import { expect, test } from "bun:test";

import { visibleRuntimeLiveTurnItems } from "@/components/conversation/liveTurnHandoff";
import type { RuntimeLiveTurn } from "@/lib/runtime/liveTurn";

import { createFeedSession, type FeedEntry } from "./parse";
import { newestTranscriptInstant } from "./transcriptOrder";

const OPENING_ANSWER = "Reading the issue and the entry points now.";

/* A synthetic session in write order: the opening assistant message, the
   bookkeeping records the engine writes with NO `timestamp` field at all
   (`ai-title`, `last-prompt`, `mode`), later tool work, a later answer, and one
   more undated bookkeeping tail. */
const TRANSCRIPT = [
  { type: "user", uuid: "rec-1", timestamp: "2026-07-25T10:00:00.000Z", message: { role: "user", content: "Investigate issue 674." } },
  { type: "assistant", uuid: "rec-2", timestamp: "2026-07-25T10:00:04.000Z", message: { role: "assistant", content: [{ type: "text", text: OPENING_ANSWER }] } },
  { type: "ai-title", title: "Feed ordering" },
  { type: "last-prompt", lastPrompt: "Investigate issue 674." },
  { type: "mode", mode: "default" },
  { type: "assistant", uuid: "rec-6", timestamp: "2026-07-25T10:12:00.000Z", message: { role: "assistant", content: [{ type: "tool_use", id: "call-1", name: "Bash", input: { command: "rg --files src/components/feed" } }] } },
  { type: "user", uuid: "rec-7", timestamp: "2026-07-25T10:12:01.000Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: "parse.ts" }] } },
  { type: "ai-title", title: "Feed ordering" },
  { type: "assistant", uuid: "rec-9", timestamp: "2026-07-25T10:14:30.000Z", message: { role: "assistant", content: [{ type: "text", text: "The parser keeps record order." }] } },
  { type: "mode", mode: "default" },
  { type: "last-prompt", lastPrompt: "Investigate issue 674." },
];

function feedOf(records: readonly Record<string, unknown>[], showSvc = true): FeedEntry[] {
  const session = createFeedSession({ engine: "claude", fmt: "claude", showSvc, lineFilter: "" });
  return session.feed(records.map((record) => JSON.stringify(record)), 0, true).items;
}

test("issue 674: interleaved undated records never displace a dated row in the transcript feed", () => {
  const items = feedOf(TRANSCRIPT).map(({ item }) => ({
    kind: item.kind,
    text: "text" in item ? item.text : undefined,
  }));

  /* Record sequence, verbatim: the opening answer stays second, and the undated
     rows sit exactly where they were written — never dragged past dated rows. */
  expect(items).toEqual([
    { kind: "user", text: "Investigate issue 674." },
    { kind: "prose", text: OPENING_ANSWER },
    { kind: "svc", text: "ai-title" },
    { kind: "svc", text: "last-prompt" },
    { kind: "svc", text: "mode" },
    { kind: "tool", text: undefined },
    { kind: "svc", text: "ai-title" },
    { kind: "prose", text: "The parser keeps record order." },
    { kind: "svc", text: "mode" },
    { kind: "svc", text: "last-prompt" },
  ]);
});

test("issue 674: the newest transcript instant skips the undated tail instead of collapsing", () => {
  const feed = feedOf(TRANSCRIPT);
  /* The last three rows carry no timestamp; the answer written at 10:14:30 is
     still the transcript's high-water mark. */
  expect(newestTranscriptInstant(feed)).toBe(Date.parse("2026-07-25T10:14:30.000Z"));
  expect(newestTranscriptInstant([])).toBeNull();
  expect(newestTranscriptInstant(feedOf([{ type: "ai-title", title: "only" }, { type: "mode", mode: "default" }])))
    .toBeNull();
});

/** The opening answer as the structured host still holds it: completed, never
    claimed, because its transcript row is far above the window the pane keeps. */
const staleOpening: RuntimeLiveTurn = {
  turnId: "turn-674-opening",
  text: OPENING_ANSWER,
  items: [{
    itemId: "item-674-opening",
    text: OPENING_ANSWER,
    phase: "awaiting-echo",
    startedAt: "2026-07-25T10:00:03.000Z",
    completedAt: "2026-07-25T10:00:04.000Z",
  }],
};

test("issue 674: an unclaimed opening answer never renders below fresher transcript records", () => {
  /* The window the pane actually holds: the opening answer's row has slid out,
     so no claim can be made from it and none was ever persisted. */
  const paneWindow = feedOf(TRANSCRIPT.slice(5));
  expect(paneWindow.some(({ item }) => "text" in item && item.text === OPENING_ANSWER)).toBe(false);

  expect(visibleRuntimeLiveTurnItems(staleOpening, paneWindow)).toEqual([]);
});

test("issue 674: an undated tail cannot resurrect the stale opening answer", () => {
  /* Same window, but the transcript's last three records carry no timestamp —
     the case that made the stale line stick. */
  const paneWindow = feedOf(TRANSCRIPT.slice(5));
  expect(paneWindow.at(-1)?.item.kind).toBe("svc");

  expect(visibleRuntimeLiveTurnItems(staleOpening, paneWindow)).toEqual([]);
});

test("issue 674: a live item newer than every transcript record still renders in the tail", () => {
  const paneWindow = feedOf(TRANSCRIPT);
  const fresh: RuntimeLiveTurn = {
    turnId: "turn-674-fresh",
    text: "Still writing the fix.",
    items: [{
      itemId: "item-674-fresh",
      text: "Still writing the fix.",
      phase: "awaiting-echo",
      startedAt: "2026-07-25T10:15:00.000Z",
      completedAt: "2026-07-25T10:15:02.000Z",
    }],
  };

  expect(visibleRuntimeLiveTurnItems(fresh, paneWindow).map((item) => item.itemId))
    .toEqual(["item-674-fresh"]);
});

test("issue 674: a streaming item and an empty transcript keep their overlay rows", () => {
  const streaming: RuntimeLiveTurn = {
    turnId: "turn-674-streaming",
    text: "Reading src/components/feed",
    items: [{
      itemId: null,
      text: "Reading src/components/feed",
      phase: "streaming",
      startedAt: "2026-07-25T10:00:03.000Z",
      completedAt: null,
    }],
  };

  /* In flight: newer than anything the transcript can hold, whatever its dates. */
  expect(visibleRuntimeLiveTurnItems(streaming, feedOf(TRANSCRIPT)).map((item) => item.phase))
    .toEqual(["streaming"]);
  /* Mid-launch, before the transcript flushes a single record. */
  expect(visibleRuntimeLiveTurnItems(staleOpening, []).map((item) => item.itemId))
    .toEqual(["item-674-opening"]);
});
