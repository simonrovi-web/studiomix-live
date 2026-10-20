'use strict';

// Live channel feed over Server-Sent Events: chat messages, viewer count and
// whether the stream is live. Each open viewer page is one SSE client.

const crypto = require('node:crypto');

const MAX_HISTORY = 100;
const MAX_TEXT = 300;
const MAX_NICK = 24;
const MIN_INTERVAL_MS = 1000;

// Control characters, zero-width characters and bidirectional overrides (which
// can disguise text), written as escapes so the source stays readable.
const UNSAFE_CHARS = new RegExp('[\\u0000-\\u001f\\u007f\\u200b-\\u200f\\u202a-\\u202e\\u2066-\\u2069]', 'g');

/** Trims and limits user text; removes unsafe characters. Returns '' if nothing is left. */
function cleanText(value, max) {
  return String(value ?? '')
    .replace(UNSAFE_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/** What viewers see of a message: never the sender's anonymous id. */
const publicMessage = ({ id, nick, text, at }) => ({ id, nick, text, at });

class Chat {
  constructor() {
    this.clients = new Map(); // id -> { res, viewerId }
    this.history = [];
    this.banned = new Set();
    this.lastPost = new Map(); // viewerId -> time
    this.status = { live: false };
    this.seq = 0;
    // Comments keep proxies from closing idle connections; the pace memory
    // only needs the last few seconds.
    this.keepAlive = setInterval(() => {
      this.writeAll(': ping\n\n');
      const cutoff = Date.now() - 10000;
      for (const [id, at] of this.lastPost) if (at < cutoff) this.lastPost.delete(id);
    }, 20000);
    this.keepAlive.unref();
  }

  get viewers() {
    return new Set([...this.clients.values()].map((c) => c.viewerId)).size;
  }

  /** Registers an SSE response; returns a function that removes it. */
  connect(res, viewerId) {
    const id = crypto.randomUUID();
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    this.clients.set(id, { res, viewerId });
    this.send(res, 'hello', { messages: this.history.map(publicMessage), status: this.status, viewers: this.viewers });
    this.broadcast('viewers', { viewers: this.viewers });
    const remove = () => {
      if (!this.clients.delete(id)) return;
      this.broadcast('viewers', { viewers: this.viewers });
    };
    res.on('close', remove);
    return remove;
  }

  send(res, event, data) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  writeAll(text) {
    for (const { res } of this.clients.values()) res.write(text);
  }

  broadcast(event, data) {
    this.writeAll(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  setStatus(status) {
    const changed = JSON.stringify(status) !== JSON.stringify(this.status);
    this.status = status;
    if (changed) this.broadcast('status', status);
  }

  /** Adds a viewer's message. Returns { ok, message } or { ok: false, error }. */
  post(viewerId, nick, text, now = Date.now()) {
    if (this.banned.has(viewerId)) return { ok: false, error: 'No puedes escribir en este chat.' };
    const cleanNick = cleanText(nick, MAX_NICK) || 'Invitado';
    const cleanBody = cleanText(text, MAX_TEXT);
    if (!cleanBody) return { ok: false, error: 'El mensaje está vacío.' };
    const last = this.lastPost.get(viewerId);
    if (last !== undefined && now - last < MIN_INTERVAL_MS) return { ok: false, error: 'Espera un momento antes de enviar otro mensaje.' };
    this.lastPost.set(viewerId, now);
    const message = { id: ++this.seq, nick: cleanNick, text: cleanBody, at: now, viewerId };
    this.history.push(message);
    if (this.history.length > MAX_HISTORY) this.history.shift();
    this.broadcast('message', publicMessage(message));
    return { ok: true, message };
  }

  remove(id) {
    const before = this.history.length;
    this.history = this.history.filter((m) => m.id !== id);
    if (this.history.length !== before) this.broadcast('delete', { id });
  }

  clear() {
    this.history = [];
    this.broadcast('clear', {});
  }

  ban(viewerId) {
    this.banned.add(viewerId);
    const removed = this.history.filter((m) => m.viewerId === viewerId).map((m) => m.id);
    this.history = this.history.filter((m) => m.viewerId !== viewerId);
    for (const id of removed) this.broadcast('delete', { id });
  }
}

module.exports = { Chat, cleanText, publicMessage, MAX_TEXT, MAX_NICK };
