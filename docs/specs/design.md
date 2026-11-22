# Design: dark studio theme

## Design language

- A dark studio. Near-black background with a soft gradient; the picture in the player is the brightest thing on screen.
- Panels are dark cards floating on the background: large radius (~24px), a thin semi-transparent outline, no heavy shadows, a small gap between them.
- One primary action per area: a white pill with dark text and a colored glow ring ("Export", "Start export"). Secondary buttons are dark pills, icon buttons are round.
- One vivid accent for sliders, selection, the playhead and "on" states. Titles and text clips use a multi-color gradient.
- Library tabs: icon above label, in a row; the active tab sits in a white circle.
- The transport floats under the player: timecode on one side, a big round white Play in the middle, duration / resolution / fps on the other side.
- The timeline toolbar is grouped into pills (undo/redo, split/delete/duplicate, range, zoom).
- Track headers show kind icon, name, mute, hide. Video clips show thumbnails, audio shows a waveform, text clips use the gradient, caption clips are outlined. The playhead has a round knob.
- Dialogs are a centered card over a blurred backdrop; choices are chips, binary choices are segmented controls, the primary action is a big white button at the bottom.

## What ALON Studio does with it

- **Identity stays ALON's.** Brand "ALON.ai" with the "A" logo. Accent is ALON coral, lightened for dark backgrounds: `--accent: #ff7a50` (contrast 7.0:1 on `--panel`). Gradient: coral -> pink -> violet (`#ff7a50 -> #ff4f8b -> #8b5cf6`).
- **Fonts:** Assistant (Hebrew) + Inter (Latin), JetBrains Mono for timecodes. All OFL, bundled from `@fontsource` (no network at runtime). Base weight 500, base size 15px (14px under 800px height).
- **Tokens** (in `src/styles.css`, nothing hard-coded in components):
  - surfaces: `--bg`, `--bg-grad`, `--panel`, `--panel-2`, `--panel-3`, `--line`, `--line-strong`
  - text: `--text-1` (#f4f2ef), `--text-2` (#c3beb7), `--text-3` (#9a948c, 5.6:1 on panel), `--text-disabled`
  - accent: `--accent`, `--accent-2` (pink), `--accent-soft`, `--accent-line`, `--accent-text`, `--gradient`, `--glow`
  - state: `--focus`, `--ok`, `--danger` (+ `-soft` variants)
  - clip kinds: `--c-video`, `--c-image`, `--c-text`, `--c-caption`, `--c-audio`
  - The old light token names (`--surface`, `--border`, ...) remain as aliases of the new ones so no component breaks.
- **Base components:** `.btn` (dark pill), `.btn.primary` (white pill + glow), `.btn.accent` (coral pill), `.icon-btn` (round), `.chip`, `.seg`, sliders, fields, `.card`, `.modal`, `.toast`, `.bar`.
- **Layout:** app grid = top bar / workspace / timeline, with 10px gutters; the library, preview, inspector and timeline are floating panels.
  - Library: tabs are a horizontal row at the top of the panel.
  - Preview: the transport is a floating pill under the stage; its end side shows duration, resolution and fps.
  - Timeline toolbar: buttons wrapped in `.tool-group` pills.
- **Behavior does not change:** shortcuts, drag/trim, right-click menu, snap and zoom are untouched; only markup wrappers and classes were added.
- **Test hooks:** key elements carry `data-testid` (`topbar`, `export-open`, `project-menu`, `library-tabs`, `tab-<id>`, `stage`, `transport`, `play`, `timeline`, `tl-toolbar`, `inspector`, `export-dialog`, `export-start`). `scripts/ui/user-journey.mjs` uses them.
- **Screens:** must work at 1366x768, 1440x900 and 1920x1080 with no horizontal scroll and no overlaps (checked by the UI journey at each size).
