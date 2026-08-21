import { expect, test } from "bun:test";

import {
  MAX_PRIVATE_DIALOGS,
  planReportSources,
  type TelegramChatSummary,
  type TelegramReadPort,
} from "./reportSources";

/**
 * The fake connector: chats in the order the real one returns them (pinned and
 * folder order — NOT recency) plus a last-message date per chat. Nothing here
 * reaches a real account.
 */
class FakeTelegram implements TelegramReadPort {
  readonly calls: string[] = [];
  concurrent = 0;
  maxConcurrent = 0;
  constructor(
    private readonly chats: TelegramChatSummary[],
    private readonly dates: Record<string, string | null>,
  ) {}
  async listChats(input: { kind: "user" | "group"; limit: number }): Promise<TelegramChatSummary[]> {
    this.calls.push(`listChats:${input.kind}:${input.limit}`);
    return this.chats.filter((chat) => chat.kind === input.kind);
  }
  async lastMessageAt(chatId: string): Promise<string | null> {
    this.calls.push(`lastMessageAt:${chatId}`);
    this.concurrent += 1;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.concurrent);
    await Promise.resolve();
    this.concurrent -= 1;
    return this.dates[chatId] ?? null;
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
     two at a time, and never asks for more than one page of chats. */
  expect(port.maxConcurrent).toBe(1);
  expect(port.calls.filter((call) => call.startsWith("listChats")).length).toBe(1);
  expect(port.calls[0]).toBe("listChats:user:100");
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
