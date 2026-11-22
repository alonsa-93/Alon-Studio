/**
 * Content libraries end to end: sound effects, text and caption styles, title font, fonts
 * (upload TTF / WOFF / WOFF2, Google Fonts through a local mock, the export really uses them),
 * API keys, stock search and import with licence (local mock) and import from a link (SSRF rules).
 *   npx tsx scripts/e2e-library.ts          (also run at the end of e2e-features.ts)
 * Needs the test instance (scripts/test-server.mjs), which points the outside services at port 5191.
 */
import './auth.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { CAPTION_PRESETS, TEXT_PRESETS } from '../shared/types';
import { startMock } from './mock-providers';

const BASE = process.env.BASE_URL ?? 'http://localhost:5182';
const FF = process.env.FFMPEG_PATH ?? 'ffmpeg';
const ROOT = path.resolve(import.meta.dirname, '..');
const FONTS = path.join(ROOT, 'node_modules', '@fontsource', 'assistant', 'files');

async function api(url: string, init?: RequestInit) {
  const res = await fetch(BASE + url, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(`${url}: ${data.error}`), { status: res.status });
  return data;
}
const post = (url: string, body: unknown) => api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const put = (url: string, body: unknown) => api(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const ops = (id: string, o: unknown) => post(`/api/projects/${id}/ops?full=1`, { ops: Array.isArray(o) ? o : [o] });
const check = (ok: unknown, msg: string) => {
  if (!ok) throw new Error('FAILED: ' + msg);
  console.log('  ok  ' + msg);
};
const status = async (p: Promise<unknown>) => {
  try {
    await p;
    return 200;
  } catch (e) {
    return (e as { status?: number }).status ?? 0;
  }
};
async function waitJob(jobId: string) {
  for (;;) {
    const job = await api(`/api/jobs/${jobId}`);
    if (job.status !== 'running') return job;
    await new Promise((r) => setTimeout(r, 300));
  }
}
const uploadFonts = async (files: { name: string; body: Buffer }[]) => {
  const fd = new FormData();
  for (const f of files) fd.append('files', new Blob([new Uint8Array(f.body)]), f.name);
  return api('/api/fonts', { method: 'POST', body: fd });
};
const exportFrame = async (id: string, out: string) => {
  const job = await waitJob((await post(`/api/projects/${id}/export`, { quality: 'low' })).jobId);
  if (job.status !== 'done') throw new Error(`export failed: ${job.error}`);
  execFileSync(FF, ['-y', '-v', 'error', '-ss', '1', '-i', job.file, '-frames:v', '1', out]);
  return out;
};
/** PSNR in dB between two pictures (inf when identical -> 99). */
function compare(a: string, b: string): number {
  const r = spawnSync(FF, ['-hide_banner', '-i', a, '-i', b, '-lavfi', 'psnr', '-f', 'null', '-'], { encoding: 'utf8' });
  const m = /average:(inf|[\d.]+)/.exec(r.stderr);
  return !m ? 0 : m[1] === 'inf' ? 99 : Number(m[1]);
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'alon-library-'));
const clip = path.join(work, 'clip.mp4');
const pic = path.join(work, 'pic.png');
const tune = path.join(work, 'tune.mp3');
execFileSync(FF, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:d=2:r=30', '-f', 'lavfi', '-i', 'sine=f=440:d=2', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', clip]);
execFileSync(FF, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x3366cc:s=320x180', '-frames:v', '1', pic]);
execFileSync(FF, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=f=660:d=3', '-c:a', 'libmp3lame', tune]);
const mock = await startMock(5191, {
  'clip.mp4': { type: 'video/mp4', body: fs.readFileSync(clip) },
  'pic.png': { type: 'image/png', body: fs.readFileSync(pic) },
  'tune.mp3': { type: 'audio/mpeg', body: fs.readFileSync(tune) },
});
const created: string[] = [];
try {
  // ---------- sound effects ----------
  const sfx = (await api('/api/library/sfx')) as { id: string; group: string; name: string; duration: number; url: string }[];
  const groups = ['motion', 'impact', 'ui', 'tones'];
  check(sfx.length >= 30 && groups.every((g) => sfx.filter((x) => x.group === g).length >= 5), `${sfx.length} sound effects in 4 groups (${groups.map((g) => sfx.filter((x) => x.group === g).length).join('/')})`);
  for (const want of ['whoosh', 'swish', 'riser', 'tape-stop', 'impact', 'boom', 'sub-drop', 'thud', 'click', 'typing', 'shutter', 'notify', 'chime', 'coin', 'sparkle'])
    if (!sfx.some((x) => x.id === want)) check(false, `sound effect ${want} exists`);
  check(true, 'every effect the guide names exists');
  let quiet = 0;
  for (const fx of sfx) {
    const wav = Buffer.from(await (await fetch(BASE + fx.url)).arrayBuffer());
    const f = path.join(work, `${fx.id}.wav`);
    fs.writeFileSync(f, wav);
    const r = spawnSync(FF, ['-hide_banner', '-i', f, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' }).stderr as string;
    const peak = Number(/max_volume: ([-\d.]+)/.exec(r)?.[1] ?? -99);
    const dur = Number(/Duration: 00:00:([\d.]+)/.exec(r)?.[1] ?? 0);
    if (peak < -20 || peak > 0 || Math.abs(dur - fx.duration) > 0.05) {
      quiet++;
      console.log(`  !!  ${fx.id}: peak ${peak} dB, ${dur}s (want ${fx.duration}s)`);
    }
  }
  check(quiet === 0, 'every effect is audible (peak between -20 and 0 dB) and as long as listed');

  // ---------- presets and title font ----------
  const p = await post('/api/projects', { name: 'ספריות תוכן' });
  created.push(p.id);
  const id = p.id as string;
  check(TEXT_PRESETS.length >= 9 && ['lower-third', 'kicker', 'cta', 'display'].every((x) => TEXT_PRESETS.some((t) => t.id === x)), `${TEXT_PRESETS.length} text styles incl. lower-third, kicker, CTA, display title`);
  check(CAPTION_PRESETS.length >= 9, `${CAPTION_PRESETS.length} caption styles`);
  let st = await ops(id, { op: 'add_text', text: 'שם · תפקיד', preset: 'lower-third', start: 0, duration: 2, id: 'T1' });
  const t1 = st.project.clips.find((c: { id: string }) => c.id === 'T1');
  check(t1.style.bg === '#141414' && t1.style.x === 0.66 && t1.style.size === 52, 'add_text with a preset gets its style');
  st = await ops(id, { op: 'add_text', text: 'CTA', preset: 'cta', style: { color: '#000000' }, id: 'T2' });
  check(st.project.clips.find((c: { id: string }) => c.id === 'T2').style.color === '#000000', 'fields given with a preset override it');
  check((await status(ops(id, { op: 'add_text', text: 'x', preset: 'nope' }))) === 400, 'an unknown text preset is refused');
  st = await ops(id, { op: 'set_caption_style', preset: 'neon' });
  check(st.project.captionStyle.color === '#7df9ff' && st.project.captionStyle.highlight === '#ff3df5', 'caption preset applied');
  check((await status(ops(id, { op: 'set_caption_style', preset: 'nope' }))) === 400 && (await status(ops(id, { op: 'set_caption_style' }))) === 400, 'unknown caption preset / nothing to set is refused');
  st = await ops(id, { op: 'set_title_font', font: 'Tahoma' });
  st = await ops(id, { op: 'add_text', text: 'כותרת', id: 'T3' });
  check(st.project.titleFont === 'Tahoma' && st.project.clips.find((c: { id: string }) => c.id === 'T3').style.font === 'Tahoma', 'new titles get the title font');
  st = await ops(id, { op: 'add_text', text: 'ציטוט', preset: 'quote', id: 'T4' });
  check(st.project.clips.find((c: { id: string }) => c.id === 'T4').style.font === 'Times New Roman', 'a preset that names a font keeps it');
  check((await status(ops(id, { op: 'set_title_font', font: '../x' }))) === 400, 'a bad title font name is refused');
  st = await ops(id, { op: 'set_title_font', font: null });
  check(st.project.titleFont === undefined, 'title font back to the default');

  // ---------- fonts: upload, convert, export uses them ----------
  for (const f of (await api('/api/fonts')) as { family: string }[]) if (['Assistant', 'Assistant ExtraLight'].includes(f.family)) await api(`/api/fonts/${encodeURIComponent(f.family)}`, { method: 'DELETE' });
  const fp = await post('/api/projects', { name: 'פונטים' });
  created.push(fp.id);
  await ops(fp.id, [
    { op: 'set_aspect', aspect: '16:9' },
    { op: 'add_text', text: 'Hamburg 2468', start: 0, duration: 2, style: { font: 'Assistant', size: 150, bold: true, color: '#ffffff', y: 0.5 } },
  ]);
  const before = await exportFrame(fp.id, path.join(work, 'font-before.png'));
  const up = await uploadFonts([
    { name: 'assistant-latin-700-normal.woff', body: fs.readFileSync(path.join(FONTS, 'assistant-latin-700-normal.woff')) },
    { name: 'assistant-hebrew-700-normal.woff2', body: fs.readFileSync(path.join(FONTS, 'assistant-hebrew-700-normal.woff2')) },
    { name: 'notes.txt', body: Buffer.from('this is not a font') },
  ]);
  check(up.added.length === 2 && up.errors.length === 1, `WOFF and WOFF2 uploaded, a text file refused (${up.errors[0]?.slice(0, 50)})`);
  const fams = (await api('/api/fonts')) as { family: string; faces: { weight: number; url: string }[] }[];
  const asst = fams.find((f) => f.family === 'Assistant');
  check(asst && asst.faces[0].weight === 700 && fams.some((f) => f.family === 'Assistant ExtraLight'), 'families read from the font files, with weight');
  const ttf = Buffer.from(await (await fetch(BASE + asst!.faces[0].url)).arrayBuffer());
  check(ttf.readUInt32BE(0) === 0x00010000, 'stored as TrueType (what libass reads)');
  const after = await exportFrame(fp.id, path.join(work, 'font-after.png'));
  const changed = compare(before, after);
  check(changed < 30, `the export uses the uploaded font (PSNR to the fallback ${changed.toFixed(1)} dB)`);
  await api(`/api/fonts/Assistant`, { method: 'DELETE' });
  const gone = await exportFrame(fp.id, path.join(work, 'font-gone.png'));
  check(compare(before, gone) > 45, 'after deleting the font the export falls back again');
  // TTF upload of the converted file works as well
  const again = await uploadFonts([{ name: 'assistant.ttf', body: ttf }]);
  check(again.added[0]?.family === 'Assistant', 'a TTF upload works');
  await api(`/api/fonts/Assistant`, { method: 'DELETE' });
  await api(`/api/fonts/${encodeURIComponent('Assistant ExtraLight')}`, { method: 'DELETE' });
  check((await status(api('/api/fonts/Arial', { method: 'DELETE' }))) === 404, 'deleting a font that was not added: 404');

  // ---------- Google Fonts (local mock) ----------
  const g = await post('/api/fonts/google', { family: 'Mock Sans' });
  check(g.family === 'Assistant' && g.faces === 2, `Google family downloaded: regular and bold, the face on another host ignored (${g.faces} faces)`);
  check(mock.hits.some((h) => h.startsWith('GET /css2?family=Mock+Sans:wght@400;700')), 'asked Google Fonts for regular and bold');
  check((await status(post('/api/fonts/google', { family: 'No Such Family' }))) === 404, 'an unknown Google family: 404');
  check((await status(post('/api/fonts/google', { family: 'Bad/../name' }))) === 400, 'a bad Google family name: 400');
  await api(`/api/fonts/Assistant`, { method: 'DELETE' });

  // ---------- API keys ----------
  for (const k of ['pexels', 'pixabay']) await api(`/api/keys/${k}`, { method: 'DELETE' });
  const ks = (await api('/api/keys')) as { provider: string; hasKey: boolean }[];
  check(ks.some((k) => k.provider === 'pexels') && ks.every((k) => !k.hasKey), 'keys listed, none set');
  const saved = await put('/api/keys/pexels', { key: 'test-pexels-key-1234' });
  check(saved.hasKey && saved.last4 === '1234' && !JSON.stringify(saved).includes('test-pexels'), 'a saved key comes back as last 4 characters only');
  await put('/api/keys/pixabay', { key: 'test-pixabay-key-5678' });
  check(!JSON.stringify(await api('/api/keys')).includes('test-pix'), 'the key list never contains a key');
  check((await status(put('/api/keys/pexels', { key: 'short' }))) === 400 && (await status(put('/api/keys/nothing', { key: 'abcdefghijk' }))) === 404, 'bad key or provider refused');
  const keyFile = path.join(process.env.ALON_DATA_DIR ?? path.join(os.tmpdir(), 'alon-test-data'), 'api-keys.json');
  if (process.platform === 'win32') {
    const acl = execFileSync('icacls', [keyFile], { encoding: 'utf8' });
    check(!/Everyone|BUILTIN\\Users|Authenticated Users/i.test(acl) && acl.includes(process.env.USERNAME ?? '?'), 'the key file is readable by this Windows account only');
  }

  // ---------- stock ----------
  const provs = (await api('/api/stock/providers')) as { id: string; hasKey: boolean }[];
  check(provs.length === 3 && provs.every((x) => x.hasKey), 'three stock providers, all usable');
  const ov = await api('/api/stock/search?provider=openverse&kind=image&q=mock');
  check(ov.items.length === 1 && ov.items[0].credit.license === 'CC BY-SA 4.0' && ov.items[0].credit.author === 'Mock Photographer', 'Openverse search with licence and author');
  check(mock.hits.some((h) => h.includes('license_type=commercial,modification')), 'Openverse asked only for licences that allow commercial use and changes');
  const thumb = await fetch(BASE + ov.items[0].thumb);
  check(thumb.ok && (thumb.headers.get('content-type') ?? '').startsWith('image/'), 'thumbnail served by the app (the page loads pictures from itself only)');
  const pxv = await api('/api/stock/search?provider=pexels&kind=video&q=mock');
  check(pxv.items[0]?.credit.provider === 'Pexels' && mock.hits.some((h) => h.includes('auth:test-pexels')), 'Pexels video search with the saved key');
  const pbi = await api('/api/stock/search?provider=pixabay&kind=image&q=mock');
  check(pbi.items[0]?.credit.license === 'Pixabay Content License', 'Pixabay picture search');
  check((await status(api('/api/stock/search?provider=openverse&kind=video&q=x'))) === 400 && (await status(api('/api/stock/search?provider=nope&kind=image&q=x'))) === 400, 'unknown provider / kind refused');
  const imp = await waitJob((await post(`/api/projects/${id}/media/stock`, { id: pxv.items[0].id })).jobId);
  check(imp.status === 'done' && imp.mediaId, `stock video imported as a background job (${imp.error ?? 'ok'})`);
  let proj = await api(`/api/projects/${id}`);
  const asset = proj.media.find((m: { id: string }) => m.id === imp.mediaId);
  check(asset.kind === 'video' && asset.credit.author === 'Mock Filmer' && asset.credit.licenseUrl === 'https://www.pexels.com/license/', 'the asset keeps licence and credit');
  const au = await waitJob((await post(`/api/projects/${id}/media/stock`, { id: (await api('/api/stock/search?provider=openverse&kind=audio&q=mock')).items[0].id })).jobId);
  check(au.status === 'done', 'Openverse audio imported');
  await ops(id, { op: 'add_clip', mediaId: imp.mediaId, start: 0 });
  const cr = await api(`/api/projects/${id}/credits`);
  check(cr.items.length === 2 && cr.text.includes('Mock Filmer') && !cr.text.includes('Mock Artist'), 'credits list: every stock file; the text only those in the video');
  check((await status(post(`/api/projects/${id}/media/stock`, { id: 'pexels:video:999' }))) === 404, 'a stock id that was not found in a search: 404');
  // undo of a removal brings the credit back (sanitizeState keeps it)
  const snap = await api(`/api/projects/${id}`);
  await ops(id, { op: 'remove_media', mediaId: imp.mediaId });
  await put(`/api/projects/${id}`, snap);
  proj = await api(`/api/projects/${id}`);
  check(proj.media.find((m: { id: string }) => m.id === imp.mediaId)?.credit?.author === 'Mock Filmer', 'undo of a removal keeps the credit');

  // ---------- import from a link ----------
  const local = await post(`/api/projects/${id}/media/url`, { url: `${mock.base}/files/clip.mp4` });
  const lj = await waitJob(local.jobId);
  check(lj.status === 'error' && /נחסם/.test(lj.error), `a link to this computer is blocked (${lj.error})`);
  for (const bad of ['file:///C:/Windows/win.ini', 'ftp://example.com/a.mp4', 'javascript:alert(1)', 'http://user:pw@example.com/a.mp4'.replace('http', 'xhttp')])
    if ((await status(post(`/api/projects/${id}/media/url`, { url: bad }))) !== 400) check(false, `refused: ${bad}`);
  check(true, 'only http and https links are accepted');
  for (const bad of ['http://localhost:5191/files/clip.mp4', 'http://[::1]:5191/x', 'http://169.254.169.254/latest/meta-data/', 'http://10.0.0.1/a.mp4', 'http://user:pw@example.com/a.mp4']) {
    const j = await waitJob((await post(`/api/projects/${id}/media/url`, { url: bad })).jobId);
    if (j.status !== 'error' || !/נחסם/.test(j.error)) check(false, `blocked: ${bad} (${j.status} ${j.error})`);
  }
  check(true, 'localhost, ::1, cloud metadata, private ranges and links with a password are blocked');

  // ---------- the downloader itself (in this process, with a policy that trusts the mock) ----------
  const { isBlockedAddress, safeDownload } = await import('../server/netguard');
  const blocked = ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '::1', '::', 'fe80::1', 'fc00::1', 'fd12::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '64:ff9b::a00:1', '2002:c0a8:101::1', 'ff02::1', 'not-an-ip'];
  const open = ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700::1111', '2a00:1450:4001::200e'];
  check(blocked.every(isBlockedAddress) && !open.some(isBlockedAddress), `address rules: ${blocked.length} private / special blocked, ${open.length} public allowed`);
  const trustMock = { lookup: async (h: string) => (h === 'rebind.test' ? [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.5', family: 4 }] : [{ address: '127.0.0.1', family: 4 }]), trusted: (u: URL) => u.host === '127.0.0.1:5191' };
  const dl = path.join(work, 'dl.bin');
  const okDl = await safeDownload(`${mock.base}/files/clip.mp4`, dl, { maxBytes: 1e8, timeoutMs: 10000, accept: () => true, policy: trustMock });
  check(okDl.bytes === fs.statSync(clip).size && fs.readFileSync(dl).equals(fs.readFileSync(clip)), 'download through the checked address, byte for byte');
  const err = async (p: Promise<unknown>) => p.then(() => 'accepted', (e: Error & { status?: number }) => `${e.status} ${e.message}`);
  check(/^400 .*נחסם/.test(await err(safeDownload(`${mock.base}/redirect?to=http://169.254.169.254/latest/`, dl, { maxBytes: 1e8, timeoutMs: 10000, accept: () => true, policy: trustMock }))), 'a redirect to a private address is checked again and blocked');
  check(/^400 .*נחסם/.test(await err(safeDownload('http://rebind.test/x.mp4', dl, { maxBytes: 1e8, timeoutMs: 10000, accept: () => true, policy: trustMock }))), 'a name with one private address among public ones is blocked');
  check(/^413/.test(await err(safeDownload(`${mock.base}/files/clip.mp4`, dl, { maxBytes: 1000, timeoutMs: 10000, accept: () => true, policy: trustMock }))), 'size limit');
  const { MEDIA_TYPES } = await import('../server/netguard');
  check(/^415/.test(await err(safeDownload(`${mock.base}/page.html`, dl, { maxBytes: 1e8, timeoutMs: 10000, accept: MEDIA_TYPES, policy: trustMock }))), 'only media content types');

  // ---------- MCP ----------
  const mcp = async (method: string, params: unknown) => {
    const res = await fetch(BASE + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    const body = await res.text();
    return JSON.parse(/data: (.*)/.exec(body)?.[1] ?? body);
  };
  const tools = JSON.stringify((await mcp('tools/list', {})).result.tools);
  check(['set_caption_style', 'set_title_font', 'search_stock', 'import_stock', 'import_url', 'list_fonts', 'add_google_font'].every((t) => tools.includes(`"${t}"`)) && tools.includes('lower-third'), 'MCP lists the library tools and the text presets');
  const call = async (name: string, args: unknown) => {
    const d = await mcp('tools/call', { name, arguments: args });
    return { error: !!d.result?.isError, text: d.result.content[0].text as string };
  };
  const ms = await call('search_stock', { provider: 'pixabay', kind: 'video', query: 'mock' });
  const mid = JSON.parse(ms.text).items[0].id;
  const mi = await call('import_stock', { projectId: id, id: mid });
  check(!mi.error && JSON.parse(mi.text).media.credit.provider === 'Pixabay', 'MCP search_stock + import_stock');
  const mu = await call('import_url', { projectId: id, url: 'http://127.0.0.1:9/x.mp4' });
  check(mu.error && /נחסם/.test(mu.text), 'MCP import_url keeps the SSRF rule');
  const mt = await call('add_text', { projectId: id, text: 'MCP', preset: 'kicker' });
  check(!mt.error, 'MCP add_text with a preset');
  const mc = await call('set_caption_style', { projectId: id, preset: 'marker' });
  check(!mc.error, 'MCP set_caption_style with a preset');

  for (const k of ['pexels', 'pixabay']) await api(`/api/keys/${k}`, { method: 'DELETE' });
  console.log('\nCONTENT LIBRARIES: ALL GOOD');
} finally {
  for (const pid of created) await api(`/api/projects/${pid}`, { method: 'DELETE' }).catch(() => {});
  await mock.close();
  fs.rmSync(work, { recursive: true, force: true });
}
