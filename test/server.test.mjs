// The platform server through its real HTTP routes (MediaMTX replaced by
// nothing: these tests cover access rules, the auth hook, admin and chat).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createServer } = require('../server/index.js');
const { Config } = require('../server/config.js');
const { Sessions } = require('../server/sessions.js');
const { Chat } = require('../server/chat.js');

const quiet = { info() {}, warn() {}, error() {} };
let dir;
let base;
let server;
let config;
const SETUP_CODE = '123456';

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studiomix-live-'));
  config = new Config(path.join(dir, 'config.json'));
  const chat = new Chat();
  ({ server } = createServer({ config, chat, sessions: new Sessions(config), mediamtx: null, setupCode: SETUP_CODE, log: quiet }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.closeAllConnections();
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** fetch that keeps cookies per "browser". */
function browser() {
  const jar = new Map();
  return async (url, { json, ...init } = {}) => {
    const headers = { ...(init.headers ?? {}) };
    if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (json !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(json);
      init.method ??= 'POST';
    }
    const res = await fetch(base + url, { ...init, headers });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      const value = pair.slice(i + 1);
      if (value) jar.set(pair.slice(0, i), value);
      else jar.delete(pair.slice(0, i));
    }
    return res;
  };
}

const hook = (body) => fetch(`${base}/internal/mediamtx-auth`, { method: 'POST', body: JSON.stringify(body) }).then((r) => r.status);

test('MediaMTX hook: only the current key may publish; reads only through our proxy', async () => {
  const key = config.data.streamKey;
  assert.equal(await hook({ action: 'publish', path: `live/${key}`, ip: '203.0.113.5' }), 200);
  assert.equal(await hook({ action: 'publish', path: 'live/otra', ip: '203.0.113.5' }), 401);
  assert.equal(await hook({ action: 'read', path: `live/${key}`, ip: '127.0.0.1' }), 200);
  assert.equal(await hook({ action: 'read', path: `live/${key}`, ip: '192.168.1.20' }), 401);
  assert.equal(await hook({ action: 'playback', path: `live/${key}`, ip: '127.0.0.1' }), 401);
});

test('admin: setup needs the console code once, then password login', async () => {
  const admin = browser();
  assert.equal((await admin('/admin/api/state')).status, 401);
  assert.equal((await admin('/admin/api/setup', { json: { code: '000000', password: 'contraseña-larga' } })).status, 403);
  assert.equal((await admin('/admin/api/setup', { json: { code: SETUP_CODE, password: 'corta' } })).status, 400);
  assert.equal((await admin('/admin/api/setup', { json: { code: SETUP_CODE, password: 'contraseña-larga' } })).status, 200);
  const state = await (await admin('/admin/api/state')).json();
  assert.equal(state.streamKey, config.data.streamKey);
  assert.match(state.ingest.rtmpUrl, /^rtmp:\/\/.+:1935\/live\/.+/);

  const other = browser();
  assert.equal((await other('/admin/api/setup', { json: { code: SETUP_CODE, password: 'otra-contraseña' } })).status, 409);
  assert.equal((await other('/admin/api/login', { json: { password: 'incorrecta' } })).status, 403);
  assert.equal((await other('/admin/api/login', { json: { password: 'contraseña-larga' } })).status, 200);
  assert.equal((await other('/admin/api/state')).status, 200);
  assert.ok(!JSON.stringify(config.data).includes('contraseña-larga'), 'the password is only stored hashed');
});

test('JSON endpoints refuse other content types (no cross-site form posts)', async () => {
  const res = await fetch(`${base}/admin/api/login`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{"password":"x"}' });
  assert.equal(res.status, 415);
});

test('private channel: no video or chat until the viewer password; changing it locks old viewers out', async () => {
  const admin = browser();
  await admin('/admin/api/login', { json: { password: 'contraseña-larga' } });
  assert.equal((await admin('/admin/api/privacy', { json: { private: true } })).status, 400, 'needs a password');
  assert.equal((await admin('/admin/api/privacy', { json: { private: true, password: 'publico1' } })).status, 200);

  const viewer = browser();
  const ch = await (await viewer('/api/channel')).json();
  assert.equal(ch.private, true);
  assert.equal(ch.canWatch, false);
  assert.equal((await viewer('/whep', { method: 'POST', headers: { 'content-type': 'application/sdp' }, body: 'v=0' })).status, 403);
  assert.equal((await viewer('/api/events')).status, 403);
  assert.equal((await viewer('/api/unlock', { json: { password: 'mal' } })).status, 403);
  assert.equal((await viewer('/api/unlock', { json: { password: 'publico1' } })).status, 200);
  assert.equal((await (await viewer('/api/channel')).json()).canWatch, true);
  const events = await viewer('/api/events', { signal: AbortSignal.timeout(1000) });
  assert.equal(events.status, 200);
  assert.match(events.headers.get('content-type'), /text\/event-stream/);
  await events.body.cancel();

  await admin('/admin/api/privacy', { json: { private: true, password: 'publico2' } });
  assert.equal((await (await viewer('/api/channel')).json()).canWatch, false, 'old unlock no longer valid');

  await admin('/admin/api/privacy', { json: { private: false } });
  assert.equal((await (await browser()('/api/channel')).json()).canWatch, true);
});

test('chat: needs the page cookie, keeps text as text, limits the pace', async () => {
  const viewer = browser();
  assert.equal((await viewer('/api/chat', { json: { nick: 'A', text: 'hola' } })).status, 400, 'no viewer id yet');
  await viewer('/api/channel');
  assert.equal((await viewer('/api/chat', { json: { nick: 'A', text: '<img src=x onerror=alert(1)>' } })).status, 200);
  const fast = await viewer('/api/chat', { json: { nick: 'A', text: 'otra vez' } });
  assert.equal(fast.status, 400);
  assert.match((await fast.json()).error, /Espera/);
});

test('regenerating the stream key stops the old one from publishing', async () => {
  const admin = browser();
  await admin('/admin/api/login', { json: { password: 'contraseña-larga' } });
  const old = config.data.streamKey;
  assert.equal((await admin('/admin/api/regenerate-key', { json: {} })).status, 200);
  assert.notEqual(config.data.streamKey, old);
  assert.equal(await hook({ action: 'publish', path: `live/${old}`, ip: '127.0.0.1' }), 401);
  assert.equal(await hook({ action: 'publish', path: `live/${config.data.streamKey}`, ip: '127.0.0.1' }), 200);
});

test('security headers on pages', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
  assert.match(res.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await fetch(`${base}/assets/..%2fserver%2fconfig.js`)).status, 404, 'no files outside web/assets');
});
