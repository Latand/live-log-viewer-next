import { expect, test } from "bun:test";

import type { DurableQuotaObservation } from "@/lib/accounts/migration/contracts";
import { LIMITS_RATE_LIMITED_REASON } from "@/lib/types";

import { accountPark } from "./accountPark";

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
  });
});

test("a provider rejection parks the account until the deadline it asked for", () => {
  const retryAt = new Date(NOW + 120_000).toISOString();

  expect(accountPark("claude", "builder-account", sources({
    limitsProvenance: () => ({ source: "cache", reason: LIMITS_RATE_LIMITED_REASON, staleSince: null, retryAt }),
  }))).toEqual({ reason: "provider_throttled", accountId: "builder-account", until: retryAt });
});

test("an exhaustion with no knowable reset is not a park", () => {
  /* Nothing can say when this one lapses, and a wait nobody can time out is
     the unwatched stall the park predicate exists to prevent. Callers fall
     back to their ordinary behaviour instead. */
  const limits = observation().limits!;
  expect(accountPark("codex", "builder-account", sources({
    quotaObservation: () => observation({
      limits: { ...limits, session: { usedPercent: 100, resetsAt: null }, weekly: null },
    }),
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
