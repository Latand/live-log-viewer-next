import { expect, test } from "bun:test";

import type { Flow } from "@/lib/flows/types";
import type { Pipeline, PipelineStage } from "@/lib/pipelines/types";
import type { FileEntry } from "@/lib/types";
import type { BranchGroup } from "@/components/projectModel";

import { buildSchemeLayout } from "./layout";
import { boundFlowExpansions, buildTranscriptLookup, pipelineWithinPlacementHorizon, transcriptIdentity } from "./placementHorizon";

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

// ── the record's path spelling is not the scanner's ─────────────────────────

/* The exact spellings the live board disagrees on: a durable attempt records
   the account-shared root a spawn ran under, while the scan that produced the
   FileEntry walked the operator's own root (or the reverse). Both name one
   transcript. A resolver keyed on the raw string answers `undefined`, which is
   why the tests above — every one of which hands back a file for ANY path —
   cannot see the miss. */
const RECORD_SPELLING = "/roots/own/claude/projects/-w-pipe/stage-one-session.jsonl";
const SCANNED_SPELLING = "/roots/shared/claude/projects/-w-pipe/stage-one-session.jsonl";

test("one transcript under two root spellings shares an identity, two transcripts never do", () => {
  expect(transcriptIdentity(RECORD_SPELLING)).toBe(transcriptIdentity(SCANNED_SPELLING));
  expect(transcriptIdentity("/a/rollout-2026-08-02T08-22-36-019fc0ec.jsonl")).not.toBe(transcriptIdentity("/a/rollout-2026-08-02T08-22-37-019fc0ed.jsonl"));
  /* A non-transcript path is never aliased down to its basename. */
  expect(transcriptIdentity("/one/output")).not.toBe(transcriptIdentity("/two/output"));
});

test("a running stage exempts its pipeline even when the scan spells the transcript differently", () => {
  const running = file(SCANNED_SPELLING, { proc: "running" });
  const aged = pipeline("aged", { agentPath: RECORD_SPELLING });
  const byPathOnly = new Map([[running.path, running]]);
  // The raw-string resolver misses the record's spelling — the defect itself.
  expect(byPathOnly.get(RECORD_SPELLING)).toBeUndefined();
  const lookup = buildTranscriptLookup([running]);
  expect(lookup(RECORD_SPELLING)).toBe(running);
  expect(pipelineWithinPlacementHorizon(aged, { now: NOW, ageHorizonSeconds: 48 * HOUR, fileAt: lookup })).toBe(true);
});

test("a recently touched transcript dates its pipeline through the other spelling too", () => {
  const touched = file(SCANNED_SPELLING, { mtime: NOW - 2 * HOUR });
  const aged = pipeline("aged", { agentPath: RECORD_SPELLING });
  expect(pipelineWithinPlacementHorizon(aged, { now: NOW, ageHorizonSeconds: 48 * HOUR, fileAt: buildTranscriptLookup([touched]) })).toBe(true);
});

test("an ambiguous identity never resolves — only an unambiguous one crosses roots", () => {
  const twinA = file("/root-a/dup.jsonl", { proc: "running" });
  const twinB = file("/root-b/dup.jsonl");
  const lookup = buildTranscriptLookup([twinA, twinB]);
  expect(lookup("/root-a/dup.jsonl")).toBe(twinA);
  expect(lookup("/somewhere-else/dup.jsonl")).toBeUndefined();
});

test("a pipeline the record cannot date at all is left alone rather than dated to the epoch", () => {
  const undatable = { ...pipeline("p"), createdAt: null, runs: [] } as unknown as Pipeline;
  expect(pipelineWithinPlacementHorizon(undatable, { now: NOW, ageHorizonSeconds: 48 * HOUR, fileAt: noFiles })).toBe(true);
});

test("a stage the projection still calls recent holds its pipeline against a tightened horizon", () => {
  const recent = file("/stage/one", { activity: "recent", mtime: NOW - 20 * 60 });
  const aged = pipeline("p", { agentPath: "/stage/one" });
  // A sub-15-minute override must not out-tighten the activity band itself.
  expect(pipelineWithinPlacementHorizon(aged, { now: NOW, ageHorizonSeconds: 300, fileAt: () => recent })).toBe(true);
});

// ── flow-driven expansions ──────────────────────────────────────────────────

function flow(overrides: Partial<Flow> = {}): Flow {
  return {
    id: "f1", template: "review", project: "demo", cwd: "/w", implementerPath: "/impl",
    roles: {}, baseRef: "a", baseMode: "head", mode: "auto", reviewerMode: "headless",
    roundLimit: 5, state: "reviewing", stateDetail: null, rounds: [], createdAt: iso(400 * HOUR), closedAt: null,
    ...overrides,
  } as unknown as Flow;
}

function round(reviewerPath: string): Flow["rounds"][number] {
  return { n: 1, reviewerPath, verdict: null, findingsCount: null, startedAt: iso(HOUR), findingsPath: null, triggeredBy: "button", readyNote: null, reviewedAt: null, relayedAt: null, error: null } as unknown as Flow["rounds"][number];
}

test("an aged implementer keeps its expansion while a reviewer of its flow is live", () => {
  const impl = file("/impl", { mtime: NOW - 400 * HOUR });
  const reviewer = file("/impl/reviewer", { parent: "/impl", mtime: NOW - 400 * HOUR, activity: "live" });
  const reviewing = flow({ rounds: [round(reviewer.path)] });
  const kept = boundFlowExpansions(new Set(["/impl"]), { flows: [reviewing], files: [impl, reviewer], now: NOW, ageHorizonSeconds: 48 * HOUR });
  // The implementer is the card the round deck hangs on: bounding it would
  // strand the live reviewer as a bare node with no deck to fold into.
  expect([...kept]).toEqual(["/impl"]);
});

test("a running reviewer holds its implementer too, and a settled flow loses it", () => {
  const impl = file("/impl", { mtime: NOW - 400 * HOUR });
  const running = file("/impl/reviewer", { parent: "/impl", mtime: NOW - 400 * HOUR, proc: "running" });
  const quiet = file("/impl/reviewer", { parent: "/impl", mtime: NOW - 400 * HOUR });
  const input = { now: NOW, ageHorizonSeconds: 48 * HOUR };
  expect([...boundFlowExpansions(new Set(["/impl"]), { ...input, flows: [flow({ rounds: [round(running.path)] })], files: [impl, running] })]).toEqual(["/impl"]);
  expect([...boundFlowExpansions(new Set(["/impl"]), { ...input, flows: [flow({ state: "approved", rounds: [round(quiet.path)] })], files: [impl, quiet] })]).toEqual([]);
});

test("a fresh implementer keeps its expansion with no reviewer at all", () => {
  const impl = file("/impl", { mtime: NOW - 2 * HOUR });
  expect([...boundFlowExpansions(new Set(["/impl"]), { flows: [flow()], files: [impl], now: NOW, ageHorizonSeconds: 48 * HOUR })]).toEqual(["/impl"]);
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

test("the layout reads a running stage and a pinned stage through the scanner's spelling", () => {
  const running = file(SCANNED_SPELLING, { proc: "running" });
  const live = pipeline("live", { agentPath: RECORD_SPELLING, state: "running" });
  const byLiveness = buildSchemeLayout([], [], [running], [], [], [live], [live], new Set(), new Set(), [], new Set(), { now: NOW });
  expect(new Set(byLiveness.slots.map((slot) => slot.pipeline.id))).toEqual(new Set(["live"]));

  /* And the pin escape: an aged, stranded pipeline whose stage card the board
     places anyway keeps the chain drawn around it. */
  const pinned = file(SCANNED_SPELLING);
  const stranded = pipeline("stranded", { agentPath: RECORD_SPELLING, state: "needs_decision" });
  const byPin = buildSchemeLayout([group(pinned)], [], [pinned], [], [], [stranded], [stranded], new Set(), new Set(), [], new Set(), { now: NOW });
  expect(new Set(byPin.slots.map((slot) => slot.pipeline.id))).toEqual(new Set(["stranded"]));
});
