# Dictation / voice input

Agent Log Viewer can turn speech into text in any composer, so you can dictate a
message to an agent instead of typing it. Transcription runs through a pluggable
backend: the default keeps everything on your machine, and two cloud providers
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
- **Live path** (ElevenLabs backend only): the transcript streams in while you
  speak. Each phrase the voice-activity detector finalises is appended to the
  draft right away, and the not-yet-final tail is overlaid on the input so you
  see words appear as you say them. Stopping is instant because there is
  nothing left to wait for.

While recording, pressing **Enter** (or clicking send) does "stop and send":
it stops the recording, waits for the final transcript, and sends the message
in one step. The `X` button discards the recording without transcribing it.

Very short recordings (a sub-2 KB blob, i.e. an accidental tap) are dropped
without contacting the server. Uploaded audio is capped at 16 MB.

## Choosing a backend

The backend is resolved on the server for every transcription request, in this
order:

1. **Environment variable `LLV_TRANSCRIBE_BACKEND`** — accepts `local`,
   `chatgpt`, or `elevenlabs` (case-insensitive). If set to a valid value, it
   wins.
2. **Override file `~/.config/agent-log-viewer/transcribe-backend`** — accepts
   `chatgpt` or `elevenlabs` (case-insensitive). Use this to switch to a cloud
   backend without setting an env var. A value of `local` in this file is not
   needed — local is already the default. Create the file with just the backend
   name as its contents, e.g. `echo elevenlabs > ~/.config/agent-log-viewer/transcribe-backend`.
3. **Default: `local`.**

> **Legacy paths:** the config and cache directories moved from `live-log-viewer`
> to `agent-log-viewer` (matching the package name). Files still under the old
> `~/.config/live-log-viewer/…` and `~/.cache/live-log-viewer/…` locations remain
> valid fallbacks when no `agent-log-viewer` copy exists. Updates keep using a
> resolved legacy config or cache file, so existing setups continue unchanged.

The cloud backends stay off the UI on purpose. There is no in-app toggle to
enable ChatGPT or ElevenLabs transcription; each one turns on only when you set
the environment variable or write the override file on that specific machine.
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

The only backend with live, streaming transcription. Recording a long draft
shows words appearing as you speak; short drafts still work as one-shot batch.

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
| "live transcription is only available with the elevenlabs backend" | Live token requested while another backend is active. | Expected — the client falls back to batch automatically.            |

Cloud backends surface upstream HTTP errors verbatim (for example
`ElevenLabs STT: HTTP 401 …` or `transcription backend: HTTP 5xx`), which usually
point to an invalid key, an expired token, or a quota limit.
