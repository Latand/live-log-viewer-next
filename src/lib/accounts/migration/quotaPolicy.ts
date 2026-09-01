import { claudeModelGatedByFlagshipWeekly } from "@/lib/agent/models";
import type { EngineLimits, LimitsProvenance, QuotaWindowKey } from "@/lib/types";

import type { AutoBalancePolicy, MigrationEvidence, MigrationEngine } from "./contracts";

export const AUTO_BALANCE_THRESHOLD = 25;
export const AUTO_BALANCE_COOLDOWN_MS = 15 * 60 * 1000;
export const AUTO_BALANCE_RETURN_WINDOW_MS = 60 * 60 * 1000;
export const AUTO_BALANCE_RETURN_ERC = 35;
export const AUTO_BALANCE_SAMPLE_GAP_MS = 60 * 1000;
export const AUTO_BALANCE_FRESH_MS = 5 * 60 * 1000;

/** Usage-limit reset credits an account holds (issue #1373), as the Codex
    app-server reports them beside the rate limits. `expiresAt` is the soonest
    expiry among the available credits, Unix seconds, or null when none expires. */
export interface QuotaResetCredits {
  availableCount: number;
  expiresAt: number | null;
}

export interface QuotaObservation {
  engine: MigrationEngine;
  accountId: string;
  authenticated: boolean;
  limits: EngineLimits | null;
  provenance: LimitsProvenance;
  observedAt: number;
  authCheckedAt?: number;
  envelope?: "headerless" | "jsonrpc-2.0" | null;
  /** Codex only; null when the probe carried no reset-credit summary. */
  resetCredits?: QuotaResetCredits | null;
}

export interface EffectiveRemaining {
  percent: number;
  window: QuotaWindowKey;
}

export interface EffectiveRemainingOptions {
  /** The model the next spawn would use. The flagship weekly (issue #1358)
      gates the minimum only when that model draws on it; an unstated model
      resolves to the launch default, which does. */
  model?: string | null;
}

/** The windows that gate the account's next spawn: the session and general
    weekly always, plus the flagship weekly when the chosen model is on that tier. */
export function gatingWindowKeys(engine: MigrationEngine, model?: string | null): readonly QuotaWindowKey[] {
  if (engine === "claude" && claudeModelGatedByFlagshipWeekly(model)) return ["session", "weekly", "flagship"];
  return ["session", "weekly"];
}

export function effectiveRemaining(observation: QuotaObservation, now = Date.now(), options: EffectiveRemainingOptions = {}): EffectiveRemaining | null {
  if (!Number.isFinite(now) || !Number.isFinite(observation.observedAt) ||
    (observation.authCheckedAt !== undefined && !Number.isFinite(observation.authCheckedAt))) return null;
  const age = now - observation.observedAt;
  const authAge = now - (observation.authCheckedAt ?? observation.observedAt);
  if (!observation.authenticated || observation.provenance.source !== "live" || age < 0 || authAge < 0 || age > AUTO_BALANCE_FRESH_MS || authAge > AUTO_BALANCE_FRESH_MS || !observation.limits) return null;
  const reportedWindows = gatingWindowKeys(observation.engine, options.model)
    .map((window) => ({ window, value: observation.limits?.[window] }))
    .filter((entry): entry is { window: QuotaWindowKey; value: NonNullable<EngineLimits["session"]> } => entry.value !== null && entry.value !== undefined);
  if (reportedWindows.some(({ value }) => !Number.isFinite(value.usedPercent) || value.usedPercent < 0 || value.usedPercent > 100 ||
    (value.resetsAt !== null && (!Number.isSafeInteger(value.resetsAt) || value.resetsAt < 0)))) return null;
  const windows = reportedWindows;
  if (!windows.length) return null;
  return windows.map(({ window, value }) => ({ window, percent: 100 - value.usedPercent }))
    .sort((a, b) => a.percent - b.percent || a.window.localeCompare(b.window))[0] ?? null;
}

export interface BalanceDecision { targetId: string; evidence: MigrationEvidence; }

export function chooseAutoBalance(
  engine: MigrationEngine,
  activeId: string,
  observations: QuotaObservation[],
  policy: AutoBalancePolicy,
  now = Date.now(),
): BalanceDecision | null {
  if (!policy.enabled || (policy.cooldownUntil && Date.parse(policy.cooldownUntil) > now)) return null;
  const active = observations.find((item) => item.engine === engine && item.accountId === activeId);
  const activeRemaining = active && effectiveRemaining(active, now);
  if (!active || !activeRemaining || activeRemaining.percent >= AUTO_BALANCE_THRESHOLD) return null;
  const candidates = observations.flatMap((item) => {
    if (item.engine !== engine || item.accountId === activeId) return [];
    const remaining = effectiveRemaining(item, now);
    const departedAt = policy.departed[item.accountId] ? Date.parse(policy.departed[item.accountId]) : 0;
    const returnBlocked = departedAt > 0 && now - departedAt < AUTO_BALANCE_RETURN_WINDOW_MS && (remaining?.percent ?? 0) <= AUTO_BALANCE_RETURN_ERC;
    return remaining && remaining.percent > AUTO_BALANCE_THRESHOLD && !returnBlocked ? [{ item, remaining }] : [];
  }).sort((a, b) => b.remaining.percent - a.remaining.percent || a.item.accountId.localeCompare(b.item.accountId));
  const winner = candidates[0];
  if (!winner) return null;
  return { targetId: winner.item.accountId, evidence: { sourceId: activeId, sourcePercent: activeRemaining.percent, sourceWindow: activeRemaining.window, targetId: winner.item.accountId, targetPercent: winner.remaining.percent, targetWindow: winner.remaining.window, observedAt: new Date(now).toISOString() } };
}
