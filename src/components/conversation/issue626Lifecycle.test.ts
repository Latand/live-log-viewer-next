import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  applyEvent,
  installSnapshot,
  type RuntimeEnvelope,
  type RuntimeSession,
  type RuntimeSnapshot,
  type RuntimeStore,
} from "@/components/runtime/runtimeModel";
import { createFeedSession } from "@/components/feed/parse";
import { sessionForConversation } from "@/hooks/useRuntime";
import {
  appendRuntimeLiveTurnDelta,
  completeRuntimeLiveTurnItem,
  runtimeLiveTurnItems,
  type RuntimeLiveTurn,
} from "@/lib/runtime/liveTurn";
import { RuntimeJournal } from "@/runtime-host/journal";

import {
  reconcileRuntimeLiveTurnItems,
  visibleRuntimeLiveTurnItems,
} from "./liveTurnHandoff";

interface LifecycleFixture {
  identity: {
    conversationId: string;
    launchId: string;
    startingPath: string;
    adoptedPath: string;
  };
  fileCheckpoints: Array<{
    name: string;
    filesRevision: number;
    path: string;
  }>;
  runtimeEnvelopes: RuntimeEnvelope[];
  transcriptRecords: unknown[];
}

const fixture = JSON.parse(fs.readFileSync(
  path.join(import.meta.dir, "fixtures", "issue-626-lifecycle.json"),
  "utf8",
)) as LifecycleFixture;

function initialSession(): RuntimeSession {
  return {
    conversationId: fixture.identity.conversationId,
    sessionKey: { engine: "codex", sessionId: "session_issue_626" },
    hostKind: "codex-app-server",
    host: "hosted",
    turn: "idle",
    provenance: "structured",
    revision: 1,
    attentionIds: [],
    recentReceipts: [],
    accountId: "work",
    parentConversationId: null,
    flowId: null,
    workflowId: null,
    cwd: "/workspace",
    artifactPath: null,
    capabilities: { steer: true, structuredAttention: true },
    activeTurnId: null,
    liveTurn: null,
  };
}

function initialSnapshot(): RuntimeSnapshot {
  return {
    schemaVersion: 1,
    snapshotSeq: 1,
    retentionFloorSeq: 0,
    runtime: { hostEpoch: 1, health: "ready" },
    filesRevision: fixture.fileCheckpoints[0]!.filesRevision,
    sessions: [initialSession()],
    attentions: [],
    recentOperations: [],
    edges: [],
    flows: [],
    workflows: [],
    tasks: [],
    deployments: [],
  };
}

function apply(store: RuntimeStore, envelope: RuntimeEnvelope): RuntimeStore {
  const result = applyEvent(store, envelope);
  expect(result.outcome).toBe("applied");
  return result.outcome === "applied" ? result.store : store;
}

test("issue 626 RED: item completion keeps streamed commentary through the tool transition", () => {
  let store = installSnapshot(initialSnapshot());
  for (const envelope of fixture.runtimeEnvelopes.slice(0, 4)) {
    store = apply(store, envelope);
  }

  expect(store.sessions[fixture.identity.conversationId]?.liveTurn?.text)
    .toBe("First commentary survives the tool transition.");
  expect(store.filesRevision).toBe(40);
  expect(fixture.fileCheckpoints[1]).toEqual({
    name: "tool-transition-lag",
    filesRevision: 40,
    path: fixture.identity.startingPath,
  });
});

test("issue 626 RED: runtime snapshot refresh retains commentary before files-revision adoption", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-issue-626-journal-"));
  const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
  try {
    journal.append({
      scope: { type: "session", id: fixture.identity.conversationId },
      kind: "session-status",
      payload: initialSession() as unknown as Record<string, unknown>,
    });
    for (const envelope of fixture.runtimeEnvelopes.slice(0, 4)) {
      journal.append({
        scope: envelope.scope,
        kind: envelope.kind,
        payload: envelope.payload as Record<string, unknown>,
      });
    }

    const refreshed = installSnapshot(journal.snapshot());
    expect(refreshed.sessions[fixture.identity.conversationId]?.liveTurn?.text)
      .toBe("First commentary survives the tool transition.");
    expect(refreshed.filesRevision).toBe(0);
    expect(refreshed.scopeHeads[`session:${fixture.identity.conversationId}`]).toBe(5);
  } finally {
    journal.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("issue 626 identity control resolves one runtime session before and after transcript adoption", () => {
  const session = initialSession();
  const sessions = { [fixture.identity.conversationId]: session };

  expect(sessionForConversation(
    sessions,
    fixture.identity.conversationId,
    fixture.identity.startingPath,
  )).toBe(session);
  expect(sessionForConversation(
    sessions,
    fixture.identity.conversationId,
    fixture.identity.adoptedPath,
  )).toBe(session);
});

test("issue 626 handoff preserves two commentary items until their canonical response ids own them", () => {
  let store = installSnapshot(initialSnapshot());
  for (const envelope of fixture.runtimeEnvelopes) store = apply(store, envelope);
  const liveTurn = store.sessions[fixture.identity.conversationId]?.liveTurn;

  expect(store.sessions[fixture.identity.conversationId]).toMatchObject({
    turn: "idle",
    activeTurnId: null,
  });
  expect(store.filesRevision).toBe(41);
  expect(runtimeLiveTurnItems(liveTurn).map(({ itemId, phase, text }) => ({
    itemId,
    phase,
    text,
  }))).toEqual([
    {
      itemId: "item_commentary_626_first",
      phase: "awaiting-echo",
      text: "First commentary survives the tool transition.",
    },
    {
      itemId: "item_commentary_626_second",
      phase: "awaiting-echo",
      text: "Second commentary follows the tool output.",
    },
  ]);

  const lines = fixture.transcriptRecords.map((record) => JSON.stringify(record));
  const fullFeed = createFeedSession({
    engine: "codex",
    fmt: "codex",
    showSvc: false,
    lineFilter: "",
  }).feed(lines, 0, false);
  const chronology = fullFeed.items.map(({ item }) => {
    if (item.kind === "user") {
      return {
        kind: "user",
        text: item.text,
      };
    }
    if (item.kind === "prose") {
      return {
        kind: "commentary",
        sourceId: item.sourceId,
        text: item.text,
      };
    }
    if (item.kind === "tool") {
      return {
        kind: "tool",
        status: item.status,
        output: item.outputPreview,
      };
    }
    return { kind: item.kind };
  });
  expect(chronology).toEqual([
    {
      kind: "user",
      text: "Investigate issue 626.",
    },
    {
      kind: "commentary",
      sourceId: "item_commentary_626_first",
      text: "First commentary survives the tool transition.",
    },
    {
      kind: "tool",
      status: "ok",
      output: "TOOL_OUTPUT_626",
    },
    {
      kind: "commentary",
      sourceId: "item_commentary_626_second",
      text: "Second commentary follows the tool output.",
    },
  ]);

  expect(visibleRuntimeLiveTurnItems(liveTurn, []).map((item) => item.itemId))
    .toEqual(["item_commentary_626_first", "item_commentary_626_second"]);
  expect(visibleRuntimeLiveTurnItems(liveTurn, fullFeed.items)).toEqual([]);
  expect(fullFeed.items).toHaveLength(4);
});

test("issue 626 structured assistant projections own their matching live handoff", () => {
  const citation = [
    "<oai-mem-citation>",
    "<citation_entries>",
    "MEMORY.md:1-1|note=[canonical handoff]",
    "</citation_entries>",
    "<rollout_ids>",
    "</rollout_ids>",
    "</oai-mem-citation>",
  ].join("\n");
  const cases: Array<{
    id: string;
    text: string;
    kind: "review" | "mem-citation" | "blob";
  }> = [
    { id: "structured-review-626", text: "VERDICT: APPROVE\nNO FINDINGS", kind: "review" },
    { id: "structured-citation-626", text: citation, kind: "mem-citation" },
    { id: "structured-blob-626", text: "A".repeat(20_001), kind: "blob" },
  ];

  for (const candidate of cases) {
    const feed = createFeedSession({
      engine: "codex",
      fmt: "codex",
      showSvc: false,
      lineFilter: "",
    }).feed([JSON.stringify({
      type: "response_item",
      timestamp: "2026-07-23T12:00:00.000Z",
      payload: {
        type: "message",
        id: candidate.id,
        role: "assistant",
        content: [{ type: "output_text", text: candidate.text }],
      },
    })], 0, false);
    const liveTurn = {
      turnId: "turn-structured-626",
      text: candidate.text,
      items: [{
        itemId: candidate.id,
        text: candidate.text,
        phase: "awaiting-echo" as const,
        startedAt: "2026-07-23T12:00:00.000Z",
        completedAt: "2026-07-23T12:00:00.100Z",
      }],
    };

    expect(feed.items.map(({ item }) => item.kind)).toEqual([candidate.kind]);
    expect(visibleRuntimeLiveTurnItems(liveTurn, feed.items)).toEqual([]);
    expect(reconcileRuntimeLiveTurnItems(liveTurn, feed.items).newlyOwnedItemIds)
      .toEqual([candidate.id]);
  }
});

test("issue 626 filtered canonical identity retires the matching live handoff", () => {
  const itemId = "filtered-assistant-626";
  const feed = createFeedSession({
    engine: "codex",
    fmt: "codex",
    showSvc: false,
    lineFilter: "missing filter",
  }).feed([JSON.stringify({
    type: "response_item",
    timestamp: "2026-07-23T12:30:00.000Z",
    payload: {
      type: "message",
      id: itemId,
      role: "assistant",
      content: [{ type: "output_text", text: "Canonical despite filtering." }],
    },
  })], 0, false);
  const reconciliation = reconcileRuntimeLiveTurnItems({
    turnId: "turn-filtered-626",
    text: "Canonical despite filtering.",
    items: [{
      itemId,
      text: "Canonical despite filtering.",
      phase: "awaiting-echo",
      startedAt: "2026-07-23T12:30:00.000Z",
      completedAt: "2026-07-23T12:30:00.100Z",
    }],
  }, feed.items, feed.canonicalAssistantItemIds);

  expect(feed.items).toEqual([]);
  expect(reconciliation).toEqual({
    visible: [],
    newlyOwnedItemIds: [itemId],
  });
});

test("issue 626 canonical ownership receipts retire handoffs and survive a runtime restart", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-issue-626-ownership-"));
  const filename = path.join(directory, "runtime.sqlite");
  let journal: RuntimeJournal | null = new RuntimeJournal(filename, { structuredHosts: true });
  try {
    journal.append({
      scope: { type: "session", id: fixture.identity.conversationId },
      kind: "session-status",
      payload: initialSession() as unknown as Record<string, unknown>,
    });
    for (const envelope of fixture.runtimeEnvelopes.slice(0, 3)) {
      journal.append({
        scope: envelope.scope,
        kind: envelope.kind,
        payload: envelope.payload as Record<string, unknown>,
      });
    }
    journal.append({
      scope: { type: "session", id: fixture.identity.conversationId },
      kind: "canonical-ownership",
      producer: {
        kind: "viewer-canonical-ownership",
        eventKey: "issue-626-ownership-receipt",
      },
      payload: {
        conversationId: fixture.identity.conversationId,
        assistantItemIds: ["item_commentary_626_first"],
        launchOutboxIds: [fixture.identity.launchId],
        outboxEntryIds: ["queued-unrelated-626"],
      },
    });

    expect(journal.snapshot().sessions[0]).toMatchObject({
      liveTurn: null,
      canonicalOwnership: {
        launchOutboxIds: [fixture.identity.launchId],
        outboxEntryIds: ["queued-unrelated-626"],
      },
    });

    journal.close();
    journal = new RuntimeJournal(filename, { structuredHosts: true });
    expect(journal.snapshot().sessions[0]).toMatchObject({
      liveTurn: null,
      canonicalOwnership: {
        launchOutboxIds: [fixture.identity.launchId],
        outboxEntryIds: ["queued-unrelated-626"],
      },
    });
  } finally {
    journal?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("issue 626 keeps the oldest unclaimed assistant item when the active item window reaches 33", () => {
  let liveTurn: RuntimeLiveTurn | null = null;
  const expectedIds: string[] = [];
  for (let index = 0; index < 33; index += 1) {
    const itemId = `bounded-item-${index}`;
    const turnId = index < 17 ? "turn-before-tool-work" : "turn-after-tool-work";
    expectedIds.push(itemId);
    liveTurn = appendRuntimeLiveTurnDelta(
      liveTurn,
      turnId,
      `assistant item ${index}`,
      `2026-07-23T13:00:${String(index).padStart(2, "0")}.000Z`,
    );
    liveTurn = completeRuntimeLiveTurnItem(
      liveTurn,
      turnId,
      { type: "agentMessage", id: itemId, text: `assistant item ${index}` },
      `2026-07-23T13:00:${String(index).padStart(2, "0")}.500Z`,
    );
  }

  expect(runtimeLiveTurnItems(liveTurn).map((item) => item.itemId)).toEqual(expectedIds);
});

test("issue 626 adopts every bounded handoff once across tool work and journal refresh", () => {
  let liveTurn: RuntimeLiveTurn | null = null;
  const expectedIds: string[] = [];
  const records: unknown[] = [];
  for (let index = 0; index < 33; index += 1) {
    const itemId = `adoption-item-${index}`;
    const turnId = index < 17 ? "turn-before-tool-work" : "turn-after-tool-work";
    const assistantText = `bounded adoption item ${index}`;
    expectedIds.push(itemId);
    liveTurn = appendRuntimeLiveTurnDelta(
      liveTurn,
      turnId,
      assistantText,
      `2026-07-23T15:00:${String(index).padStart(2, "0")}.000Z`,
    );
    liveTurn = completeRuntimeLiveTurnItem(
      liveTurn,
      turnId,
      { type: "agentMessage", id: itemId, text: assistantText },
      `2026-07-23T15:00:${String(index).padStart(2, "0")}.500Z`,
    );
    records.push({
      type: "response_item",
      timestamp: `2026-07-23T15:01:${String(index).padStart(2, "0")}.000Z`,
      payload: {
        type: "message",
        id: itemId,
        role: "assistant",
        content: [{ type: "output_text", text: assistantText }],
      },
    });
  }
  expect(runtimeLiveTurnItems(liveTurn).map((item) => item.itemId)).toEqual(expectedIds);

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-issue-626-bounds-refresh-"));
  const filename = path.join(directory, "runtime.sqlite");
  let journal: RuntimeJournal | null = new RuntimeJournal(filename, { structuredHosts: true });
  try {
    journal.append({
      scope: { type: "session", id: fixture.identity.conversationId },
      kind: "session-status",
      payload: {
        ...initialSession(),
        liveTurn,
      } as unknown as Record<string, unknown>,
    });
    journal.close();
    journal = new RuntimeJournal(filename, { structuredHosts: true });
    const refreshedLiveTurn = journal.snapshot().sessions[0]?.liveTurn;
    expect(runtimeLiveTurnItems(refreshedLiveTurn).map((item) => item.itemId))
      .toEqual(expectedIds);

    const feed = createFeedSession({
      engine: "codex",
      fmt: "codex",
      showSvc: false,
      lineFilter: "",
    }).feed(records.map((record) => JSON.stringify(record)), 0, false);
    const reconciliation = reconcileRuntimeLiveTurnItems(
      refreshedLiveTurn,
      feed.items,
      feed.canonicalAssistantItemIds,
    );
    expect(feed.items.map(({ item }) =>
      item.kind === "prose" ? item.sourceId : null,
    )).toEqual(expectedIds);
    expect(reconciliation).toEqual({
      visible: [],
      newlyOwnedItemIds: expectedIds,
    });

    journal.append({
      scope: { type: "session", id: fixture.identity.conversationId },
      kind: "canonical-ownership",
      payload: {
        conversationId: fixture.identity.conversationId,
        assistantItemIds: reconciliation.newlyOwnedItemIds,
        launchOutboxIds: [],
        outboxEntryIds: [],
      },
    });
    journal.close();
    journal = new RuntimeJournal(filename, { structuredHosts: true });
    expect(runtimeLiveTurnItems(journal.snapshot().sessions[0]?.liveTurn)).toEqual([]);
  } finally {
    journal?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("issue 626 moves whole unclaimed items across the 64 KiB active-text bound", () => {
  const firstText = "A".repeat(40 * 1024);
  const secondText = "B".repeat(40 * 1024);
  let liveTurn = appendRuntimeLiveTurnDelta(
    null,
    "turn-before-tool",
    firstText,
    "2026-07-23T14:00:00.000Z",
  );
  liveTurn = completeRuntimeLiveTurnItem(
    liveTurn,
    "turn-before-tool",
    { type: "agentMessage", id: "large-item-first", text: firstText },
    "2026-07-23T14:00:01.000Z",
  );
  liveTurn = appendRuntimeLiveTurnDelta(
    liveTurn,
    "turn-after-tool",
    secondText,
    "2026-07-23T14:00:02.000Z",
  );
  liveTurn = completeRuntimeLiveTurnItem(
    liveTurn,
    "turn-after-tool",
    { type: "agentMessage", id: "large-item-second", text: secondText },
    "2026-07-23T14:00:03.000Z",
  );

  expect(runtimeLiveTurnItems(liveTurn).map(({ itemId, text }) => ({ itemId, text })))
    .toEqual([
      { itemId: "large-item-first", text: firstText },
      { itemId: "large-item-second", text: secondText },
    ]);
  expect(liveTurn?.overflowItems?.map((item) => item.itemId)).toEqual(["large-item-first"]);
});

test("issue 626 overflow stays bounded with a durable representation for older handoffs", () => {
  let liveTurn: RuntimeLiveTurn | null = null;
  for (let index = 0; index < 97; index += 1) {
    const itemId = `overflow-summary-item-${index}`;
    const assistantText = `overflow summary item ${index}`;
    liveTurn = appendRuntimeLiveTurnDelta(
      liveTurn,
      "turn-overflow-summary",
      assistantText,
      "2026-07-23T16:00:00.000Z",
    );
    liveTurn = completeRuntimeLiveTurnItem(
      liveTurn,
      "turn-overflow-summary",
      { type: "agentMessage", id: itemId, text: assistantText },
      "2026-07-23T16:00:01.000Z",
    );
  }

  expect(runtimeLiveTurnItems(liveTurn)).toHaveLength(96);
  expect(liveTurn?.items).toHaveLength(32);
  expect(liveTurn?.overflowItems).toHaveLength(64);
  expect(liveTurn?.overflowSummary).toEqual({
    itemCount: 1,
    textLength: "overflow summary item 0".length,
  });
});

test("issue 626 refresh after turn completion retains both handoffs until adopted feed ownership", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-issue-626-refresh-"));
  const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
  try {
    journal.append({
      scope: { type: "session", id: fixture.identity.conversationId },
      kind: "session-status",
      payload: initialSession() as unknown as Record<string, unknown>,
    });
    for (const envelope of fixture.runtimeEnvelopes) {
      journal.append({
        scope: envelope.scope,
        kind: envelope.kind,
        payload: envelope.payload as Record<string, unknown>,
      });
    }

    const refreshed = installSnapshot(journal.snapshot());
    const liveTurn = refreshed.sessions[fixture.identity.conversationId]?.liveTurn;
    expect(refreshed.sessions[fixture.identity.conversationId]).toMatchObject({
      revision: 9,
      turn: "idle",
      activeTurnId: null,
    });
    expect(refreshed.filesRevision).toBe(41);
    expect(runtimeLiveTurnItems(liveTurn).map((item) => item.itemId)).toEqual([
      "item_commentary_626_first",
      "item_commentary_626_second",
    ]);

    const fullFeed = createFeedSession({
      engine: "codex",
      fmt: "codex",
      showSvc: false,
      lineFilter: "",
    }).feed(fixture.transcriptRecords.map((record) => JSON.stringify(record)), 0, false);
    expect(visibleRuntimeLiveTurnItems(liveTurn, fullFeed.items)).toEqual([]);
  } finally {
    journal.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("issue 626 unclaimed handoffs survive a later turn during transcript lag", () => {
  const nextTurn: RuntimeEnvelope = {
    schemaVersion: 1,
    seq: 11,
    eventId: "event-626-11",
    scope: { type: "session", id: fixture.identity.conversationId },
    revision: 10,
    kind: "turn-started",
    occurredAt: "2026-07-23T09:00:07.000Z",
    payload: {
      conversationId: fixture.identity.conversationId,
      turnId: "turn_issue_626_followup",
    },
  };
  const nextDelta: RuntimeEnvelope = {
    schemaVersion: 1,
    seq: 12,
    eventId: "event-626-12",
    scope: { type: "session", id: fixture.identity.conversationId },
    revision: 11,
    kind: "delta",
    occurredAt: "2026-07-23T09:00:07.500Z",
    payload: {
      conversationId: fixture.identity.conversationId,
      turnId: "turn_issue_626_followup",
      text: "Follow-up commentary remains ordered.",
    },
  };

  let store = installSnapshot(initialSnapshot());
  for (const envelope of fixture.runtimeEnvelopes) store = apply(store, envelope);
  store = apply(store, nextTurn);
  expect(runtimeLiveTurnItems(store.sessions[fixture.identity.conversationId]?.liveTurn)
    .map((item) => item.itemId))
    .toEqual(["item_commentary_626_first", "item_commentary_626_second"]);
  store = apply(store, nextDelta);
  expect(runtimeLiveTurnItems(store.sessions[fixture.identity.conversationId]?.liveTurn)
    .map(({ itemId, phase, text }) => ({ itemId, phase, text })))
    .toEqual([
      {
        itemId: "item_commentary_626_first",
        phase: "awaiting-echo",
        text: "First commentary survives the tool transition.",
      },
      {
        itemId: "item_commentary_626_second",
        phase: "awaiting-echo",
        text: "Second commentary follows the tool output.",
      },
      {
        itemId: null,
        phase: "streaming",
        text: "Follow-up commentary remains ordered.",
      },
    ]);

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-issue-626-next-turn-"));
  const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
  try {
    journal.append({
      scope: { type: "session", id: fixture.identity.conversationId },
      kind: "session-status",
      payload: initialSession() as unknown as Record<string, unknown>,
    });
    for (const envelope of [...fixture.runtimeEnvelopes, nextTurn, nextDelta]) {
      journal.append({
        scope: envelope.scope,
        kind: envelope.kind,
        payload: envelope.payload as Record<string, unknown>,
      });
    }
    const refreshed = installSnapshot(journal.snapshot());
    expect(runtimeLiveTurnItems(refreshed.sessions[fixture.identity.conversationId]?.liveTurn)
      .map(({ itemId, phase, text }) => ({ itemId, phase, text })))
      .toEqual([
        {
          itemId: "item_commentary_626_first",
          phase: "awaiting-echo",
          text: "First commentary survives the tool transition.",
        },
        {
          itemId: "item_commentary_626_second",
          phase: "awaiting-echo",
          text: "Second commentary follows the tool output.",
        },
        {
          itemId: null,
          phase: "streaming",
          text: "Follow-up commentary remains ordered.",
        },
      ]);
  } finally {
    journal.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
