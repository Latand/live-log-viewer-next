import crypto from "node:crypto";
import path from "node:path";

import { activeClaudeAccountId, listClaudeAccounts, type ClaudeAccount } from "@/lib/accounts/claude";
import { realClaudeLoginPorts } from "@/lib/accounts/claudeLogin";
import { activeCodexAccountId, listCodexAccounts, type CodexAccount } from "@/lib/accounts/codex";
import { managedCodexRuntime } from "@/lib/accounts/codexRuntime";
import { agentRegistry, type AgentRegistry } from "@/lib/agent/registry";
import { logQuotaEvent } from "@/lib/events";
import { fetchClaudeLimits, mapAppServerRateLimits, readCodexLimits } from "@/lib/limits";

import { evaluateAutoBalance } from "./autoBalance";
import type { MigrationEngine } from "./contracts";
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
      const auth = await realClaudeLoginPorts.status(candidate.home).catch(() => ({ loggedIn: false }));
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

async function mapLimit<T, R>(values: T[], limit: number, visit: (value: T) => Promise<R>): Promise<R[]> {
  const output = new Array<R>(values.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= values.length) return;
      output[index] = await visit(values[index]!);
    }
  }));
  return output;
}

export class QuotaController {
  constructor(
    private readonly registry: AgentRegistry = agentRegistry(),
    private readonly probe: QuotaProbePort = productionProbe,
    private readonly bootId = crypto.randomUUID(),
    private readonly now: () => number = () => Date.now(),
  ) {}

  async tick(engine: MigrationEngine): Promise<void> {
    if (!this.registry.autoBalancePolicy(engine).enabled) return;
    const now = this.now();
    const accounts = this.probe.list(engine);
    const observations = await mapLimit(accounts, 2, async (account) => {
      try {
        return await this.probe.probe(engine, account, now);
      } catch {
        return {
          engine,
          accountId: account.id,
          authenticated: false,
          authCheckedAt: now,
          limits: null,
          provenance: { source: "unavailable" as const, reason: "quota-probe-failed", staleSince: null },
          observedAt: now,
          envelope: null,
        };
      }
    });
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
    const active = this.registry.engineRouting(engine).activeAccountId ?? this.probe.active(engine);
    evaluateAutoBalance(engine, active, observations, now, this.registry, this.bootId);
  }
}
