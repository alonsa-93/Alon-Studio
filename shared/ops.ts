import {
  ASPECTS,
  BLEND_MODES,
  EASES,
  TRANSITION_TYPES,
  type BlendMode,
  type Ease,
  type Keyframe,
  type MediaAsset,
  DEFAULT_CAPTION_STYLE,
  DEFAULT_TEXT_STYLE,
  CAPTION_PRESETS,
  TEXT_PRESETS,
  RESOLUTIONS,
  type Anim,
  type AnimType,
  type Aspect,
  type CaptionWord,
  type Clip,
  type ClipFx,
  type ClipKind,
  type Project,
  type TextStyle,
  type Track,
  type TrackKind,
  type TransitionType,
} from './types';
import { captionTokens, speedOf } from './fx';
import { poseAt, sliceKeys, sortedKeys, stretchKeys } from './motion';
import { CORNERS, LAYOUTS, LOGO_DEFAULTS, type Corner, type Layout, type Logo } from './layout';

export type Op =
  | { op: 'cut_range'; start: number; end: number; ripple?: boolean }
  | { op: 'split'; time: number; clipId?: string; newIds?: Record<string, string> }
  | { op: 'delete'; clipId?: string; clipIds?: string[]; ripple?: boolean }
  | { op: 'add_text'; text: string; start?: number; duration?: number; style?: Partial<TextStyle>; preset?: string; trackId?: string; id?: string }
  | { op: 'add_transition'; clipId: string; type: TransitionType | 'none'; duration?: number }
  | { op: 'add_music'; mediaId: string; start?: number; volume?: number; duration?: number; id?: string }
  | { op: 'set_aspect'; aspect: Aspect }
  | { op: 'add_clip'; mediaId: string; start?: number; trackId?: string; id?: string }
  | { op: 'move_clip'; clipId: string; start: number; trackId?: string }
  | { op: 'trim_clip'; clipId: string; start: number; duration: number; offset?: number }
  | { op: 'update_clip'; clipId: string; patch: Partial<Pick<Clip, 'text' | 'style' | 'volume' | 'fadeIn' | 'fadeOut'>> }
  | { op: 'set_animation'; clipId: string; in?: { type: AnimType | 'none'; duration?: number }; out?: { type: AnimType | 'none'; duration?: number } }
  | { op: 'set_settings'; name?: string; fps?: 30 | 60; width?: number; height?: number; background?: string }
  | { op: 'set_caption_style'; style?: Partial<TextStyle>; preset?: string }
  | { op: 'set_title_font'; font: string | null }
  | { op: 'add_track'; kind: TrackKind; name?: string; id?: string }
  | { op: 'delete_track'; trackId: string }
  | { op: 'set_in_out'; in?: number | null; out?: number | null }
  | { op: 'set_captions'; captions: { start: number; end: number; text: string; words?: CaptionWord[] }[] }
  | { op: 'set_fx'; clipId: string; fx: Partial<ClipFx> | null }
  | { op: 'set_speed'; clipId: string; speed: number; ripple?: boolean }
  | { op: 'duplicate'; clipId: string; start?: number; id?: string }
  | { op: 'detach_audio'; clipId: string; id?: string }
  | { op: 'set_track'; trackId: string; muted?: boolean; hidden?: boolean; name?: string }
  | { op: 'set_caption_animation'; type: AnimType | 'none'; duration?: number }
  | { op: 'ripple_delete'; clipId: string }
  | { op: 'remove_media'; mediaId: string }
  | { op: 'set_keyframe'; clipId: string; t: number; x?: number; y?: number; scale?: number; rotation?: number; opacity?: number; ease?: Ease }
  | { op: 'delete_keyframe'; clipId: string; t: number }
  | { op: 'clear_keyframes'; clipId: string }
  | { op: 'punch_in'; clipId: string; start: number; end: number; x?: number; y?: number; scale?: number; ramp?: number; ease?: Ease }
  | { op: 'insert_clip'; mediaId: string; time: number; trackId?: string; id?: string }
  | { op: 'move_clip_to_new_track'; clipId: string; position?: 'above' | 'below'; id?: string }
  | { op: 'set_layout'; layout: Layout }
  | { op: 'set_logo'; logo: (Partial<Logo> & { mediaId?: string }) | null };

export const OP_NAMES = [
  'cut_range', 'split', 'delete', 'add_text', 'add_transition', 'add_music', 'set_aspect',
  'add_clip', 'move_clip', 'trim_clip', 'update_clip', 'set_animation', 'set_settings',
  'set_caption_style', 'add_track', 'delete_track', 'set_in_out', 'set_captions', 'remove_media',
  'set_fx', 'set_speed', 'duplicate', 'detach_audio', 'set_track', 'set_caption_animation', 'ripple_delete',
  'set_keyframe', 'delete_keyframe', 'clear_keyframes', 'punch_in', 'insert_clip', 'move_clip_to_new_track',
  'set_layout', 'set_logo', 'set_title_font',
] as const;

const EPS = 0.01;
const r3 = (n: number) => Math.round(n * 1000) / 1000;

export function uid(prefix = ''): string {
  return prefix + Math.random().toString(36).slice(2, 10);
}

export function newProject(id: string, name: string): Project {
  return {
    id,
    name,
    rev: 0,
    updatedAt: new Date().toISOString(),
    settings: { aspect: '9:16', width: 1080, height: 1920, fps: 30 },
    media: [],
    tracks: [
      { id: 't_text', kind: 'text', name: 'טקסט' },
      { id: 't_captions', kind: 'text', name: 'כתוביות', captions: true },
      { id: 't_video', kind: 'video', name: 'וידאו' },
      { id: 't_audio', kind: 'audio', name: 'אודיו' },
    ],
    clips: [],
    captionStyle: { ...DEFAULT_CAPTION_STYLE },
    inPoint: null,
    outPoint: null,
  };
}

export function projectDuration(p: Project): number {
  let d = 0;
  for (const c of p.clips) d = Math.max(d, c.start + c.duration);
  return r3(d);
}

export function trackKindFor(kind: ClipKind): TrackKind {
  if (kind === 'video' || kind === 'image') return 'video';
  if (kind === 'audio') return 'audio';
  return 'text';
}

export function textStyleOf(p: Project, clip: Clip): TextStyle {
  return clip.kind === 'caption'
    ? { ...p.captionStyle, ...clip.style }
    : { ...DEFAULT_TEXT_STYLE, ...clip.style };
}

function fail(msg: string): never {
  throw new Error(msg);
}
function num(v: unknown, name: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(`"${name}" must be a number`);
  return v as number;
}
function getClip(p: Project, id: string): Clip {
  return p.clips.find((c) => c.id === id) ?? fail(`clip not found: ${id}`);
}

function isFree(p: Project, trackId: string, start: number, duration: number, ignore?: string): boolean {
  return !p.clips.some(
    (c) => c.trackId === trackId && c.id !== ignore && c.start < start + duration - EPS && c.start + c.duration > start + EPS,
  );
}

function trackEnd(p: Project, trackId: string): number {
  let e = 0;
  for (const c of p.clips) if (c.trackId === trackId) e = Math.max(e, c.start + c.duration);
  return e;
}

function addTrack(p: Project, kind: TrackKind, name?: string, id?: string): Track {
  const count = p.tracks.filter((t) => t.kind === kind && !t.captions).length;
  const base = kind === 'video' ? 'וידאו' : kind === 'text' ? 'טקסט' : 'אודיו';
  const track: Track = { id: id ?? uid('t_'), kind, name: name ?? `${base} ${count + 1}` };
  if (kind === 'audio') p.tracks.push(track);
  else if (kind === 'text') p.tracks.unshift(track);
  else {
    const i = p.tracks.findIndex((t) => t.kind === 'video');
    p.tracks.splice(i < 0 ? p.tracks.length : i, 0, track);
  }
  return track;
}

/** A track of `kind` free in the given range (creating one when all are busy). */
function freeTrack(p: Project, kind: TrackKind, start: number, duration: number, preferred?: string): Track {
  if (preferred) {
    const t = p.tracks.find((x) => x.id === preferred) ?? fail(`track not found: ${preferred}`);
    if (t.kind !== kind) fail(`track ${preferred} is a ${t.kind} track, expected ${kind}`);
    return t;
  }
  const candidates = p.tracks.filter((t) => t.kind === kind && !t.captions);
  return candidates.find((t) => isFree(p, t.id, start, duration)) ?? addTrack(p, kind);
}

function maxSourceDuration(p: Project, clip: Clip): number {
  if (clip.kind !== 'video' && clip.kind !== 'audio') return Infinity;
  const m = p.media.find((x) => x.id === clip.mediaId);
  return m && m.duration > 0 ? m.duration : Infinity;
}

const HEX = /^#[0-9a-f]{6}$/i;
const clampN = (v: unknown, lo: number, hi: number, name: string) => Math.max(lo, Math.min(hi, num(v, name)));

function cleanFx(fx: Partial<ClipFx>): ClipFx {
  const o: ClipFx = {};
  if (fx.fit !== undefined) o.fit = fx.fit === 'cover' ? 'cover' : 'contain';
  if (fx.scale !== undefined) o.scale = clampN(fx.scale, 0.1, 4, 'scale');
  if (fx.posX !== undefined) o.posX = clampN(fx.posX, -1.5, 1.5, 'posX');
  if (fx.posY !== undefined) o.posY = clampN(fx.posY, -1.5, 1.5, 'posY');
  if (fx.opacity !== undefined) o.opacity = clampN(fx.opacity, 0, 1, 'opacity');
  if (fx.flip !== undefined) o.flip = !!fx.flip;
  if (fx.look !== undefined) {
    if (typeof fx.look !== 'string' || !/^[a-z0-9_-]{0,24}$/i.test(fx.look)) fail('fx.look must be a look id');
    o.look = fx.look;
  }
  if (fx.brightness !== undefined) o.brightness = clampN(fx.brightness, 0.3, 2, 'brightness');
  if (fx.contrast !== undefined) o.contrast = clampN(fx.contrast, 0.3, 2, 'contrast');
  if (fx.saturation !== undefined) o.saturation = clampN(fx.saturation, 0, 3, 'saturation');
  if (fx.temperature !== undefined) o.temperature = clampN(fx.temperature, -1, 1, 'temperature');
  if (fx.sepia !== undefined) o.sepia = clampN(fx.sepia, 0, 1, 'sepia');
  if (fx.blur !== undefined) o.blur = clampN(fx.blur, 0, 80, 'blur');
  if (fx.rotation !== undefined) o.rotation = clampN(fx.rotation, -180, 180, 'rotation');
  if (fx.blend !== undefined) {
    if (!BLEND_MODES.includes(fx.blend as BlendMode)) fail(`blend must be one of ${BLEND_MODES.join(', ')}`);
    o.blend = fx.blend;
  }
  return o;
}

/** Limits of the keyframe values (same as the fixed picture settings). */
function cleanKey(k: Record<string, unknown>, dur: number): Keyframe {
  if (!k || typeof k !== 'object') fail('a keyframe must be an object');
  const e = k.ease ?? 'linear';
  if (!EASES.includes(e as Ease)) fail(`ease must be one of ${EASES.join(', ')}`);
  return {
    t: r3(clampN(k.t, 0, dur, 't')),
    x: clampN(k.x, -1.5, 1.5, 'x'),
    y: clampN(k.y, -1.5, 1.5, 'y'),
    scale: clampN(k.scale, 0.1, 4, 'scale'),
    rotation: clampN(k.rotation, -720, 720, 'rotation'),
    opacity: clampN(k.opacity, 0, 1, 'opacity'),
    ease: e as Ease,
  };
}
const MAX_KEYS = 200;
/** Two keyframes closer than this are the same point in time. */
const KEY_SNAP = 0.02;
const visualClip = (c: Clip) => c.kind === 'video' || c.kind === 'image';
/** Keeps a clip's keyframes in step after its start / length changed (local [from, to] of the old clip). */
function reKey(c: Clip, from: number, to: number) {
  if (!c.keyframes?.length) return;
  c.keyframes = sliceKeys(c, from, to);
}

/** Keeps the composition identical when the frame size changes: text sizes and blur are in pixels. */
function rescale(p: Project, k: number) {
  if (!Number.isFinite(k) || Math.abs(k - 1) < 0.001) return;
  p.captionStyle = { ...p.captionStyle, size: Math.max(8, Math.round(p.captionStyle.size * k)) };
  for (const c of p.clips) {
    if (c.kind === 'text') c.style = { ...c.style, size: Math.max(8, Math.round((c.style?.size ?? DEFAULT_TEXT_STYLE.size) * k)) };
    else if (c.style?.size) c.style = { ...c.style, size: Math.max(8, Math.round(c.style.size * k)) };
    if (c.fx?.blur) c.fx = { ...c.fx, blur: Math.round(c.fx.blur * k * 10) / 10 };
  }
}

const keysOf = (c: Clip, from: number, to: number) => (c.keyframes?.length ? { keyframes: sliceKeys(c, from, to) } : {});

function cutRange(p: Project, s: number, e: number, ripple: boolean) {
  const len = e - s;
  const out: Clip[] = [];
  for (const c of p.clips) {
    const cs = c.start;
    const ce = c.start + c.duration;
    if (ce <= s + EPS) {
      out.push(c);
    } else if (cs >= e - EPS) {
      out.push(ripple ? { ...c, start: r3(Math.max(0, cs - len)) } : c);
    } else if (cs >= s - EPS && ce <= e + EPS) {
      // fully inside the range: removed
    } else if (cs < s && ce > e) {
      out.push({ ...c, duration: r3(s - cs), animOut: null, words: undefined, ...keysOf(c, 0, s - cs) });
      out.push({
        ...c,
        id: uid('c_'),
        start: r3(ripple ? s : e),
        offset: r3(c.offset + (c.kind === 'caption' ? 1 : (e - cs) * speedOf(c))),
        duration: r3(ce - e),
        animIn: null,
        transition: null,
        words: undefined,
        ...keysOf(c, e - cs, ce - cs),
      });
    } else if (cs < s) {
      out.push({ ...c, duration: r3(s - cs), animOut: null, words: undefined, ...keysOf(c, 0, s - cs) });
    } else {
      out.push({
        ...c,
        start: r3(ripple ? s : e),
        offset: r3(c.offset + (c.kind === 'caption' ? 1 : (e - cs) * speedOf(c))),
        duration: r3(ce - e),
        animIn: null,
        transition: null,
        words: undefined,
        ...keysOf(c, e - cs, ce - cs),
      });
    }
  }
  // captions: each piece keeps only the words spoken inside it
  const before = new Map(p.clips.map((c) => [c.id, c]));
  const kept: Clip[] = [];
  for (const c of out) {
    const orig = before.get(c.id) ?? p.clips.find((o) => o.kind === 'caption' && o.trackId === c.trackId && o.text === c.text && o.start <= s && o.start + o.duration >= e);
    const changed = !orig || orig.duration !== c.duration;
    if (changed && c.kind === 'caption' && orig?.text) {
      const isRight = c.offset > orig.offset + EPS || (ripple ? c.start >= s - EPS && orig.start < s - EPS : c.start >= e - EPS);
      const lo = isRight ? e - orig.start : 0;
      const hi = isRight ? Infinity : s - orig.start;
      const words = captionTokens(orig).filter((t) => t.word && (t.s + t.e) / 2 >= lo && (t.s + t.e) / 2 < hi);
      if (!words.length) continue;
      c.text = words.map((t) => t.text).join(' ');
      c.words = words.map((t) => ({ s: r3(Math.max(0, t.s - lo)), e: r3(Math.max(0, Math.min(t.e, hi) - lo)), w: t.text }));
      c.offset = 0;
    }
    // pieces shorter than a few frames are noise, not clips
    if (changed && c.duration < 0.1) continue;
    kept.push(c);
  }
  p.clips = kept;
}

function normAnim(a: { type: AnimType | 'none'; duration?: number } | undefined, cur: Anim | null | undefined): Anim | null | undefined {
  if (a === undefined) return cur;
  if (!a || a.type === 'none') return null;
  if (!['fade', 'slide', 'zoom', 'pop', 'typewriter'].includes(a.type)) fail(`unknown animation: ${a.type}`);
  const d = typeof a.duration === 'number' && Number.isFinite(a.duration) ? a.duration : 0.5;
  return { type: a.type, duration: Math.max(0.1, Math.min(5, d)) };
}

const MAX_T = 24 * 3600;
const TIME_KEYS = ['start', 'end', 'time', 'in', 'out', 'offset'];

/** Rejects non-numeric / absurd numbers before they can reach the project state. */
function checkNumbers(o: Record<string, unknown>, where = '') {
  for (const [k, v] of Object.entries(o)) {
    if (v === null || v === undefined || typeof v === 'object') continue;
    const name = where + k;
    if (TIME_KEYS.includes(k)) {
      if (typeof v !== 'number' || !Number.isFinite(v)) fail(`"${name}" must be a number of seconds`);
      if ((v as number) > MAX_T) fail(`"${name}" is too large (max ${MAX_T} seconds)`);
    } else if (k === 'duration' || k === 'fadeIn' || k === 'fadeOut') {
      if (typeof v !== 'number' || !Number.isFinite(v)) fail(`"${name}" must be a number of seconds`);
      if ((v as number) < 0 || (k === 'duration' && (v as number) <= 0)) fail(`"${name}" must be positive`);
      if ((v as number) > MAX_T) fail(`"${name}" is too large`);
    } else if (k === 'volume' || k === 'speed' || k === 'width' || k === 'height') {
      if (typeof v !== 'number' || !Number.isFinite(v)) fail(`"${name}" must be a number`);
    }
  }
}

export const FONT_OK = /^[A-Za-z0-9 _-]{1,40}$/;

/** Licence / source of a re-added media entry (undo of a removal): plain text and http(s) links only. */
function cleanCredit(m: { credit?: unknown; source?: unknown }): Pick<MediaAsset, 'credit' | 'source'> {
  const s = (v: unknown, max = 200) => (typeof v === 'string' && v.trim() ? v.slice(0, max) : undefined);
  const link = (v: unknown) => (typeof v === 'string' && /^https?:\/\//i.test(v) ? v.slice(0, 2000) : undefined);
  const out: Pick<MediaAsset, 'credit' | 'source'> = {};
  const c = m.credit as Record<string, unknown> | undefined;
  if (c && typeof c === 'object' && s(c.provider) && s(c.license)) {
    out.credit = { provider: s(c.provider, 40)!, license: s(c.license, 80)! };
    for (const k of ['title', 'author'] as const) if (s(c[k])) out.credit[k] = s(c[k]);
    for (const k of ['authorUrl', 'licenseUrl', 'sourceUrl'] as const) if (link(c[k])) out.credit[k] = link(c[k]);
  }
  if (link(m.source)) out.source = link(m.source);
  return out;
}

/** A preset's style by id (text or caption list); an unknown id is an error that lists the ids. */
function presetStyle(list: { id: string; style: Partial<TextStyle> }[], id: unknown): Partial<TextStyle> {
  const p = list.find((x) => x.id === id);
  return p ? { ...p.style } : fail(`unknown preset: ${String(id).slice(0, 40)}. Available: ${list.map((x) => x.id).join(', ')}`);
}

function cleanStyle(style: unknown): Partial<TextStyle> {
  if (!style || typeof style !== 'object' || Array.isArray(style)) fail('"style" must be an object');
  const st = style as Record<string, unknown>;
  const o: Partial<TextStyle> = {};
  const hex = (v: unknown, name: string) => (typeof v === 'string' && HEX.test(v) ? v.toLowerCase() : fail(`"${name}" must be a #rrggbb colour`));
  if (st.font !== undefined) o.font = typeof st.font === 'string' && FONT_OK.test(st.font) ? st.font : fail('"font" must be a font name');
  if (st.size !== undefined) o.size = Math.round(clampN(st.size, 8, 800, 'size'));
  if (st.color !== undefined) o.color = hex(st.color, 'color');
  if (st.bg !== undefined) o.bg = st.bg === null ? null : hex(st.bg, 'bg');
  if (st.bold !== undefined) o.bold = !!st.bold;
  if (st.x !== undefined) o.x = clampN(st.x, 0, 1, 'x');
  if (st.y !== undefined) o.y = clampN(st.y, 0, 1, 'y');
  if (st.outline !== undefined) o.outline = hex(st.outline, 'outline');
  if (st.highlight !== undefined) o.highlight = st.highlight === null ? null : hex(st.highlight, 'highlight');
  return o;
}

const MEDIA_FILE = /^m_[a-z0-9]{6,16}(_thumb\.jpg|_proxy\.mp4|_wave\.png|\.[a-z0-9]{1,5})$/;
export const isMediaFileName = (f: unknown) => typeof f === 'string' && MEDIA_FILE.test(f);

/**
 * Validates and cleans a whole project state sent by a client (undo / redo replaces the state at once),
 * with the same rules as the individual operations. Throws on anything that cannot be cleaned.
 */
export function sanitizeState(
  b: Partial<Project>,
  knownMedia: Project['media'],
): Pick<Project, 'name' | 'settings' | 'tracks' | 'clips' | 'captionStyle' | 'inPoint' | 'outPoint' | 'background' | 'captionAnim' | 'layout' | 'logo' | 'titleFont'> & { media: Project['media'] } {
  if (!b || typeof b !== 'object') fail('state must be an object');
  const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  const s = b.settings as ProjectSettingsLike;
  if (!s || typeof s !== 'object' || !fin(s.width) || !fin(s.height) || s.width < 64 || s.height < 64 || s.width > 4096 || s.height > 4096 || (s.fps !== 30 && s.fps !== 60) || !ASPECTS.includes(s.aspect)) fail('invalid settings');
  if (!Array.isArray(b.tracks) || !Array.isArray(b.clips) || b.tracks.length > 50 || b.clips.length > 5000) fail('tracks and clips are required');
  // media: only entries the project knows already, or re-added ones whose files follow the server's naming
  const media: Project['media'] = [];
  for (const m of Array.isArray(b.media) ? b.media : []) {
    if (!m || typeof m !== 'object' || typeof m.id !== 'string') continue;
    const known = knownMedia.find((k) => k.id === m.id);
    if (known) media.push(known);
    else if (/^m_[a-z0-9]{6,16}$/.test(m.id) && isMediaFileName(m.file) && [m.thumb, m.proxy, m.wave].every((x) => x === undefined || isMediaFileName(x)) && ['video', 'image', 'audio'].includes(m.kind) && fin(m.duration)) {
      media.push({ id: m.id, name: String(m.name ?? '').slice(0, 200), kind: m.kind, file: m.file, ...(m.thumb ? { thumb: m.thumb } : {}), ...(m.proxy ? { proxy: m.proxy } : {}), ...(m.wave ? { wave: m.wave } : {}), duration: m.duration, width: fin(m.width) ? m.width : undefined, height: fin(m.height) ? m.height : undefined, hasAudio: !!m.hasAudio, ...(typeof m.libraryId === 'string' ? { libraryId: m.libraryId.slice(0, 40) } : {}), ...cleanCredit(m) });
    }
  }
  const allMedia = [...knownMedia, ...media.filter((m) => !knownMedia.some((k) => k.id === m.id))];
  const tracks: Track[] = [];
  for (const t of b.tracks) {
    if (!t || typeof t !== 'object' || typeof t.id !== 'string' || !/^[A-Za-z0-9_-]{1,48}$/.test(t.id) || !['video', 'text', 'audio'].includes(t.kind) || tracks.some((x) => x.id === t.id)) fail('invalid tracks');
    if (t.name !== undefined && typeof t.name !== 'string') fail('a track name must be text');
    tracks.push({ id: t.id, kind: t.kind, name: (t.name ?? '').slice(0, 40), ...(t.captions ? { captions: true } : {}), ...(t.muted ? { muted: true } : {}), ...(t.hidden ? { hidden: true } : {}) });
  }
  const clips: Clip[] = [];
  for (const c of b.clips) {
    if (!c || typeof c !== 'object' || typeof c.id !== 'string' || !/^[A-Za-z0-9_-]{1,48}$/.test(c.id) || clips.some((x) => x.id === c.id)) fail('invalid clip id');
    const track = tracks.find((t) => t.id === c.trackId);
    if (!track || !['video', 'image', 'audio', 'text', 'caption'].includes(c.kind) || trackKindFor(c.kind) !== track.kind) fail(`clip ${c.id}: wrong track or kind`);
    if (!fin(c.start) || c.start < 0 || c.start > MAX_T || !fin(c.duration) || c.duration <= 0 || c.duration > MAX_T || !fin(c.offset) || c.offset < 0 || !fin(c.volume)) fail(`clip ${c.id}: invalid timing`);
    const out: Clip = { id: c.id, trackId: c.trackId, kind: c.kind, start: c.start, duration: c.duration, offset: c.offset, volume: Math.max(0, Math.min(2, c.volume)) };
    if (c.mediaId !== undefined) {
      if (!allMedia.some((m) => m.id === c.mediaId)) fail(`clip ${c.id}: unknown media`);
      out.mediaId = c.mediaId;
    } else if (c.kind === 'video' || c.kind === 'image' || c.kind === 'audio') fail(`clip ${c.id}: media missing`);
    if (c.text !== undefined) {
      if (typeof c.text !== 'string') fail(`clip ${c.id}: text must be text`);
      out.text = c.text.slice(0, 2000);
    }
    if (c.style !== undefined) out.style = cleanStyle(c.style);
    if (c.fx !== undefined && c.fx !== null) out.fx = cleanFx(c.fx);
    if (c.fadeIn !== undefined) out.fadeIn = clampN(c.fadeIn, 0, 60, 'fadeIn');
    if (c.fadeOut !== undefined) out.fadeOut = clampN(c.fadeOut, 0, 60, 'fadeOut');
    if (c.speed !== undefined) out.speed = clampN(c.speed, 0.25, 4, 'speed');
    if (c.music) out.music = true;
    const anim = (a: unknown) => (a && typeof a === 'object' ? normAnim(a as { type: AnimType; duration?: number }, null) ?? null : null);
    if (c.animIn) out.animIn = anim(c.animIn);
    if (c.animOut) out.animOut = anim(c.animOut);
    if (c.transition) {
      const t = c.transition as { type: unknown; duration: unknown };
      if (!TRANSITION_TYPES.includes(t.type as TransitionType)) fail(`clip ${c.id}: unknown transition`);
      out.transition = { type: t.type as TransitionType, duration: clampN(t.duration, 0.1, 3, 'transition') };
    }
    if (Array.isArray(c.words) && c.words.every((w) => w && fin(w.s) && fin(w.e) && typeof w.w === 'string')) out.words = c.words.slice(0, 200).map((w) => ({ s: w.s, e: w.e, w: w.w.slice(0, 80) }));
    if (Array.isArray(c.keyframes) && c.keyframes.length && visualClip(out)) out.keyframes = sortedKeys(c.keyframes.slice(0, MAX_KEYS).map((k) => cleanKey(k as unknown as Record<string, unknown>, out.duration)));
    if (out.animIn?.type === 'typewriter' && out.kind !== 'text' && out.kind !== 'caption') out.animIn = null;
    if (out.animOut?.type === 'typewriter') out.animOut = null;
    clips.push(out);
  }
  const point = (v: unknown) => (v === null || v === undefined ? null : fin(v) && v >= 0 && v <= MAX_T ? v : fail('invalid in / out point'));
  const capAnim = b.captionAnim && typeof b.captionAnim === 'object' ? normAnim(b.captionAnim as { type: AnimType; duration?: number }, null) ?? null : null;
  return {
    name: typeof b.name === 'string' ? b.name.slice(0, 120) : 'פרויקט',
    settings: { aspect: s.aspect, width: Math.round(s.width / 2) * 2, height: Math.round(s.height / 2) * 2, fps: s.fps },
    tracks,
    clips,
    captionStyle: { ...DEFAULT_CAPTION_STYLE, ...(b.captionStyle ? cleanStyle(b.captionStyle) : {}) },
    inPoint: point(b.inPoint),
    outPoint: point(b.outPoint),
    background: b.background && HEX.test(b.background) ? b.background : '#000000',
    captionAnim: capAnim,
    layout: LAYOUTS.includes(b.layout as Layout) && b.layout !== 'single' ? b.layout : undefined,
    logo: b.logo && typeof b.logo === 'object' ? (() => { try { return cleanLogo(b.logo, allMedia, null); } catch { return undefined; } })() : undefined,
    titleFont: typeof b.titleFont === 'string' && FONT_OK.test(b.titleFont) ? b.titleFont : undefined,
    media,
  };
}

export type EditableState = Pick<Project, 'name' | 'settings' | 'tracks' | 'clips' | 'captionStyle' | 'inPoint' | 'outPoint' | 'media' | 'background' | 'captionAnim' | 'layout' | 'logo' | 'titleFont'>;
/** The state an undo step restores. Every project-wide setting must be here: the server replaces what is missing with its default. */
export const editableState = (p: Project): EditableState => ({
  name: p.name,
  settings: p.settings,
  tracks: p.tracks,
  clips: p.clips,
  captionStyle: p.captionStyle,
  inPoint: p.inPoint,
  outPoint: p.outPoint,
  media: p.media,
  background: p.background ?? '#000000',
  captionAnim: p.captionAnim ?? null,
  layout: p.layout ?? 'single',
  logo: p.logo ?? null,
  titleFont: p.titleFont ?? '',
});

/** A logo setting: its media must be a picture of the project; numbers are clamped. `prev` fills what is missing. */
export function cleanLogo(l: Partial<Logo>, media: Project['media'], prev: Logo | null | undefined): Logo {
  const mediaId = l.mediaId ?? prev?.mediaId;
  const m = media.find((x) => x.id === mediaId);
  if (!m) fail('logo: mediaId must be a picture in the project');
  if (m.kind !== 'image') fail('logo: the media must be a picture (PNG, JPG, WEBP)');
  const base = { ...LOGO_DEFAULTS, ...(prev ?? {}) };
  const corner = l.corner ?? base.corner;
  if (!CORNERS.includes(corner as Corner)) fail(`logo: corner must be one of ${CORNERS.join(', ')}`);
  return {
    mediaId: m.id,
    corner,
    size: l.size === undefined ? base.size : clampN(l.size, 0.03, 0.5, 'logo size'),
    opacity: l.opacity === undefined ? base.opacity : clampN(l.opacity, 0, 1, 'logo opacity'),
    margin: l.margin === undefined ? base.margin : clampN(l.margin, 0, 0.2, 'logo margin'),
  };
}
type ProjectSettingsLike = { aspect: Aspect; width: number; height: number; fps: 30 | 60 };

/** Applies one operation and returns a new project (the input is not mutated). */
/** Ids of caption clips that were made from this media: they sit over its (non-music) video/audio
 *  clips and over no other sound clip, so removing the media would leave them showing over nothing. */
export function captionsTiedTo(p: Project, mediaId: string): string[] {
  const speech = (c: Clip) => (c.kind === 'video' || c.kind === 'audio') && !c.music;
  const overlaps = (a: Clip, b: Clip) => a.start < b.start + b.duration - EPS && b.start < a.start + a.duration - EPS;
  const own = p.clips.filter((c) => speech(c) && c.mediaId === mediaId);
  if (!own.length) return [];
  const others = p.clips.filter((c) => speech(c) && c.mediaId !== mediaId);
  return p.clips
    .filter((c) => c.kind === 'caption' && own.some((o) => overlaps(c, o)) && !others.some((o) => overlaps(c, o)))
    .map((c) => c.id);
}

export function applyOp(project: Project, op: Op): Project {
  if (!op || typeof op !== 'object' || Array.isArray(op)) fail('an op must be an object like {"op": "split", "time": 3}');
  const p: Project = structuredClone(project);
  checkNumbers(op as unknown as Record<string, unknown>);
  for (const key of ['in', 'out', 'patch'] as const) {
    const nested = (op as unknown as Record<string, unknown>)[key];
    if (nested && typeof nested === 'object') checkNumbers(nested as Record<string, unknown>, key + '.');
  }
  const newId = (op as { id?: unknown }).id;
  if (newId !== undefined) {
    if (typeof newId !== 'string' || !/^[A-Za-z0-9_-]{1,48}$/.test(newId)) fail('"id" must be a short string (letters, digits, _ and -)');
    if (p.clips.some((c) => c.id === newId) || p.tracks.some((t) => t.id === newId)) fail(`id already in use: ${newId}`);
  }
  switch (op.op) {
    case 'cut_range': {
      const s = Math.max(0, num(op.start, 'start'));
      const e = num(op.end, 'end');
      if (e - s < EPS) fail('"end" must be greater than "start"');
      cutRange(p, s, e, op.ripple !== false);
      if (op.ripple !== false) {
        p.inPoint = null;
        p.outPoint = null;
      }
      break;
    }
    case 'split': {
      const t = num(op.time, 'time');
      const targets = p.clips.filter(
        (c) => (!op.clipId || c.id === op.clipId) && c.start < t - EPS && c.start + c.duration > t + EPS,
      );
      if (op.clipId && !targets.length) fail('the split time is outside the clip');
      for (const c of targets) {
        const right: Clip = {
          ...structuredClone(c),
          id: op.newIds?.[c.id] ?? uid('c_'),
          start: r3(t),
          offset: r3(c.offset + (t - c.start) * speedOf(c)),
          words: c.words?.filter((w) => w.s >= t - c.start - 0.01).map((w) => ({ ...w, s: r3(w.s - (t - c.start)), e: r3(w.e - (t - c.start)) })),
          duration: r3(c.start + c.duration - t),
          animIn: null,
          transition: null,
          fadeIn: undefined,
          ...keysOf(c, t - c.start, c.duration),
        };
        if (c.keyframes?.length) c.keyframes = sliceKeys(c, 0, t - c.start);
        if (c.words) {
          c.words = c.words.filter((w) => w.s < t - c.start - 0.01);
          if (c.words.length && right.words?.length) {
            right.text = right.words.map((w) => w.w).join(' ');
            c.text = c.words.map((w) => w.w).join(' ');
          } else {
            c.words = undefined;
            right.words = undefined;
          }
        }
        c.duration = r3(t - c.start);
        c.animOut = null;
        c.fadeOut = undefined;
        p.clips.push(right);
      }
      break;
    }
    case 'ripple_delete': {
      // Removes the clip's time span from the whole video: later clips on every track move left,
      // text and captions over that span go with it. Background music is not cut (that would make it
      // jump); it simply ends earlier, so it still lasts as long as the video.
      const c = getClip(p, op.clipId);
      const s0 = c.start;
      const e0 = c.start + c.duration;
      const len = e0 - s0;
      const music = p.clips.filter((x) => x.music);
      p.clips = p.clips.filter((x) => !x.music);
      cutRange(p, s0, e0, true);
      for (const m of music) {
        const ms = m.start;
        const me = m.start + m.duration;
        if (ms >= e0 - EPS) m.start = r3(Math.max(0, ms - len));
        else if (me > s0 + EPS) m.duration = r3(Math.max(0.1, m.duration - (Math.min(me, e0) - Math.max(ms, s0))));
      }
      p.clips.push(...music);
      p.inPoint = null;
      p.outPoint = null;
      break;
    }
    case 'delete': {
      const ids = new Set([...(op.clipIds ?? []), ...(op.clipId ? [op.clipId] : [])]);
      if (!ids.size) fail('"clipId" is required');
      for (const id of ids) getClip(p, id);
      const removed = p.clips.filter((c) => ids.has(c.id)).sort((a, b) => b.start - a.start);
      p.clips = p.clips.filter((c) => !ids.has(c.id));
      if (op.ripple) {
        for (const r of removed) {
          for (const c of p.clips) {
            if (c.trackId === r.trackId && c.start >= r.start + r.duration - EPS) c.start = r3(c.start - r.duration);
          }
        }
      }
      break;
    }
    case 'add_text': {
      if (typeof op.text !== 'string' || !op.text.trim()) fail('"text" is required');
      const start = Math.max(0, op.start ?? 0);
      const duration = Math.max(0.1, op.duration ?? 3);
      if (op.trackId !== undefined && typeof op.trackId !== 'string') fail('"trackId" must be a string');
      const track = freeTrack(p, 'text', start, duration, op.trackId);
      p.clips.push({
        id: op.id ?? uid('c_'),
        trackId: track.id,
        kind: track.captions ? 'caption' : 'text',
        start: r3(start),
        duration: r3(duration),
        offset: 0,
        text: op.text,
        style: (() => {
          const st = { ...(op.preset !== undefined ? presetStyle(TEXT_PRESETS, op.preset) : {}), ...(op.style ? cleanStyle(op.style) : {}) };
          if (st.font === undefined && p.titleFont && !track.captions) st.font = p.titleFont;
          return st;
        })(),
        volume: 1,
      });
      break;
    }
    case 'add_transition': {
      const c = getClip(p, op.clipId);
      if (c.kind !== 'video' && c.kind !== 'image') fail('transitions apply to video / image clips');
      if (op.type === 'none') c.transition = null;
      else {
        if (!TRANSITION_TYPES.includes(op.type)) fail(`unknown transition: ${op.type}. Supported: ${TRANSITION_TYPES.join(', ')}`);
        c.transition = { type: op.type, duration: Math.max(0.1, Math.min(3, op.duration ?? 0.5)) };
      }
      break;
    }
    case 'add_music':
    case 'add_clip': {
      const m = p.media.find((x) => x.id === op.mediaId) ?? fail(`media not found: ${op.mediaId}`);
      const music = op.op === 'add_music';
      if (music && m.kind === 'image') fail('add_music needs an audio or video asset');
      const kind: ClipKind = music ? 'audio' : m.kind;
      const tKind = trackKindFor(kind);
      const preferredId = op.op === 'add_clip' ? op.trackId : undefined;
      let duration = m.kind === 'image' ? 5 : m.duration;
      if (music && op.duration) duration = Math.min(duration, op.duration);
      let start = op.start;
      let track: Track;
      if (start === undefined) {
        track = preferredId ? freeTrack(p, tKind, 0, 0, preferredId) : p.tracks.find((t) => t.kind === tKind && !t.captions) ?? addTrack(p, tKind);
        start = music ? 0 : trackEnd(p, track.id);
        if (music && !isFree(p, track.id, start, duration)) track = freeTrack(p, tKind, start, duration);
      } else {
        start = Math.max(0, start);
        track = freeTrack(p, tKind, start, duration, preferredId);
      }
      p.clips.push({
        id: op.id ?? uid('c_'),
        trackId: track.id,
        kind,
        start: r3(start),
        duration: r3(duration),
        mediaId: m.id,
        offset: 0,
        volume: music ? Math.max(0, Math.min(2, op.volume ?? 0.5)) : 1,
        ...(music ? { music: true, ...(duration > 4 ? { fadeOut: Math.min(1.5, duration / 4) } : {}) } : {}),
      });
      break;
    }
    case 'set_aspect': {
      const list = (Object.hasOwn(RESOLUTIONS, String(op.aspect)) ? RESOLUTIONS[op.aspect] : null) ?? fail(`aspect must be one of ${ASPECTS.join(', ')}`);
      const short = Math.min(p.settings.width, p.settings.height);
      const res = list.find((r) => Math.min(r.width, r.height) === short) ?? list[1];
      rescale(p, Math.min(res.width, res.height) / short);
      p.settings = { ...p.settings, aspect: op.aspect, width: res.width, height: res.height };
      break;
    }
    case 'move_clip': {
      const c = getClip(p, op.clipId);
      c.start = r3(Math.max(0, num(op.start, 'start')));
      if (op.trackId && op.trackId !== c.trackId) {
        const t = p.tracks.find((x) => x.id === op.trackId) ?? fail(`track not found: ${op.trackId}`);
        if (t.kind !== trackKindFor(c.kind)) fail('the clip does not fit this track type');
        if (!!t.captions !== (c.kind === 'caption')) c.kind = t.captions ? 'caption' : c.kind === 'caption' ? 'text' : c.kind;
        c.trackId = t.id;
      }
      break;
    }
    case 'trim_clip': {
      const c = getClip(p, op.clipId);
      const before = { start: c.start, offset: c.offset };
      const offset = Math.max(0, op.offset ?? c.offset);
      const max = maxSourceDuration(p, c);
      c.offset = r3(Math.min(offset, Math.max(0, max - 0.05)));
      c.duration = r3(Math.max(0.05, Math.min(num(op.duration, 'duration'), (max - c.offset) / speedOf(c))));
      c.start = r3(Math.max(0, num(op.start, 'start')));
      // the picture keeps moving the same way under the new edges (images have no offset: their start moves)
      const shift = c.kind === 'video' ? (c.offset - before.offset) / speedOf(c) : c.start - before.start;
      reKey(c, shift, shift + c.duration);
      break;
    }
    case 'update_clip': {
      const c = getClip(p, op.clipId);
      const patch = op.patch ?? fail('"patch" is required');
      const textual = c.kind === 'text' || c.kind === 'caption';
      if ((patch.text !== undefined || patch.style !== undefined) && !textual) fail('text and style apply to text / caption clips');
      if (patch.text !== undefined) {
        if (typeof patch.text !== 'string' || !patch.text.trim()) fail('"text" must be a non-empty string');
        c.text = patch.text;
      }
      if (patch.style !== undefined) c.style = { ...c.style, ...cleanStyle(patch.style) };
      if (patch.volume !== undefined) c.volume = Math.max(0, Math.min(2, num(patch.volume, 'volume')));
      if (patch.fadeIn !== undefined) c.fadeIn = Math.max(0, patch.fadeIn);
      if (patch.fadeOut !== undefined) c.fadeOut = Math.max(0, patch.fadeOut);
      break;
    }
    case 'set_animation': {
      const c = getClip(p, op.clipId);
      if (c.kind === 'audio') fail('animations apply to visual clips');
      if (op.in?.type === 'typewriter' && c.kind !== 'text' && c.kind !== 'caption') fail('typewriter applies to text clips');
      if (op.out?.type === 'typewriter') fail('typewriter is an entry animation');
      c.animIn = normAnim(op.in, c.animIn);
      c.animOut = normAnim(op.out, c.animOut);
      break;
    }
    case 'set_settings': {
      if (op.name !== undefined) p.name = String(op.name).slice(0, 120) || p.name;
      if (op.background !== undefined) {
        if (!HEX.test(op.background)) fail('background must be a #rrggbb colour');
        p.background = op.background.toLowerCase();
      }
      if (op.fps !== undefined) {
        if (op.fps !== 30 && op.fps !== 60) fail('fps must be 30 or 60');
        p.settings.fps = op.fps;
      }
      if (op.width !== undefined || op.height !== undefined) {
        const w = Math.round(num(op.width, 'width') / 2) * 2;
        const h = Math.round(num(op.height, 'height') / 2) * 2;
        if (w < 64 || h < 64 || w > 4096 || h > 4096) fail('resolution out of range');
        const ok = (Object.keys(RESOLUTIONS) as Aspect[]).find((a) => {
          const [x, y] = a.split(':').map(Number);
          return Math.abs(w / h - x / y) < 0.01;
        });
        if (!ok) fail(`resolution must match one of ${ASPECTS.join(', ')}`);
        rescale(p, Math.min(w, h) / Math.min(p.settings.width, p.settings.height));
        p.settings = { ...p.settings, aspect: ok as Aspect, width: w, height: h };
      }
      break;
    }
    case 'set_caption_style':
      if (op.preset === undefined && op.style === undefined) fail('"style" or "preset" is required');
      p.captionStyle = { ...p.captionStyle, ...(op.preset !== undefined ? presetStyle(CAPTION_PRESETS, op.preset) : {}), ...(op.style !== undefined ? cleanStyle(op.style) : {}) };
      break;
    case 'set_title_font':
      if (op.font === null || op.font === '') p.titleFont = undefined;
      else if (typeof op.font === 'string' && FONT_OK.test(op.font)) p.titleFont = op.font;
      else fail('"font" must be a font name or null');
      break;
    case 'add_track':
      if (!['video', 'text', 'audio'].includes(op.kind)) fail('kind must be video, text or audio');
      addTrack(p, op.kind, op.name, op.id);
      break;
    case 'delete_track': {
      const t = p.tracks.find((x) => x.id === op.trackId) ?? fail(`track not found: ${op.trackId}`);
      if (t.captions) fail('the captions track cannot be removed');
      if (p.tracks.filter((x) => x.kind === t.kind && !x.captions).length <= 1) fail('the last track of a kind cannot be removed');
      p.tracks = p.tracks.filter((x) => x.id !== t.id);
      p.clips = p.clips.filter((c) => c.trackId !== t.id);
      break;
    }
    case 'set_in_out': {
      if (op.in !== undefined) p.inPoint = op.in === null ? null : r3(Math.max(0, op.in));
      if (op.out !== undefined) p.outPoint = op.out === null ? null : r3(Math.max(0, op.out));
      if (p.inPoint !== null && p.outPoint !== null && p.outPoint <= p.inPoint) {
        if (op.in !== undefined && op.out === undefined) p.outPoint = null;
        else p.inPoint = null;
      }
      break;
    }
    case 'set_captions': {
      let track = p.tracks.find((t) => t.captions);
      if (!track) {
        track = { id: 't_captions', kind: 'text', name: 'כתוביות', captions: true };
        p.tracks.unshift(track);
      }
      if (!Array.isArray(op.captions)) fail('"captions" must be an array of {start, end, text}');
      for (const cap of op.captions) {
        if (!cap || typeof cap !== 'object') fail('each caption must be an object {start, end, text}');
        if (typeof cap.start !== 'number' || typeof cap.end !== 'number' || !Number.isFinite(cap.start) || !Number.isFinite(cap.end)) fail('caption "start" and "end" must be numbers');
        if (cap.start < 0 || cap.end > MAX_T || cap.end <= cap.start) fail('caption times must satisfy 0 <= start < end');
        if (typeof cap.text !== 'string') fail('caption "text" must be a string');
        if (cap.words !== undefined) {
          const ok = Array.isArray(cap.words) && cap.words.every((w) => w && typeof w === 'object' && Number.isFinite(w.s) && Number.isFinite(w.e) && typeof w.w === 'string');
          if (!ok) cap.words = undefined;
        }
      }
      p.clips = p.clips.filter((c) => c.kind !== 'caption');
      for (const cap of op.captions) {
        if (!cap.text?.trim() || cap.end - cap.start < 0.05) continue;
        p.clips.push({
          id: uid('c_'),
          trackId: track.id,
          kind: 'caption',
          start: r3(cap.start),
          duration: r3(cap.end - cap.start),
          offset: 0,
          text: cap.text.trim(),
          volume: 1,
          ...(cap.words?.length ? { words: cap.words } : {}),
          ...(p.captionAnim ? { animIn: { ...p.captionAnim, duration: Math.min(p.captionAnim.duration, cap.end - cap.start) } } : {}),
        });
      }
      break;
    }
    case 'set_fx': {
      const c = getClip(p, op.clipId);
      if (c.kind !== 'video' && c.kind !== 'image') fail('picture settings apply to video / image clips');
      if (op.fx === null) delete c.fx;
      else c.fx = { ...c.fx, ...cleanFx(op.fx ?? fail('"fx" is required')) };
      break;
    }
    case 'set_speed': {
      const c = getClip(p, op.clipId);
      if (c.kind !== 'video' && c.kind !== 'audio') fail('speed applies to video / audio clips');
      const speed = Math.round(clampN(op.speed, 0.25, 4, 'speed') * 100) / 100;
      const old = speedOf(c);
      const end = c.start + c.duration;
      const duration = r3(Math.max(0.05, (c.duration * old) / speed));
      const delta = duration - c.duration;
      // keep what follows glued to the clip: on its own track, or (ripple) on every track except background music
      const follows = (o: Clip) => o.id !== c.id && o.start >= end - EPS && (op.ripple ? !o.music : o.trackId === c.trackId);
      for (const o of p.clips) if (follows(o)) o.start = r3(Math.max(0, o.start + delta));
      if (c.keyframes?.length) c.keyframes = stretchKeys(c.keyframes, duration / c.duration);
      c.duration = duration;
      c.speed = speed;
      break;
    }
    case 'duplicate': {
      const c = getClip(p, op.clipId);
      const start = Math.max(0, op.start ?? c.start + c.duration);
      const tKind = trackKindFor(c.kind);
      let trackId = c.trackId;
      if (!isFree(p, trackId, start, c.duration)) {
        const t = p.tracks.find((x) => x.kind === tKind && !!x.captions === (c.kind === 'caption') && isFree(p, x.id, start, c.duration));
        trackId = (t ?? (c.kind === 'caption' ? p.tracks.find((x) => x.captions)! : addTrack(p, tKind))).id;
      }
      p.clips.push({ ...structuredClone(c), id: op.id ?? uid('c_'), trackId, start: r3(start), transition: null });
      break;
    }
    case 'detach_audio': {
      const c = getClip(p, op.clipId);
      const m = p.media.find((x) => x.id === c.mediaId);
      if (c.kind !== 'video' || !m?.hasAudio) fail('the clip has no audio to detach');
      if (c.volume === 0) fail('the audio of this clip is already detached or muted');
      const track = freeTrack(p, 'audio', c.start, c.duration);
      p.clips.push({ id: op.id ?? uid('c_'), trackId: track.id, kind: 'audio', start: c.start, duration: c.duration, mediaId: c.mediaId, offset: c.offset, volume: c.volume, speed: c.speed, fadeIn: c.fadeIn, fadeOut: c.fadeOut });
      c.volume = 0;
      c.fadeIn = undefined;
      c.fadeOut = undefined;
      break;
    }
    case 'set_track': {
      const t = p.tracks.find((x) => x.id === op.trackId) ?? fail(`track not found: ${op.trackId}`);
      if (op.muted !== undefined) t.muted = !!op.muted;
      if (op.hidden !== undefined) t.hidden = !!op.hidden;
      if (op.name !== undefined && String(op.name).trim()) t.name = String(op.name).trim().slice(0, 40);
      break;
    }
    case 'set_caption_animation': {
      const a = normAnim({ type: op.type, duration: op.duration ?? (op.type === 'typewriter' ? 0.6 : 0.25) }, null) ?? null;
      p.captionAnim = a;
      for (const c of p.clips) if (c.kind === 'caption') c.animIn = a ? { ...a, duration: Math.min(a.duration, c.duration) } : null;
      break;
    }
    case 'remove_media':
      if (!p.media.some((m) => m.id === op.mediaId)) fail(`media not found: ${op.mediaId}`);
      {
        const orphans = new Set(captionsTiedTo(p, op.mediaId));
        p.media = p.media.filter((m) => m.id !== op.mediaId);
        p.clips = p.clips.filter((c) => c.mediaId !== op.mediaId && !orphans.has(c.id));
        if (p.logo?.mediaId === op.mediaId) p.logo = null;
      }
      break;
    case 'set_layout':
      if (!LAYOUTS.includes(op.layout)) fail(`layout must be one of ${LAYOUTS.join(', ')}`);
      p.layout = op.layout === 'single' ? undefined : op.layout;
      break;
    case 'set_logo':
      if (op.logo === null) p.logo = null;
      else if (!op.logo || typeof op.logo !== 'object') fail('logo must be an object or null');
      else p.logo = cleanLogo(op.logo, p.media, p.logo);
      break;
    case 'set_keyframe': {
      const c = getClip(p, op.clipId);
      if (!visualClip(c)) fail('keyframes apply to video / image clips');
      const t = num(op.t, 't');
      if (t < -EPS || t > c.duration + EPS) fail(`"t" must be inside the clip (0..${c.duration} seconds from its start)`);
      const keys = sortedKeys(c.keyframes);
      const at = keys.findIndex((k) => Math.abs(k.t - t) <= KEY_SNAP);
      const prevEase = (keys.filter((k) => k.t <= t).pop() ?? keys[0])?.ease ?? 'ease-in-out';
      const cur = at >= 0 ? keys[at] : { ...poseAt(c, t), ease: prevEase };
      const given = Object.fromEntries((['x', 'y', 'scale', 'rotation', 'opacity', 'ease'] as const).filter((k) => op[k] !== undefined).map((k) => [k, op[k]]));
      const key = cleanKey({ ...cur, t: at >= 0 ? keys[at].t : Math.max(0, Math.min(c.duration, t)), ...given }, c.duration);
      if (at >= 0) keys[at] = key;
      else {
        if (keys.length >= MAX_KEYS) fail(`a clip can have up to ${MAX_KEYS} keyframes`);
        keys.push(key);
      }
      c.keyframes = sortedKeys(keys);
      break;
    }
    case 'delete_keyframe': {
      const c = getClip(p, op.clipId);
      const t = num(op.t, 't');
      const keys = sortedKeys(c.keyframes);
      const at = keys.findIndex((k) => Math.abs(k.t - t) <= 0.05);
      if (at < 0) fail('no keyframe at that time');
      keys.splice(at, 1);
      if (keys.length) c.keyframes = keys;
      else delete c.keyframes;
      break;
    }
    case 'clear_keyframes': {
      const c = getClip(p, op.clipId);
      delete c.keyframes;
      break;
    }
    case 'punch_in': {
      // zoom toward a point of the frame and back: 4 keyframes (start, arrive, hold, leave)
      const c = getClip(p, op.clipId);
      if (!visualClip(c)) fail('zoom applies to video / image clips');
      const a = r3(num(op.start, 'start') - c.start);
      const b = r3(num(op.end, 'end') - c.start);
      if (a < -EPS || b > c.duration + EPS || b - a < 0.2) fail('the zoom must lie inside the clip and last at least 0.2 seconds');
      const S = clampN(op.scale ?? 1.5, 1.05, 5, 'scale');
      const px = clampN(op.x ?? 0.5, 0, 1, 'x') - 0.5;
      const py = clampN(op.y ?? 0.5, 0, 1, 'y') - 0.5;
      const ramp = clampN(op.ramp ?? Math.min(0.4, (b - a) / 4), 0, (b - a) / 2, 'ramp');
      const e = op.ease ?? 'ease-in-out';
      if (!EASES.includes(e)) fail(`ease must be one of ${EASES.join(', ')}`);
      const from = poseAt(c, Math.max(0, a));
      // the point under (x, y) stays where it is on screen: pos' = P - (P - pos) * S
      const zoomed = { ...from, scale: Math.min(4, from.scale * S), x: px - (px - from.x) * S, y: py - (py - from.y) * S };
      const back = poseAt(c, Math.min(c.duration, b));
      const keep = sortedKeys(c.keyframes).filter((k) => k.t < a - KEY_SNAP || k.t > b + KEY_SNAP);
      const mk = (t: number, pose: typeof from, ease: Ease) => cleanKey({ ...pose, t: Math.max(0, Math.min(c.duration, t)), ease }, c.duration);
      c.keyframes = sortedKeys([...keep, mk(a, from, e), mk(a + ramp, zoomed, 'linear'), mk(b - ramp, zoomed, e), mk(b, back, keep.find((k) => k.t > b)?.ease ?? 'linear')]);
      break;
    }
    case 'insert_clip': {
      // place media at a time and push everything after it later by the clip's length (background music stays)
      const m = p.media.find((x) => x.id === op.mediaId) ?? fail(`media not found: ${op.mediaId}`);
      const t = r3(Math.max(0, num(op.time, 'time')));
      const kind: ClipKind = m.kind;
      const duration = r3(m.kind === 'image' ? 5 : m.duration);
      if (!(duration > 0)) fail('the media has no length');
      if (op.trackId !== undefined && typeof op.trackId !== 'string') fail('"trackId" must be a string');
      const tKind = trackKindFor(kind);
      const track = op.trackId ? freeTrack(p, tKind, 0, 0, op.trackId) : p.tracks.find((x) => x.kind === tKind && !x.captions) ?? addTrack(p, tKind);
      let q = p;
      for (const c of p.clips.filter((x) => !x.music && x.start < t - EPS && x.start + x.duration > t + EPS)) q = applyOp(q, { op: 'split', time: t, clipId: c.id });
      for (const c of q.clips) if (!c.music && c.start >= t - EPS) c.start = r3(c.start + duration);
      q.clips.push({ id: op.id ?? uid('c_'), trackId: track.id, kind, start: t, duration, mediaId: m.id, offset: 0, volume: 1 });
      if (q.inPoint !== null && q.inPoint >= t) q.inPoint = r3(q.inPoint + duration);
      if (q.outPoint !== null && q.outPoint >= t) q.outPoint = r3(q.outPoint + duration);
      return q;
    }
    case 'move_clip_to_new_track': {
      const c = getClip(p, op.clipId);
      const pos = op.position ?? 'above';
      if (pos !== 'above' && pos !== 'below') fail('"position" must be "above" or "below"');
      const kind = trackKindFor(c.kind);
      const count = p.tracks.filter((t) => t.kind === kind && !t.captions).length;
      const base = kind === 'video' ? 'וידאו' : kind === 'text' ? 'טקסט' : 'אודיו';
      const track: Track = { id: op.id ?? uid('t_'), kind, name: `${base} ${count + 1}` };
      const i = p.tracks.findIndex((t) => t.id === c.trackId);
      p.tracks.splice(pos === 'above' ? i : i + 1, 0, track);
      c.trackId = track.id;
      if (c.kind === 'caption') c.kind = 'text';
      break;
    }
    default:
      fail(`unknown op: ${(op as { op?: string }).op}. Supported: ${OP_NAMES.join(', ')}`);
  }
  return p;
}

export function summarize(p: Project) {
  const mediaName = (id?: string) => p.media.find((m) => m.id === id)?.name;
  return {
    id: p.id,
    name: p.name,
    rev: p.rev,
    settings: p.settings,
    duration: projectDuration(p),
    inPoint: p.inPoint,
    outPoint: p.outPoint,
    captionStyle: p.captionStyle,
    background: p.background ?? '#000000',
    layout: p.layout ?? 'single',
    ...(p.logo ? { logo: p.logo } : {}),
    ...(p.titleFont ? { titleFont: p.titleFont } : {}),
    media: p.media.map((m) => ({ id: m.id, name: m.name, kind: m.kind, duration: m.duration, width: m.width, height: m.height, hasAudio: m.hasAudio })),
    tracks: p.tracks.map((t, i) => ({
      id: t.id,
      kind: t.kind,
      name: t.name,
      ...(t.muted ? { muted: true } : {}),
      ...(t.hidden ? { hidden: true } : {}),
      layer: p.tracks.length - i,
      clips: p.clips
        .filter((c) => c.trackId === t.id)
        .sort((a, b) => a.start - b.start)
        .map((c) => ({
          id: c.id,
          kind: c.kind,
          start: c.start,
          end: r3(c.start + c.duration),
          duration: c.duration,
          ...(c.mediaId ? { mediaId: c.mediaId, media: mediaName(c.mediaId), sourceOffset: c.offset } : {}),
          ...(c.text !== undefined ? { text: c.text } : {}),
          ...(c.kind === 'audio' || c.kind === 'video' ? { volume: c.volume } : {}),
          ...(c.transition ? { transition: c.transition } : {}),
          ...(c.animIn ? { animIn: c.animIn } : {}),
          ...(c.animOut ? { animOut: c.animOut } : {}),
          ...(c.speed && c.speed !== 1 ? { speed: c.speed } : {}),
          ...(c.fx && Object.keys(c.fx).length ? { fx: c.fx } : {}),
          ...(c.keyframes?.length ? { keyframes: c.keyframes } : {}),
        })),
    })),
  };
}
