import { describe, expect, test } from "bun:test";

import type { Pipeline, PipelineStage, PipelineStageKind } from "@/lib/pipelines/types";
import type { FileEntry } from "@/lib/types";

import { latestAttempt } from "@/components/pipelines/pipelineModel";
import type { BranchGroup } from "@/components/projectModel";

import { buildSchemeLayout } from "./layout";

/**
 * #507 deterministic 1/3/5-stage graphs with mixed completed/running/queued
 * states. The on-canvas editor's core invariant is that EVERY declared stage
 * projects exactly one surface inside the pipeline group before and after
 * launch: a completed or running stage renders its real conversation node, and
 * a queued stage renders a conversation-shaped placeholder — never zero surface,
 * never a duplicate. These tests assert that partition is total and disjoint at
 * each graph size, so a five-stage graph always exposes five cards.
 */

function file(path: string): FileEntry {
  return {
    path, root: "claude-projects", name: path, project: "demo", title: path, engine: "claude", kind: "session",
    fmt: "claude", parent: null, mtime: 1_000, size: 10, activity: "idle", proc: null, pid: null,
    model: null, pendingQuestion: null, waitingInput: null,
  } as FileEntry;
}

/** A root BranchGroup wrapping one placed transcript (a materialized stage). */
function group(path: string): BranchGroup {
  const root = file(path);
  return { key: path, columns: [{ file: root, tasks: [] }], returnable: [], finished: [], smt: root.mtime, orphanTask: false };
}

type StageSpec = { id: string; kind: PipelineStageKind; surface: "completed" | "running" | "queued" };

function stageFrom(spec: StageSpec, next: string | null): PipelineStage {
  return {
    id: spec.id, kind: spec.kind, prompt: spec.kind === "review-loop" ? "{{task}}" : "{{prev.output}}", next,
    effectiveRole: { roleId: null, engine: "claude", model: "", effort: "", access: spec.kind === "review-loop" ? "read-only" : "read-write", promptScaffold: null },
  } as PipelineStage;
}

/** Build a mixed-state pipeline plus the placed transcripts for its
    completed/running stages. The cursor rests on the first non-terminal stage. */
function scene(specs: StageSpec[]): { pipeline: Pipeline; groups: BranchGroup[]; files: FileEntry[] } {
  const stages = specs.map((spec, index) => stageFrom(spec, specs[index + 1]?.id ?? null));
  const placed: string[] = [];
  const runs = specs.map((spec) => {
    if (spec.surface === "queued") return { stageId: spec.id, attempts: [] };
    const path = `/live/${spec.id}`;
    placed.push(path);
    const state = spec.surface === "completed" ? "passed" : "running";
    return { stageId: spec.id, attempts: [{ n: 1, state, agentPath: path, flowId: null } as unknown as Record<string, unknown>] };
  });
  const cursorStage = specs.find((spec) => spec.surface === "running") ?? specs.find((spec) => spec.surface === "queued") ?? specs[0]!;
  const pipeline = {
    id: "p1", task: "Ship the graph", project: "demo", repoDir: "/r", worktreeDir: "/w", branch: "b", baseBranch: "main",
    baseRef: "a", lastPassedCommit: "a", stages, runs, state: "running", pausedState: null, stateDetail: null,
    srcPath: null, srcConversationId: null, createdAt: "1970", closedAt: null,
    cursor: { stageId: cursorStage.id, state: cursorStage.surface === "running" ? "running" : "pending", input: null, activatedBy: null },
  } as unknown as Pipeline;
  return { pipeline, groups: placed.map(group), files: placed.map(file) };
}

/** The three surface classes, keyed by stage id, that layout produces. */
function surfaces(specs: StageSpec[]): { live: Set<string>; placeholder: Set<string>; history: Set<string> } {
  const { pipeline, groups, files } = scene(specs);
  const layout = buildSchemeLayout(groups, [], files, [], [], [pipeline], [pipeline]);
  const placedPaths = new Set(layout.nodes.map((node) => node.file.path));
  const live = new Set<string>();
  for (const stage of pipeline.stages) {
    const path = latestAttempt(pipeline, stage.id)?.agentPath;
    if (path && placedPaths.has(path)) live.add(stage.id);
  }
  const placeholder = new Set(layout.slots.filter((slot) => slot.pipeline.id === "p1" && slot.presentation === "placeholder").map((slot) => slot.stage.id));
  const history = new Set(layout.slots.filter((slot) => slot.pipeline.id === "p1" && slot.presentation === "completed").map((slot) => slot.stage.id));
  return { live, placeholder, history };
}

describe("#507 mixed-state stage graphs project exactly one surface per stage", () => {
  const cases: Record<string, StageSpec[]> = {
    "1 stage — running": [
      { id: "build", kind: "run", surface: "running" },
    ],
    "3 stages — completed → running → queued review": [
      { id: "architect", kind: "run", surface: "completed" },
      { id: "builder", kind: "run", surface: "running" },
      { id: "review", kind: "review-loop", surface: "queued" },
    ],
    "5 stages — two completed, one running, two queued": [
      { id: "architect", kind: "run", surface: "completed" },
      { id: "builder", kind: "run", surface: "completed" },
      { id: "verify", kind: "run", surface: "running" },
      { id: "polish", kind: "run", surface: "queued" },
      { id: "review", kind: "review-loop", surface: "queued" },
    ],
  };

  for (const [name, specs] of Object.entries(cases)) {
    test(name, () => {
      const { live, placeholder, history } = surfaces(specs);
      const all = new Set([...live, ...placeholder, ...history]);
      /* Total: every declared stage is represented exactly once. */
      expect(all.size).toBe(specs.length);
      expect([...all].sort()).toEqual(specs.map((spec) => spec.id).sort());
      /* Disjoint: no stage carries two surfaces (no duplicate, no zero-surface). */
      expect(live.size + placeholder.size + history.size).toBe(specs.length);
      /* Each surface class matches the declared state. */
      for (const spec of specs) {
        if (spec.surface === "queued") expect(placeholder.has(spec.id), spec.id).toBe(true);
        else expect(live.has(spec.id), spec.id).toBe(true);
      }
    });
  }
});
