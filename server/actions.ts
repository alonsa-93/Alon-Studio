import type { Job, MediaAsset } from '../shared/types';
import { generateCaptions, type Engine } from './captions';
import { llmTarget } from './llm';
import { TRANSLATE_LANGS } from './translate';
import fs from 'node:fs';
import path from 'node:path';
import { importLocalFile, newMediaFileName, registerMedia } from './media';
import { sfxFile, SFX } from './sfx';
import { MEDIA_DIR, withMediaHold } from './store';
import { renderExport, type Quality } from './render';
import { createJob, createProject, getProject, HttpError, saveProject, updateJob } from './store';
import { newProject } from '../shared/ops';
import { presetOf, type ExportOptions, type Reframe } from '../shared/layout';
import { applyTemplate } from './templates';

/** Checks the export options (a preset id from the list, fit or fill). */
export function exportOptions(o: { preset?: unknown; reframe?: unknown }): ExportOptions {
  if (o.preset !== undefined && o.preset !== null && o.preset !== '' && !presetOf(String(o.preset))) throw new HttpError(400, 'unknown export preset');
  if (o.reframe !== undefined && o.reframe !== 'fit' && o.reframe !== 'fill') throw new HttpError(400, 'reframe must be "fit" or "fill"');
  return { preset: o.preset ? String(o.preset) : null, reframe: (o.reframe as Reframe) ?? 'fit' };
}

/** A new project, empty or from a template (a bad template id creates nothing). */
export function newProjectFrom(name: string, templateId?: unknown) {
  if (templateId === undefined || templateId === null || templateId === '') return createProject(name);
  if (typeof templateId !== 'string') throw new HttpError(400, 'templateId must be text');
  applyTemplate(newProject('p_check', name), templateId);
  const p = createProject(name);
  return saveProject(applyTemplate(p, templateId), 'api');
}

/** Actions shared by the REST API and the MCP server. */

export function startExport(projectId: string | undefined, quality: string = 'medium', useRange = true, normalize = false, opts: ExportOptions = {}): Job {
  if (!['low', 'medium', 'high'].includes(quality)) throw new HttpError(400, 'quality must be "low", "medium" or "high"');
  const p = getProject(projectId);
  if (!p.clips.length) throw new HttpError(400, 'ציר הזמן ריק - אין מה לייצא');
  const job = createJob(p.id, 'export');
  renderExport(p, job, quality as Quality, useRange, normalize, opts).catch((e: Error) => updateJob(job, { status: 'error', error: e.message }));
  return job;
}

export function startCaptions(projectId: string | undefined, language = 'he', model?: string, maxWords?: number, opts: { engine?: unknown; translateTo?: unknown } = {}): Job {
  if (opts.engine !== undefined && !['auto', 'local', 'cloud'].includes(String(opts.engine))) throw new HttpError(400, 'engine must be auto, local or cloud');
  if (opts.translateTo !== undefined && opts.translateTo !== null && opts.translateTo !== '') {
    if (typeof opts.translateTo !== 'string' || !TRANSLATE_LANGS[opts.translateTo]) throw new HttpError(400, `translateTo must be one of ${Object.keys(TRANSLATE_LANGS).join(', ')}`);
    llmTarget(); // a missing model or key fails now, not after the transcription
  }
  if (typeof language !== 'string' || !/^([a-z]{2,3}|auto)$/.test(language)) throw new HttpError(400, 'language must be a language code such as "he", "en" or "auto"');
  // only the known model sizes (a free text could name any download source or local folder)
  if (model !== undefined && !['tiny', 'base', 'small', 'medium', 'large-v3'].includes(String(model))) throw new HttpError(400, 'model must be tiny, base, small, medium or large-v3');
  const p = getProject(projectId);
  const job = createJob(p.id, 'captions');
  generateCaptions(p, job, language, model, maxWords, { engine: opts.engine as Engine | undefined, translateTo: (opts.translateTo as string) || undefined }).catch((e: Error) => updateJob(job, { status: 'error', error: e.message }));
  return job;
}

export function addMedia(projectId: string | undefined, assets: MediaAsset[], origin = 'api') {
  const p = getProject(projectId);
  return saveProject({ ...p, media: [...p.media, ...assets] }, origin);
}

export function importMediaByPath(projectId: string | undefined, file: string): Promise<MediaAsset> {
  return withMediaHold(async () => {
    const asset = await importLocalFile(file);
    addMedia(projectId, [asset]);
    return asset;
  });
}

/** Copies a built-in sound effect into the project's media library (once) and returns the asset. */
const adding = new Map<string, Promise<MediaAsset>>();

export function addLibrarySound(projectId: string | undefined, sfxId: string): Promise<MediaAsset> {
  const key = `${getProject(projectId).id}:${sfxId}`;
  let job = adding.get(key);
  if (!job) {
    job = withMediaHold(() => addLibrarySoundOnce(projectId, sfxId)).finally(() => adding.delete(key));
    adding.set(key, job);
  }
  return job;
}

async function addLibrarySoundOnce(projectId: string | undefined, sfxId: string): Promise<MediaAsset> {
  const def = SFX.find((x) => x.id === sfxId || x.name === sfxId);
  if (!def) throw new HttpError(400, `unknown sound effect: ${sfxId}. Available: ${SFX.map((x) => x.id).join(', ')}`);
  const existing = getProject(projectId).media.find((m) => m.libraryId === def.id);
  if (existing) return existing;
  const src = await sfxFile(def.id);
  const fileName = newMediaFileName(src);
  fs.copyFileSync(src, path.join(MEDIA_DIR, fileName));
  const now = new Date();
  fs.utimesSync(path.join(MEDIA_DIR, fileName), now, now);
  const asset = { ...(await registerMedia(fileName, def.name)), libraryId: def.id };
  addMedia(projectId, [asset], 'upload');
  return asset;
}
