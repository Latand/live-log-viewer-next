import { expect, test } from "bun:test";

import type { DurableQuotaObservation } from "@/lib/accounts/migration/contracts";
import { PROVIDER_THROTTLE_GRACE_MS, providerThrottleState } from "@/lib/limitsThrottle";
import { LIMITS_RATE_LIMITED_REASON } from "@/lib/types";

import { accountPark, UNKNOWN_RESET_RECHECK_MS } from "./accountPark";

const NOW = new Date("2026-08-20T12:00:00.000Z").getTime();
const RESET = Math.floor(NOW / 1_000) + 3_600;

function observation(overrides: Partial<DurableQuotaObservation> = {}): DurableQuotaObservation {
  const iso = new Date(NOW - 30_000).toISOString();
  return {
    engine: "codex",
    accountId: "builder-account",
    authenticated: true,
    authCheckedAt: iso,
    limits: {
      session: { usedPercent: 100, resetsAt: RESET },
      weekly: { usedPercent: 42, resetsAt: RESET + 86_400 },
      plan: "pro",
      capturedAt: Math.floor((NOW - 30_000) / 1_000),
    },
    provenance: { source: "live", reason: null, staleSince: null },
    observedAt: iso,
    bootId: "boot-park",
    ...overrides,
  };
}

function sources(overrides: Partial<Parameters<typeof accountPark>[2]> = {}): Parameters<typeof accountPark>[2] {
  return {
    quotaObservation: () => undefined,
    limitsProvenance: () => null,
    now: NOW,
    ...overrides,
  };
}

test("a spent quota window parks the account until the provider resets it", () => {
  expect(accountPark("codex", "builder-account", sources({
    quotaObservation: () => observation(),
  }))).toEqual({
    reason: "quota_exhausted",
    accountId: "builder-account",
    until: new Date(RESET * 1_000).toISOString(),
    resetKnown: true,
  });
});

test("a provider rejection parks the account until the deadline it asked for", () => {
  const retryAt = new Date(NOW + 120_000).toISOString();

  expect(accountPark("claude", "builder-account", sources({
    limitsProvenance: () => ({ source: "cache", reason: LIMITS_RATE_LIMITED_REASON, staleSince: null, retryAt }),
  }))).toEqual({ reason: "provider_throttled", accountId: "builder-account", until: retryAt, resetKnown: true });
});

/** The spent window the provider named no reset for: the reading is live and
    30s old, so it is evidence right now and stops being evidence a freshness
    horizon later. */
function unknownResetObservation(): DurableQuotaObservation {
  const limits = observation().limits!;
  return observation({
    limits: { ...limits, session: { usedPercent: 100, resetsAt: null }, weekly: null },
  });
}

const UNKNOWN_RESET_RECHECK = new Date(NOW - 30_000 + UNKNOWN_RESET_RECHECK_MS + 1).toISOString();

test("issue 611: an exhaustion with no knowable reset withholds work on a bounded recheck", () => {
  /* The third answer the two earlier readings both missed. Reporting nothing
     would hand back a live host whose account is spent — the incident — and
     reporting a park with no end would be the unwatched wait wearing a
     different coat. What this is: a park the caller must withhold work for,
     whose deadline is the instant its own evidence expires, and which says the
     provider named no reset. */
  const park = accountPark("codex", "builder-account", sources({
    quotaObservation: unknownResetObservation,
  }));

  expect(park).toEqual({
    reason: "quota_exhausted",
    accountId: "builder-account",
    until: UNKNOWN_RESET_RECHECK,
    resetKnown: false,
  });
  /* Bounded in both senses: the wait is ahead of the caller rather than an
     already-spent deadline it would re-decide every tick, and it is at most one
     freshness horizon long. */
  expect(Date.parse(park!.until)).toBeGreaterThan(NOW);
  expect(Date.parse(park!.until) - NOW).toBeLessThanOrEqual(UNKNOWN_RESET_RECHECK_MS);
});

test("issue 611: the unknown-reset wait ends at its own recheck, with no fresher reading and nobody's help", () => {
  /* This is what makes it a recheck rather than a hold nobody can time out:
     the very same reading stops being evidence at the instant the park named,
     so the wait lapses on its own. A reading the account controller renews
     re-parks it — against fresh evidence, and with a fresh deadline. */
  const stuck = unknownResetObservation();

  expect(accountPark("codex", "builder-account", sources({
    quotaObservation: () => stuck,
    now: Date.parse(UNKNOWN_RESET_RECHECK),
  }))).toBeNull();
});

test("a stale quota reading is not evidence that the provider parked anything", () => {
  const stale = new Date(NOW - 10 * 60_000).toISOString();

  expect(accountPark("codex", "builder-account", sources({
    quotaObservation: () => observation({ observedAt: stale, authCheckedAt: stale }),
  }))).toBeNull();
});

test("a lapsed retry deadline and a healthy account are both unparked", () => {
  expect(accountPark("codex", "builder-account", sources({
    limitsProvenance: () => ({
      source: "cache",
      reason: LIMITS_RATE_LIMITED_REASON,
      staleSince: null,
      retryAt: new Date(NOW - 10 * 60_000).toISOString(),
    }),
    quotaObservation: () => observation({
      limits: { ...observation().limits!, session: { usedPercent: 12, resetsAt: RESET } },
    }),
  }))).toBeNull();
  expect(accountPark("codex", null, sources())).toBeNull();
});

test("issue 611: publish readiness resumes at the provider's deadline, while liveness keeps its grace", () => {
  const retryAtMs = NOW + 120_000;
  const retryAt = new Date(retryAtMs).toISOString();
  const provenance = {
    source: "cache" as const,
    reason: LIMITS_RATE_LIMITED_REASON,
    staleSince: null,
    retryAt,
  };
  const parkAt = (now: number) => accountPark("claude", "builder-account", sources({
    limitsProvenance: () => provenance,
    now,
  }));

  /* Before the deadline: parked, with the deadline the provider named. */
  expect(parkAt(retryAtMs - 1)).toEqual({
    reason: "provider_throttled",
    accountId: "builder-account",
    until: retryAt,
    resetKnown: true,
  });
  /* At it and past it: ready. Inheriting the liveness grace here returned a
     park whose `until` was already in the past, so every probe inside the
     grace re-decided the same withholding against a spent deadline. */
  expect(parkAt(retryAtMs)).toBeNull();
  expect(parkAt(retryAtMs + 1)).toBeNull();
  expect(parkAt(retryAtMs + PROVIDER_THROTTLE_GRACE_MS)).toBeNull();

  /* The grace itself is untouched — it still explains a quiet host for one
     refresh cadence, which is the liveness question it was written for. */
  expect(providerThrottleState(provenance, retryAtMs + 1)).toEqual({ reason: "provider_throttled", retryAt });
  expect(providerThrottleState(provenance, retryAtMs + PROVIDER_THROTTLE_GRACE_MS)).toEqual({
    reason: "provider_throttled",
    retryAt,
  });
  expect(providerThrottleState(provenance, retryAtMs + PROVIDER_THROTTLE_GRACE_MS + 1)).toBeNull();
});
