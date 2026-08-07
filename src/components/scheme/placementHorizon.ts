import type { Pipeline } from "@/lib/pipelines/types";
import type { FileEntry } from "@/lib/types";

/**
 * The board's automatic-placement age horizon, asked of a whole pipeline.
 *
 * A pipeline's stage surfaces — `slot::` placeholders, completed stage cards and
 * the region that frames them — are automatic placements like any card, so they
 * follow the same clock (issue: the project map filled with slots of pipelines
 * that finished, or stranded, weeks ago).
 *
 * A pipeline stays on the canvas while any stage transcript is live or its host
 * is running, at any age — a long run with an old transcript never loses its
 * slots. Otherwise the pipeline's own record dates it: the newest of its
 * lifecycle stamps and its stage transcripts. Only a fully terminal or stranded
 * pipeline past the horizon leaves; it keeps its rail entry, its stage history
 * and every transcript in «All conversations».
 *
 * `now <= 0` — the server render and the hydration pass — bounds nothing, so
 * both sides paint the same markup.
 */
export function pipelineWithinPlacementHorizon(
  pipeline: Pipeline,
  input: { now: number; ageHorizonSeconds: number; fileAt: (path: string) => FileEntry | undefined },
): boolean {
  const { now, ageHorizonSeconds, fileAt } = input;
  if (now <= 0) return true;
  let newest = epochOf(pipeline.createdAt);
  for (const stamp of [pipeline.closedAt, pipeline.pausedAt, pipeline.resumedAt]) {
    newest = Math.max(newest, epochOf(stamp));
  }
  for (const run of pipeline.runs) {
    for (const attempt of run.attempts) {
      newest = Math.max(newest, epochOf(attempt.startedAt), epochOf(attempt.completedAt));
      const file = attempt.agentPath ? fileAt(attempt.agentPath) : undefined;
      if (!file) continue;
      if (file.activity === "live" || file.proc === "running") return true;
      newest = Math.max(newest, file.mtime);
    }
  }
  return now - newest <= ageHorizonSeconds;
}

/** Epoch seconds of an ISO stamp; an absent or unparseable one dates nothing. */
function epochOf(stamp: string | null | undefined): number {
  if (!stamp) return 0;
  const ms = Date.parse(stamp);
  return Number.isFinite(ms) ? ms / 1_000 : 0;
}
