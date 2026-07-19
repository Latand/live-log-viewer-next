import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { Pipeline } from "@/lib/pipelines/types";

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
  /* The primary action and overflow trigger are rendered as 44px targets. */
  expect(html).toContain("aria-label=\"Pause pipeline\"");
  expect(html).toContain("aria-label=\"More pipeline actions\"");
  const controlRows = html.match(/h-11/g) ?? [];
  expect(controlRows.length).toBeGreaterThanOrEqual(2);
  expect(html).toContain('data-stage-presentation="waiting"');
  expect(html).toContain("Waiting");
  expect(html).not.toContain('data-stage-compact="true"');
  expect(html).toContain('data-pipeline-stage="plan"');
});

test("pipelinesToDock consumes memberful and shelf partitions directly (#388)", () => {
  const other = { ...provisioning, id: "p2", task: "Ship the map" } as Pipeline;
  const hidden = { ...provisioning, id: "p3", state: "closed" } as Pipeline;
  const docked = pipelinesToDock([provisioning, other, hidden], new Set([other.id]));

  expect(docked.map((p) => p.id)).toEqual(["p1", "p2"]);
});

test("a collapsed dock is one warning-aware summary row; expanded reveals the full rail (#156)", () => {
  const collapsed = renderToStaticMarkup(<MobilePipelineDock pipeline={provisioning} defaultExpanded={false} />);
  /* Only the 44px disclosure row: title, status badge, stage counter, chevron. */
  expect(collapsed).toContain('data-testid="mobile-pipeline-dock-summary"');
  expect(collapsed).toContain('aria-label="Expand pipeline Refactor the board"');
  expect(collapsed).toContain('aria-expanded="false"');
  expect(collapsed).toContain("Refactor the board");
  expect(collapsed).toContain("stage 3/3");
  expect(collapsed).not.toContain('aria-label="Pipeline stages"');
  expect(collapsed).not.toContain("Pause pipeline");

  /* Expanded keeps the disclosure row and mounts the full mobile rail below. */
  const expanded = renderToStaticMarkup(<MobilePipelineDock pipeline={provisioning} defaultExpanded />);
  expect(expanded).toContain('aria-label="Collapse pipeline Refactor the board"');
  expect(expanded).toContain('aria-label="Pipeline stages"');

  /* A parked or draft pipeline stays visible without expanding: the collapsed
     summary row carries the warning-toned state badge. */
  const parked = renderToStaticMarkup(
    <MobilePipelineDock pipeline={{ ...provisioning, state: "needs_decision" } as Pipeline} defaultExpanded={false} />,
  );
  expect(parked).toContain("bg-warning-soft");
  const draft = renderToStaticMarkup(
    <MobilePipelineDock pipeline={{ ...provisioning, state: "draft" } as Pipeline} defaultExpanded={false} />,
  );
  expect(draft).toContain("bg-warning-soft");
});

test("a paused pipeline shows Resume; a completed one keeps the overflow actions", () => {
  const paused = renderToStaticMarkup(<MobilePipelineDock pipeline={{ ...provisioning, state: "paused" } as Pipeline} />);
  expect(paused).toContain("aria-label=\"Resume pipeline\"");

  /* A completed pipeline stays active until dismissed, so Close must remain the
     escape hatch, while pause/resume drop away (review round 4). */
  const done = renderToStaticMarkup(<MobilePipelineDock pipeline={{ ...provisioning, state: "completed" } as Pipeline} />);
  expect(done).not.toContain("aria-label=\"Pause pipeline\"");
  expect(done).not.toContain("aria-label=\"Resume pipeline\"");
  expect(done).toContain("aria-label=\"More pipeline actions\"");

  /* The shared strip keeps its action menu when rendered directly. */
  const closed = renderToStaticMarkup(<MobilePipelineDock pipeline={{ ...provisioning, state: "closed" } as Pipeline} />);
  expect(closed).toContain("aria-label=\"More pipeline actions\"");
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
    cursor: { stageId: "plan", state: "pending", input: null, activatedBy: null },
  } as Pipeline;
  const html = renderToStaticMarkup(<MobilePipelineDock pipeline={draft} />);

  /* One title, ONE draft marker (issue #221 §2): the state label alone. */
  expect(html).toContain(">draft<");
  expect(html).not.toContain("DRAFT");
  expect(html.split("Review on mobile").length - 1).toBeGreaterThanOrEqual(2);
  expect(html).toContain("plan");
  expect(html).toContain("build");
  expect(html).toContain("review");
  expect(html).toContain("Start pipeline");
  expect(html).toContain("h-11");
  expect(html).toContain("More pipeline actions");
  expect(html).not.toContain("Pause pipeline");
});
