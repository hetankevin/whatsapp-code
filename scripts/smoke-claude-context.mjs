// Exercise native discovery and automatic compaction with the real Claude Code client.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseReply } from '../src/protocol.mjs';
import { createGateway, root } from '../src/server.mjs';

const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'wa-context-')));
const state = path.join(dir, 'state');
const sources = path.join(dir, 'src');
await mkdir(state);
await mkdir(sources);
await writeFile(path.join(state, 'gateway-token'), 'test-key');
for (let i = 0; i < 24; i++) {
  const source = Array.from({length: 70}, (_, line) => 'Example source fixture ' + i + ' line ' + line + ' for context tests.');
  await writeFile(path.join(sources, 'fragment-' + i + '.txt'), source.join('\n') + '\n');
}

let readCount = 0;
let compactions = 0;
let resumed = 0;
let requestClass;
let afterCompact;
let discovered = false;
let searched = false;
const summary = 'Continue the fixture task and return context-ok after reading the remaining fragments.';
const server = createGateway({
  token: 'test-key',
  backend: {
    ready: true,
    status: 'mock test',
    complete: async request => {
      const reply = block => parseReply(JSON.stringify({request_id: request.requestId, content: [block]}), request);
      const tool = (name, input) => reply({type: 'tool_use', name, input});
      if (requestClass === 'compaction') {
        compactions++;
        assert.equal(request.validators.size, 0, 'Compaction must be a text-only model request');
        return reply({type: 'text', text: '<summary>' + summary + '</summary>'});
      }
      if (afterCompact) {
        assert.ok(request.prompt.includes(summary), 'Claude Code must carry the summary into the next turn');
        resumed++;
      }
      if (!discovered) {
        discovered = true;
        assert.ok(request.validators.has('Glob') && request.validators.has('Grep'));
        return tool('Glob', {pattern: 'src/*.txt'});
      }
      if (!searched) {
        searched = true;
        assert.match(request.prompt, /fragment-0\.txt/);
        return tool('Grep', {pattern: 'Example source fixture 0', path: sources});
      }
      if (!readCount) assert.match(request.prompt, /fragment-0\.txt/);
      if (readCount < 24) {
        const file_path = path.join(sources, 'fragment-' + readCount++ + '.txt');
        return tool('Read', {file_path, limit: 24});
      }
      return reply({type: 'text', text: 'context-ok'});
    }
  }
});
server.prependListener('request', req => {
  requestClass = req.headers['x-claude-code-request-class'];
  afterCompact = req.headers['x-claude-code-context-compacted'];
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
try {
  const env = {...process.env, WA_STATE_DIR: state, WA_PORT: String(server.address().port),
    WA_EDIT_FILE: '', WA_EDIT_FILES: '', CLAUDE_CONFIG_DIR: path.join(dir, 'claude-config')};
  delete env.CLAUDE_CODE_MAX_CONTEXT_TOKENS;
  delete env.CLAUDE_CODE_MAX_OUTPUT_TOKENS;
  const child = spawn(process.execPath, [
    path.join(root, 'src/launch.mjs'), '--print', '--verbose', '--output-format', 'stream-json',
    '--no-session-persistence', '--permission-mode', 'dontAsk', '--allowedTools', 'Read', 'Glob', 'Grep',
    '--', 'Inspect the fixture and return context-ok.'
  ], {cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe']});
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => {stdout += chunk;});
  child.stderr.on('data', chunk => {stderr += chunk;});
  const timer = setTimeout(() => child.kill('SIGTERM'), 45000);
  const [code] = await once(child, 'exit');
  clearTimeout(timer);
  const events = stdout.trim().split('\n').map(line => JSON.parse(line));
  const result = events.findLast(event => event.type === 'result');
  assert.equal(code, 0, stderr + '\n' + JSON.stringify(result));
  assert.equal(result.result, 'context-ok');
  assert.equal(readCount, 24);
  assert.equal(result.permission_denials.length, 0);
  const calls = new Map();
  const succeeded = new Set();
  for (const event of events) {
    for (const block of event.message?.content ?? []) {
      if (block.type === 'tool_use') calls.set(block.id, block.name);
      if (block.type === 'tool_result' && !block.is_error) succeeded.add(calls.get(block.tool_use_id));
    }
  }
  assert.ok(succeeded.has('Glob') && succeeded.has('Grep'));
  assert.ok(compactions >= 2 && resumed >= 2);
  console.log('PASS: Claude Code used native Glob and Grep and completed 24 reads across ' + compactions + ' native compactions.');
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await rm(dir, {recursive: true, force: true});
}
