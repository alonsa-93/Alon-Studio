/**
 * Uses the studio the way a person does, in a real Edge browser: real mouse clicks on what is on screen,
 * real typing, real playback. Every step checks what the user would SEE (the screen / the player), not only
 * what the server stored, and saves screenshots for a human-style visual review.
 *
 *   npx tsx scripts/ui/user-journey.mjs <baseUrl> <video.mp4> <music.mp3> <outDir> [width] [height]
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { launch } from './driver.mjs';
import { KEY } from '../auth.mjs';

const [BASE = 'http://localhost:5182', VIDEO, MUSIC, OUT = 'ui-out', WIDTH = '1440', HEIGHT = '900'] = process.argv.slice(2);
// the outside services (stock) answer from a local mock; the test instance points at it (scripts/test-server.mjs)
fs.mkdirSync(OUT, { recursive: true });
const mockPic = path.resolve(OUT, 'mock-pic.png');
execFileSync(process.env.FFMPEG_PATH ?? 'ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x3366cc:s=320x180', '-frames:v', '1', mockPic]);
const { startMock } = await import('../mock-providers.ts');
const mock = await startMock(5191, { 'pic.png': { type: 'image/png', body: fs.readFileSync(mockPic) } });
// UI_LANG=en runs the same journey in English: every label it clicks is looked up in src/i18n.ts by its Hebrew
const LANG = process.env.UI_LANG === 'en' ? 'en' : 'he';
const { STRINGS } = await import('../../src/i18n.ts');
const english = new Map();
for (const [he, en] of Object.values(STRINGS)) if (!english.has(he)) english.set(he, en);
/** The label as the UI shows it in the language of this run. */
const T = (he) => {
  if (LANG === 'he') return he;
  if (!english.has(he)) throw new Error('user-journey: no English for ' + he);
  return english.get(he);
};
/** For a piece of a longer label: the Hebrew piece, or the English piece. */
const X = (he, en) => (LANG === 'he' ? he : en);
const results = [];
let shot = 0;
const b = await launch({ width: Number(WIDTH), height: Number(HEIGHT), port: Number(process.env.CDP_PORT ?? 9333) });
const S = (name) => b.screenshot(path.join(OUT, `${String(++shot).padStart(2, '0')}-${name}.png`));
const ok = (cond, msg) => {
  results.push(`${cond ? 'ok  ' : 'FAIL'} ${msg}`);
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`);
  return cond;
};
async function step(name, fn) {
  try {
    await fn();
  } catch (e) {
    ok(false, `${name}: ${e.message}`);
    await S('error-' + name.replace(/[^a-z0-9]+/gi, '_')).catch(() => {});
  }
}
const sleep = b.sleep;
const project = () => b.eval(`fetch('/api/projects/' + localStorage.getItem('alon.project')).then((r) => r.json())`);
const timecode = () => b.eval(`document.querySelector('[data-testid=timecode] b').textContent`);
/** "m:ss.t" -> seconds */
const secs = (tc) => {
  const [m, rest] = tc.split(':');
  return Number(m) * 60 + Number(rest);
};
const toast = () => b.eval(`document.querySelector('.toast')?.textContent ?? ''`);
const tab = (label) => b.click('[data-testid=library-tabs] button', label);
const visibleVideo = `[...document.querySelectorAll('.stage video')].find((v) => v.style.visibility === 'visible')`;
const videoClips = async () => (await project()).clips.filter((c) => c.kind === 'video').sort((a, c) => a.start - c.start);
/** Click on the ruler at a timeline time. */
async function seekTo(t) {
  await measurePps(); // the zoom changes (auto-fit), so measure every time
  await b.eval(`(document.querySelector('.tl-scroll').scrollLeft = 0, true)`);
  await sleep(50);
  // (not b.box: its scrollIntoView would scroll a ruler that is wider than the screen)
  const r = await b.eval(`(() => { const r = document.querySelector('.ruler').getBoundingClientRect(); return { left: r.left, top: r.top }; })()`);
  await b.clickAt(r.left + t * (await b.eval('window.__pps')), r.top + 10);
  await sleep(300);
}
async function measurePps() {
  const p = await project();
  const v = p.clips.filter((c) => c.kind === 'video').sort((a, c) => a.start - c.start)[0];
  const w = await b.eval(`[...document.querySelectorAll('.clip.k-video')].map((e) => e.getBoundingClientRect().width)[0]`);
  await b.eval(`(window.__pps = ${w} / ${v.duration}, true)`);
}

await step('open the studio', async () => {
  // like the launcher: a one-time window link, never the key itself
  const { token } = await (await fetch(`${BASE}/api/session/token`, { method: 'POST' })).json();
  await b.goto(`${BASE}/#t=${token}`);
  await b.waitFor(`!!document.querySelector('[data-testid=topbar]')`);
  ok(await b.eval(`document.title === 'ALON.ai Studio'`), 'studio opens from a one-time window link');
  ok(await b.eval(`location.hash === ''`), 'the window link is removed from the address bar');
  ok(!(await b.eval(`JSON.stringify(Object.assign({}, sessionStorage, localStorage))`)).includes(KEY), 'the access key is not kept in the window storage');
  await b.eval(`(location.reload(), true)`);
  await new Promise((r) => setTimeout(r, 1500));
  await b.waitFor(`!!document.querySelector('[data-testid=topbar]')`);
  ok(await b.eval(`!document.querySelector('.boot-error, .boot .error')`), 'a reload keeps working (cookie)');
});

await step('interface language', async () => {
  const doc = () => b.eval(`document.documentElement.lang + ' ' + document.documentElement.dir`);
  if (LANG === 'he') {
    ok((await doc()) === 'he rtl', 'Hebrew, right to left');
    return;
  }
  ok((await b.eval(`document.querySelector('[data-testid=lang-toggle]').textContent.trim()`)) === 'EN', 'the top bar offers EN');
  await b.click('[data-testid=lang-toggle]');
  await sleep(400);
  ok((await doc()) === 'en ltr', 'EN switches the page to English, left to right');
  const tabs = await b.eval(`document.querySelector('[data-testid=library-tabs]').textContent`);
  ok(tabs.includes('Media') && !/[֐-׿]/.test(tabs), 'the library tabs are in English: ' + tabs);
  const side = await b.eval(`(() => { const l = document.querySelector('[data-testid=library]') ?? document.querySelector('.library'); const i = document.querySelector('[data-testid=inspector]'); return l && i ? Math.sign(i.getBoundingClientRect().left - l.getBoundingClientRect().left) : 0; })()`);
  ok(side === 1, 'in English the library is on the left and the inspector on the right');
  await b.eval(`(location.reload(), true)`);
  await sleep(1500);
  await b.waitFor(`!!document.querySelector('[data-testid=topbar]')`);
  ok((await doc()) === 'en ltr' && (await b.eval(`document.querySelector('[data-testid=lang-toggle]').textContent.trim()`)) === 'עב', 'English is kept after a reload, and the switch now offers עב');
  await S('english');
});

await step('new project from the project menu', async () => {
  await b.click('[data-testid=project-menu]');
  await b.click('.menu button', T('סרטון חדש'));
  await sleep(900);
  const name = await b.eval(`document.querySelector('[data-testid=project-menu]').textContent`);
  ok(name.includes(T('פרויקט חדש')), 'new project created: ' + name);
  ok(await b.eval(`!!document.querySelector('.stage-empty .btn.primary')`), 'empty project shows a big "choose a file" call to action on the player');
  ok(await b.eval(`document.querySelector('[data-testid=export-open]').disabled`), 'export is disabled while there is nothing to export');
  await S('empty-project');
});

await step('upload: first video lands on the timeline by itself', async () => {
  await b.setFiles('.stage-empty input[type=file]', [VIDEO]);
  await b.waitFor(`document.querySelectorAll('.clip.k-video').length === 1`, 60000);
  ok(true, 'the uploaded video was put on the timeline without any extra click');
  await sleep(1200);
  const v = await b.eval(`(() => { const v = ${visibleVideo}; return v ? { ready: v.readyState, w: v.videoWidth } : null; })()`);
  ok(v && v.ready >= 2 && v.w > 0, 'the video frame is shown in the player');
  ok(await b.eval(`!!document.querySelector('.format-prompt')`), 'landscape clip in a portrait project: the app offers to fit the format');
  await S('format-prompt');
  await b.click('.format-prompt .btn', T('למלא את המסגרת'));
  await sleep(500);
  ok(await b.eval(`[...document.querySelectorAll('.stage video')].some((v) => v.style.objectFit === 'cover')`), '"fill the frame" fills the vertical frame');
  await measurePps();
});

await step('space plays right after clicking a button (no double add)', async () => {
  await tab(T('מדיה'));
  const before = (await videoClips()).length;
  await b.key(' ');
  await sleep(1500);
  const playing = await b.eval(`(() => { const v = ${visibleVideo}; return v ? !v.paused : false; })()`);
  await b.key(' ');
  ok(playing, 'space starts playback after a button was clicked');
  ok((await videoClips()).length === before, 'space did not "click" the last button again');
});

await step('cut out a middle part with split + delete: no black gap', async () => {
  await b.click('[data-testid=stage]');
  await seekTo(5);
  await b.key('s');
  await seekTo(8);
  await b.key('s');
  await sleep(300);
  ok((await videoClips()).length === 3, 'S cuts the video under the playhead (nothing selected)');
  const p0 = await project();
  const total0 = Math.max(...p0.clips.map((c) => c.start + c.duration));
  await seekTo(6.5);
  const mid = await b.box('.clip.k-video:nth-of-type(2)').catch(() => null);
  await b.eval(`(() => { const c = [...document.querySelectorAll('.clip.k-video')].sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)[1]; const r = c.getBoundingClientRect(); window.__mid = { x: r.left + r.width / 2, y: r.top + r.height / 2 }; return true; })()`);
  const m = await b.eval('window.__mid');
  await b.clickAt(m.x, m.y);
  await b.key('Delete');
  await sleep(500);
  const clips = await videoClips();
  const gapFree = clips.length === 2 && Math.abs(clips[1].start - (clips[0].start + clips[0].duration)) < 0.02;
  const p1 = await project();
  const total1 = Math.max(...p1.clips.map((c) => c.start + c.duration));
  ok(gapFree, `Delete closes the gap (parts at ${clips.map((c) => c.start.toFixed(2)).join(', ')})`);
  ok(Math.abs(total0 - total1 - 3) < 0.1, `video is 3 s shorter (${total0.toFixed(1)} -> ${total1.toFixed(1)})`);
  ok((await toast()).includes(T('הקטע נמחק והסרטון התחבר מחדש')) && (await b.eval(`!!document.querySelector('.toast-action')`)), 'a toast confirms the delete with an undo button');
  await S('after-delete');
  await b.click('.toast-action');
  await sleep(500);
  ok((await videoClips()).length === 3, 'the toast\'s undo brings the part back');
  await b.key('y', { ctrl: true });
  await sleep(400);
  ok((await videoClips()).length === 2, 'Ctrl+Y re-applies the delete');
  await measurePps();
});

await step('right-click menu on a clip', async () => {
  const c = await b.box('.clip.k-video');
  await b.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: c.x, y: c.y, button: 'right', buttons: 2, clickCount: 1 });
  await b.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: c.x, y: c.y, button: 'right', buttons: 0, clickCount: 1 });
  await sleep(300);
  const items = await b.eval(`[...document.querySelectorAll('.menu.context button')].map((x) => x.textContent.trim())`);
  ok(items.length >= 3 && items.some((t) => t.includes(T('מחיקה'))), 'right-click shows a menu: ' + items.join(' | '));
  await S('context-menu');
  await b.key('Escape');
  await sleep(200);
});

await step('move and resize the video on the player', async () => {
  await b.click('[data-testid=stage]');
  await seekTo(1);
  const st = await b.box('.stage');
  await b.clickAt(st.x, st.y);
  await sleep(300);
  ok(await b.eval(`!!document.querySelector('.pic-frame')`), 'clicking the picture selects the video and shows a frame with handles');
  await b.eval(`(() => { const s = document.querySelector('.stage'); return true; })()`);
  await b.drag(st.x, st.y, st.x + 30, st.y, 10);
  await sleep(400);
  let v = (await videoClips())[0];
  ok(Math.abs(v.fx?.posX ?? 0) > 0.03, 'dragging the picture moves it (posX ' + (v.fx?.posX ?? 0) + ')');
  const h = await b.box('.pic-handle');
  await b.drag(h.x, h.y, h.x - 25, h.y - 25, 10);
  await sleep(400);
  v = (await videoClips())[0];
  ok(Math.abs((v.fx?.scale ?? 1) - 1) > 0.05, 'dragging a corner resizes it (scale ' + (v.fx?.scale ?? 1) + ')');
  await S('picture-frame');
  await b.key('z', { ctrl: true });
  await b.key('z', { ctrl: true });
  await sleep(300);
});

await step('transition from the library', async () => {
  await b.click('[data-testid=stage]');
  await seekTo(6);
  await tab(T('מעברים'));
  await b.click('.tab-body .row-item', T('זום'));
  await sleep(250);
  ok(secs(await timecode()) < 6, `the player jumps to the transition to show it (at ${await timecode()})`);
  await sleep(2600);
  ok(await b.eval(`!!document.querySelector('.clip.k-video .fx-zone.in')`), 'the transition is marked on the clip');
});

await step('filter on every part of the video', async () => {
  await tab(T('פילטרים'));
  await b.click('.look', T('שחור-לבן'));
  await sleep(400);
  const btn = await b.eval(`[...document.querySelectorAll('.tab-body .btn')].some((x) => x.textContent.includes(${JSON.stringify(X('כל', 'Apply to all'))}))`);
  ok(btn, 'after a split, "apply to all parts" is offered');
  await b.click('.tab-body .btn', X('כל', 'Apply to all'));
  await sleep(400);
  const looks = (await videoClips()).map((c) => c.fx?.look);
  ok(looks.every((l) => l === 'bw'), 'the filter is on every part: ' + looks.join(','));
  await S('filter-all');
});

await step('animation toggles', async () => {
  await tab(T('אנימציה'));
  const grids = await b.eval(`document.querySelectorAll('.tab-body .chip-grid').length`);
  ok(grids === 2, 'in / out animation groups shown');
  await b.eval(`(() => { const g = document.querySelectorAll('.tab-body .chip-grid')[0]; [...g.querySelectorAll('.chip-btn')].find((x) => x.textContent.includes(${JSON.stringify(T('פופ'))})).click(); return true; })()`);
  await sleep(500);
  ok((await project()).clips.some((c) => c.animIn?.type === 'pop'), 'pop entry animation added');
  await sleep(2500);
});

await step('title: add, type, resize on the player, set how long it stays', async () => {
  await b.click('[data-testid=stage]');
  await seekTo(1);
  await tab(T('טקסט'));
  await b.click('.tab-body .row-item', T('כותרת ראשית'));
  await sleep(500);
  ok(await b.eval(`document.activeElement?.tagName === 'TEXTAREA'`), 'the text box is ready for typing right after choosing a style');
  await b.type('שלום לכולם');
  await sleep(500);
  ok(await b.eval(`[...document.querySelectorAll('.text-layer')].some((e) => e.textContent === 'שלום לכולם' && e.style.visibility === 'visible')`), 'typed Hebrew title shows on the player');
  const t0 = (await project()).clips.find((c) => c.text === 'שלום לכולם');
  const h = await b.box('.resize-handle');
  await b.drag(h.x, h.y, h.x + 40, h.y + 30, 10);
  await sleep(400);
  const t1 = (await project()).clips.find((c) => c.text === 'שלום לכולם');
  ok(t1.style.size > t0.style.size, `the corner handle resizes the text (${t0.style.size} -> ${t1.style.size})`);
  ok(await b.eval(`[...document.querySelectorAll('[data-testid=inspector] .slider-row span')].some((s) => s.textContent.includes(${JSON.stringify(T('כמה זמן על המסך'))}))`), 'the panel offers "how long on screen"');
  await S('title');
});

await step('music: one click, the right defaults', async () => {
  await b.click('[data-testid=stage]');
  await tab(T('סאונד'));
  await b.setFiles('.tab-body input[type=file]', [MUSIC]);
  await b.waitFor(`[...document.querySelectorAll('.tab-body .row-item')].some((r) => r.textContent.includes('music'))`, 30000);
  await b.click('.tab-body .row-item', 'music');
  await sleep(600);
  const p = await project();
  const music = p.clips.find((c) => c.kind === 'audio');
  const videoEnd = Math.max(...p.clips.filter((c) => c.kind === 'video').map((c) => c.start + c.duration));
  const end = Math.min(videoEnd, p.media.find((m) => m.id === music?.mediaId)?.duration ?? videoEnd); // a short song ends on its own
  ok(music && music.start === 0 && Math.abs(music.duration - end) < 0.05 && music.volume === 0.4 && music.fadeOut > 0, `music: from 0, ends with the video, 40%, fades out (${music?.start}, ${music?.duration}/${end.toFixed(2)}, ${music?.volume}, ${music?.fadeOut})`);
  await b.eval(`(() => { const r = [...document.querySelectorAll('.tab-body .slider')].find((s) => s.textContent.includes(${JSON.stringify(T('עוצמת המוזיקה בסרטון'))})).querySelector('input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(r, '0.2'); r.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await sleep(500);
  ok((await project()).clips.find((c) => c.kind === 'audio').volume === 0.2, 'the music volume slider changes the music already in the video');
  ok(await b.eval(`document.querySelectorAll('.sfx-row').length >= 30 && document.querySelectorAll('.sfx-group').length === 4 && [...document.querySelectorAll('.sfx-name span')].every((s) => s.scrollWidth <= s.clientWidth + 1)`), 'sound effects: 30+ rows in 4 groups, names not cut off');
  await S('sound');
});

await step('split with nothing selected leaves the music whole', async () => {
  await b.click('[data-testid=stage]');
  await seekTo(3);
  await b.key('s');
  await sleep(400);
  ok((await project()).clips.filter((c) => c.kind === 'audio').length === 1, 'music was not cut');
  await b.key('z', { ctrl: true });
  await sleep(300);
});

await step('captions with live status', async () => {
  await tab(T('כתוביות'));
  await b.click('.tab-body .btn.primary', T('יצירת כתוביות אוטומטית'));
  await sleep(3000);
  ok(await b.eval(`!!document.querySelector('.job-status')`), 'status panel appears');
  let shotTaken = false;
  for (let i = 0; i < 600; i++) {
    const st = await b.eval(`document.querySelector('.job-status')?.innerText ?? ''`);
    if (!st) break;
    if (!shotTaken && st.includes(T('תומללו'))) {
      await S('captions-status');
      shotTaken = true;
    }
    await sleep(1000);
  }
  const n = await b.eval(`document.querySelectorAll('.caption-row').length`);
  // the standard test clip (scripts/make-test-media.ps1) speaks 3 sentences and the journey cuts part of it earlier
  ok(n >= 2, `captions created: ${n}`);
  ok(await b.eval(`(() => { const list = document.querySelector('.caption-list').getBoundingClientRect(); const presets = document.querySelector('.preset-grid').getBoundingClientRect(); return list.top < presets.top; })()`), 'the caption text list comes before the styling');
  await b.click('.preset', T('מילה מודגשת'));
  await sleep(400);
  await S('captions');
});

await step('content libraries: caption and text styles, fonts, stock, import from a link', async () => {
  // caption styles (captions exist from the step before)
  ok((await b.eval(`document.querySelectorAll('.preset-grid .preset').length`)) >= 9, 'at least 9 caption styles');
  await b.click('[data-preset=neon]');
  await sleep(400);
  ok((await project()).captionStyle.color === '#7df9ff', 'a caption style applies');
  await b.click('[data-preset=karaoke]');
  await sleep(300);
  // text styles
  await b.click('[data-testid=stage]');
  await tab(T('טקסט'));
  ok((await b.eval(`document.querySelectorAll('[data-testid=text-presets] button').length`)) >= 9, 'at least 9 text styles');
  const before = (await project()).clips.length;
  await b.click('[data-testid=text-presets] [data-preset=lower-third]');
  await sleep(500);
  await b.key('Escape');
  const lower = (await project()).clips.filter((c) => c.kind === 'text').at(-1);
  ok((await project()).clips.length === before + 1 && lower.style.bg === '#141414', 'the lower-third style adds a title with its box');
  // take it off again: the steps after this one drag the first title on the timeline
  await b.eval(`fetch('/api/projects/' + localStorage.getItem('alon.project') + '/ops', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'delete', clipId: ${JSON.stringify(lower.id)} }) }).then((r) => r.ok)`);
  await b.waitFor(`[...document.querySelectorAll('.clip.k-text')].every((e) => !e.textContent.includes(${JSON.stringify(lower.text)}))`, 10000);
  await sleep(300);
  // fonts: upload a WOFF, it shows in the list and in the player, and becomes the title font
  const open = await b.eval(`[...document.querySelectorAll('.section-toggle')].find((x) => x.textContent.includes(${JSON.stringify(T('פונטים'))}))?.getAttribute('aria-expanded')`);
  if (open !== 'true') await b.click('.section-toggle', T('פונטים'));
  await sleep(200);
  await b.eval(`fetch('/api/fonts/Assistant', { method: 'DELETE' }).then(() => true, () => true)`);
  await b.setFiles('[data-testid=font-file]', [path.resolve('node_modules/@fontsource/assistant/files/assistant-latin-700-normal.woff')]);
  await b.waitFor(`!!document.querySelector('[data-testid=font-list] [data-family="Assistant"]')`, 15000);
  ok(await b.eval(`document.fonts.ready.then(() => [...document.fonts].some((f) => f.family.replace(/"/g, '') === 'Assistant' && f.weight === '700' && f.status === 'loaded' && !f.unicodeRange.includes('U+0590')))`), 'an uploaded font is listed and loaded in the player');
  await b.eval(`(() => { const s = document.querySelector('[data-testid=title-font]'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, 'Assistant'); s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await sleep(400);
  ok((await project()).titleFont === 'Assistant', 'the title font can be set from the fonts panel');
  await S('text-styles-fonts');
  await b.eval(`(() => { const s = document.querySelector('[data-testid=title-font]'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, ''); s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await sleep(300);
  await b.eval(`fetch('/api/fonts/Assistant', { method: 'DELETE' }).then(() => true)`);
  // stock (Openverse answers from the local mock the test instance points at)
  await tab(T('מדיה'));
  const sec = await b.eval(`[...document.querySelectorAll('.section-toggle')].find((x) => x.textContent.includes(${JSON.stringify(T('מאגרי סטוק'))}))?.getAttribute('aria-expanded')`);
  if (sec !== 'true') await b.click('.section-toggle', T('מאגרי סטוק'));
  await sleep(300);
  await b.click('[data-testid=stock-q]');
  await b.type('mock');
  await b.key('Enter');
  await b.waitFor(`document.querySelectorAll('[data-testid=stock-results] .stock-item').length > 0`, 15000);
  ok(await b.eval(`[...document.querySelectorAll('[data-testid=stock-results] .stock-thumb')].every((t) => t.style.backgroundImage.includes('/library/stock-thumb/'))`), 'stock results with thumbnails from the app');
  await S('stock-results');
  const media0 = (await project()).media.length;
  await b.click('[data-testid=stock-results] .stock-item');
  await b.waitFor(`fetch('/api/projects/' + localStorage.getItem('alon.project')).then((r) => r.json()).then((p) => p.media.length > ${media0})`, 30000);
  const got = (await project()).media.at(-1);
  ok(got.credit?.license === 'CC BY-SA 4.0' && got.credit.author === 'Mock Photographer', 'a stock picture comes in with licence and author');
  await sleep(500);
  ok(await b.eval(`[...document.querySelectorAll('.media-card')].some((c) => c.querySelector('.credit-badge') && c.textContent.includes('Openverse'))`), 'the library shows that it has a credit');
  // import from a link: a link to this computer is refused, and the user sees why
  const usec = await b.eval(`[...document.querySelectorAll('.section-toggle')].find((x) => x.textContent.includes(${JSON.stringify(T('ייבוא מקישור'))}))?.getAttribute('aria-expanded')`);
  if (usec !== 'true') await b.click('.section-toggle', T('ייבוא מקישור'));
  await sleep(200);
  await b.click('[data-testid=url-import]');
  await b.type('http://127.0.0.1:5191/files/pic.png');
  await b.key('Enter');
  await b.waitFor(`!!document.querySelector('[data-testid=import-error]')`, 15000);
  ok(/נחסם/.test(await b.eval(`document.querySelector('[data-testid=import-error]').textContent`)), 'a link to this computer is blocked with a clear message');
  await S('stock-import');
});

await step('AI: cloud captions choice, translation, the agent\'s draft card, approve, one undo step', async () => {
  // keys and settings go in through the API (the key fields are password inputs; typing them is covered by the library journey)
  const put = (url, body) => b.eval(`fetch(${JSON.stringify(url)}, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: ${JSON.stringify(JSON.stringify(body))} }).then((r) => r.status)`);
  ok((await put('/api/keys/anthropic', { key: 'test-anthropic-key-0005' })) === 200 && (await put('/api/ai/settings', { agent: { provider: 'anthropic', model: '', maxRounds: 8 } })) === 200, 'an AI key and the agent provider saved');
  await tab(T('כתוביות'));
  await sleep(600);
  ok(await b.eval(`!!document.querySelector('[data-testid=caption-engine-select]')`), 'the captions tab offers this computer or the cloud');
  await tab(T('סוכן AI'));
  await b.waitFor(`!!document.querySelector('[data-testid=agent-input]')`, 8000);
  const before = await project();
  await b.click('[data-testid=agent-input]');
  await b.type('תוסיף כותרת בהתחלה');
  await b.key('Enter');
  await b.waitFor(`!!document.querySelector('[data-testid=agent-draft]')`, 20000);
  await sleep(400);
  const rows = await b.eval(`[...document.querySelectorAll('[data-testid=agent-draft] li')].map((li) => li.textContent).join(' | ')`);
  ok(/כותרת מהסוכן/.test(rows), `the approval card lists the change: ${rows}`);
  ok((await project()).rev === before.rev, 'nothing is saved before approval');
  await S('agent-draft');
  await b.click('[data-testid=agent-approve]');
  await b.waitFor(`!document.querySelector('[data-testid=agent-draft]')`, 8000);
  await sleep(600);
  ok((await project()).clips.some((c) => c.text === 'כותרת מהסוכן'), 'approve: the title is in the project');
  await S('agent-approved');
  await b.eval(`document.activeElement?.blur(), 1`);
  await b.key('z', { ctrl: true });
  await sleep(800);
  ok(!(await project()).clips.some((c) => c.text === 'כותרת מהסוכן'), 'Ctrl+Z takes the whole agent edit back in one step');
  await b.eval(`fetch('/api/projects/' + localStorage.getItem('alon.project') + '/agent', { method: 'DELETE' }).then((r) => r.status)`);
  await b.eval(`fetch('/api/keys/anthropic', { method: 'DELETE' }).then((r) => r.status)`);
});

await step('timeline drag / trim / undo / zoom', async () => {
  await b.click('[data-testid=stage]');
  const c = await b.box('.clip.k-text');
  await b.drag(c.x, c.y, c.x + 60, c.y);
  const moved = (await project()).clips.find((x) => x.text === 'שלום לכולם');
  ok(moved.start > 1.2, 'dragging a clip moves it (' + moved.start + ')');
  ok(await b.eval(`document.activeElement?.tagName !== 'TEXTAREA'`), 'selecting the text later does not grab the keyboard');
  await b.key('z', { ctrl: true });
  await sleep(500);
  ok((await project()).clips.find((x) => x.text === 'שלום לכולם').start < moved.start, 'Ctrl+Z undoes the move');
  const w0 = (await b.box('.clip.k-video')).w;
  const sc = await b.box('.tl-scroll');
  await b.wheel(sc.x, sc.y, -300, 2);
  await b.wheel(sc.x, sc.y, -300, 2);
  ok((await b.box('.clip.k-video')).w > w0 * 1.2, 'Ctrl + wheel zooms in');
  await b.click('.tool-btn', T('הכל'));
  await sleep(300);
  await S('timeline');
});

await step('keyframes: K adds, dragging adds a second, Shift+J jumps back, Delete removes the picked one', async () => {
  await b.click('[data-testid=stage]');
  await seekTo(1);
  const st = await b.box('.stage');
  await b.clickAt(st.x, st.y);
  await sleep(300);
  const first = (await videoClips())[0];
  await b.key('k');
  await sleep(400);
  let v = (await videoClips()).find((c) => c.id === first.id);
  ok(v.keyframes?.length === 1, `K adds a keyframe at the playhead (${v.keyframes?.length ?? 0})`);
  ok(await b.eval(`document.querySelectorAll('.clip.k-video .kf').length >= 1`), 'the keyframe shows as a diamond on the clip');
  await seekTo(Math.min(first.start + first.duration - 0.3, 2.5));
  await b.clickAt(st.x, st.y);
  await sleep(300);
  await b.drag(st.x, st.y, st.x + 40, st.y + 20, 10);
  await sleep(500);
  v = (await videoClips()).find((c) => c.id === first.id);
  ok(v.keyframes?.length === 2 && Math.abs(v.keyframes[1].x - v.keyframes[0].x) > 0.02, `dragging the picture at another time adds a second keyframe (${JSON.stringify(v.keyframes?.map((k) => [k.t, Math.round(k.x * 100) / 100]))})`);
  await S('keyframes');
  await b.key('j', { shift: true });
  await sleep(300);
  ok(Math.abs(secs(await timecode()) - (first.start + v.keyframes[0].t)) < 0.1, `Shift+J jumps to the previous keyframe (${await timecode()})`);
  await b.key('k', { shift: true });
  await sleep(300);
  ok(Math.abs(secs(await timecode()) - (first.start + v.keyframes[1].t)) < 0.1, `Shift+K jumps to the next keyframe (${await timecode()})`);
  const d = await b.box('.clip.k-video .kf');
  await b.clickAt(d.x, d.y);
  await sleep(200);
  await b.key('Delete');
  await sleep(400);
  v = (await videoClips()).find((c) => c.id === first.id);
  ok(v && v.keyframes?.length === 1, `Delete removes the picked keyframe, the clip stays (${v?.keyframes?.length})`);
  await b.key('z', { ctrl: true });
  await sleep(400);
  ok((await videoClips()).find((c) => c.id === first.id)?.keyframes?.length === 2, 'Ctrl+Z brings it back');
});

await step('16 transitions and 4:5', async () => {
  await tab(T('מעברים'));
  await sleep(200);
  ok((await b.eval(`document.querySelectorAll('.tab-body .row-item').length`)) === 16, '16 transitions listed');
  await b.click('.tab-body .row-item', T('מחיקה שמאלה'));
  await sleep(400);
  ok((await project()).clips.some((c) => c.transition?.type === 'wipe-left'), 'wipe transition added');
  await b.click('[data-testid=stage]');
  await b.key('Escape');
  await sleep(200);
  ok(await b.eval(`[...document.querySelectorAll('.aspect-card')].some((x) => x.textContent.includes('4:5'))`), '4:5 format offered');
});

await step('silence removal: check first, then one undoable cut', async () => {
  const before = (await project()).clips.length;
  const dur0 = await b.eval(`fetch('/api/projects/' + localStorage.getItem('alon.project') + '/summary').then((r) => r.json()).then((s) => s.duration)`);
  await b.click('[data-testid=silence-open]');
  await sleep(300);
  await b.click('[data-testid=silence-check]');
  await b.waitFor(`!!document.querySelector('[data-testid=silence-plan]') || !!document.querySelector('[data-testid=silence-dialog] .error')`, 120000);
  await S('silence-check');
  const n = await b.eval(`document.querySelectorAll('[data-testid=silence-plan] li').length`);
  ok((await project()).clips.length === before, `the check changes nothing (${n} silences found)`);
  if (n > 0) {
    await b.click('[data-testid=silence-apply]');
    await sleep(600);
    const dur1 = await b.eval(`fetch('/api/projects/' + localStorage.getItem('alon.project') + '/summary').then((r) => r.json()).then((s) => s.duration)`);
    ok(dur1 < dur0 - 0.2, `silences removed (${dur0}s -> ${dur1}s)`);
    await b.key('z', { ctrl: true });
    await sleep(600);
    const dur2 = await b.eval(`fetch('/api/projects/' + localStorage.getItem('alon.project') + '/summary').then((r) => r.json()).then((s) => s.duration)`);
    ok(Math.abs(dur2 - dur0) < 0.05, `one Ctrl+Z brings all of them back (${dur2}s)`);
  } else {
    await b.key('Escape');
    await sleep(200);
  }
});

await step('project panel: layout, logo, template', async () => {
  await b.click('[data-testid=stage]');
  await b.key('Escape');
  await sleep(300);
  const openSection = async (title) => {
    const open = await b.eval(`[...document.querySelectorAll('.section-toggle')].find((x) => x.textContent.includes(${JSON.stringify(title)}))?.getAttribute('aria-expanded')`);
    if (open !== 'true') await b.click('.section-toggle', title);
    await sleep(200);
  };
  await openSection(T('פריסת מסך'));
  ok((await b.eval(`document.querySelectorAll('[data-testid=layout-cards] button').length`)) === 4, '4 screen layouts offered');
  await b.click('[data-layout=side]');
  await sleep(400);
  ok((await project()).layout === 'side', 'a layout card sets the layout');
  await b.click('[data-layout=single]');
  await sleep(400);
  ok(!(await project()).layout, 'back to the normal layout');
  await openSection(T('לוגו'));
  const logoFile = path.resolve(OUT, 'test-logo.png');
  execFileSync(process.env.FFMPEG_PATH ?? 'ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x14c83c:s=300x120', '-frames:v', '1', logoFile]);
  await b.setFiles('[data-testid=logo-picks] input[type=file]', [logoFile]);
  await b.waitFor(`!!document.querySelector('[data-testid=logo-layer]')`, 20000);
  ok(!!(await project()).logo, 'uploading a logo puts it on the video');
  await b.click('[data-corner=bottom-left]');
  await sleep(400);
  const lg = await b.box('[data-testid=logo-layer]');
  const st = await b.box('.stage');
  ok((await project()).logo.corner === 'bottom-left' && lg.x < st.x && lg.y > st.y, 'the corner buttons move the logo on the player');
  await openSection(T('תבניות'));
  await b.click('[data-testid=template-name]');
  await b.type('תבנית מהבדיקה');
  await b.click('[data-testid=template-save]');
  await b.waitFor(`[...document.querySelectorAll('[data-testid=template-list] li')].some((x) => x.textContent.includes('תבנית מהבדיקה'))`, 10000);
  ok(true, 'save as template, it shows in the list');
  await S('project-panel-logo-template');
});

await step('layout fits common screens', async () => {
  // no horizontal scroll, and the main panels never overlap each other or leave the window
  for (const [w, h] of [[1366, 768], [1440, 900], [1920, 1080]]) {
    await b.viewport(w, h);
    await sleep(400);
    const r = await b.eval(`(() => {
      const ids = ['topbar', 'library', 'stage', 'transport', 'inspector', 'timeline', 'tl-toolbar'];
      const box = (id) => { const e = document.querySelector('[data-testid=' + id + ']'); const r = e.getBoundingClientRect(); return { id, l: r.left, t: r.top, r: r.right, b: r.bottom }; };
      const bx = ids.map(box);
      const doc = document.documentElement;
      const out = bx.filter((x) => x.l < -1 || x.t < -1 || x.r > innerWidth + 1 || x.b > innerHeight + 1).map((x) => x.id);
      const panels = bx.filter((x) => ['library', 'inspector', 'timeline', 'topbar'].includes(x.id));
      const hit = [];
      for (let i = 0; i < panels.length; i++) for (let j = i + 1; j < panels.length; j++) {
        const a = panels[i], c = panels[j];
        if (a.l < c.r - 1 && c.l < a.r - 1 && a.t < c.b - 1 && c.t < a.b - 1) hit.push(a.id + '/' + c.id);
      }
      const tb = document.querySelector('[data-testid=tl-toolbar]');
      return { hscroll: doc.scrollWidth > innerWidth + 1, out, hit, toolbarFits: tb.scrollWidth <= tb.clientWidth + 1 };
    })()`);
    ok(!r.hscroll && !r.out.length && !r.hit.length && r.toolbarFits, `${w}x${h}: no horizontal scroll, nothing outside the window or overlapping ${JSON.stringify(r)}`);
    await S(`layout-${w}x${h}`);
  }
  await b.viewport(Number(WIDTH), Number(HEIGHT));
  await sleep(300);
});

await step('export and open the folder', async () => {
  await b.click('[data-testid=export-open]', T('ייצוא'));
  await sleep(300);
  await b.click('[data-preset=shorts]');
  await sleep(200);
  await S('export-presets');
  await b.click('[data-testid=export-dialog] .seg button', T('טיוטה מהירה'));
  await b.click('[data-testid=export-start]', T('ייצוא'));
  await sleep(1500);
  await S('export-progress');
  await b.waitFor(`!!document.querySelector('[data-testid=export-dialog] a[download]') || !!document.querySelector('[data-testid=export-dialog] .error')`, 600000);
  const err = await b.eval(`document.querySelector('[data-testid=export-dialog] .error')?.textContent ?? ''`);
  ok(!err, 'export finished without error ' + err);
  ok(await b.eval(`[...document.querySelectorAll('[data-testid=export-dialog] .btn')].some((x) => x.textContent.includes(${JSON.stringify(T('פתיחת התיקייה'))}))`), '"open the folder" is offered');
  await S('export-done');
  const href = await b.eval(`document.querySelector('[data-testid=export-dialog] a[download]').href`);
  const file = path.join(OUT, 'exported.mp4');
  fs.writeFileSync(file, Buffer.from(await (await fetch(href)).arrayBuffer()));
  const info = JSON.parse(execFileSync(process.env.FFPROBE_PATH ?? 'ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file]).toString());
  const v = info.streams.find((s) => s.codec_type === 'video');
  ok(v.codec_name === 'h264' && info.streams.some((s) => s.codec_type === 'audio'), `MP4 is h264 + audio, ${v.width}x${v.height}, ${Number(info.format.duration).toFixed(1)}s`);
  ok(v.width === 1080 && v.height === 1920, `the YouTube Shorts preset gives 1080x1920 (${v.width}x${v.height})`);
  execFileSync(process.env.FFMPEG_PATH ?? 'ffmpeg', ['-y', '-v', 'error', '-ss', '2', '-i', file, '-frames:v', '1', '-vf', 'scale=360:-2', path.join(OUT, 'export-frame-2s.png')]);
  await b.key('Escape');
});

await step('new video from a template', async () => {
  const before = (await project()).id;
  await b.click('[data-testid=project-menu]');
  await sleep(400);
  await b.click('.menu [role=menuitem]', 'תבנית מהבדיקה');
  await b.waitFor(`localStorage.getItem('alon.project') !== ${JSON.stringify(before)}`, 10000);
  await sleep(800);
  const p = await project();
  ok(p.logo?.corner === 'bottom-left' && !p.clips.some((c) => c.kind === 'video' || c.kind === 'audio'), 'the new video has the logo and frame, without the old videos and sound');
  ok(await b.eval(`!!document.querySelector('[data-testid=topbar]')`), 'the editor is open on the new video');
  await S('from-template');
});

ok(b.consoleErrors.filter((e) => !/favicon|ERR_CONNECTION|WebSocket/.test(e)).length === 0, 'no errors in the browser console: ' + b.consoleErrors.slice(0, 5).join(' || '));
await b.close();
await mock.close();
fs.writeFileSync(path.join(OUT, 'results.txt'), results.join('\n'));
const failed = results.filter((r) => r.startsWith('FAIL')).length;
console.log(`\n${failed ? failed + ' FAILED' : 'ALL GOOD'}  screenshots: ${OUT}`);
process.exit(failed ? 1 : 0);
