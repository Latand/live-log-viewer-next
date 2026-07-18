import { expect, test } from "bun:test";

import type { DurableQuotaObservation } from "@/lib/accounts/migration/contracts";

import { chooseReseatTarget } from "./reseat";

const NOW = Date.parse("2026-07-10T18:00:00.000Z");

function observation(accountId: string, usedPercent: number, over: Partial<DurableQuotaObservation> = {}): DurableQuotaObservation {
  return {
    engine: "codex",
    accountId,
    authenticated: true,
    authCheckedAt: "2026-07-10T17:59:00.000Z",
    limits: { session: { usedPercent, resetsAt: null }, weekly: null, plan: null, capturedAt: null },
    provenance: { source: "live", reason: null, staleSince: null },
    observedAt: "2026-07-10T17:59:00.000Z",
    bootId: "boot",
    ...over,
  };
}

const ACCOUNTS = [
  { id: "limited", label: "Main" },
  { id: "backup", label: "Backup" },
  { id: "spare", label: "Spare" },
];

test("the healthiest known account wins and the exhausted source is excluded", () => {
  const target = chooseReseatTarget("limited", [
    observation("limited", 100),
    observation("backup", 40),
    observation("spare", 10),
  ], ACCOUNTS, NOW);

  expect(target).toEqual({ accountId: "spare", label: "Spare", remainingPercent: 90, window: "session" });
});

test("stale, unauthenticated, thresholded, or unknown accounts never qualify", () => {
  expect(chooseReseatTarget("limited", [
    observation("backup", 40, { observedAt: "2026-07-10T17:00:00.000Z" }),
  ], ACCOUNTS, NOW)).toBeNull();
  expect(chooseReseatTarget("limited", [
    observation("backup", 40, { authenticated: false }),
  ], ACCOUNTS, NOW)).toBeNull();
  expect(chooseReseatTarget("limited", [
    observation("backup", 80),
  ], ACCOUNTS, NOW)).toBeNull();
  expect(chooseReseatTarget("limited", [
    observation("removed-account", 10),
  ], ACCOUNTS, NOW)).toBeNull();
});
