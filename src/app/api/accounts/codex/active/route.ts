import { NextRequest, NextResponse } from "next/server";

import { CorruptCodexAccountsError, UnknownAccountError } from "@/lib/accounts/codex";
import { AccountAuthenticationRequiredError, AccountLoginPendingError, accountManager } from "@/lib/accounts/manager";
import { agentRegistry } from "@/lib/agent/registry";
import { rejectCrossOrigin } from "@/lib/sameOrigin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const rejected = rejectCrossOrigin(req);
  if (rejected) return rejected;
  let body: { id?: unknown; mode?: unknown };
  try { body = await req.json() as typeof body; } catch { return NextResponse.json({ error: "invalid JSON" }, { status: 400 }); }
  if (typeof body.id !== "string") return NextResponse.json({ error: "id must be a string" }, { status: 400 });
  if (body.mode !== undefined && body.mode !== "select") return NextResponse.json({ error: "mode must be select" }, { status: 400 });
  try {
    const account = await accountManager.select("codex", body.id);
    return NextResponse.json({ active: account.id, account, revision: agentRegistry().engineRouting("codex").revision });
  } catch (error) {
    if (error instanceof AccountLoginPendingError) return NextResponse.json({ error: error.message, code: "login_pending" }, { status: 409 });
    if (error instanceof AccountAuthenticationRequiredError) return NextResponse.json({ error: error.message, code: "authentication_required" }, { status: 409 });
    const known = error instanceof UnknownAccountError || error instanceof CorruptCodexAccountsError;
    return NextResponse.json({ error: known ? error.message : "Codex account selection failed" }, { status: known ? 400 : 500 });
  }
}
