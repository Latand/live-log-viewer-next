import { beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";

import { createFeedSession, type FeedEntry } from "@/components/feed/parse";
import type { RuntimeLiveTurn } from "@/lib/runtime/liveTurn";

import {
  enrichCanonicalReasoning,
  adoptCanonicalAssistantClaims,
  publishCanonicalAssistantClaims,
  readCanonicalAssistantClaims,
  resetCanonicalAssistantClaimsForTests,
  visibleRuntimeLiveTurnItems,
} from "./liveTurnHandoff";

const dom = new Window({ url: "http://localhost/" });
Object.assign(globalThis, { window: dom, sessionStorage: dom.sessionStorage });

beforeEach(() => {
  dom.sessionStorage.clear();
  resetCanonicalAssistantClaimsForTests();
});

test("issue 626: response ownership survives structured projection eviction, filters, adoption, and refresh", () => {
  const responseId = "response-review-626";
  const live: RuntimeLiveTurn = {
    turnId: "turn-626",
    text: "VERDICT: APPROVE\n\nNO FINDINGS",
    items: [{
      itemId: responseId,
      text: "VERDICT: APPROVE\n\nNO FINDINGS",
      phase: "awaiting-echo",
      startedAt: "2026-07-23T09:00:00.000Z",
      completedAt: "2026-07-23T09:00:01.000Z",
    }],
  };
  const structuredFeed = [{
    anchorKey: "row:9:0",
    key: "9",
    item: {
      kind: "review",
      ts: "2026-07-23T09:00:01.000Z",
      verdict: "APPROVE",
      findings: [],
      summary: ["NO FINDINGS"],
      raw: "VERDICT: APPROVE\n\nNO FINDINGS",
      sourceId: responseId,
    },
  }] as FeedEntry[];

  publishCanonicalAssistantClaims("spawn:launch-626", structuredFeed);
  expect(visibleRuntimeLiveTurnItems(
    live,
    structuredFeed,
    readCanonicalAssistantClaims("spawn:launch-626"),
  )).toEqual([]);

  /* The structured row leaves the capped or filtered feed, identity adopts, and
     module state is rebuilt from session storage. The overlay stays retired. */
  adoptCanonicalAssistantClaims("spawn:launch-626", "conversation-626");
  resetCanonicalAssistantClaimsForTests();
  expect(visibleRuntimeLiveTurnItems(
    live,
    [],
    readCanonicalAssistantClaims("conversation-626"),
  )).toEqual([]);
});

test("issue 626: mixed projections claim one assistant response once", () => {
  const responseId = "response-mixed-626";
  const live: RuntimeLiveTurn = {
    turnId: "turn-mixed-626",
    text: "mixed final",
    items: [
      {
        itemId: null,
        text: "",
        phase: "awaiting-echo",
        startedAt: null,
        completedAt: null,
        omittedItems: 3,
        omittedChars: 120,
      },
      {
        itemId: responseId,
        text: "mixed final",
        phase: "awaiting-echo",
        startedAt: null,
        completedAt: null,
      },
    ],
  };
  const feed = [
    { anchorKey: "row:20:0", key: "20:0", item: { kind: "prose", ts: null, text: "intro", engine: "codex", sourceId: responseId } },
    { anchorKey: "row:20:1", key: "20:1", item: { kind: "mem-citation", entries: [], rolloutIds: [], raw: "", truncated: false, sourceId: responseId } },
    { anchorKey: "row:20:2", key: "20:2", item: { kind: "review", ts: null, verdict: "APPROVE", findings: [], summary: [], raw: "", sourceId: responseId } },
    { anchorKey: "row:20:3", key: "20:3", item: { kind: "blob", bytes: 30_000, text: "blob", sourceId: responseId } },
  ] as FeedEntry[];

  publishCanonicalAssistantClaims("conversation-mixed-626", feed);
  expect([...readCanonicalAssistantClaims("conversation-mixed-626")]).toEqual([responseId]);
  expect(visibleRuntimeLiveTurnItems(
    live,
    feed,
    readCanonicalAssistantClaims("conversation-mixed-626"),
  )).toEqual([
    expect.objectContaining({ itemId: null, omittedItems: 3, omittedChars: 120 }),
  ]);
});

/* ------------------------------------------------------------------ *
 * Issue #1100: live tool rows hand off to canonical tool rows by call id *
 * ------------------------------------------------------------------ */

function toolRow(id: string, ts: string, status: "run" | "ok" | "err" = "ok"): FeedEntry {
  return {
    anchorKey: `row:${id}:0`,
    key: id,
    item: {
      kind: "tool", id, ts, srcCall: 1, family: "shell", tool: "Bash", icon: "shell", summary: "git status",
      chips: [], status, statusLabel: status, outputPreview: "", outputTruncated: false, open: false,
    },
  } as FeedEntry;
}

function liveTool(id: string, startedAt: string, status: "run" | "ok" | "err" = "run", completedAt: string | null = null) {
  return {
    itemId: id, text: "", phase: "awaiting-echo" as const, startedAt, completedAt,
    tool: { name: "Bash", engine: "claude" as const, status, args: { command: "git status" } },
  };
}

test("issue 1100: a live tool row is claimed by the canonical tool row carrying its call id", () => {
  const live: RuntimeLiveTurn = {
    turnId: "turn-tools",
    text: "",
    items: [
      liveTool("toolu_a", "2026-08-23T08:30:01.000Z", "ok", "2026-08-23T08:30:02.000Z"),
      liveTool("toolu_b", "2026-08-23T08:30:03.000Z"),
    ],
  };
  /* Nothing read from the transcript yet (first turn, tail not attached): both
     rows show, the running one included. */
  expect(visibleRuntimeLiveTurnItems(live, [], readCanonicalAssistantClaims("conversation-tools"), "running").map((item) => item.itemId))
    .toEqual(["toolu_a", "toolu_b"]);
  /* The transcript echoes the first call: its live row yields, the second stays. */
  const feed = [toolRow("toolu_a", "2026-08-23T08:30:01.000Z")];
  publishCanonicalAssistantClaims("conversation-tools", feed);
  expect([...readCanonicalAssistantClaims("conversation-tools")]).toEqual(["toolu_a"]);
  expect(visibleRuntimeLiveTurnItems(live, feed, readCanonicalAssistantClaims("conversation-tools"), "running").map((item) => item.itemId))
    .toEqual(["toolu_b"]);
  /* The claim persists past the row leaving the capped window. */
  resetCanonicalAssistantClaimsForTests();
  expect(visibleRuntimeLiveTurnItems(live, [], readCanonicalAssistantClaims("conversation-tools"), "running").map((item) => item.itemId))
    .toEqual(["toolu_b"]);
});

test("issue 1100: a folded tool run claims every member call, and the #674 fence retires a stale tool row", () => {
  const group: FeedEntry = {
    anchorKey: "group:5:0",
    key: "g5",
    item: {
      kind: "cmd-group",
      ids: ["toolu_1", "toolu_2"],
      calls: [toolRow("toolu_1", "2026-08-23T08:30:01.000Z").item, toolRow("toolu_2", "2026-08-23T08:30:02.000Z").item],
      t0: "2026-08-23T08:30:01.000Z",
      t1: "2026-08-23T08:30:02.000Z",
      byTool: { Bash: 2 },
      okCount: 2,
      errCount: 0,
      hasErr: false,
      active: true,
    },
  } as FeedEntry;
  const prose: FeedEntry = {
    anchorKey: "row:9:0",
    key: "9",
    item: { kind: "prose", ts: "2026-08-23T08:30:10.000Z", text: "later answer", engine: "claude", sourceId: "uuid-later" },
  } as FeedEntry;
  const live: RuntimeLiveTurn = {
    turnId: "turn-group",
    text: "",
    items: [
      liveTool("toolu_1", "2026-08-23T08:30:01.000Z", "ok", "2026-08-23T08:30:01.500Z"),
      liveTool("toolu_2", "2026-08-23T08:30:02.000Z", "ok", "2026-08-23T08:30:02.500Z"),
      /* Never echoed with its id, but older than the newest transcript record:
         the transcript moved past it, so it must not trail below newer rows. */
      liveTool("toolu_orphan", "2026-08-23T08:30:05.000Z", "ok", "2026-08-23T08:30:06.000Z"),
      /* Newer than anything in the transcript window: still in flight, shown. */
      liveTool("toolu_fresh", "2026-08-23T08:30:12.000Z"),
    ],
  };
  publishCanonicalAssistantClaims("conversation-group", [group, prose]);
  expect([...readCanonicalAssistantClaims("conversation-group")]).toEqual(["toolu_1", "toolu_2", "uuid-later"]);
  expect(visibleRuntimeLiveTurnItems(live, [group, prose], readCanonicalAssistantClaims("conversation-group"), "running").map((item) => item.itemId))
    .toEqual(["toolu_fresh"]);
});


test("reasoning group claims every member and immutably retains supplied text in source order", () => {
  const records = Array.from({ length: 20 }, (_, i) => JSON.stringify({ type: "event_msg", payload: {
    type: "item_completed", item: { type: "Reasoning", id: `member-${i}`, summary_text: [], raw_content: [] },
  } }));
  const feed = createFeedSession({ engine: "codex", fmt: "codex", showSvc: false, lineFilter: "" }).feed(records, 0, false).items;
  const live: RuntimeLiveTurn = { turnId: "turn-reasoning", text: "", items: [
    { itemId: "member-12", text: "Actual supplied summary", phase: "awaiting-echo", startedAt: null, completedAt: null },
    { itemId: "unrelated", text: "Other response", phase: "awaiting-echo", startedAt: null, completedAt: null },
  ] };
  const before = JSON.stringify(feed);
  const enriched = enrichCanonicalReasoning(feed, live);
  expect(JSON.stringify(feed)).toBe(before);
  expect(enriched).toHaveLength(1);
  expect(enriched[0].key).toBe(feed[0].key);
  expect(enriched[0].anchorKey).toBe(feed[0].anchorKey);
  const item = enriched[0].item;
  if (item.kind !== "think") throw new Error("expected reasoning");
  expect(item.members?.[12]).toMatchObject({ sourceId: "member-12", text: "Actual supplied summary", availability: "available" });
  expect(item.text).toBe("Actual supplied summary");
  expect(enrichCanonicalReasoning(feed, null, enriched)).toEqual(enriched);
  expect(visibleRuntimeLiveTurnItems(live, enriched).map((item) => item.itemId)).toEqual(["unrelated"]);
  publishCanonicalAssistantClaims("reasoning-claims", enriched);
  expect([...readCanonicalAssistantClaims("reasoning-claims")]).toEqual(Array.from({ length: 20 }, (_, i) => `member-${i}`));
  expect(enrichCanonicalReasoning(feed, null)).toBe(feed);
  expect(enrichCanonicalReasoning([], null, enriched)).toEqual([]);
});

test("supplied reasoning streaming text renders once; native text and other item kinds remain authoritative", () => {
  const member = { sourceId: "reason", anchorKey: "row:1:0", text: "", availability: "unavailable" as const };
  const feed: FeedEntry[] = [{ key: "1", anchorKey: "row:1:0", item: { kind: "think", text: "", members: [member] } }];
  const live: RuntimeLiveTurn = { turnId: "turn", text: "", items: [
    { itemId: "reason", text: "Real delta", phase: "streaming", startedAt: null, completedAt: null },
  ] };
  const enriched = enrichCanonicalReasoning(feed, live);
  expect(visibleRuntimeLiveTurnItems(live, enriched, undefined, "running")).toEqual([]);
  const native: FeedEntry[] = [{ ...feed[0], item: { kind: "think", text: "Native summary", members: [{ ...member, text: "Native summary", availability: "available" }] } }];
  expect(enrichCanonicalReasoning(native, live, enriched)).toBe(native);
  expect(visibleRuntimeLiveTurnItems(live, native, undefined, "running")).toEqual([]);
  const prose: FeedEntry[] = [{ key: "1", anchorKey: "row:1:0", item: { kind: "prose", sourceId: "reason", text: "", ts: null, engine: "codex" } }];
  expect(enrichCanonicalReasoning(prose, live)).toBe(prose);
  const moved: FeedEntry[] = [{ ...feed[0], item: { kind: "think", text: "", members: [{ ...member, anchorKey: "row:99:0" }] } }];
  expect(enrichCanonicalReasoning(moved, null, enriched)).toBe(moved);
});
