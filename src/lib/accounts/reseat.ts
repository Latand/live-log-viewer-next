import type { DurableQuotaObservation } from "@/lib/accounts/migration/contracts";
import { AUTO_BALANCE_THRESHOLD, effectiveRemaining } from "@/lib/accounts/migration/quotaPolicy";

/** A healthy successor account for a one-click reseat (issue #97). */
export interface ReseatTarget {
  accountId: string;
  label: string;
  remainingPercent: number;
  window: "session" | "weekly";
}

/**
 * Picks the healthiest known account to reseat a rate-limited conversation
 * onto. Conservative on purpose: only accounts with a fresh, live,
 * authenticated quota observation and real headroom (above the auto-balance
 * threshold) qualify — a stale or unknown account is never chosen, the
 * operator resolves those through the Accounts panel (#40). Returns `null`
 * when no such account exists.
 */
export function chooseReseatTarget(
  currentAccountId: string,
  observations: readonly DurableQuotaObservation[],
  accounts: readonly { id: string; label: string }[],
  now = Date.now(),
): ReseatTarget | null {
  const labels = new Map(accounts.map((account) => [account.id, account.label] as const));
  const candidates = observations.flatMap((observation) => {
    if (observation.accountId === currentAccountId) return [];
    const label = labels.get(observation.accountId);
    if (label === undefined) return [];
    const remaining = effectiveRemaining({
      engine: observation.engine,
      accountId: observation.accountId,
      authenticated: observation.authenticated,
      limits: observation.limits,
      provenance: observation.provenance,
      observedAt: Date.parse(observation.observedAt),
      authCheckedAt: Date.parse(observation.authCheckedAt),
    }, now);
    if (!remaining || remaining.percent <= AUTO_BALANCE_THRESHOLD) return [];
    return [{ accountId: observation.accountId, label, remainingPercent: remaining.percent, window: remaining.window }];
  });
  return candidates.sort((left, right) =>
    right.remainingPercent - left.remainingPercent || left.accountId.localeCompare(right.accountId))[0] ?? null;
}
