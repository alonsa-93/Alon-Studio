/**
 * End-to-end check against a running server:
 *   npm run test:e2e -- path/to/clip.mp4 [path/to/music.mp3]
 * Uploads the clip, cuts a range, splits, adds text + captions (Whisper) and exports an MP4, then verifies it with ffprobe.
 */
import './auth.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const BASE = process.env.BASE_URL ?? 'http://localhost:5173';
const [clipPath, musicPath] = process.argv.slice(2);
if (!clipPath) {
  console.error('usage: npm run test:e2e -- <clip.mp4> [music.mp3]');
  process.exit(2);
}

async function api(url: string, init?: RequestInit) {
  const res = await fetch(BASE + url, init);
  const data = await res.json();
  if (!res.ok) throw new Error(`${url}: ${data.error}`);
  return data;
}
const post = (url: string, body: unknown) => api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const check = (ok: unknown, msg: string) => {
  if (!ok) throw new Error('FAILED: ' + msg);
  console.log('  ok  ' + msg);
};
async function waitJob(jobId: string) {
  for (;;) {
    const job = await api(`/api/jobs/${jobId}`);
    if (job.status !== 'running') return job;
    process.stdout.write(`\r  ... ${Math.round(job.progress * 100)}%   `);
    await new Promise((r) => setTimeout(r, 700));
  }
}

const project = await post('/api/projects', { name: 'בדיקת קצה לקצה' });
const id = project.id as string;
console.log(`project ${id}`);

// 1. upload
const fd = new FormData();
fd.append('files', new Blob([fs.readFileSync(clipPath)]), path.basename(clipPath));
if (musicPath) fd.append('files', new Blob([fs.readFileSync(musicPath)]), path.basename(musicPath));
const up = await api(`/api/projects/${id}/media`, { method: 'POST', body: fd });
const video = up.media.find((m: any) => m.kind === 'video');
const music = up.media.find((m: any) => m.kind === 'audio');
check(video?.duration > 1, `upload: ${video.name} (${video.duration}s, ${video.width}x${video.height})`);

// 2. edit
await post(`/api/projects/${id}/ops`, { ops: [{ op: 'set_aspect', aspect: '9:16' }, { op: 'set_settings', width: 720, height: 1280 }, { op: 'add_clip', mediaId: video.id }] });
const full = video.duration as number;
const cutFrom = Math.min(8.6, full * 0.5);
const cutTo = Math.min(12.2, full * 0.72);
let r = await post(`/api/projects/${id}/ops`, { op: 'cut_range', start: cutFrom, end: cutTo });
check(Math.abs(r.summary.duration - (full - (cutTo - cutFrom))) < 0.05, `cut_range ${cutFrom}-${cutTo}: duration ${full} -> ${r.summary.duration}`);
r = await post(`/api/projects/${id}/ops`, { op: 'split', time: 3 });
const clips = r.summary.tracks.find((t: any) => t.kind === 'video').clips;
check(clips.length === 3, `split: ${clips.length} clips on the video track`);
const ops: any[] = [
  { op: 'add_text', text: 'ALON.ai\nבדיקה', start: 0.3, duration: 2.5, style: { size: 90, y: 0.2, bg: '#ff6a3d' } },
  { op: 'set_animation', clipId: clips[0].id, in: { type: 'zoom', duration: 0.6 } },
  { op: 'add_transition', clipId: clips[1].id, type: 'slide-left', duration: 0.5 },
  { op: 'add_transition', clipId: clips[2].id, type: 'fade', duration: 0.5 },
];
if (music) ops.push({ op: 'add_music', mediaId: music.id, volume: 0.08, duration: r.summary.duration });
r = await post(`/api/projects/${id}/ops`, { ops });
const textClip = r.summary.tracks.flatMap((t: any) => t.clips).find((c: any) => c.kind === 'text');
await post(`/api/projects/${id}/ops`, { op: 'set_animation', clipId: textClip.id, in: { type: 'pop', duration: 0.4 }, out: { type: 'fade', duration: 0.4 } });
check(true, 'text, animations, transitions' + (music ? ', music' : ''));

// 3. captions
if (!process.env.SKIP_CAPTIONS) {
  const cj = await waitJob((await post(`/api/projects/${id}/captions`, { language: 'he' })).jobId);
  console.log();
  check(cj.status === 'done', `captions: ${cj.status} ${cj.error ?? cj.message}`);
  for (const c of cj.result.captions.slice(0, 6)) console.log(`      ${c.start.toFixed(2)}-${c.end.toFixed(2)}  ${c.text}`);
  check(cj.result.count > 0, `${cj.result.count} caption clips created`);
}

// 4. export
const summary = await api(`/api/projects/${id}/summary`);
const ej = await waitJob((await post(`/api/projects/${id}/export`, { quality: 'medium' })).jobId);
console.log();
check(ej.status === 'done', `export: ${ej.status} ${ej.error ?? ej.file}`);
const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', ej.file]).toString());
const v = probe.streams.find((s: any) => s.codec_type === 'video');
const a = probe.streams.find((s: any) => s.codec_type === 'audio');
check(v.codec_name === 'h264' && a.codec_name === 'aac', `codecs: ${v.codec_name} + ${a.codec_name}`);
check(v.width === 720 && v.height === 1280, `resolution: ${v.width}x${v.height}`);
check(v.r_frame_rate === '30/1', `fps: ${v.r_frame_rate}`);
check(Math.abs(Number(probe.format.duration) - summary.duration) < 0.15, `duration: ${probe.format.duration}s (timeline ${summary.duration}s)`);
console.log(`\nALL GOOD -> ${ej.file}\nproject id: ${id}`);
