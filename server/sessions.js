'use strict';

// Signed cookies (HMAC-SHA256): the admin session and the viewer "unlocked"
// pass for private channels. Nothing is stored server-side; changing the
// secret or the viewer password version invalidates them.

const crypto = require('node:crypto');

const ADMIN_COOKIE = 'sl_admin';
const VIEWER_COOKIE = 'sl_view';
const ADMIN_TTL_MS = 12 * 3600 * 1000;
const VIEWER_TTL_MS = 7 * 24 * 3600 * 1000;

function sign(secret, payload) {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

/** `scope.expiry[.extra].signature` */
function makeToken(secret, scope, ttlMs, extra = '', now = Date.now()) {
  const payload = [scope, now + ttlMs, extra].join('.');
  return `${payload}.${sign(secret, payload)}`;
}

function checkToken(secret, token, scope, extra = '', now = Date.now()) {
  if (typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 4) return false;
  const [tokenScope, expiry, tokenExtra, signature] = parts;
  if (tokenScope !== scope || tokenExtra !== String(extra) || !(Number(expiry) > now)) return false;
  const expected = Buffer.from(sign(secret, parts.slice(0, 3).join('.')));
  const actual = Buffer.from(signature);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** Set-Cookie value: HttpOnly, SameSite=Strict, Secure when served over HTTPS. */
function cookie(name, value, { maxAgeMs, secure }) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${Math.floor(maxAgeMs / 1000)}`];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

class Sessions {
  constructor(config) {
    this.config = config;
  }

  get secret() {
    return this.config.data.sessionSecret;
  }

  adminCookie(secure) {
    return cookie(ADMIN_COOKIE, makeToken(this.secret, 'admin', ADMIN_TTL_MS), { maxAgeMs: ADMIN_TTL_MS, secure });
  }

  isAdmin(req) {
    return checkToken(this.secret, parseCookies(req.headers.cookie)[ADMIN_COOKIE], 'admin');
  }

  viewerCookie(secure) {
    return cookie(VIEWER_COOKIE, makeToken(this.secret, 'view', VIEWER_TTL_MS, this.config.data.viewerPasswordVersion), { maxAgeMs: VIEWER_TTL_MS, secure });
  }

  /** Whether this request may watch: public channel, unlocked viewer, or the admin. */
  canWatch(req) {
    if (!this.config.data.privateMode) return true;
    if (this.isAdmin(req)) return true;
    return checkToken(this.secret, parseCookies(req.headers.cookie)[VIEWER_COOKIE], 'view', this.config.data.viewerPasswordVersion);
  }

  static clear(name, secure) {
    return cookie(name, '', { maxAgeMs: 0, secure });
  }
}

module.exports = { Sessions, makeToken, checkToken, parseCookies, cookie, ADMIN_COOKIE, VIEWER_COOKIE };
