import { useEffect, useRef, useState } from 'react';
import { projectDuration } from '../../shared/ops';
import { EXPORT_PRESETS, presetOf, shapeDiffers, type Reframe } from '../../shared/layout';
import { api, fmtTime, latestJob, useStore } from '../store';
import { getLang, setLang, t, tl, type Key } from '../i18n';
import { Icon } from './Icon';

/** Closes a popover when clicking outside it or pressing Escape. */
function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && close();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, close]);
  return ref;
}

function ProjectMenu() {
  const project = useStore((s) => s.project)!;
  const projects = useStore((s) => s.projects);
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(project.name);
  const ref = useDismiss(open, () => setOpen(false));
  const s = useStore.getState();
  useEffect(() => setName(project.name), [project.name, project.id]);
  // templates for "new video from a template", read when the menu opens
  const [templates, setTemplates] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    if (open) api<{ id: string; name: string }[]>('/api/templates').then(setTemplates).catch(() => setTemplates([]));
  }, [open]);
  const commit = () => {
    setRenaming(false);
    if (name.trim() && name.trim() !== project.name) s.run({ op: 'set_settings', name: name.trim() });
    else setName(project.name);
  };
  if (renaming)
    return (
      <input
        className="project-rename"
        dir="auto"
        autoFocus
        aria-label={t('top.videoName')}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={commit}
        onFocus={(e) => e.target.select()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') {
            setName(project.name);
            setRenaming(false);
          }
        }}
      />
    );
  return (
    <div className="menu-wrap" ref={ref}>
      <button className="project-btn" data-testid="project-menu" aria-haspopup="menu" aria-expanded={open} title={t('top.projectMenuTitle')} onClick={() => setOpen(!open)} onDoubleClick={() => setRenaming(true)}>
        <span className="ellipsis" dir="auto">{project.name}</span>
        <Icon name="chevron" size={16} />
      </button>
      {open && (
        <div className="menu" role="menu">
          <button role="menuitem" onClick={() => (setOpen(false), void s.createProject())}>
            <Icon name="plus" size={16} /> {t('top.newVideo')}
          </button>
          <button role="menuitem" onClick={() => (setOpen(false), setRenaming(true))}>
            <Icon name="text" size={16} /> {t('top.rename')}
          </button>
          {templates.length > 0 && <div className="menu-label">{t('top.newFromTemplate')}</div>}
          {templates.map((tp) => (
            <button key={tp.id} role="menuitem" dir="auto" onClick={() => (setOpen(false), void s.createProject(tp.id, tp.name))}>
              <Icon name="plus" size={16} /> <span className="ellipsis">{tp.name}</span>
            </button>
          ))}
          {projects.length > 1 && <div className="menu-label">{t('top.myVideos')}</div>}
          <div className="menu-list">
            {projects
              .filter((p) => p.id !== project.id)
              .map((p) => (
                <button key={p.id} role="menuitem" dir="auto" onClick={() => (setOpen(false), void s.openProject(p.id))}>
                  <span className="ellipsis">{p.name}</span>
                </button>
              ))}
          </div>
          <div className="menu-sep" />
          <button
            role="menuitem"
            className="danger"
            onClick={() => {
              setOpen(false);
              const note = t('top.deleteNote');
              if (window.confirm(t('top.deleteConfirm', { name: project.name, note }))) void s.deleteProject();
            }}
          >
            <Icon name="trash" size={16} /> {t('top.deleteVideo')}
          </button>
        </div>
      )}
    </div>
  );
}

// [key, what it does]; read at render time so a language switch shows the other language
const shortcuts = (): [string, string][] => [
  [t('top.keySpace'), t('top.scPlayPause')],
  ['S', t('top.scSplit')],
  ['Delete', t('top.scDelete')],
  ['Shift+Delete', t('top.scDeleteGap')],
  ['I / O', t('top.scInOut')],
  ['X', t('top.scCutRange')],
  ['Ctrl+Z / Ctrl+Y', t('top.scUndoRedo')],
  ['Ctrl+D', t('top.scDuplicate')],
  ['← / →', t('top.scFrame')],
  [t('top.keyCtrlWheel'), t('top.scZoom')],
];

function HelpMenu() {
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));
  return (
    <div className="menu-wrap" ref={ref}>
      <button className="icon-btn" aria-label={t('top.help')} title={t('top.helpTitle')} aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name="help" />
      </button>
      {open && (
        <div className="menu help-menu end">
          <h4>{t('top.howTo')}</h4>
          <ol className="howto">
            <li>{t('top.howTo1')}</li>
            <li>{t('top.howTo2')}</li>
            <li>{t('top.howTo3')}</li>
            <li>{t('top.howTo4')}</li>
            <li>{t('top.howTo5')}</li>
          </ol>
          <h4>{t('top.shortcuts')}</h4>
          <dl className="shortcuts">
            {shortcuts().map(([k, v]) => (
              <div key={k}>
                <dt><kbd>{k}</kbd></dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
    </div>
  );
}

export function TopBar() {
  const page = useStore((s) => s.page);
  const flash = useStore((s) => s.remoteFlash);
  const empty = useStore((s) => !s.project || projectDuration(s.project) <= 0);
  const [live, setLive] = useState(false);
  const s = useStore.getState();
  useEffect(() => {
    if (!flash) return;
    setLive(true);
    const timer = setTimeout(() => setLive(false), 2500);
    return () => clearTimeout(timer);
  }, [flash]);
  return (
    <header className="topbar" data-testid="topbar">
      <button className="brand" title={t('top.backToEditor')} onClick={() => s.set({ page: 'editor' })}>
        <span className="logo">A</span>
        <span className="brand-name" dir="ltr">ALON<b>.ai</b></span>
      </button>
      <span className="topbar-sep" />
      <ProjectMenu />
      <span className="saved" title={t('top.savedTitle')}>
        <Icon name="check" size={14} /> {t('top.saved')}
      </span>
      {live && <span className="live">{t('top.remoteUpdate')}</span>}
      <span className="grow" />
      <HelpMenu />
      <button className="btn pill-api" data-testid="lang-toggle" title={t('lang.toggleTitle')} aria-label={t('lang.toggleTitle')} onClick={() => setLang(getLang() === 'he' ? 'en' : 'he')}>
        {t('lang.toggle')}
      </button>
      <button className={'btn pill-api' + (page === 'api' ? ' on' : '')} data-testid="api-page" title={t('top.apiTitle')} aria-pressed={page === 'api'} onClick={() => s.set({ page: page === 'api' ? 'editor' : 'api' })}>
        <Icon name="code" size={16} /> <span dir="ltr">API · MCP</span>
      </button>
      <button className="btn primary" data-testid="export-open" disabled={empty} title={empty ? t('top.addVideoFirst') : t('top.makeMp4')} onClick={() => s.set({ exportOpen: true })}>
        <Icon name="download" /> {t('top.export')}
      </button>
    </header>
  );
}

const QUALITIES: [string, Key][] = [
  ['low', 'top.qualityDraft'],
  ['medium', 'top.qualityNormal'],
  ['high', 'top.qualityHigh'],
];

export function ExportDialog() {
  const project = useStore((s) => s.project)!;
  const latest = useStore((s) => latestJob(s.jobs, 'export'));
  // an export finished earlier is not shown again (the video may have changed since); a running one is
  const [before, setBefore] = useState<string | null>(null); // id of the latest export when "ייצוא" was pressed
  const job = (before !== null && latest && latest.id !== before) || latest?.status === 'running' ? latest : undefined;
  const [quality, setQuality] = useState('medium');
  // the last network picked is remembered on this computer (a convenience; it works without it)
  const [presetId, setPresetId] = useState<string>(() => {
    try {
      return presetOf(localStorage.getItem('alon.exportPreset')) ? localStorage.getItem('alon.exportPreset')! : '';
    } catch {
      return '';
    }
  });
  const [reframe, setReframe] = useState<Reframe>('fit');
  const pickPreset = (id: string) => {
    setPresetId(id);
    try {
      localStorage.setItem('alon.exportPreset', id);
    } catch {
      /* private window */
    }
  };
  const s = useStore.getState();
  const preset = presetOf(presetId);
  const { width, height, fps } = preset ?? project.settings;
  const reshape = !!preset && shapeDiffers(preset.width, preset.height, project.settings.width, project.settings.height);
  const total = projectDuration(project);
  const hasRange = project.inPoint !== null && project.outPoint !== null;
  const [range, setRange] = useState(false);
  const [normalize, setNormalize] = useState(true);
  const from = range ? project.inPoint ?? 0 : 0;
  const to = range ? Math.min(project.outPoint ?? total, total) : total;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && useStore.getState().set({ exportOpen: false });
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const running = job?.status === 'running';
  const done = job?.status === 'done';
  const pct = Math.round((job?.progress ?? 0) * 100);
  return (
    <div className="modal-back" onPointerDown={(e) => e.target === e.currentTarget && s.set({ exportOpen: false })}>
      <div className="modal" role="dialog" aria-label={t('top.export')} data-testid="export-dialog">
        <div className="modal-head">
          <h3>{t('top.exportVideo')}</h3>
          <button className="icon-btn" aria-label={t('top.close')} title={t('top.close')} onClick={() => s.set({ exportOpen: false })}>
            <Icon name="close" />
          </button>
        </div>
        <p className="export-summary">
          <bdi dir="ltr">MP4 · {width}×{height} · {fps}fps{preset ? ` · ≤${Math.round(preset.maxrate / 1000)} Mbps` : ''} · {fmtTime(Math.max(0, to - from))}</bdi>
        </p>
        {!running && !done && (
          <>
            <div className="field">
              <span className="field-label">{t('top.whereTo')}</span>
              <div className="chips preset-chips" data-testid="export-presets">
                <button className={'chip' + (!preset ? ' on' : '')} aria-pressed={!preset} onClick={() => pickPreset('')}>
                  {t('top.likeProject')}
                </button>
                {EXPORT_PRESETS.map((x) => (
                  <button key={x.id} className={'chip' + (presetId === x.id ? ' on' : '')} aria-pressed={presetId === x.id} data-preset={x.id} title={`${x.width}×${x.height}, ${x.fps}fps`} onClick={() => pickPreset(x.id)}>
                    <bdi>{tl('exportPreset', x.id, x.label)}</bdi>
                  </button>
                ))}
              </div>
            </div>
            {reshape && (
              <div className="field">
                <span className="field-label">{t('top.shapeDiffers')}</span>
                <div className="seg" data-testid="export-reframe">
                  <button className={reframe === 'fit' ? 'on' : ''} onClick={() => setReframe('fit')}>
                    {t('top.reframeFit')}
                  </button>
                  <button className={reframe === 'fill' ? 'on' : ''} onClick={() => setReframe('fill')}>
                    {t('top.reframeFill')}
                  </button>
                </div>
              </div>
            )}
            <div className="field">
              <span className="field-label">{t('top.quality')}</span>
              <div className="seg">
                {QUALITIES.map(([v, l]) => (
                  <button key={v} className={quality === v ? 'on' : ''} onClick={() => setQuality(v)}>
                    {t(l)}
                  </button>
                ))}
              </div>
            </div>
            <label className="check-row">
              <input type="checkbox" checked={normalize} onChange={(e) => setNormalize(e.target.checked)} />
              <span>{t('top.normalize')}</span>
            </label>
            {hasRange && (
              <label className="check-row">
                <input type="checkbox" checked={range} onChange={(e) => setRange(e.target.checked)} />
                <span>{t('top.rangeOnly')}</span>
              </label>
            )}
          </>
        )}
        {job && (running || done || job.status === 'error') && (
          <div className="progress-block">
            <div className="progress-row">
              <span>{done ? t('top.exportDone') : job.status === 'error' ? t('top.exportFailed') : t('top.exporting')}</span>
              <bdi dir="ltr">{done ? '' : `${pct}%`}</bdi>
            </div>
            <div className={'bar' + (done ? ' done' : job.status === 'error' ? ' error' : '')}>
              <div style={{ width: `${done ? 100 : Math.max(2, pct)}%` }} />
            </div>
          </div>
        )}
        {job?.status === 'error' && <p className="error" dir="auto">{job.error}</p>}
        {done && job.url && (
          <div className="export-done">
            <a className="btn primary lg wide" href={job.url} download>
              <Icon name="download" /> {t('top.saveFile')}
            </a>
            <button className="btn wide" onClick={() => void fetch('/api/exports/reveal', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file: job.file }) })}>
              <Icon name="folder" /> {t('top.openFolder')}
            </button>
          </div>
        )}
        {!running && (
          <button className={'btn wide lg' + (done ? ' ghost' : ' primary')} data-testid="export-start" disabled={total <= 0} onClick={() => (setBefore(latest?.id ?? ''), void s.startExport(quality, range, normalize, { preset: preset?.id ?? null, reframe }))}>
            {done || job?.status === 'error' ? t('top.exportAgain') : total > 0 ? t('top.export') : t('top.nothingToExport')}
          </button>
        )}
      </div>
    </div>
  );
}
