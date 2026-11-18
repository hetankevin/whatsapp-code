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

// One shell word: unquoted characters, escapes and quoted segments, joined.
const SHELL_WORD = /(?:'[^']*'|"(?:\\[\s\S]|[^"\\])*"|\\[\s\S]|[^\s'"\\])+/g;

// A test command's name filter (mocha --grep, node --test-name-pattern,
// pytest -k) and the same command without it, or null when it has none.
// Words are kept verbatim, so quoting survives. Short options count only for
// the runner that defines them: mocha -t is a timeout, not a filter.
export function nameFilter(command) {
  const words = typeof command === 'string' ? command.trim().match(SHELL_WORD) ?? [] : [];
  const mocha = /(?:^|\/)_?mocha$/.test(words[0] ?? '');
  const pytest = words[0] === 'pytest' || (/^python3?$/.test(words[0] ?? '') && words[1] === '-m' && words[2] === 'pytest');
  const filters = new Set(['--grep', '--fgrep', '--test-name-pattern', ...(mocha ? ['-g', '-f'] : []), ...(pytest ? ['-k'] : [])]);
  const kept = [];
  let filter;
  for (let i = 0; i < words.length; i++) {
    const [name] = words[i].split('=');
    if (filters.has(name) && (words[i].includes('=') || i + 1 < words.length)) {
      filter ??= name;
      if (!words[i].includes('=')) i++;
    } else if (!(mocha && ['--invert', '-i'].includes(words[i]))) {
      kept.push(words[i]);
    }
  }
  if (!filter) return null;
  if (kept.at(-1) === '--') kept.pop();
  return {filter, unfiltered: kept.join(' ')};
}

export const unfilteredTestCommand = command => nameFilter(command)?.unfiltered ?? null;

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
