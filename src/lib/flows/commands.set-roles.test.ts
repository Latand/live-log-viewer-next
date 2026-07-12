import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.LLV_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "llv-flow-set-roles-"));
const { patchFlow } = await import("./commands");
const { reviewerRoleFor, flowTickBase, persistTickFlows } = await import("./engine");
const { loadFlows, saveFlows } = await import("./store");
import type { Flow } from "./types";

function seed(overrides: Partial<Flow> = {}): Flow {
  const flow: Flow = {
    id: "f1",
    template: "implement-review-loop",
    project: "viewer",
    cwd: "/repo",
    implementerPath: "/impl",
    roles: {
      implementer: { engine: "codex", model: "gpt-5.6", effort: "medium" },
      reviewer: { engine: "codex", model: "gpt-5.6", effort: "high" },
    },
    baseRef: "abc",
    baseMode: "head",
    mode: "auto",
    reviewerMode: "headless",
    roundLimit: 5,
    state: "needs_decision",
    pausedState: null,
    stateDetail: null,
    rounds: [],
    createdAt: "2026-07-05T00:00:00Z",
    closedAt: null,
    ...overrides,
  };
  saveFlows([flow]);
  return flow;
}

test("set-roles re-configures the reviewer for the next round and persists", () => {
  seed();
  const result = patchFlow("f1", { action: "set-roles", roles: { reviewer: { model: "gpt-5-codex", effort: "" } } });
  expect(result.error).toBeUndefined();
  expect(result.flow!.roles.reviewer).toEqual({ engine: "codex", model: "gpt-5-codex", effort: null });
  /* Implementer is untouched, and the change is written to the store. */
  expect(result.flow!.roles.implementer).toEqual({ engine: "codex", model: "gpt-5.6", effort: "medium" });
  expect(loadFlows()[0]!.roles.reviewer.model).toBe("gpt-5-codex");
});

test("set-roles rejects a reviewer config the CLI cannot launch (issue #118 Finding 3)", () => {
  seed();
  /* codex + a claude model must not persist and fail later at spawn. */
  expect(patchFlow("f1", { action: "set-roles", roles: { reviewer: { model: "fable" } } }).status).toBe(400);
  expect(patchFlow("f1", { action: "set-roles", roles: { reviewer: { engine: "claude" } } }).status).toBe(400);
  expect(loadFlows()[0]!.roles.reviewer).toEqual({ engine: "codex", model: "gpt-5.6", effort: "high" });
});

test("set-roles can reseat the reviewer engine", () => {
  seed();
  const result = patchFlow("f1", { action: "set-roles", roles: { reviewer: { engine: "claude", model: "fable" } } });
  expect(result.flow!.roles.reviewer).toMatchObject({ engine: "claude", model: "fable" });
  /* The implementer is never touched — it is not overridable (Finding 2). */
  expect(result.flow!.roles.implementer).toEqual({ engine: "codex", model: "gpt-5.6", effort: "medium" });
});

test("set-roles ignores an implementer key and requires a reviewer override", () => {
  seed();
  /* The type no longer permits implementer, but a raw client can still send one;
     it must not silently reseat anything, and with no reviewer key it is a 400. */
  expect(patchFlow("f1", { action: "set-roles", roles: { implementer: { engine: "claude" } } as never }).status).toBe(400);
  expect(loadFlows()[0]!.roles.implementer).toEqual({ engine: "codex", model: "gpt-5.6", effort: "medium" });
});

test("set-roles does not retarget a round already in flight (Finding 1 freeze)", () => {
  /* A round is reviewing with a frozen codex reviewer role; set-roles → claude
     must not touch that round's snapshot, only the flow-level next-round role. */
  seed({
    state: "reviewing",
    rounds: [{
      n: 1, reviewerPath: "/rev", reviewerRole: { engine: "codex", model: "gpt-5.6", effort: "high" },
      accountId: null, sessionId: null, reviewerPane: null, findingsPath: null, triggeredBy: "button",
      readyNote: null, verdict: null, findingsCount: null, startedAt: "2026-07-05T00:00:00Z",
      spawnStartedAt: "2026-07-05T00:00:01Z", relayStartedAt: null, reviewedAt: null, relayedAt: null, error: null,
    }],
  });
  const result = patchFlow("f1", { action: "set-roles", roles: { reviewer: { engine: "claude", model: "fable" } } });
  expect(result.flow!.rounds[0]!.reviewerRole).toEqual({ engine: "codex", model: "gpt-5.6", effort: "high" });
  expect(result.flow!.roles.reviewer).toMatchObject({ engine: "claude", model: "fable" });
});

test("set-roles reaches a pending manual round so the imminent Spawn uses the new role (issue #118 review)", () => {
  /* waiting_ready → spawn_pending → set-roles → advance: the round frozen at
     spawn_pending must adopt the override, or the reviewer launches with the old
     engine/model/effort while the UI reports success. */
  seed({ mode: "manual", state: "waiting_ready", rounds: [] });
  /* Start review: creates the round (snapshot = codex/gpt-5.6/high) and parks it. */
  expect(patchFlow("f1", { action: "advance" }).flow!.state).toBe("spawn_pending");
  expect(loadFlows()[0]!.rounds[0]!.reviewerRole).toEqual({ engine: "codex", model: "gpt-5.6", effort: "high" });

  /* Override the reviewer before spawning. */
  const overridden = patchFlow("f1", { action: "set-roles", roles: { reviewer: { engine: "claude", model: "fable" } } });
  expect(overridden.flow!.rounds[0]!.reviewerRole).toEqual({ engine: "claude", model: "fable", effort: "high" });

  /* Spawn: the round keeps the overridden snapshot, and that is what the engine
     launches with (reviewerRoleFor reads the round, not flow.roles). */
  const advanced = patchFlow("f1", { action: "advance" }).flow!;
  expect(advanced.state).toBe("spawning");
  expect(reviewerRoleFor(advanced, advanced.rounds[0]!)).toEqual({ engine: "claude", model: "fable", effort: "high" });
});

function spawnPendingRound() {
  return {
    n: 1, reviewerPath: null, reviewerRole: { engine: "codex", model: "gpt-5.6", effort: "high" },
    findingsPath: null, triggeredBy: "button", readyNote: null, verdict: null, findingsCount: null,
    startedAt: "2026-07-05T00:00:00Z", spawnStartedAt: null, relayStartedAt: null, reviewedAt: null,
    relayedAt: null, error: null,
  };
}

test("a concurrent tick save does not revert a set-roles pending-round override (issue #118 review)", () => {
  /* The tick clones a spawn_pending flow it does not change. */
  seed({ mode: "manual", state: "spawn_pending", rounds: [spawnPendingRound()] as never });
  const clone = structuredClone(loadFlows()[0]!);
  const base = flowTickBase([clone]);

  /* While the tick awaits work on ANOTHER flow, the operator overrides the
     reviewer; round-7 pushes the new role onto the pending round on disk. */
  patchFlow("f1", { action: "set-roles", roles: { reviewer: { engine: "claude", model: "fable" } } });
  expect(loadFlows()[0]!.rounds[0]!.reviewerRole).toEqual({ engine: "claude", model: "fable", effort: "high" });

  /* The tick's later save (triggered by the other flow) must not restore the
     stale codex round role. */
  persistTickFlows([clone], base);
  const after = loadFlows()[0]!;
  expect(after.rounds[0]!.reviewerRole).toEqual({ engine: "claude", model: "fable", effort: "high" });
  expect(after.roles.reviewer).toMatchObject({ engine: "claude", model: "fable" });
});

test("a tick that DID change the flow still fences the pending round's disk-owned snapshot (issue #118 review)", () => {
  seed({ mode: "manual", state: "spawn_pending", rounds: [spawnPendingRound()] as never });
  const clone = structuredClone(loadFlows()[0]!);
  const base = flowTickBase([clone]);
  /* A tick-owned change that keeps state/rounds the same (e.g. re-homed path). */
  clone.implementerPath = "/impl-canonical";

  patchFlow("f1", { action: "set-roles", roles: { reviewer: { engine: "claude", model: "fable" } } });
  persistTickFlows([clone], base);

  const after = loadFlows()[0]!;
  /* Tick change applied, but the unstarted round keeps the operator's new role. */
  expect(after.implementerPath).toBe("/impl-canonical");
  expect(after.rounds[0]!.reviewerRole).toEqual({ engine: "claude", model: "fable", effort: "high" });
});

test("set-roles leaves a spawning round's frozen snapshot untouched (issue #118 review)", () => {
  /* An in-flight round (spawnStartedAt set) must keep its frozen role. */
  seed({
    mode: "manual",
    state: "spawning",
    rounds: [{
      n: 1, reviewerPath: null, reviewerRole: { engine: "codex", model: "gpt-5.6", effort: "high" },
      findingsPath: null, triggeredBy: "button", readyNote: null, verdict: null, findingsCount: null,
      startedAt: "2026-07-05T00:00:00Z", spawnStartedAt: "2026-07-05T00:00:01Z", relayStartedAt: null,
      reviewedAt: null, relayedAt: null, error: null,
    }] as never,
  });
  const result = patchFlow("f1", { action: "set-roles", roles: { reviewer: { engine: "claude", model: "fable" } } });
  expect(result.flow!.rounds[0]!.reviewerRole).toEqual({ engine: "codex", model: "gpt-5.6", effort: "high" });
  expect(result.flow!.roles.reviewer).toMatchObject({ engine: "claude", model: "fable" });
});

test("set-roles rejects an invalid override and an empty payload", () => {
  seed();
  expect(patchFlow("f1", { action: "set-roles", roles: { reviewer: { engine: "gemini" as never } } }).status).toBe(400);
  expect(patchFlow("f1", { action: "set-roles", roles: {} }).status).toBe(400);
  expect(patchFlow("f1", { action: "set-roles" }).status).toBe(400);
});

test("set-roles refuses a closed flow", () => {
  seed({ state: "closed", closedAt: "2026-07-06T00:00:00Z" });
  expect(patchFlow("f1", { action: "set-roles", roles: { reviewer: { model: "fable" } } }).status).toBe(409);
});

test("advancing a spawn_pending round applies the freshly edited note (issue #118 Finding 4)", () => {
  /* Manual mode: the round already exists (created at waiting_ready→spawn_pending)
     with an old note; the operator revises it before spawning. */
  seed({
    mode: "manual",
    state: "spawn_pending",
    rounds: [{
      n: 1, reviewerPath: null, findingsPath: null, triggeredBy: "button", readyNote: "old note",
      verdict: null, findingsCount: null, startedAt: "2026-07-05T00:00:00Z", reviewedAt: null, relayedAt: null, error: null,
    }] as never,
  });
  const result = patchFlow("f1", { action: "advance", note: "review the retry path carefully" });
  expect(result.error).toBeUndefined();
  expect(result.flow!.state).toBe("spawning");
  expect(result.flow!.rounds[0]!.readyNote).toBe("review the retry path carefully");
});

test("advancing spawn_pending without a note keeps the existing round note", () => {
  seed({
    mode: "manual",
    state: "spawn_pending",
    rounds: [{
      n: 1, reviewerPath: null, findingsPath: null, triggeredBy: "button", readyNote: "keep me",
      verdict: null, findingsCount: null, startedAt: "2026-07-05T00:00:00Z", reviewedAt: null, relayedAt: null, error: null,
    }] as never,
  });
  const result = patchFlow("f1", { action: "advance" });
  expect(result.flow!.rounds[0]!.readyNote).toBe("keep me");
});

function pendingRound(readyNote: string | null) {
  return {
    n: 1, reviewerPath: null, findingsPath: null, triggeredBy: "button", readyNote,
    verdict: null, findingsCount: null, startedAt: "2026-07-05T00:00:00Z", reviewedAt: null, relayedAt: null, error: null,
  };
}

test("an explicit empty note clears the round note; an omitted note keeps it (issue #118 review Finding 2)", () => {
  /* spawn_pending advance: "" clears. */
  seed({ mode: "manual", state: "spawn_pending", rounds: [pendingRound("stale note")] as never });
  expect(patchFlow("f1", { action: "advance", note: "" }).flow!.rounds[0]!.readyNote).toBeNull();
  /* spawn_pending advance: whitespace-only is also an explicit clear. */
  seed({ mode: "manual", state: "spawn_pending", rounds: [pendingRound("stale note")] as never });
  expect(patchFlow("f1", { action: "advance", note: "   " }).flow!.rounds[0]!.readyNote).toBeNull();
});

test("retry-round clears with an empty note and keeps the note when omitted (issue #118 review Finding 2)", () => {
  seed({ state: "needs_decision", rounds: [pendingRound("stale note")] as never });
  expect(patchFlow("f1", { action: "retry-round", note: "" }).flow!.rounds[0]!.readyNote).toBeNull();
  seed({ state: "needs_decision", rounds: [pendingRound("stale note")] as never });
  expect(patchFlow("f1", { action: "retry-round" }).flow!.rounds[0]!.readyNote).toBe("stale note");
  seed({ state: "needs_decision", rounds: [pendingRound("stale note")] as never });
  expect(patchFlow("f1", { action: "retry-round", note: "fresh" }).flow!.rounds[0]!.readyNote).toBe("fresh");
});
