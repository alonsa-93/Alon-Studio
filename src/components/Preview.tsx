import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { entryOf, exitOf, freezeTail, graphemes, neighborsOf, typedCount, visualAt } from '../../shared/anim';
import { poseAt } from '../../shared/motion';
import { activeWord, captionTokens, colorFx, speedOf } from '../../shared/fx';
import { applyOp, projectDuration, textStyleOf, type Op } from '../../shared/ops';
import type { Clip, ClipFx, MediaAsset, Project } from '../../shared/types';
import { addMediaToTimeline, uploadFiles } from '../actions';
import { logoRect, slotOf, slotPx } from '../../shared/layout';
import { fmtTime, useStore } from '../store';
import { t } from '../i18n';
import { Icon } from './Icon';

/** Same numbers the ASS renderer uses on export, so the preview matches the MP4. */
const FONT_SCALE: Record<string, number> = { Arial: 1.117, 'Segoe UI': 1.33, Tahoma: 1.207, 'Times New Roman': 1.107, 'Courier New': 1.133, David: 1.0, Aharoni: 1.0, Gisha: 1.17 };
const outlineOf = (size: number) => Math.max(2, Math.round(size * 0.05));
const boxPadOf = (size: number) => Math.round(size * 0.22);

const mediaUrl = (m: MediaAsset) => `/media/${m.proxy ?? m.file}`;

function MediaLayer({ clip, media, project, z }: { clip: Clip; media: MediaAsset; project: Project; z: number }) {
  const ref = useRef<HTMLVideoElement & HTMLImageElement & HTMLAudioElement>(null);
  const nb = useMemo(() => neighborsOf(project, clip), [project, clip]);
  const track = project.tracks.find((t) => t.id === clip.trackId);
  const trackMuted = !!track?.muted;
  const trackHidden = !!track?.hidden;
  const fx = clip.fx ?? {};
  const color = colorFx(fx);
  const blur = fx.blur ?? 0;
  // a blur transition sets the whole blur as it runs (one blur, like the export), so the filter leaves it out
  const blurMotion = useMemo(() => [entryOf(clip), exitOf(clip, nb)].some((m) => m?.kind === 'blur'), [clip, nb]);
  const filterId = !color.identity || (blur > 0.2 && !blurMotion) ? `fx-${clip.id}` : null;
  // a layout slot (stack / side / pip): same rectangle as the export
  const slot = useMemo(() => slotOf(project, clip), [project, clip]);

  useEffect(() => {
    const apply = () => {
      const el = ref.current;
      if (!el) return;
      const { time, playing } = useStore.getState();
      const visual = clip.kind !== 'audio';
      const sp = speedOf(clip);
      const st = visualAt(clip, nb, time, true);
      const inRange = time >= clip.start && time < clip.start + clip.duration;
      if (visual) {
        const { width: W, height: H } = project.settings;
        const box = slot ? slotPx(slot, W, H) : null;
        const pose = poseAt(clip, time - clip.start);
        el.style.visibility = st.visible && !trackHidden ? 'visible' : 'hidden';
        el.style.opacity = String(st.opacity * pose.opacity);
        const rot = pose.rotation + st.rotation;
        el.style.transform = `translate(${(st.dx + pose.x) * W}px, ${(st.dy + pose.y) * H}px)${Math.abs(rot) > 0.01 ? ` rotate(${rot}deg)` : ''} scale(${st.scale * pose.scale})${fx.flip ? ' scaleX(-1)' : ''}`;
        const extra: string[] = [];
        const b = blurMotion ? (blur > 0.2 ? blur : 0) + st.blur : 0;
        if (b > 0.2) extra.push(`blur(${b}px)`);
        // toward white: invert, darken, invert back = c * (1 - w) + w (what ffmpeg's fade to white does)
        if (st.white > 0.001) extra.push(`invert(1) brightness(${1 - st.white}) invert(1)`);
        el.style.filter = [filterId ? `url(#${filterId})` : '', ...extra].filter(Boolean).join(' ');
        // wipe: only the revealed part of the picture (its own rect inside the frame) shows
        if (st.reveal && media.width && media.height) {
          // the element's own box: the frame, or its layout slot
          const EW = box ? box.w : W;
          const EH = box ? box.h : H;
          const k = fx.fit === 'cover' || box ? 0 : Math.min(EW / media.width, EH / media.height);
          const w = k ? media.width * k : EW;
          const h = k ? media.height * k : EH;
          const ox = (EW - w) / 2;
          const oy = (EH - h) / 2;
          const [x0, x1] = fx.flip ? [1 - st.reveal.x1, 1 - st.reveal.x0] : [st.reveal.x0, st.reveal.x1];
          el.style.clipPath = `inset(${oy + h * st.reveal.y0}px ${EW - ox - w * x1}px ${EH - oy - h * st.reveal.y1}px ${ox + w * x0}px)`;
        } else el.style.clipPath = '';
      }
      if (clip.kind === 'image') return;
      const local = Math.max(0, Math.min(time - clip.start, clip.duration - 0.02));
      const target = clip.offset + local * sp;
      if (el.playbackRate !== sp) el.playbackRate = sp;
      let vol = clip.volume;
      if (clip.fadeIn && local < clip.fadeIn) vol *= local / clip.fadeIn;
      if (clip.fadeOut && clip.duration - local < clip.fadeOut) vol *= Math.max(0, (clip.duration - local) / clip.fadeOut);
      el.volume = Math.max(0, Math.min(1, vol));
      el.muted = !inRange || clip.volume === 0 || trackMuted;
      if (inRange && playing) {
        if (Math.abs(el.currentTime - target) > 0.25 * Math.max(1, sp)) el.currentTime = target;
        if (el.paused) el.play().catch(() => {});
      } else {
        if (!el.paused) el.pause();
        const want = inRange || freezeTail(clip, nb) > 0 ? target : clip.offset;
        if ((inRange || st.visible || time < clip.start) && Math.abs(el.currentTime - want) > 0.03) el.currentTime = want;
      }
    };
    apply();
    return useStore.subscribe(apply);
  }, [clip, nb, project.settings.width, project.settings.height, trackMuted, trackHidden, filterId, blurMotion, blur, media.width, media.height, slot]);

  if (clip.kind === 'audio') return <audio ref={ref} src={mediaUrl(media)} preload="auto" />;
  const sb = slot ? slotPx(slot, project.settings.width, project.settings.height) : null;
  const style: React.CSSProperties = {
    zIndex: z,
    objectFit: fx.fit === 'cover' || sb ? 'cover' : 'contain',
    // `inset` first: it is a shorthand and would reset left / top after them
    ...(sb ? { inset: 'auto', left: sb.x, top: sb.y, width: sb.w, height: sb.h } : {}),
    filter: filterId ? `url(#${filterId})` : undefined,
    mixBlendMode: fx.blend && fx.blend !== 'normal' ? fx.blend : undefined,
  };
  const m = color.matrix;
  const c = color.contrast;
  return (
    <>
      {filterId && (
        <svg className="fx-defs" aria-hidden="true">
          <filter id={filterId} colorInterpolationFilters="sRGB" x="0" y="0" width="1" height="1">
            <feColorMatrix type="matrix" values={`${m[0]} ${m[1]} ${m[2]} 0 0 ${m[3]} ${m[4]} ${m[5]} 0 0 ${m[6]} ${m[7]} ${m[8]} 0 0 0 0 0 1 0`} />
            <feComponentTransfer>
              <feFuncR type="linear" slope={c} intercept={0.5 - 0.5 * c} />
              <feFuncG type="linear" slope={c} intercept={0.5 - 0.5 * c} />
              <feFuncB type="linear" slope={c} intercept={0.5 - 0.5 * c} />
            </feComponentTransfer>
            {blur > 0.2 && !blurMotion && <feGaussianBlur stdDeviation={blur} edgeMode="duplicate" />}
          </filter>
        </svg>
      )}
      {clip.kind === 'image' ? (
        <img ref={ref} className="layer" style={style} src={mediaUrl(media)} draggable={false} alt="" />
      ) : (
        <video ref={ref} className="layer" style={style} src={mediaUrl(media)} preload="auto" playsInline />
      )}
    </>
  );
}

function TextLayer({ clip, project, z, scale }: { clip: Clip; project: Project; z: number; scale: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const nb = useMemo(() => neighborsOf(project, clip), [project, clip]);
  const st = textStyleOf(project, clip);
  const selected = useStore((s) => s.selected === clip.id);
  const { width: W, height: H } = project.settings;
  const hidden = !!project.tracks.find((t) => t.id === clip.trackId)?.hidden;
  const tokens = useMemo(() => (clip.kind === 'caption' && st.highlight ? captionTokens(clip) : null), [clip, st.highlight]);
  // typewriter: every character in its own span, hidden until typed (it keeps its place, like the export)
  const typed = useMemo(() => {
    if (entryOf(clip)?.kind !== 'typewriter') return null;
    const parts = tokens ?? [{ text: clip.text ?? '', word: false }];
    let g = 0;
    let wi = -1;
    const nodes = parts.map((t, i) => {
      const chars = graphemes(t.text).map((ch) => (
        <span key={g} data-g={g++}>
          {ch}
        </span>
      ));
      return t.word ? (
        <span key={i} data-w={++wi}>
          {chars}
        </span>
      ) : (
        <Fragment key={i}>{chars}</Fragment>
      );
    });
    return { nodes, total: g };
  }, [clip, tokens]);

  useEffect(() => {
    const apply = () => {
      const el = ref.current;
      if (!el) return;
      const time = useStore.getState().time;
      const v = visualAt(clip, nb, time, false);
      el.style.visibility = v.visible && !hidden ? 'visible' : 'hidden';
      if (tokens && v.visible) {
        const active = activeWord(tokens, time - clip.start);
        el.querySelectorAll<HTMLElement>('[data-w]').forEach((sp) => {
          sp.style.color = Number(sp.dataset.w) === active ? st.highlight! : '';
        });
      }
      el.style.opacity = String(v.opacity);
      el.style.transform = `translate(-50%, -50%) translate(${v.dx * W}px, ${v.dy * H}px) scale(${v.scale})`;
      if (typed) {
        const shown = typedCount(typed.total, v.type);
        el.querySelectorAll<HTMLElement>('[data-g]').forEach((sp) => {
          sp.style.visibility = Number(sp.dataset.g) < shown ? '' : 'hidden';
        });
      }
    };
    apply();
    return useStore.subscribe(apply);
  }, [clip, nb, W, H, hidden, tokens, st.highlight, typed]);

  const onPointerDown = (e: React.PointerEvent) => {
    e.stopPropagation();
    const store = useStore.getState();
    store.select(clip.id);
    store.setPlaying(false);
    const start = { x: e.clientX, y: e.clientY };
    const proj = store.project!;
    let last: { x: number; y: number } | null = null;
    const move = (ev: PointerEvent) => {
      if (!last && Math.abs(ev.clientX - start.x) < 2 && Math.abs(ev.clientY - start.y) < 2) return;
      const x = Math.max(0, Math.min(1, st.x + (ev.clientX - start.x) / scale / W));
      const y = Math.max(0, Math.min(1, st.y + (ev.clientY - start.y) / scale / H));
      last = { x: Math.abs(x - 0.5) < 0.015 ? 0.5 : x, y };
      useStore.getState().preview(applyOp(proj, { op: 'update_clip', clipId: clip.id, patch: { style: last } }));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (last) useStore.getState().run({ op: 'update_clip', clipId: clip.id, patch: { style: last } });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // drag the corner handle: the text grows / shrinks with the distance from its centre
  const onResize = (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const r = ref.current!.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const d0 = Math.hypot(e.clientX - cx, e.clientY - cy) || 1;
    const proj = useStore.getState().project!;
    let size = st.size;
    const move = (ev: PointerEvent) => {
      size = Math.round(Math.max(16, Math.min(400, (st.size * Math.hypot(ev.clientX - cx, ev.clientY - cy)) / d0)));
      useStore.getState().preview(applyOp(proj, { op: 'update_clip', clipId: clip.id, patch: { style: { size } } }));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (size !== st.size) useStore.getState().run({ op: 'update_clip', clipId: clip.id, patch: { style: { size } } });
      else useStore.getState().preview(null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const o = outlineOf(st.size);
  return (
    <div
      ref={ref}
      className={'text-layer' + (selected ? ' selected' : '')}
      dir="auto"
      onPointerDown={onPointerDown}
      onDoubleClick={(e) => {
        e.stopPropagation();
        useStore.getState().startTextEdit(clip.id);
      }}
      title={t('pv.textHint')}
      style={{
        zIndex: z,
        left: st.x * W,
        top: st.y * H,
        fontFamily: `"${st.font}", Arial, sans-serif`,
        fontSize: st.size,
        lineHeight: FONT_SCALE[st.font] ?? 1.15,
        fontWeight: st.bold ? 700 : 400,
        color: st.color,
        ...(st.bg
          ? { background: st.bg, padding: boxPadOf(st.size) }
          : { WebkitTextStroke: `${o * 2}px ${st.outline ?? '#000000'}`, paintOrder: 'stroke fill' }),
      }}
    >
      {selected && clip.kind === 'text' && <span className="resize-handle" style={{ width: 16 / scale, height: 16 / scale, borderWidth: 2 / scale }} onPointerDown={onResize} title={t('pv.resizeHint')} />}
      {typed
        ? typed.nodes
        : tokens
        ? (() => {
            let wi = -1;
            return tokens.map((t, i) => (t.word ? <span key={i} data-w={++wi}>{t.text}</span> : t.text));
          })()
        : clip.text}
    </div>
  );
}

/** Where a video / image clip sits on the stage (project pixels), from its fit, size and position. */
function clipRect(p: Project, clip: Clip, local: number): { x: number; y: number; w: number; h: number } | null {
  const m = p.media.find((x) => x.id === clip.mediaId);
  if (!m?.width || !m.height) return null;
  const { width: W, height: H } = p.settings;
  const fx: ClipFx = clip.fx ?? {};
  const pose = poseAt(clip, local);
  const slot = slotOf(p, clip);
  if (slot) {
    const b = slotPx(slot, W, H);
    const w = b.w * pose.scale;
    const h = b.h * pose.scale;
    return { x: b.x + b.w / 2 + pose.x * W - w / 2, y: b.y + b.h / 2 + pose.y * H - h / 2, w, h };
  }
  const k = (fx.fit === 'cover' ? Math.max(W / m.width, H / m.height) : Math.min(W / m.width, H / m.height)) * pose.scale;
  const w = m.width * k;
  const h = m.height * k;
  return { x: W / 2 + pose.x * W - w / 2, y: H / 2 + pose.y * H - h / 2, w, h };
}

/** Selection frame on the stage for the selected video / image: drag to move, corner to resize. */
function PictureFrame({ clip, project, scale }: { clip: Clip; project: Project; scale: number }) {
  const keyed = !!clip.keyframes?.length;
  // with keyframes the frame follows the motion, and a drag sets a keyframe at the playhead
  const time = useStore((s) => (keyed ? s.time : 0));
  const local = Math.max(0, Math.min(clip.duration, time - clip.start));
  const r = clipRect(project, clip, local);
  if (!r) return null;
  const { width: W, height: H } = project.settings;
  const fx: ClipFx = clip.fx ?? {};
  const pose = poseAt(clip, local);
  const opOf = (patch: Partial<ClipFx>): Op =>
    keyed
      ? { op: 'set_keyframe', clipId: clip.id, t: Math.round(local * 1000) / 1000, ...(patch.posX !== undefined ? { x: patch.posX, y: patch.posY } : {}), ...(patch.scale !== undefined ? { scale: patch.scale } : {}) }
      : { op: 'set_fx', clipId: clip.id, fx: patch };
  const drag = (e: React.PointerEvent, mode: 'move' | 'scale') => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const s = useStore.getState();
    s.setPlaying(false);
    const proj = s.project!;
    const x0 = e.clientX;
    const y0 = e.clientY;
    const box = (e.currentTarget as HTMLElement).closest('.stage')!.getBoundingClientRect();
    const cx = box.left + (r.x + r.w / 2) * scale;
    const cy = box.top + (r.y + r.h / 2) * scale;
    const d0 = Math.hypot(x0 - cx, y0 - cy) || 1;
    let patch: Partial<ClipFx> | null = null;
    const move = (ev: PointerEvent) => {
      if (!patch && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 3) return;
      if (mode === 'move') {
        let px = pose.x + (ev.clientX - x0) / scale / W;
        let py = pose.y + (ev.clientY - y0) / scale / H;
        // snap back to the centre
        if (Math.abs(px) < 0.02) px = 0;
        if (Math.abs(py) < 0.02) py = 0;
        patch = { posX: Math.round(px * 1000) / 1000, posY: Math.round(py * 1000) / 1000 };
      } else {
        let sc = (pose.scale * Math.hypot(ev.clientX - cx, ev.clientY - cy)) / d0;
        if (Math.abs(sc - 1) < 0.04) sc = 1;
        patch = { scale: Math.round(Math.max(0.2, Math.min(3, sc)) * 100) / 100 };
      }
      useStore.getState().preview(applyOp(proj, opOf(patch)));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (patch) useStore.getState().run(opOf(patch));
      else useStore.getState().preview(null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const hs = 16 / scale;
  // a picture that fills the frame is bigger than the stage: keep the frame and its handles on screen
  const vx = Math.max(0, r.x);
  const vy = Math.max(0, r.y);
  const vw = Math.min(W, r.x + r.w) - vx;
  const vh = Math.min(H, r.y + r.h) - vy;
  const corners: [string, number, number][] = [
    ['tl', 0, 0],
    ['tr', 1, 0],
    ['bl', 0, 1],
    ['br', 1, 1],
  ];
  return (
    <div
      className="pic-frame"
      title={t('pv.visualHint')}
      style={{ left: vx, top: vy, width: vw, height: vh, borderWidth: 2 / scale }}
      onPointerDown={(e) => drag(e, 'move')}
      onDoubleClick={() => useStore.getState().run({ op: 'set_fx', clipId: clip.id, fx: { fit: fx.fit === 'cover' ? 'contain' : 'cover', scale: 1, posX: 0, posY: 0 } })}
    >
      {corners.map(([k, x, y]) => (
        <span key={k} className="pic-handle" style={{ width: hs, height: hs, left: `calc(${x * 100}% - ${x ? hs : 0}px)`, top: `calc(${y * 100}% - ${y ? hs : 0}px)`, borderWidth: 2 / scale }} onPointerDown={(e) => drag(e, 'scale')} />
      ))}
    </div>
  );
}

/** The bar that offers to match the frame to the first video. */
function FormatPrompt() {
  const fp = useStore((s) => s.formatPrompt);
  const project = useStore((s) => s.project)!;
  if (!fp) return null;
  const s = useStore.getState();
  const close = () => s.set({ formatPrompt: null });
  const visuals = project.clips.filter((c) => c.kind === 'video' || c.kind === 'image');
  const target = fp.orientation === 'landscape' ? '16:9' : fp.orientation === 'portrait' ? '9:16' : '1:1';
  const frameName = project.settings.aspect === '9:16' ? t('pv.frameVertical') : project.settings.aspect === '16:9' ? t('pv.frameHorizontal') : project.settings.aspect === '4:5' ? t('pv.framePost') : t('pv.square');
  const clipName = fp.orientation === 'landscape' ? t('pv.landscape') : fp.orientation === 'portrait' ? t('pv.portrait') : t('pv.square');
  return (
    <div className="format-prompt" role="dialog" aria-label={t('pv.formatDialog')}>
      <span>
        {t('pv.formatA')}<b>{clipName}</b>{t('pv.formatB')}<b>{frameName}</b>{t('pv.formatC')}
      </span>
      <div className="btn-row">
        <button className="btn primary sm" onClick={() => (s.run(visuals.map((c) => ({ op: 'set_fx', clipId: c.id, fx: { fit: 'cover' } }) as Op)), close())}>
          {t('pv.fillFrame')}
        </button>
        <button className="btn sm" onClick={() => (s.run({ op: 'set_aspect', aspect: target }), close())}>
          {t('pv.changeFormat')}<bdi dir="ltr">{target}</bdi>
        </button>
        <button className="btn ghost sm" onClick={close}>
          {t('pv.keepBars')}
        </button>
      </div>
    </div>
  );
}

/** The project logo, where the export puts it (same rectangle, same opacity). */
function LogoLayer({ project }: { project: Project }) {
  const logo = project.logo;
  const m = logo ? project.media.find((x) => x.id === logo.mediaId) : undefined;
  if (!logo || !m) return null;
  const { width: W, height: H } = project.settings;
  const r = logoRect(logo, W, H, m.width && m.height ? m.width / m.height : 1);
  return <img className="logo-layer" data-testid="logo-layer" src={mediaUrl(m)} alt="" draggable={false} style={{ left: r.x, top: r.y, width: r.w, height: r.h, opacity: logo.opacity }} />;
}

function EmptyStage() {
  const input = useRef<HTMLInputElement>(null);
  const uploading = useStore((s) => s.uploading);
  const media = useStore((s) => s.project!.media);
  const firstVisual = media.find((m) => m.kind !== 'audio');
  return (
    <div className="stage-empty">
      <span className="empty-icon">
        <Icon name="upload" size={26} />
      </span>
      <b>{uploading ? t('pv.uploading') : t('pv.dropHere')}</b>
      <span>{t('pv.goesToTimeline')}</span>
      <div className="btn-row">
        <button className="btn primary" disabled={uploading} onClick={() => input.current?.click()}>
          {t('pv.chooseFile')}
        </button>
        {firstVisual && (
          <button className="btn" onClick={() => addMediaToTimeline(firstVisual)}>
            {t('pv.useMedia', { name: firstVisual.name.slice(0, 22) })}
          </button>
        )}
      </div>
      <input
        ref={input}
        type="file"
        hidden
        multiple
        accept="video/*,image/*,audio/*"
        onChange={(e) => {
          if (e.target.files?.length) void uploadFiles(e.target.files);
          e.target.value = '';
        }}
      />
    </div>
  );
}

function Toast() {
  const toast = useStore((s) => s.toast);
  if (!toast) return null;
  return (
    <div className={`toast ${toast.kind}`} role="status">
      <Icon name={toast.kind === 'error' ? 'info' : 'check'} size={16} />
      <span>{toast.text}</span>
      {toast.action && (
        <button
          className="toast-action"
          onClick={() => {
            toast.action!.run();
            useStore.getState().set({ toast: null });
          }}
        >
          {toast.action.label}
        </button>
      )}
    </div>
  );
}

export function Preview() {
  const project = useStore((s) => s.project)!;
  const playing = useStore((s) => s.playing);
  const time = useStore((s) => s.time);
  const selectedId = useStore((s) => s.selected);
  const boxRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.2);
  const [dropping, setDropping] = useState(false);
  const { width: W, height: H } = project.settings;
  const duration = projectDuration(project);

  useLayoutEffect(() => {
    const el = boxRef.current!;
    const fit = () => setScale(Math.max(0.02, Math.min((el.clientWidth - 24) / W, (el.clientHeight - 24) / H)));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [W, H]);

  // playback clock
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const s = useStore.getState();
      const total = s.project ? projectDuration(s.project) : 0;
      const t = s.time + (now - last) / 1000;
      last = now;
      if (s.stopAt !== null && t >= s.stopAt) {
        s.set({ time: Math.min(s.returnTo, total), playing: false, stopAt: null });
        return;
      }
      if (t >= total) {
        s.set({ time: total, playing: false, stopAt: null });
        return;
      }
      s.set({ time: t });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  // only mount media elements near the playhead
  const bucket = Math.floor(time / 2);
  const near = useMemo(() => {
    const t = bucket * 2;
    return project.clips.filter((c) => c.kind !== 'text' && c.kind !== 'caption' && c.start < t + 6 && c.start + c.duration > t - 3);
  }, [project.clips, bucket]);
  const texts = useMemo(() => {
    const t = bucket * 2;
    return project.clips.filter((c) => (c.kind === 'text' || c.kind === 'caption') && c.start < t + 4 && c.start + c.duration > t - 2);
  }, [project.clips, bucket]);
  const zOf = (c: Clip) => (project.tracks.length - project.tracks.findIndex((t) => t.id === c.trackId)) * 10;
  const s = useStore.getState();
  const selected = project.clips.find((c) => c.id === selectedId);
  const showFrame = !!selected && (selected.kind === 'video' || selected.kind === 'image') && time >= selected.start - 0.002 && time < selected.start + selected.duration && !playing;

  /** A click on the picture selects the top-most video / image shown at that spot. */
  const pickAt = (e: React.PointerEvent) => {
    const st = useStore.getState();
    const p = st.project!;
    const t = st.time;
    const stage = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const px = (e.clientX - stage.left) / scale;
    const py = (e.clientY - stage.top) / scale;
    const order = (c: Clip) => p.tracks.findIndex((tr) => tr.id === c.trackId);
    const hit = p.clips
      .filter((c) => (c.kind === 'video' || c.kind === 'image') && t >= c.start - 0.002 && t < c.start + c.duration && !p.tracks.find((tr) => tr.id === c.trackId)?.hidden)
      .sort((a, b) => order(a) - order(b))
      .find((c) => {
        const r = clipRect(p, c, t - c.start);
        return r && px >= Math.max(0, r.x) && px <= Math.min(p.settings.width, r.x + r.w) && py >= Math.max(0, r.y) && py <= Math.min(p.settings.height, r.y + r.h);
      });
    st.select(hit?.id ?? null);
  };

  return (
    <section
      className={'preview' + (dropping ? ' dropping' : '')}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        setDropping(true);
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setDropping(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDropping(false);
        if (e.dataTransfer.files.length) void uploadFiles(e.dataTransfer.files);
      }}
    >
      <FormatPrompt />
      <div className="stage-box" data-testid="stage" ref={boxRef} onPointerDown={(e) => e.target === e.currentTarget && s.select(null)}>
        {duration === 0 ? (
          <EmptyStage />
        ) : (
          <div className="stage-fit" style={{ width: W * scale, height: H * scale }}>
            <div className="stage" style={{ width: W, height: H, transform: `scale(${scale})`, background: project.background ?? '#000' }} onPointerDown={pickAt}>
              {near.map((c) => {
                const m = project.media.find((x) => x.id === c.mediaId);
                return m ? <MediaLayer key={c.id} clip={c} media={m} project={project} z={zOf(c)} /> : null;
              })}
              {texts.map((c) => (
                <TextLayer key={c.id} clip={c} project={project} z={zOf(c) + 1000} scale={scale} />
              ))}
              <LogoLayer project={project} />
              {showFrame && <PictureFrame clip={selected!} project={project} scale={scale} />}
            </div>
          </div>
        )}
        <Toast />
      </div>
      <div className="transport" data-testid="transport">
        <div className="inout">
          <span className="stage-meta" dir="ltr" title={t('pv.resFps')}>
            {project.settings.width}×{project.settings.height} · {project.settings.fps}fps
          </span>
          <button className={'chip' + (project.inPoint !== null ? ' on' : '')} title={t('pv.markInTitle')} disabled={duration <= 0} onClick={() => s.run({ op: 'set_in_out', in: useStore.getState().time })}>
            <Icon name="marker" size={12} /> {t('pv.in')} {project.inPoint !== null && <bdi dir="ltr">{fmtTime(project.inPoint)}</bdi>}
          </button>
          <button className={'chip' + (project.outPoint !== null ? ' on' : '')} title={t('pv.markOutTitle')} disabled={duration <= 0} onClick={() => s.run({ op: 'set_in_out', out: useStore.getState().time })}>
            <Icon name="marker" size={12} /> {t('pv.out')} {project.outPoint !== null && <bdi dir="ltr">{fmtTime(project.outPoint)}</bdi>}
          </button>
          {(project.inPoint !== null || project.outPoint !== null) && (
            <button className="tiny-btn" title={t('pv.clearMarks')} onClick={() => s.run({ op: 'set_in_out', in: null, out: null })}>
              <Icon name="close" size={13} />
            </button>
          )}
        </div>
        <div className="transport-main" dir="ltr">
          <button className="icon-btn" title={t('pv.toStartTitle')} aria-label={t('pv.toStart')} onClick={() => s.seek(0)}>
            <Icon name="start" size={20} />
          </button>
          <button className="play-btn" data-testid="play" title={t('pv.playTitle')} aria-label={playing ? t('pv.pause') : t('pv.play')} disabled={duration <= 0} onClick={() => s.setPlaying(!playing)}>
            <Icon name={playing ? 'pause' : 'play'} size={22} />
          </button>
          <button className="icon-btn" title={t('pv.toEndTitle')} aria-label={t('pv.toEnd')} onClick={() => s.seek(duration)}>
            <Icon name="end" size={20} />
          </button>
        </div>
        <div className="timecode" data-testid="timecode">
          <bdi dir="ltr">
            <b>{fmtTime(time)}</b>
            <span> / {fmtTime(duration)}</span>
          </bdi>
        </div>
      </div>
    </section>
  );
}
