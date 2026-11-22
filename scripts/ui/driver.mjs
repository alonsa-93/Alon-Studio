/**
 * Minimal real-browser driver: launches Microsoft Edge (headless, real rendering, real video decoding,
 * real animation frames) and talks to it over the Chrome DevTools Protocol. Clicks, drags and keys are
 * sent as real (trusted) input events at element positions, the same way a mouse and keyboard would.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const EDGE = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find((p) => fs.existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launch({ width = 1440, height = 900, port = 9333 } = {}) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'alon-ui-'));
  const proc = spawn(EDGE, [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--headless=new', `--window-size=${width},${height}`, '--autoplay-policy=no-user-gesture-required', '--no-first-run', '--mute-audio', 'about:blank'], { stdio: 'ignore' });
  let target;
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(250);
    try {
      target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page');
    } catch {}
  }
  if (!target) throw new Error('Edge did not start');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
  let id = 0;
  const waiting = new Map();
  const events = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && waiting.has(msg.id)) {
      const { resolve, reject } = waiting.get(msg.id);
      waiting.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    } else if (msg.method) events.push(msg);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const n = ++id;
    waiting.set(n, { resolve, reject });
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  const consoleErrors = [];

  const b = {
    send,
    events,
    consoleErrors,
    async close() {
      try { ws.close(); } catch {}
      // Edge starts helper processes: end the whole tree, not only the parent
      try { spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { proc.kill(); }
      await sleep(500);
      try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
    },
    /** Resize the page viewport (to check the layout at several screen sizes). */
    async viewport(w, h) {
      await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    },
    async goto(url) {
      await send('Page.navigate', { url });
      await sleep(400);
      await b.waitFor('document.readyState === "complete"');
    },
    /** Evaluates an expression (may be async) in the page and returns its JSON value. */
    async eval(expr) {
      const r = await send('Runtime.evaluate', { expression: `(async () => (${expr}))()`, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error('page error: ' + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
      return r.result.value;
    },
    async waitFor(expr, timeout = 10000) {
      const t0 = Date.now();
      for (;;) {
        try {
          if (await b.eval(expr)) return true;
        } catch {}
        if (Date.now() - t0 > timeout) throw new Error('timeout waiting for: ' + expr);
        await sleep(100);
      }
    },
    /** Centre of the first visible element matching a CSS selector, optionally with given text. */
    async box(selector, text) {
      const r = await b.eval(`(() => {
        const els = [...document.querySelectorAll(${JSON.stringify(selector)})].filter((e) => {
          const r = e.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && ${text === undefined ? 'true' : `e.textContent.replace(/\\s+/g, ' ').includes(${JSON.stringify(text)})`};
        });
        const e = els[0];
        if (!e) return null;
        e.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        const r = e.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height, left: r.left, top: r.top };
      })()`);
      if (!r) throw new Error(`element not found: ${selector}${text ? ` "${text}"` : ''}`);
      return r;
    },
    async mouse(type, x, y, extra = {}) {
      await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, ...extra });
    },
    async clickAt(x, y, clickCount = 1) {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount });
    },
    async click(selector, text) {
      const r = await b.box(selector, text);
      await b.clickAt(r.x, r.y);
      await sleep(150);
      return r;
    },
    async dblclick(selector, text) {
      const r = await b.box(selector, text);
      await b.clickAt(r.x, r.y, 1);
      await b.clickAt(r.x, r.y, 2);
      await sleep(200);
    },
    async drag(x1, y1, x2, y2, steps = 12) {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x1, y: y1 });
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x1, y: y1, button: 'left', buttons: 1, clickCount: 1 });
      for (let i = 1; i <= steps; i++) {
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x1 + ((x2 - x1) * i) / steps, y: y1 + ((y2 - y1) * i) / steps, button: 'left', buttons: 1 });
        await sleep(16);
      }
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x2, y: y2, button: 'left', buttons: 0, clickCount: 1 });
      await sleep(200);
    },
    async wheel(x, y, deltaY, modifiers = 0) {
      await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY, modifiers });
      await sleep(120);
    },
    /** Presses a key. key: 'a', 'S', ' ', 'Delete', 'Escape', 'Enter', 'ArrowLeft'... mods: ctrl, shift */
    async key(key, { ctrl = false, shift = false } = {}) {
      const named = { ' ': ['Space', 32], Delete: ['Delete', 46], Backspace: ['Backspace', 8], Escape: ['Escape', 27], Enter: ['Enter', 13], ArrowLeft: ['ArrowLeft', 37], ArrowRight: ['ArrowRight', 39], Home: ['Home', 36], End: ['End', 35] };
      let code, vk;
      if (named[key]) [code, vk] = named[key];
      else {
        code = `Key${key.toUpperCase()}`;
        vk = key.toUpperCase().charCodeAt(0);
      }
      const modifiers = (ctrl ? 2 : 0) | (shift ? 8 : 0);
      const text = !ctrl && key.length === 1 ? key : undefined;
      await send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key, code, windowsVirtualKeyCode: vk, modifiers, text });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, modifiers });
      await sleep(120);
    },
    /** Types text into the focused element (works for Hebrew). */
    async type(text) {
      await send('Input.insertText', { text });
      await sleep(150);
    },
    async screenshot(file) {
      const r = await send('Page.captureScreenshot', { format: 'png' });
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
      return file;
    },
    async setFiles(selector, files) {
      const doc = await send('DOM.getDocument', {});
      const { nodeId } = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector });
      await send('DOM.setFileInputFiles', { nodeId, files });
    },
    sleep,
  };
  await send('DOM.enable');
  await send('Log.enable');
  const origOnMessage = ws.onmessage;
  ws.onmessage = (m) => {
    origOnMessage(m);
    const msg = JSON.parse(m.data);
    if (msg.method === 'Runtime.exceptionThrown') consoleErrors.push('exception: ' + (msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text).split('\n')[0]);
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') consoleErrors.push('console.error: ' + msg.params.args.map((a) => a.value ?? a.description).join(' ').slice(0, 200));
  };
  return b;
}
