import { useEffect, useState } from 'react';
import { ApiPage } from './components/ApiPage';
import { Inspector } from './components/Inspector';
import { Library } from './components/Library';
import { Preview } from './components/Preview';
import { Timeline } from './components/Timeline';
import { cutInOut, deleteSelected, duplicateSelected, jumpKeyframe, splitAtPlayhead, toggleKeyframe } from './actions';
import { ExportDialog, TopBar } from './components/TopBar';
import { SilenceDialog } from './components/SilenceDialog';
import { useStore } from './store';
import { refreshFonts } from './fonts';
import { t, useLang } from './i18n';

let clipboardClip: string | null = null;

function useShortcuts() {
  useEffect(() => {
    // a mouse click on a button must not leave the keyboard focus on it: otherwise the next Space
    // "clicks" that button again (e.g. adds the clip twice) instead of playing the video
    const keepFocusOff = (e: MouseEvent) => {
      const b = (e.target as HTMLElement).closest('button, [role="button"]');
      // (draggable cards are left alone: cancelling mousedown would also cancel dragging them)
      if (b && !(e.target as HTMLElement).closest('input, select, textarea, [draggable="true"]')) e.preventDefault();
    };
    window.addEventListener('mousedown', keepFocusOff, true);
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      const typing = el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable || (el.tagName === 'INPUT' && !['range', 'checkbox', 'color'].includes((el as HTMLInputElement).type));
      const s = useStore.getState();
      if (!s.project || s.page !== 'editor' || s.exportOpen) return;
      const ctrl = e.ctrlKey || e.metaKey;
      // e.code keeps the shortcuts working with a Hebrew keyboard layout
      if (ctrl && e.code === 'KeyZ') {
        if (typing) return;
        e.preventDefault();
        if (e.shiftKey) s.redo();
        else s.undo();
        return;
      }
      if (ctrl && e.code === 'KeyY') {
        if (typing) return;
        e.preventDefault();
        s.redo();
        return;
      }
      if (ctrl && !typing && e.code === 'KeyD') {
        e.preventDefault();
        duplicateSelected();
        return;
      }
      if (ctrl && !typing && e.code === 'KeyC') {
        if (s.selected && !window.getSelection()?.toString()) {
          clipboardClip = s.selected;
          s.notify(t('app.copied'));
        }
        return;
      }
      if (ctrl && !typing && e.code === 'KeyV') {
        if (clipboardClip) {
          e.preventDefault();
          duplicateSelected(s.time, clipboardClip);
        }
        return;
      }
      if (typing || ctrl || e.altKey) return;
      // keys that belong to a focused control stay with it
      const control = el.tagName === 'INPUT';
      if (control && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Delete', 'Backspace', 'Space', 'Home', 'End'].includes(e.code)) return;
      if ((el.tagName === 'BUTTON' || el.tagName === 'A') && (e.code === 'Space' || e.code === 'Enter') && el.matches(':focus-visible')) return;
      const frame = 1 / s.project.settings.fps;
      switch (e.code) {
        case 'Space':
          e.preventDefault();
          (document.activeElement as HTMLElement | null)?.blur?.();
          s.setPlaying(!s.playing);
          break;
        case 'KeyS':
          splitAtPlayhead();
          break;
        case 'Delete':
        case 'Backspace':
          deleteSelected(e.shiftKey);
          break;
        case 'KeyI':
          s.run({ op: 'set_in_out', in: s.time });
          break;
        case 'KeyO':
          s.run({ op: 'set_in_out', out: s.time });
          break;
        case 'KeyX':
          cutInOut();
          break;
        case 'KeyK':
          if (e.shiftKey) jumpKeyframe(1);
          else toggleKeyframe();
          break;
        case 'KeyJ':
          if (e.shiftKey) jumpKeyframe(-1);
          break;
        case 'ArrowLeft':
          e.preventDefault();
          s.setPlaying(false);
          s.seek(s.time - (e.shiftKey ? 1 : frame));
          break;
        case 'ArrowRight':
          e.preventDefault();
          s.setPlaying(false);
          s.seek(s.time + (e.shiftKey ? 1 : frame));
          break;
        case 'Home':
          s.seek(0);
          break;
        case 'End':
          s.seek(Infinity);
          break;
        case 'Escape':
          s.select(null);
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', keepFocusOff, true);
    };
  }, []);
}

export function App() {
  const ready = useStore((s) => !!s.project);
  const page = useStore((s) => s.page);
  const exportOpen = useStore((s) => s.exportOpen);
  const silenceOpen = useStore((s) => s.silenceOpen);
  // a language switch re-renders the whole studio (the editor stays mounted)
  const lang = useLang((s) => s.lang);
  const [error, setError] = useState('');
  useShortcuts();
  useEffect(() => {
    useStore.getState().init().catch((e: Error) => setError(e.message));
    void refreshFonts();
  }, []);

  if (!ready)
    return (
      <div className="boot">
        {!error
          ? t('app.loading')
          : /access key|401/.test(error)
            ? t('app.noKey')
            : t('app.cantConnect', { error })}
      </div>
    );
  return (
    <div className="app" data-lang={lang}>
      <TopBar />
      {page === 'api' ? (
        <ApiPage />
      ) : (
        <>
          <div className="workspace">
            <Library />
            <Preview />
            <Inspector />
          </div>
          <Timeline />
        </>
      )}
      {exportOpen && <ExportDialog />}
      {silenceOpen && <SilenceDialog />}
    </div>
  );
}
