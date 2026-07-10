import crypto from "node:crypto";
import path from "node:path";

import { activeClaudeAccountId, listClaudeAccounts, type ClaudeAccount } from "@/lib/accounts/claude";
import { realClaudeLoginPorts } from "@/lib/accounts/claudeLogin";
import { activeCodexAccountId, listCodexAccounts, type CodexAccount } from "@/lib/accounts/codex";
import { managedCodexRuntime } from "@/lib/accounts/codexRuntime";
import { agentRegistry, type AgentRegistry } from "@/lib/agent/registry";
import { fetchClaudeLimits, readCodexLimits } from "@/lib/limits";

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
    const authenticated = await managedCodexRuntime().verifyAuthentication(candidate).catch(() => false);
    const limits = authenticated
      ? await readCodexLimits({ account: candidate })
      : { data: null, source: "unavailable" as const, reason: "live authentication check failed" };
    return {
      engine,
      accountId: candidate.id,
      authenticated,
      authCheckedAt: now,
      limits: limits.data,
      provenance: { source: limits.source, reason: limits.reason, staleSince: null },
      observedAt: now,
    };
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
    const observations = await mapLimit(this.probe.list(engine), 2, (account) => this.probe.probe(engine, account, now));
    const active = this.registry.engineRouting(engine).activeAccountId ?? this.probe.active(engine);
    evaluateAutoBalance(engine, active, observations, now, this.registry, this.bootId);
  }
}
