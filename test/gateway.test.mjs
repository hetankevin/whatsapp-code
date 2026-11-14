import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { prepare, parseReply, extractText } from '../src/protocol.mjs';
import { createGateway } from '../src/server.mjs';
import { WhatsApp } from '../src/whatsapp.mjs';

const body = () => ({model:'meta-ai-whatsapp',max_tokens:1024,messages:[{role:'user',content:'Read example.txt'}],tools:[{name:'Read',description:'Read a file',input_schema:{type:'object',properties:{file_path:{type:'string'}},required:['file_path'],additionalProperties:false}}]});
const reply = (r,content) => JSON.stringify({request_id:r.requestId,content});
test('tool round trip preserves IDs, arguments, and error results',()=>{
 const r=prepare(body());
 const m=parseReply(reply(r,[{type:'tool_use',name:'Read',input:{file_path:'example.txt'}}]),r);
 assert.equal(m.stop_reason,'tool_use');
 const b=body(); b.messages.push({role:'assistant',content:m.content},{role:'user',content:[{type:'tool_result',tool_use_id:m.content[0].id,is_error:true,content:'file missing'}]});
 const next=prepare(b);
 assert.ok(next.prompt.includes(m.content[0].id)); assert.ok(next.prompt.includes('file missing'));
 assert.equal(parseReply(reply(next,[{type:'text',text:'The file is missing.'}]),next).stop_reason,'end_turn');
});
test('invalid tool calls and mismatched replies fail closed',()=>{
 const r=prepare(body());
 for(const c of [[{type:'tool_use',name:'Bash',input:{command:'x'}}],[{type:'tool_use',name:'Read',input:{file_path:1}}],[{type:'image',source:{}}]]) assert.throws(()=>parseReply(reply(r,c),r));
 assert.throws(()=>parseReply('{"request_id":"stale","content":[{"type":"text","text":"x"}]}',r),/match/);
 assert.throws(()=>parseReply('I will run Read now',r),/JSON/);
});
test('native Read ignores a misplaced display label while validating the actual arguments', () => {
 const r=prepare(body());
 const read=input=>parseReply(reply(r,[{type:'tool_use',name:'Read',input}]),r);
 assert.deepEqual(read({file_path:'example.txt',description:'Inspect the file'}).content[0].input,{file_path:'example.txt'});
 assert.throws(()=>read({file_path:4,description:'Inspect the file'}), /invalid arguments/);
 assert.throws(()=>read({file_path:'example.txt',other:'unsupported'}), /invalid arguments/);
});
test('matched replies can carry a read-only call after an explanation', () => {
 const b=body();
 b.tools.push({name:'Bash', input_schema:{type:'object'}});
 const r=prepare(b);
 const prefix='I will inspect the caller.\n';
 const call={type:'tool_use',name:'Read',input:{file_path:'example.txt'}};
 const text=prefix+JSON.stringify({content:[call]});
 assert.equal(parseReply(text,r,{matchedTurn:true}).content[0].name,'Read');
 assert.throws(()=>parseReply(text,r), /complete protocol/);
 assert.throws(()=>parseReply('EDIT invalid frame\n'+text,r,{matchedTurn:true}), /complete protocol/);
 assert.throws(()=>parseReply(prefix+JSON.stringify({content:[call,{...call,name:'Bash'}]}),r,
   {matchedTurn:true}), /complete protocol/);
 const plan = '\n\nThen edit the caller.\nEDIT old 1 1\nreplacement\nEND\n' +
   JSON.stringify({content:[{type:'tool_use',name:'Bash',input:{command:'npm test'}}]});
 for (const lead of ['', prefix]) {
   const [first, later] = parseReply(lead+JSON.stringify({content:[call]})+plan,r,{matchedTurn:true}).content;
   assert.equal(first.name,'Read');
   assert.equal(later,undefined);
 }
 assert.throws(()=>parseReply(prefix+reply(r,[call]).replace(r.requestId,'old')+plan,r,{matchedTurn:true}), /does not match/);
 assert.throws(()=>parseReply(prefix+JSON.stringify({content:[{...call,name:'Bash'}]})+'\n\n'+text,
   r,{matchedTurn:true}), /complete protocol/);
 assert.throws(()=>parseReply('EDIT invalid frame\n'+text+plan,r,{matchedTurn:true}), /complete protocol/);
 const direct = JSON.stringify([{...call,id:'toolu_supplied_by_bot'}]);
 const [read] = parseReply(direct,r,{matchedTurn:true}).content;
 assert.equal(read.name,'Read');
 assert.notEqual(read.id,'toolu_supplied_by_bot');
 assert.throws(()=>parseReply(direct,r), /does not match/);
 assert.throws(()=>parseReply(JSON.stringify([call,{...call,name:'Bash'}]),r,{matchedTurn:true}), /no content/);
 assert.throws(()=>parseReply(direct.replace('"example.txt"','42'),r,{matchedTurn:true}), /invalid arguments/);
});
test('matched Grep replies preserve unescaped regex syntax', () => {
 const b = body();
 b.tools.push({name:'Grep', input_schema:{type:'object',required:['pattern'],properties:{pattern:{type:'string'}}}});
 const r = prepare(b);
 const pattern = String.raw`class\s*\{`;
 const grep = String.raw`{"content":[{"type":"tool_use","name":"Grep","input":{"pattern":"class\s*\{"}}]}`;
 const matched = {matchedTurn:true};
 for (const lead of ['', 'Search the project:\n']) {
   const [call] = parseReply(lead + grep, r, matched).content;
   assert.equal(call.name, 'Grep');
   assert.equal(call.input.pattern, pattern);
 }
 assert.equal(parseReply(grep.replace(pattern, String.raw`class\\s*\{`), r, matched).content[0].input.pattern, pattern);
 assert.throws(() => parseReply(grep, r), /complete protocol/);
 assert.throws(() => parseReply(grep.replace('Grep','Read'), r, matched), /complete protocol/);
 assert.throws(() => parseReply(grep.replace('"pattern"','"file_path"'), r, matched), /complete protocol/);
 assert.throws(() => parseReply(grep.replace('{"content"','{"request_id":"old","content"'), r, matched), /does not match/);
});
test('required tool selection and no-tools are enforced',()=>{
 const b=body(); b.tool_choice={type:'none'};let r=prepare(b);
 assert.throws(()=>parseReply(reply(r,[{type:'tool_use',name:'Read',input:{file_path:'x'}}]),r));
 b.tool_choice={type:'any'};r=prepare(b);
 assert.throws(()=>parseReply(reply(r,[{type:'text',text:'done'}]),r));
});
test('unsupported media and oversized context are rejected without truncation',()=>{
 const b=body();b.messages[0].content=[{type:'image',source:{type:'base64',data:'abc'}}];
 assert.throws(()=>prepare(b),/Unsupported/);
 assert.throws(()=>prepare(body(),10),/No context was truncated/);
 const b2=body(); b2.thinking={type:'enabled'}; assert.throws(()=>prepare(b2),/thinking/);
});
test('known rich response and nested fields extract only text',()=>{
 assert.equal(extractText({botForwardedMessage:{message:{richResponseMessage:{submessages:[{codeMetadata:{codeBlocks:[{codeContent:'{"x":'},{codeContent:'1}'}]}}]}}}}),'{"x":1}');
 const code = '  return 1;';
 const rich = {richResponseMessage:{submessages:[{codeMetadata:{codeBlocks:[{codeContent:code}]}}]}};
 const fence = '\x60'.repeat(3);
 assert.equal(extractText(rich),code);
 assert.equal(extractText(rich,true),[fence,code,fence].join('\n'));
 const framed = {richResponseMessage:{submessages:[
  {messageText:'FILE 2\nREPLACE 7 7'},
  {codeMetadata:{codeBlocks:[{codeContent:code}]}},
  {messageText:'END'}
 ]}};
 assert.equal(extractText(framed,true),'FILE 2\nREPLACE 7 7\n'+code+'\nEND');
 assert.equal(extractText({secret:'not text',messageContextInfo:{persona:'ignore'}}),'');
});
test('WhatsApp matching rejects late replies and uses final JSON only',async()=>{
 const w=Object.create(WhatsApp.prototype); const r=prepare(body()); let resolved=null;
 w.pending={id:'outbound',request:r,messageIds:new Set(),resolve:x=>{resolved=x},reject:e=>{throw e}};
 const text=reply(r,[{type:'text',text:'correct'}]);
 await w.event({event:'message',id:'wrong',target:'old',edit:'last',message:{conversation:text}});
 assert.equal(resolved,null);
 await w.event({event:'message',id:'first',target:'outbound',edit:'first',message:{conversation:'{"request_id":'}});
 assert.equal(resolved,null);
 await w.event({event:'message',id:'last',edit_target:'first',edit:'last',message:{conversation:text}});
 assert.equal(resolved.content[0].text,'correct');
});
test('valid intermediate bot edits never execute before a final edit',async()=>{
 const w=Object.create(WhatsApp.prototype);const r=prepare(body());let resolved=false;
 w.pending={id:'outbound',request:r,messageIds:new Set(),resolve:()=>{resolved=true},reject:e=>{throw e}};
 await w.event({event:'message',id:'intermediate',target:'outbound',edit:'inner',message:{conversation:reply(r,[{type:'tool_use',name:'Read',input:{file_path:'x'}}])}});
 assert.equal(w.pending.settle,undefined);assert.equal(resolved,false);
});
async function withServer(fn,complete=async r=>parseReply(reply(r,[{type:'text',text:'ok'}]),r)){
 const server=createGateway({backend:{ready:true,status:'ready',complete},token:'test-key'});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 try{await fn('http://127.0.0.1:'+server.address().port);}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}
const post=(base,extra={},headers={},signal)=>fetch(base+'/v1/messages?beta=true',{method:'POST',signal,headers:{'content-type':'application/json','x-api-key':'test-key',...headers},body:JSON.stringify({...body(),...extra})});
test('HTTP auth, browser isolation, endpoint handling, and SSE tool events',async()=>{
 await withServer(async base=>{
  assert.equal((await post(base,{}, {'x-api-key':'bad'})).status,401);
  assert.equal((await post(base,{}, {origin:'https://example.com'})).status,403);
  assert.equal((await post(base,{}, {'x-wa-test-command':'npm%20test','x-wa-project-root':'%2Fsrc%2F..%2Frepo'})).status,400);
  assert.equal((await fetch(base+'/v1/messages/count_tokens',{method:'POST',headers:{'x-api-key':'test-key'}})).status,404);
  const res=await post(base,{stream:true});assert.equal(res.status,200);
  const events=(await res.text()).split('\n\n').filter(Boolean).map(x=>JSON.parse(x.split('\ndata: ')[1]));
  assert.equal(events.at(-1).type,'message_stop');
  assert.equal(events.find(x=>x.type==='content_block_delta').delta.partial_json,'{"file_path":"x"}');
  assert.equal(events.find(x=>x.type==='message_delta').delta.stop_reason,'tool_use');
 },async r=>parseReply(reply(r,[{type:'tool_use',name:'Read',input:{file_path:'x'}}]),r));
});
test('Claude Code notification checks stay local while other requests reach the backend', async () => {
  const classifier = {
    tools: [],
    system: [
      {type:'text',text:'x-anthropic-billing-header: cc_version=fixture;'},
      {type:'text',text:'A user kicked off a Claude Code agent to do a coding task and walked away. Classify the session status.'}
    ]
  };
  const headers = {'x-claude-code-request-class':'auxiliary'};
  let forwarded = 0;
  await withServer(async base => {
    const result = await post(base, classifier, headers);
    assert.equal(result.status, 400);
    assert.match((await result.json()).error.message, /notification status fallback/);
    assert.equal(forwarded, 0);

    const title = await post(base, {tools:[],system:'Give the session a title as JSON.'}, headers);
    assert.equal(title.status, 200);
    assert.deepEqual((await title.json()).content, [{type:'text',text:'{"title":"Example"}'}]);
    assert.equal((await post(base, classifier, {'x-claude-code-request-class':'main'})).status, 200);
    assert.equal(forwarded, 2);
  }, async request => {
    forwarded++;
    if (request.textOnly) {
      assert.match(request.prompt, /Give the session a title as JSON/);
      assert.doesNotMatch(request.prompt, /For a tool call|EXACT tool name|current_request/);
      return parseReply('{"title":"Example"}', request, {matchedTurn:true});
    }
    return parseReply(reply(request,[{type:'text',text:'ok'}]),request);
  });
});
test('overlapping requests reach WhatsApp in order, even after a backend error', async () => {
  let started, release;
  const begun = new Promise(resolve => { started = resolve; });
  const wait = new Promise(resolve => { release = resolve; });
  const completed = [];
  const turn = (number, stream = true) => ({
    stream, messages:[{role:'user',content:'queued-turn-' + number}]
  });
  await withServer(async base => {
    const first = post(base, turn(1, false));
    await begun;
    try {
      const second = await post(base, turn(2));
      const third = await post(base, turn(3));
      assert.equal(second.status, 200);
      assert.equal(third.status, 200);
      assert.deepEqual(completed, [1]);
      release();
      assert.equal((await first).status, 500);
      for (const response of [second, third]) {
        const events = await response.text();
        assert.match(events, /^event: ping/);
        assert.match(events, /event: message_stop/);
      }
      assert.deepEqual(completed, [1, 2, 3]);
    } finally {
      release();
      await first;
    }
  }, async request => {
    const number = Number(/queued-turn-(\d)/.exec(request.prompt)[1]);
    completed.push(number);
    if (number === 1) {
      started();
      await wait;
      throw new Error('backend failure');
    }
    return parseReply(reply(request, [{type:'text',text:'done'}]), request);
  });
});

test('disconnecting while queued skips the WhatsApp call', async () => {
  let started, release;
  const begun = new Promise(resolve => { started = resolve; });
  const wait = new Promise(resolve => { release = resolve; });
  let calls = 0;
  await withServer(async base => {
    const first = post(base);
    await begun;
    try {
      const controller = new AbortController();
      const cancelled = await post(base, {stream:true}, {}, controller.signal);
      assert.equal(cancelled.status, 200);
      controller.abort();
      await assert.rejects(cancelled.text(), {name:'AbortError'});
      const next = await post(base, {stream:true});
      assert.equal(calls, 1);
      release();
      assert.equal((await first).status, 200);
      assert.match(await next.text(), /event: message_stop/);
      assert.equal(calls, 2);
    } finally {
      release();
      await first;
    }
  }, async request => {
    calls++;
    if (calls === 1) {
      started();
      await wait;
    }
    return parseReply(reply(request, [{type:'text',text:'done'}]), request);
  });
});
