import { describe, expect, test } from "bun:test";

import type { FileEntry } from "@/lib/types";
import type { Pipeline, PipelineStage } from "@/lib/pipelines/types";

import type { TFunction } from "@/lib/i18n";

import {
  PIPELINE_TEMPLATES,
  STAGE_GLYPH,
  type DraftStage,
  attemptStateLabel,
  canSourcePipeline,
  deriveStageId,
  draftStagesToInput,
  normalizeStageOrder,
  pipelineAnnouncement,
  pipelineBoardStripPath,
  pipelineCursorActive,
  pipelineNeedsAttention,
  pipelineStripByPath,
  renderableFlowIds,
  stageChipState,
  stageHasEvidence,
  stageOpenTarget,
} from "./pipelineModel";
import type { Flow } from "@/lib/flows/types";

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

  test("pausing a running pipeline keeps the cursor stage active while unreached stages stay pending", () => {
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
    /* A role with only blank params drops the params key, so no empties ship. */
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

  test("sends engine/model/effort only when the runtime is overridden", () => {
    const [a, b] = draftStagesToInput([
      /* Autofilled row with no override: omit runtime so the server resolves the
         current role/Builder default, so a catalog value can't freeze. */
      draft({ prompt: "a", engine: "claude", model: "fable", effort: "high" }),
      /* Hand-overridden row ships its explicit runtime. */
      draft({ prompt: "b", model: "opus", effort: "high", engine: "claude", runtimeOverridden: true }),
    ]);
    expect(a!.engine).toBeUndefined();
    expect(a!.model).toBeUndefined();
    expect(a!.effort).toBeUndefined();
    expect(b!.engine).toBe("claude");
    expect(b!.model).toBe("opus");
    expect(b!.effort).toBe("high");
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

describe("stageOpenTarget (reviewer paths route to the flow deck, never the folded node)", () => {
  const runStage = stage("build");
  const reviewStage = stage("review", "review-loop");
  const attempt = (over: Record<string, unknown>) => ({ n: 1, state: "running", agentPath: null, flowId: null, ...over }) as never;

  test("a run stage opens its own node by path", () => {
    expect(stageOpenTarget(runStage, attempt({ agentPath: "/build" }))).toEqual({ kind: "path", path: "/build" });
  });

  test("a review-loop stage routes to its embedded flow, never the reviewer path", () => {
    /* agentPath here is the reviewer transcript the board folds into the deck. */
    expect(stageOpenTarget(reviewStage, attempt({ agentPath: "/reviewer", flowId: "f1" }))).toEqual({ kind: "flow", flowId: "f1" });
  });

  test("a review-loop stage with no flow yet has no open target (no dead path click)", () => {
    expect(stageOpenTarget(reviewStage, attempt({ agentPath: "/reviewer", flowId: null }))).toBeNull();
  });

  test("an unmaterialized stage opens nothing", () => {
    expect(stageOpenTarget(runStage, null)).toBeNull();
    expect(stageOpenTarget(runStage, attempt({ agentPath: null }))).toBeNull();
  });

  test("a review-loop whose flow is not renderable (closed/missing) has no open target", () => {
    /* renderableFlows excludes closed/absent flows, so the action is disabled
       so it never routes to a deck the board never draws. */
    const renderable = new Set<string>(["f1"]);
    expect(stageOpenTarget(reviewStage, attempt({ flowId: "f1" }), renderable)).toEqual({ kind: "flow", flowId: "f1" });
    expect(stageOpenTarget(reviewStage, attempt({ flowId: "gone" }), renderable)).toBeNull();
    /* A run stage is unaffected by the flow set. */
    expect(stageOpenTarget(runStage, attempt({ agentPath: "/build" }), renderable)).toEqual({ kind: "path", path: "/build" });
  });

  test("a run stage whose transcript left the scan has no open target (AC4)", () => {
    /* renderablePaths gates run targets: a present path opens, a vanished one
       disables the action, so it never no-ops on a missing file. */
    const present = new Set<string>(["/build"]);
    expect(stageOpenTarget(runStage, attempt({ agentPath: "/build" }), undefined, present)).toEqual({ kind: "path", path: "/build" });
    expect(stageOpenTarget(runStage, attempt({ agentPath: "/gone" }), undefined, present)).toBeNull();
    /* Without the set (no gating) the path opens as before. */
    expect(stageOpenTarget(runStage, attempt({ agentPath: "/gone" }))).toEqual({ kind: "path", path: "/gone" });
  });
});

describe("renderableFlowIds (a deck exists only when the implementer is placed)", () => {
  const flow = (id: string, implementerPath: string, state = "running"): Flow => ({ id, implementerPath, state } as unknown as Flow);

  test("a scanned-but-unplaced implementer is excluded (present-in-scan, absent-from-layout)", () => {
    const flows = [flow("f1", "/impl-1"), flow("f2", "/impl-2"), flow("closed", "/impl-3", "closed")];
    /* placedPaths carries the layout's node paths; the scan is broader. /impl-2 is
       still scanned while its node stays unplaced (hidden/tombstoned), so f2 has
       zero decks despite being active and must be excluded. */
    const placedLayoutNodes = new Set<string>(["/impl-1", "/impl-3"]);
    const ids = renderableFlowIds(flows, placedLayoutNodes);
    expect(ids.has("f1")).toBe(true);
    expect(ids.has("f2")).toBe(false);
    /* A closed flow is excluded even though its implementer is placed. */
    expect(ids.has("closed")).toBe(false);
  });

  test("no placed paths means no rendered decks", () => {
    expect(renderableFlowIds([flow("f1", "/impl-1")], new Set()).size).toBe(0);
  });
});

describe("stageHasEvidence (running attempts have no verdict sheet)", () => {
  const runStage = stage("build");
  const p = (over: Partial<Pipeline>) => pipeline({ stages: [runStage], ...over });
  const att = (over: Record<string, unknown>) => ({ n: 1, state: "running", verdict: null, error: null, ...over }) as never;

  test("a running attempt with no verdict/error/park has no evidence", () => {
    expect(stageHasEvidence(p({ state: "running" }), runStage, att({ state: "running" }))).toBe(false);
  });
  test("a verdict, an error, or a park on this stage each count as evidence", () => {
    expect(stageHasEvidence(p({}), runStage, att({ verdict: { status: "fail" } }))).toBe(true);
    expect(stageHasEvidence(p({}), runStage, att({ error: "spawn failed" }))).toBe(true);
    expect(stageHasEvidence(p({ state: "needs_decision", cursor: { stageId: "build", state: "running" } }), runStage, att({}))).toBe(true);
  });
  test("no attempt is no evidence", () => {
    expect(stageHasEvidence(p({}), runStage, null)).toBe(false);
  });
});

test("attemptStateLabel maps every raw attempt state through a translated key", () => {
  const states = ["pending", "spawning", "running", "reviewing", "committing", "passed", "failed", "needs_decision", "skipped"] as const;
  for (const state of states) {
    expect(attemptStateLabel(fakeT, state)).toBe(`pipelineChipState.${state}`);
  }
});

test("every stage-chip state carries a distinct, non-empty glyph (AC4/AC8)", () => {
  const glyphs = Object.values(STAGE_GLYPH);
  /* No blank glyph (pending used to be empty) and no two states share one, so
     color/animation is never the sole differentiator — running vs committing
     included. */
  expect(glyphs.every((glyph) => glyph.length > 0)).toBe(true);
  expect(new Set(glyphs).size).toBe(glyphs.length);
});

test("pipelineNeedsAttention flags parked and paused while a closed pipeline clears it", () => {
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
