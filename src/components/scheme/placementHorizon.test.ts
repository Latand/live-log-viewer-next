import { expect, test } from "bun:test";

import type { Pipeline, PipelineStage } from "@/lib/pipelines/types";
import type { FileEntry } from "@/lib/types";
import type { BranchGroup } from "@/components/projectModel";

import { buildSchemeLayout } from "./layout";
import { pipelineWithinPlacementHorizon } from "./placementHorizon";

const HOUR = 3_600;
const NOW = 1_786_000_000;
const iso = (secondsAgo: number) => new Date((NOW - secondsAgo) * 1_000).toISOString();

function file(path: string, overrides: Partial<FileEntry> = {}): FileEntry {
  return {
    path, root: "claude-projects", name: path, project: "demo", title: path, engine: "claude", kind: "session",
    fmt: "claude", parent: null, mtime: NOW - 400 * HOUR, size: 10, activity: "idle", proc: null, pid: null,
    model: null, pendingQuestion: null, waitingInput: null, ...overrides,
  } as FileEntry;
}

function group(entry: FileEntry): BranchGroup {
  return { key: entry.path, columns: [{ file: entry, tasks: [] }], returnable: [], finished: [], smt: entry.mtime, orphanTask: false };
}

function stage(id: string, next: string | null): PipelineStage {
  return {
    id, kind: "run", prompt: "{{prev.output}}", next,
    effectiveRole: { roleId: null, engine: "claude", model: "", effort: "", access: "read-write", promptScaffold: null },
  } as PipelineStage;
}

/** A three-stage pipeline: stage one ran at `attemptAgo`, the rest are queued. */
function pipeline(id: string, options: {
  agentPath?: string | null;
  attemptAgo?: number;
  createdAgo?: number;
  state?: Pipeline["state"];
} = {}): Pipeline {
  const { agentPath = null, attemptAgo = 400 * HOUR, createdAgo = 400 * HOUR, state = "running" } = options;
  return {
    id, task: "t", taskIds: [], project: "demo", repoDir: "/r", worktreeDir: "/w", branch: "b", baseBranch: "main",
    baseRef: "a", lastPassedCommit: "a",
    stages: [stage("one", "two"), stage("two", "three"), stage("three", null)],
    runs: agentPath
      ? [{ stageId: "one", attempts: [{ n: 1, state: "passed", agentPath, flowId: null, startedAt: iso(attemptAgo), completedAt: iso(attemptAgo) }] }]
      : [],
    state, pausedState: null, stateDetail: null, srcPath: null, srcConversationId: null,
    createdAt: iso(createdAgo), closedAt: null,
    cursor: { stageId: "two", state: "pending", input: null, activatedBy: null },
  } as unknown as Pipeline;
}

const noFiles = () => undefined;

test("a pipeline whose whole record predates the horizon is bounded off the canvas", () => {
  expect(pipelineWithinPlacementHorizon(pipeline("p"), { now: NOW, ageHorizonSeconds: 48 * HOUR, fileAt: noFiles })).toBe(false);
});

test("a pipeline that moved inside the horizon keeps its surfaces", () => {
  const fresh = pipeline("p", { agentPath: "/stage/one", attemptAgo: 3 * HOUR });
  expect(pipelineWithinPlacementHorizon(fresh, { now: NOW, ageHorizonSeconds: 48 * HOUR, fileAt: noFiles })).toBe(true);
  const justCreated = pipeline("p", { createdAgo: HOUR });
  expect(pipelineWithinPlacementHorizon(justCreated, { now: NOW, ageHorizonSeconds: 48 * HOUR, fileAt: noFiles })).toBe(true);
});

test("a live or running stage exempts an old pipeline at any age", () => {
  const old = pipeline("p", { agentPath: "/stage/one" });
  const live = file("/stage/one", { activity: "live" });
  const running = file("/stage/one", { proc: "running" });
  const idle = file("/stage/one");
  expect(pipelineWithinPlacementHorizon(old, { now: NOW, ageHorizonSeconds: 48 * HOUR, fileAt: () => live })).toBe(true);
  expect(pipelineWithinPlacementHorizon(old, { now: NOW, ageHorizonSeconds: 48 * HOUR, fileAt: () => running })).toBe(true);
  expect(pipelineWithinPlacementHorizon(old, { now: NOW, ageHorizonSeconds: 48 * HOUR, fileAt: () => idle })).toBe(false);
});

test("a stage transcript written recently dates the pipeline, whatever its stamps say", () => {
  const old = pipeline("p", { agentPath: "/stage/one" });
  const touched = file("/stage/one", { mtime: NOW - 2 * HOUR });
  expect(pipelineWithinPlacementHorizon(old, { now: NOW, ageHorizonSeconds: 48 * HOUR, fileAt: () => touched })).toBe(true);
});

test("without a clock nothing is bounded", () => {
  expect(pipelineWithinPlacementHorizon(pipeline("p"), { now: 0, ageHorizonSeconds: 48 * HOUR, fileAt: noFiles })).toBe(true);
});

// ── layout integration ──────────────────────────────────────────────────────

test("a terminal pipeline past the horizon grows no slots while a live one keeps its own", () => {
  const stalePath = "/stale/one";
  const livePath = "/live/one";
  /* Stranded, not closed: the state still declares work ahead, which is exactly
     the pipeline that keeps drawing slots forever after its host died. */
  const stale = pipeline("stale", { agentPath: stalePath, state: "needs_decision" });
  const alive = pipeline("alive", { agentPath: livePath, attemptAgo: HOUR });
  const staleFile = file(stalePath);
  const liveFile = file(livePath, { mtime: NOW - HOUR, activity: "live" });
  const files = [staleFile, liveFile];
  const groups = [group(liveFile)];

  const bounded = buildSchemeLayout(groups, [], files, [], [], [stale, alive], [stale, alive], new Set(), new Set(), [], new Set(), { now: NOW });
  const pipelinesWithSlots = new Set(bounded.slots.map((slot) => slot.pipeline.id));
  expect(pipelinesWithSlots).toEqual(new Set(["alive"]));

  // Without a clock the layout is unchanged: both pipelines keep their slots.
  const unbounded = buildSchemeLayout(groups, [], files, [], [], [stale, alive], [stale, alive]);
  expect(new Set(unbounded.slots.map((slot) => slot.pipeline.id))).toEqual(new Set(["stale", "alive"]));
});

test("an aged pipeline whose stage the board still places keeps its chain", () => {
  const stalePath = "/stale/one";
  const stale = pipeline("stale", { agentPath: stalePath, state: "needs_decision" });
  const pinned = file(stalePath);
  const layout = buildSchemeLayout([group(pinned)], [], [pinned], [], [], [stale], [stale], new Set(), new Set(), [], new Set(), { now: NOW });
  expect(new Set(layout.slots.map((slot) => slot.pipeline.id))).toEqual(new Set(["stale"]));
});

test("an aged pipeline with a live stage transcript keeps its slots", () => {
  const livePath = "/aged/one";
  const aged = pipeline("aged", { agentPath: livePath, state: "running" });
  const runningFile = file(livePath, { proc: "running" });
  const layout = buildSchemeLayout([], [], [runningFile], [], [], [aged], [aged], new Set(), new Set(), [], new Set(), { now: NOW });
  expect(new Set(layout.slots.map((slot) => slot.pipeline.id))).toEqual(new Set(["aged"]));
});
