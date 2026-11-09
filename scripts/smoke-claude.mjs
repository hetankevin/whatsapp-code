// Actual Claude Code client, deterministic fake model. No WhatsApp/model calls.
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createGateway, root } from '../src/server.mjs';
import { parseReply } from '../src/protocol.mjs';

const dir=await mkdtemp(path.join(tmpdir(),'whatsapp-code-test-'));
const state=path.join(dir,'state');await mkdir(state);
const secret=randomBytes(12).toString('hex');const target=path.join(dir,'fixture.txt');
await writeFile(target,secret);await writeFile(path.join(state,'gateway-token'),'test-key');
let rounds=0,sawResult=false;
const server=createGateway({token:'test-key',backend:{ready:true,status:'mock test',complete:async request=>{
 const payload=JSON.parse(request.prompt.split('CURRENT REQUEST:\n')[1]);rounds++;
 const results=payload.messages.flatMap(m=>Array.isArray(m.content)?m.content:[]).filter(b=>b.type==='tool_result');
 let content;
 if(results.length){assert.ok(JSON.stringify(results).includes(secret),'Claude Code must return the actual fixture content');sawResult=true;content=[{type:'text',text:'Verified file: '+secret}];}
 else{assert.ok(request.validators.has('Read'));content=[{type:'tool_use',name:'Read',input:{file_path:target}}];}
 return parseReply(JSON.stringify({request_id:request.requestId,content}),request);
}}});
server.listen(0,'127.0.0.1');await once(server,'listening');
try {
 const child=spawn(process.execPath,[path.join(root,'src/launch.mjs'),'--print','--no-session-persistence','--tools','Read','--allowedTools','Read','--permission-mode','dontAsk','Read '+target+' and report its contents.'],{
  cwd:dir,env:{...process.env,WA_STATE_DIR:state,WA_PORT:String(server.address().port),CLAUDE_CONFIG_DIR:path.join(dir,'claude-config')},stdio:['ignore','pipe','pipe']
 });
 let stdout='',stderr='';child.stdout.on('data',x=>{stdout+=x});child.stderr.on('data',x=>{stderr+=x});
 const timer=setTimeout(()=>child.kill('SIGTERM'),45000);
 const [code]=await once(child,'exit');clearTimeout(timer);
 assert.equal(code,0,stderr+'\n'+stdout);assert.ok(sawResult,'No tool result received');assert.ok(stdout.includes(secret));
 console.log('PASS: actual Claude Code completed '+rounds+' local mock-model rounds, including a real Read and tool_result.');
}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});}
