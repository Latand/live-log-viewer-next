# Dictation / voice input

Agent Log Viewer can turn speech into text in any composer, so you can dictate a
message to an agent instead of typing it. Transcription runs through a pluggable
backend: the default keeps everything on your machine, and three cloud providers
are available as an explicit per-machine opt-in.

## What it does in the UI

A microphone button sits next to the send button in the composers that talk to
agents — the tmux composer (`TmuxComposer`) and the draft-agent pane
(`DraftAgentPane`). The control has three states:

- **idle** — a mic icon. Click it to start recording (the browser asks for
  microphone permission the first time).
- **rec** — a live input-level meter and an elapsed timer, plus an `X` to
  cancel. Recording stops automatically after 2 minutes.
- **busy** — a spinner shown while a finished recording is being transcribed
  (only in the record-then-transcribe path; see below).

How the recognised text reaches the draft depends on the active backend:

- **Batch path** (local and ChatGPT backends): you record, then click the mic
  again (or press Enter) to stop. The audio is uploaded, transcribed, and the
  resulting text is inserted into the draft. The button shows the "busy"
  spinner while the server works.
- **Live path** (ElevenLabs and Soniox backends): the transcript streams in
  while you speak. Each phrase the provider finalises — an ElevenLabs
  voice-activity commit, a Soniox endpoint — is appended to the draft right
  away, and the not-yet-final tail is overlaid on the input so you see words
  appear as you say them. Stopping is instant because there is nothing left to
  wait for.

While recording, pressing **Enter** (or clicking send) does "stop and send":
it stops the recording, waits for the final transcript, and sends the message
in one step. The `X` button discards the recording without transcribing it.

Very short recordings (a sub-2 KB blob, i.e. an accidental tap) are dropped
without contacting the server. Uploaded audio is capped at 16 MB.

## Choosing a backend

The backend is resolved on the server for every transcription request, in this
order:

1. **Environment variable `LLV_TRANSCRIBE_BACKEND`** — accepts `local`,
   `chatgpt`, `elevenlabs`, or `soniox` (case-insensitive). If set to a valid
   value, it wins.
2. **Override file `~/.config/agent-log-viewer/transcribe-backend`** — accepts
   `chatgpt`, `elevenlabs`, or `soniox` (case-insensitive). Use this to switch
   to a cloud backend without setting an env var. A value of `local` in this file is not
   needed — local is already the default. Create the file with just the backend
   name as its contents, e.g. `echo elevenlabs > ~/.config/agent-log-viewer/transcribe-backend`.
3. **Default: `local`.**

> **Legacy paths:** the config and cache directories moved from `live-log-viewer`
> to `agent-log-viewer` (matching the package name). Files still under the old
> `~/.config/live-log-viewer/…` and `~/.cache/live-log-viewer/…` locations remain
> valid fallbacks when no `agent-log-viewer` copy exists. Updates keep using a
> resolved legacy config or cache file, so existing setups continue unchanged.

The cloud backends stay off the UI on purpose. There is no in-app toggle to
enable ChatGPT, ElevenLabs, or Soniox transcription; each one turns on only when
you set the environment variable or write the override file on that specific
machine.
This keeps the on-by-default behaviour fully local and makes any audio leaving
the machine a deliberate, per-machine choice.

Backend selection is read at request time, so switching the override file takes
effect on the next dictation without restarting the server.

## Providers

### Local (default) — faster-whisper

Everything runs on your machine and no audio leaves it.

**Requirements:** Python 3 and a one-time setup that creates a virtualenv with
[`faster-whisper`](https://github.com/SYSTRAN/faster-whisper) and pre-downloads
the model.

**Setup:**

```bash
scripts/setup-whisper.sh
```

This creates the venv at `~/.cache/agent-log-viewer/whisper-venv`, installs
`faster-whisper`, and downloads the model so the first dictation is not the slow
one. The model is fetched on first load if you skip this step, but the first
recording then blocks while the download runs.

**Defaults and overrides** (all optional environment variables):

| Variable            | Default                                    | Meaning                                        |
| ------------------- | ------------------------------------------ | ---------------------------------------------- |
| `LLV_WHISPER_VENV`  | `~/.cache/agent-log-viewer/whisper-venv`   | Virtualenv the transcription runs from.        |
| `LLV_WHISPER_MODEL` | `small`                                    | Whisper model size (e.g. `tiny`, `base`, `small`, `medium`, `large-v3`). |
| `LLV_WHISPER_DEVICE`| `cpu`                                      | `cpu` (int8) or `cuda` (int8_float16) if you have a working CUDA setup. |

The route shells out to `scripts/whisper_transcribe.py` inside that venv; the
language is auto-detected. A per-request timeout of 120 seconds applies.

**Privacy:** audio and transcripts never leave the machine.

### ChatGPT — Codex account transcription

Reuses the ChatGPT credentials of the locally logged-in Codex CLI/Desktop to
call the same transcription endpoint the Codex Desktop composer uses. This is
a record-then-transcribe (batch) path; it has no live-streaming mode.

**Requirements:** a logged-in Codex CLI or Codex Desktop on the same machine.
The credentials are read from `~/.codex/auth.json` (`tokens.access_token` and
`tokens.account_id`). The token stays on the server and is never sent to the
browser.

**Setup:**

1. Log in with Codex so `~/.codex/auth.json` exists.
2. Enable the backend:

   ```bash
   echo chatgpt > ~/.config/agent-log-viewer/transcribe-backend
   # or: LLV_TRANSCRIBE_BACKEND=chatgpt
   ```

The upstream request goes to `https://chatgpt.com/backend-api/transcribe`. It is
sent via `curl` (Cloudflare fingerprints the TLS client and rejects Node's fetch
with a 403, while curl passes); the token is passed through a stdin config file
and never appears on the command line.

**Privacy:** audio is uploaded to ChatGPT's backend under your ChatGPT account.

### ElevenLabs — Scribe

One of the two backends with live, streaming transcription. Recording a long
draft shows words appearing as you speak; short drafts still work as one-shot
batch.

**Requirements:** an ElevenLabs API key.

**Key location** (read at request time, env first):

1. Environment variable `ELEVENLABS_API_KEY`, or
2. File `~/.config/agent-log-viewer/elevenlabs-api-key` (the key as the file's
   only contents).

**Setup:**

```bash
echo 'YOUR_ELEVENLABS_KEY' > ~/.config/agent-log-viewer/elevenlabs-api-key
echo elevenlabs > ~/.config/agent-log-viewer/transcribe-backend
```

How it works:

- **Live streaming:** on each dictation start the client asks the server for a
  single-use token (`https://api.elevenlabs.io/v1/single-use-token/realtime_scribe`).
  With a token, the browser opens a WebSocket to
  `wss://api.elevenlabs.io/v1/speech-to-text/realtime` (model `scribe_v2_realtime`),
  streams 16 kHz PCM, and receives transcripts segment-by-segment as the
  voice-activity detector commits them.
- **Batch fallback:** if no token is available, the recording is posted to
  `https://api.elevenlabs.io/v1/speech-to-text` (model `scribe_v1`, overridable
  with `LLV_ELEVENLABS_STT_MODEL`).

Your API key stays on the server for batch requests; for live mode the server
mints a short-lived single-use token and only that token reaches the browser.

**Privacy:** audio is streamed/uploaded to ElevenLabs.

### Soniox

The other live, streaming backend. Soniox streams sub-word tokens as you speak,
so the tail of a sentence keeps rewriting itself in the input until the provider
marks the utterance finished.

**Requirements:** a Soniox API key.

**Key location** (read at request time, env first):

1. Environment variable `SONIOX_API_KEY`, or
2. File `~/.config/agent-log-viewer/soniox-api-key` (the key as the file's only
   contents).

**Setup:**

```bash
echo 'YOUR_SONIOX_KEY' > ~/.config/agent-log-viewer/soniox-api-key
echo soniox > ~/.config/agent-log-viewer/transcribe-backend
```

How it works:

- **Live streaming:** on each dictation start the client asks the server for a
  credential, and the server mints a *temporary API key*
  (`https://api.soniox.com/v1/auth/temporary-api-key`, `usage_type:
  transcribe_websocket`, single-use, minutes-long expiry). The browser opens a
  WebSocket to `wss://stt-rt.soniox.com/transcribe-websocket`, sends one JSON
  start request (model `stt-rt-v5`, `audio_format: pcm_s16le`, the context's
  sample rate, endpoint detection on) carrying that temporary key, then streams
  raw PCM as binary frames. Answers arrive as `tokens[]` with `is_final`; the
  final tokens of an utterance are followed by an `<end>` token, which is where
  a segment is committed to the draft. An empty frame ends the stream.
- **Batch fallback:** if no temporary key is available, the recording goes
  through the async REST API — upload to `https://api.soniox.com/v1/files`,
  create a transcription (model `stt-async-v5`, overridable with
  `LLV_SONIOX_STT_MODEL`), poll until it completes, read the transcript. Both
  the uploaded file and the transcription are deleted afterwards.

Your API key stays on the server: batch requests are made server-side, and live
mode hands the browser only the temporary key, never the account key.

**Privacy:** audio is streamed/uploaded to Soniox.

## Read-aloud (text-to-speech)

The speaker button on an assistant answer reads it out. Its provider is chosen
the same way, one selector over:

1. **Environment variable `LLV_TTS_BACKEND`** — accepts `openai`, `elevenlabs`,
   or `soniox`. When set it wins and locks the in-app picker.
2. **Override file `~/.config/agent-log-viewer/tts-backend`**, written by that
   picker or by hand.
3. **Default: `openai`.**

Each provider reads the key file it already uses for transcription, so a Soniox
key set up above needs nothing more:

```bash
echo 'YOUR_SONIOX_KEY' > ~/.config/agent-log-viewer/soniox-api-key
echo soniox > ~/.config/agent-log-viewer/tts-backend
```

The server posts the answer text to `https://tts-rt.soniox.com/tts` (model
`tts-rt-v2`, voice `Adrian`, language `en`, mp3) and streams the audio straight
back to the browser; the key never leaves the server. Model, voice and language
follow the same per-provider override pattern as the other backends —
`LLV_TTS_SONIOX_MODEL` / `LLV_TTS_SONIOX_VOICE` / `LLV_TTS_SONIOX_LANGUAGE`, or
the files `tts-model-soniox`, `tts-voice-soniox`, `tts-language-soniox`. The
language is the language of the text being read; Soniox requires it on every
request, so set it if your agents answer in something other than English.

Without a readable key the button reports text-to-speech as unavailable and
names the file to drop the key into — the same degradation as the other
providers.

### Long answers, replay, and following along

A long answer is split client-side into chunks of roughly 400–800 characters on
paragraph and sentence boundaries (code blocks and URLs stay whole, and a word
is never cut). Two chunks are synthesized at a time — the route admits three
syntheses at once, so a slot is left for another card — and playback starts as
soon as the FIRST chunk is ready, while the rest are still being made. Chunks
play back to back on two alternating audio elements, so the joins are inaudible.

A message under ~800 characters is one chunk, exactly as before. Nothing is ever
truncated: the old "speak the first 4,000 characters" slice is gone, and a
message past the 20,000-character ceiling is refused out loud in the confirm
dialog instead of being quietly cut.

Chunks are cached per provider/model/voice/chunk text, so:

- **Replay** — after an answer has been voiced the speaker button becomes a
  replay control. It replays from the cache at no cost; anything the cache has
  evicted is re-synthesized transparently.
- **Karaoke** — while a message is being read, the word being spoken is
  highlighted in the rendered answer. The highlight uses the CSS Custom
  Highlight API over the markdown already on screen: nothing is re-parsed or
  rewritten, and selecting text still works. With ElevenLabs the position is
  word-exact (the route asks its `/with-timestamps` endpoint, which returns a
  start and end second per character, and passes that alignment through beside
  the audio). OpenAI returns no timestamps and Soniox's REST `/tts` returns raw
  audio only — their character timestamps are WebSocket-only — so for both the
  position is interpolated inside the chunk and snapped to word boundaries.
- **Click-to-seek** — while an answer is playing, clicking anywhere in its text
  jumps the audio there: exactly with an alignment, proportionally without one.
  Clicking in a part that has not been synthesized yet queues that chunk next
  and starts from it. Selecting text, or clicking a link or a copy chip inside
  the message, never seeks.

Stop still halts the whole sequence, and only one answer plays at a time across
the whole board.

## Troubleshooting

| Symptom (message in the UI)                              | Cause                                                            | Fix                                                                 |
| -------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------- |
| "no microphone access"                                   | Browser denied microphone permission.                           | Grant mic permission for the site and retry.                        |
| "server unavailable"                                     | The `/api/transcribe` request failed to reach the server.       | Check the app is running and reachable.                             |
| "silence — nothing recognized"                           | Recording contained no recognisable speech.                     | Speak up / check the mic; the input-level meter should move.        |
| "audio too large (16 MB limit)"                          | Upload exceeded the 16 MB cap.                                  | Record a shorter clip (the 2-minute auto-stop normally prevents this). |
| Error mentioning `scripts/setup-whisper.sh`              | Local backend selected but the whisper venv/Python is missing.  | Run `scripts/setup-whisper.sh`.                                     |
| "faster-whisper missing…"                                | The venv exists but `faster-whisper` is not installed in it.    | Re-run `scripts/setup-whisper.sh`.                                  |
| "no Codex ChatGPT token (~/.codex/auth.json)…"           | ChatGPT backend selected but no Codex login found.              | Log in with Codex, then retry.                                      |
| "ChatGPT token expired…"                                 | The stored Codex token is stale.                                | Open Codex so it refreshes the token, then retry.                   |
| "no ElevenLabs key…"                                     | ElevenLabs backend selected but no key found.                   | Set `ELEVENLABS_API_KEY` or write the key file (see above).         |
| "missing Soniox key…"                                    | Soniox backend selected but no key found.                       | Set `SONIOX_API_KEY` or write the key file (see above).             |
| "Soniox token: HTTP 401"                                 | The key was rejected when minting the temporary key.            | Check the key; live mode stays off and dictation falls back to batch. |
| "live transcription is only available with the elevenlabs or soniox backend" | Live token requested while another backend is active. | Expected — the client falls back to batch automatically.            |

Cloud backends surface upstream HTTP errors verbatim (for example
`ElevenLabs STT: HTTP 401 …`, `Soniox STT: upload: HTTP 402 …`, or
`transcription backend: HTTP 5xx`), which usually point to an invalid key, an
expired token, or a quota limit.
