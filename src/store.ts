import { create } from 'zustand';
import { applyOp, editableState, projectDuration, type EditableState, type Op } from '../shared/ops';
import type { Job, MediaAsset, Project } from '../shared/types';
import { getLang, t } from './i18n';

export const CLIENT_ID = 'ui_' + Math.random().toString(36).slice(2, 10);

export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { ...(init?.body && !(init.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}), 'X-Client-Id': CLIENT_ID, ...init?.headers },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data as T;
}

type Editable = EditableState;
const editable = editableState;

interface State {
  project: Project | null;
  projects: { id: string; name: string }[];
  time: number;
  playing: boolean;
  selected: string | null;
  /** A keyframe picked on the timeline (Delete removes it). */
  selectedKey: { clipId: string; t: number } | null;
  pps: number; // timeline pixels per second
  snap: boolean;
  history: Editable[];
  future: Editable[];
  jobs: Record<string, Job>;
  page: 'editor' | 'api';
  exportOpen: boolean;
  silenceOpen: boolean;
  toast: { text: string; kind: 'info' | 'error'; action?: { label: string; run: () => void } } | null;
  /** Offer to match the frame to the first video (landscape clip in a portrait project, etc.). */
  formatPrompt: { mediaId: string; orientation: 'landscape' | 'portrait' | 'square' } | null;
  /** Which side panels are open (the preview grows when they are closed). */
  helpOpen: boolean;
  uploading: boolean;
  remoteFlash: number;
  selectNonce: number;
  /** Set to a clip id to open its text for typing (the inspector focuses the text box). */
  editText: { id: string; n: number } | null;
  /** While previewing an effect: stop at this time and jump back to returnTo. */
  stopAt: number | null;
  returnTo: number;
  /** Plays the part of the clip where a transition / animation happens, so the user sees what was added. */
  showEffect(clipId: string, side: 'in' | 'out', message: string): void;
  startTextEdit(id: string): void;
  deleteProject(): Promise<void>;

  init(): Promise<void>;
  openProject(id: string): Promise<void>;
  createProject(templateId?: string, name?: string): Promise<void>;
  /** `tag`: consecutive runs with the same tag (slider drags) share one undo step. */
  run(ops: Op | Op[], tag?: string): void;
  preview(p: Project | null): void;
  undo(): void;
  redo(): void;
  seek(t: number): void;
  setPlaying(v: boolean): void;
  select(id: string | null): void;
  setPps(v: number): void;
  upload(files: FileList | File[]): Promise<MediaAsset[]>;
  startExport(quality: string, range: boolean, normalize?: boolean, opts?: { preset?: string | null; reframe?: 'fit' | 'fill' }): Promise<void>;
  startCaptions(language: string, maxWords?: number, opts?: { engine?: 'auto' | 'local' | 'cloud'; translateTo?: string }): Promise<void>;
  notify(text: string, kind?: 'info' | 'error', action?: { label: string; run: () => void }): void;
  set(patch: Partial<State>): void;
}

let events: EventSource | null = null;
let queue: Promise<unknown> = Promise.resolve();
let pending = 0;
let base: Project | null = null;
let recover: (e: Error) => Promise<boolean> = async () => false; // project state while a drag preview is active
let toastTimer = 0;
let lastTag = '';
let lastTagAt = 0;

export const useStore = create<State>((set, get) => {
  /** Sends requests one by one; when the queue drains, adopts the server's authoritative state. */
  const enqueue = (send: () => Promise<Project | { project?: Project }>) => {
    pending++;
    queue = queue
      .then(send)
      .then((res) => {
        pending--;
        const p = (res as { project?: Project }).project ?? (res as Project);
        if (pending === 0 && p?.id === get().project?.id && !base) set({ project: p });
      })
      .catch(async (e: Error) => {
        pending--;
        if (await recoverMissingProject(e)) return;
        get().notify(e.message, 'error');
        const id = get().project?.id;
        if (id) set({ project: await api<Project>(`/api/projects/${id}`) });
      });
  };

  /** The server no longer has the open project: switch to one it has, and say so. */
  const recoverMissingProject = async (e: Error): Promise<boolean> => {
    if (!/^project not found/.test(e.message)) return false;
    localStorage.removeItem('alon.project');
    set({ project: null, history: [], future: [] });
    await get().init();
    get().notify(t('store.projectMissing'), 'error');
    return true;
  };
  recover = recoverMissingProject;

  const connect = (id: string) => {
    events?.close();
    events = new EventSource(`/api/projects/${id}/events`);
    events.addEventListener('project', (ev) => {
      const { project, origin } = JSON.parse((ev as MessageEvent).data) as { project: Project; origin: string };
      const cur = get().project;
      if (origin === CLIENT_ID || project.id !== cur?.id) return;
      if (origin === 'init') {
        if (pending === 0 && project.rev !== cur.rev) set({ project });
        return;
      }
      // a change made outside this tab (REST / MCP / upload / captions job)
      const structural = origin !== 'upload';
      set((s) => ({
        project,
        history: structural ? [...s.history, editable(cur)].slice(-100) : s.history,
        future: structural ? [] : s.future,
        selected: project.clips.some((c) => c.id === s.selected) ? s.selected : null,
        time: Math.min(s.time, projectDuration(project)),
        remoteFlash: structural && origin !== 'captions' ? Date.now() : s.remoteFlash,
      }));
    });
    events.addEventListener('job', (ev) => {
      const job = JSON.parse((ev as MessageEvent).data) as Job;
      set((s) => ({ jobs: { ...s.jobs, [job.id]: job } }));
      // the server's job message is Hebrew; in English the count from the result is used instead
      const count = (job.result as { count?: unknown } | null | undefined)?.count;
      const n = getLang() === 'en' && typeof count === 'number' ? count : null;
      if (job.status === 'error' && !job.cancelled) get().notify(job.error ?? t('store.actionFailed'), 'error');
      if (job.status === 'done' && job.type === 'captions') get().notify(n !== null ? t(n === 1 ? 'store.captionsMadeOne' : 'store.captionsMadeMany', { n }) : t('store.captionsMade', { what: job.message ?? t('store.captionsWord') }));
      if (job.status === 'done' && job.type === 'translate') get().notify(n !== null ? t(n === 1 ? 'store.translatedOne' : 'store.translatedMany', { n }) : getLang() === 'en' ? t('store.translated') : job.message ?? t('store.translated'));
      if (job.status === 'done' && job.type === 'import') get().notify(t('store.importDone', { name: job.message ?? t('store.theFile') }));
      if (job.status === 'done' && job.type === 'export' && !get().exportOpen) get().notify(t('store.exportDoneToast'));
    });
  };

  const restore = (snap: Editable) => {
    const cur = get().project!;
    // undo never drops library files that were added since: keep the union
    const media = [...cur.media, ...snap.media.filter((m) => !cur.media.some((x) => x.id === m.id))];
    const next = { ...cur, ...snap, media };
    snap = { ...snap, media };
    set((s) => ({ project: next, selected: next.clips.some((c) => c.id === s.selected) ? s.selected : null, time: Math.min(s.time, projectDuration(next)) }));
    enqueue(() => api<Project>(`/api/projects/${cur.id}`, { method: 'PUT', body: JSON.stringify(snap) }));
  };

  return {
    project: null,
    projects: [],
    time: 0,
    playing: false,
    selected: null,
    selectedKey: null,
    silenceOpen: false,
    pps: 80,
    snap: true,
    history: [],
    future: [],
    jobs: {},
    page: 'editor',
    exportOpen: false,
    toast: null,
    formatPrompt: null,
    helpOpen: false,
    uploading: false,
    remoteFlash: 0,
    selectNonce: 0,
    editText: null,
    stopAt: null,
    returnTo: 0,
    showEffect(clipId, side, message) {
      const p = get().project;
      const c = p?.clips.find((x) => x.id === clipId);
      if (!p || !c) return;
      const d = side === 'in' ? c.transition?.duration ?? c.animIn?.duration ?? 0.5 : c.animOut?.duration ?? 0.5;
      const end = c.start + c.duration;
      const total = projectDuration(p);
      const from = side === 'in' ? Math.max(0, c.start - 0.5) : Math.max(c.start, end - d - 0.8);
      const to = side === 'in' ? Math.min(total, c.start + d + 0.8) : Math.min(total, end + 0.4);
      const at = side === 'in' ? c.start : end;
      const back = get().time;
      set({ time: from, playing: true, stopAt: to, returnTo: back });
      get().notify(t('store.showingEffect', { message, time: fmtTime(at, p.settings.fps) }));
    },
    startTextEdit(id) {
      set((s) => ({ selected: id, selectNonce: s.selectNonce + 1, editText: { id, n: (s.editText?.n ?? 0) + 1 }, playing: false }));
    },

    async init() {
      const list = await api<{ id: string; name: string }[]>('/api/projects');
      if (!list.length) {
        await get().createProject();
        return;
      }
      const lastId = localStorage.getItem('alon.project');
      await get().openProject(list.find((p) => p.id === lastId)?.id ?? list[0].id);
    },
    async openProject(id) {
      const project = await api<Project>(`/api/projects/${id}`);
      const projects = await api<{ id: string; name: string }[]>('/api/projects');
      localStorage.setItem('alon.project', project.id);
      set({ project, projects, history: [], future: [], selected: null, time: 0, playing: false, jobs: {} });
      connect(project.id);
    },
    async deleteProject() {
      const p = get().project;
      if (!p) return;
      await queue;
      events?.close();
      await api(`/api/projects/${p.id}`, { method: 'DELETE' });
      localStorage.removeItem('alon.project');
      set({ project: null });
      await get().init();
    },
    async createProject(templateId, name) {
      const count = get().projects.length;
      const p = await api<Project>('/api/projects', { method: 'POST', body: JSON.stringify({ name: name ?? (count ? t('store.newProjectN', { n: count + 1 }) : t('store.newProject')), ...(templateId ? { templateId } : {}) }) });
      await get().openProject(p.id);
    },

    run(ops, tag) {
      const list = Array.isArray(ops) ? ops : [ops];
      const cur = base ?? get().project;
      base = null;
      if (!cur) return;
      let next = cur;
      try {
        for (const op of list) next = applyOp(next, op);
      } catch (e) {
        set({ project: cur });
        get().notify((e as Error).message, 'error');
        return;
      }
      const merge = !!tag && tag === lastTag && Date.now() - lastTagAt < 1500;
      lastTag = tag ?? '';
      lastTagAt = Date.now();
      set((s) => ({
        project: next,
        history: merge ? s.history : [...s.history, editable(cur)].slice(-100),
        future: [],
        selected: next.clips.some((c) => c.id === s.selected) ? s.selected : null,
        time: Math.min(s.time, Math.max(projectDuration(next), 0)),
      }));
      enqueue(() => api<{ project: Project }>(`/api/projects/${cur.id}/ops?full=1`, { method: 'POST', body: JSON.stringify({ ops: list }) }));
    },
    /** Shows a not-yet-committed state while dragging. `null` cancels. */
    preview(p) {
      if (p) {
        base ??= get().project;
        set({ project: p });
      } else if (base) {
        set({ project: base });
        base = null;
      }
    },
    undo() {
      const { history, project } = get();
      if (!project || !history.length) return;
      const snap = history[history.length - 1];
      set((s) => ({ history: s.history.slice(0, -1), future: [...s.future, editable(project)] }));
      restore(snap);
    },
    redo() {
      const { future, project } = get();
      if (!project || !future.length) return;
      const snap = future[future.length - 1];
      set((s) => ({ future: s.future.slice(0, -1), history: [...s.history, editable(project)] }));
      restore(snap);
    },
    seek(t) {
      const p = get().project;
      set({ time: Math.max(0, Math.min(t, p ? projectDuration(p) : 0)) });
    },
    setPlaying(v) {
      const p = get().project;
      set({ stopAt: null });
      if (v && p && get().time >= projectDuration(p) - 0.02) set({ time: 0 });
      set({ playing: v && !!p && projectDuration(p) > 0 });
    },
    select: (id) => set((s) => ({ selected: id, selectNonce: s.selectNonce + 1, selectedKey: s.selectedKey?.clipId === id ? s.selectedKey : null })),
    setPps: (v) => set({ pps: Math.max(8, Math.min(600, v)) }),

    async upload(files) {
      const p = get().project;
      const list = [...files];
      if (!p || !list.length) return [];
      const fd = new FormData();
      for (const f of list) fd.append('files', f);
      set({ uploading: true });
      try {
        const res = await api<{ media: MediaAsset[]; errors: string[] }>(`/api/projects/${p.id}/media`, { method: 'POST', body: fd });
        if (res.errors.length) get().notify(res.errors[0], 'error');
        return res.media;
      } catch (e) {
        if (!(await recover(e as Error))) get().notify((e as Error).message, 'error');
        return [];
      } finally {
        set({ uploading: false });
      }
    },
    async startExport(quality, range, normalize = false, opts = {}) {
      const p = get().project;
      if (!p) return;
      try {
        await queue;
        const job = await api<Job>(`/api/projects/${p.id}/export`, { method: 'POST', body: JSON.stringify({ quality, range, normalize, ...opts }) });
        set((s) => ({ jobs: { ...s.jobs, [job.id]: s.jobs[job.id] ?? job } }));
      } catch (e) {
        if (!(await recover(e as Error))) get().notify((e as Error).message, 'error');
      }
    },
    async startCaptions(language, maxWords = 5, opts = {}) {
      const p = get().project;
      if (!p) return;
      try {
        await queue;
        const job = await api<Job>(`/api/projects/${p.id}/captions`, { method: 'POST', body: JSON.stringify({ language, maxWords, ...opts }) });
        set((s) => ({ jobs: { ...s.jobs, [job.id]: s.jobs[job.id] ?? job } }));
      } catch (e) {
        if (!(await recover(e as Error))) get().notify((e as Error).message, 'error');
      }
    },
    notify(text, kind = 'info', action) {
      set({ toast: { text, kind, action } });
      clearTimeout(toastTimer);
      toastTimer = window.setTimeout(() => set({ toast: null }), action ? 7000 : 4000);
    },
    set: (patch) => set(patch),
  };
});

export const latestJob = (jobs: Record<string, Job>, type: Job['type']): Job | undefined => {
  const list = Object.values(jobs).filter((j) => j.type === type);
  return list[list.length - 1];
};

/** Time as people read it: minutes:seconds.tenths, e.g. 0:08.5 (the old mm:ss:frames read like hours). */
export const fmtTime = (t: number, _fps = 30): string => {
  const d = Math.max(0, Math.floor(t * 10 + 1e-6));
  const m = Math.floor(d / 600);
  const sec = Math.floor((d % 600) / 10);
  return `${m}:${String(sec).padStart(2, '0')}.${d % 10}`;
};

/** Short duration in Hebrew-friendly form: "8.0 שנ׳" or "1:20 דק׳". */
export const fmtDuration = (d: number): string => (d < 60 ? t('store.sec', { n: d.toFixed(1) }) : t('store.min', { m: Math.floor(d / 60), s: String(Math.round(d % 60)).padStart(2, '0') }));
