import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { Pipeline, PipelineStage, PipelineStageAttempt } from "@/lib/pipelines/types";
import type { Flow } from "@/lib/flows/types";
import type { FileEntry } from "@/lib/types";

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
    input: null,
    activatedBy: null,
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

test("a review-loop verdict keeps direct transcript and flow navigation", () => {
  const reviewStage: PipelineStage = { ...stage, id: "review", kind: "review-loop" };
  const only = attempt(1, { agentPath: "/reviewer.jsonl", flowId: "f1", verdict: { status: "fail", findings: [] } });
  const html = renderToStaticMarkup(
    <VerdictPopover pipeline={pipeline([only])} stage={reviewStage} attempt={only} onClose={() => {}} onOpenPath={() => {}} onOpenFlow={() => {}} />,
  );
  expect(html).toContain("Open transcript");
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

test("a compacted review keeps transcript navigation when its deck leaves the board", () => {
  const reviewStage: PipelineStage = { ...stage, id: "review", kind: "review-loop" };
  /* A closed/missing flow (canOpenFlow=false) has no deck to reveal, so the
     action is not offered — it would route to an absent board entry. */
  const only = attempt(1, { agentPath: "/reviewer.jsonl", flowId: "f1", verdict: { status: "fail", findings: [] } });
  const html = renderToStaticMarkup(
    <VerdictPopover pipeline={pipeline([only])} stage={reviewStage} attempt={only} canOpenFlow={false} onClose={() => {}} onOpenPath={() => {}} onOpenFlow={() => {}} />,
  );
  expect(html).not.toContain("Open review");
  expect(html).toContain("Open transcript");
});

test("bounded history keeps direct transcript actions for every retry and review round (#353)", () => {
  const reviewStage: PipelineStage = { ...stage, id: "review", kind: "review-loop" };
  const prior = attempt(1, { agentPath: "/review-attempt-1.jsonl", flowId: "f0" });
  const current = attempt(2, { agentPath: "/review-attempt-2.jsonl", flowId: "f1", verdict: { status: "pass", findings: [] } });
  const flows = [{
    id: "f1", implementerPath: "/builder.jsonl", rounds: [
      { n: 1, reviewerPath: "/round-1.jsonl" },
      { n: 2, reviewerPath: "/review-attempt-2.jsonl" },
    ],
  }] as unknown as Flow[];
  const reviewPipeline = pipeline([prior, current]);
  reviewPipeline.stages = [reviewStage];
  reviewPipeline.runs = [{ stageId: reviewStage.id, attempts: [prior, current] }];
  const html = renderToStaticMarkup(
    <VerdictPopover
      pipeline={reviewPipeline}
      stage={reviewStage}
      attempt={current}
      flows={flows}
      availablePaths={new Set([prior.agentPath!, current.agentPath!, "/round-1.jsonl"])}
      onClose={() => {}}
      onOpenPath={() => {}}
    />,
  );

  expect(html).toContain("Open transcript for attempt 1");
  expect(html).toContain("Open transcript for attempt 2");
  expect(html).toContain("Open review transcript 1");
  expect(html).toContain("max-h-24");
});

test("one logical round exposes every durable reviewer binding with the current binding last (#353)", () => {
  const reviewStage: PipelineStage = { ...stage, id: "review", kind: "review-loop" };
  const current = attempt(1, { agentPath: "/review-current.jsonl", flowId: "flow-1", state: "reviewing", verdict: null });
  const reviewPipeline = pipeline([current]);
  reviewPipeline.stages = [reviewStage];
  reviewPipeline.runs = [{ stageId: reviewStage.id, attempts: [current] }];
  const membership = (slot: string) => ({
    kind: "flow" as const,
    containerId: "flow-1",
    role: "reviewer",
    slot,
    stageId: null,
    stageOrder: null,
    round: 1,
    parentConversationId: "conversation-builder",
  });
  const files = [
    {
      path: "/review-prior.jsonl",
      conversationId: "conversation-review-prior",
      durableLineage: {
        kind: "review",
        role: "reviewer",
        parentConversationId: "conversation-builder",
        reviewsConversationId: "conversation-builder",
        memberships: [membership("reviewer:1:binding-a")],
      },
    },
    {
      path: current.agentPath,
      conversationId: "conversation-review-current",
      durableLineage: {
        kind: "review",
        role: "reviewer",
        parentConversationId: "conversation-builder",
        reviewsConversationId: "conversation-builder",
        memberships: [membership("reviewer:1:binding-b")],
      },
    },
  ] as unknown as FileEntry[];
  const flows = [{
    id: "flow-1",
    implementerPath: "/builder.jsonl",
    rounds: [{ n: 1, reviewerPath: current.agentPath, reviewerConversationId: "conversation-review-current" }],
  }] as unknown as Flow[];

  const html = renderToStaticMarkup(
    <VerdictPopover
      pipeline={reviewPipeline}
      stage={reviewStage}
      attempt={current}
      flows={flows}
      files={files}
      availablePaths={new Set(files.map((file) => file.path))}
      onClose={() => {}}
      onOpenPath={() => {}}
    />,
  );

  const priorAt = html.indexOf("Open review transcript 1");
  const currentAt = html.indexOf("Open transcript for attempt 1");
  expect(priorAt).toBeGreaterThan(-1);
  expect(currentAt).toBeGreaterThan(priorAt);
});
