// Track test failures until the user or a potentially mutating tool changes the context.
const READ_ONLY = new Set(['Read', 'Glob', 'Grep']);

export function testCommand(tool) {
  if (tool?.name !== 'Bash' || typeof tool.input?.command !== 'string') return null;
  const command = tool.input.command.trim();
  // Only recognize standalone test invocations. Shell pipelines and compound
  // commands can change the workspace, so they clear prior test failures.
  if (/[;&|<>()\x60$\r\n]/.test(command)) return null;
  return /^(?:node[ \t]+--test|(?:npm|pnpm|yarn)[ \t]+test|pytest|python3?[ \t]+-m[ \t]+pytest)(?:[ \t]|$)/.test(command)
    ? command
    : null;
}

function failureExcerpt(content) {
  const text = typeof content === 'string' ? content : Array.isArray(content)
    ? content.filter(block => block.type === 'text').map(block => block.text).join('\n')
    : '';
  const lines = text.split('\n');
  const failure = lines.findIndex(line => /^(?:not ok\b|FAIL\b|E\s{2,}|AssertionError\b)/.test(line));
  return lines.slice(Math.max(failure, 0), Math.max(failure, 0) + 16).join('\n').slice(0, 1000);
}

export function failedTests(messages) {
  const failures = new Map();
  const pending = new Map();
  for (const message of messages) {
    const blocks = Array.isArray(message.content) ? message.content : [];
    if (message.role === 'assistant') {
      const calls = blocks.filter(block => block.type === 'tool_use');
      if (calls.some(call => !READ_ONLY.has(call.name) && !testCommand(call))) {
        failures.clear();
        pending.clear();
        continue;
      }
      for (const call of calls) {
        const command = testCommand(call);
        if (command) pending.set(call.id, command);
      }
    } else if (message.role === 'user') {
      const results = blocks.filter(block => block.type === 'tool_result');
      if (!results.length && (typeof message.content === 'string' || blocks.some(block => block.type === 'text'))) {
        failures.clear();
        pending.clear();
      }
      for (const result of results) {
        const command = pending.get(result.tool_use_id);
        if (!command) continue;
        pending.delete(result.tool_use_id);
        if (result.is_error) failures.set(command, failureExcerpt(result.content));
        else failures.delete(command);
      }
    }
  }
  return failures;
}
