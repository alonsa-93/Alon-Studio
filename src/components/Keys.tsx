import { useEffect, useState } from 'react';
import { api, useStore } from '../store';
import { Icon } from './Icon';
import { t } from '../i18n';

export interface KeyInfo {
  provider: string;
  label: string;
  use: string;
  hasKey: boolean;
  last4: string | null;
}

/**
 * One API key: a password field to save it, then only "saved, ends with 1234" and a remove button.
 * The key itself is never shown again or sent back by the server.
 */
export function KeyField({ provider, help, onChange, onLoad }: { provider: string; help?: React.ReactNode; onChange?: (k: KeyInfo) => void; onLoad?: (k: KeyInfo) => void }) {
  const [info, setInfo] = useState<KeyInfo | null>(null);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const s = useStore.getState();
  useEffect(() => {
    api<KeyInfo[]>('/api/keys')
      .then((list) => {
        const k = list.find((x) => x.provider === provider) ?? null;
        setInfo(k);
        if (k) onLoad?.(k);
      })
      .catch(() => setInfo(null));
  }, [provider]);
  const done = (k: KeyInfo) => {
    setInfo(k);
    setValue('');
    onChange?.(k);
  };
  const save = async () => {
    setBusy(true);
    try {
      done(await api<KeyInfo>(`/api/keys/${provider}`, { method: 'PUT', body: JSON.stringify({ key: value }) }));
      s.notify(t('keys.saved'));
    } catch (e) {
      s.notify((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!window.confirm(t('keys.deleteConfirm', { label: info?.label ?? provider }))) return;
    try {
      done(await api<KeyInfo>(`/api/keys/${provider}`, { method: 'DELETE' }));
    } catch (e) {
      s.notify((e as Error).message, 'error');
    }
  };
  if (!info) return null;
  return (
    <div className="key-field" data-testid={`key-${provider}`}>
      {info.hasKey ? (
        <div className="key-saved">
          <Icon name="check" size={16} />
          <span>
            {t('keys.savedPre', { label: info.label })}<bdi dir="ltr">{info.last4}</bdi>
          </span>
          <button className="icon-btn sm" title={t('keys.delete')} onClick={() => void remove()}>
            <Icon name="trash" size={14} />
          </button>
        </div>
      ) : (
        <>
          <div className="inline-form">
            <input type="password" dir="ltr" autoComplete="off" spellCheck={false} placeholder={t('keys.placeholder', { label: info.label })} value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && value.trim() && void save()} />
            <button className="btn" disabled={busy || !value.trim()} onClick={() => void save()}>
              {t('keys.save')}
            </button>
          </div>
          {help && <p className="hint">{help}</p>}
        </>
      )}
    </div>
  );
}
