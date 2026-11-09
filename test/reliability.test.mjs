import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadProjectContext } from '../src/project-context.mjs';
import { prepare } from '../src/protocol.mjs';
import { WhatsApp } from '../src/whatsapp.mjs';

test('project context identifies the real directory and loads only instruction contents', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'wa-context-'));
  try {
    await writeFile(path.join(dir,'AGENTS.md'),'Run node --test. Keep the public API.');
    await writeFile(path.join(dir,'.env'),'SECRET_CONTENT_SHOULD_NOT_LOAD');
    const context = await loadProjectContext(dir);
    assert.ok(context.includes('Run node --test.'));
    assert.ok(context.includes(path.basename(dir)));
    assert.ok(!context.includes('SECRET_CONTENT_SHOULD_NOT_LOAD'));
    await writeFile(path.join(dir,'CLAUDE.md'),'x'.repeat(16001));
    await assert.rejects(loadProjectContext(dir), /nothing was truncated/);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

function transportFixture() {
  const w = Object.create(WhatsApp.prototype);
  const request = prepare({system:'Use this project.', messages:[{role:'user',content:'hello'}]});
  const writes=[];let resolved, rejected;
  w.child = {stdin:{write:line=>writes.push(JSON.parse(line))}};
  w.pending = {id:'original',request,messageIds:new Set(),repairCount:0,
    resolve:value=>{resolved=value},reject:error=>{rejected=error}};
  return {w,request,writes,get resolved(){return resolved},get rejected(){return rejected}};
}
test('one format repair can recover a reply; old message targets cannot complete it', async () => {
  const f=transportFixture();
  await f.w.event({event:'message',id:'bad',target:'original',edit:'full',message:{conversation:'{broken json'}});
  assert.equal(f.writes.length,1);assert.notEqual(f.writes[0].id,'original');
  const valid=JSON.stringify({request_id:f.request.requestId,content:[{type:'text',text:'hello'}]});
  await f.w.event({event:'message',id:'late',target:'original',edit:'full',message:{conversation:valid}});
  assert.equal(f.resolved,undefined);
  await f.w.event({event:'message',id:'fixed',target:f.writes[0].id,edit:'full',message:{conversation:valid}});
  assert.equal(f.resolved.content[0].text,'hello');
});
test('repair is bounded and never repairs a valid JSON reply for the wrong request', async () => {
  const f=transportFixture();
  await f.w.event({event:'message',id:'bad',target:'original',edit:'full',message:{conversation:'not json'}});
  await f.w.event({event:'message',id:'stillbad',target:f.writes[0].id,edit:'full',message:{conversation:'still not json'}});
  assert.equal(f.writes.length,1);assert.match(f.rejected.message,/JSON/);
  const other=transportFixture();
  await other.w.event({event:'message',id:'wrong',target:'original',edit:'full',message:{conversation:JSON.stringify({request_id:'wrong',content:[{type:'text',text:'x'}]})}});
  assert.equal(other.writes.length,0);assert.match(other.rejected.message,/match/);
});
