import { NextRequest, NextResponse } from "next/server";

import { requireOperatorAuthority } from "@/lib/agent/operatorAuthority";
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
    /* Opening and closing the call is the operator's own act; an agent presenting its
       capability is refused by the same primitive that guards designation change. */
    operator: requireOperatorAuthority(req).ok,
  });
  return NextResponse.json(result.body, { status: result.status });
}
