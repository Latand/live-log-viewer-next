import type { DurableQuotaObservation } from "@/lib/accounts/migration/contracts";
import { providerThrottleState } from "@/lib/limitsThrottle";
import { rateLimitFromQuotaObservation } from "@/lib/rateLimit";
import type { LimitsProvenance } from "@/lib/types";

/** Why the provider cannot take a turn on an account right now: a rejection it
    asked us to retry after, or a quota window it has exhausted. */
export type AccountParkReason = "provider_throttled" | "quota_exhausted";

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
  /** ISO instant the park lapses at: the provider's own retry deadline, or the
      reset of the exhausted window. An exhaustion with no knowable reset is
      NOT reported — a hold whose end nobody can name is the unwatched wait
      this predicate exists to prevent. */
  until: string;
}

export interface AccountParkSources {
  /** The account's durable quota observation, as the registry recorded it. */
  quotaObservation: (engine: "claude" | "codex", accountId: string) => DurableQuotaObservation | undefined;
  /** The account's newest limits provenance. */
  limitsProvenance: (engine: "claude" | "codex", accountId: string) => LimitsProvenance | null;
  now?: number;
}

/**
 * Whether the provider has parked `accountId`, and until when. The two
 * readings are kept apart on purpose: a provider throttle is a scheduled
 * request-frequency wait, while an exhausted quota window is the account
 * having spent its allowance — the state a builder sits in at a quota-warning
 * prompt. Either one means a turn sent now cannot start.
 */
export function accountPark(
  engine: "claude" | "codex",
  accountId: string | null,
  sources: AccountParkSources,
): AccountPark | null {
  if (!accountId) return null;
  const now = sources.now ?? Date.now();
  const throttle = providerThrottleState(sources.limitsProvenance(engine, accountId), now);
  if (throttle) return { reason: "provider_throttled", accountId, until: throttle.retryAt };
  const exhausted = rateLimitFromQuotaObservation(sources.quotaObservation(engine, accountId), now);
  if (exhausted && exhausted.resetAt !== null) {
    return { reason: "quota_exhausted", accountId, until: new Date(exhausted.resetAt * 1_000).toISOString() };
  }
  return null;
}
