import fs from 'node:fs';
import path from 'node:path';
import type { MediaAsset } from '../shared/types';
import { uid } from '../shared/ops';
import { addMedia } from './actions';
import { AI_BASE, aiSettings, updateAiSettings, voiceModel } from './aiconfig';
import { getKey } from './keys';
import { FFMPEG, newMediaFileName, registerMedia, run } from './media';
import { redact } from './security';
import { DATA_DIR, getProject, holdMedia, HttpError, MEDIA_DIR, runOps } from './store';

/**
 * Narration and voice cloning with Cartesia. The text, and for a clone the voice sample, are sent to
 * Cartesia; nothing else is. Generated speech is a WAV in the media folder like any other file.
 */

const API_VERSION = '2025-04-16';
const SAMPLES = path.join(DATA_DIR, 'cache', 'voice-samples');
const MAX_TEXT = 5000;
const VOICE_ID = /^[\w-]{1,80}$/;

export interface Voice {
  id: string;
  name: string;
  description?: string;
  language?: string;
  mine?: boolean;
}

function key(): string {
  const k = getKey('cartesia');
  if (!k) throw new HttpError(400, 'חסר מפתח API של Cartesia. שמרו אותו בלשונית הסאונד, בחלק "קריינות"');
  return k;
}

async function call(pathname: string, init: { method?: string; body?: BodyInit; json?: unknown; timeoutMs?: number } = {}): Promise<Response> {
  const headers: Record<string, string> = { 'X-API-Key': key(), 'Cartesia-Version': API_VERSION };
  let body = init.body;
  if (init.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(init.json);
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), init.timeoutMs ?? 120_000);
  let res: Response;
  try {
    res = await fetch(`${AI_BASE.cartesia}${pathname}`, { method: init.method ?? 'GET', headers, body, signal: ctl.signal, redirect: 'error' });
  } catch {
    throw new HttpError(502, ctl.signal.aborted ? 'Cartesia לא ענה בזמן' : 'אין חיבור ל־Cartesia');
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const raw = await res.text();
    let msg = raw.slice(0, 300);
    try {
      const d = JSON.parse(raw) as { error?: string | { message?: string }; message?: string };
      msg = (typeof d.error === 'string' ? d.error : d.error?.message) ?? d.message ?? msg;
    } catch {
      /* not JSON */
    }
    msg = redact(msg).replace(/\s+/g, ' ').slice(0, 300);
    if (res.status === 401 || res.status === 403) throw new HttpError(502, `Cartesia לא קיבל את המפתח (${res.status}). בדקו אותו`);
    if (res.status === 402) throw new HttpError(402, `נגמרו הקרדיטים בחשבון Cartesia (${msg})`);
    if (res.status === 429) throw new HttpError(429, `Cartesia: יותר מדי בקשות. נסו שוב בעוד רגע`);
    throw new HttpError(502, `Cartesia (${res.status}): ${msg || 'הבקשה נכשלה'}`);
  }
  return res;
}

const toVoice = (v: Record<string, unknown>): Voice => ({
  id: String(v.id ?? ''),
  name: String(v.name ?? '').slice(0, 80),
  ...(v.description ? { description: String(v.description).slice(0, 200) } : {}),
  ...(v.language ? { language: String(v.language) } : {}),
  ...(v.is_owner ? { mine: true } : {}),
});

export async function listVoices(o: { q?: unknown; language?: unknown; mine?: unknown }): Promise<{ voices: Voice[] }> {
  const qs = new URLSearchParams({ limit: '100' });
  if (typeof o.q === 'string' && o.q.trim()) qs.set('q', o.q.trim().slice(0, 80));
  if (typeof o.language === 'string' && /^[a-z]{2}$/.test(o.language)) qs.set('language', o.language);
  if (o.mine === true || o.mine === '1' || o.mine === 'true') qs.set('is_owner', 'true');
  const data = (await (await call(`/voices?${qs}`)).json()) as unknown;
  const list = (Array.isArray(data) ? data : ((data as { data?: unknown[] }).data ?? [])) as Record<string, unknown>[];
  return { voices: list.map(toVoice).filter((v) => VOICE_ID.test(v.id)) };
}

export const detectLanguage = (text: string) => (/[֐-׿]/.test(text) ? 'he' : 'en');

async function tts(text: string, voiceId: string, language: string, speed: number): Promise<Buffer> {
  const res = await call('/tts/bytes', {
    method: 'POST',
    timeoutMs: 5 * 60_000,
    json: {
      model_id: voiceModel(),
      transcript: text,
      voice: { mode: 'id', id: voiceId },
      language,
      output_format: { container: 'wav', encoding: 'pcm_s16le', sample_rate: 44100 },
      ...(speed !== 1 ? { generation_config: { speed } } : {}),
    },
  });
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF') throw new HttpError(502, 'Cartesia לא החזיר קובץ שמע');
  return buf;
}

/** Text to speech into the project. With `start` the narration is also placed on the timeline. */
export async function speak(projectId: string | undefined, o: { text?: unknown; voiceId?: unknown; language?: unknown; speed?: unknown; start?: unknown }) {
  const text = typeof o.text === 'string' ? o.text.trim() : '';
  if (!text) throw new HttpError(400, 'אין טקסט להקראה');
  if (text.length > MAX_TEXT) throw new HttpError(400, `הטקסט ארוך מדי (עד ${MAX_TEXT} תווים בכל פעם)`);
  const voiceId = typeof o.voiceId === 'string' && o.voiceId ? o.voiceId : aiSettings().voice.voiceId;
  if (!voiceId || !VOICE_ID.test(voiceId)) throw new HttpError(400, 'בחרו קול');
  const language = typeof o.language === 'string' && /^[a-z]{2}$/.test(o.language) ? o.language : detectLanguage(text);
  const speed = o.speed === undefined ? 1 : Number(o.speed);
  if (!Number.isFinite(speed) || speed < 0.6 || speed > 1.5) throw new HttpError(400, 'speed must be 0.6..1.5');
  const start = o.start === undefined || o.start === null ? undefined : Number(o.start);
  if (start !== undefined && (!Number.isFinite(start) || start < 0)) throw new HttpError(400, 'start must be a time in seconds');
  const p = getProject(projectId);
  const wav = await tts(text, voiceId, language, speed);
  const release = holdMedia();
  let asset: MediaAsset;
  try {
    const fileName = newMediaFileName('narration.wav');
    fs.writeFileSync(path.join(MEDIA_DIR, fileName), wav);
    asset = await registerMedia(fileName, `קריינות - ${text.slice(0, 40)}`);
    addMedia(p.id, [asset], 'upload');
  } finally {
    release();
  }
  updateAiSettings({ voice: { voiceId } });
  const project = start !== undefined ? runOps(p.id, [{ op: 'add_music', mediaId: asset.id, start, volume: 1 }], 'voice') : getProject(p.id);
  const clip = start !== undefined ? project.clips.filter((c) => c.mediaId === asset.id).at(-1) : undefined;
  return { asset, clip, voiceId, language, model: voiceModel(), characters: text.length };
}

/** A short sample of a voice, generated once (a few credits) and kept on disk. */
export async function voicePreview(voiceId: string, language: unknown): Promise<string> {
  if (!VOICE_ID.test(voiceId)) throw new HttpError(400, 'voiceId is not valid');
  const lang = language === 'en' ? 'en' : 'he';
  fs.mkdirSync(SAMPLES, { recursive: true });
  const file = path.join(SAMPLES, `${voiceId}-${lang}.wav`);
  if (!fs.existsSync(file)) {
    const wav = await tts(lang === 'he' ? 'שלום, ככה נשמע הקול הזה.' : 'Hello, this is how this voice sounds.', voiceId, lang, 1);
    const tmp = `${file}.${uid('t')}`;
    fs.writeFileSync(tmp, wav);
    fs.renameSync(tmp, file);
  }
  return file;
}

/**
 * A new voice from a clip of the project (3 to 10 seconds of one speaker are enough; at most the first
 * 30 seconds are sent). The user must confirm they may clone that voice.
 */
export async function cloneVoice(projectId: string | undefined, o: { name?: unknown; language?: unknown; clipId?: unknown; consent?: unknown }) {
  if (o.consent !== true) throw new HttpError(400, 'צריך לאשר שמותר לכם לשכפל את הקול הזה (הקול שלכם, או באישור בעליו)');
  const name = typeof o.name === 'string' ? o.name.trim().slice(0, 60) : '';
  if (!name) throw new HttpError(400, 'תנו שם לקול');
  const language = typeof o.language === 'string' && /^[a-z]{2}$/.test(o.language) ? o.language : 'he';
  const p = getProject(projectId);
  const clip = p.clips.find((c) => c.id === o.clipId);
  if (!clip || (clip.kind !== 'video' && clip.kind !== 'audio')) throw new HttpError(400, 'בחרו בציר הזמן קליפ וידאו או אודיו עם הדובר');
  const media = p.media.find((m) => m.id === clip.mediaId);
  if (!media || (media.kind === 'video' && !media.hasAudio)) throw new HttpError(400, 'לקליפ הזה אין אודיו');
  const seconds = Math.min(30, clip.duration * (clip.speed ?? 1));
  if (seconds < 2) throw new HttpError(400, 'הקליפ קצר מדי: צריך לפחות 3 שניות של דיבור');
  const dir = path.join(DATA_DIR, 'tmp', uid('clone_'));
  fs.mkdirSync(dir, { recursive: true });
  try {
    const sample = path.join(dir, 'sample.wav');
    const r = await run(FFMPEG, ['-hide_banner', '-v', 'error', '-y', '-protocol_whitelist', 'file', '-ss', String(clip.offset), '-t', String(seconds), '-i', path.join(MEDIA_DIR, media.file), '-vn', '-ac', '1', '-ar', '44100', '-c:a', 'pcm_s16le', sample]);
    if (r.code !== 0) throw new HttpError(500, 'לא הצלחתי לחתוך את הדגימה מהקליפ');
    const form = new FormData();
    form.append('clip', new Blob([fs.readFileSync(sample)], { type: 'audio/wav' }), 'sample.wav');
    form.append('name', name);
    form.append('language', language);
    form.append('mode', 'similarity');
    form.append('description', 'Cloned in ALON Studio');
    const v = toVoice((await (await call('/voices/clone', { method: 'POST', body: form, timeoutMs: 3 * 60_000 })).json()) as Record<string, unknown>);
    if (!VOICE_ID.test(v.id)) throw new HttpError(502, 'Cartesia לא החזיר קול חדש');
    updateAiSettings({ voice: { voiceId: v.id, voiceName: v.name } });
    return { ...v, mine: true };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
