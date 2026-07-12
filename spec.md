# Issue 26: TTS read answer aloud

## Task statement

Add OpenAI text-to-speech for assistant answers through `/api/tts`, expose play/stop controls only when an environment API key is available, stream audio, and exclude tool calls and code blocks from spoken text.

## Acceptance criteria

- AC1: OpenAI and ElevenLabs resolve independently through environment and key-file credentials, with environment/file backend selection and server-side voice/model configuration.
- AC2: Every paid synthesis requires confirmation showing provider, model, voice, character count, billing disclosure, and AI-voice disclosure.
- AC3: Assistant prose is Markdown-normalized and secret-redacted; tool calls, code, image payloads, URLs, hidden text, and memory metadata stay outside provider input.
- AC4: Rapid interactions cancel stale synthesis and playback, propagate browser cancellation upstream, and bound provider requests with a timeout.
- AC5: Answers above 4,000 characters require explicit consent to synthesize the first 4,000 characters.
- AC6: Upstream responses require an `audio/*` content type and remain within 32 MB.
- AC7: `bun test` and `bunx tsc --noEmit` pass.
