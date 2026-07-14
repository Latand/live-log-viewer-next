import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { GroupsLayer, groupLabelScreenPx, groupLabelFontSize, type PipelineGroupControls } from "./nodes";
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

const controls: PipelineGroupControls = {
  flows: [], renderablePaths: new Set(), renderableFlows: new Set(), nodeStripPipelineIds: new Set(), onOpenPath: () => {}, onOpenFlow: () => {},
};

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

test("a pipeline group carries the full stage plan on its halo when no per-node strip does (#136)", () => {
  const group: SchemeGroup = { ...pipelineGroup, pipeline: planPipeline };
  /* With controls: the group is the stage-plan surface — the strip and every
     planned stage chip (incl. the not-yet-run review stage) render on the halo. */
  const withControls = renderToStaticMarkup(<GroupsLayer groups={[group]} interactive pipelineControls={controls} />);
  expect(withControls).toContain("data-scheme-group-strip");
  expect(withControls).toContain("build");
  expect(withControls).toContain("review");
  /* Without controls (e.g. the lite map) the halo keeps only its label chip. */
  const noControls = renderToStaticMarkup(<GroupsLayer groups={[group]} interactive />);
  expect(noControls).not.toContain("data-scheme-group-strip");
});

test("group carries the plan even when the current stage node is hidden/collapsed (finding 1)", () => {
  /* A pipeline whose current stage resolves to a path (pipelineBoardStripPath is
     non-null) but whose node is NOT placed on the board: it is absent from
     nodeStripPipelineIds, so no per-node strip is mounted and the group must own
     the plan. */
  const hiddenCurrent = { ...planPipeline, cursor: { stageId: "build", state: "running" } } as unknown as Pipeline;
  const group: SchemeGroup = { ...pipelineGroup, pipeline: hiddenCurrent };
  const noMountedStrip: PipelineGroupControls = { ...controls, nodeStripPipelineIds: new Set() };
  const html = renderToStaticMarkup(<GroupsLayer groups={[group]} interactive pipelineControls={noMountedStrip} />);
  expect(html).toContain("data-scheme-group-strip");

  /* When the per-node strip IS mounted (pipeline id present), the group must not
     duplicate it. */
  const mounted: PipelineGroupControls = { ...controls, nodeStripPipelineIds: new Set(["p1"]) };
  const dup = renderToStaticMarkup(<GroupsLayer groups={[group]} interactive pipelineControls={mounted} />);
  expect(dup).not.toContain("data-scheme-group-strip");
});

test("a draft pipeline has a scheme-only draft treatment and its complete stage plan", () => {
  const draft = { ...planPipeline, state: "draft" } as Pipeline;
  const group: SchemeGroup = { ...pipelineGroup, pipeline: draft };
  const html = renderToStaticMarkup(<GroupsLayer groups={[group]} interactive pipelineControls={controls} />);

  expect(html).toContain('data-pipeline-draft="true"');
  /* One title, one draft badge (issue #221 §2): the chip names the pipeline
     (once), the strip carries the single "draft" state badge — no separate
     DRAFT pill, and the compact strip repeats no title. */
  expect(html).not.toContain("DRAFT");
  expect(html.split(">Refactor the scheme<").length - 1).toBe(1); // visible title: the chip only (aria-labels aside)
  expect(html.split(">draft<").length - 1).toBe(1);
  expect(html).toContain("build");
  expect(html).toContain("review");
  expect(html).toContain("Start pipeline");
});
