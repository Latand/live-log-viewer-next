import type { DurableQuotaObservation } from "./migration/contracts";

const FRESH_QUOTA_MS = 5 * 60 * 1_000;

export type HeadlessAccountSelection =
  | { kind: "available"; accountId: string }
  | { kind: "exhausted"; resetsAt: number | null }
  | { kind: "unavailable" };

type SelectableAccount = { id: string; authPresent: boolean };

type Capacity =
  | { kind: "available"; remaining: number }
  | { kind: "exhausted"; resetsAt: number | null }
  | { kind: "unavailable" }
  | { kind: "unknown" };

function capacity(observation: DurableQuotaObservation | undefined, now: number): Capacity {
  if (!observation || observation.provenance.source !== "live") return { kind: "unknown" };
  const observedAt = Date.parse(observation.observedAt);
  const authCheckedAt = Date.parse(observation.authCheckedAt);
  if (!Number.isFinite(observedAt) || !Number.isFinite(authCheckedAt) || now < observedAt || now < authCheckedAt || now - observedAt > FRESH_QUOTA_MS || now - authCheckedAt > FRESH_QUOTA_MS) {
    return { kind: "unknown" };
  }
  if (!observation.authenticated) return { kind: "unavailable" };
  if (!observation.limits) return { kind: "unknown" };
  const windows = [observation.limits.session, observation.limits.weekly].filter((window) => window !== null);
  if (!windows.length || windows.some((window) => !Number.isFinite(window.usedPercent) || window.usedPercent < 0 || window.usedPercent > 100 || (window.resetsAt !== null && (!Number.isSafeInteger(window.resetsAt) || window.resetsAt < 0)))) {
    return { kind: "unknown" };
  }
  const remaining = Math.min(...windows.map((window) => 100 - window.usedPercent));
  if (remaining > 0) return { kind: "available", remaining };
  const exhaustedWindows = windows.filter((window) => window.usedPercent >= 100);
  const nowSeconds = Math.floor(now / 1_000);
  if (exhaustedWindows.some((window) => window.resetsAt === null || window.resetsAt <= nowSeconds)) return { kind: "exhausted", resetsAt: null };
  return { kind: "exhausted", resetsAt: Math.max(...exhaustedWindows.map((window) => window.resetsAt!)) };
}

/**
 * Selects an authenticated account for an unattended spawn. Confirmed fresh
 * headroom wins, then an account whose quota is unknown. Exhaustion is only
 * reported when every authenticated account has a fresh zero-capacity sample.
 */
export function selectHeadlessAccount(
  accounts: SelectableAccount[],
  observations: DurableQuotaObservation[],
  preferredId: string | null | undefined,
  excludedIds: string[],
  now = Date.now(),
): HeadlessAccountSelection {
  const byAccount = new Map(observations.map((observation) => [observation.accountId, observation]));
  const excluded = new Set(excludedIds);
  const candidates = accounts
    .filter((account) => account.authPresent)
    .map((account) => ({ account, capacity: capacity(byAccount.get(account.id), now) }))
    .filter((candidate) => candidate.capacity.kind !== "unavailable");
  if (!candidates.length) return { kind: "unavailable" };
  for (const attempted of [false, true]) {
    const tier = candidates.filter((candidate) => excluded.has(candidate.account.id) === attempted);
    const available = tier
      .flatMap((candidate) => candidate.capacity.kind === "available" ? [{ ...candidate, remaining: candidate.capacity.remaining }] : [])
      .sort((left, right) => right.remaining - left.remaining || Number(right.account.id === preferredId) - Number(left.account.id === preferredId) || left.account.id.localeCompare(right.account.id));
    if (available[0]) return { kind: "available", accountId: available[0].account.id };
    const unknown = tier
      .filter((candidate) => candidate.capacity.kind === "unknown")
      .sort((left, right) => Number(right.account.id === preferredId) - Number(left.account.id === preferredId) || left.account.id.localeCompare(right.account.id));
    if (unknown[0]) return { kind: "available", accountId: unknown[0].account.id };
  }
  const resets = candidates.flatMap((candidate) => candidate.capacity.kind === "exhausted" && candidate.capacity.resetsAt !== null ? [candidate.capacity.resetsAt] : []);
  return { kind: "exhausted", resetsAt: resets.length ? Math.min(...resets) : null };
}
