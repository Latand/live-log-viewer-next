import { expect, test } from "bun:test";

import type { FileEntry } from "@/lib/types";
import type { Pipeline, PipelineStage } from "@/lib/pipelines/types";

import auditFixture from "./fixtures/issue1158-audit-snapshot.json";
import { boardFirstPaintReady, pendingFocusTarget } from "./ProjectDashboard";
import { buildBranchGroups } from "./projectModel";
import {
  compactPipelineArtifactPaths,
  pipelinePlaceholderStages,
} from "./pipelines/pipelineModel";
import { buildSchemeLayout } from "./scheme/layout";
import { collapsibleWorkerFiles, finishedLaneOutcomePaths, groupWorkerStacks, pipelineCursorStagePaths } from "./scheme/workerCollapse";

test("a catalog focus waits for its pinned conversation to hydrate", () => {
  const path = "/sessions/capped-out.jsonl";
  expect(pendingFocusTarget(path, [])).toBeNull();
  expect(pendingFocusTarget(path, [{ path } as FileEntry])).toBe(path);
});

test("the board holds its skeleton until BOTH the scan and the persisted state load (#172)", () => {
  /* The flash was painting the raw scan snapshot before the persisted board
     state (closes, worker collapse, caps) landed, then culling it. The first
     real frame is gated on both signals, so neither alone lets nodes paint. */
  expect(boardFirstPaintReady(false, false)).toBe(false);
  expect(boardFirstPaintReady(true, false)).toBe(false);
  expect(boardFirstPaintReady(false, true)).toBe(false);
  expect(boardFirstPaintReady(true, true)).toBe(true);
});

/*
 * The active pipeline protects its cursor transcript. Completed prior stages use
 * the same settled/idle projection as every other conversation.
 */
const AGED = 1_000; // seconds; an hour+ idle against the fixed clock below
const DASH_NOW = 2_000_000_000_000;

function agedStageFile(path: string): FileEntry {
  return {
    path,
    root: "claude-projects",
    name: path,
    project: "demo",
    title: path,
    engine: "claude",
    kind: "session",
    fmt: "claude",
    parent: null,
    mtime: AGED, // far past the 15-minute idle window
    size: 10,
    activity: "idle",
    proc: null,
    pid: null,
    model: null,
    pendingQuestion: null,
    waitingInput: null,
  } as FileEntry;
}

function fiveStageActivePipeline(): { pipeline: Pipeline; files: FileEntry[] } {
  const stage = (id: string, kind: PipelineStage["kind"] = "run"): PipelineStage => ({
    id,
    kind, prompt: "",
    next: null,
    effectiveRole: { roleId: null, engine: "claude", model: null, effort: null, access: "read-write", promptScaffold: null },
  } as PipelineStage);
  const stages = [stage("architect"), stage("builder"), stage("verifier"), stage("integrator"), stage("shipper")];
  const files = ["/architect", "/builder", "/verifier", "/integrator"].map(agedStageFile);
  const pipeline = {
    id: "pl",
    task: "five stages",
    project: "demo",
    repoDir: "/r",
    worktreeDir: "/w",
    branch: "b",
    baseBranch: "main",
    baseRef: "a",
    lastPassedCommit: "a",
    stages,
    /* Three passed (aged-idle) stages, one live running cursor stage, and one
       future stage with no attempt. */
    runs: [
      { stageId: "architect", attempts: [{ state: "passed", agentPath: "/architect" }] },
      { stageId: "builder", attempts: [{ state: "passed", agentPath: "/builder" }] },
      { stageId: "verifier", attempts: [{ state: "passed", agentPath: "/verifier" }] },
      { stageId: "integrator", attempts: [{ state: "running", agentPath: "/integrator" }] },
    ],
    cursor: { stageId: "integrator", state: "running", input: null, activatedBy: null },
    state: "running",
    pausedState: null,
    stateDetail: null,
    srcPath: null,
    srcConversationId: null,
    createdAt: new Date(0).toISOString(),
    closedAt: null,
  } as unknown as Pipeline;
  return { pipeline, files };
}

test("an active pipeline keeps its cursor card while aged prior stages fold", () => {
  const { pipeline, files } = fiveStageActivePipeline();

  const protectedPaths = pipelineCursorStagePaths([pipeline]);
  expect(protectedPaths).toEqual(new Set(["/integrator"]));

  const compactPaths = compactPipelineArtifactPaths([pipeline], [], files);
  /* No superseded retries, so nothing compacts away from the scene. */
  expect(compactPaths.size).toBe(0);

  /* The three PASSED stages fold on their attempt state; the running cursor
     stage stays on its own evidence, so it no longer depends on the protected
     set to survive its transcript going quiet (#1244). */
  const unprotected = collapsibleWorkerFiles({
    files, project: "demo", flows: [], pipelines: [pipeline], pinnedPaths: new Set(),
  }).map((file) => file.path);
  expect(unprotected).toEqual(["/architect", "/builder", "/verifier"]);

  /* The cursor remains a real card; completed prior stages fold. */
  const collapsible = collapsibleWorkerFiles({
    files, project: "demo", flows: [], pipelines: [pipeline], pinnedPaths: new Set(), protectedPaths,
  });
  expect(collapsible.map((file) => file.path)).toEqual(["/architect", "/builder", "/verifier"]);
  const collapsedPaths = new Set(collapsible.map((file) => file.path));

  const sceneFiles = files.filter((file) => !collapsedPaths.has(file.path) && !compactPaths.has(file.path));
  expect(sceneFiles.map((file) => file.path)).toEqual(["/integrator"]);

  /* The one future stage is the single placeholder surface. */
  const placeholders = pipelinePlaceholderStages(pipeline, new Set(sceneFiles.map((file) => file.path)));
  expect(placeholders.map((stage) => stage.id)).toEqual(["shipper"]);

  const stacks = groupWorkerStacks(collapsible, [], compactPaths);
  expect(stacks.flatMap((stack) => stack.items).map((file) => file.path)).toEqual(["/architect", "/builder", "/verifier"]);
  expect(stacks.flatMap((stack) => stack.items).some((file) => file.path === "/integrator")).toBe(false);
});

test("the audited board shape folds settled work and keeps every unfinished card, plus one unread finished lane (#1158, #1244)", () => {
  const nowSeconds = auditFixture.nowMs / 1000;
  const rootPath = "fixture/root.jsonl";
  const file = (path: string, overrides: Partial<FileEntry> = {}): FileEntry => ({
    path,
    root: "codex-sessions",
    name: path,
    project: auditFixture.project,
    title: path,
    engine: "codex",
    kind: "session",
    fmt: "codex",
    parent: rootPath,
    mtime: nowSeconds - 3_600,
    size: 10,
    activity: "idle",
    proc: null,
    pid: null,
    model: null,
    pendingQuestion: null,
    waitingInput: null,
    durableLineage: { kind: "spawn", role: "builder", parentConversationId: "conversation-root", reviewsConversationId: null, memberships: [] },
    ...overrides,
  });
  const pipelineMembership = (index: number) => ({
    kind: "pipeline" as const,
    containerId: auditFixture.closedPipelineIds[index % auditFixture.closedPipelineIds.length]!,
    role: index % 2 === 0 ? "builder" : "reviewer",
    slot: `stage:${index}`,
    stageId: `stage-${index}`,
    stageOrder: index,
    round: 1,
    parentConversationId: "conversation-root",
  });
  const root = file(rootPath, { parent: null, activity: "live", proc: "running", conversationId: "conversation-root", durableLineage: undefined });
  const completedPipeline = {
    id: auditFixture.completedPipelineId,
    state: "completed",
    cursor: null,
    runs: [{ stageId: "research", attempts: [{ agentPath: "fixture/unread-outcome-0.jsonl" }] }],
  } as unknown as Pipeline;
  const settled = Array.from({ length: auditFixture.settledPipelineChildren }, (_, index) => file(`fixture/closed-stage-${index}.jsonl`, {
    handoff: true,
    proc: "killed",
    authoritativeTurn: { state: "terminal", source: "lifecycle", terminalAt: "2033-05-18T03:33:20.000Z" },
    durableLineage: { kind: "spawn", role: "builder", parentConversationId: "conversation-root", reviewsConversationId: null, memberships: [pipelineMembership(index)] },
  }));
  const running = Array.from({ length: auditFixture.runningChildren }, (_, index) => file(`fixture/running-${index}.jsonl`, {
    activity: "live",
    proc: "running",
  }));
  const fresh = Array.from({ length: auditFixture.freshIdleChildren }, (_, index) => file(`fixture/fresh-${index}.jsonl`, { mtime: nowSeconds - 60 }));
  /* #1244: unfinished and quieter than every window the board ever used —
     15 minutes, and the two-hour project default. These are what used to
     disappear while the operator was still owed a result. */
  const staleUnfinished = Array.from({ length: auditFixture.staleUnfinishedChildren }, (_, index) => file(`fixture/stale-unfinished-${index}.jsonl`, {
    mtime: nowSeconds - 5 * 3_600,
  }));
  /* #1244 follow-up: a lane that COMPLETED. Its stage is settled, yet the card
     stays because nobody has opened the result it just produced. */
  const unreadFinished = Array.from({ length: auditFixture.unreadFinishedLaneChildren }, (_, index) => file(`fixture/unread-outcome-${index}.jsonl`, {
    proc: "done",
    durableLineage: {
      kind: "spawn",
      role: "builder",
      parentConversationId: "conversation-root",
      reviewsConversationId: null,
      memberships: [{
        kind: "pipeline" as const,
        containerId: auditFixture.completedPipelineId,
        role: "builder",
        slot: "stage:research",
        stageId: "research",
        stageOrder: 0,
        round: 1,
        parentConversationId: "conversation-root",
      }],
    },
  }));
  const pinned = Array.from({ length: auditFixture.pinnedSettledChildren }, (_, index) => file(`fixture/pinned-${index}.jsonl`, { proc: "done" }));
  const reviewers = Array.from({ length: auditFixture.reviewersWithoutVerdict }, (_, index) => file(`fixture/reviewer-no-verdict-${index}.jsonl`, {
    proc: "killed",
    durableLineage: { kind: "review", role: "reviewer", parentConversationId: "conversation-root", reviewsConversationId: "conversation-root", memberships: [] },
  }));
  const files = [root, ...settled, ...running, ...fresh, ...staleUnfinished, ...unreadFinished, ...pinned, ...reviewers];
  const pinnedPaths = new Set(pinned.map((entry) => entry.path));
  const outcomePaths = finishedLaneOutcomePaths([completedPipeline], []);
  expect([...outcomePaths]).toEqual(["fixture/unread-outcome-0.jsonl"]);

  const before = buildBranchGroups(files, auditFixture.project, { now: nowSeconds });
  expect(before.flatMap((group) => group.columns)).toHaveLength(auditFixture.expected.columnsBefore);

  const projection = (seenAt: ReadonlyMap<string, number>) => collapsibleWorkerFiles({
    files,
    project: auditFixture.project,
    flows: [],
    pipelines: [completedPipeline],
    pinnedPaths,
    outcomePaths,
    seenAt,
  });
  const collapsed = projection(new Map());
  expect(collapsed).toHaveLength(auditFixture.expected.collapsed);
  /* The unfinished cards survive the fold, whatever their transcript age. */
  const foldedPaths = new Set(collapsed.map((entry) => entry.path));
  for (const entry of [...staleUnfinished, ...unreadFinished]) expect(foldedPaths.has(entry.path)).toBe(false);
  expect(collapsed.find((entry) => entry.durableLineage?.role === "reviewer")?.review).toBeUndefined();
  const collapsedPaths = new Set(collapsed.map((entry) => entry.path));
  const scene = files.filter((entry) => !collapsedPaths.has(entry.path));
  const keepExpandedPaths = new Set(scene.map((entry) => entry.path));
  const after = buildBranchGroups(scene, auditFixture.project, { keepExpandedPaths, now: nowSeconds });
  expect(after.flatMap((group) => group.columns)).toHaveLength(auditFixture.expected.columnsAfter);

  const stacks = groupWorkerStacks(collapsed, [], new Set(), { originOf: () => rootPath });
  expect(stacks.reduce((sum, stack) => sum + stack.items.length, 0)).toBe(auditFixture.expected.collapsed);
  /* The phone reads the same fold through its board rows now (mobile v2 lane
     2); the map-lite projection this used to assert is retired (lane 10). */
  expect(buildSchemeLayout(after, [], files).nodes).toHaveLength(auditFixture.expected.columnsAfter);

  /* Opening the finished lane releases it, and nothing else moves. */
  const acknowledged = projection(new Map([[unreadFinished[0]!.path, nowSeconds]]));
  expect(acknowledged).toHaveLength(auditFixture.expected.collapsedAfterAcknowledgement);
  const acknowledgedScene = files.filter((entry) => !new Set(acknowledged.map((row) => row.path)).has(entry.path));
  const afterAcknowledgement = buildBranchGroups(acknowledgedScene, auditFixture.project, {
    keepExpandedPaths: new Set(acknowledgedScene.map((entry) => entry.path)),
    now: nowSeconds,
  });
  expect(afterAcknowledgement.flatMap((group) => group.columns)).toHaveLength(auditFixture.expected.columnsAfterAcknowledgement);
});
