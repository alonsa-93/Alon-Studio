import Anthropic from '@anthropic-ai/sdk';
import { AGENT_PROVIDERS, AI_BASE, agentModel, aiSettings, type AgentProvider } from './aiconfig';
import { getKey } from './keys';
import { redact } from './security';
import { HttpError } from './store';

/**
 * One conversation with a language model that can call tools, for the AI agent and caption translation.
 * Anthropic goes through the official SDK; OpenAI, xAI, OpenRouter, Groq, Together and a local server
 * (Ollama, LM Studio) share the OpenAI-compatible /chat/completions API. Each provider keeps its own
 * message format inside the conversation, so nothing a model returns (thinking blocks included) is
 * edited before it goes back.
 */

export interface ToolDef {
  name: string;
  description: string;
  input_schema: { type: 'object'; properties?: Record<string, unknown>; required?: string[]; [k: string]: unknown };
}
export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}
export interface ToolResult {
  id: string;
  content: string;
  isError?: boolean;
}
export interface Reply {
  text: string;
  calls: ToolCall[];
  /** end: the model answered; tools: it wants the calls run; refused / cut: it stopped early. */
  stop: 'end' | 'tools' | 'refused' | 'cut';
}

export interface Conversation {
  provider: AgentProvider;
  model: string;
  /** Provider-native messages (kept between turns of the agent). */
  messages: unknown[];
  addUser(text: string): void;
  addResults(results: ToolResult[]): void;
  send(signal?: AbortSignal): Promise<Reply>;
}

export interface LlmTarget {
  provider: AgentProvider;
  model: string;
  baseUrl: string;
  key?: string;
}

/** The agent's provider from the settings, with its key; a clear error when something is missing. */
export function llmTarget(): LlmTarget {
  const s = aiSettings().agent;
  const model = agentModel(s);
  const label = AGENT_PROVIDERS[s.provider].label;
  if (!model) throw new HttpError(400, `בחרו מודל של ${label} בהגדרות הסוכן`);
  const key = getKey(s.provider);
  if (AGENT_PROVIDERS[s.provider].keyRequired && !key) throw new HttpError(400, `חסר מפתח API של ${label}. שמרו אותו בהגדרות הסוכן`);
  const baseUrl = s.provider === 'local' ? s.baseUrl : s.provider === 'anthropic' ? AI_BASE.anthropic : AI_BASE[s.provider];
  return { provider: s.provider, model, baseUrl, key };
}

const label = (p: AgentProvider) => AGENT_PROVIDERS[p].label;

/** A provider error as one short line the user can act on (never the key, never a URL with it). */
function providerError(p: AgentProvider, status: number | undefined, detail: string): HttpError {
  const d = redact(detail).replace(/\s+/g, ' ').slice(0, 300);
  if (status === 401 || status === 403) return new HttpError(502, `${label(p)} לא קיבל את המפתח (${status}). בדקו את המפתח בהגדרות`);
  if (status === 404) return new HttpError(502, `${label(p)}: המודל לא נמצא. בחרו מודל מהרשימה (${d})`);
  if (status === 429) return new HttpError(429, `${label(p)}: יותר מדי בקשות או שנגמרה המכסה. נסו שוב בעוד רגע (${d})`);
  if (status && status >= 500) return new HttpError(502, `${label(p)} לא זמין כרגע (${status}). נסו שוב`);
  return new HttpError(502, `${label(p)}: ${d || 'הבקשה נכשלה'}`);
}

// ---------------- Anthropic (official SDK) ----------------

// models that accept the server-side refusal fallback (it re-runs a declined request on a fallback model)
const FALLBACK_MODELS = /^claude-(opus-5-5|opus-5|sonnet-5-5|fable-5-[12]|fable-5)$/;

class AnthropicConversation implements Conversation {
  provider = 'anthropic' as const;
  messages: Anthropic.Beta.BetaMessageParam[] = [];
  private client: Anthropic;
  constructor(
    public model: string,
    private system: string,
    private tools: ToolDef[],
    key: string,
    baseURL: string,
  ) {
    this.client = new Anthropic({ apiKey: key, baseURL, maxRetries: 1, timeout: 5 * 60_000 });
  }
  addUser(text: string) {
    this.messages.push({ role: 'user', content: text });
  }
  addResults(results: ToolResult[]) {
    // every result of one assistant turn goes back in one user message
    this.messages.push({ role: 'user', content: results.map((r) => ({ type: 'tool_result' as const, tool_use_id: r.id, content: r.content, ...(r.isError ? { is_error: true } : {}) })) });
  }
  async send(signal?: AbortSignal): Promise<Reply> {
    let res: Anthropic.Beta.BetaMessage;
    try {
      res = await this.client.beta.messages.create(
        {
          model: this.model,
          max_tokens: 16000,
          system: this.system,
          tools: this.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema as Anthropic.Beta.BetaTool.InputSchema })),
          messages: this.messages,
          ...(FALLBACK_MODELS.test(this.model) ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
        },
        { signal },
      );
    } catch (e) {
      if (e instanceof Anthropic.APIUserAbortError) throw new HttpError(499, 'בוטל');
      if (e instanceof Anthropic.APIError) throw providerError('anthropic', e.status, e.message);
      throw providerError('anthropic', undefined, (e as Error).message);
    }
    // the whole content goes back unchanged (thinking blocks included)
    this.messages.push({ role: 'assistant', content: res.content as Anthropic.Beta.BetaContentBlockParam[] });
    const text = res.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n').trim();
    const calls = res.content.flatMap((b) => (b.type === 'tool_use' ? [{ id: b.id, name: b.name, input: b.input }] : []));
    if (res.stop_reason === 'refusal') return { text: text || 'המודל סירב לבקשה הזו.', calls: [], stop: 'refused' };
    if (res.stop_reason === 'max_tokens' && !calls.length) return { text, calls: [], stop: 'cut' };
    return { text, calls, stop: calls.length ? 'tools' : 'end' };
  }
}

// ---------------- OpenAI-compatible ----------------

interface OaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
  [k: string]: unknown;
}

class OpenAiConversation implements Conversation {
  messages: OaMessage[];
  constructor(
    public provider: AgentProvider,
    public model: string,
    system: string,
    private tools: ToolDef[],
    private baseUrl: string,
    private key?: string,
  ) {
    this.messages = [{ role: 'system', content: system }];
  }
  addUser(text: string) {
    this.messages.push({ role: 'user', content: text });
  }
  addResults(results: ToolResult[]) {
    for (const r of results) this.messages.push({ role: 'tool', tool_call_id: r.id, content: r.isError ? `Error: ${r.content}` : r.content });
  }
  async send(signal?: AbortSignal): Promise<Reply> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.key) headers.Authorization = `Bearer ${this.key}`;
    const body = {
      model: this.model,
      messages: this.messages,
      ...(this.tools.length ? { tools: this.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } })), tool_choice: 'auto' } : {}),
    };
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 5 * 60_000);
    const onAbort = () => ctl.abort();
    signal?.addEventListener('abort', onAbort);
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body), signal: ctl.signal, redirect: 'error' });
    } catch (e) {
      if (signal?.aborted) throw new HttpError(499, 'בוטל');
      if (this.provider === 'local') throw new HttpError(502, `אין חיבור לשרת המקומי ב־${this.baseUrl}. ודאו ש־Ollama או LM Studio פועלים`);
      throw providerError(this.provider, undefined, ctl.signal.aborted ? 'לא ענה בזמן' : (e as Error).message);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
    const raw = await res.text();
    let data: { choices?: { message?: OaMessage; finish_reason?: string }[]; error?: { message?: string } | string };
    try {
      data = JSON.parse(raw);
    } catch {
      throw providerError(this.provider, res.status, raw.slice(0, 200));
    }
    if (!res.ok) {
      const msg = typeof data.error === 'string' ? data.error : (data.error?.message ?? '');
      if (this.provider === 'local' && /tool/i.test(msg)) throw new HttpError(502, `המודל המקומי לא תומך בקריאה לכלים: ${redact(msg).slice(0, 200)}`);
      throw providerError(this.provider, res.status, msg);
    }
    const choice = data.choices?.[0];
    const msg = choice?.message;
    if (!msg) throw providerError(this.provider, res.status, 'empty answer');
    this.messages.push({ ...msg, role: 'assistant', content: msg.content ?? null });
    const calls: ToolCall[] = (msg.tool_calls ?? []).map((c) => {
      let input: unknown = {};
      try {
        input = c.function.arguments ? JSON.parse(c.function.arguments) : {};
      } catch {
        input = { __invalid_json: c.function.arguments?.slice(0, 500) };
      }
      return { id: c.id, name: c.function.name, input };
    });
    const text = (msg.content ?? '').trim();
    if (choice?.finish_reason === 'content_filter') return { text: text || 'המודל סירב לבקשה הזו.', calls: [], stop: 'refused' };
    if (choice?.finish_reason === 'length' && !calls.length) return { text, calls: [], stop: 'cut' };
    return { text, calls, stop: calls.length ? 'tools' : 'end' };
  }
}

export function startConversation(t: LlmTarget, system: string, tools: ToolDef[], messages?: unknown[]): Conversation {
  const c: Conversation = t.provider === 'anthropic' ? new AnthropicConversation(t.model, system, tools, t.key ?? '', t.baseUrl) : new OpenAiConversation(t.provider, t.model, system, tools, t.baseUrl, t.key);
  if (messages?.length) c.messages = (t.provider === 'anthropic' ? messages : [c.messages[0], ...messages.filter((m) => (m as OaMessage).role !== 'system')]) as never;
  return c;
}

/** One question, one text answer (no tools): caption translation. */
export async function ask(t: LlmTarget, system: string, question: string, signal?: AbortSignal): Promise<string> {
  const c = startConversation(t, system, []);
  c.addUser(question);
  const r = await c.send(signal);
  if (r.stop === 'refused') throw new HttpError(502, r.text);
  return r.text;
}

/** The provider's model list (for the settings picker). */
export async function listModels(t: Omit<LlmTarget, 'model'>): Promise<string[]> {
  if (t.provider === 'anthropic') {
    const client = new Anthropic({ apiKey: t.key ?? '', baseURL: t.baseUrl, maxRetries: 1, timeout: 20_000 });
    try {
      const out: string[] = [];
      for await (const m of client.models.list({ limit: 100 })) out.push(m.id);
      return out;
    } catch (e) {
      if (e instanceof Anthropic.APIError) throw providerError('anthropic', e.status, e.message);
      throw providerError('anthropic', undefined, (e as Error).message);
    }
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20_000);
  try {
    const res = await fetch(`${t.baseUrl}/models`, { headers: t.key ? { Authorization: `Bearer ${t.key}` } : {}, signal: ctl.signal, redirect: 'error' });
    const data = (await res.json().catch(() => ({}))) as { data?: { id?: string }[]; error?: { message?: string } };
    if (!res.ok) throw providerError(t.provider, res.status, data.error?.message ?? '');
    return (data.data ?? []).map((m) => String(m.id ?? '')).filter(Boolean).sort();
  } catch (e) {
    if (e instanceof HttpError) throw e;
    if (t.provider === 'local') throw new HttpError(502, `אין חיבור לשרת המקומי ב־${t.baseUrl}`);
    throw providerError(t.provider, undefined, (e as Error).message);
  } finally {
    clearTimeout(timer);
  }
}
