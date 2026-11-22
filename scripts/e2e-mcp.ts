/**
 * MCP for every op: every op in shared/ops.ts OP_NAMES has its own MCP tool (OP_TOOLS in
 * server/mcp.ts), the server lists them all, and the per-op tools really edit the project.
 *   npx tsx scripts/e2e-mcp.ts <clip.mp4>          (also run at the end of e2e-features.ts)
 */
import './auth.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OP_NAMES } from '../shared/ops';
import { OP_TOOLS } from '../server/mcp-ops';

const BASE = process.env.BASE_URL ?? 'http://localhost:5182';
const clipPath = process.argv[2] ?? path.join(os.tmpdir(), 'alon-test-media', 'test-clip.mp4');

async function api(url: string, init?: RequestInit) {
  const res = await fetch(BASE + url, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${url}: ${res.status} ${data.error}`);
  return data;
}
const post = (url: string, body: unknown = {}) => api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const check = (ok: unknown, msg: string) => {
  if (!ok) throw new Error('FAILED: ' + msg);
  console.log('  ok  ' + msg);
};
async function rpc(method: string, params?: unknown) {
  const res = await fetch(BASE + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const body = await res.text();
  return JSON.parse(/data: (.*)/.exec(body)?.[1] ?? body);
}
async function call(name: string, args: Record<string, unknown>) {
  const data = await rpc('tools/call', { name, arguments: args });
  if (data.result?.isError) throw new Error(`${name}: ${data.result.content[0].text}`);
  return JSON.parse(data.result.content[0].text);
}
async function refused(name: string, args: Record<string, unknown>) {
  const data = await rpc('tools/call', { name, arguments: args });
  return !!(data.result?.isError || data.error);
}

console.log('\nMCP FOR EVERY OP');
const tools: { name: string; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } }[] = (await rpc('tools/list')).result.tools;
const names = new Set(tools.map((x) => x.name));
const missing = OP_NAMES.filter((o) => !names.has(OP_TOOLS[o]));
check(!missing.length, `every one of the ${OP_NAMES.length} ops has an MCP tool${missing.length ? ' - missing: ' + missing.join(', ') : ''}`);
const unmarked = tools.filter((x) => x.annotations?.readOnlyHint === undefined && x.annotations?.destructiveHint === undefined).map((x) => x.name);
check(!unmarked.length, `every tool says whether it is read-only or destructive${unmarked.length ? ' - not: ' + unmarked.join(', ') : ''}`);
const destructive = ['delete_track', 'ripple_delete', 'remove_media', 'set_captions'];
check(destructive.every((n) => tools.find((x) => x.name === n)?.annotations?.destructiveHint === true), 'the tools that remove things are marked destructive');

const p = await post('/api/projects', { name: 'MCP test' });
const projectId = p.id as string;
try {
  const fd = new FormData();
  fd.append('files', new Blob([fs.readFileSync(clipPath)]), 'mcp-clip.mp4');
  const media = (await api(`/api/projects/${projectId}/media`, { method: 'POST', body: fd })).media[0];
  await call('add_clip', { projectId, mediaId: media.id });
  await call('add_text', { projectId, text: 'MCP', start: 1, duration: 2 });
  const get = () => api(`/api/projects/${projectId}`) as Promise<{ clips: { id: string; kind: string; start: number; duration: number; offset: number; text?: string; volume?: number; trackId: string; muted?: boolean }[]; tracks: { id: string; kind: string; name: string; muted?: boolean; hidden?: boolean }[]; name: string; inPoint: number | null; outPoint: number | null; captionAnim?: unknown; media: unknown[] }>;
  let proj = await get();
  const vid = proj.clips.find((c) => c.kind === 'video')!;
  const txt = proj.clips.find((c) => c.kind === 'text')!;

  await call('trim_clip', { projectId, clipId: vid.id, start: 0, duration: 6, offset: 1 });
  proj = await get();
  let v = proj.clips.find((c) => c.id === vid.id)!;
  check(v.duration === 6 && v.offset === 1, 'trim_clip sets the length and the source offset');

  await call('move_clip', { projectId, clipId: txt.id, start: 3 });
  await call('update_clip', { projectId, clipId: txt.id, text: 'Hello MCP', style: { size: 90 } });
  proj = await get();
  const t2 = proj.clips.find((c) => c.id === txt.id)! as { start: number; text?: string; style?: { size?: number } };
  check(t2.start === 3 && t2.text === 'Hello MCP' && t2.style?.size === 90, 'move_clip and update_clip (text and style)');
  check(await refused('update_clip', { projectId, clipId: vid.id, volume: 9 }), 'update_clip refuses a volume out of range');

  await call('duplicate_clip', { projectId, clipId: vid.id });
  proj = await get();
  check(proj.clips.filter((c) => c.kind === 'video').length === 2, 'duplicate_clip copies the clip');

  await call('detach_audio', { projectId, clipId: vid.id });
  proj = await get();
  check(proj.clips.some((c) => c.kind === 'audio') && proj.clips.find((c) => c.id === vid.id)!.volume === 0, 'detach_audio moves the sound to its own clip');

  const before = proj.clips.length;
  const second = proj.clips.filter((c) => c.kind === 'video').sort((a, b) => a.start - b.start)[1];
  await call('ripple_delete', { projectId, clipId: second.id });
  proj = await get();
  check(proj.clips.length === before - 1 && !proj.clips.some((c) => c.id === second.id), 'ripple_delete removes the clip');

  await call('add_track', { projectId, kind: 'text', name: 'Extra' });
  proj = await get();
  const extra = proj.tracks.find((x) => x.name === 'Extra')!;
  check(extra && extra.kind === 'text', 'add_track');
  await call('set_track', { projectId, trackId: extra.id, hidden: true, name: 'Extra 2' });
  proj = await get();
  check(proj.tracks.find((x) => x.id === extra.id)?.hidden === true && proj.tracks.find((x) => x.id === extra.id)?.name === 'Extra 2', 'set_track hides and renames');
  await call('delete_track', { projectId, trackId: extra.id });
  proj = await get();
  check(!proj.tracks.some((x) => x.id === extra.id), 'delete_track');

  await call('set_settings', { projectId, name: 'MCP renamed', background: '#112233' });
  await call('set_in_out', { projectId, in: 1, out: 2.5 });
  proj = await get();
  check(proj.name === 'MCP renamed' && proj.inPoint === 1 && proj.outPoint === 2.5, 'set_settings (name) and set_in_out');
  check(await refused('set_settings', { projectId, fps: 25 }), 'set_settings refuses 25 fps');

  await call('set_captions', { projectId, captions: [{ start: 0, end: 1.5, text: 'one' }, { start: 1.5, end: 3, text: 'two' }] });
  const caps = await call('get_captions', { projectId });
  check(caps.length === 2 && caps[1].text === 'two', 'set_captions replaces the captions');
  await call('set_caption_animation', { projectId, type: 'pop', duration: 0.3 });
  proj = await get();
  check(JSON.stringify(proj).includes('"pop"'), 'set_caption_animation');

  await call('remove_media', { projectId, mediaId: media.id });
  proj = await get();
  check(!proj.media.length && !proj.clips.some((c) => c.kind === 'video'), 'remove_media removes the media and its clips');
  console.log('MCP FOR EVERY OP: ALL GOOD');
} finally {
  await api(`/api/projects/${projectId}`, { method: 'DELETE' }).catch(() => undefined);
}
