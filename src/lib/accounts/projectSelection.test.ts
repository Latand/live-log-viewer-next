import { expect, test } from "bun:test";

import type { DurableQuotaObservation } from "./migration/contracts";
import type { AccountProjectBinding } from "./projectBindings";
import { selectProjectAccount } from "./projectSelection";

const NOW = Date.parse("2026-08-30T10:00:00.000Z");
const ATLAS = "project-atlas";
const RESERVED = "acct-reserved";
const SPARE = "acct-spare";

const ACCOUNTS = [
  { id: RESERVED, authPresent: true },
  { id: SPARE, authPresent: true },
];

function observation(accountId: string, usedPercent: number, resetsAt: number | null = null): DurableQuotaObservation {
  return {
    engine: "claude",
    accountId,
    authenticated: true,
    authCheckedAt: new Date(NOW - 1_000).toISOString(),
    limits: {
      session: { usedPercent, resetsAt },
      weekly: null,
      plan: "max",
      capturedAt: Math.floor((NOW - 1_000) / 1_000),
    },
    provenance: { source: "live", reason: null, staleSince: null },
    observedAt: new Date(NOW - 1_000).toISOString(),
    bootId: "boot-1279-selection",
  };
}

function binding(accountId: string, project = ATLAS): AccountProjectBinding {
  return { engine: "claude", accountId, project, createdAt: new Date(NOW - 60_000).toISOString() };
}

test("a project with no binding keeps today's answer on both launch paths", () => {
  /* The pipeline seam: the engine's active account, and no capacity arithmetic
     — the throttled sample below is not even consulted. */
  expect(selectProjectAccount({
    project: ATLAS,
    engine: "claude",
    accounts: ACCOUNTS,
    observations: [observation(RESERVED, 100)],
    bindings: [],
    preferredId: RESERVED,
    now: NOW,
  })).toEqual({ kind: "available", accountId: RESERVED });

  /* The reviewer seam: rate-limit-aware across every account, as it always was. */
  expect(selectProjectAccount({
    project: ATLAS,
    engine: "claude",
    accounts: ACCOUNTS,
    observations: [observation(RESERVED, 100), observation(SPARE, 10)],
    bindings: [],
    preferredId: RESERVED,
    unbound: "capacity",
    now: NOW,
  })).toEqual({ kind: "available", accountId: SPARE });
});

test("a bound project draws only from its allowed set, whatever the routing prefers", () => {
  expect(selectProjectAccount({
    project: ATLAS,
    engine: "claude",
    accounts: ACCOUNTS,
    observations: [observation(RESERVED, 40), observation(SPARE, 0)],
    bindings: [binding(RESERVED)],
    /* Routing points at the account with the most headroom, and it is outside
       the set: the preference orders candidates, it does not widen them. */
    preferredId: SPARE,
    now: NOW,
  })).toEqual({ kind: "available", accountId: RESERVED });
});

test("a stage naming an account the project forbids is refused, never reseated", () => {
  expect(selectProjectAccount({
    project: ATLAS,
    engine: "claude",
    accounts: ACCOUNTS,
    observations: [observation(RESERVED, 10)],
    bindings: [binding(RESERVED)],
    requestedId: SPARE,
    now: NOW,
  })).toEqual({ kind: "not_allowed", accountId: SPARE, allowedAccountIds: [RESERVED] });
});

test("a stage naming an allowed account gets it", () => {
  expect(selectProjectAccount({
    project: ATLAS,
    engine: "claude",
    accounts: ACCOUNTS,
    observations: [observation(RESERVED, 90)],
    bindings: [binding(RESERVED), binding(SPARE)],
    requestedId: RESERVED,
    now: NOW,
  })).toEqual({ kind: "available", accountId: RESERVED });
});

/* The acceptance regression, exactly as stated: one project bound to one
   account, that account throttled, an unbound account idle. No switch happens,
   and the refusal is reported. */
test("every allowed account throttled is reported, and the idle unbound account is never chosen", () => {
  const resetsAt = Math.floor(NOW / 1_000) + 1_800;
  expect(selectProjectAccount({
    project: ATLAS,
    engine: "claude",
    accounts: ACCOUNTS,
    observations: [observation(RESERVED, 100, resetsAt), observation(SPARE, 0)],
    bindings: [binding(RESERVED)],
    preferredId: RESERVED,
    now: NOW,
  })).toEqual({ kind: "exhausted", resetsAt, allowedAccountIds: [RESERVED] });

  /* The same inputs with the binding removed DO switch, which is what makes the
     line above a fence rather than an accident of the fixture. */
  expect(selectProjectAccount({
    project: ATLAS,
    engine: "claude",
    accounts: ACCOUNTS,
    observations: [observation(RESERVED, 100, resetsAt), observation(SPARE, 0)],
    bindings: [],
    preferredId: RESERVED,
    unbound: "capacity",
    now: NOW,
  })).toEqual({ kind: "available", accountId: SPARE });
});

test("a project bound to an account the catalog no longer holds refuses instead of falling back", () => {
  expect(selectProjectAccount({
    project: ATLAS,
    engine: "claude",
    accounts: ACCOUNTS,
    observations: [observation(SPARE, 5)],
    bindings: [binding("acct-retired")],
    preferredId: SPARE,
    now: NOW,
  })).toEqual({ kind: "unavailable", allowedAccountIds: ["acct-retired"] });
});

test("switching inside the allowed set stays automatic", () => {
  const resetsAt = Math.floor(NOW / 1_000) + 900;
  expect(selectProjectAccount({
    project: ATLAS,
    engine: "claude",
    accounts: ACCOUNTS,
    observations: [observation(RESERVED, 100, resetsAt), observation(SPARE, 20)],
    bindings: [binding(RESERVED), binding(SPARE)],
    preferredId: RESERVED,
    now: NOW,
  })).toEqual({ kind: "available", accountId: SPARE });
});

test("a binding on one engine leaves the other engine's selection alone", () => {
  expect(selectProjectAccount({
    project: ATLAS,
    engine: "codex",
    accounts: ACCOUNTS,
    observations: [],
    bindings: [binding(RESERVED)],
    preferredId: SPARE,
    now: NOW,
  })).toEqual({ kind: "available", accountId: SPARE });
});
