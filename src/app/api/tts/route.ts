import { NextRequest, NextResponse } from "next/server";

import { redactSecrets } from "@/lib/review";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { MAX_TTS_TEXT_LENGTH } from "@/lib/tts";
import { activeTtsOption, readOpenAiApiKey, resolveTtsBackend, ttsBackendInfo } from "@/lib/ttsBackend";
import { readElevenLabsApiKey } from "@/lib/transcribeBackend";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const OPENAI_SPEECH_URL = "https://api.openai.com/v1/audio/speech";
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
export async function GET(): Promise<NextResponse<{ available: boolean }>> {
  const info = ttsBackendInfo();
  return NextResponse.json({ available: info.options.find((option) => option.id === info.backend)?.available === true });
}

export async function POST(req: NextRequest): Promise<Response> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;

  const backend = resolveTtsBackend();
  const option = activeTtsOption();
  const apiKey = backend === "openai" ? readOpenAiApiKey() : readElevenLabsApiKey();
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

  let upstream: Response;
  try {
    const signal = AbortSignal.any([req.signal, AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)]);
    const openAi = backend === "openai";
    upstream = await fetch(openAi ? OPENAI_SPEECH_URL : `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(option.voice)}`, {
      method: "POST",
      headers: openAi
        ? { authorization: `Bearer ${apiKey}`, "content-type": "application/json" }
        : { "xi-api-key": apiKey, "content-type": "application/json", accept: "audio/mpeg" },
      body: JSON.stringify(
        openAi
          ? { model: option.model, voice: option.voice, input: text, response_format: "mp3" }
          : { model_id: option.model, text },
      ),
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
