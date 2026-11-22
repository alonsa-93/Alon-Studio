import { useEffect, useRef, useState } from 'react';
import type { Op } from '../../shared/ops';
import { api, fmtTime, useStore } from '../store';
import { Icon } from './Icon';
import { Slider } from './Inspector';
import { t } from '../i18n';

interface Plan {
  ranges: { start: number; end: number }[];
  removed: number;
  durationBefore: number;
  durationAfter: number;
  ops: Op[];
}

/** Silence removal: check first (nothing changes), then cut every silence in one undoable step. */
export function SilenceDialog() {
  const s = useStore.getState();
  const projectId = useStore((st) => st.project!.id);
  const rev = useStore((st) => st.project!.rev);
  const [threshold, setThreshold] = useState(-35);
  const [minSilence, setMinSilence] = useState(0.5);
  const [padding, setPadding] = useState(0.12);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const box = useRef<HTMLDivElement>(null);
  const close = () => useStore.getState().set({ silenceOpen: false });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
      // the keyboard stays inside the dialog
      if (e.key === 'Tab' && box.current) {
        const f = [...box.current.querySelectorAll<HTMLElement>('button:not(:disabled), input, select')];
        if (!f.length) return;
        const i = f.indexOf(document.activeElement as HTMLElement);
        if (e.shiftKey && i <= 0) (e.preventDefault(), f[f.length - 1].focus());
        else if (!e.shiftKey && i === f.length - 1) (e.preventDefault(), f[0].focus());
      }
    };
    window.addEventListener('keydown', onKey);
    box.current?.querySelector<HTMLElement>('button.primary')?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  // a changed setting or an edit makes the old check stale
  useEffect(() => setPlan(null), [threshold, minSilence, padding, rev]);

  const check = async () => {
    setBusy(true);
    setError('');
    try {
      setPlan(await api<Plan>(`/api/projects/${projectId}/silences`, { method: 'POST', body: JSON.stringify({ thresholdDb: threshold, minSilence, padding, dryRun: true }) }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const apply = () => {
    if (!plan?.ops.length) return;
    s.run(plan.ops);
    close();
    s.notify(t(plan.ranges.length === 1 ? 'sil.removedOne' : 'sil.removedMany', { n: plan.ranges.length, sec: plan.removed.toFixed(1) }), 'info', { label: t('act.undo'), run: () => useStore.getState().undo() });
  };

  return (
    <div className="modal-back" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={t('sil.title')} data-testid="silence-dialog" ref={box}>
        <div className="modal-head">
          <h3>{t('sil.title')}</h3>
          <button className="icon-btn" aria-label={t('top.close')} title={t('top.close')} onClick={close}>
            <Icon name="close" />
          </button>
        </div>
        <p className="muted small">{t('sil.intro')}</p>
        <Slider label={t('sil.threshold')} value={threshold} def={-35} min={-60} max={-20} step={1} fmt={(v) => `${v} dB`} onChange={setThreshold} />
        <Slider label={t('sil.minSilence')} value={minSilence} def={0.5} min={0.2} max={3} step={0.1} fmt={(v) => t('store.sec', { n: v.toFixed(1) })} onChange={setMinSilence} />
        <Slider label={t('sil.padding')} value={padding} def={0.12} min={0} max={0.5} step={0.01} fmt={(v) => t('store.sec', { n: v.toFixed(2) })} onChange={setPadding} />
        {error && <p className="error" dir="auto">{error}</p>}
        {plan && (
          <div className="silence-plan" data-testid="silence-plan">
            {plan.ranges.length ? (
              <>
                <b>
                  {t(plan.ranges.length === 1 ? 'sil.foundOne' : 'sil.foundMany', { n: plan.ranges.length, sec: plan.removed.toFixed(1) })}
                </b>
                <span className="muted small">
                  {t('sil.videoLength')} <bdi dir="ltr">{fmtTime(plan.durationBefore)}</bdi> {t('sil.arrow')} <bdi dir="ltr">{fmtTime(plan.durationAfter)}</bdi>
                </span>
                <ul>
                  {[...plan.ranges].reverse().slice(0, 30).map((r) => (
                    <li key={r.start}>
                      <button className="link-btn" onClick={() => (s.setPlaying(false), s.seek(r.start))}>
                        <bdi dir="ltr">
                          {fmtTime(r.start)}–{fmtTime(r.end)}
                        </bdi>
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <b>{t('sil.noneFound')}</b>
            )}
          </div>
        )}
        {plan?.ranges.length ? (
          <button className="btn primary wide lg" data-testid="silence-apply" onClick={apply}>
            {t(plan.ranges.length === 1 ? 'sil.deleteOne' : 'sil.deleteMany', { n: plan.ranges.length })}
          </button>
        ) : (
          <button className="btn primary wide lg" data-testid="silence-check" disabled={busy} onClick={check}>
            {busy ? t('sil.checking') : t('sil.check')}
          </button>
        )}
      </div>
    </div>
  );
}
