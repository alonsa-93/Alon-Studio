/**
 * AI and cloud services end to end, against the local mock (scripts/mock-ai.ts), never the internet:
 * settings, keys, model lists, cloud transcription (OpenAI, Groq, ElevenLabs), caption translation that
 * keeps the timing, the AI agent with its draft and approval card on every provider, Cartesia narration,
 * voice preview and cloning, and the new MCP tools.
 *   npx tsx scripts/e2e-ai.ts <clip.mp4>          (also run at the end of e2e-features.ts)
 * Needs the test instance (scripts/test-server.mjs), which points the AI services at port 5191.
 */
import './auth.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMock } from './mock-providers';
import { MOCK_KEYS } from './mock-ai';

const BASE = process.env.BASE_URL ?? 'http://localhost:5182';
const DATA = process.env.ALON_DATA_DIR ?? path.join(os.tmpdir(), 'alon-test-data');
const clipPath = process.argv[2] ?? path.join(os.tmpdir(), 'alon-test-media', 'test-clip.mp4');

async function api(url: string, init?: RequestInit) {
  const res = await fetch(BASE + url, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(`${url}: ${res.status} ${data.error}`), { status: res.status, body: data });
  return data;
}
const post = (url: string, body: unknown = {}) => api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const put = (url: string, body: unknown) => api(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const del = (url: string) => api(url, { method: 'DELETE' });
const ops = (id: string, o: unknown) => post(`/api/projects/${id}/ops?full=1`, { ops: Array.isArray(o) ? o : [o] });
const check = (ok: unknown, msg: string) => {
  if (!ok) throw new Error('FAILED: ' + msg);
  console.log('  ok  ' + msg);
};
const fail = async (p: Promise<unknown>): Promise<{ status: number; error: string }> => {
  try {
    await p;
    return { status: 200, error: '' };
  } catch (e) {
    const x = e as { status?: number; body?: { error?: string } };
    return { status: x.status ?? 0, error: x.body?.error ?? '' };
  }
};
async function waitJob(jobId: string) {
  for (;;) {
    const job = await api(`/api/jobs/${jobId}`);
    if (job.status !== 'running') return job;
    await new Promise((r) => setTimeout(r, 250));
  }
}
type Clip = { id: string; kind: string; start: number; duration: number; text?: string; trackId: string; mediaId?: string };
const project = (id: string) => api(`/api/projects/${id}`) as Promise<{ rev: number; clips: Clip[]; tracks: { id: string; kind: string }[]; media: { id: string; kind: string; name: string }[] }>;
const captions = async (id: string) => (await project(id)).clips.filter((c) => c.kind === 'caption').sort((a, b) => a.start - b.start);
const setAgent = (agent: Record<string, unknown>) => put('/api/ai/settings', { agent });
const SECRETS = Object.values(MOCK_KEYS);
const noSecret = (x: unknown) => !SECRETS.some((k) => JSON.stringify(x).includes(k));

const mock = await startMock(5191);
const created: string[] = [];
const before = await api('/api/ai/settings');
try {
  // ---------- settings and keys ----------
  const s0 = before;
  check(s0.settings && s0.stt.openai && s0.agent.anthropic.model === 'claude-opus-5-5' && s0.languages.en && (s0.localWhisper === null || typeof s0.localWhisper === 'boolean'), 'AI settings: providers, the default agent model and the languages');
  check((await fail(put('/api/ai/settings', { agent: { provider: 'nope' } }))).status === 400, 'an unknown agent provider is refused');
  check((await fail(put('/api/ai/settings', { agent: { baseUrl: 'http://example.com/v1' } }))).status === 400, 'a local model address that is not this computer is refused');
  check((await fail(put('/api/ai/settings', { agent: { baseUrl: 'http://169.254.169.254/v1' } }))).status === 400, 'a link-local address for the local model is refused');
  check((await fail(put('/api/ai/settings', { agent: { maxRounds: 99 } }))).status === 400, 'rounds above the limit are refused');
  check((await fail(put('/api/ai/settings', { transcription: { engine: 'magic' } }))).status === 400, 'an unknown transcription engine is refused');
  check((await fail(put('/api/ai/settings', { agent: { model: 'a b; rm' } }))).status === 400, 'a model name with odd characters is refused');
  for (const [p, k] of Object.entries(MOCK_KEYS)) await put(`/api/keys/${p}`, { key: k });
  const keys = await api('/api/keys');
  check(noSecret(keys) && keys.find((k: { provider: string }) => k.provider === 'anthropic')?.last4 === '0005', 'keys saved for 8 AI providers; the API shows only the last 4 characters');
  check(noSecret(await api('/api/ai/settings')), 'the settings never contain a key');

  // ---------- model lists ----------
  check((await api('/api/ai/models?provider=anthropic')).models.includes('claude-opus-5-5'), 'Anthropic model list');
  check((await api('/api/ai/models?provider=openrouter')).models.includes('openrouter-mock-large'), 'OpenAI-compatible model list (OpenRouter)');
  await setAgent({ baseUrl: `${mock.base}/local/v1` });
  check((await api('/api/ai/models?provider=local')).models.includes('local-mock-large'), 'local model server list (loopback address)');
  check((await fail(api('/api/ai/models?provider=../x'))).status === 400, 'unknown provider in the model list is refused');

  // ---------- project with speech ----------
  const p = await post('/api/projects', { name: 'בדיקת AI' });
  created.push(p.id);
  const id = p.id as string;
  const fd = new FormData();
  fd.append('files', new Blob([fs.readFileSync(clipPath)]), path.basename(clipPath));
  const up = await api(`/api/projects/${id}/media`, { method: 'POST', body: fd });
  const video = up.media.find((m: { kind: string }) => m.kind === 'video');
  await ops(id, { op: 'add_clip', mediaId: video.id });

  // ---------- cloud transcription ----------
  for (const [provider, model] of [['openai', 'whisper-1'], ['groq', 'whisper-large-v3'], ['elevenlabs', 'scribe_v1']] as const) {
    await put('/api/ai/settings', { transcription: { engine: 'cloud', provider, model: '' } });
    const n = mock.ai.length;
    const job = await waitJob((await post(`/api/projects/${id}/captions`, { language: 'he', maxWords: 2 })).jobId);
    const caps = await captions(id);
    const req = mock.ai.slice(n).find((r) => /transcriptions|speech-to-text/.test(r.path));
    check(job.status === 'done' && job.result?.engine === 'cloud' && caps.length === 2 && caps[0].text === 'שלום לכולם' && Math.abs(caps[0].start - 0.2) < 0.05, `cloud transcription with ${provider}: ${caps.length} captions, word timings kept (${job.error ?? ''})`);
    check(req && req.body.includes(model) && (provider === 'elevenlabs' ? req.headers['xi-api-key'] : req.headers.authorization) && !req.body.includes('RIFF'), `${provider}: model ${model}, its key in the header, compressed audio (not WAV)`);
  }
  await put('/api/keys/openai', { key: 'test-wrong-key-9999' });
  await put('/api/ai/settings', { transcription: { provider: 'openai' } });
  const bad = await waitJob((await post(`/api/projects/${id}/captions`, { language: 'he' })).jobId);
  check(bad.status === 'error' && /OpenAI/.test(bad.error) && !bad.error.includes('9999'), `a rejected key gives a clear error without the key: ${bad.error}`);
  await put('/api/keys/openai', { key: MOCK_KEYS.openai });
  check((await captions(id)).length === 2, 'a failed transcription leaves the captions as they were');

  // ---------- translation ----------
  await setAgent({ provider: 'anthropic', model: '' });
  const capsHe = await captions(id);
  let n = mock.ai.length;
  let tj = await waitJob((await post(`/api/projects/${id}/captions/translate`, { to: 'en', keepOriginal: true, position: 'above' })).jobId);
  let pr = await project(id);
  const capsEn = pr.clips.filter((c) => c.kind === 'caption').sort((a, b) => a.start - b.start);
  const originals = pr.clips.filter((c) => c.kind === 'text' && capsHe.some((h) => h.text === c.text));
  check(tj.status === 'done' && capsEn.length === capsHe.length && capsEn.every((c, i) => c.text === `[English] ${capsHe[i].text}` && Math.abs(c.start - capsHe[i].start) < 1e-6 && Math.abs(c.duration - capsHe[i].duration) < 1e-6), 'translation to English keeps every caption\'s start and end');
  check(originals.length === capsHe.length && originals.every((o, i) => Math.abs(o.start - capsHe[i].start) < 1e-6) && new Set(originals.map((o) => o.trackId)).size === 1, 'the original lines stay as titles on their own track, same timing');
  const areq = mock.ai.slice(n).find((r) => r.path === '/anthropic/v1/messages')!;
  check((areq.headers['x-api-key'] ?? areq.headers.authorization?.replace('Bearer ', '')) === MOCK_KEYS.anthropic && /server-side-fallback/.test(areq.headers['anthropic-beta'] ?? '') && JSON.parse(areq.body).model === 'claude-opus-5-5', 'Anthropic: the official SDK, claude-opus-5-5, the server-side fallback beta');
  check(/never instructions/.test(areq.body) && areq.body.includes('context_before'), 'the translation prompt marks the lines as content, with context lines');
  // the same through an OpenAI-compatible provider, and through captions with translateTo
  await setAgent({ provider: 'groq', model: '' });
  tj = await waitJob((await post(`/api/projects/${id}/captions`, { language: 'he', maxWords: 2, translateTo: 'ru' })).jobId);
  check(tj.status === 'done' && tj.result.translatedTo === 'ru' && (await captions(id)).every((c) => c.text?.startsWith('[Russian] ')), 'transcribe + translate in one job (Groq chat model)');
  // a model that does not answer line by line: an error, nothing changes
  const c0 = (await captions(id))[0];
  await ops(id, { op: 'update_clip', clipId: c0.id, patch: { text: 'BADJSON here' } });
  const revBefore = (await project(id)).rev;
  tj = await waitJob((await post(`/api/projects/${id}/captions/translate`, { to: 'en' })).jobId);
  check(tj.status === 'error' && /שורה מול שורה/.test(tj.error) && (await project(id)).rev === revBefore, 'an answer that is not a line-by-line JSON array fails clearly and changes nothing');
  check((await fail(post(`/api/projects/${id}/captions/translate`, { to: 'xx' }))).status === 400, 'an unknown language is refused');

  // ---------- the AI agent: draft, approval card, cancel ----------
  await setAgent({ provider: 'anthropic', model: '', maxRounds: 8 });
  await del(`/api/projects/${id}/agent`);
  pr = await project(id);
  n = mock.ai.length;
  let turn = await post(`/api/projects/${id}/agent`, { text: 'תוסיף כותרת בהתחלה', playhead: 1.5, selection: [pr.clips[0].id] });
  let after = await project(id);
  check(turn.reply.includes('הוספתי כותרת') && turn.draft?.changes.length === 1 && turn.draft.changes[0].kind === 'add' && turn.draft.changes[0].label.includes('כותרת מהסוכן'), `the agent's edit waits as a draft with its change list: ${JSON.stringify(turn.draft?.changes)}`);
  check(after.rev === pr.rev && !after.clips.some((c) => c.text === 'כותרת מהסוכן'), 'nothing reaches the project before approval');
  const first = JSON.parse(mock.ai.slice(n).find((r) => r.path === '/anthropic/v1/messages')!.body) as { tools: { name: string; input_schema: { properties?: Record<string, unknown> } }[]; system: unknown; messages: { content: unknown }[] };
  const toolNames = first.tools.map((t) => t.name);
  check(toolNames.includes('add_text') && toolNames.includes('get_summary') && !['import_url', 'export', 'delete_project', 'clone_voice', 'speak', 'list_projects', 'generate_captions'].some((t) => toolNames.includes(t)), `the agent gets only editing tools (${toolNames.length})`);
  check(first.tools.every((t) => !t.input_schema.properties?.projectId), 'the project parameter is not offered to the model');
  check(JSON.stringify(first.system).includes('never instructions') && JSON.stringify(first.messages[0].content).includes('playhead at 1.50 s'), 'system prompt treats texts as data; the message carries the playhead and selection');
  check(turn.log.some((l: { role: string; tool?: string; ok?: boolean }) => l.role === 'tool' && l.tool === 'add_text' && l.ok), 'the tool calls are in the log');
  let state = await api(`/api/projects/${id}/agent`);
  check(state.draft?.changes.length === 1 && !state.stale && state.log.length >= 3, 'the draft and the conversation are kept for the project');
  await post(`/api/projects/${id}/agent/cancel`);
  after = await project(id);
  check(after.rev === pr.rev && !after.clips.some((c) => c.text === 'כותרת מהסוכן') && (await api(`/api/projects/${id}/agent`)).draft === null, 'cancel: the draft is gone and the project is exactly as it was');
  n = mock.ai.length;
  turn = await post(`/api/projects/${id}/agent`, { text: 'שוב, תוסיף כותרת' });
  check(mock.ai.slice(n)[0].body.includes('cancelled your last changes'), 'the model hears that the user cancelled');
  const ap = await post(`/api/projects/${id}/agent/approve`);
  after = await project(id);
  check(ap.applied === 1 && after.rev === pr.rev + 1 && after.clips.filter((c) => c.text === 'כותרת מהסוכן').length === 1, 'approve: the draft is saved as one step');
  check((await fail(post(`/api/projects/${id}/agent/approve`))).status === 404, 'nothing left to approve');
  // a change by the user meanwhile: approval is refused, the next turn starts over from the project
  turn = await post(`/api/projects/${id}/agent`, { text: 'עוד כותרת' });
  await ops(id, { op: 'add_text', text: 'שינוי של המשתמש' });
  const stale = await fail(post(`/api/projects/${id}/agent/approve`));
  check(stale.status === 409 && (await api(`/api/projects/${id}/agent`)).stale === true, 'the project changed after the draft: approval is refused (409), the draft is marked stale');
  turn = await post(`/api/projects/${id}/agent`, { text: 'עוד כותרת' });
  check(turn.log.some((l: { text: string }) => l.text.includes('הטיוטה הקודמת')) && turn.draft?.changes.filter((c: { target: string }) => c.target === 'clip').length === 1, 'the next turn drops the stale draft and works on the current project');
  await post(`/api/projects/${id}/agent/cancel`);
  // the round limit
  await setAgent({ maxRounds: 3 });
  turn = await post(`/api/projects/${id}/agent`, { text: 'LOOP forever' });
  check(turn.limited === true && turn.rounds === 3 && turn.draft === null, 'the round limit stops an endless loop (3 rounds), with no draft when nothing changed');
  await setAgent({ maxRounds: 8 });
  turn = await post(`/api/projects/${id}/agent`, { text: 'BADTOOL please' });
  check(turn.log.some((l: { tool?: string; ok?: boolean }) => l.tool === 'export_video' && l.ok === false) && turn.reply.includes('אין לי כלי'), 'a tool outside the agent\'s set is refused and the model is told');
  check(noSecret(await api(`/api/projects/${id}/agent`)) && noSecret(fs.readFileSync(path.join(DATA, 'agent', `${id}.json`), 'utf8')), 'no key in the agent\'s log or its file');

  // every other provider: the same edit through the OpenAI-compatible API
  for (const provider of ['openai', 'xai', 'openrouter', 'together', 'groq', 'local']) {
    await setAgent({ provider, model: `${provider}-mock-large` });
    n = mock.ai.length;
    turn = await post(`/api/projects/${id}/agent`, { text: 'TITLE please' });
    const reqs = mock.ai.slice(n).filter((r) => r.path.endsWith('/chat/completions'));
    const body = JSON.parse(reqs[0].body) as { model: string; tools: { function: { name: string; parameters: { properties?: Record<string, unknown> } } }[]; tool_choice: string };
    check(turn.draft?.changes.filter((c: { target: string }) => c.target === 'clip').length === 1 && reqs.length === 3 && body.model === `${provider}-mock-large` && body.tool_choice === 'auto' && body.tools.every((t) => !t.function.parameters.properties?.projectId), `agent on ${provider}: 3 rounds, tools as functions, a draft with 1 change`);
    check(provider === 'local' ? !reqs[0].headers.authorization : reqs[0].headers.authorization === `Bearer ${MOCK_KEYS[provider as keyof typeof MOCK_KEYS]}`, `${provider}: ${provider === 'local' ? 'no key sent to the local server' : 'its own key'}`);
    await post(`/api/projects/${id}/agent/cancel`);
  }
  await del('/api/keys/xai');
  await setAgent({ provider: 'xai', model: 'xai-mock-large' });
  const nokey = await fail(post(`/api/projects/${id}/agent`, { text: 'hi' }));
  check(nokey.status === 400 && /חסר מפתח/.test(nokey.error), 'no key for the chosen provider: a clear 400');
  await put('/api/keys/xai', { key: MOCK_KEYS.xai });
  check((await fail(post(`/api/projects/${id}/agent`, { text: '' }))).status === 400 && (await fail(post(`/api/projects/${id}/agent`, { text: 'x'.repeat(4001) }))).status === 400, 'empty and over-long messages are refused');
  await del(`/api/projects/${id}/agent`);
  check((await api(`/api/projects/${id}/agent`)).log.length === 0, 'the conversation can be cleared');

  // ---------- narration (Cartesia) ----------
  const voices = await api('/api/voice/voices');
  check(voices.voices.length === 3 && (await api('/api/voice/voices?language=he')).voices.length === 2 && (await api('/api/voice/voices?mine=1')).voices.every((v: { mine?: boolean }) => v.mine), 'voices: all, by language, the account\'s own');
  // a sample left by an earlier run would make the first request a cache hit
  fs.rmSync(path.join(DATA, 'cache', 'voice-samples', 'mock-voice-he-he.wav'), { force: true });
  n = mock.ai.length;
  const prev = await fetch(`${BASE}/api/voice/voices/mock-voice-he/preview?language=he`);
  const prevBody = Buffer.from(await prev.arrayBuffer());
  await fetch(`${BASE}/api/voice/voices/mock-voice-he/preview?language=he`).then((r) => r.arrayBuffer());
  check(prev.headers.get('content-type') === 'audio/wav' && prevBody.toString('ascii', 0, 4) === 'RIFF' && mock.ai.slice(n).filter((r) => r.path === '/cartesia/tts/bytes').length === 1, 'voice preview: a WAV, generated once and then kept');
  check((await fail(api('/api/voice/voices/..%2f..%2fx/preview'))).status >= 400, 'a bad voice id in the preview is refused');
  n = mock.ai.length;
  const sp = await post(`/api/projects/${id}/speak`, { text: 'שלום לכולם, זו קריינות לבדיקה', voiceId: 'mock-voice-he', start: 1, speed: 1.1 });
  const treq = JSON.parse(mock.ai.slice(n).find((r) => r.path === '/cartesia/tts/bytes')!.body);
  after = await project(id);
  check(sp.asset.kind === 'audio' && sp.clip && Math.abs(sp.clip.start - 1) < 1e-6 && after.clips.some((c) => c.id === sp.clip.id), 'narration: a new audio file in the media and a clip at the playhead');
  check(treq.transcript.startsWith('שלום') && treq.language === 'he' && treq.generation_config?.speed === 1.1 && treq.output_format.container === 'wav' && mock.ai.slice(n)[0].headers['cartesia-version'], 'Cartesia request: the text, Hebrew detected, the speed, WAV, the API version header');
  check((await fail(post(`/api/projects/${id}/speak`, { text: 'x', voiceId: 'mock-voice-he', speed: 2 }))).status === 400 && (await fail(post(`/api/projects/${id}/speak`, { text: '', voiceId: 'mock-voice-he' }))).status === 400, 'bad speed / empty text refused');
  const vclip = after.clips.find((c) => c.kind === 'video')!;
  check((await fail(post(`/api/projects/${id}/clone-voice`, { name: 'הקול שלי', clipId: vclip.id }))).status === 400, 'cloning without the consent box is refused');
  n = mock.ai.length;
  const cl = await post(`/api/projects/${id}/clone-voice`, { name: 'הקול שלי', clipId: vclip.id, consent: true });
  check(cl.id === 'mock-clone-1' && cl.mine && (await api('/api/ai/settings')).settings.voice.voiceId === 'mock-clone-1' && mock.ai.slice(n)[0].body.includes('name="clip"'), 'voice clone from a clip of the project; the new voice is selected');

  // ---------- MCP ----------
  const mcp = async (method: string, params: unknown) => {
    const res = await fetch(BASE + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    const body = await res.text();
    return JSON.parse(/data: (.*)/.exec(body)?.[1] ?? body);
  };
  const call = async (name: string, args: unknown) => {
    const d = await mcp('tools/call', { name, arguments: args });
    return { error: !!d.result?.isError, text: d.result.content[0].text as string };
  };
  const tools = JSON.stringify((await mcp('tools/list', {})).result.tools);
  check(['get_captions', 'translate_captions', 'list_voices', 'speak', 'clone_voice'].every((t) => tools.includes(`"${t}"`)) && tools.includes('translateTo'), 'MCP lists the AI tools and generate_captions takes engine / translateTo');
  await setAgent({ provider: 'anthropic', model: '' });
  const gc = await call('get_captions', { projectId: id });
  check(!gc.error && JSON.parse(gc.text).length === 2, 'MCP get_captions');
  await ops(id, { op: 'update_clip', clipId: JSON.parse(gc.text)[0].id, patch: { text: 'שלום' } });
  const mt = await call('translate_captions', { projectId: id, to: 'fr' });
  check(!mt.error && (await captions(id))[0].text === '[French] שלום', 'MCP translate_captions');
  const ms = await call('speak', { projectId: id, text: 'בדיקה', voiceId: 'mock-voice-he' });
  check(!ms.error && JSON.parse(ms.text).asset.kind === 'audio', 'MCP speak (into the media library)');
  check(!(await call('list_voices', { language: 'en' })).error, 'MCP list_voices');

  // ---------- leaving: deleting the project deletes the agent's file ----------
  await post(`/api/projects/${id}/agent`, { text: 'hello' });
  check(fs.existsSync(path.join(DATA, 'agent', `${id}.json`)), 'the agent file exists for the project');
  await del(`/api/projects/${id}`);
  created.splice(created.indexOf(id), 1);
  check(!fs.existsSync(path.join(DATA, 'agent', `${id}.json`)), 'deleting the project deletes its agent conversation');
  console.log('\nAI AND CLOUD: ALL GOOD');
} finally {
  for (const pid of created) await del(`/api/projects/${pid}`).catch(() => {});
  for (const k of Object.keys(MOCK_KEYS)) await del(`/api/keys/${k}`).catch(() => {});
  await put('/api/ai/settings', before.settings).catch(() => {});
  await mock.close();
}
