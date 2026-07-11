import { NextRequest, NextResponse } from "next/server";

import { CorruptClaudeAccountsError, InvalidClaudeAccountLabelError, UnknownClaudeAccountError, UnsafeClaudeHomeError, cleanupOrphanedClaudeHomes, claudeAccountsMutationLocked, createManagedClaudeAccount, listClaudeAccounts, removeManagedClaudeAccount } from "@/lib/accounts/claude";
import { claudeLoginSupervisor } from "@/lib/accounts/claudeLogin";
import { accountRemovalBlockers } from "@/lib/accounts/removal";
import { requestAccountMigrationTick } from "@/lib/accounts/migration/controllerSignal";
import { agentRegistry } from "@/lib/agent/registry";
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

const LIVE_CLAUDE_LOGIN_PHASES = new Set(["starting", "awaiting_browser", "awaiting_code", "verifying", "canceling"]);

export async function DELETE(req: NextRequest) {
  const rejected = rejectCrossOrigin(req); if (rejected) return rejected;
  let body: { id?: unknown; force?: unknown; cleanupOrphans?: unknown };
  try { body = await req.json() as { id?: unknown; force?: unknown; cleanupOrphans?: unknown }; } catch { return failure(400, "invalid_json", "Invalid JSON"); }
  if (body.cleanupOrphans === true) {
    if (body.id !== undefined) return failure(400, "invalid_request", "Cleanup accepts no account id");
    try { return NextResponse.json(cleanupOrphanedClaudeHomes()); }
    catch (error) {
      if (error instanceof CorruptClaudeAccountsError) return failure(409, "accounts_locked", "Claude accounts require registry repair");
      return failure(500, "cleanup_failed", "Claude orphan cleanup failed");
    }
  }
  if (typeof body.id !== "string" || typeof body.force !== "undefined" && typeof body.force !== "boolean") {
    return failure(400, "invalid_request", "Account id and force flag are invalid");
  }
  if (claudeAccountsMutationLocked()) return failure(409, "accounts_locked", "Claude accounts require registry repair");
  const account = listClaudeAccounts().find((candidate) => candidate.id === body.id);
  if (!account || account.kind !== "managed") return failure(404, "unknown_account", "Claude account is unavailable");
  const login = claudeLoginSupervisor.forAccount(account.id);
  const blockers = [
    ...accountRemovalBlockers("claude", account.id),
    ...(login && LIVE_CLAUDE_LOGIN_PHASES.has(login.phase) ? ["login_pending"] : []),
  ];
  if (blockers.includes("current_conversations") || blockers.length && body.force !== true) {
    return NextResponse.json({ error: "Claude account has active sessions, conversations, or sign-in", code: "account_removal_blocked", blockers }, { status: 409 });
  }
  const registry = agentRegistry();
  const beforeRetirement = registry.snapshot();
  try {
    if (login && LIVE_CLAUDE_LOGIN_PHASES.has(login.phase)) await claudeLoginSupervisor.cancel(login.operationId);
    registry.retireAccount("claude", account.id, "default");
    const retired = registry.snapshot();
    try {
      const removal = removeManagedClaudeAccount(account.id);
      requestAccountMigrationTick();
      return NextResponse.json({ removed: { id: account.id }, cleanupPending: removal.cleanupPending });
    } catch (error) {
      registry.restoreSnapshot(retired, beforeRetirement);
      throw error;
    }
  } catch (error) {
    if (error instanceof UnknownClaudeAccountError) return failure(404, "unknown_account", "Claude account is unavailable");
    if (error instanceof CorruptClaudeAccountsError) return failure(409, "accounts_locked", "Claude accounts require registry repair");
    if (error instanceof UnsafeClaudeHomeError) return failure(409, "unsafe_home", "Claude account home failed safety checks");
    return failure(500, "removal_failed", "Claude account could not be removed");
  }
}
