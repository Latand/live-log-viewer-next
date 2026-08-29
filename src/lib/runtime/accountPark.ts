import type { DurableQuotaObservation } from "@/lib/accounts/migration/contracts";
import { AUTO_BALANCE_FRESH_MS } from "@/lib/accounts/migration/quotaPolicy";
import { providerThrottleAdmission } from "@/lib/limitsThrottle";
import { rateLimitFromQuotaObservation } from "@/lib/rateLimit";
import type { LimitsProvenance } from "@/lib/types";

/** Why the provider cannot take a turn on an account right now: a rejection it
    asked us to retry after, or a quota window it has exhausted. */
export type AccountParkReason = "provider_throttled" | "quota_exhausted";

/**
 * How long an exhaustion the provider gave no reset for can be evidence: the
 * same freshness horizon the quota policy applies to the reading itself
 * (`effectiveRemaining`). Past it the reading no longer answers, so the park
 * lapses on its own even if nothing new is ever observed — which is what makes
 * an unknown-reset wait bounded rather than open-ended (#611).
 */
export const UNKNOWN_RESET_RECHECK_MS = AUTO_BALANCE_FRESH_MS;

/**
 * An account the provider has parked, and the instant the park lapses (#611).
 *
 * Both readings are runtime state the Viewer already keeps for its own
 * lifecycle surfaces — the limits reader's newest provenance, and the durable
 * quota observation the account controller writes into the registry. Neither
 * is inferred from transcript prose, so a host parked at a quota-warning
 * prompt is recognized by what the runtime knows rather than by what its
 * transcript happens to say.
 */
export interface AccountPark {
  reason: AccountParkReason;
  accountId: string;
  /** ISO instant this park is next actionable at: the provider's own deadline
      when it named one, and otherwise the bounded recheck below. Always ahead
      of the caller — a deadline already in the past stops being a wait and
      becomes the same decision re-made on every tick. */
  until: string;
  /** Whether `until` is the provider's own deadline. False for an exhausted
      window the provider named no reset for: `until` is then the instant this
      reading stops being evidence, the wait is a bounded recheck of the
      account's state, and every surface must say the reset is unknown instead
      of presenting the recheck as a reset time. */
  resetKnown: boolean;
}

export interface AccountParkSources {
  /** The account's durable quota observation, as the registry recorded it. */
  quotaObservation: (engine: "claude" | "codex", accountId: string) => DurableQuotaObservation | undefined;
  /** The account's newest limits provenance. */
  limitsProvenance: (engine: "claude" | "codex", accountId: string) => LimitsProvenance | null;
  now?: number;
}

/**
 * The instant an exhaustion with no named reset stops speaking for itself: one
 * freshness horizon after the reading was taken. `rateLimitFromQuotaObservation`
 * only reports this exhaustion while `effectiveRemaining` still answers, and
 * that answer requires BOTH the observation and its auth check to be inside
 * `AUTO_BALANCE_FRESH_MS` — so the earlier of the two is when this park ends
 * unless a fresh reading renews it. Both parse finite here, because an
 * exhaustion the caller is holding could not have been reported otherwise.
 */
function unknownResetRecheckAt(observation: DurableQuotaObservation, now: number): string {
  const observedAt = Date.parse(observation.observedAt);
  const authCheckedAt = Date.parse(observation.authCheckedAt);
  const evidenceFrom = Math.min(observedAt, authCheckedAt);
  /* The reading still answers AT the horizon and stops one instant past it, so
     that instant is the recheck: at `until`, this park is gone unless a fresher
     reading renews it. The `now + 1` floor keeps the deadline strictly ahead of
     the caller, because a deadline already reached leaves the wait behind and
     becomes the same decision re-made on every tick. */
  return new Date(Math.max(now + 1, evidenceFrom + UNKNOWN_RESET_RECHECK_MS + 1)).toISOString();
}

/**
 * Whether the provider has parked `accountId`, and until when. The two
 * readings are kept apart on purpose: a provider throttle is a scheduled
 * request-frequency wait, while an exhausted quota window is the account
 * having spent its allowance — the state a builder sits in at a quota-warning
 * prompt. Either one means a turn sent now cannot start.
 *
 * An exhaustion the provider gave no reset for is the third case (#611).
 * Reporting nothing publishes a host whose account is spent, which is the
 * incident itself; reporting a park with no end is the unwatched stall wearing
 * a different coat. So it is reported as a park whose `until` is a bounded
 * recheck and whose `resetKnown` is false: callers withhold work now, say what
 * they are waiting on and that the reset is unknown, and resume the moment the
 * account reads usable again.
 */
export function accountPark(
  engine: "claude" | "codex",
  accountId: string | null,
  sources: AccountParkSources,
): AccountPark | null {
  if (!accountId) return null;
  const now = sources.now ?? Date.now();
  /* This is the admission question, so the liveness grace stays out of it: the
     deadline governs until the provider's own instant and no further. Carrying
     the grace here withheld work for a minute after the provider said to retry,
     and re-decided it every tick against a deadline already spent. */
  const throttle = providerThrottleAdmission(sources.limitsProvenance(engine, accountId), now);
  if (throttle) {
    return { reason: "provider_throttled", accountId, until: throttle.retryAt, resetKnown: true };
  }
  const observation = sources.quotaObservation(engine, accountId);
  if (!observation) return null;
  const exhausted = rateLimitFromQuotaObservation(observation, now);
  if (!exhausted) return null;
  if (exhausted.resetAt !== null) {
    return {
      reason: "quota_exhausted",
      accountId,
      until: new Date(exhausted.resetAt * 1_000).toISOString(),
      resetKnown: true,
    };
  }
  return {
    reason: "quota_exhausted",
    accountId,
    until: unknownResetRecheckAt(observation, now),
    resetKnown: false,
  };
}
