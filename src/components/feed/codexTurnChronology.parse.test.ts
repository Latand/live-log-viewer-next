import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { FileEntry } from "@/lib/types";
import type { RuntimeLiveTurn } from "@/lib/runtime/liveTurn";

import { enrichCanonicalReasoning, visibleRuntimeLiveTurnItems } from "@/components/conversation/liveTurnHandoff";
import { buildFeed, createFeedSession, type FeedEntry, type Item } from "./parse";

const codexFile = {
  path: "src/components/feed/fixtures/codex-turn-chronology.jsonl",
  engine: "codex",
  fmt: "codex",
  activity: "recent",
} as FileEntry;

const fixture = readFileSync(
  join(import.meta.dir, "fixtures", "codex-turn-chronology-0.151.jsonl"),
  "utf8",
).trim().split("\n");
const finalStart = fixture.findIndex((line) => line.includes('"id":"message-final"'));
if (finalStart < 0) throw new Error("chronology fixture is missing its final answer");

function itemOrder(items: readonly Item[], includeReasoning = true): string[] {
  return items.flatMap((item) => {
    if (item.kind === "prose") return [item.text];
    if (item.kind === "think") return includeReasoning ? [item.text] : [];
    if (item.kind === "tool") return [item.id];
    if (item.kind === "cmd-group") return item.calls.map((call) => call.id);
    return [];
  });
}

function entryItems(entries: readonly FeedEntry[]): Item[] {
  return entries.map((entry) => entry.item);
}

describe("Codex current-generation turn chronology (#1395)", () => {
  test("a completed turn keeps commentary and tools in execution order with the final message last", () => {
    const completed = buildFeed(codexFile, fixture, false, "");

    expect(itemOrder(completed.items, false)).toEqual([
      "Inspecting the parser first.",
      "command-first",
      "command-second",
      "The task is complete.",
    ]);
    expect(completed.items.filter((item) => item.kind === "mem-citation")).toHaveLength(1);
  });

  test("a streamed reasoning block settles as a collapsed row in its streamed position", () => {
    const session = createFeedSession({ engine: "codex", fmt: "codex", showSvc: false, lineFilter: "" });
    const completed = session.feed(fixture, 0, false);
    const reasoning = completed.items.find((entry) => entry.item.kind === "think")?.item;
    const streamed: RuntimeLiveTurn = {
      turnId: "turn-chronology",
      text: "The first result fixes the ordering seam.",
      items: [{
        itemId: "reasoning-stream",
        text: "The first result fixes the ordering seam.",
        phase: "awaiting-echo",
        startedAt: "2026-09-01T05:00:03.000Z",
        completedAt: "2026-09-01T05:00:03.500Z",
      }],
    };

    expect(reasoning).toMatchObject({
      kind: "think",
      text: "",
      availability: "unavailable",
      sourceId: "reasoning-stream",
    });
    // This supplied-text control is conditional; the captured native fixture
    // itself has no readable summary and proves no historical delta loss.
    const enriched = enrichCanonicalReasoning(completed.items, streamed);
    expect(visibleRuntimeLiveTurnItems(streamed, enriched, undefined, "idle")).toEqual([]);
    expect(itemOrder(entryItems(enriched))).toEqual([
      "Inspecting the parser first.",
      "command-first",
      "The first result fixes the ordering seam.",
      "command-second",
      "The task is complete.",
    ]);
  });

  test("the live turn and its completed re-render keep the same shared row order", () => {
    const session = createFeedSession({ engine: "codex", fmt: "codex", showSvc: false, lineFilter: "" });
    const live = session.feed(fixture.slice(0, finalStart), 0, true);
    const completed = session.feed(fixture, 0, false);
    const liveOrder = itemOrder(entryItems(live.items));
    const completedOrder = itemOrder(entryItems(completed.items));

    expect(liveOrder).toEqual([
      "Inspecting the parser first.",
      "command-first",
      "",
      "command-second",
    ]);
    expect(completedOrder).toEqual([...liveOrder, "The task is complete."]);
  });
});
