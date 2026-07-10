import { NextRequest, NextResponse } from "next/server";

import { claudeAccountForSpawn, listClaudeAccounts } from "@/lib/accounts/claude";
import { claudeLoginSupervisor, realClaudeLoginPorts } from "@/lib/accounts/claudeLogin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const account = listClaudeAccounts().find((item) => item.id === id);
  if (!account) return NextResponse.json({ error: "unknown Claude account" }, { status: 404 });
  const fresh = req.nextUrl.searchParams.get("fresh") === "1";
  let auth = { state: account.authPresent ? "authenticated" : "signed_out", method: null as string | null, email: null as string | null, plan: null as string | null, checkedAt: null as string | null };
  if (fresh) {
    try { const status = await realClaudeLoginPorts.status(claudeAccountForSpawn(id).home); auth = { state: status.loggedIn ? "authenticated" : "signed_out", method: status.method, email: status.email, plan: status.plan, checkedAt: new Date().toISOString() }; }
    catch { auth = { ...auth, state: "error" }; }
  }
  return NextResponse.json({ id: account.id, label: account.label, kind: account.kind, auth, limits: { state: "unavailable", session: null, weekly: null, checkedAt: null }, login: claudeLoginSupervisor.forAccount(id) });
}
