import type { FileEntry } from "@/lib/types";

import { isSubagent, projectKey } from "./projectModel";

/**
 * The attention queue: which agents are blocked on the user right now, oldest
 * wait first. Pure derived state over the polled file list — every surface
 * (badge, popover, title, N-cycle, push/toast seen-sets) derives identity from
 * the one `attentionId` helper here so counts and dedupe keys cannot drift.
 */

/** «blocked» — a hard question/prompt; «stalled» — an interrupted agent (FIFO tail segment). */
export type AttentionTier = "blocked" | "stalled";

export interface AttentionItem {
  /** attentionId(file) — stable while the underlying signal is unchanged. */
  id: string;
  file: FileEntry;
  project: string;
  tier: AttentionTier;
  /** Epoch seconds the wait started: askedAt | waitingInput.since | mtime. */
  since: number;
}

/* An interrupted session stops being "yours to answer" after a while: a
   permission prompt from two days ago is dead context. Shared with the
   switchboard's isAwaitingUser so the queue and the «waiting» bucket agree. */
export const STALLED_ATTENTION_TTL = 2 * 3600;

function isReturnedSubagent(file: FileEntry): boolean {
  return isSubagent(file) && file.proc !== "running";
}

/** Epoch seconds an ISO timestamp names, or null when it does not parse. */
function isoSeconds(iso: string): number | null {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms / 1000 : null;
}

/**
 * The shared attention identity of a file, by signal precedence:
 * a structured question wins over the screen-scrape fallback, which wins over
 * the stalled state; anything else is not in the queue. The id doubles as the
 * dedupe key of the toast and push pipelines, so the formats here must stay
 * byte-identical to the historical inline derivations (`push-sent.json`
 * entries survive the refactor).
 */
export function attentionId(file: FileEntry, now: number = Date.now() / 1000): string | null {
  if (file.pendingQuestion) return file.pendingQuestion.toolUseId;
  if (file.waitingInput) return `${file.path}:waiting:${Math.floor(file.waitingInput.since)}`;
  if (file.activity === "stalled" && !isReturnedSubagent(file) && now - file.mtime <= STALLED_ATTENTION_TTL) {
    return `${file.path}:stalled:${Math.floor(file.mtime)}`;
  }
  return null;
}

/**
 * Ordered queue of everyone blocked on the user: hard-blocked segment first,
 * stalled tail after, oldest wait first inside each segment, id as the
 * tie-breaker. The sort keys are frozen at enqueue (`since` never moves while
 * the id is unchanged), so polls cannot reshuffle the order.
 */
export function buildAttentionQueue(
  files: FileEntry[],
  now: number = Date.now() / 1000,
  project?: string,
): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const file of files) {
    if (project !== undefined && projectKey(file) !== project) continue;
    const id = attentionId(file, now);
    if (id === null) continue;
    const tier: AttentionTier = file.pendingQuestion || file.waitingInput ? "blocked" : "stalled";
    const since = file.pendingQuestion
      ? (isoSeconds(file.pendingQuestion.askedAt) ?? file.mtime)
      : file.waitingInput
        ? file.waitingInput.since
        : file.mtime;
    items.push({ id, file, project: projectKey(file), tier, since });
  }
  return items.sort(
    (a, b) =>
      (a.tier === b.tier ? 0 : a.tier === "blocked" ? -1 : 1) || a.since - b.since || a.id.localeCompare(b.id),
  );
}

/**
 * Id-anchored cycle step: the pointer is an id, not an index, so an item
 * answered elsewhere silently drops out and the next press serves the
 * next-oldest remaining item (queue head forward, tail backward). Wraps.
 */
export function nextAttention(
  queue: AttentionItem[],
  currentId: string | null,
  dir: 1 | -1,
): AttentionItem | null {
  if (!queue.length) return null;
  const index = currentId === null ? -1 : queue.findIndex((item) => item.id === currentId);
  if (index === -1) return dir === 1 ? queue[0]! : queue[queue.length - 1]!;
  return queue[(index + dir + queue.length) % queue.length]!;
}
