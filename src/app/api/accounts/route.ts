import { NextResponse } from "next/server";

import { activeCodexAccountId, codexAccountsMutationLocked, listCodexAccounts } from "@/lib/accounts/codex";
import { activeClaudeAccountId, claudeAccountsMutationLocked, listClaudeAccounts } from "@/lib/accounts/claude";
import { claudeLoginSupervisor } from "@/lib/accounts/claudeLogin";
import { managedCodexRuntime } from "@/lib/accounts/codexRuntime";
import { agentRegistry } from "@/lib/agent/registry";
import { AUTO_BALANCE_FRESH_MS, AUTO_BALANCE_THRESHOLD, effectiveRemaining } from "@/lib/accounts/migration/quotaPolicy";
import type { DurableQuotaObservation, MigrationEngine } from "@/lib/accounts/migration/contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function liveFreshObservation(observation: DurableQuotaObservation | undefined, now: number): boolean {
  if (!observation?.authenticated || observation.provenance.source !== "live") return false;
  const observedAge = now - Date.parse(observation.observedAt);
  const authAge = now - Date.parse(observation.authCheckedAt);
  return Number.isFinite(observedAge) && Number.isFinite(authAge)
    && observedAge >= 0 && authAge >= 0
    && observedAge <= AUTO_BALANCE_FRESH_MS && authAge <= AUTO_BALANCE_FRESH_MS;
}

function accountProjection(observation: DurableQuotaObservation | undefined, authPresent: boolean, now: number) {
  const eligible = liveFreshObservation(observation, now);
  const effective = observation ? effectiveRemaining({
    engine: observation.engine,
    accountId: observation.accountId,
    authenticated: observation.authenticated,
    limits: observation.limits,
    provenance: observation.provenance,
    observedAt: Date.parse(observation.observedAt),
    authCheckedAt: Date.parse(observation.authCheckedAt),
  }, now) : null;
  return {
    auth: {
      state: eligible ? "authenticated" : authPresent ? "unknown" : "signed_out",
      method: null,
      email: null,
      plan: observation?.limits?.plan ?? null,
      checkedAt: observation?.authCheckedAt ?? null,
    },
    limits: {
      state: eligible ? "fresh" : observation?.limits ? "stale" : "unavailable",
      session: observation?.limits?.session ?? null,
      weekly: observation?.limits?.weekly ?? null,
      checkedAt: observation?.observedAt ?? null,
    },
    effective: effective ? { ...effective, freshness: eligible ? "fresh" : "stale" } : null,
  };
}

function migrationProjection(engine: MigrationEngine, snapshot: ReturnType<ReturnType<typeof agentRegistry>["snapshot"]>) {
  const intent = Object.values(snapshot.migrationIntents)
    .filter((candidate) => {
      if (candidate.engine !== engine) return false;
      if (candidate.state === "draining") return true;
      return candidate.state === "complete" && Object.values(snapshot.conversations)
        .some((conversation) => conversation.migration?.intentId === candidate.id && conversation.migration.phase === "failed-recoverable");
    })
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0] ?? null;
  if (!intent) return null;
  const conversations = Object.values(snapshot.conversations).filter((conversation) => conversation.migration?.intentId === intent.id);
  const count = (phase: string) => conversations.filter((conversation) => conversation.migration?.phase === phase).length;
  const committed = count("committed");
  const rolledBack = count("rolled-back");
  const targetLabel = (engine === "claude" ? listClaudeAccounts() : listCodexAccounts())
    .find((account) => account.id === intent.targetId)?.label ?? intent.targetId;
  return {
    intentId: intent.id,
    targetId: intent.targetId,
    targetLabel,
    revision: intent.revision,
    origin: intent.origin,
    reason: intent.evidence ? { window: intent.evidence.sourceWindow, fromPercent: intent.evidence.sourcePercent, toPercent: intent.evidence.targetPercent } : null,
    state: intent.state,
    counts: {
      done: committed + rolledBack,
      waitingTurn: count("waiting-turn"),
      inFlight: conversations.filter((conversation) => ["requested", "preparing", "successor-starting", "verifying"].includes(conversation.migration?.phase ?? "")).length,
      failed: count("failed-recoverable"),
      total: conversations.length,
    },
    startedAt: intent.createdAt,
  };
}

function autoBalanceProjection(engine: MigrationEngine, snapshot: ReturnType<ReturnType<typeof agentRegistry>["snapshot"]>, now: number) {
  const policy = snapshot.autoBalance[engine];
  const draining = Object.values(snapshot.migrationIntents).some((intent) => intent.engine === engine && intent.state === "draining");
  const fresh = Object.values(snapshot.quotaObservations[engine]).some((observation) =>
    liveFreshObservation(observation, now));
  const cooling = Boolean(policy.cooldownUntil && Date.parse(policy.cooldownUntil) > now);
  return {
    ...policy,
    thresholdPercent: AUTO_BALANCE_THRESHOLD,
    state: !policy.enabled ? "disabled" : draining ? "draining" : cooling ? "cooldown" : fresh ? "idle" : "waiting-fresh",
  };
}

/** Pure durable projection. Live auth/quota/login reconciliation runs in the controller. */
export async function GET() {
  const registry = agentRegistry();
  const snapshot = registry.snapshot();
  const now = Date.now();
  const claudeObservations = snapshot.quotaObservations.claude;
  const codexObservations = snapshot.quotaObservations.codex;
  const codexAccounts = listCodexAccounts().map((account) => {
    const authenticated = liveFreshObservation(codexObservations[account.id], now);
    const login = managedCodexRuntime().peekLogin(account);
    const compatibilityPending = Boolean(account.loginPane && !authenticated);
    return {
      id: account.id,
      label: account.label,
      kind: account.kind,
      authPresent: account.authPresent,
      loginPending: compatibilityPending || login.state === "pending",
      loginState: authenticated ? "authenticated" : compatibilityPending ? "pending" : login.state,
      attemptState: compatibilityPending ? "pending" : login.attemptState,
      deviceAuth: login.deviceAuth,
      ...accountProjection(codexObservations[account.id], account.authPresent, now),
    };
  });
  const claudeAccounts = listClaudeAccounts().map((account) => ({
    id: account.id,
    label: account.label,
    kind: account.kind,
    authPresent: account.authPresent,
    loginPending: claudeLoginSupervisor.forAccount(account.id)?.phase === "awaiting_browser",
    loginState: account.authPresent ? "authenticated" : "idle",
    attemptState: null,
    deviceAuth: null,
    ...accountProjection(claudeObservations[account.id], account.authPresent, now),
    login: claudeLoginSupervisor.forAccount(account.id),
  }));
  const codexMigration = migrationProjection("codex", snapshot);
  const claudeMigration = migrationProjection("claude", snapshot);
  const codexAuto = autoBalanceProjection("codex", snapshot, now);
  const claudeAuto = autoBalanceProjection("claude", snapshot, now);
  return NextResponse.json({
    codex: {
      active: snapshot.engineRouting.codex.activeAccountId ?? activeCodexAccountId(),
      accounts: codexAccounts,
      migration: codexMigration,
      autoBalance: codexAuto,
    },
    claude: {
      active: snapshot.engineRouting.claude.activeAccountId ?? activeClaudeAccountId(),
      accounts: claudeAccounts,
      mutationLocked: claudeAccountsMutationLocked(),
      migration: claudeMigration,
      autoBalance: claudeAuto,
    },
    mutationLocked: { codex: codexAccountsMutationLocked(), claude: claudeAccountsMutationLocked() },
    migration: { codex: codexMigration, claude: claudeMigration },
    autoBalance: { codex: codexAuto, claude: claudeAuto },
  });
}
