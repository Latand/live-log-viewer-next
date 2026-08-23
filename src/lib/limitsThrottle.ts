import { LIMITS_RATE_LIMITED_REASON, type LimitsProvenance } from "@/lib/types";

/** A provider retry deadline is an estimate. Give the provider one ordinary
    refresh cadence to release the request before silence becomes a real stall. */
export const PROVIDER_THROTTLE_GRACE_MS = 60_000;

/** The retry deadline while a limits rejection still explains provider-side
    silence. Once the bounded grace passes, callers resume ordinary stall
    classification even when an old cache entry has not refreshed yet. */
export function providerThrottleRetryAt(
  provenance: LimitsProvenance | null | undefined,
  now: number = Date.now(),
  graceMs: number = PROVIDER_THROTTLE_GRACE_MS,
): string | null {
  if (provenance?.reason !== LIMITS_RATE_LIMITED_REASON || !provenance.retryAt) return null;
  const retryAt = Date.parse(provenance.retryAt);
  if (!Number.isFinite(retryAt)) return null;
  const grace = Number.isFinite(graceMs) ? Math.max(0, graceMs) : PROVIDER_THROTTLE_GRACE_MS;
  if (now > retryAt + grace) return null;
  return new Date(retryAt).toISOString();
}
