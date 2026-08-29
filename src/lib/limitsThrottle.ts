import { LIMITS_RATE_LIMITED_REASON, type LimitsProvenance } from "@/lib/types";

/** A provider retry deadline is an estimate. Give the provider one ordinary
    refresh cadence to release the request before silence becomes a real stall. */
export const PROVIDER_THROTTLE_GRACE_MS = 60_000;

export interface ProviderThrottleState {
  reason: "provider_throttled";
  /** Normalized provider retry deadline. */
  retryAt: string;
}

/** The provider's retry deadline as milliseconds, or null when this provenance
    carries no usable one. */
function retryDeadline(provenance: LimitsProvenance | null | undefined): number | null {
  if (provenance?.reason !== LIMITS_RATE_LIMITED_REASON || !provenance.retryAt) return null;
  const retryAt = Date.parse(provenance.retryAt);
  return Number.isFinite(retryAt) ? retryAt : null;
}

/** The retry deadline while a limits rejection still explains provider-side
    silence. Once the bounded grace passes, callers resume ordinary stall
    classification even when an old cache entry has not refreshed yet.
    LIVENESS ONLY: the grace answers "does a rejection still explain this
    quiet host", which is a classification question. Whether a turn may be
    SENT is `providerThrottleAdmission` below, and it has no grace. */
export function providerThrottleRetryAt(
  provenance: LimitsProvenance | null | undefined,
  now: number = Date.now(),
  graceMs: number = PROVIDER_THROTTLE_GRACE_MS,
): string | null {
  const retryAt = retryDeadline(provenance);
  if (retryAt === null) return null;
  const grace = Number.isFinite(graceMs) ? Math.max(0, graceMs) : PROVIDER_THROTTLE_GRACE_MS;
  if (now > retryAt + grace) return null;
  return new Date(retryAt).toISOString();
}

export function providerThrottleState(
  provenance: LimitsProvenance | null | undefined,
  now: number = Date.now(),
  graceMs: number = PROVIDER_THROTTLE_GRACE_MS,
): ProviderThrottleState | null {
  const retryAt = providerThrottleRetryAt(provenance, now, graceMs);
  return retryAt ? { reason: "provider_throttled", retryAt } : null;
}

/**
 * The retry deadline as an ADMISSION gate: it governs strictly before the
 * instant the provider named, and not at or after it.
 *
 * The liveness grace above is deliberately not applied here. It exists so a
 * host that looks stalled is still explained for one refresh cadence past the
 * deadline; borrowing it to decide whether a turn may be sent withholds work
 * for a minute past the moment the provider itself said to retry, and — since
 * the deadline it reports is by then already in the past — re-decides the same
 * withholding on every tick until the grace runs out. Admission resumes at the
 * provider's own deadline.
 */
export function providerThrottleAdmission(
  provenance: LimitsProvenance | null | undefined,
  now: number = Date.now(),
): ProviderThrottleState | null {
  const retryAt = retryDeadline(provenance);
  if (retryAt === null || now >= retryAt) return null;
  return { reason: "provider_throttled", retryAt: new Date(retryAt).toISOString() };
}
