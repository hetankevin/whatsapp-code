import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadProjectContext } from '../src/project-context.mjs';
import { prepare, parseReply } from '../src/protocol.mjs';
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

test('only numbered Read results lose their display prefixes', () => {
  const numbered = '7\tfunction value() {\n8\t\treturn "a";\n9\t}\n';
  const read = {type:'tool_use', id:'read', name:'Read', input:{file_path:'a.js'}};
  const bash = {type:'tool_use', id:'bash', name:'Bash', input:{command:'example'}};
  const messages = [
    {role:'assistant',content:[read,bash]},
    {role:'user',content:[
      {type:'tool_result',tool_use_id:'read',content:[{type:'text',text:numbered}]},
      {type:'tool_result',tool_use_id:'bash',content:numbered},
      {type:'tool_result',tool_use_id:'read',content:numbered,is_error:true},
      {type:'tool_result',tool_use_id:'read',content:'1\tfirst\n3\tthird'}
    ]}
  ];
  const {prompt} = prepare({messages});
  const payload = JSON.parse(prompt.split('CURRENT REQUEST:\n')[1]);
  const results = payload.messages[1].content;
  assert.equal(results[0].content[0].text, 'function value() {\n\treturn "a";\n}\n');
  assert.equal(results[1].content, numbered);
  assert.equal(results[2].content, numbered);
  assert.equal(results[3].content, '1\tfirst\n3\tthird');
});

test('literal Write and Edit source survives quotes, slashes, indentation, and trailing newline', () => {
  const tools = [
    {name:'Write', input_schema:{type:'object', required:['file_path','content'], properties:{file_path:{type:'string'},content:{type:'string'}},additionalProperties:false}},
    {name:'Edit', input_schema:{type:'object', required:['file_path','old_string','new_string'], properties:{file_path:{type:'string'},old_string:{type:'string'},new_string:{type:'string'}},additionalProperties:false}}
  ];
  const request = prepare({tools,messages:[{role:'user',content:'Edit csv'}]});
  const header = (name,id=request.requestId,input={file_path:'csv.mjs'}) =>
    JSON.stringify({request_id:id,content:[{type:'tool_use',name,input}]});
  const oldSource = 'export const c = "\\n";\n';
  const source = 'export function f(c) {\n  return c === \'"\';\n}\n';
  const write = header('Write')+'\n<<<FILE>>>\n'+source+'\n<<<END>>>';
  const edit = header('Edit')+'\n<<<OLD>>>\n'+oldSource+'\n<<<NEW>>>\n'+source+'\n<<<END>>>';
  assert.equal(parseReply(write,request).content[0].input.content, source);
  assert.deepEqual(parseReply(edit,request).content[0].input, {file_path:'csv.mjs',old_string:oldSource,new_string:source});
  assert.throws(() => parseReply(write.replace(request.requestId,'stale'),request), /does not match/);
  assert.throws(() => parseReply(write.replace('\n<<<END>>>',''),request), /complete protocol/);
  assert.throws(() => parseReply(write.replace(header('Write'),header('Write',request.requestId,{file_path:5})),request), /invalid arguments/);
});
