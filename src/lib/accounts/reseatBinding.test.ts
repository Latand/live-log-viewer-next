import { expect, test } from "bun:test";

import type { DurableQuotaObservation } from "@/lib/accounts/migration/contracts";
import { chooseProjectReseatTarget } from "@/lib/accounts/reseat";

/**
 * #1279 at the reseat seam: moving a rate-limited conversation onto a healthier
 * account is a selection for that conversation's project's work, so it draws
 * from the project's allowed set like every launch does.
 *
 * Account ids here are invented; nothing in this file names a real account.
 */

const NOW = Date.parse("2026-07-10T18:00:00.000Z");

const ACCOUNTS = [
  { id: "acct-alpha", label: "account A" },
  { id: "acct-beta", label: "account B" },
  { id: "acct-gamma", label: "account C" },
];

/** Same shape the reseat suite beside this one uses; `usedPercent` is usage,
    so a low number is an account with headroom. */
function observation(accountId: string, usedPercent: number): DurableQuotaObservation {
  return {
    engine: "claude",
    accountId,
    authenticated: true,
    authCheckedAt: "2026-07-10T17:59:00.000Z",
    limits: { session: { usedPercent, resetsAt: null }, weekly: null, plan: null, capturedAt: null },
    provenance: { source: "live", reason: null, staleSince: null },
    observedAt: "2026-07-10T17:59:00.000Z",
    bootId: "boot",
  };
}

test("an unbound project reseats exactly as it always did", () => {
  const selection = chooseProjectReseatTarget(
    "acct-alpha",
    [observation("acct-alpha", 98), observation("acct-beta", 20)],
    ACCOUNTS,
    null,
    NOW,
  );
  expect(selection.kind).toBe("target");
  expect(selection.kind === "target" ? selection.target.accountId : null).toBe("acct-beta");
});

test("switching inside the allowed set stays automatic", () => {
  const selection = chooseProjectReseatTarget(
    "acct-alpha",
    [observation("acct-alpha", 98), observation("acct-beta", 20), observation("acct-gamma", 5)],
    ACCOUNTS,
    ["acct-alpha", "acct-beta"],
    NOW,
  );
  /* Gamma has the most headroom of all three and is still not chosen: the
     allowed set is the candidate list, not a preference over one. */
  expect(selection.kind === "target" ? selection.target.accountId : null).toBe("acct-beta");
});

test("regression: the only allowed account throttled and an unbound account idle — no switch, the refusal is reported", () => {
  const selection = chooseProjectReseatTarget(
    "acct-alpha",
    [observation("acct-alpha", 99), observation("acct-gamma", 1)],
    ACCOUNTS,
    ["acct-alpha"],
    NOW,
  );
  expect(selection.kind).toBe("fenced");
  expect(selection.kind === "fenced" ? selection.allowedAccountIds : []).toEqual(["acct-alpha"]);
});

test("a project bound to accounts the catalog no longer holds is fenced, not opened", () => {
  const selection = chooseProjectReseatTarget(
    "acct-alpha",
    [observation("acct-gamma", 1)],
    ACCOUNTS,
    ["acct-retired"],
    NOW,
  );
  expect(selection.kind).toBe("fenced");
});

test("a bound project with no healthy successor is reported as fenced, never as today's bare answer", () => {
  const bound = chooseProjectReseatTarget("acct-alpha", [observation("acct-alpha", 99)], ACCOUNTS, ["acct-alpha", "acct-beta"], NOW);
  const unbound = chooseProjectReseatTarget("acct-alpha", [observation("acct-alpha", 99)], ACCOUNTS, null, NOW);
  /* Same shortage, two different answers on purpose: one names the fence the
     operator configured, the other is the shortage that has always existed. */
  expect(bound.kind).toBe("fenced");
  expect(unbound.kind).toBe("none");
});
