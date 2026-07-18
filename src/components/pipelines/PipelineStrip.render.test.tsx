import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { Pipeline, PipelineStage, PipelineStageAttempt, PipelineState } from "@/lib/pipelines/types";
import type { Flow } from "@/lib/flows/types";

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

test("a running retry exposes its prior failed transcript through history", () => {
  const p = pipeline({
    cursor: { stageId: "build", state: "running" },
    runs: [{ stageId: "build", attempts: [
      attempt({ n: 1, state: "failed", agentPath: "/build-1.jsonl", error: "failed" }),
      attempt({ n: 2, state: "running", agentPath: "/build-2.jsonl", error: null }),
    ] }],
  });
  const html = renderToStaticMarkup(
    <PipelineStrip pipeline={p} renderablePaths={new Set(["/build-1.jsonl", "/build-2.jsonl"])} onOpenPath={() => undefined} />,
  );
  expect(html).toContain("Open verdict for stage");
});

test("an active multi-round review exposes its earlier reviewer transcript through history", () => {
  const review = stage("review", "review-loop");
  const p = pipeline({
    stages: [stage("build"), review],
    cursor: { stageId: "review", state: "reviewing" },
    runs: [{ stageId: "review", attempts: [attempt({ n: 1, state: "reviewing", agentPath: "/round-2.jsonl", flowId: "flow-1" })] }],
  });
  const flows = [{
    id: "flow-1",
    implementerPath: "/builder.jsonl",
    rounds: [{ n: 1, reviewerPath: "/round-1.jsonl" }, { n: 2, reviewerPath: "/round-2.jsonl" }],
  }] as unknown as Flow[];
  const html = renderToStaticMarkup(
    <PipelineStrip
      pipeline={p}
      flows={flows}
      renderablePaths={new Set(["/round-1.jsonl", "/round-2.jsonl"])}
      onOpenPath={() => undefined}
    />,
  );
  expect(html).toContain("Open verdict for stage");
});

test("an empty draft's strip disables Start until it holds 2 stages (#136)", () => {
  /* Isolate the opening tag of the button wrapping the given label. */
  const startTag = (html: string, label: string) => {
    const at = html.indexOf(label);
    const open = html.lastIndexOf("<button", at);
    return html.slice(open, html.indexOf(">", open));
  };
  /* Assert on the `disabled=""` attribute; the class list also carries the token
     `disabled:opacity-40`, which a bare substring check would match. */
  const empty = pipeline({ state: "draft", stages: [], runs: [], cursor: null });
  expect(startTag(render(empty), "Start pipeline")).toContain('disabled=""');
  /* Once it reaches the 2-stage floor, Start is live. */
  const two = pipeline({ state: "draft", stages: [stage("a"), stage("b")], runs: [], cursor: { stageId: "a", state: "pending" } });
  expect(startTag(render(two), "Start pipeline")).not.toContain('disabled=""');
});

test("the status dot follows the tone matrix (accent busy, amber attention, ok done)", () => {
  const dotClass = (state: PipelineState, over: Partial<Pipeline> = {}) => {
    const html = render(pipeline({ state, ...over }));
    return html.slice(0, html.indexOf("aria-hidden"));
  };
  /* Running → accent, never green; needs_decision + paused → warning, never red. */
  expect(dotClass("running")).toContain("bg-accent");
  expect(dotClass("needs_decision")).toContain("bg-warning");
  expect(dotClass("paused")).toContain("bg-warning");
  expect(dotClass("completed")).toContain("bg-success");
  /* Red is reserved for chip/verdict failures — the dot never uses it. */
  expect(render(pipeline({ state: "needs_decision" }))).not.toContain("rounded-full bg-danger");
});

test("the compact pipeline surface exposes the full pinned base SHA", () => {
  const baseRef = "48c739bbcc87b3244aee7fb0e2d1b3f8e312548f";
  const html = renderToStaticMarkup(<PipelineStrip pipeline={pipeline({ baseRef, lastPassedCommit: baseRef })} compact />);

  expect(html).toContain(`Base ${baseRef}`);
});

test("mobile contains the rail and defers diagnostics while desktop markup stays complete", () => {
  const baseRef = "48c739bbcc87b3244aee7fb0e2d1b3f8e312548f";
  const stages = [stage("plan"), stage("build")];
  const passed = attempt({
    state: "passed",
    agentPath: "/build.jsonl",
    startedAt: "2026-07-18T10:00:00.000Z",
    completedAt: "2026-07-18T10:01:30.000Z",
    verdict: { status: "pass", findings: [], confidence: 0.95 },
  });
  const p = pipeline({
    baseRef,
    lastPassedCommit: baseRef,
    stages,
    runs: [{ stageId: "build", attempts: [passed] }],
  });
  const mobile = renderToStaticMarkup(
    <PipelineStrip mobile pipeline={p} renderablePaths={new Set(["/build.jsonl"])} onOpenPath={() => undefined} />,
  );
  const desktop = renderToStaticMarkup(
    <PipelineStrip pipeline={p} renderablePaths={new Set(["/build.jsonl"])} onOpenPath={() => undefined} />,
  );

  expect(mobile).toContain("max-w-full");
  expect(mobile).toContain("overflow-hidden");
  expect(mobile).toContain("justify-start");
  expect(mobile).not.toContain(`Base ${baseRef}`);
  expect(mobile).not.toContain("data-stage-evidence");
  expect(mobile).not.toContain("Open previous stage plan");

  expect(desktop).toContain("justify-center");
  expect(desktop).toContain(`Base ${baseRef}`);
  expect(desktop).toContain('data-stage-evidence="passed"');
  expect(desktop).toContain("Open previous stage plan");
});

test("mobile compacts empty stages while a parked decision keeps its full controls", () => {
  const build = stage("build");
  const pending = renderToStaticMarkup(
    <PipelineStrip
      mobile
      pipeline={pipeline({ state: "draft", stages: [build], cursor: { stageId: build.id, state: "pending" } })}
    />,
  );
  const parked = renderToStaticMarkup(
    <PipelineStrip
      mobile
      pipeline={pipeline({
        state: "needs_decision",
        stages: [build],
        cursor: { stageId: build.id, state: "running" },
        runs: [{ stageId: build.id, attempts: [attempt({ state: "needs_decision", agentPath: null })] }],
      })}
    />,
  );

  expect(pending).toContain('data-stage-compact="true"');
  expect(pending).toContain('aria-label="build, pending"');
  expect(pending).toContain("h-11 w-11");
  expect(pending).not.toContain(">build</span>");

  expect(parked).not.toContain("data-stage-compact");
  expect(parked).toContain("max-w-[180px]");
  expect(parked).toContain('aria-label="Retry stage"');
  expect(parked).toContain('aria-label="Skip"');
});

test("compact history exposes evidence, configuration, and ordered lineage controls (#353)", () => {
  const stages = [stage("plan"), stage("build"), stage("verify")];
  const passed = attempt({
    state: "passed",
    agentPath: "/build.jsonl",
    startedAt: "2026-07-18T10:00:00.000Z",
    completedAt: "2026-07-18T10:01:30.000Z",
    effectiveRole: { roleId: "builder", engine: "codex", model: "gpt-5.6-sol", effort: "high", access: "read-write", promptScaffold: null },
    verdict: { status: "pass", findings: [], confidence: 0.95 },
  });
  const html = renderToStaticMarkup(
    <PipelineStrip
      pipeline={pipeline({
        stages,
        state: "draft",
        cursor: { stageId: "verify", state: "pending" },
        runs: [{ stageId: "build", attempts: [passed] }],
      })}
      renderablePaths={new Set(["/build.jsonl"])}
      onOpenPath={() => undefined}
      linkedTasks={[{
        id: "task-1", project: "proj", status: "assigned", text: "Verify compact board\nDetails", placement: "unplaced", assignments: [],
        createdAt: "2026-07-18T00:00:00Z", updatedAt: "2026-07-18T00:00:00Z",
      }]}
      onOpenTask={() => undefined}
    />,
  );

  expect(html).toContain("<ol");
  expect(html).toContain('data-stage-evidence="passed"');
  expect(html).toContain("1:30");
  expect(html).toContain("gpt-5.6-sol");
  expect(html).toContain("Configure stage verify, state pending");
  expect(html).toContain("Open transcript for stage build, state passed");
  expect(html).toContain("Stage lineage from plan to build");
  expect(html).toContain("Open previous stage plan, state pending");
  expect(html).toContain("Open next stage build, state passed");
  expect(html).toContain("Open verdict for stage build, state passed");
  expect(html).toContain("Open linked task Verify compact board");
  const previousAt = html.indexOf("Open previous stage plan, state pending");
  const previousButton = html.slice(html.lastIndexOf("<button", previousAt), html.indexOf(">", previousAt));
  expect(previousButton).not.toContain('disabled=""');
});

test("every linked task keeps a direct control inside the bounded rail (#353)", () => {
  const linkedTasks = Array.from({ length: 5 }, (_, index) => ({
    id: `task-${index + 1}`, project: "proj", status: "assigned" as const, text: `Linked ${index + 1}`,
    placement: "unplaced" as const, assignments: [], createdAt: "2026-07-18T00:00:00Z", updatedAt: "2026-07-18T00:00:00Z",
  }));
  const html = renderToStaticMarkup(
    <PipelineStrip pipeline={pipeline({ state: "draft" })} linkedTasks={linkedTasks} onOpenTask={() => undefined} />,
  );

  for (let index = 1; index <= 5; index += 1) expect(html).toContain(`Open linked task Linked ${index}`);
  expect(html).toContain("overflow-x-auto");
  expect(html).not.toContain("+2");
});

test("the compact board strip is one bounded scrolling row — it can never wrap over the pane below (#353)", () => {
  const linkedTasks = Array.from({ length: 4 }, (_, index) => ({
    id: `task-${index + 1}`, project: "proj", status: "assigned" as const, text: `Linked ${index + 1}`,
    placement: "unplaced" as const, assignments: [], createdAt: "2026-07-18T00:00:00Z", updatedAt: "2026-07-18T00:00:00Z",
  }));
  const parked = pipeline({ state: "needs_decision", cursor: { stageId: "build", state: "running" } });
  const compact = renderToStaticMarkup(<PipelineStrip pipeline={parked} linkedTasks={linkedTasks} compact onOpenTask={() => undefined} />);
  /* The board mounts anchor the strip's TOP inside the group's 44px headroom /
     above a node's pane; a wrapped second row paints over the chat. The compact
     root therefore never wraps — it scrolls internally instead. */
  const root = compact.slice(compact.indexOf("Pipeline "), compact.indexOf("<span"));
  expect(root).toContain("flex-nowrap");
  expect(root).toContain("overflow-x-auto");
  expect(root).not.toContain("flex-wrap");
  /* Everything stays reachable inside the scroller: tasks + full controls. */
  for (let index = 1; index <= 4; index += 1) expect(compact).toContain(`Open linked task Linked ${index}`);
  expect(compact).toContain("Retry stage");
  /* The standalone (builder-panel) strip keeps its wrapping layout. */
  const standalone = renderToStaticMarkup(<PipelineStrip pipeline={parked} linkedTasks={linkedTasks} onOpenTask={() => undefined} />);
  expect(standalone.slice(standalone.indexOf("Pipeline "), standalone.indexOf("<span"))).toContain("flex-wrap");
});

test("the mobile action row shrinks and wraps inside the rail — no button is clipped off-screen (#156 AC6)", () => {
  const parked = pipeline({ state: "needs_decision", cursor: { stageId: "build", state: "running" } });
  const mobile = renderToStaticMarkup(<PipelineStrip mobile pipeline={parked} />);
  /* `shrink-0` keeps the row max-content wide and the rail's overflow clip cuts
     the trailing buttons (Close pipeline) off-screen at 390px. */
  expect(mobile).toContain('class="flex flex-wrap items-center gap-1.5 min-w-0 shrink"');
  const desktop = renderToStaticMarkup(<PipelineStrip pipeline={parked} />);
  expect(desktop).toContain('class="flex flex-wrap items-center gap-1.5 shrink-0"');
});
