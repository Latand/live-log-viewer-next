import { afterAll, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-telegram-feed-"));
const OLD_STATE = process.env.LLV_STATE_DIR;
process.env.LLV_STATE_DIR = path.join(SANDBOX, "state");

const { activeFeedFile, feedDialogsSince, readFeedDialogsSince, scopedFeedFile, FEED_CHUNK_BYTES, MAX_FEED_SCAN_BYTES } = await import("./reportFeed");
const { ensureTelegramStateDir, telegramIncomingFeedPath } = await import("./sessionStore");

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

/* Two credential generations, invented. A generation is an opaque ref the
   store mints per connect; these stand in for "the account that was connected
   yesterday" and "the one connected now". */
const CREDENTIAL_A = "credential-generation-a";
const CREDENTIAL_B = "credential-generation-b";

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

/** Writes a feed under this generation's own name, the way the connector does. */
function writeFeed(lines: string[], mode = 0o600): string {
  ensureTelegramStateDir(true);
  const feedFile = telegramIncomingFeedPath(CREDENTIAL_A);
  fs.writeFileSync(feedFile, lines.join("\n") + "\n", { mode });
  return feedFile;
}

test("one dialog bursting all day cannot push another out of the window (#1091)", () => {
  /* The reviewer's repro: the target burst arrives first, then one other
     dialog bursts thousands of times behind it and pushes it far past any
     fixed tail. Its dialog also sits beyond the walk's probe budget, so a tail
     that stopped at a constant would drop it from the report in silence — the
     exact omission the feed exists to end. */
  const target = line(910009001, "Dialog target", seconds("2026-08-20T07:30:00.000Z"));
  const chatter = Array.from({ length: 9000 }, (_, index) =>
    line(910009002, "Dialog chatter", seconds("2026-08-20T09:00:00.000Z") + index));
  const older = line(910009003, "Dialog older", seconds("2026-08-19T22:00:00.000Z"));
  const feedFile = writeFeed([older, target, ...chatter]);
  expect(fs.statSync(feedFile).size).toBeGreaterThan(FEED_CHUNK_BYTES);

  const dialogs = readFeedDialogsSince(feedFile, WINDOW_START);

  /* Both in-window dialogs, and every row parsed — no truncated line reached
     the parser. The pre-window burst is what stopped the backward scan, and it
     is still filtered out of the answer. */
  expect(dialogs.map((row) => row.id).sort()).toEqual(["910009001", "910009002"]);
  expect(dialogs[0]).toEqual({ id: "910009002", title: "Dialog chatter", lastMessageAt: "2026-08-20T11:29:59.000Z" });
});

test("a feed too large to reach the window's far side fails the read, never truncates it", () => {
  /* Nothing before the window inside the budget, so the scan cannot prove it
     saw the whole window. Answering with the part that fit would drop the
     OLDEST in-window dialogs — the ones the bounded walk behind this cannot
     recover either — so the source pass fails instead. */
  const lines = Array.from({ length: 90_000 }, (_, index) =>
    line(910010000 + (index % 40), `Dialog ${index % 40}`, seconds("2026-08-20T09:00:00.000Z") + index));
  const feedFile = writeFeed(lines);
  expect(fs.statSync(feedFile).size).toBeGreaterThan(MAX_FEED_SCAN_BYTES);

  expect(() => readFeedDialogsSince(feedFile, WINDOW_START)).toThrow(/larger than one report read/i);
});

test("a feed that was never written is an empty answer, not a failure", () => {
  ensureTelegramStateDir(true);
  expect(readFeedDialogsSince(telegramIncomingFeedPath(CREDENTIAL_A), WINDOW_START)).toEqual([]);
  expect(readFeedDialogsSince(null, WINDOW_START)).toEqual([]);
});

test("a feed file readable by anyone else is refused, not read", () => {
  const feedFile = writeFeed([line(910000007, "Dialog G", seconds("2026-08-20T09:00:00.000Z"))], 0o644);

  /* It names the operator's correspondents, so it lives under the same
     owner-only fence as the credential beside it. */
  expect(() => readFeedDialogsSince(feedFile, WINDOW_START)).toThrow(/unsafe/i);
});

test("account A's feed is never readable as account B's activity (#1091)", () => {
  /* A disconnect that removed the credential used to leave the feed behind,
     and the next account to connect — its own id check passed — discovered the
     departed account's recent dialogs as its own sources. Two defences, either
     of which alone ends it. */
  const feedFile = writeFeed([line(910000008, "Dialog carried", seconds("2026-08-20T09:00:00.000Z"))]);
  expect(readFeedDialogsSince(feedFile, WINDOW_START)).toHaveLength(1);

  /* One: the file is named for its credential generation, so B cannot even
     name A's. */
  expect(telegramIncomingFeedPath(CREDENTIAL_B)).not.toBe(feedFile);
  expect(readFeedDialogsSince(telegramIncomingFeedPath(CREDENTIAL_B), WINDOW_START)).toEqual([]);

  /* Two: a run reads only the file the CURRENT generation's connector reports
     it is writing. A listener still pointed at A's feed is refused as no feed
     at all, which fails the source pass instead of borrowing A's dialogs. */
  expect(scopedFeedFile(status({ enabled: true, feed_file: feedFile }), CREDENTIAL_A)).toBe(feedFile);
  expect(scopedFeedFile(status({ enabled: true, feed_file: feedFile }), CREDENTIAL_B)).toBeNull();
  expect(scopedFeedFile(status({ enabled: true, feed_file: feedFile }), null)).toBeNull();
});

/** What the connector's `incoming_feed_status` answers, invented. */
function status(fields: Record<string, unknown>): string {
  return JSON.stringify({
    feed_file: "/state/telegram/incoming_feed.jsonl",
    settle_ms: 6000,
    watch_command: "tail -n 0 -F /state/telegram/incoming_feed.jsonl",
    autostart_pending: false,
    enabled: false,
    ...fields,
  });
}

test("a running feed and an armed one both name their file; nothing else does", () => {
  /* The connector starts its feed from the handler of the FIRST incoming
     message, so `autostart_pending` is the ordinary state of a connector that
     has been up since before anybody wrote to the operator — and it has lost
     nothing, because the burst that starts the feed is recorded before the
     start and written with it. */
  expect(activeFeedFile(status({ enabled: true }))).toBe("/state/telegram/incoming_feed.jsonl");
  expect(activeFeedFile(status({ autostart_pending: true }))).toBe("/state/telegram/incoming_feed.jsonl");

  /* Neither running nor armed: a connector adopted from a Viewer generation
     that predates the feed. It answers with a path it will never write, which
     is precisely the answer that must not read as an empty feed (#1091). */
  expect(activeFeedFile(status({}))).toBeNull();
  expect(activeFeedFile(status({ enabled: true, feed_file: "" }))).toBeNull();
  expect(activeFeedFile(status({ enabled: "yes" }))).toBeNull();
  /* A connector too old to have the tool at all answers with a sentence. */
  expect(activeFeedFile("Unknown tool: incoming_feed_status")).toBeNull();
  expect(activeFeedFile("")).toBeNull();
});
