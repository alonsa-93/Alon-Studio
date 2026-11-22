/**
 * Test helper: the studio's API answers only with its access key. Importing this file makes every
 * fetch() to the studio carry it. The key comes from ALON_ACCESS_KEY, or from the data folder of the
 * server under test (ALON_DATA_DIR, default ./data).
 */
import fs from 'node:fs';
import path from 'node:path';

export const KEY =
  process.env.ALON_ACCESS_KEY ??
  (() => {
    try {
      return fs.readFileSync(path.join(process.env.ALON_DATA_DIR ?? path.resolve('data'), 'access-key'), 'utf8').trim();
    } catch {
      return '';
    }
  })();

const original = globalThis.fetch;
globalThis.fetch = (input, init = {}) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (/^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):\d+\//.test(url) && !init.noKey) {
    const headers = new Headers(init.headers);
    if (!headers.has('authorization')) headers.set('authorization', `Bearer ${KEY}`);
    return original(input, { ...init, headers });
  }
  return original(input, init);
};
