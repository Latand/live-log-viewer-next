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
import { runtimeLiveTurnItems } from "@/lib/runtime/liveTurn";
import { RuntimeJournal } from "@/runtime-host/journal";

import { visibleRuntimeLiveTurnItems } from "./liveTurnHandoff";

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
