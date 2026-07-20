import { expect, test } from "bun:test";

import type { Pipeline } from "@/lib/pipelines/types";

import { PIPELINE_PLACEHOLDER_STATES, pipelinePlaceholderStages } from "./pipelineModel";

/* A pipeline whose stages materialize one at a time; `runs` decides which stages
   have already launched an attempt (materialized or folded history) and which are
   still future placeholders inside the colored halo (#353 desktop ownership). */
function pipeline(over: Partial<Pipeline>): Pipeline {
  return {
    id: "p", task: "Restore the halo", project: "demo", repoDir: "/r", worktreeDir: "/w",
    branch: "b", baseBranch: "main", baseRef: "a", lastPassedCommit: "a",
    stages: [
      { id: "architect", kind: "run", prompt: "", next: "builder" },
      { id: "builder", kind: "run", prompt: "", next: "review" },
      { id: "review", kind: "review-loop", prompt: "", next: null },
    ],
    runs: [], cursor: null, state: "running", pausedState: null, stateDetail: null,
    srcPath: null, srcConversationId: null, createdAt: "1970", closedAt: null,
    ...over,
  } as unknown as Pipeline;
}

test("every declared stage is a placeholder before anything launches", () => {
  const draft = pipeline({ state: "draft" });
  expect(pipelinePlaceholderStages(draft).map((stage) => stage.id)).toEqual(["architect", "builder", "review"]);
});

test("a launched stage is not a placeholder; only the future stages remain", () => {
  const running = pipeline({
    runs: [{ stageId: "architect", attempts: [{ n: 1, state: "passed", agentPath: "/arch", flowId: null }] }],
  } as unknown as Partial<Pipeline>);
  /* architect ran (a real card / folded history), so only builder + review are
     future placeholders. */
  expect(pipelinePlaceholderStages(running).map((stage) => stage.id)).toEqual(["builder", "review"]);
});

test("a failed or folded attempt is navigable history, never a placeholder", () => {
  /* The builder attempt failed; its transcript is folded, but the stage still ran
     — it must not resurrect a big empty placeholder shell. */
  const failed = pipeline({
    runs: [
      { stageId: "architect", attempts: [{ n: 1, state: "passed", agentPath: "/arch", flowId: null }] },
      { stageId: "builder", attempts: [{ n: 1, state: "failed", agentPath: "/build", flowId: null }] },
    ],
  } as unknown as Partial<Pipeline>);
  expect(pipelinePlaceholderStages(failed).map((stage) => stage.id)).toEqual(["review"]);
});

test("a stage whose attempts have all folded into history stays navigable, never a resurrected placeholder", () => {
  /* The builder ran and its every attempt is now `historical` (folded into the
     compact prior-attempt evidence). The stage still ran, so it must keep its
     compact history at its stage position — reading only the operational attempt
     would report it empty and grow a duplicate empty shell over that history. */
  const folded = pipeline({
    runs: [
      { stageId: "architect", attempts: [{ n: 1, state: "passed", agentPath: "/arch", flowId: null }] },
      { stageId: "builder", attempts: [{ n: 1, state: "passed", agentPath: "/build", flowId: null, historical: true }] },
    ],
  } as unknown as Partial<Pipeline>);
  expect(pipelinePlaceholderStages(folded).map((stage) => stage.id)).toEqual(["review"]);
});

test("a pending/spawning current attempt keeps exactly one placeholder until its transcript materializes (#353 R3)", () => {
  /* The engine created the builder attempt but its transcript has not landed yet
     (agentPath/flowId both null). Across pending → spawning the stage must keep a
     conversation-shaped placeholder — never zero pane / zero placeholder. */
  const architectRun = { stageId: "architect", attempts: [{ n: 1, state: "passed", agentPath: "/arch", flowId: null }] };
  for (const state of ["pending", "spawning"] as const) {
    const forming = pipeline({
      cursor: { stageId: "builder", state, input: null, activatedBy: null },
      runs: [
        architectRun,
        { stageId: "builder", attempts: [{ n: 1, state, agentPath: null, flowId: null }] },
      ],
    } as unknown as Partial<Pipeline>);
    /* architect is materialized (compact history), builder is the forming stage's
       single placeholder, review is a future placeholder. */
    expect(pipelinePlaceholderStages(forming).map((stage) => stage.id)).toEqual(["builder", "review"]);
  }
});

test("the live stage keeps its placeholder across path/flow publication until a board rect is placed, then dissolves (#353 R4)", () => {
  /* The R4 materialization gap: the builder attempt is running and has PUBLISHED
     agentPath="/build", but the scanned conversation has not yet been placed as a
     board rect. Keying off the stored agentPath alone (the pre-R4 predicate) would
     drop the placeholder here and leave the stage with zero surface. Board presence
     — not the stored path — governs: while "/build" is unplaced the builder keeps
     exactly one placeholder; the instant "/build" is a placed rect the placeholder
     dissolves (the live pane owns the slot) with no duplicate. */
  const architectRun = { stageId: "architect", attempts: [{ n: 1, state: "passed", agentPath: "/arch", flowId: null }] };
  const running = pipeline({
    cursor: { stageId: "builder", state: "running", input: null, activatedBy: null },
    runs: [
      architectRun,
      { stageId: "builder", attempts: [{ n: 1, state: "running", agentPath: "/build", flowId: null }] },
    ],
  } as unknown as Partial<Pipeline>);

  /* Path published, but not yet placed (nothing in placedPaths): builder retains
     its single placeholder through the whole publish → scan gap. */
  expect(pipelinePlaceholderStages(running).map((stage) => stage.id)).toEqual(["builder", "review"]);
  expect(pipelinePlaceholderStages(running, new Set(["/arch"])).map((stage) => stage.id)).toEqual(["builder", "review"]);

  /* Once "/build" is a placed board rect the builder placeholder dissolves; only
     the future review stage remains. No duplicate placeholder over the live pane. */
  expect(pipelinePlaceholderStages(running, new Set(["/arch", "/build"])).map((stage) => stage.id)).toEqual(["review"]);
});

test("a live review-loop cursor keeps its placeholder until its flow deck is placed (#353 R4)", () => {
  /* A review-loop cursor materializes through a flow, not a run transcript: its
     board presence is its placed round deck. While the flow's deck is unplaced the
     stage keeps its single placeholder; once the deck id is placed it dissolves. */
  const architectRun = { stageId: "architect", attempts: [{ n: 1, state: "passed", agentPath: "/arch", flowId: null }] };
  const builderRun = { stageId: "builder", attempts: [{ n: 1, state: "passed", agentPath: "/build", flowId: null }] };
  const reviewing = pipeline({
    cursor: { stageId: "review", state: "reviewing", input: null, activatedBy: null },
    runs: [
      architectRun,
      builderRun,
      { stageId: "review", attempts: [{ n: 1, state: "reviewing", agentPath: null, flowId: "f1" }] },
    ],
  } as unknown as Partial<Pipeline>);

  /* Flow published but its deck unplaced: review keeps its placeholder. */
  expect(pipelinePlaceholderStages(reviewing, new Set(["/arch", "/build"])).map((stage) => stage.id)).toEqual(["review"]);
  /* Deck placed: the live review pane owns the slot, no placeholder remains. */
  expect(pipelinePlaceholderStages(reviewing, new Set(["/arch", "/build"]), new Set(["f1"]))).toEqual([]);
});

test("a completed or closed pipeline grows no placeholders", () => {
  for (const state of ["completed", "closed"] as const) {
    expect(pipelinePlaceholderStages(pipeline({ state }))).toEqual([]);
    expect(PIPELINE_PLACEHOLDER_STATES.has(state)).toBe(false);
  }
});

test("an empty (zero-stage) shell grows no placeholders", () => {
  expect(pipelinePlaceholderStages(pipeline({ state: "draft", stages: [] }))).toEqual([]);
});
