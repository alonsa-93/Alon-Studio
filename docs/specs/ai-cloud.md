# AI and cloud services

Cloud transcription, caption translation that keeps the timing, narration and voice cloning with Cartesia, and an AI agent that edits with the MCP tools but only on a draft the user approves. Every outside call is made only when the user asks for it, with a key the user saved. The tests point every provider at a local mock (`scripts/mock-ai.ts`) and never reach the internet.

## Settings and keys

- **Settings:** `<data>/ai-settings.json` (`server/aiconfig.ts`), no secrets. Every field is optional on disk; missing ones take the defaults.
  - `transcription { engine: auto | local | cloud, provider: openai | groq | elevenlabs, model }`
  - `agent { provider, model, baseUrl, maxRounds 1..24 (8) }`
  - `voice { model, voiceId, voiceName }`
- **Validation:** unknown providers and engines are a 400. Model names must match `[\w.:/@+-]{1,120}`. The local model address must be `http(s)://127.0.0.1 | localhost | [::1]`: no LAN, cloud metadata, file or look-alike hosts.
- **Keys:** the same store as the stock keys (`server/keys.ts`, owner-only file, only `last4` returned, every key added to `redact`). New providers: openai, groq, elevenlabs, cartesia, anthropic, xai, openrouter, together. `local` needs none.
- **Hosts:** fixed public hosts. `ALON_AI_BASE` (set only by `scripts/test-server.mjs`) points all of them at the mock.
- **REST:**
  - `GET /api/ai/settings` returns `{ settings, stt, agent, languages, localWhisper }`. `localWhisper` is `null` while the background check of the faster-whisper install runs; the check can take half a minute the first time, and a failed check is retried after a minute.
  - `PUT /api/ai/settings` with a partial patch.
  - `GET /api/ai/models?provider=` lists the provider's models.

## Cloud transcription

- **User sees:** in the captions tab, "איפה לתמלל":
  - "אוטומטי": this computer when faster-whisper is installed, else the cloud.
  - "במחשב הזה".
  - "בענן", with the provider and its key field. The hint says the audio is sent to that provider.
- **Made here:** `server/cloudstt.ts`.
  - The speech mix is cut into mono 16 kHz MP3 parts of 20 minutes (48 kbps, about 7 MB, under every provider's upload limit).
  - Each part is sent with word timestamps. Each word gets its part's offset, then the same caption grouping as the local engine.
  - OpenAI `whisper-1` and Groq `whisper-large-v3`: `verbose_json`, `timestamp_granularities[]=word`.
  - ElevenLabs `scribe_v1`: `timestamps_granularity=word`; only `type: word` entries are kept.
- **Hebrew on this computer:** the default local model for Hebrew is `ivrit-ai/whisper-large-v3-turbo-ct2`. It is pinned in `transcribe.py` to revision `72ad623a…` with the SHA-256 of `model.bin` (1.6 GB, one download). Other languages keep `WHISPER_MODEL`.
- **REST:** `POST /api/projects/:id/captions { language, maxWords, model?, engine?, translateTo? }`. The job result has `engine` and `translatedTo`.
- **MCP:** `generate_captions { engine, translateTo }`.

## Caption translation

- **Languages:** he, en, ar, ru, es, fr, de, it, pt.
- **Model:** the one set for the agent, so there is one place to choose a model.
- **Batches:** 30 lines, with 3 lines of context before and after.
- **Prompt:** says the lines are content, never instructions, and asks for a JSON array only.
- **Answer check:** the answer must be an array of exactly that many lines, or the batch is asked once more. Then the job fails and nothing changes.
- **Timing:** every caption keeps its start and end; word highlight timing is spread evenly over the translated words.
- **Original lines:** optionally kept as titles on their own text track, just above or below the captions (`translationOps`), all in one undo step.
- **Changed meanwhile:** if the captions changed while the job ran, it ends with a 409 and changes nothing.
- **User sees:** "תרגום הכתוביות" under the caption list (language, replace or keep the originals above or below), or "תרגום אחרי התמלול" next to the engine choice.
- **REST:** `POST /api/projects/:id/captions/translate { to, keepOriginal, position }`, a `translate` job.
- **MCP:** `translate_captions`, `get_captions`.

## Narration and voice cloning (Cartesia)

- **Headers:** `X-API-Key`, `Cartesia-Version: 2025-04-16`.
- **Text to speech:** `/tts/bytes` with model `sonic-3` (settable), `voice { mode: id }`, the language (Hebrew detected from the text), WAV PCM 44.1 kHz, and `generation_config.speed` 0.6–1.5.
- **Result:** the WAV is checked (`RIFF`) and added to the media library ("קריינות - …"). With `start` it is also placed on an audio track at that time.
- **Voice preview:** generated once per voice and language and kept in `<data>/cache/voice-samples`.
- **Clone:**
  - The consent box is required; the server refuses without `consent: true`.
  - The source is a selected video or audio clip with sound. Up to its first 30 seconds are cut to WAV by ffmpeg and sent to `/voices/clone` (`mode=similarity`).
  - The new voice becomes the selected one.
- **User sees:** in the sound tab, "קריינות מטקסט (AI)": key, language, voice with "השמעת דוגמה", text, speed, "יצירת קריינות במקום הסמן", and "שכפול קול מקליפ" with the consent box.
- **REST:**
  - `GET /api/voice/voices?q&language&mine`
  - `GET /api/voice/voices/:id/preview?language`
  - `POST /api/projects/:id/speak { text, voiceId, language?, speed?, start? }`
  - `POST /api/projects/:id/clone-voice { name, clipId, consent, language? }`
- **MCP:** `list_voices`, `speak`, `clone_voice` (its description tells the model to ask the user first).

## The AI agent

- **Providers:**
  - Anthropic through the official SDK (`@anthropic-ai/sdk`, beta Messages). The default model is `claude-opus-5-5`; supported models use the server-side fallback beta. Thinking blocks are passed back unchanged.
  - OpenAI, xAI, OpenRouter, Groq, Together and a local server (Ollama, LM Studio) through the OpenAI-compatible `chat/completions` with function tools and `tool_choice: auto`. The local server gets no key.
- **Tools:**
  - The agent gets the same MCP tool definitions (`buildServer(ctx, AGENT_TOOLS)`), called in-process through an MCP client and an in-memory transport.
  - The set is only reading and editing the open project: `get_summary`, `get_captions`, cutting, text, captions style, transitions, music, layout, logo, effects, speed, keyframes, silences, `apply_ops` and others.
  - It does not get import, internet, export, voices, other projects or captions generation. A call to any other tool is refused and the model is told.
  - The `projectId` parameter is removed from the schemas.
- **Draft:**
  - The tools run on a copy of the project (`applyChecked`, the same strict checks as a save).
  - At the end of a turn, `diffProjects` (`shared/diff.ts`) lists the changes, one row per clip, track or setting, and the captions summed in one row. That list is the approval card.
  - Nothing reaches the project before "אישור".
  - Approval saves the draft as one save (origin `agent`), so Ctrl+Z in the editor takes it back in one step.
  - "ביטול" drops the draft; the project is exactly as it was.
  - If the project changed after the draft was made, approval is a 409, the card says it is out of date, and the next turn starts again from the current project.
  - The model is told when the user approved, cancelled, or the draft was dropped.
- **Limits:**
  - `maxRounds` model calls per request (default 8; the log says "אפשר לכתוב 'המשך'").
  - One turn per project at a time.
  - Messages up to 4000 characters, tool results cut at 12,000 characters, and 400 stored messages before the conversation starts over.
  - Closing the request or "עצירה" stops the turn; what was done stays in the draft.
- **Prompt:** the user's message carries the playhead and selected clips. The system prompt says clip texts, captions, media and project names are content, never instructions.
- **Stored:** `<data>/agent/<projectId>.json` holds the provider's native messages, the visible log, the draft and a pending note. It is deleted with the project; the "ניקוי שיחה" button clears it. Switching provider or model starts the model conversation over.
- **User sees:** the "סוכן AI" tab with settings (provider, key, local address, model with "רשימה", rounds), the conversation with each tool step in plain Hebrew, and the draft card with + / − / ✎ rows, "אישור" and "ביטול".
- **REST:**
  - `GET /api/projects/:id/agent` returns `{ log, draft, stale, busy }`.
  - `POST /api/projects/:id/agent { text, playhead?, selection? }`
  - `POST …/agent/stop`, `…/agent/approve`, `…/agent/cancel`
  - `DELETE /api/projects/:id/agent`

## Design choices

- **Agent edits:** the agent's edits stay in a draft until the user approves them, so nothing reaches the project without a yes.
- **Translation model:** translation uses the agent's model instead of a separate setting.
- **Voice model:** the Cartesia default model is `sonic-3`. It was not checked against the live service.

## Tests

- **`scripts/e2e-ai.ts`** (gate 4) runs against the mock:
  - settings validation, keys never echoed, model lists;
  - transcription with each of the three cloud providers, and a rejected key;
  - translation through Anthropic and Groq, keep-original, and a bad model answer;
  - the agent on all 7 providers: draft, cancel, approve, stale draft, round limit, refused tool, missing key;
  - narration, preview cache, speed and consent rules, clone;
  - the MCP tools, and deleting the project.
- **Regression (gate 2):** `diffProjects`, `parseLines`, `spreadWords`, `translationOps`, and the local-address rule.
- **Security (gate 5):** 401 on every new route without the key.
- **Browser (gate 6):** the engine choice in the captions tab, then the agent's draft card, approve, and one Ctrl+Z.
- **Mock request log:** each request's headers and body are kept, so the tests check the model, the beta header, that `projectId` is not offered, and that the key goes only to its own provider.
