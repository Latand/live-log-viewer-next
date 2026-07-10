import { NextRequest, NextResponse } from "next/server";

import { CorruptClaudeAccountsError, InvalidClaudeAccountLabelError, UnknownClaudeAccountError, createManagedClaudeAccount, listClaudeAccounts, removeManagedClaudeAccount } from "@/lib/accounts/claude";
import { claudeLoginSupervisor } from "@/lib/accounts/claudeLogin";
import { rejectCrossOrigin } from "@/lib/sameOrigin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const rejected = rejectCrossOrigin(req); if (rejected) return rejected;
  let body: { label?: unknown; id?: unknown; action?: unknown }; try { body = await req.json() as { label?: unknown; id?: unknown; action?: unknown }; } catch { return NextResponse.json({ error: "invalid JSON" }, { status: 400 }); }
  if (!claudeLoginSupervisor.canStart()) return NextResponse.json({ error: "Claude login is disabled until LLV_ENABLE_CLAUDE_LOGIN=1 and LLV_CLAUDE_LOGIN_POLICY_ACCEPTED=1 are set" }, { status: 503 });
  if (body.action === "retry") {
    if (typeof body.id !== "string") return NextResponse.json({ error: "id must be a string" }, { status: 400 });
    try {
      const account = listClaudeAccounts().find((candidate) => candidate.id === body.id);
      if (!account || account.kind !== "managed") throw new UnknownClaudeAccountError(body.id);
      const login = claudeLoginSupervisor.start(account.id);
      if (login.phase === "failed") return NextResponse.json({ error: "could not start Claude login" }, { status: 503 });
      return NextResponse.json({ account: { id: account.id, label: account.label, kind: account.kind, authPresent: account.authPresent }, login }, { status: 202 });
    } catch (error) {
      const status = error instanceof UnknownClaudeAccountError || error instanceof CorruptClaudeAccountsError ? 400 : 503;
      return NextResponse.json({ error: error instanceof Error ? error.message : "could not retry Claude login" }, { status });
    }
  }
  if (typeof body.label !== "string") return NextResponse.json({ error: "label must be a string" }, { status: 400 });
  let reserved: string | null = null; let accountId: string | null = null;
  try {
    reserved = claudeLoginSupervisor.reserve().operationId;
    const account = createManagedClaudeAccount(body.label);
    accountId = account.id;
    const login = claudeLoginSupervisor.start(account.id, reserved);
    if (login.phase === "failed") {
      removeManagedClaudeAccount(account.id);
      return NextResponse.json({ error: "could not start Claude login" }, { status: 503 });
    }
    return NextResponse.json({ account: { id: account.id, label: account.label, kind: account.kind, authPresent: account.authPresent }, login }, { status: 202 });
  } catch (error) {
    if (accountId) removeManagedClaudeAccount(accountId);
    if (reserved) claudeLoginSupervisor.abandon(reserved);
    const status = error instanceof InvalidClaudeAccountLabelError || error instanceof CorruptClaudeAccountsError ? 400 : 503;
    return NextResponse.json({ error: error instanceof Error ? error.message : "could not create Claude account" }, { status });
  }
}
