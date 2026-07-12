import { describe, expect, test } from "bun:test";

import type { Flow, Round } from "@/lib/flows/types";
import type { Pipeline } from "@/lib/pipelines/types";
import type { FileEntry } from "@/lib/types";

import {
  classifyWorker,
  collapsibleWorkerFiles,
  computeWorkerStacks,
  DEFAULT_WORKER_COLLAPSE_IDLE_MS,
  groupWorkerStacks,
  isCollapseExempt,
  pipelineOriginOf,
  pipelineStageAgentPaths,
  pipelineStagePipelineIds,
  protectedReviewerNodes,
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
  test("roles are derived from the flows list by path, NOT from file.flow (integration seam)", () => {
    /* /api/files ships raw scanner entries with no `file.flow` annotation, so
       classification must match flow.implementerPath / round.reviewerPath. */
    const reviewer = entry({ path: "/rev" });
    const impl = entry({ path: "/impl", parent: "/orchestrator" });
    const flows = [flow({ id: "f1", implementerPath: "/impl", rounds: [round({ reviewerPath: "/rev" })] })];
    expect(reviewer.flow).toBeUndefined();
    expect(classifyWorker(reviewer, lineage(flows))).toBe("flow-reviewer");
    expect(classifyWorker(impl, lineage(flows))).toBe("flow-implementer");
  });

  test("a parentless flow implementer is an owner root, never worker-class", () => {
    /* The owner started a top-level conversation and then a flow on it; keep it
       out of scope (and off the fragile authorship discount). */
    const impl = entry({ path: "/impl", parent: null });
    const flows = [flow({ id: "f1", implementerPath: "/impl" })];
    expect(classifyWorker(impl, lineage(flows))).toBeNull();
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

  test("HARD CONSTRAINT: an owner-created handoff is never a worker (even as a flow implementer)", () => {
    /* A handoff continues a conversation from the composer — owner-created — so
       its first composer prompt must not be discounted into a collapse. */
    const handoff = entry({ path: "/h", parent: "/root", handoff: true });
    expect(classifyWorker(handoff, lineage())).toBeNull();
    const handoffImplementer = entry({ path: "/h", parent: "/root", handoff: true });
    const flows = [flow({ id: "f1", implementerPath: "/h", rounds: [] })];
    expect(classifyWorker(handoffImplementer, lineage(flows))).toBeNull();
  });

  test("an owner-started root conversation is not worker-class", () => {
    const root = entry({ path: "/root" });
    expect(classifyWorker(root, lineage())).toBeNull();
  });

  test("FAIL TOWARD COLLAPSED: a parented conversation the specific classes miss is still worker-class (#136)", () => {
    /* A spawned claude *main* session (kind "session", not "subagent"), or any
       worker whose flow/pipeline attachment can't be resolved by path, must still
       fold — a classification miss defaults to collapsed, not to a full node. */
    const spawnedMain = entry({ path: "/spawned", parent: "/root" });
    expect(spawnedMain.kind).toBe("session");
    expect(classifyWorker(spawnedMain, lineage())).toBe("spawned-descendant");
  });

  test("fail-toward-collapsed never overrides the parentless-root exemption (#136)", () => {
    const root = entry({ path: "/root", parent: null });
    expect(classifyWorker(root, lineage())).toBeNull();
  });
});

describe("pipelineOriginOf — ancestor-chain pipeline ownership (#136)", () => {
  test("a stage resolves directly; its spawned descendant resolves through the chain", () => {
    const stage = entry({ path: "/stage", parent: "/orch" });
    const child = entry({ path: "/stage/child", parent: "/stage", kind: "subagent" });
    const grandchild = entry({ path: "/stage/child/leaf", parent: "/stage/child", kind: "subagent" });
    const filesByPath = new Map([[stage.path, stage], [child.path, child], [grandchild.path, grandchild]]);
    const pipelineIds = new Map([["/stage", "pipe1"]]);
    expect(pipelineOriginOf(stage, filesByPath, pipelineIds)).toBe("pipe1");
    expect(pipelineOriginOf(child, filesByPath, pipelineIds)).toBe("pipe1");
    expect(pipelineOriginOf(grandchild, filesByPath, pipelineIds)).toBe("pipe1");
  });

  test("a worker with no pipeline ancestor resolves to null", () => {
    const a = entry({ path: "/a" });
    const b = entry({ path: "/a/b", parent: "/a", kind: "subagent" });
    const filesByPath = new Map([[a.path, a], [b.path, b]]);
    expect(pipelineOriginOf(b, filesByPath, new Map())).toBeNull();
  });

  test("ownership map covers a stage agentPath AND an embedded flow's implementer + reviewers (#136)", () => {
    const flows = [flow({ id: "flow1", implementerPath: "/builder", rounds: [round({ reviewerPath: "/reviewer" })] })];
    const pipelines = [
      { id: "pipe1", runs: [{ stageId: "review", attempts: [{ agentPath: "/reviewer", flowId: "flow1" }] }] } as unknown as Pipeline,
    ];
    const map = pipelineStagePipelineIds(pipelines, flows);
    expect(map.get("/reviewer")).toBe("pipe1");
    expect(map.get("/builder")).toBe("pipe1");
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
      parent: "/orchestrator",
      mtime: NOW_SEC - 24 * 3600, // a day idle
      userAuthored: true,
    });
    // A closed flow would otherwise make its implementer a collapse candidate.
    const flows = [flow({ id: "f1", implementerPath: "/impl", state: "closed", closedAt: "2026-07-05T02:00:00Z" })];
    expect(shouldCollapseWorker(impl, ctx({ flows }))).toBe(false);
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
    const impl = entry({ path: "/impl", parent: "/orchestrator", mtime: NOW_SEC - 60 * 60, flow: { flowId: "f1", flowRole: "implementer", round: null } });
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

  test("groups collapse-eligible workers per flow, then per worktree (from flows, no file.flow)", () => {
    // Files carry NO flow annotation (as /api/files serves them); classification
    // and grouping both derive from the flows list by path.
    const flowWorker = stale({ path: "/rev" });
    const worktreeWorker = stale({ path: "/w", kind: "subagent", parent: "/root", worktree: "feat" });
    const flows = [flow({ id: "f1", implementerPath: "/impl", rounds: [round({ reviewerPath: "/rev", verdict: "APPROVE" })] })];
    expect(flowWorker.flow).toBeUndefined();
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

describe("groupWorkerStacks — one stack per origin (#136)", () => {
  const stale = (over: Partial<FileEntry> & { path: string }) => entry({ mtime: NOW_SEC - 30 * 60, ...over });

  test("a pipeline's stage workers fold into one pipeline stack", () => {
    const s1 = stale({ path: "/s1", parent: "/root" });
    const s2 = stale({ path: "/s2", parent: "/root" });
    const pipelineIdOf = (p: string) => (p === "/s1" || p === "/s2" ? "pipe1" : null);
    const stacks = groupWorkerStacks([s1, s2], [], new Set(), { pipelineIdOf });
    expect(stacks).toHaveLength(1);
    expect(stacks[0]!.kind).toBe("pipeline");
    expect(stacks[0]!.id).toBe("pipe1");
    expect(stacks[0]!.items.map((f) => f.path).sort()).toEqual(["/s1", "/s2"]);
  });

  test("workers from one spawner fold into one origin stack, regardless of worktree", () => {
    const a = stale({ path: "/a", kind: "subagent", parent: "/originX", worktree: "wt1" });
    const b = stale({ path: "/b", kind: "subagent", parent: "/originX", worktree: "wt2" });
    const stacks = groupWorkerStacks([a, b], [], new Set(), { originOf: () => "/originX" });
    expect(stacks).toHaveLength(1);
    expect(stacks[0]!.kind).toBe("origin");
    expect(stacks[0]!.id).toBe("/originX");
    expect(stacks[0]!.items).toHaveLength(2);
  });

  test("a pipeline stage and its spawned child fold into ONE pipeline stack, not a second origin stack (#136)", () => {
    /* The stage is owned by agentPath; its child has a different path. Ancestor
       resolution keeps both in the same pipeline stack. */
    const stage = stale({ path: "/stage", parent: "/orch" });
    const child = stale({ path: "/stage/child", parent: "/stage", kind: "subagent" });
    const filesByPath = new Map([[stage.path, stage], [child.path, child]]);
    const pipelineIds = new Map([["/stage", "pipe1"]]);
    const stacks = groupWorkerStacks([stage, child], [], new Set(), {
      pipelineIdOf: (path) => {
        const file = filesByPath.get(path);
        return file ? pipelineOriginOf(file, filesByPath, pipelineIds) : null;
      },
      /* Without the pipeline resolver both would fall here — proving the split. */
      originOf: () => "/orch",
    });
    expect(stacks).toHaveLength(1);
    expect(stacks[0]!.kind).toBe("pipeline");
    expect(stacks[0]!.id).toBe("pipe1");
    expect(stacks[0]!.items.map((f) => f.path).sort()).toEqual(["/stage", "/stage/child"]);
  });

  test("an embedded review-loop pipeline folds architect + builder + reviewer into ONE pipeline stack (#136)", () => {
    /* architect run stage, plus a review-loop stage whose flow's implementer
       (builder) and reviewer are pipeline-owned — all one pipeline, one stack,
       never split into a pipeline stack + a flow stack. */
    const architect = stale({ path: "/architect", parent: "/orch" });
    const builder = stale({ path: "/builder", parent: "/orch" });
    const reviewer = stale({ path: "/reviewer", parent: "/builder" });
    const flows = [flow({ id: "flow1", implementerPath: "/builder", rounds: [round({ reviewerPath: "/reviewer", verdict: "APPROVE" })] })];
    const pipelines = [
      {
        id: "pipe1", runs: [
          { stageId: "arch", attempts: [{ agentPath: "/architect", flowId: null }] },
          { stageId: "review", attempts: [{ agentPath: "/reviewer", flowId: "flow1" }] },
        ],
      } as unknown as Pipeline,
    ];
    const ownership = pipelineStagePipelineIds(pipelines, flows);
    const filesByPath = new Map([[architect.path, architect], [builder.path, builder], [reviewer.path, reviewer]]);
    const stacks = groupWorkerStacks([architect, builder, reviewer], flows, new Set(), {
      pipelineIdOf: (path) => {
        const file = filesByPath.get(path);
        return file ? pipelineOriginOf(file, filesByPath, ownership) : null;
      },
      originOf: () => "/orch",
    });
    expect(stacks).toHaveLength(1);
    expect(stacks[0]!.kind).toBe("pipeline");
    expect(stacks[0]!.id).toBe("pipe1");
    expect(stacks[0]!.items).toHaveLength(3);
  });

  test("origin precedence: flow → pipeline → spawner → worktree", () => {
    const flowWorker = stale({ path: "/rev" });
    const pipeWorker = stale({ path: "/pw", parent: "/root" });
    const spawnWorker = stale({ path: "/sw", kind: "subagent", parent: "/origin" });
    const bareWorker = stale({ path: "/bw", kind: "subagent", parent: "/root", worktree: "wt" });
    const flows = [flow({ id: "f1", implementerPath: "/impl", rounds: [round({ reviewerPath: "/rev", verdict: "APPROVE" })] })];
    const stacks = groupWorkerStacks([bareWorker, spawnWorker, pipeWorker, flowWorker], flows, new Set(), {
      pipelineIdOf: (p) => (p === "/pw" ? "pipe1" : null),
      originOf: (file) => (file.path === "/sw" ? "/origin" : null),
    });
    expect(stacks.map((s) => s.kind)).toEqual(["flow", "pipeline", "origin", "worktree"]);
  });
});

describe("protectedReviewerNodes", () => {
  const closed = (over: Partial<Flow> & { id: string; implementerPath: string }) =>
    flow({ state: "closed", closedAt: "2026-07-05T02:00:00Z", ...over });
  const nodes = (over: Partial<Parameters<typeof protectedReviewerNodes>[0]> & { files: FileEntry[]; flows: Flow[] }) =>
    protectedReviewerNodes({ renderedNodePaths: new Set(), hiddenPaths: new Set(), pinnedPaths: new Set(), ...over }).map((file) => file.path);

  test("materializes owner-authored / unverified reviewers of closed flows, not clean ones", () => {
    const authored = entry({ path: "/rev-authored", userAuthored: true });
    const unverified = entry({ path: "/rev-unverified", authorshipUnverified: true });
    const clean = entry({ path: "/rev-clean" });
    const flows = [
      closed({ id: "f1", implementerPath: "/i1", rounds: [round({ reviewerPath: "/rev-authored" })] }),
      closed({ id: "f2", implementerPath: "/i2", rounds: [round({ reviewerPath: "/rev-unverified" })] }),
      closed({ id: "f3", implementerPath: "/i3", rounds: [round({ reviewerPath: "/rev-clean" })] }),
    ];
    expect(new Set(nodes({ files: [authored, unverified, clean], flows }))).toEqual(new Set(["/rev-authored", "/rev-unverified"]));
  });

  test("HARD CONSTRAINT: materializes a protected reviewer of an ACTIVE flow whose implementer is UNPLACED", () => {
    const authored = entry({ path: "/rev", userAuthored: true });
    const flows = [flow({ id: "f1", implementerPath: "/impl", state: "reviewing", rounds: [round({ reviewerPath: "/rev" })] })];
    // Implementer not among the PLACED nodes → the active flow has zero decks.
    expect(nodes({ files: [authored], flows, renderedNodePaths: new Set() })).toEqual(["/rev"]);
  });

  test("materializes an owner-OPENED (pinned) reviewer of a deckless active flow, even unprotected", () => {
    /* The finished reviewer the owner clicked out of a worker stack: it carries
       no authorship protection but is a durable pin, and its active flow's
       implementer is unplaced, so it has no deck to fall back to. */
    const opened = entry({ path: "/rev" });
    const flows = [flow({ id: "f1", implementerPath: "/impl", state: "needs_decision", rounds: [round({ reviewerPath: "/rev" })] })];
    expect(nodes({ files: [opened], flows, renderedNodePaths: new Set(), pinnedPaths: new Set(["/rev"]) })).toEqual(["/rev"]);
  });

  test("does NOT duplicate a reviewer whose implementer is ephemerally revealed (deck rendered)", () => {
    /* An ephemeral focus places the hidden implementer, so buildSchemeLayout draws
       its deck. The implementer is in the PLACED set even though it is also hidden,
       so the reviewer stays in the deck and is not materialized a second time. */
    const authored = entry({ path: "/rev", userAuthored: true });
    const flows = [flow({ id: "f1", implementerPath: "/impl", state: "reviewing", rounds: [round({ reviewerPath: "/rev" })] })];
    expect(nodes({ files: [authored], flows, renderedNodePaths: new Set(["/impl"]), hiddenPaths: new Set(["/impl"]) })).toEqual([]);
  });

  test("skips a protected reviewer whose active flow HAS a rendered deck (placed implementer)", () => {
    const authored = entry({ path: "/rev", userAuthored: true });
    const flows = [flow({ id: "f1", implementerPath: "/impl", state: "reviewing", rounds: [round({ reviewerPath: "/rev" })] })];
    expect(nodes({ files: [authored], flows, renderedNodePaths: new Set(["/impl"]) })).toEqual([]);
  });

  test("skips a reviewer already drawn as a node, or manually closed", () => {
    const authored = entry({ path: "/rev", userAuthored: true });
    const flows = [closed({ id: "f1", implementerPath: "/impl", rounds: [round({ reviewerPath: "/rev" })] })];
    expect(nodes({ files: [authored], flows, renderedNodePaths: new Set(["/rev"]) })).toEqual([]);
    expect(nodes({ files: [authored], flows, hiddenPaths: new Set(["/rev"]) })).toEqual([]);
  });
});
