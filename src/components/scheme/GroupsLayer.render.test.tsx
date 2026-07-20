import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { GroupsLayer, groupLabelScreenPx, groupLabelFontSize } from "./nodes";
import type { SchemeGroup } from "./layout";
import type { Pipeline } from "@/lib/pipelines/types";

/* A provisioning pipeline whose current stage has NOT materialized a run-stage
   session, so it has no per-node strip — the group halo must carry the plan. */
const planPipeline = {
  id: "p1", task: "Refactor the scheme", project: "proj", repoDir: "/r", worktreeDir: "/w",
  branch: "b", baseBranch: "main", baseRef: "a", lastPassedCommit: "a",
  stages: [
    { id: "build", kind: "run", prompt: "", next: "review", effectiveRole: { roleId: null, engine: "codex", model: null, effort: null, access: "read-write", promptScaffold: null } },
    { id: "review", kind: "review-loop", prompt: "", next: null, effectiveRole: { roleId: null, engine: "codex", model: null, effort: null, access: "read-only", promptScaffold: null } },
  ],
  runs: [], cursor: null, state: "provisioning", pausedState: null, stateDetail: null,
  srcPath: null, srcConversationId: null, createdAt: new Date(0).toISOString(), closedAt: null,
} as unknown as Pipeline;

const flowGroup: SchemeGroup = {
  key: "group::flow::f1",
  kind: "flow",
  id: "f1",
  hue: 210,
  members: ["/impl", "deck::f1"],
  label: "Ship the group overlay",
  x: 80,
  y: 60,
  w: 900,
  h: 780,
};

const pipelineGroup: SchemeGroup = {
  key: "group::pipeline::p1",
  kind: "pipeline",
  id: "p1",
  hue: 24,
  members: ["/plan", "/build"],
  label: "Refactor the scheme",
  x: 1200,
  y: 60,
  w: 1400,
  h: 780,
};

const render = (groups: SchemeGroup[], interactive: boolean) =>
  renderToStaticMarkup(<GroupsLayer groups={groups} interactive={interactive} />);

test("each group draws a named, hue-tinted halo region (issue #118)", () => {
  const html = render([flowGroup, pipelineGroup], true);
  /* Both flow and pipeline groups render their name. */
  expect(html).toContain("Ship the group overlay");
  expect(html).toContain("Refactor the scheme");
  /* The halo tint is derived from the group's distinct hue. */
  expect(html).toContain("hsl(210 62% 42%)");
  expect(html).toContain("hsl(24 62% 42%)");
  /* A data hook per kind so the board can be asserted against and styled. */
  expect(html).toContain('data-scheme-group="flow"');
  expect(html).toContain('data-scheme-group="pipeline"');
});

test("the label chip fully counter-scales so it stays readable at minimum zoom (issue #118 review)", () => {
  const html = render([flowGroup], true);
  /* Uncapped inverse-zoom scaling: constant on-screen size, no min(…) ceiling
     that would shrink the label to a few px at the 0.12 map minimum. */
  expect(html).toContain("var(--inv-z, 1)");
  expect(html).not.toContain("min(");
  expect(html).toContain(groupLabelFontSize());
});

test("the label holds its on-screen size at the 0.12 minimum zoom", () => {
  /* World font × zoom is constant across zoom → always ~11px on screen, never the
     ~3.4px the old min(…, 2.6) cap produced at z=0.12. */
  expect(groupLabelScreenPx(0.12)).toBeCloseTo(11, 6);
  expect(groupLabelScreenPx(1)).toBeCloseTo(11, 6);
  expect(groupLabelScreenPx(0.12)).toBeGreaterThanOrEqual(11);
});

test("the label chip is a live control when interactive and inert otherwise", () => {
  /* Interactive: the chip opens the override panel (button enabled, pointer on). */
  const live = render([flowGroup], true);
  expect(live).toContain("pointer-events-auto");
  expect(live).not.toContain("disabled=\"\"");
  /* Passive (hand tool / selection session / lite map): chip disabled, no tap. */
  const passive = render([flowGroup], false);
  expect(passive).toContain("disabled=\"\"");
});

test("no groups renders nothing", () => {
  expect(render([], true)).toBe("");
});

test("a pipeline group frames its members with a label chip but no detached stage strip (#353)", () => {
  const group: SchemeGroup = { ...pipelineGroup, pipeline: planPipeline };
  /* The conversation-card stage graph now mounts inside the compact PipelineGroup
     body, NOT on the halo — the halo carries only its region and title chip, so
     no large detached graph panel floats over the board (#353 operator correction). */
  const html = renderToStaticMarkup(<GroupsLayer groups={[group]} interactive />);
  expect(html).toContain('data-scheme-group="pipeline"');
  expect(html).toContain("Refactor the scheme");
  expect(html).not.toContain("data-scheme-group-strip");
  expect(html).not.toContain("data-pipeline-stage-graph");
  expect(html.match(/data-stage-graph-node=/g)).toBeNull();
});

test("a draft pipeline keeps its scheme-only dashed draft treatment and single title (#353)", () => {
  const draft = { ...planPipeline, state: "draft" } as Pipeline;
  const group: SchemeGroup = { ...pipelineGroup, pipeline: draft };
  const html = renderToStaticMarkup(<GroupsLayer groups={[group]} interactive />);

  expect(html).toContain('data-pipeline-draft="true"');
  /* The group chip remains the single pipeline title. */
  expect(html).not.toContain("DRAFT");
  expect(html.split(">Refactor the scheme<").length - 1).toBe(1); // visible title: the chip only (aria-labels aside)
  /* No detached stage graph surface floats on the draft halo. */
  expect(html).not.toContain("data-pipeline-stage-graph");
});
