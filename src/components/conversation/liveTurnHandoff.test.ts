import { beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";

import type { FeedEntry } from "@/components/feed/parse";
import type { RuntimeLiveTurn } from "@/lib/runtime/liveTurn";

import {
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
