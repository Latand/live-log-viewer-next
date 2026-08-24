import { NextRequest, NextResponse } from "next/server";

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
}

/**
 * Delivery-ledger provenance for one Claude conversation. Codex needs no
 * endpoint — its authorship rides the structured-user marker in the transcript
 * itself — so a non-Claude path simply answers with an empty map.
 */
export function GET(req: NextRequest): NextResponse<MessageProvenanceResponse | ApiError> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;
  const path = req.nextUrl.searchParams.get("path") ?? "";
  if (!path || !pathAllowed(path)) {
    return NextResponse.json({ error: "path not allowed" }, { status: 403 });
  }
  return NextResponse.json(
    { messages: claudeMessageProvenance(path) },
    { headers: { "Cache-Control": "no-store" } },
  );
}
