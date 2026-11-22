import { useEffect, useRef, useState } from 'react';
import { colorFx, parseSrt } from '../../shared/fx';
import { captionsTiedTo, uid, type Op } from '../../shared/ops';
import { ANIM_LABELS, CAPTION_PRESETS, TEXT_PRESETS, LOOKS, TRANSITION_LABELS, type AnimType, type Clip, type Job, type Look, type MediaAsset, type MediaCredit, type TextStyle, type TransitionType } from '../../shared/types';
import { addMediaToTimeline, applyFxToAll, insertAtPlayhead, siblingsOf, uploadFiles } from '../actions';
import { api, fmtTime, latestJob, useStore } from '../store';
import { setFonts, useFonts, type FontFamilyInfo } from '../fonts';
import { Icon } from './Icon';
import { FontOptions, Section, Seg, Slider, TextStyleFields } from './Inspector';
import { KeyField } from './Keys';
import { AgentTab, CaptionEngine, Narration, TranslateSection } from './Ai';
import { t, tl, type Key } from '../i18n';

type Tab = 'media' | 'text' | 'captions' | 'music' | 'filters' | 'transitions' | 'anim' | 'ai';
const TABS: { id: Tab; label: Key; icon: string }[] = [
  { id: 'media', label: 'lib.media', icon: 'film' },
  { id: 'text', label: 'lib.text', icon: 'text' },
  { id: 'captions', label: 'lib.captions', icon: 'captions' },
  { id: 'music', label: 'lib.sound', icon: 'music' },
  { id: 'filters', label: 'lib.filters', icon: 'wand' },
  { id: 'transitions', label: 'lib.transitions', icon: 'swap' },
  { id: 'anim', label: 'lib.animation', icon: 'spark' },
  { id: 'ai', label: 'lib.aiAgent', icon: 'chat' },
];

const mmss = (d: number) => `${Math.floor(d / 60)}:${String(Math.floor(d % 60)).padStart(2, '0')}`;

/** A one-line "how it works", opened on demand instead of paragraphs above every list. */
function Help({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="help-link" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name="help" size={14} /> {open ? t('lib.helpHide') : t('lib.helpShow')}
      </button>
      {open && <p className="hint">{children}</p>}
    </>
  );
}

function PanelHead({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="panel-head">
      <h3>{title}</h3>
      {children}
    </div>
  );
}

function useFilePicker(accept: string) {
  const input = useRef<HTMLInputElement>(null);
  const el = (
    <input
      ref={input}
      type="file"
      hidden
      multiple
      accept={accept}
      onChange={(e) => {
        if (e.target.files?.length) void uploadFiles(e.target.files);
        e.target.value = '';
      }}
    />
  );
  return { open: () => input.current?.click(), el };
}

const creditLine = (c: MediaCredit) => [c.title && `"${c.title}"`, c.author && t('lib.creditBy', { author: c.author }), `${c.provider} · ${c.license}`].filter(Boolean).join(' · ');

function MediaCard({ m }: { m: MediaAsset }) {
  const used = useStore((s) => s.project!.clips.some((c) => c.mediaId === m.id));
  const s = useStore.getState();
  return (
    <div
      className="media-card"
      title={`${m.name}${m.credit ? `\n${creditLine(m.credit)}` : ''}\n${t('lib.mediaCardHint')}`}
      role="button"
      tabIndex={0}
      draggable
      onClick={() => addMediaToTimeline(m)}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), addMediaToTimeline(m))}
      onDragStart={(e) => {
        e.dataTransfer.setData('application/x-alon-media', m.id);
        e.dataTransfer.effectAllowed = 'copy';
      }}
    >
      <div className={'media-thumb' + (m.kind === 'audio' ? ' audio' : '')} style={m.thumb ? { backgroundImage: `url(/media/${m.thumb})` } : m.wave ? { backgroundImage: `url(/media/${m.wave})` } : undefined}>
        {m.kind === 'audio' && !m.wave && <Icon name="music" size={24} />}
        {m.kind !== 'image' && <span className="dur" dir="ltr">{mmss(m.duration)}</span>}
        {used && <span className="used">{t('lib.inVideo')}</span>}
        {m.credit && (
          <span className="credit-badge" title={creditLine(m.credit)}>
            ©
          </span>
        )}
        <span className="add" aria-hidden="true">
          <Icon name="plus" size={16} />
        </span>
        {m.kind !== 'audio' && (
          <button
            className="insert"
            title={t('lib.insertTitle')}
            aria-label={t('lib.insertNamed', { name: m.name })}
            onClick={(e) => {
              e.stopPropagation();
              insertAtPlayhead(m);
            }}
          >
            <Icon name="split" size={14} />
          </button>
        )}
        <button
          className="remove"
          title={t('lib.removeFromLibrary')}
          onClick={(e) => {
            e.stopPropagation();
            const p = useStore.getState().project!;
            const n = p.clips.filter((c) => c.mediaId === m.id).length;
            const caps = captionsTiedTo(p, m.id).length;
            const clipsText = t(n === 1 ? 'lib.clipsOne' : 'lib.clipsMany', { n });
            const ask = caps
              ? t('lib.removeAskCaps', { clips: clipsText, caps: t(caps === 1 ? 'lib.captionsCountOne' : 'lib.captionsCountMany', { n: caps }) })
              : t('lib.removeAsk', { clips: clipsText });
            if (!n || window.confirm(ask)) s.run({ op: 'remove_media', mediaId: m.id });
          }}
        >
          <Icon name="close" size={14} />
        </button>
      </div>
      <div className="media-name" dir="auto">
        {m.name}
      </div>
    </div>
  );
}

function MediaTab() {
  const media = useStore((s) => s.project!.media).filter((m) => !m.libraryId);
  const uploading = useStore((s) => s.uploading);
  const [over, setOver] = useState(false);
  const picker = useFilePicker('video/*,image/*,audio/*');
  return (
    <div
      className={'tab-body' + (over ? ' dropping' : '')}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        if (e.dataTransfer.files.length) void uploadFiles(e.dataTransfer.files);
      }}
    >
      <PanelHead title={t('lib.media')} />
      <button className="dropzone" disabled={uploading} onClick={picker.open}>
        <Icon name="upload" size={22} />
        <b>{uploading ? t('lib.uploading') : t('lib.uploadMedia')}</b>
        <span>{t('lib.orDrop')}</span>
      </button>
      {picker.el}
      {media.length > 0 && (
        <>
          <p className="hint">{t('lib.mediaHint')}</p>
          <div className="media-grid">
            {media.map((m) => (
              <MediaCard key={m.id} m={m} />
            ))}
          </div>
        </>
      )}
      <ImportJob />
      <Section id="url-import" title={t('lib.urlImport')} defaultOpen={false}>
        <UrlImport />
      </Section>
      <Section id="stock" title={t('lib.stock')} defaultOpen={false}>
        <StockPanel />
      </Section>
      {media.some((m) => m.credit) && <CreditsButton />}
    </div>
  );
}

/** Progress of the running (or last failed) download. */
function ImportJob() {
  const job = useStore((s) => latestJob(s.jobs, 'import'));
  if (!job || job.status === 'done') return null;
  if (job.status === 'error')
    return (
      <p className="error" dir="auto" data-testid="import-error">
        {t('lib.importFailed', { error: job.error ?? '' })}
      </p>
    );
  const mb = (b?: number) => (b ? (b / 1048576).toFixed(1) : '0');
  return (
    <div className="import-job" data-testid="import-job">
      <div className="progress">
        <div style={{ width: `${Math.round(job.progress * 100)}%` }} />
      </div>
      <span className="muted small">{job.stage === 'check' ? t('lib.importChecking') : job.dlTotal ? t('lib.importDownloadingOf', { dl: mb(job.dl), total: mb(job.dlTotal) }) : t('lib.importDownloading', { dl: mb(job.dl) })}</span>
    </div>
  );
}

function UrlImport() {
  const [url, setUrl] = useState('');
  const projectId = useStore((s) => s.project!.id);
  const running = useStore((s) => latestJob(s.jobs, 'import')?.status === 'running');
  const s = useStore.getState();
  const go = async () => {
    try {
      const job = await api<Job>(`/api/projects/${projectId}/media/url`, { method: 'POST', body: JSON.stringify({ url: url.trim() }) });
      // the live update may already have reported the end (a quick failure): keep it
      useStore.setState((st) => ({ jobs: { ...st.jobs, [job.id]: st.jobs[job.id] ?? job } }));
      setUrl('');
    } catch (e) {
      s.notify((e as Error).message, 'error');
    }
  };
  return (
    <>
      <div className="inline-form">
        <input type="url" dir="ltr" placeholder="https://..." value={url} data-testid="url-import" onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && url.trim() && void go()} />
        <button className="btn" disabled={running || !url.trim()} onClick={() => void go()}>
          {t('lib.import')}
        </button>
      </div>
      <p className="hint">{t('lib.urlHint')}</p>
    </>
  );
}

interface StockItem {
  id: string;
  provider: string;
  kind: 'image' | 'video' | 'audio';
  title: string;
  duration?: number;
  thumb: string | null;
  credit: MediaCredit;
}
interface StockProviderInfo {
  id: string;
  label: string;
  kinds: ('image' | 'video' | 'audio')[];
  key: boolean;
  hasKey: boolean;
}
const KIND_LABELS = { image: 'lib.kindImages', video: 'lib.kindVideo', audio: 'lib.kindAudio' } as const satisfies Record<string, Key>;
const KEY_HELP: Record<string, Key> = {
  pexels: 'lib.keyHelpPexels',
  pixabay: 'lib.keyHelpPixabay',
};

function StockPanel() {
  const [providers, setProviders] = useState<StockProviderInfo[]>([]);
  const [provider, setProvider] = useState('openverse');
  const [kind, setKind] = useState<'image' | 'video' | 'audio'>('image');
  const [q, setQ] = useState('');
  const [items, setItems] = useState<StockItem[] | null>(null);
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState(false);
  const projectId = useStore((s) => s.project!.id);
  const running = useStore((s) => latestJob(s.jobs, 'import')?.status === 'running');
  const s = useStore.getState();
  const load = () => api<StockProviderInfo[]>('/api/stock/providers').then(setProviders).catch(() => {});
  useEffect(() => {
    void load();
  }, []);
  const cur = providers.find((p) => p.id === provider);
  const search = async (nextPage = 1) => {
    if (!q.trim()) return;
    setBusy(true);
    try {
      const r = await api<{ items: StockItem[]; needsKey?: boolean }>(`/api/stock/search?provider=${provider}&kind=${kind}&q=${encodeURIComponent(q.trim())}&page=${nextPage}`);
      setItems((old) => (nextPage > 1 && old ? [...old, ...r.items] : r.items));
      setPage(nextPage);
    } catch (e) {
      s.notify((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const take = async (it: StockItem) => {
    try {
      const job = await api<Job>(`/api/projects/${projectId}/media/stock`, { method: 'POST', body: JSON.stringify({ id: it.id }) });
      // the live update may already have reported the end (a quick failure): keep it
      useStore.setState((st) => ({ jobs: { ...st.jobs, [job.id]: st.jobs[job.id] ?? job } }));
      s.notify(t('lib.stockDownloading', { title: it.title }));
    } catch (e) {
      s.notify((e as Error).message, 'error');
    }
  };
  return (
    <div className="stock" data-testid="stock-panel">
      <Seg
        label={t('lib.stockSource')}
        value={provider}
        options={providers.map((p) => [p.id, p.label] as [string, string])}
        onChange={(v) => {
          setProvider(v);
          setItems(null);
          const k = providers.find((p) => p.id === v)?.kinds ?? ['image'];
          if (!k.includes(kind)) setKind(k[0]);
        }}
      />
      {cur && cur.kinds.length > 1 && (
        <Seg
          label={t('lib.stockKind')}
          value={kind}
          options={cur.kinds.map((k) => [k, t(KIND_LABELS[k])] as [typeof k, string])}
          onChange={(v) => {
            setKind(v);
            setItems(null);
          }}
        />
      )}
      {cur?.key && !cur.hasKey ? (
        <KeyField provider={provider} help={KEY_HELP[provider] && t(KEY_HELP[provider])} onChange={() => void load()} />
      ) : (
        <>
          <div className="inline-form">
            <input type="search" dir="auto" placeholder={t('lib.stockSearchPlaceholder')} value={q} data-testid="stock-q" onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void search()} />
            <button className="btn" disabled={busy || !q.trim()} onClick={() => void search()}>
              {t('lib.search')}
            </button>
          </div>
          {items && !items.length && <p className="hint">{t('lib.noResults')}</p>}
          {items && items.length > 0 && (
            <>
              <div className="stock-grid" data-testid="stock-results">
                {items.map((it) => (
                  <button key={it.id} className="stock-item" disabled={running} title={`${it.title}\n${creditLine(it.credit)}\n${t('lib.stockItemHint')}`} onClick={() => void take(it)}>
                    <span className={'stock-thumb' + (it.thumb ? '' : ' none')} style={it.thumb ? { backgroundImage: `url(${it.thumb})` } : undefined}>
                      {!it.thumb && <Icon name={it.kind === 'audio' ? 'music' : 'film'} size={20} />}
                      {it.duration ? <span className="dur" dir="ltr">{mmss(it.duration)}</span> : null}
                    </span>
                    <span className="stock-meta ellipsis" dir="auto">
                      {it.credit.author ?? it.title}
                    </span>
                    <span className="stock-license">{it.credit.license}</span>
                  </button>
                ))}
              </div>
              <button className="btn wide" disabled={busy} onClick={() => void search(page + 1)}>
                {t('lib.moreResults')}
              </button>
            </>
          )}
          {cur?.key && cur.hasKey && <KeyField provider={provider} onChange={() => void load()} />}
          <p className="hint">{provider === 'openverse' ? t('lib.stockHintOpenverse') : t('lib.stockHint')}</p>
        </>
      )}
    </div>
  );
}

/** Copies the credits of the stock files used in the video (for the description of the post). */
function CreditsButton() {
  const projectId = useStore((s) => s.project!.id);
  const s = useStore.getState();
  return (
    <button
      className="btn wide"
      data-testid="copy-credits"
      onClick={async () => {
        try {
          const r = await api<{ text: string }>(`/api/projects/${projectId}/credits`);
          if (!r.text) return s.notify(t('lib.noStockInVideo'));
          await navigator.clipboard.writeText(r.text);
          s.notify(t('lib.creditsCopied'));
        } catch (e) {
          s.notify((e as Error).message, 'error');
        }
      }}
    >
      <Icon name="copy" size={14} /> {t('lib.copyCredits')}
    </button>
  );
}


function TextTab() {
  const s = useStore.getState();
  return (
    <div className="tab-body">
      <PanelHead title={t('lib.text')} />
      <p className="hint">{t('lib.textHint')}</p>
      <div className="list" data-testid="text-presets">
        {TEXT_PRESETS.map((p) => (
          <button
            key={p.id}
            className="row-item"
            data-preset={p.id}
            title={tl('textStyle', p.id, p.label)}
            onClick={() => {
              const id = uid('c_');
              s.run({ op: 'add_text', text: tl('textSample', p.id, p.sample), start: useStore.getState().time, duration: 3, preset: p.id, id });
              s.startTextEdit(id);
            }}
          >
            <span
              className={'text-sample' + (p.style.bg ? ' boxed' : '')}
              style={{
                fontWeight: p.style.bold === false ? 400 : 700,
                fontFamily: p.style.font ? `"${p.style.font}"` : undefined,
                background: p.style.bg ?? undefined,
                color: p.style.bg || p.style.color ? (p.style.color ?? '#fff') : undefined,
                fontSize: p.style.size! >= 150 ? 22 : p.style.size! > 100 ? 18 : p.style.size! < 50 ? 13 : 15,
              }}
            >
              {tl('textSample', p.id, p.sample)}
            </span>
            <span className="muted small">{tl('textStyle', p.id, p.label)}</span>
            <span className="row-add" aria-hidden="true">
              <Icon name="plus" size={16} />
            </span>
          </button>
        ))}
      </div>
      <Help>{t('lib.textHelp')}</Help>
      <FontsPanel />
    </div>
  );
}

const GOOGLE_SUGGESTIONS = ['Heebo', 'Rubik', 'Assistant', 'Secular One', 'Frank Ruhl Libre', 'Varela Round', 'Suez One', 'Noto Sans Hebrew'];

/** Fonts: the default for new titles, uploads, Google Fonts, and the list of added families. */
function FontsPanel() {
  const fonts = useFonts();
  const titleFont = useStore((s) => s.project!.titleFont ?? '');
  const s = useStore.getState();
  const [family, setFamily] = useState('');
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const upload = async (files: FileList) => {
    const fd = new FormData();
    for (const f of Array.from(files)) fd.append('files', f);
    setBusy(true);
    try {
      const r = await api<{ added: { family: string }[]; errors: string[]; fonts: FontFamilyInfo[] }>('/api/fonts', { method: 'POST', body: fd });
      setFonts(r.fonts);
      const names = [...new Set(r.added.map((a) => a.family))].join(', ');
      s.notify(r.errors.length ? t('lib.fontsAddedPartly', { names, errors: r.errors.join(' · ') }) : t('lib.fontAdded', { names }), r.errors.length ? 'error' : 'info');
    } catch (e) {
      s.notify((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const fromGoogle = async () => {
    if (!family.trim()) return;
    setBusy(true);
    try {
      const r = await api<{ family: string; faces: number; fonts: FontFamilyInfo[] }>('/api/fonts/google', { method: 'POST', body: JSON.stringify({ family: family.trim() }) });
      setFonts(r.fonts);
      setFamily('');
      s.notify(t('lib.fontFromGoogle', { family: r.family }));
    } catch (e) {
      s.notify((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const remove = async (f: string) => {
    if (!window.confirm(t('lib.fontDeleteAsk', { name: f }))) return;
    try {
      const r = await api<{ fonts: FontFamilyInfo[] }>(`/api/fonts/${encodeURIComponent(f)}`, { method: 'DELETE' });
      setFonts(r.fonts);
    } catch (e) {
      s.notify((e as Error).message, 'error');
    }
  };
  return (
    <Section id="fonts" title={t('lib.fonts')} defaultOpen={false}>
      <label className="field">
        <span className="field-label">{t('lib.titleFont')}</span>
        <select data-testid="title-font" value={titleFont} onChange={(e) => s.run({ op: 'set_title_font', font: e.target.value || null })}>
          <option value="">{t('lib.defaultFont')}</option>
          <FontOptions custom={fonts.map((f) => f.family)} current={titleFont || undefined} />
        </select>
      </label>
      {fonts.length > 0 && (
        <div className="font-list" data-testid="font-list">
          {fonts.map((f) => (
            <div key={f.family} className="font-row" data-family={f.family}>
              <span className="font-sample" style={{ fontFamily: `"${f.family}", Arial` }} dir="auto">
                {f.family} · {t('lib.fontSample')}
              </span>
              <span className="muted small">{f.source === 'google' ? 'Google' : t('lib.fontUploaded')}</span>
              <button className="icon-btn sm" title={t('lib.deleteFont', { name: f.family })} onClick={() => void remove(f.family)}>
                <Icon name="trash" size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
      <button className="btn wide" disabled={busy} data-testid="font-upload" onClick={() => input.current?.click()}>
        <Icon name="upload" size={16} /> {t('lib.uploadFont')}
      </button>
      <input
        ref={input}
        type="file"
        hidden
        multiple
        accept=".ttf,.otf,.woff,.woff2"
        data-testid="font-file"
        onChange={(e) => {
          if (e.target.files?.length) void upload(e.target.files);
          e.target.value = '';
        }}
      />
      <div className="inline-form">
        <input type="text" dir="ltr" placeholder={t('lib.googleFontPlaceholder')} value={family} list="google-font-names" data-testid="google-font" onChange={(e) => setFamily(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void fromGoogle()} />
        <button className="btn" disabled={busy || !family.trim()} onClick={() => void fromGoogle()}>
          {t('lib.download')}
        </button>
      </div>
      <datalist id="google-font-names">
        {GOOGLE_SUGGESTIONS.map((f) => (
          <option key={f} value={f} />
        ))}
      </datalist>
      <p className="hint">{t('lib.fontsHint')}</p>
    </Section>
  );
}

/**
 * The clip a library action applies to: the selected clip when it fits; otherwise the top-most
 * fitting clip under the playhead; otherwise the fitting clip closest to the playhead.
 */
function pickTarget(kinds: Clip['kind'][]): { clip: Clip; how: 'selected' | 'playhead' | 'nearest' } | undefined {
  const s = useStore.getState();
  const p = s.project;
  if (!p) return undefined;
  const sel = p.clips.find((c) => c.id === s.selected);
  if (sel && kinds.includes(sel.kind)) return { clip: sel, how: 'selected' };
  const order = (c: Clip) => p.tracks.findIndex((t) => t.id === c.trackId);
  const visible = p.clips.filter((c) => kinds.includes(c.kind) && !p.tracks.find((t) => t.id === c.trackId)?.hidden);
  const t = s.time;
  const under = visible.filter((c) => t >= c.start - 0.001 && t < c.start + c.duration).sort((a, b) => order(a) - order(b));
  if (under.length) return { clip: under[0], how: 'playhead' };
  const dist = (c: Clip) => (t < c.start ? c.start - t : Math.max(0, t - (c.start + c.duration)));
  const nearest = [...visible].sort((a, b) => dist(a) - dist(b) || order(a) - order(b))[0];
  return nearest ? { clip: nearest, how: 'nearest' } : undefined;
}

function useTargetClip(kinds: Clip['kind'][]) {
  // re-evaluate when the selection, the clips or the playhead position change
  useStore((s) => s.selected);
  useStore((s) => s.project?.clips);
  useStore((s) => s.project?.tracks);
  useStore((s) => Math.round(s.time * 10));
  return pickTarget(kinds);
}

/** Shows which clip the choices below will change. */
function TargetCard({ target, empty }: { target: ReturnType<typeof pickTarget>; empty: string }) {
  const media = useStore((s) => s.project!.media);
  if (!target)
    return (
      <div className="target-card empty">
        <Icon name="info" size={16} />
        <span>{empty}</span>
      </div>
    );
  const c = target.clip;
  const m = media.find((x) => x.id === c.mediaId);
  const name = c.text?.replace(/\n/g, ' · ') ?? m?.name ?? '';
  return (
    <div className={`target-card k-${c.kind}`}>
      {m?.thumb ? <span className="target-thumb" style={{ backgroundImage: `url(/media/${m.thumb})` }} /> : <span className="target-thumb icon"><Icon name="text" size={16} /></span>}
      <span className="target-text">
        <span className="muted small">{target.how === 'selected' ? t('lib.appliesSelected') : t('lib.appliesPlayhead')}</span>
        <b className="ellipsis" dir="auto">{name}</b>
      </span>
    </div>
  );
}

/** Applies an op to the target clip and selects it, so the change is visible in the timeline and the panel. */
function applyToTarget(kinds: Clip['kind'][], empty: string, make: (c: Clip) => Op, show?: { side: 'in' | 'out'; message: string }) {
  const s = useStore.getState();
  const t = pickTarget(kinds);
  if (!t) return s.notify(empty);
  s.run(make(t.clip));
  s.select(t.clip.id);
  if (show) s.showEffect(t.clip.id, show.side, show.message);
}

const VISUAL: Clip['kind'][] = ['video', 'image'];
const ANIMATABLE: Clip['kind'][] = ['video', 'image', 'text', 'caption'];
const NO_VISUAL = () => t('lib.noVisual');
const NO_ANIMATABLE = () => t('lib.noAnimatable');

const TRANSITION_ICON: Record<TransitionType, string> = {
  fade: '◐', dip: '●', 'dip-white': '○', flash: '✦', blur: '◌', zoom: '⤢', 'zoom-out': '⤡', spin: '↻',
  'slide-left': '⇠', 'slide-right': '⇢', 'slide-up': '⇡', 'slide-down': '⇣',
  'wipe-left': '◧', 'wipe-right': '◨', 'wipe-up': '⬒', 'wipe-down': '⬓',
};

function TransitionsTab() {
  const tgt = useTargetClip(VISUAL);
  const target = tgt?.clip;
  const [duration, setDuration] = useState(0.5);
  const apply = (type: TransitionType | 'none') =>
    applyToTarget(VISUAL, NO_VISUAL(), (c) => ({ op: 'add_transition', clipId: c.id, type, duration }), type === 'none' ? undefined : { side: 'in', message: t('lib.transitionAdded', { name: tl('tr', type, TRANSITION_LABELS[type]) }) });
  return (
    <div className="tab-body">
      <PanelHead title={t('lib.transitions')} />
      <TargetCard target={tgt} empty={NO_VISUAL()} />
      <div className={'list' + (tgt ? '' : ' disabled')}>
        {(Object.keys(TRANSITION_LABELS) as TransitionType[]).map((tt) => (
          <button key={tt} className={'row-item' + (target?.transition?.type === tt ? ' active' : '')} onClick={() => apply(tt)}>
            <span className="row-icon" aria-hidden="true">{TRANSITION_ICON[tt]}</span>
            <span className="row-label">{tl('tr', tt, TRANSITION_LABELS[tt])}</span>
            <span className="row-add" aria-hidden="true">
              <Icon name={target?.transition?.type === tt ? 'check' : 'plus'} size={16} />
            </span>
          </button>
        ))}
      </div>
      <Slider label={t('lib.transitionDuration')} value={duration} min={0.2} max={2} step={0.1} fmt={(v) => t('lib.seconds', { v: v.toFixed(1) })} onChange={setDuration} />
      {target?.transition && (
        <button className="btn ghost wide" onClick={() => apply('none')}>
          {t('lib.removeTransition')}
        </button>
      )}
      <Help>{t('lib.transitionsHelp')}</Help>
    </div>
  );
}

function LookSwatch({ look, thumb }: { look: Look | null; thumb?: string }) {
  const c = colorFx(look?.fx);
  const m = c.matrix;
  const id = `sw-${look?.id ?? 'none'}`;
  return (
    <>
      <svg className="fx-defs" aria-hidden="true">
        <filter id={id} colorInterpolationFilters="sRGB">
          <feColorMatrix type="matrix" values={`${m[0]} ${m[1]} ${m[2]} 0 0 ${m[3]} ${m[4]} ${m[5]} 0 0 ${m[6]} ${m[7]} ${m[8]} 0 0 0 0 0 1 0`} />
          <feComponentTransfer>
            <feFuncR type="linear" slope={c.contrast} intercept={0.5 - 0.5 * c.contrast} />
            <feFuncG type="linear" slope={c.contrast} intercept={0.5 - 0.5 * c.contrast} />
            <feFuncB type="linear" slope={c.contrast} intercept={0.5 - 0.5 * c.contrast} />
          </feComponentTransfer>
        </filter>
      </svg>
      <span className="look-swatch" style={{ filter: `url(#${id})`, ...(thumb ? { backgroundImage: `url(/media/${thumb})` } : {}) }} />
    </>
  );
}

function FiltersTab() {
  const tgt = useTargetClip(VISUAL);
  const target = tgt?.clip;
  const project = useStore((s) => s.project)!;
  const thumb = project.media.find((m) => m.id === target?.mediaId)?.thumb;
  const parts = target ? siblingsOf(project, target).length : 0;
  const lookFx = (look: Look | null) => ({ brightness: 1, contrast: 1, saturation: 1, temperature: 0, sepia: 0, ...look?.fx, look: look?.id ?? '' });
  const apply = (look: Look | null) => applyToTarget(VISUAL, NO_VISUAL(), (c) => ({ op: 'set_fx', clipId: c.id, fx: lookFx(look) }));
  const cur = target?.fx?.look ?? '';
  return (
    <div className="tab-body">
      <PanelHead title={t('lib.filters')} />
      <TargetCard target={tgt} empty={NO_VISUAL()} />
      <div className={'look-grid' + (tgt ? '' : ' disabled')}>
        <button className={'look' + (target && !cur ? ' active' : '')} onClick={() => apply(null)}>
          <LookSwatch look={null} thumb={thumb} />
          <span>{t('lib.original')}</span>
        </button>
        {LOOKS.map((l) => (
          <button key={l.id} className={'look' + (cur === l.id ? ' active' : '')} title={t('lib.lookTitle', { name: tl('look', l.id, l.label) })} onClick={() => apply(l)}>
            <LookSwatch look={l} thumb={thumb} />
            <span>{tl('look', l.id, l.label)}</span>
          </button>
        ))}
      </div>
      {target && parts > 1 && (
        <button className="btn wide" onClick={() => applyFxToAll(target, lookFx(LOOKS.find((l) => l.id === cur) ?? null))}>
          {t('lib.applyAllParts', { n: parts })}
        </button>
      )}
      <Help>{t('lib.filtersHelp')}</Help>
    </div>
  );
}

function AnimTab() {
  const tgt = useTargetClip(ANIMATABLE);
  const target = tgt?.clip;
  const [duration, setDuration] = useState(0.5);
  const apply = (side: 'in' | 'out', type: AnimType | 'none') =>
    applyToTarget(ANIMATABLE, NO_ANIMATABLE(), (c) => ({ op: 'set_animation', clipId: c.id, [side]: { type, duration } }), type === 'none' ? undefined : { side, message: t(side === 'in' ? 'lib.animInAdded' : 'lib.animOutAdded', { name: tl('anim', type, ANIM_LABELS[type]) }) });
  const section = (side: 'in' | 'out', title: string, current?: AnimType) => (
    <>
      <h4 className="group-title">{title}</h4>
      <div className={'chip-grid' + (tgt ? '' : ' disabled')}>
        {(Object.keys(ANIM_LABELS) as AnimType[]).filter((a) => a !== 'typewriter' || (side === 'in' && (target?.kind === 'text' || target?.kind === 'caption'))).map((a) => (
          <button key={a} className={'chip-btn' + (current === a ? ' active' : '')} onClick={() => apply(side, current === a ? 'none' : a)}>
            {current === a && <Icon name="check" size={14} />}
            {tl('anim', a, ANIM_LABELS[a])}
          </button>
        ))}
      </div>
    </>
  );
  return (
    <div className="tab-body">
      <PanelHead title={t('lib.animation')} />
      <TargetCard target={tgt} empty={NO_ANIMATABLE()} />
      {section('in', t('lib.animIn'), target?.animIn?.type)}
      {section('out', t('lib.animOut'), target?.animOut?.type)}
      <Slider label={t('lib.duration')} value={duration} min={0.2} max={2} step={0.1} fmt={(v) => t('lib.seconds', { v: v.toFixed(1) })} onChange={setDuration} />
      <Help>{t('lib.animHelp')}</Help>
    </div>
  );
}

interface Sfx {
  id: string;
  group?: string;
  name: string;
  duration: number;
  url: string;
}

function Recorder() {
  const [state, setState] = useState<'idle' | 'recording' | 'saving'>('idle');
  const [seconds, setSeconds] = useState(0);
  const rec = useRef<{ recorder: MediaRecorder; stream: MediaStream; startAt: number; timer: number } | null>(null);
  useEffect(
    () => () => {
      if (rec.current) {
        clearInterval(rec.current.timer);
        rec.current.stream.getTracks().forEach((t) => t.stop());
      }
    },
    [],
  );
  const start = async () => {
    const s = useStore.getState();
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') return s.notify(t('lib.recNoSupport'), 'error');
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      return s.notify(t('lib.recNoMic'), 'error');
    }
    const chunks: Blob[] = [];
    const recorder = new MediaRecorder(stream);
    const startAt = s.time;
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    recorder.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      setState('saving');
      const d = new Date();
      const name = t('lib.recFileName', { h: String(d.getHours()).padStart(2, '0'), m: String(d.getMinutes()).padStart(2, '0') });
      const [asset] = await useStore.getState().upload([new File(chunks, name, { type: recorder.mimeType || 'audio/webm' })]);
      if (asset) {
        for (let i = 0; i < 60 && !useStore.getState().project?.media.some((m) => m.id === asset.id); i++) await new Promise((r) => setTimeout(r, 50));
        const id = uid('c_');
        useStore.getState().run({ op: 'add_clip', mediaId: asset.id, start: startAt, id });
        useStore.getState().select(id);
      }
      setState('idle');
    };
    recorder.start();
    setSeconds(0);
    const timer = window.setInterval(() => setSeconds((v) => v + 1), 1000);
    rec.current = { recorder, stream, startAt, timer };
    setState('recording');
  };
  const stop = () => {
    if (!rec.current) return;
    clearInterval(rec.current.timer);
    rec.current.recorder.stop();
    rec.current = null;
  };
  return state === 'recording' ? (
    <button className="btn wide recording" onClick={stop}>
      <span className="rec-dot" /> {t('lib.recStop', { time: mmss(seconds) })}
    </button>
  ) : (
    <button className="btn wide" disabled={state === 'saving'} onClick={() => void start()}>
      <Icon name="mic" /> {state === 'saving' ? t('lib.recSaving') : t('lib.recStart')}
    </button>
  );
}

const SFX_GROUP_NAMES: [string, Key][] = [
  ['motion', 'sfxGroup.motion'],
  ['impact', 'sfxGroup.impact'],
  ['ui', 'sfxGroup.ui'],
  ['tones', 'sfxGroup.tones'],
];

function MusicTab() {
  // select stable references, filter outside (zustand re-renders forever on a new array per call)
  const allMedia = useStore((s) => s.project!.media);
  const clips = useStore((s) => s.project!.clips);
  const audio = allMedia.filter((m) => m.kind === 'audio' && !m.libraryId);
  const musicClips = clips.filter((c) => c.music || (c.kind === 'audio' && allMedia.some((m) => m.id === c.mediaId && !m.libraryId)));
  const projectId = useStore((s) => s.project!.id);
  const [sfx, setSfx] = useState<Sfx[] | null>(null);
  const [busy, setBusy] = useState('');
  const player = useRef<HTMLAudioElement | null>(null);
  const picker = useFilePicker('audio/*');
  const s = useStore.getState();
  useEffect(() => {
    fetch('/api/library/sfx')
      .then((r) => r.json())
      .then((list) => Array.isArray(list) && setSfx(list))
      .catch(() => setSfx([]));
    return () => player.current?.pause();
  }, []);
  const play = (url: string) => {
    player.current?.pause();
    player.current = new Audio(url);
    void player.current.play().catch(() => {});
  };
  const addSfx = async (fx: Sfx) => {
    setBusy(fx.id);
    try {
      const res = await fetch(`/api/projects/${projectId}/media/library`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: fx.id }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      for (let i = 0; i < 40 && !useStore.getState().project!.media.some((m) => m.id === data.media.id); i++) await new Promise((r) => setTimeout(r, 50));
      const id = uid('c_');
      useStore.getState().run({ op: 'add_clip', mediaId: data.media.id, start: useStore.getState().time, id });
      useStore.getState().select(id);
      useStore.getState().notify(t('lib.sfxAdded', { name: tl('sfx', fx.id, fx.name) }));
    } catch (e) {
      s.notify((e as Error).message, 'error');
    } finally {
      setBusy('');
    }
  };
  const volume = musicClips.length ? musicClips[0].volume : 0.4;
  return (
    <div className="tab-body">
      <PanelHead title={t('lib.sound')} />
      <h4 className="group-title">{t('lib.backgroundMusic')}</h4>
      <div className="list">
        {audio.map((m) => {
          const inVideo = musicClips.some((c) => c.mediaId === m.id);
          return (
            <button key={m.id} className={'row-item' + (inVideo ? ' active' : '')} onClick={() => addMediaToTimeline(m)}>
              <span className="row-icon" aria-hidden="true">
                <Icon name="music" size={16} />
              </span>
              <span className="row-label ellipsis" dir="auto">{m.name}</span>
              <span className="muted small" dir="ltr">{mmss(m.duration)}</span>
              <span className="row-add" aria-hidden="true">
                <Icon name={inVideo ? 'check' : 'plus'} size={16} />
              </span>
            </button>
          );
        })}
      </div>
      <button className="btn wide" onClick={picker.open}>
        <Icon name="upload" size={16} /> {t('lib.uploadMusic')}
      </button>
      {picker.el}
      {musicClips.length > 0 ? (
        <Slider
          label={t('lib.musicVolume')}
          value={volume}
          def={0.4}
          min={0}
          max={1}
          step={0.05}
          fmt={(v) => `${Math.round(v * 100)}%`}
          onChange={(v) => s.run(musicClips.map((c) => ({ op: 'update_clip', clipId: c.id, patch: { volume: v } }) as Op), 'music-volume')}
        />
      ) : (
        <p className="hint">{t('lib.musicHint')}</p>
      )}
      <h4 className="group-title">{t('lib.soundEffects')}</h4>
      <div className="sfx-list" data-testid="sfx-list">
        {SFX_GROUP_NAMES.map(([g, label]) => [g, label, (sfx ?? []).filter((fx) => (fx.group ?? 'ui') === g)] as const)
          .filter(([, , list]) => list.length > 0)
          .map(([g, label, list]) => (
            <div key={g} className="sfx-group" data-group={g}>
              <h5 className="sfx-group-title">{t(label)}</h5>
              {list.map((fx) => (
                <div key={fx.id} className="sfx-row" data-sfx={fx.id}>
                  <button className="icon-btn sm" title={t('lib.playSfx', { name: tl('sfx', fx.id, fx.name) })} onClick={() => play(fx.url)}>
                    <Icon name="play" size={14} />
                  </button>
                  <button className="sfx-name" disabled={busy === fx.id} title={t('lib.addAtPlayhead')} onClick={() => void addSfx(fx)}>
                    <span>{tl('sfx', fx.id, fx.name)}</span>
                    <span className="row-add" aria-hidden="true">
                      <Icon name="plus" size={16} />
                    </span>
                  </button>
                </div>
              ))}
            </div>
          ))}
      </div>
      {sfx === null && <p className="hint">{t('lib.loadingSfx')}</p>}
      <h4 className="group-title">{t('lib.voiceOver')}</h4>
      <Recorder />
      <Section id="narration-ai" title={t('lib.narrationAi')} defaultOpen={false}>
        <Narration />
      </Section>
    </div>
  );
}

const LENGTHS = (): [number, string][] => [
  [3, t('lib.lenShort')],
  [5, t('lib.lenMedium')],
  [8, t('lib.lenLong')],
];

/** Live status of the transcription: stage, what has been done, time spent, time left, and a cancel button. */
function JobStatus({ job }: { job: Job }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const elapsed = job.startedAt ? Math.max(job.elapsed ?? 0, (now - job.startedAt) / 1000) : job.elapsed ?? 0;
  const steps = ['audio', job.stage === 'download' ? 'download' : 'load', 'transcribe'];
  const stepIndex = Math.max(0, steps.indexOf(job.stage ?? 'audio'));
  const label = [t('lib.stepPrepare'), job.stage === 'download' ? t('lib.stepDownloadModel') : t('lib.stepLoad'), t('lib.stepTranscribe')];
  const pct = Math.round(job.progress * 100);
  const shownPct = job.stage === 'download' && job.dlTotal ? Math.round(((job.dl ?? 0) / job.dlTotal) * 100) : pct;
  return (
    <div className="job-status" role="status">
      <ol className="job-steps">
        {label.map((l, i) => (
          <li key={l} className={i < stepIndex ? 'done' : i === stepIndex ? 'now' : ''}>
            {i < stepIndex && <Icon name="check" size={12} />}
            {l}
          </li>
        ))}
      </ol>
      <div className="progress-row">
        <span>
          {job.stage === 'download' ? (
            <>
              {t('lib.modelDownloading')} <bdi dir="ltr">{Math.round((job.dl ?? 0) / 1e6)}{job.dlTotal ? ` / ${Math.round(job.dlTotal / 1e6)}` : ''} MB</bdi>
            </>
          ) : job.stage === 'transcribe' && job.total ? (
            <>
              {t('lib.transcribed')} <bdi dir="ltr">{mmss(job.pos ?? 0)}</bdi> {t('lib.of')} <bdi dir="ltr">{mmss(job.total)}</bdi>
            </>
          ) : (
            job.message
          )}
        </span>
        <bdi dir="ltr">{shownPct}%</bdi>
      </div>
      <div className="bar">
        <div style={{ width: `${Math.max(2, shownPct)}%` }} />
      </div>
      <div className="progress-row muted small">
        <span>
          {t('lib.elapsed')} <bdi dir="ltr">{mmss(elapsed)}</bdi>
          {job.eta != null ? (
            <>
              {' '}· {t('lib.etaLeft')} <bdi dir="ltr">{mmss(job.eta)}</bdi>
            </>
          ) : job.stage === 'transcribe' ? (
            t('lib.etaCalculating')
          ) : job.stage === 'load' ? (
            t('lib.firstLoadSlow')
          ) : null}
        </span>
        <button className="link-btn" onClick={() => void fetch(`/api/jobs/${job.id}/cancel`, { method: 'POST' })}>
          {t('lib.cancel')}
        </button>
      </div>
    </div>
  );
}

function CaptionRow({ clip }: { clip: Clip }) {
  const [text, setText] = useState(clip.text ?? '');
  const [seen, setSeen] = useState(clip.text);
  const active = useStore((s) => s.time >= clip.start && s.time < clip.start + clip.duration);
  if (seen !== clip.text) {
    setSeen(clip.text);
    setText(clip.text ?? '');
  }
  const s = useStore.getState();
  // saved while typing (one undo step per row), so nothing is lost if focus never leaves the field
  const change = (v: string) => {
    setText(v);
    if (v.trim() && v !== clip.text) {
      setSeen(v);
      s.run({ op: 'update_clip', clipId: clip.id, patch: { text: v } }, `caprow-${clip.id}`);
    }
  };
  return (
    <div className={'caption-row' + (active ? ' active' : '')}>
      <button className="time" title={t('lib.seekCaption')} onClick={() => (s.seek(clip.start + 0.01), s.select(clip.id))}>
        <bdi dir="ltr">{fmtTime(clip.start)}</bdi>
      </button>
      <textarea
        dir="auto"
        rows={1}
        spellCheck={false}
        aria-label={t('lib.captionTextLabel')}
        value={text}
        onFocus={() => s.seek(clip.start + 0.01)}
        onChange={(e) => change(e.target.value.replace(/\n/g, ' '))}
        onBlur={() => !text.trim() && setText(clip.text ?? '')}
        onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), (e.target as HTMLTextAreaElement).blur())}
      />
      <button className="tiny-btn" title={t('lib.deleteCaption')} onClick={() => s.run({ op: 'delete', clipId: clip.id })}>
        <Icon name="close" size={13} />
      </button>
    </div>
  );
}

function CaptionsTab() {
  const project = useStore((s) => s.project)!;
  const job = useStore((s) => latestJob(s.jobs, 'captions'));
  const [language, setLanguage] = useState('he');
  const [maxWords, setMaxWords] = useState(5);
  const [translateTo, setTranslateTo] = useState('');
  const srtInput = useRef<HTMLInputElement>(null);
  const s = useStore.getState();
  const captions = project.clips.filter((c) => c.kind === 'caption').sort((a, b) => a.start - b.start);
  const running = job?.status === 'running';
  const style = project.captionStyle;
  const hasSound = project.clips.some((c) => (c.kind === 'video' || c.kind === 'audio') && c.volume > 0);
  const importSrt = async (file: File) => {
    const caps = parseSrt(await file.text());
    if (!caps.length) return s.notify(t('lib.noCaptionsInFile'), 'error');
    s.run({ op: 'set_captions', captions: caps });
    s.notify(t(caps.length === 1 ? 'lib.importedCaptionsOne' : 'lib.importedCaptionsMany', { n: caps.length }));
  };
  const presetOn = (p: (typeof CAPTION_PRESETS)[number]) => p.style.color === style.color && (p.style.bg ?? null) === (style.bg ?? null) && (p.style.highlight ?? null) === (style.highlight ?? null) && (p.style.bold ?? true) === style.bold && (p.style.font ?? style.font) === style.font;
  return (
    <div className="tab-body">
      <PanelHead title={t('lib.captions')} />
      {!running && (
        <div className="caption-start">
          <div className="field-grid">
            <label className="field">
              <span className="field-label">{t('lib.spokenLanguage')}</span>
              <select value={language} onChange={(e) => setLanguage(e.target.value)}>
                <option value="he">{t('lib.langHe')}</option>
                <option value="en">{t('lib.langEn')}</option>
                <option value="ar">{t('lib.langAr')}</option>
                <option value="ru">{t('lib.langRu')}</option>
                <option value="auto">{t('lib.langAuto')}</option>
              </select>
            </label>
            <div className="field">
              <span className="field-label">{t('lib.captionLength')}</span>
              <Seg value={maxWords} options={LENGTHS()} onChange={setMaxWords} label={t('lib.captionLengthShort')} />
            </div>
          </div>
          <CaptionEngine translateTo={translateTo} setTranslateTo={setTranslateTo} />
          <button className="btn primary wide lg" disabled={!hasSound} title={hasSound ? '' : t('lib.noSpeech')} onClick={() => void s.startCaptions(language, maxWords, translateTo ? { translateTo } : {})} data-testid="captions-start">
            <Icon name="captions" /> {captions.length ? t('lib.recreateCaptions') : t('lib.createCaptions')}
          </button>
          {!hasSound && <p className="hint">{t('lib.addSpeechFirst')}</p>}
        </div>
      )}
      {running && <JobStatus job={job} />}
      {job?.status === 'error' && !job.cancelled && (
        <p className="error" dir="auto">
          {job.error}
        </p>
      )}
      {captions.length > 0 && (
        <>
          <h4 className="group-title">
            {t('lib.captionText')} <span className="muted small">({captions.length})</span>
          </h4>
          <p className="hint">{t('lib.captionListHint')}</p>
          <div className="caption-list">
            {captions.map((c) => (
              <CaptionRow key={c.id} clip={c} />
            ))}
          </div>
          <button
            className="btn wide"
            onClick={() => {
              if (window.confirm(t(captions.length === 1 ? 'lib.deleteAllCaptionsAskOne' : 'lib.deleteAllCaptionsAskMany', { n: captions.length }))) {
                s.run({ op: 'set_captions', captions: [] });
                s.notify(t('lib.captionsDeleted'), 'info', { label: t('lib.undo'), run: () => s.undo() });
              }
            }}
          >
            <Icon name="trash" size={14} /> {t('lib.deleteAllCaptions')}
          </button>
          <Section id="caption-translate" title={t('lib.translateCaptions')} defaultOpen={false}>
            <TranslateSection />
          </Section>
          <h4 className="group-title">{t('lib.style')}</h4>
          <div className="preset-grid">
            {CAPTION_PRESETS.map((p) => (
              <button key={p.id} className={'preset' + (presetOn(p) ? ' active' : '')} data-preset={p.id} title={tl('capStyle', p.id, p.label)} onClick={() => s.run({ op: 'set_caption_style', preset: p.id })}>
                <span style={{ color: p.style.color, fontWeight: p.style.bold === false ? 400 : 700, background: p.style.bg ?? undefined, ...(p.style.bg ? {} : { WebkitTextStroke: `3px ${p.style.outline ?? '#000'}`, paintOrder: 'stroke fill' }) }}>
                  {p.style.highlight ? (
                    <>
                      {t('lib.capSampleA')}<span style={{ color: p.style.highlight, padding: 0 }}>{t('lib.capSampleB')}</span>
                    </>
                  ) : (
                    t('lib.captions')
                  )}
                </span>
                <small>{tl('capStyle', p.id, p.label)}</small>
              </button>
            ))}
          </div>
          <label className="check-row">
            <input type="checkbox" checked={!!style.highlight} onChange={(e) => s.run({ op: 'set_caption_style', style: { highlight: e.target.checked ? '#ffe500' : null } })} />
            <span>{t('lib.highlightWord')}</span>
          </label>
          <Section id="caption-style-adv" title={t('lib.advancedStyle')} defaultOpen={false}>
            <TextStyleFields style={style} tag="caption-style" onChange={(st, t) => s.run({ op: 'set_caption_style', style: st }, t ?? 'caption-style-' + Object.keys(st).join())} />
            <Slider label={t('lib.heightOnScreen')} value={style.y} min={0.05} max={0.95} step={0.01} fmt={(v) => `${Math.round(v * 100)}%`} onChange={(v) => s.run({ op: 'set_caption_style', style: { y: v } }, 'caption-y')} />
            <label className="field">
              <span className="field-label">{t('lib.captionAnim')}</span>
              <select value={project.captionAnim?.type ?? 'none'} onChange={(e) => s.run({ op: 'set_caption_animation', type: e.target.value as AnimType | 'none', duration: e.target.value === 'typewriter' ? 0.6 : 0.25 })}>
                <option value="none">{t('lib.none')}</option>
                {(Object.keys(ANIM_LABELS) as AnimType[]).map((a) => (
                  <option key={a} value={a}>
                    {tl('anim', a, ANIM_LABELS[a])}
                  </option>
                ))}
              </select>
            </label>
          </Section>
        </>
      )}
      <Section id="caption-file" title={t('lib.captionFile')} defaultOpen={false}>
        <div className="btn-row">
          <a className={'btn' + (captions.length ? '' : ' disabled')} href={captions.length ? `/api/projects/${project.id}/captions.srt` : undefined} aria-disabled={!captions.length} download>
            {t('lib.saveAsFile')}
          </a>
          <button className="btn" onClick={() => srtInput.current?.click()}>
            {t('lib.loadFromFile')}
          </button>
          <input
            ref={srtInput}
            type="file"
            hidden
            accept=".srt,text/plain"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void importSrt(f);
              e.target.value = '';
            }}
          />
        </div>
      </Section>
    </div>
  );
}

export function Library() {
  const [tab, setTab] = useState<Tab>('media');
  useEffect(() => {
    const go = (e: Event) => setTab((e as CustomEvent<Tab>).detail);
    window.addEventListener('alon:tab', go);
    return () => window.removeEventListener('alon:tab', go);
  }, []);
  return (
    <aside className="library" data-testid="library">
      <nav className="tabs" aria-label={t('lib.library')} data-testid="library-tabs">
        {TABS.map((tb) => (
          <button key={tb.id} data-testid={'tab-' + tb.id} className={tab === tb.id ? 'on' : ''} aria-current={tab === tb.id ? 'page' : undefined} onClick={() => setTab(tb.id)}>
            <span className="tab-icon"><Icon name={tb.icon} size={19} /></span>
            <span className="tab-label">{t(tb.label)}</span>
          </button>
        ))}
      </nav>
      <div className="library-panel">
        {tab === 'media' && <MediaTab />}
        {tab === 'text' && <TextTab />}
        {tab === 'captions' && <CaptionsTab />}
        {tab === 'music' && <MusicTab />}
        {tab === 'filters' && <FiltersTab />}
        {tab === 'transitions' && <TransitionsTab />}
        {tab === 'anim' && <AnimTab />}
        {tab === 'ai' && <AgentTab />}
      </div>
    </aside>
  );
}

/** Opens a library tab from anywhere (e.g. the "+ טקסט" button on the preview toolbar). */
export const openTab = (tab: Tab) => window.dispatchEvent(new CustomEvent('alon:tab', { detail: tab }));
