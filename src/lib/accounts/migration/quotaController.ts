import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { accountsCollectionRevision } from "@/lib/accounts/accountsStore";

import { activeClaudeAccountId, listClaudeAccounts, listClaudeProviderModels, readClaudeProviderToken, type ClaudeAccount } from "@/lib/accounts/claude";
import { realClaudeLoginPorts } from "@/lib/accounts/claudeLogin";
import { accountProbeIdentity, claudeProbeCredentialIdentity, withAccountMutationLockAsync } from "@/lib/accounts/accountMutation";
import { activeCodexAccountId, listCodexAccounts, type CodexAccount } from "@/lib/accounts/codex";
import { activeCopilotAccountId, copilotSignedInUser, listCopilotAccounts, type CopilotAccount } from "@/lib/accounts/copilot";
import { managedCodexRuntime, type CodexQuotaProbe } from "@/lib/accounts/codexRuntime";
import type { AppServerResetCredits } from "@/lib/accounts/codexAppServer";
import { agentRegistry, type AgentRegistry } from "@/lib/agent/registry";
import { logQuotaEvent } from "@/lib/events";
import { adoptClaudeLimitsSnapshot, readClaudeAccountLimits, readCodexLimits } from "@/lib/limits";
import { readCopilotTranscriptLimits } from "@/lib/limits/copilotTranscriptLimits";

import type { DurableQuotaObservation } from "./contracts";
import type { QuotaEngine, QuotaObservation, QuotaResetCredits } from "./quotaPolicy";

type QuotaAccount = ClaudeAccount | CodexAccount | CopilotAccount;

export interface QuotaProbePort {
  list(engine: QuotaEngine): QuotaAccount[];
  active(engine: QuotaEngine): string;
  /** Optional backend-aware credential fingerprint; evaluated outside the lease. */
  credentialIdentity?(engine: QuotaEngine, account: QuotaAccount): string | null;
  probe(engine: QuotaEngine, account: QuotaAccount, now: number, options?: QuotaProbeOptions): Promise<QuotaObservation>;
}

export interface QuotaProbeOptions {
  /** An operator asked for this read (#1418): skip the shared snapshot's
      fresh-read and backoff rests. */
  force?: boolean;
}

/** The durable projection of a reset-credit summary (issue #1373): the count
    and the soonest expiry among the available credits. Opaque credit ids stop
    here. */
export function quotaResetCreditsFrom(summary: AppServerResetCredits | null): QuotaResetCredits | null {
  if (!summary) return null;
  const expiries = (summary.credits ?? [])
    .filter((credit) => credit.status === "available" && credit.expiresAt !== null)
    .map((credit) => credit.expiresAt as number);
  return { availableCount: summary.availableCount, expiresAt: expiries.length ? Math.min(...expiries) : null };
}

/** One Codex app-server probe reconciled into the observation the registry
    keeps. Shared by the periodic controller tick, the operator's per-account
    re-read (#1418) and the post-redemption re-read (#1373), so every path
    records a reading of the same shape and provenance. */
export async function codexObservationFromProbe(account: CodexAccount, probe: CodexQuotaProbe, now: number): Promise<QuotaObservation> {
  const limits = await readCodexLimits({
    account,
    liveReader: async () => probe.rateLimits,
    now: () => now,
  });
  return {
    engine: "codex",
    accountId: account.id,
    authenticated: probe.authenticated,
    authCheckedAt: now,
    limits: limits.data,
    provenance: {
      source: limits.source,
      reason: probe.authenticated ? limits.reason : "unsupported-account-type",
      staleSince: null,
    },
    observedAt: now,
    envelope: probe.envelope,
    resetCredits: quotaResetCreditsFrom(probe.resetCredits),
  };
}

/** The registry's record of one observation. */
export function durableQuotaObservation(observation: QuotaObservation, bootId: string): DurableQuotaObservation {
  return {
    engine: observation.engine,
    accountId: observation.accountId,
    authenticated: observation.authenticated,
    authCheckedAt: new Date(observation.authCheckedAt ?? observation.observedAt).toISOString(),
    limits: observation.limits,
    provenance: observation.provenance,
    observedAt: new Date(observation.observedAt).toISOString(),
    bootId,
    resetCredits: observation.resetCredits ?? null,
  };
}

/**
 * One Claude account's observation. The usage numbers come from the snapshot
 * `/api/limits` answers from, never straight from the provider (issue #1849):
 * a read the footer took inside the window serves this one, a 429 either path
 * met holds both back, and the read this takes is what the footer shows next.
 * `observedAt` is when the provider answered, which a served snapshot can
 * predate.
 */
export async function claudeQuotaObservation(
  account: Pick<ClaudeAccount, "id" | "home" | "provider" | "authPresent">,
  now: number,
  options: QuotaProbeOptions & { authStatus?: (home: string) => Promise<{ loggedIn: boolean; indeterminate?: boolean }> } = {},
): Promise<QuotaObservation> {
  if (account.provider) {
    const token = readClaudeProviderToken(account.home);
    let authenticated = Boolean(token);
    let reason = authenticated ? "provider limits unknown" : "provider credential unavailable";
    if (token) {
      try { await listClaudeProviderModels(account.provider, token); }
      catch (error) { if (error instanceof Error && error.message === "Provider authentication failed") { authenticated = false; reason = "provider authentication failed"; } }
    }
    return {
      engine: "claude", accountId: account.id, authenticated, authCheckedAt: now, limits: null,
      provenance: { source: "unavailable", reason, staleSince: null }, observedAt: now,
    };
  }
  const status = options.authStatus ?? realClaudeLoginPorts.status;
  const auth = await status(account.home).catch(() => ({ loggedIn: false, indeterminate: true }));
  /* An indeterminate status read observed nothing about the account —
     throwing routes it to the carry-forward path instead of recording a
     sign-out that never happened. */
  if (auth.indeterminate) throw new Error("quota-auth-indeterminate");
  if (!auth.loggedIn) {
    return {
      engine: "claude",
      accountId: account.id,
      authenticated: false,
      authCheckedAt: now,
      limits: null,
      provenance: { source: "unavailable", reason: "live authentication check failed", staleSince: null },
      observedAt: now,
    };
  }
  const limits = await readClaudeAccountLimits(account, { now: () => now, force: options.force });
  return {
    engine: "claude",
    accountId: account.id,
    authenticated: true,
    authCheckedAt: now,
    limits: limits.data,
    provenance: { source: limits.provenance.source, reason: limits.provenance.reason, staleSince: limits.provenance.staleSince },
    observedAt: limits.observedAt ?? now,
  };
}

const productionProbe: QuotaProbePort = {
  list: (engine) => engine === "claude" ? listClaudeAccounts() : engine === "codex" ? listCodexAccounts() : listCopilotAccounts(),
  active: (engine) => engine === "claude" ? activeClaudeAccountId() : engine === "codex" ? activeCodexAccountId() : activeCopilotAccountId() ?? "",
  credentialIdentity: (engine, account) => engine === "claude"
    ? (account as ClaudeAccount).provider ? accountProbeIdentity(account) : claudeProbeCredentialIdentity(account.home)
    : engine === "copilot" ? copilotProbeIdentity(account as CopilotAccount) : accountProbeIdentity(account),
  async probe(engine, account, now, options) {
    if (engine === "claude") return await claudeQuotaObservation(account as ClaudeAccount, now, options);
    if (engine === "copilot") {
      const candidate = account as CopilotAccount;
      const authenticated = copilotSignedInUser(candidate.home) !== null;
      const limits = authenticated ? readCopilotTranscriptLimits(candidate.sessionStateDir) : { data: null, reason: "Copilot CLI is signed out", source: "unavailable" as const };
      return {
        engine: "copilot",
        accountId: candidate.id,
        authenticated,
        authCheckedAt: now,
        limits: limits.data,
        provenance: { source: limits.source, reason: limits.reason, staleSince: null },
        observedAt: limits.data?.capturedAt === null || limits.data?.capturedAt === undefined
          ? now
          : limits.data.capturedAt * 1000,
      };
    }
    const candidate = account as CodexAccount;
    try {
      const probe = await managedCodexRuntime().probeQuota(candidate);
      return await codexObservationFromProbe(candidate, probe, now);
    } catch (error) {
      // The reader owns redacted server-local detail and returns a closed code
      // suitable for the durable quota registry.
      const limits = await readCodexLimits({ account: candidate, liveReader: async () => Promise.reject(error) });
      /* An empty transcript fallback after a failed live probe observed
         nothing — rethrow so the controller keeps the last known reading. */
      if (!limits.data) throw error;
      return {
        engine,
        accountId: candidate.id,
        authenticated: false,
        authCheckedAt: now,
        limits: limits.data,
        provenance: { source: limits.source, reason: limits.reason, staleSince: null },
        observedAt: now,
        envelope: null,
      };
    }
  },
};

function copilotProbeIdentity(account: CopilotAccount): string {
  try {
    const stat = fs.statSync(path.join(account.home, "config.json"), { bigint: true });
    return [accountProbeIdentity(account), stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(":");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return `${accountProbeIdentity(account)}:${code === "ENOENT" ? "missing" : "unreadable"}`;
  }
}

/** The live provider probe, exported so an operator-triggered re-read
    (issue #1418) goes through exactly the reader the controller uses. */
export const liveQuotaProbe: QuotaProbePort = productionProbe;

/* One hung provider (e.g. a wedged Codex app-server) must not delay or blank
   the other accounts' readings: every account is probed concurrently and a
   probe that outlives this deadline is treated as failed for this tick. */
export const PROBE_TIMEOUT_MS = 15_000;

export function probeTimeout(timeoutMs: number): Promise<never> {
  return new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error("quota-probe-timeout")), timeoutMs);
    timer.unref?.();
  });
}

export class QuotaController {
  constructor(
    private readonly registry: AgentRegistry = agentRegistry(),
    private readonly probe: QuotaProbePort = productionProbe,
    private readonly bootId: string = crypto.randomUUID(),
    private readonly now: () => number = () => Date.now(),
    private readonly probeTimeoutMs: number = PROBE_TIMEOUT_MS,
  ) {}

  /* A failed probe must not erase the last successful reading — the panel
     always shows the most recent known limits plus when they were observed.
     The carried observation keeps the previous limits and timestamps and is
     marked as cache provenance, which keeps it ineligible for auto-balance
     decisions (those require a fresh live observation). */
  private carryForward(engine: QuotaEngine, accountId: string, reason: string, now: number): QuotaObservation {
    const previous = this.registry.readOnlySnapshot().quotaObservations[engine][accountId];
    if (previous?.limits) {
      return {
        engine,
        accountId,
        authenticated: previous.authenticated,
        authCheckedAt: Date.parse(previous.authCheckedAt) || now,
        limits: previous.limits,
        provenance: {
          source: "cache",
          reason,
          staleSince: previous.provenance.staleSince ?? previous.observedAt,
        },
        observedAt: Date.parse(previous.observedAt) || now,
        envelope: null,
        resetCredits: previous.resetCredits ?? null,
      };
    }
    return {
      engine,
      accountId,
      authenticated: false,
      authCheckedAt: now,
      limits: null,
      provenance: { source: "unavailable", reason, staleSince: null },
      observedAt: now,
      envelope: null,
    };
  }

  async tick(engine: QuotaEngine): Promise<void> {
    // Catalog listing may run recovery or query Keychain. Read it before
    // the lease, then validate the revision it came from inside the lease.
    const revision = accountsCollectionRevision();
    const accountsBefore = this.probe.list(engine).map((account) => ({ account, identity: accountProbeIdentity(account) }));
    const activeBefore = this.probe.active(engine);
    const snapshot = await withAccountMutationLockAsync(() => {
      if (revision !== accountsCollectionRevision()) return null;
      return { accounts: accountsBefore, revision,
        routing: this.registry.engineRouting(engine).revision, active: activeBefore };
    }, { holder: "quota snapshot" });
    if (!snapshot) return; // The next tick reads the catalog that won.
    const now = this.now();
    const results = await Promise.all(snapshot.accounts.map(async ({ account }) => {
      const credentialIdentity = this.probe.credentialIdentity?.(engine, account);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const observation = await Promise.race([
          this.probe.probe(engine, account, now),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("quota-probe-timeout")), this.probeTimeoutMs);
            timer.unref?.();
          }),
        ]);
        return { account, observation, reason: null, credentialIdentity };
      } catch (error) {
        return { account, observation: null, credentialIdentity, reason: error instanceof Error && error.message === "quota-probe-timeout" ? "quota-probe-timeout" : "quota-probe-failed" };
      } finally {
        clearTimeout(timer);
      }
    }));
    // Keychain reads may start a child; do them before admission. A Viewer
    // login during admission is also fenced by the collection revision below.
    const credentialsUnchanged = results.map(({ account, credentialIdentity }) => credentialIdentity !== null
      && credentialIdentity === this.probe.credentialIdentity?.(engine, account));
    const currentRevision = accountsCollectionRevision();
    const current = new Map(this.probe.list(engine).map((account) => [account.id, account]));
    const active = this.probe.active(engine);
    const accepted = await withAccountMutationLockAsync(() => {
      // A switch (including switch-away-and-back), removal or login mutation
      // invalidates the read. Never let an old probe restore retired state.
      if (currentRevision !== accountsCollectionRevision() || snapshot.revision !== currentRevision
        || snapshot.routing !== this.registry.engineRouting(engine).revision
        || snapshot.active !== active) return [];
      const observations: QuotaObservation[] = [];
      for (const [index, result] of results.entries()) {
        const account = current.get(result.account.id);
        if (!credentialsUnchanged[index] || !account || snapshot.accounts[index]!.identity !== accountProbeIdentity(account)) continue;
        const previous = this.registry.readOnlySnapshot().quotaObservations[engine][account.id];
        // Another read may have committed while this one waited for its provider.
        if (previous && Date.parse(previous.authCheckedAt) > now) continue;
        const observation = result.observation;
        if (!observation || (observation.authenticated && (!observation.limits && engine !== "copilot"
          || (previous?.limits && Date.parse(previous.observedAt) > observation.observedAt)))) {
          observations.push(this.carryForward(engine, account.id, result.reason ?? observation?.provenance.reason ?? (observation?.limits ? "quota-probe-older" : "quota-probe-empty"), now));
        } else {
          observations.push(observation);
        }
      }
      if (observations.length) {
        if (engine === "copilot") {
          observations.forEach((observation) => this.registry.recordQuotaObservation(durableQuotaObservation(observation, this.bootId)));
          return observations;
        }
        this.registry.recordQuotaEvaluation({
          engine,
          observations: observations.map((observation) => durableQuotaObservation({ ...observation, engine }, this.bootId)),
          signature: null, evidence: null, bootId: this.bootId,
          now: new Date(now).toISOString(), minimumGapMs: 60_000,
        });
      }
      return observations;
    }, { holder: "quota commit" });
    const observations = accepted;
    const accounts = new Map(snapshot.accounts.map(({ account }) => [account.id, account]));
    observations.forEach((observation) => {
      const account = accounts.get(observation.accountId)!;
      if (engine === "copilot") return;
      logQuotaEvent({
        engine,
        accountId: observation.accountId,
        accountKind: account.kind,
        envelope: observation.envelope ?? null,
        probePhase: "account-rate-limits",
        provenance: observation.provenance.source,
        reasonCode: observation.provenance.reason,
      });
    });
    /* Whatever the registry now holds for a Claude account is offered to the
       snapshot `/api/limits` answers from; it lands only where it is newer, so
       the footer never shows an older reading than the accounts dialog. */
    if (engine === "claude") {
      for (const observation of observations) {
        if (observation.limits) adoptClaudeLimitsSnapshot(observation.accountId, observation.limits, observation.observedAt, now);
      }
    }
  }
}
