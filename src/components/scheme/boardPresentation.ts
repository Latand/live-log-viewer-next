import type { Flow } from "@/lib/flows/types";
import type { Pipeline, PipelineStageAttempt } from "@/lib/pipelines/types";
import type { SchemeLayout } from "./layout";
import type { TaskBand } from "./taskBands";

/** Rendering and placement share disclosure decisions. Opening details reserves
 * space; the camera scales these board pixels without changing their shape. */
export const BOARD_SURFACE = {
  summary: { w: 360, h: 88 },
  stage: { w: 360, h: 104 },
  /** A disclosed PLANNED stage: the whole draft-agent editor — engine chips,
      role section, runtime controls and the prompt field — which needs the
      height to be usable at all. */
  stageDetails: { w: 600, h: 748 },
  /** A disclosed SETTLED stage (#1668). The status row directly above already
      states which stage it is and how it ended, so the disclosure only adds the
      prompt that was sent, the runtime it ran on and the transcript link. It is
      bounded: the prompt scrolls inside the card instead of the card growing to
      hold it, which is what left a 620px box mostly blank and stretched every
      connector attached to the stage down the board. */
  stageSettledDetails: { w: 600, h: 460 },
  /** Separation between a stage's status row and the surface it discloses, so
      the card reads as a detail OF that row rather than glued to it. */
  stageDetailsGap: 12,
  header: 96,
  /** A container section's own heading bar, inside the section's region. Two
      lines of title at 16px leading plus its padding: a pipeline goal is a
      sentence, and hard-truncating it to one line is what made four stacked
      headings interchangeable. */
  groupHeader: 56,
  roleSpace: 28,
  navigationSpace: 28,
} as const;

export type StagePresentation = "placeholder" | "completed";

export function stageSurface(expanded: boolean, presentation: StagePresentation = "placeholder") {
  if (!expanded) return { ...BOARD_SURFACE.stage, detailsExpanded: false };
  const surface = presentation === "completed" ? BOARD_SURFACE.stageSettledDetails : BOARD_SURFACE.stageDetails;
  return { ...surface, detailsExpanded: true };
}

/** Height the disclosed card gets inside {@link stageSurface}'s expanded
 * footprint. Placement and rendering read the same function, so the reserved
 * rectangle and the drawn card can never disagree. */
export function stageDetailsCardHeight(presentation: StagePresentation): number {
  const surface = presentation === "completed" ? BOARD_SURFACE.stageSettledDetails : BOARD_SURFACE.stageDetails;
  return surface.h - BOARD_SURFACE.stage.h - BOARD_SURFACE.stageDetailsGap;
}

/** Epoch ms of a recorded date; null when it is absent or unreadable. */
function recordedAt(value: string | null | undefined): number | null {
  const at = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(at) ? at : null;
}

/** Work placed after the task finished, or with no readable date at all,
 * cannot be shown to predate completion. */
function mayPostdate(values: readonly (string | null | undefined)[], finishedAt: number): boolean {
  const dates = values.map(recordedAt).filter((at): at is number => at !== null);
  return !dates.length || dates.some(at => at > finishedAt);
}

function pipelineMayHaveWork(pipeline: Pipeline, finishedAt: number): boolean {
  if (mayPostdate([pipeline.createdAt], finishedAt) || pipeline.unconfirmedHosts?.length) return true;
  if (!["needs_decision", "completed", "closed"].includes(pipeline.state)) return true;
  return pipeline.runs.some(run => run.attempts.some(attempt =>
    ["spawning", "running", "reviewing", "committing"].includes(attempt.state)
    || Boolean(attempt.unresolvedTermination?.survivors.length)
    || mayPostdate([attempt.startedAt, attempt.completedAt], finishedAt),
  ));
}

/** A review loop's current work is its latest round (its creation before the
 * first). A round started, reviewed or relayed after the task finished is a new
 * decision. */
function flowMayHaveWork(flow: Flow, finishedAt: number): boolean {
  if (!["approved", "done_comment", "needs_decision", "closed"].includes(flow.state)) return true;
  const latest = flow.rounds.at(-1);
  return mayPostdate(latest ? [latest.startedAt, latest.reviewedAt, latest.terminalAt, latest.relayedAt] : [flow.createdAt], finishedAt);
}

/** A completed task may retain a parked old run. Its recorded state stays on
 * the history heading. Live/unknown work, incomplete evidence and drafts keep
 * their surfaces. `flows` is the flow catalog: a pipeline's review loops are
 * not board decks, so only their records say whether a round is new. */
export function bandHistoryAvailable(band: TaskBand, base: SchemeLayout, flows: readonly Flow[] = []): boolean {
  if (band.status !== "done" || band.working || band.unknown || !band.members.length) return false;
  const finishedAt = recordedAt(band.task?.updatedAt);
  if (finishedAt === null) return false;
  const files = band.members.flatMap(member => [
    ...(member.file ? [member.file] : []),
    ...(base.stacks.find(stack => stack.key === member.key)?.items.map(item => item.file) ?? []),
    ...(base.decks.find(deck => deck.key === member.key)?.rounds.flatMap(round => round.file ? [round.file] : []) ?? []),
  ]);
  files.push(...band.mirrors.map(mirror => mirror.file));
  if (band.members.some(member => member.kind === "draft")) return false;
  if (files.some(file => file.pendingQuestion || file.waitingInput || file.derivationComplete === false
    || file.authoritativeTurn?.state === "unknown" || file.authoritativeTurn?.state === "busy"
    || file.proc === "running" || (file.spawn && file.spawn.state !== "failed"))) return false;
  const groups = base.groups.filter(group => band.groups.includes(group.key));
  /* A band's review loops: flow groups, decks placed without one, and every
     loop a pipeline stage ran. */
  const flowIds = new Set(groups.flatMap(group => group.pipeline?.runs.flatMap(run => run.attempts.flatMap(attempt => attempt.flowId ? [attempt.flowId] : [])) ?? []));
  const loops = [
    ...groups.flatMap(group => !group.pipeline && group.flow ? [group.flow] : []),
    ...base.decks.filter(deck => band.members.some(member => member.key === deck.key)).map(deck => deck.flow),
    ...(flowIds.size ? flows.filter(flow => flowIds.has(flow.id)) : []),
  ];
  return !groups.some(group => group.pipeline && pipelineMayHaveWork(group.pipeline, finishedAt))
    && !loops.some(flow => flowMayHaveWork(flow, finishedAt));
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
