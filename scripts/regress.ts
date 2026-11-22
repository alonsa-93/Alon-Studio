/**
 * Regression checks for defects found in QA. Runs the shared editing logic directly, plus a few HTTP checks
 * when a server is running:   npx tsx scripts/regress.ts
 */
import './auth.mjs';
import os from 'node:os';
import path from 'node:path';
import { applyOp, editableState, newProject, sanitizeState, type Op } from '../shared/ops';
import { graphemes, typedCount } from '../shared/anim';
import { keyExpr, poseAt, POSE_KEYS } from '../shared/motion';
import { captionTokens, toSrt } from '../shared/fx';
import { BLEND_MODES, TRANSITION_TYPES, type Project } from '../shared/types';
import { EXPORT_PRESETS, logoRect, presetOf, slotOf } from '../shared/layout';

let failures = 0;
const check = (ok: unknown, msg: string) => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${msg}`);
};
const rejects = (p: Project, op: unknown, msg: string) => {
  try {
    applyOp(p, op as Op);
    check(false, `${msg} (was accepted)`);
  } catch {
    check(true, msg);
  }
};

let p = newProject('t', 'test');
p.media.push({ id: 'm1', name: 'v.mp4', kind: 'video', file: 'v.mp4', duration: 10, width: 1280, height: 720, hasAudio: true });
p = applyOp(p, { op: 'add_clip', mediaId: 'm1', id: 'A' });

console.log('numbers');
rejects(p, { op: 'add_text', text: 'x', start: 'abc' }, 'add_text start "abc" rejected');
rejects(p, { op: 'add_text', text: 'x', duration: 'abc' }, 'add_text duration "abc" rejected');
rejects(p, { op: 'add_text', text: 'x', start: 1e15 }, 'add_text huge start rejected');
rejects(p, { op: 'add_clip', mediaId: 'm1', start: 'x' }, 'add_clip start "x" rejected');
rejects(p, { op: 'duplicate', clipId: 'A', start: 'x' }, 'duplicate start "x" rejected');
rejects(p, { op: 'trim_clip', clipId: 'A', start: 0, duration: 2, offset: 'x' }, 'trim_clip offset "x" rejected');
rejects(p, { op: 'add_music', mediaId: 'm1', duration: -5 }, 'add_music negative duration rejected');
rejects(p, { op: 'add_music', mediaId: 'm1', volume: 'x' }, 'add_music volume "x" rejected');
rejects(p, { op: 'set_in_out', in: 'x' }, 'set_in_out in "x" rejected');
rejects(p, { op: 'add_transition', clipId: 'A', type: 'fade', duration: 'x' }, 'add_transition duration "x" rejected');
rejects(p, { op: 'set_animation', clipId: 'A', in: { type: 'fade', duration: 'x' } }, 'set_animation duration "x" rejected');
rejects(p, { op: 'update_clip', clipId: 'A', patch: { fadeIn: 'x' } }, 'update_clip fadeIn "x" rejected');
rejects(p, { op: 'set_caption_animation', type: 'pop', duration: 'x' }, 'set_caption_animation duration "x" rejected');

check(applyOp(p, { op: 'set_animation', clipId: 'A', in: { type: 'fade', duration: 0.5 }, out: { type: 'none' } }).clips[0].animIn?.type === 'fade', 'set_animation with valid in/out accepted');
check(applyOp(p, { op: 'set_in_out', in: 1, out: null }).inPoint === 1, 'set_in_out with null accepted');
console.log('ids and styles');
rejects(p, { op: 'add_text', text: 'x', id: 'A' }, 'duplicate clip id rejected');
rejects(p, { op: 'add_track', kind: 'video', id: 't_video' }, 'duplicate track id rejected');
rejects(p, { op: 'add_track', kind: 'video', id: { a: 1 } }, 'object id rejected');
rejects(p, { op: 'set_caption_style', style: 'abc' }, 'caption style string rejected');
rejects(p, { op: 'set_caption_style', style: { font: 'X\\fs500}{' } }, 'caption font with ASS tags rejected');
rejects(p, { op: 'set_caption_style', style: { bg: 123 } }, 'caption bg number rejected');
rejects(p, { op: 'update_clip', clipId: 'A', patch: { text: 'on video' } }, 'text on a video clip rejected');
rejects(p, { op: 'set_aspect', aspect: 'toString' }, 'set_aspect "toString" rejected');
rejects(p, { op: 'remove_media', mediaId: 'nope' }, 'remove_media unknown id rejected');

console.log('captions');
rejects(p, { op: 'set_captions', captions: 'abc' }, 'set_captions string rejected');
rejects(p, { op: 'set_captions', captions: [1, 'a'] }, 'set_captions junk array rejected');
rejects(p, { op: 'set_captions', captions: [{ start: 'a', end: 'b', text: 'x' }] }, 'set_captions NaN times rejected');
rejects(p, { op: 'set_captions', captions: [{ start: -3, end: 2, text: 'neg' }] }, 'set_captions negative start rejected');
let c = applyOp(p, { op: 'set_captions', captions: [{ start: 0, end: 3, text: 'one two three four', words: 'zz' as never }] });
check(captionTokens(c.clips.find((x) => x.kind === 'caption')!).filter((t) => t.word).length === 4, 'bad "words" dropped, tokens still computed');
c = applyOp(p, { op: 'set_captions', captions: [{ start: 0, end: 4, text: 'one two three four', words: [{ s: 0, e: 1, w: 'one' }, { s: 1, e: 2, w: 'two' }, { s: 2, e: 3, w: 'three' }, { s: 3, e: 4, w: 'four' }] }] });
const cut = applyOp(c, { op: 'cut_range', start: 1.9, end: 2.1 });
const caps = cut.clips.filter((x) => x.kind === 'caption').sort((a, b) => a.start - b.start);
check(caps.length === 2 && caps[0].text === 'one two' && caps[1].text === 'three four', `cut_range splits caption words: ${caps.map((x) => `"${x.text}"`).join(' | ')}`);
const sliver = applyOp(c, { op: 'cut_range', start: 0.04, end: 3.5 });
check(sliver.clips.filter((x) => x.kind === 'caption').every((x) => x.duration >= 0.1), 'cut_range leaves no sub-frame caption slivers');
const v = applyOp(p, { op: 'cut_range', start: 0.005, end: 1, ripple: false });
check(v.clips.every((x) => x.duration >= 0.1), 'cut_range leaves no sub-frame video slivers');
check(!toSrt([{ start: 0, end: 1, text: 'a\n\nb' }]).includes('a\n\nb'), 'SRT text has no blank lines');

console.log('resolution / detach');
let t = applyOp(p, { op: 'add_text', text: 'כותרת', style: { size: 120 }, id: 'T' });
t = applyOp(t, { op: 'set_settings', width: 720, height: 1280 });
check(Math.abs((t.clips.find((x) => x.id === 'T')!.style!.size ?? 0) - 80) <= 1 && t.captionStyle.size === Math.round(64 * (720 / 1080)), 'changing resolution rescales text and captions');
let d = applyOp(p, { op: 'update_clip', clipId: 'A', patch: { fadeIn: 1, fadeOut: 2 } });
d = applyOp(d, { op: 'detach_audio', clipId: 'A' });
const au = d.clips.find((x) => x.kind === 'audio')!;
check(au.fadeIn === 1 && au.fadeOut === 2, 'detach_audio keeps the fades');

console.log('removing media takes its captions');
let rm = structuredClone(p);
rm.media.push({ id: 'm2', name: 'w.mp4', kind: 'video', file: 'w.mp4', duration: 10, width: 1280, height: 720, hasAudio: true });
rm.media.push({ id: 'm3', name: 'song.mp3', kind: 'audio', file: 'song.mp3', duration: 30, hasAudio: true });
rm = applyOp(rm, { op: 'add_clip', mediaId: 'm2', id: 'B' });
rm = applyOp(rm, { op: 'add_music', mediaId: 'm3' });
rm = applyOp(rm, { op: 'set_captions', captions: [{ start: 0, end: 3, text: 'רק על הראשון' }, { start: 9, end: 11, text: 'על שניהם' }, { start: 12, end: 14, text: 'רק על השני' }] });
const gone = applyOp(rm, { op: 'remove_media', mediaId: 'm1' });
const left = gone.clips.filter((x) => x.kind === 'caption').map((x) => x.text);
check(left.length === 2 && !left.includes('רק על הראשון'), `captions only over the removed video go with it (left: ${left.join(' | ')})`);
check(gone.clips.some((x) => x.music) && gone.clips.some((x) => x.id === 'B'), 'other clips and music stay');
check(applyOp(rm, { op: 'remove_media', mediaId: 'm3' }).clips.filter((x) => x.kind === 'caption').length === 3, 'removing music keeps every caption');
check(!applyOp(rm, { op: 'set_captions', captions: [] }).clips.some((x) => x.kind === 'caption'), 'set_captions [] clears all captions');

console.log('editing core: rejects');
rejects(p, { op: 'set_fx', clipId: 'A', fx: { rotation: 'x' } }, 'rotation "x" rejected');
rejects(p, { op: 'set_fx', clipId: 'A', fx: { blend: 'darken-ish' } }, 'unknown blend mode rejected');
rejects(p, { op: 'add_transition', clipId: 'A', type: 'nope' }, 'unknown transition rejected');
rejects(p, { op: 'set_animation', clipId: 'A', in: { type: 'typewriter', duration: 0.5 } }, 'typewriter on a video rejected');
rejects(p, { op: 'set_keyframe', clipId: 'A', t: 99 }, 'keyframe outside the clip rejected');
rejects(p, { op: 'set_keyframe', clipId: 'A', t: 1, ease: 'bounce' }, 'unknown ease rejected');
rejects(p, { op: 'set_keyframe', clipId: 'A', t: 1, scale: 'big' }, 'keyframe scale "big" rejected');
rejects(p, { op: 'delete_keyframe', clipId: 'A', t: 1 }, 'deleting a missing keyframe rejected');
rejects(p, { op: 'punch_in', clipId: 'A', start: 1, end: 1.1 }, 'punch_in shorter than 0.2s rejected');
rejects(p, { op: 'punch_in', clipId: 'A', start: 1, end: 3, x: 'left' }, 'punch_in point "left" rejected');
rejects(p, { op: 'insert_clip', mediaId: 'nope', time: 1 }, 'insert_clip unknown media rejected');
rejects(p, { op: 'insert_clip', mediaId: 'm1', time: 'x' }, 'insert_clip time "x" rejected');
rejects(p, { op: 'move_clip_to_new_track', clipId: 'A', position: 'left' }, 'move_clip_to_new_track bad position rejected');
rejects(p, { op: 'set_speed', clipId: 'A', speed: 'fast' }, 'set_speed "fast" rejected');
let tw = applyOp(p, { op: 'add_text', text: 'שלום עולם', id: 'TW' });
rejects(tw, { op: 'set_animation', clipId: 'TW', out: { type: 'typewriter', duration: 0.5 } }, 'typewriter as exit rejected');
tw = applyOp(tw, { op: 'set_animation', clipId: 'TW', in: { type: 'typewriter', duration: 1 } });
check(tw.clips.find((x) => x.id === 'TW')!.animIn?.type === 'typewriter', 'typewriter entry on a text accepted');
check(typedCount(graphemes('שָׁלוֹם').length, 0.5) === 2 && graphemes('שָׁלוֹם').length === 4, 'typewriter counts letters with their niqqud as one');
check(applyOp(p, { op: 'set_aspect', aspect: '4:5' }).settings.height === 1350, 'aspect 4:5 accepted (1080x1350)');
check(TRANSITION_TYPES.every((type) => applyOp(p, { op: 'add_transition', clipId: 'A', type, duration: 0.5 }).clips[0].transition?.type === type) && TRANSITION_TYPES.length === 16, '16 transitions accepted');
check(BLEND_MODES.every((blend) => applyOp(p, { op: 'set_fx', clipId: 'A', fx: { blend } }).clips[0].fx?.blend === blend), 'blend modes accepted');

console.log('keyframes');
let k = applyOp(p, { op: 'set_keyframe', clipId: 'A', t: 0, x: -0.2, scale: 1, rotation: 0, opacity: 1, ease: 'ease-in-out' });
k = applyOp(k, { op: 'set_keyframe', clipId: 'A', t: 4, x: 0.3, y: 0.1, scale: 1.8, rotation: 45, opacity: 0.4, ease: 'ease-out' });
k = applyOp(k, { op: 'set_keyframe', clipId: 'A', t: 7, x: 0, scale: 1.2, ease: 'hold' });
k = applyOp(k, { op: 'set_keyframe', clipId: 'A', t: 9, x: 0.5 });
const A = k.clips[0];
check(A.keyframes?.length === 4, `4 keyframes (${A.keyframes?.length})`);
check(applyOp(k, { op: 'set_keyframe', clipId: 'A', t: 4.01, x: 0 }).clips[0].keyframes!.length === 4, 'a keyframe 10ms away updates the same one');
// the ffmpeg expression and the preview interpolation agree (< 1 px on a 1080 frame) at 10 sampled times
const evalExpr = (e: string, T: number) => new Function('T', 'IF', 'LT', `return ${e.replace(/if\(/g, 'IF(').replace(/lt\(/g, 'LT(')}`)(T, (c: number, a: number, b: number) => (c ? a : b), (a: number, b: number) => (a < b ? 1 : 0)) as number;
let worst = 0;
for (let i = 0; i < 10; i++) {
  const T = (i / 9) * 10 - 0.3;
  const pose = poseAt(A, T);
  for (const prop of POSE_KEYS) {
    const unit = prop === 'x' || prop === 'y' ? 1080 : prop === 'scale' ? 1080 : prop === 'rotation' ? 1080 * (Math.PI / 180) : 255;
    worst = Math.max(worst, Math.abs(evalExpr(keyExpr(A.keyframes!, prop, 'T'), T) - pose[prop]) * unit);
  }
}
check(worst < 1, `ffmpeg keyframe expression vs preview: worst difference ${worst.toFixed(4)} px`);
check(poseAt(A, 8).x === 0 && poseAt(A, 8.9).x === 0, '"hold" keeps the value until the next keyframe');
const sp = applyOp(k, { op: 'split', clipId: 'A', time: 5 });
const [s1, s2] = sp.clips.filter((x) => x.kind === 'video').sort((a, b) => a.start - b.start);
const same = [1, 3, 4.3, 4.5, 4.77].every((t) => Math.abs(poseAt(s1, t).x - poseAt(A, t).x) * 1080 < 1) && [5.5, 6.5, 9.5].every((t) => Math.abs(poseAt(s2, t - 5).x - poseAt(A, t).x) * 1080 < 1);
check(same, 'split keeps the motion of both pieces');
const fast = applyOp(k, { op: 'set_speed', clipId: 'A', speed: 2 });
check(Math.abs(fast.clips[0].keyframes!.at(-1)!.t - 4.5) < 0.01, 'speed 2x squeezes the keyframes too');
check(!applyOp(k, { op: 'clear_keyframes', clipId: 'A' }).clips[0].keyframes, 'clear_keyframes');
check(applyOp(k, { op: 'delete_keyframe', clipId: 'A', t: 7.03 }).clips[0].keyframes!.length === 3, 'delete_keyframe within 50ms');
check(applyOp(p, { op: 'set_keyframe', clipId: 'A', t: 2 }).clips[0].keyframes![0].scale === 1, 'a new keyframe starts from the current look');

console.log('punch-in zoom');
const z = applyOp(p, { op: 'punch_in', clipId: 'A', start: 2, end: 6, x: 0.75, y: 0.25, scale: 2 });
const zk = z.clips[0].keyframes!;
check(zk.length === 4 && zk[0].ease === 'ease-in-out', `punch_in writes 4 keyframes (${zk.map((x) => `${x.t}:${x.scale}`).join(', ')})`);
const held = poseAt(z.clips[0], 4);
// the chosen point (0.75, 0.25 of the frame) stays where it was on screen
check(Math.abs(held.x + 0.25 * held.scale - 0.25) < 1e-6 && Math.abs(held.y - 0.25 * held.scale + 0.25) < 1e-6 && Math.abs(held.scale - 2) < 1e-6, `zoom holds on the point (x ${held.x}, y ${held.y}, scale ${held.scale})`);
check(poseAt(z.clips[0], 1).scale === 1 && poseAt(z.clips[0], 7).scale === 1, 'before and after the zoom the picture is as it was');

console.log('insert / speed ripple / new track');
let ins = structuredClone(p);
ins.media.push({ id: 'm4', name: 'b.mp4', kind: 'video', file: 'b.mp4', duration: 3, width: 1280, height: 720, hasAudio: true });
ins = applyOp(ins, { op: 'add_text', text: 'אחרי', start: 6, duration: 2, id: 'TX' });
ins = applyOp(ins, { op: 'insert_clip', mediaId: 'm4', time: 4, id: 'I' });
const vids = ins.clips.filter((x) => x.kind === 'video').sort((a, b) => a.start - b.start);
check(vids.length === 3 && vids[0].duration === 4 && vids[1].id === 'I' && vids[2].start === 7 && vids[2].offset === 4, `insert_clip splits at 4s and pushes the rest by 3s (${vids.map((x) => `${x.start}+${x.duration}`).join(', ')})`);
check(ins.clips.find((x) => x.id === 'TX')!.start === 9, 'insert_clip pushes clips on other tracks too');
let rip = applyOp(p, { op: 'split', clipId: 'A', time: 5 });
rip = applyOp(rip, { op: 'add_text', text: 'כותרת', start: 6, duration: 2, id: 'TT' });
const firstId = rip.clips.filter((x) => x.kind === 'video').sort((a, b) => a.start - b.start)[0].id;
const ripOn = applyOp(rip, { op: 'set_speed', clipId: firstId, speed: 2, ripple: true });
const ripOff = applyOp(rip, { op: 'set_speed', clipId: firstId, speed: 2 });
check(ripOn.clips.find((x) => x.id === 'TT')!.start === 3.5 && ripOff.clips.find((x) => x.id === 'TT')!.start === 6, 'set_speed ripple moves later clips on every track');
const nt = applyOp(p, { op: 'move_clip_to_new_track', clipId: 'A', position: 'above', id: 'NT' });
const ti = nt.tracks.findIndex((x) => x.id === 'NT');
check(ti >= 0 && nt.clips[0].trackId === 'NT' && nt.tracks[ti + 1]?.id === p.tracks.find((x) => x.id === p.clips[0].trackId)!.id, 'move_clip_to_new_track puts a new track above');
check(sanitizeState(JSON.parse(JSON.stringify(k)), k.media).clips[0].keyframes?.length === 4, 'a state with keyframes survives undo / redo validation');

console.log('layouts, logo, presets');
{
  let q = newProject('l', 'layout');
  q.media.push({ id: 'm1', name: 'v.mp4', kind: 'video', file: 'v.mp4', duration: 10, width: 1280, height: 720, hasAudio: true });
  q.media.push({ id: 'm2', name: 'logo.png', kind: 'image', file: 'logo.png', duration: 5, width: 400, height: 200, hasAudio: false });
  q = applyOp(q, { op: 'add_clip', mediaId: 'm1', id: 'MAIN' });
  q = applyOp(q, { op: 'add_track', kind: 'video', id: 'UP' } as Op);
  q = applyOp(q, { op: 'add_clip', mediaId: 'm1', id: 'SEC', trackId: 'UP' });
  rejects(q, { op: 'set_layout', layout: 'grid' }, 'unknown layout rejected');
  rejects(q, { op: 'set_logo', logo: { mediaId: 'm1' } }, 'a video as logo rejected');
  rejects(q, { op: 'set_logo', logo: { mediaId: 'm2', corner: 'middle' } }, 'unknown logo corner rejected');
  rejects(q, { op: 'set_logo', logo: 'm2' }, 'a logo that is not an object rejected');
  const st = applyOp(q, { op: 'set_layout', layout: 'stack' });
  const main = st.clips.find((c) => c.id === 'MAIN')!;
  const sec = st.clips.find((c) => c.id === 'SEC')!;
  check(JSON.stringify(slotOf(st, main)) === JSON.stringify({ x: 0, y: 0, w: 1, h: 0.5 }) && slotOf(st, sec)?.y === 0.5, 'stack: main on top, the track above it below');
  const pip = applyOp(q, { op: 'set_layout', layout: 'pip' });
  check(slotOf(pip, pip.clips.find((c) => c.id === 'MAIN')!) === null && slotOf(pip, pip.clips.find((c) => c.id === 'SEC')!)!.w === 0.3, 'pip: main full frame, the other small');
  check(applyOp(st, { op: 'set_layout', layout: 'single' }).layout === undefined, 'single removes the field (old projects stay as they were)');
  const lg = applyOp(q, { op: 'set_logo', logo: { mediaId: 'm2', size: 2, opacity: -1 } });
  check(lg.logo?.size === 0.5 && lg.logo.opacity === 0 && lg.logo.corner === 'top-right', 'logo numbers clamped, corner defaults to top-right');
  const r1 = logoRect({ mediaId: 'm2', corner: 'bottom-left', size: 0.2, opacity: 1, margin: 0.05 }, 1920, 1080, 2);
  check(r1.x === 54 && r1.w === 384 && r1.h === 192 && r1.y === 1080 - 54 - 192, `logo rectangle bottom-left (${JSON.stringify(r1)})`);
  check(applyOp(lg, { op: 'remove_media', mediaId: 'm2' }).logo === null, 'removing the logo picture removes the logo');
  const saved = sanitizeState(JSON.parse(JSON.stringify({ ...st, logo: lg.logo })), q.media);
  check(saved.layout === 'stack' && saved.logo?.mediaId === 'm2', 'layout and logo survive undo / redo validation');
  // the UI's undo snapshot (editableState) carries them too: a missing field would reset them on every Ctrl+Z
  const snapState = sanitizeState(JSON.parse(JSON.stringify(editableState({ ...st, logo: lg.logo, titleFont: 'Heebo' } as Project))), q.media);
  check(snapState.layout === 'stack' && snapState.logo?.mediaId === 'm2' && snapState.titleFont === 'Heebo', 'the undo snapshot keeps layout, logo and title font');
  const plain = sanitizeState(JSON.parse(JSON.stringify(editableState({ ...st, layout: undefined, logo: null } as Project))), q.media);
  check(plain.layout === undefined && !plain.logo && plain.titleFont === undefined, 'an undo snapshot without them stays single, no logo, default font');
  check(sanitizeState(JSON.parse(JSON.stringify({ ...q, logo: { mediaId: 'nope' }, layout: 'weird' })), q.media).logo === undefined, 'a bad logo or layout in a state is dropped, not fatal');
  check(EXPORT_PRESETS.length === 9 && EXPORT_PRESETS.every((x) => x.width % 2 === 0 && x.height % 2 === 0 && x.maxrate > 0), '9 export presets with even sizes and a bitrate cap');
  check(['youtube', 'youtube-4k', 'shorts', 'reels', 'tiktok', 'instagram-post', 'square', 'x', 'linkedin'].every((id) => presetOf(id)), 'every network from the guide has a preset');
}

console.log('AI: change list, translation, settings');
{
  const { diffProjects } = await import('../shared/diff');
  let a = newProject('d', 'diff');
  a.media.push({ id: 'm1', name: 'talk.mp4', kind: 'video', file: 'v.mp4', duration: 10, width: 1280, height: 720, hasAudio: true });
  a = applyOp(a, { op: 'add_clip', mediaId: 'm1', id: 'V' });
  a = applyOp(a, { op: 'set_captions', captions: [{ start: 0, end: 1, text: 'אחת' }, { start: 1, end: 2, text: 'שתיים' }] } as Op);
  check(diffProjects(a, a).length === 0, 'no changes: an empty list');
  let b = applyOp(a, { op: 'add_text', text: 'כותרת', id: 'T' } as Op);
  b = applyOp(b, { op: 'trim_clip', clipId: 'V', start: 0, duration: 5 } as Op);
  b = applyOp(b, { op: 'set_layout', layout: 'stack' });
  const d = diffProjects(a, b);
  check(d.some((c) => c.kind === 'add' && c.target === 'clip' && c.label.includes('"כותרת"')) && d.some((c) => c.kind === 'change' && c.id === 'V' && /אורך/.test(c.detail ?? '')) && d.some((c) => c.target === 'setting' && c.label === 'פריסת מסך'), `added title, shorter clip and layout in the list (${d.length} rows)`);
  const del = diffProjects(a, applyOp(a, { op: 'delete', clipIds: ['V'] } as Op));
  check(del.some((c) => c.kind === 'remove' && c.label.includes('talk.mp4')), 'a deleted clip shows with its media name');
  const caps = diffProjects(a, applyOp(a, { op: 'set_captions', captions: [{ start: 0, end: 2, text: 'הכול' }] } as Op));
  check(caps.filter((c) => c.target === 'captions').length === 1 && caps.length === 1, 'captions are summed in one row');

  process.env.ALON_DATA_DIR ??= path.join(os.tmpdir(), 'alon-test-data');
  const { parseLines, spreadWords, translationOps } = await import('../server/translate');
  const { checkLocalBase } = await import('../server/aiconfig');
  check(JSON.stringify(parseLines('Sure:\n["one","two"]', 2)) === '["one","two"]' && parseLines('["one"]', 2) === null && parseLines('no json', 1) === null, 'translation answer: the JSON array, only with the same line count');
  check(JSON.stringify(parseLines('[" a  b ", null]', 2)) === '["a b",""]', 'translation answer: spaces tidied, an empty line stays empty');
  const sw = spreadWords('one two three four', 2)!;
  check(sw.length === 4 && sw[0].s === 0 && sw[3].e === 2 && spreadWords('one', 1) === undefined, 'translated words spread over the caption time');
  const tOps = translationOps(a, ['one', 'two'], true, 'above');
  const tr = tOps.reduce((p, o) => applyOp(p, o), a);
  const newCaps = tr.clips.filter((c) => c.kind === 'caption').sort((x, y) => x.start - y.start);
  const orig = tr.clips.filter((c) => c.kind === 'text');
  check(newCaps.map((c) => c.text).join() === 'one,two' && newCaps[1].start === 1 && orig.length === 2 && orig[0].text === 'אחת' && orig[0].style!.y! < tr.captionStyle.y, 'translation keeps times; the originals sit above the captions on their own track');
  const below = translationOps(a, ['one', 'two'], true, 'below').reduce((p, o) => applyOp(p, o), a).clips.filter((c) => c.kind === 'text');
  check(below[0].style!.y! > a.captionStyle.y, 'or below them');
  let threw = false;
  try {
    translationOps(a, ['one'], false);
  } catch {
    threw = true;
  }
  check(threw, 'a translation with a different line count is refused');
  const bad = ['http://example.com/v1', 'http://10.0.0.5:11434/v1', 'http://169.254.169.254/', 'file:///c:/x', 'http://127.0.0.1.evil.com/v1', 'ftp://127.0.0.1/'];
  check(bad.every((u) => { try { checkLocalBase(u); return false; } catch { return true; } }), 'local model address: only this computer (no LAN, cloud metadata, file or look-alike hosts)');
  check(['http://127.0.0.1:11434/v1', 'http://localhost:1234/v1', 'http://[::1]:8080/v1'].every((u) => checkLocalBase(u).startsWith('http')), 'local model address: 127.0.0.1, localhost and [::1] allowed');
}

const BASE = process.env.BASE_URL ?? 'http://localhost:5173';
try {
  await fetch(BASE + '/api/health');
  console.log('http');
  const j = async (url: string, init?: RequestInit) => {
    const r = await fetch(BASE + url, init);
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const json = (body: unknown, method = 'POST'): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const proj = (await j('/api/projects', json({ name: 'regress' }))).body;
  let r = await j(`/api/projects/${proj.id}`, json({ tracks: proj.tracks, clips: [null], settings: proj.settings }, 'PUT'));
  check(r.status === 400, `PUT with clips:[null] -> ${r.status}`);
  r = await j(`/api/projects/${proj.id}/summary`);
  check(r.status === 200, 'project still readable afterwards');
  r = await j('/media/nope.mp4');
  check(r.status === 404 && !JSON.stringify(r.body).includes('\\\\'), 'static 404 does not leak a path');
  r = await j('/api/projects/current', { method: 'DELETE' });
  check(r.status === 400, `DELETE current -> ${r.status}`);
  const fd = new FormData();
  fd.append('wrong', new Blob(['x']), 'a.txt');
  r = await j(`/api/projects/${proj.id}/media`, { method: 'POST', body: fd });
  check(r.status === 400, `upload with a wrong field name -> ${r.status}`);
  const svg = new FormData();
  svg.append('files', new Blob(['<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>']), 'x.svg');
  r = await j(`/api/projects/${proj.id}/media`, { method: 'POST', body: svg });
  check(r.status === 400, `SVG upload rejected -> ${r.status}`);
  r = await j(`/api/projects/${proj.id}/captions`, json({ language: 'not a language' }));
  check(r.status === 400, `bad captions language -> ${r.status}`);
  const four = await Promise.all([1, 2, 3, 4].map(() => j(`/api/projects/${proj.id}/media/library`, json({ id: 'whoosh' }))));
  const after = (await j(`/api/projects/${proj.id}`)).body as Project;
  check(four.every((x) => x.status === 200) && after.media.filter((m) => m.libraryId === 'whoosh').length === 1, 'parallel sound-effect add is idempotent');
  await j(`/api/projects/${proj.id}`, { method: 'DELETE' });
  // the AI routes need the key too (here rather than in the security gate, whose lockout test counts refusals)
  const noKey = async (u: string, method = 'GET') => (await fetch(BASE + u, { method, noKey: true, headers: { 'Content-Type': 'application/json' }, body: method === 'GET' ? undefined : '{}' } as RequestInit)).status;
  const aiRoutes: [string, string][] = [['/api/ai/settings', 'GET'], ['/api/ai/settings', 'PUT'], ['/api/ai/models', 'GET'], ['/api/voice/voices', 'GET'], ['/api/voice/voices/x/preview', 'GET'], ['/api/projects/current/agent', 'GET'], ['/api/projects/current/agent', 'POST'], ['/api/projects/current/agent/approve', 'POST'], ['/api/projects/current/speak', 'POST'], ['/api/projects/current/clone-voice', 'POST'], ['/api/projects/current/captions/translate', 'POST']];
  const refused = [];
  for (const [u, m] of aiRoutes) refused.push(await noKey(u, m));
  check(refused.every((x) => x === 401), `no key -> 401 on the ${aiRoutes.length} AI routes (${refused.join(',')})`);
} catch (e) {
  console.log(`(http checks skipped: ${(e as Error).message})`);
}
// both UI languages complete (scripts/i18n-check.ts)
try {
  await import('./i18n-check');
} catch (e) {
  console.log('  FAIL ' + (e as Error).message);
  failures++;
}
console.log(failures ? `\n${failures} FAILED` : '\nALL GOOD');
process.exit(failures ? 1 : 0);
