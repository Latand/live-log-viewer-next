import { expect, test } from "bun:test";

import type { FileEntry } from "@/lib/types";
import type { Pipeline, PipelineStage } from "@/lib/pipelines/types";

import { boardFirstPaintReady, pendingFocusTarget } from "./ProjectDashboard";
import {
  compactPipelineArtifactPaths,
  pipelineFullPanePaths,
  pipelinePlaceholderStages,
} from "./pipelines/pipelineModel";
import { collapsibleWorkerFiles, groupWorkerStacks } from "./scheme/workerCollapse";

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
 * #507 final review F1 — an aged-idle passed stage on a cursor-bearing active
 * pipeline stays the ONE real stage conversation card. The board runs two
 * independent derivations over the same scan: worker auto-collapse (#112) folds
 * idle pipeline-stage transcripts into the pipeline stack, while #507 F2 keeps
 * every current stage's latest attempt full-size. Without the full-pane
 * protection the two disagree — the passed stage's card either vanishes or
 * duplicates beside the stack. This mirrors ProjectDashboard's own composition:
 * pipelineFullPanePaths protects the collapse pass, so each of the five stages
 * projects exactly one surface (four real cards + one placeholder) and no stage
 * card is duplicated in a worker stack.
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

test("an aged-idle passed stage stays one real card, never a worker-stack duplicate (#507 final F1)", () => {
  const { pipeline, files } = fiveStageActivePipeline();
  const placedPaths = new Set(files.map((file) => file.path));

  const protectedPaths = pipelineFullPanePaths([pipeline], []);
  expect(protectedPaths).toEqual(new Set(["/architect", "/builder", "/verifier", "/integrator"]));

  const compactPaths = compactPipelineArtifactPaths([pipeline], [], files);
  /* No superseded retries, so nothing compacts away from the scene. */
  expect(compactPaths.size).toBe(0);

  /* Without protection the three aged-idle passed stages would fold into the
     pipeline worker stack (the bug). */
  const unprotected = collapsibleWorkerFiles({
    files, project: "demo", flows: [], pipelines: [pipeline], pinnedPaths: new Set(), nowMs: DASH_NOW,
  }).map((file) => file.path);
  expect(unprotected).toEqual(expect.arrayContaining(["/architect", "/builder", "/verifier"]));

  /* With the full-pane protection ProjectDashboard applies, none fold. */
  const collapsible = collapsibleWorkerFiles({
    files, project: "demo", flows: [], pipelines: [pipeline], pinnedPaths: new Set(), protectedPaths, nowMs: DASH_NOW,
  });
  expect(collapsible).toHaveLength(0);
  const collapsedPaths = new Set(collapsible.map((file) => file.path));

  /* Scene = files that neither compacted nor collapsed: the four launched
     stages each keep one real card. */
  const sceneFiles = files.filter((file) => !collapsedPaths.has(file.path) && !compactPaths.has(file.path));
  expect(sceneFiles.map((file) => file.path)).toEqual(["/architect", "/builder", "/verifier", "/integrator"]);

  /* The one future stage is the single placeholder surface. */
  const placeholders = pipelinePlaceholderStages(pipeline, placedPaths);
  expect(placeholders.map((stage) => stage.id)).toEqual(["shipper"]);

  /* Five stages → five total real/placeholder surfaces, exactly one per stage. */
  expect(sceneFiles.length + placeholders.length).toBe(5);

  /* No worker-stack duplicate of any real stage card. */
  const stacks = groupWorkerStacks(collapsible, [], compactPaths);
  expect(stacks.flatMap((stack) => stack.items)).toHaveLength(0);
});
