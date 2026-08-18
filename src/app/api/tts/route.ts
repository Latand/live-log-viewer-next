import { NextRequest, NextResponse } from "next/server";

import { redactSecrets } from "@/lib/review";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { MAX_TTS_TEXT_LENGTH } from "@/lib/tts";
import { activeTtsOption, readOpenAiApiKey, resolveTtsBackend, ttsBackendInfo, type TtsBackend, type TtsBackendOption } from "@/lib/ttsBackend";
import { readElevenLabsApiKey, readSonioxApiKey } from "@/lib/transcribeBackend";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const OPENAI_SPEECH_URL = "https://api.openai.com/v1/audio/speech";
const SONIOX_SPEECH_URL = "https://tts-rt.soniox.com/tts";
const MAX_AUDIO_BYTES = 32 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 60_000;
const MAX_CONCURRENT_SYNTHESES = 3;
let activeSyntheses = 0;

function admitSynthesis(): (() => void) | null {
  if (activeSyntheses >= MAX_CONCURRENT_SYNTHESES) return null;
  activeSyntheses += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeSyntheses -= 1;
  };
}

function boundedAudioStream(body: ReadableStream<Uint8Array>, release: () => void): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let bytes = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          release();
          controller.close();
          return;
        }
        bytes += result.value.byteLength;
        if (bytes > MAX_AUDIO_BYTES) {
          await reader.cancel("TTS audio exceeded 32 MB");
          release();
          controller.error(new Error("TTS audio exceeded 32 MB"));
          return;
        }
        controller.enqueue(result.value);
      } catch (error) {
        release();
        controller.error(error);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        release();
      }
    },
  });
}

/**
 * The upstream synthesis call per provider.
 *
 * OpenAI and Soniox answer with audio bytes on the response body, so the route
 * streams those straight through (Soniox's realtime socket delivers base64 JSON
 * frames, which the audio-element playback in SpeakButton would have to
 * reassemble anyway). ElevenLabs is asked for `/with-timestamps` instead: the
 * same mp3, base64-encoded inside a JSON envelope that also carries a start and
 * an end second for every character. That alignment is what turns the karaoke
 * follow-along and click-to-seek of issue #1022 from proportional guessing into
 * word-exact positions, so the route passes it through beside the audio.
 */
function synthesisRequest(
  backend: TtsBackend,
  option: TtsBackendOption,
  apiKey: string,
  text: string,
): { url: string; headers: Record<string, string>; body: string; timestamped: boolean } {
  if (backend === "openai") {
    return {
      url: OPENAI_SPEECH_URL,
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: option.model, voice: option.voice, input: text, response_format: "mp3" }),
      timestamped: false,
    };
  }
  if (backend === "soniox") {
    return {
      url: SONIOX_SPEECH_URL,
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: option.model,
        voice: option.voice,
        language: option.language ?? "en",
        audio_format: "mp3",
        text,
      }),
      timestamped: false,
    };
  }
  return {
    url: `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(option.voice)}/with-timestamps`,
    headers: { "xi-api-key": apiKey, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ model_id: option.model, text }),
    timestamped: true,
  };
}

/** Reads a whole upstream body under the same ceiling the audio stream keeps. */
async function readBounded(body: ReadableStream<Uint8Array>, limit: number): Promise<string | null> {
  const reader = body.getReader();
  const parts: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (let result = await reader.read(); !result.done; result = await reader.read()) {
      bytes += result.value.byteLength;
      if (bytes > limit) {
        await reader.cancel("TTS response exceeded the size limit");
        return null;
      }
      parts.push(result.value);
    }
  } catch {
    return null;
  }
  const joined = new Uint8Array(bytes);
  let offset = 0;
  for (const part of parts) { joined.set(part, offset); offset += part.byteLength; }
  return new TextDecoder().decode(joined);
}

/** The character alignment of a `/with-timestamps` payload, or null when absent. */
function alignmentOf(value: unknown): { characters: string[]; starts: number[]; ends: number[] } | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as {
    characters?: unknown;
    character_start_times_seconds?: unknown;
    character_end_times_seconds?: unknown;
  };
  const characters = candidate.characters;
  const starts = candidate.character_start_times_seconds;
  const ends = candidate.character_end_times_seconds;
  if (!Array.isArray(characters) || !Array.isArray(starts) || !Array.isArray(ends)) return null;
  if (characters.length !== starts.length || starts.length !== ends.length || characters.length === 0) return null;
  if (!characters.every((entry) => typeof entry === "string")) return null;
  if (!starts.every((entry) => typeof entry === "number") || !ends.every((entry) => typeof entry === "number")) return null;
  return { characters: characters as string[], starts: starts as number[], ends: ends as number[] };
}

export async function GET(): Promise<NextResponse<{ available: boolean }>> {
  const info = ttsBackendInfo();
  return NextResponse.json({ available: info.options.find((option) => option.id === info.backend)?.available === true });
}

export async function POST(req: NextRequest): Promise<Response> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;

  const backend = resolveTtsBackend();
  const option = activeTtsOption();
  const apiKey =
    backend === "openai" ? readOpenAiApiKey() : backend === "soniox" ? readSonioxApiKey() : readElevenLabsApiKey();
  if (!apiKey) {
    return NextResponse.json({ error: "text-to-speech is unavailable", keyPath: option.keyPath }, { status: 503 });
  }

  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return NextResponse.json({ error: "expected a JSON object" }, { status: 400 });
  }
  const body = parsed as { text?: unknown };
  if (typeof body.text !== "string" || !body.text.trim()) {
    return NextResponse.json({ error: "text must be a non-empty string" }, { status: 400 });
  }
  if (body.text.length > MAX_TTS_TEXT_LENGTH) {
    return NextResponse.json({ error: `text is too long (${MAX_TTS_TEXT_LENGTH} character limit)` }, { status: 413 });
  }
  const text = redactSecrets(body.text.trim());
  const release = admitSynthesis();
  if (!release) return NextResponse.json({ error: "another read-aloud is in progress" }, { status: 429 });

  const request = synthesisRequest(backend, option, apiKey, text);
  let upstream: Response;
  try {
    const signal = AbortSignal.any([req.signal, AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)]);
    upstream = await fetch(request.url, {
      method: "POST",
      headers: request.headers,
      body: request.body,
      signal,
    });
  } catch {
    release();
    if (req.signal.aborted) return new Response(null, { status: 499 });
    return NextResponse.json(
      { error: `${backend} TTS request failed` },
      { status: 502 },
    );
  }

  if (!upstream.ok || !upstream.body) {
    release();
    return NextResponse.json({ error: `${backend} TTS failed (HTTP ${upstream.status})` }, { status: 502 });
  }

  const contentType = upstream.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() ?? "";
  if (request.timestamped) {
    const payload = await readBounded(upstream.body, MAX_AUDIO_BYTES);
    release();
    let envelope: unknown;
    try {
      envelope = payload === null ? null : JSON.parse(payload);
    } catch {
      envelope = null;
    }
    const audio = (envelope as { audio_base64?: unknown } | null)?.audio_base64;
    if (typeof audio !== "string" || !audio) {
      return NextResponse.json({ error: `${backend} TTS returned invalid audio` }, { status: 502 });
    }
    /* `alignment` indexes the text as it was sent, which is the text the client
       chunked — `normalized_alignment` would index the provider's own rewrite. */
    return NextResponse.json(
      {
        audio,
        contentType: "audio/mpeg",
        alignment: alignmentOf((envelope as { alignment?: unknown }).alignment),
      },
      { headers: { "cache-control": "no-store" } },
    );
  }
  if (!contentType.startsWith("audio/")) {
    void upstream.body.cancel();
    release();
    return NextResponse.json({ error: `${backend} TTS returned invalid audio` }, { status: 502 });
  }
  const contentLength = Number(upstream.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_AUDIO_BYTES) {
    void upstream.body.cancel();
    release();
    return NextResponse.json({ error: `${backend} TTS audio is too large` }, { status: 502 });
  }
  const boundedBody = boundedAudioStream(upstream.body, release);

  return new Response(boundedBody, {
    headers: {
      "content-type": contentType,
      "cache-control": "no-store",
    },
  });
}
