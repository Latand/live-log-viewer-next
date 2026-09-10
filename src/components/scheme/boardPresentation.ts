import type { Flow } from "@/lib/flows/types";
import type { Pipeline, PipelineStageAttempt } from "@/lib/pipelines/types";
import type { SchemeLayout } from "./layout";
import type { TaskBand } from "./taskBands";

/** Rendering and placement share disclosure decisions. Opening details reserves
 * space; the camera scales these board pixels without changing their shape. */
export const BOARD_SURFACE = {
  summary: { w: 360, h: 88 },
  stage: { w: 360, h: 104 },
  stageDetails: { w: 600, h: 724 },
  header: 96,
  groupHeader: 40,
  roleSpace: 28,
  navigationSpace: 28,
} as const;

export function stageSurface(expanded: boolean) {
  return { ...(expanded ? BOARD_SURFACE.stageDetails : BOARD_SURFACE.stage), detailsExpanded: expanded };
}

/** Epoch ms of a recorded date; null when it is absent or unreadable. */
function recordedAt(value: string | null | undefined): number | null {
  const at = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(at) ? at : null;
}

function pipelineMayHaveWork(pipeline: Pipeline, finishedAt: number): boolean {
  const after = (value: string | null) => (recordedAt(value) ?? -Infinity) > finishedAt;
  if (after(pipeline.createdAt) || pipeline.unconfirmedHosts?.length) return true;
  if (!["needs_decision", "completed", "closed"].includes(pipeline.state)) return true;
  return pipeline.runs.some(run => run.attempts.some(attempt =>
    ["spawning", "running", "reviewing", "committing"].includes(attempt.state)
    || Boolean(attempt.unresolvedTermination?.survivors.length)
    || after(attempt.completedAt),
  ));
}

/** A review loop's current work is its latest round (its creation before the
 * first). A round started, reviewed or relayed after the task finished is a new
 * decision; one with no readable date cannot be shown to predate completion. */
function flowMayHaveWork(flow: Flow, finishedAt: number): boolean {
  if (!["approved", "done_comment", "needs_decision", "closed"].includes(flow.state)) return true;
  const latest = flow.rounds.at(-1);
  const dates = (latest ? [latest.startedAt, latest.reviewedAt, latest.terminalAt, latest.relayedAt] : [flow.createdAt])
    .map(recordedAt).filter((at): at is number => at !== null);
  return !dates.length || dates.some(at => at > finishedAt);
}

/** A completed task may retain a parked old run. Its recorded state stays on
 * the history heading. Live/unknown work and drafts keep their surfaces. */
export function bandHistoryAvailable(band: TaskBand, base: SchemeLayout): boolean {
  if (band.status !== "done" || band.working || band.unknown || !band.members.length) return false;
  const finishedAt = recordedAt(band.task?.updatedAt);
  if (finishedAt === null) return false;
  const files = band.members.flatMap(member => [
    ...(member.file ? [member.file] : []),
    ...(base.stacks.find(stack => stack.key === member.key)?.items.map(item => item.file) ?? []),
    ...(base.decks.find(deck => deck.key === member.key)?.rounds.flatMap(round => round.file ? [round.file] : []) ?? []),
  ]);
  if (band.members.some(member => member.kind === "draft")) return false;
  if (files.some(file => file.pendingQuestion || file.waitingInput
    || file.authoritativeTurn?.state === "unknown" || file.authoritativeTurn?.state === "busy"
    || file.proc === "running" || (file.spawn && file.spawn.state !== "failed"))) return false;
  const groups = base.groups.filter(group => band.groups.includes(group.key));
  /* A pipeline's review stage draws its deck without a flow group, so the
     band's decks answer for their loops as well. */
  const decks = base.decks.filter(deck => band.members.some(member => member.key === deck.key));
  const flows = [...groups.flatMap(group => !group.pipeline && group.flow ? [group.flow] : []), ...decks.map(deck => deck.flow)];
  return !groups.some(group => group.pipeline && pipelineMayHaveWork(group.pipeline, finishedAt))
    && !flows.some(flow => flowMayHaveWork(flow, finishedAt));
}

export function bandContainsTarget(band: TaskBand, base: SchemeLayout, target: string | null): boolean {
  if (!target) return false;
  return band.members.some(member => member.key === target
    || base.stacks.find(stack => stack.key === member.key)?.items.some(item => item.file.path === target)
    || base.decks.find(deck => deck.key === member.key)?.rounds.some(round => round.file?.path === target))
    || band.mirrors.some(mirror => mirror.ofKey === target);
}

/** Older attempt labels use that attempt's record, never the cursor's state.
 * The conversation remains selectable and retains its current activity badge. */
export function historicalAttemptLabels(pipelines: readonly Pipeline[]): ReadonlyMap<string, PipelineStageAttempt> {
  const labels = new Map<string, PipelineStageAttempt>();
  const currentPaths = new Set<string>();
  for (const pipeline of pipelines) for (const run of pipeline.runs) {
    const current = run.attempts.filter(attempt => !attempt.historical).at(-1);
    if (current?.agentPath) currentPaths.add(current.agentPath);
    for (const attempt of run.attempts) {
      if (attempt === current || !attempt.agentPath) continue;
      if (["passed", "failed", "skipped", "needs_decision"].includes(attempt.state)) labels.set(attempt.agentPath, attempt);
    }
  }
  for (const path of currentPaths) labels.delete(path);
  return labels;
}
