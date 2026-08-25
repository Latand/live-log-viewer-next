import { expect, test } from "bun:test";

import { classifySpawnAccountAdmission } from "./accountLiveness";

const NOW = Date.parse("2026-08-23T15:00:00.000Z");

test("spawn admission distinguishes last-known stale evidence from affirmative unavailability", () => {
  const retryAt = "2026-08-23T15:30:00.000Z";

  expect(classifySpawnAccountAdmission({
    enabled: true,
    authentication: "unknown",
    limits: "unknown",
    stale: true,
    retryAt,
  }, NOW)).toEqual({
    kind: "admissible",
    basis: "last-known",
    stale: true,
    retryAt: null,
  });

  expect(classifySpawnAccountAdmission({
    enabled: true,
    authentication: "authenticated",
    limits: "exhausted",
    stale: false,
    retryAt,
  }, NOW)).toEqual({
    kind: "retry-at",
    reason: "hard-limit",
    stale: false,
    retryAt,
  });

  expect(classifySpawnAccountAdmission({
    enabled: true,
    authentication: "failed",
    limits: "unknown",
    stale: false,
    retryAt: null,
  }, NOW)).toEqual({
    kind: "unavailable",
    reason: "auth-failed",
    stale: false,
    retryAt: null,
  });

  expect(classifySpawnAccountAdmission({
    enabled: false,
    authentication: "authenticated",
    limits: "available",
    stale: false,
    retryAt: null,
  }, NOW)).toEqual({
    kind: "unavailable",
    reason: "account-disabled",
    stale: false,
    retryAt: null,
  });
});
