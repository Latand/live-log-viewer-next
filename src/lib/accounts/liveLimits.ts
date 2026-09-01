import crypto from "node:crypto";

import type { ClaudeAccount } from "@/lib/accounts/claude";
import type { CodexAccount } from "@/lib/accounts/codex";
import { redactAppServerDetail } from "@/lib/accounts/codexAppServerProtocol";
import type { DurableQuotaObservation, MigrationEngine } from "@/lib/accounts/migration/contracts";
import { durableQuotaObservation, liveQuotaProbe, PROBE_TIMEOUT_MS, probeTimeout, type QuotaProbePort } from "@/lib/accounts/migration/quotaController";
import type { QuotaObservation } from "@/lib/accounts/migration/quotaPolicy";
import { agentRegistry, type AgentRegistry } from "@/lib/agent/registry";
import { logQuotaEvent } from "@/lib/events";
import { forgetCachedLimits } from "@/lib/limits";

/**
 * An operator-triggered live re-read of one account's limits (issue #1418).
 *
 * The background controller probes every account once a minute; until now the
 * only way to a fresh number was to wait for it. This runs the SAME probe for
 * one named account right now and records the result where the controller
 * records its own — the registry's durable quota observation — so the accounts
 * dialog, the capacity gate every spawn consults, and the limits footer all
 * see the reading taken at that moment. The short-lived `/api/limits` cache
 * for the account is dropped too, so the footer's next poll goes live.
 */

/** Which reader took the observation, for the quota telemetry line. */
export type LiveReadPhase = "operator-refresh" | "reset-credit-redeem";

export interface LiveLimitsDeps {
  registry?: Pick<AgentRegistry, "recordQuotaObservation">;
  probe?: QuotaProbePort;
  now?: number;
  timeoutMs?: number;
  phase?: LiveReadPhase;
}

export type LimitsRefreshResult =
  | { kind: "refreshed"; account: ClaudeAccount | CodexAccount; observation: DurableQuotaObservation }
  | { kind: "unknown_account" }
  | { kind: "probe_failed"; detail: string };

/* One boot id per Viewer process for observations recorded outside the
   controller's cycle; the controller keeps its own. */
const LIVE_READ_BOOT_ID = crypto.randomUUID();

/** Records a live observation durably and drops the account's limits cache. */
export function recordLiveObservation(
  observation: QuotaObservation,
  accountKind: "legacy" | "managed",
  deps: LiveLimitsDeps = {},
): DurableQuotaObservation {
  const registry = deps.registry ?? agentRegistry();
  const durable = durableQuotaObservation(observation, LIVE_READ_BOOT_ID);
  registry.recordQuotaObservation(durable);
  forgetCachedLimits(observation.engine, observation.accountId);
  logQuotaEvent({
    engine: observation.engine,
    accountId: observation.accountId,
    accountKind,
    envelope: observation.envelope ?? null,
    probePhase: deps.phase ?? "operator-refresh",
    provenance: observation.provenance.source,
    reasonCode: observation.provenance.reason,
  });
  return durable;
}

export async function refreshAccountLimits(engine: MigrationEngine, accountId: string, deps: LiveLimitsDeps = {}): Promise<LimitsRefreshResult> {
  const probe = deps.probe ?? liveQuotaProbe;
  const now = deps.now ?? Date.now();
  const account = probe.list(engine).find((candidate) => candidate.id === accountId);
  if (!account) return { kind: "unknown_account" };
  try {
    const observation = await Promise.race([
      probe.probe(engine, account, now),
      probeTimeout(deps.timeoutMs ?? PROBE_TIMEOUT_MS),
    ]);
    return { kind: "refreshed", account, observation: recordLiveObservation(observation, account.kind, deps) };
  } catch (error) {
    const detail = redactAppServerDetail(error instanceof Error ? error.message : String(error));
    logQuotaEvent({
      engine,
      accountId,
      accountKind: account.kind,
      envelope: null,
      probePhase: deps.phase ?? "operator-refresh",
      provenance: "unavailable",
      reasonCode: detail === "quota-probe-timeout" ? "quota-probe-timeout" : "quota-probe-failed",
    });
    return { kind: "probe_failed", detail };
  }
}
