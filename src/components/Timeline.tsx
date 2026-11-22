import { useEffect, useRef, useState } from 'react';
import { speedOf } from '../../shared/fx';
import { applyOp, projectDuration, trackKindFor, uid, type Op } from '../../shared/ops';
import { ANIM_LABELS, TRANSITION_LABELS, type Clip, type Project, type Track } from '../../shared/types';
import { addMediaToTimeline, cutInOut, deleteSelected, duplicateSelected, mainTrackId, splitAtPlayhead, toggleKeyframe } from '../actions';
import { fmtTime, useStore } from '../store';
import * as i18n from '../i18n';
import { STRINGS, t, tl, type Key } from '../i18n';
import { Icon } from './Icon';

export { cutInOut, deleteSelected, duplicateSelected, splitAtPlayhead };

const RULER_H = 24;
const ROW_H: Record<Track['kind'], number> = { video: 56, text: 32, audio: 44 };
// short screens (laptops): slimmer rows so every track fits without scrolling
const ROW_H_COMPACT: Record<Track['kind'], number> = { video: 46, text: 26, audio: 34 };
const STEPS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];

/** Nearest start time on `trackId` where the clip does not overlap anything. */
function placeFree(p: Project, clip: Clip, trackId: string, start: number): number {
  const others = p.clips.filter((c) => c.trackId === trackId && c.id !== clip.id);
  const free = (s: number) => s >= 0 && !others.some((o) => o.start < s + clip.duration - 0.001 && o.start + o.duration > s + 0.001);
  if (free(start)) return start;
  const candidates = [0, ...others.flatMap((o) => [o.start + o.duration, o.start - clip.duration])].filter(free);
  return candidates.sort((a, b) => Math.abs(a - start) - Math.abs(b - start))[0] ?? start;
}

function useViewportSize() {
  const read = () => ({ header: window.innerWidth < 1360 ? 112 : 128, compact: window.innerHeight < 800 });
  const [v, setV] = useState(read);
  useEffect(() => {
    const on = () => setV(read());
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return v;
}

function Playhead({ scroller, header }: { scroller: React.RefObject<HTMLDivElement | null>; header: number }) {
  const time = useStore((s) => s.time);
  const pps = useStore((s) => s.pps);
  const playing = useStore((s) => s.playing);
  const x = header + time * pps;
  useEffect(() => {
    const el = scroller.current;
    if (!el || !playing) return;
    if (x > el.scrollLeft + el.clientWidth - 30 || x < el.scrollLeft + header) el.scrollLeft = x - header - 40;
  }, [x, playing, scroller, header]);
  return (
    <div className="playhead" style={{ transform: `translateX(${x}px)` }}>
      <div className="playhead-knob" />
    </div>
  );
}

function ClipView({ clip, project, onDrag, onMenu }: { clip: Clip; project: Project; onDrag: (e: React.PointerEvent, clip: Clip, mode: 'move' | 'l' | 'r') => void; onMenu: (e: React.MouseEvent, clip: Clip) => void }) {
  const pps = useStore((s) => s.pps);
  const selected = useStore((s) => s.selected === clip.id);
  const selKey = useStore((s) => (s.selectedKey?.clipId === clip.id ? s.selectedKey.t : null));
  const media = project.media.find((m) => m.id === clip.mediaId);
  const label = clip.text?.replace(/\n/g, ' · ') ?? media?.name ?? '';
  const visual = clip.kind === 'video' || clip.kind === 'image';
  const sp = speedOf(clip);
  const wave = (clip.kind === 'audio' || clip.kind === 'video') && media?.wave && media.duration > 0 ? media : null;
  const width = Math.max(4, clip.duration * pps);
  const inZone = clip.transition || clip.animIn ? Math.max(8, Math.min(clip.duration, clip.transition?.duration ?? clip.animIn?.duration ?? 0) * pps) : 0;
  const outZone = clip.animOut ? Math.max(8, Math.min(clip.duration, clip.animOut.duration) * pps) : 0;
  const fxTitle = [clip.transition && t('tl.fxTransition', { name: tl('tr', clip.transition.type, TRANSITION_LABELS[clip.transition.type]) }), clip.animIn && t('tl.fxIn', { name: tl('anim', clip.animIn.type, ANIM_LABELS[clip.animIn.type]) }), clip.animOut && t('tl.fxOut', { name: tl('anim', clip.animOut.type, ANIM_LABELS[clip.animOut.type]) })].filter(Boolean).join(' · ');
  return (
    <div
      className={`clip k-${clip.kind}${selected ? ' selected' : ''}${width < 40 ? ' narrow' : ''}`}
      style={{ left: clip.start * pps, width }}
      onPointerDown={(e) => onDrag(e, clip, 'move')}
      onContextMenu={(e) => onMenu(e, clip)}
      onDoubleClick={() => (clip.kind === 'text' || clip.kind === 'caption') && useStore.getState().startTextEdit(clip.id)}
      title={`${label}\n${fmtTime(clip.start)}–${fmtTime(clip.start + clip.duration)}${fxTitle ? `\n${fxTitle}` : ''}`}
    >
      {visual && media?.thumb && <div className="clip-thumbs" style={{ backgroundImage: `url(/media/${media.thumb})` }} />}
      {wave && clip.kind === 'audio' && <div className="clip-wave" style={{ backgroundImage: `url(/media/${wave.wave})`, backgroundSize: `${(wave.duration * pps) / sp}px 100%`, backgroundPosition: `${(-clip.offset * pps) / sp}px 0` }} />}
      {inZone > 0 && (
        <div className="fx-zone in" style={{ width: inZone }}>
          <Icon name={clip.transition ? 'swap' : 'spark'} size={12} />
        </div>
      )}
      {outZone > 0 && (
        <div className="fx-zone out" style={{ width: outZone }}>
          <Icon name="spark" size={12} />
        </div>
      )}
      <div className="clip-label" dir="auto" style={{ left: inZone + 6, right: outZone + 6 }}>
        {sp !== 1 && (
          <span className="badge" dir="ltr">
            {sp}x
          </span>
        )}
        <span className="clip-name">{label}</span>
      </div>
      {clip.keyframes?.map((k) => (
        <button
          key={k.t}
          className={'kf' + (selKey !== null && Math.abs(selKey - k.t) < 0.01 ? ' on' : '')}
          style={{ left: k.t * pps }}
          title={t('tl.kfTitle', { time: fmtTime(clip.start + k.t) })}
          aria-label={t('tl.kfAria', { time: fmtTime(clip.start + k.t) })}
          onPointerDown={(e) => {
            e.stopPropagation();
            const s = useStore.getState();
            s.select(clip.id);
            s.setPlaying(false);
            s.seek(clip.start + k.t);
            s.set({ selectedKey: { clipId: clip.id, t: k.t } });
          }}
        />
      ))}
      {selected && (
        <>
          <div className="handle l" title={t('tl.trimHandle')} onPointerDown={(e) => onDrag(e, clip, 'l')} />
          <div className="handle r" title={t('tl.trimHandle')} onPointerDown={(e) => onDrag(e, clip, 'r')} />
        </>
      )}
      {!selected && (
        <>
          <div className="handle l quiet" onPointerDown={(e) => onDrag(e, clip, 'l')} />
          <div className="handle r quiet" onPointerDown={(e) => onDrag(e, clip, 'r')} />
        </>
      )}
    </div>
  );
}

interface Menu {
  x: number;
  y: number;
  clip: Clip;
}

function ClipMenu({ menu, close }: { menu: Menu; close: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const s = useStore.getState();
  useEffect(() => {
    const down = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && close();
    const key = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('keydown', key);
    };
  }, [close]);
  const p = s.project!;
  const c = menu.clip;
  const media = p.media.find((m) => m.id === c.mediaId);
  const onMain = c.trackId === mainTrackId(p) && (c.kind === 'video' || c.kind === 'image');
  const act = (fn: () => void) => () => {
    close();
    fn();
  };
  return (
    <div className="menu context" ref={ref} role="menu" style={{ left: Math.min(menu.x, window.innerWidth - 230), top: Math.min(menu.y, window.innerHeight - 400) }}>
      <button role="menuitem" onClick={act(splitAtPlayhead)}>
        <Icon name="split" size={16} /> {t('tl.splitHere')} <kbd>S</kbd>
      </button>
      <button role="menuitem" onClick={act(() => duplicateSelected())}>
        <Icon name="copy" size={16} /> {t('tl.duplicate')} <kbd>Ctrl+D</kbd>
      </button>
      {c.kind === 'video' && media?.hasAudio && c.volume > 0 && (
        <button role="menuitem" onClick={act(() => s.run({ op: 'detach_audio', clipId: c.id }))}>
          <Icon name="music" size={16} /> {t('tl.detachAudio')}
        </button>
      )}
      {(c.kind === 'text' || c.kind === 'caption') && (
        <button role="menuitem" onClick={act(() => s.startTextEdit(c.id))}>
          <Icon name="text" size={16} /> {t('tl.editText')}
        </button>
      )}
      {(c.kind === 'video' || c.kind === 'image') && (
        <button role="menuitem" onClick={act(toggleKeyframe)}>
          <Icon name="spark" size={16} /> {t('tl.kfHere')} <kbd>K</kbd>
        </button>
      )}
      <button role="menuitem" onClick={act(() => s.run({ op: 'move_clip_to_new_track', clipId: c.id, position: 'above' }))}>
        <Icon name="layers" size={16} /> {t('tl.moveAbove')}
      </button>
      <button role="menuitem" onClick={act(() => s.run({ op: 'move_clip_to_new_track', clipId: c.id, position: 'below' }))}>
        <Icon name="layers" size={16} /> {t('tl.moveBelow')}
      </button>
      <div className="menu-sep" />
      <button role="menuitem" className="danger" onClick={act(() => deleteSelected())}>
        <Icon name="trash" size={16} /> {t('tl.delete')} <kbd>Delete</kbd>
      </button>
      {onMain && (
        <button role="menuitem" className="danger" onClick={act(() => deleteSelected(true))}>
          <Icon name="trash" size={16} /> {t('tl.deleteGap')}
        </button>
      )}
    </div>
  );
}

function AddTrackMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const s = useStore.getState();
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener('pointerdown', down, true);
    return () => window.removeEventListener('pointerdown', down, true);
  }, [open]);
  const add = (kind: Track['kind']) => () => {
    setOpen(false);
    s.run({ op: 'add_track', kind });
  };
  return (
    <div className="menu-wrap" ref={ref}>
      <button className="tool-btn" title={t('tl.addTrackTitle')} aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name="layers" size={16} /> <span className="tool-label">{t('tl.track')}</span>
      </button>
      {open && (
        <div className="menu up">
          <button onClick={add('video')}>
            <Icon name="film" size={16} /> {t('tl.addVideoTrack')}
          </button>
          <button onClick={add('text')}>
            <Icon name="text" size={16} /> {t('tl.addTextTrack')}
          </button>
          <button onClick={add('audio')}>
            <Icon name="music" size={16} /> {t('tl.addAudioTrack')}
          </button>
        </div>
      )}
    </div>
  );
}

const TRACK_HINT: Record<Track['kind'], Key> = { video: 'tl.hintVideo', text: 'tl.hintText', audio: 'tl.hintAudio' };

/** A default track name ("Video", "Video 2"...) in the current language; a name the user gave stays as is. */
function trackName(track: Track): string {
  const id = track.captions ? 'captions' : track.kind;
  const he: string = STRINGS[`trackName.${id}`][0];
  if (track.name === he) return tl('trackName', id, he);
  const rest = track.name.startsWith(he + ' ') ? track.name.slice(he.length + 1) : '';
  if (/^\d+$/.test(rest)) return `${tl('trackName', id, he)} ${rest}`;
  return track.name;
}

export function Timeline() {
  const project = useStore((s) => s.project)!;
  const pps = useStore((s) => s.pps);
  const snap = useStore((s) => s.snap);
  const selected = useStore((s) => s.selected);
  const canUndo = useStore((s) => s.history.length > 0);
  const canRedo = useStore((s) => s.future.length > 0);
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ left: 0, width: 1200 });
  const [menu, setMenu] = useState<Menu | null>(null);
  const { header, compact } = useViewportSize();
  const rowH = compact ? ROW_H_COMPACT : ROW_H;
  const duration = projectDuration(project);
  // a short tail after the end (room to drop clips), not whole empty seconds
  const contentW = Math.max(duration * pps + 160, view.width - header);
  const store = useStore.getState();
  const minPps = duration > 0 ? Math.max(4, (view.width - header - 40) / duration / 1.15) : 8;

  const timeAt = (clientX: number) => (clientX - content.current!.getBoundingClientRect().left - header) / useStore.getState().pps;

  const fit = () => {
    const d = projectDuration(useStore.getState().project!);
    if (d <= 0 || !scroller.current) return;
    store.setPps((scroller.current.clientWidth - header - 40) / d);
    scroller.current.scrollLeft = 0;
  };

  useEffect(() => {
    const el = scroller.current!;
    const update = () => setView({ left: el.scrollLeft, width: el.clientWidth });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    el.addEventListener('scroll', update, { passive: true });
    const wheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const s = useStore.getState();
      const rect = el.getBoundingClientRect();
      const t = (e.clientX - rect.left + el.scrollLeft - header) / s.pps;
      s.setPps(s.pps * (e.deltaY < 0 ? 1.18 : 1 / 1.18));
      const next = useStore.getState().pps;
      requestAnimationFrame(() => (el.scrollLeft = t * next + header - (e.clientX - rect.left)));
    };
    el.addEventListener('wheel', wheel, { passive: false });
    window.addEventListener('alon:fit-timeline', fit);
    return () => {
      ro.disconnect();
      el.removeEventListener('scroll', update);
      el.removeEventListener('wheel', wheel);
      window.removeEventListener('alon:fit-timeline', fit);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [header]);

  // keep the whole video in view when its length changes a lot (first clip, big cuts)
  const lastFit = useRef(0);
  useEffect(() => {
    if (duration <= 0) return;
    const prev = lastFit.current;
    if (!prev || Math.abs(duration - prev) / prev > 0.3) {
      lastFit.current = duration;
      fit();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [duration]);

  const scrub = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const s = useStore.getState();
    s.setPlaying(false);
    s.select(null);
    s.seek(timeAt(e.clientX));
    const move = (ev: PointerEvent) => useStore.getState().seek(timeAt(ev.clientX));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const dragClip = (e: React.PointerEvent, clip: Clip, mode: 'move' | 'l' | 'r') => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const s = useStore.getState();
    s.select(clip.id);
    const proj = s.project!;
    const x0 = e.clientX;
    const y0 = e.clientY;
    const scroll0 = scroller.current!.scrollLeft;
    const others = proj.clips.filter((c) => c.id !== clip.id);
    const points = [0, s.time, ...(proj.inPoint !== null ? [proj.inPoint] : []), ...(proj.outPoint !== null ? [proj.outPoint] : []), ...others.flatMap((c) => [c.start, c.start + c.duration])];
    const snapT = (t: number) => {
      const st = useStore.getState();
      if (!st.snap) return t;
      let best = t;
      let bd = 8 / st.pps;
      for (const p of points) {
        const d = Math.abs(p - t);
        if (d < bd) {
          bd = d;
          best = p;
        }
      }
      return best;
    };
    const media = proj.media.find((m) => m.id === clip.mediaId);
    const hasSource = (clip.kind === 'video' || clip.kind === 'audio') && !!media && media.duration > 0;
    const sp = speedOf(clip);
    const end0 = clip.start + clip.duration;
    const sameTrack = others.filter((c) => c.trackId === clip.trackId);
    let op: Op | null = null;

    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - x0 + (scroller.current!.scrollLeft - scroll0);
      if (!op && Math.abs(dx) < 3 && mode !== 'move') return;
      if (!op && Math.abs(dx) < 3 && Math.abs(ev.clientY - y0) < 6) return;
      const dt = dx / useStore.getState().pps;
      if (mode === 'move') {
        let start = clip.start + dt;
        const a = snapT(start);
        const b = snapT(start + clip.duration) - clip.duration;
        start = Math.abs(a - start) > 0 && (b === start || Math.abs(a - start) <= Math.abs(b - start)) ? a : b;
        start = Math.max(0, start);
        const row = document.elementsFromPoint(ev.clientX, ev.clientY).find((el) => (el as HTMLElement).dataset?.trackId) as HTMLElement | undefined;
        const target = proj.tracks.find((t) => t.id === row?.dataset.trackId);
        const trackId = target && target.kind === trackKindFor(clip.kind) ? target.id : clip.trackId;
        op = { op: 'move_clip', clipId: clip.id, start: placeFree(proj, clip, trackId, start), trackId };
      } else if (mode === 'l') {
        const prevEnd = Math.max(0, ...sameTrack.filter((c) => c.start + c.duration <= clip.start + 0.001).map((c) => c.start + c.duration));
        const min = Math.max(prevEnd, hasSource ? clip.start - clip.offset / sp : 0);
        const ns = Math.min(Math.max(snapT(clip.start + dt), min), end0 - 0.1);
        const d = ns - clip.start;
        op = { op: 'trim_clip', clipId: clip.id, start: ns, duration: clip.duration - d, offset: hasSource ? clip.offset + d * sp : 0 };
      } else {
        const nextStart = Math.min(Infinity, ...sameTrack.filter((c) => c.start >= end0 - 0.001).map((c) => c.start));
        const max = Math.min(nextStart, hasSource ? clip.start + (media!.duration - clip.offset) / sp : Infinity);
        const ne = Math.max(Math.min(snapT(end0 + dt), max), clip.start + 0.1);
        op = { op: 'trim_clip', clipId: clip.id, start: clip.start, duration: ne - clip.start, offset: clip.offset };
      }
      useStore.getState().preview(applyOp(proj, op));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (op) useStore.getState().run(op);
      else useStore.getState().preview(null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const openMenu = (e: React.MouseEvent, clip: Clip) => {
    e.preventDefault();
    useStore.getState().select(clip.id);
    setMenu({ x: e.clientX, y: e.clientY, clip });
  };

  // ruler labels for the visible range only
  const step = STEPS.find((s) => s * pps >= 70) ?? 600;
  const first = Math.max(0, Math.floor((view.left - header) / pps / step));
  const count = Math.ceil(view.width / pps / step) + 2;
  const labels = Array.from({ length: count }, (_, i) => (first + i) * step);
  const fmtRuler = (t: number) => {
    const m = Math.floor(t / 60);
    const sec = t - m * 60;
    return `${m}:${step < 1 ? sec.toFixed(1).padStart(4, '0') : String(Math.round(sec)).padStart(2, '0')}`;
  };

  const dropMedia = (e: React.DragEvent, track: Track) => {
    const mediaId = e.dataTransfer.getData('application/x-alon-media');
    (e.currentTarget as HTMLElement).classList.remove('drop-over');
    const s = useStore.getState();
    const m = s.project?.media.find((x) => x.id === mediaId);
    if (!m) return;
    e.preventDefault();
    let start = Math.max(0, timeAt(e.clientX));
    // a drop near the start or right after the previous clip snaps to it, so no gap is left by accident
    const ends = [0, ...s.project!.clips.filter((c) => c.trackId === track.id).map((c) => c.start + c.duration)];
    const near = ends.find((t) => Math.abs(t - start) < 40 / s.pps);
    if (near !== undefined) start = near;
    if (m.kind === 'image' && track.kind === 'audio') return s.notify(t('tl.noImageOnAudio'));
    if (m.kind !== 'audio' && track.kind !== 'video') return s.notify(t('tl.dropOnVideo'));
    if (m.kind === 'audio') {
      const id = uid('c_');
      s.run({ op: 'add_music', mediaId: m.id, start, volume: 1, id });
      s.select(id);
    } else addMediaToTimeline(m, { start });
  };

  const canCut = project.inPoint !== null && project.outPoint !== null;
  const removable = (t: Track) => !t.captions && project.tracks.filter((x) => x.kind === t.kind && !x.captions).length > 1;
  const zoomBy = (k: number) => store.setPps(Math.max(minPps, useStore.getState().pps * k));
  const playheadOnVideo = useStore((s) => s.project!.clips.some((c) => (c.kind === 'video' || c.kind === 'image') && c.start < s.time - 0.02 && c.start + c.duration > s.time + 0.02));

  return (
    <section className="timeline" data-testid="timeline">
      <div className="tl-toolbar" data-testid="tl-toolbar">
        <span className="tool-group">
        <button className="icon-btn" title={t('tl.undoTitle')} aria-label={t('tl.undo')} disabled={!canUndo} onClick={store.undo}>
          <Icon name="undo" />
        </button>
        <button className="icon-btn" title={t('tl.redoTitle')} aria-label={t('tl.redo')} disabled={!canRedo} onClick={store.redo}>
          <Icon name="redo" />
        </button>
        </span>
        <span className="tool-group">
        <button className="tool-btn" title={t('tl.splitTitle')} disabled={duration <= 0 || (!selected && !playheadOnVideo)} onClick={splitAtPlayhead}>
          <Icon name="split" size={16} /> <span className="tool-label">{t('tl.split')}</span>
        </button>
        <button className="tool-btn" title={t('tl.deleteTitle')} disabled={!selected} onClick={() => deleteSelected()}>
          <Icon name="trash" size={16} /> <span className="tool-label">{t('tl.delete')}</span>
        </button>
        <button className="tool-btn" title={t('tl.duplicateTitle')} disabled={!selected} onClick={() => duplicateSelected()}>
          <Icon name="copy" size={16} /> <span className="tool-label">{t('tl.duplicate')}</span>
        </button>
        <button className="tool-btn" title={t('tl.silencesTitle')} data-testid="silence-open" disabled={duration <= 0} onClick={() => store.set({ silenceOpen: true })}>
          <Icon name="mute" size={16} /> <span className="tool-label">{t('tl.silences')}</span>
        </button>
        {canCut && (
          <button className="tool-btn accent" title={t('tl.cutRangeTitle')} onClick={cutInOut}>
            <Icon name="cut" size={16} /> {t('tl.cutRange')}
          </button>
        )}
        </span>
        <span className="grow" />
        <span className="tool-group">
        <AddTrackMenu />
        <button className={'icon-btn' + (snap ? ' on' : '')} aria-pressed={snap} aria-label={t('tl.snap')} title={snap ? t('tl.snapOn') : t('tl.snapOff')} onClick={() => store.set({ snap: !snap })}>
          <Icon name="magnet" />
        </button>
        </span>
        <span className="tool-group">
        <button className="icon-btn" title={t('tl.zoomOutTitle')} aria-label={t('tl.zoomOut')} onClick={() => zoomBy(1 / 1.4)}>
          <Icon name="zoomout" />
        </button>
        <input
          className="zoom"
          dir="ltr"
          type="range"
          aria-label={t('tl.zoomSlider')}
          min={Math.log(minPps)}
          max={Math.log(600)}
          step={0.01}
          value={Math.log(Math.max(minPps, pps))}
          style={{ ['--p' as string]: `${((Math.log(Math.max(minPps, pps)) - Math.log(minPps)) / (Math.log(600) - Math.log(minPps))) * 100}%` }}
          onChange={(e) => store.setPps(Math.exp(Number(e.target.value)))}
        />
        <button className="icon-btn" title={t('tl.zoomInTitle')} aria-label={t('tl.zoomIn')} onClick={() => zoomBy(1.4)}>
          <Icon name="zoomin" />
        </button>
        <button className="tool-btn" title={t('tl.fitTitle')} onClick={fit}>
          <Icon name="fit" size={16} /> <span className="tool-label">{t('tl.fit')}</span>
        </button>
        </span>
      </div>
      <div className="tl-scroll" ref={scroller} dir="ltr">
        <div className="tl-content" ref={content} style={{ width: header + contentW, ['--hw' as string]: `${header}px` }}>
          <div className="tl-row ruler-row" style={{ height: RULER_H }}>
            <div className="tl-header corner" />
            <div className="ruler" onPointerDown={scrub} style={{ backgroundSize: `${(step * pps) / 5}px 100%` }}>
              {labels.map((t) => (
                <span key={t} className="tick" style={{ left: t * pps }}>
                  {fmtRuler(t)}
                </span>
              ))}
              {project.inPoint !== null && project.outPoint !== null && <div className="range" style={{ left: project.inPoint * pps, width: (project.outPoint - project.inPoint) * pps }} />}
              {project.inPoint !== null && <div className="marker in" title={t('tl.inMarker')} style={{ left: project.inPoint * pps }} />}
              {project.outPoint !== null && <div className="marker out" title={t('tl.outMarker')} style={{ left: project.outPoint * pps }} />}
            </div>
          </div>
          {project.tracks.map((t) => {
            const clips = project.clips.filter((c) => c.trackId === t.id);
            return (
              <div key={t.id} className={`tl-row kind-${t.kind}${t.muted ? ' is-muted' : ''}${t.hidden ? ' is-hidden' : ''}`} style={{ height: rowH[t.kind] }}>
                <div className="tl-header" dir={i18n.getLang() === 'he' ? 'rtl' : 'ltr'}>
                  <Icon name={t.captions ? 'captions' : t.kind === 'video' ? 'film' : t.kind === 'text' ? 'text' : 'music'} size={14} />
                  <span className="tl-name" title={trackName(t)}>
                    {trackName(t)}
                  </span>
                  <span className="tl-tools">
                    {t.kind !== 'audio' && (
                      <button className={'track-btn' + (t.hidden ? ' on' : '')} title={t.hidden ? i18n.t('tl.showTrack') : i18n.t('tl.hideTrack')} aria-pressed={!!t.hidden} onClick={() => store.run({ op: 'set_track', trackId: t.id, hidden: !t.hidden })}>
                        <Icon name={t.hidden ? 'eyeoff' : 'eye'} size={14} />
                      </button>
                    )}
                    {t.kind !== 'text' && (
                      <button className={'track-btn' + (t.muted ? ' on' : '')} title={t.muted ? i18n.t('tl.unmuteTrack') : i18n.t('tl.muteTrack')} aria-pressed={!!t.muted} onClick={() => store.run({ op: 'set_track', trackId: t.id, muted: !t.muted })}>
                        <Icon name={t.muted ? 'mute' : 'volume'} size={14} />
                      </button>
                    )}
                    {removable(t) && (
                      <button
                        className="track-btn"
                        title={i18n.t('tl.deleteTrack')}
                        onClick={() => {
                          const n = clips.length;
                          if (!n || window.confirm(i18n.t(n === 1 ? 'tl.deleteTrackConfirmOne' : 'tl.deleteTrackConfirmMany', { n }))) store.run({ op: 'delete_track', trackId: t.id });
                        }}
                      >
                        <Icon name="close" size={13} />
                      </button>
                    )}
                  </span>
                </div>
                <div
                  className="lane"
                  data-track-id={t.id}
                  onPointerDown={scrub}
                  onDragOver={(e) => {
                    if (!e.dataTransfer.types.includes('application/x-alon-media')) return;
                    e.preventDefault();
                    e.currentTarget.classList.add('drop-over');
                  }}
                  onDragLeave={(e) => e.currentTarget.classList.remove('drop-over')}
                  onDrop={(e) => dropMedia(e, t)}
                >
                  {!clips.length && (t.id === mainTrackId(project) || t.kind !== 'video') && (
                    <span className="lane-hint" style={{ left: Math.max(view.left, 0) + 12 }}>
                      {i18n.t(TRACK_HINT[t.kind])}
                    </span>
                  )}
                  {clips.map((c) => (
                    <ClipView key={c.id} clip={c} project={project} onDrag={dragClip} onMenu={openMenu} />
                  ))}
                </div>
              </div>
            );
          })}
          <Playhead scroller={scroller} header={header} />
        </div>
      </div>
      {menu && <ClipMenu menu={menu} close={() => setMenu(null)} />}
    </section>
  );
}
