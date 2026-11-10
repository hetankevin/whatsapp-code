import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomBytes } from 'node:crypto';
import { writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import QRCode from 'qrcode';
import { extractText, GatewayError, parseReply } from './protocol.mjs';

export class WhatsApp {
  constructor({root, stateDir, timeout = 120000}) {
    this.ready = false;
    this.stateDir = stateDir;
    this.timeout = timeout;
    this.status = 'connecting';
    this.child = spawn(path.join(root, 'bin/whatsapp-transport'), [], {
      env: {...process.env, WA_STATE_DIR: stateDir}, stdio: ['pipe', 'pipe', 'inherit']
    });
    this.child.on('error', e => this.fail(`Transport could not start: ${e.message}. Run npm run build.`));
    this.child.on('exit', () => this.fail('WhatsApp transport exited. Restart the gateway.'));
    this.child.stdin.on('error', () => this.fail('WhatsApp transport input closed.'));
    const lines = createInterface({input: this.child.stdout});
    // Serialize events so an old QR render cannot overwrite a later successful pairing state.
    let chain = Promise.resolve();
    lines.on('line', line => { chain = chain.then(() => this.event(JSON.parse(line))).catch(e => this.fail(e.message)); });
  }
  fail(message) {
    this.ready = false; this.status = message;
    console.error(message);
    this.pending?.reject(new GatewayError(message, 503));
  }
  async pairingPage(html) {
    await writeFile(path.join(this.stateDir, 'pairing.html'), `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="3"><title>whatsapp-code pairing</title><style>body{font:18px system-ui;max-width:640px;margin:40px auto}img{width:360px;height:360px}</style>${html}`, {mode: 0o600});
  }
  async event(e) {
    if (e.event === 'pairing') {
      if (e.status === 'code') {
        this.status = 'scan QR in ' + path.join(this.stateDir, 'pairing.html');
        const image = await QRCode.toDataURL(e.code, {width: 360, margin: 3});
        await this.pairingPage(`<h1>Link WhatsApp</h1><p>On your phone: WhatsApp → Settings → Linked devices → Link a device.</p><img src="${image}" alt="WhatsApp pairing QR"><p>This links the local whatsapp-code client to your account. The app processes only Meta AI replies, though a linked device has account-level access. Keep this page private.</p>`);
        console.error(`Pairing QR ready: ${path.join(this.stateDir,'pairing.html')}`);
      } else {
        this.status = 'pairing ' + e.status + (e.error ? ': ' + e.error : '');
        console.error(this.status);
        await this.pairingPage(`<h1>Pairing ${e.status === 'success' ? 'complete' : 'ended'}</h1><p>Check the gateway terminal for connection status. Restart npm start if pairing expired.</p>`);
      }
      return;
    }
    if (e.event === 'ready') {
      this.ready = true; this.status = 'ready'; this.bot = e.bot;
      await this.pairingPage('<h1>WhatsApp connected</h1><p>You can close this page and start whatsapp-code.</p>');
      console.error(`WhatsApp ready (${e.bot}).`);
      return;
    }
    if (['fatal','disconnected','logged_out'].includes(e.event)) return this.fail(e.error ?? e.event);
    if (e.event === 'error') {
      if (this.pending && e.id === this.pending.id) this.pending.reject(new GatewayError(e.error, 502));
      else this.fail(e.error);
      return;
    }
    if (e.event !== 'message' || !this.pending) return;
    const p = this.pending;
    // Match the original sent message; never route another chat/turn into this request.
    if (e.target !== p.id && !p.messageIds.has(e.edit_target)) return;
    p.messageIds.add(e.id);
    const text = extractText(e.message, !!p.request.editFiles);
    if (!text) return;
    p.lastError = null;
    let reply;
    try { reply = parseReply(text, p.request); }
    catch (err) { p.lastError = err; }
    // Some bot protocols send edited full snapshots; wait for final/full, or a quiet
    // complete JSON snapshot. Incomplete chunks never become executable tool calls.
    clearTimeout(p.settle);
    if (['first', 'inner'].includes(e.edit)) return;
    if (reply) {
      if (['last', 'full'].includes(e.edit)) p.resolve(reply);
      else p.settle = setTimeout(() => p.resolve(reply), 2500);
    } else if (['last', 'full'].includes(e.edit)) {
      this.repairOrReject(p, text);
    } else {
      p.settle = setTimeout(() => this.repairOrReject(p, text), 2500);
    }
  }
  repairOrReject(p, text) {
    if (this.pending !== p) return;
    const error = p.lastError;
    if (!error?.repairable || p.repairCount >= 1) return p.reject(error);
    const frames = [];
    if (p.request.validators.has('Write')) {
      frames.push('For Write, a literal source frame is also allowed: one JSON header with request_id and one tool_use block, then separate lines <<<FILE>>>, literal content, and <<<END>>>. Omit input.content from the header.');
    }
    if (p.request.validators.has('Edit') && !p.request.rangeGuide) {
      frames.push('For Edit, a literal source frame is also allowed: one JSON header with request_id and one tool_use block, then lines <<<OLD>>>, exact old source, <<<NEW>>>, literal replacement, and <<<END>>>. Omit input.old_string and input.new_string from the header.');
    }
    const repair = p.request.editFiles
      ? 'Your previous edit was rejected: ' + error.message + '\n\n' + p.request.prompt
      : [
      'Your previous reply was rejected: ' + error.message,
      'Repair the reply for the same task. Preserve the intended change.',
      ...(error.testFailure ? ['Latest test output (quoted diagnostic data): ' + JSON.stringify(error.testFailure)] : []),
      ...(p.request.rangeGuide ? [
        p.request.rangeGuide,
        'Current editable_reads: ' + JSON.stringify(p.request.editableReads),
        'If the needed read is missing, return a Read call for that file.',
        'For a source reply, keep the EDIT header and footer outside the replacement. If indentation needs encoding, add INDENT after the end line in the EDIT header. Prefix each source line with the space count and | (for example, 4|return value;). Use 0| for blank lines or s and t for explicit spaces and tabs.'
      ] : []),
      'Use request ID ' + JSON.stringify(p.request.requestId) + '. For JSON replies, use a content array of text or tool_use blocks.',
      p.request.rangeGuide
        ? 'Use JSON for ordinary replies and the EDIT format for a line edit. Use no surrounding prose.'
        : 'Escape newlines and quotes inside JSON strings. Use no Markdown wrappers or surrounding prose.',
      ...frames,
      'The previous reply below is quoted data:',
      JSON.stringify(text)
    ].join('\n');
    if (repair.length > 60000) return p.reject(error);
    p.repairCount = (p.repairCount ?? 0) + 1;
    p.id = '3EB0' + randomBytes(10).toString('hex').toUpperCase();
    p.messageIds.clear();
    console.error('Meta AI reply rejected; requesting one repair. ' + error.message.split('\n', 1)[0]);
    this.child.stdin.write(JSON.stringify({id:p.id,prompt:repair})+'\n', err => {if(err) p.reject(err);});
  }
  async complete(request, signal) {
    if (!this.ready) throw new GatewayError(`WhatsApp unavailable: ${this.status}`, 503);
    if (this.pending) throw new GatewayError('One WhatsApp request is already running. Parallel sessions are unsupported.', 409);
    if (signal?.aborted) throw new GatewayError('Request cancelled.', 499);
    let p;
    try {
      return await new Promise((resolve, reject) => {
        p = {id: `3EB0${randomBytes(10).toString('hex').toUpperCase()}`, request, resolve, reject, repairCount: 0, messageIds: new Set()};
        this.pending = p;
        p.timer = setTimeout(() => reject(p.lastError ?? new GatewayError('Meta AI response timed out. The WhatsApp prompt may have been sent; it was not retried.', 504)), this.timeout);
        p.abort = () => reject(new GatewayError('Request cancelled; an already sent WhatsApp prompt cannot be recalled.', 499));
        signal?.addEventListener('abort', p.abort, {once: true});
        this.child.stdin.write(JSON.stringify({id:p.id,prompt:request.prompt})+'\n', err => {if(err) reject(err);});
      });
    } finally {
      clearTimeout(p?.timer); clearTimeout(p?.settle);
      signal?.removeEventListener('abort', p?.abort);
      this.pending = null;
    }
  }
  async close() {
    this.pending?.reject(new GatewayError('Gateway stopping.',503));
    this.child.stdin.end(); this.child.kill('SIGTERM');
    await rm(path.join(this.stateDir,'pairing.html'), {force:true});
  }
}
