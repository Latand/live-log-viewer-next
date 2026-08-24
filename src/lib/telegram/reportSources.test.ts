import { expect, test } from "bun:test";

import type { FeedDialog } from "./reportFeed";
import {
  CHAT_PAGE_LIMIT,
  listReportGroups,
  MAX_PRIVATE_DIALOGS,
  MAX_PROBES,
  planReportSources,
  type TelegramChatSummary,
  type TelegramReadPort,
} from "./reportSources";

/**
 * The fake connector: chats in the order the real one returns them (pinned and
 * folder order — NOT recency) plus a last-message date per chat. Nothing here
 * reaches a real account.
 *
 * `listChats` models the real ceiling faithfully: the connector takes its
 * `limit` dialogs of EVERY kind first and filters by kind afterwards, so a
 * private dialog sitting below a hundred groups is simply not in the answer.
 * `pageChats` is the paged raw dialog list, which is how those dialogs are
 * reached at all.
 */
class FakeTelegram implements TelegramReadPort {
  readonly calls: string[] = [];
  concurrent = 0;
  maxConcurrent = 0;
  /** What the connector's incoming feed recorded, newest first (#1091). */
  feed: FeedDialog[] = [];
  /** Set to model a connector that is running no feed to read. */
  feedFailure: Error | null = null;
  constructor(
    private readonly chats: TelegramChatSummary[],
    private readonly dates: Record<string, string | null>,
  ) {}
  async getMe(): Promise<{ name: string; username: string | null; id: string | null }> {
    this.calls.push("getMe");
    return { name: "Account A", username: "account_a", id: "770000001" };
  }
  async feedDialogs(input: { sinceMs: number }): Promise<FeedDialog[]> {
    this.calls.push(`feedDialogs:${input.sinceMs}`);
    return this.track(() => {
      /* The production port throws when the connector is running no feed at
         all, or when its file cannot be read safely (#1091). */
      if (this.feedFailure) throw this.feedFailure;
      return this.feed.filter((row) => Date.parse(row.lastMessageAt) >= input.sinceMs);
    });
  }
  async listChats(input: { kind: "user" | "group"; limit: number }): Promise<TelegramChatSummary[]> {
    this.calls.push(`listChats:${input.kind}:${input.limit}`);
    return this.track(() => this.chats.slice(0, input.limit).filter((chat) => chat.kind === input.kind));
  }
  async pageChats(input: { page: number; pageSize: number }): Promise<Array<{ id: string; title: string }>> {
    this.calls.push(`pageChats:${input.page}:${input.pageSize}`);
    const start = (input.page - 1) * input.pageSize;
    return this.track(() => this.chats.slice(start, start + input.pageSize).map((chat) => ({ id: chat.id, title: chat.title })));
  }
  async lastMessageAt(chatId: string): Promise<string | null> {
    this.calls.push(`lastMessageAt:${chatId}`);
    return this.track(() => this.dates[chatId] ?? null);
  }
  /** Every read goes through here, so "the connector never sees two at once"
      is asserted against the whole surface rather than the probes alone — the
      connector this fakes died under concurrent reads (#1087). */
  private async track<T>(read: () => T): Promise<T> {
    this.concurrent += 1;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.concurrent);
    await Promise.resolve();
    this.concurrent -= 1;
    return read();
  }
}

const WINDOW = { windowStart: "2026-08-20T07:00:00.000Z", windowEnd: "2026-08-21T07:00:00.000Z" };

function dialog(id: string, title: string, username: string | null = null): TelegramChatSummary {
  return { id, kind: "user", title, username, unread: 0 };
}

test("an active dialog ranked low by the connector still becomes a source", async () => {
  /* The live pitfall this rule exists for: the connector's first entries are
     stale pinned chats, and the genuinely active dialog sits last. */
  const port = new FakeTelegram(
    [
      dialog("101", "Dialog A"),
      dialog("102", "Dialog B"),
      dialog("103", "Dialog C"),
      dialog("104", "Dialog D"),
    ],
    {
      "101": "2026-07-01T09:00:00.000Z",
      "102": "2026-06-15T09:00:00.000Z",
      "103": null,
      "104": "2026-08-20T15:00:00.000Z",
    },
  );
  const plan = await planReportSources(port, { ...WINDOW, groups: [], promptVersion: "v1" });
  expect(plan.privateDialogs.map((row) => row.id)).toEqual(["104"]);
  expect(plan.probes).toBe(4);
});

test("dialogs are ordered by last activity, bots are dropped, and reads never overlap", async () => {
  const port = new FakeTelegram(
    [
      dialog("201", "Dialog A"),
      dialog("202", "Reminder Service", "some_reminder_bot"),
      dialog("203", "Dialog C"),
    ],
    {
      "201": "2026-08-20T08:00:00.000Z",
      "202": "2026-08-21T06:00:00.000Z",
      "203": "2026-08-20T23:00:00.000Z",
    },
  );
  const plan = await planReportSources(port, { ...WINDOW, groups: [], promptVersion: "v1" });
  expect(plan.privateDialogs.map((row) => row.id)).toEqual(["203", "201"]);
  /* The bot was never even probed — Telegram requires bot usernames to end in
     "bot", so the listing alone identifies it. */
  expect(port.calls).not.toContain("lastMessageAt:202");
  /* The connector died once under concurrent reads; this plan never issues
     two at a time, and never asks for more than one page of chats. The feed is
     read FIRST, before anything walks a list. */
  expect(port.maxConcurrent).toBe(1);
  expect(port.calls.filter((call) => call.startsWith("listChats")).length).toBe(1);
  expect(port.calls[0]).toBe("feedDialogs:1787209200000");
  expect(port.calls[1]).toBe("listChats:user:100");
});

test("an active dialog below the connector's pre-filter ceiling is still found", async () => {
  /* The defect this covers: `list_chats` applies its 100-chat limit to the
     dialog list BEFORE filtering by kind, so an operator whose first hundred
     dialogs are groups has no private dialogs in that answer at all. */
  const groups: TelegramChatSummary[] = Array.from({ length: CHAT_PAGE_LIMIT }, (_, index) => ({
    id: `-100${1000 + index}`,
    kind: "group",
    title: `Group ${index}`,
    username: null,
    unread: 0,
  }));
  const buried = dialog("777", "Dialog buried past the ceiling");
  const port = new FakeTelegram([...groups, buried], { "777": "2026-08-20T15:00:00.000Z" });

  const plan = await planReportSources(port, { ...WINDOW, groups: [], promptVersion: "v1" });
  expect(plan.privateDialogs.map((row) => row.id)).toEqual(["777"]);
  /* The typed page contributed nothing, so the paged list is what reached it —
     and it identified the dialog by its positive marked id, with no extra call
     per chat. */
  expect(port.calls).toContain("pageChats:1:100");
  expect(port.calls.filter((call) => call.startsWith("lastMessageAt"))).toEqual(["lastMessageAt:777"]);
});

test("a dialog active after a long run of cold ones is still a source", async () => {
  /* The defect this covers: an earlier revision stopped the walk after a run
     of consecutive stale candidates, which is a recency assumption about a
     list that is ordered by pins and folders. An operator whose pinned block
     is dormant would silently lose the conversation they answered an hour
     ago. */
  const many: TelegramChatSummary[] = Array.from({ length: 60 }, (_, index) => dialog(String(5000 + index), `Dialog ${index}`));
  const dates: Record<string, string> = {};
  for (const chat of many) dates[chat.id] = "2026-01-01T00:00:00.000Z";
  dates["5040"] = "2026-08-20T15:00:00.000Z";
  const port = new FakeTelegram(many, dates);

  const plan = await planReportSources(port, { ...WINDOW, groups: [], promptVersion: "v1" });
  expect(plan.privateDialogs.map((row) => row.id)).toEqual(["5040"]);
  expect(plan.probes).toBe(60);
  expect(plan.probeBudgetExhausted).toBe(false);
});

test("a very long dialog list stops at the probe ceiling and says so", async () => {
  const many: TelegramChatSummary[] = Array.from({ length: 400 }, (_, index) => dialog(String(5000 + index), `Dialog ${index}`));
  const dates: Record<string, string> = { "5000": "2026-08-20T15:00:00.000Z" };
  for (let index = 1; index < many.length; index += 1) dates[String(5000 + index)] = "2026-01-01T00:00:00.000Z";
  const port = new FakeTelegram(many, dates);

  const plan = await planReportSources(port, { ...WINDOW, groups: [], promptVersion: "v1" });
  expect(plan.privateDialogs.map((row) => row.id)).toEqual(["5000"]);
  /* One bound, and it is the only one: the walk probes every candidate it can
     afford, then reports that it ran out rather than pretending completeness. */
  expect(plan.probes).toBe(MAX_PROBES);
  expect(plan.probeBudgetExhausted).toBe(true);
});

test("the operator's groups ride along with their pass, and dialogs stay bounded", async () => {
  const many = Array.from({ length: MAX_PRIVATE_DIALOGS + 5 }, (_, index) => dialog(String(900 + index), `Dialog ${index}`));
  const dates = Object.fromEntries(many.map((chat, index) => [chat.id, new Date(Date.parse(WINDOW.windowStart) + index * 60_000).toISOString()]));
  const port = new FakeTelegram(many, dates);
  const plan = await planReportSources(port, {
    ...WINDOW,
    groups: [{ id: "-1001", title: "Team room", mode: "light" }, { id: "-1002", title: "Project room", mode: "full" }],
    promptVersion: "v1",
  });
  expect(plan.privateDialogs.length).toBe(MAX_PRIVATE_DIALOGS);
  expect(plan.truncated).toBe(true);
  expect(plan.groups).toEqual([
    { id: "-1001", title: "Team room", mode: "light" },
    { id: "-1002", title: "Project room", mode: "full" },
  ]);
  /* Groups are never re-derived from activity: the operator picked them. */
  expect(port.calls).not.toContain("listChats:group:100");
});

function burst(id: string, title: string, at: string): FeedDialog {
  return { id, title, lastMessageAt: at };
}

test("a dialog the feed recorded is a source even when the walk never reaches it", async () => {
  /* The acceptance criterion of #1091: an active dialog ranked LAST by the
     connector's list order still appears in the run's sources. The walk cannot
     get to it — the probe budget runs out hundreds of candidates earlier — and
     it does not have to, because the feed recorded the burst when it arrived. */
  const many = Array.from({ length: 400 }, (_, index) => dialog(String(5000 + index), `Dialog ${index}`));
  const last = dialog("6001", "Dialog answered an hour ago");
  const dates: Record<string, string> = {};
  for (const chat of many) dates[chat.id] = "2026-01-01T00:00:00.000Z";
  dates[last.id] = "2026-08-20T15:00:00.000Z";
  const port = new FakeTelegram([...many, last], dates);
  port.feed = [burst(last.id, last.title, "2026-08-20T15:00:00.000Z")];

  const plan = await planReportSources(port, { ...WINDOW, groups: [], promptVersion: "v1" });

  expect(plan.privateDialogs.map((row) => row.id)).toEqual([last.id]);
  expect(plan.feedDialogs).toBe(1);
  /* It cost no probe, and the exhausted budget says nothing about it. */
  expect(port.calls).not.toContain(`lastMessageAt:${last.id}`);
  expect(plan.probes).toBe(MAX_PROBES);
  expect(plan.probeBudgetExhausted).toBe(true);
  /* Still one read at a time, feed included — the connector dies under
     concurrent reads (#1087). */
  expect(port.maxConcurrent).toBe(1);
});

test("the feed never costs a second probe for a dialog the walk would also find", async () => {
  const port = new FakeTelegram(
    [dialog("301", "Dialog A"), dialog("302", "Dialog B")],
    { "301": "2026-08-20T09:00:00.000Z", "302": "2026-08-20T20:00:00.000Z" },
  );
  port.feed = [burst("302", "Dialog B", "2026-08-20T20:30:00.000Z")];

  const plan = await planReportSources(port, { ...WINDOW, groups: [], promptVersion: "v1" });

  /* Newest first, and the feed's own instant is the one carried for the dialog
     it recorded. */
  expect(plan.privateDialogs).toEqual([
    { id: "302", title: "Dialog B", lastMessageAt: "2026-08-20T20:30:00.000Z" },
    { id: "301", title: "Dialog A", lastMessageAt: "2026-08-20T09:00:00.000Z" },
  ]);
  expect(port.calls).not.toContain("lastMessageAt:302");
  expect(plan.probes).toBe(1);
});

test("a feed the connector never wrote leaves the walk exactly as it was", async () => {
  const port = new FakeTelegram([dialog("401", "Dialog A")], { "401": "2026-08-20T15:00:00.000Z" });

  const plan = await planReportSources(port, { ...WINDOW, groups: [], promptVersion: "v1" });

  expect(plan.privateDialogs.map((row) => row.id)).toEqual(["401"]);
  expect(plan.feedDialogs).toBe(0);
  expect(plan.probes).toBe(1);
});

test("a connector with no feed fails the plan instead of walking alone", async () => {
  /* The regression this guards: a connector adopted from a Viewer generation
     that predates the feed answers `incoming_feed_status` with a path it will
     never write. Reading that as "the feed saw nothing" would put the run back
     on the bounded probe walk over a list ordered by pins — silently handing
     the operator a report that omits whatever sits past the budget, which is
     the v1 defect #1091 replaced. The run fails instead, and nothing is read
     after the failure. */
  const port = new FakeTelegram([dialog("501", "Dialog A")], { "501": "2026-08-20T15:00:00.000Z" });
  port.feedFailure = new Error("Telegram incoming feed is unavailable");

  await expect(planReportSources(port, { ...WINDOW, groups: [], promptVersion: "v1" })).rejects.toThrow(/feed/i);
  expect(port.calls).toEqual([`feedDialogs:${Date.parse(WINDOW.windowStart)}`]);

  /* The GROUP picker is untouched by it: choosing sources is not a report run,
     and it reads no feed. */
  expect((await listReportGroups(port)).length).toBe(0);
});

test("a group below the connector's pre-filter ceiling is still selectable", async () => {
  /* The defect: the picker offered one `list_chats` page, and that ceiling is
     applied to the dialog list BEFORE the kind filter, so an operator whose
     first hundred dialogs are private chats was offered no groups at all. */
  const dialogs: TelegramChatSummary[] = Array.from({ length: CHAT_PAGE_LIMIT }, (_, index) => dialog(String(7000 + index), `Dialog ${index}`));
  const buried: TelegramChatSummary = { id: "-1001200300", kind: "group", title: "Room below the ceiling", username: null, unread: 0 };
  const port = new FakeTelegram([...dialogs, buried], {});

  const groups = await listReportGroups(port);

  expect(groups).toEqual([{ id: buried.id, title: buried.title }]);
  /* Page one of the raw list is all dialogs; the group is on page two. */
  expect(port.calls).toContain("pageChats:2:100");
  /* Bounded and sequential: the typed head plus at most three pages. */
  expect(port.calls.filter((call) => call.startsWith("pageChats")).length).toBeLessThanOrEqual(3);
  expect(port.maxConcurrent).toBe(1);
});

test("the group picker never offers a private dialog and never repeats a room", async () => {
  const head: TelegramChatSummary = { id: "-1001000001", kind: "group", title: "Team room", username: null, unread: 0 };
  const port = new FakeTelegram([head, dialog("801", "Dialog A")], {});

  const groups = await listReportGroups(port);

  expect(groups).toEqual([{ id: head.id, title: head.title }]);
});
