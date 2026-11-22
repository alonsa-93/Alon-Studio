/**
 * The AI services in the local mock (scripts/mock-providers.ts): cloud transcription (OpenAI, Groq,
 * ElevenLabs), chat models (Anthropic Messages and the OpenAI-compatible chat API of OpenAI, xAI, Groq,
 * OpenRouter, Together and a local server) and Cartesia narration and voice cloning.
 *
 * The chat models follow a script, chosen by the words in the user's message:
 *   TITLE / כותרת -> get_summary, then add_text, then a short reply (a draft with one new clip)
 *   LOOP          -> get_summary forever (the round limit stops it)
 *   BADTOOL       -> asks for a tool the agent does not have, then replies
 *   anything else -> a text reply, no tools
 * A translation request (a JSON object with "lines") gets "[<language>] <line>" for every line;
 * a line with BADJSON gets an answer that is not JSON.
 */
import type http from 'node:http';

export const MOCK_KEYS = {
  openai: 'test-openai-key-0001',
  groq: 'test-groq-key-0002',
  elevenlabs: 'test-eleven-key-0003',
  cartesia: 'test-cartesia-key-0004',
  anthropic: 'test-anthropic-key-0005',
  xai: 'test-xai-key-0006',
  openrouter: 'test-openrouter-key-0007',
  together: 'test-together-key-0008',
};

export interface AiRequest {
  path: string;
  headers: Record<string, string>;
  body: string;
}

const CHAT_PREFIX: Record<string, string> = {
  '/openai/v1': 'openai',
  '/groq/openai/v1': 'groq',
  '/xai/v1': 'xai',
  '/openrouter/api/v1': 'openrouter',
  '/together/v1': 'together',
  '/local/v1': 'local',
};

export const isAiPath = (p: string) => /^\/(openai|groq|xai|openrouter|together|local|anthropic|elevenlabs|cartesia)\//.test(p);

/** A short WAV (mono 16-bit), a quiet tone. */
export function wav(seconds: number, rate = 44100): Buffer {
  const n = Math.max(1, Math.round(seconds * rate));
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(36 + n * 2, 4);
  b.write('WAVEfmt ', 8, 'ascii');
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36, 'ascii');
  b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(3000 * Math.sin((2 * Math.PI * 220 * i) / rate)), 44 + i * 2);
  return b;
}

const WORDS = [
  ['שלום', 0.2, 0.6],
  ['לכולם', 0.65, 1.1],
  ['וברוכים', 1.3, 1.8],
  ['הבאים', 1.85, 2.3],
] as const;

type Step = { text?: string; call?: { id: string; name: string; input: Record<string, unknown> } };
let seq = 0;

/** The next move of the scripted model, from the user's request and the last tool result in this turn. */
function brain(userText: string, lastToolId: string | undefined): Step {
  const id = (kind: string) => `call_${kind}_${++seq}`;
  if (/LOOP/.test(userText)) return { text: 'בודק שוב', call: { id: id('summary'), name: 'get_summary', input: {} } };
  if (/BADTOOL/.test(userText)) {
    if (!lastToolId) return { call: { id: id('bad'), name: 'export_video', input: { quality: 'high' } } };
    return { text: 'אין לי כלי לייצוא. אפשר לייצא בכפתור הייצוא.' };
  }
  if (/TITLE|כותרת/.test(userText)) {
    if (!lastToolId) return { text: 'מסתכל על הפרויקט', call: { id: id('summary'), name: 'get_summary', input: {} } };
    if (lastToolId.includes('_summary_')) return { call: { id: id('addtext'), name: 'add_text', input: { text: 'כותרת מהסוכן', start: 0.5, duration: 2, y: 0.2 } } };
    return { text: 'הוספתי כותרת בתחילת הסרטון.' };
  }
  return { text: 'שלום! מה לערוך?' };
}

function translate(question: string): string | null {
  const a = question.indexOf('{');
  const b = question.lastIndexOf('}');
  if (a < 0 || b < a) return null;
  try {
    const q = JSON.parse(question.slice(a, b + 1)) as { target_language?: string; lines?: string[] };
    if (!Array.isArray(q.lines)) return null;
    if (q.lines.some((l) => l.includes('BADJSON'))) return 'Sorry, here is the translation: line one, line two';
    return JSON.stringify(q.lines.map((l) => `[${q.target_language}] ${l}`));
  } catch {
    return null;
  }
}

function json(res: http.ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** Answers an AI request; false when the path is not one of them. */
export function handleAi(req: http.IncomingMessage, res: http.ServerResponse, u: URL, body: Buffer, log: AiRequest[]): boolean {
  const p = u.pathname;
  const h = (k: string) => String(req.headers[k] ?? '');
  const text = body.toString('utf8');
  // the SDK sends the key as x-api-key or as a bearer token, depending on its version
  const anthropicKey = () => h('x-api-key') || h('authorization').replace(/^Bearer /, '');
  log.push({ path: p, headers: Object.fromEntries(['authorization', 'x-api-key', 'xi-api-key', 'anthropic-version', 'anthropic-beta', 'cartesia-version', 'content-type'].filter((k) => req.headers[k]).map((k) => [k, h(k)])), body: text.slice(0, 200_000) });

  // ---- transcription ----
  if (p === '/openai/v1/audio/transcriptions' || p === '/groq/openai/v1/audio/transcriptions') {
    const want = p.startsWith('/groq') ? MOCK_KEYS.groq : MOCK_KEYS.openai;
    if (h('authorization') !== `Bearer ${want}`) return json(res, 401, { error: { message: 'Incorrect API key provided' } }), true;
    if (!text.includes('name="file"') || !text.includes('verbose_json') || body.length < 500) return json(res, 400, { error: { message: 'bad form' } }), true;
    json(res, 200, { text: WORDS.map((w) => w[0]).join(' '), words: WORDS.map(([word, start, end]) => ({ word, start, end })) });
    return true;
  }
  if (p === '/elevenlabs/v1/speech-to-text') {
    if (h('xi-api-key') !== MOCK_KEYS.elevenlabs) return json(res, 401, { detail: { message: 'invalid api key' } }), true;
    if (!text.includes('name="file"') || !text.includes('scribe_v1')) return json(res, 400, { detail: { message: 'bad form' } }), true;
    json(res, 200, { text: 'x', words: WORDS.flatMap(([t, start, end]) => [{ text: t, start, end, type: 'word' }, { text: ' ', start: end, end, type: 'spacing' }]) });
    return true;
  }

  // ---- Anthropic Messages ----
  if (p === '/anthropic/v1/models') {
    if (anthropicKey() !== MOCK_KEYS.anthropic) return json(res, 401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }), true;
    json(res, 200, { data: [{ type: 'model', id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', created_at: '2026-01-01T00:00:00Z' }, { type: 'model', id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5', created_at: '2026-01-01T00:00:00Z' }], has_more: false, first_id: 'claude-opus-5-5', last_id: 'claude-sonnet-5-5' });
    return true;
  }
  if (p === '/anthropic/v1/messages') {
    if (anthropicKey() !== MOCK_KEYS.anthropic) return json(res, 401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }), true;
    const b = JSON.parse(text) as { model: string; messages: { role: string; content: string | { type: string; text?: string; tool_use_id?: string }[] }[] };
    const last = b.messages[b.messages.length - 1];
    const blocks = typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : last.content;
    const result = blocks.find((x) => x.type === 'tool_result');
    const userText = [...b.messages].reverse().map((m) => (typeof m.content === 'string' ? m.content : m.role === 'user' ? (m.content.find((x) => x.type === 'text')?.text ?? '') : '')).find(Boolean) ?? '';
    const tr = result ? null : translate(userText);
    const step: Step = tr !== null ? { text: tr } : brain(userText, result?.tool_use_id);
    const content: unknown[] = [];
    if (step.text) content.push({ type: 'text', text: step.text });
    if (step.call) content.push({ type: 'tool_use', id: step.call.id.replace('call_', 'toolu_'), name: step.call.name, input: step.call.input });
    json(res, 200, { id: `msg_${++seq}`, type: 'message', role: 'assistant', model: b.model, content, stop_reason: step.call ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 } });
    return true;
  }

  // ---- OpenAI-compatible chat (OpenAI, xAI, Groq, OpenRouter, Together, local) ----
  const prefix = Object.keys(CHAT_PREFIX).find((k) => p === `${k}/chat/completions` || p === `${k}/models`);
  if (prefix) {
    const provider = CHAT_PREFIX[prefix];
    const want = provider === 'local' ? '' : `Bearer ${MOCK_KEYS[provider as keyof typeof MOCK_KEYS]}`;
    if (provider !== 'local' && h('authorization') !== want) return json(res, 401, { error: { message: 'Incorrect API key provided' } }), true;
    if (p.endsWith('/models')) return json(res, 200, { object: 'list', data: [{ id: `${provider}-mock-large` }, { id: `${provider}-mock-small` }] }), true;
    const b = JSON.parse(text) as { model: string; messages: { role: string; content: string | null; tool_call_id?: string }[]; tools?: unknown[] };
    const last = b.messages[b.messages.length - 1];
    const userText = [...b.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    const tr = last.role === 'tool' ? null : translate(String(userText));
    const step: Step = tr !== null ? { text: tr } : brain(String(userText), last.role === 'tool' ? last.tool_call_id : undefined);
    const message = {
      role: 'assistant',
      content: step.text ?? null,
      ...(step.call ? { tool_calls: [{ id: step.call.id, type: 'function', function: { name: step.call.name, arguments: JSON.stringify(step.call.input) } }] } : {}),
    };
    json(res, 200, { id: `chatcmpl-${++seq}`, object: 'chat.completion', model: b.model, choices: [{ index: 0, message, finish_reason: step.call ? 'tool_calls' : 'stop' }] });
    return true;
  }

  // ---- Cartesia ----
  if (p.startsWith('/cartesia/')) {
    if (h('x-api-key') !== MOCK_KEYS.cartesia) return json(res, 401, { error: 'Invalid API key' }), true;
    if (!h('cartesia-version')) return json(res, 400, { error: 'Cartesia-Version header is required' }), true;
    if (p === '/cartesia/voices' && req.method === 'GET') {
      const mine = u.searchParams.get('is_owner') === 'true';
      const all = [
        { id: 'mock-voice-he', name: 'קול בדיקה', description: 'Hebrew narrator', language: 'he', is_owner: false },
        { id: 'mock-voice-en', name: 'Test Voice', description: 'English narrator', language: 'en', is_owner: false },
        { id: 'mock-clone-1', name: 'My clone', language: 'he', is_owner: true },
      ];
      const lang = u.searchParams.get('language');
      return json(res, 200, { data: all.filter((v) => (!mine || v.is_owner) && (!lang || v.language === lang)), has_more: false }), true;
    }
    if (p === '/cartesia/tts/bytes' && req.method === 'POST') {
      const b = JSON.parse(text) as { transcript?: string; voice?: { id?: string }; output_format?: { container?: string } };
      if (!b.transcript || !b.voice?.id || b.output_format?.container !== 'wav') return json(res, 400, { error: 'bad request' }), true;
      const out = wav(Math.max(0.5, Math.min(8, b.transcript.length * 0.06)));
      res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': out.length });
      res.end(out);
      return true;
    }
    if (p === '/cartesia/voices/clone' && req.method === 'POST') {
      if (!text.includes('name="clip"') || !text.includes('RIFF')) return json(res, 400, { error: 'clip missing' }), true;
      const name = /name="name"\r\n\r\n([^\r]*)/.exec(text)?.[1] ?? 'clone';
      return json(res, 200, { id: 'mock-clone-1', name, language: 'he', is_owner: true }), true;
    }
    return json(res, 404, { error: 'not found' }), true;
  }
  return false;
}
