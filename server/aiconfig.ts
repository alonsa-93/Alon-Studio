import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, HttpError } from './store';

/**
 * Settings of the AI and cloud services (no secrets here: keys live in keys.ts).
 * <data>/ai-settings.json. Every field is optional on disk; missing ones take the defaults below.
 */

// fixed public hosts; the tests point all of them at a local mock through the environment (never through the API)
const MOCK = process.env.ALON_AI_BASE?.replace(/\/+$/, '');
export const AI_BASE = {
  openai: MOCK ? `${MOCK}/openai/v1` : 'https://api.openai.com/v1',
  groq: MOCK ? `${MOCK}/groq/openai/v1` : 'https://api.groq.com/openai/v1',
  xai: MOCK ? `${MOCK}/xai/v1` : 'https://api.x.ai/v1',
  openrouter: MOCK ? `${MOCK}/openrouter/api/v1` : 'https://openrouter.ai/api/v1',
  together: MOCK ? `${MOCK}/together/v1` : 'https://api.together.xyz/v1',
  anthropic: MOCK ? `${MOCK}/anthropic` : 'https://api.anthropic.com',
  elevenlabs: MOCK ? `${MOCK}/elevenlabs/v1` : 'https://api.elevenlabs.io/v1',
  cartesia: MOCK ? `${MOCK}/cartesia` : 'https://api.cartesia.ai',
} as const;

export const STT_PROVIDERS = {
  openai: { label: 'OpenAI', model: 'whisper-1' },
  groq: { label: 'Groq', model: 'whisper-large-v3' },
  elevenlabs: { label: 'ElevenLabs', model: 'scribe_v1' },
} as const;
export type SttProvider = keyof typeof STT_PROVIDERS;

export const AGENT_PROVIDERS = {
  anthropic: { label: 'Anthropic (Claude)', model: 'claude-opus-5-5', keyRequired: true },
  openai: { label: 'OpenAI', model: '', keyRequired: true },
  xai: { label: 'xAI (Grok)', model: '', keyRequired: true },
  openrouter: { label: 'OpenRouter', model: '', keyRequired: true },
  groq: { label: 'Groq', model: 'llama-3.3-70b-versatile', keyRequired: true },
  together: { label: 'Together AI', model: '', keyRequired: true },
  local: { label: 'מודל מקומי (Ollama, LM Studio)', model: '', keyRequired: false },
} as const;
export type AgentProvider = keyof typeof AGENT_PROVIDERS;

export interface AiSettings {
  transcription: { engine: 'auto' | 'local' | 'cloud'; provider: SttProvider; model: string };
  agent: { provider: AgentProvider; model: string; baseUrl: string; maxRounds: number };
  voice: { model: string; voiceId: string; voiceName: string };
}

export const DEFAULT_LOCAL_BASE = 'http://127.0.0.1:11434/v1';
export const DEFAULT_VOICE_MODEL = 'sonic-3';

const DEFAULTS: AiSettings = {
  transcription: { engine: 'auto', provider: 'openai', model: '' },
  agent: { provider: 'anthropic', model: '', baseUrl: DEFAULT_LOCAL_BASE, maxRounds: 8 },
  voice: { model: '', voiceId: '', voiceName: '' },
};

const FILE = path.join(DATA_DIR, 'ai-settings.json');
const MODEL_OK = /^[\w.:/@+-]{1,120}$/;
const VOICE_ID_OK = /^[\w-]{1,80}$/;
const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/** A local model server: http(s) on this computer only (the agent never talks to the home network). */
export function checkLocalBase(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length > 200) throw new HttpError(400, 'כתובת השרת המקומי לא תקינה');
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new HttpError(400, 'כתובת השרת המקומי לא תקינה (למשל http://127.0.0.1:11434/v1)');
  }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password || u.search || u.hash) throw new HttpError(400, 'כתובת השרת המקומי חייבת להיות http או https, בלי שם משתמש');
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) throw new HttpError(400, 'מודל מקומי חייב לרוץ על המחשב הזה (127.0.0.1 או localhost)');
  return u.href.replace(/\/+$/, '');
}

function clean(raw: unknown): AiSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, Record<string, unknown>>;
  const t = r.transcription ?? {};
  const a = r.agent ?? {};
  const v = r.voice ?? {};
  const str = (x: unknown, ok: RegExp) => (typeof x === 'string' && ok.test(x) ? x : '');
  let baseUrl = DEFAULT_LOCAL_BASE;
  try {
    if (a.baseUrl) baseUrl = checkLocalBase(a.baseUrl);
  } catch {
    /* keep the default */
  }
  return {
    transcription: {
      engine: (['auto', 'local', 'cloud'] as const).find((e) => e === t.engine) ?? DEFAULTS.transcription.engine,
      provider: typeof t.provider === 'string' && own(STT_PROVIDERS, t.provider) ? (t.provider as SttProvider) : DEFAULTS.transcription.provider,
      model: str(t.model, MODEL_OK),
    },
    agent: {
      provider: typeof a.provider === 'string' && own(AGENT_PROVIDERS, a.provider) ? (a.provider as AgentProvider) : DEFAULTS.agent.provider,
      model: str(a.model, MODEL_OK),
      baseUrl,
      maxRounds: Math.max(1, Math.min(24, Math.round(Number(a.maxRounds)) || DEFAULTS.agent.maxRounds)),
    },
    voice: { model: str(v.model, MODEL_OK), voiceId: str(v.voiceId, VOICE_ID_OK), voiceName: typeof v.voiceName === 'string' ? v.voiceName.slice(0, 80) : '' },
  };
}

let settings = (() => {
  try {
    return clean(JSON.parse(fs.readFileSync(FILE, 'utf8')));
  } catch {
    return clean({});
  }
})();

export const aiSettings = (): AiSettings => structuredClone(settings);

/** Merges a partial update. Unknown values are refused (400), not silently dropped. */
export function updateAiSettings(patch: unknown): AiSettings {
  if (!patch || typeof patch !== 'object') throw new HttpError(400, 'expected an object');
  const p = patch as Record<string, Record<string, unknown> | undefined>;
  const next = structuredClone(settings);
  const t = p.transcription;
  if (t) {
    if (t.engine !== undefined) {
      if (!['auto', 'local', 'cloud'].includes(String(t.engine))) throw new HttpError(400, 'engine must be auto, local or cloud');
      next.transcription.engine = t.engine as AiSettings['transcription']['engine'];
    }
    if (t.provider !== undefined) {
      if (typeof t.provider !== 'string' || !own(STT_PROVIDERS, t.provider)) throw new HttpError(400, `transcription provider must be one of ${Object.keys(STT_PROVIDERS).join(', ')}`);
      next.transcription.provider = t.provider as SttProvider;
    }
    if (t.model !== undefined) {
      if (t.model !== '' && (typeof t.model !== 'string' || !MODEL_OK.test(t.model))) throw new HttpError(400, 'model name is not valid');
      next.transcription.model = t.model as string;
    }
  }
  const a = p.agent;
  if (a) {
    if (a.provider !== undefined) {
      if (typeof a.provider !== 'string' || !own(AGENT_PROVIDERS, a.provider)) throw new HttpError(400, `agent provider must be one of ${Object.keys(AGENT_PROVIDERS).join(', ')}`);
      if (a.provider !== next.agent.provider && a.model === undefined) next.agent.model = '';
      next.agent.provider = a.provider as AgentProvider;
    }
    if (a.model !== undefined) {
      if (a.model !== '' && (typeof a.model !== 'string' || !MODEL_OK.test(a.model))) throw new HttpError(400, 'model name is not valid');
      next.agent.model = a.model as string;
    }
    if (a.baseUrl !== undefined) next.agent.baseUrl = checkLocalBase(a.baseUrl);
    if (a.maxRounds !== undefined) {
      const n = Number(a.maxRounds);
      if (!Number.isInteger(n) || n < 1 || n > 24) throw new HttpError(400, 'maxRounds must be 1..24');
      next.agent.maxRounds = n;
    }
  }
  const v = p.voice;
  if (v) {
    if (v.model !== undefined) {
      if (v.model !== '' && (typeof v.model !== 'string' || !MODEL_OK.test(v.model))) throw new HttpError(400, 'model name is not valid');
      next.voice.model = v.model as string;
    }
    if (v.voiceId !== undefined) {
      if (v.voiceId !== '' && (typeof v.voiceId !== 'string' || !VOICE_ID_OK.test(v.voiceId))) throw new HttpError(400, 'voiceId is not valid');
      next.voice.voiceId = v.voiceId as string;
    }
    if (v.voiceName !== undefined) next.voice.voiceName = String(v.voiceName).slice(0, 80);
  }
  settings = next;
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2));
  fs.renameSync(tmp, FILE);
  return aiSettings();
}

export const agentModel = (s = settings.agent) => s.model || AGENT_PROVIDERS[s.provider].model;
export const sttModel = (s = settings.transcription) => s.model || STT_PROVIDERS[s.provider].model;
export const voiceModel = () => settings.voice.model || DEFAULT_VOICE_MODEL;
