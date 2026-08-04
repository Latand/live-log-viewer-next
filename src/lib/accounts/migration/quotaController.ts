import crypto from "node:crypto";
import path from "node:path";

import { activeClaudeAccountId, listClaudeAccounts, type ClaudeAccount } from "@/lib/accounts/claude";
import { realClaudeLoginPorts } from "@/lib/accounts/claudeLogin";
import { activeCodexAccountId, listCodexAccounts, type CodexAccount } from "@/lib/accounts/codex";
import { managedCodexRuntime } from "@/lib/accounts/codexRuntime";
import { agentRegistry, type AgentRegistry } from "@/lib/agent/registry";
import { logQuotaEvent } from "@/lib/events";
import { fetchClaudeLimits, mapAppServerRateLimits, readCodexLimits } from "@/lib/limits";

import type { DurableQuotaObservation, MigrationEngine } from "./contracts";
import type { QuotaObservation } from "./quotaPolicy";

export interface QuotaProbePort {
  list(engine: MigrationEngine): Array<ClaudeAccount | CodexAccount>;
  active(engine: MigrationEngine): string;
  probe(engine: MigrationEngine, account: ClaudeAccount | CodexAccount, now: number): Promise<QuotaObservation>;
}

const productionProbe: QuotaProbePort = {
  list: (engine) => engine === "claude" ? listClaudeAccounts() : listCodexAccounts(),
  active: (engine) => engine === "claude" ? activeClaudeAccountId() : activeCodexAccountId(),
  async probe(engine, account, now) {
    if (engine === "claude") {
      const candidate = account as ClaudeAccount;
      const auth = await realClaudeLoginPorts.status(candidate.home).catch(() => ({ loggedIn: false, indeterminate: true }));
      /* An indeterminate status read observed nothing about the account —
         throwing routes it to the carry-forward path instead of recording a
         sign-out that never happened. */
      if (auth.indeterminate) throw new Error("quota-auth-indeterminate");
      const limits = auth.loggedIn
        ? await fetchClaudeLimits(path.join(candidate.home, ".credentials.json"))
        : { data: null, source: "unavailable" as const, reason: "live authentication check failed" };
      return {
        engine,
        accountId: candidate.id,
        authenticated: auth.loggedIn,
        authCheckedAt: now,
        limits: limits.data,
        provenance: { source: limits.source, reason: limits.reason, staleSince: null },
        observedAt: now,
      };
    }
    const candidate = account as CodexAccount;
    try {
      const probe = await managedCodexRuntime().probeQuota(candidate);
      return {
        engine,
        accountId: candidate.id,
        authenticated: probe.authenticated,
        authCheckedAt: now,
        limits: mapAppServerRateLimits(probe.rateLimits, Math.floor(now / 1000)),
        provenance: { source: "live", reason: probe.authenticated ? null : "unsupported-account-type", staleSince: null },
        observedAt: now,
        envelope: probe.envelope,
      };
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

/* One hung provider (e.g. a wedged Codex app-server) must not delay or blank
   the other accounts' readings: every account is probed concurrently and a
   probe that outlives this deadline is treated as failed for this tick. */
const PROBE_TIMEOUT_MS = 15_000;

function probeTimeout(timeoutMs: number): Promise<never> {
  return new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error("quota-probe-timeout")), timeoutMs);
    timer.unref?.();
  });
}

export class QuotaController {
  constructor(
    private readonly registry: AgentRegistry = agentRegistry(),
    private readonly probe: QuotaProbePort = productionProbe,
    private readonly bootId = crypto.randomUUID(),
    private readonly now: () => number = () => Date.now(),
    private readonly probeTimeoutMs: number = PROBE_TIMEOUT_MS,
  ) {}

  /* A failed probe must not erase the last successful reading — the panel
     always shows the most recent known limits plus when they were observed.
     The carried observation keeps the previous limits and timestamps and is
     marked as cache provenance, which keeps it ineligible for auto-balance
     decisions (those require a fresh live observation). */
  private carryForward(engine: MigrationEngine, accountId: string, reason: string, now: number): QuotaObservation {
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

  async tick(engine: MigrationEngine): Promise<void> {
    const now = this.now();
    const accounts = this.probe.list(engine);
    const observations = await Promise.all(accounts.map(async (account) => {
      try {
        const observation = await Promise.race([this.probe.probe(engine, account, now), probeTimeout(this.probeTimeoutMs)]);
        /* An authenticated account whose limits fetch came back empty-handed
           (rate-limited, provider hiccup) keeps its last known numbers. A live
           `authenticated: false` answer is a real state change — sign-out must
           surface, so it records as returned. */
        if (observation.authenticated && !observation.limits) {
          return this.carryForward(engine, account.id, observation.provenance.reason ?? "quota-probe-empty", now);
        }
        return observation;
      } catch (error) {
        const reason = error instanceof Error && error.message === "quota-probe-timeout" ? "quota-probe-timeout" : "quota-probe-failed";
        return this.carryForward(engine, account.id, reason, now);
      }
    }));
    observations.forEach((observation, index) => {
      const account = accounts[index]!;
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
    const recorded: DurableQuotaObservation[] = observations.map((observation) => ({
      engine,
      accountId: observation.accountId,
      authenticated: observation.authenticated,
      authCheckedAt: new Date(observation.authCheckedAt ?? observation.observedAt).toISOString(),
      limits: observation.limits,
      provenance: observation.provenance,
      observedAt: new Date(observation.observedAt).toISOString(),
      bootId: this.bootId,
    }));
    this.registry.recordQuotaEvaluation({
      engine,
      observations: recorded,
      signature: null,
      evidence: null,
      bootId: this.bootId,
      now: new Date(now).toISOString(),
      minimumGapMs: 60_000,
    });
  }
}
