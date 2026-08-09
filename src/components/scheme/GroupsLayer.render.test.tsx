import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { GroupsLayer, groupLabelScreenPx, groupLabelFontSize } from "./nodes";
import type { SchemeGroup } from "./layout";
import type { Pipeline } from "@/lib/pipelines/types";

/* A provisioning pipeline whose current stage has NOT materialized a run-stage
   session. Its planned stages render as placeholder cards inside the halo (via
   NodesLayer); the halo itself carries only its compact header. */
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

/* Issue #962 depth ladder: a settled container is a faint FILLED well with a
   hairline border, so grouping reads by depth instead of by outline. */
test("a settled flow/pipeline container renders as a filled well with a hairline border, not a dashed outline", () => {
  const html = render([flowGroup, pipelineGroup], true);
  /* The well fill sits on the shared well surface, washed with the group hue. */
  expect(html).toContain("var(--surface-well)");
  expect(html).toContain("background-color:color-mix(in srgb, hsl(210 62% 42%) 6%, var(--surface-well))");
  /* Hairline: the region border derives from the default hairline role. */
  expect(html).toContain("border-color:color-mix(in srgb, hsl(210 62% 42%) 32%, var(--border-default))");
  /* No dashed region and no 2px outline anywhere in a settled board. */
  expect(html).not.toContain("border-dashed");
});

/* Dashed treatment stays reserved for drafts (and drop targets elsewhere). */
test("a draft pipeline keeps its dashed warning halo (issue #962: dashed = draft/drop affordance)", () => {
  const draft = {
    ...pipelineGroup,
    key: "group::pipeline::d1",
    id: "d1",
    pipeline: { ...planPipeline, id: "d1", state: "draft" } as unknown as Pipeline,
  };
  const html = render([draft], true);
  expect(html).toContain("border-dashed");
  expect(html).toContain("data-pipeline-draft");
  expect(html).toContain("var(--color-warning)");
  /* The draft halo does NOT take the settled well fill. */
  expect(html).not.toContain("var(--surface-well)");
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

test("a pipeline halo carries only its compact header — no detached stage graph (#353)", () => {
  const group: SchemeGroup = { ...pipelineGroup, pipeline: planPipeline };
  const html = renderToStaticMarkup(<GroupsLayer groups={[group]} interactive />);
  /* The halo is the sole region: no duplicate stage graph or strip lives on it. */
  expect(html).not.toContain("data-scheme-group-strip");
  expect(html).not.toContain("data-pipeline-stage-graph");
  expect(html).not.toContain("data-stage-graph-node");
  /* The compact header exposes title, progress, lifecycle, and a disclosure. */
  expect(html).toContain('data-pipeline-group-header="p1"');
  expect(html).toContain("Refactor the scheme");
  expect(html).toContain("data-pipeline-progress");
  expect(html).toContain("data-pipeline-lifecycle");
});

test("the pipeline header shows stage progress k/n over the two declared stages", () => {
  const group: SchemeGroup = { ...pipelineGroup, pipeline: planPipeline };
  const html = renderToStaticMarkup(<GroupsLayer groups={[group]} interactive />);
  /* Two declared stages ⇒ the counter denominator is 2. */
  expect(html).toMatch(/data-pipeline-progress[^>]*>[^<]*\/2</);
});

test("a draft pipeline keeps a scheme-only draft treatment and one compact header", () => {
  const draft = { ...planPipeline, state: "draft" } as Pipeline;
  const group: SchemeGroup = { ...pipelineGroup, pipeline: draft };
  const html = renderToStaticMarkup(<GroupsLayer groups={[group]} interactive />);

  expect(html).toContain('data-pipeline-draft="true"');
  expect(html).not.toContain("DRAFT");
  /* The compact header is the single pipeline title on the halo. */
  expect(html.split(">Refactor the scheme<").length - 1).toBe(1);
  expect(html).toContain('data-pipeline-group-header="p1"');
});
