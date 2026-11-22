/**
 * Access to the local server.
 * - The installed app opens the window at  /#t=<one-time token>. The page trades the token for an
 *   HttpOnly session cookie once (POST /api/session) and removes it from the address. The key itself
 *   never appears in the address, the browser history or the window's storage.
 * - Development / tests open  /#k=<key>. The key is kept in memory only and sent with the first API
 *   calls; the server answers with the same cookie.
 * After that, every request (fetch, <video>, event streams, downloads) is authorised by the cookie,
 * also after a reload.
 */
let key = '';
let token = '';
{
  const k = /[#&]k=([a-f0-9]{64})/.exec(location.hash);
  const t = /[#&]t=([a-f0-9]{48})/.exec(location.hash);
  if (k) key = k[1];
  if (t) token = t[1];
  if (k || t) history.replaceState(null, '', location.pathname + location.search);
}

/** Resolves once the window holds its cookie (or has a key to send). */
export const ready: Promise<void> = token
  ? fetch('/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }), credentials: 'same-origin' })
      .then(() => undefined)
      .catch(() => undefined)
  : Promise.resolve();

/** The key for the "API / MCP" page (copied into commands for other programs). */
export async function accessKey(): Promise<string> {
  if (key) return key;
  const r = await fetch('/api/access-key');
  return r.ok ? ((await r.json()) as { key: string }).key : '';
}

/** Adds the key (when the window has it) to same-origin API calls made with fetch(). */
export function installKeyedFetch() {
  const original = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const u = new URL(url, location.href);
    if (u.origin === location.origin && (u.pathname.startsWith('/api/') || u.pathname === '/mcp')) {
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      if (key) headers.set('X-Alon-Key', key);
      return original(input, { ...init, headers, credentials: 'same-origin' });
    }
    return original(input, init);
  };
}
