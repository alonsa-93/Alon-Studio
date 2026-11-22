# Export and layout

One shared model for the player and the export: `shared/layout.ts` (slots, logo rectangle, presets). Gate 9 (`scripts/parity.ts`) compares player and MP4 for every layout with a logo; `scripts/e2e-export.ts` (run inside gate 4) checks real pixels, sizes and bitrates of exported files.

## Export presets for networks

- **User sees:** in the export dialog, "לאן מעלים": "כמו הפרויקט" plus 9 networks. The summary line shows size, fps and the bitrate cap. When the network's shape differs from the project, a choice appears: "הכול נכנס, רקע מטושטש" (fit, default) or "מילוי המסך (חיתוך)" (fill). The last network picked is remembered in this browser (`localStorage`, optional).
- **Presets** (size, fps, cap in Mbps): YouTube 1920x1080 30 12 · YouTube 4K 3840x2160 30 45 · Shorts 1080x1920 30 10 · Reels 1080x1920 30 8 · TikTok 1080x1920 30 8 · Instagram 4:5 1080x1350 30 8 · Square 1080x1080 30 8 · X 1920x1080 30 8 · LinkedIn 1920x1080 30 8.
- **Export:** the project renders at its own size as before, then one output stage:
  - same shape: `scale`;
  - fill: `scale` (cover) + centre `crop`;
  - fit: `split`; one branch is scaled to cover at 1/4 size, `boxblur`, scaled back and darkened slightly (fast at 4K); the other is scaled to contain; `overlay` in the centre.
  - The bitrate cap is `-maxrate` + `-bufsize` (2x) next to the CRF; fps is `-r` from the preset. The file name gets `_<preset>`.
- **REST:** `POST /api/projects/:id/export { quality, preset?, reframe?: fit | fill }`; `GET /api/export-presets`. An unknown preset or reframe is a 400.
- **MCP:** `export` takes `preset` (enum of the ids) and `reframe`.
- **Measured:** noise video at CRF 17 is 85 Mbps without a preset and 8.5 Mbps with the X preset (cap 8). The average can sit a little above the cap because of the buffer; the test allows 15%.

## Logo

- **User sees:** "לוגו" in the project panel (nothing selected): pick a picture from the library or upload one, a 2x2 corner grid, size, opacity, distance from the edge, "הסרת הלוגו". The logo shows on the player where the export puts it.
- **Data:** `Project.logo?: { mediaId, corner, size, opacity, margin } | null` (optional). `size` is the width as a fraction of the frame width (0.03–0.5), `margin` a fraction of the shorter side (0–0.2). Numbers are clamped; the media must be a picture of the project. Removing that picture removes the logo.
- **Op:** `set_logo { logo: {...} | null }` (merges into the current logo).
- **Export:** a looped picture input, `scale`, `colorchannelmixer=aa`, `overlay` on the **final** frame, after captions and after a preset's reframing, so it is always inside the frame (fit would otherwise shrink it, fill could crop it). Corners are physical (left is left), also in the Hebrew interface.
- **MCP:** `set_logo` (`remove: true` takes it off).

## Screen layouts

- **User sees:** "פריסת מסך" in the project panel: רגיל, זה מעל זה, זה לצד זה, תמונה בתוך תמונה. A hint explains which tracks it uses.
- **Data:** `Project.layout?: 'stack' | 'side' | 'pip'` (missing = single; setting single removes the field, so old projects are unchanged).
- **Which clips:** the main video track (the bottom one) and the video track right above it. stack: main top half, the other bottom half. side: main left, the other right. pip: main full frame, the other 30% in the bottom-right corner, 4% from the edges. Each clip fills its rectangle, centre-cropped; its position, size and keyframes still apply on top, relative to the rectangle's centre.
- **Export:** for a clip in a slot, the fit step is `scale` (cover) + `crop` to the slot size, and the overlay is placed at the slot's centre.
- **Preview:** the `<img>` / `<video>` gets the slot box (`left`, `top`, `width`, `height`, `object-fit: cover`); selection and dragging use the same rectangle.
- **Op / MCP:** `set_layout { layout }`.

## Templates

- **User sees:** "תבניות" in the project panel: a name and "שמירה כתבנית", then a list with "סרטון חדש" and delete. The project menu also lists "סרטון חדש מתבנית".
- **What is saved:** frame (aspect, size, fps), background, tracks, layout, titles (text clips), caption style and caption animation, logo with its picture. Not saved: videos, pictures, sounds, captions, in/out points.
- **Storage:** `<data>/templates/tpl_*.json`. The id is checked against `tpl_[a-z0-9]`, never used as a path. The media cleanup keeps files a template's logo needs. A template is checked again (`sanitizeState`) when a project is made from it; a logo whose file is gone is dropped.
- **REST:** `GET /api/templates`, `POST /api/projects/:id/template { name }`, `DELETE /api/templates/:id`, `POST /api/projects { name, templateId }`. A bad template id creates nothing (404).
- **MCP:** `list_templates`, `save_template`, `create_project { templateId }`.

## Tests

- `regress.ts`: op validation, slots per layout, logo rectangle and clamping, undo / redo state with layout and logo, the 9 presets.
- `e2e-export.ts` (gate 4): logo pixels and opacity, Shorts fit (blurred copy above, picture in the middle, logo in the final frame's corner), 4:5 fill, YouTube scaling, bitrate cap, the three layouts by pixel colour, templates round trip, MCP tools.
- `security-tests.ts` (gate 5): template ids with a path, presets only by name.
- UI journey (gate 6): layout cards, logo upload and corner, save template, export with the Shorts preset (1080x1920), new video from the template.
- `parity.ts` (gate 9): stack, side and pip with a logo, 28–29 dB.
