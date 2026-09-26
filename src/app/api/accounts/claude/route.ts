import { NextRequest, NextResponse } from "next/server";

import { CorruptClaudeAccountsError, InvalidClaudeAccountLabelError, UnknownClaudeAccountError, UnsafeClaudeHomeError, cleanupOrphanedClaudeHomes, claudeAccountsMutationLocked, createManagedClaudeAccount, listClaudeAccounts, listClaudeProviderModels, readClaudeProviderToken, removeManagedClaudeAccount, updateProviderClaudeAccount, validateProviderConfig, type ClaudeProviderConfig } from "@/lib/accounts/claude";
import { claudeLoginSupervisor, LIVE_CLAUDE_LOGIN_PHASES } from "@/lib/accounts/claudeLogin";
import { AccountArchiveUnavailableError, AccountHistoryInventoryBlockedError, AccountRemovalBlockedError, accountRemovalBlockers, removalErrno, removalResponse } from "@/lib/accounts/removal";
import { requestAccountMigrationTick } from "@/lib/accounts/migration/controllerSignal";
import { withAccountMutationLockAsync } from "@/lib/accounts/accountMutation";
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

function providerInput(value: unknown): { config: ClaudeProviderConfig; token?: string } {
  if (!value || typeof value !== "object") throw new Error("Invalid provider configuration");
  const input = value as Record<string, unknown>;
  const config = validateProviderConfig({
    baseUrl: input.baseUrl as string,
    model: input.model as string,
    smallFastModel: input.smallFastModel === undefined || input.smallFastModel === "" ? null : input.smallFastModel as string,
  });
  if (input.token !== undefined && (typeof input.token !== "string" || !input.token || input.token.length > 4096 || /[\r\n\u0000]/.test(input.token))) throw new Error("Invalid provider token");
  return { config, token: input.token as string | undefined };
}

export async function PATCH(req: NextRequest) {
  const rejected = rejectCrossOrigin(req); if (rejected) return rejected;
  let body: { id?: unknown; label?: unknown; provider?: unknown };
  try { body = await req.json(); } catch { return failure(400, "invalid_json", "Invalid JSON"); }
  if (typeof body.id !== "string") return failure(400, "invalid_account", "Invalid account");
  try {
    const input = providerInput(body.provider);
    const account = updateProviderClaudeAccount(body.id, input.config, input.token, body.label === undefined ? undefined : body.label as string);
    return NextResponse.json({ account: { id: account.id, label: account.label, provider: account.provider, authPresent: account.authPresent } });
  } catch (error) {
    if (error instanceof UnknownClaudeAccountError) return failure(404, "unknown_account", "Provider account is unavailable");
    if (error instanceof CorruptClaudeAccountsError || error instanceof UnsafeClaudeHomeError) return failure(409, "accounts_locked", "Provider account requires repair");
    return failure(400, "invalid_provider", "Invalid provider configuration");
  }
}

export async function POST(req: NextRequest) {
  const rejected = rejectCrossOrigin(req); if (rejected) return rejected;
  let body: { label?: unknown; id?: unknown; action?: unknown; provider?: unknown }; try { body = await req.json() as typeof body; } catch { return failure(400, "invalid_json", "Invalid JSON"); }
  if (body.action === "provider-models") {
    try {
      const input = providerInput(body.provider);
      const saved = typeof body.id === "string" ? listClaudeAccounts().find((account) => account.id === body.id && account.provider) : null;
      const token = input.token ?? (saved ? readClaudeProviderToken(saved.home) : null);
      if (!token) return failure(400, "invalid_provider", "Provider token is required");
      return NextResponse.json({ models: await listClaudeProviderModels(input.config, token) });
    } catch (error) { return failure(502, "provider_models_unavailable", error instanceof Error && error.message === "Provider authentication failed" ? "Provider authentication failed" : "Provider model list unavailable"); }
  }
  if (body.provider !== undefined) {
    if (typeof body.label !== "string") return failure(400, "invalid_label", "Account label must be a string");
    try {
      const input = providerInput(body.provider);
      if (!input.token) return failure(400, "invalid_provider", "Provider token is required");
      const models = await listClaudeProviderModels(input.config, input.token);
      const account = createManagedClaudeAccount(body.label, { config: input.config, token: input.token });
      return NextResponse.json({ account: { id: account.id, label: account.label, kind: account.kind, authPresent: account.authPresent, provider: account.provider }, models }, { status: 201 });
    } catch (error) {
      if (error instanceof InvalidClaudeAccountLabelError) return failure(400, "invalid_label", "Invalid account label");
      if (error instanceof CorruptClaudeAccountsError) return failure(409, "accounts_locked", "Claude accounts require registry repair");
      if (error instanceof Error && error.message === "Provider authentication failed") return failure(401, "provider_auth_failed", "Provider authentication failed");
      return failure(400, "invalid_provider", "Provider configuration or model list is unavailable");
    }
  }
  try {
    return await withAccountMutationLockAsync(async () => {
      if (body.action === "retry") {
        if (typeof body.id !== "string") return failure(400, "invalid_account", "Account id must be a string");
        try {
          // Legacy Main and managed accounts alike can reauthenticate in place;
          // the supervisor fences the login to that account's safe home.
          const account = listClaudeAccounts().find((candidate) => candidate.id === body.id);
          if (!account) throw new UnknownClaudeAccountError(body.id);
          if (account.provider) return failure(409, "provider_account", "Edit the provider token in Accounts");
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
        let caught: unknown = error;
        if (accountId) {
          try { removeManagedClaudeAccount(accountId); }
          catch (cleanupError) { caught = cleanupError; }
        }
        if (reserved) claudeLoginSupervisor.abandon(reserved);
        if (caught instanceof AccountHistoryInventoryBlockedError) {
          return NextResponse.json({ error: "Claude account history inventory blocked cleanup", code: "account_removal_blocked", blockers: ["filesystem_history"], history: caught.report }, { status: 409 });
        }
        if (caught instanceof InvalidClaudeAccountLabelError || caught instanceof CorruptClaudeAccountsError) return failure(400, "invalid_account", "Claude account could not be created");
        if (caught instanceof Error && caught.message === "a Claude login operation is already running") return failure(409, "login_busy", "A Claude login operation is already running");
        return failure(503, "login_unavailable", "Claude login is temporarily unavailable");
      }
    });
  } catch {
    return failure(503, "login_unavailable", "Claude login is temporarily unavailable");
  }
}

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
  try {
    return await withAccountMutationLockAsync(async () => {
      if (claudeAccountsMutationLocked()) return failure(409, "accounts_locked", "Claude accounts require registry repair");
      const account = listClaudeAccounts().find((candidate) => candidate.id === body.id);
      if (!account || account.kind !== "managed") return failure(404, "unknown_account", "Claude account is unavailable");
      const login = claudeLoginSupervisor.forAccount(account.id);
      const blockers = [
        ...accountRemovalBlockers("claude", account.id),
        ...(login && LIVE_CLAUDE_LOGIN_PHASES.has(login.phase) ? ["login_pending"] : []),
      ];
      if (blockers.length > 0) {
        return NextResponse.json({ error: "Claude account has active sessions, conversations, or sign-in", code: "account_removal_blocked", blockers }, { status: 409 });
      }
      try {
        if (login && LIVE_CLAUDE_LOGIN_PHASES.has(login.phase)) await claudeLoginSupervisor.cancel(login.operationId);
        const removal = removeManagedClaudeAccount(account.id);
        requestAccountMigrationTick();
        return NextResponse.json(removalResponse(account.id, removal));
      } catch (error) {
        if (error instanceof AccountRemovalBlockedError) {
          return NextResponse.json({ error: "Claude account has active sessions or conversations", code: "account_removal_blocked", blockers: error.blockers }, { status: 409 });
        }
        if (error instanceof AccountArchiveUnavailableError) {
          return NextResponse.json({ error: error.message, code: "archive_unavailable", archive: error.archive }, { status: 409 });
        }
        if (error instanceof UnknownClaudeAccountError) return failure(404, "unknown_account", "Claude account is unavailable");
        if (error instanceof CorruptClaudeAccountsError) return failure(409, "accounts_locked", "Claude accounts require registry repair");
        if (error instanceof UnsafeClaudeHomeError) return failure(409, "unsafe_home", "Claude account home failed safety checks");
        return NextResponse.json({ error: "Claude account could not be removed", code: "removal_failed", ...removalErrno(error) }, { status: 500 });
      }
    });
  } catch {
    return failure(500, "removal_failed", "Claude account could not be removed");
  }
}
