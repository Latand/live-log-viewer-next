import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { StageSlot } from "@/components/scheme/layout";
import type { Pipeline, PipelineStage } from "@/lib/pipelines/types";

import { StageCompletedCard } from "./StageCompletedCard";
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
