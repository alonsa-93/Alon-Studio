// Regenerates scripts/installer/install.cmd: node scripts/installer/gen-install-cmd.mjs
// The .cmd must stay ASCII (cmd.exe reads it in the OEM code page), so the Hebrew message is a list of character codes.
import fs from 'node:fs';
import path from 'node:path';
const msg = 'קודם צריך לחלץ את קובץ ה-zip:\nלחיצה ימנית על הקובץ > "חלץ הכל".\nאחר כך פותחים את התיקייה שנוצרה ולוחצים שוב על "התקנה".';
const codes = [...msg].map((c) => c.charCodeAt(0)).join(',');
const BS = String.fromCharCode(92);
const lines = [
  '@echo off',
  'rem Copied into the release under a Hebrew name ("install"). Installs ALON Studio for this user (see runtime' + BS + 'installer' + BS + 'install.ps1).',
  'rem Kept ASCII-only: the Hebrew message below is written as character codes. Regenerate with scripts/installer/gen-install-cmd.mjs.',
  `if not exist "%~dp0runtime${BS}installer${BS}install.ps1" goto notextracted`,
  `powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0runtime${BS}installer${BS}install.ps1"`,
  'exit /b %errorlevel%',
  ':notextracted',
  `powershell -NoProfile -WindowStyle Hidden -Command "Add-Type -AssemblyName System.Windows.Forms; [void][System.Windows.Forms.MessageBox]::Show((-join [char[]](${codes})), 'ALON Studio', 'OK', 'Warning', 'Button1', 'RtlReading, RightAlign')"`,
  'exit /b 1',
  '',
];
const out = lines.join('\r\n');
if (/[^\x00-\x7f]/.test(out)) throw new Error('not ASCII');
fs.writeFileSync(path.join(import.meta.dirname, 'install.cmd'), out, 'latin1');
console.log('written install.cmd', out.length, 'bytes');
