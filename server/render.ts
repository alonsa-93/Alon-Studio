import fs from 'node:fs';
import path from 'node:path';
import { BLUR_MAX, entryOf, exitOf, freezeTail, neighborsOf, type Motion } from '../shared/anim';
import { animates, basePose, keyExpr, poseAt, sortedKeys, type PoseKey } from '../shared/motion';
import { colorFx, speedOf } from '../shared/fx';
import { projectDuration, uid } from '../shared/ops';
import type { Clip, Job, Project } from '../shared/types';
import { buildAss } from './ass';
import { copyProjectFonts, customFontScales } from './fonts';
import { logoRect, presetOf, shapeDiffers, slotOf, slotPx, type ExportOptions, type Reframe } from '../shared/layout';
import { FFMPEG, run } from './media';
import { attachProcess, detachProcess, EXPORTS_DIR, HttpError, MEDIA_DIR, TMP_DIR, updateJob } from './store';
import { isInside } from './security';

const n = (v: number) => (Math.round(v * 1000) / 1000).toString();

export type Quality = 'low' | 'medium' | 'high';
const QUALITY: Record<Quality, { crf: number; preset: string; audio: string }> = {
  low: { crf: 28, preset: 'veryfast', audio: '128k' },
  medium: { crf: 22, preset: 'fast', audio: '192k' },
  high: { crf: 17, preset: 'medium', audio: '256k' },
};

const progress = (m: Motion, dur: number, entry: boolean) => ({
  p: entry ? `(t/${n(m.duration)})` : `((${n(dur)}-t)/${n(m.duration)})`,
  cond: entry ? `lt(t,${n(m.duration)})` : `gt(t,${n(dur - m.duration)})`,
});

/** Scale factor expression (clip-local time `t`) for zoom / zoom-out / pop / spin motions. */
function zoomExpr(m: Motion | null, dur: number, entry: boolean): string | null {
  if (!m || !['zoom', 'zoom-out', 'pop', 'spin'].includes(m.kind)) return null;
  const { p, cond } = progress(m, dur, entry);
  const e = `(1-pow(1-${p},2))`;
  const f =
    m.kind === 'zoom'
      ? `(0.6+0.4*${e})`
      : m.kind === 'zoom-out'
        ? `(1.4-0.4*${e})`
        : m.kind === 'spin'
          ? `(0.5+0.5*${e})`
          : `max(0.05,if(lt(${p},0.7),1.1*${p}/0.7,1.1-0.1*(${p}-0.7)/0.3))`;
  return `if(${cond},${f},1)`;
}

/** Extra rotation (degrees, clip-local `t`) of the spin transition: 180 -> 0 with ease-out. */
function spinExpr(m: Motion | null, dur: number, entry: boolean): string | null {
  if (!m || m.kind !== 'spin') return null;
  const { p, cond } = progress(m, dur, entry);
  return `if(${cond},180*pow(1-${p},2),0)`;
}

/** Motions whose picture fades (alpha) while it moves. */
const FADES = new Set(['fade', 'zoom', 'zoom-out', 'spin', 'blur']);

/**
 * sendcmd lines that set a filter option every frame while its value changes (values ffmpeg cannot
 * take as an expression: opacity, blur strength). `fn` gets clip-local seconds.
 */
function sampled(target: string, opt: string, fn: (t: number) => number, until: number, fps: number): string {
  const out: string[] = [];
  let last = NaN;
  const frames = Math.ceil(until * fps) + 1;
  for (let i = 0; i <= frames; i++) {
    const t = i / fps;
    const v = Math.round(fn(t) * 1000) / 1000;
    if (v === last) continue;
    last = v;
    // a hair before the frame, so the frame at exactly t already gets the value
    out.push(`${Math.max(0, t - 0.0005).toFixed(4)} ${target} ${opt} ${v};`);
  }
  return out.join('\n') + '\n';
}

/** Slide offset expression (timeline time `t`) as a fraction of the frame. */
function slideExpr(m: Motion | null, at: number, entry: boolean, axis: 'x' | 'y'): string | null {
  if (!m || m.kind !== 'slide') return null;
  const dir = axis === 'x' ? m.dirX : m.dirY;
  if (!dir) return null;
  const p = entry ? `(t-${n(at)})/${n(m.duration)}` : `(${n(at)}-t)/${n(m.duration)}`;
  return `${dir}*pow(1-min(max(${p},0),1),2)`;
}

export interface Graph {
  args: string[]; // input arguments + -filter_complex
  video: string | null; // output label
  audio: string;
  total: number;
  assFile: string | null; // contents to write next to the job as subs.ass
  files: Record<string, string>; // other files the graph reads (sendcmd), written into the job folder
  audioSources: number;
}

/** atempo accepts 0.5..2 per instance; chain several for bigger changes. */
function atempo(speed: number): string[] {
  const out: string[] = [];
  let s = speed;
  while (s > 2.0001) {
    out.push('atempo=2');
    s /= 2;
  }
  while (s < 0.4999) {
    out.push('atempo=0.5');
    s /= 0.5;
  }
  if (Math.abs(s - 1) > 0.001) out.push(`atempo=${n(s)}`);
  return out;
}

export function buildGraph(p: Project, opts: { audioOnly?: boolean; speechOnly?: boolean; normalize?: boolean; output?: { width: number; height: number; reframe: Reframe } } = {}): Graph {
  const { width: W, height: H, fps: F } = p.settings;
  const total = projectDuration(p);
  if (total <= 0) throw new HttpError(400, 'ציר הזמן ריק - אין מה לרנדר');
  const args: string[] = [];
  const filters: string[] = [];
  const files: Record<string, string> = {};
  let idx = 0;
  const addInput = (...a: string[]) => {
    args.push(...a);
    return idx++;
  };
  const mediaOf = (id?: string) => {
    const m = p.media.find((x) => x.id === id);
    if (!m) throw new HttpError(400, `חסר קובץ מדיה לקליפ (${id})`);
    const file = path.join(MEDIA_DIR, m.file);
    // a media entry can only point to a file inside the media folder
    if (!isInside(path.resolve(file), path.resolve(MEDIA_DIR))) throw new HttpError(400, `קובץ מדיה לא תקין: ${m.name}`);
    if (!fs.existsSync(file)) throw new HttpError(400, `קובץ המדיה נמחק מהדיסק: ${m.name}`);
    return { m, file };
  };

  let last = '';
  if (!opts.audioOnly) {
    const bg = /^#[0-9a-f]{6}$/i.test(p.background ?? '') ? '0x' + p.background!.slice(1) : 'black';
    const base = addInput('-f', 'lavfi', '-i', `color=c=${bg}:s=${W}x${H}:r=${F}:d=${n(total)}`);
    last = `${base}:v`;
  }
  const audio: string[] = [];
  const sil = addInput('-f', 'lavfi', '-i', `anullsrc=r=48000:cl=stereo:d=${n(total)}`);

  const addAudio = (input: number, clip: Clip) => {
    const parts = ['aresample=48000', 'aformat=sample_fmts=fltp:channel_layouts=stereo', ...atempo(speedOf(clip)), `volume=${n(clip.volume)}`];
    if (clip.fadeIn) parts.push(`afade=t=in:st=0:d=${n(Math.min(clip.fadeIn, clip.duration))}`);
    if (clip.fadeOut) {
      const d = Math.min(clip.fadeOut, clip.duration);
      parts.push(`afade=t=out:st=${n(clip.duration - d)}:d=${n(d)}`);
    }
    parts.push(`adelay=${Math.round(clip.start * 1000)}:all=1`);
    const label = `a${audio.length}`;
    filters.push(`[${input}:a]${parts.join(',')}[${label}]`);
    audio.push(label);
  };

  const muted = new Set(p.tracks.filter((t) => t.muted).map((t) => t.id));
  const hasSpeechVideo = p.clips.some((c) => c.kind === 'video' && c.volume > 0 && !muted.has(c.trackId) && p.media.find((m) => m.id === c.mediaId)?.hasAudio);

  // visual layers, bottom track first
  const videoTracks = p.tracks.filter((t) => t.kind === 'video').reverse();
  let layer = 0;
  for (const track of videoTracks) {
    const clips = p.clips.filter((c) => c.trackId === track.id).sort((a, b) => a.start - b.start);
    for (const clip of clips) {
      const { m, file } = mediaOf(clip.mediaId);
      const nb = neighborsOf(p, clip);
      const tail = freezeTail(clip, nb);
      const sp = speedOf(clip);
      const withAudio = clip.kind === 'video' && m.hasAudio && clip.volume > 0 && !track.muted;
      if (opts.audioOnly || track.hidden) {
        if (withAudio) addAudio(addInput('-vn', '-ss', n(clip.offset), '-t', n(clip.duration * sp), '-protocol_whitelist', 'file', '-i', file), clip);
        continue;
      }
      const input =
        clip.kind === 'image'
          ? /\.gif$/i.test(file)
            ? addInput('-ignore_loop', '0', '-t', n(clip.duration + tail), '-protocol_whitelist', 'file', '-i', file)
            : addInput('-loop', '1', '-framerate', String(F), '-t', n(clip.duration + tail), '-protocol_whitelist', 'file', '-i', file)
          : addInput('-ss', n(clip.offset), '-t', n(clip.duration * sp), '-protocol_whitelist', 'file', '-i', file);
      const en = entryOf(clip);
      const ex = exitOf(clip, nb);
      const fx = clip.fx ?? {};
      const keys = clip.keyframes?.length ? sortedKeys(clip.keyframes) : null;
      const pose = basePose(clip);
      // a pose property: a number, or (keyframes) an expression of clip-local time `T`
      const poseE = (k: PoseKey, T = 't') => (keys ? keyExpr(keys, k, T) : n(pose[k]));
      const moving = (k: PoseKey) => !!keys && animates(keys, k);
      const span = clip.duration + tail;
      const chain: string[] = [];
      const cmds: string[] = [];
      if (sp !== 1) chain.push(`setpts=(PTS-STARTPTS)/${n(sp)}`);
      chain.push(`fps=${F}`);
      const cmdAt = chain.length;
      // a layout slot (stack / side / pip): the picture fills its rectangle, centre-cropped
      const slot = slotOf(p, clip);
      const box = slot ? slotPx(slot, W, H) : null;
      if (box) chain.push(`scale=${box.w}:${box.h}:force_original_aspect_ratio=increase:force_divisible_by=2`, `crop=${box.w}:${box.h}`);
      else if (fx.fit === 'cover') chain.push(`scale=${W}:${H}:force_original_aspect_ratio=increase:force_divisible_by=2`, `crop=${W}:${H}`);
      else chain.push(`scale=${W}:${H}:force_original_aspect_ratio=decrease:force_divisible_by=2`);
      chain.push('setsar=1');
      if (fx.flip) chain.push('hflip');
      const fxBlur = fx.blur && fx.blur > 0.2 ? fx.blur : 0;
      const blurMotion = [en, ex].some((m) => m?.kind === 'blur');
      if (blurMotion) {
        // the blur transition: strongest at the cut, gone at its end (same curve as the preview)
        const sigma = (t: number) => {
          let b = fxBlur;
          if (en?.kind === 'blur' && t < en.duration) b += BLUR_MAX * (1 - t / en.duration);
          if (ex?.kind === 'blur' && t > clip.duration - ex.duration) b += BLUR_MAX * (1 - Math.max(0, clip.duration - t) / ex.duration);
          return b;
        };
        chain.push(`gblur@bl${layer}=sigma=${n(sigma(0))}`);
        cmds.push(sampled(`gblur@bl${layer}`, 'sigma', sigma, span, F));
      } else if (fxBlur) chain.push(`gblur=sigma=${n(fxBlur)}`);
      const color = colorFx(fx);
      const opacity = keys ? keys[0].opacity : pose.opacity;
      const fadesOpacity = moving('opacity');
      if (!color.identity || opacity < 1 || fadesOpacity) {
        const [rr, rg, rb, gr, gg, gb, br, bg2, bb] = color.matrix;
        chain.push('format=rgba', `colorchannelmixer${fadesOpacity ? `@op${layer}` : ''}=rr=${rr}:rg=${rg}:rb=${rb}:gr=${gr}:gg=${gg}:gb=${gb}:br=${br}:bg=${bg2}:bb=${bb}:aa=${n(opacity)}`);
        if (fadesOpacity) cmds.push(sampled(`colorchannelmixer@op${layer}`, 'aa', (t) => poseAt(clip, t).opacity, span, F));
        if (color.contrast !== 1) {
          const e = `clip((val-127.5)*${n(color.contrast)}+127.5\\,0\\,255)`;
          chain.push(`lutrgb=r=${e}:g=${e}:b=${e}`);
        }
      }
      chain.push('format=yuva420p');
      if (en?.kind === 'wipe') {
        // reveal from one edge: pixels past the moving edge are transparent while the wipe runs
        const P = `(T/${n(en.duration)})`;
        const cond = en.dirX > 0 ? `lte(X,W*${P})` : en.dirX < 0 ? `gte(X,W*(1-${P}))` : en.dirY > 0 ? `lte(Y,H*${P})` : `gte(Y,H*(1-${P}))`;
        chain.push(`geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a='if(${cond},alpha(X,Y),0)':enable='lt(t,${n(en.duration)})'`);
      }
      if (tail > 0 && clip.kind === 'video') chain.push(`tpad=stop_mode=clone:stop_duration=${n(tail)}`);
      if (en && FADES.has(en.kind)) chain.push(`fade=t=in:st=0:d=${n(en.duration)}:alpha=1`);
      if (ex && FADES.has(ex.kind)) chain.push(`fade=t=out:st=${n(clip.duration - ex.duration)}:d=${n(ex.duration)}:alpha=1`);
      if (en?.kind === 'white') chain.push(`fade=t=in:st=0:d=${n(en.duration)}:color=white`);
      if (ex?.kind === 'white') chain.push(`fade=t=out:st=${n(clip.duration - ex.duration)}:d=${n(ex.duration)}:color=white`);
      // rotation about the picture's centre, on a canvas big enough for any angle (corners stay transparent)
      const rot = [keys ? poseE('rotation') : Math.abs(pose.rotation) > 0.01 ? n(pose.rotation) : null, spinExpr(en, clip.duration, true), spinExpr(ex, clip.duration, false)].filter(Boolean);
      if (rot.length && !(rot.length === 1 && rot[0] === '0')) {
        const side = `2*ceil(hypot(iw,ih)/2)`;
        chain.push(`rotate=a='(${rot.join('+')})*PI/180':c=black@0:ow='${side}':oh='${side}'`);
      }
      const z = [zoomExpr(en, clip.duration, true), zoomExpr(ex, clip.duration, false)].filter(Boolean);
      if (z.length || moving('scale')) {
        const zz = [...z, `(${poseE('scale')})`].join('*');
        chain.push(`scale=w='max(2,trunc(iw*${zz}/2)*2)':h='max(2,trunc(ih*${zz}/2)*2)':eval=frame`);
      } else {
        const userScale = keys ? keys[0].scale : pose.scale;
        if (Math.abs(userScale - 1) > 0.001) chain.push(`scale=w='max(2,trunc(iw*${n(userScale)}/2)*2)':h='max(2,trunc(ih*${n(userScale)}/2)*2)'`);
      }
      chain.push(`setpts=PTS-STARTPTS+${n(clip.start)}/TB`);
      if (cmds.length) {
        const name = `k${layer}.cmd`;
        files[name] = cmds.join('');
        chain.splice(cmdAt, 0, `sendcmd=f=${name}`);
      }
      filters.push(`[${input}:v]${chain.join(',')}[v${layer}]`);
      const end = clip.start + clip.duration;
      const local = `(t-${n(clip.start)})`;
      const dx = [slideExpr(en, clip.start, true, 'x'), slideExpr(ex, end, false, 'x')].filter(Boolean).map((e) => `+W*${e}`).join('');
      const dy = [slideExpr(en, clip.start, true, 'y'), slideExpr(ex, end, false, 'y')].filter(Boolean).map((e) => `+H*${e}`).join('');
      const cx = box ? `${box.x}+(${box.w}-w)/2` : '(W-w)/2';
      const cy = box ? `${box.y}+(${box.h}-h)/2` : '(H-h)/2';
      const place = `x='${cx}+W*(${poseE('x', local)})${dx}':y='${cy}+H*(${poseE('y', local)})${dy}':enable='between(t,${n(clip.start)},${n(end + tail)})':eof_action=pass`;
      const blend = fx.blend && fx.blend !== 'normal' ? fx.blend : null;
      if (!blend) {
        filters.push(`[${last}][v${layer}]overlay=${place}[b${layer}]`);
      } else {
        // blend mode: the clip on a transparent frame, mixed with what is under it in RGB, kept only where the clip is
        filters.push(
          `color=c=black@0:s=${W}x${H}:r=${F}:d=${n(total)},format=yuva420p[cv${layer}]`,
          `[cv${layer}][v${layer}]overlay=${place},split[l${layer}][la${layer}]`,
          `[la${layer}]alphaextract[a${layer}]`,
          `[${last}]format=gbrp,split[u${layer}][ub${layer}]`,
          `[l${layer}]format=gbrp[lc${layer}]`,
          `[u${layer}][lc${layer}]blend=all_mode=${blend}[x${layer}]`,
          `[x${layer}][a${layer}]alphamerge[xa${layer}]`,
          `[ub${layer}][xa${layer}]overlay=format=auto,format=yuv420p[b${layer}]`,
        );
      }
      last = `b${layer}`;
      layer++;
      if (withAudio) addAudio(input, clip);
    }
  }

  // audio tracks. For transcription, music and sound effects are left out (unless they are the only sound there is)
  {
    const audioClips = p.clips.filter((c) => c.kind === 'audio' && c.volume > 0 && !muted.has(c.trackId));
    const isMusic = (c: Clip) => !!c.music || !!p.media.find((m) => m.id === c.mediaId)?.libraryId;
    const skipMusic = !!opts.speechOnly && (hasSpeechVideo || audioClips.some((c) => !isMusic(c)));
    for (const clip of audioClips) {
      if (skipMusic && isMusic(clip)) continue;
      const { m, file } = mediaOf(clip.mediaId);
      if (!m.hasAudio) continue;
      addAudio(addInput('-vn', '-ss', n(clip.offset), '-t', n(clip.duration * speedOf(clip)), '-protocol_whitelist', 'file', '-i', file), clip);
    }
  }
  filters.push(`[${sil}:a]${audio.map((l) => `[${l}]`).join('')}amix=inputs=${audio.length + 1}:duration=first:normalize=0:dropout_transition=0,alimiter=limit=0.97${opts.normalize ? ',loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000' : ''}[aout]`);

  let assFile: string | null = null;
  let video: string | null = null;
  if (!opts.audioOnly) {
    const count = { count: 0 };
    const ass = buildAss(p, count, customFontScales());
    let cur = last;
    if (count.count > 0) {
      assFile = ass;
      filters.push(`[${cur}]subtitles=subs.ass:fontsdir=fonts[sub]`);
      cur = 'sub';
    }
    // another size (an export preset): same shape -> scale; another shape -> fit over a blurred copy, or fill (crop)
    let OW = W;
    let OH = H;
    const o = opts.output;
    if (o && (o.width !== W || o.height !== H)) {
      OW = o.width;
      OH = o.height;
      const cover = `scale=${OW}:${OH}:force_original_aspect_ratio=increase:flags=bicubic,crop=${OW}:${OH}`;
      if (!shapeDiffers(OW, OH, W, H)) filters.push(`[${cur}]scale=${OW}:${OH}:flags=bicubic,setsar=1[rs]`);
      else if (o.reframe === 'fill') filters.push(`[${cur}]${cover},setsar=1[rs]`);
      else {
        // the blur runs on a quarter-size copy (fast at 4K), then is scaled back up
        const qw = Math.max(16, Math.round(OW / 8) * 2);
        const qh = Math.max(16, Math.round(OH / 8) * 2);
        filters.push(
          `[${cur}]split[rf1][rf2]`,
          `[rf1]scale=${qw}:${qh}:force_original_aspect_ratio=increase,crop=${qw}:${qh},boxblur=${Math.round(qw / 20)}:2,scale=${OW}:${OH}:flags=bicubic,eq=brightness=-0.06,setsar=1[rbg]`,
          `[rf2]scale=${OW}:${OH}:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=bicubic,setsar=1[rfg]`,
          `[rbg][rfg]overlay=(W-w)/2:(H-h)/2[rs]`,
        );
      }
      cur = 'rs';
    }
    // the logo, on the final frame (always inside it, whatever the preset)
    const logo = p.logo;
    if (logo) {
      const { m, file } = mediaOf(logo.mediaId);
      const r = logoRect(logo, OW, OH, m.width && m.height ? m.width / m.height : 1);
      const li = addInput('-loop', '1', '-framerate', String(F), '-t', n(total), '-protocol_whitelist', 'file', '-i', file);
      filters.push(`[${li}:v]scale=${r.w}:${r.h},format=rgba,colorchannelmixer=aa=${n(logo.opacity)}[logo]`, `[${cur}][logo]overlay=${r.x}:${r.y}:format=auto[lgd]`);
      cur = 'lgd';
    }
    filters.push(`[${cur}]format=yuv420p[vout]`);
    video = 'vout';
  }
  args.push('-filter_complex', filters.join(';'));
  return { args, video, audio: 'aout', total, assFile, files, audioSources: audio.length };
}

function jobDir(): string {
  const dir = path.join(TMP_DIR, uid('job_'));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// no Windows-reserved characters, control characters or direction overrides (a name that displays misleadingly)
const safeName = (s: string) => s.replace(/[<>:"/\\|?*\x00-\x1f\x7f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, 60) || 'export';

export async function renderExport(p: Project, job: Job, quality: Quality, useRange = true, normalize = false, eo: ExportOptions = {}): Promise<void> {
  const q = QUALITY[quality] ?? QUALITY.medium;
  const preset = presetOf(eo.preset);
  const g = buildGraph(p, { normalize, output: preset ? { width: preset.width, height: preset.height, reframe: eo.reframe ?? 'fit' } : undefined });
  // a network's bitrate cap next to the CRF (the buffer is twice the cap)
  const cap = preset ? ['-maxrate', `${preset.maxrate}k`, '-bufsize', `${preset.maxrate * 2}k`] : [];
  const fps = preset?.fps ?? p.settings.fps;
  const dir = jobDir();
  try {
    if (g.assFile) {
      fs.writeFileSync(path.join(dir, 'subs.ass'), g.assFile, 'utf8');
      // the custom fonts this project uses, for libass (relative path: no drive-letter escaping)
      copyProjectFonts(p, path.join(dir, 'fonts'));
    }
    for (const [name, body] of Object.entries(g.files)) fs.writeFileSync(path.join(dir, name), body, 'utf8');
    let from = 0;
    let to = g.total;
    if (useRange) {
      if (p.inPoint !== null) from = Math.min(p.inPoint, g.total);
      if (p.outPoint !== null) to = Math.min(p.outPoint, g.total);
      if (to - from < 0.05) [from, to] = [0, g.total];
    }
    const length = to - from;
    const d = new Date();
    const stamp = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    const fileName = `${safeName(p.name)}${preset ? `_${preset.id}` : ''}_${stamp}_${job.id.slice(-4)}.mp4`;
    // written inside the job folder and moved to exports only when complete: a crash leaves no half file there
    const out = path.join(dir, 'out.mp4');
    const finalFile = path.join(EXPORTS_DIR, fileName);
    const args = [
      '-y', '-hide_banner', '-loglevel', 'error', '-progress', 'pipe:1', '-nostats',
      ...g.args,
      '-map', `[${g.video}]`, '-map', `[${g.audio}]`,
      ...(from > 0 ? ['-ss', n(from)] : []),
      '-t', n(length),
      '-c:v', 'libx264', '-preset', q.preset, '-crf', String(q.crf), ...cap, '-pix_fmt', 'yuv420p', '-r', String(fps),
      '-c:a', 'aac', '-b:a', q.audio, '-ar', '48000', '-ac', '2',
      '-movflags', '+faststart', out,
    ];
    const r = await run(FFMPEG, args, {
      cwd: dir,
      onSpawn: (child) => attachProcess(job.id, { kill: () => child.kill() }),
      onStdout: (s) => {
        const m = [...s.matchAll(/out_time_(?:us|ms)=(\d+)/g)].pop();
        if (m) updateJob(job, { progress: Math.max(job.progress, Math.min(0.99, Number(m[1]) / 1e6 / length)) });
      },
    });
    detachProcess(job.id);
    if (job.status !== 'running') {
      // cancelled: no half-written file left behind
      fs.rmSync(out, { force: true });
      return;
    }
    if (r.code !== 0 || !fs.existsSync(out) || fs.statSync(out).size === 0) {
      fs.rmSync(out, { force: true });
    }
    if (r.code !== 0 || !fs.existsSync(out)) throw new Error(`ffmpeg נכשל: ${r.stderr.trim().split('\n').slice(-4).join(' | ')}`);
    try {
      fs.renameSync(out, finalFile);
    } catch {
      fs.copyFileSync(out, finalFile); // another drive
    }
    updateJob(job, { status: 'done', progress: 1, file: finalFile, url: `/exports/${encodeURIComponent(fileName)}`, message: fileName });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Mixes the timeline's speech to a 16 kHz mono wav for Whisper. Returns the wav path (caller removes its folder). */
export async function renderSpeechWav(p: Project, job?: Job): Promise<{ wav: string; dir: string; total: number }> {
  const g = buildGraph(p, { audioOnly: true, speechOnly: true });
  if (g.audioSources === 0) throw new HttpError(400, 'אין אודיו בציר הזמן - אין מה לתמלל');
  const dir = jobDir();
  const wav = path.join(dir, 'speech.wav');
  const r = await run(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', ...g.args, '-map', `[${g.audio}]`, '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav], {
    cwd: dir,
    onSpawn: job ? (child) => attachProcess(job.id, { kill: () => child.kill() }) : undefined,
  });
  if (job) detachProcess(job.id);
  if (job && job.status !== 'running') {
    // cancelled while the audio was being prepared
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error('בוטל');
  }
  if (r.code !== 0) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error(`ffmpeg נכשל: ${r.stderr.trim().split('\n').slice(-3).join(' | ')}`);
  }
  return { wav, dir, total: g.total };
}
