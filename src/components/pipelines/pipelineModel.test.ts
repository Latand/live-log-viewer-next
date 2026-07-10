import { describe, expect, test } from "bun:test";

import type { Pipeline, PipelineStage } from "@/lib/pipelines/types";

import {
  PIPELINE_TEMPLATES,
  type DraftStage,
  deriveStageId,
  draftStagesToInput,
  pipelineNeedsAttention,
  stageChipState,
} from "./pipelineModel";

function stage(id: string, kind: PipelineStage["kind"] = "run", roleId?: string): PipelineStage {
  return {
    id,
    kind,
    ...(roleId ? { role: { roleId: roleId as PipelineStage["role"] extends undefined ? never : NonNullable<PipelineStage["role"]>["roleId"] } } : {}),
    prompt: "",
    next: null,
    effectiveRole: { roleId: null, engine: "codex", model: null, effort: null, access: kind === "review-loop" ? "read-only" : "read-write", promptScaffold: null },
  } as PipelineStage;
}

function pipeline(over: Partial<Pipeline>): Pipeline {
  return {
    id: "p1",
    task: "t",
    project: "proj",
    repoDir: "/repo",
    worktreeDir: "/wt",
    branch: "b",
    baseBranch: "main",
    baseRef: "abc",
    lastPassedCommit: "abc",
    stages: [],
    runs: [],
    cursor: null,
    state: "running",
    pausedState: null,
    stateDetail: null,
    srcPath: null,
    srcConversationId: null,
    createdAt: new Date(0).toISOString(),
    closedAt: null,
    ...over,
  } as Pipeline;
}

describe("stageChipState", () => {
  const stages = [stage("plan"), stage("build"), stage("review", "review-loop")];

  test("a stage with no attempt before the cursor is pending", () => {
    const p = pipeline({ stages, cursor: { stageId: "plan", state: "running" } });
    expect(stageChipState(p, stages[2]!)).toBe("pending");
  });

  test("the cursor stage of a busy pipeline is running", () => {
    const p = pipeline({ stages, cursor: { stageId: "build", state: "running" }, runs: [{ stageId: "build", attempts: [{ state: "running" } as never] }] });
    expect(stageChipState(p, stages[1]!)).toBe("running");
  });

  test("a review-loop cursor stage reads as reviewing", () => {
    const p = pipeline({ stages, cursor: { stageId: "review", state: "reviewing" }, runs: [{ stageId: "review", attempts: [{ state: "reviewing" } as never] }] });
    expect(stageChipState(p, stages[2]!)).toBe("reviewing");
  });

  test("a committing cursor state overrides running", () => {
    const p = pipeline({ stages, cursor: { stageId: "build", state: "committing" }, runs: [{ stageId: "build", attempts: [{ state: "committing" } as never] }] });
    expect(stageChipState(p, stages[1]!)).toBe("committing");
  });

  test("terminal attempt states win over the cursor", () => {
    const p = pipeline({ stages, cursor: { stageId: "build", state: "running" }, state: "needs_decision", runs: [{ stageId: "build", attempts: [{ state: "needs_decision" } as never] }] });
    expect(stageChipState(p, stages[1]!)).toBe("needs_decision");
    const passed = pipeline({ stages, runs: [{ stageId: "plan", attempts: [{ state: "passed" } as never] }] });
    expect(stageChipState(passed, stages[0]!)).toBe("passed");
    const skipped = pipeline({ stages, runs: [{ stageId: "plan", attempts: [{ state: "skipped" } as never] }] });
    expect(stageChipState(skipped, stages[0]!)).toBe("skipped");
  });
});

describe("deriveStageId", () => {
  test("slugs the role id and dedupes with numeric suffixes", () => {
    const taken = new Set<string>();
    expect(deriveStageId("run", "builder", taken)).toBe("builder");
    expect(deriveStageId("run", "builder", taken)).toBe("builder-2");
    expect(deriveStageId("run", "builder", taken)).toBe("builder-3");
  });

  test("falls back to kind for role-less stages", () => {
    const taken = new Set<string>();
    expect(deriveStageId("run", "", taken)).toBe("stage");
    expect(deriveStageId("review-loop", "", taken)).toBe("review");
  });
});

describe("draftStagesToInput", () => {
  const draft = (over: Partial<DraftStage>): DraftStage => ({
    key: "k",
    kind: "run",
    roleId: "",
    engine: "codex",
    model: "",
    effort: "",
    access: "read-write",
    prompt: "do it",
    roleParams: {},
    ...over,
  });

  test("derives a linear next chain ending in null, from array order", () => {
    const input = draftStagesToInput([
      draft({ roleId: "architect", prompt: "plan {{task}}" }),
      draft({ roleId: "builder", prompt: "{{prev.output}}" }),
      draft({ kind: "review-loop", roleId: "reviewer", prompt: "review" }),
    ]);
    expect(input.map((stage) => stage.id)).toEqual(["architect", "builder", "reviewer"]);
    expect(input.map((stage) => stage.next)).toEqual(["builder", "reviewer", null]);
  });

  test("attaches roleId only when a role is chosen and omits access for review-loop", () => {
    const [raw, review] = draftStagesToInput([
      draft({ roleId: "", prompt: "raw" }),
      draft({ kind: "review-loop", roleId: "reviewer", prompt: "review" }),
    ]);
    expect(raw!.role).toBeUndefined();
    expect(raw!.access).toBe("read-write");
    expect(review!.role).toEqual({ roleId: "reviewer" });
    expect(review!.access).toBeUndefined();
  });

  test("only sends model/effort overrides when set", () => {
    const [a, b] = draftStagesToInput([
      draft({ prompt: "a", model: "  ", effort: "" }),
      draft({ prompt: "b", model: "opus", effort: "high", engine: "claude" }),
    ]);
    expect(a!.model).toBeUndefined();
    expect(a!.effort).toBeUndefined();
    expect(b!.model).toBe("opus");
    expect(b!.effort).toBe("high");
    expect(b!.engine).toBe("claude");
  });
});

test("templates are all 2–4 stages with a run before any review-loop", () => {
  for (const template of PIPELINE_TEMPLATES) {
    expect(template.stages.length).toBeGreaterThanOrEqual(2);
    expect(template.stages.length).toBeLessThanOrEqual(4);
    template.stages.forEach((stage, index) => {
      if (stage.kind === "review-loop") {
        expect(template.stages.slice(0, index).some((prior) => prior.kind === "run")).toBe(true);
      }
    });
  }
});

test("pipelineNeedsAttention flags parked and paused, not closed", () => {
  expect(pipelineNeedsAttention(pipeline({ state: "needs_decision" }))).toBe(true);
  expect(pipelineNeedsAttention(pipeline({ state: "paused" }))).toBe(true);
  expect(pipelineNeedsAttention(pipeline({ state: "running" }))).toBe(false);
  expect(pipelineNeedsAttention(pipeline({ state: "closed" }))).toBe(false);
});
