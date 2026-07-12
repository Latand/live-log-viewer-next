import { describe, expect, test } from "bun:test";

import type { Flow, Round } from "@/lib/flows/types";
import type { FileEntry } from "@/lib/types";

import {
  classifyWorker,
  collapsibleWorkerFiles,
  computeWorkerStacks,
  DEFAULT_WORKER_COLLAPSE_IDLE_MS,
  isCollapseExempt,
  pipelineStageAgentPaths,
  reviewerRoundFinished,
  shouldCollapseWorker,
} from "./workerCollapse";

const NOW = 2_000_000_000_000; // fixed clock; tests never read the wall clock
const NOW_SEC = NOW / 1000;

function entry(overrides: Partial<FileEntry> & { path: string }): FileEntry {
  return {
    root: "claude-projects",
    name: overrides.path,
    project: "demo",
    title: overrides.path,
    engine: "claude",
    kind: "session",
    fmt: "claude",
    parent: null,
    mtime: NOW_SEC - 3600, // an hour idle unless overridden
    size: 10,
    activity: "idle",
    proc: null,
    pid: null,
    model: null,
    pendingQuestion: null,
    waitingInput: null,
    ...overrides,
  };
}

const roleConfig = { engine: "claude" as const, model: null, effort: null };

function round(overrides: Partial<Round> = {}): Round {
  return {
    n: 1,
    reviewerPath: "/rev",
    findingsPath: null,
    triggeredBy: "marker",
    readyNote: null,
    verdict: null,
    findingsCount: null,
    startedAt: "2026-07-05T00:00:00Z",
    reviewedAt: null,
    relayedAt: null,
    error: null,
    ...overrides,
  };
}

function flow(overrides: Partial<Flow> & { id: string; implementerPath: string }): Flow {
  return {
    template: "implement-review-loop",
    project: "demo",
    cwd: "/tmp",
    roles: { implementer: roleConfig, reviewer: roleConfig },
    baseRef: "abc",
    baseMode: "head",
    mode: "auto",
    reviewerMode: "headless",
    roundLimit: 5,
    state: "reviewing",
    stateDetail: null,
    rounds: [round()],
    createdAt: "2026-07-05T00:00:00Z",
    closedAt: null,
    ...overrides,
  };
}

const lineage = (flows: Flow[] = [], pipelineStagePaths = new Set<string>()) => ({ flows, pipelineStagePaths });

const ctx = (over: Partial<Parameters<typeof shouldCollapseWorker>[1]> = {}) => ({
  flows: [] as Flow[],
  pipelineStagePaths: new Set<string>(),
  nowMs: NOW,
  idleMs: DEFAULT_WORKER_COLLAPSE_IDLE_MS,
  pinnedPaths: new Set<string>(),
  ...over,
});

describe("classifyWorker", () => {
  test("flow reviewer and implementer annotations win", () => {
    const reviewer = entry({ path: "/rev", flow: { flowId: "f1", flowRole: "reviewer", round: 1 } });
    const impl = entry({ path: "/impl", flow: { flowId: "f1", flowRole: "implementer", round: null } });
    expect(classifyWorker(reviewer, lineage())).toBe("flow-reviewer");
    expect(classifyWorker(impl, lineage())).toBe("flow-implementer");
  });

  test("pipeline stage ownership is worker-class", () => {
    const stage = entry({ path: "/stage" });
    expect(classifyWorker(stage, lineage([], new Set(["/stage"])))).toBe("pipeline-stage");
  });

  test("agent-spawned subagents and codex children are spawned workers", () => {
    const subagent = entry({ path: "/sub", kind: "subagent", parent: "/root" });
    const codexChild = entry({ path: "/c", root: "codex-sessions", engine: "codex", parent: "/root" });
    expect(classifyWorker(subagent, lineage())).toBe("spawned-worker");
    expect(classifyWorker(codexChild, lineage())).toBe("spawned-worker");
  });

  test("an owner-started root conversation is not worker-class", () => {
    const root = entry({ path: "/root" });
    expect(classifyWorker(root, lineage())).toBeNull();
  });
});

describe("reviewerRoundFinished", () => {
  test("true on verdict, reviewedAt, error, or terminalAt", () => {
    expect(reviewerRoundFinished(round({ verdict: "APPROVE" }))).toBe(true);
    expect(reviewerRoundFinished(round({ reviewedAt: "2026-07-05T01:00:00Z" }))).toBe(true);
    expect(reviewerRoundFinished(round({ error: "boom" }))).toBe(true);
    expect(reviewerRoundFinished(round({ terminalAt: "2026-07-05T01:00:00Z" }))).toBe(true);
  });
  test("false while a round is still reviewing", () => {
    expect(reviewerRoundFinished(round())).toBe(false);
  });
});

describe("isCollapseExempt — hard exemptions", () => {
  test("a user-authored message pins the card forever", () => {
    const file = entry({ path: "/w", kind: "subagent", parent: "/r", userAuthored: true });
    expect(isCollapseExempt(file, ctx())).toBe(true);
    expect(shouldCollapseWorker(file, ctx())).toBe(false);
  });

  test("live / stalled / running / awaiting-input work is never collapsed", () => {
    for (const over of [
      { activity: "live" as const },
      { activity: "stalled" as const },
      { proc: "running" as const },
      { pendingQuestion: { kind: "text" } as unknown as FileEntry["pendingQuestion"] },
      { waitingInput: {} as unknown as FileEntry["waitingInput"] },
    ]) {
      const file = entry({ path: "/w", kind: "subagent", parent: "/r", ...over });
      expect(isCollapseExempt(file, ctx())).toBe(true);
    }
  });

  test("an in-flight account migration pins the card", () => {
    const migrating = entry({
      path: "/w",
      kind: "subagent",
      parent: "/r",
      migration: { intentId: "i", trigger: "manual", phase: "verifying", targetAccountId: "a", failure: null },
    });
    expect(isCollapseExempt(migrating, ctx())).toBe(true);
    const committed = entry({
      path: "/w",
      kind: "subagent",
      parent: "/r",
      migration: { intentId: "i", trigger: "manual", phase: "committed", targetAccountId: "a", failure: null },
    });
    expect(isCollapseExempt(committed, ctx())).toBe(false);
  });

  test("an explicit manual/expanded placement pins the card", () => {
    const file = entry({ path: "/w", kind: "subagent", parent: "/r" });
    expect(shouldCollapseWorker(file, ctx({ pinnedPaths: new Set(["/w"]) }))).toBe(false);
  });

  test("HARD CONSTRAINT: unverified authorship fails closed", () => {
    /* The reaper has not scanned since the last write, so authorship is
       unconfirmed — pin the card until a cycle clears it. */
    const file = entry({ path: "/w", kind: "subagent", parent: "/r", authorshipUnverified: true });
    expect(isCollapseExempt(file, ctx())).toBe(true);
    expect(shouldCollapseWorker(file, ctx())).toBe(false);
    /* Even a finished reviewer round is held while authorship is unverified. */
    const reviewer = entry({ path: "/rev", authorshipUnverified: true, flow: { flowId: "f1", flowRole: "reviewer", round: 1 } });
    const flows = [flow({ id: "f1", implementerPath: "/impl", rounds: [round({ reviewerPath: "/rev", verdict: "APPROVE" })] })];
    expect(shouldCollapseWorker(reviewer, ctx({ flows }))).toBe(false);
  });
});

describe("shouldCollapseWorker", () => {
  test("a finished reviewer round collapses immediately, even while fresh", () => {
    const reviewer = entry({
      path: "/rev",
      activity: "recent",
      mtime: NOW_SEC - 5, // 5 s old — well inside the idle window
      flow: { flowId: "f1", flowRole: "reviewer", round: 1 },
    });
    const flows = [flow({ id: "f1", implementerPath: "/impl", rounds: [round({ reviewerPath: "/rev", verdict: "APPROVE" })] })];
    expect(shouldCollapseWorker(reviewer, ctx({ flows }))).toBe(true);
  });

  test("HARD CONSTRAINT: a user-authored message overrides reviewer immediate-collapse", () => {
    /* The exemption is checked before the reviewer verdict short-circuit, so a
       reviewer round that somehow carries a human message never folds — even
       with an APPROVE verdict on the board. */
    const reviewer = entry({
      path: "/rev",
      activity: "recent",
      mtime: NOW_SEC - 5,
      userAuthored: true,
      flow: { flowId: "f1", flowRole: "reviewer", round: 1 },
    });
    const flows = [flow({ id: "f1", implementerPath: "/impl", rounds: [round({ reviewerPath: "/rev", verdict: "APPROVE" })] })];
    expect(shouldCollapseWorker(reviewer, ctx({ flows }))).toBe(false);
  });

  test("HARD CONSTRAINT: a user-authored implementer never collapses however idle", () => {
    const impl = entry({
      path: "/impl",
      mtime: NOW_SEC - 24 * 3600, // a day idle
      userAuthored: true,
      flow: { flowId: "f1", flowRole: "implementer", round: null },
    });
    expect(shouldCollapseWorker(impl, ctx())).toBe(false);
  });

  test("a reviewer still reviewing is not collapsed, fresh or idle", () => {
    const flows = [flow({ id: "f1", implementerPath: "/impl", rounds: [round({ reviewerPath: "/rev" })] })];
    const fresh = entry({ path: "/rev", activity: "recent", mtime: NOW_SEC - 5, flow: { flowId: "f1", flowRole: "reviewer", round: 1 } });
    const idle = entry({ path: "/rev", mtime: NOW_SEC - 60 * 60, flow: { flowId: "f1", flowRole: "reviewer", round: 1 } });
    expect(shouldCollapseWorker(fresh, ctx({ flows }))).toBe(false);
    /* An unfinished round never folds on the idle window alone. */
    expect(shouldCollapseWorker(idle, ctx({ flows }))).toBe(false);
  });

  test("a flow implementer stays while its flow is open, collapses once closed", () => {
    const impl = entry({ path: "/impl", mtime: NOW_SEC - 60 * 60, flow: { flowId: "f1", flowRole: "implementer", round: null } });
    const active = [flow({ id: "f1", implementerPath: "/impl", state: "needs_decision" })];
    const closed = [flow({ id: "f1", implementerPath: "/impl", state: "closed", closedAt: "2026-07-05T02:00:00Z" })];
    /* Awaiting the owner's decision — the anchor stays even though its own
       transcript is an hour idle. */
    expect(shouldCollapseWorker(impl, ctx({ flows: active }))).toBe(false);
    /* Closed and idle past the window — now a candidate. */
    expect(shouldCollapseWorker(impl, ctx({ flows: closed }))).toBe(true);
  });

  test("a non-reviewer worker collapses only past the idle window", () => {
    const fresh = entry({ path: "/w", kind: "subagent", parent: "/r", mtime: NOW_SEC - 60 });
    const stale = entry({ path: "/w", kind: "subagent", parent: "/r", mtime: NOW_SEC - 16 * 60 });
    expect(shouldCollapseWorker(fresh, ctx())).toBe(false);
    expect(shouldCollapseWorker(stale, ctx())).toBe(true);
  });

  test("the idle window is configurable", () => {
    const file = entry({ path: "/w", kind: "subagent", parent: "/r", mtime: NOW_SEC - 6 * 60 });
    expect(shouldCollapseWorker(file, ctx({ idleMs: 15 * 60 * 1000 }))).toBe(false);
    expect(shouldCollapseWorker(file, ctx({ idleMs: 5 * 60 * 1000 }))).toBe(true);
  });
});

describe("pipelineStageAgentPaths", () => {
  test("collects every attempt's agent transcript", () => {
    const pipelines = [
      {
        runs: [{ attempts: [{ agentPath: "/a" }, { agentPath: null }] }, { attempts: [{ agentPath: "/b" }] }],
      },
    ] as unknown as Parameters<typeof pipelineStageAgentPaths>[0];
    expect(pipelineStageAgentPaths(pipelines)).toEqual(new Set(["/a", "/b"]));
  });
});

describe("collapsibleWorkerFiles — subtree guard", () => {
  const stale = (over: Partial<FileEntry> & { path: string }) => entry({ mtime: NOW_SEC - 30 * 60, ...over });

  test("does not fold a worker whose subtree holds a live descendant", () => {
    const parent = stale({ path: "/p", kind: "subagent", parent: "/root" });
    const liveChild = entry({ path: "/p/c", kind: "subagent", parent: "/p", activity: "live" });
    const paths = collapsibleWorkerFiles({ files: [parent, liveChild], project: "demo", flows: [], pinnedPaths: new Set(), nowMs: NOW }).map((f) => f.path);
    expect(paths).not.toContain("/p");
  });

  test("does not fold a worker whose subtree holds a user-authored descendant", () => {
    const parent = stale({ path: "/p", kind: "subagent", parent: "/root" });
    const touchedChild = stale({ path: "/p/c", kind: "subagent", parent: "/p", userAuthored: true });
    const paths = collapsibleWorkerFiles({ files: [parent, touchedChild], project: "demo", flows: [], pinnedPaths: new Set(), nowMs: NOW }).map((f) => f.path);
    /* Folding the parent off the board would bury the owner-touched child. */
    expect(paths).not.toContain("/p");
    expect(paths).not.toContain("/p/c");
  });

  test("folds a worker whose entire subtree is quiet", () => {
    const parent = stale({ path: "/p", kind: "subagent", parent: "/root" });
    const quietChild = stale({ path: "/p/c", kind: "subagent", parent: "/p" });
    const paths = collapsibleWorkerFiles({ files: [parent, quietChild], project: "demo", flows: [], pinnedPaths: new Set(), nowMs: NOW }).map((f) => f.path);
    expect(new Set(paths)).toEqual(new Set(["/p", "/p/c"]));
  });
});

describe("computeWorkerStacks", () => {
  const stale = (over: Partial<FileEntry> & { path: string }) => entry({ mtime: NOW_SEC - 30 * 60, ...over });

  test("groups collapse-eligible workers per flow, then per worktree", () => {
    const flowWorker = stale({ path: "/rev", flow: { flowId: "f1", flowRole: "reviewer", round: 1 } });
    const worktreeWorker = stale({ path: "/w", kind: "subagent", parent: "/root", worktree: "feat" });
    const flows = [flow({ id: "f1", implementerPath: "/impl", rounds: [round({ reviewerPath: "/rev", verdict: "APPROVE" })] })];
    const stacks = computeWorkerStacks({
      files: [flowWorker, worktreeWorker],
      project: "demo",
      flows,
      renderedPaths: new Set(),
      pinnedPaths: new Set(),
      nowMs: NOW,
    });
    expect(stacks.map((s) => s.kind)).toEqual(["flow", "worktree"]);
    expect(stacks[0]!.items.map((f) => f.path)).toEqual(["/rev"]);
    expect(stacks[1]!.items.map((f) => f.path)).toEqual(["/w"]);
  });

  test("excludes conversations already drawn on the scheme", () => {
    const worker = stale({ path: "/w", kind: "subagent", parent: "/root" });
    const stacks = computeWorkerStacks({
      files: [worker],
      project: "demo",
      flows: [],
      renderedPaths: new Set(["/w"]),
      pinnedPaths: new Set(),
      nowMs: NOW,
    });
    expect(stacks).toHaveLength(0);
  });

  test("never collapses an owner-started root or a user-authored worker", () => {
    const root = stale({ path: "/root" });
    const touched = stale({ path: "/w", kind: "subagent", parent: "/root", userAuthored: true });
    const stacks = computeWorkerStacks({
      files: [root, touched],
      project: "demo",
      flows: [],
      renderedPaths: new Set(),
      pinnedPaths: new Set(),
      nowMs: NOW,
    });
    expect(stacks).toHaveLength(0);
  });
});
