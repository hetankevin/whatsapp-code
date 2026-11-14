// Track test failures within the current user task.
const READ_ONLY = new Set(['Read', 'Glob', 'Grep']);

export function testCommand(tool, configuredCommand) {
  if (tool?.name !== 'Bash' || typeof tool.input?.command !== 'string') return null;
  const command = tool.input.command.trim();
  if (command === configuredCommand) return command;
  // Only recognize standalone test invocations. Shell pipelines and compound
  // commands can change the workspace, so they clear prior test failures.
  if (/[;&|<>()\x60$\r\n]/.test(command)) return null;
  return /^(?:node[ \t]+--test|(?:npm|pnpm|yarn)[ \t]+test|(?:\.\/)?node_modules\/\.bin\/_?mocha|mocha|pytest|python3?[ \t]+-m[ \t]+pytest)(?:[ \t]|$)/.test(command)
    ? command
    : null;
}

function failureExcerpt(content) {
  const text = typeof content === 'string' ? content : Array.isArray(content)
    ? content.filter(block => block.type === 'text').map(block => block.text).join('\n')
    : '';
  const lines = text.split('\n');
  const failure = lines.findIndex(line => /^(?:not ok\b|FAIL\b|E\s{2,}|AssertionError\b|(?:# )?SyntaxError:|[ \t]+\d+\) )/.test(line));
  const syntaxError = /^(?:# )?SyntaxError:/.test(lines[failure] ?? '');
  const location = syntaxError ? lines.findLastIndex((line, index) => index < failure &&
    /^(?:# )?(?:file:\/\/)?\/[^\n]+:\d+(?::\d+)?\s*$/.test(line)) : -1;
  const start = location >= 0 && failure - location < 6 ? location : Math.max(failure, 0);
  return lines.slice(start, start + 16).join('\n').slice(0, 1000);
}

export function testState(messages, configuredCommand) {
  const failures = new Map();
  const histories = new Map();
  const pending = new Map();
  let latestCommand;
  for (const message of messages) {
    const blocks = Array.isArray(message.content) ? message.content : [];
    if (message.role === 'assistant') {
      const calls = blocks.filter(block => block.type === 'tool_use');
      if (calls.some(call => !READ_ONLY.has(call.name) && !testCommand(call, configuredCommand))) {
        failures.clear();
        pending.clear();
        continue;
      }
      for (const call of calls) {
        const command = testCommand(call, configuredCommand);
        if (command) pending.set(call.id, command);
      }
    } else if (message.role === 'user') {
      const results = blocks.filter(block => block.type === 'tool_result');
      for (const result of results) {
        const command = pending.get(result.tool_use_id);
        if (!command) continue;
        pending.delete(result.tool_use_id);
        latestCommand = command;
        if (result.is_error) {
          const failure = failureExcerpt(result.content);
          failures.set(command, failure);
          histories.set(command, {latestFailure:{command, failure},
            previousFailure:histories.get(command)?.latestFailure});
        } else {
          failures.delete(command);
          histories.delete(command);
        }
      }
    }
  }
  return {failures, ...histories.get(configuredCommand ?? latestCommand)};
}
