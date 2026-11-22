import type { Clip, Project, Track } from './types';

/**
 * What changed between two states of a project, one row per clip, track or setting, in words the user
 * reads on the AI agent's approval card. Captions are summed up in one row (a transcript can hold hundreds).
 */
export interface Change {
  kind: 'add' | 'remove' | 'change';
  target: 'clip' | 'track' | 'setting' | 'captions';
  id?: string;
  label: string;
  detail?: string;
  /** The same row as ids (label, detail parts and their values), so the studio can show it in English.
   *  label and detail above stay the Hebrew text. */
  i18n?: { label: string; vars?: Record<string, string | number>; detail?: string[] };
}

const t = (s: number) => {
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  return `${m}:${sec.toFixed(1).padStart(4, '0')}`;
};
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

const KIND: Record<Clip['kind'], string> = { video: 'וידאו', image: 'תמונה', audio: 'אודיו', text: 'טקסט', caption: 'כתובית' };

function clipWhat(c: Clip, p: Project): string {
  return c.kind === 'text' ? `"${(c.text ?? '').slice(0, 30)}"` : (p.media.find((m) => m.id === c.mediaId)?.name ?? '').slice(0, 30);
}

function clipKey(c: Clip, p: Project) {
  return { label: 'clip', vars: { kind: c.kind, what: clipWhat(c, p), range: `${t(c.start)}–${t(c.start + c.duration)}` } };
}

/** A track name the studio made (the kind's name) can be shown in English; a name the user gave cannot. */
function trackKey(x: Track): { label: string; vars: Record<string, string> } {
  return { label: 'track', vars: x.name === KIND[x.kind] ? { name: x.name, kind: x.kind } : { name: x.name ?? '' } };
}

function clipLabel(c: Clip, p: Project): string {
  const what = clipWhat(c, p);
  // the time range is isolated left-to-right, or a right-to-left line shows it backwards
  return `${KIND[c.kind]} ${what} (⁦${t(c.start)}–${t(c.start + c.duration)}⁩)`.replace(/\s+/g, ' ');
}

const CLIP_FIELDS: [keyof Clip, string][] = [
  ['start', 'מיקום'],
  ['duration', 'אורך'],
  ['offset', 'נקודת התחלה במקור'],
  ['trackId', 'ערוץ'],
  ['text', 'טקסט'],
  ['style', 'עיצוב'],
  ['fx', 'אפקטים ומסגור'],
  ['keyframes', 'תנועה'],
  ['transition', 'מעבר'],
  ['animIn', 'אנימציית כניסה'],
  ['animOut', 'אנימציית יציאה'],
  ['speed', 'מהירות'],
  ['volume', 'עוצמה'],
  ['fadeIn', 'כניסה הדרגתית'],
  ['fadeOut', 'יציאה הדרגתית'],
];

const SETTINGS: [string, (p: Project) => unknown, string][] = [
  ['שם הפרויקט', (p) => p.name, 'name'],
  ['גודל ויחס המסך', (p) => [p.settings.width, p.settings.height], 'size'],
  ['קצב פריימים', (p) => p.settings.fps, 'fps'],
  ['צבע רקע', (p) => p.background ?? null, 'background'],
  ['פריסת מסך', (p) => p.layout ?? 'single', 'layout'],
  ['לוגו', (p) => p.logo ?? null, 'logo'],
  ['פונט לכותרות', (p) => p.titleFont ?? '', 'titleFont'],
  ['עיצוב הכתוביות', (p) => p.captionStyle, 'captionStyle'],
  ['אנימציית כתוביות', (p) => p.captionAnim ?? null, 'captionAnim'],
  ['נקודות In / Out', (p) => [p.inPoint ?? null, p.outPoint ?? null], 'inOut'],
];

export function diffProjects(before: Project, after: Project): Change[] {
  const out: Change[] = [];
  for (const [label, get, id] of SETTINGS) if (!same(get(before), get(after))) out.push({ kind: 'change', target: 'setting', label, i18n: { label: `setting.${id}` } });

  const bt = new Map(before.tracks.map((x) => [x.id, x]));
  const at = new Map(after.tracks.map((x) => [x.id, x]));
  for (const x of after.tracks) if (!bt.has(x.id)) out.push({ kind: 'add', target: 'track', id: x.id, label: `ערוץ ${x.name ?? ''}`.trim(), i18n: trackKey(x) });
  for (const x of before.tracks) if (!at.has(x.id)) out.push({ kind: 'remove', target: 'track', id: x.id, label: `ערוץ ${x.name ?? ''}`.trim(), i18n: trackKey(x) });
  for (const x of after.tracks) {
    const y = bt.get(x.id);
    if (!y) continue;
    const d = [!same(x.muted, y.muted) && (x.muted ? 'הושתק' : 'הושמע'), !same(x.hidden, y.hidden) && (x.hidden ? 'הוסתר' : 'הוצג'), !same(x.name, y.name) && 'שם'].filter(Boolean);
    const dk = [!same(x.muted, y.muted) && (x.muted ? 'track.muted' : 'track.unmuted'), !same(x.hidden, y.hidden) && (x.hidden ? 'track.hidden' : 'track.shown'), !same(x.name, y.name) && 'track.name'].filter((v): v is string => !!v);
    if (d.length) out.push({ kind: 'change', target: 'track', id: x.id, label: `ערוץ ${x.name ?? ''}`.trim(), detail: d.join(', '), i18n: { ...trackKey(x), detail: dk } });
  }

  const bc = new Map(before.clips.map((c) => [c.id, c]));
  const ac = new Map(after.clips.map((c) => [c.id, c]));
  const caps = { add: 0, remove: 0, change: 0 };
  for (const c of after.clips) {
    const old = bc.get(c.id);
    if (!old) {
      if (c.kind === 'caption') caps.add++;
      else out.push({ kind: 'add', target: 'clip', id: c.id, label: clipLabel(c, after), i18n: clipKey(c, after) });
      continue;
    }
    const changed = CLIP_FIELDS.filter(([k]) => !same(old[k], c[k]));
    const fields = changed.map(([, name]) => name);
    const fieldIds = changed.map(([k]) => `field.${k}`);
    if (!fields.length && old.kind === 'caption' && !same(old.words, c.words)) {
      fields.push('תזמון מילים');
      fieldIds.push('field.words');
    }
    if (!fields.length) continue;
    if (c.kind === 'caption') caps.change++;
    else out.push({ kind: 'change', target: 'clip', id: c.id, label: clipLabel(c, after), detail: fields.join(', '), i18n: { ...clipKey(c, after), detail: fieldIds } });
  }
  for (const c of before.clips)
    if (!ac.has(c.id)) {
      if (c.kind === 'caption') caps.remove++;
      else out.push({ kind: 'remove', target: 'clip', id: c.id, label: clipLabel(c, before), i18n: clipKey(c, before) });
    }
  if (caps.add || caps.remove || caps.change) {
    const parts = [caps.add && `${caps.add} נוספו`, caps.remove && `${caps.remove} הוסרו`, caps.change && `${caps.change} שונו`].filter(Boolean);
    const partIds = [caps.add && 'caps.add', caps.remove && 'caps.remove', caps.change && 'caps.change'].filter((v): v is string => !!v);
    out.push({ kind: caps.add && !caps.remove && !caps.change ? 'add' : caps.remove && !caps.add && !caps.change ? 'remove' : 'change', target: 'captions', label: 'כתוביות', detail: parts.join(', '), i18n: { label: 'captions', vars: { ...caps }, detail: partIds } });
  }
  return out;
}
