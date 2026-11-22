/**
 * Security checks against a running studio (use a disposable instance):
 *   BASE_URL=http://localhost:5186 ALON_ACCESS_KEY=<key> ALON_DATA_DIR=<its data folder> npx tsx scripts/security-tests.ts <some.mp4>
 * Each check sends ordinary requests and verifies the protection answers as designed.
 */
import fs from 'node:fs';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { KEY } from './auth.mjs';

const BASE = process.env.BASE_URL ?? 'http://localhost:5173';
const PORT = new URL(BASE).port;
const MEDIA = process.argv[2];
let failures = 0;
const check = (ok: unknown, msg: string) => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${msg}`);
};
type Init = RequestInit & { noKey?: boolean };
const req = async (url: string, init: Init = {}) => {
  const r = await fetch(BASE + url, init as RequestInit);
  const text = await r.text();
  return { status: r.status, headers: r.headers, text };
};
const json = (body: unknown, extra: Record<string, string> = {}): Init => ({ method: 'POST', headers: { 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(body) });

console.log('access key');
for (const u of ['/api/projects', '/api/health', '/api/library/sfx', '/api/keys', '/api/fonts', '/api/stock/providers']) check((await req(u, { noKey: true })).status === 401, `no key -> 401 on ${u}`);
check((await req('/mcp', { ...json({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { Accept: 'application/json, text/event-stream' }), noKey: true })).status === 401, 'no key -> 401 on /mcp');
// the AI routes are checked without the key in regress.ts (gate 2): more refusals here would trip the lockout
check((await req('/api/projects', { noKey: true, headers: { authorization: 'Bearer ' + 'a'.repeat(64) } })).status === 401, 'wrong key -> 401');
check((await req('/api/projects?key=' + KEY, { noKey: true })).status === 401, 'key in the URL query is not accepted (it would end up in history / logs)');
check((await req('/api/projects')).status === 200, 'right key -> 200');
const mcp = await req('/mcp', json({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { Accept: 'application/json, text/event-stream' }));
check(mcp.status === 200 && mcp.text.includes('readOnlyHint') && mcp.text.includes('destructiveHint'), 'MCP with key works and marks read-only / destructive tools');
const page = await req('/', { noKey: true });
check(page.status === 200 && !page.text.includes(KEY), 'the app page does not contain the key');

console.log('origin');
const evil = async (headers: Record<string, string>) => (await req('/api/projects', { headers })).status;
check((await evil({ Origin: 'http://localhost:8099' })) === 403, 'another localhost port is refused (403)');
check((await evil({ Origin: 'https://evil.example' })) === 403, 'a foreign site is refused (403)');
check((await evil({ Origin: 'null' })) === 403, 'Origin: null is refused (403)');
check((await evil({ 'Sec-Fetch-Site': 'same-site' })) === 403, 'a request started by another localhost page (Sec-Fetch-Site: same-site) is refused');
check((await evil({ 'Sec-Fetch-Site': 'cross-site' })) === 403, 'a cross-site request is refused');
// fetch() never sends a custom Host header, so this one goes out as a raw HTTP request
const hostStatus = await new Promise<number>((resolve) => {
  const r = http.request({ host: '127.0.0.1', port: Number(PORT), path: '/api/projects', headers: { Host: 'evil.example', Authorization: `Bearer ${KEY}` } }, (res) => {
    res.resume();
    resolve(res.statusCode ?? 0);
  });
  r.on('error', () => resolve(0));
  r.end();
});
check(hostStatus === 403, `a foreign Host header (DNS rebinding) is refused (${hostStatus})`);
check((await evil({ Origin: `http://localhost:${PORT}` })) === 200, 'the app\'s own origin is accepted');

console.log('security headers');
for (const u of ['/', '/api/projects', '/media/none.mp4']) {
  const r = await req(u);
  const h = r.headers;
  const okHeaders = !!h.get('content-security-policy') && h.get('x-content-type-options') === 'nosniff' && h.get('x-frame-options') === 'DENY' && h.get('referrer-policy') === 'no-referrer' && h.get('cross-origin-resource-policy') === 'same-origin' && !h.get('x-powered-by');
  check(okHeaders, `headers on ${u} (CSP, nosniff, frame denial, referrer, CORP; no X-Powered-By)`);
}
check(/no-store/.test((await req('/media/none.mp4')).headers.get('cache-control') ?? '') && /no-store/.test((await req('/api/projects')).headers.get('cache-control') ?? ''), 'media and API answers are not kept in the browser disk cache (no-store)');
check(/frame-ancestors 'none'/.test((await req('/')).headers.get('content-security-policy') ?? ''), "the app cannot be framed (frame-ancestors 'none')");

console.log('files');
check((await req('/media/x.mp4', { noKey: true })).status === 401, 'media files need the key / cookie');
check((await req('/library/fonts/f_abcdef12.ttf', { noKey: true })).status === 401 && (await req('/library/stock-thumb/x', { noKey: true })).status === 401, 'font files and stock thumbnails need the key / cookie');
// fonts: only f_*.ttf / .otf are served; the index, the keys file or a path never are
for (const u of ['/library/fonts/fonts.json', '/library/fonts/..%2fapi-keys.json', '/library/fonts/..%5capi-keys.json', '/library/fonts/%2e%2e/access-key', '/library/fonts/f_abcdef12.ttf.json'])
  if ((await req(u)).status !== 404) check(false, `not served: ${u}`);
check(true, 'the fonts folder serves font files only (no index, no path)');
check((await req(`/api/fonts/${encodeURIComponent('../api-keys')}`, { method: 'DELETE' })).status === 404, 'deleting a font by a path deletes nothing');
// API keys: never come back; only for the known providers
const keyPut = await req('/api/keys/pexels', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'sec-test-key-ABCD9876' }) });
check(keyPut.status === 200 && !keyPut.text.includes('sec-test-key') && JSON.parse(keyPut.text).last4 === '9876', 'a saved key is answered with its last 4 characters only');
check(!(await req('/api/keys')).text.includes('sec-test-key') && !(await req('/api/stock/providers')).text.includes('sec-test-key'), 'no API answer contains the key');
check((await req('/api/keys/__proto__', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'abcdefghijkl' }) })).status === 404, 'only known providers take a key');
const { redact } = await import('../server/security');
const { secretValues } = await import('../server/security');
secretValues.add('sec-test-key-ABCD9876');
check(!redact('calling with sec-test-key-ABCD9876 now').includes('sec-test-key'), 'saved keys are cut out of log lines');
await req('/api/keys/pexels', { method: 'DELETE' });
const proj = JSON.parse((await req('/api/projects', json({ name: 'security test' }))).text);
const imp = (p: string) => req(`/api/projects/${proj.id}/media/import`, json({ path: p }));
check((await imp('C:\\Windows\\win.ini')).status === 403, 'import of a system file is refused');
check((await imp('C:\\Windows\\System32\\drivers\\etc\\hosts')).status === 403, 'import of hosts file is refused');
check((await imp('\\\\127.0.0.1\\c$\\Windows\\win.ini')).status === 403, 'network (UNC) paths are refused');
check((await imp(path.join(os.homedir(), 'notes.txt'))).status === 403, 'non-media files are refused even in the user folders');
check((await imp(path.join(os.homedir(), '..', '..', 'Windows', 'win.ini'))).status === 403, 'path traversal out of the user folder is refused');
// templates: an id is only ever a template file name, never a path
check((await req(`/api/templates/${encodeURIComponent('..\\projects\\' + proj.id)}`, { method: 'DELETE' })).status === 404, 'a template id with a path deletes nothing');
check((await req(`/api/projects`, json({ name: 'x', templateId: '../projects/' + proj.id }))).status === 404, 'a template id with a path opens nothing');
// import from a link: never this computer or the local network
for (const u of ['http://127.0.0.1:' + PORT + '/api/projects', 'http://localhost:' + PORT + '/', 'http://[::ffff:127.0.0.1]:' + PORT + '/', 'http://0x7f000001:' + PORT + '/', 'http://2130706433:' + PORT + '/']) {
  const r = await req(`/api/projects/${proj.id}/media/url`, json({ url: u }));
  if (r.status === 200) {
    const jid = JSON.parse(r.text).jobId;
    let job;
    for (let i = 0; i < 50; i++) {
      job = JSON.parse((await req(`/api/jobs/${jid}`)).text);
      if (job.status !== 'running') break;
      await new Promise((ok) => setTimeout(ok, 100));
    }
    if (job.status !== 'error' || !/נחסם/.test(job.error)) check(false, `blocked: ${u} (${job.status} ${job.error})`);
  } else if (r.status !== 400) check(false, `blocked: ${u} (${r.status})`);
}
check(true, 'import from a link refuses this computer in every spelling (127.0.0.1, localhost, mapped IPv6, hex, decimal)');
check((await req(`/api/projects/${proj.id}`)).status === 200, 'the project is still there');
check((await req(`/api/projects/${proj.id}/export`, json({ preset: { width: 99999 } }))).status === 400, 'an export preset is only a name from the list');
if (MEDIA) check((await imp(path.resolve(MEDIA))).status === 200, 'a video in the user folders can be imported');
check((await req(`/api/projects/${proj.id}/captions`, json({ language: 'he', model: 'C:\\models\\evil' }))).status === 400, 'transcription model must be one of the known sizes');
check((await req('/api/exports/reveal', json({ file: '..\\..\\..\\Windows\\win.ini' }))).status === 400, '"open folder" accepts only files inside the exports folder');

console.log('malformed input');
const p0 = JSON.parse((await req(`/api/projects/${proj.id}`)).text);
const put = await req(`/api/projects/${proj.id}`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ ...p0, media: [{ id: 'm_evil0001', file: '..\\..\\outside.mp4', kind: 'video', duration: 3, name: 'x', hasAudio: false }], clips: [] }),
});
const after = JSON.parse((await req(`/api/projects/${proj.id}`)).text);
check(put.status === 200 && !after.media.some((m: { file: string }) => m.file.includes('..')), 'undo state cannot add a media entry that points outside the media folder');
const bad = await req(`/api/projects/${proj.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...p0, clips: [null] }) });
check(bad.status === 400, 'a broken undo state is rejected (400)');
const fontInj = await req(`/api/projects/${proj.id}/ops`, json({ op: 'add_text', text: 'x', style: { font: 'Arial\\fs500}{\\pos(1,1)' } }));
check(fontInj.status === 400, 'a font name with subtitle tags is rejected');
for (const junk of ['not json', '{"op":', '[]', '{"op":"split","time":"abc"}', '{"op":"__proto__"}', '{"ops":[{"op":"delete","clipId":{"$ne":1}}]}']) {
  const r = await req(`/api/projects/${proj.id}/ops`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: junk });
  check(r.status >= 400 && r.status < 500, `junk input "${junk.slice(0, 30)}" -> ${r.status}`);
}
check((await req('/api/projects')).status === 200, 'the server is still healthy after malformed input');
// single operations get the same strict check as a whole undo state
const opReq = (o: unknown) => req(`/api/projects/${proj.id}/ops`, json(o));
check((await opReq({ op: 'add_track', kind: 'audio', name: { evil: 1 } })).status === 400, 'a track name that is not text is rejected');
await opReq({ op: 'add_text', text: 'x', id: 'clipA', start: 0, duration: 4 });
check((await opReq({ op: 'split', time: 2, clipId: 'clipA', newIds: { clipA: 'clipA' } })).status === 400, 'a split that would duplicate a clip id is rejected');
check((await opReq({ op: 'split', time: 2, clipId: 'clipA', newIds: { clipA: { x: 1 } } })).status === 400, 'a split with a non-text clip id is rejected');
await opReq({ op: 'add_text', text: 'y'.repeat(300_000), id: 'longT' });
const longT = JSON.parse((await req(`/api/projects/${proj.id}`)).text).clips.find((c: { id: string }) => c.id === 'longT');
check(!longT || longT.text.length <= 2000, `very long text is cut to a sane length (${longT?.text.length})`);
check((await opReq({ op: 'set_fx', clipId: 'clipA', fx: { look: 'z'.repeat(50_000) } })).status === 400, 'an absurd fx look is rejected');
const p1 = JSON.parse((await req(`/api/projects/${proj.id}`)).text);
const ghost = await req(`/api/projects/${proj.id}`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ ...p1, media: [...p1.media, { id: 'm_ghost001', file: 'm_ghost001.mp4', kind: 'video', duration: 3, name: 'g', hasAudio: false }], clips: [...p1.clips, { id: 'gclip', trackId: p1.tracks.find((t: { kind: string }) => t.kind === 'video').id, kind: 'video', mediaId: 'm_ghost001', start: 0, duration: 2, offset: 0, volume: 1 }] }),
});
check(ghost.status === 400, `an undo state that refers to a missing media file is rejected (${ghost.status})`);
check((await imp(path.join(os.homedir(), 'Videos', 'a.mp4:hidden'))).status === 403, 'alternate data streams (file.mp4:stream) are refused');
check((await req('/api/exports/reveal', json({ file: { a: 1 } }))).status === 400, '"open folder" with a non-text name -> 400');
check(/no-store/.test((await req('/API/projects')).headers.get('cache-control') ?? ''), 'no-store also on upper-case paths');

console.log('one-time window link');
const tok = JSON.parse((await req('/api/session/token', { method: 'POST' })).text).token as string;
const redeem = (t: unknown) => fetch(BASE + '/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json', authorization: '' }, body: JSON.stringify({ token: t }) } as RequestInit);
const r1 = await redeem(tok);
const cookie = r1.headers.get('set-cookie') ?? '';
check(r1.status === 200 && cookie.includes(KEY) && /HttpOnly/i.test(cookie) && /SameSite=Strict/i.test(cookie), 'a fresh window link is traded once for the HttpOnly key cookie');
check((await redeem(tok)).status === 401, 'a used window link is worthless');
check((await redeem('c'.repeat(48))).status === 401, 'a made-up window link is refused');
const cookieOnly = await fetch(BASE + '/api/projects', { headers: { authorization: '', cookie: cookie.split(';')[0] } } as RequestInit);
check(cookieOnly.status === 200, 'the cookie alone opens the API (reloads keep working)');
// second launch: challenge-response, the key itself never travels
const hm = (label: string, n: string) => crypto.createHmac('sha256', KEY).update(`${label}:${n}`).digest('hex');
const nonce = crypto.randomBytes(24).toString('hex');
const ch = JSON.parse((await req('/api/session/challenge', { ...json({ nonce }), noKey: true })).text);
check(ch.proof === hm('server', nonce), 'the running studio proves it knows the key before a second launch trusts it');
const badProof = await req('/api/session/proof', { ...json({ challenge: ch.challenge, proof: crypto.createHmac('sha256', 'x'.repeat(64)).update(`client:${ch.challenge}`).digest('hex') }), noKey: true });
check(badProof.status === 401, 'a launch proof made without the key is refused');
const ch2 = JSON.parse((await req('/api/session/challenge', { ...json({ nonce }), noKey: true })).text);
const good = JSON.parse((await req('/api/session/proof', { ...json({ challenge: ch2.challenge, proof: hm('client', ch2.challenge) }), noKey: true })).text);
check(/^[a-f0-9]{48}$/.test(good.token ?? ''), 'a correct launch proof gets a window link');
check((await req('/api/session/proof', { ...json({ challenge: ch2.challenge, proof: hm('client', ch2.challenge) }), noKey: true })).status === 401, 'a launch challenge works only once');

if (process.env.ALON_DATA_DIR) {
  console.log('damaged project files');
  const pd = path.join(process.env.ALON_DATA_DIR, 'projects');
  fs.writeFileSync(path.join(pd, 'p_broken01.json'), '{}');
  fs.writeFileSync(path.join(pd, 'p_broken02.json'), '{"id":');
  check((await req('/api/projects')).status === 200, 'a damaged project file does not break the project list');
  check((await req('/api/projects/p_broken01')).status === 409, 'a project file with the wrong shape is reported as damaged (409)');
  const d1 = await req('/api/projects/p_broken01', { method: 'DELETE' });
  const d2 = await req('/api/projects/p_broken02', { method: 'DELETE' });
  check(d1.status === 200 && d2.status === 200 && !fs.existsSync(path.join(pd, 'p_broken01.json')) && !fs.existsSync(path.join(pd, 'p_broken02.json')), 'damaged project files can be deleted');
}

console.log('wrong-key lockout');
for (let i = 0; i < 22; i++) await req('/api/projects', { noKey: true, headers: { authorization: `Bearer ${'b'.repeat(64)}` } });
const locked = await req('/api/projects', { noKey: true, headers: { authorization: `Bearer ${'b'.repeat(64)}` } });
check(locked.status === 429, `after many wrong keys, wrong keys are refused outright (${locked.status})`);
check((await req('/api/projects')).status === 200, 'the real window (right key) keeps working during the lockout');
check((await req('/media/x.mp4', { noKey: true, headers: { authorization: `Bearer ${'b'.repeat(64)}` } })).status === 429, 'the lockout covers media files too');
const lockTok = JSON.parse((await req('/api/session/token', { method: 'POST' })).text).token;
const lockRedeem = await fetch(BASE + '/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json', authorization: '' }, body: JSON.stringify({ token: lockTok }) } as RequestInit);
check(lockRedeem.status === 200, `a valid window link still opens the studio during the lockout (${lockRedeem.status})`);

console.log('secrets');
const dataDir = process.env.ALON_DATA_DIR;
if (dataDir && fs.existsSync(path.join(dataDir, 'studio.log'))) check(!fs.readFileSync(path.join(dataDir, 'studio.log'), 'utf8').includes(KEY), 'the key never appears in the log');
const keyFile = dataDir ? path.join(dataDir, 'access-key') : '';
if (keyFile && fs.existsSync(keyFile) && process.platform === 'win32') {
  // icacls lists one "account:(rights)" entry per line; "(I)" marks permissions inherited from the folder
  const acl = execFileSync('icacls', [keyFile]).toString().split(/\r?\n/).map((l) => l.replace(keyFile, '').trim()).filter((l) => l.includes(':('));
  check(acl.length === 1 && !acl[0].includes('(I)'), `the key file is readable by this Windows account only (${acl.join(' | ')})`);
}
const projFile = dataDir ? path.join(dataDir, 'projects', `${proj.id}.json`) : '';
if (projFile && fs.existsSync(projFile)) check(!fs.readFileSync(projFile, 'utf8').includes(KEY), 'the key never appears in project files');
const srcDir = path.resolve('src');
const sinks = fs
  .readdirSync(srcDir, { recursive: true })
  .map(String)
  .filter((f) => /\.(tsx?|jsx?)$/.test(f))
  .filter((f) => /dangerouslySetInnerHTML|\.innerHTML\s*=|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function\(/.test(fs.readFileSync(path.join(srcDir, f), 'utf8')));
check(sinks.length === 0, 'the interface code has no HTML / code injection sinks' + (sinks.length ? `: ${sinks.join(', ')}` : ''));

await req(`/api/projects/${proj.id}`, { method: 'DELETE' });
console.log(failures ? `\n${failures} FAILED` : '\nALL GOOD');
process.exit(failures ? 1 : 0);
