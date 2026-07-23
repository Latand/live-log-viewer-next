import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";

import {
  parseCanonicalOwnershipClaim,
  type CanonicalOwnershipClaim,
} from "@/lib/runtime/canonicalOwnership";
import { runtimeHostClient } from "@/lib/runtime/client";
import { runtimeEventsEnabled } from "@/lib/runtime/flags";
import { rejectCrossOrigin } from "@/lib/sameOrigin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function ownershipEventKey(claim: CanonicalOwnershipClaim): string {
  const stable = JSON.stringify({
    ...claim,
    assistantItemIds: [...claim.assistantItemIds].sort(),
    launchOutboxIds: [...claim.launchOutboxIds].sort(),
    outboxEntryIds: [...claim.outboxEntryIds].sort(),
  });
  return `canonical-ownership:${createHash("sha256").update(stable).digest("hex")}`;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const rejection = rejectCrossOrigin(request);
  if (rejection) return rejection;
  if (!runtimeEventsEnabled()) {
    return NextResponse.json({ error: "runtime events are disabled" }, { status: 503 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const claim = parseCanonicalOwnershipClaim(body);
  if (!claim) {
    return NextResponse.json({ error: "invalid canonical ownership receipt" }, { status: 400 });
  }
  const client = runtimeHostClient();
  if (!client) {
    return NextResponse.json({ error: "runtime host socket is unavailable" }, { status: 503 });
  }
  try {
    await client.append({
      scope: { type: "session", id: claim.conversationId },
      kind: "canonical-ownership",
      producer: {
        kind: "viewer-canonical-ownership",
        eventKey: ownershipEventKey(claim),
      },
      payload: claim as unknown as Record<string, unknown>,
    });
    return NextResponse.json({ accepted: true }, { status: 202 });
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : "runtime host is unavailable",
    }, { status: 503 });
  }
}
