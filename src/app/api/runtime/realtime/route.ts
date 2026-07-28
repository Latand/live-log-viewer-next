import { NextRequest, NextResponse } from "next/server";

import { voiceTransportOperator } from "@/lib/agent/operatorAuthority";
import { executeRealtimeControl } from "@/lib/runtime/realtimeControl";
import { designatedManagerConversationId, realtimeCallerFromRequest } from "@/lib/runtime/realtimeInjection";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import type { ApiError } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse<Record<string, unknown> | ApiError>> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  /* #691 §6: resolved from the capability the registry issued, never from anything
     in the body — a caller naming itself is not evidence. */
  const result = await executeRealtimeControl(body, undefined, {
    caller: realtimeCallerFromRequest(req, body && typeof body === "object" && !Array.isArray(body)
      ? body as Record<string, unknown>
      : {}),
    managerConversationId: designatedManagerConversationId(),
    /* Opening and closing the call is the operator's own act, and on this loopback
       single-user app the same-origin browser IS the operator (the cross-origin
       rejection above is the perimeter). The only caller refused transport is an
       AGENT, which names itself by presenting its capability — the distinction this
       guard was always about. Designation and every other operator-only action keep
       the stricter possession check. */
    operator: voiceTransportOperator(req),
  });
  return NextResponse.json(result.body, { status: result.status });
}
