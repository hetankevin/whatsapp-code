// Exercise the actual Claude Code client with a deterministic local fake model.
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createGateway, root } from '../src/server.mjs';
import { parseReply } from '../src/protocol.mjs';

const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'whatsapp-code-test-')));
const state = path.join(dir, 'state');
const target = path.join(dir, 'verified.mjs');
const secret = randomBytes(12).toString('hex');
const original = '// ' + secret + '\n';
const expected = 'verified: ' + secret;
const source = 'console.log("' + expected + '");\n';
await mkdir(state);
await writeFile(target, original);
await writeFile(path.join(state, 'gateway-token'), 'test-key');

let rounds = 0;
const server = createGateway({
  token: 'test-key',
  backend: {
    ready: true,
    status: 'mock test',
    complete: async request => {
      rounds++;
      const payload = JSON.parse(request.prompt.split('CURRENT REQUEST:\n')[1]);
      const results = payload.messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
        .filter(block => block.type === 'tool_result');
      const last = results.at(-1);
      const reply = block => JSON.stringify({request_id: request.requestId, content: [block]});
      const tool = (name, input) => reply({type: 'tool_use', name, input});

      if (results.length === 0) return parseReply(tool('Read', {file_path: target}), request);
      assert.ok(last && !last.is_error, 'Claude Code must successfully execute each tool');
      if (results.length === 1) {
        assert.ok(JSON.stringify(last.content).includes(secret), 'Read must return the actual fixture content');
        const read = payload.editable_reads.find(read => read.read_id === last.tool_use_id);
        assert.ok(read, 'Claude Code must return a numbered Read snapshot');
        const frame = tool('EditLines', {read_id:read.read_id, start_line:1, end_line:1}) +
          '\n<<<NEW>>>\n' + source.slice(0, -1) + '\n<<<END>>>';
        return parseReply(frame, request);
      }
      if (results.length === 2) {
        assert.equal(await readFile(target, 'utf8'), source, 'The framed source must reach Edit unchanged');
        return parseReply(tool('Bash', {command: 'node verified.mjs', description: 'Run the fixture'}), request);
      }
      assert.equal(results.length, 3);
      assert.ok(JSON.stringify(last.content).includes(expected), 'Bash must return the program output');
      return parseReply(reply({type: 'text', text: expected}), request);
    }
  }
});

server.listen(0, '127.0.0.1');
await once(server, 'listening');
try {
  const child = spawn(process.execPath, [
    path.join(root, 'src/launch.mjs'), '--print', '--no-session-persistence',
    '--restricted', '--tools', 'Read,Edit,Bash', '--permission-mode', 'dontAsk',
    '--allowedTools', 'Read', 'Edit', 'Bash(node verified.mjs)', '--',
    'Read the fixture, write a small program, and run it.'
  ], {
    cwd: dir,
    env: {...process.env, WA_STATE_DIR: state, WA_PORT: String(server.address().port),
      CLAUDE_CONFIG_DIR: path.join(dir, 'claude-config')},
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => {stdout += chunk;});
  child.stderr.on('data', chunk => {stderr += chunk;});
  const timer = setTimeout(() => child.kill('SIGTERM'), 45000);
  const [code] = await once(child, 'exit');
  clearTimeout(timer);
  assert.equal(code, 0, stderr + '\n' + stdout);
  assert.ok(rounds >= 4);
  assert.ok(stdout.includes(expected));
  console.log('PASS: Claude Code read a file, applied a line-range edit, ran it, and returned the actual output.');
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await rm(dir, {recursive: true, force: true});
}
