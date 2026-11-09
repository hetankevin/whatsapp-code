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

function lineEditRequest(extra = [], result = {type:'tool_result',tool_use_id:'read-x',content:'7\tconst a = 1;\n8\t  return "old";\n9\t}'}) {
  const tools = ['Read', 'Edit', 'Bash'].map(name => ({name,input_schema:{type:'object'}}));
  const messages = [
    {role:'assistant',content:[{type:'tool_use',name:'Read',id:'read-x',input:{file_path:'module.js',offset:7}}]},
    {role:'user',content:[result]},
    ...extra
  ];
  return prepare({tools,messages});
}

test('EditLines uses exact source and preserves lines outside the range', () => {
  const request = lineEditRequest();
  const payload = JSON.parse(request.prompt.split('CURRENT REQUEST:\n')[1]);
  assert.deepEqual(payload.editable_reads, [{read_id:'read-x',file_path:'module.js',start_line:7,end_line:9}]);
  assert.ok(payload.tools.some(tool => tool.name === 'EditLines'));
  assert.ok(!payload.tools.some(tool => tool.name === 'Edit'));
  const header = JSON.stringify({request_id:request.requestId, content:[
    {type:'tool_use',name:'EditLines',input:{read_id:'read-x',start_line:8,end_line:8}}
  ]});
  const [edit] = parseReply(header+'\n<<<NEW>>>\n  return "\\\\n";\n<<<END>>>',request).content;
  assert.match(edit.id, /^toolu_lines_/);
  assert.equal(edit.name, 'Edit');
  assert.deepEqual(edit.input, {
    file_path:'module.js',
    old_string:'const a = 1;\n  return "old";\n}',
    new_string:'const a = 1;\n  return "\\\\n";\n}'
  });
});

test('range edits reject unobserved lines, stale snapshots, and parallel calls', () => {
  const call = (input = {}) => ({type:'tool_use',name:'EditLines',input:{
    read_id:'read-x',start_line:8,end_line:8,new_string:'',...input
  }});
  const reply = (request, ...content) => JSON.stringify({request_id:request.requestId,content});
  const request = lineEditRequest();
  assert.throws(() => parseReply(reply(request,call({start_line:6})),request), /outside/);
  assert.throws(() => parseReply(reply(request,call({end_line:10})),request), /outside/);
  assert.throws(() => parseReply(reply(request,call(),call()),request), /without other tools/);
  assert.equal(parseReply(reply(request,call()),request).content[0].input.new_string, 'const a = 1;\n}');
  const stale = lineEditRequest([{role:'assistant',content:[
    {type:'tool_use',name:'Bash',id:'cmd',input:{command:'node --test'}}
  ]}]);
  assert.throws(() => parseReply(reply(stale,call()),stale), /current Read snapshot/);
  const unnumbered = lineEditRequest([], {type:'tool_result',tool_use_id:'read-x',content:'unnumbered'});
  assert.throws(() => parseReply(reply(unnumbered,call()),unnumbered), /current Read snapshot/);
});

test('EDIT header preserves fenced source and accepts the observed older inline marker', () => {
  const request = lineEditRequest();
  const nonce = request.requestId;
  const code = '  const quote = \'"\';\n\treturn "\\\\n";';
  const fence = '\x60'.repeat(3);
  const reply = 'EDIT '+nonce+' read-x 8 8\n'+fence+'js\n'+code+'\n'+fence+'\nEND '+nonce;
  const [edit] = parseReply(reply,request).content;
  assert.equal(edit.input.new_string, 'const a = 1;\n'+code+'\n}');
  assert.throws(() => parseReply(reply.replace('END '+nonce,'END stale'),request), /complete protocol/);
  assert.throws(() => parseReply(reply.replaceAll(nonce,'stale'),request), /does not match/);
  const legacy = JSON.stringify({request_id:nonce,content:[
    {type:'tool_use',name:'EditLines',input:{read_id:'read-x',start_line:8,end_line:8}}
  ]}) + ' <<<NEW>>\n' + code + '\n<<<END>>>';
  assert.deepEqual(parseReply(legacy,request).content[0].input, edit.input);
});

test('an unchanged failed test gets a repair with the assertion and can rerun after an edit', () => {
  const tools = ['Bash','Read','Edit'].map(name=>({name,input_schema:{type:'object'}}));
  const testCall = {type:'tool_use',name:'Bash',input:{command:'node --test'}};
  const messages = [
    {role:'user',content:'Fix expiration.'},
    {role:'assistant',content:[{...testCall,id:'test-one'}]},
    {role:'user',content:[{type:'tool_result',tool_use_id:'test-one',is_error:true,
      content:'Exit code 1\nok 1 - defaults\nnot ok 2 - expires at deadline\nAssertionError: 1 !== undefined'}]},
    {role:'assistant',content:[{type:'tool_use',name:'Read',id:'r',input:{file_path:'cache.mjs'}}]},
    {role:'user',content:[{type:'tool_result',tool_use_id:'r',content:'1\treturn 1;'}]}
  ];
  const run = request => parseReply(JSON.stringify({request_id:request.requestId,content:[testCall]}),request);
  const blocked = prepare({tools,messages});
  assert.throws(() => run(blocked), error => error.repairable && /not ok 2 - expires at deadline/.test(error.testFailure));
  const edited = prepare({tools,messages:[...messages,
    {role:'assistant',content:[{type:'tool_use',id:'edit',name:'Edit',input:{file_path:'cache.mjs'}}]},
    {role:'user',content:[{type:'tool_result',tool_use_id:'edit',content:'File updated'}]}
  ]});
  assert.equal(run(edited).content[0].name, 'Bash');
  const requested = prepare({tools,messages:[...messages,{role:'user',content:'Run the tests again.'}]});
  assert.equal(run(requested).content[0].name, 'Bash');
});

test('encoded indentation survives CRLF framing without changing source characters', () => {
  const request = lineEditRequest();
  const nonce = request.requestId;
  const reply = ['EDIT '+nonce+' read-x 8 8 INDENT', '2|return "\\\\n";', 'st|next();', '0|', 'END '+nonce].join('\r\n');
  const [edit] = parseReply(reply,request).content;
  assert.equal(edit.input.new_string, 'const a = 1;\n  return "\\\\n";\r\n \tnext();\r\n\n}');
  assert.throws(() => parseReply(reply.replace('st|next','next'),request), /complete protocol/);
});
