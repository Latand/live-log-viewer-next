import { describe, expect, test } from "bun:test";

import type { FileEntry } from "@/lib/types";
import type { Pipeline, PipelineStage } from "@/lib/pipelines/types";

import type { TFunction } from "@/lib/i18n";

import {
  PIPELINE_TEMPLATES,
  type DraftStage,
  canSourcePipeline,
  deriveStageId,
  draftStagesToInput,
  normalizeStageOrder,
  pipelineAnnouncement,
  pipelineBoardStripPath,
  pipelineCursorActive,
  pipelineNeedsAttention,
  pipelineStripByPath,
  stageChipState,
} from "./pipelineModel";

/** A structural stand-in for the locale function: echoes the key and its vars. */
const fakeT = ((key: string, vars?: Record<string, unknown>) => (vars ? `${key}:${JSON.stringify(vars)}` : key)) as unknown as TFunction;

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

  test("pausing a running pipeline keeps the cursor stage active, not pending", () => {
    const p = pipeline({
      stages,
      state: "paused",
      pausedState: "running",
      cursor: { stageId: "build", state: "running" },
      runs: [{ stageId: "build", attempts: [{ state: "running" } as never] }],
    });
    expect(stageChipState(p, stages[1]!)).toBe("running");
    /* A stage the cursor has not reached stays pending even while paused. */
    expect(stageChipState(p, stages[2]!)).toBe("pending");
  });
});

describe("pipelineCursorActive", () => {
  const stages = [stage("plan"), stage("build")];
  test("is true while busy and while paused-from-busy, false when parked", () => {
    expect(pipelineCursorActive(pipeline({ stages, state: "running" }))).toBe(true);
    expect(pipelineCursorActive(pipeline({ stages, state: "paused", pausedState: "running" }))).toBe(true);
    expect(pipelineCursorActive(pipeline({ stages, state: "paused", pausedState: "needs_decision" }))).toBe(false);
    expect(pipelineCursorActive(pipeline({ stages, state: "needs_decision" }))).toBe(false);
  });
});

describe("pipelineAnnouncement", () => {
  test("names the pipeline's task, state, and cursor position", () => {
    const stages = [stage("plan"), stage("build"), stage("review", "review-loop")];
    const p = pipeline({ task: "ship it", stages, state: "running", cursor: { stageId: "build", state: "running" } });
    const message = pipelineAnnouncement(fakeT, p);
    expect(message).toContain("ship it");
    expect(message).toContain('"k":2');
    expect(message).toContain('"n":3');
  });
});

describe("normalizeStageOrder", () => {
  const d = (over: Partial<DraftStage>): DraftStage => ({ key: "k", kind: "run", roleId: "", engine: "codex", model: "", effort: "", access: "read-write", prompt: "p", roleParams: {}, ...over });

  test("demotes a review-loop that lands at stage 1 back to a run", () => {
    /* Reordering a [run, review-loop] chain up would otherwise submit and 400. */
    const out = normalizeStageOrder([d({ kind: "review-loop", roleId: "reviewer" }), d({ kind: "run", roleId: "builder" })]);
    expect(out[0]!.kind).toBe("run");
    expect(out[1]!.kind).toBe("run");
  });

  test("leaves a valid order untouched (same reference)", () => {
    const stages = [d({ kind: "run" }), d({ kind: "review-loop" })];
    expect(normalizeStageOrder(stages)).toBe(stages);
  });
});

describe("canSourcePipeline", () => {
  const file = (over: Partial<FileEntry>): FileEntry => ({ path: "/p", root: "codex-sessions", engine: "codex", kind: "session", parent: null, ...over } as FileEntry);
  test("accepts codex sessions and both Claude roots and children", () => {
    expect(canSourcePipeline(file({ root: "codex-sessions", engine: "codex" }))).toBe(true);
    expect(canSourcePipeline(file({ root: "claude-projects", engine: "claude", kind: "session" }))).toBe(true);
    /* Claude children scan as kind "subagent" — AC3 must still reach them. */
    expect(canSourcePipeline(file({ root: "claude-projects", engine: "claude", kind: "subagent" }))).toBe(true);
  });
  test("rejects non-claude/codex engines", () => {
    expect(canSourcePipeline(file({ engine: "gemini" as never }))).toBe(false);
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

  test("carries non-empty role params and omits an all-blank map", () => {
    const [withParams, blank, noRole] = draftStagesToInput([
      draft({ roleId: "reviewer", prompt: "review", roleParams: { diffSource: "PR#100", lens: "correctness" } }),
      draft({ roleId: "builder", prompt: "build", roleParams: { mode: "", domain: "" } }),
      draft({ roleId: "", prompt: "raw", roleParams: { ignored: "x" } }),
    ]);
    expect(withParams!.role).toEqual({ roleId: "reviewer", params: { diffSource: "PR#100", lens: "correctness" } });
    /* A role with only blank params drops the params key rather than shipping empties. */
    expect(blank!.role).toEqual({ roleId: "builder" });
    /* Params without a chosen role are never serialized. */
    expect(noRole!.role).toBeUndefined();
  });

  test("trims string params and drops whitespace-only ones the server would reject", () => {
    const [stage] = draftStagesToInput([
      draft({ roleId: "reviewer", prompt: "review", roleParams: { diffSource: "  PR#7  ", lens: "   " } }),
      draft({ roleId: "builder", prompt: "build" }),
    ]);
    /* diffSource trimmed; whitespace-only lens dropped (server boundedText would 400). */
    expect(stage!.role).toEqual({ roleId: "reviewer", params: { diffSource: "PR#7" } });
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

describe("pipelineBoardStripPath (§2.2 board strip anchor)", () => {
  const stages = [stage("plan"), stage("build"), stage("review", "review-loop")];
  const run = (stageId: string, agentPath: string | null) => ({ stageId, attempts: [{ state: "running", agentPath } as never] });

  test("anchors on the current run stage's latest attempt path", () => {
    const p = pipeline({ stages, cursor: { stageId: "build", state: "running" }, runs: [run("plan", "/a"), run("build", "/b")] });
    expect(pipelineBoardStripPath(p)).toBe("/b");
  });

  test("a review-loop current stage yields the slot (null) so FlowStrip owns it", () => {
    const p = pipeline({ stages, cursor: { stageId: "review", state: "reviewing" }, runs: [run("review", "/r")] });
    expect(pipelineBoardStripPath(p)).toBeNull();
  });

  test("an unmaterialized current stage (no agent path) anchors nowhere", () => {
    const p = pipeline({ stages, cursor: { stageId: "build", state: "running" }, runs: [run("build", null)] });
    expect(pipelineBoardStripPath(p)).toBeNull();
  });

  test("a closed pipeline never anchors a strip", () => {
    const p = pipeline({ stages, state: "closed", cursor: { stageId: "build", state: "running" }, runs: [run("build", "/b")] });
    expect(pipelineBoardStripPath(p)).toBeNull();
  });

  test("a completed pipeline falls back to the last stage", () => {
    const done = [stage("plan"), stage("build")];
    const p = pipeline({ stages: done, state: "completed", cursor: null, runs: [run("plan", "/a"), run("build", "/b")] });
    expect(pipelineBoardStripPath(p)).toBe("/b");
  });

  test("pipelineStripByPath maps every anchored pipeline by its node path", () => {
    const a = pipeline({ id: "a", stages, cursor: { stageId: "build", state: "running" }, runs: [run("build", "/b")] });
    const b = pipeline({ id: "b", stages, cursor: { stageId: "review", state: "reviewing" }, runs: [run("review", "/r")] });
    const map = pipelineStripByPath([a, b]);
    expect(map.get("/b")?.id).toBe("a");
    expect(map.has("/r")).toBe(false);
  });
});
