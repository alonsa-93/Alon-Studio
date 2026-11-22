import type { Clip, Project } from './types';

/** Clips directly before / after `clip` on the same track (touching within 50ms). */
export interface Neighbors {
  prev?: Clip;
  next?: Clip;
}

const TOUCH = 0.05;

export function neighborsOf(project: Project, clip: Clip): Neighbors {
  let prev: Clip | undefined;
  let next: Clip | undefined;
  const end = clip.start + clip.duration;
  for (const c of project.clips) {
    if (c.id === clip.id || c.trackId !== clip.trackId) continue;
    if (Math.abs(c.start + c.duration - clip.start) < TOUCH) prev = c;
    if (Math.abs(c.start - end) < TOUCH) next = c;
  }
  return { prev, next };
}

export type MotionKind = 'fade' | 'slide' | 'zoom' | 'zoom-out' | 'pop' | 'spin' | 'blur' | 'wipe' | 'white' | 'typewriter';
export interface Motion {
  kind: MotionKind;
  duration: number;
  dirX: number; // slide / wipe direction (entry: comes from, exit: goes to); wipe: the way the edge moves
  dirY: number;
}

/** Transitions that show the incoming clip over the (frozen) last frame of the outgoing one. */
const OVERLAP = new Set(['fade', 'slide-left', 'slide-right', 'slide-up', 'slide-down', 'zoom', 'zoom-out', 'spin', 'blur', 'wipe-left', 'wipe-right', 'wipe-up', 'wipe-down']);
/** Strongest blur (px, project resolution) at the start of a "blur" transition. */
export const BLUR_MAX = 30;

export function entryOf(clip: Clip): Motion | null {
  const tr = clip.transition;
  if (tr && tr.duration > 0) {
    const d = Math.min(tr.duration, clip.duration);
    const m = (kind: MotionKind, duration = d, dirX = 0, dirY = 0): Motion => ({ kind, duration, dirX, dirY });
    switch (tr.type) {
      case 'fade':
        return m('fade');
      case 'dip':
        return m('fade', d / 2);
      case 'dip-white':
        return m('white', d / 2);
      case 'flash':
        return m('white', d * 0.7);
      case 'slide-left':
        return m('slide', d, 1, 0);
      case 'slide-right':
        return m('slide', d, -1, 0);
      case 'slide-up':
        return m('slide', d, 0, 1);
      case 'slide-down':
        return m('slide', d, 0, -1);
      case 'zoom':
        return m('zoom');
      case 'zoom-out':
        return m('zoom-out');
      case 'spin':
        return m('spin');
      case 'blur':
        return m('blur');
      case 'wipe-left':
        return m('wipe', d, -1, 0);
      case 'wipe-right':
        return m('wipe', d, 1, 0);
      case 'wipe-up':
        return m('wipe', d, 0, -1);
      case 'wipe-down':
        return m('wipe', d, 0, 1);
    }
  }
  const a = clip.animIn;
  if (a && a.duration > 0) {
    return { kind: a.type, duration: Math.min(a.duration, clip.duration), dirX: 1, dirY: 0 };
  }
  return null;
}

export function exitOf(clip: Clip, nb: Neighbors): Motion | null {
  const nt = nb.next?.transition;
  if (nt && nt.duration > 0) {
    if (nt.type === 'dip') return { kind: 'fade', duration: Math.min(nt.duration / 2, clip.duration), dirX: 0, dirY: 0 };
    if (nt.type === 'dip-white') return { kind: 'white', duration: Math.min(nt.duration / 2, clip.duration), dirX: 0, dirY: 0 };
    if (nt.type === 'flash') return { kind: 'white', duration: Math.min(nt.duration * 0.3, clip.duration), dirX: 0, dirY: 0 };
  }
  const a = clip.animOut;
  if (a && a.duration > 0 && a.type !== 'typewriter') {
    return { kind: a.type, duration: Math.min(a.duration, clip.duration), dirX: -1, dirY: 0 };
  }
  return null;
}

/** Seconds the clip's last frame is held after its end, underneath the next clip's transition. */
export function freezeTail(clip: Clip, nb: Neighbors): number {
  const nt = nb.next?.transition;
  if (!nt || !OVERLAP.has(nt.type) || nt.duration <= 0) return 0;
  if (clip.kind !== 'video' && clip.kind !== 'image') return 0;
  return Math.min(nt.duration, nb.next!.duration);
}

export function popScale(p: number): number {
  const s = p < 0.7 ? (1.1 * p) / 0.7 : 1.1 - (0.1 * (p - 0.7)) / 0.3;
  return Math.max(0.05, s);
}

export interface VisualState {
  visible: boolean;
  opacity: number;
  scale: number;
  dx: number; // fraction of frame width
  dy: number;
  rotation: number; // degrees (spin)
  blur: number; // px (blur transition)
  white: number; // 0..1 mix toward white (flash / dip to white)
  /** visible part of the picture (wipe), fractions of its own width / height */
  reveal: { x0: number; x1: number; y0: number; y1: number } | null;
  type: number; // typewriter: fraction of the text shown (1 = all)
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
export const easeOut = (p: number) => 1 - (1 - p) * (1 - p);

/**
 * Visual state of a clip at timeline time `t`. `ease` = ease-out for motion (video / images);
 * text uses linear motion so the preview matches the ASS renderer used on export.
 */
export function visualAt(clip: Clip, nb: Neighbors, t: number, ease: boolean): VisualState {
  const end = clip.start + clip.duration;
  const tail = freezeTail(clip, nb);
  const st: VisualState = { visible: t >= clip.start - 0.002 && t < end + tail - 0.002, opacity: 1, scale: 1, dx: 0, dy: 0, rotation: 0, blur: 0, white: 0, reveal: null, type: 1 };
  if (!st.visible) return st;
  const apply = (m: Motion, p: number, entry: boolean) => {
    if (p >= 1) return;
    const e = ease ? easeOut(p) : p;
    switch (m.kind) {
      case 'fade':
        st.opacity *= p;
        break;
      case 'slide':
        st.dx += m.dirX * (1 - e);
        st.dy += m.dirY * (1 - e);
        break;
      case 'zoom':
        st.scale *= 0.6 + 0.4 * e;
        st.opacity *= p;
        break;
      case 'zoom-out':
        st.scale *= 1.4 - 0.4 * e;
        st.opacity *= p;
        break;
      case 'pop':
        st.scale *= popScale(p);
        break;
      case 'spin':
        st.rotation += 180 * (1 - e);
        st.scale *= 0.5 + 0.5 * e;
        st.opacity *= p;
        break;
      case 'blur':
        st.blur += BLUR_MAX * (1 - p);
        st.opacity *= p;
        break;
      case 'white':
        st.white = Math.max(st.white, 1 - p);
        break;
      case 'wipe':
        if (entry) st.reveal = m.dirX > 0 ? { x0: 0, x1: p, y0: 0, y1: 1 } : m.dirX < 0 ? { x0: 1 - p, x1: 1, y0: 0, y1: 1 } : m.dirY > 0 ? { x0: 0, x1: 1, y0: 0, y1: p } : { x0: 0, x1: 1, y0: 1 - p, y1: 1 };
        break;
      case 'typewriter':
        if (entry) st.type = p;
        break;
    }
  };
  const en = entryOf(clip);
  if (en) apply(en, clamp01((t - clip.start) / en.duration), true);
  const ex = exitOf(clip, nb);
  if (ex && t <= end) apply(ex, clamp01((end - t) / ex.duration), false);
  return st;
}

/** User-visible characters (grapheme clusters, so a letter keeps its niqqud). */
export function graphemes(text: string): string[] {
  const Seg = (Intl as unknown as { Segmenter?: new (l?: string, o?: { granularity: string }) => { segment(s: string): Iterable<{ segment: string }> } }).Segmenter;
  if (Seg) return [...new Seg(undefined, { granularity: 'grapheme' }).segment(text)].map((x) => x.segment);
  return Array.from(text);
}
/** How many characters a typewriter shows at fraction `f` (spaces and line breaks count, so the pace is even). */
export const typedCount = (total: number, f: number) => (f >= 1 ? total : Math.max(0, Math.min(total, Math.floor(f * total + 1e-6))));
