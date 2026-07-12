import { NextRequest, NextResponse } from "next/server";

import { rejectCrossOrigin } from "@/lib/sameOrigin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const OPENAI_SPEECH_URL = "https://api.openai.com/v1/audio/speech";
const MAX_TEXT_LENGTH = 4096;

export async function GET(): Promise<NextResponse<{ available: boolean }>> {
  return NextResponse.json({ available: Boolean(process.env.OPENAI_API_KEY?.trim()) });
}

export async function POST(req: NextRequest): Promise<Response> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;

  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    return NextResponse.json({ error: "text-to-speech is unavailable" }, { status: 501 });
  }

  let body: { text?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (typeof body.text !== "string" || !body.text.trim()) {
    return NextResponse.json({ error: "text must be a non-empty string" }, { status: 400 });
  }
  if (body.text.length > MAX_TEXT_LENGTH) {
    return NextResponse.json({ error: `text is too long (${MAX_TEXT_LENGTH} character limit)` }, { status: 413 });
  }

  let upstream: Response;
  try {
    upstream = await fetch(OPENAI_SPEECH_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o-mini-tts", voice: "cedar", input: body.text, response_format: "mp3" }),
    });
  } catch (error) {
    return NextResponse.json(
      { error: `OpenAI TTS: ${error instanceof Error ? error.message : String(error)}` },
      { status: 502 },
    );
  }

  if (!upstream.ok || !upstream.body) {
    return NextResponse.json({ error: `OpenAI TTS: HTTP ${upstream.status}` }, { status: 502 });
  }

  return new Response(upstream.body, {
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "audio/mpeg",
      "cache-control": "no-store",
    },
  });
}
