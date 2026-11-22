/**
 * Monthly supply-chain check (also after any dependency change):
 *   node scripts/security-check.mjs [release folder]
 * - npm audit of the production dependencies
 * - OSV (osv.dev) lookup of every npm package in the lockfile and every Python package bundled in the release
 * - is the bundled Node.js still the latest release of its major line, and is that line still supported
 * Only package names and versions are sent (to registry.npmjs.org, api.osv.dev and nodejs.org). Exit code 1 = action needed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const REL = path.resolve(process.argv[2] ?? path.join(ROOT, 'release', 'ALON Studio'));
const SITE = path.join(REL, 'runtime', 'python', 'Lib', 'site-packages');
const problems = [];
const say = (s) => console.log(s);
// Advisories reviewed and judged not reachable in this app. Each has a review date; after it, it is reported again.
const ACCEPTED = {
  'GHSA-h35f-9h28-mq5c': { until: '2027-05-01', why: 'setuptools sdist building (MANIFEST.in on macOS); the app never builds packages' },
  'PYSEC-2026-3447': { until: '2027-05-01', why: 'same as GHSA-h35f-9h28-mq5c' },
  'GHSA-xmj3-9gf7-h52w': { until: '2027-05-01', why: 'setuptools legacy wheel installation; the app never installs packages (setuptools ships only for pkg_resources, which CTranslate2 4.4 imports)' },
};
const today = new Date().toISOString().slice(0, 10);
const accepted = (id) => ACCEPTED[id] && ACCEPTED[id].until > today;

// ---- 1. npm audit (production dependencies) ----
say('npm audit (production dependencies)');
try {
  // npm is a .cmd script on Windows, which needs cmd.exe; the command line is fixed text
  const [cmd, args] = process.platform === 'win32' ? ['cmd.exe', ['/d', '/s', '/c', 'npm audit --omit=dev --json']] : ['npm', ['audit', '--omit=dev', '--json']];
  const out = execFileSync(cmd, args, { cwd: ROOT }).toString();
  const v = JSON.parse(out).metadata?.vulnerabilities ?? {};
  say(`  ${JSON.stringify(v)}`);
} catch (e) {
  // npm audit exits non-zero when it finds something
  const out = e.stdout?.toString() ?? '';
  try {
    const j = JSON.parse(out);
    say(`  ${JSON.stringify(j.metadata?.vulnerabilities)}`);
    for (const [name, x] of Object.entries(j.vulnerabilities ?? {})) problems.push(`npm ${name}: ${x.severity} (${x.via.map((v) => (typeof v === 'string' ? v : v.title)).join('; ')})`);
  } catch {
    problems.push(`npm audit failed: ${e.message}`);
  }
}

// ---- 2. OSV for the lockfile and the bundled Python packages ----
const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
const pkgs = [];
for (const [k, v] of Object.entries(lock.packages)) if (k && v.version) pkgs.push({ eco: 'npm', name: v.name ?? k.split('node_modules/').pop(), version: v.version, dev: !!v.dev });
if (fs.existsSync(SITE)) {
  for (const d of fs.readdirSync(SITE).filter((x) => x.endsWith('.dist-info'))) {
    const n = d.slice(0, -'.dist-info'.length);
    const i = n.lastIndexOf('-');
    pkgs.push({ eco: 'PyPI', name: n.slice(0, i), version: n.slice(i + 1), dev: false });
  }
} else say(`  (no bundled Python found in ${REL})`);
const seen = new Set();
const q = pkgs.filter((p) => !seen.has(p.eco + p.name + p.version) && seen.add(p.eco + p.name + p.version));
say(`\nOSV lookup: ${q.length} packages`);
const res = await fetch('https://api.osv.dev/v1/querybatch', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ queries: q.map((p) => ({ package: { ecosystem: p.eco, name: p.name }, version: p.version })) }),
});
if (!res.ok) problems.push(`OSV query failed: ${res.status}`);
else {
  const data = await res.json();
  q.forEach((p, i) => {
    const all = (data.results[i]?.vulns ?? []).map((v) => v.id);
    for (const id of all.filter(accepted)) say(`  accepted until ${ACCEPTED[id].until}: ${p.name}@${p.version} ${id} (${ACCEPTED[id].why})`);
    const ids = all.filter((id) => !accepted(id));
    if (ids.length) problems.push(`${p.eco} ${p.name}@${p.version}${p.dev ? ' (build tool only)' : ''}: ${ids.join(', ')}  -> https://osv.dev/vulnerability/${ids[0]}`);
  });
}

// ---- 3. bundled Node.js ----
const nodeExe = path.join(REL, 'runtime', 'node.exe');
const bundled = fs.existsSync(nodeExe) ? execFileSync(nodeExe, ['-v']).toString().trim() : process.version;
const index = await (await fetch('https://nodejs.org/dist/index.json')).json();
const major = bundled.split('.')[0];
const latestSame = index.find((r) => r.version.startsWith(major + '.'));
say(`\nNode.js bundled ${bundled}, latest ${major}.x is ${latestSame?.version ?? '?'}${latestSame?.security ? ' (security release)' : ''}`);
if (latestSame && latestSame.version !== bundled) {
  const newer = index.filter((r) => r.version.startsWith(major + '.') && cmp(r.version, bundled) > 0);
  const sec = newer.filter((r) => r.security).map((r) => r.version);
  (sec.length ? problems : []).push(`Node.js ${bundled} is behind security release(s) ${sec.join(', ')}: rebuild with ${latestSame.version}`);
  if (!sec.length) say('  (newer, but no security release in between)');
}
const lts = index.filter((r) => r.lts).map((r) => r.version.split('.')[0]);
if (!lts.includes(major) && !index.slice(0, 1).some((r) => r.version.startsWith(major + '.'))) problems.push(`Node.js ${major} is no longer a supported line: move to ${index.find((r) => r.lts)?.version}`);

const ff = path.join(REL, 'runtime', 'ffmpeg.exe');
if (fs.existsSync(ff)) say(`\nffmpeg: ${execFileSync(ff, ['-version']).toString().split(/\r?\n/)[0]}  (compare with https://ffmpeg.org/security.html)`);

say(problems.length ? `\nACTION NEEDED (${problems.length}):\n- ${problems.join('\n- ')}` : '\nNO KNOWN VULNERABILITIES');
process.exit(problems.length ? 1 : 0);

function cmp(a, b) {
  const x = a.slice(1).split('.').map(Number);
  const y = b.slice(1).split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}
