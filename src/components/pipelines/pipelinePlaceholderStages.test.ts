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
     conversation-shaped placeholder — never zero pane / zero placeholder — and the
     placeholder must dissolve the instant the running attempt materializes a
     transcript. */
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

  const running = pipeline({
    cursor: { stageId: "builder", state: "running", input: null, activatedBy: null },
    runs: [
      architectRun,
      { stageId: "builder", attempts: [{ n: 1, state: "running", agentPath: "/build", flowId: null }] },
    ],
  } as unknown as Partial<Pipeline>);
  /* The builder placeholder dissolved once its transcript materialized. */
  expect(pipelinePlaceholderStages(running).map((stage) => stage.id)).toEqual(["review"]);
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
