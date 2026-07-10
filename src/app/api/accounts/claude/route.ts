import { NextRequest, NextResponse } from "next/server";

import { CorruptClaudeAccountsError, InvalidClaudeAccountLabelError, UnknownClaudeAccountError, createManagedClaudeAccount, listClaudeAccounts, removeManagedClaudeAccount } from "@/lib/accounts/claude";
import { claudeLoginSupervisor } from "@/lib/accounts/claudeLogin";
import { rejectCrossOrigin } from "@/lib/sameOrigin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CLAUDE_LOGIN_TARGET = "claude-auth-login";

function failure(status: number, code: string, message: string) {
  return NextResponse.json({ error: message, code }, { status });
}

function accountResponse(account: { id: string; label: string; kind: "legacy" | "managed"; authPresent: boolean }, login: ReturnType<typeof claudeLoginSupervisor.start>) {
  return NextResponse.json({
    account: { id: account.id, label: account.label, kind: account.kind, authPresent: account.authPresent },
    login,
    target: CLAUDE_LOGIN_TARGET,
  }, { status: 202 });
}

export async function POST(req: NextRequest) {
  const rejected = rejectCrossOrigin(req); if (rejected) return rejected;
  let body: { label?: unknown; id?: unknown; action?: unknown }; try { body = await req.json() as { label?: unknown; id?: unknown; action?: unknown }; } catch { return failure(400, "invalid_json", "Invalid JSON"); }
  if (body.action === "retry") {
    if (typeof body.id !== "string") return failure(400, "invalid_account", "Account id must be a string");
    try {
      const account = listClaudeAccounts().find((candidate) => candidate.id === body.id);
      if (!account || account.kind !== "managed") throw new UnknownClaudeAccountError(body.id);
      const login = claudeLoginSupervisor.start(account.id);
      if (login.phase === "failed") return failure(503, login.result?.code ?? "start_failed", login.result?.message ?? "Claude login could not start");
      return accountResponse(account, login);
    } catch (error) {
      if (error instanceof UnknownClaudeAccountError || error instanceof CorruptClaudeAccountsError) return failure(400, "unknown_account", "Claude account is unavailable");
      if (error instanceof Error && error.message === "a Claude login operation is already running") return failure(409, "login_busy", "A Claude login operation is already running");
      return failure(503, "login_unavailable", "Claude login is temporarily unavailable");
    }
  }
  if (typeof body.label !== "string") return failure(400, "invalid_label", "Account label must be a string");
  let reserved: string | null = null; let accountId: string | null = null;
  try {
    reserved = claudeLoginSupervisor.reserve().operationId;
    const account = createManagedClaudeAccount(body.label);
    accountId = account.id;
    const login = claudeLoginSupervisor.start(account.id, reserved);
    if (login.phase === "failed") {
      removeManagedClaudeAccount(account.id);
      return failure(503, login.result?.code ?? "start_failed", login.result?.message ?? "Claude login could not start");
    }
    return accountResponse(account, login);
  } catch (error) {
    if (accountId) removeManagedClaudeAccount(accountId);
    if (reserved) claudeLoginSupervisor.abandon(reserved);
    if (error instanceof InvalidClaudeAccountLabelError || error instanceof CorruptClaudeAccountsError) return failure(400, "invalid_account", "Claude account could not be created");
    if (error instanceof Error && error.message === "a Claude login operation is already running") return failure(409, "login_busy", "A Claude login operation is already running");
    return failure(503, "login_unavailable", "Claude login is temporarily unavailable");
  }
}
