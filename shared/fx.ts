import type { CaptionWord, Clip, ClipFx } from './types';

/**
 * Colour maths shared by the browser preview (SVG filter) and the export (ffmpeg),
 * so a look appears the same in both: a 3x3 RGB matrix, then contrast around mid-grey.
 */
export interface ColorFx {
  matrix: number[]; // 9 values, row-major: r' = m0*r + m1*g + m2*b ...
  contrast: number;
  identity: boolean;
}

const mul = (a: number[], b: number[]): number[] => {
  const o = new Array<number>(9);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
  return o;
};

export function colorFx(fx: ClipFx | undefined): ColorFx {
  const s = fx?.saturation ?? 1;
  const t = fx?.temperature ?? 0;
  const b = fx?.brightness ?? 1;
  const sp = fx?.sepia ?? 0;
  const contrast = fx?.contrast ?? 1;
  let m = [0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s, 0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s, 0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s];
  if (sp > 0) {
    const k = 1 - sp;
    m = mul([0.393 + 0.607 * k, 0.769 - 0.769 * k, 0.189 - 0.189 * k, 0.349 - 0.349 * k, 0.686 + 0.314 * k, 0.168 - 0.168 * k, 0.272 - 0.272 * k, 0.534 - 0.534 * k, 0.131 + 0.869 * k], m);
  }
  const gain = [b * (1 + 0.18 * t), b * (1 + 0.02 * t), b * (1 - 0.18 * t)];
  m = m.map((v, i) => Math.round(v * gain[Math.floor(i / 3)] * 10000) / 10000);
  const identity = s === 1 && t === 0 && b === 1 && sp === 0 && contrast === 1;
  return { matrix: m, contrast, identity };
}

export const speedOf = (clip: Pick<Clip, 'speed' | 'kind'>): number => (clip.kind === 'video' || clip.kind === 'audio' ? Math.max(0.1, clip.speed ?? 1) : 1);

/** Text of a caption split into tokens (words and the whitespace between them) with timing per word. */
export function captionTokens(clip: Pick<Clip, 'text' | 'words' | 'duration'>): { text: string; word: boolean; s: number; e: number }[] {
  const parts = (clip.text ?? '').split(/(\s+)/).filter((p) => p.length);
  const words = parts.filter((p) => p.trim().length);
  let timing: CaptionWord[];
  if (Array.isArray(clip.words) && clip.words.length === words.length && clip.words.every((w) => w && Number.isFinite(w.s) && Number.isFinite(w.e))) timing = clip.words;
  else {
    // edited text: spread the words over the clip by their length
    const total = words.reduce((n, w) => n + w.length, 0) || 1;
    let t = 0;
    timing = words.map((w) => {
      const d = (w.length / total) * clip.duration;
      const out = { s: t, e: t + d, w };
      t += d;
      return out;
    });
  }
  let i = 0;
  return parts.map((p) => {
    if (!p.trim().length) return { text: p, word: false, s: 0, e: 0 };
    const tm = timing[i++];
    return { text: p, word: true, s: tm.s, e: tm.e };
  });
}

/** Index (among word tokens) of the word spoken at local time `t`, or -1. A word stays lit until the next one starts. */
export function activeWord(tokens: { word: boolean; s: number }[], t: number): number {
  let idx = -1;
  let n = 0;
  for (const tk of tokens) {
    if (!tk.word) continue;
    if (t >= tk.s) idx = n;
    n++;
  }
  return idx;
}

export function toSrt(caps: { start: number; end: number; text: string }[]): string {
  const f = (t: number) => {
    const ms = Math.max(0, Math.round(t * 1000));
    const p = (n: number, l = 2) => String(n).padStart(l, '0');
    return `${p(Math.floor(ms / 3600000))}:${p(Math.floor((ms % 3600000) / 60000))}:${p(Math.floor((ms % 60000) / 1000))},${p(ms % 1000, 3)}`;
  };
  return caps.map((c, i) => `${i + 1}\n${f(c.start)} --> ${f(c.end)}\n${c.text.replace(/\r/g, '').replace(/\n{2,}/g, '\n').trim()}\n`).join('\n');
}

export function parseSrt(src: string): { start: number; end: number; text: string }[] {
  const t = (s: string) => {
    const m = /(\d+):(\d+):(\d+)[,.](\d+)/.exec(s);
    return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, '0').slice(0, 3)) / 1000 : NaN;
  };
  const out: { start: number; end: number; text: string }[] = [];
  for (const block of src.replace(/^﻿/, '').replace(/\r/g, '').split(/\n{2,}/)) {
    const lines = block.split('\n').filter((l) => l.trim().length);
    const ti = lines.findIndex((l) => l.includes('-->'));
    if (ti < 0) continue;
    const [a, b] = lines[ti].split('-->');
    const start = t(a);
    const end = t(b);
    const text = lines.slice(ti + 1).join('\n').replace(/<[^>]+>/g, '').trim();
    if (Number.isFinite(start) && Number.isFinite(end) && end > start && text) out.push({ start, end, text });
  }
  return out;
}
