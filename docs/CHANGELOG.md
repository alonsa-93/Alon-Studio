# Changelog

One line per feature, newest first. Specs live in `docs/specs/`.

## 1.0.0

- Release rebuilt with steps 1-6 (release-next/, 820 MB, zip 306 MB). SHA256SUMS matches all 1,944 files. Gates 3, 4, 5, 6 and 10 pass against the extracted package (isolated port, minimal PATH, temporary data). The Anthropic SDK is bundled inside app/server.mjs.
- English UI: all UI strings in `src/i18n.ts` (Hebrew and English per key), EN / עב switch in the top bar, LTR in English, shortcuts by physical key. Key check `scripts/i18n-check.ts`; the UI journey runs in both languages. Spec: `specs/i18n.md`.
- MCP: a tool for every op (`OP_TOOLS`): `move_clip`, `trim_clip`, `update_clip`, `duplicate_clip`, `ripple_delete`, `detach_audio`, `add_track`, `set_track`, `delete_track`, `set_settings`, `set_in_out`, `set_captions`, `set_caption_animation`, `remove_media`. Tested in `scripts/e2e-mcp.ts`.
- AI agent tab: edits on a draft with the same MCP tools, an approval card listing every change (`shared/diff.ts`), approve as one undo step, cancel leaves the project as it was, stale drafts refused; history per project; round limit. Providers: Anthropic (official SDK, Claude Opus 5.5 default), OpenAI, xAI, OpenRouter, Groq, Together, local (loopback only). Spec: `specs/ai-cloud.md`.
- Cloud transcription (OpenAI whisper-1, Groq whisper-large-v3, ElevenLabs scribe_v1) with word timings, 20-minute parts; engine auto / local / cloud. Hebrew on this computer now uses ivrit-ai large-v3 turbo, pinned by revision and SHA-256.
- Caption translation to 9 languages that keeps every caption's time, optionally keeping the original lines above or below; also right after transcription (`translateTo`).
- Narration from text and voice cloning with Cartesia (consent required), voice previews cached.
- MCP: `get_captions`, `translate_captions`, `list_voices`, `speak`, `clone_voice`; `generate_captions` takes `engine` and `translateTo`.
- Fixed: errors from outside services (502 with a message for the user) were shown as "internal error".
- Tests: a mock of every AI provider (`scripts/mock-ai.ts`); `scripts/e2e-ai.ts` runs inside gate 4.

- Content library: 31 sound effects in 4 groups; 10 text styles (`add_text { preset }`) and 4 new caption styles (`set_caption_style { preset }`); title font for new titles (`set_title_font`). Spec: `specs/content-library.md`.
- Fonts: upload TTF, OTF, WOFF, WOFF2 (WOFF/WOFF2 converted to TTF here) or add from Google Fonts; the player loads the same file; the export copies it to libass `fontsdir` and sizes it by the font's own line height. Gate 9 now checks an added font's text box (player 58.9% vs MP4 58.6% of the width).
- Stock: Openverse (no key, commercial + modification licences only), Pexels and Pixabay (keys stored locally, owner-only file, never returned, cut from logs). Credits stored with the media; "copy credits" for the video description.
- Import from a link through a guarded downloader: http/https, public DNS only (checked on every redirect, connection pinned to the checked address), size, time and type limits, ffprobe before it reaches the library. Runs as an `import` job.
- Fixed: undo / redo dropped the layout, logo and title font (the undo snapshot now comes from one shared `editableState`).
- Tests talk to a local mock of Google Fonts and the stock sites (`scripts/mock-providers.ts`), never the internet.

- Export presets for 9 networks (size, fps, bitrate cap) with fit (blurred copy behind) or fill (centre crop) when the shape differs; REST `preset` / `reframe`, MCP `export`. Spec: `specs/export-layout.md`.
- Logo on every frame: corner, size, opacity, margin; burned in on the final frame; `set_logo`.
- Screen layouts for the main track and the one above it: stack, side, picture in picture; `set_layout`.
- Templates: save frame, tracks, layout, titles and logo; new video from a template (project panel and project menu); REST and MCP.
- Preview vs export gate now also covers the three layouts with a logo.
- Preview vs export gate (`scripts/parity.ts`, gate 9): PSNR of player screenshots vs MP4 frames, threshold 24 dB. It found and fixed smeared corners on rotated clips in export (`rotate c=none` -> `c=black@0`). Spec: `specs/editing-core.md`.
- Silence removal: dialog with check-first (dry run) and one-step undo; `POST /api/projects/:id/silences`; MCP `remove_silences`.
- Keyframes for position, size, rotation and opacity with 5 eases; K / Shift+K / Shift+J; diamonds on timeline clips; exact re-timing on split, trim and speed. Ops `set_keyframe`, `delete_keyframe`, `clear_keyframes`.
- Punch-in (zoom to a point) as 4 keyframes; op and MCP tool `punch_in`.
- Rotation and blend modes (screen, lighten, multiply, overlay); "make overlay above the video".
- 16 transitions (wipes, flash, blur, spin, zoom-out, dip to white, slide down); typewriter text animation; 4:5 aspect.
- Insert at the playhead (`insert_clip`), ripple on speed change, move a clip to a new track above / below.
- Dark studio design: dark semantic tokens, floating panels, white glowing primary pill, horizontal icon tabs, floating transport with resolution and fps, pill-grouped timeline toolbar, gradient text clips, outlined caption clips, round playhead knob, blurred dialog backdrop. Fonts Assistant, Inter and JetBrains Mono bundled (OFL). Stable `data-testid` hooks; the UI journey checks 1366x768, 1440x900 and 1920x1080. Spec: `specs/design.md`.
- Removing a media file also removes the captions that belong only to it; "delete all captions" button with undo.
