/**
 * Gate 8: real projects made before a change still open, export and look the same.
 *   npx tsx scripts/old-projects.ts [projectId ...]
 * Env: BASE_URL (test instance), ALON_DATA_DIR (its data folder), OLD_PROJECTS_SRC (read-only source,
 * default ./data), PARITY_BASELINE (default %TEMP%/alon-test-baseline).
 * Copies each project (JSON + its media) into the test data folder without touching the source, exports
 * it, grabs 5 frames and compares them with the frames saved on the first run (PSNR, threshold below).
 * Delete the baseline folder to take a new baseline on purpose.
 */
import './auth.mjs';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = process.env.BASE_URL ?? 'http://localhost:5182';
const DATA = process.env.ALON_DATA_DIR ?? path.join(os.tmpdir(), 'alon-test-data');
const SRC = path.resolve(process.env.OLD_PROJECTS_SRC ?? 'data');
const BASELINE = process.env.PARITY_BASELINE ?? path.join(os.tmpdir(), 'alon-test-baseline');
/** Which projects: the arguments, else OLD_PROJECTS (comma separated), else the ones that already have a
 *  baseline, else the first 3 in the source folder. A fresh checkout has none: the gate is skipped. */
function pickProjects(): string[] {
  const args = process.argv.slice(2);
  if (args.length) return args;
  if (process.env.OLD_PROJECTS) return process.env.OLD_PROJECTS.split(',').map((s) => s.trim()).filter(Boolean);
  const dir = path.join(SRC, 'projects');
  // only projects with something to export whose media is still on disk
  const usable = (id: string) => {
    try {
      const p = JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf8'));
      return p.clips?.length > 0 && p.media.every((m: { file: string }) => fs.existsSync(path.join(SRC, 'media', m.file)));
    } catch {
      return false;
    }
  };
  const found = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^p_\w+\.json$/.test(f)).map((f) => f.slice(0, -5)).sort().filter(usable) : [];
  const withBaseline = found.filter((id) => fs.existsSync(path.join(BASELINE, id, 'meta.json')));
  return (withBaseline.length ? withBaseline : found).slice(0, 3);
}
const IDS = pickProjects();
if (!IDS.length) {
  console.log(`SKIPPED: no saved projects in ${SRC} (set OLD_PROJECTS_SRC to a data folder with projects)`);
  process.exit(0);
}
/** same pipeline and encoder settings give near-identical frames; below this something visibly changed */
const MIN_PSNR = 35;

let failures = 0;
const check = (ok: unknown, msg: string) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${msg}`);
  if (!ok) failures++;
};
async function api(url: string, init?: RequestInit) {
  const res = await fetch(BASE + url, init);
  const data = await res.json();
  if (!res.ok) throw new Error(`${url}: ${data.error}`);
  return data;
}
async function waitJob(jobId: string) {
  for (;;) {
    const job = await api(`/api/jobs/${jobId}`);
    if (job.status !== 'running') return job;
    await new Promise((r) => setTimeout(r, 700));
  }
}
function psnr(a: string, b: string): number {
  // ffmpeg prints the psnr summary on stderr
  const r = spawnSync('ffmpeg', ['-hide_banner', '-i', a, '-i', b, '-lavfi', 'psnr', '-f', 'null', '-'], { encoding: 'utf8' });
  return parsePsnr(r.stderr ?? '');
}
function parsePsnr(s: string): number {
  const m = /average:(inf|[\d.]+)/.exec(s);
  return !m ? 0 : m[1] === 'inf' ? Infinity : Number(m[1]);
}

for (const id of IDS) {
  console.log(`\n${id}`);
  const srcJson = path.join(SRC, 'projects', `${id}.json`);
  const project = JSON.parse(fs.readFileSync(srcJson, 'utf8'));
  fs.mkdirSync(path.join(DATA, 'media'), { recursive: true });
  fs.mkdirSync(path.join(DATA, 'projects'), { recursive: true });
  for (const m of project.media) {
    for (const f of [m.file, m.proxy, m.thumb, m.wave].filter(Boolean)) {
      const to = path.join(DATA, 'media', f);
      if (!fs.existsSync(to)) fs.copyFileSync(path.join(SRC, 'media', f), to);
    }
  }
  fs.copyFileSync(srcJson, path.join(DATA, 'projects', `${id}.json`));

  const opened = await api(`/api/projects/${id}`);
  check(opened.clips.length === project.clips.length && opened.media.length === project.media.length, `opens with all ${project.clips.length} clips and ${project.media.length} media`);
  const job = await waitJob((await api(`/api/projects/${id}/export`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ quality: 'medium' }) })).jobId);
  check(job.status === 'done', `export: ${job.status} ${job.error ?? ''}`);
  if (job.status !== 'done') continue;
  const dur = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', job.file]).toString());
  const dir = path.join(BASELINE, id);
  const fresh = !fs.existsSync(path.join(dir, 'meta.json'));
  fs.mkdirSync(dir, { recursive: true });
  if (fresh) fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ duration: dur, takenAt: new Date().toISOString() }));
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  check(Math.abs(dur - meta.duration) < 0.05, `duration ${dur.toFixed(2)}s (baseline ${meta.duration.toFixed(2)}s)`);
  const scores: string[] = [];
  for (const frac of [0.1, 0.3, 0.5, 0.7, 0.9]) {
    const t = (meta.duration * frac).toFixed(3);
    const base = path.join(dir, `f${frac}.png`);
    const now = path.join(os.tmpdir(), `alon-old-${id}-${frac}.png`);
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', t, '-i', job.file, '-frames:v', '1', fresh ? base : now]);
    if (fresh) continue;
    const p = psnr(base, now);
    scores.push(p === Infinity ? 'identical' : p.toFixed(1));
    check(p >= MIN_PSNR, `frame at ${t}s: PSNR ${p === Infinity ? 'identical' : p.toFixed(1) + ' dB'} (min ${MIN_PSNR})`);
  }
  if (fresh) console.log(`  baseline taken: ${dir}`);
  await api(`/api/projects/${id}`, { method: 'DELETE' }).catch(() => {});
}
console.log(failures ? `\n${failures} FAILED` : '\nALL GOOD');
process.exit(failures ? 1 : 0);
