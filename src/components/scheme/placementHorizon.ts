import type { Flow } from "@/lib/flows/types";
import type { Pipeline } from "@/lib/pipelines/types";
import type { FileEntry } from "@/lib/types";

import { reviewerFileForRound } from "../flows/flowModel";
import { withinPlacementHorizon } from "../projectModel";

/**
 * The identity a durable record and a scanned entry always agree on for a
 * single transcript — its file name.
 *
 * A pipeline attempt stores whichever absolute path the spawn ran under —
 * `$HOME/.claude/projects/…` or the account-shared
 * `$XDG_CONFIG_HOME/agent-log-viewer/shared/claude/projects/…` (and the same
 * pair for codex, `~/.codex/sessions/…` against
 * `…/agent-log-viewer/accounts/codex/<account>/sessions/…`). The scan that
 * produced the FileEntry may have walked the other one. Measured on the live
 * board: 20 of 78 recorded attempt paths, across 15 pipelines including running
 * ones, miss a raw-string lookup while the same session resolves under the
 * other spelling.
 *
 * Only a transcript file name is an identity — every other path stays itself,
 * so two unrelated `output` files can never be read as one conversation.
 */
export function transcriptIdentity(path: string): string {
  if (!path.endsWith(".jsonl")) return path;
  const cut = path.lastIndexOf("/");
  return cut < 0 ? path : path.slice(cut + 1);
}

/**
 * Resolve a path a durable record names against the entries the scanner
 * actually published: the exact string first, then the transcript identity.
 *
 * An identity shared by two scanned entries resolves to neither — a genuine
 * ambiguity must not silently pick one. Callers that hold a raw
 * `Map<path, FileEntry>` see none of this, which is exactly how the liveness
 * exemption below came to miss every cross-spelling attempt.
 */
export function buildTranscriptLookup(files: readonly FileEntry[]): (path: string) => FileEntry | undefined {
  const byPath = new Map<string, FileEntry>();
  const byIdentity = new Map<string, FileEntry | null>();
  for (const file of files) {
    byPath.set(file.path, file);
    const identity = transcriptIdentity(file.path);
    if (identity === file.path) continue;
    const seen = byIdentity.get(identity);
    if (seen === undefined) byIdentity.set(identity, file);
    else if (seen && seen.path !== file.path) byIdentity.set(identity, null);
  }
  return (path: string) => byPath.get(path) ?? byIdentity.get(transcriptIdentity(path)) ?? undefined;
}

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
  /* 0 means "this stamp dates nothing", so it must never win a Math.max against
     a real time and never stand in as one. A pipeline the record cannot date at
     all stays put rather than being judged epoch-old. */
  let newest = 0;
  for (const stamp of [pipeline.createdAt, pipeline.closedAt, pipeline.pausedAt, pipeline.resumedAt]) {
    newest = Math.max(newest, epochOf(stamp));
  }
  for (const run of pipeline.runs) {
    for (const attempt of run.attempts) {
      newest = Math.max(newest, epochOf(attempt.startedAt), epochOf(attempt.completedAt));
      const file = attempt.agentPath ? fileAt(attempt.agentPath) : undefined;
      if (!file) continue;
      if (file.activity === "live" || file.proc === "running") return true;
      /* The same `recent` guard its twin keeps (withinPlacementHorizon in
         projectModel.ts): a sub-15-minute horizon override can never
         out-tighten the activity band the projection already calls recent. */
      if (file.activity === "recent") return true;
      newest = Math.max(newest, file.mtime);
    }
  }
  return newest === 0 || now - newest <= ageHorizonSeconds;
}

/**
 * The board's own flow-driven expansions, bounded by the same horizon.
 *
 * These are automatic — the board opens them, not the operator — so a flow that
 * has sat approved for weeks must not keep dragging its implementer (and,
 * through it, an ancient root) onto the canvas. The operator's own expansions
 * are merged in by the caller afterwards and are never bounded.
 *
 * One exemption, and it is the horizon's own rule rather than a hole in it: an
 * implementer is the card a round deck hangs on, so while a reviewer of that
 * flow is live or running, bounding the implementer would strand a live
 * reviewer as a bare node with no deck to fold into. Live work is exempt at any
 * age; so is the single surface that hosts it. Once every reviewer has gone
 * quiet the implementer is bounded like anything else.
 */
export function boundFlowExpansions(
  paths: ReadonlySet<string>,
  input: { flows: readonly Flow[]; files: readonly FileEntry[]; now: number; ageHorizonSeconds: number },
): Set<string> {
  const { flows, files, now, ageHorizonSeconds } = input;
  const kept = new Set(paths);
  const hostsLiveReviewer = new Set<string>();
  for (const flow of flows) {
    const live = flow.rounds.some((round) => {
      const reviewer = reviewerFileForRound(flow, round, files);
      return reviewer ? reviewer.activity === "live" || reviewer.proc === "running" : false;
    });
    if (live) hostsLiveReviewer.add(flow.implementerPath);
  }
  const byPath = new Map(files.map((file) => [file.path, file] as const));
  for (const path of paths) {
    if (hostsLiveReviewer.has(path)) continue;
    const file = byPath.get(path);
    if (file && !withinPlacementHorizon(file, now, ageHorizonSeconds)) kept.delete(path);
  }
  return kept;
}

/** Epoch seconds of an ISO stamp; an absent or unparseable one dates nothing. */
function epochOf(stamp: string | null | undefined): number {
  if (!stamp) return 0;
  const ms = Date.parse(stamp);
  return Number.isFinite(ms) ? ms / 1_000 : 0;
}
