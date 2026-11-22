import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { applyOp, newProject, sanitizeState, uid, type Op } from '../shared/ops';
import type { Job, Project } from '../shared/types';

export const ROOT = path.resolve(import.meta.dirname, '..');
export const DATA_DIR = path.resolve(process.env.ALON_DATA_DIR ?? path.join(ROOT, 'data'));
export const PROJECTS_DIR = path.join(DATA_DIR, 'projects');
export const MEDIA_DIR = path.join(DATA_DIR, 'media');
export const EXPORTS_DIR = path.join(DATA_DIR, 'exports');
export const TMP_DIR = path.join(DATA_DIR, 'tmp');
export const TEMPLATES_DIR = path.join(DATA_DIR, 'templates');

for (const d of [PROJECTS_DIR, MEDIA_DIR, EXPORTS_DIR, TMP_DIR, TEMPLATES_DIR]) fs.mkdirSync(d, { recursive: true });

/** 'project' events: (project, origin). 'job' events: (job). */
export const bus = new EventEmitter();
bus.setMaxListeners(200);

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const cache = new Map<string, Project>();
const safeId = (id: string) => /^[A-Za-z0-9_-]{1,64}$/.test(id);
const fileOf = (id: string) => path.join(PROJECTS_DIR, `${id}.json`);

function load(id: string): Project | undefined {
  if (cache.has(id)) return cache.get(id);
  if (!safeId(id) || !fs.existsSync(fileOf(id))) return undefined;
  let p: Project;
  try {
    p = JSON.parse(fs.readFileSync(fileOf(id), 'utf8')) as Project;
  } catch {
    p = null as unknown as Project;
  }
  // readable JSON is not enough: the editor needs the basic shape
  if (!p || typeof p !== 'object' || p.id !== id || typeof p.name !== 'string' || typeof p.updatedAt !== 'string' || !Array.isArray(p.tracks) || !Array.isArray(p.clips) || !Array.isArray(p.media) || !p.settings || typeof p.settings !== 'object') {
    throw new HttpError(409, `the project file ${id}.json is damaged and cannot be opened`);
  }
  cache.set(id, p);
  return p;
}

export function listProjects(): Project[] {
  const ids = fs
    .readdirSync(PROJECTS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -5));
  return ids
    .map((id) => {
      // one damaged file must not hide every other project
      try {
        return load(id);
      } catch {
        return undefined;
      }
    })
    .filter((p): p is Project => !!p)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Resolves a project id. "current" (or an empty id) means the most recently edited project. */
export function getProject(id?: string): Project {
  if (!id || id === 'current') {
    const all = listProjects();
    // a read never creates anything (a GET from anywhere must not have side effects)
    if (!all[0]) throw new HttpError(404, 'there are no projects yet');
    return all[0];
  }
  const p = load(id);
  if (!p) throw new HttpError(404, `project not found: ${id}`);
  return p;
}

function write(p: Project) {
  const tmp = fileOf(p.id) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(p, null, 2));
  fs.renameSync(tmp, fileOf(p.id));
}

export function saveProject(p: Project, origin = 'api'): Project {
  const prev = cache.get(p.id);
  const next: Project = { ...p, rev: (prev?.rev ?? p.rev ?? 0) + 1, updatedAt: new Date().toISOString() };
  cache.set(next.id, next);
  write(next);
  bus.emit('project', next, origin);
  return next;
}

export function createProject(name: string): Project {
  const p = newProject(uid('p_'), name || 'פרויקט חדש');
  cache.set(p.id, p);
  write(p);
  return p;
}

export function deleteProject(id: string) {
  // a damaged project file can still be deleted (its media stay until they are proven unused)
  if (id !== 'current' && safeId(id) && fs.existsSync(fileOf(id))) {
    try {
      load(id);
    } catch {
      cache.delete(id);
      fs.rmSync(fileOf(id), { force: true });
      return;
    }
  }
  const p = getProject(id);
  cache.delete(p.id);
  fs.rmSync(fileOf(p.id), { force: true });
  // the AI agent's conversation and draft for this project
  fs.rmSync(path.join(DATA_DIR, 'agent', `${p.id}.json`), { force: true });
  // the project's videos, thumbnails, previews and waveforms go too, unless another project uses them
  try {
    removeUnusedMedia();
  } catch {
    /* the files go at the next start */
  }
}

// While a file is being added to the media folder (upload, import, sound effect) it belongs to no project yet;
// the clean-up below must not touch the folder until that is done.
let mediaHolds = 0;
export function holdMedia(): () => void {
  mediaHolds++;
  let released = false;
  return () => {
    if (!released) (released = true), mediaHolds--;
  };
}
export async function withMediaHold<T>(fn: () => Promise<T>): Promise<T> {
  const release = holdMedia();
  try {
    return await fn();
  } finally {
    release();
  }
}

/** Leftovers of an earlier run that ended abruptly (mixed speech audio, subtitle files, half-written exports). */
export function clearTmp() {
  for (const f of fs.readdirSync(TMP_DIR)) fs.rmSync(path.join(TMP_DIR, f), { recursive: true, force: true });
}

/**
 * Deletes files in the media folder that no project refers to any more (privacy: copies of people's
 * faces and voices should not stay behind). Recent files are kept (an upload may still be in flight).
 */
export function removeUnusedMedia(minAgeMs = 60_000): number {
  if (mediaHolds > 0) return 0;
  const used = new Set<string>();
  for (const f of fs.readdirSync(PROJECTS_DIR).filter((x) => x.endsWith('.json'))) {
    // a project file that cannot be read (renamed, damaged) may still own media: then delete nothing
    const p = safeId(f.slice(0, -5)) ? (() => { try { return load(f.slice(0, -5)); } catch { return undefined; } })() : undefined;
    if (!p || !Array.isArray(p.media)) return 0;
    for (const m of p.media) for (const x of [m.file, m.proxy, m.thumb, m.wave]) if (x) used.add(x);
  }
  // a template's logo stays too; a template file that cannot be read may own media: then delete nothing
  for (const f of fs.readdirSync(TEMPLATES_DIR).filter((x) => x.endsWith('.json'))) {
    let media: Project['media'];
    try {
      media = JSON.parse(fs.readFileSync(path.join(TEMPLATES_DIR, f), 'utf8'))?.state?.media;
    } catch {
      return 0;
    }
    if (!Array.isArray(media)) return 0;
    for (const m of media) for (const x of [m.file, m.proxy, m.thumb, m.wave]) if (x) used.add(x);
  }
  let removed = 0;
  for (const f of fs.readdirSync(MEDIA_DIR)) {
    if (used.has(f) || !/^m_[a-z0-9]+/.test(f)) continue;
    const full = path.join(MEDIA_DIR, f);
    try {
      if (Date.now() - fs.statSync(full).mtimeMs < minAgeMs) continue;
      fs.rmSync(full, { force: true });
      removed++;
    } catch {
      /* in use: next time */
    }
  }
  return removed;
}

export function runOps(id: string | undefined, ops: Op[], origin = 'api'): Project {
  return saveProject(applyChecked(getProject(id), ops), origin);
}

/** Applies operations to a copy and checks the result like a saved project; nothing is saved. */
export function applyChecked(p: Project, ops: Op[]): Project {
  for (const op of ops) {
    try {
      p = applyOp(p, op);
    } catch (e) {
      throw new HttpError(400, `${(op as { op?: string })?.op ?? 'op'}: ${(e as Error).message}`);
    }
  }
  // the result passes the same strict check as a whole undo state (types, ids, lengths): an operation
  // from a program or an AI client can never leave a project the editor cannot open
  let clean: ReturnType<typeof sanitizeState>;
  try {
    clean = sanitizeState(p, p.media);
  } catch (e) {
    throw new HttpError(400, `the operations would leave an invalid project: ${(e as Error).message}`);
  }
  return { ...p, ...clean, media: p.media };
}

// ---- jobs ----
const jobs = new Map<string, Job>();

export function createJob(projectId: string, type: Job['type']): Job {
  // one export and one transcription at a time: both use the whole CPU, and a flood of jobs must not freeze the PC
  if ([...jobs.values()].some((j) => j.type === type && j.status === 'running')) throw new HttpError(429, type === 'export' ? 'ייצוא אחר עדיין רץ. חכו שיסתיים' : type === 'import' ? 'הורדה אחרת עדיין רצה. חכו שתסתיים' : type === 'translate' ? 'תרגום אחר עדיין רץ. חכו שיסתיים' : 'תמלול אחר עדיין רץ. חכו שיסתיים');
  // keep only the latest finished jobs
  const done = [...jobs.values()].filter((j) => j.status !== 'running');
  for (const j of done.slice(0, Math.max(0, done.length - 50))) jobs.delete(j.id);
  const job: Job = { id: uid('j_'), projectId, type, status: 'running', progress: 0, startedAt: Date.now(), elapsed: 0 };
  jobs.set(job.id, job);
  bus.emit('job', job);
  return job;
}

export function updateJob(job: Job, patch: Partial<Job>) {
  Object.assign(job, patch);
  bus.emit('job', job);
}

export const hasRunningJobs = () => [...jobs.values()].some((j) => j.status === 'running');

/** Processes that belong to a running job, so the job can be cancelled. */
const jobProcs = new Map<string, { kill: () => void }>();
export const attachProcess = (jobId: string, proc: { kill: () => void }) => jobProcs.set(jobId, proc);
export const detachProcess = (jobId: string) => jobProcs.delete(jobId);
export function cancelJob(id: string): Job {
  const job = getJob(id);
  if (job.status !== 'running') return job;
  jobProcs.get(id)?.kill();
  jobProcs.delete(id);
  updateJob(job, { status: 'error', error: 'בוטל', cancelled: true } as Partial<Job>);
  return job;
}

export function getJob(id: string): Job {
  const j = jobs.get(id);
  if (!j) throw new HttpError(404, `job not found: ${id}`);
  return j;
}

export function waitForJob(id: string): Promise<Job> {
  return new Promise((resolve) => {
    const check = (j: Job) => {
      if (j.id === id && j.status !== 'running') {
        bus.off('job', check);
        resolve(j);
      }
    };
    bus.on('job', check);
    check(getJob(id));
  });
}
