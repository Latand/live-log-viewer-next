import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { Pipeline, PipelineStage, PipelineStageAttempt } from "@/lib/pipelines/types";

import { VerdictPopover } from "./VerdictPopover";

function attempt(n: number, over: Partial<PipelineStageAttempt> = {}): PipelineStageAttempt {
  return {
    n,
    state: "failed",
    effectiveRole: { roleId: null, engine: "codex", model: null, effort: null, access: "read-write", promptScaffold: null },
    launchId: null,
    conversationId: null,
    sessionId: null,
    agentPath: `/stage-${n}.jsonl`,
    paneId: null,
    flowId: null,
    startedAt: null,
    completedAt: null,
    output: null,
    verdict: { status: "fail", findings: [] },
    error: null,
    ...over,
  };
}

const stage: PipelineStage = {
  id: "build",
  kind: "run",
  prompt: "",
  next: null,
  effectiveRole: { roleId: null, engine: "codex", model: null, effort: null, access: "read-write", promptScaffold: null },
};

function pipeline(attempts: PipelineStageAttempt[]): Pipeline {
  return {
    id: "p1", task: "t", project: "proj", repoDir: "/repo", worktreeDir: "/wt", branch: "b", baseBranch: "main",
    baseRef: "abc", lastPassedCommit: "abc", stages: [stage], runs: [{ stageId: "build", attempts }],
    cursor: null, state: "running", pausedState: null, stateDetail: null, srcPath: null, srcConversationId: null,
    createdAt: new Date(0).toISOString(), closedAt: null,
  } as Pipeline;
}

test("the prior-attempts audit excludes the current attempt shown in the header", () => {
  const current = attempt(2, { verdict: { status: "pass", findings: [] } });
  const html = renderToStaticMarkup(
    <VerdictPopover pipeline={pipeline([attempt(1), current])} stage={stage} attempt={current} onClose={() => {}} />,
  );
  /* Attempt 1 is the only earlier attempt; the header already represents #2. */
  expect(html).toContain("Attempt 1:");
  expect(html).not.toContain("Attempt 2:");
});

test("a first attempt shows no earlier-attempts section", () => {
  const only = attempt(1);
  const html = renderToStaticMarkup(
    <VerdictPopover pipeline={pipeline([only])} stage={stage} attempt={only} onClose={() => {}} />,
  );
  expect(html).not.toContain("Earlier attempts");
});

test("a review-loop verdict offers Open flow, not the folded reviewer transcript", () => {
  const reviewStage: PipelineStage = { ...stage, id: "review", kind: "review-loop" };
  /* agentPath is the reviewer transcript the board folds into the deck, so
     "Open transcript" must be withheld; only the flow route is offered. */
  const only = attempt(1, { agentPath: "/reviewer.jsonl", flowId: "f1", verdict: { status: "fail", findings: [] } });
  const html = renderToStaticMarkup(
    <VerdictPopover pipeline={pipeline([only])} stage={reviewStage} attempt={only} onClose={() => {}} onOpenPath={() => {}} onOpenFlow={() => {}} />,
  );
  expect(html).not.toContain("Open transcript");
  expect(html).toContain("Open review");
});
