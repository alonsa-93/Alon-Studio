import type { Clip, Project } from './types';

/**
 * Screen layouts for the two bottom video tracks, and export presets for social networks.
 * One model for the player and the export (server/render.ts), like shared/motion.ts.
 */

export type Layout = 'single' | 'stack' | 'side' | 'pip';
export const LAYOUTS: Layout[] = ['single', 'stack', 'side', 'pip'];

/** A rectangle in frame fractions (0..1). */
export interface Slot {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The main video track: the bottom-most video track. */
export function mainTrackOf(p: Project): string | undefined {
  const video = p.tracks.filter((t) => t.kind === 'video');
  return video[video.length - 1]?.id;
}

/** The second video track: the one just above the main track. */
export function secondTrackOf(p: Project): string | undefined {
  const video = p.tracks.filter((t) => t.kind === 'video');
  return video[video.length - 2]?.id;
}

const PIP_SIZE = 0.3;
const PIP_MARGIN = 0.04;

/**
 * The rectangle a video / image clip is framed into (it fills it, centre-cropped), or null when it
 * uses the whole frame. stack: main on top, second below. side: main on the left, second on the right.
 * pip: the second track small in the bottom-right corner, the main track full frame.
 */
export function slotOf(p: Project, clip: Clip): Slot | null {
  const layout = p.layout ?? 'single';
  if (layout === 'single' || (clip.kind !== 'video' && clip.kind !== 'image')) return null;
  const main = mainTrackOf(p);
  const second = secondTrackOf(p);
  const isMain = clip.trackId === main;
  const isSecond = !!second && clip.trackId === second;
  if (!isMain && !isSecond) return null;
  switch (layout) {
    case 'stack':
      return isMain ? { x: 0, y: 0, w: 1, h: 0.5 } : { x: 0, y: 0.5, w: 1, h: 0.5 };
    case 'side':
      return isMain ? { x: 0, y: 0, w: 0.5, h: 1 } : { x: 0.5, y: 0, w: 0.5, h: 1 };
    case 'pip':
      return isMain ? null : { x: 1 - PIP_MARGIN - PIP_SIZE, y: 1 - PIP_MARGIN - PIP_SIZE, w: PIP_SIZE, h: PIP_SIZE };
  }
  return null;
}

/** Slot size in pixels, even numbers (what yuv420p needs). */
export function slotPx(s: Slot, W: number, H: number): { x: number; y: number; w: number; h: number } {
  const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);
  return { x: Math.round(s.x * W), y: Math.round(s.y * H), w: even(s.w * W), h: even(s.h * H) };
}

// ---------- logo ----------

export type Corner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
export const CORNERS: Corner[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];

export interface Logo {
  mediaId: string;
  corner: Corner;
  size: number; // width as a fraction of the frame width, 0.03..0.5
  opacity: number; // 0..1
  margin: number; // distance from the edges, fraction of the shorter side, 0..0.2
}
export const LOGO_DEFAULTS: Omit<Logo, 'mediaId'> = { corner: 'top-right', size: 0.15, opacity: 0.9, margin: 0.04 };

/** Where the logo sits (pixels) in a W x H frame, for a picture of aspect `ar` (width / height). */
export function logoRect(l: Logo, W: number, H: number, ar: number): { x: number; y: number; w: number; h: number } {
  const w = Math.max(2, Math.round((l.size * W) / 2) * 2);
  const h = Math.max(2, Math.round(w / Math.max(0.05, ar) / 2) * 2);
  const m = Math.round(l.margin * Math.min(W, H));
  const x = l.corner.endsWith('left') ? m : W - m - w;
  const y = l.corner.startsWith('top') ? m : H - m - h;
  return { x, y, w, h };
}

// ---------- export presets ----------

export type Reframe = 'fit' | 'fill';

export interface ExportOptions {
  preset?: string | null;
  reframe?: Reframe;
}

export interface ExportPreset {
  id: string;
  label: string;
  width: number;
  height: number;
  fps: 30 | 60;
  maxrate: number; // kbit/s, the cap next to CRF
}

/** Sizes and bitrate caps from the networks' upload recommendations. */
export const EXPORT_PRESETS: ExportPreset[] = [
  { id: 'youtube', label: 'YouTube', width: 1920, height: 1080, fps: 30, maxrate: 12000 },
  { id: 'youtube-4k', label: 'YouTube 4K', width: 3840, height: 2160, fps: 30, maxrate: 45000 },
  { id: 'shorts', label: 'YouTube Shorts', width: 1080, height: 1920, fps: 30, maxrate: 10000 },
  { id: 'reels', label: 'Instagram Reels', width: 1080, height: 1920, fps: 30, maxrate: 8000 },
  { id: 'tiktok', label: 'TikTok', width: 1080, height: 1920, fps: 30, maxrate: 8000 },
  { id: 'instagram-post', label: 'Instagram 4:5', width: 1080, height: 1350, fps: 30, maxrate: 8000 },
  { id: 'square', label: 'ריבוע 1:1', width: 1080, height: 1080, fps: 30, maxrate: 8000 },
  { id: 'x', label: 'X (Twitter)', width: 1920, height: 1080, fps: 30, maxrate: 8000 },
  { id: 'linkedin', label: 'LinkedIn', width: 1920, height: 1080, fps: 30, maxrate: 8000 },
];
export const presetOf = (id: string | undefined | null) => EXPORT_PRESETS.find((x) => x.id === id);

/** True when a preset has another shape than the project (then fit / fill matters). */
export const shapeDiffers = (pw: number, ph: number, W: number, H: number) => Math.abs(pw / ph - W / H) > 0.01;
