/**
 * Runs the release gates (types, logic, end to end, features, security, browser, dependencies, old projects, preview vs export, and the browser journey in English) against the isolated test instance and prints a table.
 *   node scripts/gates.mjs [--only=1,2,...]
 * Needs the test instance running (node scripts/test-server.mjs, port 5182) and the test media
 * (scripts/make-test-media.ps1). Logs go to %TEMP%/alon-gates/<n>.log; UI screenshots to ui-out/.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const MEDIA = process.env.ALON_TEST_MEDIA ?? path.join(os.tmpdir(), 'alon-test-media');
const env = {
  ...process.env,
  BASE_URL: process.env.BASE_URL ?? 'http://localhost:5182',
  ALON_DATA_DIR: process.env.ALON_DATA_DIR ?? path.join(os.tmpdir(), 'alon-test-data'),
};
const clip = path.join(MEDIA, 'test-clip.mp4');
const music = path.join(MEDIA, 'test-music.mp3');
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const gates = [
  [1, 'types', npm, ['run', '-s', 'typecheck']],
  [2, 'logic regression', npx, ['tsx', 'scripts/regress.ts']],
  [3, 'end to end', npx, ['tsx', 'scripts/e2e.ts', clip, music]],
  [4, 'features end to end', npx, ['tsx', 'scripts/e2e-features.ts', clip]],
  [5, 'security', npx, ['tsx', 'scripts/security-tests.ts', clip]],
  [6, 'real browser', npx, ['tsx', 'scripts/ui/user-journey.mjs', env.BASE_URL, clip, music, 'ui-out']],
  [7, 'dependencies', process.execPath, ['scripts/security-check.mjs']],
  [8, 'old projects', npx, ['tsx', 'scripts/old-projects.ts']],
  [9, 'preview vs export', npx, ['tsx', 'scripts/parity.ts', env.BASE_URL, 'ui-out/parity']],
  [10, 'real browser, English', npx, ['tsx', 'scripts/ui/user-journey.mjs', env.BASE_URL, clip, music, 'ui-out/en'], { UI_LANG: 'en' }],
];
const only = (process.argv.find((a) => a.startsWith('--only=')) ?? '').slice(7).split(',').filter(Boolean).map(Number);
const logDir = path.join(os.tmpdir(), 'alon-gates');
fs.mkdirSync(logDir, { recursive: true });
if (!fs.existsSync(clip)) throw new Error(`test media missing: run scripts/make-test-media.ps1 (${MEDIA})`);

const rows = [];
for (const [n, name, cmd, args, extra] of gates) {
  if (only.length && !only.includes(n)) continue;
  const t0 = Date.now();
  const r = spawnSync(cmd, args, { cwd: ROOT, env: { ...env, ...extra }, encoding: 'utf8', shell: cmd.endsWith('.cmd'), maxBuffer: 64 << 20 });
  const out = (r.stdout ?? '') + (r.stderr ?? '');
  fs.writeFileSync(path.join(logDir, `${n}.log`), out);
  const lines = out.trim().split(/\r?\n/).filter((l) => l.trim());
  const fails = lines.filter((l) => /\bFAIL(ED)?\b|error TS\d+/.test(l)).slice(0, 5);
  const pass = r.status === 0;
  rows.push({ n, name, pass, secs: Math.round((Date.now() - t0) / 1000), summary: pass ? (lines.at(-1) ?? '').slice(0, 70) : fails.join(' | ').slice(0, 300) || (lines.at(-1) ?? '') });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${n}. ${name}  (${rows.at(-1).secs}s)  ${rows.at(-1).summary}`);
}
const bad = rows.filter((r) => !r.pass);
console.log(bad.length ? `\n${bad.length} GATE(S) FAILED - logs in ${logDir}` : `\nALL ${rows.length} GATES GREEN`);
process.exit(bad.length ? 1 : 0);
