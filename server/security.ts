import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { NextFunction, Request, Response } from 'express';
import { DATA_DIR, HttpError } from './store';

/**
 * Local-only hardening.
 *
 * Access key: a random 256-bit key, created once per installation in the user's data folder
 * (readable by this Windows account only: see ownerOnly). It is never served over HTTP:
 * - the app window receives it out of band, in the URL fragment the launcher opens (#k=...),
 *   sends it as the X-Alon-Key header and gets an HttpOnly SameSite=Strict cookie back
 *   (used by <video>, event streams and download links, which cannot send headers);
 * - other programs (MCP clients, scripts) send "Authorization: Bearer <key>".
 * Without it the server answers 401. Requests that a different site or another localhost port
 * started are refused before that (exact own origin + Fetch Metadata).
 */

const KEY_FILE = path.join(DATA_DIR, 'access-key');

function loadOrCreateKey(): string {
  const fromEnv = process.env.ALON_ACCESS_KEY;
  if (fromEnv && /^[a-f0-9]{64}$/.test(fromEnv)) return fromEnv;
  try {
    const k = fs.readFileSync(KEY_FILE, 'utf8').trim();
    if (/^[a-f0-9]{64}$/.test(k)) {
      ownerOnly(KEY_FILE);
      return k;
    }
  } catch {
    /* first run */
  }
  const k = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(KEY_FILE, k, 'utf8');
  ownerOnly(KEY_FILE);
  return k;
}

/**
 * The key file is readable by the current Windows account only, whatever the folder above it allows
 * (a PC may grant other local accounts or groups read access to Documents).
 */
export function ownerOnly(file: string) {
  if (process.platform !== 'win32' || !process.env.USERNAME) return;
  const who = process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}` : process.env.USERNAME;
  try {
    execFileSync('icacls', [file, '/inheritance:r', '/grant:r', `${who}:F`], { stdio: 'ignore', windowsHide: true, timeout: 10_000 });
  } catch {
    /* best effort: the folder's own permissions still apply */
  }
}

export const ACCESS_KEY = loadOrCreateKey();
const KEY_BUF = Buffer.from(ACCESS_KEY);
// one cookie per port: a development copy and the installed app in the same browser do not overwrite each other
const COOKIE = `alon_key_${Number(process.env.PORT ?? 5173)}`;
const setKeyCookie = (res: Response) => res.setHeader('Set-Cookie', `${COOKIE}=${ACCESS_KEY}; Path=/; HttpOnly; SameSite=Strict`);

function sameKey(candidate: unknown): boolean {
  if (typeof candidate !== 'string' || !candidate) return false;
  const b = Buffer.from(candidate);
  return b.length === KEY_BUF.length && crypto.timingSafeEqual(b, KEY_BUF);
}

function readCookie(req: Request, name: string): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

// ---- repeated wrong keys: stop answering them for a while ----
// Every caller here is 127.0.0.1 / ::1, so this cannot lock by address without also locking the app's
// own window out. Instead, wrong keys are slowed down and, after too many, refused outright for a few
// minutes - while requests that DO carry the right key keep working.
const MAX_FAILS = 20;
const WINDOW_MS = 60_000;
const LOCK_MS = 5 * 60_000;
let failCount = 0;
let failWindowStart = 0;
let lockedUntil = 0;

function recordFail() {
  const now = Date.now();
  if (now - failWindowStart > WINDOW_MS) {
    failWindowStart = now;
    failCount = 0;
  }
  failCount++;
  if (failCount >= MAX_FAILS) {
    lockedUntil = now + LOCK_MS;
    console.error(`security: ${failCount} requests with a wrong access key within a minute; refusing wrong keys for 5 minutes`);
  }
}

/** /api and /mcp. */
export function requireKey(req: Request, res: Response, next: NextFunction) {
  const auth = req.headers.authorization;
  const bearer = auth?.startsWith('Bearer ') ? auth.slice(7).trim() : undefined;
  const header = req.headers['x-alon-key'];
  const viaHeader = sameKey(header) || sameKey(bearer);
  if (viaHeader || sameKey(readCookie(req, COOKIE))) {
    // the window proves the key once with the header; from then on <video>, event streams and
    // download links (which cannot send headers) use this cookie
    if (viaHeader && header && !sameKey(readCookie(req, COOKIE))) setKeyCookie(res);
    next();
    return;
  }
  refuse(res, 'missing or wrong access key. Open the studio from its shortcut.');
}

/** Wrong or missing key: counted, slowed down, and refused outright while locked. */
function refuse(res: Response, message: string) {
  if (Date.now() < lockedUntil) {
    res.status(429).json({ error: 'too many wrong access keys; try again in a few minutes' });
    return;
  }
  recordFail();
  // slow down guessing
  setTimeout(() => res.status(401).json({ error: message }), 300);
}

/**
 * One-time launch tokens. The window is opened at  /#t=<token>  instead of the key itself, because the
 * browser keeps opened addresses (history, session restore) on disk. The page trades the token for the
 * key cookie once; a used or expired token (2 minutes) is worthless.
 */
const launchTokens = new Map<string, number>();
export function issueLaunchToken(): string {
  const now = Date.now();
  for (const [t, exp] of launchTokens) if (exp < now) launchTokens.delete(t);
  const t = crypto.randomBytes(24).toString('hex');
  launchTokens.set(t, now + 120_000);
  return t;
}
/**
 * A second launch while the studio already runs asks it for a window link WITHOUT sending the key
 * (whatever owns the port might not be the studio): both sides prove they know the key with an HMAC
 * over a fresh random value, and the launcher checks the server's proof first.
 */
const hmac = (label: string, nonce: string) => crypto.createHmac('sha256', ACCESS_KEY).update(`${label}:${nonce}`).digest('hex');
const serverNonces = new Map<string, number>();
export function launchChallenge(req: Request, res: Response) {
  const n = (req.body as { nonce?: unknown } | undefined)?.nonce;
  if (typeof n !== 'string' || !/^[a-f0-9]{32,64}$/.test(n)) {
    res.status(400).json({ error: 'nonce required' });
    return;
  }
  const now = Date.now();
  for (const [c, exp] of serverNonces) if (exp < now) serverNonces.delete(c);
  if (serverNonces.size > 50) {
    res.status(429).json({ error: 'busy' });
    return;
  }
  const c = crypto.randomBytes(24).toString('hex');
  serverNonces.set(c, now + 30_000);
  res.json({ proof: hmac('server', n), challenge: c });
}
export function launchTokenByProof(req: Request, res: Response) {
  const { challenge, proof } = (req.body ?? {}) as { challenge?: unknown; proof?: unknown };
  const exp = typeof challenge === 'string' ? serverNonces.get(challenge) : undefined;
  if (typeof challenge !== 'string' || typeof proof !== 'string' || !exp || exp < Date.now()) {
    refuse(res, 'invalid launch proof');
    return;
  }
  serverNonces.delete(challenge);
  const want = Buffer.from(hmac('client', challenge));
  const got = Buffer.from(proof);
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) {
    refuse(res, 'invalid launch proof');
    return;
  }
  res.json({ token: issueLaunchToken() });
}
/** The launcher side: returns a window link from the studio already running on this port, or null. */
export async function tokenFromRunningStudio(port: number): Promise<string | null> {
  const base = `http://127.0.0.1:${port}`;
  const nonce = crypto.randomBytes(24).toString('hex');
  const post = (p: string, body: unknown) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const a = (await (await post('/api/session/challenge', { nonce })).json()) as { proof?: string; challenge?: string };
  const expected = Buffer.from(hmac('server', nonce));
  // not the studio (or not this installation): nothing is sent to it
  if (typeof a.proof !== 'string' || typeof a.challenge !== 'string' || a.proof.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(a.proof), expected)) return null;
  const b = (await (await post('/api/session/proof', { challenge: a.challenge, proof: hmac('client', a.challenge) })).json()) as { token?: string };
  return typeof b.token === 'string' && /^[a-f0-9]{48}$/.test(b.token) ? b.token : null;
}

export function redeemLaunchToken(req: Request, res: Response) {
  const t = (req.body as { token?: unknown } | undefined)?.token;
  const exp = typeof t === 'string' ? launchTokens.get(t) : undefined;
  // a valid link always works, also during a lockout (like the right key): wrong guesses cannot lock the user out
  if (typeof t !== 'string' || !exp || exp < Date.now()) {
    refuse(res, 'this window link has expired. Open the studio again from its shortcut.');
    return;
  }
  launchTokens.delete(t);
  setKeyCookie(res);
  res.json({ ok: true });
}

/** Media files, exports, the sound library: only the cookie (the window's own requests). */
export function requireKeyCookie(req: Request, res: Response, next: NextFunction) {
  if (sameKey(readCookie(req, COOKIE)) || sameKey(req.headers['x-alon-key']) || sameKey(req.headers.authorization?.replace(/^Bearer /, ''))) {
    next();
    return;
  }
  refuse(res, 'missing access key');
}

/** Only the app's own origin (same host name family AND this server's port); no request started by another site or port. */
export function originGuard(port: number) {
  const hosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]);
  const origins = new Set([...hosts].map((h) => `http://${h}`));
  return (req: Request, res: Response, next: NextFunction) => {
    const host = req.headers.host ?? '';
    const origin = req.headers.origin;
    const site = req.headers['sec-fetch-site'];
    // 'none' = typed / opened by the launcher, 'same-origin' = the app itself; programs send nothing
    const foreignSite = site !== undefined && site !== 'none' && site !== 'same-origin';
    if (!hosts.has(host) || (origin !== undefined && !origins.has(origin)) || foreignSite) {
      res.status(403).json({ error: 'forbidden: this local service only answers its own window' });
      return;
    }
    next();
  };
}

/** Security headers on every response. */
export function securityHeaders(production: boolean) {
  const csp = [
    "default-src 'self'",
    production ? "script-src 'self'" : "script-src 'self' 'unsafe-inline'", // Vite's dev preamble is inline
    "style-src 'self' 'unsafe-inline'", // React style attributes
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "font-src 'self'",
    production ? "connect-src 'self'" : "connect-src 'self' ws://localhost:* ws://127.0.0.1:* ws://[::1]:*",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
  return (req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Content-Security-Policy', csp);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(), geolocation=(), payment=(), usb=(), microphone=(self)');
    if (/^\/(api|media|exports|library)\//i.test(req.path) || /^\/mcp$/i.test(req.path)) res.setHeader('Cache-Control', 'no-store');
    next();
  };
}

/** Uploaded / served user media: never rendered as a page. */
export const mediaHeaders = (res: Response) => {
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  // people's videos are not copied into the browser's disk cache
  res.setHeader('Cache-Control', 'no-store');
};

// ---- importing a local file by path (REST and MCP) ----
export const MEDIA_EXT = new Set(['.mp4', '.mov', '.m4v', '.mkv', '.webm', '.avi', '.wmv', '.mts', '.m2ts', '.3gp', '.mp3', '.wav', '.m4a', '.aac', '.ogg', '.oga', '.opus', '.flac', '.wma', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']);
const MAX_IMPORT_BYTES = 8 * 1024 ** 3;

/** Folders a file may be imported from: the user's own folders (home: Desktop, Documents, Downloads, Videos...) plus ALON_IMPORT_DIRS. */
export function importRoots(): string[] {
  const extra = (process.env.ALON_IMPORT_DIRS ?? '').split(path.delimiter).filter(Boolean);
  return [os.homedir(), ...extra].map((d) => {
    try {
      return fs.realpathSync.native(path.resolve(d));
    } catch {
      return path.resolve(d);
    }
  });
}

export const isInside = (child: string, parent: string) => {
  const rel = path.relative(parent.toLowerCase(), child.toLowerCase());
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
};

/**
 * Validates a path for "import by path" and returns its real location (links / junctions resolved).
 * Only drive-letter paths, only media file types, only inside the allowed folders. Errors do not say
 * whether a file exists outside those folders.
 */
export function checkImportPath(input: unknown): string {
  if (typeof input !== 'string' || !input.trim()) throw new HttpError(400, '"path" is required');
  const denied = () => new HttpError(403, 'only video, audio and image files from your own folders (Desktop, Documents, Downloads, Videos...) can be imported');
  // no network shares (\\server\share would make Windows contact that server) and no device paths
  if (!/^[a-zA-Z]:[\\/]/.test(input) || /^[\\/]{2}/.test(input) || input.includes('\0') || input.indexOf(':', 2) !== -1) throw denied(); // and no alternate data streams (file.mp4:s)
  const abs = path.resolve(input);
  if (!MEDIA_EXT.has(path.extname(abs).toLowerCase())) throw denied();
  if (!importRoots().some((r) => isInside(abs, r))) throw denied();
  let real: string;
  try {
    // the native call also expands 8.3 short names (C:\PROGRA~1), so the data-folder check cannot be side-stepped
    real = fs.realpathSync.native(abs);
  } catch {
    throw new HttpError(400, 'file not found');
  }
  if (!importRoots().some((r) => isInside(real, r)) || isInside(real, dataDirReal())) throw denied();
  const st = fs.statSync(real);
  if (!st.isFile()) throw new HttpError(400, 'not a file');
  if (st.size > MAX_IMPORT_BYTES) throw new HttpError(413, 'file is too large');
  return real;
}

/** Log lines: the Windows user name and home folder are replaced by ~. */
/** Saved API keys: replaced by [key] wherever they would reach a log line. */
export const secretValues = new Set<string>();

export const redact = (s: string) => {
  for (const k of secretValues) if (k.length >= 8) s = s.split(k).join('[key]');
  const home = os.homedir();
  // as written, with forward slashes, and inside JSON (where every backslash is doubled)
  return [home, home.replace(/\\/g, '/'), home.replace(/\\/g, '\\\\')].reduce((out, h) => out.split(h).join('~'), s);
};

function dataDirReal(): string {
  try {
    return fs.realpathSync.native(DATA_DIR);
  } catch {
    return path.resolve(DATA_DIR);
  }
}
