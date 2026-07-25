import type { FeedEntry, Item } from "./parse";

/**
 * How far the transcript has advanced, read from its own rows (issue #674).
 *
 * The feed itself is already ordered by record sequence — the parser pushes one
 * item per line and nothing downstream re-sorts. What can still break the
 * invariant is the window tail, which renders live-turn overlay rows BELOW every
 * transcript row: an overlay row that the transcript already moved past would
 * show a session-opening line under tool cards written minutes later.
 *
 * Comparing against the transcript needs an instant, and transcripts carry rows
 * that have none: engines interleave bookkeeping records — `ai-title`,
 * `last-prompt`, `mode` — with no `timestamp` field at all, and they parse into
 * `svc` rows. Those must never read as "dated at zero" or collapse the answer to
 * "unknown"; they simply do not carry ordering information and are skipped.
 */

/** The row's own instant, or null when its record carries no usable timestamp. */
export function transcriptInstant(item: Item): number | null {
  const raw = item.kind === "cmd-group" ? (item.t1 ?? item.t0) : "ts" in item ? item.ts : undefined;
  if (typeof raw !== "string" || !raw) return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * The newest instant any row in the window was written at, or null when the
 * window holds no dated row at all (an empty feed, or a launch whose transcript
 * has not flushed). Undated rows contribute nothing, so a tail of `ai-title` /
 * `last-prompt` / `mode` records leaves the answer at the last dated record
 * instead of erasing it.
 */
export function newestTranscriptInstant(feed: readonly FeedEntry[]): number | null {
  let newest: number | null = null;
  for (const entry of feed) {
    const at = transcriptInstant(entry.item);
    if (at !== null && (newest === null || at > newest)) newest = at;
  }
  return newest;
}
