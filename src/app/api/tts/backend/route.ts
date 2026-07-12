import { NextRequest, NextResponse } from "next/server";

import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { isTtsBackend, ttsBackendInfo, writeTtsBackend, type TtsBackendInfo } from "@/lib/ttsBackend";
import type { ApiError } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse<TtsBackendInfo>> {
  return NextResponse.json(ttsBackendInfo());
}

export async function POST(req: NextRequest): Promise<NextResponse<TtsBackendInfo | ApiError>> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;
  let body: { backend?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (!isTtsBackend(body.backend)) return NextResponse.json({ error: "backend must be openai or elevenlabs" }, { status: 400 });
  if (ttsBackendInfo().lockedByEnv) return NextResponse.json({ error: "selection is locked by LLV_TTS_BACKEND" }, { status: 409 });
  writeTtsBackend(body.backend);
  return NextResponse.json(ttsBackendInfo());
}
