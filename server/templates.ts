import fs from 'node:fs';
import path from 'node:path';
import { sanitizeState, uid } from '../shared/ops';
import type { Project } from '../shared/types';
import { HttpError, MEDIA_DIR, TEMPLATES_DIR } from './store';

/**
 * Templates: a project's frame, tracks, layout, titles (text clips) and logo, without its videos, sounds
 * or captions. Kept as JSON files in <data>/templates. A new project can start from one.
 */
export interface Template {
  id: string;
  name: string;
  createdAt: string;
  state: Pick<Project, 'settings' | 'tracks' | 'clips' | 'captionStyle' | 'background' | 'captionAnim' | 'layout' | 'logo' | 'titleFont' | 'media'>;
}

const MAX_TEMPLATES = 200;
const safeId = (id: string) => /^tpl_[a-z0-9]{6,16}$/.test(id);
const fileOf = (id: string) => path.join(TEMPLATES_DIR, `${id}.json`);

function read(id: string): Template | undefined {
  if (!safeId(id) || !fs.existsSync(fileOf(id))) return undefined;
  try {
    return JSON.parse(fs.readFileSync(fileOf(id), 'utf8')) as Template;
  } catch {
    return undefined;
  }
}

export function listTemplates(): { id: string; name: string; createdAt: string; aspect: string; layout: string; titles: number; logo: boolean }[] {
  return fs
    .readdirSync(TEMPLATES_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => read(f.slice(0, -5)))
    .filter((t): t is Template => !!t)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((t) => ({ id: t.id, name: t.name, createdAt: t.createdAt, aspect: t.state.settings.aspect, layout: t.state.layout ?? 'single', titles: t.state.clips.length, logo: !!t.state.logo }));
}

export function saveTemplate(p: Project, name: string): Template {
  if (fs.readdirSync(TEMPLATES_DIR).filter((f) => f.endsWith('.json')).length >= MAX_TEMPLATES) throw new HttpError(400, 'יש כבר יותר מדי תבניות. מחקו כמה ונסו שוב');
  const logoMedia = p.logo ? p.media.filter((m) => m.id === p.logo!.mediaId) : [];
  const titles = p.clips.filter((c) => c.kind === 'text');
  const clean = sanitizeState({ ...p, clips: titles, media: logoMedia, inPoint: null, outPoint: null }, logoMedia);
  const t: Template = {
    id: uid('tpl_'),
    name: String(name || p.name).slice(0, 80).trim() || 'תבנית',
    createdAt: new Date().toISOString(),
    state: {
      settings: clean.settings,
      tracks: clean.tracks,
      clips: clean.clips,
      captionStyle: clean.captionStyle,
      background: clean.background,
      captionAnim: clean.captionAnim,
      layout: clean.layout,
      logo: clean.logo,
      titleFont: clean.titleFont,
      media: logoMedia,
    },
  };
  fs.writeFileSync(fileOf(t.id), JSON.stringify(t, null, 2));
  return t;
}

export function deleteTemplate(id: string) {
  if (!read(id)) throw new HttpError(404, 'template not found');
  fs.rmSync(fileOf(id), { force: true });
}

/** A new project's state from a template (checked again, and a logo whose file is gone is dropped). */
export function applyTemplate(p: Project, id: string): Project {
  const t = read(id) ?? (() => { throw new HttpError(404, 'template not found'); })();
  const media = (t.state.media ?? []).filter((m) => fs.existsSync(path.join(MEDIA_DIR, m.file)));
  const state = { ...t.state, logo: t.state.logo && media.some((m) => m.id === t.state.logo!.mediaId) ? t.state.logo : null };
  let clean;
  try {
    clean = sanitizeState({ ...state, name: p.name, inPoint: null, outPoint: null, media }, media);
  } catch (e) {
    throw new HttpError(400, `the template is damaged: ${(e as Error).message}`);
  }
  return { ...p, ...clean, name: p.name, media };
}
