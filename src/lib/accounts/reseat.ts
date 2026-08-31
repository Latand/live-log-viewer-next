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

/** What #1279's binding decides for one reseat, before any migration starts. */
export type ProjectReseatSelection =
  | { kind: "target"; target: ReseatTarget }
  /** No healthy successor, and no binding was involved — today's answer. */
  | { kind: "none" }
  /** The project is bound and none of the accounts it allows has headroom.
      The caller REPORTS this; the idle account next door is not a candidate,
      and reseating onto it is the boundary crossing the binding prevents. */
  | { kind: "fenced"; allowedAccountIds: string[] };

/**
 * The same choice as `chooseReseatTarget`, fenced by the project's allowed set.
 *
 * `allowedAccountIds` null is a project with no binding, and takes the byte-
 * identical path this has always taken. A bound project draws its successor
 * from its allowed set only — which is what makes a reseat under rate-limit
 * pressure obey the same rule a launch does, rather than being the one switch
 * that could still cross the line.
 */
export function chooseProjectReseatTarget(
  currentAccountId: string,
  observations: readonly DurableQuotaObservation[],
  accounts: readonly { id: string; label: string }[],
  allowedAccountIds: readonly string[] | null,
  now = Date.now(),
): ProjectReseatSelection {
  const candidates = allowedAccountIds === null
    ? accounts
    : accounts.filter((account) => allowedAccountIds.includes(account.id));
  const target = chooseReseatTarget(currentAccountId, observations, candidates, now);
  if (target) return { kind: "target", target };
  return allowedAccountIds === null
    ? { kind: "none" }
    : { kind: "fenced", allowedAccountIds: [...allowedAccountIds] };
}
