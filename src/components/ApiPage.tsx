import { useEffect, useState } from 'react';
import { accessKey } from '../key';
import { useStore } from '../store';
import { Icon } from './Icon';
import { t, type Key } from '../i18n';

function Code({ children, label }: { children: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="code" dir="ltr">
      {label && <div className="code-label">{label}</div>}
      <pre>{children}</pre>
      <button
        className="copy"
        title={t('api.copy')}
        onClick={() => {
          navigator.clipboard.writeText(children).then(
            () => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            },
            () => useStore.getState().notify(t('api.copyBlocked'), 'error'),
          );
        }}
      >
        {copied ? t('api.copied') : <Icon name="copy" size={15} />}
      </button>
    </div>
  );
}

const ENDPOINTS: [string, string, Key][] = [
  ['GET', '/api/projects', 'api.epProjects'],
  ['POST', '/api/projects', 'api.epCreate'],
  ['GET', '/api/projects/:id/summary', 'api.epSummary'],
  ['POST', '/api/projects/:id/ops', 'api.epOps'],
  ['POST', '/api/projects/:id/media', 'api.epUpload'],
  ['POST', '/api/projects/:id/media/import', 'api.epImportPath'],
  ['POST', '/api/projects/:id/captions', 'api.epCaptions'],
  ['POST', '/api/projects/:id/captions/translate', 'api.epTranslate'],
  ['GET', '/api/projects/:id/captions.srt', 'api.epSrt'],
  ['GET', '/api/library/sfx', 'api.epSfx'],
  ['POST', '/api/projects/:id/media/library', 'api.epSfxAdd'],
  ['POST', '/api/projects/:id/silences', 'api.epSilences'],
  ['POST', '/api/projects/:id/export', 'api.epExport'],
  ['GET', '/api/export-presets', 'api.epPresets'],
  ['GET', '/api/templates', 'api.epTemplates'],
  ['POST', '/api/projects/:id/template', 'api.epTemplateSave'],
  ['DELETE', '/api/templates/:id', 'api.epTemplateDelete'],
  ['GET', '/api/fonts', 'api.epFonts'],
  ['POST', '/api/fonts', 'api.epFontsUpload'],
  ['POST', '/api/fonts/google', 'api.epFontsGoogle'],
  ['DELETE', '/api/fonts/:family', 'api.epFontDelete'],
  ['GET', '/api/keys', 'api.epKeys'],
  ['PUT', '/api/keys/:provider', 'api.epKeySave'],
  ['DELETE', '/api/keys/:provider', 'api.epKeyDelete'],
  ['GET', '/api/ai/settings', 'api.epAiSettings'],
  ['PUT', '/api/ai/settings', 'api.epAiSettingsPut'],
  ['GET', '/api/ai/models', 'api.epModels'],
  ['GET', '/api/voice/voices', 'api.epVoices'],
  ['GET', '/api/voice/voices/:id/preview', 'api.epVoicePreview'],
  ['POST', '/api/projects/:id/speak', 'api.epSpeak'],
  ['POST', '/api/projects/:id/clone-voice', 'api.epClone'],
  ['GET', '/api/projects/:id/agent', 'api.epAgent'],
  ['POST', '/api/projects/:id/agent', 'api.epAgentPost'],
  ['POST', '/api/projects/:id/agent/approve', 'api.epAgentApprove'],
  ['POST', '/api/projects/:id/agent/cancel', 'api.epAgentCancel'],
  ['POST', '/api/projects/:id/agent/stop', 'api.epAgentStop'],
  ['DELETE', '/api/projects/:id/agent', 'api.epAgentClear'],
  ['GET', '/api/stock/providers', 'api.epStockProviders'],
  ['GET', '/api/stock/search', 'api.epStockSearch'],
  ['POST', '/api/projects/:id/media/stock', 'api.epStockImport'],
  ['POST', '/api/projects/:id/media/url', 'api.epUrlImport'],
  ['GET', '/api/projects/:id/credits', 'api.epCredits'],
  ['GET', '/api/jobs/:jobId', 'api.epJob'],
  ['GET', '/api/projects/:id/events', 'api.epEvents'],
  ['POST', '/mcp', 'api.epMcp'],
];

const OPS: [string, string, Key][] = [
  ['cut_range', '{ start, end, ripple? }', 'api.opCutRange'],
  ['split', '{ time, clipId? }', 'api.opSplit'],
  ['delete', '{ clipId, ripple? }', 'api.opDelete'],
  ['add_text', '{ text, start?, duration?, preset?, style? }', 'api.opAddText'],
  ['add_transition', '{ clipId, type, duration? }', 'api.opAddTransition'],
  ['add_music', '{ mediaId, start?, volume?, duration? }', 'api.opAddMusic'],
  ['set_aspect', '{ aspect }', 'api.opSetAspect'],
  ['add_clip', '{ mediaId, start?, trackId? }', 'api.opAddClip'],
  ['move_clip', '{ clipId, start, trackId? }', 'api.opMoveClip'],
  ['trim_clip', '{ clipId, start, duration, offset? }', 'api.opTrimClip'],
  ['update_clip', '{ clipId, patch: { text?, style?, volume?, fadeIn?, fadeOut? } }', 'api.opUpdateClip'],
  ['set_animation', '{ clipId, in?: { type, duration }, out?: {...} }', 'api.opSetAnimation'],
  ['set_settings', '{ name?, fps?, width?, height? }', 'api.opSetSettings'],
  ['set_caption_style', '{ preset?, style?: { font?, size?, color?, bg?, bold?, x?, y? } }', 'api.opSetCaptionStyle'],
  ['set_title_font', '{ font: string | null }', 'api.opSetTitleFont'],
  ['set_captions', '{ captions: [{ start, end, text }] }', 'api.opSetCaptions'],
  ['set_in_out', '{ in?, out? }', 'api.opSetInOut'],
  ['add_track / delete_track', '{ kind } / { trackId }', 'api.opTracks'],
  ['remove_media', '{ mediaId }', 'api.opRemoveMedia'],
  ['set_fx', '{ clipId, fx: { look?, brightness?, contrast?, saturation?, temperature?, blur?, fit?, scale?, posX?, posY?, opacity?, flip?, rotation?, blend? } }', 'api.opSetFx'],
  ['set_speed', '{ clipId, speed, ripple? }', 'api.opSetSpeed'],
  ['duplicate', '{ clipId, start? }', 'api.opDuplicate'],
  ['detach_audio', '{ clipId }', 'api.opDetachAudio'],
  ['set_track', '{ trackId, muted?, hidden?, name? }', 'api.opSetTrack'],
  ['set_caption_animation', '{ type, duration? }', 'api.opSetCaptionAnimation'],
  ['set_keyframe', '{ clipId, t, x?, y?, scale?, rotation?, opacity?, ease? }', 'api.opSetKeyframe'],
  ['delete_keyframe / clear_keyframes', '{ clipId, t } / { clipId }', 'api.opDeleteKeyframe'],
  ['punch_in', '{ clipId, start, end, x, y, scale }', 'api.opPunchIn'],
  ['insert_clip', '{ mediaId, time, trackId? }', 'api.opInsertClip'],
  ['move_clip_to_new_track', '{ clipId, position: above | below }', 'api.opMoveToNewTrack'],
  ['set_layout', '{ layout: single | stack | side | pip }', 'api.opSetLayout'],
  ['set_logo', '{ logo: { mediaId?, corner?, size?, opacity?, margin? } | null }', 'api.opSetLogo'],
];

const TOOLS = ['get_summary', 'cut_range', 'split', 'delete', 'add_text', 'add_transition', 'add_music', 'add_sound_effect', 'set_effect', 'set_speed', 'set_aspect', 'set_keyframe', 'delete_keyframe', 'punch_in', 'insert_clip', 'move_clip_to_new_track', 'set_animation', 'remove_silences', 'set_layout', 'set_logo', 'save_template', 'list_templates', 'set_caption_style', 'set_title_font', 'list_fonts', 'add_google_font', 'search_stock', 'import_stock', 'import_url', 'generate_captions', 'get_captions', 'translate_captions', 'list_voices', 'speak', 'clone_voice', 'export', 'import_media', 'add_clip', 'move_clip', 'trim_clip', 'update_clip', 'duplicate_clip', 'ripple_delete', 'detach_audio', 'add_track', 'set_track', 'delete_track', 'set_settings', 'set_in_out', 'set_captions', 'set_caption_animation', 'remove_media', 'apply_ops', 'job_status', 'list_projects', 'create_project'];

export function ApiPage() {
  const project = useStore((s) => s.project)!;
  const [health, setHealth] = useState<{ ffmpeg: string | null; whisper: boolean; whisperModel: string } | null>(null);
  const [ACCESS_KEY, setKey] = useState(t('api.keyPlaceholder'));
  useEffect(() => {
    fetch('/api/health').then((r) => r.json()).then(setHealth).catch(() => {});
    accessKey().then((k) => k && setKey(k)).catch(() => {});
  }, []);
  const base = window.location.origin;
  const id = project.id;
  return (
    <main className="api-page">
      <div className="api-inner">
        <button className="btn ghost" onClick={() => useStore.getState().set({ page: 'editor' })}>{t('api.back')}</button>
        <h1>{t('api.titlePre')} <span dir="ltr">API / MCP</span></h1>
        <p className="lead">{t('api.lead')}</p>

        <h2>{t('api.claudeCode')}</h2>
        <Code>{`claude mcp add --transport http alon-studio ${base}/mcp --header "Authorization: Bearer ${ACCESS_KEY}"`}</Code>
        <p className="muted">{t('api.keyWarning')}</p>
        <p>{t('api.claudeExample')}</p>
        <div className="tool-list" dir="ltr">
          {TOOLS.map((t) => (
            <code key={t}>{t}</code>
          ))}
        </div>

        <h2>{t('api.status')}</h2>
        <ul className="status">
          <li className={health?.ffmpeg ? 'ok' : 'bad'}>
            <b dir="ltr">ffmpeg</b> <span dir="ltr">{health ? health.ffmpeg ?? t('api.notInPath') : '...'}</span>
          </li>
          <li className={health?.whisper ? 'ok' : 'bad'}>
            <b dir="ltr">faster-whisper</b> {health ? (health.whisper ? <span>{t('api.whisperInstalled')} <span dir="ltr">{health.whisperModel}</span></span> : t('api.whisperMissing')) : '...'}
          </li>
          <li className="ok">
            <b>{t('api.openProject')}</b> <span dir="ltr">{id}</span> <span className="muted">{t('api.currentHint')}</span>
          </li>
        </ul>

        <h2>{t('api.endpoints')}</h2>
        <table>
          <tbody>
            {ENDPOINTS.map(([m, p, d]) => (
              <tr key={m + p}>
                <td>{t(d)}</td>
                <td dir="ltr"><span className={`method ${m}`}>{m}</span> <code>{p}</code></td>
              </tr>
            ))}
          </tbody>
        </table>

        <h2>{t('api.examples')}</h2>
        <Code label={t('api.exSummary')}>{`curl -H "Authorization: Bearer ${ACCESS_KEY}" ${base}/api/projects/${id}/summary`}</Code>
        <Code label={t('api.exCut')}>{`curl -H "Authorization: Bearer ${ACCESS_KEY}" -X POST ${base}/api/projects/${id}/ops \\\n  -H "Content-Type: application/json" \\\n  -d '{"op":"cut_range","start":2,"end":5}'`}</Code>
        <Code label={t('api.exBatch')}>{`curl -H "Authorization: Bearer ${ACCESS_KEY}" -X POST ${base}/api/projects/${id}/ops \\\n  -H "Content-Type: application/json" \\\n  -d '{"ops":[{"op":"set_aspect","aspect":"9:16"},{"op":"add_text","text":"${t('api.exHello')}","start":0,"duration":3}]}'`}</Code>
        <Code label={t('api.exCaptions')}>{`curl -H "Authorization: Bearer ${ACCESS_KEY}" -X POST ${base}/api/projects/${id}/captions \\\n  -H "Content-Type: application/json" -d '{"language":"he"}'`}</Code>
        <Code label={t('api.exExport')}>{`curl -H "Authorization: Bearer ${ACCESS_KEY}" -X POST ${base}/api/projects/${id}/export \\\n  -H "Content-Type: application/json" -d '{"quality":"high"}'\ncurl ${base}/api/jobs/<jobId>`}</Code>

        <h2>{t('api.ops')} <span dir="ltr">(ops)</span></h2>
        <table>
          <tbody>
            {OPS.map(([name, params, d]) => (
              <tr key={name}>
                <td>{t(d)}</td>
                <td dir="ltr"><code className="op">{name}</code> <code className="dim">{params}</code></td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted">{t('api.opsFooter')}</p>
      </div>
    </main>
  );
}
