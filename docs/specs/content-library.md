# Content library

Sound effects, caption and text styles, fonts, stock libraries, import from a link, and the credits that come with outside media. Everything outside the computer goes through one guarded downloader (`server/netguard.ts`); the tests point the outside services at a local mock (`scripts/mock-providers.ts`) and never touch the internet.

## Sound effects

- **User sees:** "אפקטי קול" in the sound tab, in 4 groups: תנועה ומעברים, מכות והדגשות, ממשק, צלילים. 31 effects, each with play and "+".
- **Made here:** every effect is an ffmpeg expression (`server/sfx.ts`), built once into the data folder's cache (batches of 4). No downloaded audio, so no licence question. `SFX_VERSION` stays `v3`, so earlier effects keep their ids.
- **REST / MCP:** `GET /api/library/sfx` (now with `group`); MCP `add_sound_effect`.

## Caption and text styles

- **Caption styles:** 9+ presets in `CAPTION_PRESETS` (new: marker, neon, minimal, mint). The op `set_caption_style` takes `preset` (an id) and/or `style`; a preset is applied first, then `style` on top. One of them is required.
- **Text styles:** `TEXT_PRESETS`, 10 entries (title, subtitle, display, kicker, lower-third, cta, boxed, tag, highlight, quote). `add_text { preset }` merges the preset with `style`. In the text tab each style is a button that adds a title at the playhead.
- **Title font:** `Project.titleFont?: string` (optional). New titles take it when they name no font (never captions). Op `set_title_font { font: string | null }` (null or "" removes it). Saved in templates, kept in the undo snapshot.

## Fonts

- **User sees:** "פונטים" in the text tab: the project's title font, the added families (with delete), "העלאת קובץ" (TTF, OTF, WOFF, WOFF2, up to 10 files of 30 MB), and "הוספה מ־Google Fonts" by family name. Added families appear in every font list (titles, captions).
- **Storage:** `<data>/fonts/f_xxx.ttf|otf` + `fonts.json`. WOFF and WOFF2 are converted to TTF/OTF here (`server/fontfile.ts`: zlib, brotli, and the WOFF2 glyf/loca/hmtx transforms rebuilt; 0 mismatches against fontTools on the test files), because the export's libass reads only sfnt files. Family names must be Latin letters, digits, space, `-` or `_` (`FONT_OK`); built-in names are refused. The same family + weight + slant replaces the earlier face. At most 300 faces.
- **Player:** `FontFace` from `/library/fonts/f_xxx.ttf` (key cookie, same origin, CSP `font-src 'self'`). Only file names `f_[a-z0-9]{6,16}.(ttf|otf)` are served.
- **Export:** the used families' files are copied to `<job>/fonts`, `subtitles=subs.ass:fontsdir=fonts`. Size: libass sizes by the font's full line height, CSS by the em box, so the ASS size is `size × scale` where `scale = (OS/2 winAscent + winDescent) / unitsPerEm` (else hhea ascender − descender). The formula gives the built-in table (Arial 1.117, Segoe UI 1.33, …).
- **Measured (gate 9):** Assistant Bold uploaded as WOFF, "Hamburg 2026" at 120 px: text box 58.9% × 15.3% of the frame in the player, 58.6% × 15.3% in the MP4.
- **Google Fonts:** `css2?family=X:wght@400;700` (falls back to the family alone when there is no bold), up to 4 faces; only files on `fonts.gstatic.com` are taken from the stylesheet.
- **REST:** `GET /api/fonts`, `POST /api/fonts` (multipart `files`), `POST /api/fonts/google { family }`, `DELETE /api/fonts/:family`. **MCP:** `list_fonts`, `add_google_font`, `set_title_font`.

## Keys for outside services

- `server/keys.ts`: `api-keys.json` in the data folder, written through a temp file that is locked to the current Windows account (`icacls`) before the key is written, then renamed. The API returns only `{ hasKey, last4 }`; every saved key is added to `redact`, so it never reaches a log line. A key is 8–300 printable ASCII characters. Unknown providers are a 404.
- **User sees:** a password field next to the provider that needs one; once saved, only "saved, ends with 1234" and a remove button.
- **REST:** `GET /api/keys`, `PUT /api/keys/:provider { key }`, `DELETE /api/keys/:provider`.

## Stock libraries

- **Providers:** Openverse (pictures and audio, no key, only `license_type=commercial,modification`), Pexels (pictures and video, key in the `Authorization` header), Pixabay (pictures and video, key in the query; that URL is never echoed in an error).
- **User sees:** "מאגרי סטוק" in the media tab: provider, kind, search, results with thumbnails (served by the app from `/library/stock-thumb/:id`, cached in `<data>/cache/stock-thumbs`). A click imports into the project with a progress line.
- **Cache:** results live 2 hours on the server; an import takes the result id, never a URL from the client.
- **REST:** `GET /api/stock/providers`, `GET /api/stock/search?provider&kind&q&page`, `POST /api/projects/:id/media/stock { id }`. **MCP:** `search_stock`, `import_stock`.

## Import from a link

- **User sees:** "ייבוא מקישור": paste a link, Enter. A blocked link shows why ("הקישור נחסם: ...").
- **Rules (`safeDownload`):** http/https only; no user name or password in the link; `localhost`, `.local`, `.internal` refused; DNS is resolved first and every address must be public (IPv4 private, loopback, link-local, CGNAT, multicast, reserved; IPv6 loopback, mapped, compatible, NAT64, 6to4, ULA, link-local, site-local, multicast, documentation). The connection is pinned to the checked address (`lookup`), and every redirect (up to 5) is checked again. Size (2 GB), time (30 min) and content type (video, audio, picture) are limited.
- **Then:** the file goes to `<data>/tmp/downloads`, ffprobe must read it, and only then it moves to `media` and is registered. It runs as an `import` job (`GET /api/jobs/:id`), one per project at a time.
- **REST:** `POST /api/projects/:id/media/url { url }`. **MCP:** `import_url`.
- **Tests only:** `ALON_STOCK_BASE`, `ALON_GOOGLE_FONTS_CSS`, `ALON_GOOGLE_FONTS_FILES` point at the mock (set only in `scripts/test-server.mjs`). The stock downloader trusts only that one origin; the user's link import has no bypass.

## Credits

- **Data:** `MediaAsset.credit?: { provider, title?, author?, authorUrl?, license, licenseUrl?, sourceUrl? }` and `source?` (optional). Kept when media is removed and added back through undo.
- **User sees:** a small badge on media cards with a credit; "העתקת קרדיטים" copies one line per outside file that is used in the video.
- **REST:** `GET /api/projects/:id/credits` → `{ items, text }`.

## Not done here

- No live test against Google Fonts, Openverse, Pexels or Pixabay: only the mock. The first real use should be watched.
- Families whose name is not Latin are refused (libass and the ASS override tag need a safe name).
- Variable fonts: only the default instance is used, in both player and export. Synthetic bold (a family without a bold face) can look slightly different between the browser and libass.
