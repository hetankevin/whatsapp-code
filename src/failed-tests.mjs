// Track test failures within the current user task.
const READ_ONLY = new Set(['Read', 'Glob', 'Grep']);

const TEST_RUNNER = '(?:node[ \\t]+--test|(?:npm|pnpm|yarn)[ \\t]+test|(?:\\.\\/)?node_modules\\/\\.bin\\/_?mocha|mocha|pytest|python3?[ \\t]+-m[ \\t]+pytest)';

// The part of a command the shell interprets: single-quoted text is literal,
// so it is dropped. Escaped characters and double-quoted text are kept.
function shellActive(command) {
  let out = '';
  for (let i = 0, quote = ''; i < command.length; i++) {
    const ch = command[i];
    if (quote === "'") { if (ch === "'") quote = ''; continue; }
    if (ch === '\\') { out += ch + (command[i + 1] ?? ''); i++; continue; }
    if (ch === "'" && !quote) { quote = "'"; continue; }
    if (ch === '"') quote = quote ? '' : '"';
    out += ch;
  }
  return out;
}

export function testCommand(tool, configuredCommand) {
  if (tool?.name !== 'Bash' || typeof tool.input?.command !== 'string') return null;
  const command = tool.input.command.trim();
  if (command === configuredCommand) return command;
  // Only recognize standalone test invocations. Shell pipelines and compound
  // commands can change the workspace, so they clear prior test failures.
  // A quoted name filter such as --grep 'a|b' is still one test run.
  if (/[;&|<>()\x60$\r\n]/.test(shellActive(command))) return null;
  return new RegExp('^' + TEST_RUNNER + '(?:[ \\t]|$)').test(command) ? command : null;
}

// The test command a task names, such as "then run exactly: npm test" or
// "run `pytest -q`": a standalone test invocation in backticks, after a colon
// at the end of a line, or alone on a line. Prose after a command on the same
// line ("run npm test and fix it") is not a command, so it is not matched.
// Returns the last one found, or null.
export function namedTestCommand(text) {
  if (typeof text !== 'string') return null;
  let found = null;
  for (const line of text.split('\n')) {
    const candidates = [...line.matchAll(/\x60([^\x60\n]+)\x60/g)].map(match => match[1].trim());
    if (!line.includes('\x60')) {
      for (const match of line.trim().matchAll(/(?:^|:[ \t]+)(?=\S)/g)) {
        candidates.push(line.trim().slice(match.index + match[0].length).replace(/(?<=\S)[.,;]$/, ''));
      }
    }
    for (const command of candidates) {
      if (new RegExp('^' + TEST_RUNNER + '(?:[ \\t]|$)').test(command) && testCommand({name: 'Bash', input: {command}})) found = command;
    }
  }
  return found;
}

// Terminal styling and dependency stack frames add nothing for Meta AI.
// Clean them from the WhatsApp view of tool output; Claude Code keeps the raw text.
export function readableOutput(text) {
  if (typeof text !== 'string') return text;
  return text
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/(?:[\u2024.]){12,}/g, dots => '[' + dots.length + ' progress dots]')
    .split('\n')
    .filter(line => !/^\s+at (?:.*[(\s])?(?:node:[\w/]+|\S*\/node_modules\/)\S*:\d+(?::\d+)?\)?\s*$/.test(line))
    .join('\n');
}

function failureExcerpt(content) {
  const text = readableOutput(typeof content === 'string' ? content : Array.isArray(content)
    ? content.filter(block => block.type === 'text').map(block => block.text).join('\n')
    : '');
  // Multi-step test commands can print a failure heading before another
  // test process dumps dependency warnings. Preserve the actual assertion.
  const lines = text.split('\n').filter(line => !/^\(node:\d+\) Warning:|^\(Use `node --trace-warnings /.test(line));
  const failure = lines.findIndex(line => /^(?:not ok\b|FAIL\b|E\s{2,}|AssertionError\b|(?:# )?SyntaxError:|[ \t]+\d+\) )/.test(line));
  const syntaxError = /^(?:# )?SyntaxError:/.test(lines[failure] ?? '');
  const location = syntaxError ? lines.findLastIndex((line, index) => index < failure &&
    /^(?:# )?(?:file:\/\/)?\/[^\n]+:\d+(?::\d+)?\s*$/.test(line)) : -1;
  const start = location >= 0 && failure - location < 6 ? location : Math.max(failure, 0);
  return lines.slice(start, start + 16).join('\n').slice(0, 1000);
}

export function testState(messages, configuredCommand) {
  const failures = new Map();
  // Test commands that passed with no workspace change since.
  const passes = new Set();
  const histories = new Map();
  const pending = new Map();
  let latestCommand;
  for (const message of messages) {
    const blocks = Array.isArray(message.content) ? message.content : [];
    if (message.role === 'assistant') {
      const calls = blocks.filter(block => block.type === 'tool_use');
      if (calls.some(call => !READ_ONLY.has(call.name) && !testCommand(call, configuredCommand))) {
        failures.clear();
        passes.clear();
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
          passes.delete(command);
          const failure = failureExcerpt(result.content);
          failures.set(command, failure);
          histories.set(command, {latestFailure:{command, failure},
            previousFailure:histories.get(command)?.latestFailure});
        } else {
          failures.delete(command);
          histories.delete(command);
          passes.add(command);
        }
      }
    }
  }
  return {failures, passes, ...histories.get(configuredCommand ?? latestCommand)};
}
