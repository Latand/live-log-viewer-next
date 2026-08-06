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

test("a canonical tool card claims its live tool row during the running turn and after feed eviction", () => {
  const toolId = "tool-claim-live";
  const live: RuntimeLiveTurn = {
    turnId: "turn-tool-claim",
    text: "",
    items: [{
      kind: "tool",
      itemId: toolId,
      text: JSON.stringify({ cmd: "bun test src/components/conversation/liveTurnHandoff.test.ts" }),
      toolName: "exec_command",
      toolEngine: "codex",
      phase: "streaming",
      startedAt: "2026-08-06T09:20:00.000Z",
      completedAt: null,
    }],
  };
  const canonicalFeed = [{
    anchorKey: "row:30:0",
    key: "30:0",
    item: {
      kind: "tool",
      id: toolId,
      ts: "2026-08-06T09:20:00.100Z",
      srcCall: 30,
      family: "shell",
      tool: "exec_command",
      icon: "shell",
      summary: "bun test src/components/conversation/liveTurnHandoff.test.ts",
      chips: [],
      status: "run",
      statusLabel: "Executing",
      outputPreview: "",
      outputTruncated: false,
      open: false,
    },
  }] as FeedEntry[];

  publishCanonicalAssistantClaims("conversation-tool-claim", canonicalFeed);
  const persisted = readCanonicalAssistantClaims("conversation-tool-claim");
  expect([...persisted]).toEqual([toolId]);
  expect(visibleRuntimeLiveTurnItems(live, canonicalFeed, persisted, "running")).toEqual([]);
  expect(visibleRuntimeLiveTurnItems(live, [], persisted, "running")).toEqual([]);
});

test("a canonical command group publishes claims for every grouped tool call", () => {
  const groupedFeed = [{
    anchorKey: "row:40:0",
    key: "40:0",
    item: {
      kind: "cmd-group",
      ids: ["grouped-command", "grouped-read"],
      calls: [],
      t0: "2026-08-06T09:21:00.000Z",
      t1: "2026-08-06T09:21:01.000Z",
      byTool: { exec_command: 1, Read: 1 },
      okCount: 2,
      errCount: 0,
      hasErr: false,
      active: false,
    },
  }] as FeedEntry[];

  publishCanonicalAssistantClaims("conversation-grouped-tools", groupedFeed);
  expect([...readCanonicalAssistantClaims("conversation-grouped-tools")]).toEqual([
    "grouped-command",
    "grouped-read",
  ]);
});

test("a canonical outgoing teammate message claims its live SendMessage tool row", () => {
  const toolId = "send-message-live";
  const live: RuntimeLiveTurn = {
    turnId: "turn-send-message",
    text: "",
    items: [{
      kind: "tool",
      itemId: toolId,
      text: JSON.stringify({ to: "worker-1", message: "check the branch" }),
      toolName: "SendMessage",
      toolEngine: "claude",
      phase: "streaming",
      startedAt: "2026-08-06T10:00:00.000Z",
      completedAt: null,
    }],
  };
  const canonicalFeed = [{
    anchorKey: "row:50:0",
    key: "50:0",
    item: {
      kind: "tmsg",
      ts: "2026-08-06T10:00:00.100Z",
      dir: "out",
      peer: "worker-1",
      summary: "",
      text: "check the branch",
      sourceId: toolId,
    },
  }] as FeedEntry[];

  publishCanonicalAssistantClaims("conversation-send-message", canonicalFeed);
  const persisted = readCanonicalAssistantClaims("conversation-send-message");
  expect([...persisted]).toEqual([toolId]);
  expect(visibleRuntimeLiveTurnItems(live, canonicalFeed, persisted, "running")).toEqual([]);
});
