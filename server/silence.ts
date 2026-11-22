import fs from 'node:fs';
import type { Op } from '../shared/ops';
import { projectDuration } from '../shared/ops';
import type { Project } from '../shared/types';
import { FFMPEG, run } from './media';
import { renderSpeechWav } from './render';
import { HttpError } from './store';

export interface SilenceOptions {
  thresholdDb?: number; // quieter than this counts as silence (default -35)
  minSilence?: number; // seconds of silence before it is removed (default 0.5)
  padding?: number; // seconds kept on each side of the speech (default 0.12)
}
export interface SilencePlan {
  ranges: { start: number; end: number }[]; // timeline ranges to cut, latest first
  removed: number;
  durationBefore: number;
  durationAfter: number;
  ops: Op[];
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;

function num(v: unknown, name: string, def: number, lo: number, hi: number): number {
  if (v === undefined || v === null) return def;
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new HttpError(400, `"${name}" must be a number`);
  if (v < lo || v > hi) throw new HttpError(400, `"${name}" must be between ${lo} and ${hi}`);
  return v;
}

/** Timeline spans that carry speech: video with sound and voice / audio clips (not background music). */
function speechSpans(p: Project): [number, number][] {
  const muted = new Set(p.tracks.filter((t) => t.muted).map((t) => t.id));
  const spans = p.clips
    .filter((c) => !muted.has(c.trackId) && c.volume > 0 && !c.music && (c.kind === 'audio' || c.kind === 'video'))
    .filter((c) => {
      const m = p.media.find((x) => x.id === c.mediaId);
      return m?.hasAudio && !m.libraryId;
    })
    .map((c) => [c.start, c.start + c.duration] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const s of spans) {
    const last = out[out.length - 1];
    if (last && s[0] <= last[1] + 0.01) last[1] = Math.max(last[1], s[1]);
    else out.push([...s]);
  }
  return out;
}

/**
 * Finds the silent parts of the timeline's speech (ffmpeg silencedetect on the mixed speech) and turns
 * them into cut_range ops, latest first so each cut leaves the ones still to come in place.
 */
export async function planSilences(p: Project, o: SilenceOptions = {}): Promise<SilencePlan> {
  const threshold = num(o.thresholdDb, 'thresholdDb', -35, -80, -10);
  const minSilence = num(o.minSilence, 'minSilence', 0.5, 0.1, 10);
  const padding = num(o.padding, 'padding', 0.12, 0, 1);
  const spans = speechSpans(p);
  if (!spans.length) throw new HttpError(400, 'אין בציר הזמן קליפ עם דיבור');
  const { wav, dir, total } = await renderSpeechWav(p);
  let found: [number, number][] = [];
  try {
    const r = await run(FFMPEG, ['-hide_banner', '-nostats', '-i', wav, '-af', `silencedetect=n=${threshold}dB:d=${minSilence}`, '-f', 'null', '-']);
    let open: number | null = null;
    for (const line of r.stderr.split(/\r?\n/)) {
      const s = /silence_start:\s*(-?[\d.]+)/.exec(line);
      const e = /silence_end:\s*(-?[\d.]+)/.exec(line);
      if (s) open = Math.max(0, Number(s[1]));
      if (e && open !== null) {
        found.push([open, Number(e[1])]);
        open = null;
      }
    }
    if (open !== null) found.push([open, total]); // silent until the end
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  found = found.filter(([a, b]) => b - a >= minSilence - 0.01);
  const ranges: { start: number; end: number }[] = [];
  for (const [a, b] of found) {
    for (const [cs, ce] of spans) {
      const s = Math.max(a, cs);
      const e = Math.min(b, ce);
      if (e - s < minSilence - 0.01) continue;
      // keep a little air next to the speech, also before the first word and after the last one
      const start = s + padding;
      const end = e - padding;
      if (end - start >= 0.05) ranges.push({ start: r3(start), end: r3(end) });
    }
  }
  ranges.sort((x, y) => y.start - x.start);
  const removed = r3(ranges.reduce((t, x) => t + x.end - x.start, 0));
  const before = projectDuration(p);
  return {
    ranges,
    removed,
    durationBefore: before,
    durationAfter: r3(before - removed),
    ops: ranges.map((x) => ({ op: 'cut_range', start: x.start, end: x.end }) as Op),
  };
}
