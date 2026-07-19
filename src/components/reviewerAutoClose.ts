import type { BoardMutationV1 } from "@/lib/board/mutations";
import type { Flow } from "@/lib/flows/types";
import type { FileEntry } from "@/lib/types";

import { projectKey } from "./projectModel";

/*
 * Durable close of verdict-complete reviewers (#289).
 *
 * The board projection already folds an unpinned finished reviewer with zero
 * mutations. But a reviewer the operator once manually placed carries an
 * `explicitManual` / `expanded` pin that outranks folding and is
 * rematerialized by protectedReviewerNodes — the card sticks to the board
 * forever after its verdict (the 2026-07-15 audit hand-moved 30 such
 * reviewers). This module derives the ONE durable `close` mutation per such
 * reviewer once its terminal verdict is durably observed, releasing the pin
 * through the same revision-fenced board grammar a user close uses.
 *
 * Evidence retention is untouched: `close` edits board membership only —
 * transcripts, receipts, review edges, task assignments and verdict evidence
 * live elsewhere, deck spines resolve their files from the full scan
 * independent of hidden state, and the conversation list still opens the
 * transcript.
 *
 * Fail-closed rules: no verdict → never (a failed-before-verdict reviewer is
 * NOT closed); still working (live / mid-turn / waiting on input) → never;
 * owner-authored or unverified authorship → never; already hidden → no-op.
 * Idempotence: the close strips every membership shape, so the candidate set
 * is empty on the next application; the emitter additionally guards
 * once-per-session so an operator's deliberate re-open is not re-closed.
 */

export interface ReviewerAutoCloseInput {
  files: readonly FileEntry[];
  /** Deck flows (real + synthetic direct groups): their rounds claim reviewer
      transcripts and carry the durably observed verdicts. */
  flows: readonly Flow[];
  project: string;
  /** Durable board memberships the projection cannot release. */
  explicitManual: readonly string[];
  manual: readonly string[];
  expanded: readonly string[];
  hidden: readonly string[];
}

/** A round's verdict is durably observed: an explicit verdict, or a terminal
    observation that is not an abort. Errors never qualify — a failed round is
    the spec's "failed before a verdict" and must stay recoverable. */
function roundVerdictObserved(flow: Flow, path: string): boolean {
  for (const round of flow.rounds) {
    if (round.reviewerPath !== path) continue;
    if (round.verdict !== null) return true;
    if (round.terminalAt != null && round.error === null) return true;
  }
  return false;
}

function reviewerStillWorking(file: FileEntry): boolean {
  return (
    file.activity === "live"
    || file.activity === "stalled"
    || file.proc === "running"
    || Boolean(file.pendingQuestion)
    || Boolean(file.waitingInput)
  );
}

export function reviewerCloseMutations(input: ReviewerAutoCloseInput): Extract<BoardMutationV1, { kind: "close" }>[] {
  const hidden = new Set(input.hidden);
  const pinned = new Set([...input.explicitManual, ...input.expanded, ...input.manual]);
  const claimedBy = new Map<string, Flow>();
  for (const flow of input.flows) {
    for (const round of flow.rounds) {
      if (round.reviewerPath && !claimedBy.has(round.reviewerPath)) claimedBy.set(round.reviewerPath, flow);
    }
  }

  const out: Extract<BoardMutationV1, { kind: "close" }>[] = [];
  for (const file of input.files) {
    if (projectKey(file) !== input.project) continue;
    /* Only a reviewer holding a board membership the projection cannot fold. */
    if (!pinned.has(file.path) || hidden.has(file.path)) continue;
    /* Durable reviewer lineage, or a claimed reviewer round of a flow. */
    const owner = claimedBy.get(file.path) ?? null;
    const durableReviewer = file.durableLineage?.role === "reviewer" && Boolean(file.durableLineage.reviewsConversationId);
    if (!durableReviewer && !owner) continue;
    /* Terminal verdict durably observed — from the transcript's own parsed
       outcome or the claiming round. Fail closed on anything else. */
    const verdictObserved = Boolean(file.review?.verdict) || (owner !== null && roundVerdictObserved(owner, file.path));
    if (!verdictObserved) continue;
    /* Owner protection and live work always win. */
    if (file.userAuthored || file.authorshipUnverified) continue;
    if (reviewerStillWorking(file)) continue;
    out.push({ kind: "close", path: file.path });
  }
  return out;
}
