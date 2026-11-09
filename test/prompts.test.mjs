import test from 'node:test';
import assert from 'node:assert/strict';
import { compact, coding, parseHarnessArgs } from '../src/prompts.mjs';

test('prompt selection strips only harness options and preserves Claude arguments', () => {
  assert.deepEqual(parseHarnessArgs(['--harness-prompt','coding','-p','fix the test']),
    {mode:'coding',args:['-p','fix the test']});
  assert.equal(parseHarnessArgs(['--harness-prompt=native']).mode, 'native');
  assert.throws(() => parseHarnessArgs(['--harness-prompt','unknown']), /must be/);
  assert.throws(() => parseHarnessArgs(['--harness-prompt']), /must be/);
});
test('argument terminator preserves prompt text that looks like an option', () => {
  assert.deepEqual(parseHarnessArgs(['--','--harness-prompt','native']),
    {mode:'compact',args:['--','--harness-prompt','native']});
});
test('coding prompt retains permission and evidence boundaries', () => {
  assert.ok(compact.includes('permission'));
  assert.ok(coding.includes('AGENTS.md'));
  assert.ok(coding.includes('untrusted'));
  assert.ok(coding.includes('rerun'));
  assert.ok(coding.includes('denied tool calls'));
});
