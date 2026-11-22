import { useEffect, useRef, useState } from 'react';
import type { Job } from '../../shared/types';
import { api, latestJob, useStore } from '../store';
import { Icon } from './Icon';
import { KeyField } from './Keys';
import { Slider } from './Inspector';
import { getLang, t, tl, type Key } from '../i18n';

/**
 * The AI and cloud parts of the editor: the transcription engine and caption translation (captions tab),
 * narration and voice cloning (sound tab) and the AI agent tab, whose edits wait on an approval card.
 * Keys are typed into password fields and kept by the server; they never come back to this page.
 */

export interface AiSettings {
  transcription: { engine: 'auto' | 'local' | 'cloud'; provider: string; model: string };
  agent: { provider: string; model: string; baseUrl: string; maxRounds: number };
  voice: { model: string; voiceId: string; voiceName: string };
}
interface AiInfo {
  settings: AiSettings;
  stt: Record<string, { label: string; model: string }>;
  agent: Record<string, { label: string; model: string; keyRequired: boolean }>;
  languages: Record<string, string>;
  /** null while the server still checks */
  localWhisper: boolean | null;
}

const LANG_KEYS: Record<string, Key> = { he: 'ai.langHe', en: 'ai.langEn', ar: 'ai.langAr', ru: 'ai.langRu', es: 'ai.langEs', fr: 'ai.langFr', de: 'ai.langDe', it: 'ai.langIt', pt: 'ai.langPt' };
const langName = (l: string) => (LANG_KEYS[l] ? t(LANG_KEYS[l]) : l);

// one copy for every panel on the page; a change in one panel shows in the others
let shared: AiInfo | null = null;
const listeners = new Set<(i: AiInfo) => void>();
function publish(i: AiInfo) {
  shared = i;
  for (const l of listeners) l(i);
}
export function useAi() {
  const [info, setInfo] = useState<AiInfo | null>(shared);
  useEffect(() => {
    listeners.add(setInfo);
    let timer = 0;
    const fetchInfo = () =>
      api<AiInfo>('/api/ai/settings')
        .then((i) => {
          publish(i);
          // the local Whisper check takes a while the first time: ask again
          if (i.localWhisper === null) timer = window.setTimeout(fetchInfo, 4000);
        })
        .catch(() => {});
    if (!shared || shared.localWhisper === null) void fetchInfo();
    return () => {
      clearTimeout(timer);
      listeners.delete(setInfo);
    };
  }, []);
  const save = async (patch: { [K in keyof AiSettings]?: Partial<AiSettings[K]> }) => {
    try {
      const r = await api<{ settings: AiSettings }>('/api/ai/settings', { method: 'PUT', body: JSON.stringify(patch) });
      if (shared) publish({ ...shared, settings: r.settings });
    } catch (e) {
      useStore.getState().notify((e as Error).message, 'error');
    }
  };
  return { info, save };
}

// ---------------- captions: engine and translation ----------------

/** Where the speech is transcribed: this computer, or a cloud provider with its key. */
export function CaptionEngine({ translateTo, setTranslateTo }: { translateTo: string; setTranslateTo: (v: string) => void }) {
  const { info, save } = useAi();
  if (!info) return null;
  const tr = info.settings.transcription;
  const cloud = tr.engine === 'cloud' || (tr.engine === 'auto' && info.localWhisper === false);
  return (
    <div className="ai-engine" data-testid="caption-engine">
      <div className="field-grid">
        <label className="field">
          <span className="field-label">{t('ai.whereTranscribe')}</span>
          <select value={tr.engine} onChange={(e) => void save({ transcription: { engine: e.target.value as AiSettings['transcription']['engine'] } })} data-testid="caption-engine-select">
            <option value="auto">{info.localWhisper === null ? t('ai.engineAuto') : info.localWhisper ? t('ai.engineAutoLocal') : t('ai.engineAutoCloud')}</option>
            <option value="local">{t('ai.engineLocal')}</option>
            <option value="cloud">{t('ai.engineCloud')}</option>
          </select>
        </label>
        <label className="field">
          <span className="field-label">{t('ai.translateAfter')}</span>
          <select value={translateTo} onChange={(e) => setTranslateTo(e.target.value)} data-testid="caption-translate-to">
            <option value="">{t('ai.noTranslation')}</option>
            {Object.keys(info.languages).map((l) => (
              <option key={l} value={l}>
                {langName(l)}
              </option>
            ))}
          </select>
        </label>
      </div>
      {cloud && (
        <>
          <label className="field">
            <span className="field-label">{t('ai.sttService')}</span>
            <select value={tr.provider} onChange={(e) => void save({ transcription: { provider: e.target.value, model: '' } })} data-testid="caption-provider">
              {Object.entries(info.stt).map(([id, p]) => (
                <option key={id} value={id}>
                  {p.label} ({p.model})
                </option>
              ))}
            </select>
          </label>
          <KeyField key={tr.provider} provider={tr.provider} help={t('ai.sttHelp', { label: info.stt[tr.provider]?.label ?? '' })} />
        </>
      )}
      {tr.engine === 'local' && info.localWhisper === false && <p className="hint">{t('ai.localMissing')}</p>}
      {translateTo && <p className="hint">{t('ai.translateModelHint')}</p>}
    </div>
  );
}

/** Translate the existing captions; every caption keeps its time. */
export function TranslateSection() {
  const { info } = useAi();
  const project = useStore((s) => s.project)!;
  const job = useStore((s) => latestJob(s.jobs, 'translate'));
  const [to, setTo] = useState('en');
  const [keep, setKeep] = useState(false);
  const [position, setPosition] = useState<'above' | 'below'>('above');
  const s = useStore.getState();
  const running = job?.status === 'running';
  const start = async () => {
    try {
      const j = await api<Job>(`/api/projects/${project.id}/captions/translate`, { method: 'POST', body: JSON.stringify({ to, keepOriginal: keep, position }) });
      useStore.setState((st) => ({ jobs: { ...st.jobs, [j.id]: st.jobs[j.id] ?? j } }));
    } catch (e) {
      s.notify((e as Error).message, 'error');
    }
  };
  if (!info) return null;
  return (
    <div className="ai-translate" data-testid="caption-translate">
      <div className="field-grid">
        <label className="field">
          <span className="field-label">{t('ai.toLanguage')}</span>
          <select value={to} onChange={(e) => setTo(e.target.value)} data-testid="translate-lang">
            {Object.keys(info.languages).map((l) => (
              <option key={l} value={l}>
                {langName(l)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">{t('ai.originalLines')}</span>
          <select value={keep ? position : 'none'} onChange={(e) => (e.target.value === 'none' ? setKeep(false) : (setKeep(true), setPosition(e.target.value as 'above' | 'below')))} data-testid="translate-keep">
            <option value="none">{t('ai.replaceThem')}</option>
            <option value="above">{t('ai.keepAbove')}</option>
            <option value="below">{t('ai.keepBelow')}</option>
          </select>
        </label>
      </div>
      {running ? (
        <div className="progress-row" role="status">
          <span>{job.message ?? t('ai.translating')}</span>
          <button className="link-btn" onClick={() => void fetch(`/api/jobs/${job.id}/cancel`, { method: 'POST' })}>
            {t('ai.cancel')}
          </button>
        </div>
      ) : (
        <button className="btn wide" onClick={() => void start()} data-testid="translate-start">
          <Icon name="swap" size={15} /> {t('ai.translateCaptions')}
        </button>
      )}
      <p className="hint">{t('ai.translateHint')}</p>
    </div>
  );
}

// ---------------- narration (Cartesia) ----------------

interface Voice {
  id: string;
  name: string;
  description?: string;
  language?: string;
  mine?: boolean;
}

export function Narration() {
  const { info, save } = useAi();
  const projectId = useStore((s) => s.project!.id);
  const selected = useStore((s) => s.project!.clips.find((c) => c.id === s.selected && (c.kind === 'video' || c.kind === 'audio')));
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [voices, setVoices] = useState<Voice[] | null>(null);
  const [lang, setLang] = useState('he');
  const [text, setText] = useState('');
  const [speed, setSpeed] = useState(1);
  const [busy, setBusy] = useState('');
  const [cloneName, setCloneName] = useState('');
  const [consent, setConsent] = useState(false);
  const player = useRef<HTMLAudioElement | null>(null);
  const s = useStore.getState();
  const voiceId = info?.settings.voice.voiceId ?? '';
  useEffect(() => () => player.current?.pause(), []);
  useEffect(() => {
    if (!hasKey) return;
    setVoices(null);
    api<{ voices: Voice[] }>(`/api/voice/voices?language=${lang}`)
      .then((r) => setVoices(r.voices))
      .catch((e) => (setVoices([]), s.notify((e as Error).message, 'error')));
  }, [hasKey, lang]);
  const preview = (id: string) => {
    player.current?.pause();
    player.current = new Audio(`/api/voice/voices/${encodeURIComponent(id)}/preview?language=${lang === 'he' ? 'he' : 'en'}`);
    void player.current.play().catch(() => s.notify(t('ai.previewFailed'), 'error'));
  };
  const speak = async () => {
    setBusy('speak');
    try {
      const r = await api<{ clip?: { id: string } }>(`/api/projects/${projectId}/speak`, { method: 'POST', body: JSON.stringify({ text, voiceId, speed, start: useStore.getState().time }) });
      if (r.clip) s.select(r.clip.id);
      s.notify(t('ai.narrationAdded'));
      setText('');
    } catch (e) {
      s.notify((e as Error).message, 'error');
    } finally {
      setBusy('');
    }
  };
  const clone = async () => {
    setBusy('clone');
    try {
      const v = await api<Voice>(`/api/projects/${projectId}/clone-voice`, { method: 'POST', body: JSON.stringify({ name: cloneName, clipId: selected?.id, consent, language: lang }) });
      setVoices((list) => [v, ...(list ?? []).filter((x) => x.id !== v.id)]);
      if (shared) publish({ ...shared, settings: { ...shared.settings, voice: { ...shared.settings.voice, voiceId: v.id, voiceName: v.name } } });
      s.notify(t('ai.voiceCreated', { name: v.name }));
      setCloneName('');
      setConsent(false);
    } catch (e) {
      s.notify((e as Error).message, 'error');
    } finally {
      setBusy('');
    }
  };
  return (
    <div className="narration" data-testid="narration">
      <KeyField provider="cartesia" onChange={(k) => setHasKey(k.hasKey)} onLoad={(k) => setHasKey(k.hasKey)} help={t('ai.cartesiaHelp')} />
      {hasKey && (
        <>
          <div className="field-grid">
            <label className="field">
              <span className="field-label">{t('ai.language')}</span>
              <select value={lang} onChange={(e) => setLang(e.target.value)}>
                {Object.entries(LANG_KEYS).map(([k, v]) => (
                  <option key={k} value={k}>
                    {t(v)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="field-label">{t('ai.voice')}</span>
              <select value={voiceId} onChange={(e) => void save({ voice: { voiceId: e.target.value, voiceName: voices?.find((v) => v.id === e.target.value)?.name ?? '' } })} data-testid="voice-select">
                <option value="">{voices === null ? t('ai.loadingVoices') : t('ai.chooseVoice')}</option>
                {voiceId && !voices?.some((v) => v.id === voiceId) && <option value={voiceId}>{info?.settings.voice.voiceName || voiceId}</option>}
                {(voices ?? []).map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                    {v.mine ? t('ai.voiceMine') : ''}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {voiceId && (
            <button className="link-btn" onClick={() => preview(voiceId)} data-testid="voice-preview">
              <Icon name="play" size={13} /> {t('ai.playSample')}
            </button>
          )}
          <textarea className="narration-text" dir="auto" rows={3} maxLength={2000} placeholder={t('ai.narrationPlaceholder')} value={text} onChange={(e) => setText(e.target.value)} data-testid="narration-text" />
          <Slider label={t('ai.speed')} value={speed} def={1} min={0.6} max={1.5} step={0.05} fmt={(v) => `×${v.toFixed(2)}`} onChange={setSpeed} />
          <button className="btn primary wide" disabled={!text.trim() || !voiceId || busy !== ''} onClick={() => void speak()} data-testid="narration-generate">
            <Icon name="mic" size={15} /> {busy === 'speak' ? t('ai.generating') : t('ai.generate')}
          </button>
          <details className="clone-box">
            <summary>{t('ai.cloneTitle')}</summary>
            <p className="hint">{t('ai.cloneHint')}</p>
            <input type="text" dir="auto" placeholder={t('ai.cloneName')} maxLength={60} value={cloneName} onChange={(e) => setCloneName(e.target.value)} />
            <label className="check-row">
              <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} data-testid="clone-consent" />
              <span>{t('ai.cloneConsent')}</span>
            </label>
            <button className="btn wide" disabled={!selected || !cloneName.trim() || !consent || busy !== ''} onClick={() => void clone()}>
              {busy === 'clone' ? t('ai.cloning') : selected ? t('ai.cloneSelected') : t('ai.selectClipFirst')}
            </button>
          </details>
        </>
      )}
    </div>
  );
}

// ---------------- the AI agent ----------------

interface LogEntry {
  role: 'user' | 'assistant' | 'tool' | 'note';
  text: string;
  at: string;
  tool?: string;
  ok?: boolean;
  /** a note as an id and values (missing in conversations kept before the English UI) */
  key?: string;
  vars?: Record<string, string | number>;
}
interface Change {
  kind: 'add' | 'remove' | 'change';
  target: string;
  label: string;
  detail?: string;
  /** the row as ids (see shared/diff.ts); missing in drafts kept before the English UI */
  i18n?: { label: string; vars?: Record<string, string | number>; detail?: string[] };
}
interface DraftView {
  changes: Change[];
  operations: number;
}
interface AgentView {
  log: LogEntry[];
  draft: DraftView | null;
  stale: boolean;
  busy: boolean;
}

const TOOL_KEYS: Record<string, Key> = {
  get_summary: 'ai.toolGetSummary',
  get_captions: 'ai.toolGetCaptions',
  cut_range: 'ai.toolCutRange',
  split: 'ai.toolSplit',
  delete: 'ai.toolDelete',
  add_text: 'ai.toolAddText',
  set_caption_style: 'ai.toolSetCaptionStyle',
  set_title_font: 'ai.toolSetTitleFont',
  add_transition: 'ai.toolAddTransition',
  add_music: 'ai.toolAddMusic',
  set_layout: 'ai.toolSetLayout',
  set_logo: 'ai.toolSetLogo',
  set_aspect: 'ai.toolSetAspect',
  set_effect: 'ai.toolSetEffect',
  set_speed: 'ai.toolSetSpeed',
  set_keyframe: 'ai.toolSetKeyframe',
  delete_keyframe: 'ai.toolDeleteKeyframe',
  punch_in: 'ai.toolPunchIn',
  insert_clip: 'ai.toolInsertClip',
  move_clip_to_new_track: 'ai.toolMoveToNewTrack',
  set_animation: 'ai.toolSetAnimation',
  remove_silences: 'ai.toolRemoveSilences',
  add_clip: 'ai.toolAddClip',
  move_clip: 'ai.toolMoveClip',
  trim_clip: 'ai.toolTrimClip',
  update_clip: 'ai.toolUpdateClip',
  duplicate_clip: 'ai.toolDuplicateClip',
  ripple_delete: 'ai.toolRippleDelete',
  detach_audio: 'ai.toolDetachAudio',
  add_track: 'ai.toolAddTrack',
  set_track: 'ai.toolSetTrack',
  delete_track: 'ai.toolDeleteTrack',
  set_settings: 'ai.toolSetSettings',
  set_in_out: 'ai.toolSetInOut',
  set_captions: 'ai.toolSetCaptions',
  set_caption_animation: 'ai.toolSetCaptionAnimation',
  apply_ops: 'ai.toolApplyOps',
};
const KIND_ICON: Record<Change['kind'], string> = { add: '+', remove: '−', change: '✎' };

// notes the server writes into the log (server/agent.ts), by id
const NOTE_KEYS: Record<string, Key> = {
  tooLong: 'ai.noteTooLong',
  switched: 'ai.noteSwitched',
  draftDropped: 'ai.noteDraftDropped',
  cut: 'ai.noteCut',
  roundLimit: 'ai.noteRoundLimit',
  noChange: 'ai.noteNoChange',
  stopped: 'ai.noteStopped',
  error: 'ai.noteError',
  saved: 'ai.noteSaved',
  cancelled: 'ai.noteCancelled',
};

// the parts of an approval-card row (shared/diff.ts), by id
const DIFF_KEYS: Record<string, Key> = {
  'kind.video': 'ai.diffKindVideo',
  'kind.image': 'ai.diffKindImage',
  'kind.audio': 'ai.diffKindAudio',
  'kind.text': 'ai.diffKindText',
  'kind.caption': 'ai.diffKindCaption',
  captions: 'ai.diffCaptions',
  'setting.name': 'ai.diffSetName',
  'setting.size': 'ai.diffSetSize',
  'setting.fps': 'ai.diffSetFps',
  'setting.background': 'ai.diffSetBackground',
  'setting.layout': 'ai.diffSetLayout',
  'setting.logo': 'ai.diffSetLogo',
  'setting.titleFont': 'ai.diffSetTitleFont',
  'setting.captionStyle': 'ai.diffSetCaptionStyle',
  'setting.captionAnim': 'ai.diffSetCaptionAnim',
  'setting.inOut': 'ai.diffSetInOut',
  'field.start': 'ai.diffFieldStart',
  'field.duration': 'ai.diffFieldDuration',
  'field.offset': 'ai.diffFieldOffset',
  'field.trackId': 'ai.diffFieldTrack',
  'field.text': 'ai.diffFieldText',
  'field.style': 'ai.diffFieldStyle',
  'field.fx': 'ai.diffFieldFx',
  'field.keyframes': 'ai.diffFieldKeyframes',
  'field.transition': 'ai.diffFieldTransition',
  'field.animIn': 'ai.diffFieldAnimIn',
  'field.animOut': 'ai.diffFieldAnimOut',
  'field.speed': 'ai.diffFieldSpeed',
  'field.volume': 'ai.diffFieldVolume',
  'field.fadeIn': 'ai.diffFieldFadeIn',
  'field.fadeOut': 'ai.diffFieldFadeOut',
  'field.words': 'ai.diffFieldWords',
  'track.muted': 'ai.diffTrackMuted',
  'track.unmuted': 'ai.diffTrackUnmuted',
  'track.hidden': 'ai.diffTrackHidden',
  'track.shown': 'ai.diffTrackShown',
  'track.name': 'ai.diffTrackName',
  'caps.add': 'ai.diffCapsAdd',
  'caps.remove': 'ai.diffCapsRemove',
  'caps.change': 'ai.diffCapsChange',
};

/** A server note in the current language; the Hebrew text when it has no id (older conversations). */
function noteText(l: LogEntry): string {
  const key = l.key ? NOTE_KEYS[l.key] : undefined;
  return getLang() === 'en' && key ? t(key, l.vars) : l.text;
}

/** An approval-card row in the current language; the Hebrew text when its ids are missing or unknown. */
function changeText(c: Change): { label: string; detail?: string } {
  const k = c.i18n;
  if (getLang() !== 'en' || !k) return { label: c.label, detail: c.detail };
  const v = k.vars ?? {};
  let label: string | null;
  if (k.label === 'clip') {
    const kind = DIFF_KEYS[`kind.${v.kind}`];
    // the clip's own text (often Hebrew) is isolated, so it does not swallow the quotes and the time range
    const what = String(v.what ?? '');
    label = t('ai.diffClip', { kind: kind ? t(kind) : String(v.kind ?? ''), what: what ? '⁨' + what + '⁩' : '', range: String(v.range ?? '') }).replace(/\s+/g, ' ');
  } else if (k.label === 'track') {
    const name = String(v.name ?? '');
    label = t('ai.diffTrack', { name: v.kind ? tl('trackName', String(v.kind), name) : name }).trim();
  } else label = DIFF_KEYS[k.label] ? t(DIFF_KEYS[k.label], v) : null;
  if (label === null) return { label: c.label, detail: c.detail };
  if (!k.detail) return { label, detail: c.detail };
  const parts = k.detail.map((d) => (DIFF_KEYS[d] ? t(DIFF_KEYS[d], v) : null));
  return { label, detail: parts.every((x) => x !== null) ? parts.join(', ') : c.detail };
}

function AgentSettings({ open }: { open: boolean }) {
  const { info, save } = useAi();
  const [models, setModels] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [model, setModel] = useState('');
  const [base, setBase] = useState('');
  const a = info?.settings.agent;
  useEffect(() => {
    setModel(a?.model ?? '');
    setBase(a?.baseUrl ?? '');
  }, [a?.model, a?.baseUrl, a?.provider]);
  useEffect(() => {
    setModels([]);
  }, [a?.provider]);
  if (!info || !a) return null;
  const p = info.agent[a.provider];
  const loadModels = async () => {
    setLoading(true);
    try {
      setModels((await api<{ models: string[] }>(`/api/ai/models?provider=${a.provider}`)).models);
    } catch (e) {
      useStore.getState().notify((e as Error).message, 'error');
    } finally {
      setLoading(false);
    }
  };
  return (
    <details className="agent-settings" open={open} data-testid="agent-settings">
      <summary>
        {t('ai.settingsSummary', { label: p.label })}<bdi dir="ltr">{a.model || p.model || t('ai.chooseModel')}</bdi>
      </summary>
      <label className="field">
        <span className="field-label">{t('ai.provider')}</span>
        <select value={a.provider} onChange={(e) => void save({ agent: { provider: e.target.value, model: '' } })} data-testid="agent-provider">
          {Object.entries(info.agent).map(([id, x]) => (
            <option key={id} value={id}>
              {x.label}
            </option>
          ))}
        </select>
      </label>
      {p.keyRequired && <KeyField key={a.provider} provider={a.provider} help={t('ai.agentHelp', { label: p.label })} />}
      {a.provider === 'local' && (
        <label className="field">
          <span className="field-label">{t('ai.localServer')}</span>
          <input type="text" dir="ltr" value={base} onChange={(e) => setBase(e.target.value)} onBlur={() => base !== a.baseUrl && void save({ agent: { baseUrl: base } })} placeholder="http://127.0.0.1:11434/v1" data-testid="agent-base" />
        </label>
      )}
      <label className="field">
        <span className="field-label">{t('ai.model')}</span>
        <div className="inline-form">
          <input type="text" dir="ltr" list="agent-models" value={model} placeholder={p.model || t('ai.modelName')} onChange={(e) => setModel(e.target.value)} onBlur={() => model !== a.model && void save({ agent: { model } })} data-testid="agent-model" />
          <button className="btn" disabled={loading} onClick={() => void loadModels()}>
            {loading ? '...' : t('ai.list')}
          </button>
        </div>
        <datalist id="agent-models">
          {models.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
      </label>
      <Slider label={t('ai.rounds')} value={a.maxRounds} def={8} min={1} max={24} step={1} fmt={(v) => String(v)} onChange={(v) => void save({ agent: { maxRounds: v } })} />
    </details>
  );
}

export function AgentTab() {
  const project = useStore((s) => s.project)!;
  const rev = useStore((s) => s.project!.rev);
  const { info } = useAi();
  const [view, setView] = useState<AgentView | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState<'' | 'turn' | 'approve' | 'cancel'>('');
  const logEl = useRef<HTMLDivElement>(null);
  const s = useStore.getState();
  const load = () =>
    api<AgentView>(`/api/projects/${project.id}/agent`)
      .then(setView)
      .catch(() => setView({ log: [], draft: null, stale: false, busy: false }));
  // leaving the tab does not stop the agent: coming back shows it still working
  useEffect(() => {
    void load();
  }, [project.id]);
  const working = busy === 'turn' || !!view?.busy;
  useEffect(() => {
    if (!view?.busy || busy === 'turn') return;
    const timer = setTimeout(() => void load(), 1500);
    return () => clearTimeout(timer);
  }, [view]);
  // a change by the user after the draft was made: the card says it is out of date
  useEffect(() => {
    if (view?.draft && !busy) void load();
  }, [rev]);
  useEffect(() => {
    logEl.current?.scrollTo({ top: logEl.current.scrollHeight });
  }, [view?.log.length, busy]);
  const send = async () => {
    const msg = text.trim();
    if (!msg) return;
    setBusy('turn');
    setText('');
    setView((v) => v && { ...v, log: [...v.log, { role: 'user', text: msg, at: new Date().toISOString() }] });
    try {
      const st = useStore.getState();
      await api(`/api/projects/${project.id}/agent`, { method: 'POST', body: JSON.stringify({ text: msg, playhead: st.time, selection: st.selected ? [st.selected] : [] }) });
    } catch (e) {
      s.notify((e as Error).message, 'error');
    } finally {
      setBusy('');
      await load();
    }
  };
  const stop = () => {
    void fetch(`/api/projects/${project.id}/agent/stop`, { method: 'POST' });
  };
  const decide = async (what: 'approve' | 'cancel') => {
    setBusy(what);
    try {
      await api(`/api/projects/${project.id}/agent/${what}`, { method: 'POST' });
      s.notify(what === 'approve' ? t('ai.agentSaved') : t('ai.agentCancelled'));
    } catch (e) {
      s.notify((e as Error).message, 'error');
    } finally {
      setBusy('');
      await load();
    }
  };
  const clear = async () => {
    if (!window.confirm(t('ai.clearConfirm'))) return;
    try {
      setView(await api<AgentView>(`/api/projects/${project.id}/agent`, { method: 'DELETE' }));
    } catch (e) {
      s.notify((e as Error).message, 'error');
    }
  };
  const a = info?.settings.agent;
  const configured = !!a && !!(a.model || info?.agent[a.provider]?.model);
  return (
    <div className="tab-body agent-tab" data-testid="agent-tab">
      <div className="panel-head">
        <h3>{t('ai.agentTitle')}</h3>
        {!!view?.log.length && (
          <button className="link-btn" onClick={() => void clear()} disabled={busy !== ''}>
            {t('ai.clearChat')}
          </button>
        )}
      </div>
      <AgentSettings open={!configured} />
      <div className="agent-log" ref={logEl} data-testid="agent-log" aria-live="polite">
        {!view?.log.length && <p className="hint">{t('ai.agentEmpty')}</p>}
        {view?.log.map((l, i) =>
          l.role === 'tool' ? (
            <div key={i} className={'agent-tool' + (l.ok === false ? ' failed' : '')}>
              {l.ok === false ? '✕' : '·'} {TOOL_KEYS[l.tool ?? ''] ? t(TOOL_KEYS[l.tool ?? '']) : l.tool}
            </div>
          ) : (
            <div key={i} className={'agent-msg ' + l.role} dir="auto">
              {l.role === 'note' ? noteText(l) : l.text}
            </div>
          ),
        )}
        {working && (
          <div className="agent-msg note" role="status">
            {t('ai.agentWorking')}{' '}
            <button className="link-btn" onClick={stop}>
              {t('ai.stop')}
            </button>
          </div>
        )}
      </div>
      {view?.draft && (
        <div className={'draft-card' + (view.stale ? ' stale' : '')} data-testid="agent-draft">
          <h4>
            {t(view.draft.changes.length === 1 ? 'ai.draftCountOne' : 'ai.draftCountMany', { n: view.draft.changes.length })}
          </h4>
          <ul>
            {view.draft.changes.map((c, i) => {
              const row = changeText(c);
              return (
                <li key={i} className={'change ' + c.kind}>
                  <span className="change-kind" aria-hidden="true">
                    {KIND_ICON[c.kind]}
                  </span>
                  <span dir="auto">
                    {row.label}
                    {row.detail && <span className="muted"> · {row.detail}</span>}
                  </span>
                </li>
              );
            })}
          </ul>
          {view.stale && <p className="hint">{t('ai.staleHint')}</p>}
          <div className="btn-row">
            <button className="btn primary" disabled={busy !== '' || view.stale} onClick={() => void decide('approve')} data-testid="agent-approve">
              <Icon name="check" size={15} /> {t('ai.approve')}
            </button>
            <button className="btn" disabled={busy !== ''} onClick={() => void decide('cancel')} data-testid="agent-cancel">
              {t('ai.cancel')}
            </button>
          </div>
        </div>
      )}
      <div className="agent-input">
        <textarea
          dir="auto"
          rows={2}
          maxLength={4000}
          placeholder={configured ? t('ai.inputPlaceholder') : t('ai.inputNeedsSetup')}
          value={text}
          disabled={working}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          data-testid="agent-input"
        />
        <button className="btn primary" disabled={!text.trim() || busy !== '' || working} onClick={() => void send()} data-testid="agent-send">
          {t('ai.send')}
        </button>
      </div>
    </div>
  );
}
