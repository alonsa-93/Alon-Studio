import fs from 'node:fs';
import path from 'node:path';
import { FFMPEG, run } from './media';
import { DATA_DIR, HttpError } from './store';

/** Built-in sound effects, synthesised locally with ffmpeg the first time they are needed. */
export const SFX_DIR = path.join(DATA_DIR, 'library', 'sfx');
fs.mkdirSync(SFX_DIR, { recursive: true });

export type SfxGroup = 'motion' | 'impact' | 'ui' | 'tones';
/** Groups in the order the library shows them, with their Hebrew labels. */
export const SFX_GROUPS: { id: SfxGroup; name: string }[] = [
  { id: 'motion', name: 'תנועה ומעברים' },
  { id: 'impact', name: 'מכות והדגשות' },
  { id: 'ui', name: 'ממשק' },
  { id: 'tones', name: 'צלילים' },
];

interface SfxDef {
  id: string;
  group: SfxGroup;
  name: string;
  duration: number;
  source: string; // lavfi source
  filter?: string;
}

const ev = (expr: string, d: number) => `aevalsrc=exprs='${expr}':d=${d}:s=48000`;
const noise = (d: number, c = 'white', a = 0.8) => `anoisesrc=d=${d}:c=${c}:r=48000:a=${a}`;

export const SFX: SfxDef[] = [
  { id: 'whoosh', group: 'motion', name: 'וווש', duration: 0.7, source: 'anoisesrc=d=0.7:c=pink:r=48000:a=0.9', filter: 'bandpass=f=1400:w=1100,afade=t=in:d=0.3:curve=qsin,afade=t=out:st=0.3:d=0.4,volume=40dB,alimiter=limit=0.7' },
  { id: 'pop', group: 'ui', name: 'פופ', duration: 0.15, source: ev('0.8*sin(2*PI*(520-1400*t)*t)*exp(-32*t)', 0.15) },
  { id: 'click', group: 'ui', name: 'קליק', duration: 0.06, source: ev('0.7*sin(2*PI*1900*t)*exp(-160*t)', 0.06) },
  { id: 'ding', group: 'tones', name: 'דינג', duration: 1.4, source: ev('0.45*sin(2*PI*1320*t)*exp(-3.5*t)+0.2*sin(2*PI*2640*t)*exp(-5*t)', 1.4) },
  { id: 'success', group: 'tones', name: 'הצלחה', duration: 1.0, source: ev('0.4*sin(2*PI*880*t)*exp(-7*t)*lt(t\\,0.16)+0.4*sin(2*PI*1318.5*t)*exp(-4.5*(t-0.16))*gte(t\\,0.16)', 1.0) },
  { id: 'boom', group: 'impact', name: 'בום', duration: 1.3, source: ev('0.95*sin(2*PI*(95-30*t)*t)*exp(-3.2*t)', 1.3), filter: 'afade=t=out:st=1.0:d=0.3' },
  { id: 'riser', group: 'motion', name: 'עלייה', duration: 2.0, source: ev('0.35*sin(2*PI*(180+380*t)*t)*min(t/1.6\\,1)', 2.0), filter: 'afade=t=out:st=1.9:d=0.1' },
  { id: 'notify', group: 'ui', name: 'התראה', duration: 0.6, source: ev('0.4*sin(2*PI*1046.5*t)*exp(-9*t)+0.35*sin(2*PI*1568*t)*exp(-8*max(t-0.12\\,0))*gte(t\\,0.12)', 0.6) },
  { id: 'error', group: 'ui', name: 'שגיאה', duration: 0.45, source: ev('0.3*(sin(2*PI*160*t)+sin(2*PI*166*t))*lt(mod(t\\,0.24)\\,0.17)', 0.45) },
  { id: 'swipe', group: 'motion', name: 'החלקה', duration: 0.35, source: 'anoisesrc=d=0.35:c=white:r=48000:a=0.7', filter: 'highpass=f=2500,afade=t=in:d=0.12,afade=t=out:st=0.12:d=0.23,volume=1.5' },
  { id: 'swish', group: 'motion', name: 'סוויש', duration: 0.4, source: noise(0.4), filter: 'bandpass=f=3200:w=2600,afade=t=in:d=0.12:curve=qsin,afade=t=out:st=0.12:d=0.28,volume=26dB,alimiter=limit=0.7' },
  { id: 'tape-stop', group: 'motion', name: 'עצירת קלטת', duration: 0.9, source: ev('0.5*sin(2*PI*(220*t-110*t*t/0.9))*(1-t/0.9)+0.25*sin(2*PI*(440*t-220*t*t/0.9))*(1-t/0.9)', 0.9) },
  { id: 'drop', group: 'motion', name: 'נפילה', duration: 0.8, source: ev('0.45*sin(2*PI*(1200*t-650*t*t))*exp(-1.5*t)', 0.8), filter: 'afade=t=out:st=0.6:d=0.2' },
  { id: 'zip', group: 'motion', name: 'רוכסן', duration: 0.35, source: ev('0.4*sin(2*PI*(300*t+2400*t*t))*lt(mod(t\\,0.018)\\,0.009)', 0.35), filter: 'afade=t=out:st=0.25:d=0.1' },
  { id: 'reverse', group: 'motion', name: 'שאיבה לאחור', duration: 1.2, source: noise(1.2, 'pink', 0.9), filter: 'highpass=f=1800,afade=t=in:d=1.15:curve=exp,afade=t=out:st=1.15:d=0.05,volume=14dB,alimiter=limit=0.7' },
  { id: 'impact', group: 'impact', name: 'מכה', duration: 0.9, source: ev('0.9*sin(2*PI*(70-25*t)*t)*exp(-5*t)+0.3*(random(0)-0.5)*exp(-28*t)', 0.9) },
  { id: 'sub-drop', group: 'impact', name: 'צלילה עמוקה', duration: 1.6, source: ev('0.95*sin(2*PI*(110*t-30*t*t))*exp(-1.6*t)', 1.6), filter: 'afade=t=out:st=1.3:d=0.3' },
  { id: 'thud', group: 'impact', name: 'חבטה', duration: 0.4, source: ev('0.95*sin(2*PI*(90-60*t)*t)*exp(-14*t)', 0.4) },
  { id: 'punch', group: 'impact', name: 'אגרוף', duration: 0.3, source: ev('0.8*sin(2*PI*(160-200*t)*t)*exp(-18*t)+0.5*(random(0)-0.5)*exp(-60*t)', 0.3) },
  { id: 'clap', group: 'impact', name: 'מחיאה', duration: 0.35, source: noise(0.35, 'white', 1), filter: 'highpass=f=700,lowpass=f=3000,afade=t=out:st=0.01:d=0.3:curve=qua,volume=2dB' },
  { id: 'glitch', group: 'impact', name: 'גליץ׳', duration: 0.45, source: ev('0.35*(2*gte(sin(2*PI*(80+900*floor(mod(t*37\\,7)))*t)\\,0)-1)*lt(mod(t\\,0.06)\\,0.04)', 0.45) },
  { id: 'typing', group: 'ui', name: 'הקלדה', duration: 1.2, source: ev('0.6*sin(2*PI*2400*t)*exp(-260*mod(t\\,0.11))*lt(mod(t\\,0.11)\\,0.03)', 1.2) },
  { id: 'shutter', group: 'ui', name: 'צמצם מצלמה', duration: 0.3, source: noise(0.3, 'white', 0.9), filter: "highpass=f=2000,volume='exp(-40*t)+0.8*exp(-60*max(t-0.12\\,0))*gte(t\\,0.12)':eval=frame,volume=6dB,alimiter=limit=0.7" },
  { id: 'toggle', group: 'ui', name: 'מתג', duration: 0.12, source: ev('0.6*sin(2*PI*1200*t)*exp(-90*t)+0.4*sin(2*PI*1800*(t-0.05))*exp(-90*(t-0.05))*gte(t\\,0.05)', 0.12) },
  { id: 'bubble', group: 'ui', name: 'בועה', duration: 0.25, source: ev('0.6*sin(2*PI*(400+1600*t)*t)*exp(-14*t)', 0.25) },
  { id: 'chime', group: 'tones', name: 'פעמון רוח', duration: 1.6, source: ev('0.5*sin(2*PI*1568*t)*exp(-3*t)+0.4*sin(2*PI*2093*(t-0.12))*exp(-3*(t-0.12))*gte(t\\,0.12)+0.35*sin(2*PI*2637*(t-0.24))*exp(-3*(t-0.24))*gte(t\\,0.24)', 1.6) },
  { id: 'coin', group: 'tones', name: 'מטבע', duration: 0.5, source: ev('0.3*(2*gte(sin(2*PI*(988+lt(0.08\\,t)*331)*t)\\,0)-1)*exp(-6*t)', 0.5) },
  { id: 'sparkle', group: 'tones', name: 'נצנוץ', duration: 1.0, source: ev('0.45*sin(2*PI*(2500+1500*sin(2*PI*9*t))*t)*exp(-3*t)+0.3*sin(2*PI*4200*t)*exp(-6*t)', 1.0) },
  { id: 'bell', group: 'tones', name: 'פעמון', duration: 2.0, source: ev('0.4*sin(2*PI*660*t)*exp(-2*t)+0.2*sin(2*PI*1650*t)*exp(-3*t)+0.1*sin(2*PI*2310*t)*exp(-4*t)', 2.0) },
  { id: 'magic', group: 'tones', name: 'קסם', duration: 1.2, source: ev('0.6*sin(2*PI*(600*t+900*t*t))*exp(-1.8*t)*(0.6+0.4*sin(2*PI*14*t))', 1.2), filter: 'afade=t=out:st=1.0:d=0.2' },
  { id: 'jump', group: 'tones', name: 'קפיצה', duration: 0.3, source: ev('0.6*(2*gte(sin(2*PI*(300*t+1500*t*t))\,0)-1)*exp(-5*t)', 0.3) },
];

const SFX_VERSION = 'v3';
const pending = new Map<string, Promise<string>>();

export function sfxFile(id: string): Promise<string> {
  const def = SFX.find((x) => x.id === id);
  if (!def) throw new HttpError(404, `unknown sound effect: ${id}`);
  const out = path.join(SFX_DIR, `${def.id}_${SFX_VERSION}.wav`);
  if (fs.existsSync(out)) return Promise.resolve(out);
  let job = pending.get(id);
  if (!job) {
    job = (async () => {
      const tmp = out + '.tmp.wav';
      const args = ['-y', '-v', 'error', '-f', 'lavfi', '-i', def.source, ...(def.filter ? ['-af', def.filter] : []), '-ac', '2', '-ar', '48000', '-c:a', 'pcm_s16le', tmp];
      const r = await run(FFMPEG, args);
      if (r.code !== 0) throw new Error(`sound effect "${id}" failed: ${r.stderr.trim()}`);
      fs.renameSync(tmp, out);
      return out;
    })().finally(() => pending.delete(id));
    pending.set(id, job);
  }
  return job;
}

export async function listSfx() {
  // Four ffmpeg runs at a time: the first call makes all of them.
  const ids = SFX.map((s) => s.id);
  for (let i = 0; i < ids.length; i += 4) await Promise.all(ids.slice(i, i + 4).map((id) => sfxFile(id)));
  return SFX.map((s) => ({ id: s.id, group: s.group, name: s.name, duration: s.duration, url: `/library/sfx/${s.id}_${SFX_VERSION}.wav` }));
}
