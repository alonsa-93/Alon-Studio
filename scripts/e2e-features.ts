/**
 * Second end-to-end check (effects, speed, sound effects, caption highlight, SRT, loudness):
 *   npx tsx scripts/e2e-features.ts path/to/clip.mp4
 */
import './auth.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const BASE = process.env.BASE_URL ?? 'http://localhost:5173';
const clipPath = process.argv[2];
if (!clipPath) {
  console.error('usage: npx tsx scripts/e2e-features.ts <clip.mp4>');
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
    await new Promise((r) => setTimeout(r, 700));
  }
}
const ffprobe = process.env.FFPROBE_PATH ?? 'ffprobe';

const id = (await post('/api/projects', { name: 'בדיקת אפקטים וסאונד' })).id as string;
const ops = (o: unknown) => post(`/api/projects/${id}/ops`, o);
const fd = new FormData();
fd.append('files', new Blob([fs.readFileSync(clipPath)]), path.basename(clipPath));
const video = (await api(`/api/projects/${id}/media`, { method: 'POST', body: fd })).media[0];
check(video.wave, `upload created a waveform image (${video.wave})`);

let r = await ops({ ops: [{ op: 'set_settings', width: 720, height: 1280 }, { op: 'set_settings', background: '#1b2a4a' }, { op: 'add_clip', mediaId: video.id }, { op: 'split', time: 6 }] });
const [a, b] = r.summary.tracks.find((t: any) => t.kind === 'video').clips;
const before = r.summary.duration;

r = await ops({ ops: [{ op: 'set_fx', clipId: a.id, fx: { fit: 'cover', look: 'bw', saturation: 0, contrast: 1.15 } }, { op: 'set_fx', clipId: b.id, fx: { blur: 12, temperature: 0.8, scale: 0.8, posY: -0.1, flip: true } }] });
check(r.summary.tracks.flatMap((t: any) => t.clips).filter((c: any) => c.fx).length === 2, 'set_fx on two clips');

r = await ops({ op: 'set_speed', clipId: b.id, speed: 2 });
const bLen = before - 6;
check(Math.abs(r.summary.duration - (6 + bLen / 2)) < 0.02, `set_speed 2x: timeline ${before}s -> ${r.summary.duration}s`);

r = await ops({ op: 'duplicate', clipId: a.id });
check(r.summary.tracks.flatMap((t: any) => t.clips).filter((c: any) => c.kind === 'video').length === 3, 'duplicate clip');
const dup = r.summary.tracks.flatMap((t: any) => t.clips).find((c: any) => c.kind === 'video' && c.id !== a.id && c.id !== b.id);
r = await ops({ op: 'delete', clipId: dup.id });

r = await ops({ op: 'detach_audio', clipId: a.id });
const audioTrack = r.summary.tracks.find((t: any) => t.kind === 'audio');
check(audioTrack.clips.length === 1 && r.summary.tracks.flatMap((t: any) => t.clips).find((c: any) => c.id === a.id).volume === 0, 'detach_audio moved the sound to an audio track');

const sfx = await api('/api/library/sfx');
check(sfx.length >= 8, `${sfx.length} built-in sound effects: ${sfx.map((s: any) => s.id).join(', ')}`);
const ding = (await post(`/api/projects/${id}/media/library`, { id: 'ding' })).media;
r = await ops({ ops: [{ op: 'add_music', mediaId: ding.id, start: 1, volume: 1 }, { op: 'set_track', trackId: audioTrack.id, name: 'קול' }] });
check(r.summary.media.some((m: any) => m.name === 'דינג'), 'sound effect added to the project');

const cj = await waitJob((await post(`/api/projects/${id}/captions`, { language: 'he', maxWords: 3 })).jobId);
check(cj.status === 'done' && cj.result.count > 0, `captions (max 3 words): ${cj.result?.count} clips ${cj.error ?? ''}`);
check(cj.result.captions.every((c: any) => c.text.split(/\s+/).length <= 3 && c.words?.length), 'every caption has <= 3 words and word timings');
await ops({ ops: [{ op: 'set_caption_style', style: { highlight: '#ffe500', bg: null, outline: '#000000', size: 72 } }, { op: 'set_caption_animation', type: 'pop', duration: 0.2 }] });
const srt = await (await fetch(`${BASE}/api/projects/${id}/captions.srt`)).text();
check(/\d\d:\d\d:\d\d,\d\d\d --> /.test(srt), `SRT export (${srt.split('\n\n').length - 1} cues)`);

const summary = await api(`/api/projects/${id}/summary`);
const ej = await waitJob((await post(`/api/projects/${id}/export`, { quality: 'low', normalize: true })).jobId);
check(ej.status === 'done', `export with loudness normalisation: ${ej.status} ${ej.error ?? ''}`);
const probe = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', ej.file]).toString());
const v = probe.streams.find((s: any) => s.codec_type === 'video');
check(v.codec_name === 'h264' && v.width === 720 && v.height === 1280, `video ${v.codec_name} ${v.width}x${v.height}`);
check(Math.abs(Number(probe.format.duration) - summary.duration) < 0.2, `duration ${probe.format.duration}s (timeline ${summary.duration}s)`);
const ebur = spawnSync(process.env.FFMPEG_PATH ?? 'ffmpeg', ['-hide_banner', '-nostats', '-i', ej.file, '-af', 'ebur128', '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
const lufs = Number(/I:\s+(-?[\d.]+) LUFS/.exec(ebur.slice(ebur.lastIndexOf('Summary')))?.[1]);
check(Math.abs(lufs + 14) <= 1, `loudness ${lufs} LUFS (target -14 +-1)`);

// editing core: keyframes, punch-in, rotation, blend, new transitions, typewriter, insert / ripple / new track
r = await ops({ ops: [{ op: 'set_keyframe', clipId: a.id, t: 0, x: -0.1, scale: 1, rotation: -8, opacity: 1, ease: 'ease-in-out' }, { op: 'set_keyframe', clipId: a.id, t: 3, x: 0.1, scale: 1.3, rotation: 8, opacity: 0.6, ease: 'ease-out' }] });
check(r.summary.tracks.flatMap((t: any) => t.clips).find((c: any) => c.id === a.id).keyframes?.length === 2, 'keyframes through REST');
r = await ops({ op: 'punch_in', clipId: b.id, start: 6.3, end: 8, x: 0.3, y: 0.4, scale: 1.6 });
check(r.summary.tracks.flatMap((t: any) => t.clips).find((c: any) => c.id === b.id).keyframes?.length === 4, 'punch_in through REST');
r = await ops({ ops: [{ op: 'set_fx', clipId: b.id, fx: { rotation: 12, blend: 'screen' } }, { op: 'add_transition', clipId: b.id, type: 'spin', duration: 0.6 }] });
const nt = await ops({ op: 'move_clip_to_new_track', clipId: b.id, position: 'above' });
check(nt.summary.tracks.filter((t: any) => t.kind === 'video').length === r.summary.tracks.filter((t: any) => t.kind === 'video').length + 1 && nt.summary.tracks.find((t: any) => t.clips.some((c: any) => c.id === b.id)).clips.length === 1, 'move_clip_to_new_track through REST');
r = await ops({ op: 'add_text', text: 'מכונת כתיבה', start: 0.5, duration: 2.5, id: 'tw1' });
r = await ops({ op: 'set_animation', clipId: 'tw1', in: { type: 'typewriter', duration: 1.2 } });
const ins = await ops({ op: 'insert_clip', mediaId: video.id, time: 2 });
const lenAfter = ins.summary.duration;
check(lenAfter > summary.duration + 5, `insert_clip ripples the timeline (${summary.duration}s -> ${lenAfter}s)`);
const vclips = ins.summary.tracks.filter((t: any) => t.kind === 'video').flatMap((t: any) => t.clips).sort((x: any, y: any) => x.start - y.start);
for (const [i, type] of ['wipe-left', 'blur', 'dip-white', 'zoom-out'].entries()) {
  const target = vclips[i + 1];
  if (target) await ops({ op: 'add_transition', clipId: target.id, type, duration: 0.5 });
}
const s2 = await api(`/api/projects/${id}/summary`);
const ej2 = await waitJob((await post(`/api/projects/${id}/export`, { quality: 'low' })).jobId);
check(ej2.status === 'done', `export with keyframes, punch-in, rotation, screen blend, spin / wipe / blur / white transitions and typewriter: ${ej2.status} ${ej2.error ?? ''}`);
const probe2 = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', ej2.file]).toString());
check(Math.abs(Number(probe2.format.duration) - s2.duration) < 0.2, `duration ${probe2.format.duration}s (timeline ${s2.duration}s)`);
// the opacity keyframes reached ffmpeg: the first clip fades to 60% over its first 3 seconds
const frame = (t: number) => execFileSync(process.env.FFMPEG_PATH ?? 'ffmpeg', ['-v', 'error', '-ss', String(t), '-i', ej2.file, '-frames:v', '1', '-vf', 'scale=8:8,format=gray', '-f', 'rawvideo', '-']);
const mean = (b: Buffer) => b.reduce((s, v) => s + v, 0) / b.length;
check(Math.abs(mean(frame(0.2)) - mean(frame(1.9))) > 1, 'keyframed clip changes over time in the export');

// silence removal on the Hebrew speech file: known silences (0.5 s lead, gaps 1.5 s and 2 s, 0.5 s tail)
const speechFile = path.join(path.dirname(clipPath), 'speech-he.mp4');
if (fs.existsSync(speechFile)) {
  const truth = JSON.parse(fs.readFileSync(path.join(path.dirname(clipPath), 'speech-he.json'), 'utf8').replace(/^﻿/, ''));
  const sid = (await post('/api/projects', { name: 'בדיקת הסרת שתיקות' })).id as string;
  const sfd = new FormData();
  sfd.append('files', new Blob([fs.readFileSync(speechFile)]), 'speech-he.mp4');
  const sm = (await api(`/api/projects/${sid}/media`, { method: 'POST', body: sfd })).media[0];
  await post(`/api/projects/${sid}/ops`, { op: 'add_clip', mediaId: sm.id });
  const words = async () => {
    const j = await waitJob((await post(`/api/projects/${sid}/captions`, { language: 'he' })).jobId);
    if (j.status !== 'done') throw new Error('captions failed: ' + j.error);
    return (j.result.captions as { text: string }[]).map((c) => c.text).join(' ').replace(/[.,!?]/g, '').split(/\s+/).filter(Boolean);
  };
  const wordsBefore = await words();
  await post(`/api/projects/${sid}/ops`, { op: 'set_captions', captions: [] });
  const pad = 0.12;
  const expected = truth.duration - (truth.lead - pad) - truth.gaps.reduce((t: number, g: number) => t + g - 2 * pad, 0) - (truth.tail - pad);
  const plan = await post(`/api/projects/${sid}/silences`, {});
  check(!plan.applied && plan.ranges.length === 4 && Math.abs(plan.durationAfter - expected) <= 0.2, `silence dry run: ${plan.ranges.length} silences, ${plan.durationBefore}s -> ${plan.durationAfter}s (expected ${expected.toFixed(2)} +-0.2)`);
  const stillLong = (await api(`/api/projects/${sid}/summary`)).duration;
  check(Math.abs(stillLong - truth.duration) < 0.05, 'the dry run changed nothing');
  // MCP: the same plan through the MCP tool, then apply it
  const mcpCall = async (name: string, args: unknown) => {
    const res = await fetch(BASE + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
    const body = await res.text();
    const data = JSON.parse(/data: (.*)/.exec(body)?.[1] ?? body);
    if (data.result?.isError) throw new Error(`${name}: ${data.result.content[0].text}`);
    return JSON.parse(data.result.content[0].text);
  };
  const listed = await (await fetch(BASE + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })).text();
  const newTools = ['set_keyframe', 'delete_keyframe', 'punch_in', 'insert_clip', 'move_clip_to_new_track', 'set_animation', 'remove_silences'];
  check(newTools.every((t) => listed.includes(`"${t}"`)) && listed.includes('wipe-down') && listed.includes('4:5'), 'MCP lists the new tools, transitions and the 4:5 aspect');
  const mplan = await mcpCall('remove_silences', { projectId: sid, dryRun: true });
  check(mplan.ranges.length === plan.ranges.length && !mplan.applied, 'MCP remove_silences dry run matches REST');
  const done = await mcpCall('remove_silences', { projectId: sid, dryRun: false });
  check(done.applied && Math.abs(done.summary.duration - expected) <= 0.2, `silences removed in one step: ${done.summary.duration}s`);
  const wordsAfter = await words();
  const norm = (w: string[]) => w.join(' ');
  check(norm(wordsBefore) === norm(wordsAfter), `no word was cut (${wordsBefore.length} words before and after)`);
  await api(`/api/projects/${sid}`, { method: 'DELETE' });
}
// export presets, logo, layouts, templates
await import('./e2e-export');
// sound effects, text and caption styles, fonts, keys, stock, import from a link
await import('./e2e-library');
// AI and cloud services (transcription, translation, the agent, narration)
await import('./e2e-ai');
// an MCP tool for every op
await import('./e2e-mcp');
console.log(`\nALL GOOD -> ${ej.file}\nproject id: ${id}`);
