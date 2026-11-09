import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { homedir } from 'node:os';
import { GatewayError, prepare, streamMessage } from './protocol.mjs';

export function createGateway({backend, token, maxChars = 60000}) {
  let busy = false;
  return http.createServer(async (req, res) => {
    const sendJSON = (status, obj) => {res.writeHead(status, {'content-type':'application/json','cache-control':'no-store'}); res.end(JSON.stringify(obj));};
    let ping;
    let locked = false;
    try {
      if (req.headers.origin) throw new GatewayError('Browser-origin requests are not allowed.',403);
      const provided = req.headers['x-api-key'] ?? req.headers.authorization?.replace(/^Bearer /,'') ?? '';
      const a = Buffer.from(String(provided)); const b = Buffer.from(token);
      if (a.length !== b.length || !timingSafeEqual(a,b)) throw new GatewayError('Invalid local gateway credential.',401);
      const url = new URL(req.url,'http://127.0.0.1');
      if (req.method === 'HEAD' && url.pathname === '/api/hello') {res.writeHead(200); return res.end();}
      if (req.method === 'GET' && url.pathname === '/health') return sendJSON(200,{ready:backend.ready,status:backend.status,bot:backend.bot});
      if (req.method === 'GET' && url.pathname === '/v1/models') return sendJSON(200,{data:[{id:'meta-ai-whatsapp',type:'model',display_name:'Meta AI via WhatsApp (experimental)',created_at:'2026-11-09T00:00:00Z'}],has_more:false,first_id:'meta-ai-whatsapp',last_id:'meta-ai-whatsapp'});
      if (req.method !== 'POST' || url.pathname !== '/v1/messages') throw new GatewayError('Unknown endpoint.',404);
      if (!String(req.headers['content-type']??'').startsWith('application/json')) throw new GatewayError('Expected application/json.',415);
      if (busy) throw new GatewayError('A WhatsApp request is already running. Use one session at a time.',409);
      busy = true; locked = true;
      const chunks=[]; let size=0;
      for await (const chunk of req) {size+=chunk.length; if(size>1024*1024) throw new GatewayError('Request too large.',413); chunks.push(chunk);}
      let body; try {body=JSON.parse(Buffer.concat(chunks));} catch {throw new GatewayError('Invalid JSON.');}
      const request = prepare(body,maxChars);
      if (!backend.ready) throw new GatewayError(`WhatsApp unavailable: ${backend.status}`,503);
      const controller = new AbortController();
      res.on('close', () => {if(!res.writableEnded) controller.abort();});
      const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      if (body.stream) {
        res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-store','connection':'keep-alive','x-accel-buffering':'no'});
        send('ping',{type:'ping'});
        ping = setInterval(()=>send('ping',{type:'ping'}),10000);
      }
      const result = await backend.complete(request,controller.signal);
      if (body.stream) {streamMessage(result,send); res.end();}
      else sendJSON(200,result);
    } catch (err) {
      const status = err instanceof GatewayError ? err.status : 500;
      const payload = {type:'error',error:{type:status===401?'authentication_error':status<500?'invalid_request_error':'api_error',message:err.message}};
      if (!res.headersSent) sendJSON(status,payload);
      else if (!res.destroyed) {res.write(`event: error\ndata: ${JSON.stringify(payload)}\n\n`);res.end();}
    } finally {clearInterval(ping); if(locked) busy=false;}
  });
}

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const localState = process.platform === 'darwin'
  ? path.join(homedir(), 'Library', 'Application Support', 'whatsapp-code')
  : path.join(process.env.XDG_STATE_HOME ?? path.join(homedir(), '.local', 'state'), 'whatsapp-code');
export const stateDir = path.resolve(process.env.WA_STATE_DIR ?? localState);
export async function getToken() {
  await mkdir(stateDir,{recursive:true,mode:0o700}); await chmod(stateDir,0o700);
  const file=path.join(stateDir,'gateway-token');
  try {return (await readFile(file,'utf8')).trim();} catch(e) {if(e.code!=='ENOENT') throw e;}
  const token=randomBytes(32).toString('hex');
  try {await writeFile(file,token+'\n',{mode:0o600,flag:'wx'});return token;}
  catch(e) {if(e.code==='EEXIST') return (await readFile(file,'utf8')).trim();throw e;}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.umask(0o077);
  const {WhatsApp}=await import('./whatsapp.mjs');
  const token=await getToken();
  const port=Number(process.env.WA_PORT??8787);
  const backend=new WhatsApp({root,stateDir});
  const server=createGateway({backend,token});
  server.requestTimeout=150000;
  server.on('error',async e=>{console.error(e.message);await backend.close();process.exit(1);});
  server.listen(port,'127.0.0.1',()=>console.error(`whatsapp-code listening on http://127.0.0.1:${port}`));
  for(const signal of ['SIGINT','SIGTERM']) process.once(signal,async()=>{server.close();server.closeAllConnections();await backend.close();process.exit(0);});
}
