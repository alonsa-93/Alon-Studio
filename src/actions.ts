/**
 * Editing commands shared by the toolbar, keyboard shortcuts, library and properties panel,
 * so every entry point behaves the same way.
 */
import { poseAt, sortedKeys } from '../shared/motion';
import { projectDuration, uid, type Op } from '../shared/ops';
import type { Clip, ClipFx, MediaAsset, Project } from '../shared/types';
import { useStore } from './store';
// imported as tr: several commands here use a local `t` for a time
import { t as tr } from './i18n';

const st = () => useStore.getState();

/** The main video track: the bottom-most video track (the one a beginner's video lives on). */
export function mainTrackId(p: Project): string | undefined {
  const video = p.tracks.filter((t) => t.kind === 'video');
  return video[video.length - 1]?.id;
}

// the label is read when the toast is shown, so it follows the current language
const undoAction = {
  get label() {
    return tr('act.undo');
  },
  run: () => st().undo(),
};

const orientationOf = (w: number, h: number): 'landscape' | 'portrait' | 'square' => (Math.abs(w / h - 1) < 0.1 ? 'square' : w > h ? 'landscape' : 'portrait');

/** After the first picture lands on the timeline: offer to match the frame when the shapes differ. */
function maybeOfferFormat(p: Project, m: MediaAsset) {
  if (m.kind === 'audio' || !m.width || !m.height) return;
  const hadVisual = p.clips.some((c) => c.kind === 'video' || c.kind === 'image');
  if (hadVisual) return;
  const clipShape = orientationOf(m.width, m.height);
  const frameShape = orientationOf(p.settings.width, p.settings.height);
  if (clipShape !== frameShape) st().set({ formatPrompt: { mediaId: m.id, orientation: clipShape } });
}

/** Inserts a video / image at the playhead: what is there splits and everything after moves later. */
export function insertAtPlayhead(m: MediaAsset) {
  const s = st();
  if (!s.project || m.kind === 'audio') return;
  const id = uid('c_');
  const main = mainTrackId(s.project);
  s.run({ op: 'insert_clip', mediaId: m.id, time: s.time, id, ...(main ? { trackId: main } : {}) });
  s.select(id);
  s.notify(tr('act.inserted'), 'info', undoAction);
}

/** Puts a library item on the timeline the way a beginner expects. */
export function addMediaToTimeline(m: MediaAsset, opts: { start?: number } = {}) {
  const s = st();
  const p = s.project;
  if (!p) return;
  const id = uid('c_');
  if (m.kind === 'audio') {
    // audio next to a video is background music: from the start, as long as the video, softer, fading out
    const videoEnd = Math.max(0, ...p.clips.filter((c) => c.kind === 'video' || c.kind === 'image').map((c) => c.start + c.duration));
    const op: Op = videoEnd > 0 && opts.start === undefined
      ? { op: 'add_music', mediaId: m.id, start: 0, volume: 0.4, duration: videoEnd, id }
      : { op: 'add_music', mediaId: m.id, start: opts.start ?? s.time, volume: 1, id };
    s.run(op);
    s.select(id);
    s.notify(videoEnd > 0 && opts.start === undefined ? tr('act.musicAdded') : tr('act.soundAdded'));
    return;
  }
  maybeOfferFormat(p, m);
  const main = mainTrackId(p);
  s.run({ op: 'add_clip', mediaId: m.id, id, ...(opts.start !== undefined ? { start: opts.start } : {}), ...(opts.start === undefined && main ? { trackId: main } : {}) });
  s.select(id);
  // show the new clip: jump to it, and fit the timeline when it is the first one
  const c = st().project?.clips.find((x) => x.id === id);
  if (c) s.seek(c.start);
  fitTimelineSoon();
}

/** Upload, and when the timeline has no picture yet, put the first video / image on it right away. */
export async function uploadFiles(files: FileList | File[]) {
  const assets = await st().upload(files);
  const p = st().project;
  if (!p || !assets.length) return assets;
  const hasVisual = p.clips.some((c) => c.kind === 'video' || c.kind === 'image');
  const first = assets.find((a) => a.kind !== 'audio');
  // the asset arrives in the project through the live-update stream; wait for it
  const wait = async (id: string) => {
    for (let i = 0; i < 60 && !st().project?.media.some((m) => m.id === id); i++) await new Promise((r) => setTimeout(r, 50));
  };
  if (!hasVisual && first) {
    await wait(first.id);
    addMediaToTimeline(first);
  } else {
    st().notify(assets.length === 1 ? tr('act.addedOne', { name: assets[0].name }) : tr('act.addedMany', { n: assets.length }));
  }
  return assets;
}

let fitTimer = 0;
/** Asks the timeline to show the whole project (after the first clip / big length changes). */
export function fitTimelineSoon() {
  clearTimeout(fitTimer);
  fitTimer = window.setTimeout(() => window.dispatchEvent(new Event('alon:fit-timeline')), 60);
}

/** S / "חיתוך": cuts the selected clip at the playhead; with nothing selected, the video under the playhead. */
export function splitAtPlayhead() {
  const s = st();
  const p = s.project;
  if (!p) return;
  const t = s.time;
  const under = (c: Clip) => c.start < t - 0.02 && c.start + c.duration > t + 0.02;
  const sel = p.clips.find((c) => c.id === s.selected);
  let targets: Clip[];
  if (sel) targets = under(sel) ? [sel] : [];
  else targets = p.clips.filter((c) => (c.kind === 'video' || c.kind === 'image') && under(c));
  if (!targets.length) {
    s.notify(sel ? tr('act.playheadOffClip') : tr('act.noVideoUnder'));
    return;
  }
  const newIds = Object.fromEntries(targets.map((c) => [c.id, uid('c_')]));
  s.run(targets.map((c) => ({ op: 'split', time: t, clipId: c.id, newIds }) as Op));
  s.notify(tr('act.splitDone'), 'info', undoAction);
}

/**
 * Delete / "מחיקה". A part of the main video is removed together with its time span, so no black
 * gap is left (keepGap = Shift+Delete leaves the gap). Anything else is just removed.
 */
/** The clip keyframe commands work on: the selected video / image, else the top one under the playhead. */
export function keyframeTarget(): Clip | null {
  const s = st();
  const p = s.project;
  if (!p) return null;
  const visual = (c: Clip) => c.kind === 'video' || c.kind === 'image';
  const sel = p.clips.find((c) => c.id === s.selected);
  if (sel && visual(sel)) return sel;
  const order = (c: Clip) => p.tracks.findIndex((t) => t.id === c.trackId);
  return p.clips.filter((c) => visual(c) && s.time >= c.start && s.time < c.start + c.duration).sort((a, b) => order(a) - order(b))[0] ?? null;
}
const KEY_HIT = 0.05;

/** K: a keyframe at the playhead appears (with the picture as it is now) or, when there is one, goes. */
export function toggleKeyframe() {
  const s = st();
  const c = keyframeTarget();
  if (!c) {
    s.notify(tr('act.pickForKeyframe'));
    return;
  }
  const local = s.time - c.start;
  if (local < -0.001 || local > c.duration + 0.001) {
    s.notify(tr('act.playheadOffSelected'));
    return;
  }
  const t = Math.round(Math.max(0, Math.min(c.duration, local)) * 1000) / 1000;
  const hit = sortedKeys(c.keyframes).find((k) => Math.abs(k.t - t) <= KEY_HIT);
  if (hit) {
    s.run({ op: 'delete_keyframe', clipId: c.id, t: hit.t });
    s.set({ selectedKey: null });
    s.notify(tr('act.keyframeRemoved'), 'info', undoAction);
  } else {
    s.run({ op: 'set_keyframe', clipId: c.id, t, ...poseAt(c, t) });
    if (s.selected !== c.id) s.select(c.id);
    s.set({ selectedKey: { clipId: c.id, t } });
    if (!c.keyframes?.length) s.notify(tr('act.keyframeAdded'));
  }
}

/** Shift+K / Shift+J: the playhead jumps to the next / previous keyframe of the clip. */
export function jumpKeyframe(dir: 1 | -1) {
  const s = st();
  const c = keyframeTarget();
  const keys = sortedKeys(c?.keyframes).map((k) => c!.start + k.t);
  if (!c || !keys.length) {
    s.notify(tr('act.noKeyframes'));
    return;
  }
  const next = dir > 0 ? keys.find((t) => t > s.time + 0.01) : [...keys].reverse().find((t) => t < s.time - 0.01);
  if (next === undefined) return;
  s.setPlaying(false);
  s.seek(next);
  s.set({ selectedKey: { clipId: c.id, t: Math.round((next - c.start) * 1000) / 1000 } });
}

export function deleteSelected(keepGap = false) {
  const s = st();
  if (s.selectedKey && s.project?.clips.some((c) => c.id === s.selectedKey!.clipId)) {
    // a keyframe picked on the timeline goes first, the clip stays
    s.run({ op: 'delete_keyframe', clipId: s.selectedKey.clipId, t: s.selectedKey.t });
    s.set({ selectedKey: null });
    s.notify(tr('act.keyframeDeleted'), 'info', undoAction);
    return;
  }
  const p = s.project;
  const c = p?.clips.find((x) => x.id === s.selected);
  if (!p || !c) {
    s.notify(tr('act.selectClipFirst'));
    return;
  }
  const onMain = c.trackId === mainTrackId(p) && (c.kind === 'video' || c.kind === 'image');
  const isLast = onMain && !p.clips.some((x) => x.trackId === c.trackId && x.id !== c.id);
  if (onMain && !keepGap && !isLast) {
    s.run({ op: 'ripple_delete', clipId: c.id });
    s.notify(tr('act.rangeDeletedJoined'), 'info', undoAction);
  } else {
    s.run({ op: 'delete', clipId: c.id });
    s.notify(tr('act.deleted'), 'info', undoAction);
  }
  s.select(null);
}

export function duplicateSelected(at?: number, sourceId?: string) {
  const s = st();
  const id = sourceId ?? s.selected;
  if (!id || !s.project?.clips.some((c) => c.id === id)) {
    s.notify(sourceId ? tr('act.copiedGone') : tr('act.selectClipFirst'));
    return;
  }
  const newId = uid('c_');
  s.run({ op: 'duplicate', clipId: id, id: newId, ...(at !== undefined ? { start: at } : {}) });
  s.select(newId);
}

/** Deletes the marked range (start / end marks) from the whole video and closes the gap. */
export function cutInOut() {
  const s = st();
  const p = s.project;
  if (!p || p.inPoint === null || p.outPoint === null) {
    s.notify(tr('act.markRangeFirst'));
    return;
  }
  const start = p.inPoint;
  s.run({ op: 'cut_range', start, end: p.outPoint });
  s.seek(start);
  s.notify(tr('act.rangeDeleted'), 'info', undoAction);
}

/** The video / image clips that come from the same source file(s) as `clip` - "the whole video". */
export function siblingsOf(p: Project, clip: Clip): Clip[] {
  return p.clips.filter((c) => (c.kind === 'video' || c.kind === 'image') && (c.trackId === clip.trackId || c.mediaId === clip.mediaId));
}

/** Applies picture settings to every part of the video (after splits, the parts are separate clips). */
export function applyFxToAll(clip: Clip, fx: Partial<ClipFx>) {
  const s = st();
  const p = s.project;
  if (!p) return;
  const all = siblingsOf(p, clip);
  s.run(all.map((c) => ({ op: 'set_fx', clipId: c.id, fx }) as Op));
  s.notify(all.length > 1 ? tr('act.appliedAll', { n: all.length }) : tr('act.applied'));
}

export const totalDuration = () => {
  const p = st().project;
  return p ? projectDuration(p) : 0;
};
