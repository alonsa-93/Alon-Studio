import fs from 'node:fs';
import path from 'node:path';
import type { Job, Project } from '../shared/types';
import { run } from './media';
import { renderSpeechWav } from './render';
import { attachProcess, detachProcess, HttpError, ROOT, runOps, updateJob } from './store';
import { aiSettings, STT_PROVIDERS, sttModel } from './aiconfig';
import { transcribeCloud } from './cloudstt';
import { getKey } from './keys';
import { translateLines, spreadWords } from './translate';

export const PYTHON = process.env.WHISPER_PYTHON ?? 'python';
export const WHISPER_MODEL = process.env.WHISPER_MODEL ?? 'medium';
/** Hebrew speech: the ivrit.ai fine-tune of Whisper large-v3 turbo (pinned in transcribe.py). */
export const WHISPER_MODEL_HE = process.env.WHISPER_MODEL_HE ?? 'ivrit-ai/whisper-large-v3-turbo-ct2';

export type Engine = 'auto' | 'local' | 'cloud';

// is faster-whisper installed in the Python the app uses? (checked at most every 10 minutes)
// (importing it can take half a minute on a slow disk, so the settings page never waits for it: localWhisperKnown)
let localCheck: { at: number; ok: Promise<boolean>; result?: boolean } | null = null;
export function localWhisperReady(): Promise<boolean> {
  // a failed check is retried after a minute (Windows can block a DLL once and allow it on the next try)
  if (!localCheck || Date.now() - localCheck.at > (localCheck.result === false ? 60_000 : 10 * 60_000)) {
    const check: NonNullable<typeof localCheck> = { at: Date.now(), ok: Promise.resolve(false) };
    let child: { kill: () => void } | undefined;
    const timer = setTimeout(() => child?.kill(), 90_000);
    check.ok = run(PYTHON, ['-c', 'import faster_whisper'], { onSpawn: (c) => (child = c) })
      .then((r) => r.code === 0, () => false)
      .then((ok) => {
        clearTimeout(timer);
        check.result = ok;
        return ok;
      });
    localCheck = check;
  }
  return localCheck.ok;
}
/** The answer if it is already known; null while the check runs (it is started here). */
export function localWhisperKnown(): boolean | null {
  void localWhisperReady();
  return localCheck?.result ?? null;
}

/** auto: this computer when Whisper is installed, otherwise the cloud provider (when it has a key). */
export async function chooseEngine(requested?: Engine): Promise<'local' | 'cloud'> {
  const s = aiSettings().transcription;
  const engine = requested ?? s.engine;
  if (engine === 'local') return 'local';
  if (engine === 'cloud') return 'cloud';
  if (await localWhisperReady()) return 'local';
  if (getKey(s.provider)) return 'cloud';
  throw new HttpError(400, `התמלול המקומי (faster-whisper) לא מותקן במחשב הזה, ואין מפתח לתמלול בענן. שמרו מפתח של ${STT_PROVIDERS[s.provider].label} בהגדרות התמלול`);
}

interface Word {
  start: number;
  end: number;
  text: string;
  segment?: boolean;
}

export interface Caption {
  start: number;
  end: number;
  text: string;
  words?: { s: number; e: number; w: string }[];
}

/** Groups word timestamps into short on-screen captions. */
export function chunkWords(words: Word[], maxChars = 26, maxWords = 5, maxGap = 0.6): Caption[] {
  const out: Caption[] = [];
  let cur: Word[] = [];
  const flush = () => {
    if (!cur.length) return;
    const start = cur[0].start;
    out.push({ start, end: cur[cur.length - 1].end, text: cur.map((w) => w.text).join(' '), words: cur.map((w) => ({ s: Math.round((w.start - start) * 1000) / 1000, e: Math.round((w.end - start) * 1000) / 1000, w: w.text })) });
    cur = [];
  };
  for (const w of words) {
    if (w.segment) {
      flush();
      out.push({ start: w.start, end: w.end, text: w.text });
      continue;
    }
    const len = cur.reduce((s, x) => s + x.text.length + 1, 0);
    const prev = cur[cur.length - 1];
    if (prev && (len + w.text.length > maxChars || cur.length >= maxWords || w.start - prev.end > maxGap || /[.?!…]$/.test(prev.text))) flush();
    cur.push(w);
  }
  flush();
  // keep each caption on screen long enough to read, without overlapping the next one
  for (let i = 0; i < out.length; i++) {
    const next = out[i + 1];
    const minEnd = out[i].start + 0.6;
    if (out[i].end < minEnd) out[i].end = next ? Math.min(minEnd, next.start) : minEnd;
    if (next && out[i].end > next.start) out[i].end = next.start;
    out[i].text = out[i].text.replace(/[,،]$/, '');
    const lastWord = out[i].words?.[out[i].words!.length - 1];
    if (lastWord) lastWord.w = lastWord.w.replace(/[,،]$/, '');
  }
  return out.filter((c) => c.end - c.start > 0.05);
}

const STAGE_TEXT: Record<string, string> = {
  audio: 'מכין את האודיו',
  download: 'מוריד את מודל התמלול (פעם אחת בלבד)',
  load: 'טוען את מודל התמלול',
  transcribe: 'מתמלל',
};

export async function generateCaptions(p: Project, job: Job, language: string, model?: string, maxWords = 5, opts: { engine?: Engine; translateTo?: string } = {}): Promise<Caption[]> {
  const engine = await chooseEngine(opts.engine);
  updateJob(job, { progress: 0.01, stage: 'audio', message: 'מכין את האודיו', engine });
  const { wav, dir } = await renderSpeechWav(p, job);
  try {
    if (job.status !== 'running') throw new Error('בוטל');
    let words: Word[] | null;
    if (engine === 'cloud') {
      const s = aiSettings().transcription;
      const label = STT_PROVIDERS[s.provider].label;
      updateJob(job, { stage: 'cloud', message: `מתמלל ב־${label}`, progress: 0.05 });
      const ctl = new AbortController();
      const watch = setInterval(() => job.status !== 'running' && ctl.abort(), 500);
      try {
        words = await transcribeCloud(wav, dir, {
          provider: s.provider,
          model: sttModel(s),
          language,
          signal: ctl.signal,
          onProgress: (d, t) => updateJob(job, { progress: Math.min(0.9, 0.05 + (0.85 * d) / Math.max(1, t)), message: t > 1 ? `מתמלל ב־${label}: חלק ${Math.min(d + 1, t)} מתוך ${t}` : `מתמלל ב־${label}` }),
        });
      } finally {
        clearInterval(watch);
      }
    } else {
      words = await transcribeLocal(job, wav, language, model || (language === 'he' ? WHISPER_MODEL_HE : WHISPER_MODEL));
    }
    if (job.status !== 'running' || !words) return [];
    const mw = Math.max(1, Math.min(10, Math.round(maxWords) || 5));
    // a caption is one line: never let it grow wider than ~90% of the frame
    const fit = Math.max(8, Math.floor((p.settings.width * 0.9 - (p.captionStyle.bg ? p.captionStyle.size * 0.44 : 0)) / (p.captionStyle.size * 0.56)));
    const captions = chunkWords(words, Math.min(fit, mw <= 2 ? 18 : mw * 6), mw);
    let translatedTo: string | undefined;
    if (opts.translateTo && opts.translateTo !== language) {
      updateJob(job, { stage: 'translate', message: 'מתרגם את הכתוביות', progress: 0.92 });
      const lines = await translateLines(
        captions.map((c) => c.text),
        opts.translateTo,
        { onProgress: (d, t) => updateJob(job, { message: `מתרגם ${d} מתוך ${t}`, progress: Math.min(0.98, 0.92 + (0.06 * d) / Math.max(1, t)) }) },
      );
      captions.forEach((c, i) => {
        c.text = lines[i];
        c.words = spreadWords(lines[i], c.end - c.start);
      });
      translatedTo = opts.translateTo;
    }
    if (job.status !== 'running') return [];
    runOps(p.id, [{ op: 'set_captions', captions }], 'captions');
    updateJob(job, { status: 'done', progress: 1, message: `${captions.length} כתוביות`, result: { count: captions.length, captions, engine, ...(translatedTo ? { translatedTo } : {}) } });
    return captions;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** faster-whisper on this computer (transcribe.py), with live progress. null when the job was stopped. */
async function transcribeLocal(job: Job, wav: string, language: string, model: string): Promise<Word[] | null> {
    let words: Word[] | null = null;
    let error = '';
    let buf = '';
    let transcribeStart = 0;
    let lastPos = 0;
    let lastAt = 0;
    let speed = 0;
    let shownPos = 0;
    const r = await run(PYTHON, [path.join(ROOT, 'server', 'transcribe.py'), wav, '--language', language || 'he', '--model', model], {
      onSpawn: (child) => attachProcess(job.id, { kill: () => child.kill() }),
      onStdout: (s) => {
        buf += s;
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line.startsWith('{')) continue;
          try {
            const msg = JSON.parse(line);
            if (job.status !== 'running') continue;
            if (msg.stage || msg.progress !== undefined || msg.tick !== undefined) {
              const stage: string = msg.stage ?? job.stage ?? 'transcribe';
              const pos: number = msg.pos ?? job.pos ?? 0;
              const total: number = msg.total || job.total || 0;
              const elapsed = (Date.now() - (job.startedAt ?? Date.now())) / 1000;
              // speed is measured only over the transcription itself, so model loading does not skew it
              if (stage === 'transcribe' && !transcribeStart) transcribeStart = Date.now();
              const spent = transcribeStart ? (Date.now() - transcribeStart) / 1000 : 0;
              // Whisper reports in chunks of ~15-30 s of audio. Between reports, move the estimate forward
              // at the measured speed so the bar and the countdown keep moving instead of jumping.
              if (msg.pos !== undefined && msg.pos > lastPos) {
                lastPos = msg.pos;
                lastAt = Date.now();
                speed = spent > 0 ? lastPos / ((lastAt - transcribeStart) / 1000) : 0;
              }
              const since = (Date.now() - lastAt) / 1000;
              // never move backwards on screen, even when a report comes in below the estimate
              shownPos = Math.max(shownPos, speed > 0 ? Math.min(total * 0.985, lastPos + speed * since) : pos);
              const estPos = shownPos;
              const eta = stage === 'transcribe' && speed > 0 && total > 0 ? Math.max(1, Math.round((total - estPos) / speed)) : null;
              const message = STAGE_TEXT[stage] ?? 'מתמלל';
              const reported = msg.progress !== undefined ? msg.progress : 0;
              const estimated = stage === 'transcribe' && total > 0 ? 0.05 + (0.94 * estPos) / total : 0;
              const progress = Math.min(0.99, Math.max(job.progress, reported, estimated));
              const dl: number = msg.dl ?? job.dl ?? 0;
              const dlTotal: number = msg.dlTotal || job.dlTotal || 0;
              // while downloading, the bar shows the download (0-4% of the whole job is too little to see)
              const dlEta = stage === 'download' && dl > 0 && dlTotal > 0 ? Math.round(((dlTotal - dl) * elapsed) / dl) : null;
              updateJob(job, { progress, stage, message, pos: Math.round(estPos * 10) / 10, total, elapsed: Math.round(elapsed), eta: stage === 'download' ? dlEta : eta, dl, dlTotal });
            }
            if (msg.words) words = msg.words;
            if (msg.error) error = msg.error;
          } catch {
            /* not a JSON line */
          }
        }
      },
    });
    detachProcess(job.id);
    if (job.status !== 'running') return null;
    if (error) throw new Error(error);
    if (r.code !== 0 || !words) throw new Error(`התמלול נכשל: ${r.stderr.trim().split('\n').slice(-3).join(' | ') || 'Whisper לא החזיר תוצאה'}`);
    return words;
}
