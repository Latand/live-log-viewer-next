import { NextRequest, NextResponse } from "next/server";

import { claudeLoginSupervisor } from "@/lib/accounts/claudeLogin";
import { rejectCrossOrigin } from "@/lib/sameOrigin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, ctx: { params: Promise<{ operationId: string }> }) {
  const rejected = rejectCrossOrigin(req); if (rejected) return rejected;
  let body: { code?: unknown }; try { body = await req.json() as { code?: unknown }; } catch { return NextResponse.json({ error: "invalid JSON" }, { status: 400 }); }
  if (typeof body.code !== "string") return NextResponse.json({ error: "code must be a string" }, { status: 400 });
  try { const { operationId } = await ctx.params; return NextResponse.json({ login: await claudeLoginSupervisor.input(operationId, body.code) }); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "could not submit login code" }, { status: 409 }); }
}
