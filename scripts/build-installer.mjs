/**
 * Builds the Windows installer (ALON-Studio-Setup.exe) from a built release folder, plus its SHA-256.
 *   node scripts/build-installer.mjs [release folder]      (default: release/ALON Studio)
 * Run after `npm run release` and `npm run release:docs`. Needs Inno Setup 6 (ISCC.exe):
 *   winget install --id JRSoftware.InnoSetup -e --scope user
 * or set ISCC to its full path.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.resolve(process.argv[2] ?? path.join(ROOT, 'release', 'ALON Studio'));
const OUT = path.dirname(SRC);
const ISS = path.join(ROOT, 'scripts', 'installer', 'alon-studio.iss');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

if (!fs.existsSync(path.join(SRC, 'ALON Studio.cmd'))) throw new Error(`not a built release folder: ${SRC}`);
const candidates = [
  process.env.ISCC,
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Inno Setup 6', 'ISCC.exe'),
  process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Inno Setup 6', 'ISCC.exe'),
  process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Inno Setup 6', 'ISCC.exe'),
].filter(Boolean);
const iscc = candidates.find((c) => fs.existsSync(c));
if (!iscc) throw new Error('Inno Setup 6 not found. Install it: winget install --id JRSoftware.InnoSetup -e --scope user');

const t0 = Date.now();
execFileSync(iscc, ['/Q', `/DSrcDir=${SRC}`, `/DOutDir=${OUT}`, `/DAppVersion=${VERSION}`, ISS], { stdio: 'inherit' });
const exe = path.join(OUT, 'ALON-Studio-Setup.exe');
const hash = createHash('sha256');
const fd = fs.openSync(exe, 'r');
const buf = Buffer.alloc(1 << 22);
for (let n; (n = fs.readSync(fd, buf, 0, buf.length, null)) > 0; ) hash.update(buf.subarray(0, n));
fs.closeSync(fd);
const hex = hash.digest('hex');
fs.writeFileSync(exe + '.sha256', `${hex}  ALON-Studio-Setup.exe\r\n`);
console.log(`DONE  ${exe}  (${Math.round(fs.statSync(exe).size / 1e6)} MB, ${Math.round((Date.now() - t0) / 1000)} s)\n${hex}`);
