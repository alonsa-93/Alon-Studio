import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DATA_DIR } from './store';
import { redact } from './security';

/** "Desktop app" mode (packaged build): open the studio in its own window and quit when it closes. */
export const APP_MODE = process.env.ALON_OPEN === '1';

export function setupLogFile() {
  if (!APP_MODE) return;
  const file = path.join(DATA_DIR, 'studio.log');
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > 2_000_000) fs.rmSync(file);
  } catch {
    /* ignore */
  }
  let written = 0;
  const write = (level: string, args: unknown[]) => {
    const line = redact(`${new Date().toISOString()} ${level} ${args.map((a) => (a instanceof Error ? a.stack ?? a.message : typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`).slice(0, 4000) + '\n';
    // a runaway error loop cannot fill the disk: at most ~2 MB per run
    if ((written += line.length) > 2_000_000) return;
    fs.appendFile(file, line, () => {});
  };
  console.log = (...a) => write('info', a);
  console.error = (...a) => write('error', a);
  // an unexpected crash: write it down and stop (the window shows that the studio has to be reopened)
  const die = (e: unknown) => {
    write('fatal', [e]);
    setTimeout(() => process.exit(1), 200);
  };
  process.on('uncaughtException', die);
  process.on('unhandledRejection', die);
}

function findBrowser(): string | null {
  const roots = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean) as string[];
  const rel = ['Microsoft\\Edge\\Application\\msedge.exe', 'Google\\Chrome\\Application\\chrome.exe'];
  for (const r of rel) for (const root of roots) if (fs.existsSync(path.join(root, r))) return path.join(root, r);
  return null;
}

/**
 * Opens the studio in its own window. The server itself runs hidden, and a window started directly
 * from a hidden process inherits "hidden" - so the browser is started through `cmd /c start`,
 * which gives it a normal, visible window.
 */
export function openAppWindow(url: string): void {
  if (process.platform !== 'win32') {
    spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    return;
  }
  const browser = findBrowser();
  const profile = path.join(DATA_DIR, 'window-profile');
  // the window's disk cache may hold pieces of earlier projects, and its history / session files the
  // addresses it was opened with (older versions put the access key there): every session starts without them
  for (const dir of ['Cache', 'Code Cache', 'History', 'History-journal', 'Visited Links', 'Sessions', 'Session Storage', 'Current Session', 'Current Tabs', 'Last Session', 'Last Tabs']) {
    try {
      fs.rmSync(path.join(profile, 'Default', dir), { recursive: true, force: true });
    } catch {
      /* a window is still open */
    }
  }
  const args = browser
    ? ['/c', 'start', '""', `"${browser}"`, `--app=${url}`, `"--user-data-dir=${profile}"`, '--no-first-run', '--no-default-browser-check', '--window-size=1500,920', '--disable-features=Translate', '--disable-extensions', '--disable-sync', '--no-pings']
    : ['/c', 'start', '""', url];
  const child = spawn('cmd.exe', args, { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true });
  child.on('error', (e) => console.error('could not open the app window', e));
  child.unref();
}
