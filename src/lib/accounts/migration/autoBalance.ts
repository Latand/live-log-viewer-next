import crypto from "node:crypto";

import { agentRegistry, MigrationRevisionError, type AgentRegistry } from "@/lib/agent/registry";

import type { DurableQuotaObservation, MigrationIntent } from "./contracts";
import { AUTO_BALANCE_COOLDOWN_MS, AUTO_BALANCE_SAMPLE_GAP_MS, chooseAutoBalance, type QuotaObservation } from "./quotaPolicy";

const BOOT_ID = crypto.randomUUID();

/** Records every sample and the sustain clock in the durable registry. */
export function evaluateAutoBalance(
  engine: "claude" | "codex",
  activeId: string,
  observations: QuotaObservation[],
  now = Date.now(),
  registry: AgentRegistry = agentRegistry(),
  bootId: string = BOOT_ID,
): MigrationIntent | null {
  const policy = registry.autoBalancePolicy(engine);
  const draining = Object.values(registry.snapshot().migrationIntents).some((intent) => intent.engine === engine && intent.state === "draining");
  const decision = draining ? null : chooseAutoBalance(engine, activeId, observations, policy, now);
  const recorded: DurableQuotaObservation[] = observations.map((observation) => ({
    engine,
    accountId: observation.accountId,
    authenticated: observation.authenticated,
    authCheckedAt: new Date(observation.authCheckedAt ?? observation.observedAt).toISOString(),
    limits: observation.limits,
    provenance: observation.provenance,
    observedAt: new Date(observation.observedAt).toISOString(),
    bootId,
  }));
  const signature = decision ? `${activeId}:${decision.targetId}` : null;
  const evaluation = registry.recordQuotaEvaluation({
    engine,
    observations: recorded,
    signature,
    evidence: decision?.evidence ?? null,
    bootId,
    now: new Date(now).toISOString(),
    minimumGapMs: AUTO_BALANCE_SAMPLE_GAP_MS,
  });
  if (!decision || !evaluation.sustained) return null;
  try {
    const intent = registry.commitMigrationIntent({
      engine,
      targetId: decision.targetId,
      origin: "auto",
      requestId: `auto:${engine}:${decision.targetId}:${decision.evidence.observedAt}`,
      expectedRevision: evaluation.routeRevision,
      evidence: decision.evidence,
    });
    if (intent.origin === "auto" && intent.state === "complete") {
      registry.recordAutoBalanceOutcome(engine, "complete", intent.evidence, new Date(now + AUTO_BALANCE_COOLDOWN_MS).toISOString());
    }
    return intent.origin === "auto" ? intent : null;
  } catch (error) {
    if (error instanceof MigrationRevisionError) return null;
    throw error;
  }
}

export function completeAutoBalanceIntent(engine: "claude" | "codex", intentId: string, outcome: "complete" | "stopped" | "failed-partial", now = Date.now(), registry: AgentRegistry = agentRegistry()): void {
  registry.setMigrationIntentState(intentId, outcome === "stopped" ? "stopped" : "complete");
  const snapshot = registry.snapshot();
  registry.recordAutoBalanceOutcome(engine, outcome, snapshot.migrationIntents[intentId]?.evidence ?? null, new Date(now + AUTO_BALANCE_COOLDOWN_MS).toISOString());
}
