import { NextRequest, NextResponse } from "next/server";

import { CorruptClaudeAccountsError, UnknownClaudeAccountError } from "@/lib/accounts/claude";
import { accountManager } from "@/lib/accounts/manager";
import { agentRegistry } from "@/lib/agent/registry";
import { rejectCrossOrigin } from "@/lib/sameOrigin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const rejected = rejectCrossOrigin(req); if (rejected) return rejected;
  let body: { id?: unknown; mode?: unknown }; try { body = await req.json() as typeof body; } catch { return NextResponse.json({ error: "invalid JSON" }, { status: 400 }); }
  if (typeof body.id !== "string") return NextResponse.json({ error: "id must be a string" }, { status: 400 });
  if (body.mode !== undefined && body.mode !== "select") return NextResponse.json({ error: "mode must be select" }, { status: 400 });
  try {
    const account = await accountManager.select("claude", body.id);
    return NextResponse.json({ active: account.id, account, revision: agentRegistry().engineRouting("claude").revision });
  }
  catch (error) {
    const known = error instanceof UnknownClaudeAccountError || error instanceof CorruptClaudeAccountsError;
    return NextResponse.json({ error: known ? error.message : "Claude account selection failed" }, { status: known ? 400 : 500 });
  }
}
