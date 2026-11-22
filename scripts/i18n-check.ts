/**
 * The bilingual UI check: every string in src/i18n.ts has Hebrew and English with the same
 * {slots}, every label list in shared/ (and the sound effects) has an English entry with the same Hebrew,
 * and no Hebrew literal is left in the components (outside comments).
 *   npx tsx scripts/i18n-check.ts          (also run by scripts/regress.ts)
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { STRINGS } from '../src/i18n';
import { ANIM_LABELS, BLEND_LABELS, CAPTION_PRESETS, EASE_LABELS, LOOKS, TEXT_PRESETS, TRANSITION_LABELS } from '../shared/types';
import { EXPORT_PRESETS } from '../shared/layout';

// server/sfx.ts sits on the data folder: never let this check touch the real one
process.env.ALON_DATA_DIR ??= path.join(os.tmpdir(), 'alon-test-data');
const { SFX, SFX_GROUPS } = await import('../server/sfx');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HEB = /[֐-׿]/;
const problems: string[] = [];
const entries = Object.entries(STRINGS as Record<string, readonly [string, string]>);
// the toggle shows the other language's name on purpose
const HEBREW_IN_ENGLISH_OK = new Set(['lang.toggle', 'lang.toggleTitle']);
const slots = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

for (const [key, v] of entries) {
  if (!Array.isArray(v) || v.length !== 2) {
    problems.push(`${key}: not a [Hebrew, English] pair`);
    continue;
  }
  const [he, en] = v;
  if (!he.trim()) problems.push(`${key}: Hebrew is empty`);
  if (!en.trim()) problems.push(`${key}: English is empty`);
  if (HEB.test(en) && !HEBREW_IN_ENGLISH_OK.has(key)) problems.push(`${key}: the English text has Hebrew letters: ${en}`);
  // a singular English form ('...One') may say "one" instead of {n}
  if (slots(he) !== slots(en) && !(key.endsWith('One') && slots(en) === slots(he).replace(/(^|,)n(,|$)/, '$1').replace(/^,|,$/g, ''))) problems.push(`${key}: different {slots} - he {${slots(he)}} en {${slots(en)}}`);
}

// lists that live in shared/ (the server uses their Hebrew) are shown through tl(group, id, he)
const lists: [string, Record<string, string>][] = [
  ['anim', ANIM_LABELS],
  ['tr', TRANSITION_LABELS],
  ['blend', BLEND_LABELS],
  ['ease', EASE_LABELS],
  ['look', Object.fromEntries(LOOKS.map((x) => [x.id, x.label]))],
  ['capStyle', Object.fromEntries(CAPTION_PRESETS.map((x) => [x.id, x.label]))],
  ['textStyle', Object.fromEntries(TEXT_PRESETS.map((x) => [x.id, x.label]))],
  ['textSample', Object.fromEntries(TEXT_PRESETS.map((x) => [x.id, x.sample]))],
  ['exportPreset', Object.fromEntries(EXPORT_PRESETS.map((x) => [x.id, x.label]))],
  ['sfx', Object.fromEntries(SFX.map((x) => [x.id, x.name]))],
  ['sfxGroup', Object.fromEntries(SFX_GROUPS.map((x) => [x.id, x.name]))],
];
const table = STRINGS as Record<string, readonly [string, string]>;
for (const [group, list] of lists)
  for (const [id, he] of Object.entries(list)) {
    const e = table[`${group}.${id}`];
    if (!e) problems.push(`${group}.${id}: no English for "${he}"`);
    else if (e[0] !== he) problems.push(`${group}.${id}: Hebrew differs from the list ("${e[0]}" vs "${he}")`);
  }

// no Hebrew literal left in the UI code (comments are fine)
const files = [
  ...fs.readdirSync(path.join(ROOT, 'src/components')).filter((f) => f.endsWith('.tsx')).map((f) => `src/components/${f}`),
  'src/App.tsx', 'src/store.ts', 'src/actions.ts', 'src/fonts.ts', 'src/key.ts', 'src/main.tsx',
];
const stripComments = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
for (const f of files) {
  const code = stripComments(fs.readFileSync(path.join(ROOT, f), 'utf8'));
  code.split('\n').forEach((line, i) => {
    if (HEB.test(line)) problems.push(`${f}:${i + 1}: Hebrew text outside src/i18n.ts: ${line.trim().slice(0, 90)}`);
  });
}

// keys used in the code exist (t('x.y') with a literal key; tsc checks most of these too)
const used = new Set<string>();
for (const f of files) for (const m of fs.readFileSync(path.join(ROOT, f), 'utf8').matchAll(/\bt\(\s*'([\w.]+)'/g)) used.add(m[1]);
for (const k of used) if (!table[k]) problems.push(`t('${k}') has no entry`);

if (problems.length) {
  console.log(problems.map((p) => '  FAIL ' + p).join('\n'));
  throw new Error(`i18n check: ${problems.length} problem(s)`);
}
console.log(`  ok  i18n: ${entries.length} strings in Hebrew and English, ${lists.length} shared lists covered, no Hebrew left in ${files.length} UI files (${used.size} keys used directly)`);
