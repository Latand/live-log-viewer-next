import type { DeliveredMessageOccurrence, DeliveredMessageProvenance } from "@/lib/runtime/messageOrigin";
import { messageTextDigest } from "@/lib/runtime/messageTextDigest";

import type { Item } from "./parse";

/*
 * The occurrence join of #1117: attaches each delivered-message occurrence
 * (content digest + settlement time + authorship) to exactly ONE transcript
 * row — the unclaimed row carrying the same text whose timestamp lies nearest
 * the settlement — so evidence never fans out over every row that happens to
 * repeat a text. Two identical rows, a relay and the operator's own message,
 * resolve by time: the occurrence claims the row its delivery produced, and
 * the other keeps today's rendering.
 *
 * Pure: the hook memoizes over it, and the tests drive it directly.
 */

/** How far a transcript row's timestamp may sit from its delivery's settlement.
    A legacy paste into a pane that first has to resume its session lands
    seconds after the receipt; nearest-wins inside this window keeps an
    identical row minutes away from ever being mistaken for it. */
export const OCCURRENCE_WINDOW_MS = 10 * 60 * 1000;

export interface OccurrenceCandidate {
  item: Item;
  text: string;
  tsMs: number;
}

/**
 * The rows a delivery could have produced. Every row that IS a message —
 * a user bubble, a relay card, a Claude SDK-delivered system row — takes part,
 * including rows the parser or the ledger already attributed: they consume
 * their own occurrence, so it can never drift onto a look-alike row. Scaffold
 * rows carry no timestamped message identity and never take part.
 */
export function occurrenceCandidate(item: Item): OccurrenceCandidate | null {
  let ts: unknown;
  let text: string;
  if (item.kind === "user" || item.kind === "tmsg") {
    ts = item.ts;
    text = item.text;
  } else if (item.kind === "sysmsg" && item.deliveredMessage) {
    ts = item.deliveredMessage.ts;
    text = item.text;
  } else {
    return null;
  }
  if (!text.trim()) return null;
  const tsMs = typeof ts === "string" || typeof ts === "number" ? new Date(ts).getTime() : Number.NaN;
  if (!Number.isFinite(tsMs)) return null;
  return { item, text, tsMs };
}

/* Items are immutable after the parse, so a row's digests are computed once
   per object for the life of the page. */
const digestCache = new WeakMap<Item, readonly string[]>();

/** The digests a row can match: its trimmed text (what every admission
    surface holds) and, when it differs, the verbatim text. */
export function candidateDigests(candidate: OccurrenceCandidate): readonly string[] {
  const cached = digestCache.get(candidate.item);
  if (cached) return cached;
  const trimmed = candidate.text.trim();
  const digests = [messageTextDigest(trimmed)];
  if (trimmed !== candidate.text) digests.push(messageTextDigest(candidate.text));
  digestCache.set(candidate.item, digests);
  return digests;
}

function provenanceOf(occurrence: DeliveredMessageOccurrence): DeliveredMessageProvenance {
  return {
    origin: occurrence.origin,
    ...(occurrence.senderRole ? { senderRole: occurrence.senderRole } : {}),
    ...(occurrence.selectedContext ? { selectedContext: occurrence.selectedContext } : {}),
    ...(occurrence.mandate ? { mandate: occurrence.mandate } : {}),
  };
}

/**
 * One row per occurrence, nearest-in-time within the window, each row claimed
 * at most once. Occurrences are visited in settlement order so an earlier
 * delivery claims the earlier of two look-alike rows.
 */
export function assignDeliveredOccurrences(
  items: Iterable<Item>,
  occurrences: readonly DeliveredMessageOccurrence[],
): Map<Item, DeliveredMessageProvenance> {
  const assigned = new Map<Item, DeliveredMessageProvenance>();
  if (occurrences.length === 0) return assigned;
  const byDigest = new Map<string, OccurrenceCandidate[]>();
  for (const item of items) {
    const candidate = occurrenceCandidate(item);
    if (!candidate) continue;
    for (const digest of candidateDigests(candidate)) {
      const pool = byDigest.get(digest);
      if (pool) pool.push(candidate);
      else byDigest.set(digest, [candidate]);
    }
  }
  if (byDigest.size === 0) return assigned;
  const ordered = occurrences
    .map((occurrence) => ({ occurrence, settledMs: Date.parse(occurrence.deliveredAt) }))
    .filter(({ settledMs }) => Number.isFinite(settledMs))
    .sort((left, right) => left.settledMs - right.settledMs);
  for (const { occurrence, settledMs } of ordered) {
    const pool = byDigest.get(occurrence.textDigest);
    if (!pool) continue;
    let best: OccurrenceCandidate | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const candidate of pool) {
      if (assigned.has(candidate.item)) continue;
      const distance = Math.abs(candidate.tsMs - settledMs);
      if (distance <= OCCURRENCE_WINDOW_MS && distance < bestDistance) {
        best = candidate;
        bestDistance = distance;
      }
    }
    if (best) assigned.set(best.item, provenanceOf(occurrence));
  }
  return assigned;
}
