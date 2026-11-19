// Real Claude Code, fake model: a task names a name-filtered test command.
// The gateway runs the same file unfiltered before the first edit, and after
// the filtered run passes it runs the file unfiltered again and judges the
// result against that first run (one test already fails, and stays failing).
import { mkdtemp, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createGateway, root } from '../src/server.mjs';
import { parseReply } from '../src/protocol.mjs';

const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'whatsapp-code-baseline-')));
const state = path.join(dir, 'state');
await import('node:fs/promises').then(fs => fs.mkdir(state));
await writeFile(path.join(state, 'gateway-token'), 'test-key');
await writeFile(path.join(dir, 'value.mjs'), 'export const value = "old";\n');
await writeFile(path.join(dir, 'behavior.test.mjs'), [
  'import test from "node:test";',
  'import assert from "node:assert/strict";',
  'import {value} from "./value.mjs";',
  'test("target", () => assert.equal(value, "new"));',
  'test("neighbour", () => assert.equal(typeof value, "string"));',
  'test("environment", () => assert.ok(false, "fails before and after"));'
].join('\n') + '\n');
const filtered = 'node --test --test-name-pattern target behavior.test.mjs';
const unfiltered = 'node --test behavior.test.mjs';
const results = [];
let rounds = 0;
const server = createGateway({token: 'test-key', backend: {ready: true, status: 'mock', complete: async request => {
  rounds++;
  const reply = blocks => JSON.stringify({content: blocks});
  if (rounds === 1) return parseReply(reply([{type: 'tool_use', name: 'Read', input: {file_path: path.join(dir, 'value.mjs')}}]), request, {matchedTurn: true});
  if (rounds === 2) {
    return parseReply('EDIT ' + request.editableReads[0].read_id + ' 1 1\nexport const value = "new";\nEND', request, {matchedTurn: true});
  }
  results.push(request.prompt);
  if (rounds === 3) return parseReply(reply([{type: 'tool_use', name: 'Bash', input: {command: filtered}}]), request, {matchedTurn: true});
  // A final answer after the filtered pass: on the last attempt the gateway
  // runs the file unfiltered instead. After that run, the answer stands.
  return parseReply(reply([{type: 'text', text: 'Done.'}]), request, {matchedTurn: true, finalAttempt: true});
}}});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
try {
  const child = spawn(process.execPath, [path.join(root, 'src/launch.mjs'), '--print', '--no-session-persistence',
    '--permission-mode', 'dontAsk', '--allowedTools', 'Read', 'Edit', 'Bash(node --test:*)', '--',
    'Make value "new".\n\nEdit, and then run exactly: ' + filtered], {cwd: dir, stdio: ['ignore', 'pipe', 'pipe'],
    env: {...process.env, WA_STATE_DIR: state, WA_PORT: String(server.address().port), CLAUDE_CONFIG_DIR: path.join(dir, 'cfg')}});
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => {stdout += chunk;});
  child.stderr.on('data', chunk => {stderr += chunk;});
  const timer = setTimeout(() => child.kill('SIGTERM'), 60000);
  const [code] = await once(child, 'exit');
  clearTimeout(timer);
  assert.equal(code, 0, stderr + '\n' + stdout);
  assert.equal(await readFile(path.join(dir, 'value.mjs'), 'utf8'), 'export const value = "new";\n');
  // Round 3 saw the run made before the edit: the target and the environment test failed.
  assert.match(results[0], /before your first edit to record which tests already fail/);
  assert.match(results[0], /not ok 1 - target/);
  // The last request saw the unfiltered run after the edit, judged against it.
  assert.match(results.at(-1), /1 of these 1 failing tests failed then too; none is new/);
  assert.equal(rounds, 5);
  assert.ok(stdout.includes('Done.'));
  console.log('PASS: Claude Code ran the unfiltered tests before the first edit and after the filtered pass; only the old failure remained.');
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await rm(dir, {recursive: true, force: true});
}
