'use strict';

// StudioMix Live: your own streaming page. StudioMix (or OBS) sends RTMP/SRT
// to MediaMTX; viewers watch here over WebRTC, with chat and an optional
// password. Run with `npm start`.

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { Config, hashPassword, verifyPassword, randomToken } = require('./config');
const { Sessions, parseCookies, ADMIN_COOKIE } = require('./sessions');
const { Chat } = require('./chat');
const { MediaMTX, mediamtxConfig, MEDIAMTX_HTTP } = require('./mediamtx');

const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'web');
const DATA = process.env.STUDIOMIX_LIVE_DATA || path.join(ROOT, 'data');
const EXE = path.join(ROOT, 'vendor', 'mediamtx', process.platform === 'win32' ? 'mediamtx.exe' : 'mediamtx');

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; media-src 'self' blob: mediastream:; connect-src 'self'; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};
const MAX_JSON = 16 * 1024;
const MAX_SDP = 64 * 1024;

const isLoopback = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
const isHttps = (req) => req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';

/**
 * IPv4 addresses others on the network could reach, real adapters first
 * (VirtualBox, Hyper-V, WSL, VPN… adapters go last). Same rules as StudioMix.
 */
function lanAddresses() {
  const virtualName = /virtual|vbox|vmware|vethernet|hyper-v|wsl|docker|loopback|tap|tun|vpn|zerotier|tailscale/i;
  const virtualMac = /^(0a:00:27|08:00:27|00:50:56|00:0c:29|00:05:69|00:15:5d)/i;
  const list = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal || a.address.startsWith('169.254.')) continue;
      const isVirtual = virtualName.test(name) || virtualMac.test(a.mac || '');
      list.push({ ip: a.address, rank: isVirtual ? 2 : /^(192\.168|10\.|172\.(1[6-9]|2\d|3[01]))\./.test(a.address) ? 0 : 1 });
    }
  }
  return list.sort((a, b) => a.rank - b.rank).map((a) => a.ip);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('Petición demasiado grande'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  // Browsers can't send application/json cross-site without CORS, which we never allow.
  if (!/^application\/json\b/.test(req.headers['content-type'] ?? '')) throw Object.assign(new Error('Se esperaba JSON'), { status: 415 });
  try {
    return JSON.parse(String(await readBody(req, MAX_JSON)) || '{}');
  } catch (err) {
    throw Object.assign(new Error(err.status ? err.message : 'JSON no válido'), { status: err.status ?? 400 });
  }
}

function send(res, status, body, headers = {}) {
  const json = typeof body !== 'string';
  res.writeHead(status, { ...SECURITY_HEADERS, 'Cache-Control': 'no-store', 'Content-Type': json ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8', ...headers });
  res.end(json ? JSON.stringify(body) : body);
}

function serveStatic(res, file) {
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'No encontrado');
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

/** Brute-force brake for password forms: 8 attempts per IP every 10 minutes. */
class Throttle {
  constructor(max = 8, windowMs = 600000) {
    Object.assign(this, { max, windowMs, hits: new Map() });
  }

  allow(key, now = Date.now()) {
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    recent.push(now);
    this.hits.set(key, recent);
    return recent.length <= this.max;
  }
}

/** Forwards a WHEP request to MediaMTX for the current stream path. */
function proxyWhep(req, res, body, upstreamPath) {
  const headers = { 'Content-Type': req.headers['content-type'] ?? 'application/sdp' };
  for (const h of ['if-match', 'accept']) if (req.headers[h]) headers[h] = req.headers[h];
  const upstream = http.request({ host: '127.0.0.1', port: MEDIAMTX_HTTP.webrtc, method: req.method, path: upstreamPath, headers }, (up) => {
    const out = { ...SECURITY_HEADERS, 'Cache-Control': 'no-store' };
    for (const h of ['content-type', 'etag', 'link', 'accept-patch']) if (up.headers[h]) out[h] = up.headers[h];
    // MediaMTX's session URL contains the stream key: hand out our own instead.
    const session = /\/whep\/([\w-]+)$/.exec(up.headers.location ?? '')?.[1];
    if (session) out.Location = `/whep/${session}`;
    res.writeHead(up.statusCode ?? 502, out);
    up.pipe(res);
  });
  upstream.on('error', () => send(res, 503, 'El servidor de vídeo no está disponible'));
  upstream.end(body);
}

function createServer({ config, chat, sessions, mediamtx, setupCode, log = console }) {
  const loginThrottle = new Throttle();
  const streamPath = () => `live/${config.data.streamKey}`;

  const viewerIdFor = (req) => {
    // Anonymous, per browser: lets the admin ban someone from the chat.
    const cookies = parseCookies(req.headers.cookie);
    return /^[\w-]{10,40}$/.test(cookies.sl_vid ?? '') ? cookies.sl_vid : null;
  };

  const channel = (req) => ({
    title: config.data.title,
    description: config.data.description,
    private: config.data.privateMode,
    canWatch: sessions.canWatch(req),
    live: chat.status.live,
    viewers: chat.viewers,
  });

  const adminState = (req) => {
    const host = config.data.publicHost || lanAddresses()[0] || '127.0.0.1';
    return {
      ...channel(req),
      streamKey: config.data.streamKey,
      ingest: {
        rtmpServer: `rtmp://${host}:${config.data.rtmpPort}/live`,
        rtmpUrl: `rtmp://${host}:${config.data.rtmpPort}/live/${config.data.streamKey}`,
        srtUrl: `srt://${host}:${config.data.srtPort}?streamid=publish:live/${config.data.streamKey}`,
      },
      viewerUrl: `http://${host}:${config.data.port}/`,
      hasViewerPassword: !!config.data.viewerPasswordHash,
      publicHost: config.data.publicHost,
      ports: { web: config.data.port, rtmp: config.data.rtmpPort, srt: config.data.srtPort, webrtc: config.data.webrtcPort },
      stats: chat.status,
      chat: chat.history,
      banned: chat.banned.size,
    };
  };

  async function route(req, res) {
    const url = new URL(req.url, 'http://local');
    const p = url.pathname;
    const secure = isHttps(req);

    // --- MediaMTX asks whether a publish/read is allowed (localhost only) ---
    if (p === '/internal/mediamtx-auth' && req.method === 'POST') {
      if (!isLoopback(req)) return send(res, 403, 'Prohibido');
      const a = JSON.parse(String(await readBody(req, MAX_JSON)) || '{}');
      const ok =
        (a.action === 'publish' && a.path === streamPath()) ||
        // Viewers only reach MediaMTX through our proxy, which checks access first.
        (a.action === 'read' && a.path === streamPath() && ['127.0.0.1', '::1'].includes(a.ip));
      if (!ok && a.action === 'publish') log.warn(`Emisión rechazada desde ${a.ip} (clave incorrecta)`);
      return send(res, ok ? 200 : 401, ok ? 'ok' : 'denegado');
    }

    // --- viewer pages ---
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) return serveStatic(res, path.join(WEB, 'index.html'));
    if (req.method === 'GET' && p === '/admin') return serveStatic(res, path.join(WEB, 'admin.html'));
    if (req.method === 'GET' && p.startsWith('/assets/')) {
      const file = path.join(WEB, 'assets', path.basename(p));
      return serveStatic(res, file);
    }

    if (p === '/api/channel' && req.method === 'GET') {
      const headers = {};
      if (!viewerIdFor(req)) headers['Set-Cookie'] = `sl_vid=${randomToken(12)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000${secure ? '; Secure' : ''}`;
      return send(res, 200, channel(req), headers);
    }

    if (p === '/api/unlock' && req.method === 'POST') {
      if (!loginThrottle.allow(`view:${req.socket.remoteAddress}`)) return send(res, 429, { ok: false, error: 'Demasiados intentos. Espera unos minutos.' });
      const { password } = await readJson(req);
      if (!config.data.privateMode) return send(res, 200, { ok: true });
      if (!verifyPassword(String(password ?? ''), config.data.viewerPasswordHash)) return send(res, 403, { ok: false, error: 'Contraseña incorrecta' });
      return send(res, 200, { ok: true }, { 'Set-Cookie': sessions.viewerCookie(secure) });
    }

    if (p === '/api/events' && req.method === 'GET') {
      if (!sessions.canWatch(req)) return send(res, 403, 'Este directo es privado');
      chat.connect(res, viewerIdFor(req) ?? `anon-${crypto.randomUUID()}`);
      return undefined;
    }

    if (p === '/api/chat' && req.method === 'POST') {
      if (!sessions.canWatch(req)) return send(res, 403, { ok: false, error: 'Este directo es privado' });
      const viewerId = viewerIdFor(req);
      if (!viewerId) return send(res, 400, { ok: false, error: 'Recarga la página' });
      const { nick, text } = await readJson(req);
      const result = chat.post(viewerId, nick, text);
      return send(res, result.ok ? 200 : 400, result.ok ? { ok: true } : result);
    }

    // --- video (WHEP), proxied so viewers never learn the stream key ---
    if (p === '/whep' && req.method === 'POST') {
      if (!sessions.canWatch(req)) return send(res, 403, 'Este directo es privado');
      const body = await readBody(req, MAX_SDP);
      return proxyWhep(req, res, body, `/${streamPath()}/whep`);
    }
    const session = /^\/whep\/([\w-]+)$/.exec(p)?.[1];
    if (session && (req.method === 'PATCH' || req.method === 'DELETE')) {
      if (!sessions.canWatch(req)) return send(res, 403, 'Este directo es privado');
      const body = await readBody(req, MAX_SDP);
      return proxyWhep(req, res, body, `/${streamPath()}/whep/${session}`);
    }

    // --- admin ---
    if (p.startsWith('/admin/api/')) {
      const action = p.slice('/admin/api/'.length);
      if (action === 'status' && req.method === 'GET') {
        return send(res, 200, { needsSetup: config.needsSetup, loggedIn: sessions.isAdmin(req) });
      }
      if (req.method !== 'POST' && action !== 'state') return send(res, 405, 'Método no permitido');

      if (action === 'setup') {
        if (!config.needsSetup) return send(res, 409, { ok: false, error: 'El panel ya está configurado' });
        if (!loginThrottle.allow(`setup:${req.socket.remoteAddress}`)) return send(res, 429, { ok: false, error: 'Demasiados intentos. Espera unos minutos.' });
        const { code, password } = await readJson(req);
        if (String(code ?? '').trim() !== setupCode) return send(res, 403, { ok: false, error: 'El código de activación no es correcto (está en la consola del servidor)' });
        if (String(password ?? '').length < 8) return send(res, 400, { ok: false, error: 'La contraseña debe tener al menos 8 caracteres' });
        config.update({ adminPasswordHash: hashPassword(password) });
        log.info('Panel de administración configurado');
        return send(res, 200, { ok: true }, { 'Set-Cookie': sessions.adminCookie(secure) });
      }
      if (action === 'login') {
        if (!loginThrottle.allow(`admin:${req.socket.remoteAddress}`)) return send(res, 429, { ok: false, error: 'Demasiados intentos. Espera unos minutos.' });
        const { password } = await readJson(req);
        if (!verifyPassword(String(password ?? ''), config.data.adminPasswordHash)) {
          log.warn(`Acceso al panel rechazado desde ${req.socket.remoteAddress}`);
          return send(res, 403, { ok: false, error: 'Contraseña incorrecta' });
        }
        return send(res, 200, { ok: true }, { 'Set-Cookie': sessions.adminCookie(secure) });
      }
      if (action === 'logout') return send(res, 200, { ok: true }, { 'Set-Cookie': Sessions.clear(ADMIN_COOKIE, secure) });

      if (!sessions.isAdmin(req)) return send(res, 401, { ok: false, error: 'Inicia sesión' });
      if (action === 'state') return send(res, 200, adminState(req));

      const body = await readJson(req);
      switch (action) {
        case 'channel': {
          const title = String(body.title ?? '').trim().slice(0, 100) || 'Mi canal';
          const description = String(body.description ?? '').trim().slice(0, 1000);
          const publicHost = String(body.publicHost ?? config.data.publicHost).trim().replace(/^https?:\/\//, '').replace(/[/:].*$/, '').slice(0, 253);
          if (publicHost && !/^[\w.-]+$/.test(publicHost)) return send(res, 400, { ok: false, error: 'La dirección pública debe ser una IP o un dominio' });
          const hostChanged = publicHost !== config.data.publicHost;
          config.update({ title, description, publicHost });
          chat.broadcast('channel', { title, description });
          if (hostChanged) restartMediamtx();
          return send(res, 200, { ok: true });
        }
        case 'privacy': {
          const privateMode = !!body.private;
          const patch = { privateMode };
          if (body.password) {
            if (String(body.password).length < 4) return send(res, 400, { ok: false, error: 'La contraseña del público debe tener al menos 4 caracteres' });
            patch.viewerPasswordHash = hashPassword(String(body.password));
            patch.viewerPasswordVersion = config.data.viewerPasswordVersion + 1;
          }
          if (privateMode && !patch.viewerPasswordHash && !config.data.viewerPasswordHash) return send(res, 400, { ok: false, error: 'Elige una contraseña para el público' });
          config.update(patch);
          chat.broadcast('channel', { private: privateMode });
          return send(res, 200, { ok: true });
        }
        case 'regenerate-key': {
          config.update({ streamKey: randomToken() });
          log.info('Clave de emisión cambiada; la emisión en curso se cortará');
          // The old key's path stops being authorised; reconnecting needs the new key.
          restartMediamtx();
          return send(res, 200, { ok: true });
        }
        case 'chat-delete':
          chat.remove(Number(body.id));
          return send(res, 200, { ok: true });
        case 'chat-clear':
          chat.clear();
          return send(res, 200, { ok: true });
        case 'chat-ban': {
          const target = chat.history.find((m) => m.id === Number(body.id))?.viewerId;
          if (target) chat.ban(target);
          return send(res, 200, { ok: true });
        }
        default:
          return send(res, 404, { ok: false, error: 'Acción desconocida' });
      }
    }

    return send(res, 404, 'No encontrado');
  }

  function restartMediamtx() {
    if (!mediamtx) return;
    mediamtx.stop();
    mediamtx.start(mediamtxConfig(config.data, { authUrl: authUrl(), additionalHosts: config.data.publicHost ? [config.data.publicHost] : [] }));
  }

  const authUrl = () => `http://127.0.0.1:${config.data.port}/internal/mediamtx-auth`;

  const server = http.createServer((req, res) => {
    route(req, res).catch((err) => {
      if (!err.status) log.error('Error en', req.method, req.url, err);
      if (!res.headersSent) send(res, err.status ?? 500, { ok: false, error: err.status ? err.message : 'Error interno' });
      else res.end();
    });
  });
  return { server, restartMediamtx, authUrl };
}

function main() {
  const log = {
    info: (...a) => console.log(new Date().toISOString(), ...a),
    warn: (...a) => console.warn(new Date().toISOString(), 'AVISO', ...a),
    error: (...a) => console.error(new Date().toISOString(), 'ERROR', ...a),
  };
  const config = new Config(path.join(DATA, 'config.json'));
  const sessions = new Sessions(config);
  const chat = new Chat();
  const mediamtx = new MediaMTX({ exe: EXE, dataDir: DATA, log });
  // One-time code shown only here: whoever sets up the panel must see this console.
  const setupCode = config.needsSetup ? String(crypto.randomInt(100000, 1000000)) : null;
  const { server, restartMediamtx } = createServer({ config, chat, sessions, mediamtx, setupCode, log });

  server.listen(config.data.port, () => {
    const hosts = ['localhost', ...lanAddresses()];
    log.info(`StudioMix Live en marcha:\n  Público: ${hosts.map((h) => `http://${h}:${config.data.port}/`).join('  ')}\n  Panel:   http://localhost:${config.data.port}/admin`);
    if (setupCode) log.info(`\n  Código de activación del panel: ${setupCode}\n  (Ábrelo y crea tu contraseña de administrador.)\n`);
    restartMediamtx();
  });

  // Live status and stats from MediaMTX every 2 s.
  setInterval(async () => {
    const info = await mediamtx.pathInfo(`live/${config.data.streamKey}`);
    if (!info) return;
    chat.setStatus({ live: info.ready, readers: info.readers, tracks: info.tracks });
  }, 2000).unref();

  const shutdown = () => {
    mediamtx.stop();
    server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) main();

module.exports = { createServer, Throttle, lanAddresses };
