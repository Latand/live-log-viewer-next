import { NextRequest, NextResponse } from "next/server";

import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { readReplySuggestions } from "@/lib/suggestions/store";
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
 * READ ONLY, deliberately. Retiring a set is not a thing a rendered pane does:
 * the operator's message retires it, so the send paths clear the record as
 * part of accepting that message — whether or not any pane was watching.
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
