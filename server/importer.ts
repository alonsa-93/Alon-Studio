import fs from 'node:fs';
import path from 'node:path';
import type { Job, MediaAsset, MediaCredit } from '../shared/types';
import { uid } from '../shared/ops';
import { addMedia } from './actions';
import { newMediaFileName, probe, registerMedia } from './media';
import { MEDIA_TYPES, safeDownload, type NetPolicy, defaultPolicy } from './netguard';
import { createJob, DATA_DIR, getProject, HttpError, holdMedia, MEDIA_DIR, updateJob } from './store';
import { stockEntry, stockPolicy } from './stock';

/**
 * Imports from the internet as a background job with progress: a link the user pasted, or a stock
 * result. The file is downloaded into a temporary folder, checked with ffprobe there, and only then
 * moved into the media folder and added to the project.
 */
const TMP = path.join(DATA_DIR, 'tmp', 'downloads');
const MAX_BYTES = 2 * 1024 ** 3;
const TIMEOUT = 30 * 60_000;

function nameFrom(url: string, contentType: string): string {
  let base = '';
  try {
    base = decodeURIComponent(path.posix.basename(new URL(url).pathname));
  } catch {
    /* keep empty */
  }
  base = base.replace(/[<>:"/\\|?*\x00-\x1f\x7f‎‏‪-‮⁦-⁩]/g, '').slice(0, 100);
  if (!path.extname(base)) {
    const ext = ({ 'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov', 'audio/mpeg': '.mp3', 'audio/mp4': '.m4a', 'audio/wav': '.wav', 'audio/x-wav': '.wav', 'audio/ogg': '.ogg', 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' } as Record<string, string>)[contentType] ?? '';
    base = (base || 'download') + ext;
  }
  return base;
}

export async function downloadInto(projectId: string, job: Job, url: string, opts: { name?: string; credit?: MediaCredit; policy?: NetPolicy }): Promise<MediaAsset> {
  fs.mkdirSync(TMP, { recursive: true });
  const tmp = path.join(TMP, uid('dl_'));
  const release = holdMedia();
  let moved: string | null = null;
  try {
    let last = 0;
    const got = await safeDownload(url, tmp, {
      maxBytes: MAX_BYTES,
      timeoutMs: TIMEOUT,
      accept: MEDIA_TYPES,
      policy: opts.policy ?? defaultPolicy,
      onProgress: (done, total) => {
        if (Date.now() - last < 250) return;
        last = Date.now();
        updateJob(job, { progress: total ? Math.min(0.95, (done / total) * 0.95) : 0, dl: done, dlTotal: total ?? undefined, stage: 'download', elapsed: Math.round((Date.now() - job.startedAt!) / 1000) });
      },
    });
    updateJob(job, { stage: 'check', progress: 0.96 });
    const display = (opts.name ?? nameFrom(got.url, got.contentType)).slice(0, 120);
    // ffprobe in the temporary folder first: nothing that is not media reaches the media folder
    const fileName = newMediaFileName(nameFrom(got.url, got.contentType));
    const staged = tmp + path.extname(fileName);
    fs.renameSync(tmp, staged);
    await probe(staged);
    moved = path.join(MEDIA_DIR, fileName);
    fs.renameSync(staged, moved);
    const asset = await registerMedia(fileName, display);
    if (opts.credit) asset.credit = opts.credit;
    asset.source = got.url.slice(0, 2000);
    addMedia(projectId, [asset], 'import');
    return asset;
  } catch (e) {
    if (moved) fs.rmSync(moved, { force: true });
    throw e;
  } finally {
    for (const f of fs.readdirSync(TMP).filter((f) => f.startsWith(path.basename(tmp)))) fs.rmSync(path.join(TMP, f), { force: true });
    release();
  }
}

function startImport(projectId: string | undefined, url: string, opts: Parameters<typeof downloadInto>[3]): Job {
  const p = getProject(projectId);
  const job = createJob(p.id, 'import');
  downloadInto(p.id, job, url, opts)
    .then((asset) => updateJob(job, { status: 'done', progress: 1, mediaId: asset.id, message: asset.name }))
    .catch((e: Error) => updateJob(job, { status: 'error', error: e.message }));
  return job;
}

/** "Import from a link": any public http(s) address of a media file. */
export function importFromUrl(projectId: string | undefined, url: unknown): Job {
  if (typeof url !== 'string' || url.length > 2000 || !/^https?:\/\//i.test(url.trim())) throw new HttpError(400, 'צריך קישור שמתחיל ב־http או https');
  return startImport(projectId, url.trim(), {});
}

/** A stock search result, with its licence and credit. */
export function importStock(projectId: string | undefined, id: unknown): Job {
  if (typeof id !== 'string') throw new HttpError(400, '"id" is required');
  const e = stockEntry(id);
  return startImport(projectId, e.download, { name: `${e.item.credit.provider} - ${e.item.title}`.slice(0, 100), credit: e.item.credit, policy: stockPolicy });
}
