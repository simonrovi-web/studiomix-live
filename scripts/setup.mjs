// Downloads the pinned MediaMTX release for this OS from its official GitHub
// releases, checks it against the release's SHA-256 list, and unpacks it into
// vendor/mediamtx/. Run with `npm run setup`; does nothing if already present.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MEDIAMTX_VERSION = 'v1.21.2';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(root, 'vendor', 'mediamtx');
const exe = path.join(target, process.platform === 'win32' ? 'mediamtx.exe' : 'mediamtx');

const ASSETS = {
  'win32-x64': `mediamtx_${MEDIAMTX_VERSION}_windows_amd64.zip`,
  'linux-x64': `mediamtx_${MEDIAMTX_VERSION}_linux_amd64.tar.gz`,
  'linux-arm64': `mediamtx_${MEDIAMTX_VERSION}_linux_arm64.tar.gz`,
  'darwin-arm64': `mediamtx_${MEDIAMTX_VERSION}_darwin_arm64.tar.gz`,
  'darwin-x64': `mediamtx_${MEDIAMTX_VERSION}_darwin_amd64.tar.gz`,
};

async function download(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function main() {
  if (fs.existsSync(exe)) {
    console.log(`MediaMTX ya está en ${exe}`);
    return;
  }
  const asset = ASSETS[`${process.platform}-${process.arch}`];
  if (!asset) throw new Error(`No hay MediaMTX para ${process.platform}-${process.arch}`);
  const base = `https://github.com/bluenviron/mediamtx/releases/download/${MEDIAMTX_VERSION}`;

  console.log(`Descargando ${asset}…`);
  const [archive, sums] = await Promise.all([download(`${base}/${asset}`), download(`${base}/checksums.sha256`)]);
  const expected = String(sums).split(/\r?\n/).map((l) => l.trim().split(/\s+/)).find(([, name]) => name?.replace(/^\*/, '') === asset)?.[0];
  if (!expected) throw new Error(`${asset} no aparece en checksums.sha256`);
  const actual = createHash('sha256').update(archive).digest('hex');
  if (actual !== expected.toLowerCase()) throw new Error(`La suma SHA-256 no coincide: esperada ${expected}, obtenida ${actual}`);
  console.log(`SHA-256 correcta (${actual}).`);

  fs.mkdirSync(target, { recursive: true });
  const file = path.join(target, asset);
  fs.writeFileSync(file, archive);
  // bsdtar unpacks both .zip and .tar.gz and ships with Windows 10+, macOS and
  // Linux. On Windows use the system one: Git's GNU tar reads "D:" as a host.
  const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  execFileSync(tar, ['-xf', file, '-C', target], { stdio: 'inherit' });
  fs.rmSync(file);
  if (!fs.existsSync(exe)) throw new Error('El archivo no contenía el ejecutable de MediaMTX');
  if (process.platform !== 'win32') fs.chmodSync(exe, 0o755);
  console.log(`MediaMTX ${MEDIAMTX_VERSION} instalado en ${target}`);
}

main().catch((err) => {
  console.error(`No se pudo instalar MediaMTX: ${err.message}`);
  process.exit(1);
});
