/**
 * Builds a portable Windows package: release/ALON Studio/ (+ a zip).
 *   npm run release            full package (Node + ffmpeg + Python/Whisper inside)
 *   npm run release -- --no-whisper   without the bundled Python
 * Everything the app needs is inside the folder; the user double-clicks "ALON Studio.cmd".
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, execSync } from 'node:child_process';
import { build as viteBuild } from 'vite';
import { build as esbuild } from 'esbuild';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = process.env.ALON_RELEASE_DIR ? path.resolve(process.env.ALON_RELEASE_DIR) : path.join(ROOT, 'release', 'ALON Studio');
const RUNTIME = path.join(OUT, 'runtime');
const withWhisper = !process.argv.includes('--no-whisper');
const PY_VERSION = '3.12.10';
const log = (m) => console.log(`\n== ${m}`);
const where = (exe) => execSync(`where ${exe}`).toString().split(/\r?\n/)[0].trim();

fs.rmSync(OUT, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 });
fs.mkdirSync(RUNTIME, { recursive: true });

log('building the client');
await viteBuild({ root: ROOT, logLevel: 'warn', build: { outDir: path.join(OUT, 'dist'), emptyOutDir: true } });

log('bundling the server');
await esbuild({
  entryPoints: [path.join(ROOT, 'server', 'index.ts')],
  outfile: path.join(OUT, 'app', 'server.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  external: ['vite'],
  logLevel: 'warning',
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module';\nimport { fileURLToPath as __fileURLToPath } from 'node:url';\nimport { dirname as __pathDirname } from 'node:path';\nconst require = __createRequire(import.meta.url);\nconst __filename = __fileURLToPath(import.meta.url);\nconst __dirname = __pathDirname(__filename);",
  },
});
fs.mkdirSync(path.join(OUT, 'server'), { recursive: true });
fs.copyFileSync(path.join(ROOT, 'server', 'transcribe.py'), path.join(OUT, 'server', 'transcribe.py'));

log('copying Node and ffmpeg');
// NODE_EXE: a node.exe downloaded from nodejs.org and checked against SHASUMS256.txt (otherwise: the one running this script)
fs.copyFileSync(process.env.NODE_EXE ?? process.execPath, path.join(RUNTIME, 'node.exe'));
console.log('   node ' + execFileSync(path.join(RUNTIME, 'node.exe'), ['-v']).toString().trim());
for (const exe of ['ffmpeg', 'ffprobe']) {
  const src = process.env[`${exe.toUpperCase()}_PATH`] ?? where(exe);
  fs.copyFileSync(fs.realpathSync(src), path.join(RUNTIME, `${exe}.exe`));
}

if (withWhisper) {
  log(`bundling Python ${PY_VERSION} + faster-whisper`);
  const py = path.join(RUNTIME, 'python');
  const cache = path.join(ROOT, 'release', `python-${PY_VERSION}-embed-amd64.zip`);
  if (!fs.existsSync(cache)) {
    const res = await fetch(`https://www.python.org/ftp/python/${PY_VERSION}/python-${PY_VERSION}-embed-amd64.zip`);
    if (!res.ok) throw new Error(`python download failed: ${res.status}`);
    fs.writeFileSync(cache, Buffer.from(await res.arrayBuffer()));
  }
  fs.mkdirSync(py, { recursive: true });
  execFileSync(path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'tar.exe'), ['-xf', cache, '-C', py], { stdio: 'inherit' });
  const pth = fs.readdirSync(py).find((f) => f.endsWith('._pth'));
  fs.writeFileSync(path.join(py, pth), `${pth.replace('._pth', '.zip')}\n.\nLib\\site-packages\nimport site\n`);
  const site = path.join(py, 'Lib', 'site-packages');
  // pin the exact versions that are installed (and tested) on the build machine
  const hostPy = process.env.WHISPER_PYTHON ?? 'python';
  const pinScript = ['import importlib.metadata as m', "for p in ['faster-whisper','av','ctranslate2','tokenizers','onnxruntime','huggingface-hub','numpy']: print(p+'=='+m.version(p))"].join(String.fromCharCode(10));
  const pins = execFileSync(hostPy, ['-c', pinScript]).toString().trim().split(/\s+/);
  console.log('   ' + pins.join('  '));
  fs.mkdirSync(site, { recursive: true });
  execFileSync(process.env.WHISPER_PYTHON ?? 'python', ['-m', 'pip', 'install', '--quiet', '--no-warn-script-location', '--disable-pip-version-check', '--only-binary=:all:', '--python-version', '3.12', '--platform', 'win_amd64', '--target', site, ...pins, 'setuptools<81'], { stdio: 'inherit' });
  // trim what the app never uses
  for (const junk of ['pip', 'wheel']) for (const f of fs.readdirSync(site)) if (f === junk || f.startsWith(junk + '-')) fs.rmSync(path.join(site, f), { recursive: true, force: true });
  // console scripts (their launchers embed the build machine's path), test suites, headers, type stubs,
  // static libraries and byte-code compiled here (it records build-machine paths; Python rebuilds it on first use)
  fs.rmSync(path.join(site, 'bin'), { recursive: true, force: true });
  const trimmed = { files: 0, bytes: 0 };
  const trim = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === '__pycache__' || e.name === 'tests' || e.name === 'include') fs.rmSync(full, { recursive: true, force: true });
        else trim(full);
      } else if (/\.(pyi|h|hpp|lib|f90|pxd|pyx)$/i.test(e.name)) {
        trimmed.files++;
        trimmed.bytes += fs.statSync(full).size;
        fs.rmSync(full, { force: true });
      }
    }
  };
  trim(site);
  console.log(`   trimmed ${trimmed.files} build-only files (${Math.round(trimmed.bytes / 1e6)} MB) plus caches and tests`);
  // the Visual C++ runtime that CTranslate2 / ONNX Runtime link against: shipped next to python.exe
  // (app-local deployment), so a PC without the VC++ redistributable can still transcribe
  const sys32 = path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32');
  for (const dll of ['msvcp140.dll', 'msvcp140_1.dll', 'vcruntime140.dll', 'vcruntime140_1.dll']) {
    if (fs.existsSync(path.join(sys32, dll))) fs.copyFileSync(path.join(sys32, dll), path.join(py, dll));
  }
  const out = execFileSync(path.join(py, 'python.exe'), ['-B', '-c', 'import faster_whisper, ctranslate2, onnxruntime, av;print(faster_whisper.__version__)']).toString().trim();
  console.log(`   faster-whisper ${out} works inside the bundle`);
}

log('writing the launcher and notes');
const launcher = `@echo off
setlocal
cd /d "%~dp0"
set "NODE_ENV=production"
set "ALON_OPEN=1"
set "PORT=5199"
set "ALON_DATA_DIR=%USERPROFILE%\\Documents\\ALON Studio"
set "FFMPEG_PATH=%~dp0runtime\\ffmpeg.exe"
set "FFPROBE_PATH=%~dp0runtime\\ffprobe.exe"
if exist "%~dp0runtime\\python\\python.exe" set "WHISPER_PYTHON=%~dp0runtime\\python\\python.exe"
set "HF_HUB_DISABLE_TELEMETRY=1"
set "HF_HUB_DISABLE_IMPLICIT_TOKEN=1"
if not exist "%ALON_DATA_DIR%" mkdir "%ALON_DATA_DIR%"
rem the folder goes through an environment variable, so a path with an apostrophe cannot break the command
set "ALON_HOME=%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command "Start-Process -FilePath (Join-Path $env:ALON_HOME 'runtime\\node.exe') -ArgumentList 'app\\server.mjs' -WorkingDirectory $env:ALON_HOME -WindowStyle Hidden"
`;
fs.writeFileSync(path.join(OUT, 'ALON Studio.cmd'), launcher.replace(/\n/g, '\r\n'), 'latin1');

// install for this user (Start menu + desktop shortcut + Settings > Apps entry), without an .exe of its own:
// an unsigned setup.exe is blocked outright by Windows 11 Smart App Control, these scripts are not.
// PowerShell 5.1 reads scripts without a BOM as ANSI, so the Hebrew messages need the BOM.
const instSrc = path.join(ROOT, 'scripts', 'installer');
const instOut = path.join(RUNTIME, 'installer');
fs.mkdirSync(instOut, { recursive: true });
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
for (const f of ['install.ps1', 'uninstall.ps1']) {
  const text = fs.readFileSync(path.join(instSrc, f), 'utf8').replace(/^﻿/, '').replace(/__VERSION__/g, VERSION);
  fs.writeFileSync(path.join(instOut, f), '﻿' + text.replace(/\r?\n/g, '\r\n'), 'utf8');
}
fs.copyFileSync(path.join(instSrc, 'icon.ico'), path.join(instOut, 'icon.ico'));
const installCmd = fs.readFileSync(path.join(instSrc, 'install.cmd'), 'utf8').replace(/\r?\n/g, '\r\n');
if (/[^\x00-\x7f]/.test(installCmd)) throw new Error('scripts/installer/install.cmd must stay ASCII');
fs.writeFileSync(path.join(OUT, 'התקנה.cmd'), installCmd, 'latin1');

const readme = `ALON.ai Studio - עורך וידאו מקומי
=====================================

התקנה (מומלץ)
--------------
1. לפני החילוץ: לחיצה ימנית על קובץ ה-ZIP > מאפיינים (Properties). אם למטה יש תיבה
   "ביטול חסימה" (Unblock), מסמנים אותה ולוחצים "אישור". בלי זה Windows 11 עלול לחסום את התוכנה.
2. לחיצה ימנית על קובץ ה-ZIP ואז "חלץ הכל" (Extract All). לא להפעיל מתוך ה-ZIP.
3. בתיקייה שנוצרה: לחיצה כפולה על "התקנה".
4. מאשרים, ותוך פחות מדקה התוכנה מותקנת: יש אייקון "ALON Studio" בשולחן העבודה ובתפריט התחל.
5. אחרי ההתקנה אפשר למחוק את התיקייה שחילצתם ואת קובץ ה-ZIP.

עדכון לגרסה חדשה: עושים את אותו הדבר עם ה-ZIP החדש. הפרויקטים והסרטונים נשארים.
ההתקנה לא מבקשת הרשאות מנהל ומתקינה רק למשתמש הנוכחי.

בלי התקנה (גרסה ניידת)
----------------------
אפשר גם להפעיל ישירות מהתיקייה שחילצתם (אחרי שלבים 1-2 למעלה): לחיצה כפולה על "ALON Studio" (הקובץ ALON Studio.cmd).
כך אפשר להריץ גם מדיסק און קי. התוכנה המותקנת והניידת משתמשות באותם פרויקטים.

הסטודיו נפתח בחלון משלו. סגירת החלון סוגרת את התוכנה.
אם Windows מציג אזהרה כחולה ("Windows protected your PC"): לחצו "More info" ואז "Run anyway".
בהפעלה הראשונה ייתכן ש-Windows ישאל על גישה לרשת: אפשר לסרב, התוכנה עובדת רק בתוך המחשב.

מה צריך במחשב
--------------
Windows 10 או 11 (64 ביט), עם Edge או Chrome. אין צורך להתקין שום דבר נוסף.

כתוביות אוטומטיות
------------------
בפעם הראשונה שלוחצים "תמלול אוטומטי" התוכנה מורידה את מודל התמלול (כ-1.5GB, פעם אחת בלבד),
ולכן צריך חיבור לאינטרנט באותה פעם. אחר כך הכול עובד בלי אינטרנט.

איפה הקבצים שלי
----------------
הפרויקטים, המדיה והסרטונים המיוצאים נשמרים בתיקייה הזו (העתיקו לשורת הכתובת של סייר הקבצים):
  %USERPROFILE%\\Documents\\ALON Studio
הסרטונים המיוצאים נמצאים בתת-התיקייה exports. אפשר גם ללחוץ "פתיחת התיקייה" אחרי ייצוא.
אפשר להחליף את תיקיית התוכנה בגרסה חדשה בלי לאבד פרויקטים.

פרטיות ואבטחה
--------------
- הכול נשמר רק במחשב הזה. הסרטונים וההקלטות לא נשלחים לשום מקום.
  החיבור היחיד לאינטרנט הוא הורדת מודל התמלול בפעם הראשונה (בלי הקול שלכם).
- מחיקת פרויקט מוחקת גם את הסרטונים שהועלו אליו. סרטונים שייצאתם נשארים בתיקיית exports.
- הקבצים מוגנים על ידי Windows. מומלץ לוודא שהצפנת המכשיר פועלת:
  הגדרות > פרטיות ואבטחה > הצפנת מכשיר (Device encryption).
- אם OneDrive מגבה את תיקיית המסמכים, גם תיקיית הסטודיו תעלה לענן. אפשר להחריג אותה בהגדרות OneDrive.

הסרה מלאה
----------
1. תוכנה מותקנת: הגדרות > אפליקציות > אפליקציות מותקנות > ALON Studio > הסרת התקנה.
   (ההסרה משאירה את הפרויקטים והסרטונים.) גרסה ניידת: סוגרים את חלון הסטודיו ומוחקים את התיקייה שלה.
2. כדי למחוק גם את הפרויקטים והסרטונים: מחקו את התיקייה  %USERPROFILE%\\Documents\\ALON Studio
3. מודל התמלול נשמר ב-  %USERPROFILE%\\.cache\\huggingface\\hub  (התיקיות שמתחילות ב-models--Systran--faster-whisper).

קיצורי מקלדת
-------------
רווח            נגן / עצור
S               פיצול בסמן
Delete          מחיקת הקליפ הנבחר (עם Shift: סגירת הרווח)
I / O           נקודות In / Out
X               מחיקת הטווח שבין In ל-Out
Ctrl+Z / Ctrl+Y ביטול / שחזור
Ctrl+D          שכפול קליפ
Ctrl+C / Ctrl+V העתקה והדבקה במיקום הסמן
Ctrl + גלגלת    זום בציר הזמן

תקלה?
------
אם התוכנה לא נפתחת, שלחו את הקובץ:  %USERPROFILE%\\Documents\\ALON Studio\\studio.log
(הקובץ יכול להכיל שמות של קבצים ופרויקטים. כדאי להציץ בו לפני ששולחים.)
`;
fs.writeFileSync(path.join(OUT, 'קרא אותי.txt'), '﻿' + readme.replace(/\n/g, '\r\n'), 'utf8');

// the app's own licence (GPL-3.0-or-later), next to the notices of what it bundles
fs.copyFileSync(path.join(ROOT, 'LICENSE'), path.join(OUT, 'LICENSE.txt'));
fs.writeFileSync(
  path.join(OUT, 'LICENSES.txt'),
  `ALON.ai Studio is free software under the GNU General Public License v3.0 or later (LICENSE.txt).
Its source code is published with each release.

ALON.ai Studio bundles the following third-party software, each under its own licence.
The full component list, licence texts and GPL source information are in THIRD-PARTY-NOTICES.txt
(written by "npm run release:docs"), the machine-readable list in sbom.cdx.json.

- FFmpeg (ffmpeg.exe, ffprobe.exe) - GPL v3 build by gyan.dev. Source code: https://ffmpeg.org/download.html and https://www.gyan.dev/ffmpeg/builds/
- Node.js (node.exe) - MIT licence. https://nodejs.org
- Python ${PY_VERSION} embeddable package - PSF licence. https://www.python.org
- faster-whisper (MIT), CTranslate2 (MIT), PyAV (BSD), ONNX Runtime (MIT), tokenizers (Apache-2.0), huggingface_hub (Apache-2.0), NumPy (BSD)
- Whisper speech recognition models by OpenAI (MIT), downloaded on first use from huggingface.co
- JavaScript libraries: React, Express, Zustand, Zod, Model Context Protocol SDK, Multer (MIT / ISC)
`.replace(/\n/g, '\r\n'),
);

const size = (dir) => fs.readdirSync(dir, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? size(path.join(dir, e.name)) : fs.statSync(path.join(dir, e.name)).size), 0);
console.log(`\nDONE  ${OUT}  (${Math.round(size(OUT) / 1e6)} MB)`);
