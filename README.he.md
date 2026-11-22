# ALON.ai Studio

[English](README.md)

סטודיו לעריכת וידאו שרץ מקומית בדפדפן: ציר זמן מרובה ערוצים, כתוביות אוטומטיות בעברית, ייצוא MP4, ושליטה מלאה דרך REST ו-MCP. בלי מנויים ובלי ענן.

- **צד לקוח:** Vite + React + TypeScript, ממשק בעברית (RTL).
- **צד שרת:** Node (Express) על אותו פורט, 5173.
- **רינדור וייצוא:** ffmpeg.
- **תמלול:** Whisper מקומי (faster-whisper).

## התקנה

דרושים Node 20 ומעלה, ffmpeg, ו-Python 3.9 ומעלה (רק בשביל הכתוביות).

**1. ffmpeg** (חייב להיות ב-PATH, כולל ffprobe):

```bash
winget install Gyan.FFmpeg
```

ב-macOS: `brew install ffmpeg`. בלינוקס: `sudo apt install ffmpeg`.

**2. Whisper** (לכתוביות):

```bash
pip install faster-whisper
```

בהרצת התמלול הראשונה המודל יורד פעם אחת (ברירת המחדל `medium`, כ-1.5GB) ונשמר במטמון המקומי.

**3. תלויות הפרויקט:**

```bash
npm install
```

## הרצה

```bash
npm start
```

השרת מדפיס כתובת פתיחה מהצורה `http://localhost:5173/#k=<מפתח>`, ופותחים אותה בדפדפן. הממשק, ה-API ושרת ה-MCP רצים כולם על הפורט הזה, וכולם דורשים את מפתח הגישה (ראו "אבטחה").

## חבילה ניידת ל-Windows (לשליחה למי שלא מתכנת)

```bash
npm run release
```

```bash
npm run release:docs
```

```bash
npm run release:zip
```

הפקודה השנייה כותבת לתיקייה את `sbom.cdx.json` (רשימת הרכיבים), את `THIRD-PARTY-NOTICES.txt` (רישיונות) ואת `SHA256SUMS.txt` (טביעת אצבע לכל קובץ). השלישית יוצרת את `release/ALON-Studio-Windows.zip` ולידו את `ALON-Studio-Windows.zip.sha256`.

הפקודה בונה את התיקייה `release/ALON Studio` ובתוכה כל מה שצריך: Node, ffmpeg, ו-Python עם faster-whisper. אין צורך להתקין שום דבר במחשב היעד.

### התקנה מתוך ה-zip

ב-zip יש גם את `התקנה.cmd`. לחיצה כפולה עליו מתקינה את התוכנה למשתמש הנוכחי, בלי הרשאות מנהל:
- **מיקום:** התוכנה מועתקת ל-`%LOCALAPPDATA%\Programs\ALON Studio`.
- **קיצורי דרך:** נוצר אייקון בתפריט התחל ועל שולחן העבודה.
- **הסרה:** התוכנה מופיעה ב"הגדרות ← אפליקציות" ואפשר להסיר אותה משם.
- **עדכון:** מריצים את ההתקנה מ-zip חדש.

הסרטונים והפרויקטים ב-Documents\ALON Studio לא נמחקים לעולם.

הקוד נמצא ב-`scripts/installer`:
- **`install.ps1` ו-`uninstall.ps1`:** ההתקנה וההסרה.
- **`install.cmd`:** קובץ ASCII בלבד, שנוצר מחדש עם `node scripts/installer/gen-install-cmd.mjs`.

ההתקנה עובדת בלי exe, כי Smart App Control של Windows 11 חוסם כל exe לא חתום.

**חשוב:** במחשב שבו Smart App Control פועל, Windows חוסם קבצי `.cmd` שחולצו מ-zip שהורד מהאינטרנט. לכן לפני החילוץ צריך לפתוח את המאפיינים של ה-zip ולסמן "ביטול חסימה" (Unblock). ההוראה הזו כתובה גם ב"קרא אותי".

### קובץ setup.exe (רק עם חתימה דיגיטלית)

```bash
npm run release:setup
```

הפקודה בונה את `release/ALON-Studio-Setup.exe` עם Inno Setup 6. כדי להתקין את Inno Setup:

```bash
winget install --id JRSoftware.InnoSetup -e --scope user
```

כל עוד הקובץ לא חתום, Smart App Control חוסם אותו לגמרי, ולכן הוא לא נשלח כרגע.

- **הפעלה:** מחלצים את ה-ZIP ולוחצים פעמיים על `ALON Studio.cmd`. הסטודיו נפתח בחלון משלו (Edge או Chrome), וסגירת החלון סוגרת את התוכנה.
- **נתונים:** הפרויקטים והייצוא נשמרים ב-`%USERPROFILE%\Documents\ALON Studio`, כך שאפשר להחליף את תיקיית התוכנה בגרסה חדשה בלי לאבד עבודה.
- **כתוביות:** בתמלול הראשון מודל Whisper יורד פעם אחת (כ-1.5GB), ולכן נדרש אז חיבור לאינטרנט.
- **אזהרת Windows:** החבילה לא חתומה דיגיטלית, ולכן ייתכן ש-Windows יציג אזהרה בהפעלה הראשונה ("More info" ואז "Run anyway").
- **בלי Whisper:** `npm run release -- --no-whisper` בונה חבילה קטנה יותר, בלי תמלול.

## שימוש

- **מדיה:** מעלים וידאו, תמונות או אודיו (או גוררים לפאנל), ולוחצים "+" כדי להוסיף לציר הזמן.
- **ציר זמן:** גרירה להזזה (גם בין ערוצים), גרירת קצוות לחיתוך, הצמדה (snap), זום עם Ctrl + גלגלת.
- **טקסט, מעברים, אנימציות:** בוחרים קליפ ולוחצים "+" בלשונית המתאימה. טקסט אפשר לגרור בתצוגה המקדימה.
- **אפקטים:** מראות צבע (חי, חם, קר, שחור-לבן, וינטג׳, דרמטי, דהוי, קולנועי, שמשי), טשטוש, מילוי המסך או התאמה, היפוך מראה. כיוונון עדין (בהירות, ניגודיות, רוויה, חום, גודל, מיקום, שקיפות) ומהירות ניגון (0.25x עד 4x) בפאנל "קליפ נבחר".
- **כתוביות:** לשונית "כתוביות", ואז "תמלול אוטומטי". אפשר לבחור כמה מילים בכל כתובית, להחיל תבנית עיצוב, להדגיש את המילה הנאמרת, להוסיף אנימציית כניסה, לערוך כל שורה, ולייבא או לייצא קובץ SRT. הכתוביות נצרבות בייצוא. התמלול נעשה במחשב (לעברית: מודל ivrit.ai) או בענן (OpenAI, Groq, ElevenLabs, עם מפתח שלכם). "תרגום הכתוביות" מתרגם ל-9 שפות בלי לשנות את הזמנים, ואפשר להשאיר את השורות המקוריות מעל התרגום או מתחתיו.
- **סאונד:** מוזיקת רקע עם עוצמה ודהייה, 31 אפקטי קול מובנים בארבע קבוצות, הקלטת קריינות מהמיקרופון, קריינות מטקסט ושכפול קול (Cartesia, רק באישור שהקול שלכם), ניתוק האודיו מקליפ וידאו, השתקת ערוץ, ואיזון עוצמה ל-‎-14 LUFS בייצוא.
- **תנועה (Keyframes):** בפאנל "קליפ נבחר" מוסיפים נקודות תנועה ומשנים בכל אחת גודל, מיקום, סיבוב ושקיפות, עם האטה לנקודה הבאה. "זום לנקודה" מוסיף התקרבות, החזקה ויציאה בלחיצה אחת.
- **שכבות ומיזוג:** סיבוב, מיזוג עם מה שמתחת (מסך, הבהרה, הכפלה, שכבת־על) והעברת קליפ לשכבה מעל הסרטון.
- **מעברים:** 16 מעברים, בהם מחיקה מכל כיוון, הבזק, טשטוש, סיבוב וזום החוצה. אנימציית מכונת כתיבה לטקסט. יחס 4:5 לפוסטים.
- **הסרת שתיקות:** כפתור "שתיקות" בציר הזמן. קודם בודקים מה יימחק, ואז מוחקים הכול בצעד אחד שאפשר לבטל.
- **ערוצים:** כפתורי עין ורמקול בכותרת הערוץ מסתירים או משתיקים אותו. צבע הרקע נקבע בהגדרות הפרויקט.
- **פריסה, לוגו ותבניות:** בפאנל "הסרטון" (כשלא נבחר קליפ): פריסת מסך (זה מעל זה, זה לצד זה, תמונה בתוך תמונה), לוגו קבוע בפינה, ושמירת הפרויקט כתבנית לסרטונים הבאים.
- **סגנונות ופונטים:** 10 סגנונות טקסט (כותרת, כותרת משנה, שם ותפקיד, קריאה לפעולה ועוד) ו-9 סגנונות כתוביות. בלשונית "טקסט", "פונטים": העלאת קובצי פונט (TTF, OTF, WOFF, WOFF2) או הוספה מ-Google Fonts, ובחירת פונט לכל הכותרות החדשות. הפונט נצרב בייצוא באותו גודל שרואים בתצוגה.
- **סטוק וקישורים:** בלשונית "מדיה", "מאגרי סטוק": חיפוש ב-Openverse (בלי מפתח), Pexels ו-Pixabay (עם מפתח שנשמר במחשב בלבד). "ייבוא מקישור" מוריד קובץ מכתובת ציבורית. הרישיון והקרדיט נשמרים עם הקובץ, ו"העתקת קרדיטים" מעתיקה אותם לתיאור הסרטון.
- **סוכן AI:** בלשונית "סוכן AI" כותבים מה לעשות (למשל "תוסיף כותרת בהתחלה"). הסוכן עורך עותק של הפרויקט, ואז מציג כרטיס עם רשימת השינויים. "אישור" שומר אותם בצעד אחד (Ctrl+Z מבטל), "ביטול" משאיר את הפרויקט כמו שהיה. ספקים: Anthropic (ברירת המחדל: Claude Opus 5.5), OpenAI, xAI, OpenRouter, Groq, Together, או שרת מקומי (Ollama, LM Studio). השיחה נשמרת לכל פרויקט, ומספר הסבבים בכל בקשה מוגבל.
- **שפה:** הכפתור EN / עב בסרגל העליון מחליף את הממשק לאנגלית (משמאל לימין) ובחזרה. הבחירה נשמרת בדפדפן. קיצורי המקלדת עובדים גם במקלדת עברית, כי הם נקראים לפי המקש הפיזי.
- **ייצוא:** כפתור "ייצוא" מפיק MP4 ‏(H.264 + AAC) ברזולוציה וב-fps של הפרויקט, או לפי רשת (יוטיוב, שורטס, רילס, טיקטוק, אינסטגרם, X, לינקדאין) עם תקרת קצב נתונים. כשהצורה שונה מהפרויקט בוחרים: הכול נכנס עם רקע מטושטש, או מילוי המסך בחיתוך. אם סומנו נקודות In / Out אפשר לייצא רק את הטווח. הקבצים נשמרים ב-`data/exports`.

| פעולה | מקש |
| --- | --- |
| נגן / עצור | רווח |
| פיצול בסמן | S |
| מחיקת הקליפ הנבחר | Delete |
| מחיקה וסגירת הרווח | Shift+Delete |
| שכפול קליפ | Ctrl+D |
| העתקה והדבקה במיקום הסמן | Ctrl+C / Ctrl+V |
| נקודות In / Out | I / O |
| מחיקת הטווח שבין In ל-Out | X |
| ביטול / שחזור | Ctrl+Z / Ctrl+Y |
| זום בציר הזמן | Ctrl + גלגלת |
| פריים אחורה / קדימה | חיצים |
| נקודת תנועה בסמן (הוספה או הסרה) | K |
| לנקודת התנועה הבאה / הקודמת | Shift+K / Shift+J |

## API

כל פעולה בממשק זמינה גם ב-REST, ושינויים שמגיעים מבחוץ מופיעים בעורך מיד. כל בקשה צריכה את הכותרת `Authorization: Bearer <מפתח>` (המפתח בקובץ `access-key` שבתיקיית הנתונים, ומופיע גם בדף "API / MCP" באפליקציה). במקום מזהה פרויקט אפשר לכתוב `current` (הפרויקט שנערך לאחרונה).

| תיאור | נקודת קצה |
| --- | --- |
| תקציר הפרויקט | `GET /api/projects/:id/summary` |
| פעולות עריכה | `POST /api/projects/:id/ops` |
| העלאת קבצים (multipart, שדה `files`) | `POST /api/projects/:id/media` |
| ייבוא קובץ מקומי לפי נתיב | `POST /api/projects/:id/media/import` |
| תמלול `{ language, maxWords, engine, translateTo }` (engine: auto / local / cloud) | `POST /api/projects/:id/captions` |
| תרגום הכתוביות `{ to, keepOriginal, position }` | `POST /api/projects/:id/captions/translate` |
| הגדרות AI (בלי מפתחות), רשימת מודלים | `GET`/`PUT /api/ai/settings`, `GET /api/ai/models?provider=` |
| קולות, דוגמת קול | `GET /api/voice/voices`, `GET /api/voice/voices/:id/preview` |
| קריינות מטקסט `{ text, voiceId, speed, start }`, שכפול קול `{ name, clipId, consent }` | `POST /api/projects/:id/speak`, `POST /api/projects/:id/clone-voice` |
| סוכן AI: מצב, בקשה `{ text, playhead, selection }`, עצירה, אישור, ביטול, ניקוי | `GET`/`POST`/`DELETE /api/projects/:id/agent`, `POST …/agent/stop`, `…/agent/approve`, `…/agent/cancel` |
| הורדת הכתוביות כ-SRT | `GET /api/projects/:id/captions.srt` |
| אפקטי הקול המובנים | `GET /api/library/sfx` |
| הסרת שתיקות `{ thresholdDb, minSilence, padding, dryRun }` (ברירת המחדל: רק בדיקה) | `POST /api/projects/:id/silences` |
| ייצוא `{ quality, preset, reframe }` (preset: youtube, youtube-4k, shorts, reels, tiktok, instagram-post, square, x, linkedin; reframe: fit / fill) | `POST /api/projects/:id/export` |
| רשימת הגדרות הייצוא לרשתות | `GET /api/export-presets` |
| תבניות: רשימה, שמירה, מחיקה | `GET /api/templates`, `POST /api/projects/:id/template`, `DELETE /api/templates/:id` |
| פרויקט חדש מתבנית `{ name, templateId }` | `POST /api/projects` |
| פונטים: רשימה, העלאה (TTF, OTF, WOFF, WOFF2), Google Fonts, מחיקה | `GET /api/fonts`, `POST /api/fonts`, `POST /api/fonts/google`, `DELETE /api/fonts/:family` |
| מפתחות לשירותים חיצוניים (מחזיר רק 4 תווים אחרונים) | `GET /api/keys`, `PUT /api/keys/:provider`, `DELETE /api/keys/:provider` |
| סטוק: ספקים, חיפוש, ייבוא תוצאה `{ id }` | `GET /api/stock/providers`, `GET /api/stock/search`, `POST /api/projects/:id/media/stock` |
| ייבוא מקישור ציבורי `{ url }` | `POST /api/projects/:id/media/url` |
| קרדיטים לקבצים מבחוץ | `GET /api/projects/:id/credits` |
| מצב עבודת ייצוא, תמלול, תרגום או ייבוא | `GET /api/jobs/:jobId` |

פעולות העריכה (`op`): `cut_range`, `split`, `delete`, `add_text`, `add_transition`, `add_music`, `set_aspect`, `add_clip`, `move_clip`, `trim_clip`, `update_clip`, `set_animation`, `set_settings`, `set_caption_style`, `set_captions`, `set_in_out`, `add_track`, `delete_track`, `remove_media`, `set_fx`, `set_speed`, `duplicate`, `detach_audio`, `set_track`, `set_caption_animation`, `set_keyframe`, `delete_keyframe`, `clear_keyframes`, `punch_in`, `insert_clip`, `move_clip_to_new_track`, `set_layout`, `set_logo`, `set_title_font`. ל-`add_text` ול-`set_caption_style` אפשר להעביר `preset`. הפרמטרים של כל אחת מופיעים בדף "API / MCP" בתוך האפליקציה.

```bash
curl -X POST http://localhost:5173/api/projects/current/ops -H "Authorization: Bearer $ALON_KEY" -H "Content-Type: application/json" -d '{"op":"cut_range","start":2,"end":5}'
```

## MCP

```bash
claude mcp add --transport http alon-studio http://localhost:5173/mcp --header "Authorization: Bearer <מפתח>"
```

הפקודה המלאה, עם המפתח, מופיעה בדף "API / MCP" באפליקציה. כלי שמשנה או מוחק מסומן `destructiveHint`, וכלי קריאה מסומן `readOnlyHint`.

הכלים: `get_summary`, `cut_range`, `split`, `delete`, `add_text`, `add_transition`, `add_music`, `add_sound_effect`, `set_effect`, `set_speed`, `set_aspect`, `set_keyframe`, `delete_keyframe`, `punch_in`, `insert_clip`, `move_clip_to_new_track`, `set_animation`, `remove_silences`, `set_layout`, `set_logo`, `save_template`, `list_templates`, `set_caption_style`, `set_title_font`, `list_fonts`, `add_google_font`, `search_stock`, `import_stock`, `import_url`, `generate_captions`, `get_captions`, `translate_captions`, `list_voices`, `speak`, `clone_voice`, `export`, `import_media`, `add_clip`, `move_clip`, `trim_clip`, `update_clip`, `duplicate_clip`, `ripple_delete`, `detach_audio`, `add_track`, `set_track`, `delete_track`, `set_settings`, `set_in_out`, `set_captions`, `set_caption_animation`, `remove_media`, `apply_ops`, `job_status`, `list_projects`, `create_project`.

לכל פעולת עריכה (`op`) יש כלי MCP משלה (הטבלה `OP_TOOLS` ב-`server/mcp-ops.ts`), והבדיקות מוודאות שאף פעולה לא חסרה. `apply_ops` מריץ כמה פעולות בצעד אחד.

## בדיקה מקצה לקצה

כשהשרת רץ, הסקריפט מעלה קליפ, חותך טווח, מפצל, מוסיף טקסט וכתוביות, מייצא ומאמת את הקובץ עם ffprobe:

```bash
npm run test:e2e -- path/to/clip.mp4 path/to/music.mp3
```

בדיקה שנייה מכסה אפקטים, מהירות, אפקטי קול, הדגשת מילים, SRT ואיזון עוצמה:

```bash
npx tsx scripts/e2e-features.ts path/to/clip.mp4
```

כדי להריץ את הבדיקות מול החבילה הארוזה מגדירים `BASE_URL` לכתובת שלה, ו-`ALON_DATA_DIR` לתיקיית הנתונים שלה (משם הבדיקות קוראות את מפתח הגישה).

בדיקות האבטחה (מפתח, מקור, כותרות, קבצים, קלט פגום, נעילה, סודות). מריצים מול מופע זמני בלבד:

```bash
npm run test:security -- path/to/clip.mp4
```

בדיקת משתמש בדפדפן אמיתי (Edge במצב headless): לוחצת על מה שמופיע במסך, מקלידה, מנגנת, מתמללת ומייצאת, ושומרת צילומי מסך לבדיקה בעין:

```bash
npm run test:ui -- http://localhost:5173 path/to/video.mp4 path/to/music.mp3 ui-out
```

ודאו שאין שרת ישן אחר שמאזין על אותו פורט, אחרת הבדיקה תרוץ מול הגרסה הלא נכונה.

## נתונים והגדרות

מצב כל פרויקט נשמר כ-JSON ב-`data/projects`. קובצי המדיה ב-`data/media` והייצוא ב-`data/exports`.

| משתנה סביבה | ברירת מחדל | תיאור |
| --- | --- | --- |
| `PORT` | `5173` | פורט השרת |
| `ALON_DATA_DIR` | `./data` | תיקיית הנתונים |
| `WHISPER_MODEL` | `medium` | מודל התמלול (`small` מהיר יותר, `large-v3` מדויק יותר) |
| `WHISPER_MODEL_HE` | `ivrit-ai/whisper-large-v3-turbo-ct2` | מודל התמלול המקומי לעברית (גרסה נעולה, SHA-256) |
| `WHISPER_PYTHON` | `python` | מפרש ה-Python שבו מותקן faster-whisper |
| `FFMPEG_PATH`, `FFPROBE_PATH` | `ffmpeg`, `ffprobe` | נתיבים מפורשים ל-ffmpeg |
| `ALON_IMPORT_DIRS` | (ריק) | תיקיות נוספות שמהן מותר לייבא מדיה לפי נתיב, מופרדות ב-`;` |
| `ALON_ACCESS_KEY` | (מהקובץ) | מפתח גישה קבוע (64 תווים הקסדצימליים), לבדיקות אוטומטיות |

## אבטחה

- **מפתח גישה:** בהפעלה הראשונה נוצר מפתח אקראי של 256 ביט בקובץ `access-key` בתיקיית הנתונים, וההרשאות לקובץ ניתנות רק לחשבון Windows הנוכחי. בלי המפתח השרת עונה 401. חלון האפליקציה מקבל אותו בכתובת (`#k=`), שומר אותו לחלון בלבד ומנקה את שורת הכתובת. אחרי 20 ניסיונות שגויים בדקה, מפתחות שגויים נחסמים ל-5 דקות, והחלון האמיתי ממשיך לעבוד.
- **מקור:** השרת מאזין רק ל-localhost, ומקבל רק בקשות מהכתובת שלו עצמו (בדיקת Host, Origin ו-Sec-Fetch-Site).
- **קבצים:** ייבוא לפי נתיב מותר רק לקובצי מדיה מתוך תיקיית המשתמש (או `ALON_IMPORT_DIRS`), בלי נתיבי רשת. מדיה מוגשת עם `sandbox` ובלי שמירה במטמון הדפדפן.
- **ניקיון:** מחיקת פרויקט מוחקת את המדיה שלו. קבצים זמניים (אודיו לתמלול, כתוביות) נמחקים בסוף כל עבודה ובכל הפעלה. ייצוא נכתב לתיקייה זמנית ועובר ל-`exports` רק כשהוא שלם.
- **רשת:** חיבורים החוצה רק כשהמשתמש מבקש: הורדת מודל התמלול בפעם הראשונה (גרסה נעולה, SHA-256), Google Fonts, מאגרי הסטוק, ייבוא מקישור, ושירותי ה-AI שבחרתם (תמלול בענן, תרגום, הסוכן, Cartesia). לסוכן נשלחים ההודעות ופרטי הפרויקט (שמות, זמנים, טקסטים, כתוביות), לא קובצי וידאו. מודל מקומי מותר רק בכתובת של המחשב הזה (127.0.0.1, localhost). כל הורדה מקישור עוברת בדיקה: רק http/https, כתובת ה-DNS חייבת להיות ציבורית (גם אחרי כל הפניה, והחיבור ננעל לכתובת שנבדקה), מגבלת גודל, זמן וסוג, והקובץ נכנס לספרייה רק אחרי ש-ffprobe קרא אותו.
- **הסוכן:** עורך רק טיוטה, ושום דבר לא נשמר בלי אישור. הוא מקבל רק כלי קריאה ועריכה של הפרויקט הפתוח (בלי ייבוא, אינטרנט, ייצוא או פרויקטים אחרים), וטקסטים מתוך הסרטון מסומנים לו כתוכן ולא כהוראות.
- **מפתחות:** מפתחות לשירותים חיצוניים נשמרים ב-`api-keys.json` בתיקיית הנתונים, עם הרשאות לחשבון Windows הנוכחי בלבד. השרת מחזיר רק את 4 התווים האחרונים, והמפתחות נמחקים מכל שורת לוג.
- **בדיקה חודשית:** `npm run security:check` בודק את חבילות npm ואת חבילות ה-Python שבחבילה מול npm audit ו-OSV, ואת גרסת Node שבחבילה מול עדכוני האבטחה. קוד יציאה 1 אומר שיש מה לעדכן.

## הערות

- הפונטים של הטקסט הם פונטי מערכת של Windows (למשל Arial, David, Aharoni). פונט שלא מותקן יוחלף בפונט ברירת מחדל.
- קובצי וידאו שהדפדפן לא יודע לנגן (למשל HEVC מהטלפון) מקבלים עותק תצוגה אוטומטי, והייצוא נעשה תמיד מהמקור.
- `rollup` מותקן בגרסת WebAssembly (דרך `overrides` ב-`package.json`), כדי שהפרויקט ירוץ גם במחשבים שבהם Windows חוסם קבצים בינאריים לא חתומים.

## רישיון

ALON.ai Studio הוא תוכנה חופשית ברישיון [GNU GPL גרסה 3 ומעלה](LICENSE). החבילה ל-Windows כוללת את FFmpeg (GPL), Node.js, Python ורכיבים נוספים, כל אחד ברישיון שלו, כמפורט ב-`THIRD-PARTY-NOTICES.txt` וב-`sbom.cdx.json` שבחבילה. דיווח על בעיות אבטחה: [SECURITY.md](SECURITY.md). תרומה לקוד: [CONTRIBUTING.md](CONTRIBUTING.md). באנגלית: [README.md](README.md).
