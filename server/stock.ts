import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { MediaCredit } from '../shared/types';
import { DATA_DIR, HttpError } from './store';
import { getKey } from './keys';
import { safeDownload, type NetPolicy, defaultPolicy } from './netguard';

/**
 * Stock search: Openverse (no key; only licences that allow commercial use and changes), Pexels and
 * Pixabay (with the user's key). Results keep the licence and credit, which go with the imported asset.
 * The browser gets an id per result; the download address stays on the server (no URL from the
 * browser is ever fetched by this route).
 */
export type StockProvider = 'openverse' | 'pexels' | 'pixabay';
export type StockKind = 'image' | 'video' | 'audio';
export const STOCK_PROVIDERS: Record<StockProvider, { label: string; kinds: StockKind[]; key: boolean }> = {
  openverse: { label: 'Openverse', kinds: ['image', 'audio'], key: false },
  pexels: { label: 'Pexels', kinds: ['image', 'video'], key: true },
  pixabay: { label: 'Pixabay', kinds: ['image', 'video'], key: true },
};

export interface StockItem {
  id: string;
  provider: StockProvider;
  kind: StockKind;
  title: string;
  width?: number;
  height?: number;
  duration?: number;
  thumb: string | null; // served by this app (/library/stock-thumb/<id>)
  credit: MediaCredit;
}

// test instances point all three at a local mock (scripts/test-server.mjs); the app uses the public hosts
const MOCK = process.env.ALON_STOCK_BASE;
const BASES: Record<StockProvider, string> = MOCK
  ? { openverse: `${MOCK}/openverse`, pexels: `${MOCK}/pexels`, pixabay: `${MOCK}/pixabay` }
  : { openverse: 'https://api.openverse.org', pexels: 'https://api.pexels.com', pixabay: 'https://pixabay.com' };
/** Downloads of stock files: the public-address rule, except the configured mock in tests. */
export const stockPolicy: NetPolicy = { ...defaultPolicy, trusted: (u) => !!MOCK && u.origin === new URL(MOCK).origin };

const cache = new Map<string, { download: string; thumb: string | null; item: StockItem; at: number }>();
const TTL = 2 * 3600_000;
function remember(item: StockItem, download: string, thumb: string | null) {
  if (cache.size > 3000) for (const [k, v] of cache) if (Date.now() - v.at > TTL || cache.size > 2500) cache.delete(k);
  cache.set(item.id, { download, thumb, item, at: Date.now() });
}
export function stockEntry(id: string) {
  const e = cache.get(id);
  if (!e || Date.now() - e.at > TTL) throw new HttpError(404, 'תוצאת החיפוש פגה. חפשו שוב');
  return e;
}

async function getJson(url: string, headers: Record<string, string> = {}): Promise<any> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 20000);
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json', ...headers }, signal: ctl.signal, redirect: 'error' });
    if (res.status === 401 || res.status === 403 || (res.status === 400 && /key/i.test(await res.clone().text()))) throw new HttpError(401, 'המפתח לא התקבל אצל הספק. בדקו אותו בהגדרות');
    if (res.status === 429) throw new HttpError(429, 'הספק מגביל כרגע את מספר החיפושים. נסו שוב בעוד דקה');
    if (!res.ok) throw new HttpError(502, `הספק ענה ${res.status}`);
    return await res.json();
  } catch (e) {
    if (e instanceof HttpError) throw e;
    // never echo the URL: Pixabay carries the key in it
    throw new HttpError(502, ctl.signal.aborted ? 'הספק לא ענה בזמן' : 'אין חיבור לספק');
  } finally {
    clearTimeout(t);
  }
}

const str = (v: unknown, max = 200) => (typeof v === 'string' ? v.slice(0, max) : undefined);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const httpUrl = (v: unknown) => (typeof v === 'string' && /^https?:\/\//i.test(v) ? v.slice(0, 2000) : undefined);
const thumbPath = (id: string) => `/library/stock-thumb/${encodeURIComponent(id)}`;

export async function searchStock(provider: string, kind: string, q: string, page = 1): Promise<{ items: StockItem[]; needsKey?: boolean }> {
  if (!(provider in STOCK_PROVIDERS)) throw new HttpError(400, `provider must be one of ${Object.keys(STOCK_PROVIDERS).join(', ')}`);
  const pr = provider as StockProvider;
  if (!STOCK_PROVIDERS[pr].kinds.includes(kind as StockKind)) throw new HttpError(400, `${STOCK_PROVIDERS[pr].label} has ${STOCK_PROVIDERS[pr].kinds.join(' and ')}`);
  const k = kind as StockKind;
  q = String(q ?? '').trim().slice(0, 100);
  if (!q) throw new HttpError(400, 'מה לחפש?');
  page = Math.max(1, Math.min(50, Math.floor(Number(page) || 1)));
  const items: StockItem[] = [];
  const add = (rawId: unknown, title: string, download: string | undefined, thumb: string | undefined, credit: MediaCredit, extra: Partial<StockItem> = {}) => {
    if (!download || (typeof rawId !== 'string' && typeof rawId !== 'number')) return;
    const id = `${pr}:${k}:${String(rawId).slice(0, 80)}`;
    const item: StockItem = { id, provider: pr, kind: k, title: title || credit.title || 'ללא שם', thumb: thumb ? thumbPath(id) : null, credit, ...extra };
    remember(item, download, thumb ?? null);
    items.push(item);
  };
  if (pr === 'openverse') {
    const d = await getJson(`${BASES.openverse}/v1/${k === 'audio' ? 'audio' : 'images'}/?q=${encodeURIComponent(q)}&page=${page}&page_size=20&license_type=commercial,modification`);
    for (const r of Array.isArray(d?.results) ? d.results : []) {
      const license = `CC ${String(r.license ?? '').toUpperCase()}${r.license_version ? ' ' + r.license_version : ''}`.replace('CC CC0', 'CC0').replace('CC PDM', 'Public Domain');
      add(r.id, str(r.title) ?? '', httpUrl(r.url), httpUrl(r.thumbnail) ?? (k === 'image' ? httpUrl(r.url) : undefined), { provider: 'Openverse', title: str(r.title), author: str(r.creator), authorUrl: httpUrl(r.creator_url), license, licenseUrl: httpUrl(r.license_url), sourceUrl: httpUrl(r.foreign_landing_url) }, { width: num(r.width), height: num(r.height), duration: num(r.duration) ? num(r.duration)! / 1000 : undefined });
    }
    return { items };
  }
  const key = getKey(pr);
  if (!key) return { items: [], needsKey: true };
  if (pr === 'pexels') {
    const lic = { license: 'Pexels License', licenseUrl: 'https://www.pexels.com/license/' };
    if (k === 'video') {
      const d = await getJson(`${BASES.pexels}/videos/search?query=${encodeURIComponent(q)}&page=${page}&per_page=20`, { Authorization: key });
      for (const v of Array.isArray(d?.videos) ? d.videos : []) {
        const files = (Array.isArray(v.video_files) ? v.video_files : []).filter((f: any) => f?.file_type === 'video/mp4' && num(f.width));
        // the biggest file up to 1920 wide (4K is slow to edit)
        const f = files.filter((x: any) => x.width <= 1920).sort((a: any, b: any) => b.width - a.width)[0] ?? files.sort((a: any, b: any) => a.width - b.width)[0];
        add(v.id, `Pexels ${v.id}`, httpUrl(f?.link), httpUrl(v.image), { provider: 'Pexels', author: str(v.user?.name), authorUrl: httpUrl(v.user?.url), sourceUrl: httpUrl(v.url), ...lic }, { width: num(f?.width), height: num(f?.height), duration: num(v.duration) });
      }
    } else {
      const d = await getJson(`${BASES.pexels}/v1/search?query=${encodeURIComponent(q)}&page=${page}&per_page=20`, { Authorization: key });
      for (const ph of Array.isArray(d?.photos) ? d.photos : []) add(ph.id, str(ph.alt) ?? '', httpUrl(ph.src?.large2x ?? ph.src?.large), httpUrl(ph.src?.medium ?? ph.src?.tiny), { provider: 'Pexels', title: str(ph.alt), author: str(ph.photographer), authorUrl: httpUrl(ph.photographer_url), sourceUrl: httpUrl(ph.url), ...lic }, { width: num(ph.width), height: num(ph.height) });
    }
    return { items };
  }
  // pixabay
  const lic = { license: 'Pixabay Content License', licenseUrl: 'https://pixabay.com/service/license-summary/' };
  const d = await getJson(`${BASES.pixabay}/api/${k === 'video' ? 'videos/' : ''}?key=${encodeURIComponent(key)}&q=${encodeURIComponent(q)}&page=${page}&per_page=20&safesearch=true`);
  for (const h of Array.isArray(d?.hits) ? d.hits : []) {
    if (k === 'video') {
      const f = h.videos?.medium ?? h.videos?.small ?? h.videos?.tiny;
      add(h.id, str(h.tags) ?? '', httpUrl(f?.url), httpUrl(f?.thumbnail), { provider: 'Pixabay', title: str(h.tags), author: str(h.user), sourceUrl: httpUrl(h.pageURL), ...lic }, { width: num(f?.width), height: num(f?.height), duration: num(h.duration) });
    } else add(h.id, str(h.tags) ?? '', httpUrl(h.largeImageURL ?? h.webformatURL), httpUrl(h.previewURL ?? h.webformatURL), { provider: 'Pixabay', title: str(h.tags), author: str(h.user), sourceUrl: httpUrl(h.pageURL), ...lic }, { width: num(h.imageWidth), height: num(h.imageHeight) });
  }
  return { items };
}

// ---------- thumbnails (the page may load pictures from this app only) ----------
const THUMBS = path.join(DATA_DIR, 'cache', 'stock-thumbs');
fs.mkdirSync(THUMBS, { recursive: true });
const pendingThumbs = new Map<string, Promise<string>>();

export function stockThumb(id: string): Promise<string> {
  const e = stockEntry(id);
  if (!e.thumb) throw new HttpError(404, 'no thumbnail');
  const file = path.join(THUMBS, crypto.createHash('sha256').update(e.thumb).digest('hex').slice(0, 32) + '.img');
  if (fs.existsSync(file)) return Promise.resolve(file);
  let job = pendingThumbs.get(file);
  if (!job) {
    job = (async () => {
      const tmp = file + '.part';
      try {
        await safeDownload(e.thumb!, tmp, { maxBytes: 3 * 1024 * 1024, timeoutMs: 15000, accept: (t) => /^image\/(jpeg|png|webp|gif)$/.test(t), policy: stockPolicy });
        fs.renameSync(tmp, file);
        return file;
      } finally {
        fs.rmSync(tmp, { force: true });
      }
    })().finally(() => pendingThumbs.delete(file));
    pendingThumbs.set(file, job);
  }
  return job;
}
