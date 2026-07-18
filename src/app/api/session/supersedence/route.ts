import { NextRequest, NextResponse } from "next/server";

import { agentRegistry } from "@/lib/agent/registry";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import type { ApiError } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface SupersedenceBody {
  conversationId?: unknown;
  action?: unknown;
}

type SupersedenceResponse = { ok: true; conversationId: string } | ApiError;

/** Explicit operator fork of a superseded round (issue #383 invariant 5):
    "resume here" clears the durable predecessor edge, so the card leaves the
    superseded surface and the ordinary dead/resume recovery takes over. The
    edge is the ONLY thing removed — transcripts, receipts, memberships, and
    the successor conversation all stay untouched. */
export async function POST(req: NextRequest): Promise<NextResponse<SupersedenceResponse>> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;

  let body: SupersedenceBody;
  try {
    body = (await req.json()) as SupersedenceBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (body.action !== "clear") {
    return NextResponse.json({ error: "action must be \"clear\"" }, { status: 400 });
  }
  if (typeof body.conversationId !== "string" || !body.conversationId.startsWith("conversation_")) {
    return NextResponse.json({ error: "conversationId is required" }, { status: 400 });
  }
  try {
    const cleared = agentRegistry().clearSupersedence(body.conversationId as `conversation_${string}`);
    if (!cleared) return NextResponse.json({ error: "conversation is unknown" }, { status: 404 });
    return NextResponse.json({ ok: true, conversationId: cleared.id });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
