import { NextRequest, NextResponse } from "next/server";

import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { clearReplySuggestions, readReplySuggestions } from "@/lib/suggestions/store";
import type { ReplySuggestionSetV1 } from "@/lib/suggestions/types";
import type { ApiError } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The conversation's current reply-draft set (#1202) — the read side of the
 * record `suggest_replies` writes.
 *
 * It sits beside the feed's other per-conversation evidence read
 * (`/api/log/provenance`) and is used the same way: the surfaces that render a
 * conversation already stream its transcript, and a set is fetched when that
 * stream says something changed. No new bus, no timer of its own.
 *
 * DELETE is what the operator's own message does to a set: once they have
 * answered, the drafts are stale, so the surface that sent the message clears
 * them rather than leaving a dead row under a question that is over.
 */
export function GET(req: NextRequest): NextResponse<{ set: ReplySuggestionSetV1 | null } | ApiError> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;
  const conversationId = req.nextUrl.searchParams.get("conversationId") ?? "";
  if (!conversationId) return NextResponse.json({ error: "conversationId is required" }, { status: 400 });
  return NextResponse.json(
    { set: readReplySuggestions(conversationId) },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export function DELETE(req: NextRequest): NextResponse<{ cleared: boolean } | ApiError> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;
  const conversationId = req.nextUrl.searchParams.get("conversationId") ?? "";
  if (!conversationId) return NextResponse.json({ error: "conversationId is required" }, { status: 400 });
  return NextResponse.json({ cleared: clearReplySuggestions(conversationId) });
}
