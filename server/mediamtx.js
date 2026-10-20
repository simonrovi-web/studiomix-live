'use strict';

// Runs MediaMTX with a configuration generated from the channel settings.
// Publishing and reading are authorised by our own server (authMethod: http);
// the WebRTC/HLS HTTP endpoints and the API listen on localhost only, so
// viewers always go through our proxy and its access checks.

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { opusCommand } = require('./ffmpeg');

const MEDIAMTX_HTTP = { webrtc: 18889, hls: 18888, api: 19997, rtsp: 18554 };

/**
 * MediaMTX YAML (JSON is valid YAML, which keeps quoting simple). The
 * publisher sends to live/<key>; with FFmpeg, viewers watch watch/<key>, the
 * same video with Opus audio; without it they watch live/<key> (no sound).
 */
function mediamtxConfig(cfg, { authUrl, additionalHosts = [], streamKey, ffmpeg = null }) {
  const live = `live/${streamKey}`;
  const watch = `watch/${streamKey}`;
  const paths = ffmpeg
    ? { [live]: { runOnAvailable: opusCommand(ffmpeg, MEDIAMTX_HTTP.rtsp, live, watch), runOnAvailableRestart: true }, [watch]: {} }
    : { [live]: {} };
  const config = {
    logLevel: 'info',
    logDestinations: ['stdout'],
    readTimeout: '10s',
    writeTimeout: '10s',
    authMethod: 'http',
    authHTTPAddress: authUrl,
    // Local API (status and viewer counts) needs no round trip to our hook.
    authHTTPExclude: [{ action: 'api' }, { action: 'metrics' }],
    api: true,
    apiAddress: `127.0.0.1:${MEDIAMTX_HTTP.api}`,
    metrics: false,
    pprof: false,
    playback: false,
    // Local only: FFmpeg reads and republishes through it for the Opus audio.
    rtsp: !!ffmpeg,
    rtspAddress: `127.0.0.1:${MEDIAMTX_HTTP.rtsp}`,
    rtspTransports: ['tcp'],
    moq: false,
    rtmp: true,
    rtmpAddress: `:${cfg.rtmpPort}`,
    srt: true,
    srtAddress: `:${cfg.srtPort}`,
    hls: true,
    hlsAddress: `127.0.0.1:${MEDIAMTX_HTTP.hls}`,
    hlsVariant: 'lowLatency',
    hlsAllowOrigins: [],
    webrtc: true,
    webrtcAddress: `127.0.0.1:${MEDIAMTX_HTTP.webrtc}`,
    webrtcAllowOrigins: [],
    webrtcLocalUDPAddress: `:${cfg.webrtcPort}`,
    // Same port over TCP for viewers whose network blocks UDP.
    webrtcLocalTCPAddress: `:${cfg.webrtcPort}`,
    webrtcIPsFromInterfaces: true,
    webrtcAdditionalHosts: additionalHosts,
    pathDefaults: { source: 'publisher', overridePublisher: true },
    // Only the current key's paths exist (and the hook checks again).
    paths,
  };
  return `${JSON.stringify(config, null, 2)}\n`;
}

class MediaMTX {
  constructor({ exe, dataDir, log = console }) {
    this.exe = exe;
    this.configFile = path.join(dataDir, 'mediamtx.yml');
    this.log = log;
    this.proc = null;
    this.stopping = false;
    this.restarts = 0;
  }

  start(yaml) {
    if (!fs.existsSync(this.exe)) throw new Error(`No se encuentra MediaMTX en ${this.exe}. Ejecuta «npm run setup».`);
    fs.writeFileSync(this.configFile, yaml);
    this.stopping = false;
    this.spawn();
  }

  spawn() {
    const proc = spawn(this.exe, [this.configFile], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    this.proc = proc;
    const forward = (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        // Our status poll asks for the path while nobody is publishing.
        if (!line.trim() || /\[API\] path not found/.test(line)) continue;
        // Session noise is useful when debugging, not in normal operation.
        if (/\b(ERR|WAR)\b/.test(line)) this.log.warn(`[mediamtx] ${line}`);
        else if (/is publishing|closed|destroyed|session .* created/i.test(line)) this.log.info(`[mediamtx] ${line}`);
      }
    };
    proc.stdout.on('data', forward);
    proc.stderr.on('data', forward);
    proc.on('error', (err) => this.log.error(`[mediamtx] no se pudo iniciar: ${err.message}`));
    proc.on('close', (code) => {
      if (this.proc !== proc || this.stopping) return;
      // Crashed: restart with a growing delay, so a bad config doesn't spin.
      const delay = Math.min(30000, 1000 * 2 ** Math.min(this.restarts++, 5));
      this.log.warn(`[mediamtx] terminó (código ${code}); reinicio en ${delay / 1000} s`);
      this.timer = setTimeout(() => this.spawn(), delay);
    });
    setTimeout(() => {
      if (this.proc === proc && proc.exitCode === null) this.restarts = 0;
    }, 60000).unref();
  }

  stop() {
    this.stopping = true;
    clearTimeout(this.timer);
    this.proc?.kill();
    this.proc = null;
  }

  /** Path state from the local API: { ready, readers, bytesReceived } or null if offline. */
  async pathInfo(name) {
    try {
      const res = await fetch(`http://127.0.0.1:${MEDIAMTX_HTTP.api}/v3/paths/get/${encodeURIComponent(name)}`, { signal: AbortSignal.timeout(2000) });
      if (res.status === 404) return { ready: false, readers: 0, bytesReceived: 0 };
      if (!res.ok) return null;
      const p = await res.json();
      return { ready: !!p.ready, readers: p.readers?.length ?? 0, bytesReceived: p.bytesReceived ?? 0, tracks: p.tracks ?? [] };
    } catch {
      return null; // MediaMTX starting or restarting.
    }
  }
}

module.exports = { MediaMTX, mediamtxConfig, MEDIAMTX_HTTP };
