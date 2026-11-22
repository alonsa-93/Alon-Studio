import { useEffect, useRef, useState, type ReactNode } from 'react';
import { speedOf } from '../../shared/fx';
import { textStyleOf, uid } from '../../shared/ops';
import { poseAt, sortedKeys, type PoseKey } from '../../shared/motion';
import { ANIM_LABELS, BLEND_LABELS, BLEND_MODES, EASE_LABELS, EASES, FONTS, LOOKS, RESOLUTIONS, SPEEDS, TRANSITION_LABELS, type Aspect, type BlendMode, type Clip, type ClipFx, type Ease, type TextStyle } from '../../shared/types';
import { applyFxToAll, deleteSelected, jumpKeyframe, mainTrackId, siblingsOf, toggleKeyframe } from '../actions';
import { CORNERS, LAYOUTS, secondTrackOf, type Corner, type Layout } from '../../shared/layout';
import { api, fmtDuration, fmtTime, useStore } from '../store';
import { useFonts } from '../fonts';
import { Icon } from './Icon';
import { t, tl, type Key } from '../i18n';

/** Collapsible group. Open / closed is remembered per group name. */
export function Section({ id, title, children, defaultOpen = true, onReset }: { id: string; title: string; children: ReactNode; defaultOpen?: boolean; onReset?: () => void }) {
  const key = `alon.section.${id}`;
  const [open, setOpen] = useState(() => {
    try {
      const v = localStorage.getItem(key);
      return v === null ? defaultOpen : v === '1';
    } catch {
      return defaultOpen;
    }
  });
  const toggle = () => {
    setOpen(!open);
    try {
      localStorage.setItem(key, open ? '0' : '1');
    } catch {
      /* private mode */
    }
  };
  return (
    <section className={'section' + (open ? ' open' : '')}>
      <div className="section-head">
        <button className="section-toggle" aria-expanded={open} onClick={toggle}>
          <span>{title}</span>
          <Icon name="chevron" size={16} />
        </button>
        {onReset && (
          <button className="link-btn" onClick={onReset} title={t('insp.resetTitle')}>
            {t('insp.reset')}
          </button>
        )}
      </div>
      {open && <div className="section-body">{children}</div>}
    </section>
  );
}

/** Slider with the value at the end of the label row; double-click (or the reset icon) returns to the default. */
export function Slider({ label, value, min, max, step, def, fmt, onChange }: { label: string; value: number; min: number; max: number; step: number; def?: number; fmt: (v: number) => string; onChange: (v: number) => void }) {
  const changed = def !== undefined && Math.abs(value - def) > step / 2;
  const p = ((value - min) / (max - min)) * 100;
  return (
    <div className={'slider' + (changed ? ' changed' : '')}>
      <div className="slider-row">
        <span>{label}</span>
        <span className="slider-end">
          {changed && (
            <button className="tiny-btn" title={t('insp.reset')} onClick={() => onChange(def!)}>
              <Icon name="reset" size={13} />
            </button>
          )}
          <bdi className="value" dir="ltr">{fmt(value)}</bdi>
        </span>
      </div>
      <input
        dir="ltr"
        type="range"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={value}
        style={{ ['--p' as string]: `${Math.max(0, Math.min(100, p))}%` }}
        onDoubleClick={() => def !== undefined && onChange(def)}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}

export function Seg<T extends string | number>({ value, options, onChange, label }: { value: T; options: [T, ReactNode][]; onChange: (v: T) => void; label?: string }) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map(([v, l]) => (
        <button key={String(v)} className={value === v ? 'on' : ''} aria-pressed={value === v} onClick={() => onChange(v)}>
          {l}
        </button>
      ))}
    </div>
  );
}

const SWATCHES = ['#ffffff', '#1d1c1a', '#ffe500', '#ff6a3d', '#e5383b', '#2f80ed', '#27ae60', '#9b51e0'];

export function ColorRow({ label, value, onChange, allowNone }: { label: string; value: string | null; onChange: (v: string | null) => void; allowNone?: boolean }) {
  return (
    <div className="color-row">
      <span className="color-label">{label}</span>
      <div className="swatches">
        {allowNone && (
          <button className={'swatch none' + (value === null ? ' on' : '')} title={t('insp.none')} aria-label={t('insp.none')} onClick={() => onChange(null)} />
        )}
        {SWATCHES.map((c) => (
          <button key={c} className={'swatch' + (value?.toLowerCase() === c ? ' on' : '')} style={{ background: c }} title={c} aria-label={c} onClick={() => onChange(c)} />
        ))}
        <label className="swatch custom" title={t('insp.otherColor')}>
          <input type="color" value={value ?? '#000000'} onChange={(e) => onChange(e.target.value)} />
        </label>
      </div>
    </div>
  );
}

const SIZE_PRESETS: [number, Key][] = [
  [48, 'insp.sizeSmall'],
  [72, 'insp.sizeMedium'],
  [110, 'insp.sizeLarge'],
  [160, 'insp.sizeHuge'],
];

/** The text style controls shared by text clips and the captions tab. */
/** Built-in fonts, then the ones the user added; a font that is gone stays listed so the select shows it. */
export function FontOptions({ custom, current }: { custom: string[]; current?: string }) {
  const missing = current && !FONTS.includes(current) && !custom.includes(current) ? [current] : [];
  return (
    <>
      <optgroup label={t('insp.fontsBuiltIn')}>
        {FONTS.map((f) => (
          <option key={f} value={f} style={{ fontFamily: f }}>
            {f}
          </option>
        ))}
      </optgroup>
      {custom.length > 0 && (
        <optgroup label={t('insp.fontsAdded')}>
          {custom.map((f) => (
            <option key={f} value={f} style={{ fontFamily: `"${f}"` }}>
              {f}
            </option>
          ))}
        </optgroup>
      )}
      {missing.map((f) => (
        <option key={f} value={f}>
          {t('insp.fontMissing', { font: f })}
        </option>
      ))}
    </>
  );
}

export function TextStyleFields({ style, onChange, tag }: { style: TextStyle; onChange: (patch: Partial<TextStyle>, tag?: string) => void; tag: string }) {
  const custom = useFonts();
  return (
    <>
      <ColorRow label={t('insp.color')} value={style.color} onChange={(c) => c && onChange({ color: c })} />
      <ColorRow label={t('insp.background')} value={style.bg} allowNone onChange={(c) => onChange({ bg: c })} />
      <Slider label={t('insp.size')} value={style.size} min={20} max={260} step={2} fmt={(v) => String(v)} onChange={(v) => onChange({ size: v }, `${tag}-size`)} />
      <div className="mini-presets">
        {SIZE_PRESETS.map(([v, l]) => (
          <button key={v} className={'chip' + (Math.abs(style.size - v) < 4 ? ' on' : '')} onClick={() => onChange({ size: v })}>
            {t(l)}
          </button>
        ))}
      </div>
      <div className="field-grid">
        <label className="field">
          <span className="field-label">{t('insp.font')}</span>
          <select value={style.font} data-testid={`${tag}-font`} onChange={(e) => onChange({ font: e.target.value })}>
            <FontOptions custom={custom.map((f) => f.family)} current={style.font} />
          </select>
        </label>
        <label className="check-row">
          <input type="checkbox" checked={style.bold} onChange={(e) => onChange({ bold: e.target.checked })} />
          <span>{t('insp.bold')}</span>
        </label>
      </div>
    </>
  );
}

const pct = (v: number) => `${Math.round(v * 100)}%`;

const ASPECTS: [Aspect, Key, string][] = [
  ['9:16', 'insp.aspectReels', 'r-9-16'],
  ['16:9', 'insp.aspectYoutube', 'r-16-9'],
  ['1:1', 'insp.aspectSquare', 'r-1-1'],
  ['4:5', 'insp.aspectPortrait', 'r-4-5'],
];

function ProjectPanel() {
  const project = useStore((s) => s.project)!;
  const s = useStore.getState();
  const { aspect, width, height, fps } = project.settings;
  return (
    <div className="panel-scroll">
      <div className="panel-title">
        <h3>{t('insp.video')}</h3>
        <p className="muted small">{t('insp.projectHint')}</p>
      </div>
      <Section id="format" title={t('insp.format')}>
        <div className="aspect-cards">
          {ASPECTS.map(([a, label, cls]) => (
            <button key={a} className={'aspect-card' + (aspect === a ? ' on' : '')} aria-pressed={aspect === a} onClick={() => s.run({ op: 'set_aspect', aspect: a })}>
              <i className={`ratio ${cls}`} />
              <span>{t(label)}</span>
              <bdi className="muted small" dir="ltr">{a}</bdi>
            </button>
          ))}
        </div>
      </Section>
      <LayoutSection />
      <LogoSection />
      <Section id="background" title={t('insp.bgColor')}>
        <ColorRow label={t('insp.behindVideo')} value={project.background ?? '#000000'} onChange={(c) => c && s.run({ op: 'set_settings', background: c }, 'bg')} />
      </Section>
      <TemplatesSection />
      <Section id="project-advanced" title={t('insp.advanced')} defaultOpen={false}>
        <label className="field">
          <span className="field-label">{t('insp.resolution')}</span>
          <select
            dir="ltr"
            value={`${width}x${height}`}
            onChange={(e) => {
              const [w, h] = e.target.value.split('x').map(Number);
              s.run({ op: 'set_settings', width: w, height: h });
            }}
          >
            {RESOLUTIONS[aspect].map((r) => (
              <option key={r.label} value={`${r.width}x${r.height}`}>{`${r.label}  (${r.width}×${r.height})`}</option>
            ))}
          </select>
        </label>
        <div className="field">
          <span className="field-label">{t('insp.frameRate')}</span>
          <Seg value={fps} options={[[30, t('insp.fps30')], [60, t('insp.fps60')]]} onChange={(v) => s.run({ op: 'set_settings', fps: v })} />
        </div>
      </Section>
    </div>
  );
}

const LAYOUT_LABELS: Record<Layout, Key> = { single: 'insp.layoutSingle', stack: 'insp.layoutStack', side: 'insp.layoutSide', pip: 'insp.layoutPip' };

/** How the main video track and the track above it share the frame. */
function LayoutSection() {
  const project = useStore((st) => st.project)!;
  const s = useStore.getState();
  const layout = project.layout ?? 'single';
  const second = secondTrackOf(project);
  const hasSecond = !!second && project.clips.some((c) => c.trackId === second && (c.kind === 'video' || c.kind === 'image'));
  return (
    <Section id="layout" title={t('insp.screenLayout')} defaultOpen={false}>
      <div className="layout-cards" data-testid="layout-cards">
        {LAYOUTS.map((l) => (
          <button key={l} className={'layout-card' + (layout === l ? ' on' : '')} aria-pressed={layout === l} data-layout={l} onClick={() => s.run({ op: 'set_layout', layout: l })}>
            <i className={`lay lay-${l}`} aria-hidden="true">
              <b />
              <b />
            </i>
            <span>{t(LAYOUT_LABELS[l])}</span>
          </button>
        ))}
      </div>
      <p className="hint">
        {hasSecond ? t('insp.layoutHint') : t('insp.layoutNeedSecond')}
      </p>
    </Section>
  );
}

const CORNER_LABELS: Record<Corner, Key> = { 'top-left': 'insp.cornerTopLeft', 'top-right': 'insp.cornerTopRight', 'bottom-left': 'insp.cornerBottomLeft', 'bottom-right': 'insp.cornerBottomRight' };

/** A logo on every frame of the export: pick a picture, corner, size, opacity, margin. */
function LogoSection() {
  const project = useStore((st) => st.project)!;
  const s = useStore.getState();
  const logo = project.logo;
  const pictures = project.media.filter((m) => m.kind === 'image');
  const input = useRef<HTMLInputElement>(null);
  const set = (patch: Record<string, unknown>, tag?: string) => s.run({ op: 'set_logo', logo: patch }, tag);
  const upload = async (files: FileList) => {
    const assets = await s.upload(files);
    const pic = assets.find((a) => a.kind === 'image');
    if (!pic) return s.notify(t('insp.logoMustBeImage'), 'error');
    for (let i = 0; i < 60 && !useStore.getState().project?.media.some((m) => m.id === pic.id); i++) await new Promise((r) => setTimeout(r, 50));
    set({ mediaId: pic.id });
  };
  return (
    <Section id="logo" title={t('insp.logo')} defaultOpen={false} onReset={logo ? () => s.run({ op: 'set_logo', logo: null }) : undefined}>
      <div className="logo-picks" data-testid="logo-picks">
        {pictures.map((m) => (
          <button key={m.id} className={'logo-pick' + (logo?.mediaId === m.id ? ' on' : '')} aria-pressed={logo?.mediaId === m.id} title={m.name} onClick={() => set({ mediaId: m.id })}>
            <img src={`/media/${m.thumb ?? m.file}`} alt={m.name} />
          </button>
        ))}
        <button className="logo-pick add" title={t('insp.uploadLogo')} aria-label={t('insp.uploadLogo')} onClick={() => input.current?.click()}>
          <Icon name="plus" size={18} />
        </button>
        <input ref={input} type="file" hidden accept="image/png,image/jpeg,image/webp" onChange={(e) => (e.target.files?.length && void upload(e.target.files), (e.target.value = ''))} />
      </div>
      {logo ? (
        <>
          <div className="field">
            <span className="field-label">{t('insp.corner')}</span>
            <div className="corner-grid" dir="ltr" role="group" aria-label={t('insp.logoCorner')}>
              {CORNERS.map((c) => (
                <button key={c} className={logo.corner === c ? 'on' : ''} aria-pressed={logo.corner === c} aria-label={t(CORNER_LABELS[c])} title={t(CORNER_LABELS[c])} data-corner={c} onClick={() => set({ corner: c })} />
              ))}
            </div>
          </div>
          <Slider label={t('insp.size')} value={logo.size} def={0.15} min={0.03} max={0.5} step={0.01} fmt={pct} onChange={(v) => set({ size: v }, 'logo-size')} />
          <Slider label={t('insp.opacity')} value={logo.opacity} def={0.9} min={0} max={1} step={0.01} fmt={pct} onChange={(v) => set({ opacity: v }, 'logo-opacity')} />
          <Slider label={t('insp.margin')} value={logo.margin} def={0.04} min={0} max={0.2} step={0.005} fmt={pct} onChange={(v) => set({ margin: v }, 'logo-margin')} />
          <button className="link-btn" onClick={() => s.run({ op: 'set_logo', logo: null })}>
            {t('insp.removeLogo')}
          </button>
        </>
      ) : (
        <p className="hint">{pictures.length ? t('insp.logoPickHint') : t('insp.logoUploadHint')}</p>
      )}
    </Section>
  );
}

interface TemplateRow {
  id: string;
  name: string;
  aspect: string;
  layout: string;
  titles: number;
  logo: boolean;
}

/** Save the frame, tracks, layout, titles and logo as a template; start a new video from one. */
function TemplatesSection() {
  const project = useStore((st) => st.project)!;
  const s = useStore.getState();
  const [list, setList] = useState<TemplateRow[] | null>(null);
  const [name, setName] = useState('');
  const load = () => api<TemplateRow[]>('/api/templates').then(setList).catch(() => setList([]));
  useEffect(() => void load(), []);
  const save = async () => {
    try {
      await api(`/api/projects/${project.id}/template`, { method: 'POST', body: JSON.stringify({ name: name.trim() || project.name }) });
      setName('');
      s.notify(t('insp.templateSaved'));
      void load();
    } catch (e) {
      s.notify((e as Error).message, 'error');
    }
  };
  const remove = async (tpl: TemplateRow) => {
    if (!window.confirm(t('insp.templateDeleteConfirm', { name: tpl.name }))) return;
    await api(`/api/templates/${tpl.id}`, { method: 'DELETE' }).catch((e: Error) => s.notify(e.message, 'error'));
    void load();
  };
  return (
    <Section id="templates" title={t('insp.templates')} defaultOpen={false}>
      <p className="hint">{t('insp.templatesHint')}</p>
      <div className="inline-form">
        <input type="text" dir="auto" placeholder={project.name} value={name} maxLength={80} aria-label={t('insp.templateName')} data-testid="template-name" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void save()} />
        <button className="btn small" data-testid="template-save" onClick={() => void save()}>
          {t('insp.saveAsTemplate')}
        </button>
      </div>
      {list && list.length > 0 && (
        <ul className="template-list" data-testid="template-list">
          {list.map((tpl) => (
            <li key={tpl.id}>
              <span className="ellipsis" dir="auto">{tpl.name}</span>
              <bdi className="muted small" dir="ltr">{tpl.aspect}</bdi>
              <button className="btn small" data-testid="template-use" title={t('insp.newFromTemplate')} onClick={() => void s.createProject(tpl.id, tpl.name)}>
                {t('insp.newVideo')}
              </button>
              <button className="icon-btn sm" aria-label={t('insp.deleteTemplate', { name: tpl.name })} title={t('insp.delete')} onClick={() => void remove(tpl)}>
                <Icon name="trash" size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

const KIND_LABEL: Record<Clip['kind'], Key> = { video: 'insp.kindVideo', image: 'insp.kindImage', audio: 'insp.kindAudio', text: 'insp.kindText', caption: 'insp.kindCaption' };


const POSE_FX = { x: 'posX', y: 'posY', scale: 'scale', rotation: 'rotation', opacity: 'opacity' } as const;
const deg = (v: number) => `${Math.round(v)}°`;
const POINTS = [0.25, 0.5, 0.75];

/** Position, size, rotation, opacity and blend of a picture. With keyframes, a change is a keyframe at the playhead. */
function PlaceSection({ clip, tag }: { clip: Clip; tag: string }) {
  const s = useStore.getState();
  const project = useStore((st) => st.project)!;
  const fx: ClipFx = clip.fx ?? {};
  const keys = sortedKeys(clip.keyframes);
  const keyed = keys.length > 0;
  // paused, the values follow the playhead; while playing they stay put (no re-render every frame)
  const now = useStore((st) => (keyed && !st.playing ? st.time : -1));
  const time = now >= 0 ? now : s.time;
  const inside = time >= clip.start - 0.001 && time <= clip.start + clip.duration + 0.001;
  const ct = Math.round(Math.max(0, Math.min(clip.duration, time - clip.start)) * 1000) / 1000;
  const pose = poseAt(clip, ct);
  const at = keys.find((k) => Math.abs(k.t - ct) <= 0.05);
  const set = (k: PoseKey, v: number) => {
    if (!keyed) return s.run({ op: 'set_fx', clipId: clip.id, fx: { [POSE_FX[k]]: v } }, `${tag}-fx-${k}`);
    if (!inside) return s.notify(t('insp.moveToClip'));
    const kt = at?.t ?? ct;
    s.run({ op: 'set_keyframe', clipId: clip.id, t: kt, [k]: v }, `${tag}-kf-${k}-${kt}`);
  };
  const changed = (fx.scale ?? 1) !== 1 || (fx.posX ?? 0) !== 0 || (fx.posY ?? 0) !== 0 || (fx.opacity ?? 1) !== 1 || !!fx.flip || !!fx.rotation || (!!fx.blend && fx.blend !== 'normal');
  const onMain = clip.trackId === mainTrackId(project);
  return (
    <Section id="place" title={t('insp.placeTitle')} defaultOpen={false} onReset={changed && !keyed ? () => s.run({ op: 'set_fx', clipId: clip.id, fx: { scale: 1, posX: 0, posY: 0, opacity: 1, flip: false, rotation: 0, blend: 'normal' } }) : undefined}>
      {keyed && <p className="hint">{t('insp.keyedHint')}</p>}
      <Slider label={t('insp.size')} value={pose.scale} def={1} min={0.2} max={3} step={0.01} fmt={pct} onChange={(v) => set('scale', v)} />
      <Slider label={t('insp.leftRight')} value={pose.x} def={0} min={-1} max={1} step={0.01} fmt={pct} onChange={(v) => set('x', v)} />
      <Slider label={t('insp.upDown')} value={pose.y} def={0} min={-1} max={1} step={0.01} fmt={pct} onChange={(v) => set('y', v)} />
      <Slider label={t('insp.rotation')} value={pose.rotation} def={0} min={-180} max={180} step={1} fmt={deg} onChange={(v) => set('rotation', v)} />
      <Slider label={t('insp.opacity')} value={pose.opacity} def={1} min={0} max={1} step={0.01} fmt={pct} onChange={(v) => set('opacity', v)} />
      <label className="check-row">
        <input type="checkbox" checked={!!fx.flip} onChange={(e) => s.run({ op: 'set_fx', clipId: clip.id, fx: { flip: e.target.checked } })} />
        <span>{t('insp.mirror')}</span>
      </label>
      <label className="field">
        <span className="field-label">{t('insp.blendBelow')}</span>
        <select value={fx.blend ?? 'normal'} onChange={(e) => s.run({ op: 'set_fx', clipId: clip.id, fx: { blend: e.target.value as BlendMode } })}>
          {BLEND_MODES.map((b) => (
            <option key={b} value={b}>
              {tl('blend', b, BLEND_LABELS[b])}
            </option>
          ))}
        </select>
      </label>
      {onMain && (
        <button
          className="link-btn"
          onClick={() => {
            s.run([{ op: 'move_clip_to_new_track', clipId: clip.id, position: 'above' }, { op: 'set_fx', clipId: clip.id, fx: { blend: 'screen' } }]);
            s.notify(t('insp.overlayDone'));
          }}
        >
          {t('insp.makeOverlay')}
        </button>
      )}
    </Section>
  );
}

/** Keyframes of a picture: add / remove at the playhead, jump between them, the curve to the next one, zoom to a point. */
function MotionSection({ clip }: { clip: Clip }) {
  const s = useStore.getState();
  const keys = sortedKeys(clip.keyframes);
  const now = useStore((st) => (st.playing ? -1 : st.time));
  const time = now >= 0 ? now : s.time;
  const inside = time >= clip.start - 0.001 && time <= clip.start + clip.duration + 0.001;
  const ct = Math.round(Math.max(0, Math.min(clip.duration, time - clip.start)) * 1000) / 1000;
  const at = keys.find((k) => Math.abs(k.t - ct) <= 0.05);
  const [zoom, setZoom] = useState(1.5);
  const [len, setLen] = useState(2);
  const [pt, setPt] = useState<[number, number]>([0.5, 0.5]);
  const punch = () => {
    if (!inside || clip.start + clip.duration - time < 0.2) return s.notify(t('insp.punchMoveHint'));
    const end = Math.min(clip.start + clip.duration, time + len);
    s.run({ op: 'punch_in', clipId: clip.id, start: time, end, x: pt[0], y: pt[1], scale: zoom });
    s.notify(t('insp.punchAdded'), 'info', { label: t('insp.undo'), run: () => useStore.getState().undo() });
  };
  return (
    <>
      <Section id="motion" title={t('insp.motion')} defaultOpen={keys.length > 0}>
        <div className="kf-bar">
          <button className="btn small" onClick={toggleKeyframe} aria-keyshortcuts="K">
            <Icon name={at ? 'close' : 'plus'} size={14} /> {at ? t('insp.removeKey') : t('insp.addKey')} <kbd>K</kbd>
          </button>
          <button className="btn small" disabled={!keys.length} onClick={() => jumpKeyframe(-1)} aria-label={t('insp.prevKey')} title={t('insp.prevKey')}>
            <span aria-hidden="true">◀</span>
          </button>
          <button className="btn small" disabled={!keys.length} onClick={() => jumpKeyframe(1)} aria-label={t('insp.nextKey')} title={t('insp.nextKey')}>
            <span aria-hidden="true">▶</span>
          </button>
          <span className="kf-count">{keys.length ? t(keys.length === 1 ? 'insp.keysOne' : 'insp.keysMany', { n: keys.length }) : t('insp.noKeys')}</span>
        </div>
        {at && (
          <label className="field">
            <span className="field-label">{t('insp.easeToNext')}</span>
            <select value={at.ease} onChange={(e) => s.run({ op: 'set_keyframe', clipId: clip.id, t: at.t, ease: e.target.value as Ease })}>
              {EASES.map((e) => (
                <option key={e} value={e}>
                  {tl('ease', e, EASE_LABELS[e])}
                </option>
              ))}
            </select>
          </label>
        )}
        {keys.length > 0 && (
          <button className="link-btn" onClick={() => s.run({ op: 'clear_keyframes', clipId: clip.id })}>
            {t('insp.clearKeys')}
          </button>
        )}
        <p className="hint">{t('insp.motionHint')}</p>
      </Section>
      <Section id="punch" title={t('insp.punchTitle')} defaultOpen={false}>
        <div className="field">
          <span className="field-label">{t('insp.zoomWhere')}</span>
          <div className="point-grid" dir="ltr" role="group" aria-label={t('insp.zoomPoint')}>
            {POINTS.flatMap((y) =>
              POINTS.map((x) => (
                <button key={`${x}-${y}`} className={pt[0] === x && pt[1] === y ? 'on' : ''} aria-pressed={pt[0] === x && pt[1] === y} aria-label={t('insp.pointAt', { x: Math.round(x * 100), y: Math.round(y * 100) })} onClick={() => setPt([x, y])} />
              )),
            )}
          </div>
        </div>
        <Slider label={t('insp.howClose')} value={zoom} def={1.5} min={1.1} max={3} step={0.05} fmt={pct} onChange={setZoom} />
        <Slider label={t('insp.duration')} value={len} def={2} min={0.5} max={6} step={0.1} fmt={(v) => t('insp.seconds', { n: v.toFixed(1) })} onChange={setLen} />
        <button className="btn wide" onClick={punch}>
          {t('insp.addZoom')}
        </button>
      </Section>
    </>
  );
}

function ClipPanel({ clip }: { clip: Clip }) {
  const project = useStore((s) => s.project)!;
  const s = useStore.getState();
  const [text, setText] = useState(clip.text ?? '');
  const [speedRipple, setSpeedRipple] = useState(false);
  useEffect(() => setText(clip.text ?? ''), [clip.id, clip.text]);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const editReq = useStore((st) => (st.editText?.id === clip.id ? st.editText.n : 0));
  useEffect(() => {
    if (!editReq || !textRef.current) return;
    const el = textRef.current;
    el.scrollIntoView({ block: 'center' });
    el.focus();
    el.select();
    // select again after this render settles, so typing replaces the sample text
    requestAnimationFrame(() => document.activeElement === el && el.select());
    // one request = one focus: selecting this clip later must not steal the keyboard again
    useStore.getState().set({ editText: null });
  }, [editReq]);
  const media = project.media.find((m) => m.id === clip.mediaId);
  const isText = clip.kind === 'text' || clip.kind === 'caption';
  const picture = clip.kind === 'video' || clip.kind === 'image';
  const hasSound = clip.kind === 'audio' || (clip.kind === 'video' && !!media?.hasAudio);
  const tag = `clip-${clip.id}`;
  const fx: ClipFx = clip.fx ?? {};
  const parts = picture ? siblingsOf(project, clip).length : 1;
  const setFx = (patch: Partial<ClipFx>, key?: string) => s.run({ op: 'set_fx', clipId: clip.id, fx: patch }, key ? `${tag}-fx-${key}` : undefined);
  const colorChanged = ['brightness', 'contrast', 'saturation', 'temperature', 'sepia', 'blur'].some((k) => (fx as Record<string, unknown>)[k] !== undefined && (fx as Record<string, number>)[k] !== (k === 'temperature' || k === 'sepia' || k === 'blur' ? 0 : 1)) || !!fx.look;
  const st = isText ? textStyleOf(project, clip) : null;
  const setStyle = (style: Partial<TextStyle>, tg?: string) => s.run({ op: 'update_clip', clipId: clip.id, patch: { style } }, tg ?? `${tag}-style-${Object.keys(style).join()}`);
  const name = media?.name ?? clip.text ?? '';
  return (
    <>
      <div className="panel-scroll">
        <div className="clip-head">
          <span className={`kind-chip k-${clip.kind}`}>{t(KIND_LABEL[clip.kind])}</span>
          <b className="ellipsis" dir="auto" title={name}>{isText ? (clip.text ?? '').replace(/\n/g, ' · ') : name}</b>
          <span className="muted small">
            <bdi dir="ltr">{fmtTime(clip.start)}–{fmtTime(clip.start + clip.duration)}</bdi> · {fmtDuration(clip.duration)}
          </span>
        </div>

        {isText && st && (
          <>
            <Section id="text" title={clip.kind === 'caption' ? t('insp.captionText') : t('insp.text')}>
              <textarea
                ref={textRef}
                className="text-edit"
                spellCheck={false}
                aria-label={t('insp.theText')}
                placeholder={t('insp.typeHere')}
                dir="auto"
                rows={3}
                value={text}
                onBlur={() => !text.trim() && setText(clip.text ?? '')}
                onChange={(e) => {
                  setText(e.target.value);
                  if (e.target.value.trim()) s.run({ op: 'update_clip', clipId: clip.id, patch: { text: e.target.value } }, tag + '-text');
                }}
              />
              {clip.kind === 'text' && (
                <Slider
                  label={t('insp.onScreen')}
                  value={clip.duration}
                  min={0.5}
                  max={Math.max(15, Math.ceil(clip.duration))}
                  step={0.5}
                  fmt={(v) => t('insp.seconds', { n: v.toFixed(1) })}
                  onChange={(v) => s.run({ op: 'trim_clip', clipId: clip.id, start: clip.start, duration: v }, `${tag}-dur`)}
                />
              )}
            </Section>
            {clip.kind === 'text' ? (
              <Section id="text-style" title={t('insp.style')}>
                <TextStyleFields style={st} tag={tag} onChange={setStyle} />
              </Section>
            ) : (
              <p className="hint">{t('insp.captionStyleHint')}</p>
            )}
          </>
        )}

        {picture && (
          <>
            <Section id="frame" title={t('insp.framing')}>
              <Seg
                label={t('insp.framing')}
                value={fx.fit === 'cover' ? 'cover' : 'contain'}
                options={[
                  ['cover', t('insp.fill')],
                  ['contain', t('insp.fit')],
                ]}
                onChange={(v) => setFx({ fit: v })}
              />
              {parts > 1 && (
                <button className="link-btn" onClick={() => applyFxToAll(clip, { fit: fx.fit ?? 'contain' })}>
                  {t('insp.applyAllParts', { n: parts })}
                </button>
              )}
              <p className="hint">{t('insp.frameTip')}</p>
            </Section>
            <Section id="look" title={t('insp.color')} onReset={colorChanged ? () => s.run({ op: 'set_fx', clipId: clip.id, fx: { brightness: 1, contrast: 1, saturation: 1, temperature: 0, sepia: 0, blur: 0, look: '' } }) : undefined}>
              <select
                aria-label={t('insp.filter')}
                value={fx.look || 'none'}
                onChange={(e) => {
                  const look = LOOKS.find((l) => l.id === e.target.value);
                  s.run({ op: 'set_fx', clipId: clip.id, fx: { brightness: 1, contrast: 1, saturation: 1, temperature: 0, sepia: 0, ...look?.fx, look: look?.id ?? '' } });
                }}
              >
                <option value="none">{t('insp.noFilter')}</option>
                {LOOKS.map((l) => (
                  <option key={l.id} value={l.id}>
                    {tl('look', l.id, l.label)}
                  </option>
                ))}
              </select>
              <Slider label={t('insp.brightness')} value={fx.brightness ?? 1} def={1} min={0.5} max={1.5} step={0.01} fmt={pct} onChange={(v) => setFx({ brightness: v, look: '' }, 'brightness')} />
              {parts > 1 && (
                <button className="link-btn" onClick={() => applyFxToAll(clip, { look: fx.look ?? '', brightness: fx.brightness ?? 1, contrast: fx.contrast ?? 1, saturation: fx.saturation ?? 1, temperature: fx.temperature ?? 0, sepia: fx.sepia ?? 0, blur: fx.blur ?? 0 })}>
                  {t('insp.applyAllParts', { n: parts })}
                </button>
              )}
            </Section>
          </>
        )}

        {hasSound && (
          <Section id="sound" title={t('insp.sound')}>
            <Slider label={t('insp.volume')} value={clip.volume} def={1} min={0} max={2} step={0.05} fmt={pct} onChange={(v) => s.run({ op: 'update_clip', clipId: clip.id, patch: { volume: v } }, tag + '-vol')} />
            {clip.kind === 'audio' && (
              <button
                className="link-btn"
                onClick={() => {
                  const end = Math.max(...project.clips.filter((c) => c.kind === 'video' || c.kind === 'image').map((c) => c.start + c.duration), 0);
                  if (end > clip.start) s.run({ op: 'trim_clip', clipId: clip.id, start: clip.start, duration: end - clip.start });
                }}
              >
                {t('insp.endWithVideo')}
              </button>
            )}
          </Section>
        )}

        {/* ---- advanced, closed by default ---- */}
        {picture && <MotionSection clip={clip} />}
        {picture && <PlaceSection clip={clip} tag={tag} />}
        {picture && (
          <Section id="color-advanced" title={t('insp.colorAdvanced')} defaultOpen={false}>
            <Slider label={t('insp.contrast')} value={fx.contrast ?? 1} def={1} min={0.5} max={1.5} step={0.01} fmt={pct} onChange={(v) => setFx({ contrast: v, look: '' }, 'contrast')} />
            <Slider label={t('insp.saturation')} value={fx.saturation ?? 1} def={1} min={0} max={2} step={0.01} fmt={pct} onChange={(v) => setFx({ saturation: v, look: '' }, 'saturation')} />
            <Slider label={t('insp.temperature')} value={fx.temperature ?? 0} def={0} min={-1} max={1} step={0.01} fmt={(v) => String(Math.round(v * 100))} onChange={(v) => setFx({ temperature: v, look: '' }, 'temperature')} />
            <Slider label={t('insp.blur')} value={fx.blur ?? 0} def={0} min={0} max={40} step={0.5} fmt={(v) => String(v)} onChange={(v) => setFx({ blur: v }, 'blur')} />
          </Section>
        )}
        {isText && st && clip.kind === 'text' && (
          <Section id="text-place" title={t('insp.position')} defaultOpen={false}>
            <p className="hint">{t('insp.dragTextHint')}</p>
            <Slider label={t('insp.upDown')} value={st.y} min={0.04} max={0.96} step={0.01} fmt={pct} onChange={(v) => setStyle({ y: v }, `${tag}-y`)} />
            <Slider label={t('insp.leftRight')} value={st.x} min={0.04} max={0.96} step={0.01} fmt={pct} onChange={(v) => setStyle({ x: v }, `${tag}-x`)} />
          </Section>
        )}
        {(clip.kind === 'video' || clip.kind === 'audio') && (
          <Section id="speed" title={t('insp.speed')} defaultOpen={false}>
            <label className="check-row">
              <input type="checkbox" checked={speedRipple} onChange={(e) => setSpeedRipple(e.target.checked)} />
              <span>{t('insp.speedRipple')}</span>
            </label>
            <div className="mini-presets">
              {SPEEDS.filter((v) => [0.5, 1, 1.5, 2, 3].includes(v)).map((v) => (
                <button key={v} className={'chip' + (speedOf(clip) === v ? ' on' : '')} onClick={() => s.run({ op: 'set_speed', clipId: clip.id, speed: v, ripple: speedRipple })}>
                  <bdi dir="ltr">{v}x</bdi>
                </button>
              ))}
            </div>
          </Section>
        )}
        {hasSound && (
          <Section id="fades" title={t('insp.fades')} defaultOpen={false}>
            <Slider label={t('insp.fadeIn')} value={clip.fadeIn ?? 0} def={0} min={0} max={5} step={0.1} fmt={(v) => t('insp.seconds', { n: v.toFixed(1) })} onChange={(v) => s.run({ op: 'update_clip', clipId: clip.id, patch: { fadeIn: v } }, tag + '-fi')} />
            <Slider label={t('insp.fadeOut')} value={clip.fadeOut ?? 0} def={0} min={0} max={5} step={0.1} fmt={(v) => t('insp.seconds', { n: v.toFixed(1) })} onChange={(v) => s.run({ op: 'update_clip', clipId: clip.id, patch: { fadeOut: v } }, tag + '-fo')} />
          </Section>
        )}
        {clip.kind !== 'audio' && (clip.transition || clip.animIn || clip.animOut) && (
          <Section id="effects-on-clip" title={t('insp.clipEffects')}>
            <div className="tag-list">
              {clip.transition && (
                <span className="tag">
                  {t('insp.transitionTag', { name: tl('tr', clip.transition.type, TRANSITION_LABELS[clip.transition.type]) })}
                  <button className="tiny-btn" title={t('insp.remove')} onClick={() => s.run({ op: 'add_transition', clipId: clip.id, type: 'none' })}>
                    <Icon name="close" size={12} />
                  </button>
                </span>
              )}
              {clip.animIn && (
                <span className="tag">
                  {t('insp.inTag', { name: tl('anim', clip.animIn.type, ANIM_LABELS[clip.animIn.type]) })}
                  <button className="tiny-btn" title={t('insp.remove')} onClick={() => s.run({ op: 'set_animation', clipId: clip.id, in: { type: 'none' } })}>
                    <Icon name="close" size={12} />
                  </button>
                </span>
              )}
              {clip.animOut && (
                <span className="tag">
                  {t('insp.outTag', { name: tl('anim', clip.animOut.type, ANIM_LABELS[clip.animOut.type]) })}
                  <button className="tiny-btn" title={t('insp.remove')} onClick={() => s.run({ op: 'set_animation', clipId: clip.id, out: { type: 'none' } })}>
                    <Icon name="close" size={12} />
                  </button>
                </span>
              )}
            </div>
          </Section>
        )}
      </div>
      <div className="panel-footer">
        <button
          className="btn"
          onClick={() => {
            const id = uid('c_');
            s.run({ op: 'duplicate', clipId: clip.id, id });
            s.select(id);
          }}
        >
          <Icon name="copy" size={16} /> {t('insp.duplicate')}
        </button>
        {clip.kind === 'video' && media?.hasAudio && clip.volume > 0 && (
          <button className="btn ghost" title={t('insp.detachAudioTitle')} onClick={() => s.run({ op: 'detach_audio', clipId: clip.id })}>
            {t('insp.detachAudio')}
          </button>
        )}
        <span className="grow" />
        <button className="icon-btn danger" title={t('insp.deleteDel')} onClick={() => deleteSelected()}>
          <Icon name="trash" />
        </button>
      </div>
    </>
  );
}

export function Inspector() {
  const clip = useStore((s) => s.project!.clips.find((c) => c.id === s.selected));
  return <aside className="inspector" data-testid="inspector">{clip ? <ClipPanel key={clip.id} clip={clip} /> : <ProjectPanel />}</aside>;
}
