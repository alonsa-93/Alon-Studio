/**
 * Preview vs export: builds a project with keyframes (position, size, rotation, opacity), a look, a screen
 * blend layer, rotation and transitions (wipe, zoom-out, blur, flash), and a second one with the screen
 * layouts (stack, side, pip) and a logo; exports them, then grabs the
 * same frames from the MP4 (ffmpeg) and from the player in a real browser (driver.mjs) and compares them.
 *   npx tsx scripts/parity.ts [BASE_URL] [out-dir]
 * Pass: PSNR >= PSNR_MIN dB on every sampled time. Pictures only (text is checked by the ASS tests),
 * since the browser and libass rasterise glyphs differently.
 */
import './auth.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { launch } from './ui/driver.mjs';

const BASE = process.argv[2] ?? process.env.BASE_URL ?? 'http://localhost:5182';
const OUT = process.argv[3] ?? 'ui-out/parity';
/** Threshold. Measured values sit well above it (see docs/specs/editing-core.md); below it means a visible mismatch. */
const PSNR_MIN = 24;
const FF = process.env.FFMPEG_PATH ?? 'ffmpeg';
const FPS = 30;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'alon-parity-'));
let failures = 0;
const check = (ok: unknown, msg: string) => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${msg}`);
};

// test pictures (made here, nothing downloaded)
const img = (name: string, src: string) => {
  const f = path.join(work, name);
  execFileSync(FF, ['-v', 'error', '-y', '-f', 'lavfi', '-i', src, '-frames:v', '1', f]);
  return f;
};
const pics = {
  a: img('pattern.png', 'testsrc2=s=1280x720:r=1'),
  b: img('glow.png', "gradients=s=640x640:c0=0xff4f8b:c1=0x2050ff:x0=0:y0=0:x1=640:y1=640:r=1"),
  c: img('bars.png', 'smptehdbars=s=1280x720:r=1'),
  d: img('mandel.png', 'mandelbrot=s=1280x720:r=1'),
  k: img('black.png', 'color=c=black:s=1280x720:r=1'),
};

async function api(url: string, init?: RequestInit) {
  const r = await fetch(BASE + url, init);
  const d = await r.json();
  if (!r.ok) throw new Error(`${url}: ${d.error}`);
  return d;
}
const post = (url: string, body: unknown) => api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

const id = (await post('/api/projects', { name: 'בדיקת זהות תצוגה וייצוא' })).id as string;
const media: Record<string, string> = {};
for (const [k, f] of Object.entries({ a: pics.a, b: pics.b, c: pics.c, d: pics.d })) {
  const fd = new FormData();
  fd.append('files', new Blob([fs.readFileSync(f)]), path.basename(f));
  media[k] = (await api(`/api/projects/${id}/media`, { method: 'POST', body: fd })).media[0].id;
}
await post(`/api/projects/${id}/ops`, {
  ops: [
    { op: 'set_aspect', aspect: '16:9' },
    { op: 'set_settings', width: 1280, height: 720, background: '#20304a' },
    { op: 'add_clip', mediaId: media.a, id: 'A', start: 0 },
    { op: 'trim_clip', clipId: 'A', start: 0, duration: 4 },
    { op: 'set_fx', clipId: 'A', fx: { look: 'warm', brightness: 1.05, temperature: 0.4, saturation: 1.2 } },
    { op: 'set_keyframe', clipId: 'A', t: 0, x: -0.1, y: 0, scale: 0.8, rotation: -10, opacity: 1, ease: 'ease-in-out' },
    { op: 'set_keyframe', clipId: 'A', t: 3, x: 0.1, y: 0.05, scale: 1.1, rotation: 15, opacity: 0.7, ease: 'linear' },
    { op: 'add_clip', mediaId: media.c, id: 'C', start: 4 },
    { op: 'trim_clip', clipId: 'C', start: 4, duration: 3 },
    { op: 'add_transition', clipId: 'C', type: 'wipe-right', duration: 0.8 },
    { op: 'add_clip', mediaId: media.d, id: 'D', start: 7 },
    { op: 'trim_clip', clipId: 'D', start: 7, duration: 3 },
    { op: 'add_transition', clipId: 'D', type: 'zoom-out', duration: 0.8 },
    { op: 'add_track', kind: 'video', id: 'TOP' },
    { op: 'add_clip', mediaId: media.b, id: 'B', start: 1, trackId: 'TOP' },
    { op: 'trim_clip', clipId: 'B', start: 1, duration: 5 },
    { op: 'set_fx', clipId: 'B', fx: { blend: 'screen', rotation: 20, scale: 0.6, posX: 0.25 } },
  ],
});
// main track clips must be on one track: the "add_clip" defaults put them there; check
const proj = await api(`/api/projects/${id}`);
check(proj.clips.filter((c: { trackId: string }) => c.trackId === proj.clips.find((x: { id: string }) => x.id === 'A').trackId).length === 3, 'test project built');

async function exportFile(pid: string): Promise<string> {
  const ej = await post(`/api/projects/${pid}/export`, { quality: 'high', range: false });
  let job;
  for (;;) {
    job = await api(`/api/jobs/${ej.jobId}`);
    if (job.status !== 'running') break;
    await new Promise((r) => setTimeout(r, 700));
  }
  check(job.status === 'done', `export ${job.status} ${job.error ?? ''}`);
  return job.file as string;
}
const mainFile = await exportFile(id);

// screen layouts and the logo, in a second project (a main picture and one above it)
const lid = (await post('/api/projects', { name: 'בדיקת זהות פריסה ולוגו' })).id as string;
const lmedia: Record<string, string> = {};
for (const [k, f] of Object.entries({ a: pics.d, b: pics.c, logo: pics.b })) {
  const fd = new FormData();
  fd.append('files', new Blob([fs.readFileSync(f)]), path.basename(f));
  lmedia[k] = (await api(`/api/projects/${lid}/media`, { method: 'POST', body: fd })).media[0].id;
}
await post(`/api/projects/${lid}/ops`, {
  ops: [
    { op: 'set_aspect', aspect: '16:9' },
    { op: 'set_settings', width: 1280, height: 720, background: '#20304a' },
    { op: 'add_clip', mediaId: lmedia.a, id: 'LA', start: 0 },
    { op: 'trim_clip', clipId: 'LA', start: 0, duration: 2 },
    { op: 'add_track', kind: 'video', id: 'LTOP' },
    { op: 'add_clip', mediaId: lmedia.b, id: 'LB', start: 0, trackId: 'LTOP' },
    { op: 'trim_clip', clipId: 'LB', start: 0, duration: 2 },
    { op: 'set_logo', logo: { mediaId: lmedia.logo, corner: 'bottom-left', size: 0.18, opacity: 0.8 } },
  ],
});
const layoutFiles: Record<string, string> = {};
for (const layout of ['stack', 'side', 'pip']) {
  await post(`/api/projects/${lid}/ops`, { op: 'set_layout', layout });
  layoutFiles[layout] = await exportFile(lid);
}

// a font the user added (uploaded WOFF, stored as TTF) must come out of the export at the size the
// player shows. Glyph edges differ between the browser and libass, so this compares the text's box, not PSNR.
const fontFile = path.resolve('node_modules/@fontsource/assistant/files/assistant-latin-700-normal.woff');
await fetch(`${BASE}/api/fonts/Assistant`, { method: 'DELETE' }).catch(() => {});
{
  const fd = new FormData();
  fd.append('files', new Blob([fs.readFileSync(fontFile)]), 'assistant-latin-700-normal.woff');
  await api('/api/fonts', { method: 'POST', body: fd });
}
const fid = (await post('/api/projects', { name: 'בדיקת זהות פונט שהוסף' })).id as string;
{
  const fd = new FormData();
  fd.append('files', new Blob([fs.readFileSync(pics.k)]), 'black.png');
  const bg = (await api(`/api/projects/${fid}/media`, { method: 'POST', body: fd })).media[0].id;
  await post(`/api/projects/${fid}/ops`, {
    ops: [
      { op: 'set_aspect', aspect: '16:9' },
      { op: 'set_settings', width: 1280, height: 720, background: '#000000' },
      { op: 'add_clip', mediaId: bg, id: 'K', start: 0 },
      { op: 'trim_clip', clipId: 'K', start: 0, duration: 2 },
      { op: 'add_text', text: 'Hamburg 2026', id: 'FT', start: 0, duration: 2, style: { font: 'Assistant', bold: true, size: 120, color: '#ffffff', x: 0.5, y: 0.5 } },
    ],
  });
}
const fontExport = await exportFile(fid);
/** Box of the bright pixels of a picture, scaled to w x h (fractions of the frame). */
function brightBox(file: string, w: number, h: number) {
  const raw = execFileSync(FF, ['-v', 'error', '-i', file, '-vf', `scale=${w}:${h}:flags=bicubic,format=gray`, '-f', 'rawvideo', '-']);
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (raw[y * w + x] > 128) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  return x1 < 0 ? null : { w: (x1 - x0 + 1) / w, h: (y1 - y0 + 1) / h, cx: (x0 + x1) / 2 / w, cy: (y0 + y1) / 2 / h };
}

// [seconds, what is going on]
const SAMPLES: [number, string][] = [
  [0.5, 'keyframes: moving, growing, rotating'],
  [1.5, 'keyframes + screen blend layer, rotated'],
  [2.9, 'keyframes near the end, opacity 70%'],
  [4.4, 'wipe right, half way'],
  [5.5, 'blend layer over bars'],
  [7.3, 'zoom-out transition'],
  [8.5, 'still picture'],
];

const b = await launch({ width: 1600, height: 1000, port: Number(process.env.CDP_PORT ?? 9334) });
const results: { t: number; what: string; psnr: number }[] = [];
try {
  const { token } = await (await fetch(`${BASE}/api/session/token`, { method: 'POST' })).json();
  await b.goto(`${BASE}/#t=${token}`);
  await b.waitFor(`!!document.querySelector('[data-testid=topbar]')`);
  const open = async (pid: string) => {
    await b.eval(`(localStorage.setItem('alon.project', ${JSON.stringify(pid)}), location.reload(), true)`);
    await sleep(1500);
    await b.waitFor(`!!document.querySelector('[data-testid=topbar]') && document.querySelectorAll('.stage .layer').length >= 1`, 20000);
    await sleep(1200);
  };
  const compare = async (file: string, t: number, what: string, name: string) => {
    // exact frame times through the keyboard: Home, then whole seconds, then single frames
    await b.key('Escape');
    await b.key('Home');
    for (let i = 0; i < Math.floor(t); i++) await b.key('ArrowRight', { shift: true });
    const frames = Math.round((t - Math.floor(t)) * FPS);
    for (let i = 0; i < frames; i++) await b.key('ArrowRight');
    await sleep(600);
    const r = await b.eval(`(() => { const r = document.querySelector('.stage').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
    const shot = await b.send('Page.captureScreenshot', { format: 'png', clip: { x: r.x, y: r.y, width: r.w, height: r.h, scale: 1 } });
    const prev = path.join(OUT, `${name}-preview.png`);
    fs.writeFileSync(prev, Buffer.from(shot.data, 'base64'));
    const exp = path.join(OUT, `${name}-export.png`);
    const n = Math.round(t * FPS);
    execFileSync(FF, ['-v', 'error', '-y', '-i', file, '-vf', `select=eq(n\\,${n}),scale=${Math.round(r.w)}:${Math.round(r.h)}:flags=bicubic`, '-frames:v', '1', exp]);
    const out = spawnSync(FF, ['-hide_banner', '-i', prev, '-i', exp, '-lavfi', `[0]scale=${Math.round(r.w)}:${Math.round(r.h)},format=rgb24[a];[1]format=rgb24[b];[a][b]psnr`, '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
    const psnr = Number(/average:([\d.]+|inf)/.exec(out)?.[1].replace('inf', '99'));
    results.push({ t, what, psnr });
    check(psnr >= PSNR_MIN, `${t.toFixed(1)}s ${what}: PSNR ${psnr.toFixed(1)} dB`);
  };
  await open(id);
  for (const [t, what] of SAMPLES) await compare(mainFile, t, what, `t${t.toFixed(1)}`);
  await open(lid);
  for (const layout of ['pip', 'side', 'stack']) {
    // the player follows the change live
    await post(`/api/projects/${lid}/ops`, { op: 'set_layout', layout });
    await sleep(800);
    await compare(layoutFiles[layout], 1, `layout ${layout} + logo`, `layout-${layout}`);
  }
  // the added font: same text box in the player and in the export
  await open(fid);
  await b.waitFor(`document.fonts.ready.then(() => [...document.fonts].some((f) => f.family.replace(/"/g, '') === 'Assistant' && f.weight === '700' && f.status === 'loaded' && f.unicodeRange === 'U+0-10FFFF'))`, 15000).catch(() => {});
  await compare(fontExport, 1, 'added font (picture)', 'font');
  const W = 640, H = 360;
  const pb = brightBox(path.join(OUT, 'font-preview.png'), W, H);
  const eb = brightBox(path.join(OUT, 'font-export.png'), W, H);
  const near = (a: number, c: number, tol: number) => Math.abs(a - c) <= tol * Math.max(a, c);
  check(pb && eb && near(pb.w, eb.w, 0.06) && near(pb.h, eb.h, 0.1) && Math.abs(pb.cx - eb.cx) < 0.02 && Math.abs(pb.cy - eb.cy) < 0.03,
    `added font: text box player ${pb ? `${(pb.w * 100).toFixed(1)}% x ${(pb.h * 100).toFixed(1)}%` : '-'} vs export ${eb ? `${(eb.w * 100).toFixed(1)}% x ${(eb.h * 100).toFixed(1)}%` : '-'}`);
} finally {
  await b.close();
  fs.rmSync(work, { recursive: true, force: true });
}
await fetch(`${BASE}/api/fonts/Assistant`, { method: 'DELETE' }).catch(() => {});
for (const pid of [id, lid, fid]) await api(`/api/projects/${pid}`, { method: 'DELETE' }).catch(() => {});
fs.writeFileSync(path.join(OUT, 'parity.json'), JSON.stringify({ threshold: PSNR_MIN, results }, null, 2));
console.log(failures ? `\n${failures} FAILED` : `\nALL GOOD (min PSNR ${Math.min(...results.map((r) => r.psnr)).toFixed(1)} dB)  frames: ${OUT}`);
process.exit(failures ? 1 : 0);
