import { expect, test } from "bun:test";

import type { DurableQuotaObservation } from "./migration/contracts";
import { selectHeadlessAccount } from "./headlessSelection";

const NOW = Date.parse("2026-07-12T10:00:00.000Z");

function observation(accountId: string, usedPercent: number, resetsAt: number | null = null): DurableQuotaObservation {
  return {
    engine: "codex",
    accountId,
    authenticated: true,
    authCheckedAt: new Date(NOW - 1_000).toISOString(),
    limits: {
      session: { usedPercent, resetsAt },
      weekly: null,
      plan: "pro",
      capturedAt: Math.floor((NOW - 1_000) / 1_000),
    },
    provenance: { source: "live", reason: null, staleSince: null },
    observedAt: new Date(NOW - 1_000).toISOString(),
    bootId: "00000000-0000-4000-8000-000000000117",
  };
}

const accounts = [
  { id: "default", authPresent: true },
  { id: "spare", authPresent: true },
];

test("headless selection chooses the authenticated account with the most fresh quota headroom", () => {
  expect(selectHeadlessAccount(accounts, [observation("default", 100), observation("spare", 25)], "default", [], NOW)).toEqual({
    kind: "available",
    accountId: "spare",
  });
});

test("headless selection uses an unobserved account before declaring confirmed exhaustion", () => {
  expect(selectHeadlessAccount(accounts, [observation("default", 100)], "default", [], NOW)).toEqual({
    kind: "available",
    accountId: "spare",
  });
});

test("headless selection reports the earliest account recovery when every account is exhausted", () => {
  const firstReset = Math.floor(NOW / 1_000) + 900;
  const secondReset = Math.floor(NOW / 1_000) + 1_800;
  expect(selectHeadlessAccount(accounts, [observation("default", 100, secondReset), observation("spare", 100, firstReset)], null, [], NOW)).toEqual({
    kind: "exhausted",
    resetsAt: firstReset,
  });
});

test("headless selection keeps reset unknown when any exhausted governing window lacks a reset", () => {
  const reset = Math.floor(NOW / 1_000) + 900;
  const mixedReset = observation("default", 100, reset);
  mixedReset.limits!.weekly = { usedPercent: 100, resetsAt: null };
  expect(selectHeadlessAccount([accounts[0]!], [mixedReset], "default", [], NOW)).toEqual({
    kind: "exhausted",
    resetsAt: null,
  });
});

test("headless selection keeps reset unknown when exhausted evidence names an expired reset", () => {
  const expiredReset = Math.floor(NOW / 1_000) - 1;
  expect(selectHeadlessAccount([accounts[0]!], [observation("default", 100, expiredReset)], "default", [], NOW)).toEqual({
    kind: "exhausted",
    resetsAt: null,
  });
});

test("headless retry prefers an eligible account that has not already failed", () => {
  expect(selectHeadlessAccount(accounts, [observation("default", 20), observation("spare", 30)], "default", ["default"], NOW)).toEqual({
    kind: "available",
    accountId: "spare",
  });
});

test("headless retry chooses an untried unknown-capacity account before a tried account with known headroom", () => {
  expect(selectHeadlessAccount(accounts, [observation("default", 20)], "default", ["default"], NOW)).toEqual({
    kind: "available",
    accountId: "spare",
  });
});

test("headless selection distinguishes missing authentication from exhausted quota", () => {
  expect(selectHeadlessAccount([{ id: "default", authPresent: false }], [], "default", [], NOW)).toEqual({ kind: "unavailable" });
});

test("headless selection excludes fresh live signed-out evidence even when credentials remain on disk", () => {
  const signedOut = { ...observation("default", 20), authenticated: false };
  expect(selectHeadlessAccount(accounts, [signedOut], "default", [], NOW)).toEqual({
    kind: "available",
    accountId: "spare",
  });
});
