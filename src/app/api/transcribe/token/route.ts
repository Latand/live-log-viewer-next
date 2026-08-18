import { NextRequest, NextResponse } from "next/server";

import { CAP_SECONDS } from "@/lib/dictationTimer";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { readElevenLabsApiKey, readSonioxApiKey, resolveTranscribeBackend } from "@/lib/transcribeBackend";
import type { ApiError } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* Short-lived credential for the browser's realtime STT WebSocket. The client
   asks for one on every dictation start; a non-200 answer just means "no live
   mode here" and the client falls back to record-then-transcribe, so this
   route never needs to be soft about failures. Whichever provider is active,
   the account key stays on this side — only the minted token is handed out. */
const ELEVENLABS_TOKEN_URL = "https://api.elevenlabs.io/v1/single-use-token/realtime_scribe";
const SONIOX_TOKEN_URL = "https://api.soniox.com/v1/auth/temporary-api-key";
/* Long enough that a prewarmed token survives the hover-to-press gap, short
   enough that a leaked one is worthless within minutes. */
const SONIOX_TOKEN_TTL_S = 300;
/* One dictation can run to the recording cap; the margin covers the trailing
   frames after the client's stop. */
const SONIOX_SESSION_CAP_S = CAP_SECONDS + 60;

export interface LiveTokenResponse {
  token: string;
  provider: "elevenlabs" | "soniox";
}

export async function POST(req: NextRequest): Promise<NextResponse<LiveTokenResponse | ApiError>> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;

  const backend = resolveTranscribeBackend();
  if (backend !== "elevenlabs" && backend !== "soniox") {
    return NextResponse.json(
      { error: "live transcription is only available with the elevenlabs or soniox backend" },
      { status: 409 },
    );
  }
  return backend === "soniox" ? sonioxToken() : elevenLabsToken();
}

async function elevenLabsToken(): Promise<NextResponse<LiveTokenResponse | ApiError>> {
  const key = readElevenLabsApiKey();
  if (!key) {
    return NextResponse.json(
      { error: "missing ElevenLabs key (~/.config/agent-log-viewer/elevenlabs-api-key or ELEVENLABS_API_KEY)" },
      { status: 503 },
    );
  }
  try {
    const res = await fetch(ELEVENLABS_TOKEN_URL, {
      method: "POST",
      headers: { "xi-api-key": key },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      return NextResponse.json({ error: `ElevenLabs token: HTTP ${res.status}` }, { status: 502 });
    }
    const json = (await res.json()) as { token?: unknown };
    if (typeof json.token !== "string" || !json.token) {
      return NextResponse.json({ error: "ElevenLabs token: response had no token" }, { status: 502 });
    }
    return NextResponse.json({ token: json.token, provider: "elevenlabs" });
  } catch (error) {
    return NextResponse.json(
      { error: `ElevenLabs token: ${error instanceof Error ? error.message : String(error)}` },
      { status: 502 },
    );
  }
}

/* Soniox's realtime socket authenticates with an api_key in the start request,
   so the browser needs a credential of its own: a temporary key minted here,
   scoped to one transcription stream and expiring in minutes. */
async function sonioxToken(): Promise<NextResponse<LiveTokenResponse | ApiError>> {
  const key = readSonioxApiKey();
  if (!key) {
    return NextResponse.json(
      { error: "missing Soniox key (~/.config/agent-log-viewer/soniox-api-key or SONIOX_API_KEY)" },
      { status: 503 },
    );
  }
  try {
    const res = await fetch(SONIOX_TOKEN_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        usage_type: "transcribe_websocket",
        expires_in_seconds: SONIOX_TOKEN_TTL_S,
        single_use: true,
        max_session_duration_seconds: SONIOX_SESSION_CAP_S,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      return NextResponse.json({ error: `Soniox token: HTTP ${res.status}` }, { status: 502 });
    }
    const json = (await res.json()) as { api_key?: unknown };
    /* Never fall back to the account key: a malformed answer means no live
       mode, and the client quietly records-then-transcribes instead. */
    if (typeof json.api_key !== "string" || !json.api_key || json.api_key === key) {
      return NextResponse.json({ error: "Soniox token: response had no temporary key" }, { status: 502 });
    }
    return NextResponse.json({ token: json.api_key, provider: "soniox" });
  } catch (error) {
    return NextResponse.json(
      { error: `Soniox token: ${error instanceof Error ? error.message : String(error)}` },
      { status: 502 },
    );
  }
}
