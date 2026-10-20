'use strict';

// Browsers only play Opus audio over WebRTC, while StudioMix, OBS and RTMP in
// general send AAC. FFmpeg re-encodes just the audio (the video is copied), so
// it is cheap. This finds an FFmpeg that can encode Opus.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const exeName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';

/** Places to look, in order: setting, FFMPEG_PATH, PATH, a StudioMix next to this folder. */
function candidates(configured, root) {
  return [
    configured,
    process.env.FFMPEG_PATH,
    'ffmpeg',
    path.join(root, '..', 'studiomix', 'node_modules', 'ffmpeg-static', exeName),
  ].filter(Boolean);
}

function canEncodeOpus(file) {
  if (file !== 'ffmpeg' && !fs.existsSync(file)) return false;
  const r = spawnSync(file, ['-hide_banner', '-encoders'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  return r.status === 0 && /\blibopus\b/.test(r.stdout);
}

function findFfmpeg(configured, root) {
  return candidates(configured, root).find(canEncodeOpus) ?? null;
}

/**
 * Command MediaMTX runs while the stream is available: reads the published
 * path over local RTSP and republishes it with Opus audio on the viewer path.
 * Forward slashes keep Windows paths intact through MediaMTX's argument splitting.
 */
function opusCommand(ffmpeg, rtspPort, from, to) {
  const exe = ffmpeg.replace(/\\/g, '/');
  return [
    `"${exe}"`, '-hide_banner', '-loglevel', 'error',
    '-rtsp_transport', 'tcp', '-i', `rtsp://127.0.0.1:${rtspPort}/${from}`,
    '-map', '0:v', '-map', '0:a?',
    '-c:v', 'copy', '-c:a', 'libopus', '-ar', '48000', '-ac', '2', '-b:a', '128k',
    '-f', 'rtsp', '-rtsp_transport', 'tcp', `rtsp://127.0.0.1:${rtspPort}/${to}`,
  ].join(' ');
}

module.exports = { findFfmpeg, opusCommand, candidates };
