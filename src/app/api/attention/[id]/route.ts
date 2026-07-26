import { NextRequest, NextResponse } from "next/server";

import { answerAttentionRequest } from "@/lib/attention/service";
import { readBoundedJson, validateAttentionEvent } from "@/lib/attention/validation";
import { rejectCrossOrigin } from "@/lib/sameOrigin";

import { attentionFailure } from "../failure";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const headers = { "Cache-Control": "no-store" };

/**
 * Answer one request: render it, look at it, agree, refuse, land, go back.
 *
 * A refused transition is a 409 carrying the state the record is actually in,
 * not a 500 — an out-of-order answer is an ordinary race (two devices, a click
 * that arrived after the TTL) and the surface needs to re-render from the truth
 * rather than retry.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const rejection = rejectCrossOrigin(request);
  if (rejection) {
    rejection.headers.set("Cache-Control", "no-store");
    return rejection;
  }
  const { id } = await params;
  try {
    const body = await readBoundedJson(request) as { expectedRevision?: unknown };
    const expectedRevision = typeof body?.expectedRevision === "number" ? body.expectedRevision : undefined;
    const outcome = answerAttentionRequest(id, validateAttentionEvent(body), { expectedRevision });

    if (outcome.ok) return NextResponse.json({ ok: true, request: outcome.request, changed: outcome.changed }, { headers });
    if (outcome.reason === "not-found") {
      return NextResponse.json({ error: "NOT_FOUND", message: "no such attention request" }, { status: 404, headers });
    }
    return NextResponse.json({ error: outcome.reason, state: outcome.state }, { status: 409, headers });
  } catch (error) {
    return attentionFailure(error);
  }
}
