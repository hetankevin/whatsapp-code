import { randomBytes } from 'node:crypto';
import Ajv from 'ajv';
import Ajv2020 from 'ajv/dist/2020.js';

export class GatewayError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

function content(blocks) {
  if (typeof blocks === 'string') return blocks;
  if (!Array.isArray(blocks)) throw new GatewayError('Expected text or content blocks.');
  return blocks.map(b => {
    if (b.type === 'text') return { type: 'text', text: b.text };
    if (b.type === 'tool_use') return { type: b.type, id: b.id, name: b.name, input: b.input };
    if (b.type === 'tool_result') return { type: b.type, tool_use_id: b.tool_use_id, is_error: !!b.is_error, content: content(b.content ?? '') };
    throw new GatewayError(`Unsupported content type: ${b.type}. This gateway accepts text and client tool calls only.`);
  });
}

export function prepare(body, maxChars = 60000) {
  if (!Array.isArray(body.messages) || !body.messages.length) throw new GatewayError('messages must be a nonempty array.');
  if (body.thinking && body.thinking.type !== 'disabled') throw new GatewayError('Extended thinking is unavailable. Set MAX_THINKING_TOKENS=0.');
  if (body.output_config?.format || body.output_format) throw new GatewayError('Structured output API options are unsupported.');
  const tools = body.tools ?? [];
  if (!Array.isArray(tools)) throw new GatewayError('tools must be an array.');
  const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false });
  const ajv2020 = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
  const validators = new Map();
  for (const t of tools) {
    if (!t.name || !t.input_schema || (t.type && t.type !== 'custom')) throw new GatewayError('Only named client tools with input_schema are supported.');
    if (validators.has(t.name)) throw new GatewayError('Duplicate tool names.');
    try { validators.set(t.name, (t.input_schema.$schema?.includes('2020-12') ? ajv2020 : ajv).compile(t.input_schema)); }
    catch (error) { throw new GatewayError(`Invalid input schema for ${t.name}: ${error.message}`); }
  }
  const requestId = randomBytes(12).toString('hex');
  const payload = {
    request_id: requestId,
    system: content(body.system ?? ''),
    tools: tools.map(({name, description, input_schema}) => ({name, description, input_schema})),
    tool_choice: body.tool_choice ?? {type: 'auto'},
    messages: body.messages.map(m => {
      if (!['user', 'assistant'].includes(m.role)) throw new GatewayError('Invalid message role.');
      return {role: m.role, content: content(m.content)};
    })
  };
  let prompt = `You are the model in a local coding harness. Answer only the current request below. The supplied conversation is complete for this request; do not use earlier WhatsApp messages as task context. Follow the supplied system instructions. You do not execute tools yourself: request them and the harness returns their results. Never claim a tool ran before receiving its result.\nReturn ONLY one JSON object, with no Markdown or explanation outside it:\n{"request_id":"${requestId}","content":[{"type":"text","text":"your answer"}]}\nTo call a tool instead, include {"type":"tool_use","name":"EXACT tool name","input":{...}} in content. Use only supplied tools and obey their JSON schemas. You can mix text and tool_use blocks. After requesting tools, stop and wait. tool_choice none forbids tools; any requires a tool; tool with name requires that tool. Return final text when finished.\nCURRENT REQUEST:\n${JSON.stringify({...payload, system: undefined})}`;
  const systemText = typeof payload.system === 'string' ? payload.system : payload.system.map(b => b.text ?? '').join('\n');
  prompt = 'TASK SYSTEM INSTRUCTIONS:\n' + systemText + '\n\n' + prompt;
  if (prompt.length > maxChars) throw new GatewayError(`Context is ${prompt.length} characters; the configured WhatsApp limit is ${maxChars}. Start a shorter session or reduce tool output. No context was truncated.`, 413);
  return {prompt, requestId, validators, choice: payload.tool_choice, model: body.model ?? 'meta-ai-whatsapp'};
}

export function parseReply(raw, request) {
  const trimmed = raw.trim().replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```$/, '').trim();
  let obj;
  try { obj = JSON.parse(trimmed); } catch { const error = new GatewayError('Meta AI did not return complete protocol JSON.', 502); error.repairable = true; throw error; }
  if (obj.request_id !== request.requestId) throw new GatewayError('Meta AI reply does not match this request.', 502);
  if (!Array.isArray(obj.content) || !obj.content.length) throw new GatewayError('Meta AI returned no content.', 502);
  const blocks = obj.content.map(b => {
    if (b.type === 'text' && typeof b.text === 'string' && b.text.length) return {type: 'text', text: b.text};
    if (b.type !== 'tool_use' || !request.validators.has(b.name)) throw new GatewayError('Meta AI returned an unknown content block or tool.', 502);
    if (!request.validators.get(b.name)(b.input)) throw new GatewayError(`Meta AI supplied invalid arguments for ${b.name}.`, 502);
    return {type: 'tool_use', id: `toolu_${randomBytes(12).toString('hex')}`, name: b.name, input: b.input};
  });
  const calls = blocks.filter(b => b.type === 'tool_use');
  if (request.choice.type === 'none' && calls.length) throw new GatewayError('Meta AI ignored tool_choice none.', 502);
  if (['any', 'tool'].includes(request.choice.type) && !calls.length) throw new GatewayError('Meta AI omitted a required tool.', 502);
  if (request.choice.type === 'tool' && calls.some(b => b.name !== request.choice.name)) throw new GatewayError('Meta AI selected the wrong required tool.', 502);
  if (request.choice.disable_parallel_tool_use && calls.length > 1) throw new GatewayError('Meta AI requested parallel tools when disabled.', 502);
  return {
    id: `msg_${randomBytes(12).toString('hex')}`, type: 'message', role: 'assistant', model: request.model,
    content: blocks, stop_reason: calls.length ? 'tool_use' : 'end_turn', stop_sequence: null,
    // Consumer WhatsApp supplies no tokenizer counts. These are estimates, not billing data.
    usage: {input_tokens: Math.ceil(request.prompt.length / 4), output_tokens: Math.ceil(raw.length / 4)}
  };
}

export function streamMessage(message, send) {
  send('message_start', {type: 'message_start', message: {...message, content: [], stop_reason: null, usage: {...message.usage, output_tokens: 0}}});
  message.content.forEach((b, index) => {
    send('content_block_start', {type: 'content_block_start', index, content_block: b.type === 'text' ? {type: 'text', text: ''} : {...b, input: {}}});
    send('content_block_delta', {type: 'content_block_delta', index, delta: b.type === 'text' ? {type: 'text_delta', text: b.text} : {type: 'input_json_delta', partial_json: JSON.stringify(b.input)}});
    send('content_block_stop', {type: 'content_block_stop', index});
  });
  send('message_delta', {type: 'message_delta', delta: {stop_reason: message.stop_reason, stop_sequence: null}, usage: {output_tokens: message.usage.output_tokens}});
  send('message_stop', {type: 'message_stop'});
}

// Read only known text fields. Never interpret arbitrary protobuf metadata as model output.
export function extractText(message) {
  if (!message) return '';
  for (const key of ['botForwardedMessage', 'editedMessage', 'ephemeralMessage', 'viewOnceMessage']) {
    if (message[key]?.message) return extractText(message[key].message);
  }
  if (message.protocolMessage?.editedMessage) return extractText(message.protocolMessage.editedMessage);
  if (typeof message.conversation === 'string') return message.conversation;
  if (typeof message.extendedTextMessage?.text === 'string') return message.extendedTextMessage.text;
  const parts = message.richResponseMessage?.submessages;
  if (!Array.isArray(parts)) return '';
  return parts.map(p => p.messageText ?? p.codeMetadata?.codeBlocks?.map(b => b.codeContent ?? '').join('') ?? p.latexMetadata?.text ?? '').join('\n');
}
