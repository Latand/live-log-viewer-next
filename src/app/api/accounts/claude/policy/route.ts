import { NextRequest, NextResponse } from "next/server";

import { agentRegistry } from "@/lib/agent/registry";
import { rejectCrossOrigin } from "@/lib/sameOrigin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(req: NextRequest) {
  const rejected = rejectCrossOrigin(req); if (rejected) return rejected;
  let body: { automaticSwitching?: unknown; expectedRevision?: unknown };
  try { body = await req.json() as typeof body; } catch { return NextResponse.json({ error: "invalid JSON" }, { status: 400 }); }
  if (typeof body.automaticSwitching !== "boolean") return NextResponse.json({ error: "automaticSwitching must be a boolean" }, { status: 400 });
  try { return NextResponse.json(agentRegistry().setAutoBalancePolicy("claude", body.automaticSwitching, typeof body.expectedRevision === "number" ? body.expectedRevision : undefined)); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "policy update failed" }, { status: 409 }); }
}
