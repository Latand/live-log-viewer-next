import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { Pipeline, PipelineStage, PipelineStageAttempt, PipelineState } from "@/lib/pipelines/types";

import { PipelineStrip } from "./PipelineStrip";

function stage(id: string, kind: PipelineStage["kind"] = "run"): PipelineStage {
  return { id, kind, prompt: "", next: null, effectiveRole: { roleId: null, engine: "codex", model: null, effort: null, access: "read-write", promptScaffold: null } } as PipelineStage;
}

function attempt(over: Partial<PipelineStageAttempt> = {}): PipelineStageAttempt {
  return {
    n: 1, state: "failed", effectiveRole: { roleId: null, engine: "codex", model: null, effort: null, access: "read-write", promptScaffold: null },
    launchId: null, conversationId: null, sessionId: null, agentPath: "/s.jsonl", paneId: null, flowId: null,
    startedAt: null, completedAt: null, output: null, verdict: null, error: null, ...over,
  };
}

function pipeline(over: Partial<Pipeline>): Pipeline {
  return {
    id: "p1", task: "t", project: "proj", repoDir: "/r", worktreeDir: "/w", branch: "b", baseBranch: "main",
    baseRef: "a", lastPassedCommit: "a", stages: [stage("build")], runs: [], cursor: null, state: "running",
    pausedState: null, stateDetail: null, srcPath: null, srcConversationId: null, createdAt: new Date(0).toISOString(), closedAt: null,
    ...over,
  } as Pipeline;
}

const render = (p: Pipeline) => renderToStaticMarkup(<PipelineStrip pipeline={p} />);

test("a verdict-less errored attempt still exposes the verdict popover trigger", () => {
  const p = pipeline({ runs: [{ stageId: "build", attempts: [attempt({ state: "failed", error: "spawn failed: tmux pane gone" })] }] });
  /* No verdict, but the error must be reachable — the trigger renders. */
  expect(render(p)).toContain("Open verdict for stage");
});

test("a parked stage without a verdict exposes the trigger for Retry/Skip", () => {
  const p = pipeline({
    state: "needs_decision",
    cursor: { stageId: "build", state: "running" },
    runs: [{ stageId: "build", attempts: [attempt({ state: "needs_decision", verdict: null })] }],
  });
  expect(render(p)).toContain("Open verdict for stage");
});

test("a running attempt with no verdict, error, or park shows no trigger", () => {
  const p = pipeline({ cursor: { stageId: "build", state: "running" }, runs: [{ stageId: "build", attempts: [attempt({ state: "running", error: null })] }] });
  expect(render(p)).not.toContain("Open verdict for stage");
});

test("the status dot follows the tone matrix (accent busy, amber attention, ok done)", () => {
  const dotClass = (state: PipelineState, over: Partial<Pipeline> = {}) => {
    const html = render(pipeline({ state, ...over }));
    return html.slice(0, html.indexOf("aria-hidden"));
  };
  /* Running → accent, never green; needs_decision + paused → amber, never red. */
  expect(dotClass("running")).toContain("bg-accent");
  expect(dotClass("needs_decision")).toContain("bg-[#e0ae45]");
  expect(dotClass("paused")).toContain("bg-[#e0ae45]");
  expect(dotClass("completed")).toContain("bg-ok");
  /* Red is reserved for chip/verdict failures — the dot never uses it. */
  expect(render(pipeline({ state: "needs_decision" }))).not.toContain("rounded-full bg-err");
});
