import fs from 'node:fs';
import path from 'node:path';
import { AI_BASE, STT_PROVIDERS, type SttProvider } from './aiconfig';
import { getKey } from './keys';
import { FFMPEG, run } from './media';
import { redact } from './security';
import { HttpError } from './store';

/**
 * Transcription through an API: OpenAI (whisper-1), Groq (whisper-large-v3) or ElevenLabs (scribe_v1).
 * The speech is sent as small mono MP3 parts (20 minutes each by default) so long videos stay under the
 * providers' upload limits; the word times of each part are moved by the part's start.
 * Only the audio leaves the computer, and only to the provider the user chose.
 */

export interface SttWord {
  start: number;
  end: number;
  text: string;
}

export const PART_SECONDS = 20 * 60;

/** Cuts the speech into MP3 parts. Returns [file, start seconds] pairs in order. */
export async function audioParts(wav: string, dir: string, partSeconds = PART_SECONDS): Promise<[string, number][]> {
  const r = await run(FFMPEG, ['-hide_banner', '-v', 'error', '-y', '-i', wav, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', '48k', '-f', 'segment', '-segment_time', String(partSeconds), '-reset_timestamps', '1', path.join(dir, 'part_%03d.mp3')]);
  if (r.code !== 0) throw new Error(`ffmpeg could not prepare the audio: ${r.stderr.trim().split('\n').slice(-2).join(' ')}`);
  return fs
    .readdirSync(dir)
    .filter((f) => /^part_\d{3}\.mp3$/.test(f))
    .sort()
    .map((f, i) => [path.join(dir, f), i * partSeconds] as [string, number]);
}

function sttError(provider: SttProvider, status: number, detail: string): Error {
  const label = STT_PROVIDERS[provider].label;
  const d = redact(detail).replace(/\s+/g, ' ').slice(0, 300);
  if (status === 401 || status === 403) return new HttpError(502, `${label} לא קיבל את המפתח (${status}). בדקו אותו בהגדרות התמלול`);
  if (status === 429) return new HttpError(429, `${label}: יותר מדי בקשות או שנגמרה המכסה (${d})`);
  return new HttpError(502, `התמלול ב־${label} נכשל (${status}): ${d || 'אין פרטים'}`);
}

async function postForm(provider: SttProvider, url: string, form: FormData, headers: Record<string, string>, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 10 * 60_000);
  const onAbort = () => ctl.abort();
  signal?.addEventListener('abort', onAbort);
  try {
    const res = await fetch(url, { method: 'POST', body: form, headers, signal: ctl.signal, redirect: 'error' });
    const raw = await res.text();
    let data: Record<string, unknown> = {};
    try {
      data = JSON.parse(raw);
    } catch {
      /* not JSON */
    }
    if (!res.ok) {
      const err = data.error as { message?: string } | string | undefined;
      const detail = data.detail as { message?: string } | string | undefined;
      throw sttError(provider, res.status, (typeof err === 'string' ? err : err?.message) ?? (typeof detail === 'string' ? detail : detail?.message) ?? raw.slice(0, 200));
    }
    return data;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    if (signal?.aborted) throw new Error('בוטל');
    throw new HttpError(502, `אין חיבור ל־${STT_PROVIDERS[provider].label}${ctl.signal.aborted ? ' (לא ענה בזמן)' : ''}`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/** One part: the words with times inside the part. */
async function transcribePart(provider: SttProvider, model: string, file: string, language: string, key: string, signal?: AbortSignal): Promise<SttWord[]> {
  const audio = new Blob([fs.readFileSync(file)], { type: 'audio/mpeg' });
  const form = new FormData();
  if (provider === 'elevenlabs') {
    form.append('file', audio, path.basename(file));
    form.append('model_id', model);
    form.append('timestamps_granularity', 'word');
    if (language && language !== 'auto') form.append('language_code', language);
    const data = await postForm(provider, `${AI_BASE.elevenlabs}/speech-to-text`, form, { 'xi-api-key': key }, signal);
    const words = (data.words ?? []) as { text?: string; start?: number; end?: number; type?: string }[];
    return words.filter((w) => (w.type ?? 'word') === 'word' && typeof w.start === 'number' && String(w.text ?? '').trim()).map((w) => ({ start: w.start!, end: Math.max(w.start!, w.end ?? w.start!), text: String(w.text).trim() }));
  }
  form.append('file', audio, path.basename(file));
  form.append('model', model);
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'word');
  if (language && language !== 'auto') form.append('language', language);
  const base = provider === 'groq' ? AI_BASE.groq : AI_BASE.openai;
  const data = await postForm(provider, `${base}/audio/transcriptions`, form, { Authorization: `Bearer ${key}` }, signal);
  const words = data.words as { word?: string; start?: number; end?: number }[] | undefined;
  if (!Array.isArray(words)) {
    if (typeof data.text === 'string' && !data.text.trim()) return [];
    throw new HttpError(502, `המודל "${model}" לא החזיר תזמון של מילים, ולכן אי אפשר לבנות ממנו כתוביות. בחרו מודל אחר`);
  }
  return words.filter((w) => typeof w.start === 'number' && String(w.word ?? '').trim()).map((w) => ({ start: w.start!, end: Math.max(w.start!, w.end ?? w.start!), text: String(w.word).trim() }));
}

export async function transcribeCloud(
  wav: string,
  workDir: string,
  o: { provider: SttProvider; model: string; language: string; signal?: AbortSignal; onProgress?: (done: number, total: number) => void; partSeconds?: number },
): Promise<SttWord[]> {
  const key = getKey(o.provider);
  if (!key) throw new HttpError(400, `חסר מפתח API של ${STT_PROVIDERS[o.provider].label}. שמרו אותו בהגדרות התמלול`);
  const dir = path.join(workDir, 'parts');
  fs.mkdirSync(dir, { recursive: true });
  const parts = await audioParts(wav, dir, o.partSeconds);
  const out: SttWord[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (o.signal?.aborted) throw new Error('בוטל');
    o.onProgress?.(i, parts.length);
    const [file, offset] = parts[i];
    const words = await transcribePart(o.provider, o.model, file, o.language, key, o.signal);
    for (const w of words) out.push({ start: Math.round((w.start + offset) * 1000) / 1000, end: Math.round((w.end + offset) * 1000) / 1000, text: w.text });
  }
  o.onProgress?.(parts.length, parts.length);
  return out;
}
