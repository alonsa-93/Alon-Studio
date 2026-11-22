import fs from 'node:fs';
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { sanitizeState, summarize, type Op } from '../shared/ops';
import type { Job, MediaAsset, Project } from '../shared/types';
import { toSrt } from '../shared/fx';
import { addLibrarySound, addMedia, exportOptions, importMediaByPath, newProjectFrom, startCaptions, startExport } from './actions';
import { deleteTemplate, listTemplates, saveTemplate } from './templates';
import { EXPORT_PRESETS } from '../shared/layout';
import { listSfx, SFX_DIR } from './sfx';
import { addFontFile, addGoogleFont, deleteFamily, FONTS_DIR, listFonts } from './fonts';
import { deleteKey, getKey, keyStatus, setKey } from './keys';
import { searchStock, STOCK_PROVIDERS, stockThumb, type StockProvider } from './stock';
import { importFromUrl, importStock } from './importer';
import { localWhisperKnown, PYTHON, WHISPER_MODEL } from './captions';
import { AGENT_PROVIDERS, AI_BASE, aiSettings, STT_PROVIDERS, updateAiSettings, type AgentProvider } from './aiconfig';
import { listModels } from './llm';
import { startTranslate, TRANSLATE_LANGS } from './translate';
import { cloneVoice, listVoices, speak, voicePreview } from './voice';
import { agentState, agentTurn, approveDraft, cancelDraft, resetAgent, stopAgent } from './agent';
import { FFMPEG, newMediaFileName, registerMedia, run } from './media';
import { APP_MODE, openAppWindow, setupLogFile } from './desktop';
import { handleMcp } from './mcp';
import { planSilences } from './silence';
import { ACCESS_KEY, isInside, issueLaunchToken, launchChallenge, launchTokenByProof, mediaHeaders, originGuard, redeemLaunchToken, requireKey, requireKeyCookie, securityHeaders, tokenFromRunningStudio } from './security';
import { cancelJob, clearTmp, hasRunningJobs, holdMedia, removeUnusedMedia } from './store';
import { bus, createProject, deleteProject, EXPORTS_DIR, getJob, getProject, HttpError, listProjects, MEDIA_DIR, ROOT, runOps, saveProject } from './store';

const PORT = Number(process.env.PORT ?? 5173);
const HOST = process.env.HOST ?? '127.0.0.1';
const PRODUCTION = process.env.NODE_ENV === 'production';
if (!['127.0.0.1', '::1', 'localhost'].includes(HOST)) {
  console.error('ALON.ai Studio only runs on this computer (HOST must be 127.0.0.1 or ::1).');
  process.exit(1);
}
setupLogFile();
const app = express();
app.disable('x-powered-by');
const server = http.createServer(app);

// 1. security headers on every response
app.use(securityHeaders(PRODUCTION));
// 2. only this computer, only this app's own origin (no other site, no other localhost port, no DNS rebinding)
app.use((req, res, next) => {
  const a = req.socket.remoteAddress ?? '';
  if (a !== '127.0.0.1' && a !== '::1' && a !== '::ffff:127.0.0.1') {
    res.status(403).end();
    return;
  }
  next();
});
app.use(originGuard(PORT));
// 3. the access key on the API and MCP, the key cookie on the user's files
// the window trades its one-time launch token for the key cookie (the only /api call without the key)
app.post('/api/session', express.json({ limit: '1kb' }), redeemLaunchToken);
// a second launch proves it knows the key (HMAC challenge) without sending it
app.post('/api/session/challenge', express.json({ limit: '1kb' }), launchChallenge);
app.post('/api/session/proof', express.json({ limit: '1kb' }), launchTokenByProof);
app.use(['/api', '/mcp'], requireKey);
app.use(['/media', '/exports', '/library'], requireKeyCookie);
app.use(express.json({ limit: '20mb' }));

const wrap = (fn: (req: Request, res: Response) => unknown | Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => {
  Promise.resolve()
    .then(() => fn(req, res))
    .then((out) => {
      if (out !== undefined && !res.headersSent) res.json(out);
    })
    .catch(next);
};
const originOf = (req: Request) => String(req.headers['x-client-id'] ?? 'api');

// ---- projects ----
app.get('/api/projects', wrap(() => listProjects().map((p) => ({ id: p.id, name: p.name, updatedAt: p.updatedAt, rev: p.rev }))));
app.post('/api/projects', wrap((req) => newProjectFrom(String(req.body?.name ?? 'פרויקט חדש'), req.body?.templateId)));

// ---- templates ----
app.get('/api/templates', wrap(() => listTemplates()));
app.post('/api/projects/:id/template', wrap((req) => {
  const t = saveTemplate(getProject(req.params.id), String(req.body?.name ?? ''));
  return { id: t.id, name: t.name };
}));
app.delete('/api/templates/:id', wrap((req) => (deleteTemplate(req.params.id), { ok: true })));
app.get('/api/export-presets', wrap(() => EXPORT_PRESETS));
app.get('/api/projects/:id', wrap((req) => getProject(req.params.id)));
app.get('/api/projects/:id/summary', wrap((req) => summarize(getProject(req.params.id))));
app.delete(
  '/api/projects/:id',
  wrap((req) => {
    if (req.params.id === 'current') throw new HttpError(400, 'deleting needs an explicit project id');
    deleteProject(req.params.id);
    return { ok: true };
  }),
);

// Replace the editable state (used by the UI for undo / redo).
app.put(
  '/api/projects/:id',
  wrap((req) => {
    const p = getProject(req.params.id);
    let clean: ReturnType<typeof sanitizeState>;
    try {
      // same rules as the single operations: nothing reaches ffmpeg or the subtitles unchecked
      clean = sanitizeState(req.body as Partial<Project>, p.media);
    } catch (e) {
      throw new HttpError(400, `invalid project state: ${(e as Error).message}`);
    }
    // a media entry that is re-added (undo of a removal) must still have its file in the media folder
    const readded = clean.media.filter((m) => !p.media.some((x) => x.id === m.id));
    if (readded.some((m) => !fs.existsSync(path.join(MEDIA_DIR, m.file)))) throw new HttpError(400, 'invalid project state: a media file is missing');
    return saveProject({ ...p, ...clean, media: [...p.media, ...readded] }, originOf(req));
  }),
);

// ---- editing operations ----
app.post(
  '/api/projects/:id/ops',
  wrap((req) => {
    const body = req.body;
    const ops: Op[] = Array.isArray(body) ? body : Array.isArray(body?.ops) ? body.ops : body?.op ? [body] : [];
    if (!ops.length) throw new HttpError(400, 'send {"op": "...", ...} or {"ops": [...]}');
    const p = runOps(req.params.id, ops, originOf(req));
    return req.query.full ? { ok: true, rev: p.rev, project: p } : { ok: true, rev: p.rev, summary: summarize(p) };
  }),
);
// silence removal: {thresholdDb?, minSilence?, padding?, dryRun?}. dryRun (default) only plans the cuts; the
// cuts are cut_range ops, applied here in one batch or sent by the editor as one undo step
app.post(
  '/api/projects/:id/silences',
  wrap(async (req) => {
    const b = req.body ?? {};
    const plan = await planSilences(getProject(req.params.id), b);
    if (b.dryRun === false && plan.ops.length) {
      const p = runOps(req.params.id, plan.ops, originOf(req));
      return { ...plan, applied: true, rev: p.rev, summary: summarize(p) };
    }
    return { ...plan, applied: false };
  }),
);

// ---- media ----
const projectExists = (req: Request, _res: Response, next: NextFunction) => {
  try {
    getProject(req.params.id);
    next();
  } catch (e) {
    next(e);
  }
};

const upload = multer({
  storage: multer.diskStorage({
    destination: MEDIA_DIR,
    filename: (_req, file, cb) => cb(null, newMediaFileName(file.originalname)),
  }),
  limits: { fileSize: 8 * 1024 ** 3, files: 10, fields: 10, parts: 20 },
});
// the media clean-up waits while the files of this upload are on their way into the media folder
const holdDuringRequest: express.RequestHandler = (_req, res, next) => {
  const release = holdMedia();
  res.on('close', release);
  res.on('finish', release);
  next();
};
app.post(
  '/api/projects/:id/media',
  projectExists,
  holdDuringRequest,
  upload.array('files', 10),
  wrap(async (req) => {
    const p = getProject(req.params.id);
    const assets: MediaAsset[] = [];
    const errors: string[] = [];
    for (const f of (req.files as Express.Multer.File[]) ?? []) {
      const name = Buffer.from(f.originalname, 'latin1').toString('utf8');
      try {
        assets.push(await registerMedia(f.filename, name));
      } catch (e) {
        fs.rmSync(f.path, { force: true });
        errors.push(e instanceof HttpError ? `קובץ מדיה לא נתמך: ${name}` : (e as Error).message);
      }
    }
    if (!assets.length) throw new HttpError(400, errors[0] ?? 'לא התקבלו קבצים');
    addMedia(p.id, assets, 'upload');
    return { media: assets, errors };
  }),
);
app.post(
  '/api/projects/:id/media/import',
  wrap(async (req) => {
    if (typeof req.body?.path !== 'string') throw new HttpError(400, '"path" is required');
    getProject(req.params.id);
    return { media: await importMediaByPath(req.params.id, req.body.path) };
  }),
);

// ---- captions / export / jobs ----
app.post('/api/projects/:id/captions', wrap((req) => jobView(startCaptions(req.params.id, req.body?.language ?? 'he', req.body?.model, req.body?.maxWords, { engine: req.body?.engine, translateTo: req.body?.translateTo || undefined }))));
app.post('/api/projects/:id/captions/translate', wrap((req) => jobView(startTranslate(req.params.id, req.body?.to, req.body?.keepOriginal, req.body?.position))));
app.get('/api/projects/:id/captions.srt', (req, res, next) => {
  try {
    const p = getProject(req.params.id);
    const caps = p.clips.filter((c) => c.kind === 'caption').sort((a, b) => a.start - b.start).map((c) => ({ start: c.start, end: c.start + c.duration, text: c.text ?? '' }));
    res.setHeader('Content-Type', 'application/x-subrip; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="captions.srt"; filename*=UTF-8''${encodeURIComponent(p.name)}.srt`);
    res.send('\uFEFF' + toSrt(caps));
  } catch (e) {
    next(e);
  }
});
app.post('/api/projects/:id/export', wrap((req) => jobView(startExport(req.params.id, req.body?.quality ?? 'medium', req.body?.range !== false, !!req.body?.normalize, exportOptions(req.body ?? {})))));

// ---- built-in sound effects ----
app.get('/api/library/sfx', wrap(() => listSfx()));
app.post(
  '/api/projects/:id/media/library',
  wrap(async (req) => {
    if (typeof req.body?.id !== 'string') throw new HttpError(400, '"id" is required');
    return { media: await addLibrarySound(req.params.id, req.body.id) };
  }),
);
// ---- fonts (uploaded or from Google Fonts; stored as TTF / OTF for libass) ----
const fontUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 ** 2, files: 10, fields: 5, parts: 15 } });
app.get('/api/fonts', wrap(() => listFonts()));
app.post(
  '/api/fonts',
  fontUpload.array('files', 10),
  wrap(async (req) => {
    const added: { family: string; weight: number; italic: boolean }[] = [];
    const errors: string[] = [];
    for (const f of (req.files as Express.Multer.File[]) ?? []) {
      const name = Buffer.from(f.originalname, 'latin1').toString('utf8');
      try {
        const face = addFontFile(f.buffer, 'upload', name);
        added.push({ family: face.family, weight: face.weight, italic: face.italic });
      } catch (e) {
        errors.push(`${name}: ${(e as Error).message}`);
      }
    }
    if (!added.length) throw new HttpError(400, errors[0] ?? 'לא התקבלו קבצים');
    return { added, errors, fonts: listFonts() };
  }),
);
app.post(
  '/api/fonts/google',
  wrap(async (req) => {
    if (typeof req.body?.family !== 'string') throw new HttpError(400, '"family" is required');
    const r = await addGoogleFont(req.body.family);
    return { ...r, fonts: listFonts() };
  }),
);
app.delete(
  '/api/fonts/:family',
  wrap((req) => {
    deleteFamily(req.params.family);
    return { fonts: listFonts() };
  }),
);
// ---- API keys of outside services (never sent back: only whether one is set and its last 4 characters) ----
app.get('/api/keys', wrap(() => keyStatus()));
app.put('/api/keys/:provider', wrap((req) => setKey(req.params.provider, req.body?.key)));
app.delete('/api/keys/:provider', wrap((req) => deleteKey(req.params.provider)));

// ---- AI and cloud services: settings (no secrets), models, narration, the AI agent ----
app.get(
  '/api/ai/settings',
  wrap(() => ({
    settings: aiSettings(),
    stt: STT_PROVIDERS,
    agent: AGENT_PROVIDERS,
    languages: TRANSLATE_LANGS,
    // null while the check of the local Whisper install still runs
    localWhisper: localWhisperKnown(),
  })),
);
app.put('/api/ai/settings', wrap((req) => ({ settings: updateAiSettings(req.body) })));
app.get(
  '/api/ai/models',
  wrap(async (req) => {
    const provider = String(req.query.provider ?? aiSettings().agent.provider) as AgentProvider;
    if (!Object.hasOwn(AGENT_PROVIDERS, provider)) throw new HttpError(400, 'unknown provider');
    const key = getKey(provider);
    if (AGENT_PROVIDERS[provider].keyRequired && !key) throw new HttpError(400, `חסר מפתח API של ${AGENT_PROVIDERS[provider].label}`);
    const baseUrl = provider === 'local' ? aiSettings().agent.baseUrl : AI_BASE[provider];
    return { models: await listModels({ provider, baseUrl, key }) };
  }),
);
app.get('/api/voice/voices', wrap((req) => listVoices({ q: req.query.q, language: req.query.language, mine: req.query.mine === '1' || req.query.mine === 'true' })));
app.get('/api/voice/voices/:id/preview', (req, res, next) => {
  voicePreview(req.params.id, req.query.language)
    .then((file) => {
      res.setHeader('Content-Type', 'audio/wav');
      res.setHeader('Cache-Control', 'no-store');
      res.sendFile(file, { dotfiles: 'deny' }, (e) => e && !res.headersSent && next(e));
    })
    .catch(next);
});
app.post('/api/projects/:id/speak', wrap((req) => speak(req.params.id, req.body ?? {})));
app.post('/api/projects/:id/clone-voice', wrap((req) => cloneVoice(req.params.id, req.body ?? {})));
app.get('/api/projects/:id/agent', wrap((req) => agentState(req.params.id)));
app.delete('/api/projects/:id/agent', wrap((req) => resetAgent(req.params.id)));
app.post(
  '/api/projects/:id/agent',
  wrap((req, res) => {
    // closing the request (the user left or pressed stop) stops the agent; what it did stays in the draft
    const ctl = new AbortController();
    res.on('close', () => !res.writableFinished && ctl.abort());
    return agentTurn(req.params.id, req.body ?? {}, ctl.signal);
  }),
);
app.post('/api/projects/:id/agent/stop', wrap((req) => stopAgent(req.params.id)));
app.post('/api/projects/:id/agent/approve', wrap((req) => approveDraft(req.params.id)));
app.post('/api/projects/:id/agent/cancel', wrap((req) => cancelDraft(req.params.id)));

// ---- stock and import from a link (background jobs with progress) ----
app.get('/api/stock/providers', wrap(() => Object.entries(STOCK_PROVIDERS).map(([id, p]) => ({ id, ...p, hasKey: !p.key || !!getKey(id as Exclude<StockProvider, 'openverse'>) }))));
app.get('/api/stock/search', wrap((req) => searchStock(String(req.query.provider ?? ''), String(req.query.kind ?? ''), String(req.query.q ?? ''), Number(req.query.page ?? 1))));
app.post('/api/projects/:id/media/stock', wrap((req) => jobView(importStock(req.params.id, req.body?.id))));
app.post('/api/projects/:id/media/url', wrap((req) => jobView(importFromUrl(req.params.id, req.body?.url))));
app.get(
  '/api/projects/:id/credits',
  wrap((req) => {
    const p = getProject(req.params.id);
    const used = new Set(p.clips.map((c) => c.mediaId));
    const items = p.media.filter((m) => m.credit).map((m) => ({ mediaId: m.id, name: m.name, used: used.has(m.id), credit: m.credit! }));
    const line = (c: NonNullable<(typeof items)[number]['credit']>) => [c.title && `"${c.title}"`, c.author && `by ${c.author}`, `(${c.provider}, ${c.license})`, c.sourceUrl].filter(Boolean).join(' ');
    return { items, text: items.filter((i) => i.used).map((i) => line(i.credit)).join('\n') };
  }),
);
app.get('/api/jobs/:id', wrap((req) => jobView(getJob(req.params.id))));
// a new one-time window link (used by a second launch while the studio already runs)
app.post('/api/session/token', wrap(() => ({ token: issueLaunchToken() })));
// the key itself, for the "API / MCP" page (the window holds only the cookie)
app.get('/api/access-key', wrap(() => ({ key: ACCESS_KEY })));
// shows an exported file in Windows Explorer (only files inside the exports folder)
app.post(
  '/api/exports/reveal',
  wrap((req) => {
    // a file NAME inside the exports folder (links / junctions resolved), nothing else
    if (typeof req.body?.file !== 'string') throw new HttpError(400, '"file" is required');
    const name = path.basename(req.body.file);
    let file: string;
    try {
      file = fs.realpathSync(path.join(EXPORTS_DIR, name));
    } catch {
      throw new HttpError(400, 'file not found in the exports folder');
    }
    if (!isInside(file, fs.realpathSync(EXPORTS_DIR)) || !fs.statSync(file).isFile() || /[,"]/.test(file)) throw new HttpError(400, 'file not found in the exports folder');
    if (process.platform === 'win32') spawn('explorer.exe', [`/select,${file}`], { detached: true, stdio: 'ignore' }).unref();
    else spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [path.dirname(file)], { detached: true, stdio: 'ignore' }).unref();
    return { ok: true };
  }),
);
app.post('/api/jobs/:id/cancel', wrap((req) => jobView(cancelJob(req.params.id))));
const jobView = (j: Job) => ({ jobId: j.id, ...j });

// ---- desktop mode: the server lives as long as a studio window is connected ----
let windows = 0;
let quitTimer: NodeJS.Timeout | null = null;
const scheduleQuit = (ms: number) => {
  if (!APP_MODE) return;
  if (quitTimer) clearTimeout(quitTimer);
  quitTimer = setTimeout(() => {
    if (windows > 0) return;
    if (hasRunningJobs()) return scheduleQuit(15000); // let an export finish
    process.exit(0);
  }, ms);
};
function windowOpened() {
  windows++;
  if (quitTimer) clearTimeout(quitTimer);
  quitTimer = null;
}
function windowClosed() {
  windows = Math.max(0, windows - 1);
  if (windows === 0) scheduleQuit(12000); // survives a page reload
}

// ---- live updates (SSE) ----
const MAX_STREAMS = 20;
let streams = 0;
app.get('/api/projects/:id/events', (req, res, next) => {
  if (streams >= MAX_STREAMS) {
    res.status(429).json({ error: 'too many open windows' });
    return;
  }
  let p: Project;
  try {
    p = getProject(req.params.id);
  } catch (e) {
    next(e);
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send('project', { project: p, origin: 'init' });
  const onProject = (proj: Project, origin: string) => proj.id === p.id && send('project', { project: proj, origin });
  const onJob = (job: Job) => job.projectId === p.id && send('job', job);
  bus.on('project', onProject);
  bus.on('job', onJob);
  streams++;
  windowOpened();
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    clearInterval(ping);
    bus.off('project', onProject);
    bus.off('job', onJob);
    streams--;
    windowClosed();
  });
});

// ---- health ----
let health: Promise<Record<string, unknown>> | null = null;
app.get(
  '/api/health',
  wrap(() => {
    health ??= (async () => {
      const ff = await run(FFMPEG, ['-version']).catch(() => null);
      const fw = await run(PYTHON, ['-c', 'import importlib.util,sys;sys.exit(0 if importlib.util.find_spec("faster_whisper") else 1)']).catch(() => null);
      return { ffmpeg: ff?.code === 0 ? ff.stdout.split('\n')[0] : null, whisper: fw?.code === 0, whisperModel: WHISPER_MODEL, port: PORT };
    })();
    return health;
  }),
);

// ---- MCP (Streamable HTTP) ----
app.all('/mcp', (req, res) => void handleMcp(req, res));

app.use('/media', express.static(MEDIA_DIR, { fallthrough: false, dotfiles: 'deny', setHeaders: mediaHeaders }));
app.use('/library/sfx', express.static(SFX_DIR, { fallthrough: false, dotfiles: 'deny', setHeaders: mediaHeaders }));
app.get('/library/stock-thumb/:id', (req, res, next) => {
  stockThumb(req.params.id)
    .then((file) => {
      res.setHeader('Cache-Control', 'private, max-age=3600');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.type(fs.readFileSync(file).subarray(0, 4).toString('hex').startsWith('89504e47') ? 'png' : 'jpeg');
      res.sendFile(file);
    })
    .catch(next);
});
app.use('/library/fonts', (req, _res, next) => (/^\/f_[a-z0-9]{6,16}\.(ttf|otf)$/.test(req.path) ? next() : next(new HttpError(404, 'not found'))), express.static(FONTS_DIR, { fallthrough: false, dotfiles: 'deny', setHeaders: mediaHeaders }));
// nothing else under /library (a path like /library/fonts/../x must not fall through to the app page)
app.use('/library', (_req, _res, next) => next(new HttpError(404, 'not found')));
app.use('/exports', express.static(EXPORTS_DIR, { fallthrough: false, dotfiles: 'deny', setHeaders: (res) => (mediaHeaders(res), res.setHeader('Content-Disposition', 'attachment')) }));
app.use('/api', (_req, _res, next) => next(new HttpError(404, 'unknown API endpoint')));

// ---- client (Vite dev middleware, or the production build when dist/ exists and NODE_ENV=production) ----
const dist = path.join(ROOT, 'dist');
if (PRODUCTION && fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
} else {
  const { createServer } = await import('vite');
  const vite = await createServer({ root: ROOT, appType: 'spa', server: { middlewareMode: true, hmr: { server } } });
  app.use(vite.middlewares);
}

app.use((err: Error & { status?: number; code?: string }, _req: Request, res: Response, _next: NextFunction) => {
  const multerErr = err.name === 'MulterError';
  const status = err instanceof HttpError ? err.status : err.code === 'ENOENT' ? 404 : multerErr ? 400 : err.status ?? 500;
  if (status >= 500 && !(err instanceof HttpError && status !== 500)) console.error(err);
  // unexpected errors: details go to the log only, not to the caller
  // (an HttpError is a message written for the user, also when an outside service failed: 502)
  const message = err.code === 'ENOENT' ? 'not found' : multerErr ? `upload rejected: ${err.message}. Send up to 10 files in the multipart field "files"` : status >= 500 && !(err instanceof HttpError) ? 'internal error' : err.message;
  if (!res.headersSent) res.status(status).json({ error: message });
});

server.on('error', (e: NodeJS.ErrnoException) => {
  if (e.code === 'EADDRINUSE' && APP_MODE) {
    // the studio is already running: just bring up another window on it
    // ask the running studio for a window link; the key is never sent (the port might belong to another program)
    tokenFromRunningStudio(PORT)
      .then((token) => (token ? openAppWindow(`http://localhost:${PORT}/#t=${token}`) : console.error(`port ${PORT} is used by another program, not this studio`)))
      .catch((err) => console.error('could not reach the running studio', err))
      .finally(() => setTimeout(() => process.exit(0), 2500));
    return;
  }
  console.error(e.code === 'EADDRINUSE' ? `הפורט ${PORT} תפוס. סגרו את התהליך שמשתמש בו או הריצו עם PORT אחר.` : e);
  process.exit(1);
});
if (HOST === '127.0.0.1') {
  // "localhost" may resolve to IPv6 first; answer there too (best effort).
  http
    .createServer(app)
    .on('upgrade', (req, socket, head) => server.emit('upgrade', req, socket, head)) // Vite HMR websocket
    .on('error', () => {})
    .listen(PORT, '::1');
}
// files of media that no project uses any more (removed in an earlier session) are deleted at start
try {
  clearTmp();
  removeUnusedMedia(10 * 60_000);
} catch (e) {
  console.error(e);
}
server.listen(PORT, HOST, () => {
  console.log(`\n  ALON.ai Studio  ->  http://localhost:${PORT}`);
  console.log(`  REST API        ->  http://localhost:${PORT}/api`);
  console.log(`  MCP             ->  http://localhost:${PORT}/mcp\n`);
  // the key opens the studio; it is printed only in development (in the app it would end up in the log file)
  if (!APP_MODE) console.log(`  Open:  http://localhost:${PORT}/#k=${ACCESS_KEY}\n`);
  if (APP_MODE) {
    openAppWindow(`http://localhost:${PORT}/#t=${issueLaunchToken()}`);
    scheduleQuit(5 * 60 * 1000); // nobody ever connected: do not linger forever
  }
});
