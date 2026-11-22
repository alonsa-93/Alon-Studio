import { entryOf, exitOf, graphemes, neighborsOf, typedCount, type Motion } from '../shared/anim';
import { activeWord, captionTokens } from '../shared/fx';
import { textStyleOf } from '../shared/ops';
import type { Project } from '../shared/types';

/** libass sizes a font by its full line height; CSS sizes it by the em box. Ratio per font. */
export const FONT_SCALE: Record<string, number> = {
  Arial: 1.117,
  'Segoe UI': 1.33,
  Tahoma: 1.207,
  'Times New Roman': 1.107,
  'Courier New': 1.133,
  David: 1.0,
  Aharoni: 1.0,
  Gisha: 1.17,
};

const assTime = (t: number) => {
  const cs = Math.max(0, Math.round(t * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = ((cs % 6000) / 100).toFixed(2).padStart(5, '0');
  return `${h}:${String(m).padStart(2, '0')}:${s}`;
};

/** #rrggbb -> &HBBGGRR& */
const assColor = (hex: string) => {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex) ?? ['', 'ff', 'ff', 'ff'];
  return `&H${m[3]}${m[2]}${m[1]}&`.toUpperCase();
};

// newlines become \N; every other control character (a bare \r also ends an ASS line) is removed
const escapeText = (s: string) =>
  s
    .replace(/\\/g, '/')
    .replace(/[{}]/g, '')
    .replace(/\r?\n/g, '\\N')
    .replace(/[\x00-\x1f\x7f\u2028\u2029]/g, '');

/** Outline width (px) used when a text has no background box. Shared with the preview. */
export const outlineOf = (size: number) => Math.max(2, Math.round(size * 0.05));
export const boxPadOf = (size: number) => Math.round(size * 0.22);

/** `custom`: fonts the user added (family -> size ratio); any other unknown name falls back to Arial. */
export function buildAss(p: Project, hasText: { count: number }, custom: Map<string, number> = new Map()): string {
  const { width: W, height: H } = p.settings;
  const head = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${W}`,
    `PlayResY: ${H}`,
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: Plain,Arial,64,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,3,0,5,0,0,0,-1',
    'Style: Box,Arial,64,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,3,10,0,5,0,0,0,-1',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
  const lines: string[] = [];
  const textTracks = p.tracks.filter((t) => t.kind === 'text');
  for (const clip of p.clips) {
    if ((clip.kind !== 'text' && clip.kind !== 'caption') || !clip.text?.trim()) continue;
    if (textTracks.find((t) => t.id === clip.trackId)?.hidden) continue;
    const layer = textTracks.length - textTracks.findIndex((t) => t.id === clip.trackId);
    const st = textStyleOf(p, clip);
    // the font goes into an override tag: only known font names (built in, or added and checked by FONT_OK)
    if (!(st.font in FONT_SCALE) && !custom.has(st.font)) st.font = 'Arial';
    const x = Math.round(st.x * W);
    const y = Math.round(st.y * H);
    const fs = Math.round(st.size * (FONT_SCALE[st.font] ?? custom.get(st.font) ?? 1.15));
    const base =
      `\\an5\\fn${st.font}\\fs${fs}\\b${st.bold ? 1 : 0}\\1c${assColor(st.color)}\\shad0` +
      (st.bg ? `\\3c${assColor(st.bg)}\\4c${assColor(st.bg)}\\bord${boxPadOf(st.size)}` : `\\3c${assColor(st.outline ?? '#000000')}\\bord${outlineOf(st.size)}`);
    const nb = neighborsOf(p, clip);
    const en = entryOf(clip);
    const ex = exitOf(clip, nb);
    const end = clip.start + clip.duration;

    const event = (s: number, e: number, entry: Motion | null, exit: Motion | null, body = escapeText(clip.text!)) => {
      const durMs = Math.round((e - s) * 1000);
      const inMs = entry ? Math.min(durMs, Math.round(entry.duration * 1000)) : 0;
      const outMs = exit ? Math.min(durMs, Math.round(exit.duration * 1000)) : 0;
      let tags = base;
      if (entry?.kind === 'slide') tags += `\\move(${x + Math.round(entry.dirX * W)},${y + Math.round(entry.dirY * H)},${x},${y},0,${inMs})`;
      else if (exit?.kind === 'slide') tags += `\\move(${x},${y},${x + Math.round(exit.dirX * W)},${y + Math.round(exit.dirY * H)},${durMs - outMs},${durMs})`;
      else tags += `\\pos(${x},${y})`;
      const fadeIn = entry && (entry.kind === 'fade' || entry.kind === 'zoom') ? inMs : 0;
      const fadeOut = exit && (exit.kind === 'fade' || exit.kind === 'zoom') ? outMs : 0;
      if (fadeIn || fadeOut) tags += `\\fad(${fadeIn},${fadeOut})`;
      if (entry?.kind === 'zoom') tags += `\\fscx60\\fscy60\\t(0,${inMs},\\fscx100\\fscy100)`;
      if (entry?.kind === 'pop') {
        const k = Math.round(inMs * 0.7);
        tags += `\\fscx5\\fscy5\\t(0,${k},\\fscx110\\fscy110)\\t(${k},${inMs},\\fscx100\\fscy100)`;
      }
      if (exit?.kind === 'zoom') tags += `\\t(${durMs - outMs},${durMs},\\fscx60\\fscy60)`;
      if (exit?.kind === 'pop') {
        const k = durMs - Math.round(outMs * 0.7);
        tags += `\\t(${durMs - outMs},${k},\\fscx110\\fscy110)\\t(${k},${durMs},\\fscx5\\fscy5)`;
      }
      lines.push(`Dialogue: ${layer},${assTime(s)},${assTime(e)},${st.bg ? 'Box' : 'Plain'},,0,0,0,,{${tags}}${body}`);
    };

    // captions with a highlight colour (one event per spoken word, that word recoloured) and / or a
    // typewriter entry (one event per typed character, the rest of the text drawn fully transparent)
    const highlight = clip.kind === 'caption' && !!st.highlight;
    const tw = en?.kind === 'typewriter' ? en : null;
    if (highlight || tw) {
      const tokens = highlight ? captionTokens(clip) : [{ text: clip.text!, word: false, s: 0, e: 0 }];
      const pieces = tokens.map((t) => graphemes(t.text));
      const total = pieces.reduce((k, g) => k + g.length, 0);
      const marks = highlight ? tokens.filter((t) => t.word).map((t) => Math.min(Math.max(t.s, 0), clip.duration)) : [];
      if (tw) for (let k = 1; k < total; k++) marks.push((tw.duration * k) / total);
      const cuts = [...new Set([0, ...marks, clip.duration].map((v) => Math.round(v * 100) / 100))].sort((a, b) => a - b);
      // hidden characters keep their place (the line does not reflow) and, on a box, the box
      const hide = st.bg ? '{\\1a&HFF&}' : '{\\1a&HFF&\\3a&HFF&}';
      for (let i = 0; i < cuts.length - 1; i++) {
        if (cuts[i + 1] - cuts[i] < 0.01) continue;
        const at = cuts[i] + 0.005;
        const active = highlight ? activeWord(tokens, at) : -1;
        const shown = tw ? typedCount(total, at / tw.duration) : total;
        let wi = -1;
        let g = 0;
        let body = '';
        tokens.forEach((t, ti) => {
          const lit = t.word && ++wi === active;
          let part = '';
          for (const ch of pieces[ti]) {
            if (g === shown) part += hide;
            part += escapeText(ch);
            g++;
          }
          body += lit ? `{\\1c${assColor(st.highlight!)}}${part}{\\1c${assColor(st.color)}}` : part;
        });
        if (shown === 0) body = hide + body.replace(hide, '');
        event(clip.start + cuts[i], clip.start + cuts[i + 1], i === 0 ? en : null, i === cuts.length - 2 ? ex : null, body);
      }
      continue;
    }
    if (en?.kind === 'slide' && ex?.kind === 'slide') {
      const mid = clip.start + clip.duration / 2;
      event(clip.start, mid, en, null);
      event(mid, end, null, ex);
    } else event(clip.start, end, en, ex);
  }
  hasText.count = lines.length;
  return [...head, ...lines, ''].join('\n');
}
