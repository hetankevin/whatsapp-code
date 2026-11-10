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

function transportFixture(tools = []) {
  const w = Object.create(WhatsApp.prototype);
  const request = prepare({tools, system:'Use this project.', messages:[{role:'user',content:'hello'}]});
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
test('format repair is bounded', async () => {
  const f=transportFixture();
  await f.w.event({event:'message',id:'bad',target:'original',edit:'full',message:{conversation:'{not json'}});
  await f.w.event({event:'message',id:'stillbad',target:f.writes[0].id,edit:'full',message:{conversation:'{still not json'}});
  assert.equal(f.writes.length,1);assert.match(f.rejected.message,/JSON/);
});

test('a matched final WhatsApp answer can be ordinary text', async () => {
  const f = transportFixture();
  const answer = 'A faster bound uses preprocessing.\n\nThe details depend on the computation model.';
  const event = (id, target, edit, text, edit_target) => ({
    event:'message', id, target, edit, edit_target, message:{extendedTextMessage:{text}}
  });
  await f.w.event(event('late', 'old-turn', 'full', answer));
  await f.w.event(event('partial', 'original', 'first', 'A faster bound'));
  assert.equal(f.resolved, undefined);
  await f.w.event(event('final', undefined, 'last', answer, 'partial'));
  assert.deepEqual(f.resolved.content, [{type:'text',text:answer}]);
  assert.equal(f.resolved.stop_reason, 'end_turn');
  assert.equal(f.writes.length, 0);

  const body = {messages:[{role:'user',content:'Question'}]};
  for (const choice of ['auto', 'none']) {
    const request = prepare({...body,tool_choice:{type:choice}});
    assert.throws(() => parseReply(answer, request), /protocol JSON/);
    assert.throws(() => parseReply('Here is the tool: {"type":"tool_use"', request, {matchedTurn:true}), /protocol JSON/);
  }
  const required = prepare({...body,tool_choice:{type:'any'}});
  assert.throws(() => parseReply(answer, required, {matchedTurn:true}), /protocol JSON/);
  assert.throws(() => parseReply(answer, {...f.request,editFiles:['/fixture.js']}, {matchedTurn:true}), /protocol JSON/);
});

test('reply repair covers malformed envelopes and tool arguments without consuming the context budget', async () => {
  const read = {name:'Read',input_schema:{
    type:'object',required:['file_path'],properties:{file_path:{type:'string'}}
  }};
  const fence = '\x60'.repeat(3);
  const answer = '[Guide](https://example.invalid)\n\n' + fence + 'js\nlet result = 1;\n' + fence;
  for (const text of [
    fence + 'json\n{incomplete',
    'Proposed edit:\nEDIT nonce toolu_read 1 1\nsource',
    '{"content":[{"type":"tool_use","name":"Read","input":{"file_path":1}}]}',
    '{"content":[{"type":"tool_use","name":"Unknown","input":{}}]}',
    ''
  ]) {
    const f = transportFixture([read]);
    const event = (id, target, text) => ({event:'message',id,target,edit:'last',message:{conversation:text}});
    await f.w.event(event('bad', 'original', text));
    assert.equal(f.resolved, undefined);
    assert.equal(f.writes.length, 1);
    await f.w.event(event('valid', f.writes[0].id, answer));
    assert.deepEqual(f.resolved.content, [{type:'text',text:answer}]);
  }

  const f = transportFixture([read]);
  f.request.maxChars = f.request.prompt.length + 1200;
  await f.w.event({event:'message',id:'large',target:'original',edit:'last',
    message:{conversation:'{"content":' + 'x'.repeat(4000)}});
  assert.equal(f.writes.length, 1);
  assert.ok(f.writes[0].prompt.includes(f.request.prompt));
  assert.ok(f.writes[0].prompt.length <= f.request.maxChars);
});

test('the current user turn stays visible after prior tasks and tool results', () => {
  const messages = [
    {role:'user',content:'Fix the old task.'},
    {role:'assistant',content:[{type:'text',text:'The old task is in progress.'}]},
    {role:'user',content:'Explain the new topic.'},
    {role:'user',content:[{type:'text',text:'<system-reminder>Keep context.</system-reminder>'}]},
    {role:'user',content:[{type:'tool_result',tool_use_id:'read',content:'Old file text.'}]}
  ];
  const payload = choice => JSON.parse(prepare({messages,tool_choice:{type:choice}}).prompt.split('CURRENT REQUEST:\n')[1]);
  assert.equal(payload('auto').current_request, 'Explain the new topic.');
  assert.equal(payload('auto').messages[0].content, 'Fix the old task.');
  assert.equal(payload('none').current_request, undefined);
  assert.equal(payload('none').messages[2].content, 'Explain the new topic.');
});

test('a matched reply without an answer gets one repair', async () => {
  const reply = (id, target, body) => ({
    event:'message', id, target, edit:'full', message:{conversation:JSON.stringify(body)}
  });
  for (const invalid of [{}, {content:[]}, {content:[{type:'text',text:'  '}]}]) {
    const f = transportFixture();
    await f.w.event(reply('empty', 'original', invalid));
    assert.equal(f.writes.length, 1);
    assert.equal(f.rejected, undefined);
    await f.w.event(reply('fixed', f.writes[0].id, {content:[{type:'text',text:'I am here.'}]}));
    assert.equal(f.resolved.content[0].text, 'I am here.');
  }

  const f = transportFixture();
  await f.w.event(reply('empty', 'original', {content:[]}));
  await f.w.event(reply('still-empty', f.writes[0].id, {content:[]}));
  assert.equal(f.writes.length, 1);
  assert.match(f.rejected.message, /no content/);
});

test('stale IDs get one fresh prompt and ID-free calls still require a matched WhatsApp turn', async () => {
  const f = transportFixture([{name: 'Grep', input_schema: {
    type: 'object', properties: {pattern: {type: 'string'}}, required: ['pattern']
  }}]);
  const old = JSON.stringify({request_id: 'old', content: [{type: 'text', text: 'STALE PAYLOAD'}]});
  const fresh = JSON.stringify({content: [{type: 'tool_use', name: 'Grep', input: {pattern: 'SessionCache'}}]});
  const event = (id, target, conversation) => f.w.event({event: 'message', id, target, edit: 'full', message: {conversation}});

  assert.throws(() => parseReply(fresh, f.request), /does not match/);
  await event('old-turn', 'unrelated', fresh);
  assert.equal(f.resolved, undefined);
  assert.equal(f.writes.length, 0);
  await event('stale', 'original', old);
  assert.equal(f.resolved, undefined);
  assert.equal(f.writes.length, 1);
  assert.ok(f.writes[0].prompt.endsWith(f.request.prompt));
  assert.doesNotMatch(f.writes[0].prompt, /STALE PAYLOAD/);
  await event('late', 'original', fresh);
  assert.equal(f.resolved, undefined);
  await event('fresh', f.writes[0].id, fresh);
  assert.equal(f.resolved.content[0].name, 'Grep');
  assert.deepEqual(f.resolved.content[0].input, {pattern: 'SessionCache'});

  const repeated = transportFixture();
  const reply = target => repeated.w.event({event: 'message', id: target + '-reply', target, edit: 'full', message: {conversation: old}});
  await reply('original');
  await reply(repeated.writes[0].id);
  assert.equal(repeated.writes.length, 1);
  assert.match(repeated.rejected.message, /does not match/);
});

test('old sessions omit the stock attribution reminder and keep other context', () => {
  const stock = `<system-reminder>
Attribution for git commits and pull requests you create from here on (this replaces Claude Code's own earlier attribution guidance, such as a previous copy of this reminder; the user's own instructions about these lines, such as a CLAUDE.md or memory rule, take precedence over this reminder, but do not add attribution lines this reminder leaves out):
- End git commit messages with:
Co-Authored-By: Claude Code <noreply@anthropic.com>
- End pull request descriptions with:
🤖 Generated with [Claude Code](https://claude.com/claude-code)
</system-reminder>
`;
  const custom = '<system-reminder>Use the repository commit conventions.</system-reminder>';
  const task = {type:'text',text:'Fix the bug.'};
  const reminder = {type:'text',text:stock};
  const bash = {type:'tool_use',id:'bash',name:'Bash',input:{command:'example'}};
  const output = {type:'tool_result',tool_use_id:'bash',is_error:false,content:stock};
  const messages = [
    {role:'user',content:[task, reminder, {type:'text',text:custom}]},
    {role:'assistant',content:[bash]},
    {role:'user',content:[output]},
    {role:'user',content:[reminder]}
  ];
  const payload = snapshot => JSON.parse(prepare({messages}, 60000, snapshot).prompt.split('CURRENT REQUEST:\n')[1]);
  assert.deepEqual(payload(false).messages, [
    {role:'user',content:'[See current_request below.]'},
    {role:'assistant',content:[bash]},
    {role:'user',content:[output]}
  ]);
  assert.deepEqual(payload(false).current_request, [task, {type:'text',text:custom}]);
  assert.deepEqual(payload(true).task, [task, {type:'text',text:custom}]);
});

test('a failed filtered Grep gets one native retry with the original scope', () => {
  const tools = [{name:'Grep',input_schema:{type:'object',required:['pattern','path']}}];
  const input = {pattern:'baseConfig',path:'lib',glob:'*_/_.js',output_mode:'content'};
  const call = {type:'tool_use',id:'original-search',name:'Grep',input};
  const result = {type:'tool_result',tool_use_id:call.id,content:[{type:'text',text:'No matches found'}]};
  const user = block => ({role:'user',content:[block]});
  const assistant = block => ({role:'assistant',content:[block]});
  const messages = [{role:'user',content:'Find the relevant config.'}, assistant(call), user(result)];
  const [retry] = prepare({tools,messages}).localResult.content;
  assert.equal(retry.name,'Grep');
  assert.deepEqual(retry.input,{pattern:'baseConfig',path:'lib',output_mode:'content'});
  assert.equal(call.input.glob,'*_/_.js');
  assert.equal(prepare({tools,messages:[...messages, assistant(retry), user({
    ...result,tool_use_id:retry.id
  })]}).localResult, undefined);
  assert.equal(prepare({tools,messages:[...messages.slice(0,-1),user({
    ...result,is_error:true
  })]}).localResult, undefined);
  assert.equal(prepare({tools,messages,tool_choice:{type:'none'}}).localResult, undefined);
});

test('an empty glob-free retry falls back to a leading literal once', () => {
  const tools = [{name:'Grep',input_schema:{type:'object',required:['pattern','path']}}];
  const call = {type:'tool_use',id:'toolu_grep_retry_fixture',name:'Grep',
    input:{pattern:'baseConfig.*extends',path:'lib',head_limit:10}};
  const noMatch = id => ({role:'user',content:[{type:'tool_result',tool_use_id:id,content:'No matches found'}]});
  const messages = [{role:'assistant',content:[call]}, noMatch(call.id)];
  const [literal] = prepare({tools,messages}).localResult.content;
  assert.match(literal.id, /^toolu_grep_literal_/);
  assert.deepEqual(literal.input,{pattern:'baseConfig',path:'lib',head_limit:10});
  assert.equal(prepare({tools,messages:[
    ...messages,{role:'assistant',content:[literal]},noMatch(literal.id)
  ]}).localResult, undefined);
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
  const [read] = payload.editable_reads;
  assert.match(read.read_id, /^r[0-9a-f]{12}$/);
  assert.deepEqual(read, {read_id:request.editableReads[0].read_id,file_path:'module.js',start_line:7,end_line:9});
  assert.ok(!payload.tools.some(tool => tool.name === 'EditLines'));
  assert.match(request.prompt, /standalone EDIT frame shown below, outside JSON/);
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

test('large translated edits keep the changed lines and linked result in the WhatsApp transcript', () => {
  const unchanged = 'const value = "' + 'a'.repeat(20000) + '";';
  const request = lineEditRequest([], {
    type:'tool_result',tool_use_id:'read-x',content:'7\t' + unchanged + '\n8\treturn "old";\n9\t}'
  });
  const [edit] = parseReply('EDIT ' + request.editableReads[0].read_id + ' 8 8\nreturn "new";\nEND',
    request, {matchedTurn:true}).content;
  assert.equal(edit.input.old_string, unchanged + '\nreturn "old";\n}');
  assert.equal(edit.input.new_string, unchanged + '\nreturn "new";\n}');
  const result = {type:'tool_result',tool_use_id:edit.id,content:'File updated.'};
  const followUp = lineEditRequest([
    {role:'assistant',content:[edit]},
    {role:'user',content:[result]}
  ], {type:'tool_result',tool_use_id:'read-x',content:'7\t' + unchanged + '\n8\treturn "old";\n9\t}'});
  const {messages} = JSON.parse(followUp.prompt.split('CURRENT REQUEST:\n')[1]);
  assert.equal(followUp.prompt.split('a'.repeat(20000)).length, 2);
  assert.deepEqual(messages[2].content[0], {
    type:'tool_use',id:edit.id,name:'Edit',input:{file_path:'module.js'},
    changed_lines:{before:'return "old";',after:'return "new";'}
  });
  assert.equal(messages[3].content[0].tool_use_id, edit.id);
});

test('short edit frames require a matched turn and the current Read handle', () => {
  const original = lineEditRequest();
  const oldHandle = original.editableReads[0].read_id;
  const frame = handle => 'EDIT ' + handle + ' 8 8 INDENT\n2|return "new";\nEND';
  assert.throws(() => parseReply(frame(oldHandle), original), /does not match/);
  const parsed = parseReply(frame(oldHandle), original, {matchedTurn:true});
  assert.equal(parsed.content[0].input.new_string, 'const a = 1;\n  return "new";\n}');

  const fresh = lineEditRequest([
    {role:'assistant',content:[{type:'tool_use',name:'Read',id:'read-y',input:{file_path:'module.js',offset:7}}]},
    {role:'user',content:[{type:'tool_result',tool_use_id:'read-y',content:'7\tconst a = 2;\n8\t  return "newer";\n9\t}'}]}
  ]);
  assert.throws(() => parseReply(frame(oldHandle), fresh, {matchedTurn:true}), /current Read snapshot/);
  const next = parseReply(frame(fresh.editableReads[0].read_id), fresh, {matchedTurn:true});
  assert.equal(next.content[0].input.old_string, 'const a = 2;\n  return "newer";\n}');
});

test('literal quotes and line breaks in a final edit string preserve source bytes', () => {
  const request = lineEditRequest();
  const read = request.editableReads[0].read_id;
  const envelope = (source, read_id = read) => '{"content":[{"type":"text","text":"I found the change."},' +
    '{"type":"tool_use","name":"EditLines","input":' +
    JSON.stringify({read_id,start_line:8,end_line:8}).slice(0,-1) +
    ',"new_string":"' + source + '"}}]}';
  const literal = '  const empty = "";\n  return empty + "\\\\n";';
  const reply = parseReply(envelope(literal), request, {matchedTurn:true});
  assert.equal(reply.content[1].input.new_string, 'const a = 1;\n  const empty = "";\n  return empty + "\\n";\n}');
  assert.throws(() => parseReply(envelope(literal), request), /does not match/);
  assert.throws(() => parseReply(envelope(literal, 'stale'), request, {matchedTurn:true}), /current Read snapshot/);
  assert.throws(() => parseReply(envelope('line\n", "extra":"value'), request, {matchedTurn:true}), /complete protocol/);
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

test('nested EDIT headers never become source and are unwrapped only for matching metadata', () => {
  const request = lineEditRequest();
  const nonce = request.requestId;
  const nested = 'EDIT '+nonce+' read-x 8 8\n2|return "value";\n0|\nEND '+nonce;
  const reply = (new_string, end_line=8) => JSON.stringify({request_id:nonce, content:[
    {type:'tool_use',name:'EditLines',input:{read_id:'read-x',start_line:8,end_line,new_string}}
  ]});
  const [edit] = parseReply(reply(nested),request).content;
  assert.equal(edit.input.new_string, 'const a = 1;\n  return "value";\n\n}');
  assert.throws(() => parseReply(reply(nested,9),request), /disagrees/);
  assert.throws(() => parseReply(reply(nested.replace('END '+nonce,'END wrong')),request), /one complete EDIT frame/);
  assert.throws(() => parseReply(reply(nested.replaceAll(nonce,'0'.repeat(24))),request), /stale request ID/);
  const literal = '2|3';
  assert.equal(parseReply(reply(literal),request).content[0].input.new_string, 'const a = 1;\n2|3\n}');
});

test('recover a complete EDIT frame inside malformed JSON without changing literal code', () => {
  const request = lineEditRequest();
  const nonce = request.requestId;
  const source = "return c === '\"' ? '\\\\n' : c;";
  const frame = 'EDIT '+nonce+' read-x 8 8 INDENT\n2|'+source+'\nEND '+nonce;
  const header = '{"request_id":"'+nonce+'","content":[{"type":"tool_use","name":"EditLines","input":'
    +'{"read_id":"read-x","start_line":8,"end_line":8,"new_string":"';
  const wrap = (body, tail = '"}}]}') => header + body + tail;
  for (const reply of [wrap(frame), wrap(frame, '"}]}')]) {
    assert.throws(() => JSON.parse(reply), SyntaxError);
    assert.equal(parseReply(reply,request).content[0].input.new_string,'const a = 1;\n  '+source+'\n}');
  }
  assert.throws(() => parseReply(wrap(frame.replace('read-x 8 8','read-x 8 9')),request), /disagrees/);
  assert.throws(() => parseReply(wrap(frame.replaceAll(nonce,'1'.repeat(24))),request), /stale request ID/);
  assert.throws(() => parseReply(wrap(frame.split('\nEND ')[0]),request), /complete protocol/);
  assert.throws(() => parseReply(wrap(frame).replace('"EditLines"','"Edit"'),request), /complete protocol/);
});

test('snapshot context keeps one current read and the latest test outcome', () => {
  const tools = ['Read', 'Edit', 'Bash'].map(name => ({name, input_schema: {type: 'object'}}));
  const call = (id, name, input) => ({role: 'assistant', content: [{type: 'tool_use', id, name, input}]});
  const result = (id, content, is_error = false) => ({
    role: 'user', content: [{type: 'tool_result', tool_use_id: id, content, is_error}]
  });
  const messages = [
    {role: 'user', content: 'Fix CSV.'},
    call('old', 'Read', {file_path: 'csv.mjs'}),
    result('old', '1\tobsolete source'),
    call('failed', 'Bash', {command: 'node --test'}),
    result('failed', 'not ok 1 - quoted empty field', true),
    call('notes', 'Read', {file_path: 'AGENTS.md'}),
    result('notes', '1\tolder instructions read'),
    call('current', 'Read', {file_path: 'csv.mjs'}),
    result('current', '1\texport function parseCSV() {\n2\t  return [];\n3\t}')
  ];
  const prepareSnapshot = extra => prepare({tools, messages: [...messages, ...extra]}, 60000, true);
  const payload = request => JSON.parse(request.prompt.split('CURRENT REQUEST:\n')[1]);
  const request = prepareSnapshot([]);
  const state = payload(request);
  assert.equal(state.task, 'Fix CSV.');
  assert.equal(state.current_file, messages.at(-1).content[0].content);
  assert.deepEqual(state.editable_reads.map(read => request.readHandles.get(read.read_id)), ['current']);
  assert.deepEqual(state.latest_test_failure, {command: 'node --test', failure: 'not ok 1 - quoted empty field'});
  assert.doesNotMatch(request.prompt, /obsolete source|older instructions read|"messages":/);
  const edit = readId => 'EDIT ' + request.requestId + ' ' + readId + ' 2 2\n  return [[""]];\nEND ' + request.requestId;
  assert.throws(() => parseReply(edit('notes'), request), /current Read snapshot/);
  assert.equal(parseReply(edit('current'), request).content[0].input.new_string,
    'export function parseCSV() {\n  return [[""]];\n}');

  const edited = [
    call('edit', 'Edit', {file_path: 'csv.mjs'}),
    result('edit', 'file updated')
  ];
  const afterEdit = payload(prepareSnapshot(edited));
  assert.equal(afterEdit.current_file, undefined);
  assert.equal(afterEdit.latest_test_failure.failure, state.latest_test_failure.failure);
  assert.deepEqual(afterEdit.last_tool_status, [{tool: 'Edit', file_path: 'csv.mjs', status: 'succeeded'}]);

  const syntaxError = '# file:///project/csv.mjs:58\n# SyntaxError: Unexpected end of input';
  const failedAgain = payload(prepareSnapshot([...edited,
    call('syntax', 'Bash', {command: 'node --test'}),
    result('syntax', 'TAP version 13\n' + syntaxError + '\nnot ok 1 - behavior.test.mjs', true)
  ]));
  assert.ok(failedAgain.latest_test_failure.failure.startsWith(syntaxError));

  const passed = payload(prepareSnapshot([...edited,
    call('passed', 'Bash', {command: 'node --test'}),
    result('passed', 'ok 1 - quoted empty field')
  ]));
  assert.equal(passed.latest_test_failure, undefined);
  assert.deepEqual(passed.last_tool_status, [{tool: 'Bash', command: 'node --test', status: 'succeeded'}]);
});
