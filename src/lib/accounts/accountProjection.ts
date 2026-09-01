import type { DurableQuotaObservation } from "@/lib/accounts/migration/contracts";
import { AUTO_BALANCE_FRESH_MS, effectiveRemaining } from "@/lib/accounts/migration/quotaPolicy";

/**
 * The per-account block `GET /api/accounts` sends for one durable quota
 * observation: auth state, the quota windows, and (issue #1373) the reset
 * credits the account held when it was last read. The per-account re-read
 * (#1418) and the reset-credit redemption (#1373) answer with the same block,
 * so the panel merges one card from any of the three without a second parse.
 */

export function currentObservation(observation: DurableQuotaObservation | undefined, now: number): boolean {
  if (!observation) return false;
  const observedAge = now - Date.parse(observation.observedAt);
  const authAge = now - Date.parse(observation.authCheckedAt);
  return Number.isFinite(observedAge) && Number.isFinite(authAge)
    && observedAge >= 0 && authAge >= 0
    && observedAge <= AUTO_BALANCE_FRESH_MS && authAge <= AUTO_BALANCE_FRESH_MS;
}

export function currentLiveObservation(observation: DurableQuotaObservation | undefined, now: number): boolean {
  return observation?.provenance.source === "live" && currentObservation(observation, now);
}

export function liveFreshObservation(observation: DurableQuotaObservation | undefined, now: number): boolean {
  return observation?.authenticated === true && currentLiveObservation(observation, now);
}

export type AccountAuthState = "authenticated" | "signed_out" | "unknown" | "error";

export interface AccountObservationProjection {
  auth: { state: AccountAuthState; method: null; email: null; plan: string | null; checkedAt: string | null };
  limits: {
    state: "fresh" | "stale" | "unavailable";
    session: NonNullable<DurableQuotaObservation["limits"]>["session"];
    weekly: NonNullable<DurableQuotaObservation["limits"]>["weekly"];
    /** The flagship tier's weekly window when the account reports one (#1358). */
    flagship: NonNullable<DurableQuotaObservation["limits"]>["flagship"] | null;
    checkedAt: string | null;
  };
  /** Usage-limit reset credits at the last read (#1373); null until a read
      that carried the summary has happened. */
  resetCredits: { availableCount: number; expiresAt: number | null } | null;
  effective: { percent: number; window: string; freshness: "fresh" | "stale" } | null;
}

export function accountProjection(observation: DurableQuotaObservation | undefined, authPresent: boolean, now: number): AccountObservationProjection {
  const eligible = liveFreshObservation(observation, now);
  const authCurrent = currentObservation(observation, now);
  const reauthenticationRequired = authCurrent && observation?.provenance.reason === "oauth-reauthentication-required";
  let authState: AccountAuthState = "unknown";
  if (eligible) authState = "authenticated";
  else if (!authPresent || reauthenticationRequired) authState = "signed_out";
  else if (authCurrent && observation?.authenticated === false) {
    authState = observation.provenance.source === "live" ? "signed_out" : "error";
  }
  const effective = observation ? effectiveRemaining({
    engine: observation.engine,
    accountId: observation.accountId,
    authenticated: observation.authenticated,
    limits: observation.limits,
    provenance: observation.provenance,
    observedAt: Date.parse(observation.observedAt),
    authCheckedAt: Date.parse(observation.authCheckedAt),
  }, now) : null;
  return {
    auth: {
      state: authState,
      method: null,
      email: null,
      plan: observation?.limits?.plan ?? null,
      checkedAt: observation?.authCheckedAt ?? null,
    },
    limits: {
      state: eligible ? "fresh" : observation?.limits ? "stale" : "unavailable",
      session: observation?.limits?.session ?? null,
      weekly: observation?.limits?.weekly ?? null,
      flagship: observation?.limits?.flagship ?? null,
      checkedAt: observation?.observedAt ?? null,
    },
    resetCredits: observation?.resetCredits ?? null,
    // No client parses this block any more — every capacity chip is reconciled
    // from the window rows above. Dropping it from the wire is a route change
    // this lane is scoped away from (issue #1018 follow-up).
    effective: effective ? { ...effective, freshness: eligible ? "fresh" : "stale" } : null,
  };
}
