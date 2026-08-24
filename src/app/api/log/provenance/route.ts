import { NextRequest, NextResponse } from "next/server";

import { flowRelayedMessageProvenance } from "@/lib/flows/relayProvenance";
import { claudeMessageProvenance, type DeliveredMessageProvenance } from "@/lib/runtime/claudeMessageProvenance";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { pathAllowed } from "@/lib/scanner/roots";
import type { ApiError } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export interface MessageProvenanceResponse {
  /** Delivered-message authorship keyed by the transcript row's engine uuid
      (#1117). Only rows with real delivery evidence appear; the feed keeps
      today's rendering for everything else. */
  messages: Record<string, DeliveredMessageProvenance>;
  /** Flow-relay authorship keyed by the relayed message's own trimmed text —
      the join for deliveries that left no per-row evidence (legacy tmux relays
      on both engines, pre-#1117 structured relays). */
  relayedTexts: Record<string, DeliveredMessageProvenance>;
}

/**
 * Delivery-evidence provenance for one conversation. The `messages` id join is
 * Claude-only (a non-Claude path yields an empty map); the flow-relay text
 * join serves both engines, since a legacy relay's transcript row looks the
 * same on each.
 */
export function GET(req: NextRequest): NextResponse<MessageProvenanceResponse | ApiError> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;
  const path = req.nextUrl.searchParams.get("path") ?? "";
  if (!path || !pathAllowed(path)) {
    return NextResponse.json({ error: "path not allowed" }, { status: 403 });
  }
  return NextResponse.json(
    { messages: claudeMessageProvenance(path), relayedTexts: flowRelayedMessageProvenance(path) },
    { headers: { "Cache-Control": "no-store" } },
  );
}
