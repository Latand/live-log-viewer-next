import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { Pipeline } from "@/lib/pipelines/types";

import type { SchemeGroup } from "@/components/scheme/layout";

import { MobilePipelineDock, pipelinesToDock } from "./MobileFocusView";

/* A provisioning pipeline with zero materialized stage nodes — the exact case the
   phone lite map (pick-only, needs ≥2 nodes) cannot surface (issue #136 / review). */
const provisioning = {
  id: "p1", task: "Refactor the board", project: "demo", repoDir: "/r", worktreeDir: "/w",
  branch: "b", baseBranch: "main", baseRef: "a", lastPassedCommit: "a",
  stages: [
    { id: "plan", kind: "run", prompt: "", next: "build", effectiveRole: { roleId: null, engine: "codex", model: null, effort: null, access: "read-only", promptScaffold: null } },
    { id: "build", kind: "run", prompt: "", next: "review", effectiveRole: { roleId: null, engine: "codex", model: null, effort: null, access: "read-write", promptScaffold: null } },
    { id: "review", kind: "review-loop", prompt: "", next: null, effectiveRole: { roleId: null, engine: "codex", model: null, effort: null, access: "read-only", promptScaffold: null } },
  ],
  runs: [], cursor: null, state: "provisioning", pausedState: null, stateDetail: null,
  srcPath: null, srcConversationId: null, createdAt: new Date(0).toISOString(), closedAt: null,
} as unknown as Pipeline;

test("mobile dock surfaces the full plan + 44px controls for a memberless pipeline (#136)", () => {
  const html = renderToStaticMarkup(<MobilePipelineDock pipeline={provisioning} />);
  /* The dock is present and shows the whole planned stage graph. */
  expect(html).toContain("mobile-pipeline-dock");
  expect(html).toContain("plan");
  expect(html).toContain("build");
  expect(html).toContain("review");
  /* Pipeline-level controls (pause + close) are rendered as 44px (h-11) targets. */
  expect(html).toContain("aria-label=\"Pause pipeline\"");
  expect(html).toContain("aria-label=\"Close pipeline\"");
  const controlRows = html.match(/h-11/g) ?? [];
  expect(controlRows.length).toBeGreaterThanOrEqual(2);
});

test("pipelinesToDock docks every active pipeline group — memberful ones too (#156)", () => {
  const other = { ...provisioning, id: "p2", task: "Ship the map" } as Pipeline;
  const group = (pipeline: Pipeline, members: string[]): SchemeGroup =>
    ({ key: `group::pipeline::${pipeline.id}`, kind: "pipeline", id: pipeline.id, hue: 0, members, pipeline, label: pipeline.task, x: 0, y: 0, w: 1, h: 1 }) as SchemeGroup;
  const flowGroup = { key: "group::flow::f1", kind: "flow", id: "f1", hue: 0, members: ["/a"], label: "f", x: 0, y: 0, w: 1, h: 1 } as SchemeGroup;

  const docked = pipelinesToDock([
    group(provisioning, []), // memberless placeholder (issue #136)
    flowGroup, // a plain flow group carries no pipeline — never docked
    group(other, ["/x", "/y"]), // memberful pipeline — previously skipped
  ]);

  /* Both pipelines dock, in group order; the flow group contributes nothing. */
  expect(docked.map((p) => p.id)).toEqual(["p1", "p2"]);
});

test("a paused pipeline shows Resume; a completed one keeps Close but drops pause/resume", () => {
  const paused = renderToStaticMarkup(<MobilePipelineDock pipeline={{ ...provisioning, state: "paused" } as Pipeline} />);
  expect(paused).toContain("aria-label=\"Resume pipeline\"");

  /* A completed pipeline stays active until dismissed, so Close must remain the
     escape hatch, while pause/resume drop away (review round 4). */
  const done = renderToStaticMarkup(<MobilePipelineDock pipeline={{ ...provisioning, state: "completed" } as Pipeline} />);
  expect(done).not.toContain("aria-label=\"Pause pipeline\"");
  expect(done).not.toContain("aria-label=\"Resume pipeline\"");
  expect(done).toContain("aria-label=\"Close pipeline\"");

  /* A truly closed pipeline is gone — no controls at all. */
  const closed = renderToStaticMarkup(<MobilePipelineDock pipeline={{ ...provisioning, state: "closed" } as Pipeline} />);
  expect(closed).not.toContain("aria-label=\"Close pipeline\"");
});

test("mobile renders a read-only draft plan with a 44px Start action", () => {
  const draft = {
    ...provisioning,
    task: "Review on mobile",
    state: "draft",
    baseBranch: "",
    baseRef: "",
    lastPassedCommit: "",
    runs: provisioning.stages.map((stage) => ({ stageId: stage.id, attempts: [] })),
    cursor: { stageId: "plan", state: "pending" },
  } as Pipeline;
  const html = renderToStaticMarkup(<MobilePipelineDock pipeline={draft} />);

  /* One title, ONE draft marker (issue #221 §2): the state label alone. */
  expect(html).toContain(">draft<");
  expect(html).not.toContain("DRAFT");
  expect(html.split("Review on mobile").length - 1).toBe(2); // aria-label + visible title
  expect(html).toContain("plan");
  expect(html).toContain("build");
  expect(html).toContain("review");
  expect(html).toContain("Start pipeline");
  expect(html).toContain("h-11");
  expect(html).toContain("Discard draft");
  expect(html).not.toContain("Pause pipeline");
});
