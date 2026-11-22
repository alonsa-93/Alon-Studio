import fs from 'node:fs';
import path from 'node:path';
import { FONTS, type Project } from '../shared/types';
import { FONT_OK, uid } from '../shared/ops';
import { DATA_DIR, HttpError } from './store';
import { FontError, sfntInfo, toSfnt } from './fontfile';

/**
 * Fonts added by the user: uploaded files (TTF, OTF, WOFF, WOFF2) and families from Google Fonts.
 * Every face is stored as TTF / OTF in <data>/fonts, because the export's libass reads only those.
 * The player loads the same files with @font-face, so preview and export use one file.
 */
export const FONTS_DIR = path.join(DATA_DIR, 'fonts');
fs.mkdirSync(FONTS_DIR, { recursive: true });
const INDEX = path.join(FONTS_DIR, 'fonts.json');
const MAX_FACES = 300;
const MAX_FILE = 30 * 1024 * 1024;

export interface FontFace {
  id: string; // f_xxx; the file is <id>.ttf or <id>.otf
  family: string;
  weight: number;
  italic: boolean;
  file: string;
  source: 'upload' | 'google';
  scale?: number; // line height / em (see sfntInfo)
  original?: string; // uploaded file name
  addedAt: string;
}

function readIndex(): FontFace[] {
  try {
    const list = JSON.parse(fs.readFileSync(INDEX, 'utf8')) as FontFace[];
    return Array.isArray(list) ? list.filter((f) => f && /^f_[a-z0-9]{6,16}\.(ttf|otf)$/.test(f.file) && FONT_OK.test(f.family)) : [];
  } catch {
    return [];
  }
}

function writeIndex(list: FontFace[]) {
  const tmp = INDEX + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
  fs.renameSync(tmp, INDEX);
}

/** Families with their faces, sorted by name. */
export function listFonts() {
  const fams = new Map<string, { family: string; source: FontFace['source']; faces: { id: string; weight: number; italic: boolean; url: string }[] }>();
  for (const f of readIndex()) {
    const e = fams.get(f.family) ?? { family: f.family, source: f.source, faces: [] };
    e.faces.push({ id: f.id, weight: f.weight, italic: f.italic, url: `/library/fonts/${f.file}` });
    fams.set(f.family, e);
  }
  return [...fams.values()].sort((a, b) => a.family.localeCompare(b.family));
}

export const customFamilies = () => new Set(readIndex().map((f) => f.family));

/** Size ratio per added family for the export (the regular face, else the first one). */
export function customFontScales(): Map<string, number> {
  const out = new Map<string, number>();
  const faces = readIndex().sort((a, b) => Math.abs(a.weight - 400) - Math.abs(b.weight - 400) || Number(a.italic) - Number(b.italic));
  for (const f of faces) {
    if (out.has(f.family)) continue;
    let scale = f.scale;
    if (!scale)
      try {
        scale = sfntInfo(fs.readFileSync(path.join(FONTS_DIR, f.file))).scale;
      } catch {
        continue;
      }
    out.set(f.family, scale);
  }
  return out;
}

/** Adds one font file. A face with the same family, weight and slant is replaced. */
export function addFontFile(buf: Buffer, source: FontFace['source'], original?: string): FontFace {
  if (buf.length > MAX_FILE) throw new HttpError(400, 'הקובץ גדול מדי (עד 30MB)');
  let sfnt: Buffer;
  let info: ReturnType<typeof sfntInfo>;
  try {
    sfnt = toSfnt(buf);
    info = sfntInfo(sfnt);
  } catch (e) {
    if (e instanceof FontError) throw new HttpError(400, `קובץ הפונט לא נקרא: ${e.message}`);
    throw e;
  }
  const family = info.family.replace(/\s+/g, ' ').trim();
  if (!FONT_OK.test(family)) throw new HttpError(400, `שם המשפחה של הפונט ("${family.slice(0, 40)}") חייב להיות באותיות לטיניות, ספרות, רווח, מקף או קו תחתון`);
  if (FONTS.includes(family)) throw new HttpError(400, `"${family}" כבר מובנה בתוכנה`);
  const list = readIndex();
  const same = list.find((f) => f.family === family && f.weight === info.weight && f.italic === info.italic);
  if (!same && list.length >= MAX_FACES) throw new HttpError(400, 'יש כבר יותר מדי פונטים. מחקו כמה ונסו שוב');
  const id = uid('f_');
  const face: FontFace = { id, family, weight: info.weight, italic: info.italic, scale: info.scale, file: `${id}.${info.format}`, source, ...(original ? { original: original.slice(0, 120) } : {}), addedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(FONTS_DIR, face.file), sfnt);
  const next = list.filter((f) => f !== same);
  next.push(face);
  writeIndex(next);
  if (same) fs.rmSync(path.join(FONTS_DIR, same.file), { force: true });
  return face;
}

/** Removes every face of a family. Titles that use it fall back to the default font. */
export function deleteFamily(family: string) {
  const list = readIndex();
  const gone = list.filter((f) => f.family === family);
  if (!gone.length) throw new HttpError(404, 'font not found');
  writeIndex(list.filter((f) => f.family !== family));
  for (const f of gone) fs.rmSync(path.join(FONTS_DIR, f.file), { force: true });
}

/** Font families a project's titles and captions use. */
export function familiesOf(p: Project): Set<string> {
  const used = new Set<string>([p.captionStyle.font]);
  for (const c of p.clips) if (c.style?.font) used.add(c.style.font);
  if (p.titleFont) used.add(p.titleFont);
  return used;
}

/** Copies the files of the custom fonts a project uses into `dir` (the export's fontsdir). */
export function copyProjectFonts(p: Project, dir: string): number {
  const used = familiesOf(p);
  const faces = readIndex().filter((f) => used.has(f.family));
  fs.mkdirSync(dir, { recursive: true });
  for (const f of faces) fs.copyFileSync(path.join(FONTS_DIR, f.file), path.join(dir, f.file));
  return faces.length;
}

// ---------- Google Fonts ----------

// fixed hosts; tests may point both at a local mock server through the environment (never through the API)
const CSS_BASE = process.env.ALON_GOOGLE_FONTS_CSS ?? 'https://fonts.googleapis.com';
const FILE_HOST = process.env.ALON_GOOGLE_FONTS_FILES ?? 'https://fonts.gstatic.com';
const GOOGLE_FAMILY = /^[A-Za-z0-9][A-Za-z0-9 ]{0,39}$/;

async function fetchLimited(url: string, max: number, ms: number): Promise<Buffer> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctl.signal, redirect: 'error' });
    if (res.status === 400 || res.status === 404) throw new HttpError(404, 'המשפחה לא נמצאה ב־Google Fonts');
    if (!res.ok) throw new HttpError(502, `Google Fonts לא זמין (${res.status})`);
    const len = Number(res.headers.get('content-length') ?? 0);
    if (len > max) throw new HttpError(400, 'הקובץ גדול מדי');
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      total += chunk.length;
      if (total > max) throw new HttpError(400, 'הקובץ גדול מדי');
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(502, ctl.signal.aborted ? 'Google Fonts לא ענה בזמן' : 'אין חיבור ל־Google Fonts');
  } finally {
    clearTimeout(timer);
  }
}

/** The font files a Google Fonts stylesheet points at, by weight (only files on the fonts host). */
export function parseGoogleCss(css: string): { weight: number; italic: boolean; url: string }[] {
  const allowed = new URL(FILE_HOST);
  const out: { weight: number; italic: boolean; url: string }[] = [];
  for (const block of css.match(/@font-face\s*\{[^}]*\}/g) ?? []) {
    const url = /src:\s*url\(\s*['"]?([^'")\s]+)['"]?\s*\)/.exec(block)?.[1];
    if (!url) continue;
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      continue;
    }
    if (u.protocol !== allowed.protocol || u.host !== allowed.host) continue;
    const weight = Number(/font-weight:\s*(\d{3})/.exec(block)?.[1] ?? 400);
    const italic = /font-style:\s*italic/.test(block);
    if (!out.some((x) => x.url === u.href)) out.push({ weight, italic, url: u.href });
  }
  return out;
}

/** Downloads a family (regular and bold when it has them) from Google Fonts. */
export async function addGoogleFont(family: string): Promise<{ family: string; faces: number }> {
  family = String(family ?? '').replace(/\s+/g, ' ').trim();
  if (!GOOGLE_FAMILY.test(family)) throw new HttpError(400, 'שם משפחה לא תקין (אותיות לטיניות, ספרות ורווחים, למשל Heebo או Frank Ruhl Libre)');
  const q = family.replace(/ /g, '+');
  let css: string;
  try {
    css = (await fetchLimited(`${CSS_BASE}/css2?family=${q}:wght@400;700`, 256 * 1024, 20000)).toString('utf8');
  } catch (e) {
    // families without a bold weight answer 400 to the two-weight request
    if (!(e instanceof HttpError) || e.status !== 404) throw e;
    css = (await fetchLimited(`${CSS_BASE}/css2?family=${q}`, 256 * 1024, 20000)).toString('utf8');
  }
  const files = parseGoogleCss(css);
  if (!files.length) throw new HttpError(502, 'Google Fonts לא החזיר קבצים למשפחה הזו');
  let name = family;
  for (const f of files.slice(0, 4)) {
    const face = addFontFile(await fetchLimited(f.url, MAX_FILE, 60000), 'google');
    name = face.family;
  }
  return { family: name, faces: Math.min(files.length, 4) };
}
