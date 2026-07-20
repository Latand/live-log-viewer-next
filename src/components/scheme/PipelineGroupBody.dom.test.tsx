import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { Pipeline } from "@/lib/pipelines/types";

import { PipelineGroupBody } from "./PipelineGroupBody";

/* A three-stage pipeline: two run stages and a review loop. The body must render
   every declared stage as a real conversation-card shell, inline in the group. */
const basePipeline = {
  id: "p1", task: "Refactor the board", project: "demo", repoDir: "/r", worktreeDir: "/w",
  branch: "b", baseBranch: "main", baseRef: "a", lastPassedCommit: "a",
  stages: [
    { id: "plan", kind: "run", prompt: "", next: "build", onFail: null, effectiveRole: { roleId: null, engine: "codex", model: null, effort: null, access: "read-write", promptScaffold: null } },
    { id: "build", kind: "run", prompt: "", next: "review", onFail: null, effectiveRole: { roleId: null, engine: "codex", model: null, effort: null, access: "read-write", promptScaffold: null } },
    { id: "review", kind: "review-loop", prompt: "", next: null, onFail: null, effectiveRole: { roleId: null, engine: "codex", model: null, effort: null, access: "read-only", promptScaffold: null } },
  ],
  runs: [], cursor: { stageId: "plan", state: "running", input: null, activatedBy: null }, state: "running",
  pausedState: null, stateDetail: null, srcPath: null, srcConversationId: null,
  createdAt: new Date(0).toISOString(), closedAt: null,
} as unknown as Pipeline;

const render = (pipeline: Pipeline) =>
  renderToStaticMarkup(<PipelineGroupBody pipeline={pipeline} flows={[]} onOpenAttempt={() => {}} onClose={() => {}} />);

test("the group body hosts one real conversation-card graph for every declared stage (#353)", () => {
  const html = render(basePipeline);
  /* The body IS the pipeline editor surface (a11y dialog) and mounts the real
     conversation-card shells — exactly one graph, not a detached second surface. */
  expect(html).toContain('data-group-override="pipeline"');
  expect(html.match(/data-pipeline-stage-graph/g)).toHaveLength(1);
  const nodes = html.match(/data-stage-graph-node=/g) ?? [];
  expect(nodes.length).toBe(3);
  expect(html).toContain('data-stage-graph-node="plan"');
  expect(html).toContain('data-stage-graph-node="build"');
  expect(html).toContain('data-stage-graph-node="review"');
});

test("the body never emits a fixed-height slab wrapper around its cards (#353)", () => {
  /* The old regression sized the body to a fixed 444px slab; the content-sized
     body must carry no hard-coded pixel height on any wrapper it owns. */
  const html = render(basePipeline);
  expect(html).not.toMatch(/height:\s*444px/);
  expect(html).not.toContain("data-scheme-group-strip");
});

test("a running pipeline body exposes Pause + Close lifecycle controls (#353)", () => {
  const html = render(basePipeline);
  expect(html).toContain("Pause pipeline");
  expect(html).toContain("Close pipeline");
});

test("a draft pipeline body keeps metadata, Start, and Discard beside its cards (#353)", () => {
  const draft = {
    ...basePipeline,
    state: "draft",
    runs: basePipeline.stages.map((stage) => ({ stageId: stage.id, attempts: [] })),
    cursor: { stageId: "plan", state: "pending", input: null, activatedBy: null },
  } as Pipeline;
  const html = render(draft);
  /* Draft metadata is a compact field group — never the removed tall
     nested-scroll stage form. */
  expect(html).toContain("Start pipeline");
  expect(html).toContain("Discard draft");
  expect(html).toContain('data-pipeline-stage-graph');
  /* The on-canvas add-node action bar is the draft editor path. */
  expect(html).toContain("data-stage-graph-actions");
});
