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

test("a verdict-less prior attempt renders a translated state label", () => {
  /* Prior attempt #1 has no structured verdict and state needs_decision; the audit
     must show the localized label, never the English identifier "needs_decision". */
  const priorNoVerdict = attempt(1, { state: "needs_decision", verdict: null });
  const current = attempt(2, { verdict: { status: "pass", findings: [] } });
  const html = renderToStaticMarkup(
    <VerdictPopover pipeline={pipeline([priorNoVerdict, current])} stage={stage} attempt={current} onClose={() => {}} />,
  );
  expect(html).toContain("Attempt 1: needs a decision");
  expect(html).not.toContain("Attempt 1: needs_decision");
});

test("an oversized retry history bounds the popover and scrolls the audit", () => {
  /* Many retries would otherwise grow the popover past the viewport and push the
     Retry/Skip footer off-screen; the root is capped and the audit scrolls. */
  const attempts = Array.from({ length: 25 }, (_, i) => attempt(i + 1, { verdict: { status: "fail", findings: [] } }));
  const current = attempts.at(-1)!;
  const html = renderToStaticMarkup(
    <VerdictPopover pipeline={pipeline(attempts)} stage={stage} attempt={current} onClose={() => {}} />,
  );
  /* Popover height is bounded, and the prior-attempt audit is a bounded scroll. */
  expect(html).toContain("max-h-[80vh]");
  expect(html).toContain("max-h-24");
  expect(html).toContain("overflow-y-auto");
  /* Attempt 24 (the last prior) is still present, just inside the scroll region. */
  expect(html).toContain("Attempt 24:");
});

test("a review-loop verdict offers Open flow and hides the folded-transcript action", () => {
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

test("Open transcript is withheld when the run transcript left the scan", () => {
  /* A run stage whose transcript vanished (canOpenPath=false) must not offer an
     action that would no-op on a missing file. */
  const only = attempt(1, { agentPath: "/gone.jsonl", verdict: { status: "fail", findings: [] } });
  const html = renderToStaticMarkup(
    <VerdictPopover pipeline={pipeline([only])} stage={stage} attempt={only} canOpenPath={false} onClose={() => {}} onOpenPath={() => {}} />,
  );
  expect(html).not.toContain("Open transcript");
});

test("Open review is withheld when the flow no longer has a board deck", () => {
  const reviewStage: PipelineStage = { ...stage, id: "review", kind: "review-loop" };
  /* A closed/missing flow (canOpenFlow=false) has no deck to reveal, so the
     action is not offered — it would route to an absent board entry. */
  const only = attempt(1, { agentPath: "/reviewer.jsonl", flowId: "f1", verdict: { status: "fail", findings: [] } });
  const html = renderToStaticMarkup(
    <VerdictPopover pipeline={pipeline([only])} stage={reviewStage} attempt={only} canOpenFlow={false} onClose={() => {}} onOpenPath={() => {}} onOpenFlow={() => {}} />,
  );
  expect(html).not.toContain("Open review");
  expect(html).not.toContain("Open transcript");
});
