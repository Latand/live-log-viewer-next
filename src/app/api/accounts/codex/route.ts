import { NextRequest, NextResponse } from "next/server";

import { CorruptCodexAccountsError, InvalidAccountLabelError, UnknownAccountError, UnsafeCodexHomeError, cleanupOrphanedCodexHomes, codexAccountsMutationLocked, createManagedCodexAccount, listCodexAccounts, removeManagedCodexAccount, setCodexAccountLoginPane } from "@/lib/accounts/codex";
import { managedCodexRuntime } from "@/lib/accounts/codexRuntime";
import { accountRemovalBlockers } from "@/lib/accounts/removal";
import { requestAccountMigrationTick } from "@/lib/accounts/migration/controllerSignal";
import { agentRegistry } from "@/lib/agent/registry";
import { rejectCrossOrigin } from "@/lib/sameOrigin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const rejected = rejectCrossOrigin(req);
  if (rejected) return rejected;
  let body: { label?: unknown; id?: unknown; action?: unknown };
  try { body = await req.json() as { label?: unknown; id?: unknown; action?: unknown }; } catch { return NextResponse.json({ error: "invalid JSON" }, { status: 400 }); }
  try {
    if (body.action === "retry" || body.action === "cancel") {
      if (typeof body.id !== "string") return NextResponse.json({ error: "id must be a string" }, { status: 400 });
      const account = listCodexAccounts().find((candidate) => candidate.id === body.id);
      if (!account || account.kind !== "managed") throw new UnknownAccountError(body.id);
      if (body.action === "cancel") {
        const cancelled = await managedCodexRuntime().cancelLogin(account.id);
        return NextResponse.json({ account: { id: account.id }, cancelled });
      }
      const challenge = await managedCodexRuntime().retryLogin(account);
      return NextResponse.json({
        account: { id: account.id, label: account.label, kind: account.kind, authPresent: account.authPresent, loginPending: true },
        deviceAuth: { url: challenge.verificationUrl, code: challenge.userCode },
        target: challenge.verificationUrl,
      });
    }
    if (typeof body.label !== "string") return NextResponse.json({ error: "label must be a string" }, { status: 400 });
    const account = createManagedCodexAccount(body.label);
    const challenge = await managedCodexRuntime().startLogin(account);
    return NextResponse.json({
      account: { id: account.id, label: account.label, kind: account.kind, authPresent: account.authPresent, loginPending: true },
      deviceAuth: { url: challenge.verificationUrl, code: challenge.userCode },
      // The existing frontend only requires a string target for its success note.
      target: challenge.verificationUrl,
    });
  } catch (error) {
    const status = error instanceof InvalidAccountLabelError || error instanceof CorruptCodexAccountsError || error instanceof UnknownAccountError ? 400 : 500;
    return NextResponse.json({ error: error instanceof Error ? error.message : "could not create account" }, { status });
  }
}

export async function DELETE(req: NextRequest) {
  const rejected = rejectCrossOrigin(req);
  if (rejected) return rejected;
  let body: { id?: unknown; force?: unknown; cleanupOrphans?: unknown };
  try { body = await req.json() as { id?: unknown; force?: unknown; cleanupOrphans?: unknown }; } catch { return NextResponse.json({ error: "invalid JSON" }, { status: 400 }); }
  if (body.cleanupOrphans === true) {
    if (body.id !== undefined) return NextResponse.json({ error: "cleanup accepts no account id", code: "invalid_request" }, { status: 400 });
    try { return NextResponse.json(cleanupOrphanedCodexHomes()); }
    catch (error) {
      if (error instanceof CorruptCodexAccountsError) return NextResponse.json({ error: "Codex accounts require registry repair", code: "accounts_locked" }, { status: 409 });
      return NextResponse.json({ error: "Codex orphan cleanup failed", code: "cleanup_failed" }, { status: 500 });
    }
  }
  if (typeof body.id !== "string" || typeof body.force !== "undefined" && typeof body.force !== "boolean") {
    return NextResponse.json({ error: "account id and force flag are invalid", code: "invalid_request" }, { status: 400 });
  }
  if (codexAccountsMutationLocked()) return NextResponse.json({ error: "Codex accounts require registry repair", code: "accounts_locked" }, { status: 409 });
  const account = listCodexAccounts().find((candidate) => candidate.id === body.id);
  if (!account || account.kind !== "managed") return NextResponse.json({ error: "Codex account is unavailable", code: "unknown_account" }, { status: 404 });
  const login = managedCodexRuntime().peekLogin(account);
  const blockers = [
    ...accountRemovalBlockers("codex", account.id),
    ...(login.attemptState === "pending" || account.loginPane !== null ? ["login_pending"] : []),
  ];
  if (blockers.includes("current_conversations") || blockers.length && body.force !== true) {
    return NextResponse.json({ error: "Codex account has active sessions, conversations, or sign-in", code: "account_removal_blocked", blockers }, { status: 409 });
  }
  const registry = agentRegistry();
  const beforeRetirement = registry.snapshot();
  try {
    if (login.attemptState === "pending") await managedCodexRuntime().cancelLogin(account.id);
    if (account.loginPane !== null) setCodexAccountLoginPane(account.id, null);
    registry.retireAccount("codex", account.id, "default");
    const retired = registry.snapshot();
    try {
      const removal = removeManagedCodexAccount(account.id);
      requestAccountMigrationTick();
      return NextResponse.json({ removed: { id: account.id }, cleanupPending: removal.cleanupPending });
    } catch (error) {
      registry.restoreSnapshot(retired, beforeRetirement);
      throw error;
    }
  } catch (error) {
    if (error instanceof UnknownAccountError) return NextResponse.json({ error: "Codex account is unavailable", code: "unknown_account" }, { status: 404 });
    if (error instanceof CorruptCodexAccountsError) return NextResponse.json({ error: "Codex accounts require registry repair", code: "accounts_locked" }, { status: 409 });
    if (error instanceof UnsafeCodexHomeError) return NextResponse.json({ error: "Codex account home failed safety checks", code: "unsafe_home" }, { status: 409 });
    return NextResponse.json({ error: "Codex account could not be removed", code: "removal_failed" }, { status: 500 });
  }
}
