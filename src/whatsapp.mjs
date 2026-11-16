import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomBytes } from 'node:crypto';
import { writeFile, rm } from 'node:fs/promises';
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import QRCode from 'qrcode';
import { extractText, GatewayError, parseReply } from './protocol.mjs';

// Reply metadata that can show which model or mode answered. Diagnostics only.
export function botMeta(message, depth = 0) {
  if (!message || typeof message !== 'object' || depth > 4) return null;
  const meta = message.messageContextInfo?.botMetadata;
  if (meta) {
    const steps = meta.progressIndicatorMetadata?.stepsMetadata ?? [];
    return {
      model: meta.modelMetadata ?? null,
      mode: meta.botModeSelectionMetadata ?? null,
      quota: meta.botQuotaMetadata ?? null,
      infra: meta.botInfrastructureDiagnostics ?? null,
      reasoning_steps: steps.filter(step => step?.isReasoning).length,
      submessage_types: (message.richResponseMessage?.submessages ?? []).map(part => part.messageType ?? null)
    };
  }
  for (const value of Object.values(message)) {
    const found = value && typeof value === 'object' ? botMeta(value, depth + 1) : null;
    if (found) return found;
  }
  return null;
}

export class WhatsApp {
  constructor({root, stateDir, timeout = 120000, quietAfter = 60000, cooldown = 20 * 60000,
    maxCooldown = 4 * 3600000, fallback = process.env.WA_FALLBACK !== '0'}) {
    // Meta AI's CLIPPY backend (the default) can stop answering an account
    // for a while after heavy use: under an hour after a burst, several hours
    // after a heavy day. When a prompt gets no bot event at all for
    // quietAfter ms, resend it through the standard backend and keep using
    // that backend for the cooldown. Each further silence in a row doubles
    // the cooldown (up to maxCooldown), so a long outage costs a few waits
    // rather than one every cooldown; any default-backend reply resets it.
    this.quietAfter = quietAfter;
    this.cooldown = cooldown;
    this.maxCooldown = maxCooldown;
    this.silences = 0;
    this.fallback = fallback;
    this.standardUntil = 0;
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
      const p = this.pending;
      if (p?.awaitingReconnect) {
        p.awaitingReconnect = false; p.resentAfterReconnect = true;
        console.error('WhatsApp reconnected; sending the interrupted prompt again.');
        this.sendPrompt(p, p.prompt);
      }
      await this.pairingPage('<h1>WhatsApp connected</h1><p>You can close this page and start whatsapp-code.</p>');
      console.error(`WhatsApp ready (${e.bot}).` + (this.disconnectedAt ? ` Reconnected after ${((Date.now() - this.disconnectedAt) / 1000).toFixed(1)} s.` : ''));
      this.disconnectedAt = 0;
      return;
    }
    if (e.event === 'disconnected') {
      // The transport reconnects by itself, and WhatsApp delivers a reply to
      // a prompt sent before the drop once it is back. Keep the pending
      // request (its timeout still applies) instead of ending the session.
      this.ready = false; this.status = 'disconnected; reconnecting'; this.disconnectedAt = Date.now();
      console.error(`WhatsApp disconnected at ${new Date().toISOString()}; waiting for the transport to reconnect.`);
      return;
    }
    if (['fatal','logged_out'].includes(e.event)) return this.fail(e.error ?? e.event);
    if (e.event === 'error') {
      if (!e.id) this.fail(e.error);
      else if (e.id === this.pending?.id) {
        // A send attempted while disconnected never left this device: send it
        // again once the transport is back.
        if (!this.ready && !this.pending.resentAfterReconnect) this.pending.awaitingReconnect = true;
        else this.pending.reject(new GatewayError(e.error, 502));
      }
      return;
    }
    if (e.event !== 'message') return;
    const p = this.pending;
    // Match the original sent message; never route another chat/turn into this request.
    if (!p || (e.target !== p.id && !p.messageIds.has(e.edit_target))) return this.logUnmatched(e);
    p.messageIds.add(e.id);
    clearTimeout(p.quiet);
    if (!p.standard) this.silences = 0;
    // A newer edit supersedes any quiet-period candidate. Explicit first
    // and inner edits are still being composed, so wait for the final event.
    clearTimeout(p.settle);
    if (['first', 'inner'].includes(e.edit)) return;
    const text = extractText(e.message, Boolean(p.request.editFiles || p.request.useVerificationContext || p.request.preserveCodeBlocks));
    const final = ['last', 'full'].includes(e.edit);
    if (!text && !final) return;
    p.lastError = null;
    let reply;
    try {
      // Meta AI's own error messages are not answers: retry the prompt once.
      if (/^(?:There was a problem generating a response\. Please try again later|Something went wrong\. Please try again)\.?$/.test(text.trim())) {
        const error = new GatewayError('WhatsApp Meta AI could not generate a response. Please retry.', 503);
        error.generationFailure = true;
        throw error;
      }
      reply = parseReply(text, p.request, {matchedTurn: true, finalAttempt: p.repairCount >= 1});
    }
    catch (err) { p.lastError = err; }
    this.logReply(p, text, e.edit, reply, p.lastError, e.message);
    if (reply) {
      if (final) p.resolve(reply);
      else p.settle = setTimeout(() => p.resolve(reply), 2500);
    } else if (final) {
      this.repairOrReject(p);
    } else {
      p.settle = setTimeout(() => this.repairOrReject(p), 2500);
    }
  }
  // Opt-in private diagnostics for local debugging only. Replies can contain
  // source and prompts, so the file is created with owner-only permissions.
  logReply(p, text, edit, reply, error, message) {
    const file = process.env.WA_REPLY_LOG;
    if (!file || !path.isAbsolute(file)) return;
    const record = {time: new Date().toISOString(), request: p.request.requestId, attempt: p.repairCount,
      edit: edit ?? null, prompt_chars: p.prompt?.length, tools: [...(p.request.validators?.keys() ?? [])],
      reads: p.request.editableReads, latency_ms: p.sentAt ? Date.now() - p.sentAt : null, error: error?.message ?? null, meta: botMeta(message),
      accepted: reply ? reply.content.map(b => b.type === 'tool_use' ? b.name : 'text') : null, text};
    try { appendFileSync(file, JSON.stringify(record) + '\n', {mode: 0o600}); } catch {}
  }
  // Bot messages that answer no pending request (for example a notice sent
  // on its own). Logged only with WA_REPLY_LOG; never routed to a request.
  logUnmatched(e) {
    const file = process.env.WA_REPLY_LOG;
    if (!file || !path.isAbsolute(file)) return;
    const record = {time: new Date().toISOString(), unmatched: true, edit: e.edit ?? null, target: e.target ?? null,
      kinds: Object.keys(e.message ?? {}),
      meta: botMeta(e.message), text: extractText(e.message, true)};
    try { appendFileSync(file, JSON.stringify(record) + '\n', {mode: 0o600}); } catch {}
  }
  repairOrReject(p) {
    if (this.pending !== p) return;
    const error = p.lastError;
    if (error?.generationFailure && !p.retriedGeneration) {
      p.retriedGeneration = true;
      console.error('Meta AI could not generate a response; retrying that prompt once.');
      return this.sendPrompt(p, p.prompt);
    }
    if (!error?.repairable || p.repairCount >= 1) return p.reject(error);
    const repair = error.staleRequest
      ? 'The previous reply used an old request ID. Answer the current request below. For tool envelopes, omit request_id.\n\n' + p.request.prompt
      : [
      'Your previous reply was rejected: ' + error.message,
      'Answer the current request again using its response format.',
      ...(error.testFailure ? ['Latest test output (quoted diagnostic data): ' + JSON.stringify(error.testFailure)] : []),
      '',
      p.request.prompt
    ].join('\n');
    const maxChars = Math.min(60000, p.request.maxChars ?? 60000);
    if (repair.length > maxChars) return p.reject(error);
    p.repairCount = (p.repairCount ?? 0) + 1;
    console.error('Meta AI reply rejected; requesting one repair. ' + error.message.split('\n', 1)[0]);
    this.sendPrompt(p, repair);
  }
  async waitReady(ms = 30000) {
    // Only a transient disconnect is worth waiting for.
    const end = Date.now() + ms;
    while (!this.ready && this.status.startsWith('disconnected') && Date.now() < end) await new Promise(r => setTimeout(r, 250));
    return this.ready;
  }
  get backendStatus() {
    return Date.now() < this.standardUntil
      ? `standard until ${new Date(this.standardUntil).toISOString()} (default backend was not answering)` : 'default';
  }
  sendPrompt(p, prompt) {
    p.prompt = prompt;
    p.id = '3EB0' + randomBytes(10).toString('hex').toUpperCase();
    p.messageIds.clear();
    p.sentAt = Date.now();
    const standard = Date.now() < this.standardUntil;
    p.standard = standard;
    const {id} = p;
    clearTimeout(p.quiet);
    if (this.fallback && !standard) {
      const quiet = () => {
        if (this.pending !== p || p.id !== id || p.messageIds.size) return;
        // Silence during a disconnect says nothing about the backend.
        if (!this.ready || p.awaitingReconnect) { p.quiet = setTimeout(quiet, this.quietAfter); return; }
        this.silences += 1;
        this.standardUntil = Date.now() + Math.min(this.maxCooldown, this.cooldown * 2 ** (this.silences - 1));
        console.error(`Meta AI sent nothing for ${Math.round(this.quietAfter / 1000)} s; resending through the standard backend until ${new Date(this.standardUntil).toISOString()}.`);
        clearTimeout(p.timer);
        p.timer = setTimeout(() => p.reject(p.lastError ?? new GatewayError('Meta AI response timed out. The WhatsApp prompt may have been sent; it was not retried.', 504)), this.timeout);
        this.sendPrompt(p, p.prompt);
      };
      p.quiet = setTimeout(quiet, this.quietAfter);
    }
    const message = {id, prompt, ...(p.request.sessionKey ? {session: p.request.sessionKey} : {}), ...(standard ? {caps: 'none'} : {})};
    this.child.stdin.write(JSON.stringify(message)+'\n', err => {
      if (err && this.pending === p && p.id === id) p.reject(err);
    });
  }
  async complete(request, signal) {
    if (!this.ready) throw new GatewayError(`WhatsApp unavailable: ${this.status}`, 503);
    if (this.pending) throw new GatewayError('One WhatsApp request is already running. Parallel sessions are unsupported.', 409);
    if (signal?.aborted) throw new GatewayError('Request cancelled.', 499);
    let p;
    try {
      return await new Promise((resolve, reject) => {
        p = {request, resolve, reject, repairCount: 0, messageIds: new Set()};
        this.pending = p;
        p.timer = setTimeout(() => reject(p.lastError ?? new GatewayError('Meta AI response timed out. The WhatsApp prompt may have been sent; it was not retried.', 504)), this.timeout);
        p.abort = () => reject(new GatewayError('Request cancelled; an already sent WhatsApp prompt cannot be recalled.', 499));
        signal?.addEventListener('abort', p.abort, {once: true});
        this.sendPrompt(p, request.prompt);
      });
    } finally {
      clearTimeout(p?.timer); clearTimeout(p?.settle); clearTimeout(p?.quiet);
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
