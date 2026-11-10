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
const post=(base,extra={},headers={})=>fetch(base+'/v1/messages?beta=true',{method:'POST',headers:{'content-type':'application/json','x-api-key':'test-key',...headers},body:JSON.stringify({...body(),...extra})});
test('HTTP auth, browser isolation, endpoint handling, and SSE tool events',async()=>{
 await withServer(async base=>{
  assert.equal((await post(base,{}, {'x-api-key':'bad'})).status,401);
  assert.equal((await post(base,{}, {origin:'https://example.com'})).status,403);
  assert.equal((await fetch(base+'/v1/messages/count_tokens',{method:'POST',headers:{'x-api-key':'test-key'}})).status,404);
  const res=await post(base,{stream:true});assert.equal(res.status,200);
  const events=(await res.text()).split('\n\n').filter(Boolean).map(x=>JSON.parse(x.split('\ndata: ')[1]));
  assert.equal(events.at(-1).type,'message_stop');
  assert.equal(events.find(x=>x.type==='content_block_delta').delta.partial_json,'{"file_path":"x"}');
  assert.equal(events.find(x=>x.type==='message_delta').delta.stop_reason,'tool_use');
 },async r=>parseReply(reply(r,[{type:'tool_use',name:'Read',input:{file_path:'x'}}]),r));
});
test('overlapping requests are rejected before reaching WhatsApp',async()=>{
 let started,release; const begun=new Promise(r=>{started=r});const wait=new Promise(r=>{release=r});
 await withServer(async base=>{
  const first=post(base);await begun;
  assert.equal((await post(base)).status,409);release();assert.equal((await first).status,200);
 },async r=>{started();await wait;return parseReply(reply(r,[{type:'text',text:'done'}]),r)});
});
