# Apollo v2 — GPT-4o + OpenAI TTS (Design)

**Date:** 2026-07-14
**Context:** Non-interactive `claude -p` batch run (`opus-apollo-v2.sh`, `--max-turns 40`).
The detailed task prompt is the approved spec; no interactive brainstorming/approval is
possible, so this doc records the design decisions and the reconciliation of ambiguities.

## Current state (v1, already live)
- `pages/Voice.tsx` — a complete amber-orb Apollo UI (hero orb, status text, `Waveform`,
  transcript with user=sky/Apollo=amber, settings modal, real-time toggle, KITT bar).
  Uses **browser `speechSynthesis`** (the "terrible voices") and calls `/api/apollo/command`.
  **Cut-off bug:** `rec.continuous = false` (line 211) → recognizer ends after the first
  pause and submits, cutting the user off mid-sentence.
- `server/apollo.py` — parse→execute(open/build/search)→reply→persist. Uses
  `inference.generate()` (**DeepSeek**), not OpenAI. No TTS.
- `server/app.py` — handlers return `(status, dict)` JSON tuples via `self._json(*result)`.
  Routes registered in a `ROUTES` list of `(method, compiled_regex, handler)`. `/builds/`
  static serving exists. Apollo routes: `/api/apollo/{command,chat,history}`.
- Env: `OPENAI_API_KEY` present; egress to api.openai.com works (verified 200).

## v2 changes (surgical upgrade — preserve what works)

### Backend — `server/apollo.py`
- Add self-contained OpenAI helpers (urllib, matching `inference.py` style):
  - `_openai_key()` → env-first via `inference._key("OPENAI_API_KEY", "/etc/agent-os/openai-api-key")`.
  - `_openai_chat(system, prompt, max_tokens, temperature)` → POST
    `https://api.openai.com/v1/chat/completions`, model `gpt-4o`; returns str|None.
  - `_apollo_generate(...)` → try `_openai_chat` first, **fall back to `inference.generate`**
    (DeepSeek), preserving the best-effort chain. Replace the `inference.generate(...)`
    calls in `parse_command`, `chat_reply`, `execute_build` with `_apollo_generate`.
  - `synthesize_speech(text, voice) -> data_url|None` → POST
    `https://api.openai.com/v1/audio/speech`, model `tts-1`, mp3 bytes → base64
    `data:audio/mpeg;base64,...`. Validate voice against OpenAI set; default **nova**.
- Persistence (agent_memory + voice_sessions + apollo_commands) unchanged — kept as-is.

### Backend — `server/app.py`
- `h_apollo_tts(req)`: `_require` auth; body `{text, voice?}`; 400 if no text; cap 4096 chars;
  returns `200 {"audio_url": data_url}` or `502 {"error": ...}` when TTS unavailable.
- Register `("POST", r"^/api/apollo/tts$", h_apollo_tts)` beside the other apollo routes.

**Decision — TTS delivery = data URL** (not temp file): handlers return JSON tuples, so a
data URL fits the infra with zero binary-response plumbing and no disk cleanup. Spec allows
"temp file or data URL". mp3 for 1–3 sentences is tens of KB — fine inline.

**Decision — frontend keeps `/api/apollo/command`** (not `/api/apollo/chat`): command is a
superset that preserves open/build/search actions the JARVIS persona advertises. Both
endpoints are upgraded to GPT-4o, so chat replies are GPT-4o either way. Switching to
`/chat` would regress capabilities.

### API client / types
- `lib/api.ts`: `apolloTts({text, voice?}) -> {audio_url}`.
- `lib/types.ts`: extend Apollo `Settings` (frontend-local) as needed.

### Frontend — `pages/Voice.tsx`
1. **Fix cut-off:** `rec.continuous = true`; keep `interimResults = true`. Add a silence
   timer armed/reset on every `onresult`; after **~2.5s** of silence following speech it
   calls `rec.stop()` → existing `onend` submits the accumulated final text. User can pause
   mid-thought without being cut off. Stop only on user action or the silence timeout.
2. **Add `'speaking'` phase:** status "Apollo is speaking…", orb/waveform active, dot pulses.
3. **OpenAI TTS playback:** voice dropdown gains "Apollo (OpenAI · Nova/Alloy)" options
   (encoded as `openai:nova` / `openai:alloy` in `voiceUri`). `speakReply` branches: OpenAI
   path fetches `apolloTts`, plays via an `Audio` ref, shows speaking indicator; on any
   failure falls back to browser synth. Browser path unchanged.
4. **Interruption:** `cancelPlayback()` (pause Audio + `speechSynthesis.cancel()`) runs when
   listening starts / orb tapped / suspend / unmount, so new voice input cancels playback.
5. **Settings modal:** add cosmetic **Wake word** and **Real-time (WebSocket)** toggles, and
   an **Always listen** toggle mapped to the existing realtime/continuous behavior.
6. **Galaxy indicator:** small "Conversations saved to the galaxy" line linking to `/galaxy`.

## Non-goals / YAGNI
- No real-time WebSocket (cosmetic toggle only, per spec).
- No literal mic-amplitude analysis for the waveform (SpeechRecognition owns the mic;
  the existing phase-driven animated bars stay — extended to react during `speaking`).
- No new DB schema; no changes to other agents/pages.

## Verification
- `python3` smoke test of `synthesize_speech` + `_openai_chat` (one small real call each).
- `npm run build` (TypeScript) must pass.
- `systemctl restart agent-os`; curl `/api/apollo/tts` + `/api/apollo/command` with a real
  session token; confirm audio_url + GPT-4o reply. Confirm graceful fallback if key absent.
