import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { FileEntry } from "@/lib/types";

import type { Flow } from "./types";

process.env.LLV_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "llv-flow-engine-test-"));
const { tickFlows, persistTickFlows } = await import("./engine");
const { loadFlows, saveFlows } = await import("./store");

afterAll(() => {
  fs.rmSync(process.env.LLV_STATE_DIR!, { recursive: true, force: true });
});

function entryFor(pathname: string, mtime: number): FileEntry {
  return {
    path: pathname,
    root: "codex-sessions",
    name: path.basename(pathname),
    project: "repo",
    title: "agent",
    engine: "codex",
    kind: "session",
    fmt: "codex",
    parent: null,
    mtime,
    size: fs.statSync(pathname).size,
    activity: "idle",
    proc: null,
    pid: null,
    model: null,
    pendingQuestion: null,
    waitingInput: null,
  };
}

function writeCodexEntry(name: string, payload: Record<string, unknown>, mtime: number): FileEntry {
  const pathname = path.join(process.env.LLV_STATE_DIR!, "flow-codex-fixtures", name);
  fs.mkdirSync(path.dirname(pathname), { recursive: true });
  fs.writeFileSync(pathname, JSON.stringify({ type: "session_meta", payload }) + "\n");
  return entryFor(pathname, mtime);
}

test("review-flow heuristic claim skips a newer native Codex subagent", async () => {
  const startedAt = "2026-01-01T00:00:00.000Z";
  const started = Date.parse(startedAt) / 1000;
  const cwd = "/repo";
  const implementerId = "019f421e-02e1-73e0-9b77-bebde063f10c";
  const rootId = "019f421e-02e1-73e0-9b77-bebde063f10a";
  const childId = "019f423a-d6e9-7903-b597-3e676b6ff3d4";
  const implementer = writeCodexEntry(`rollout-implementer-${implementerId}.jsonl`, { id: implementerId, cwd }, started - 100);
  const root = writeCodexEntry(`rollout-root-${rootId}.jsonl`, { id: rootId, cwd }, started + 5);
  const nativeChild = writeCodexEntry(
    `rollout-child-${childId}.jsonl`,
    {
      id: childId,
      parent_thread_id: rootId,
      cwd,
      source: { subagent: { thread_spawn: { parent_thread_id: rootId } } },
    },
    started + 10,
  );
  const flow: Flow = {
    id: "flow-test",
    template: "implement-review-loop",
    project: "repo",
    cwd,
    implementerPath: implementer.path,
    roles: {
      implementer: { engine: "codex", model: null, effort: "high" },
      reviewer: { engine: "codex", model: null, effort: "xhigh" },
    },
    baseRef: "base",
    baseMode: "head",
    mode: "auto",
    reviewerMode: "pane",
    roundLimit: 5,
    state: "reviewing",
    pausedState: null,
    stateDetail: null,
    rounds: [
      {
        n: 1,
        reviewerPath: null,
        sessionId: null,
        reviewerPid: null,
        reviewerPane: { paneId: "%2", windowName: "codex-new" },
        findingsPath: null,
        triggeredBy: "marker",
        readyNote: null,
        verdict: null,
        findingsCount: null,
        startedAt,
        spawnStartedAt: startedAt,
        relayStartedAt: null,
        reviewedAt: null,
        relayedAt: null,
        error: null,
      },
    ],
    createdAt: startedAt,
    closedAt: null,
  };
  saveFlows([flow]);

  await tickFlows([implementer, nativeChild, root]);
  const after = loadFlows()[0]!;

  expect(after.rounds[0]!.reviewerPath).toBe(root.path);
});

test("a mid-flight round is polled with its frozen reviewer role, not a raced set-roles (issue #118 Finding 1)", async () => {
  const startedAt = "2026-02-02T00:00:00.000Z";
  const started = Date.parse(startedAt) / 1000;
  const cwd = "/repo";
  const implementerId = "029f421e-02e1-73e0-9b77-bebde063f20c";
  const reviewerId = "029f421e-02e1-73e0-9b77-bebde063f20b";
  const implementer = writeCodexEntry(`rollout-impl2-${implementerId}.jsonl`, { id: implementerId, cwd }, started - 100);
  /* The reviewer candidate is a CODEX session, matching the round's frozen role. */
  const reviewerCandidate = writeCodexEntry(`rollout-rev2-${reviewerId}.jsonl`, { id: reviewerId, cwd }, started + 5);
  const flow: Flow = {
    id: "flow-freeze",
    template: "implement-review-loop",
    project: "repo",
    cwd,
    implementerPath: implementer.path,
    /* The live flow role has already been switched to claude by a set-roles that
       raced the running reviewer — the round must ignore it. */
    roles: {
      implementer: { engine: "codex", model: null, effort: "high" },
      reviewer: { engine: "claude", model: "fable", effort: null },
    },
    baseRef: "base",
    baseMode: "head",
    mode: "auto",
    reviewerMode: "pane",
    roundLimit: 5,
    state: "reviewing",
    pausedState: null,
    stateDetail: null,
    rounds: [
      {
        n: 1,
        reviewerPath: null,
        sessionId: null,
        reviewerPid: null,
        /* Frozen at spawn: this reviewer is codex. */
        reviewerRole: { engine: "codex", model: null, effort: "xhigh" },
        reviewerPane: { paneId: "%3", windowName: "codex-rev" },
        findingsPath: null,
        triggeredBy: "marker",
        readyNote: null,
        verdict: null,
        findingsCount: null,
        startedAt,
        spawnStartedAt: startedAt,
        relayStartedAt: null,
        reviewedAt: null,
        relayedAt: null,
        error: null,
      },
    ],
    createdAt: startedAt,
    closedAt: null,
  };
  saveFlows([flow]);

  await tickFlows([implementer, reviewerCandidate]);
  const after = loadFlows()[0]!;

  /* The heuristic claimed the codex candidate: it used the round's frozen codex
     role. Had it read flow.roles.reviewer (now claude), no claude entry exists
     and the reviewer path would still be null. */
  expect(after.rounds[0]!.reviewerPath).toBe(reviewerCandidate.path);
  expect(after.rounds[0]!.reviewerRole).toEqual({ engine: "codex", model: null, effort: "xhigh" });
});

test("loadFlows migrates a legacy round without a reviewer snapshot (issue #118 Finding 1)", () => {
  /* A round persisted before per-round snapshots existed: no reviewerRole. */
  const legacy = {
    id: "flow-legacy",
    template: "implement-review-loop",
    project: "repo",
    cwd: "/repo",
    implementerPath: "/impl",
    roles: {
      implementer: { engine: "codex", model: null, effort: "high" },
      reviewer: { engine: "codex", model: null, effort: "xhigh" },
    },
    baseRef: "base",
    baseMode: "head",
    mode: "auto",
    reviewerMode: "headless",
    roundLimit: 5,
    state: "reviewing",
    pausedState: null,
    stateDetail: null,
    rounds: [{
      n: 1, reviewerPath: "/rev", findingsPath: null, triggeredBy: "marker", readyNote: null,
      verdict: null, findingsCount: null, startedAt: "2026-03-03T00:00:00Z", reviewedAt: null, relayedAt: null, error: null,
    }],
    createdAt: "2026-03-03T00:00:00Z",
    closedAt: null,
  } as unknown as Flow;
  saveFlows([legacy]);
  /* On load, the round is frozen to the flow's current reviewer role. */
  const loaded = loadFlows()[0]!;
  expect(loaded.rounds[0]!.reviewerRole).toEqual({ engine: "codex", model: null, effort: "xhigh" });
});

test("persistTickFlows never reverts a concurrent operator config change (issue #118 Finding 2)", () => {
  /* On disk: the operator has switched the reviewer to claude/fable and bumped
     the round limit. */
  const onDisk = {
    id: "flow-race",
    template: "implement-review-loop",
    project: "repo",
    cwd: "/repo",
    implementerPath: "/impl",
    roles: {
      implementer: { engine: "codex", model: null, effort: "high" },
      reviewer: { engine: "claude", model: "fable", effort: null },
    },
    baseRef: "base",
    baseMode: "head",
    mode: "manual",
    reviewerMode: "headless",
    roundLimit: 9,
    state: "reviewing",
    pausedState: null,
    stateDetail: null,
    rounds: [],
    createdAt: "2026-04-04T00:00:00Z",
    closedAt: null,
  } as unknown as Flow;
  saveFlows([onDisk]);

  /* A stale tick clone still carries the OLD codex reviewer, roundLimit 5, auto
     mode, and a state advance the tick computed. */
  const staleClone = structuredClone(onDisk);
  staleClone.roles.reviewer = { engine: "codex", model: null, effort: "xhigh" };
  staleClone.roundLimit = 5;
  staleClone.mode = "auto";
  staleClone.state = "relaying";
  persistTickFlows([staleClone]);

  const after = loadFlows()[0]!;
  /* Operator-owned config survives from disk; the tick's own state change lands. */
  expect(after.roles.reviewer).toMatchObject({ engine: "claude", model: "fable" });
  expect(after.roundLimit).toBe(9);
  expect(after.mode).toBe("manual");
  expect(after.state).toBe("relaying");
});
