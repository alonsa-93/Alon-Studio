# Editing core

Everything here works the same in the editor, over REST (`POST /api/projects/:id/ops`) and over MCP. One shared model drives both the player and the export: `shared/motion.ts` (poses and keyframes) and `shared/anim.ts` (transitions and in/out animations). The preview and the MP4 are compared by `scripts/parity.ts` (gate 9).

## Keyframes

- **User sees:** a "תנועה (Keyframes)" section in the clip inspector. `K` adds or removes a point at the playhead, `Shift+K` / `Shift+J` jump to the next / previous point, diamonds on the clip in the timeline (click picks one, `Delete` removes it). With points, changing size, position, rotation or opacity (sliders or dragging the picture) writes a point at the playhead. Each point has an ease to the next one: linear, ease-in, ease-out, ease-in-out, hold.
- **Data:** `Clip.keyframes?: { t, x?, y?, scale?, rotation?, opacity?, ease }[]`, `t` relative to the clip start, at most 200, snapped together within 0.02 s. Optional field; old projects load unchanged. While a clip has keyframes they override `fx.posX/posY/scale/rotation/opacity`.
- **Ops:** `set_keyframe { clipId, t, x?, y?, scale?, rotation?, opacity?, ease? }` (merges into a point within 0.05 s), `delete_keyframe { clipId, t }`, `clear_keyframes { clipId }`. Values are clamped, not rejected.
- **Split / trim / speed:** points are re-timed. A cut inside an eased segment keeps the exact path: `sliceKeys` subdivides it into short linear steps (at most 12, about 0.1 s each).
- **Export:** each animated property is a piecewise ffmpeg expression (`keyExpr`); position goes to `overlay x/y`, scale to `scale eval=frame`, rotation to `rotate`, opacity and blur through `sendcmd` samples.
- **MCP:** `set_keyframe`, `delete_keyframe` (with `clear`).
- **Tests:** `regress.ts` (expression vs `poseAt` under 1 px, split / speed re-timing), `e2e-features.ts` (export frames change), UI journey (K, drag, Shift+J/K, Delete, Ctrl+Z), parity gate.

## Punch-in (zoom to a point)

- **User sees:** "זום לנקודה": pick one of 9 points in a 3x3 grid, how close (110%–300%) and how long, then "הוספת זום מהסמן".
- **Op:** `punch_in { clipId, start, end, x, y, scale }` writes 4 keyframes (in, hold, hold, out) with ease-in-out. The zoom keeps the chosen point still: `pos' = P - (P - pos) * S`.
- **MCP:** `punch_in`.

## Rotation, blend modes, overlay layer

- `fx.rotation` (-180..180), `fx.blend`: normal, screen, lighten, multiply, overlay. Blend works for any clip above the main track.
- "הפיכה לשכבת אוברליי מעל הסרטון" moves a main-track clip to a new track above it and sets blend to screen (one undo step).
- **Export:** rotation uses a square canvas big enough for any angle with transparent corners (`c=black@0`); blends render on a transparent canvas, then `blend=all_mode` against the picture below and `alphamerge`.
- **Preview:** CSS `rotate`, `mix-blend-mode`.
- **Bug found by the parity gate:** `rotate c=none` left the corners unpainted (smeared colors in the MP4). Fixed to `c=black@0`.

## Transitions (16) and 4:5

- `fade, dip, dip-white, flash, blur, zoom, zoom-out, spin, slide-left/right/up/down, wipe-left/right/up/down`. Wipes reveal from an edge with a `geq` alpha mask; flash fades from white; blur samples `gblur` sigma through `sendcmd`.
- New aspect `4:5` (1080x1350 and friends) for feed posts.

## Typewriter text

- In-animation `typewriter`: letters appear one by one (graphemes via `Intl.Segmenter`, so Hebrew with niqqud and emoji stay whole). Export: one ASS event per step with the rest hidden by alpha; preview: per-letter spans with `visibility: hidden`, so the line never reflows.

## Insert, ripple speed, new track

- `insert_clip { mediaId, time, trackId? }`: splits at `time` and pushes everything after it to make room. The "+" on a media card inserts at the playhead.
- `set_speed { clipId, speed, ripple? }`: with `ripple`, clips after it move with the new length (off by default, as before).
- `move_clip_to_new_track { clipId, position: above | below }`.
- **MCP:** `insert_clip`, `set_speed` (ripple), `move_clip_to_new_track`.

## Silence removal

- **User sees:** "שתיקות" in the timeline toolbar opens a dialog: what counts as quiet (dB), minimum silence, padding left next to speech. "בדיקה" lists the silences and the new length and changes nothing; "מחיקת N השתיקות" cuts them all in one undo step.
- **REST:** `POST /api/projects/:id/silences { thresholdDb?, minSilence?, padding?, dryRun? }` (dry run by default) returns `{ ranges, removed, durationBefore, durationAfter, ops }`.
- **How:** mixes the speech tracks (video/audio with sound; not music or library sounds), runs `silencedetect`, keeps only silences inside the speech spans, pads both sides, cuts latest first.
- **MCP:** `remove_silences` (`dryRun` true by default).
- **Tests:** `e2e-features.ts` on a Hebrew speech file (expected length 5.69 s ±0.2; the words before and after the cut are the same), UI journey (check changes nothing, apply, one Ctrl+Z restores).

## Preview vs export (gate 9)

`scripts/parity.ts` builds a project with keyframes (move, scale, rotate, opacity), a color look, a rotated screen-blend layer, a wipe and a zoom-out; exports it; grabs the same frames from the MP4 (ffmpeg) and from the player in Edge (`driver.mjs`, `Page.captureScreenshot` on the stage); compares with ffmpeg `psnr`.

- **Threshold:** 24 dB on every sampled time. Below that a difference is visible to the eye (the rotate bug above measured 17 dB). Measured after the fix: 27.7–32.8 dB. The remaining gap is scaling filters and YUV 4:2:0 color rounding.
- **Not compared:** text and captions. The browser and libass draw glyphs differently; text is covered by the ASS tests and by eye.
- Frames are kept in `ui-out/parity/` with `parity.json`.
