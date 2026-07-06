import { NextRequest, NextResponse } from "next/server";

import { rejectCrossOrigin } from "@/lib/sameOrigin";
import {
  isTranscribeBackend,
  transcribeBackendInfo,
  writeTranscribeBackend,
  type TranscribeBackendInfo,
} from "@/lib/transcribeBackend";
import type { ApiError } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Current dictation backend + per-option availability for the mic menu. */
export async function GET(): Promise<NextResponse<TranscribeBackendInfo>> {
  return NextResponse.json(transcribeBackendInfo());
}

/** Persists the mic-menu choice into the override file. */
export async function POST(req: NextRequest): Promise<NextResponse<TranscribeBackendInfo | ApiError>> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;

  let body: { backend?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "некоректний JSON" }, { status: 400 });
  }
  if (!isTranscribeBackend(body.backend)) {
    return NextResponse.json({ error: "backend має бути local, chatgpt або elevenlabs" }, { status: 400 });
  }
  const info = transcribeBackendInfo();
  if (info.lockedByEnv) {
    return NextResponse.json({ error: "вибір заблоковано змінною LLV_TRANSCRIBE_BACKEND" }, { status: 409 });
  }
  try {
    writeTranscribeBackend(body.backend);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
  return NextResponse.json(transcribeBackendInfo());
}
