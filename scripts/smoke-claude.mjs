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

const discoverFiles = process.argv.includes('--verify-discovery');
const multiFile = discoverFiles || process.argv.includes('--verify-files');
const verifyEdits = multiFile || process.argv.includes('--verify-edits');
const testCommand = multiFile ? 'node --test behavior.test.mjs' : 'node --test';
const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'whatsapp-code-test-')));
const state = path.join(dir, 'state');
const target = path.join(dir, 'verified.mjs');
const helper = path.join(dir, 'helper.mjs');
const helperSource = 'export const suffix = "ready";\n';
const secret = randomBytes(12).toString('hex');
const original = '// ' + secret + '\n';
const expected = 'verified: ' + secret;
const source = verifyEdits ? 'export const value = ' + JSON.stringify(expected) + ';\n'
  : 'console.log("' + expected + '");\n';
await mkdir(state);
await writeFile(target, verifyEdits ? 'export const value = "initial"; // ' + secret + '\n' : original);
if (multiFile) await writeFile(helper, 'export const suffix = "pending";\n// Outside the edit range.\n');
if (verifyEdits) {
  await writeFile(path.join(dir, 'behavior.test.mjs'), [
    'import test from "node:test";',
    'import assert from "node:assert/strict";',
    'import {value} from "./verified.mjs";',
    ...(multiFile ? ['import {suffix} from "./helper.mjs";'] : []),
    ...(discoverFiles ? [
      'test("reports expected result", () => {',
      '  assert.equal(value, ' + JSON.stringify(expected) + ');',
      '  assert.equal(suffix, "ready");',
      '});'
    ] : [
      'test("reports expected result", () => { assert.equal(value, ' + JSON.stringify(expected) + ');' +
        (multiFile ? ' assert.equal(suffix, "ready");' : '') + ' });'
    ])
  ].join('\n'));
}
await writeFile(path.join(state, 'gateway-token'), 'test-key');

let rounds = 0;
const server = createGateway({
  token: 'test-key',
  backend: {
    ready: true,
    status: 'mock test',
    complete: async request => {
      rounds++;
      if (discoverFiles) {
        const response = blocks => JSON.stringify({content:blocks});
        if (rounds === 1) {
          return parseReply(response([{type:'tool_use',name:'Bash',input:{command:testCommand,
            description:'Reproduce the failing test'}}]),request,{matchedTurn:true});
        }
        const read = file_path => ({type:'tool_use',name:'Read',input:{file_path,offset:1,limit:2}});
        if (!request.editableReads.length) {
          return parseReply(response([read(target),read(helper)]),request,{matchedTurn:true});
        }
        const initial = (await readFile(target,'utf8')).includes('"initial"');
        const editedFile = initial ? target : helper;
        const selected = request.editableReads.find(read => path.resolve(dir, read.file_path) === editedFile);
        assert.ok(selected);
        assert.ok(request.prompt.includes(JSON.stringify(selected)));
        assert.match(request.prompt, /not ok 1 - reports expected result/);
        const replacement = initial ? source : helperSource;
        const proposal = 'EDIT ' + selected.read_id + ' 1 1\n' + replacement + 'END\n' +
          '[{"type":"tool_use","name":"Bash","input":{"command":"node --test"}}]';
        return parseReply(proposal,request,{matchedTurn:true});
      }
      if (verifyEdits) {
        assert.ok(rounds <= 2, 'Passing tests should end the loop without another model call');
        assert.match(request.prompt, /not ok 1 - reports expected result/);
        if (multiFile) assert.equal(request.editableReads[1].end_line, 1);
        const expectedSnapshot = rounds === 1 ? secret : multiFile ? source.trimEnd() : '"still wrong"';
        assert.ok(request.prompt.includes(expectedSnapshot), `Unexpected snapshot on proposal ${rounds}: ${request.prompt}`);
        assert.equal(request.editableReads.length, multiFile ? 2 : 1);
        if (multiFile) assert.ok(request.prompt.includes('export const suffix = "pending";'));
        const replacement = multiFile
          ? (rounds === 1 ? source : helperSource).trimEnd()
          : rounds === 1 ? 'export const value = "still wrong";' : source.trimEnd();
        const selector = multiFile ? 'FILE ' + rounds + '\n' : '';
        const frame = 'REPLACE 1 1 INDENT\n0|' + replacement + '\nEND';
        assert.throws(() => parseReply(selector + frame.replace('1 1', '1 9999'), request), /outside/);
        const shell = JSON.stringify({request_id: request.requestId, content: [
          {type: 'tool_use', name: 'Bash', input: {command: 'node --test'}}
        ]});
        assert.throws(() => parseReply(shell, request), /Propose one line edit/);
        const fence = '\x60'.repeat(3);
        const proposal = rounds === 1 ? frame : fence + 'js\n' + replacement + '\n' + fence;
        if (multiFile) assert.throws(() => parseReply('FILE 9\n' + proposal, request), /code frame/);
        return parseReply(selector + proposal, request);
      }
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
        const read = payload.editable_reads.find(read => read.file_path === target);
        assert.ok(read, 'Claude Code must return a numbered Read snapshot');
        const frame = 'EDIT ' + read.read_id + ' 1 1 INDENT\n' +
          '0|' + source.slice(0, -1) + '\nEND';
        return parseReply(frame, request, {matchedTurn: true});
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
    '--allowedTools', 'Read', 'Edit', verifyEdits ? 'Bash(' + testCommand + ')' : 'Bash(node verified.mjs)', '--',
    'Read the fixture, write a small program, and run it.'
  ], {
    cwd: dir,
    env: {...process.env, WA_STATE_DIR: state, WA_PORT: String(server.address().port),
      WA_EDIT_FILE: verifyEdits && !multiFile ? target : '',
      WA_EDIT_FILES: multiFile && !discoverFiles ? JSON.stringify([target, helper]) : '',
      WA_TEST_COMMAND: multiFile ? testCommand : '', WA_EDIT_RANGES: multiFile && !discoverFiles ? '[null,[1,1]]' : '',
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
  if (verifyEdits) {
    assert.equal(rounds, discoverFiles ? 4 : 2);
    assert.equal(await readFile(target, 'utf8'), source);
    if (multiFile) assert.equal(await readFile(helper, 'utf8'), helperSource + '// Outside the edit range.\n');
    assert.ok(stdout.includes('ran ' + testCommand + ' successfully'));
    console.log('PASS: The harness tested and reread after each edit, then stopped when the tests passed.');
  } else {
    assert.ok(rounds >= 4);
    assert.ok(stdout.includes(expected));
    console.log('PASS: Claude Code read a file, applied a line-range edit, ran it, and returned the actual output.');
  }
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await rm(dir, {recursive: true, force: true});
}
