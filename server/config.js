'use strict';

// Channel settings, kept in data/config.json (created on first start, written
// atomically). Secrets are only stored as scrypt hashes or random tokens.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = {
  title: 'Mi canal',
  description: '',
  // Private mode: viewers need the viewer password.
  privateMode: false,
  viewerPasswordHash: null,
  // Bumped when the viewer password changes, so earlier unlocks stop working.
  viewerPasswordVersion: 1,
  adminPasswordHash: null,
  port: 8080,
  rtmpPort: 1935,
  srtPort: 8890,
  webrtcPort: 8189,
  // Public address (IP or domain) viewers reach the server at; empty = this machine's IPs.
  publicHost: '',
};

const randomToken = (bytes = 18) => crypto.randomBytes(bytes).toString('base64url');

/** "scrypt$salt$hash" for `password`. */
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 32);
  return `scrypt$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

function verifyPassword(password, stored) {
  if (typeof stored !== 'string' || typeof password !== 'string') return false;
  const [scheme, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64url');
  const actual = crypto.scryptSync(password, Buffer.from(salt, 'base64url'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

class Config {
  constructor(file) {
    this.file = file;
    this.data = this.load();
  }

  load() {
    let saved = {};
    try {
      saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') throw new Error(`${this.file} no es válido: ${err.message}`);
    }
    const data = { ...DEFAULTS, ...saved };
    let changed = !fs.existsSync(this.file);
    if (!data.streamKey) {
      data.streamKey = randomToken();
      changed = true;
    }
    if (!data.sessionSecret) {
      data.sessionSecret = randomToken(32);
      changed = true;
    }
    this.data = data;
    if (changed) this.save();
    return data;
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  update(patch) {
    Object.assign(this.data, patch);
    this.save();
  }

  get needsSetup() {
    return !this.data.adminPasswordHash;
  }
}

module.exports = { Config, DEFAULTS, hashPassword, verifyPassword, randomToken };
