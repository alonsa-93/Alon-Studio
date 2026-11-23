/**
 * Release paperwork for a built package (run after `npm run release`):
 *   node scripts/release-docs.mjs [release folder]
 * Writes into the release folder:
 *   sbom.cdx.json            CycloneDX 1.6 software bill of materials (npm, Python wheels, binaries, model)
 *   THIRD-PARTY-NOTICES.txt  component list + licence texts (+ the GPL source information for FFmpeg)
 *   SHA256SUMS.txt           SHA-256 of every file in the package (lets anyone check a copy is untouched)
 * Licence texts come from the files on disk; a few are fetched from their upstream tags.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const REL = path.resolve(process.argv[2] ?? path.join(ROOT, 'release', 'ALON Studio'));
const SP = path.join(REL, 'runtime', 'python', 'Lib', 'site-packages');
const { version: VERSION, license: LICENSE } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const OWN_OUTPUTS = new Set(['sbom.cdx.json', 'THIRD-PARTY-NOTICES.txt', 'SHA256SUMS.txt']);
const sha256 = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
const rel = (f) => path.relative(REL, f).split(path.sep).join('/');
const get = async (u) => {
  try {
    const r = await fetch(u);
    return r.ok ? await r.text() : `[could not fetch ${u}: ${r.status}]`;
  } catch (e) {
    return `[could not fetch ${u}: ${e.message}]`;
  }
};
const read = (f) => fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n').trim();

// pinned transcription models (same table as server/transcribe.py)
const pySrc = fs.readFileSync(path.join(ROOT, 'server', 'transcribe.py'), 'utf8');
const table = (name) => Object.fromEntries([...pySrc.split(name + ' = {')[1].split('}')[0].matchAll(/"([^"]+)":\s*"([0-9a-f]+)"/g)].map((m) => [m[1], m[2]]));
const MODEL_REV = table('PINNED');
const MODEL_SHA = table('PINNED_SHA256');

// ---------- file manifest ----------
const files = walk(REL).filter((f) => !OWN_OUTPUTS.has(rel(f)));
const manifest = files.map((f) => `${sha256(f)}  ${rel(f)}`).sort((a, b) => a.slice(66).localeCompare(b.slice(66)));
fs.writeFileSync(path.join(REL, 'SHA256SUMS.txt'), manifest.join('\r\n') + '\r\n');
const hashOf = Object.fromEntries(manifest.map((l) => [l.slice(66), l.slice(0, 64)]));
const bin = (r) => (hashOf[r] ? [{ alg: 'SHA-256', content: hashOf[r] }] : undefined);

const components = [];
const add = (c) => (components.push(c), c['bom-ref']);

// ---------- npm: what esbuild put into app/server.mjs, plus the client bundle ----------
const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
const serverSrc = fs.readFileSync(path.join(REL, 'app', 'server.mjs'), 'utf8');
const pkgPaths = new Set();
for (const m of serverSrc.matchAll(/^\/\/ (node_modules\/.+)$/gm)) {
  const parts = m[1].split('/');
  const p = [];
  for (let i = 0; i < parts.length; ) {
    if (parts[i] === 'node_modules') {
      const name = parts[i + 1].startsWith('@') ? parts.slice(i + 1, i + 3).join('/') : parts[i + 1];
      p.push('node_modules/' + name);
      i += name.split('/').length + 1;
    } else i++;
  }
  pkgPaths.add(p.join('/'));
}
const client = ['node_modules/react', 'node_modules/react-dom', 'node_modules/scheduler', 'node_modules/zustand'];
const npmRefs = [];
for (const [where, list] of [['server (app/server.mjs)', [...pkgPaths]], ['client (dist/assets)', client]]) {
  for (const p of list.sort()) {
    const e = lock.packages[p];
    if (!e) continue;
    const name = p.split('node_modules/').pop();
    const ref = `npm:${name}@${e.version}`;
    if (components.some((c) => c['bom-ref'] === ref)) continue;
    const [alg, b64] = (e.integrity ?? '').split('-');
    npmRefs.push(
      add({
        type: 'library', 'bom-ref': ref, name, version: e.version,
        purl: `pkg:npm/${name.replace('@', '%40')}@${e.version}`,
        licenses: e.license ? [{ expression: e.license }] : undefined,
        hashes: alg === 'sha512' ? [{ alg: 'SHA-512', content: Buffer.from(b64, 'base64').toString('hex') }] : undefined,
        externalReferences: e.resolved ? [{ type: 'distribution', url: e.resolved }] : undefined,
        properties: [{ name: 'alon:bundledInto', value: where }, { name: 'alon:lockfilePath', value: p }],
      }),
    );
  }
}

// ---------- Python wheels (SHA-256 of the exact wheel on PyPI) ----------
const pyRefs = [];
for (const d of fs.existsSync(SP) ? fs.readdirSync(SP).filter((x) => x.endsWith('.dist-info')) : []) {
  const base = d.replace(/\.dist-info$/, '');
  const i = base.lastIndexOf('-');
  const name = base.slice(0, i);
  const version = base.slice(i + 1);
  const meta = fs.readFileSync(path.join(SP, d, 'METADATA'), 'utf8');
  const lic = (meta.match(/^License-Expression: (.+)$/m) ?? meta.match(/^License: (.+)$/m))?.[1]?.trim();
  const tags = [...fs.readFileSync(path.join(SP, d, 'WHEEL'), 'utf8').matchAll(/^Tag: (.+)$/gm)].map((m) => m[1].trim());
  let wheel = null;
  try {
    const j = await (await fetch(`https://pypi.org/pypi/${name}/${version}/json`)).json();
    wheel = j.urls.find((u) => u.packagetype === 'bdist_wheel' && tags.some((t) => u.filename.endsWith(`-${t}.whl`) || (t.startsWith('py') && u.filename.includes('none-any'))));
  } catch {
    /* offline: no wheel hash */
  }
  pyRefs.push(
    add({
      type: 'library', 'bom-ref': `pypi:${name}@${version}`, name, version,
      purl: `pkg:pypi/${name.toLowerCase().replace(/_/g, '-')}@${version}`,
      licenses: lic ? [{ license: { name: lic } }] : undefined,
      hashes: wheel ? [{ alg: 'SHA-256', content: wheel.digests.sha256 }] : undefined,
      externalReferences: wheel ? [{ type: 'distribution', url: wheel.url }] : undefined,
      properties: [{ name: 'alon:wheelTag', value: tags.join(' ') }],
    }),
  );
}

// ---------- binaries ----------
const nodeV = execFileSync(path.join(REL, 'runtime', 'node.exe'), ['-v']).toString().trim().slice(1);
const ffLine = execFileSync(path.join(REL, 'runtime', 'ffmpeg.exe'), ['-version']).toString().split(/\r?\n/)[0];
const ffV = (/ffmpeg version (\S+)/.exec(ffLine) ?? [])[1] ?? 'unknown';
const nodeRef = add({ type: 'application', 'bom-ref': 'node.exe', name: 'Node.js', version: nodeV, supplier: { name: 'OpenJS Foundation' }, licenses: [{ license: { id: 'MIT' } }], purl: `pkg:generic/nodejs@${nodeV}`, hashes: bin('runtime/node.exe') });
const ffRef = add({ type: 'application', 'bom-ref': 'ffmpeg.exe', name: 'FFmpeg (ffmpeg.exe)', version: ffV, supplier: { name: 'gyan.dev (build) / FFmpeg project (source)' }, licenses: [{ license: { id: 'GPL-3.0-or-later' } }], purl: `pkg:generic/ffmpeg@${ffV}`, hashes: bin('runtime/ffmpeg.exe') });
const fpRef = add({ type: 'application', 'bom-ref': 'ffprobe.exe', name: 'FFmpeg (ffprobe.exe)', version: ffV, supplier: { name: 'gyan.dev (build) / FFmpeg project (source)' }, licenses: [{ license: { id: 'GPL-3.0-or-later' } }], purl: `pkg:generic/ffprobe@${ffV}`, hashes: bin('runtime/ffprobe.exe') });
const pyV = '3.12.10';
const pyRef = add({ type: 'application', 'bom-ref': 'python-embed', name: 'CPython embeddable package (amd64)', version: pyV, supplier: { name: 'Python Software Foundation' }, licenses: [{ license: { id: 'PSF-2.0' } }], purl: `pkg:generic/cpython@${pyV}?download_url=https://www.python.org/ftp/python/${pyV}/python-${pyV}-embed-amd64.zip`, hashes: bin('runtime/python/python.exe') });
const vcDlls = fs.existsSync(path.join(REL, 'runtime', 'python')) ? fs.readdirSync(path.join(REL, 'runtime', 'python')).filter((f) => /^(msvcp|vcruntime|concrt)\d/i.test(f)) : [];
const vc = vcDlls.map((f) => add({ type: 'library', 'bom-ref': `vc:${f}`, name: `Microsoft Visual C++ runtime ${f}`, supplier: { name: 'Microsoft Corporation' }, licenses: [{ license: { name: 'Microsoft Visual C++ Redistributable' } }], hashes: bin(`runtime/python/${f}`) }));
const models = Object.keys(MODEL_REV).map((size) =>
  add({
    type: 'machine-learning-model', 'bom-ref': `model:Systran/faster-whisper-${size}`, name: `Systran/faster-whisper-${size}`, version: MODEL_REV[size],
    licenses: [{ license: { id: 'MIT' } }],
    hashes: MODEL_SHA[size] ? [{ alg: 'SHA-256', content: MODEL_SHA[size] }] : undefined,
    externalReferences: [{ type: 'distribution', url: `https://huggingface.co/Systran/faster-whisper-${size}/tree/${MODEL_REV[size]}` }],
    properties: [{ name: 'alon:shipped', value: 'no - downloaded at first use, revision pinned, model.bin SHA-256 checked' }],
  }),
);
const own = ['app/server.mjs', 'server/transcribe.py', 'ALON Studio.cmd', ...files.map(rel).filter((r) => r.startsWith('dist/'))].map((r) => add({ type: 'file', 'bom-ref': `file:${r}`, name: r, version: VERSION, hashes: bin(r) }));

const bom = {
  bomFormat: 'CycloneDX', specVersion: '1.6', serialNumber: 'urn:uuid:' + crypto.randomUUID(), version: 1,
  metadata: {
    timestamp: new Date().toISOString(),
    tools: { components: [{ type: 'application', name: 'scripts/release-docs.mjs', version: VERSION }] },
    component: { type: 'application', 'bom-ref': 'alon-studio', name: 'ALON.ai Studio (portable Windows package)', version: VERSION, licenses: [{ expression: LICENSE }], properties: [{ name: 'alon:fileCount', value: String(files.length) }, { name: 'alon:fullManifest', value: 'SHA256SUMS.txt' }] },
  },
  components,
  dependencies: [
    { ref: 'alon-studio', dependsOn: [nodeRef, ffRef, fpRef, pyRef, ...vc, ...npmRefs, ...own] },
    { ref: pyRef, dependsOn: [...pyRefs, ...vc] },
    ...(pyRefs.some((r) => r.startsWith('pypi:faster_whisper@')) ? [{ ref: pyRefs.find((r) => r.startsWith('pypi:faster_whisper@')), dependsOn: models }] : []),
  ],
};
fs.writeFileSync(path.join(REL, 'sbom.cdx.json'), JSON.stringify(bom, null, 2));

// ---------- THIRD-PARTY-NOTICES.txt ----------
const HR = '\n' + '='.repeat(78) + '\n';
const o = [];
const p = (s = '') => o.push(s);
const section = (title, text) => {
  p(HR);
  p(title);
  p('-'.repeat(Math.min(78, title.length)));
  p(text);
};
p(`ALON.ai Studio ${VERSION} - THIRD-PARTY NOTICES`);
p('');
p('ALON.ai Studio is distributed together with the third-party components listed below. Each is');
p('licensed by its authors under the licence named here; those licences govern your use of it.');
p('Machine-readable list: sbom.cdx.json. File fingerprints: SHA256SUMS.txt.');
p(HR);
p('GPL-LICENSED COMPONENTS AND THEIR SOURCE CODE');
p('');
p(`runtime/ffmpeg.exe and runtime/ffprobe.exe: ${ffLine}`);
p('  Licensed under the GNU General Public License v3 or later (built with --enable-gpl --enable-version3).');
p('  Build information and the list of included libraries: https://www.gyan.dev/ffmpeg/builds/');
p('  FFmpeg source code: https://ffmpeg.org/download.html  (git: https://github.com/FFmpeg/FFmpeg)');
p('runtime/python/Lib/site-packages/av.libs/*.dll: FFmpeg libraries inside the PyAV wheel, GPL v3 or later.');
p('  Build scripts and sources: https://github.com/PyAV-Org/pyav-ffmpeg');
p('');
p(`ALON.ai Studio's own code is licensed under ${LICENSE} as well (LICENSE.txt). It runs ffmpeg.exe and`);
p('ffprobe.exe as separate programs. The GPL v3 text is below.');
p(HR);
p('COMPONENTS');
p('');
for (const c of components.filter((x) => x.type !== 'file')) {
  const lic = c.licenses?.[0]?.expression ?? c.licenses?.[0]?.license?.id ?? c.licenses?.[0]?.license?.name ?? 'see licence text below';
  p(`${c.name} ${c.version ?? ''}  |  ${lic}`);
}
section('GNU GENERAL PUBLIC LICENSE v3 (FFmpeg)', await get('https://www.gnu.org/licenses/gpl-3.0.txt'));
section(`Node.js ${nodeV} (runtime/node.exe) - MIT, with bundled third-party components`, await get(`https://raw.githubusercontent.com/nodejs/node/v${nodeV}/LICENSE`));
if (fs.existsSync(path.join(REL, 'runtime', 'python', 'LICENSE.txt'))) section(`Python ${pyV} (runtime/python)`, read(path.join(REL, 'runtime', 'python', 'LICENSE.txt')));
for (const d of fs.existsSync(SP) ? fs.readdirSync(SP).filter((x) => x.endsWith('.dist-info')).sort() : []) {
  const base = path.join(SP, d);
  const lics = walk(base).filter((f) => /^(LICEN[CS]E|COPYING|NOTICE|AUTHORS)/i.test(path.basename(f)) && !f.endsWith('.py'));
  const name = d.replace(/\.dist-info$/, '');
  let text = lics.map((f) => (lics.length > 1 ? `[${path.relative(base, f)}]\n` : '') + read(f)).join('\n\n');
  if (!text) {
    if (name.startsWith('ctranslate2-')) text = await get(`https://raw.githubusercontent.com/OpenNMT/CTranslate2/v${name.split('-')[1]}/LICENSE`);
    else if (name.startsWith('tokenizers-') || name.startsWith('flatbuffers-')) text = await get('https://www.apache.org/licenses/LICENSE-2.0.txt');
    else if (name.startsWith('onnxruntime-') && fs.existsSync(path.join(SP, 'onnxruntime', 'LICENSE'))) text = read(path.join(SP, 'onnxruntime', 'LICENSE'));
    else text = '[no licence file in the wheel; see the package page on pypi.org]';
  }
  section(`Python package ${name}`, text);
}
section('Binary components inside the ctranslate2 wheel', [
  'ctranslate2.dll statically links Intel oneMKL and oneDNN; libiomp5md.dll is the Intel OpenMP runtime',
  '(Intel Simplified Software License; oneDNN: Apache-2.0). cudnn64_8.dll is the NVIDIA cuDNN 8 dispatcher',
  '(NVIDIA cuDNN Software License Agreement); it is used only on PCs with an NVIDIA GPU and CUDA installed.',
  'ONNX Runtime third-party notices: runtime/python/Lib/site-packages/onnxruntime/ThirdPartyNotices.txt',
].join('\n'));
section('Microsoft Visual C++ runtime (' + vcDlls.join(', ') + ')', 'Copyright (c) Microsoft Corporation. Redistributed under the Microsoft Visual C++ Redistributable terms.');
section('OpenAI Whisper model weights (downloaded at first use, not shipped)', await get('https://raw.githubusercontent.com/openai/whisper/main/LICENSE'));
const seen = new Set();
for (const c of components.filter((x) => x['bom-ref'].startsWith('npm:'))) {
  const lp = c.properties.find((x) => x.name === 'alon:lockfilePath').value;
  const dir = path.join(ROOT, lp);
  const lf = fs.existsSync(dir) ? fs.readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.|$)/i.test(f)) : null;
  const key = `${c.name}@${c.version}`;
  if (seen.has(key)) continue;
  seen.add(key);
  section(`npm package ${key} (${c.properties.find((x) => x.name === 'alon:bundledInto').value})`, lf ? read(path.join(dir, lf)) : `[licence: ${c.licenses?.[0]?.expression ?? 'see the package page on npmjs.com'}]`);
}
fs.writeFileSync(path.join(REL, 'THIRD-PARTY-NOTICES.txt'), o.join('\n').replace(/\n/g, '\r\n'));

console.log(`sbom.cdx.json: ${components.length} components (npm ${npmRefs.length}, Python ${pyRefs.length}, models ${models.length})`);
console.log(`THIRD-PARTY-NOTICES.txt: ${o.length} blocks`);
console.log(`SHA256SUMS.txt: ${files.length} files`);
const missing = components.filter((c) => c['bom-ref'].startsWith('pypi:') && !c.hashes).map((c) => c.name);
if (missing.length) console.log('no PyPI wheel hash for: ' + missing.join(', '));
