import { afterAll, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-telegram-feed-"));
const OLD_STATE = process.env.LLV_STATE_DIR;
process.env.LLV_STATE_DIR = path.join(SANDBOX, "state");

const { feedDialogsSince, readFeedDialogsSince, MAX_FEED_TAIL_BYTES } = await import("./reportFeed");
const { ensureTelegramStateDir } = await import("./sessionStore");

/**
 * The connector's feed lines, invented. Nothing here is a real correspondent:
 * ids are in a made-up range and names are placeholders.
 */
function line(chatId: number, name: string, ts: number, username: string | null = null): string {
  return JSON.stringify({
    chat_id: chatId,
    name,
    username,
    message_count: 2,
    first_message_id: 10,
    last_message_id: 11,
    burst_seconds: 4.2,
    ts,
  });
}

const WINDOW_START = Date.parse("2026-08-20T07:00:00.000Z");
const seconds = (iso: string) => Date.parse(iso) / 1000;

beforeEach(() => {
  fs.rmSync(path.join(SANDBOX, "state"), { recursive: true, force: true });
});

afterAll(() => {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  if (OLD_STATE === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = OLD_STATE;
});

test("the feed answers which dialogs were active in the window, newest first", () => {
  const text = [
    line(910000001, "Dialog A", seconds("2026-08-20T09:00:00.000Z")),
    line(910000002, "Dialog B", seconds("2026-08-20T20:00:00.000Z")),
    /* Before the window: the same dialog, an earlier day. */
    line(910000003, "Dialog C", seconds("2026-08-18T09:00:00.000Z")),
  ].join("\n") + "\n";

  expect(feedDialogsSince(text, WINDOW_START)).toEqual([
    { id: "910000002", title: "Dialog B", lastMessageAt: "2026-08-20T20:00:00.000Z" },
    { id: "910000001", title: "Dialog A", lastMessageAt: "2026-08-20T09:00:00.000Z" },
  ]);
});

test("a dialog that burst repeatedly is one source, stamped with its latest burst", () => {
  const text = [
    line(910000004, "Dialog D", seconds("2026-08-20T09:00:00.000Z")),
    line(910000004, "Dialog D", seconds("2026-08-20T18:30:00.000Z")),
    line(910000004, "Dialog D", seconds("2026-08-20T12:00:00.000Z")),
  ].join("\n");

  expect(feedDialogsSince(text, WINDOW_START)).toEqual([
    { id: "910000004", title: "Dialog D", lastMessageAt: "2026-08-20T18:30:00.000Z" },
  ]);
});

test("bots, groups and junk lines are not private dialogs", () => {
  const text = [
    line(910000005, "Reminder Service", seconds("2026-08-20T09:00:00.000Z"), "some_reminder_bot"),
    /* A negative marked id is a group or channel; this feed should not carry
       one, and a report's private-dialog list must never gain one this way. */
    line(-1001200300, "Team room", seconds("2026-08-20T09:00:00.000Z")),
    "{ not json at all",
    "",
    line(910000006, "Dialog F", seconds("2026-08-20T09:00:00.000Z")),
  ].join("\n");

  expect(feedDialogsSince(text, WINDOW_START).map((row) => row.id)).toEqual(["910000006"]);
});

test("the file read is bounded to the tail and never returns a half line", () => {
  ensureTelegramStateDir(true);
  const feedFile = path.join(process.env.LLV_STATE_DIR!, "telegram", "incoming_feed.jsonl");
  const filler = Array.from({ length: 4000 }, (_, index) =>
    line(910001000 + index, `Dialog ${index}`, seconds("2026-08-20T09:00:00.000Z")));
  const newest = line(910009999, "Dialog newest", seconds("2026-08-20T22:00:00.000Z"));
  fs.writeFileSync(feedFile, filler.join("\n") + "\n" + newest + "\n", { mode: 0o600 });
  expect(fs.statSync(feedFile).size).toBeGreaterThan(MAX_FEED_TAIL_BYTES);

  const dialogs = readFeedDialogsSince(feedFile, WINDOW_START);

  /* The newest burst is at the END of an append-only file, which is the half
     the bound keeps — and every row it returns parsed, so no truncated first
     line was handed to the parser. */
  expect(dialogs[0]).toEqual({ id: "910009999", title: "Dialog newest", lastMessageAt: "2026-08-20T22:00:00.000Z" });
  expect(dialogs.length).toBeGreaterThan(1);
  expect(dialogs.length).toBeLessThan(filler.length);
});

test("a feed that was never written is an empty answer, not a failure", () => {
  ensureTelegramStateDir(true);
  expect(readFeedDialogsSince(path.join(process.env.LLV_STATE_DIR!, "telegram", "incoming_feed.jsonl"), WINDOW_START)).toEqual([]);
  expect(readFeedDialogsSince(null, WINDOW_START)).toEqual([]);
});

test("a feed file readable by anyone else is refused, not read", () => {
  ensureTelegramStateDir(true);
  const feedFile = path.join(process.env.LLV_STATE_DIR!, "telegram", "incoming_feed.jsonl");
  fs.writeFileSync(feedFile, line(910000007, "Dialog G", seconds("2026-08-20T09:00:00.000Z")) + "\n", { mode: 0o644 });

  /* It names the operator's correspondents, so it lives under the same
     owner-only fence as the credential beside it. */
  expect(() => readFeedDialogsSince(feedFile, WINDOW_START)).toThrow(/unsafe/i);
});
