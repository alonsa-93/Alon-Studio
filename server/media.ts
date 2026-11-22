import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { uid } from '../shared/ops';
import type { MediaAsset } from '../shared/types';
import { HttpError, MEDIA_DIR } from './store';
import { checkImportPath, MEDIA_EXT } from './security';

export const FFMPEG = process.env.FFMPEG_PATH ?? 'ffmpeg';
export const FFPROBE = process.env.FFPROBE_PATH ?? 'ffprobe';

export function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; onStdout?: (s: string) => void; onStderr?: (s: string) => void; onSpawn?: (child: ReturnType<typeof spawn>) => void } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    // no telemetry from the Hugging Face library; nothing else in the child needs the network
    const child = spawn(cmd, args, { cwd: opts.cwd, windowsHide: true, env: { ...process.env, HF_HUB_DISABLE_TELEMETRY: '1', HF_HUB_DISABLE_IMPLICIT_TOKEN: '1', DO_NOT_TRACK: '1' } });
    opts.onSpawn?.(child);
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => {
      if (opts.onStdout) opts.onStdout(d);
      else stdout += d;
    });
    child.stderr.setEncoding('utf8').on('data', (d: string) => {
      opts.onStderr?.(d);
      stderr = (stderr + d).slice(-8000);
    });
    child.on('error', (e) => reject(new Error(`cannot run "${cmd}": ${e.message}`)));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']);
const WEB_VIDEO_CODECS = new Set(['h264', 'vp8', 'vp9', 'av1']);

interface Probe {
  kind: MediaAsset['kind'];
  duration: number;
  width?: number;
  height?: number;
  hasAudio: boolean;
  vcodec?: string;
  pixFmt?: string;
}

export async function probe(file: string): Promise<Probe> {
  const r = await run(FFPROBE, ['-v', 'error', '-protocol_whitelist', 'file', '-print_format', 'json', '-show_format', '-show_streams', file]);
  if (r.code !== 0) throw new HttpError(400, `קובץ מדיה לא נתמך: ${path.basename(file)}`);
  const info = JSON.parse(r.stdout) as { streams?: any[]; format?: { duration?: string } };
  const streams = info.streams ?? [];
  const v = streams.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
  const a = streams.find((s) => s.codec_type === 'audio');
  const duration = Number(info.format?.duration ?? v?.duration ?? a?.duration ?? 0) || 0;
  const ext = path.extname(file).toLowerCase();
  if (!v && !a) throw new HttpError(400, `אין וידאו או אודיו בקובץ: ${path.basename(file)}`);
  let width: number | undefined = v?.width;
  let height: number | undefined = v?.height;
  const rot = Number(v?.side_data_list?.find((s: any) => s.rotation !== undefined)?.rotation ?? v?.tags?.rotate ?? 0);
  if (v && Math.abs(rot) % 180 === 90) [width, height] = [height, width];
  const isImage = !!v && (IMAGE_EXT.has(ext) || (!a && (duration < 0.05 || v.codec_name === 'mjpeg' || v.codec_name === 'png')));
  const kind: MediaAsset['kind'] = isImage ? 'image' : v ? 'video' : 'audio';
  return { kind, duration: kind === 'image' ? 0 : Math.round(duration * 1000) / 1000, width, height, hasAudio: !!a && kind !== 'image', vcodec: v?.codec_name, pixFmt: v?.pix_fmt };
}

/** Registers a file that already sits inside MEDIA_DIR: probes it, builds a thumbnail and (if needed) a browser proxy. */
export async function registerMedia(fileName: string, displayName: string): Promise<MediaAsset> {
  let full = path.join(MEDIA_DIR, fileName);
  let info = await probe(full);
  const id = path.parse(fileName).name;
  // browser recordings (webm / ogg) carry no duration: rewrite them once as m4a
  if (info.kind === 'audio' && (info.duration <= 0 || /\.(webm|ogg|weba)$/i.test(fileName))) {
    const fixed = `${id}.m4a`;
    const r = await run(FFMPEG, ['-y', '-v', 'error', '-protocol_whitelist', 'file', '-i', full, '-vn', '-c:a', 'aac', '-b:a', '192k', path.join(MEDIA_DIR, fixed)]);
    if (r.code !== 0) throw new HttpError(400, `לא ניתן לקרוא את קובץ האודיו: ${displayName}`);
    fs.rmSync(full, { force: true });
    fileName = fixed;
    full = path.join(MEDIA_DIR, fixed);
    info = await probe(full);
  }
  const asset: MediaAsset = { id, name: displayName, kind: info.kind, file: fileName, duration: info.duration, width: info.width, height: info.height, hasAudio: info.hasAudio };
  if (info.kind !== 'audio') {
    const thumb = `${id}_thumb.jpg`;
    const at = info.kind === 'video' ? Math.min(1, info.duration / 3) : 0;
    const r = await run(FFMPEG, ['-y', '-v', 'error', '-ss', String(at), '-protocol_whitelist', 'file', '-i', full, '-frames:v', '1', '-vf', 'scale=320:-2', '-q:v', '4', path.join(MEDIA_DIR, thumb)]);
    if (r.code === 0) asset.thumb = thumb;
    // no size or no decodable frame (e.g. SVG): not usable in a render
    if (!info.width || !info.height || r.code !== 0) throw new HttpError(400, `קובץ מדיה לא נתמך: ${displayName}`);
  }
  if (info.hasAudio) {
    const wave = `${id}_wave.png`;
    const r = await run(FFMPEG, ['-y', '-v', 'error', '-protocol_whitelist', 'file', '-i', full, '-filter_complex', 'aformat=channel_layouts=mono,showwavespic=s=1600x96:colors=white:scale=sqrt', '-frames:v', '1', path.join(MEDIA_DIR, wave)]);
    if (r.code === 0) asset.wave = wave;
  }
  const webOk = info.vcodec && WEB_VIDEO_CODECS.has(info.vcodec) && (info.vcodec !== 'h264' || /^yuvj?420p$/.test(info.pixFmt ?? ''));
  if (info.kind === 'video' && !webOk) {
    const proxy = `${id}_proxy.mp4`;
    const r = await run(FFMPEG, ['-y', '-v', 'error', '-protocol_whitelist', 'file', '-i', full, '-vf', "scale='min(1280,iw)':-2", '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', path.join(MEDIA_DIR, proxy)]);
    if (r.code === 0) asset.proxy = proxy;
  }
  return asset;
}

export function newMediaFileName(originalName: string): string {
  let ext = (path.extname(originalName) || '.bin').toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 6);
  // only media types are kept as such; anything else is stored with a neutral extension (and then rejected by the probe)
  if (!MEDIA_EXT.has(ext) && ext !== '.bin') ext = '.bin';
  return `${uid('m_')}${ext}`;
}

/** Copies a local file into the media library (used by the API / MCP "import by path"). */
export async function importLocalFile(src: string): Promise<MediaAsset> {
  // only media files from the user's own folders (see checkImportPath)
  const abs = checkImportPath(src);
  const fileName = newMediaFileName(abs);
  fs.copyFileSync(abs, path.join(MEDIA_DIR, fileName));
  // a copy keeps the source's modified time; give it "now" so it is never mistaken for an old leftover
  const now = new Date();
  fs.utimesSync(path.join(MEDIA_DIR, fileName), now, now);
  try {
    return await registerMedia(fileName, path.basename(abs));
  } catch (e) {
    fs.rmSync(path.join(MEDIA_DIR, fileName), { force: true });
    throw e;
  }
}
