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

// Names of the failing tests in a test run's output, as the scorer reads them:
// pytest "FAILED id", node TAP "not ok N - name", mocha "N) name".
export function failureTitles(output) {
  return failureReport(output).titles;
}

// The same names plus the runner's own failing count. Claude Code cuts long
// command output in the middle, which can drop names; `complete` says whether
// every failure the runner counted is named.
export function failureReport(output) {
  const text = (typeof output === 'string' ? output : Array.isArray(output)
    ? output.filter(block => block?.type === 'text').map(block => block.text).join('\n') : '')
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  const pytest = /^=*\s*(\d+ (passed|failed|errors?)\b|no tests ran).* in [\d.]+s/m.exec(text);
  const tap = /^# (pass|fail) \d+/m.test(text);
  const pattern = pytest ? /^(?:FAILED|ERROR) (\S+)/gm : tap ? /^\s*not ok \d+ - ([^\n]+)/gm : /^\s*\d+\) ([^\n]+)/gm;
  const named = [...text.matchAll(pattern)].map(match => match[1].trim());
  const count = pytest
    ? [...pytest[0].matchAll(/(\d+) (?:failed|errors?)\b/g)].reduce((sum, match) => sum + Number(match[1]), 0)
    : Number((tap ? /^# fail (\d+)/m : /^\s*(\d+) failing\b/m).exec(text)?.[1] ?? NaN);
  const failing = Number.isFinite(count) ? count : null;
  return {titles: [...new Set(named)], failing, complete: failing !== null && named.length === failing};
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
