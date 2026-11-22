/**
 * Export and layout end to end: network presets (size, fps, bitrate cap, fit / fill), logo,
 * screen layouts and templates, over REST and MCP. Checks real pixels of the exported MP4s.
 *   npx tsx scripts/e2e-export.ts            (also run at the end of e2e-features.ts)
 */
import './auth.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { EXPORT_PRESETS, logoRect, presetOf } from '../shared/layout';

const BASE = process.env.BASE_URL ?? 'http://localhost:5173';
const FF = process.env.FFMPEG_PATH ?? 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH ?? 'ffprobe';

async function api(url: string, init?: RequestInit) {
  const res = await fetch(BASE + url, init);
  const data = await res.json();
  if (!res.ok) throw Object.assign(new Error(`${url}: ${data.error}`), { status: res.status });
  return data;
}
const post = (url: string, body: unknown) => api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const check = (ok: unknown, msg: string) => {
  if (!ok) throw new Error('FAILED: ' + msg);
  console.log('  ok  ' + msg);
};
const rejects = async (p: Promise<unknown>, msg: string) => {
  try {
    await p;
  } catch (e) {
    check((e as { status?: number }).status === 400, `${msg} (${(e as Error).message.slice(0, 70)})`);
    return;
  }
  check(false, msg + ' (it was accepted)');
};
async function waitJob(jobId: string) {
  for (;;) {
    const job = await api(`/api/jobs/${jobId}`);
    if (job.status !== 'running') return job;
    await new Promise((r) => setTimeout(r, 600));
  }
}
const exportAs = async (id: string, body: Record<string, unknown>) => {
  const job = await waitJob((await post(`/api/projects/${id}/export`, { quality: 'low', ...body })).jobId);
  if (job.status !== 'done') throw new Error(`export failed: ${job.error}`);
  return job.file as string;
};
const probe = (file: string) => {
  const j = JSON.parse(execFileSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,r_frame_rate,bit_rate:format=bit_rate,duration', '-of', 'json', file], { encoding: 'utf8' }));
  const s = j.streams[0];
  const [a, b] = s.r_frame_rate.split('/').map(Number);
  return { width: s.width, height: s.height, fps: a / b, bitrate: Number(s.bit_rate ?? j.format.bit_rate) };
};
/** Average colour [r, g, b] of a w x h box at (x, y) of the frame at time t. */
const pixel = (file: string, t: number, x: number, y: number, w = 8, h = 8): number[] => [
  ...execFileSync(FF, ['-v', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-vf', `crop=${w}:${h}:${x}:${y},scale=1:1:flags=area,format=rgb24`, '-f', 'rawvideo', '-']),
];
const near = (c: number[], want: number[], tol = 40) => c.every((v, i) => Math.abs(v - want[i]) <= tol);

// test pictures, made here
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'alon-e2e-export-'));
const img = (name: string, src: string, extra: string[] = []) => {
  const f = path.join(work, name);
  execFileSync(FF, ['-v', 'error', '-y', '-f', 'lavfi', '-i', src, ...extra, '-frames:v', '1', f]);
  return f;
};
const RED = [230, 30, 30];
const BLUE = [30, 60, 230];
const GREEN = [20, 200, 60];
const files = {
  red: img('red.png', 'color=c=0xe61e1e:s=1280x720'),
  blue: img('blue.png', 'color=c=0x1e3ce6:s=1280x720'),
  logo: img('logo.png', 'color=c=0x14c83c:s=400x200'),
  noise: path.join(work, 'noise.mp4'),
};
// a picture no encoder can squeeze: random noise (the bitrate cap has to do the work)
execFileSync(FF, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=30:d=3', '-vf', 'noise=alls=90:allf=t+u', '-c:v', 'libx264', '-crf', '10', '-preset', 'ultrafast', files.noise]);

const upload = async (id: string, f: string) => {
  const fd = new FormData();
  fd.append('files', new Blob([fs.readFileSync(f)]), path.basename(f));
  return (await api(`/api/projects/${id}/media`, { method: 'POST', body: fd })).media[0];
};

try {
  const id = (await post('/api/projects', { name: 'בדיקת ייצוא ופריסה' })).id as string;
  const ops = (o: unknown) => post(`/api/projects/${id}/ops`, o);
  const red = await upload(id, files.red);
  const blue = await upload(id, files.blue);
  const logo = await upload(id, files.logo);
  let r = await ops({ ops: [{ op: 'set_aspect', aspect: '16:9' }, { op: 'set_settings', width: 1280, height: 720 }, { op: 'add_clip', mediaId: red.id, id: 'RED', start: 0 }, { op: 'trim_clip', clipId: 'RED', start: 0, duration: 2 }] });

  // ---------- validation ----------
  await rejects(ops({ op: 'set_logo', logo: { mediaId: 'm_nothere' } }), 'a logo must be a picture of the project');
  await rejects(ops({ op: 'set_layout', layout: 'grid' }), 'an unknown layout is refused');
  await rejects(post(`/api/projects/${id}/export`, { preset: 'myspace' }), 'an unknown export preset is refused');
  await rejects(post(`/api/projects/${id}/export`, { preset: 'youtube', reframe: 'stretch' }), 'reframe must be fit or fill');

  // ---------- logo ----------
  r = await ops({ op: 'set_logo', logo: { mediaId: logo.id, corner: 'top-left', size: 0.2, opacity: 1, margin: 0.05 } });
  check(r.summary.logo?.corner === 'top-left' && r.summary.logo.size === 0.2, 'set_logo stores the logo');
  r = await ops({ op: 'set_logo', logo: { size: 9 } });
  check(r.summary.logo.size === 0.5 && r.summary.logo.mediaId === logo.id, 'a logo size out of range is clamped, the rest kept');
  r = await ops({ op: 'set_logo', logo: { size: 0.2 } });
  let file = await exportAs(id, {});
  let lr = logoRect(r.summary.logo, 1280, 720, 2);
  check(near(pixel(file, 1, lr.x + lr.w / 2 - 4, lr.y + lr.h / 2 - 4), GREEN) && near(pixel(file, 1, 1280 - 60, 720 - 60), RED), `logo burned in at the top-left (${lr.x},${lr.y} ${lr.w}x${lr.h}), the rest is the picture`);
  await ops({ op: 'set_logo', logo: { opacity: 0.5 } });
  file = await exportAs(id, {});
  const half = pixel(file, 1, lr.x + lr.w / 2 - 4, lr.y + lr.h / 2 - 4);
  check(near(half, [(RED[0] + GREEN[0]) / 2, (RED[1] + GREEN[1]) / 2, (RED[2] + GREEN[2]) / 2], 30), `logo opacity 50% mixes with the picture (${half})`);
  await ops({ op: 'set_logo', logo: { opacity: 1 } });

  // ---------- presets: fit (blurred copy behind), fill (crop), same shape ----------
  const shorts = presetOf('shorts')!;
  file = await exportAs(id, { preset: 'shorts', reframe: 'fit' });
  let pr = probe(file);
  check(pr.width === shorts.width && pr.height === shorts.height && Math.round(pr.fps) === shorts.fps, `Shorts preset: ${pr.width}x${pr.height} ${Math.round(pr.fps)}fps`);
  const top = pixel(file, 1, 540, 300);
  check(top[0] > 90 && top[0] > top[2] * 2, `fit: above the picture is a (darkened, blurred) copy of it, not black (${top})`);
  check(near(pixel(file, 1, 540, 960), RED), 'fit: the whole picture in the middle');
  lr = logoRect({ ...r.summary.logo, opacity: 1 }, shorts.width, shorts.height, 2);
  check(near(pixel(file, 1, lr.x + lr.w / 2 - 4, lr.y + lr.h / 2 - 4), GREEN), 'the logo sits in the corner of the final frame, not of the shrunk picture');
  file = await exportAs(id, { preset: 'instagram-post', reframe: 'fill' });
  pr = probe(file);
  check(pr.width === 1080 && pr.height === 1350, `Instagram 4:5 fill: ${pr.width}x${pr.height}`);
  check(near(pixel(file, 1, 1080 - 40, 1350 - 40), RED), 'fill: the picture covers the frame edge to edge');
  file = await exportAs(id, { preset: 'youtube' });
  pr = probe(file);
  check(pr.width === 1920 && pr.height === 1080, `YouTube (same shape, scaled): ${pr.width}x${pr.height}`);
  check(file.includes('_youtube_'), 'the file name says which preset');

  // ---------- bitrate cap ----------
  const nid = (await post('/api/projects', { name: 'בדיקת תקרת קצב' })).id as string;
  const noise = await upload(nid, files.noise);
  await post(`/api/projects/${nid}/ops`, { op: 'add_clip', mediaId: noise.id });
  const free = probe(await exportAs(nid, { quality: 'high' }));
  const capped = probe(await exportAs(nid, { quality: 'high', preset: 'x' }));
  const cap = presetOf('x')!.maxrate * 1000;
  check(free.bitrate > cap * 1.5 && capped.bitrate <= cap * 1.15, `bitrate cap: ${Math.round(free.bitrate / 1e6)} Mbps without a preset, ${Math.round(capped.bitrate / 1e6 * 10) / 10} Mbps with X (cap ${cap / 1e6})`);
  await api(`/api/projects/${nid}`, { method: 'DELETE' });

  // ---------- layouts ----------
  await ops({ ops: [{ op: 'set_logo', logo: null }, { op: 'add_track', kind: 'video', id: 'TOP' }, { op: 'add_clip', mediaId: blue.id, id: 'BLUE', start: 0, trackId: 'TOP' }, { op: 'trim_clip', clipId: 'BLUE', start: 0, duration: 2 }] });
  const want: Record<string, [number, number, number[]][]> = {
    stack: [[640, 150, RED], [640, 570, BLUE]],
    side: [[300, 360, RED], [980, 360, BLUE]],
    pip: [[300, 200, RED], [1280 - 51 - 100, 720 - 29 - 60, BLUE], [1280 - 51 - 400, 720 - 29 - 60, RED]],
  };
  for (const [layout, pts] of Object.entries(want)) {
    r = await ops({ op: 'set_layout', layout });
    check(r.summary.layout === layout, `set_layout ${layout}`);
    file = await exportAs(id, {});
    for (const [x, y, c] of pts) check(near(pixel(file, 1, x, y), c), `${layout}: (${x},${y}) is ${c === RED ? 'the main track' : 'the track above it'}`);
  }
  r = await ops({ op: 'set_layout', layout: 'single' });
  check(r.summary.layout === 'single' && !(await api(`/api/projects/${id}`)).layout, 'single takes the layout field away again');

  // ---------- templates ----------
  await ops({ ops: [{ op: 'set_layout', layout: 'side' }, { op: 'set_logo', logo: { mediaId: logo.id, corner: 'bottom-right' } }, { op: 'add_text', text: 'כותרת מהתבנית', start: 0, duration: 2 }] });
  const tpl = await post(`/api/projects/${id}/template`, { name: 'תבנית בדיקה' });
  const list = await api('/api/templates');
  check(list.some((t: { id: string; layout: string; logo: boolean; titles: number }) => t.id === tpl.id && t.layout === 'side' && t.logo && t.titles === 1), 'save as template, listed with its layout, logo and title');
  const fromTpl = await post('/api/projects', { name: 'מתבנית', templateId: tpl.id });
  check(fromTpl.layout === 'side' && fromTpl.logo?.corner === 'bottom-right' && fromTpl.settings.width === 1280, 'a new project from the template has its frame, layout and logo');
  check(fromTpl.clips.length === 1 && fromTpl.clips[0].text === 'כותרת מהתבנית' && fromTpl.media.length === 1 && fromTpl.media[0].id === logo.id, 'only the titles and the logo come along (no videos or pictures)');
  check((await fetch(`${BASE}/media/${fromTpl.media[0].file}`)).ok, "the template's logo file is served");
  await rejects(post('/api/projects', { name: 'x', templateId: 'tpl_nothere1' }).catch((e) => Promise.reject(Object.assign(e, { status: e.status === 404 ? 400 : e.status }))), 'an unknown template creates nothing');

  // ---------- MCP ----------
  const mcp = async (method: string, params: unknown) => {
    const res = await fetch(BASE + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    const body = await res.text();
    return JSON.parse(/data: (.*)/.exec(body)?.[1] ?? body);
  };
  const tools = JSON.stringify((await mcp('tools/list', {})).result.tools);
  check(['set_layout', 'set_logo', 'save_template', 'list_templates'].every((t) => tools.includes(`"${t}"`)) && EXPORT_PRESETS.every((p) => tools.includes(p.id)), 'MCP lists layout, logo, template tools and every export preset');
  const call = async (name: string, args: unknown) => {
    const d = await mcp('tools/call', { name, arguments: args });
    if (d.result?.isError) throw new Error(`${name}: ${d.result.content[0].text}`);
    return JSON.parse(d.result.content[0].text);
  };
  const viaMcp = await call('create_project', { name: 'מתבנית דרך MCP', templateId: tpl.id });
  check(viaMcp.layout === 'side' && viaMcp.logo?.mediaId === logo.id, 'MCP create_project from a template');
  const ls = await call('set_logo', { projectId: viaMcp.id, corner: 'top-left', size: 0.1 });
  check(ls.logo.corner === 'top-left' && ls.logo.size === 0.1, 'MCP set_logo');
  const ex = await call('export', { projectId: id, preset: 'square', reframe: 'fill', quality: 'low' });
  pr = probe(ex.file);
  check(pr.width === 1080 && pr.height === 1080, `MCP export with a preset: ${pr.width}x${pr.height}`);

  await api(`/api/templates/${tpl.id}`, { method: 'DELETE' });
  check(!(await api('/api/templates')).some((t: { id: string }) => t.id === tpl.id), 'template deleted');
  for (const pid of [id, fromTpl.id, viaMcp.id]) await api(`/api/projects/${pid}`, { method: 'DELETE' });
  console.log('\nEXPORT AND LAYOUT: ALL GOOD');
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
