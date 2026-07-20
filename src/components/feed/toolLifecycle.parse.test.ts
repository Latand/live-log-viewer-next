import { expect, test } from "bun:test";

import type { FileEntry } from "@/lib/types";

import { liveTrailingRunLines } from "./__fixtures__/readableTools";
import { buildFeed, createFeedSession, type CmdGroupItem, type FeedEntry, type Item } from "./parse";

const liveClaude = { path: "/tmp/x.jsonl", engine: "claude", fmt: "claude", activity: "live" } as FileEntry;

function onlyGroup(items: (Item | FeedEntry)[]): CmdGroupItem {
  const unwrapped = items.map((entry) => ("item" in entry ? entry.item : entry));
  const group = unwrapped.find((item): item is CmdGroupItem => item.kind === "cmd-group");
  if (!group) throw new Error("expected a cmd-group");
  return group;
}

test("a live trailing run folds the whole active run — the in-flight call included — into one aggregate", () => {
  const items = buildFeed(liveClaude, liveTrailingRunLines(), false, "").items;
  // Exactly one aggregate, no loose running row trailing it.
  expect(items.filter((item) => item.kind === "cmd-group")).toHaveLength(1);
  expect(items.filter((item) => item.kind === "tool")).toHaveLength(0);
  const group = onlyGroup(items);
  // All three calls (two done + one running) belong to the aggregate.
  expect(group.calls).toHaveLength(3);
  expect(group.calls.map((c) => c.status)).toEqual(["ok", "ok", "run"]);
  // The trailing live aggregate is marked active.
  expect(group.active).toBe(true);
});

test("the aggregate settles (active → false) once it is no longer the live trailing run", () => {
  const session = createFeedSession({ engine: "claude", fmt: "claude", showSvc: false, lineFilter: "" });
  const lines = liveTrailingRunLines();
  const live = onlyGroup(session.feed(lines, 0, true).items);
  expect(live.active).toBe(true);
  // The same window, re-fed as a settled (non-live) session: the group settles.
  const settled = onlyGroup(session.feed(lines, 0, false).items);
  expect(settled.active).toBe(false);
  // The calls are unchanged — only the lifecycle flag flips.
  expect(settled.calls).toHaveLength(3);
});

test("a settled group re-fed while still live keeps its identity and active flag stable", () => {
  const session = createFeedSession({ engine: "claude", fmt: "claude", showSvc: false, lineFilter: "" });
  const lines = liveTrailingRunLines();
  const first = onlyGroup(session.feed(lines, 0, true).items);
  const second = onlyGroup(session.feed(lines, 0, true).items);
  // No new events arrived, so the memoized group is reused as-is.
  expect(second).toBe(first);
  expect(second.active).toBe(true);
});
