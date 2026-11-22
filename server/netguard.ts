import dns from 'node:dns';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { HttpError } from './store';

/**
 * Downloads from the internet for "import from a link" and stock files, safe against SSRF:
 * only http / https, the host's addresses are resolved first and every one must be public, the
 * connection goes to the address that was checked (no second DNS answer), and the same checks run
 * again for every redirect. Size, time and content type are limited; the file lands in a temporary
 * path and the caller moves it into the media folder only after ffprobe accepts it.
 */

const V4_BLOCKED: [string, number][] = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
];
const v4num = (ip: string) => ip.split('.').reduce((a, p) => a * 256 + Number(p), 0);

function v6words(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  // a trailing dotted IPv4 part (::ffff:1.2.3.4)
  const m = /(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (m) {
    if (!net.isIPv4(m[2])) return null;
    const n = v4num(m[2]);
    s = `${m[1]}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  const words = [...head, ...Array(fill).fill('0'), ...tail].map((w) => parseInt(w, 16));
  return words.length === 8 && words.every((w) => Number.isInteger(w) && w >= 0 && w <= 0xffff) ? words : null;
}

/** True for addresses that must never be fetched: private, loopback, link-local, multicast, reserved. */
export function isBlockedAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const n = v4num(ip);
    return V4_BLOCKED.some(([base, bits]) => Math.floor(n / 2 ** (32 - bits)) === Math.floor(v4num(base) / 2 ** (32 - bits))) || n === 0xffffffff;
  }
  if (!net.isIPv6(ip)) return true;
  const w = v6words(ip);
  if (!w) return true;
  const v4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  if (w.slice(0, 7).every((x) => x === 0)) return true; // :: and ::1
  if (w.slice(0, 5).every((x) => x === 0) && w[5] === 0xffff) return isBlockedAddress(v4(w[6], w[7])); // IPv4-mapped
  if (w.slice(0, 6).every((x) => x === 0)) return true; // IPv4-compatible (deprecated)
  if (w[0] === 0x64 && w[1] === 0xff9b) return isBlockedAddress(v4(w[6], w[7])); // NAT64
  if (w[0] === 0x2002) return isBlockedAddress(v4(w[1], w[2])); // 6to4
  if ((w[0] & 0xfe00) === 0xfc00) return true; // unique local
  if ((w[0] & 0xffc0) === 0xfe80 || (w[0] & 0xffc0) === 0xfec0) return true; // link-local, site-local
  if ((w[0] & 0xff00) === 0xff00) return true; // multicast
  if (w[0] === 0x2001 && w[1] === 0x0db8) return true; // documentation
  if (w[0] === 0x0100 && w[1] === 0 && w[2] === 0 && w[3] === 0) return true; // discard
  return false;
}

export interface NetPolicy {
  lookup(host: string): Promise<{ address: string; family: number }[]>;
  /** Hosts allowed although their addresses are not public (tests of the stock providers only). */
  trusted?: (url: URL) => boolean;
}
export const defaultPolicy: NetPolicy = { lookup: (host) => dns.promises.lookup(host, { all: true, verbatim: true }) };

const denied = (why: string) => new HttpError(400, `הקישור נחסם: ${why}`);

/** Checks a URL and returns the address to connect to. */
export async function vetUrl(raw: string | URL, policy: NetPolicy = defaultPolicy): Promise<{ url: URL; address: string; family: number }> {
  let url: URL;
  try {
    url = new URL(String(raw));
  } catch {
    throw new HttpError(400, 'קישור לא תקין');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw denied('רק קישורי http או https');
  if (url.username || url.password) throw denied('קישור עם שם משתמש או סיסמה');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host) throw denied('אין שם שרת');
  let addrs: { address: string; family: number }[];
  if (net.isIP(host)) addrs = [{ address: host, family: net.isIPv6(host) ? 6 : 4 }];
  else {
    if (/^localhost$|\.localhost$|\.local$|\.internal$/i.test(host)) throw denied('כתובת פנימית');
    try {
      addrs = await policy.lookup(host);
    } catch {
      throw new HttpError(400, `השרת ${host} לא נמצא`);
    }
  }
  if (!addrs.length) throw new HttpError(400, `השרת ${host} לא נמצא`);
  const trusted = policy.trusted?.(url) ?? false;
  if (!trusted && addrs.some((a) => isBlockedAddress(a.address))) throw denied('כתובת פרטית, מקומית או שמורה');
  return { url, address: addrs[0].address, family: addrs[0].family };
}

export interface DownloadOptions {
  maxBytes: number;
  timeoutMs: number;
  /** Content types that are accepted (checked before the body is read). */
  accept: (contentType: string) => boolean;
  onProgress?: (done: number, total: number | null) => void;
  policy?: NetPolicy;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

/** Downloads `raw` into `dest`. Returns the final URL and the content type. */
export async function safeDownload(raw: string, dest: string, o: DownloadOptions): Promise<{ url: string; contentType: string; bytes: number }> {
  const policy = o.policy ?? defaultPolicy;
  const deadline = Date.now() + o.timeoutMs;
  let current = raw;
  for (let hop = 0; hop <= 5; hop++) {
    const { url, address, family } = await vetUrl(current, policy);
    const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const lib = url.protocol === 'https:' ? https : http;
      const req = lib.request(
        url,
        {
          method: 'GET',
          headers: { 'User-Agent': 'ALON-Studio', Accept: '*/*', ...o.headers },
          // connect to the address that was checked, never to a second DNS answer
          lookup: (_h: string, opts: { all?: boolean }, cb: (...a: unknown[]) => void) => (opts?.all ? cb(null, [{ address, family }]) : cb(null, address, family)),
          timeout: Math.max(1000, deadline - Date.now()),
          signal: o.signal,
        } as https.RequestOptions,
        resolve,
      );
      req.on('timeout', () => req.destroy(new HttpError(504, 'ההורדה לקחה יותר מדי זמן')));
      req.on('error', reject);
      req.end();
    }).catch((e) => {
      throw e instanceof HttpError ? e : new HttpError(502, `לא ניתן להתחבר לשרת: ${(e as Error).message.slice(0, 80)}`);
    });
    const status = res.statusCode ?? 0;
    if (status >= 300 && status < 400 && res.headers.location) {
      res.resume();
      current = new URL(res.headers.location, url).href;
      continue;
    }
    if (status !== 200) {
      res.resume();
      throw new HttpError(502, `השרת ענה ${status}`);
    }
    const type = String(res.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (!o.accept(type)) {
      res.resume();
      throw new HttpError(415, `סוג הקובץ לא נתמך (${type || 'לא ידוע'})`);
    }
    const total = Number(res.headers['content-length'] ?? 0) || null;
    if (total && total > o.maxBytes) {
      res.resume();
      throw new HttpError(413, 'הקובץ גדול מדי');
    }
    let bytes = 0;
    await new Promise<void>((resolve, reject) => {
      const out = fs.createWriteStream(dest);
      const fail = (e: Error) => {
        res.destroy();
        out.destroy();
        reject(e);
      };
      const timer = setTimeout(() => fail(new HttpError(504, 'ההורדה לקחה יותר מדי זמן')), Math.max(0, deadline - Date.now()));
      res.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > o.maxBytes) return fail(new HttpError(413, 'הקובץ גדול מדי'));
        o.onProgress?.(bytes, total);
      });
      res.on('error', fail);
      out.on('error', fail);
      out.on('finish', () => {
        clearTimeout(timer);
        resolve();
      });
      res.pipe(out);
    });
    return { url: url.href, contentType: type, bytes };
  }
  throw new HttpError(400, 'יותר מדי הפניות');
}

/** Media content types (plus the generic binary type many servers send; ffprobe decides then). */
export const MEDIA_TYPES = (t: string) => /^(video|audio|image)\/[\w.+-]+$/.test(t) && t !== 'image/svg+xml' || t === 'application/octet-stream' || t === 'binary/octet-stream';
