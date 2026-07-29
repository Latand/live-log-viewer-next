import { NextRequest, NextResponse } from "next/server";

import { requireOperatorAuthority } from "@/lib/agent/operatorAuthority";
import { executeOrchestratorRotation } from "@/lib/orchestrator/seatCommand";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import type { ApiError } from "@/lib/types";

/* Explicit orchestrator rotation (two-axis contract). Behavior lives in
   `@/lib/orchestrator/seatCommand`; a route module may export only the
   documented route fields. Rotation is NEVER automatic — this route runs only
   when explicitly called, and context pressure elsewhere only recommends. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse<Record<string, unknown> | ApiError>> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;
  const operator = requireOperatorAuthority(req);
  if (!operator.ok) {
    return NextResponse.json({ error: operator.error }, { status: operator.status });
  }
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const result = await executeOrchestratorRotation(body);
  return NextResponse.json(result.body, { status: result.status });
}
