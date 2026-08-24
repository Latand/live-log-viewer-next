import { readSafeTailUntil, telegramIncomingFeedPath } from "./sessionStore";

/**
 * The connector's incoming event feed, as a Daily Report source (issue #1091).
 *
 * The feed is the only thing on this host that records WHEN a private dialog
 * was last active without asking Telegram for a chat list. The connector's list
 * order is pins and folders — never recency — so v1 had to probe candidates one
 * by one and stop at a budget, which meant an operator with hundreds of dialogs
 * could have a conversation they answered an hour ago fall outside the budget
 * and vanish from the day's report. A feed line has none of that shape: it is
 * written the moment a burst settles, so "dialogs active since the last run" is
 * a filter over the feed rather than a search through a list.
 *
 * Two properties this module is built around:
 *
 *  - the file is APPEND-ONLY and stamped as it is written, so it is read from
 *    the END, backward, until a burst OLDER than the window proves the window
 *    is fully in hand. A day's activity is kilobytes, so that is one step for
 *    any ordinary account; the total bound only decides when a feed is so
 *    large that the window cannot be covered at all, which FAILS the source
 *    pass rather than answering with the part that happened to fit.
 *  - the file is written by the connector under the same owner-only fence as
 *    the credential (0600, same uid), and it is read through that fence, so a
 *    feed replaced by another user's file is refused rather than believed.
 *
 * Every value in a line except the id and the timestamp is user-generated: the
 * `name` is whatever the correspondent calls themselves. It is carried as a
 * title and truncated, never interpreted.
 */

/** One backward step. Each line is ~150 bytes, so a single step is thousands
    of bursts — for nearly every account, the whole window in one read. */
export const FEED_CHUNK_BYTES = 512 * 1024;
/** The ceiling on ONE feed read, across all its steps. Past this the window is
    reported as uncovered instead of silently truncated: a single dialog
    bursting all day can push the morning arbitrarily far back, and the dialog
    that then falls out is exactly the one a bounded probe walk cannot recover
    either (#1091). */
export const MAX_FEED_SCAN_BYTES = 8 * 1024 * 1024;

/** A title longer than this is not a name. */
const MAX_TITLE_LENGTH = 120;

export type FeedDialog = {
  /** Marked chat id, as a string so a 64-bit id survives JSON. */
  id: string;
  title: string;
  /** ISO instant of the most recent burst this feed records for the dialog. */
  lastMessageAt: string;
};

type FeedLine = {
  chat_id?: unknown;
  name?: unknown;
  username?: unknown;
  ts?: unknown;
};

/**
 * The dialogs the feed records as active at or after `sinceMs`, newest first.
 *
 * One dialog appears once, stamped with its most recent burst. Bots are dropped
 * on the same evidence the chat listing uses — Telegram requires every bot
 * username to end in `bot` — and a negative id is a group or channel, which
 * this feed is not supposed to contain and which is never a private dialog.
 */
export function feedDialogsSince(text: string, sinceMs: number): FeedDialog[] {
  const newest = new Map<string, number>();
  const titles = new Map<string, string>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let parsed: FeedLine;
    try {
      parsed = JSON.parse(line) as FeedLine;
    } catch {
      /* A half-written tail line, or a rotation that left junk. The feed is a
         source of activity, not a source of truth about its own integrity. */
      continue;
    }
    const id = feedChatId(parsed.chat_id);
    if (!id) continue;
    if (typeof parsed.username === "string" && parsed.username.toLowerCase().endsWith("bot")) continue;
    const at = feedInstant(parsed.ts);
    if (at === null || at < sinceMs) continue;
    const previous = newest.get(id);
    if (previous !== undefined && previous >= at) continue;
    newest.set(id, at);
    titles.set(id, typeof parsed.name === "string" && parsed.name ? parsed.name.slice(0, MAX_TITLE_LENGTH) : id);
  }
  return [...newest.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([id, at]) => ({ id, title: titles.get(id) ?? id, lastMessageAt: new Date(at).toISOString() }));
}

/** Telegram marks user ids positive and every group/channel id negative. */
function feedChatId(value: unknown): string | null {
  if (typeof value === "number") return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
  if (typeof value !== "string") return null;
  return /^[1-9]\d{0,18}$/.test(value.trim()) ? value.trim() : null;
}

/** The feed stamps `ts` as epoch SECONDS with two decimals. */
function feedInstant(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return Math.round(value * 1000);
}

/**
 * Reads the feed file itself, bounded and owner-only.
 *
 * A feed that has never been written (no incoming message since the connector
 * started) is not an error: it is an account with nothing to report from this
 * source, and the caller's own candidate walk still runs. Two states DO throw,
 * because both are a feed whose contents are unknown rather than empty:
 *
 *  - a file that exists but fails the owner-only fence;
 *  - a file whose window the scan could not reach the far side of inside
 *    {@link MAX_FEED_SCAN_BYTES}. Answering with the tail that fit would be the
 *    silent omission this module exists to end — the dialogs it dropped are the
 *    OLDEST in the window, and the walk behind it is bounded by a probe budget
 *    over a list ordered by pins, so it cannot be relied on to find them.
 */
export function readFeedDialogsSince(feedFile: string | null, sinceMs: number): FeedDialog[] {
  if (!feedFile) return [];
  const tail = readSafeTailUntil(
    feedFile,
    { chunkBytes: FEED_CHUNK_BYTES, maxBytes: MAX_FEED_SCAN_BYTES },
    (chunkText) => feedCrossesBefore(chunkText, sinceMs),
  );
  if (tail === null) return [];
  if (!tail.complete) throw new Error("Telegram incoming feed is larger than one report read");
  return feedDialogsSince(tail.text, sinceMs);
}

/** Whether a chunk of the feed holds a burst OLDER than the window. The feed
    is append-only and stamped as it is written, so one such line is proof that
    everything before it is older too — which is what lets the backward scan
    stop instead of reading a file that only ever grows. */
function feedCrossesBefore(chunkText: string, sinceMs: number): boolean {
  for (const line of chunkText.split("\n")) {
    if (!line.trim()) continue;
    let parsed: FeedLine;
    try {
      parsed = JSON.parse(line) as FeedLine;
    } catch {
      continue;
    }
    const at = feedInstant(parsed.ts);
    if (at !== null && at < sinceMs) return true;
  }
  return false;
}

/**
 * The feed file an `incoming_feed_status` answer describes, or `null` when
 * that connector is not running one (#1091).
 *
 * Two states count as running, and the difference matters:
 *
 *  - `enabled` — the consumer task is up and appending settled bursts;
 *  - `autostart_pending` — the connector was launched with the feed armed and
 *    starts it from the handler of the first incoming message. The burst that
 *    triggers the start is recorded before the start and is written too, so a
 *    pending feed has lost nothing; it simply has had nothing to write.
 *
 * Everything else is a connector that will never record anything — one adopted
 * from a Viewer generation that predates the feed, above all — and answering
 * `null` for it is what stops the report from silently falling back to the
 * bounded probe walk that #1091 exists to replace.
 */
export function activeFeedFile(statusText: string): string | null {
  let parsed: { enabled?: unknown; feed_file?: unknown; autostart_pending?: unknown };
  try {
    parsed = JSON.parse(statusText) as typeof parsed;
  } catch {
    return null;
  }
  const running = parsed?.enabled === true || parsed?.autostart_pending === true;
  const file = typeof parsed?.feed_file === "string" ? parsed.feed_file.trim() : "";
  return running && file ? file : null;
}

/**
 * The feed file a run may read: the one THIS credential generation's connector
 * reports it is writing, and nothing else (#1091).
 *
 * The feed is named for its credential generation, so a status answer pointing
 * anywhere else is a listener from another account's generation — and its
 * recent bursts, adopted as the current account's active dialogs, would put one
 * operator's correspondents into another's report after the id check had
 * already passed. Refused as no feed at all, which fails the source pass.
 */
export function scopedFeedFile(statusText: string, credentialRef: string | null): string | null {
  if (!credentialRef) return null;
  const reported = activeFeedFile(statusText);
  return reported !== null && reported === telegramIncomingFeedPath(credentialRef) ? reported : null;
}
