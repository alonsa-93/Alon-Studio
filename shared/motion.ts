import type { Clip, Ease, Keyframe } from './types';

/**
 * Keyframe motion of a video / image clip, shared by the preview and the export: the preview evaluates
 * `poseAt`, the export turns the same keyframes into ffmpeg expressions with `keyExpr` (same curves).
 */
export interface Pose {
  x: number; // offset, fraction of the frame width (= ClipFx.posX)
  y: number;
  scale: number;
  rotation: number; // degrees
  opacity: number;
}
export const POSE_KEYS = ['x', 'y', 'scale', 'rotation', 'opacity'] as const;
export type PoseKey = (typeof POSE_KEYS)[number];

export function basePose(clip: Pick<Clip, 'fx'>): Pose {
  const fx = clip.fx ?? {};
  return { x: fx.posX ?? 0, y: fx.posY ?? 0, scale: fx.scale ?? 1, rotation: fx.rotation ?? 0, opacity: fx.opacity ?? 1 };
}

/** Progress 0..1 shaped by an ease. */
export function ease(e: Ease | undefined, p: number): number {
  const q = Math.max(0, Math.min(1, p));
  switch (e) {
    case 'ease-in':
      return q * q;
    case 'ease-out':
      return 1 - (1 - q) * (1 - q);
    case 'ease-in-out':
      return q * q * (3 - 2 * q);
    case 'hold':
      return 0;
    default:
      return q;
  }
}

/** The same curves as ffmpeg expression text (P = progress 0..1). */
function easeExpr(e: Ease | undefined, P: string): string {
  switch (e) {
    case 'ease-in':
      return `${P}*${P}`;
    case 'ease-out':
      return `(1-(1-${P})*(1-${P}))`;
    case 'ease-in-out':
      return `${P}*${P}*(3-2*${P})`;
    case 'hold':
      return '0';
    default:
      return P;
  }
}

export const sortedKeys = (keys: Keyframe[] | undefined): Keyframe[] => (keys ? [...keys].sort((a, b) => a.t - b.t) : []);
export const hasMotion = (clip: Pick<Clip, 'keyframes'>) => !!clip.keyframes?.length;

/** Pose of a clip at `local` seconds from its start: keyframes when it has them, else its fixed settings. */
export function poseAt(clip: Pick<Clip, 'fx' | 'keyframes'>, local: number): Pose {
  const keys = sortedKeys(clip.keyframes);
  if (!keys.length) return basePose(clip);
  if (local <= keys[0].t) return pick(keys[0]);
  const last = keys[keys.length - 1];
  if (local >= last.t) return pick(last);
  let i = 0;
  while (i < keys.length - 2 && local >= keys[i + 1].t) i++;
  const a = keys[i];
  const b = keys[i + 1];
  const k = ease(a.ease, (local - a.t) / Math.max(1e-6, b.t - a.t));
  const out = {} as Pose;
  for (const p of POSE_KEYS) out[p] = a[p] + (b[p] - a[p]) * k;
  return out;
}
const pick = (k: Keyframe): Pose => ({ x: k.x, y: k.y, scale: k.scale, rotation: k.rotation, opacity: k.opacity });

const n = (v: number) => (Math.round(v * 100000) / 100000).toString();

/**
 * One pose property as an ffmpeg expression of time `T` (seconds from the clip start), piecewise over the
 * keyframes. Returns a plain number when the value never changes.
 */
export function keyExpr(keys: Keyframe[], prop: PoseKey, T = 't'): string {
  const k = sortedKeys(keys);
  if (!k.length) return '0';
  if (k.every((x) => Math.abs(x[prop] - k[0][prop]) < 1e-9)) return n(k[0][prop]);
  let expr = n(k[k.length - 1][prop]);
  for (let i = k.length - 2; i >= 0; i--) {
    const a = k[i];
    const b = k[i + 1];
    const dv = b[prop] - a[prop];
    const P = `((${T}-${n(a.t)})/${n(Math.max(1e-6, b.t - a.t))})`;
    const seg = Math.abs(dv) < 1e-9 ? n(a[prop]) : `(${n(a[prop])}+${n(dv)}*${easeExpr(a.ease, P)})`;
    expr = `if(lt(${T},${n(b.t)}),${seg},${expr})`;
  }
  return `if(lt(${T},${n(k[0].t)}),${n(k[0][prop])},${expr})`;
}

/** Is a property animated (different values across the keyframes)? */
export const animates = (keys: Keyframe[] | undefined, prop: PoseKey) => !!keys && keys.length > 1 && keys.some((x) => Math.abs(x[prop] - keys[0][prop]) > 1e-9);

/**
 * Keyframes of the part [from, to] (clip-local seconds) of a clip, re-based to start at 0. The edges get a
 * keyframe with the pose there, so a split / trimmed piece keeps moving exactly as before.
 */
export function sliceKeys(clip: Pick<Clip, 'fx' | 'keyframes'>, from: number, to: number): Keyframe[] | undefined {
  const keys = sortedKeys(clip.keyframes);
  if (!keys.length) return undefined;
  const r = (v: number) => Math.round(v * 1000) / 1000;
  const easeAt = (t: number) => {
    let e = keys[0].ease;
    for (const k of keys) if (k.t <= t + 1e-6) e = k.ease;
    return e;
  };
  const at = (t: number): Keyframe => ({ t, ...poseAt(clip, t), ease: easeAt(t) });
  const pts = [at(from), ...keys.filter((k) => k.t > from + 0.001 && k.t < to - 0.001).map((k) => ({ ...k })), at(to)];
  // a curved segment cut in two is not the same curve any more: the cut part becomes short straight steps
  const out: Keyframe[] = [];
  const isKey = (t: number) => keys.some((k) => Math.abs(k.t - t) < 1e-6);
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    out.push(a);
    const b = pts[i + 1];
    if (!b || (isKey(a.t) && isKey(b.t)) || a.ease === 'linear' || a.ease === 'hold') continue;
    if (a.t >= keys[keys.length - 1].t || b.t <= keys[0].t) continue; // flat before the first / after the last key
    a.ease = 'linear';
    const steps = Math.max(2, Math.min(12, Math.ceil((b.t - a.t) / 0.1)));
    for (let j = 1; j < steps; j++) out.push({ ...at(a.t + ((b.t - a.t) * j) / steps), ease: 'linear' });
  }
  return out.map((k) => ({ ...k, t: r(k.t - from) }));
}

/** Keyframes stretched in time (speed change: the same motion over a longer / shorter clip). */
export const stretchKeys = (keys: Keyframe[] | undefined, k: number) => keys?.map((x) => ({ ...x, t: Math.round(x.t * k * 1000) / 1000 }));
