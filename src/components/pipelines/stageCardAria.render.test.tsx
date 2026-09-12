import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { StageSlot } from "@/components/scheme/layout";
import type { Pipeline, PipelineStage } from "@/lib/pipelines/types";
import { BOARD_SURFACE, stageDetailsCardHeight, stageSurface } from "@/components/scheme/boardPresentation";

import { StageCompletedCard } from "./StageCompletedCard";
import { StageStatusRow } from "./StageStatusRow";
import { StagePlaceholderPane } from "./StagePlaceholderPane";

/*
 * A stage card's accessible name carries the same identity its visible title
 * does (#658). Naming it by the role alone left two same-role stages of one
 * pipeline indistinguishable to assistive tech while their visible titles
 * differed — the exact confusion the issue is about, one layer down.
 */

const effectiveRole = { roleId: "builder", engine: "codex" as const, model: null, effort: null, access: "read-write" as const, promptScaffold: null };

function stage(id: string): PipelineStage {
  return { id, kind: "run", role: { roleId: "builder" }, next: null, effectiveRole, prompt: "{{task}}" } as unknown as PipelineStage;
}

const stages = [stage("integrate_v3_voice"), stage("harden_v3_voice")];

const pipeline = {
  id: "p658", task: "V3 voice", project: "demo", repoDir: "/r", worktreeDir: "/w", branch: "b",
  baseBranch: "main", baseRef: "a", lastPassedCommit: "a", stages,
  runs: [{ stageId: "integrate_v3_voice", attempts: [{ n: 1, state: "passed", agentPath: "/integrate", flowId: null }] }],
  cursor: null, state: "running", pausedState: null, stateDetail: null,
  srcPath: null, srcConversationId: null, createdAt: "1970", closedAt: null,
} as unknown as Pipeline;

function slot(index: number, presentation: "placeholder" | "completed"): StageSlot {
  return {
    key: `slot::p658::${stages[index]!.id}`, pipeline, stage: stages[index]!, index, total: stages.length,
    presentation, x: 0, y: 0, w: 600, h: 620,
  } as StageSlot;
}

const ariaLabels = (html: string) => [...html.matchAll(/aria-label="([^"]+)"/g)].map((match) => match[1]!);
/** Rendered text only: attribute values (titles, accessible names) are not what
    the operator sees twice. */
const visible = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
/** The settled-state badge a stage card paints in its own tone. */
const STATE_BADGE = 'style="background-color:var(--color-success-soft);color:var(--color-success)"';

test("two same-role stages expose distinct accessible names on their cards", () => {
  const first = ariaLabels(renderToStaticMarkup(<StagePlaceholderPane slot={slot(0, "placeholder")} interactive={false} />));
  const second = ariaLabels(renderToStaticMarkup(<StagePlaceholderPane slot={slot(1, "placeholder")} interactive={false} />));
  expect(first).toContain("Planned stage Builder · integrate_v3_voice · stage 1/2");
  expect(second).toContain("Planned stage Builder · harden_v3_voice · stage 2/2");
});

test("a completed stage card names itself by role, stage and position too", () => {
  const html = renderToStaticMarkup(<StageCompletedCard slot={slot(0, "completed")} />);
  expect(ariaLabels(html)).toContain("Completed stage Builder · integrate_v3_voice · stage 1/2 — open to review");
});

/*
 * #1668. Disclosed from its own status row, the card used to repeat the stage
 * heading and the state badge the row was already showing — two cards for one
 * stage — and push its transcript control to the bottom of a 620px box that was
 * mostly blank. Disclosed, it carries only what the row cannot.
 */
test("a disclosed completed card repeats neither the row's heading nor its state badge (#1668)", () => {
  const row = renderToStaticMarkup(<StageStatusRow slot={slot(0, "completed")} expanded />);
  const disclosed = renderToStaticMarkup(<StageCompletedCard slot={slot(0, "completed")} disclosed />);
  const standalone = renderToStaticMarkup(<StageCompletedCard slot={slot(0, "completed")} />);

  /* The row is what names the stage and states how it ended. */
  expect(visible(row)).toContain("Builder · integrate_v3_voice · stage 1/2");
  expect(visible(row)).toContain("passed");
  /* The disclosure repeats neither: no second heading, no second state badge.
     The accessible name is NOT duplication — it is how the card is identified
     when the row above it cannot be read. */
  expect(visible(disclosed)).not.toContain("Builder · integrate_v3_voice · stage 1/2");
  expect(disclosed).not.toContain(STATE_BADGE);
  /* Standing alone at a stage position it still carries both. */
  expect(visible(standalone)).toContain("Builder · integrate_v3_voice · stage 1/2");
  expect(standalone).toContain(STATE_BADGE);

  /* What the row cannot carry stays: the runtime that ran it, and the prompt —
     which scrolls, so the whole prompt is reachable in a bounded surface. */
  expect(disclosed).toContain("codex");
  expect(disclosed).toContain("Stage prompt");
  expect(disclosed).toContain("overflow-y-auto");
  expect(disclosed).not.toContain("line-clamp-[12]");
  /* The transcript control follows the prompt instead of being pushed to the
     bottom of an oversized box. */
  expect(disclosed).not.toContain("mt-auto");
  expect(standalone).toContain("mt-auto");
  /* Both keep the accessible name the stage is identified by. */
  expect(ariaLabels(disclosed)).toContain("Completed stage Builder · integrate_v3_voice · stage 1/2 — open to review");
});

/*
 * The reserved rectangle and the drawn card must agree: the row, the deliberate
 * gap and the card together are exactly the footprint the layout gave the
 * disclosure, and a settled stage's is bounded well below the planned stage's
 * full editor.
 */
test("the disclosed footprint is the row plus a deliberate gap plus the card (#1668)", () => {
  for (const presentation of ["completed", "placeholder"] as const) {
    const surface = stageSurface(true, presentation);
    expect(BOARD_SURFACE.stage.h + BOARD_SURFACE.stageDetailsGap + stageDetailsCardHeight(presentation)).toBe(surface.h);
  }
  expect(BOARD_SURFACE.stageDetailsGap).toBeGreaterThan(0);
  expect(stageDetailsCardHeight("completed")).toBeLessThan(stageDetailsCardHeight("placeholder"));
  /* Collapsed, a stage reserves only its row. */
  expect(stageSurface(false, "completed").h).toBe(BOARD_SURFACE.stage.h);
});

/*
 * #1668. The row is the only thing a settled stage shows until it is opened, so
 * both of the things it says must survive a long value: a stage title is
 * `role · stage-id · position`, and the explanation is a sentence. Cutting each
 * to one truncated line left several stages of one pipeline reading identically.
 */
test("a stage status row gives its title and its explanation two lines each (#1668)", () => {
  const html = renderToStaticMarkup(<StageStatusRow slot={slot(0, "completed")} expanded={false} />);
  expect(html).not.toContain("truncate");
  expect([...html.matchAll(/-webkit-line-clamp:2/g)]).toHaveLength(2);
  /* The full strings stay reachable as tooltips whatever the clamp hides. */
  expect(html).toContain('title="Builder · integrate_v3_voice · stage 1/2"');
});
