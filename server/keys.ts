import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, HttpError } from './store';
import { ownerOnly, secretValues } from './security';

/**
 * API keys of outside services: stock, cloud transcription, voice (Cartesia) and the AI agent's providers.
 * Stored in <data>/api-keys.json, readable by the current Windows account only (like access-key).
 * A key never goes back to the browser: the API returns only whether it is set and its last 4
 * characters. Every saved key is added to the log redaction.
 */
export const KEY_PROVIDERS = {
  pexels: { label: 'Pexels', use: 'stock' },
  pixabay: { label: 'Pixabay', use: 'stock' },
  openai: { label: 'OpenAI', use: 'transcribe agent' },
  groq: { label: 'Groq', use: 'transcribe agent' },
  elevenlabs: { label: 'ElevenLabs', use: 'transcribe' },
  cartesia: { label: 'Cartesia', use: 'voice' },
  anthropic: { label: 'Anthropic (Claude)', use: 'agent' },
  xai: { label: 'xAI (Grok)', use: 'agent' },
  openrouter: { label: 'OpenRouter', use: 'agent' },
  together: { label: 'Together AI', use: 'agent' },
  local: { label: 'מודל מקומי', use: 'agent' },
} as const satisfies Record<string, { label: string; use: string }>;
export type KeyProvider = keyof typeof KEY_PROVIDERS;

const FILE = path.join(DATA_DIR, 'api-keys.json');
const KEY_OK = /^[\x21-\x7e]{8,300}$/;

function load(): Partial<Record<KeyProvider, string>> {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8')) as Record<string, unknown>;
    const out: Partial<Record<KeyProvider, string>> = {};
    for (const [k, v] of Object.entries(raw)) if (k in KEY_PROVIDERS && typeof v === 'string' && KEY_OK.test(v)) out[k as KeyProvider] = v;
    return out;
  } catch {
    return {};
  }
}

let keys = load();
for (const v of Object.values(keys)) secretValues.add(v!);
if (fs.existsSync(FILE)) ownerOnly(FILE);

function save() {
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, '{}', 'utf8');
  ownerOnly(tmp); // locked before the keys are written into it
  fs.writeFileSync(tmp, JSON.stringify(keys, null, 2), 'utf8');
  fs.renameSync(tmp, FILE);
  ownerOnly(FILE);
}

const isProvider = (p: string): p is KeyProvider => Object.prototype.hasOwnProperty.call(KEY_PROVIDERS, p);
const providerOf = (p: string): KeyProvider => (isProvider(p) ? p : (() => { throw new HttpError(404, `unknown provider: ${String(p).slice(0, 30)}`); })());

/** What the browser may know: set or not, and the last 4 characters. */
export function keyStatus() {
  return (Object.keys(KEY_PROVIDERS) as KeyProvider[]).map((p) => ({ provider: p, label: KEY_PROVIDERS[p].label, use: KEY_PROVIDERS[p].use, hasKey: !!keys[p], last4: keys[p] ? keys[p]!.slice(-4) : null }));
}

export function setKey(provider: string, key: unknown) {
  const p = providerOf(provider);
  if (typeof key !== 'string' || !KEY_OK.test(key.trim())) throw new HttpError(400, 'המפתח לא תקין (8 עד 300 תווים, בלי רווחים)');
  keys = { ...keys, [p]: key.trim() };
  secretValues.add(key.trim());
  save();
  return keyStatus().find((k) => k.provider === p)!;
}

export function deleteKey(provider: string) {
  const p = providerOf(provider);
  const { [p]: _gone, ...rest } = keys;
  keys = rest;
  save();
  return keyStatus().find((k) => k.provider === p)!;
}

/** For server-side calls only. */
export const getKey = (p: KeyProvider): string | undefined => keys[p];
