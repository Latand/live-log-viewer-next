import { readSafeTailText } from "./sessionStore";

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
 *  - the file is APPEND-ONLY and nothing rotates it, so it is read from the END
 *    with a byte bound. A day's activity is kilobytes; the bound only decides
 *    how far back a first run after a long silence can see.
 *  - the file is written by the connector under the same owner-only fence as
 *    the credential (0600, same uid), and it is read through that fence, so a
 *    feed replaced by another user's file is refused rather than believed.
 *
 * Every value in a line except the id and the timestamp is user-generated: the
 * `name` is whatever the correspondent calls themselves. It is carried as a
 * title and truncated, never interpreted.
 */

/** How far back from the end of the feed one read looks. Each line is ~150
    bytes, so this is thousands of bursts — far past any report window. */
export const MAX_FEED_TAIL_BYTES = 512 * 1024;

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
 * source, and the caller's own candidate walk still runs. A file that exists
 * but cannot be read through the owner-only fence THROWS, because that is a
 * feed whose contents are unknown rather than empty.
 */
export function readFeedDialogsSince(feedFile: string | null, sinceMs: number): FeedDialog[] {
  if (!feedFile) return [];
  const text = readSafeTailText(feedFile, MAX_FEED_TAIL_BYTES);
  return text === null ? [] : feedDialogsSince(text, sinceMs);
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
