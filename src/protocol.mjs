import { randomBytes } from 'node:crypto';
import Ajv from 'ajv';
import Ajv2020 from 'ajv/dist/2020.js';
import { failedTests, testCommand } from './failed-tests.mjs';

export class GatewayError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const READ_ONLY_TOOLS = new Set(['Read', 'Glob', 'Grep']);

// Claude Code prefixes text Read results with their source line numbers.
function numberedRead(text) {
  if (typeof text !== 'string') return null;
  const labels = text.split('\n');
  if (labels.at(-1) === '') labels.pop();
  const lines = [];
  let first;
  for (const label of labels) {
    const match = /^ *(\d+)\t([\s\S]*)$/.exec(label);
    if (!match) return null;
    const line = Number(match[1]);
    first ??= line;
    if (!Number.isSafeInteger(line) || line < 1 || line !== first + lines.length) return null;
    lines.push(match[2]);
  }
  return lines.length ? {first, lines} : null;
}

function withoutReadLabels(text) {
  const read = numberedRead(text);
  return read ? read.lines.join('\n') + (text.endsWith('\n') ? '\n' : '') : text;
}

function trackReads(messages) {
  const pending = new Map();
  const snapshots = new Map();
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    if (message.role === 'assistant') {
      const calls = message.content.filter(block => block.type === 'tool_use');
      if (calls.some(call => !READ_ONLY_TOOLS.has(call.name))) {
        pending.clear();
        snapshots.clear();
        continue;
      }
      for (const call of calls) {
        if (call.name === 'Read' && typeof call.input?.file_path === 'string') {
          pending.set(call.id, call.input.file_path);
        }
      }
    } else if (message.role === 'user') {
      for (const result of message.content) {
        if (result.type !== 'tool_result' || !pending.has(result.tool_use_id)) continue;
        const filePath = pending.get(result.tool_use_id);
        pending.delete(result.tool_use_id);
        for (const [id, snapshot] of snapshots) {
          if (snapshot.filePath === filePath) snapshots.delete(id);
        }
        if (result.is_error) continue;
        const output = result.content;
        const text = Array.isArray(output) && output.length === 1 && output[0]?.type === 'text'
          ? output[0].text
          : output;
        const read = numberedRead(text);
        if (read && read.lines.join('\n')) snapshots.set(result.tool_use_id, {...read, filePath});
      }
    }
  }
  return snapshots;
}

const lineEditTool = {
  name: 'EditLines',
  description: 'Replace an inclusive range of lines in a recent Read snapshot. Use editable_reads to select the read ID and range. Reread after an edit or a shell command.',
  input_schema: {
    type: 'object',
    properties: {
      read_id: {type: 'string'},
      start_line: {type: 'integer', minimum: 1},
      end_line: {type: 'integer', minimum: 1},
      new_string: {type: 'string'}
    },
    required: ['read_id', 'start_line', 'end_line', 'new_string'],
    additionalProperties: false
  }
};

function repairableError(message) {
  const error = new GatewayError(message, 502);
  error.repairable = true;
  return error;
}

function resolveLineEdit(input, request) {
  if (!request.validateLineEdit?.(input)) throw repairableError('EditLines needs a read_id, two line numbers, and replacement source.');
  const {read_id, start_line, end_line} = input;
  let replacement = input.new_string;
  const embedded = replacement.trim();
  if (/^EDIT[ \t]+[0-9a-f]{24}(?:[ \t]|\r?\n|$)/.test(embedded)) {
    // A live reply wrapped a complete EDIT frame in the replacement string.
    // Only unwrap the current request and the exact same snapshot and range.
    let decoded;
    try { decoded = parseLineFrame(embedded, true); }
    catch { throw repairableError('Send one complete EDIT frame, outside the replacement source.'); }
    if (decoded.request_id !== request.requestId) throw repairableError('Nested EDIT uses a stale request ID. Send one EDIT frame for this request.');
    const nested = decoded.content[0].input;
    if (nested.read_id !== read_id || nested.start_line !== start_line || nested.end_line !== end_line) {
      throw repairableError('Nested EDIT metadata disagrees with the requested range. Send one EDIT frame.');
    }
    replacement = nested.new_string;
  }
  const snapshot = request.snapshots.get(read_id);
  if (!snapshot) throw repairableError('EditLines needs a current Read snapshot. Use a read_id from editable_reads or call Read again.');
  const {first, lines, filePath} = snapshot;
  if (start_line < first || end_line < start_line || end_line >= first + lines.length) {
    throw repairableError('EditLines range lies outside the numbered Read result.');
  }
  // Use the whole observed excerpt as the exact match. The real Edit tool
  // checks for file changes and ambiguity before modifying anything.
  const updated = [...lines];
  updated.splice(start_line - first, end_line - start_line + 1, ...(replacement === '' ? [] : replacement.split('\n')));
  return {file_path: filePath, old_string: lines.join('\n'), new_string: updated.join('\n')};
}

function content(blocks, readIds, snapshots) {
  if (typeof blocks === 'string') return blocks;
  if (!Array.isArray(blocks)) throw new GatewayError('Expected text or content blocks.');
  return blocks.map(b => {
    if (b.type === 'text') return { type: 'text', text: b.text };
    if (b.type === 'tool_use') return { type: b.type, id: b.id, name: b.name, input: b.input };
    if (b.type === 'tool_result') {
      let result = content(b.content ?? '');
      if (!b.is_error && readIds?.has(b.tool_use_id) && !snapshots?.has(b.tool_use_id)) {
        result = typeof result === 'string'
          ? withoutReadLabels(result)
          : result.map(block => block.type === 'text' ? {...block, text: withoutReadLabels(block.text)} : block);
      }
      return {type: b.type, tool_use_id: b.tool_use_id, is_error: !!b.is_error, content: result};
    }
    throw new GatewayError(`Unsupported content type: ${b.type}. This gateway accepts text and client tool calls only.`);
  });
}

const indentationPrefix = /^(\d{1,3}|[st]{1,128})\|([\s\S]*)$/;

function decodeIndentation(source) {
  if (source === '') return '';
  return source.split('\n').map(line => {
    const match = indentationPrefix.exec(line);
    if (!match) throw new SyntaxError('Indented source needs an indentation prefix on each line.');
    const [, prefix, code] = match;
    const indentation = /^\d/.test(prefix)
      ? ' '.repeat(Number(prefix))
      : prefix.replaceAll('s', ' ').replaceAll('t', '\t');
    return indentation + code;
  }).join('\n');
}

// A short header avoids putting code or delimiter punctuation inside JSON.
function parseLineFrame(text, inferIndent = false) {
  const match = /^EDIT[ \t]+(\S+)[ \t]+(\S+)[ \t]+(\d+)[ \t]+(\d+)(?:[ \t]+(INDENT))?[ \t]*\r?\n([\s\S]*?)\r?\nEND[ \t]+(\S+)$/.exec(text);
  if (!match || match[1] !== match[7]) throw new SyntaxError('Incomplete EDIT frame.');
  const [, request_id, read_id, start, end, mode, body] = match;
  const fence = /^(\x60{3,})[a-zA-Z0-9_+-]*[ \t]*\r?\n([\s\S]*?)\r?\n\1[ \t]*$/.exec(body);
  const source = fence ? fence[2] : body;
  const encoded = mode === 'INDENT' ||
    (inferIndent && source.split('\n').every(line => indentationPrefix.test(line)));
  return {request_id, content:[{
    type:'tool_use', name:'EditLines',
    input:{read_id, start_line:Number(start), end_line:Number(end), new_string:encoded ? decodeIndentation(source) : source}
  }]};
}

// JSON carries metadata and the framed text carries literal source.
function parseCodeFrame(text) {
  const ordinary = /^([^\n]+)\n<<<(FILE|OLD)>>>\n([\s\S]*)\n<<<END>>>$/.exec(text);
  // WhatsApp delivered the previous range marker inline and one > short.
  const range = /^([^\n]+?)[ \t]*(?:\r?\n[ \t]*)?<<<NEW>>[>]?[ \t]*\r?\n([\s\S]*?)\r?\n<<<END>>>$/.exec(text);
  if (!ordinary && !range) throw new SyntaxError('Missing code frame markers.');
  const [header, kind, source] = ordinary ? ordinary.slice(1) : [range[1], 'NEW', range[2]];
  const reply = JSON.parse(header);
  if (!Array.isArray(reply?.content) || reply.content.length !== 1) {
    throw new SyntaxError('A code frame requires exactly one tool call.');
  }
  const [call] = reply.content;
  const input = call?.input;
  if (call?.type !== 'tool_use' || !input || typeof input !== 'object' || Array.isArray(input)) {
    throw new SyntaxError('Invalid code frame header.');
  }
  if (kind === 'FILE' && call.name === 'Write' && !Object.hasOwn(input, 'content')) {
    input.content = source;
  } else if (kind === 'NEW' && call.name === 'EditLines' && !Object.hasOwn(input, 'new_string')) {
    input.new_string = source;
  } else if (kind === 'OLD' && call.name === 'Edit' &&
             !Object.hasOwn(input, 'old_string') && !Object.hasOwn(input, 'new_string')) {
    const sections = source.split('\n<<<NEW>>>\n');
    if (sections.length !== 2) throw new SyntaxError('An edit frame requires one NEW marker.');
    [input.old_string, input.new_string] = sections;
  } else {
    throw new SyntaxError('Code frame fields conflict with its tool or header.');
  }
  return reply;
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
  const choice = body.tool_choice ?? {type: 'auto'};
  const rangeEnabled = validators.has('Read') && validators.has('Edit') &&
    ['auto', 'any'].includes(choice.type) && !validators.has('EditLines');
  const snapshots = rangeEnabled ? trackReads(body.messages) : new Map();
  const editableReads = [...snapshots].map(([read_id, {filePath, first, lines}]) =>
    ({read_id, file_path:filePath, start_line:first, end_line:first + lines.length - 1}));
  const modelTools = rangeEnabled ? tools.map(tool => tool.name === 'Edit' ? lineEditTool : tool) : tools;
  const testFailures = choice.type === 'auto' ? failedTests(body.messages) : new Map();
  const readIds = new Set();
  const payload = {
    request_id: requestId,
    system: content(body.system ?? ''),
    tools: modelTools.map(({name, description, input_schema}) => ({name, description, input_schema})),
    tool_choice: choice,
    editable_reads: rangeEnabled ? editableReads : undefined,
    failed_tests: testFailures.size ? [...testFailures].slice(-2).map(([command, failure]) => ({command, failure})) : undefined,
    messages: body.messages.map(m => {
      if (!['user', 'assistant'].includes(m.role)) throw new GatewayError('Invalid message role.');
      if (m.role === 'assistant' && Array.isArray(m.content)) {
        for (const block of m.content) {
          if (block.type === 'tool_use' && block.name === 'Read') readIds.add(block.id);
        }
      }
      return {role: m.role, content: content(m.content, m.role === 'user' ? readIds : undefined, snapshots)};
    })
  };
  let prompt = `You are the model in a local coding harness. Answer only the current request below. The supplied conversation is complete for this request; do not use earlier WhatsApp messages as task context. Follow the supplied system instructions. You do not execute tools yourself: request them and the harness returns their results. Never claim a tool ran before receiving its result.\nReturn one JSON object. Use no Markdown or surrounding prose. A text reply looks like:\n{"request_id":"${requestId}","content":[{"type":"text","text":"your answer"}]}\nTo call a tool instead, include {"type":"tool_use","name":"EXACT tool name","input":{...}} in content. Use only supplied tools and obey their JSON schemas. You can mix text and tool_use blocks. After requesting tools, stop and wait. tool_choice none forbids tools; any requires a tool; tool with name requires that tool. Return final text when finished.\nCURRENT REQUEST:\n${JSON.stringify({...payload, system: undefined})}`;
  const rangeGuide = rangeEnabled ? [
    'Use EditLines for edits. Select a read_id from editable_reads and use 1-based inclusive line numbers. If the file is missing from editable_reads, call Read first. A write, edit, or command makes prior reads ineligible.',
    'For EditLines use the three-part format below. Replace READ_ID, START, and END_LINE with the actual read ID and line numbers. Put only the replacement lines between the header and footer. A fenced code block around the replacement is encouraged to preserve indentation. To delete the selected lines, leave one empty line between the header and footer.',
    'EDIT ' + requestId + ' READ_ID START END_LINE',
    'literal replacement code',
    'END ' + requestId
  ].join('\n') : '';
  const systemText = typeof payload.system === 'string' ? payload.system : payload.system.map(b => b.text ?? '').join('\n');
  if (rangeGuide) prompt = prompt.replace('Return one JSON object.', 'Return JSON for ordinary replies. Use the literal source format for EditLines.').replace(
    '\nCURRENT REQUEST:', () => '\n\n' + rangeGuide + '\n\nCURRENT REQUEST:'
  );
  if (testFailures.size) prompt = prompt.replace('\nCURRENT REQUEST:', '\nThe failed_tests field contains the latest failure since a possible workspace change. Inspect the failing assertion and fix its cause before rerunning the same test command.\nCURRENT REQUEST:');
  prompt = 'TASK SYSTEM INSTRUCTIONS:\n' + systemText + '\n\n' + prompt;
  if (prompt.length > maxChars) throw new GatewayError(`Context is ${prompt.length} characters; the configured WhatsApp limit is ${maxChars}. Start a shorter session or reduce tool output. No context was truncated.`, 413);
  return {prompt, requestId, validators, choice, snapshots, editableReads, rangeGuide, testFailures,
    validateLineEdit: rangeEnabled ? ajv.compile(lineEditTool.input_schema) : null, model: body.model ?? 'meta-ai-whatsapp'};
}

export function parseReply(raw, request) {
  const trimmed = raw.trim().replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```$/, '').trim();
  let obj;
  try {
    try { obj = JSON.parse(trimmed); }
    catch { obj = trimmed.startsWith('EDIT ') || trimmed.startsWith('EDIT\t') ? parseLineFrame(trimmed) : parseCodeFrame(trimmed); }
  } catch {
    const error = new GatewayError('Meta AI did not return complete protocol JSON or a code frame.', 502);
    error.repairable = true;
    throw error;
  }
  if (obj?.request_id !== request.requestId) throw new GatewayError('Meta AI reply does not match this request.', 502);
  if (!Array.isArray(obj.content) || !obj.content.length) throw new GatewayError('Meta AI returned no content.', 502);
  const hasLineEdit = request.validateLineEdit && obj.content.some(b => b?.type === 'tool_use' && b.name === 'EditLines');
  if (hasLineEdit && obj.content.filter(b => b?.type === 'tool_use').length !== 1) {
    throw repairableError('Send one EditLines call without other tools.');
  }
  const blocks = obj.content.map(b => {
    if (b?.type === 'text' && typeof b.text === 'string' && b.text.length) return {type: 'text', text: b.text};
    if (b?.type !== 'tool_use') throw new GatewayError('Meta AI returned an unknown content block or tool.', 502);
    const lineEdit = hasLineEdit && b.name === 'EditLines';
    const name = lineEdit ? 'Edit' : b.name;
    if (!request.validators.has(name)) throw new GatewayError('Meta AI returned an unknown content block or tool.', 502);
    const input = lineEdit ? resolveLineEdit(b.input, request) : b.input;
    if (!request.validators.get(name)(input)) throw new GatewayError('Meta AI supplied invalid arguments for ' + name + '.', 502);
    const repeatedTest = testCommand({name, input});
    if (request.testFailures?.has(repeatedTest)) {
      const error = repairableError('This test command already failed and no workspace change is recorded. Inspect the failure, then edit or investigate before rerunning it.');
      error.testFailure = request.testFailures.get(repeatedTest);
      throw error;
    }
    const id = (lineEdit ? 'toolu_lines_' : 'toolu_') + randomBytes(12).toString('hex');
    return {type: 'tool_use', id, name, input};
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
