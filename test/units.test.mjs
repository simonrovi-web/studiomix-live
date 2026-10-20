// Building blocks: password hashing, signed tokens, chat rules, MediaMTX config.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { hashPassword, verifyPassword } = require('../server/config.js');
const { makeToken, checkToken, parseCookies } = require('../server/sessions.js');
const { Chat, cleanText } = require('../server/chat.js');
const { mediamtxConfig } = require('../server/mediamtx.js');

test('passwords are salted scrypt hashes', () => {
  const a = hashPassword('secreto123');
  const b = hashPassword('secreto123');
  assert.notEqual(a, b);
  assert.ok(verifyPassword('secreto123', a));
  assert.ok(!verifyPassword('secreto124', a));
  assert.ok(!verifyPassword('secreto123', 'texto$plano'));
  assert.ok(!verifyPassword('x', null));
});

test('tokens: scope, expiry, extra and signature are all checked', () => {
  const now = 1_000_000;
  const t = makeToken('s', 'admin', 1000, '', now);
  assert.ok(checkToken('s', t, 'admin', '', now + 500));
  assert.ok(!checkToken('s', t, 'admin', '', now + 1500), 'expired');
  assert.ok(!checkToken('otro', t, 'admin', '', now), 'other secret');
  assert.ok(!checkToken('s', t, 'view', '', now), 'other scope');
  const forged = t.replace(/\.(\d+)\./, (_m, e) => `.${Number(e) + 999999}.`);
  assert.ok(!checkToken('s', forged, 'admin', '', now), 'tampered expiry');
  const v = makeToken('s', 'view', 1000, 3, now);
  assert.ok(checkToken('s', v, 'view', 3, now));
  assert.ok(!checkToken('s', v, 'view', 4, now), 'old password version');
  assert.deepEqual(parseCookies('a=1; b=x%20y'), { a: '1', b: 'x y' });
});

test('cleanText removes control, zero-width and direction-override characters', () => {
  assert.equal(cleanText('  hola\n\tque​tal‮!  ', 50), 'hola que tal !');
  assert.equal(cleanText('x'.repeat(400), 300).length, 300);
  assert.equal(cleanText(null, 10), '');
});

test('chat: bans hide past messages and block new ones; history is capped', () => {
  const chat = new Chat();
  chat.post('a', 'Ana', 'uno', 0);
  chat.post('b', 'Bea', 'dos', 0);
  chat.ban('a');
  assert.deepEqual(chat.history.map((m) => m.text), ['dos']);
  assert.equal(chat.post('a', 'Ana', 'otra', 5000).ok, false);
  for (let i = 0; i < 150; i++) chat.post(`v${i}`, 'X', `m${i}`, 10000);
  assert.equal(chat.history.length, 100);
  clearInterval(chat.keepAlive);
});

test('MediaMTX config: HTTP endpoints and API on localhost, auth through our hook', () => {
  const cfg = JSON.parse(mediamtxConfig({ rtmpPort: 1935, srtPort: 8890, webrtcPort: 8189 }, { authUrl: 'http://127.0.0.1:8080/internal/mediamtx-auth', additionalHosts: ['ejemplo.com'] }));
  assert.equal(cfg.authMethod, 'http');
  assert.equal(cfg.authHTTPAddress, 'http://127.0.0.1:8080/internal/mediamtx-auth');
  for (const key of ['webrtcAddress', 'hlsAddress', 'apiAddress']) assert.match(cfg[key], /^127\.0\.0\.1:/, key);
  assert.equal(cfg.rtmpAddress, ':1935');
  assert.equal(cfg.rtsp, false);
  assert.deepEqual(cfg.webrtcAllowOrigins, []);
  assert.deepEqual(cfg.webrtcAdditionalHosts, ['ejemplo.com']);
});
