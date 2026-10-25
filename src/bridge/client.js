// One AUBridge copy: newline-JSON over TCP on 127.0.0.1:<port>, one request per connection (as the
// mod's own tools do). Every request carries the token; the token is never logged.
// AUBridge serves at most 6 connections per copy, so requests per client are capped below that.

import net from 'node:net';

export class BridgeError extends Error {}

const MAX_OPEN = 4;

export class BridgeClient {
  constructor({ id, port = 47000 + id, token, host = '127.0.0.1' }) {
    if (!token || token.length < 16) throw new Error('AUBridge needs a token of 16 or more characters');
    this.id = id;
    this.port = port;
    this.host = host;
    this.token = token;
    this.open = 0;
    this.queue = [];
  }

  // The raw reply ({ok:false, error} included). Throws only when the copy cannot be reached.
  async request(cmd, args = {}, { timeoutMs = 15000 } = {}) {
    await this.slot();
    try {
      return await this.send({ ...args, cmd, token: this.token }, timeoutMs);
    } finally {
      this.open--;
      this.queue.shift()?.();
    }
  }

  // Like request(), but an {ok:false} reply throws BridgeError with the bridge's message.
  async call(cmd, args = {}, opts) {
    const r = await this.request(cmd, args, opts);
    if (!r.ok) throw new BridgeError(r.error ?? `${cmd} failed`);
    return r;
  }

  state() { return this.call('state'); }
  act(args) { return this.request('act', args); }

  // Long poll: everything after `since`, or the first new event, or nothing after `timeoutSec`.
  waitEvents(since, timeoutSec = 20) {
    return this.call('wait_event', { since, timeout: timeoutSec }, { timeoutMs: (timeoutSec + 15) * 1000 });
  }

  async slot() {
    if (this.open < MAX_OPEN) { this.open++; return; }
    await new Promise((resolve) => this.queue.push(resolve));
    this.open++;
  }

  send(msg, timeoutMs) {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection({ host: this.host, port: this.port });
      let buf = '';
      let done = false;
      const finish = (err, value) => {
        if (done) return;
        done = true;
        sock.destroy();
        if (err) reject(err); else resolve(value);
      };
      sock.setEncoding('utf8');
      sock.setTimeout(timeoutMs, () => finish(new Error(`copy ${this.id}: no reply to ${msg.cmd} in ${timeoutMs}ms`)));
      sock.on('connect', () => sock.write(`${JSON.stringify(msg)}\n`));
      sock.on('data', (chunk) => {
        buf += chunk;
        const nl = buf.indexOf('\n');
        if (nl < 0) return;
        try { finish(null, JSON.parse(buf.slice(0, nl))); } catch (e) { finish(new Error(`copy ${this.id}: bad reply (${e.message})`)); }
      });
      sock.on('error', (e) => finish(new Error(`copy ${this.id} (port ${this.port}): ${e.code ?? e.message}`)));
      sock.on('close', () => finish(new Error(`copy ${this.id}: connection closed before a reply to ${msg.cmd}`)));
    });
  }
}
