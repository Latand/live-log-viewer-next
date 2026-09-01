import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { mergeRuntimeReceipts } from "@/components/TmuxComposer";
import { applyEvent, installSnapshot } from "@/components/runtime/runtimeModel";
import type { Flow } from "@/lib/flows/types";
import { UnixRuntimeHostClient } from "@/lib/runtime/client";
import { runtimePresentationReceipt, runtimeScope } from "@/lib/runtime/contracts";
import { projectEngineHostEvent } from "@/lib/runtime/engineHostEvents";
import { LIVE_TURN_TEXT_LIMIT } from "@/lib/runtime/liveTurn";
import { structuredContentDigest, type StructuredImageRef } from "@/lib/runtime/structuredContent";
import { streamingVoiceDelivery } from "@/lib/runtime/voiceDelivery";

import { RuntimeHost, RuntimeHostFence } from "./host";
import {
  RuntimeJournal,
  RuntimeJournalFault,
  RUNTIME_SNAPSHOT_STALE_EDGE_RETENTION_MS,
  RUNTIME_SNAPSHOT_TERMINAL_DEPLOYMENT_LIMIT,
} from "./journal";
import { serveRuntimeHost } from "./socket";

function sandbox(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `llv-runtime-${name}-`));
}

test("journal assigns global sequences, consecutive scoped revisions, and idempotent producer keys", () => {
  const dir = sandbox("sequence");
  const journal = new RuntimeJournal(path.join(dir, "events.sqlite"), { maxEvents: 100, now: () => 100 });
  const first = journal.append({ scope: runtimeScope("session", "one"), kind: "turn.started", payload: { turnId: "a" }, producerKey: "native:a" });
  const duplicate = journal.append({ scope: runtimeScope("session", "one"), kind: "turn.started", payload: { turnId: "a" }, producerKey: "native:a" });
  const second = journal.append({ scope: runtimeScope("session", "one"), kind: "turn.completed", payload: { turnId: "a" } });
  const third = journal.append({ scope: runtimeScope("flow", "one"), kind: "flow.ready", payload: {} });
  expect([first.seq, second.seq, third.seq]).toEqual([1, 2, 3]);
  expect([first.revision, second.revision, third.revision]).toEqual([1, 2, 1]);
  expect(duplicate).toEqual(first);
  const snapshot = journal.snapshot();
  expect(snapshot.snapshotSeq).toBe(3);
  expect(snapshot.sessions).toHaveLength(1);
  expect(snapshot.sessions[0]).toMatchObject({ conversationId: "one", turn: "idle", revision: 2 });
  expect(snapshot.flows).toHaveLength(1);
  expect(snapshot.flows[0]).toMatchObject({ revision: 1, value: { id: "one" } });
  journal.close();
});

test("producer dedupe keys are isolated by producer identity", () => {
  const dir = sandbox("producer-dedupe");
  const journal = new RuntimeJournal(path.join(dir, "events.sqlite"), { maxEvents: 100, now: () => 100 });
  const first = journal.append({
    scope: runtimeScope("session", "one"),
    kind: "turn.started",
    payload: { turnId: "a" },
    producer: { kind: "codex-app-server", eventKey: "native:a" },
  });
  const second = journal.append({
    scope: runtimeScope("session", "one"),
    kind: "turn.completed",
    payload: { turnId: "a" },
    producer: { kind: "claude-broker", eventKey: "native:a" },
  });
  expect([first.seq, second.seq]).toEqual([1, 2]);
  expect([first.revision, second.revision]).toEqual([1, 2]);
  journal.close();
});

test("producer cursor reports the highest durably acknowledged engine event", () => {
  const dir = sandbox("producer-cursor");
  const filename = path.join(dir, "events.sqlite");
  const sessionId = "thread-one";
  const prefix = `engine-host:codex:${sessionId}:`;
  const journal = new RuntimeJournal(filename, { maxEvents: 1, now: () => 100 });
  for (const sequence of [1, 2, 10]) {
    journal.append({
      scope: runtimeScope("session", "one"),
      kind: "delta",
      payload: { conversationId: "one", turnId: "turn-one", text: `delta ${sequence}` },
      producer: { kind: "codex-app-server", eventKey: `${prefix}${sequence}` },
    });
  }
  journal.compact(1);

  expect(journal.producerCursor("codex-app-server", prefix)).toBe(10);
  expect(journal.producerCursor("claude-broker", "engine-host:claude:thread-one:")).toBe(0);
  journal.close();

  const legacy = new Database(filename);
  const latest = legacy.query<{ event_json: string }, [string, string]>(
    "SELECT event_json FROM producer_receipts WHERE producer_kind = ? AND producer_key = ?",
  ).get("codex-app-server", `${prefix}10`)!;
  for (const sequence of [2, 9]) {
    legacy.query("INSERT INTO producer_receipts(producer_kind, producer_key, event_json) VALUES (?, ?, ?)")
      .run("codex-app-server", `${prefix}${sequence}`, latest.event_json);
  }
  legacy.close();

  const reopened = new RuntimeJournal(filename, { maxEvents: 1, now: () => 100 });
  expect(reopened.producerCursor("codex-app-server", prefix)).toBe(10);
  const stale = reopened.append({
    scope: runtimeScope("session", "one"),
    kind: "delta",
    payload: { conversationId: "one", turnId: "turn-one", text: "stale delta" },
    producer: { kind: "codex-app-server", eventKey: `${prefix}9` },
  });
  expect(stale.seq).toBe(3);
  reopened.close();

  const compacted = new Database(filename, { readonly: true });
  expect(compacted.query<{ count: number }, [string, string, string]>(
    "SELECT COUNT(*) AS count FROM producer_receipts WHERE producer_kind = ? AND producer_key >= ? AND producer_key < ?",
  ).get("codex-app-server", prefix, `${prefix}\uffff`)?.count).toBe(1);
  compacted.close();
});

test("canonical voice deliveries survive missed-running recovery and compaction until acknowledged", () => {
  const dir = sandbox("voice-delivery-recovery");
  const filename = path.join(dir, "events.sqlite");
  const unicode = `${"🫶🏽界".repeat(12_000)}\nterminal`;
  const journal = new RuntimeJournal(filename, { maxEvents: 100, now: () => 100 });
  journal.append({
    scope: runtimeScope("session", "conversation_voice"),
    kind: "item",
    payload: {
      conversationId: "conversation_voice",
      turnId: "turn-recovered",
      phase: "completed",
      item: { type: "agentMessage", id: "bounded", text: "bounded" },
      voiceResponse: { responseId: "response-one", text: unicode },
    },
  });
  journal.append({
    scope: runtimeScope("session", "conversation_voice"),
    kind: "item",
    payload: {
      conversationId: "conversation_voice",
      turnId: "turn-recovered",
      phase: "completed",
      item: { type: "agentMessage", id: "bounded-two", text: "bounded" },
      voiceResponse: { responseId: "response-two", text: "second" },
    },
  });
  journal.append({
    scope: runtimeScope("session", "conversation_voice"),
    kind: "turn-ended",
    payload: {
      conversationId: "conversation_voice",
      turnId: "turn-recovered",
      outcome: "completed",
    },
  });
  journal.compact(1);
  journal.close();

  const recovered = new RuntimeJournal(filename, { maxEvents: 100, now: () => 200 });
  const delivery = recovered.snapshot().sessions[0]?.voiceDeliveries?.[0];
  expect(delivery).toEqual({
    deliveryId: 'voice:["turn-recovered",["response-one","response-two"]]',
    turnId: "turn-recovered",
    responses: [
      { responseId: "response-one", text: unicode },
      { responseId: "response-two", text: "second" },
    ],
    ready: true,
  });
  expect(new TextEncoder().encode(delivery!.responses[0]!.text).length).toBeGreaterThan(64 * 1024);

  recovered.append({
    scope: runtimeScope("session", "conversation_voice"),
    kind: "voice-delivery-progress",
    payload: {
      conversationId: "conversation_voice",
      deliveryId: delivery!.deliveryId,
      responseIndex: 0,
      offset: 8_192,
    },
  });
  expect(recovered.snapshot().sessions[0]).toMatchObject({
    revision: 4,
    voiceDeliveries: [delivery],
  });
  recovered.append({
    scope: runtimeScope("session", "conversation_voice"),
    kind: "voice-delivery-acknowledged",
    payload: {
      conversationId: "conversation_voice",
      deliveryId: delivery!.deliveryId,
    },
  });
  expect(recovered.snapshot().sessions[0]?.voiceDeliveries).toEqual([]);
  recovered.close();
});

test("semantic voice chunks become ready immediately and interruption removes their queued suffix", () => {
  const dir = sandbox("voice-semantic-chunks");
  const journal = new RuntimeJournal(path.join(dir, "events.sqlite"), { maxEvents: 100, now: () => 100 });
  const delivery = streamingVoiceDelivery({
    sourceTurnId: "turn-streaming",
    chunkIndex: 0,
    startOffset: 0,
    endOffset: 19,
    text: "substantial phrase ",
  });
  journal.append({
    scope: runtimeScope("session", "conversation_streaming"),
    kind: "voice-chunk",
    payload: {
      conversationId: "conversation_streaming",
      turnId: "turn-streaming",
      voiceDelivery: delivery,
    },
  });
  expect(journal.snapshot().sessions[0]?.voiceDeliveries).toEqual([delivery]);
  journal.append({
    scope: runtimeScope("session", "conversation_streaming"),
    kind: "turn-ended",
    payload: {
      conversationId: "conversation_streaming",
      turnId: "turn-streaming",
      outcome: "interrupted",
    },
  });
  expect(journal.snapshot().sessions[0]?.voiceDeliveries).toEqual([]);
  journal.close();
});

test("acknowledged voice delivery stays retired after reload and terminal replay while an undelivered response hydrates", () => {
  const dir = sandbox("voice-delivery-reload");
  const filename = path.join(dir, "events.sqlite");
  const conversationId = "conversation_reload";
  const firstHostKey = "codex:thread-before-reload";
  const replayHostKey = "codex:thread-after-reload";
  const deliveredItem = {
    type: "agentMessage",
    id: "response-delivered",
    phase: "final_answer",
    text: "Delivered once before reload 🫶🏽",
  };
  const appendProjected = (
    journal: RuntimeJournal,
    hostKey: string,
    event: Parameters<typeof projectEngineHostEvent>[2],
  ) => {
    const projected = projectEngineHostEvent(conversationId, hostKey, event);
    expect(projected).not.toBeNull();
    return journal.append(projected!);
  };

  const journal = new RuntimeJournal(filename, { maxEvents: 100, now: () => 100 });
  appendProjected(journal, firstHostKey, {
    kind: "item",
    turnId: "turn-delivered",
    item: deliveredItem,
    phase: "completed",
    seq: 1,
  });
  appendProjected(journal, firstHostKey, {
    kind: "turn-ended",
    turnId: "turn-delivered",
    status: "completed",
    seq: 2,
  });
  const firstMount = installSnapshot(journal.snapshot());
  const delivered = firstMount.sessions[conversationId]?.voiceDeliveries?.[0];
  expect(delivered).toMatchObject({
    turnId: "turn-delivered",
    responses: [{ responseId: "response-delivered", text: deliveredItem.text }],
    ready: true,
  });
  appendProjected(journal, firstHostKey, {
    kind: "realtime-delivery-acknowledged",
    deliveryId: delivered!.deliveryId,
    digest: "delivered-digest",
    seq: 3,
  });
  expect(journal.snapshot().sessions[0]?.voiceDeliveries).toEqual([]);
  expect(journal.snapshot().sessions[0]?.acknowledgedVoiceDeliveryIds).toEqual([
    delivered!.deliveryId,
  ]);
  journal.compact(1);
  journal.close();

  const recovered = new RuntimeJournal(filename, { maxEvents: 100, now: () => 200 });
  appendProjected(recovered, replayHostKey, {
    kind: "item",
    turnId: "turn-delivered",
    item: deliveredItem,
    phase: "completed",
    seq: 1,
  });
  appendProjected(recovered, replayHostKey, {
    kind: "turn-ended",
    turnId: "turn-delivered",
    status: "completed",
    seq: 2,
  });
  appendProjected(recovered, replayHostKey, {
    kind: "item",
    turnId: "turn-undelivered",
    item: {
      type: "agentMessage",
      id: "response-undelivered",
      phase: "final_answer",
      text: "Genuinely undelivered after reload 界",
    },
    phase: "completed",
    seq: 3,
  });
  appendProjected(recovered, replayHostKey, {
    kind: "turn-ended",
    turnId: "turn-undelivered",
    status: "completed",
    seq: 4,
  });

  const reloadMount = installSnapshot(recovered.snapshot());
  expect(reloadMount.sessions[conversationId]?.acknowledgedVoiceDeliveryIds).toEqual([
    delivered!.deliveryId,
  ]);
  expect(reloadMount.sessions[conversationId]?.voiceDeliveries).toEqual([{
    deliveryId: 'voice:["turn-undelivered",["response-undelivered"]]',
    turnId: "turn-undelivered",
    responses: [{
      responseId: "response-undelivered",
      text: "Genuinely undelivered after reload 界",
    }],
    ready: true,
  }]);
  recovered.close();
});

test("snapshot exposes the canonical projected runtime model", () => {
  const dir = sandbox("canonical-snapshot");
  const journal = new RuntimeJournal(path.join(dir, "events.sqlite"), { maxEvents: 100, now: () => 100 });
  journal.append({
    scope: runtimeScope("session", "conv-one"),
    kind: "session.status",
    payload: {
      conversationId: "conv-one",
      sessionKey: { engine: "codex", sessionId: "thread-one" },
      hostKind: "codex-app-server",
      host: "hosted",
      turn: "idle",
      provenance: "structured",
      accountId: "account-one",
      parentConversationId: null,
      flowId: null,
      workflowId: null,
      cwd: "/repo",
      artifactPath: "/sessions/one.jsonl",
      capabilities: { steer: true, structuredAttention: true },
      activeTurnId: null,
    },
  });
  journal.append({
    scope: runtimeScope("session", "conv-one"),
    kind: "turn.started",
    payload: { conversationId: "conv-one", turnId: "turn-one" },
  });
  journal.append({
    scope: runtimeScope("session", "conv-one"),
    kind: "attention.requested",
    payload: {
      id: "attention-one",
      conversationId: "conv-one",
      kind: "approval",
      state: "open",
      unowned: false,
      createdAt: "2026-07-10T00:00:00.000Z",
      request: { command: "bun test" },
      turnId: "turn-one",
    },
  });

  expect(journal.snapshot()).toEqual({
    schemaVersion: 1,
    snapshotSeq: 3,
    retentionFloorSeq: 0,
    serverTime: "1970-01-01T00:00:00.100Z",
    runtime: { hostEpoch: 1, health: "ready" },
    filesRevision: 0,
    sessions: [{
      conversationId: "conv-one",
      sessionKey: { engine: "codex", sessionId: "thread-one" },
      hostKind: "codex-app-server",
      host: "hosted",
      turn: "running",
      provenance: "structured",
      revision: 3,
      attentionIds: ["attention-one"],
      recentReceipts: [],
      accountId: "account-one",
      parentConversationId: null,
      flowId: null,
      workflowId: null,
      cwd: "/repo",
      artifactPath: "/sessions/one.jsonl",
      capabilities: {
        steer: true,
        structuredAttention: true,
        imageInput: expect.objectContaining({
          supported: false,
          reason: "The selected Codex model does not advertise image input through app-server.",
        }),
      },
      activeTurnId: "turn-one",
      liveTurn: null,
      pendingReconfigure: null,
      drift: null,
    }],
    attentions: [{
      id: "attention-one",
      conversationId: "conv-one",
      kind: "approval",
      state: "open",
      unowned: false,
      createdAt: "2026-07-10T00:00:00.000Z",
      request: { command: "bun test" },
      turnId: "turn-one",
    }],
    recentOperations: [],
    edges: [],
    flows: [],
    workflows: [],
    tasks: [],
    deployments: [],
  });
  journal.close();
});

test("snapshot bounds inactive session history while retaining every active session", () => {
  const dir = sandbox("bounded-inactive-snapshot");
  const journal = new RuntimeJournal(path.join(dir, "events.sqlite"), { maxEvents: 2_000, now: () => 100 });
  const projectSession = (conversationId: string, host: "hosted" | "dead") => journal.append({
    scope: runtimeScope("session", conversationId),
    kind: "session-status",
    payload: {
      conversationId,
      sessionKey: { engine: "claude", sessionId: `session-${conversationId}` },
      hostKind: "claude-broker",
      host,
      turn: "idle",
      provenance: "structured",
      capabilities: { steer: false, structuredAttention: true },
    },
  });

  projectSession("conversation_active_oldest", "hosted");
  for (let index = 0; index < 300; index += 1) {
    projectSession(`conversation_dead_${String(index).padStart(3, "0")}`, "dead");
  }

  const snapshot = journal.snapshot();
  const ids = new Set(snapshot.sessions.map((session) => session.conversationId));
  expect(snapshot.sessions).toHaveLength(129);
  expect(ids.has("conversation_active_oldest")).toBeTrue();
  expect(ids.has("conversation_dead_299")).toBeTrue();
  expect(ids.has("conversation_dead_000")).toBeFalse();
  expect(journal.sessionState("conversation_dead_000")).toMatchObject({ host: "dead" });
  journal.close();
});

test("snapshot drops large live turns from every hosted idle session", () => {
  const dir = sandbox("bounded-idle-live-turns");
  const filename = path.join(dir, "events.sqlite");
  const journal = new RuntimeJournal(filename, { maxEvents: 1_000, now: () => 100 });
  const sessionCount = 300;
  for (let index = 0; index < sessionCount; index += 1) {
    const conversationId = `conversation_idle_${String(index).padStart(3, "0")}`;
    journal.append({
      scope: runtimeScope("session", conversationId),
      kind: "session-status",
      payload: {
        conversationId,
        sessionKey: { engine: "codex", sessionId: `session-${index}` },
        hostKind: "codex-app-server",
        host: "hosted",
        turn: "idle",
        provenance: "structured",
        capabilities: { steer: true, structuredAttention: true },
      },
    });
  }

  // Recreate the oversized durable rows that predated live-turn bounding.
  const legacyText = "x".repeat(LIVE_TURN_TEXT_LIMIT);
  const raw = new Database(filename);
  raw.query(`
    UPDATE entities
    SET state_json = json_set(
      state_json,
      '$.liveTurn',
      json(?)
    )
    WHERE kind = 'session'
  `).run(JSON.stringify({ turnId: "turn-finished", text: legacyText }));
  raw.close();

  expect(sessionCount * Buffer.byteLength(legacyText)).toBeGreaterThan(16 * 1024 * 1024);
  expect(journal.sessionState("conversation_idle_000")?.liveTurn?.text).toHaveLength(LIVE_TURN_TEXT_LIMIT);
  const json = journal.snapshotJson();
  const snapshot = JSON.parse(json) as ReturnType<RuntimeJournal["snapshot"]>;
  expect(snapshot.sessions).toHaveLength(sessionCount);
  expect(snapshot.sessions.every((session) => session.liveTurn === null)).toBeTrue();
  expect(Buffer.byteLength(json)).toBeLessThan(4 * 1024 * 1024);
  journal.close();
});

test("snapshot nulls live turns for every non-running turn axis regardless of host", () => {
  const dir = sandbox("non-running-live-turns");
  const journal = new RuntimeJournal(path.join(dir, "events.sqlite"), { now: () => 100 });
  for (const [turn, host] of [
    ["idle", "hosted"],
    ["unknown", "dead"],
    ["interrupt_requested", "unhosted"],
  ] as const) {
    journal.append({
      scope: runtimeScope("session", `conversation-${turn}`),
      kind: "session-status",
      payload: {
        conversationId: `conversation-${turn}`,
        host,
        turn,
        liveTurn: { turnId: `turn-${turn}`, text: "stale live text" },
      },
    });
  }

  expect(journal.snapshot().sessions.map((session) => session.liveTurn)).toEqual([null, null, null]);
  journal.close();
});

test("snapshot caps a legacy running live turn to its marked UTF-8 tail", () => {
  const dir = sandbox("bounded-running-live-turn");
  const filename = path.join(dir, "events.sqlite");
  const journal = new RuntimeJournal(filename, { now: () => 100 });
  journal.append({
    scope: runtimeScope("session", "conversation-running"),
    kind: "session-status",
    payload: {
      conversationId: "conversation-running",
      sessionKey: { engine: "codex", sessionId: "session-running" },
      hostKind: "codex-app-server",
      host: "hosted",
      turn: "running",
      provenance: "structured",
      capabilities: { steer: true, structuredAttention: true },
      activeTurnId: "turn-running",
    },
  });

  const tail = "tail-界";
  const legacyText = `${"🫶🏽".repeat(LIVE_TURN_TEXT_LIMIT)}${tail}`;
  const raw = new Database(filename);
  const row = raw.query<{ state_json: string }, [string, string]>(
    "SELECT state_json FROM entities WHERE kind = ? AND id = ?",
  ).get("session", "conversation-running")!;
  const state = JSON.parse(row.state_json) as Record<string, unknown>;
  state.liveTurn = { turnId: "turn-running", text: legacyText };
  raw.query("UPDATE entities SET state_json = ? WHERE kind = ? AND id = ?")
    .run(JSON.stringify(state), "session", "conversation-running");
  raw.close();

  expect(Buffer.byteLength(journal.sessionState("conversation-running")?.liveTurn?.text ?? ""))
    .toBeGreaterThan(LIVE_TURN_TEXT_LIMIT);
  const liveTurn = journal.snapshot().sessions[0]?.liveTurn;
  expect(liveTurn).not.toBeNull();
  expect(Buffer.byteLength(liveTurn?.text ?? "")).toBeLessThanOrEqual(LIVE_TURN_TEXT_LIMIT);
  expect(liveTurn?.text.endsWith(tail)).toBeTrue();
  expect(liveTurn?.items?.some((item) => (item.omittedChars ?? 0) > 0)).toBeTrue();
  journal.close();
});

test("snapshot retains active and newest terminal deployments without deleting history", () => {
  const dir = sandbox("bounded-deployments");
  let now = 100;
  const journal = new RuntimeJournal(path.join(dir, "events.sqlite"), { now: () => now });
  const terminalIds: string[] = [];
  for (let index = 0; index < RUNTIME_SNAPSHOT_TERMINAL_DEPLOYMENT_LIMIT + 5; index += 1) {
    const receipt = journal.admitViewerDeployment({
      idempotencyKey: `deployment-${index}`,
      requestedRevision: `requested-${index}`,
      revision: `revision-${index}`,
    }, { pid: index + 1, startIdentity: null });
    if (receipt.state !== "accepted") throw new Error("deployment fixture was not admitted");
    terminalIds.push(receipt.deploymentId);
    now += 1;
    journal.updateViewerDeployment(receipt.deploymentId, { phase: "succeeded", terminal: true });
    now += 1;
  }
  const active = journal.admitViewerDeployment({
    idempotencyKey: "deployment-active",
    requestedRevision: "requested-active",
    revision: "revision-active",
  }, { pid: 99, startIdentity: null });
  if (active.state !== "accepted") throw new Error("active deployment fixture was not admitted");

  const snapshotIds = new Set(journal.snapshot().deployments.map((deployment) => deployment.deploymentId));
  expect(snapshotIds.size).toBe(RUNTIME_SNAPSHOT_TERMINAL_DEPLOYMENT_LIMIT + 1);
  expect(snapshotIds.has(active.deploymentId)).toBeTrue();
  expect(snapshotIds.has(terminalIds[0]!)).toBeFalse();
  expect(snapshotIds.has(terminalIds.at(-1)!)).toBeTrue();
  expect(journal.viewerDeployment(terminalIds[0]!)).toMatchObject({ terminal: true, phase: "succeeded" });
  journal.close();
});

test("snapshot omits stale terminal-session edges while durable rows remain", () => {
  const dir = sandbox("bounded-edges");
  const filename = path.join(dir, "events.sqlite");
  let now = 100;
  const journal = new RuntimeJournal(filename, { maxEvents: 100, now: () => now });
  const spawn = (suffix: string) => journal.executeOperation({
    kind: "spawn",
    conversationId: `child-${suffix}`,
    operationId: `operation-${suffix}`,
    idempotencyKey: `spawn-${suffix}`,
    engine: "codex",
    cwd: "repo",
    "prompt": "Run the fixture",
    parentConversationId: "parent",
    sessionId: `session-${suffix}`,
  });
  const setHost = (suffix: string, host: "hosted" | "dead" | "unhosted") => journal.append({
    scope: runtimeScope("session", `child-${suffix}`),
    kind: "session-status",
    payload: { host, turn: "idle" },
  });

  spawn("stale-dead");
  setHost("stale-dead", "dead");
  spawn("recent-terminal");
  setHost("recent-terminal", "hosted");
  spawn("active-old");
  setHost("active-old", "hosted");
  now += RUNTIME_SNAPSHOT_STALE_EDGE_RETENTION_MS + 1;
  setHost("recent-terminal", "unhosted");

  const edgeIds = journal.snapshot().edges.map((edge) => edge.id);
  expect(edgeIds).toEqual(["edge-operation-active-old", "edge-operation-recent-terminal"]);
  const raw = new Database(filename, { readonly: true });
  expect(raw.query<{ count: number }, []>(
    "SELECT COUNT(*) AS count FROM entities WHERE kind = 'edge'",
  ).get()?.count).toBe(3);
  raw.close();
  journal.close();
});

test("snapshot retains an old edge when a recent terminal checkpoint was compacted", () => {
  const dir = sandbox("compacted-terminal-edge");
  const filename = path.join(dir, "events.sqlite");
  const day = 24 * 60 * 60 * 1_000;
  let now = 0;
  const journal = new RuntimeJournal(filename, { maxEvents: 100, now: () => now });
  journal.executeOperation({
    kind: "spawn",
    conversationId: "child-compacted-terminal",
    operationId: "operation-compacted-terminal",
    idempotencyKey: "spawn-compacted-terminal",
    engine: "codex",
    cwd: "repo",
    "prompt": "Run the fixture",
    parentConversationId: "parent",
    sessionId: "session-compacted-terminal",
  });

  now = 6 * day;
  journal.append({
    scope: runtimeScope("session", "child-compacted-terminal"),
    kind: "session-status",
    payload: { host: "dead", turn: "idle" },
  });
  journal.append({
    scope: runtimeScope("session", "unrelated-session"),
    kind: "session-status",
    payload: { host: "hosted", turn: "idle" },
  });
  journal.compact(1);
  now = 8 * day;

  const raw = new Database(filename, { readonly: true });
  expect(raw.query<{ count: number }, []>(`
    SELECT COUNT(*) AS count
    FROM entities AS session
    JOIN events AS event ON event.seq = session.checkpoint_seq
    WHERE session.kind = 'session' AND session.id = 'child-compacted-terminal'
  `).get()?.count).toBe(0);
  expect(raw.query<{ count: number }, []>(`
    SELECT COUNT(*) AS count FROM entities WHERE kind = 'edge'
  `).get()?.count).toBe(1);
  raw.close();

  expect(journal.snapshot().edges.map((edge) => edge.id))
    .toEqual(["edge-operation-compacted-terminal"]);
  journal.close();
});

test("journal backfills entity update times when reopening a legacy schema", () => {
  const dir = sandbox("legacy-entity-update-time");
  const filename = path.join(dir, "events.sqlite");
  const initial = new RuntimeJournal(filename, { now: () => 123 });
  initial.append({
    scope: runtimeScope("session", "legacy-session"),
    kind: "session-status",
    payload: { host: "dead", turn: "idle" },
  });
  initial.close();

  const legacy = new Database(filename);
  legacy.exec(`
    ALTER TABLE entities RENAME TO entities_with_update_time;
    CREATE TABLE entities (
      kind TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL,
      state_json TEXT NOT NULL, checkpoint_seq INTEGER NOT NULL,
      PRIMARY KEY(kind, id)
    );
    INSERT INTO entities(kind, id, revision, state_json, checkpoint_seq)
    SELECT kind, id, revision, state_json, checkpoint_seq FROM entities_with_update_time;
    DROP TABLE entities_with_update_time;
  `);
  legacy.close();

  const reopened = new RuntimeJournal(filename, { now: () => 999 });
  const migrated = new Database(filename, { readonly: true });
  expect(migrated.query<{ updated_at: number }, [string, string]>(`
    SELECT updated_at FROM entities WHERE kind = ? AND id = ?
  `).get("session", "legacy-session")?.updated_at).toBe(123);
  migrated.close();
  reopened.close();
});

test("issue 51 keeps tool work running until authoritative turn completion", () => {
  const dir = sandbox("terminal-axes");
  const journal = new RuntimeJournal(path.join(dir, "events.sqlite"), { maxEvents: 100, now: () => 100 });
  journal.append({
    scope: runtimeScope("session", "conv-one"),
    kind: "session-status",
    payload: { hostKind: "codex-app-server", host: "hosted", turn: "running", activeTurnId: "turn-one" },
  });
  journal.append({ scope: runtimeScope("session", "conv-one"), kind: "item.completed", payload: { itemType: "agentMessage" } });
  journal.append({ scope: runtimeScope("session", "conv-one"), kind: "item.completed", payload: { itemType: "commandExecution" } });
  expect(journal.snapshot().sessions[0]?.turn).toBe("running");
  journal.append({ scope: runtimeScope("session", "conv-one"), kind: "host.disconnected", payload: {} });
  expect(journal.snapshot().sessions[0]).toMatchObject({ host: "recovering", turn: "unknown", provenance: "replayed" });
  journal.append({ scope: runtimeScope("session", "conv-one"), kind: "turn.completed", payload: { turnId: "turn-one" } });
  expect(journal.snapshot().sessions[0]?.turn).toBe("idle");
  journal.close();
});

test("send operations converge by idempotency key and persist one receipt and effect", () => {
  const dir = sandbox("operation-dedupe");
  // Legacy (non-structured) receipt shape: opt out explicitly now that
  // structured hosting is the default.
  const journal = new RuntimeJournal(path.join(dir, "events.sqlite"), { structuredHosts: false, maxEvents: 100, now: () => 100 });
  journal.append({
    scope: runtimeScope("session", "conv-one"),
    kind: "session-status",
    payload: {
      conversationId: "conv-one",
      sessionKey: { engine: "codex", sessionId: "thread-one" },
      hostKind: "codex-app-server",
      host: "hosted",
      turn: "running",
      provenance: "structured",
      capabilities: { steer: true, structuredAttention: true },
      activeTurnId: "turn-one",
    },
  });
  const command = {
    kind: "send" as const,
    operationId: "op-send-one",
    idempotencyKey: "send-key-one",
    conversationId: "conv-one",
    text: "keep going",
    policy: "steer-if-active" as const,
  };

  const first = journal.executeOperation(command);
  const duplicate = journal.executeOperation(command);

  expect(first.replayed).toBe(false);
  expect(duplicate).toEqual({ ...first, replayed: true });
  expect(first.receipt).toMatchObject({
    operationId: "op-send-one",
    idempotencyKey: "send-key-one",
    conversationId: "conv-one",
    kind: "send",
    status: "pending",
    turnId: "turn-one",
    revision: 1,
  });
  expect(journal.effectBatch()).toHaveLength(1);
  expect(journal.snapshot().recentOperations).toHaveLength(1);
  expect(journal.snapshot().sessions[0]?.recentReceipts).toHaveLength(1);
  expect(() => journal.executeOperation({ ...command, text: "different" })).toThrow("idempotency key already belongs to another request");
  expect(() => journal.executeOperation({ ...command, idempotencyKey: "send-key-two" })).toThrow("operationId already belongs to another request");
  /* #1117: authorship is server-derived metadata — caller attribution can
     lawfully differ between a call and its replay — so a changed origin must
     replay, never conflict. */
  expect(journal.executeOperation({ ...command, origin: { kind: "agent" as const, role: "reviewer" } }))
    .toEqual({ ...first, replayed: true });
  journal.close();
});

test("send receipt echoes the per-turn runtime settings snapshot (issue #499)", () => {
  const dir = sandbox("operation-runtime-echo");
  const journal = new RuntimeJournal(path.join(dir, "events.sqlite"), { structuredHosts: true, maxEvents: 100, now: () => 100 });
  journal.append({
    scope: runtimeScope("session", "conv-rt"),
    kind: "session-status",
    payload: {
      conversationId: "conv-rt",
      sessionKey: { engine: "codex", sessionId: "thread-rt" },
      hostKind: "codex-app-server",
      host: "hosted",
      turn: "idle",
      provenance: "structured",
      capabilities: { steer: true, structuredAttention: true },
      activeTurnId: null,
    },
  });
  const runtime = { model: "gpt-5.6-sol", effort: "xhigh", fast: true };
  const command = {
    kind: "send" as const,
    operationId: "op-send-rt",
    idempotencyKey: "send-key-rt",
    conversationId: "conv-rt",
    text: "carry my selection",
    policy: "queue" as const,
    runtime,
  };

  const first = journal.executeOperation(command);
  const replay = journal.executeOperation(command);

  /* The receipt is the audit record the composer and the acceptance flow read:
     it must carry exactly the settings the send was admitted with, and a
     replayed key must return the identical echo. */
  expect(first.receipt.runtime).toEqual(runtime);
  expect(replay.receipt.runtime).toEqual(runtime);
  /* The durable effect delivers the same snapshot to the provider host. */
  const effects = journal.effectBatch();
  expect(effects).toHaveLength(1);
  expect((effects[0]!.payload as { runtime?: unknown }).runtime).toEqual(runtime);
  /* A send without a selection stays byte-identical to today's format. */
  const bare = journal.executeOperation({
    kind: "send",
    operationId: "op-send-bare",
    idempotencyKey: "send-key-bare",
    conversationId: "conv-rt",
    text: "no selection",
    policy: "queue",
  });
  expect("runtime" in bare.receipt).toBe(false);
  journal.close();
});

test("reconfigure admission durably replaces the session pending switch", () => {
  const dir = sandbox("reconfigure-last-write-wins");
  const journal = new RuntimeJournal(path.join(dir, "events.sqlite"), { structuredHosts: true, now: () => 100 });
  journal.append({
    scope: runtimeScope("session", "conv-reconfigure"),
    kind: "session-status",
    payload: {
      conversationId: "conv-reconfigure",
      sessionKey: { engine: "codex", sessionId: "thread-one" },
      hostKind: "codex-app-server",
      host: "hosted",
      turn: "running",
      provenance: "structured",
      accountId: "default",
      capabilities: { steer: true, structuredAttention: true },
      activeTurnId: "turn-one",
    },
  });

  const first = journal.executeOperation({
    kind: "reconfigure",
    operationId: "reconfigure-one",
    idempotencyKey: "reconfigure-one",
    conversationId: "conv-reconfigure",
    model: "gpt-5.6-sol",
    effort: "high",
    fast: false,
  });
  const second = journal.executeOperation({
    kind: "reconfigure",
    operationId: "reconfigure-two",
    idempotencyKey: "reconfigure-two",
    conversationId: "conv-reconfigure",
    model: "gpt-5.6-terra",
    effort: "xhigh",
    fast: true,
    accountId: "work",
  });

  expect(first.receipt.status).toBe("queued");
  expect(second.receipt.status).toBe("queued");
  expect(journal.snapshot().sessions[0]?.pendingReconfigure).toEqual({
    operationId: "reconfigure-two",
    model: "gpt-5.6-terra",
    effort: "xhigh",
    fast: true,
    accountId: "work",
  });
  expect(journal.effectBatch(100, ["runtime.reconfigure"])).toHaveLength(2);
  expect(journal.transitionOperation(first.operationId, "failed", { reason: "superseded" }).receipt.status).toBe("failed");
  expect(journal.snapshot().sessions[0]?.pendingReconfigure?.operationId).toBe(second.operationId);
  expect(journal.transitionOperation(second.operationId, "applying").receipt.status).toBe("applying");
  expect(journal.effectBatch(100, ["runtime.reconfigure"])).toHaveLength(1);
  expect(journal.transitionOperation(second.operationId, "applied").receipt.status).toBe("applied");
  expect(journal.snapshot().sessions[0]?.pendingReconfigure).toBeNull();
  expect(journal.effectBatch(100, ["runtime.reconfigure"])).toHaveLength(0);
  journal.close();
});

test("image refs remain ordered and participate in journal idempotency", () => {
  const dir = sandbox("operation-images");
  const journal = new RuntimeJournal(path.join(dir, "events.sqlite"), { structuredHosts: true });
  journal.append({
    scope: runtimeScope("session", "conv-images"),
    kind: "session-status",
    payload: {
      conversationId: "conv-images",
      sessionKey: { engine: "claude", sessionId: "session-images" },
      hostKind: "claude-broker",
      host: "hosted",
      turn: "idle",
      provenance: "structured",
      capabilities: { steer: false, structuredAttention: true },
    },
  });
  const images: StructuredImageRef[] = [
    { sha256: "a".repeat(64), mime: "image/png", bytes: 67 },
    { sha256: "b".repeat(64), mime: "image/webp", bytes: 80 },
  ];
  const command = {
    kind: "send" as const,
    operationId: "op-images",
    idempotencyKey: "key-images",
    conversationId: "conv-images",
    text: "",
    images,
    contentDigest: structuredContentDigest({ text: "", images }),
    policy: "queue" as const,
  };

  const first = journal.executeOperation(command);
  expect(first.receipt).toMatchObject({ status: "queued", text: "", imageCount: 2 });
  expect(journal.effectBatch()[0]?.payload).toMatchObject({
    operationId: "op-images",
    text: "",
    images,
    contentDigest: command.contentDigest,
  });
  expect(Buffer.byteLength(JSON.stringify(journal.effectBatch()[0]))).toBeLessThan(16 * 1024);
  expect(() => journal.executeOperation({
    ...command,
    images: [{ ...images[0]!, sha256: "c".repeat(64) }, images[1]!],
    contentDigest: structuredContentDigest({
      text: "",
      images: [{ ...images[0]!, sha256: "c".repeat(64) }, images[1]!],
    }),
  })).toThrow("idempotency key already belongs to another request");
  journal.close();
});

test("runtime restart migrates a legacy operation with no conversation identity", () => {
  const dir = sandbox("operation-idempotency-missing-conversation");
  const filename = path.join(dir, "events.sqlite");
  const initial = new RuntimeJournal(filename, { maxEvents: 100, now: () => 100 });
  const original = initial.executeOperation({
    kind: "send",
    operationId: "op-missing-conversation",
    idempotencyKey: "composer-message-without-conversation",
    conversationId: "conversation-removed-from-legacy-json",
    text: "survive the legacy migration",
    policy: "queue",
  });
  initial.close();

  const legacy = new Database(filename);
  legacy.exec(`
    BEGIN IMMEDIATE;
    ALTER TABLE operations RENAME TO operations_scoped_idempotency;
    CREATE TABLE operations (
      operation_id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE,
      request_hash TEXT NOT NULL, request_json TEXT NOT NULL,
      receipt_json TEXT NOT NULL, event_seq INTEGER NOT NULL
    );
    INSERT INTO operations(operation_id, idempotency_key, request_hash, request_json, receipt_json, event_seq)
    SELECT operation_id, idempotency_key, request_hash,
      json_remove(request_json, '$.conversationId'),
      json_remove(receipt_json, '$.conversationId'),
      event_seq
    FROM operations_scoped_idempotency;
    DROP TABLE operations_scoped_idempotency;
    COMMIT;
  `);
  legacy.close();

  const migrated = new RuntimeJournal(filename, { maxEvents: 100, now: () => 101 });
  expect(migrated.operationResult(original.operationId)?.receipt.operationId).toBe(original.operationId);
  migrated.close();
  const migratedDb = new Database(filename, { readonly: true });
  expect(migratedDb.query<{ conversation_id: string }, []>(
    "SELECT conversation_id FROM operations WHERE operation_id = 'op-missing-conversation'",
  ).get()?.conversation_id).toBe("");
  migratedDb.close();

  const reopened = new RuntimeJournal(filename, { maxEvents: 100, now: () => 102 });
  expect(reopened.operationResult(original.operationId)?.receipt.operationId).toBe(original.operationId);
  reopened.close();
});

test("runtime restart completes an interrupted operation table rename idempotently", () => {
  const dir = sandbox("operation-idempotency-interrupted-rename");
  const filename = path.join(dir, "events.sqlite");
  const command = {
    kind: "send" as const,
    operationId: "op-before-interrupted-rename",
    idempotencyKey: "composer-message-before-interrupted-rename",
    conversationId: "conversation-before-interrupted-rename",
    text: "survive the interrupted table rename",
    policy: "queue" as const,
  };
  const initial = new RuntimeJournal(filename, { maxEvents: 100, now: () => 100 });
  const original = initial.executeOperation(command);
  initial.close();

  const interrupted = new Database(filename);
  interrupted.exec("ALTER TABLE operations RENAME TO operations_global_idempotency");
  interrupted.close();

  const recovered = new RuntimeJournal(filename, { maxEvents: 100, now: () => 101 });
  expect(recovered.executeOperation(command)).toEqual({ ...original, replayed: true });
  recovered.close();
  const recoveredDb = new Database(filename, { readonly: true });
  expect(recoveredDb.query<{ count: number }, []>(
    "SELECT COUNT(*) AS count FROM operations WHERE operation_id = 'op-before-interrupted-rename'",
  ).get()?.count).toBe(1);
  expect(recoveredDb.query<{ count: number }, []>(
    "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'operations_global_idempotency'",
  ).get()?.count).toBe(0);
  recoveredDb.close();

  const reopened = new RuntimeJournal(filename, { maxEvents: 100, now: () => 102 });
  expect(reopened.executeOperation(command)).toEqual({ ...original, replayed: true });
  reopened.close();
});

test("structured send receipts advance through the durable delivery lifecycle", () => {
  const dir = sandbox("structured-delivery-lifecycle");
  const journal = new RuntimeJournal(path.join(dir, "events.sqlite"), {
    maxEvents: 100,
    now: () => 100,
    structuredHosts: true,
  });
  journal.append({
    scope: runtimeScope("session", "conv-one"),
    kind: "session-status",
    payload: {
      conversationId: "conv-one",
      sessionKey: { engine: "codex", sessionId: "thread-one" },
      hostKind: "codex-app-server",
      host: "hosted",
      turn: "idle",
      provenance: "structured",
      artifactPath: "/sessions/one.jsonl",
      capabilities: { steer: true, structuredAttention: true },
    },
  });

  const queued = journal.executeOperation({
    kind: "send",
    operationId: "op-lifecycle",
    idempotencyKey: "key-lifecycle",
    conversationId: "conv-one",
    text: "hello",
    policy: "queue",
  });
  expect(queued.receipt.status).toBe("queued");
  expect(journal.effectBatch()).toHaveLength(1);

  const delivering = journal.transitionOperation("op-lifecycle", "delivering");
  expect(delivering.receipt.status).toBe("delivering");
  expect(journal.effectBatch()).toHaveLength(1);

  const retryQueued = journal.transitionOperation("op-lifecycle", "queued", { reason: "dead-host" });
  expect(retryQueued.receipt).toMatchObject({ status: "queued", reason: "dead-host", revision: 3 });
  const retryDelivering = journal.transitionOperation("op-lifecycle", "delivering");
  expect(retryDelivering.receipt).toMatchObject({ status: "delivering", reason: null, revision: 4 });

  const delivered = journal.transitionOperation("op-lifecycle", "delivered", { turnId: "turn-one" });
  expect(delivered.receipt).toMatchObject({ status: "delivered", turnId: "turn-one", revision: 5 });
  expect(journal.effectBatch()).toEqual([]);
  expect(journal.snapshot().sessions[0]?.recentReceipts[0]).toMatchObject({ status: "delivered" });
  journal.close();
});

test("effectBatch omits an uncertain operation even when its outbox row remains pending", () => {
  const dir = sandbox("terminal-effect-filter");
  const filename = path.join(dir, "events.sqlite");
  const journal = new RuntimeJournal(filename, { structuredHosts: true });
  journal.append({
    scope: runtimeScope("session", "conv-terminal"),
    kind: "session-status",
    payload: {
      conversationId: "conv-terminal",
      sessionKey: { engine: "codex", sessionId: "thread-terminal" },
      hostKind: "codex-app-server",
      host: "hosted",
      turn: "idle",
      provenance: "structured",
    },
  });
  journal.executeOperation({
    kind: "send",
    operationId: "op-terminal",
    idempotencyKey: "key-terminal",
    conversationId: "conv-terminal",
    text: "settle once",
    policy: "queue",
  });
  const payload = journal.effectBatch()[0]!.payload;
  journal.transitionOperation("op-terminal", "uncertain", { reason: "delivery outcome is unverified" });
  journal.close();

  const database = new Database(filename);
  database.query("UPDATE outbox SET state = 'pending', payload_json = ? WHERE id = ?")
    .run(JSON.stringify(payload), "effect:op-terminal");
  database.close();

  const reopened = new RuntimeJournal(filename, { structuredHosts: true });
  expect(reopened.effectBatch()).toEqual([]);
  reopened.close();
});

test("a terminal structured send retries from its full journaled request", () => {
  const dir = sandbox("structured-delivery-retry");
  const journal = new RuntimeJournal(path.join(dir, "events.sqlite"), { structuredHosts: true });
  journal.append({
    scope: runtimeScope("session", "conv-retry"),
    kind: "session-status",
    payload: {
      conversationId: "conv-retry",
      sessionKey: { engine: "codex", sessionId: "thread-retry" },
      hostKind: "codex-app-server",
      host: "hosted",
      turn: "idle",
      provenance: "structured",
      capabilities: { steer: true, structuredAttention: true },
    },
  });
  const text = "retry the complete payload ".repeat(20);
  journal.executeOperation({
    kind: "send",
    operationId: "op-retry-failed",
    idempotencyKey: "key-retry-failed",
    conversationId: "conv-retry",
    text,
    policy: "queue",
  });
  journal.transitionOperation("op-retry-failed", "delivering");
  journal.transitionOperation("op-retry-failed", "failed", { reason: "engine write failed" });
  expect(journal.effectBatch()).toEqual([]);

  const retried = journal.retryOperation("op-retry-failed");

  expect(retried.receipt).toMatchObject({ status: "queued", reason: null, revision: 4 });
  expect(journal.effectBatch()).toEqual([
    expect.objectContaining({
      id: "effect:op-retry-failed",
      kind: "runtime.send",
      payload: expect.objectContaining({ operationId: "op-retry-failed", text }),
    }),
  ]);
  journal.close();
});

test("an explicit uncertain retry re-arms the same durable operation once (#1226)", () => {
  const dir = sandbox("structured-delivery-uncertain-retry");
  const journal = new RuntimeJournal(path.join(dir, "events.sqlite"), { structuredHosts: true });
  journal.append({
    scope: runtimeScope("session", "conv-uncertain-retry"),
    kind: "session-status",
    payload: {
      conversationId: "conv-uncertain-retry",
      sessionKey: { engine: "codex", sessionId: "thread-uncertain-retry" },
      hostKind: "codex-app-server",
      host: "hosted",
      turn: "idle",
      provenance: "structured",
      capabilities: { steer: true, structuredAttention: true },
    },
  });
  journal.executeOperation({
    kind: "send",
    operationId: "op-uncertain-retry",
    idempotencyKey: "key-uncertain-retry",
    conversationId: "conv-uncertain-retry",
    text: "deliver under one identity",
    policy: "queue",
  });
  journal.transitionOperation("op-uncertain-retry", "delivering");
  journal.transitionOperation("op-uncertain-retry", "uncertain", { reason: "confirmation timed out" });

  const retried = journal.retryOperation("op-uncertain-retry");
  const replayed = journal.retryOperation("op-uncertain-retry");
  expect(retried).toMatchObject({
    operationId: "op-uncertain-retry",
    replayed: false,
    receipt: { operationId: "op-uncertain-retry", idempotencyKey: "key-uncertain-retry", status: "queued" },
  });
  expect(replayed).toMatchObject({ operationId: "op-uncertain-retry", replayed: true });
  expect(journal.effectBatch()).toEqual([
    expect.objectContaining({
      id: "effect:op-uncertain-retry",
      payload: expect.objectContaining({ operationId: "op-uncertain-retry", idempotencyKey: "key-uncertain-retry" }),
    }),
  ]);
  journal.close();
});

test("a discard fence cannot overwrite a hand-over that began after its read (#1226)", () => {
  const dir = sandbox("structured-delivery-discard-fence");
  const journal = new RuntimeJournal(path.join(dir, "events.sqlite"), { structuredHosts: true });
  journal.append({
    scope: runtimeScope("session", "conv-discard-fence"),
    kind: "session-status",
    payload: {
      conversationId: "conv-discard-fence",
      sessionKey: { engine: "codex", sessionId: "thread-discard-fence" },
      hostKind: "codex-app-server",
      host: "hosted",
      turn: "idle",
      provenance: "structured",
      capabilities: { steer: true, structuredAttention: true },
    },
  });
  journal.executeOperation({
    kind: "send",
    operationId: "op-discard-fence",
    idempotencyKey: "key-discard-fence",
    conversationId: "conv-discard-fence",
    text: "do not retire a live hand-over",
    policy: "queue",
  });
  journal.transitionOperation("op-discard-fence", "delivering");

  expect(() => journal.transitionOperation(
    "op-discard-fence",
    "failed",
    { reason: "delivery-discarded" },
    { fromStatuses: ["pending", "queued"] },
  )).toThrow("runtime operation moved before its transition");
  expect(journal.operationResult("op-discard-fence")?.receipt.status).toBe("delivering");
  expect(journal.effectBatch()).toHaveLength(1);
  journal.close();
});

test("a discarded send cannot be re-armed under either retry mode (#1226)", () => {
  const dir = sandbox("structured-delivery-discard-absorbing");
  const journal = new RuntimeJournal(path.join(dir, "events.sqlite"), { structuredHosts: true });
  journal.append({
    scope: runtimeScope("session", "conv-discard-absorbing"),
    kind: "session-status",
    payload: {
      conversationId: "conv-discard-absorbing",
      sessionKey: { engine: "codex", sessionId: "thread-discard-absorbing" },
      hostKind: "codex-app-server",
      host: "hosted",
      turn: "idle",
      provenance: "structured",
      capabilities: { steer: true, structuredAttention: true },
    },
  });
  journal.executeOperation({
    kind: "send",
    operationId: "op-discard-absorbing",
    idempotencyKey: "key-discard-absorbing",
    conversationId: "conv-discard-absorbing",
    text: "discard permanently",
    policy: "queue",
  });
  journal.transitionOperation(
    "op-discard-absorbing",
    "failed",
    { reason: "delivery-discarded" },
    { fromStatuses: ["pending", "queued"] },
  );

  expect(() => journal.retryOperation("op-discard-absorbing"))
    .toThrow("discarded runtime operations cannot retry");
  expect(() => journal.retryOperation("op-discard-absorbing", "fresh-after-discard"))
    .toThrow("discarded runtime operations cannot retry");
  expect(journal.effectBatch()).toEqual([]);
  journal.close();
});

test("terminal delivery retry on a replacement host mints one fresh operation", () => {
  const dir = sandbox("fresh-terminal-retry");
  const journal = new RuntimeJournal(path.join(dir, "events.sqlite"), { structuredHosts: true });
  const projectHost = (sessionId: string, host: "hosted" | "dead") => journal.append({
    scope: runtimeScope("session", "conv-fresh-retry"),
    kind: "session-status",
    payload: {
      conversationId: "conv-fresh-retry",
      sessionKey: { engine: "codex", sessionId },
      hostKind: "codex-app-server",
      host,
      turn: host === "hosted" ? "idle" : "unknown",
      provenance: "structured",
      capabilities: { steer: true, structuredAttention: true },
    },
  });
  projectHost("thread-before", "hosted");
  const text = "preserve the complete message across replacement";
  journal.executeOperation({
    kind: "send",
    operationId: "op-before-replacement",
    idempotencyKey: "key-before-replacement",
    conversationId: "conv-fresh-retry",
    text,
    policy: "queue",
  });
  journal.transitionOperation("op-before-replacement", "delivering");
  journal.transitionOperation("op-before-replacement", "failed", { reason: "dead-host" });
  projectHost("thread-before", "dead");
  projectHost("thread-after", "hosted");

  const retried = journal.retryOperation("op-before-replacement", "key-after-replacement");
  const replayed = journal.retryOperation("op-before-replacement", "key-after-replacement");
  const replayedAfterAnotherClick = journal.retryOperation("op-before-replacement", "key-after-reload");

  expect(retried.operationId).not.toBe("op-before-replacement");
  expect(retried.receipt).toMatchObject({
    idempotencyKey: "key-after-replacement",
    status: "queued",
    retryOfOperationId: "op-before-replacement",
  });
  expect(replayed).toMatchObject({
    operationId: retried.operationId,
    replayed: true,
  });
  expect(replayedAfterAnotherClick).toMatchObject({
    operationId: retried.operationId,
    replayed: true,
    receipt: { idempotencyKey: "key-after-replacement" },
  });
  expect(journal.operationResult("op-before-replacement")?.receipt).toMatchObject({
    idempotencyKey: "key-before-replacement",
    status: "failed",
  });
  expect(journal.effectBatch()).toEqual([
    expect.objectContaining({
      id: `effect:${retried.operationId}`,
      kind: "runtime.send",
      payload: expect.objectContaining({
        operationId: retried.operationId,
        idempotencyKey: "key-after-replacement",
        text,
      }),
    }),
  ]);
  journal.transitionOperation(retried.operationId, "delivering");
  const delivered = journal.transitionOperation(retried.operationId, "delivered", { turnId: "turn-after" });
  expect(delivered.receipt).toMatchObject({
    status: "delivered",
    retryOfOperationId: "op-before-replacement",
  });
  journal.close();

  const reopened = new RuntimeJournal(path.join(dir, "events.sqlite"), { structuredHosts: true });
  expect(reopened.operationResult(retried.operationId)?.receipt).toMatchObject({
    status: "delivered",
    retryOfOperationId: "op-before-replacement",
  });
  expect(reopened.operationResult("op-before-replacement")?.receipt.status).toBe("failed");
  reopened.close();
});

test("terminal retry admits no replacement when recovered host ownership is lost", () => {
  const dir = sandbox("terminal-retry-host-loss");
  const journal = new RuntimeJournal(path.join(dir, "runtime.sqlite"), { structuredHosts: true });
  const projectHost = (host: "hosted" | "dead") => journal.append({
    scope: runtimeScope("session", "conv-retry-host-loss"),
    kind: "session-status",
    payload: {
      conversationId: "conv-retry-host-loss",
      sessionKey: { engine: "codex", sessionId: `thread-${host}` },
      hostKind: "codex-app-server",
      host,
      turn: host === "hosted" ? "idle" : "unknown",
      provenance: "structured",
      capabilities: { steer: true, structuredAttention: true },
    },
  });
  projectHost("hosted");
  const original = journal.executeOperation({
    kind: "send",
    operationId: "op-retry-host-loss-original",
    idempotencyKey: "key-retry-host-loss-original",
    conversationId: "conv-retry-host-loss",
    text: "deliver after stable recovery",
    policy: "queue",
  });
  journal.transitionOperation(original.operationId, "delivering");
  journal.transitionOperation(original.operationId, "failed", { reason: "dead-host" });
  projectHost("dead");

  expect(() => journal.retryOperation(
    original.operationId,
    "key-retry-host-loss-replacement",
    { requireHostedConversationId: "conv-retry-host-loss" },
  )).toThrow("structured recovery ownership changed before retry admission");
  expect(journal.snapshot().recentOperations).toEqual([
    expect.objectContaining({ operationId: original.operationId, status: "failed" }),
  ]);
  expect(journal.effectBatch()).toEqual([]);

  projectHost("hosted");
  const replacement = journal.retryOperation(
    original.operationId,
    "key-retry-host-loss-replacement",
    { requireHostedConversationId: "conv-retry-host-loss" },
  );
  expect(replacement.receipt).toMatchObject({
    status: "queued",
    retryOfOperationId: original.operationId,
  });
  expect(journal.effectBatch()).toEqual([
    expect.objectContaining({
      id: `effect:${replacement.operationId}`,
      payload: expect.objectContaining({ text: "deliver after stable recovery" }),
    }),
  ]);
  journal.close();
});

test("a rejected dead-host retry replays after its replacement starts delivery", () => {
  const dir = sandbox("rejected-retry-in-flight-replay");
  const journal = new RuntimeJournal(path.join(dir, "events.sqlite"), { structuredHosts: true });
  const projectHost = (host: "hosted" | "dead") => journal.append({
    scope: runtimeScope("session", "conv-rejected-replay"),
    kind: "session-status",
    payload: {
      conversationId: "conv-rejected-replay",
      sessionKey: { engine: "claude", sessionId: "thread-rejected-replay" },
      hostKind: "claude-broker",
      host,
      turn: host === "hosted" ? "idle" : "unknown",
      provenance: "structured",
      capabilities: { steer: false, structuredAttention: true },
    },
  });
  projectHost("dead");
  const original = journal.executeOperation({
    kind: "send",
    operationId: "op-rejected-replay-original",
    idempotencyKey: "key-rejected-replay-original",
    conversationId: "conv-rejected-replay",
    text: "deliver once after recovery",
    policy: "queue",
  });
  expect(original.receipt).toMatchObject({ status: "rejected", reason: "dead-host" });
  projectHost("hosted");

  const replacement = journal.retryOperation(
    original.operationId,
    "key-rejected-replay-replacement",
  );
  journal.transitionOperation(replacement.operationId, "delivering", { turnId: null });
  const replayed = journal.retryOperation(
    original.operationId,
    "key-rejected-replay-network-retry",
  );

  expect(replayed).toMatchObject({
    operationId: replacement.operationId,
    replayed: true,
    receipt: { status: "delivering", retryOfOperationId: original.operationId },
  });
  expect(journal.effectBatch()).toHaveLength(1);
  journal.close();
});

test("a terminal steer retry creates one deterministic replacement effect", () => {
  const dir = sandbox("terminal-steer-retry");
  const journal = new RuntimeJournal(path.join(dir, "events.sqlite"), { structuredHosts: true });
  journal.append({
    scope: runtimeScope("session", "conv-steer-retry"),
    kind: "session-status",
    payload: {
      conversationId: "conv-steer-retry",
      sessionKey: { engine: "codex", sessionId: "thread-steer-retry" },
      hostKind: "codex-app-server",
      host: "hosted",
      turn: "running",
      activeTurnId: "turn-steer-retry",
      provenance: "structured",
      capabilities: { steer: true, structuredAttention: true },
    },
  });
  const original = journal.executeOperation({
    kind: "steer",
    operationId: "op-steer-retry-original",
    idempotencyKey: "key-steer-retry-original",
    conversationId: "conv-steer-retry",
    text: "amend the active turn once",
    turnId: "turn-steer-retry",
  });
  journal.transitionOperation(original.operationId, "delivering", { turnId: "turn-steer-retry" });
  journal.transitionOperation(original.operationId, "failed", { reason: "dead-host" });

  const replacement = journal.retryOperation(original.operationId, "key-steer-retry-replacement");
  const replayed = journal.retryOperation(original.operationId, "key-steer-retry-network-replay");

  expect(replacement.receipt).toMatchObject({
    kind: "steer",
    status: "pending",
    turnId: "turn-steer-retry",
    retryOfOperationId: original.operationId,
  });
  expect(replayed).toMatchObject({ operationId: replacement.operationId, replayed: true });
  expect(journal.effectBatch()).toEqual([
    expect.objectContaining({
      id: `effect:${replacement.operationId}`,
      kind: "runtime.steer",
      payload: expect.objectContaining({
        operationId: replacement.operationId,
        text: "amend the active turn once",
        turnId: "turn-steer-retry",
      }),
    }),
  ]);
  journal.close();
});

test("a failed replacement retries from the current attempt and keeps one pending effect", () => {
  const dir = sandbox("replacement-retry-chain");
  const journal = new RuntimeJournal(path.join(dir, "events.sqlite"), { structuredHosts: true });
  journal.append({
    scope: runtimeScope("session", "conv-retry-chain"),
    kind: "session-status",
    payload: {
      conversationId: "conv-retry-chain",
      sessionKey: { engine: "codex", sessionId: "thread-chain" },
      hostKind: "codex-app-server",
      host: "hosted",
      turn: "idle",
      provenance: "structured",
      capabilities: { steer: true, structuredAttention: true },
    },
  });
  journal.executeOperation({
    kind: "send",
    operationId: "op-chain-original",
    idempotencyKey: "key-chain-original",
    conversationId: "conv-retry-chain",
    text: "deliver once across generations",
    policy: "queue",
  });
  journal.transitionOperation("op-chain-original", "delivering");
  journal.transitionOperation("op-chain-original", "failed", { reason: "dead-host" });
  const replacement = journal.retryOperation("op-chain-original", "key-chain-replacement");
  journal.transitionOperation(replacement.operationId, "delivering");
  journal.transitionOperation(replacement.operationId, "failed", { reason: "dead-host" });

  const current = journal.retryOperation(replacement.operationId, "key-chain-current");
  const repeated = journal.retryOperation(replacement.operationId, "key-chain-another-click");

  expect(current.receipt).toMatchObject({
    status: "queued",
    retryOfOperationId: replacement.operationId,
  });
  expect(repeated).toMatchObject({ operationId: current.operationId, replayed: true });
  expect(journal.effectBatch()).toEqual([
    expect.objectContaining({
      id: `effect:${current.operationId}`,
      payload: expect.objectContaining({ text: "deliver once across generations" }),
    }),
  ]);
  journal.close();
});

test("retry chains expose only the current leaf while retaining every durable attempt", () => {
  const dir = sandbox("visible-retry-leaf");
  const journal = new RuntimeJournal(path.join(dir, "events.sqlite"), { structuredHosts: true });
  journal.append({
    scope: runtimeScope("session", "conv-visible-retry"),
    kind: "session-status",
    payload: {
      conversationId: "conv-visible-retry",
      sessionKey: { engine: "codex", sessionId: "thread-visible-retry" },
      hostKind: "codex-app-server", host: "hosted", turn: "idle", provenance: "structured",
      capabilities: { steer: true, structuredAttention: true },
    },
  });
  const original = journal.executeOperation({ kind: "send", operationId: "op-visible-original", idempotencyKey: "visible-original", conversationId: "conv-visible-retry", text: "one", policy: "queue" });
  journal.transitionOperation(original.operationId, "failed", { reason: "dead-host" });
  const replacement = journal.retryOperation(original.operationId, "visible-replacement");
  journal.transitionOperation(replacement.operationId, "failed", { reason: "dead-host" });
  const leaf = journal.retryOperation(replacement.operationId, "visible-leaf");
  journal.transitionOperation(leaf.operationId, "delivered");

  expect(journal.snapshot().sessions[0]?.recentReceipts).toEqual([
    expect.objectContaining({ operationId: original.operationId, status: "delivered" }),
  ]);
  expect(journal.operationResult(original.operationId)?.receipt.status).toBe("failed");
  expect(journal.operationResult(replacement.operationId)?.receipt.status).toBe("failed");
  expect(journal.replay(0).events.filter((event) => event.kind === "receipt").length).toBeGreaterThanOrEqual(6);
  journal.close();
});

test("production reducers expose one current retry leaf across immediate, SSE, and snapshot projections", () => {
  const dir = sandbox("retry-projection-contract");
  const journal = new RuntimeJournal(path.join(dir, "events.sqlite"), { structuredHosts: true });
  journal.append({
    scope: runtimeScope("session", "conv-retry-projection"),
    kind: "session-status",
    payload: {
      conversationId: "conv-retry-projection",
      sessionKey: { engine: "codex", sessionId: "thread-retry-projection" },
      hostKind: "codex-app-server",
      host: "hosted",
      turn: "idle",
      provenance: "structured",
      capabilities: { steer: true, structuredAttention: true },
    },
  });
  const original = journal.executeOperation({
    kind: "send",
    operationId: "op-retry-projection-original",
    idempotencyKey: "key-retry-projection-original",
    conversationId: "conv-retry-projection",
    text: "show one retry leaf",
    policy: "queue",
  });
  journal.transitionOperation(original.operationId, "delivering");
  journal.transitionOperation(original.operationId, "failed", { reason: "dead-host" });
  const beforeRetry = journal.snapshot();
  const replacement = journal.retryOperation(original.operationId, "key-retry-projection-replacement");

  const immediate = mergeRuntimeReceipts(
    beforeRetry.sessions[0]?.recentReceipts ?? [],
    [runtimePresentationReceipt(replacement.receipt)],
  );
  expect(immediate).toEqual([
    expect.objectContaining({ status: "queued", retryOfOperationId: original.operationId }),
  ]);

  let streamed = installSnapshot(beforeRetry);
  for (const event of journal.replay(beforeRetry.snapshotSeq).events) {
    const applied = applyEvent(streamed, event);
    expect(applied.outcome).toBe("applied");
    if (applied.outcome === "applied") streamed = applied.store;
  }
  expect(streamed.sessions["conv-retry-projection"]?.recentReceipts).toEqual([
    expect.objectContaining({ status: "queued", retryOfOperationId: original.operationId }),
  ]);

  journal.transitionOperation(replacement.operationId, "delivering");
  journal.transitionOperation(replacement.operationId, "failed", { reason: "dead-host" });
  const beforeRequeue = journal.snapshot();
  journal.retryOperation(replacement.operationId);
  let requeued = installSnapshot(beforeRequeue);
  for (const event of journal.replay(beforeRequeue.snapshotSeq).events) {
    const applied = applyEvent(requeued, event);
    expect(applied.outcome).toBe("applied");
    if (applied.outcome === "applied") requeued = applied.store;
  }
  expect(requeued.sessions["conv-retry-projection"]?.recentReceipts).toEqual([
    expect.objectContaining({ status: "queued", retryOfOperationId: original.operationId }),
  ]);
  journal.transitionOperation(replacement.operationId, "delivering");
  journal.transitionOperation(replacement.operationId, "failed", { reason: "dead-host" });
  const leaf = journal.retryOperation(replacement.operationId, "key-retry-projection-leaf");
  expect(journal.currentRetryResult(original.operationId)?.operationId).toBe(leaf.operationId);
  journal.transitionOperation(leaf.operationId, "delivering");
  journal.transitionOperation(leaf.operationId, "delivered");
  const reloaded = installSnapshot(journal.snapshot());
  expect(reloaded.sessions["conv-retry-projection"]?.recentReceipts).toEqual([
    expect.objectContaining({ status: "delivered", retryOfOperationId: replacement.operationId }),
  ]);
  expect(reloaded.sessions["conv-retry-projection"]?.recentReceipts.filter((receipt) => receipt.status === "failed")).toEqual([]);
  expect(journal.operationResult(original.operationId)?.receipt.status).toBe("failed");
  expect(journal.operationResult(replacement.operationId)?.receipt.status).toBe("failed");
  journal.close();
});

test("filtered effect batches skip a full page of unrelated pending work", () => {
  const dir = sandbox("filtered-effect-batch");
  const journal = new RuntimeJournal(path.join(dir, "events.sqlite"), { structuredHosts: true });
  for (let index = 0; index < 100; index += 1) {
    journal.append({
      scope: runtimeScope("operation", `spawn-${index}`),
      kind: "receipt",
      payload: { operationId: `spawn-${index}` },
      effect: { id: `effect:spawn-${index}`, kind: "runtime.spawn", payload: { operationId: `spawn-${index}` } },
    });
  }
  journal.append({
    scope: runtimeScope("operation", "send-after-spawns"),
    kind: "receipt",
    payload: { operationId: "send-after-spawns" },
    effect: {
      id: "effect:send-after-spawns",
      kind: "runtime.send",
      payload: { operationId: "send-after-spawns", conversationId: "conv-one", text: "deliver me" },
    },
  });

  expect(journal.effectBatch()).toHaveLength(100);
  expect(journal.effectBatch(100, ["runtime.send", "runtime.steer"])).toEqual([
    expect.objectContaining({ id: "effect:send-after-spawns", kind: "runtime.send" }),
  ]);
  journal.close();
});

test("a delivering transition persists its derived turn fence in the outbox", () => {
  const dir = sandbox("structured-delivery-fence");
  const journal = new RuntimeJournal(path.join(dir, "events.sqlite"), { structuredHosts: true });
  journal.append({
    scope: runtimeScope("session", "conv-fence"),
    kind: "session-status",
    payload: {
      conversationId: "conv-fence",
      sessionKey: { engine: "codex", sessionId: "thread-fence" },
      hostKind: "codex-app-server",
      host: "hosted",
      turn: "running",
      activeTurnId: "turn-old",
      provenance: "structured",
      capabilities: { steer: true, structuredAttention: true },
    },
  });
  journal.executeOperation({
    kind: "send",
    operationId: "op-fenced-send",
    idempotencyKey: "key-fenced-send",
    conversationId: "conv-fence",
    text: "amend",
    policy: "steer-if-active",
  });

  journal.transitionOperation("op-fenced-send", "delivering", { turnId: "turn-old" });

  expect(journal.effectBatch()).toEqual([
    expect.objectContaining({
      id: "effect:op-fenced-send",
      payload: expect.objectContaining({ turnId: "turn-old" }),
    }),
  ]);

  journal.transitionOperation("op-fenced-send", "failed", { reason: "engine write failed" });
  journal.retryOperation("op-fenced-send");

  expect(journal.effectBatch()).toEqual([
    expect.objectContaining({
      id: "effect:op-fenced-send",
      payload: expect.objectContaining({ turnId: "turn-old" }),
    }),
  ]);
  journal.close();
});

test("an engine-host resolution keyed only by `id` still retires the attention (#765)", () => {
  /* Engine-host projections historically carried the attention id as `id`
     rather than `attentionId`; the reducer fell back to the session scope id,
     matched no entity, and the question stayed open in every snapshot. */
  const dir = sandbox("attention-id-fallback");
  const journal = new RuntimeJournal(path.join(dir, "events.sqlite"), { maxEvents: 100, now: () => 100 });
  journal.append({
    scope: runtimeScope("session", "conv-one"),
    kind: "attention",
    payload: {
      id: "attention-one",
      conversationId: "conv-one",
      kind: "question",
      state: "open",
      unowned: false,
      createdAt: "2026-07-10T00:00:00.000Z",
      request: { question: { prompt: "Proceed?" } },
      turnId: "turn-one",
    },
  });
  journal.append({
    scope: runtimeScope("session", "conv-one"),
    kind: "attention-resolved",
    payload: { id: "attention-one", conversationId: "conv-one", state: "cancelled", resolution: "turn-ended" },
  });
  expect(journal.snapshot().attentions[0]?.state).toBe("cancelled");
  expect(journal.snapshot().sessions[0]?.attentionIds).toEqual([]);
  journal.close();
});

test("answer and interrupt operations update projected attention and turn axes", () => {
  const dir = sandbox("answer-interrupt");
  const filename = path.join(dir, "events.sqlite");
  const journal = new RuntimeJournal(filename, { maxEvents: 100, now: () => 100 });
  journal.append({
    scope: runtimeScope("session", "conv-one"),
    kind: "session-status",
    payload: {
      hostKind: "codex-app-server",
      host: "hosted",
      turn: "running",
      activeTurnId: "turn-one",
      capabilities: { steer: true, structuredAttention: true },
    },
  });
  journal.append({
    scope: runtimeScope("session", "conv-one"),
    kind: "attention",
    payload: {
      id: "attention-one",
      conversationId: "conv-one",
      kind: "question",
      state: "open",
      unowned: false,
      createdAt: "2026-07-10T00:00:00.000Z",
      request: { question: { prompt: "Proceed?" } },
      turnId: "turn-one",
    },
  });
  journal.executeOperation({
    kind: "answer",
    conversationId: "conv-one",
    operationId: "op-answer-one",
    idempotencyKey: "answer-one",
    attentionId: "attention-one",
    resolution: { option: "yes" },
  });
  journal.executeOperation({
    kind: "interrupt",
    conversationId: "conv-one",
    operationId: "op-interrupt-one",
    idempotencyKey: "interrupt-one",
    turnId: "turn-one",
  });
  const snapshot = journal.snapshot();
  expect(snapshot.attentions[0]?.state).toBe("resolving");
  expect(snapshot.sessions[0]?.attentionIds).toEqual(["attention-one"]);
  expect(snapshot.sessions[0]?.turn).toBe("interrupt_requested");
  const database = new Database(filename);
  const persisted = database.query<{ request_json: string; payload_json: string }, []>("SELECT request_json, payload_json FROM operations JOIN outbox ON outbox.id = 'effect:' || operations.operation_id WHERE operations.operation_id = 'op-answer-one'").get();
  database.close();
  expect(persisted?.request_json).not.toContain('"option":"yes"');
  expect(persisted?.payload_json).not.toContain('"option":"yes"');
  expect(journal.effectBatch().find((effect) => effect.id === "effect:op-answer-one")?.payload.resolution).toEqual({ option: "yes" });
  const answered = journal.completeOperation("op-answer-one", "answered", { turnId: "turn-one" });
  const completedAgain = journal.completeOperation("op-answer-one", "answered", { turnId: "turn-one" });
  expect(completedAgain).toEqual({ ...answered, replayed: true });
  expect(journal.snapshot().attentions[0]?.state).toBe("resolved");
  expect(journal.snapshot().sessions[0]?.attentionIds).toEqual([]);
  const terminalAnswer = journal.executeOperation({
    kind: "answer",
    conversationId: "conv-one",
    operationId: "op-answer-two",
    idempotencyKey: "answer-two",
    attentionId: "attention-one",
    resolution: { option: "yes" },
  });
  expect(terminalAnswer.receipt.status).toBe("answered");
  expect(journal.effectBatch().some((effect) => effect.id === "effect:op-answer-two")).toBe(false);
  const completedDatabase = new Database(filename);
  const completedPayload = completedDatabase.query<{ payload_json: string }, [string]>("SELECT payload_json FROM outbox WHERE id = ?").get("effect:op-answer-one");
  completedDatabase.close();
  expect(completedPayload?.payload_json).toBe("{}");
  journal.close();
});

test("recovering sessions reject new actuation", () => {
  const dir = sandbox("recovering-actuation");
  const journal = new RuntimeJournal(path.join(dir, "events.sqlite"), { maxEvents: 100, now: () => 100 });
  journal.append({
    scope: runtimeScope("session", "conv-one"),
    kind: "session-status",
    payload: {
      hostKind: "codex-app-server",
      host: "hosted",
      turn: "running",
      activeTurnId: "turn-one",
      capabilities: { steer: true, structuredAttention: true },
    },
  });
  journal.append({ scope: runtimeScope("session", "conv-one"), kind: "host.disconnected", payload: {} });
  const send = journal.executeOperation({
    kind: "send",
    conversationId: "conv-one",
    operationId: "op-send-recovering",
    idempotencyKey: "send-recovering",
    text: "continue",
  });
  const interrupt = journal.executeOperation({
    kind: "interrupt",
    conversationId: "conv-one",
    operationId: "op-interrupt-recovering",
    idempotencyKey: "interrupt-recovering",
    turnId: "turn-one",
  });
  expect(send.receipt).toMatchObject({ status: "rejected", reason: "no-claim" });
  expect(interrupt.receipt).toMatchObject({ status: "rejected", reason: "no-claim" });
  expect(journal.effectBatch()).toEqual([]);
  journal.close();
});

test("spawn acceptance creates the placeholder session and lineage edge atomically", () => {
  const dir = sandbox("spawn-lineage");
  const journal = new RuntimeJournal(path.join(dir, "events.sqlite"), { maxEvents: 100, now: () => 100 });
  const command = {
    kind: "spawn" as const,
    conversationId: "child-one",
    operationId: "op-spawn-one",
    idempotencyKey: "spawn-one",
    engine: "codex" as const,
    cwd: "/repo",
    "prompt": "Implement the task",
    accountId: "account-one",
    parentConversationId: "parent-one",
    sessionId: "thread-child-one",
  };
  journal.executeOperation(command);
  journal.executeOperation(command);
  const snapshot = journal.snapshot();
  expect(snapshot.sessions).toHaveLength(1);
  expect(snapshot.sessions[0]).toMatchObject({
    conversationId: "child-one",
    sessionKey: { engine: "codex", sessionId: "thread-child-one" },
    hostKind: "codex-app-server",
    host: "registering",
    parentConversationId: "parent-one",
    accountId: "account-one",
  });
  expect(snapshot.edges).toEqual([{
    id: "edge-op-spawn-one",
    kind: "viewer_spawn",
    parentConversationId: "parent-one",
    childConversationId: "child-one",
    createdByOperationId: "op-spawn-one",
    revision: 1,
    createdAt: "1970-01-01T00:00:00.100Z",
  }]);
  expect(journal.effectBatch()).toHaveLength(1);
  journal.close();
});

test("successor spawn preserves one canonical lineage edge and rejects self lineage", () => {
  const dir = sandbox("successor-lineage");
  const journal = new RuntimeJournal(path.join(dir, "events.sqlite"), { maxEvents: 100, now: () => 100 });
  const child = "child-one";
  const parent = "parent-one";
  for (const [operationId, parentConversationId] of [["op-spawn-one", parent], ["op-spawn-two", parent], ["op-spawn-self", child]] as const) {
    journal.executeOperation({
      kind: "spawn",
      conversationId: child,
      operationId,
      idempotencyKey: operationId,
      engine: "codex",
      cwd: "/repo",
      "prompt": "Resume the worker",
      accountId: "account-one",
      parentConversationId,
      sessionId: "thread-child-one",
    });
  }
  const snapshot = journal.snapshot();
  expect(snapshot.sessions).toEqual([expect.objectContaining({
    conversationId: child,
    parentConversationId: parent,
  })]);
  expect(snapshot.edges).toEqual([expect.objectContaining({
    parentConversationId: parent,
    childConversationId: child,
  })]);
  journal.close();
});

test("runtime host advances and publishes a flow from a terminal event without file polling", async () => {
  const dir = sandbox("flow-consumer");
  const journal = new RuntimeJournal(path.join(dir, "events.sqlite"), { maxEvents: 100, now: () => 100 });
  const calls: string[] = [];
  let progressSignals = 0;
  const host = new RuntimeHost(journal, {
    flowReady: (flowId, note) => {
      calls.push(`${flowId}:${note}`);
      return { id: flowId, state: "spawn_pending" } as unknown as Flow;
    },
    workflowStageCompleted: () => undefined,
    taskDeliveryAcknowledged: () => undefined,
  }, undefined, false, () => { progressSignals += 1; });
  await host.handle({
    id: "session-claim",
    method: "append",
    params: {
      event: {
        scope: runtimeScope("session", "implementer"),
        kind: "session-status",
        payload: {
          hostKind: "codex-app-server",
          host: "hosted",
          turn: "running",
          flowId: "flow-one",
          capabilities: { steer: true, structuredAttention: true },
        },
      },
    },
  });
  const response = await host.handle({
    id: "request-one",
    method: "append",
    params: {
      event: {
        scope: runtimeScope("session", "implementer"),
        kind: "turn.completed",
        producerKey: "terminal-flow-one",
        payload: { finalAssistantOutput: "REVIEW_READY: finished" },
      },
    },
  });
  await host.handle({
    id: "request-two",
    method: "append",
    params: {
      event: {
        scope: runtimeScope("session", "implementer"),
        kind: "turn.completed",
        producerKey: "terminal-flow-one",
        payload: { finalAssistantOutput: "REVIEW_READY: finished" },
      },
    },
  });
  expect(response.ok).toBe(true);
  expect(calls).toEqual(["flow-one:REVIEW_READY: finished"]);
  expect(progressSignals).toBe(1);
  expect(journal.snapshot().flows[0]).toMatchObject({ revision: 1, value: { id: "flow-one", state: "spawn_pending" } });
  journal.close();
});

test("a newly committed terminal event wakes promptly once while flow delivery is pending", async () => {
  const journal = new RuntimeJournal(path.join(sandbox("terminal-wake-before-consumer"), "events.sqlite"), { maxEvents: 100, now: () => 100 });
  let releaseFlowReady = () => {};
  let markFlowReadyStarted = () => {};
  const flowReadyStarted = new Promise<void>((resolve) => { markFlowReadyStarted = resolve; });
  const flowReadyGate = new Promise<void>((resolve) => { releaseFlowReady = resolve; });
  let progressSignals = 0;
  const host = new RuntimeHost(journal, {
    flowReady: async (flowId) => {
      markFlowReadyStarted();
      await flowReadyGate;
      return { id: flowId, state: "spawn_pending" } as unknown as Flow;
    },
    workflowStageCompleted: () => undefined,
    taskDeliveryAcknowledged: () => undefined,
  }, undefined, false, () => { progressSignals += 1; });
  const request = {
    method: "append" as const,
    params: {
      event: {
        scope: runtimeScope("session", "implementer"),
        kind: "turn.completed" as const,
        producerKey: "terminal-wake-before-consumer",
        payload: { flowId: "flow-one", readyNote: "REVIEW_READY: finished" },
      },
    },
  };

  const first = host.handle({ id: "request-one", ...request });
  await flowReadyStarted;
  const duplicate = host.handle({ id: "request-two", ...request });
  await Promise.resolve();
  const signalsWhilePending = progressSignals;
  releaseFlowReady();
  const responses = await Promise.all([first, duplicate]);

  expect(responses.every((response) => response.ok)).toBe(true);
  expect(signalsWhilePending).toBe(1);
  expect(progressSignals - signalsWhilePending).toBe(0);
  expect(progressSignals).toBe(1);
  journal.close();
});

test("a failed terminal wake keeps the committed runtime acknowledgement successful", async () => {
  const journal = new RuntimeJournal(path.join(sandbox("terminal-wake-failure"), "events.sqlite"), { maxEvents: 100, now: () => 100 });
  const host = new RuntimeHost(journal, undefined, undefined, false, () => {
    throw new Error("wake transport failed");
  });

  const response = await host.handle({
    id: "terminal-wake-request",
    method: "append",
    params: {
      event: {
        scope: runtimeScope("session", "worker"),
        kind: "turn.completed",
        producerKey: "terminal-wake-failure",
        payload: {},
      },
    },
  });

  expect(response.ok).toBe(true);
  expect(journal.replay(0).events).toHaveLength(1);
  journal.close();
});

test("runtime host retries an uncheckpointed consumer after a committed event", async () => {
  const dir = sandbox("consumer-retry");
  const journal = new RuntimeJournal(path.join(dir, "events.sqlite"), { maxEvents: 100, now: () => 100 });
  let attempts = 0;
  const host = new RuntimeHost(journal, {
    flowReady: (flowId) => {
      attempts += 1;
      if (attempts === 1) throw new Error("consumer interrupted");
      return { id: flowId, state: "spawn_pending" } as unknown as Flow;
    },
    workflowStageCompleted: () => undefined,
    taskDeliveryAcknowledged: () => undefined,
  });
  const request = {
    method: "append" as const,
    params: {
      event: {
        scope: runtimeScope("session", "implementer"),
        kind: "turn.completed",
        producerKey: "terminal-consumer-retry",
        payload: { flowId: "flow-one", readyNote: "REVIEW_READY: finished" },
      },
    },
  };
  // The event commit remains successful even when its asynchronous consumer
  // needs another pass; callers must never retry an already-committed append.
  expect((await host.handle({ id: "request-one", ...request })).ok).toBe(true);
  expect((await host.handle({ id: "request-two", ...request })).ok).toBe(true);
  expect((await host.handle({ id: "request-three", ...request })).ok).toBe(true);
  expect(attempts).toBe(2);
  expect(journal.snapshot().flows[0]).toMatchObject({ value: { id: "flow-one", state: "spawn_pending" } });
  journal.close();
});

test("runtime host quarantines a deterministic consumer failure without poisoning commands", async () => {
  const journal = new RuntimeJournal(path.join(sandbox("consumer-poison"), "events.sqlite"), { maxEvents: 100, now: () => 100 });
  let attempts = 0;
  const host = new RuntimeHost(journal, {
    flowReady: () => { attempts += 1; throw new Error("poison event"); },
    workflowStageCompleted: () => undefined,
    taskDeliveryAcknowledged: () => undefined,
  });
  const event = {
    scope: runtimeScope("session", "implementer"),
    kind: "turn.completed",
    producerKey: "terminal-consumer-poison",
    payload: { flowId: "flow-one", readyNote: "REVIEW_READY: poison" },
  };
  for (let index = 0; index < 4; index += 1) {
    expect((await host.handle({ id: `request-${index}`, method: "append", params: { event } })).ok).toBe(true);
  }
  expect(attempts).toBe(3);
  journal.close();
});

test("runtime host serializes concurrent duplicate consumer delivery", async () => {
  const dir = sandbox("consumer-concurrency");
  const journal = new RuntimeJournal(path.join(dir, "events.sqlite"), { maxEvents: 100, now: () => 100 });
  let calls = 0;
  let releaseConsumer!: () => void;
  let markStarted!: () => void;
  const consumerStarted = new Promise<void>((resolve) => { markStarted = resolve; });
  const consumerGate = new Promise<void>((resolve) => { releaseConsumer = resolve; });
  const host = new RuntimeHost(journal, {
    flowReady: async (flowId) => {
      calls += 1;
      markStarted();
      await consumerGate;
      return { id: flowId, state: "spawn_pending" } as unknown as Flow;
    },
    workflowStageCompleted: () => undefined,
    taskDeliveryAcknowledged: () => undefined,
  });
  const event = {
    scope: runtimeScope("session", "implementer"),
    kind: "turn.completed",
    producerKey: "terminal-concurrent",
    payload: { flowId: "flow-one", readyNote: "REVIEW_READY: finished" },
  };
  const first = host.handle({ id: "request-one", method: "append", params: { event } });
  await consumerStarted;
  const second = host.handle({ id: "request-two", method: "append", params: { event } });
  releaseConsumer();
  const responses = await Promise.all([first, second]);
  expect(responses.every((response) => response.ok)).toBe(true);
  expect(calls).toBe(1);
  expect(journal.snapshot().flows).toHaveLength(1);
  journal.close();
});

test("runtime command acknowledgements do not wait for a slow committed-event consumer", async () => {
  const dir = sandbox("command-ack");
  const journal = new RuntimeJournal(path.join(dir, "events.sqlite"), { maxEvents: 100, now: () => 100 });
  let releaseConsumer!: () => void;
  let markStarted!: () => void;
  let consumerHasStarted = false;
  const consumerStarted = new Promise<void>((resolve) => { markStarted = resolve; });
  const consumerGate = new Promise<void>((resolve) => { releaseConsumer = resolve; });
  const host = new RuntimeHost(journal, {
    flowReady: async () => {
      consumerHasStarted = true;
      markStarted();
      await consumerGate;
      return { id: "flow-one", state: "spawn_pending" } as unknown as Flow;
    },
    workflowStageCompleted: () => undefined,
    taskDeliveryAcknowledged: () => undefined,
  }, undefined, true);
  journal.append({
    scope: runtimeScope("session", "slow-consumer"),
    kind: "turn.completed",
    payload: { flowId: "flow-one", readyNote: "REVIEW_READY: slow" },
  });

  const response = host.handle({
    id: "command-request",
    method: "command",
    params: {
      command: {
        kind: "send",
        operationId: "op-command-ack",
        idempotencyKey: "command-ack",
        conversationId: "conversation-one",
        text: "continue",
      },
    },
  });
  expect((await response).ok).toBe(true);
  expect(consumerHasStarted).toBeFalse();
  await consumerStarted;

  releaseConsumer();
  await host.recoverConsumers();
  journal.close();
});

test("runtime host acknowledges a durable command while consumer recovery is slow", async () => {
  const dir = sandbox("command-consumer-latency");
  const journal = new RuntimeJournal(path.join(dir, "events.sqlite"), { maxEvents: 100, now: () => 100 });
  let releaseConsumer!: () => void;
  let markStarted!: () => void;
  const consumerStarted = new Promise<void>((resolve) => { markStarted = resolve; });
  const consumerGate = new Promise<void>((resolve) => { releaseConsumer = resolve; });
  const host = new RuntimeHost(journal, {
    flowReady: async (flowId) => {
      markStarted();
      await consumerGate;
      return { id: flowId, state: "spawn_pending" } as unknown as Flow;
    },
    workflowStageCompleted: () => undefined,
    taskDeliveryAcknowledged: () => undefined,
  });
  const pendingConsumerEvent = journal.append({
    scope: runtimeScope("session", "implementer"),
    kind: "turn.completed",
    producerKey: "terminal-before-command",
    payload: { flowId: "flow-one", readyNote: "REVIEW_READY: finished" },
  });

  const response = await Promise.race([
    host.handle({
      id: "spawn-command",
      method: "command",
      params: {
        command: {
          kind: "spawn",
          conversationId: "worker",
          operationId: "op-worker",
          idempotencyKey: "op-worker",
          engine: "claude",
          cwd: "/repo",
          "prompt": "work",
          accountId: "account-one",
          parentConversationId: null,
        },
      },
    }).then(() => "acknowledged"),
    Bun.sleep(50).then(() => "blocked"),
  ]);

  expect(response).toBe("acknowledged");
  await consumerStarted;
  releaseConsumer();
  await host.recoverConsumers();
  expect(journal.consumerCompleted(pendingConsumerEvent.eventId, "orchestration")).toBe(true);
  journal.close();
});

test("runtime host recovers committed consumer work after restart", async () => {
  const dir = sandbox("consumer-restart");
  const filename = path.join(dir, "events.sqlite");
  const journal = new RuntimeJournal(filename, { maxEvents: 100, now: () => 100 });
  journal.append({
    scope: runtimeScope("session", "implementer"),
    kind: "session-status",
    payload: {
      hostKind: "codex-app-server",
      host: "hosted",
      turn: "running",
      flowId: "flow-one",
      capabilities: { steer: true, structuredAttention: true },
    },
  });
  journal.append({
    scope: runtimeScope("session", "implementer"),
    kind: "turn.completed",
    producerKey: "terminal-before-restart",
    payload: { finalAssistantOutput: "REVIEW_READY: recovered" },
  });
  journal.close();

  const reopened = new RuntimeJournal(filename, { maxEvents: 100, now: () => 200 });
  const calls: string[] = [];
  const host = new RuntimeHost(reopened, {
    flowReady: (flowId, note) => {
      calls.push(`${flowId}:${note}`);
      return { id: flowId, state: "spawn_pending" } as unknown as Flow;
    },
    workflowStageCompleted: () => undefined,
    taskDeliveryAcknowledged: () => undefined,
  });
  expect(await host.recoverConsumers()).toBe(2);
  expect(await host.recoverConsumers()).toBe(0);
  expect(calls).toEqual(["flow-one:REVIEW_READY: recovered"]);
  expect(reopened.snapshot().flows[0]).toMatchObject({ value: { id: "flow-one", state: "spawn_pending" } });
  reopened.close();
});

test("journal waiters wake on the next committed event", async () => {
  const dir = sandbox("waiter");
  const journal = new RuntimeJournal(path.join(dir, "events.sqlite"), { maxEvents: 100, now: () => 100 });
  const waiting = journal.waitForEvents(0, 1_000);
  journal.append({ scope: runtimeScope("system", "runtime"), kind: "files.revision", payload: { filesRevision: 1 } });
  const replay = await waiting;
  expect(replay.reset).toBe(false);
  expect(replay.events.map((event) => event.seq)).toEqual([1]);
  journal.close();
});

test("runtime host epochs advance durably across host claims", () => {
  const dir = sandbox("host-epoch");
  const filename = path.join(dir, "events.sqlite");
  const journal = new RuntimeJournal(filename, { maxEvents: 100, now: () => 100 });
  expect(journal.claimHostEpoch()).toBe(2);
  expect(journal.snapshot().runtime).toEqual({ hostEpoch: 2, health: "ready" });
  journal.close();
  const reopened = new RuntimeJournal(filename, { maxEvents: 100, now: () => 100 });
  expect(reopened.claimHostEpoch()).toBe(3);
  reopened.close();
});

test("replay batches stay within the SSE backpressure byte ceiling", () => {
  const dir = sandbox("backpressure");
  const journal = new RuntimeJournal(path.join(dir, "events.sqlite"), { maxEvents: 100, now: () => 100 });
  for (let index = 0; index < 50; index += 1) {
    journal.append({
      scope: runtimeScope("system", "load"),
      kind: "limits",
      payload: { index, data: "x".repeat(8_000) },
      producerKey: `load:${index}`,
    });
  }
  const first = journal.replay(0, 128);
  expect(Buffer.byteLength(JSON.stringify(first.events))).toBeLessThanOrEqual(256 * 1024);
  expect(first.events.length).toBeLessThan(50);
  const second = journal.replay(first.events.at(-1)!.seq, 128);
  expect(second.events[0]?.seq).toBe(first.events.at(-1)!.seq + 1);
  journal.close();
});

test("journal compaction emits a deterministic retention reset and leaves an anchor-verified tail", () => {
  const dir = sandbox("compact");
  const filename = path.join(dir, "events.sqlite");
  const journal = new RuntimeJournal(filename, { maxEvents: 2, now: () => 100 });
  const first = journal.append({ scope: runtimeScope("session", "one"), kind: "item.completed", payload: { i: 0 }, producerKey: "compact-dedupe" });
  for (let i = 1; i < 4; i += 1) journal.append({ scope: runtimeScope("session", "one"), kind: "item.completed", payload: { i } });
  expect(journal.replay(0)).toEqual({ reset: true, floorSeq: 2, events: [] });
  expect(journal.replay(999)).toEqual({ reset: true, floorSeq: 2, events: [] });
  expect(journal.replay(2).events.map((event) => event.seq)).toEqual([3, 4]);
  expect(journal.append({ scope: runtimeScope("session", "one"), kind: "item.completed", payload: { i: 0 }, producerKey: "compact-dedupe" }).eventId).toBe(first.eventId);
  journal.close();
  const reopened = new RuntimeJournal(filename, { maxEvents: 2 });
  expect(reopened.replay(2).events).toHaveLength(2);
  reopened.close();
});

test("restart reconstructs identical sessions, receipts, flow state, and graph", () => {
  const dir = sandbox("restart-equivalence");
  const filename = path.join(dir, "events.sqlite");
  const command = {
    kind: "spawn" as const,
    conversationId: "child-one",
    operationId: "op-spawn-one",
    idempotencyKey: "spawn-one",
    engine: "codex" as const,
    cwd: "/repo",
    "prompt": "Implement",
    parentConversationId: "parent-one",
  };
  const journal = new RuntimeJournal(filename, { maxEvents: 100, now: () => 100 });
  journal.executeOperation(command);
  journal.append({
    scope: runtimeScope("flow", "flow-one"),
    kind: "flow.state",
    payload: { id: "flow-one", state: "approved" },
    producerKey: "flow-one-approved",
  });
  const before = journal.snapshot();
  journal.close();

  const reopened = new RuntimeJournal(filename, { maxEvents: 100, now: () => 100 });
  expect(reopened.snapshot()).toEqual(before);
  expect(reopened.executeOperation(command).receipt).toEqual(before.recentOperations[0]);
  reopened.close();
});

test("rejected appends leave sequence, scope revisions, and projections unchanged", () => {
  const dir = sandbox("partial-write");
  const journal = new RuntimeJournal(path.join(dir, "events.sqlite"), { maxEvents: 100, now: () => 100 });
  journal.append({ scope: runtimeScope("system", "runtime"), kind: "files.revision", payload: { filesRevision: 1 } });
  const before = journal.snapshot();
  expect(() => journal.append({
    scope: runtimeScope("system", "runtime"),
    kind: "limits",
    payload: { oversized: "x".repeat(17 * 1024) },
  })).toThrow("runtime event payload exceeds 16 KiB");
  expect(() => journal.append({
    scope: runtimeScope("system", "runtime"),
    kind: "limits",
    payload: "invalid" as unknown as Record<string, unknown>,
  })).toThrow("runtime event payload is invalid");
  expect(() => journal.append({
    scope: { type: "invalid", id: "runtime" } as never,
    kind: "limits",
    payload: {},
  })).toThrow("runtime scope type is invalid");
  expect(journal.snapshot()).toEqual(before);
  journal.close();
});

test("journal detects a modified hash chain and fails closed", () => {
  const dir = sandbox("fault");
  const filename = path.join(dir, "events.sqlite");
  const journal = new RuntimeJournal(filename);
  journal.append({ scope: runtimeScope("session", "one"), kind: "turn.started", payload: {} });
  journal.close();
  const database = new Database(filename);
  database.exec("UPDATE events SET producer_kind = 'tampered' WHERE seq = 1");
  database.close();
  const corrupted = new RuntimeJournal(filename);
  expect(corrupted.snapshot().runtime.health).toBe("read_only_fault");
  expect(() => corrupted.append({ scope: runtimeScope("session", "one"), kind: "turn.completed", payload: {} })).toThrow(RuntimeJournalFault);
  corrupted.close();
});

test("Unix socket host isolates a singleton writer and serves a fake Viewer client", async () => {
  const dir = sandbox("socket");
  const socketPath = path.join(dir, "runtime.sock");
  const fence = new RuntimeHostFence(`${socketPath}.lock`);
  fence.acquire();
  expect(() => new RuntimeHostFence(`${socketPath}.lock`).acquire()).toThrow("singleton fence");
  // Legacy receipt shape over the socket; the structured path has its own cases.
  const journal = new RuntimeJournal(path.join(dir, "events.sqlite"), { structuredHosts: false });
  const server = serveRuntimeHost(socketPath, new RuntimeHost(journal));
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const client = new UnixRuntimeHostClient(socketPath);
  await client.append({
    scope: runtimeScope("session", "one"),
    kind: "session-status",
    payload: {
      hostKind: "codex-app-server",
      host: "hosted",
      turn: "running",
      capabilities: { steer: true, structuredAttention: true },
      activeTurnId: "turn-one",
    },
  });
  expect((await client.snapshot()).snapshotSeq).toBe(1);
  const operation = await client.command({
    kind: "send",
    conversationId: "one",
    operationId: "op-socket-one",
    idempotencyKey: "socket-send-one",
    text: "continue",
    policy: "steer-if-active",
  });
  expect(operation.receipt.status).toBe("pending");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  journal.close();
  fence.release();
});

test("runtime socket keeps command capacity beyond 64 concurrent SSE waits", async () => {
  const dir = sandbox("socket-command-capacity");
  const socketPath = path.join(dir, "runtime.sock");
  const journal = new RuntimeJournal(path.join(dir, "events.sqlite"));
  const server = serveRuntimeHost(socketPath, new RuntimeHost(journal));
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const waiters = Array.from({ length: 64 }, () => net.createConnection(socketPath));

  try {
    await Promise.all(waiters.map((socket, index) => new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.once("connect", () => {
        socket.write(`${JSON.stringify({
          id: `wait-${index}`,
          method: "wait",
          params: { after: 0, timeoutMs: 5_000 },
        })}\n`);
        resolve();
      });
    })));

    for (let attempt = 0; attempt < 100; attempt += 1) {
      const connections = await new Promise<number>((resolve, reject) => {
        server.getConnections((error, count) => error ? reject(error) : resolve(count));
      });
      if (connections >= waiters.length) break;
      await Bun.sleep(2);
    }

    const client = new UnixRuntimeHostClient(socketPath, 250);
    expect((await client.snapshot()).snapshotSeq).toBe(0);
  } finally {
    journal.append({ scope: runtimeScope("system", "runtime"), kind: "files.revision", payload: { filesRevision: 1 } });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const connections = await new Promise<number>((resolve, reject) => {
        server.getConnections((error, count) => error ? reject(error) : resolve(count));
      });
      if (connections === 0) break;
      await Bun.sleep(2);
    }
    for (const waiter of waiters) waiter.destroy();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    journal.close();
  }
});

test("runtime socket bounds waiters and reserves command capacity", async () => {
  const dir = sandbox("socket-bounded-waits");
  const socketPath = path.join(dir, "runtime.sock");
  const journal = new RuntimeJournal(path.join(dir, "events.sqlite"));
  const server = serveRuntimeHost(socketPath, new RuntimeHost(journal), {
    maxConnections: 4,
    maxWaitConnections: 2,
  });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const waiters: net.Socket[] = [];

  const openWait = async (id: string): Promise<net.Socket> => await new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ id, method: "wait", params: { after: 0, timeoutMs: 5_000 } })}\n`);
      waiters.push(socket);
      resolve(socket);
    });
  });

  try {
    await openWait("wait-one");
    await openWait("wait-two");
    await Bun.sleep(10);
    const rejected = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const socket = net.createConnection(socketPath);
      let response = "";
      socket.once("error", reject);
      socket.on("data", (chunk) => {
        response += String(chunk);
        const newline = response.indexOf("\n");
        if (newline >= 0) {
          socket.destroy();
          resolve(JSON.parse(response.slice(0, newline)) as Record<string, unknown>);
        }
      });
      socket.once("connect", () => {
        socket.write(`${JSON.stringify({ id: "wait-excess", method: "wait", params: { after: 0, timeoutMs: 5_000 } })}\n`);
      });
    });

    expect(rejected).toEqual({ id: "wait-excess", ok: false, error: "runtime wait capacity exceeded" });
    const client = new UnixRuntimeHostClient(socketPath, 250);
    expect((await client.snapshot()).snapshotSeq).toBe(0);

    for (const waiter of waiters) waiter.destroy();
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const connections = await new Promise<number>((resolve, reject) => {
        server.getConnections((error, count) => error ? reject(error) : resolve(count));
      });
      if (connections === 0) break;
      await Bun.sleep(2);
    }
    const replacement = net.createConnection(socketPath);
    const replacementResponse = new Promise<Record<string, unknown>>((resolve, reject) => {
      let response = "";
      replacement.once("error", reject);
      replacement.on("data", (chunk) => {
        response += String(chunk);
        const newline = response.indexOf("\n");
        if (newline >= 0) resolve(JSON.parse(response.slice(0, newline)) as Record<string, unknown>);
      });
      replacement.once("connect", () => {
        replacement.write(`${JSON.stringify({ id: "wait-replacement", method: "wait", params: { after: 0, timeoutMs: 5_000 } })}\n`);
      });
    });
    await Bun.sleep(10);
    journal.append({ scope: runtimeScope("system", "runtime"), kind: "files.revision", payload: { filesRevision: 1 } });
    expect(await replacementResponse).toMatchObject({ id: "wait-replacement", ok: true });
    replacement.destroy();
    expect(server.maxConnections).toBe(4);
  } finally {
    journal.append({ scope: runtimeScope("system", "runtime"), kind: "files.revision", payload: { filesRevision: 1 } });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const connections = await new Promise<number>((resolve, reject) => {
        server.getConnections((error, count) => error ? reject(error) : resolve(count));
      });
      if (connections === 0) break;
      await Bun.sleep(2);
    }
    for (const waiter of waiters) waiter.destroy();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    journal.close();
  }
});

test("concurrent socket replays keep maximum-size command output byte-bounded and advancing", async () => {
  const dir = sandbox("socket-replay-burst");
  const socketPath = path.join(dir, "runtime.sock");
  const journal = new RuntimeJournal(path.join(dir, "events.sqlite"), { maxEvents: 256 });
  for (let index = 0; index < 128; index += 1) {
    journal.append({
      scope: runtimeScope("session", "burst"),
      kind: "item",
      payload: { phase: "completed", commandOutput: "x".repeat(15_500), index },
    });
  }
  const server = serveRuntimeHost(socketPath, new RuntimeHost(journal));
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const client = new UnixRuntimeHostClient(socketPath);

  const concurrent = await Promise.all(Array.from({ length: 32 }, () => client.waitEvents(0, 1_000)));
  expect(concurrent.every((replay) => replay.reset === false && replay.events[0]?.seq === 1)).toBeTrue();
  expect(concurrent.every((replay) => Buffer.byteLength(JSON.stringify(replay.events)) <= 256 * 1024)).toBeTrue();

  let cursor = 0;
  let pages = 0;
  while (cursor < 128) {
    const replay = await client.waitEvents(cursor, 1_000);
    expect(replay.reset).toBeFalse();
    expect(replay.events.length).toBeGreaterThan(0);
    expect(replay.events[0]!.seq).toBe(cursor + 1);
    cursor = replay.events.at(-1)!.seq;
    pages += 1;
  }
  expect(cursor).toBe(128);
  expect(pages).toBeGreaterThan(1);

  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  journal.close();
});

test("a production-sized snapshot has a bounded read budget independent from controls", async () => {
  const dir = sandbox("socket-large-snapshot-budget");
  const socketPath = path.join(dir, "runtime.sock");
  const server = net.createServer((socket) => {
    let frame = "";
    socket.on("data", (chunk) => {
      frame += String(chunk);
      const newline = frame.indexOf("\n");
      if (newline < 0) return;
      const request = JSON.parse(frame.slice(0, newline)) as { id: string; method: string };
      setTimeout(() => {
        const result = request.method === "snapshot"
          ? { snapshotSeq: 1, transportPadding: "x".repeat(950 * 1024) }
          : { reset: false, floorSeq: 0, events: [] };
        socket.end(`${JSON.stringify({ id: request.id, ok: true, result })}\n`);
      }, 60);
    });
  });
  server.listen(socketPath);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const client = new UnixRuntimeHostClient(socketPath, 20, 100, 250);

  try {
    const snapshot = await client.snapshot() as unknown as { transportPadding: string };
    expect(Buffer.byteLength(snapshot.transportPadding)).toBe(950 * 1024);
    await expect(client.events(0)).rejects.toThrow("runtime host request timed out");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("structured queue controls cross the local runtime socket", async () => {
  const dir = sandbox("structured-socket");
  const socketPath = path.join(dir, "runtime.sock");
  const journal = new RuntimeJournal(path.join(dir, "events.sqlite"), { structuredHosts: true });
  journal.append({
    scope: runtimeScope("session", "one"),
    kind: "session-status",
    payload: {
      hostKind: "codex-app-server",
      host: "hosted",
      turn: "idle",
      capabilities: { steer: true, structuredAttention: true },
    },
  });
  const server = serveRuntimeHost(socketPath, new RuntimeHost(journal, undefined, undefined, true));
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const client = new UnixRuntimeHostClient(socketPath);
  await client.append({
    scope: runtimeScope("session", "one"),
    kind: "limits",
    payload: { conversationId: "one", snapshot: {} },
    producer: { kind: "codex-app-server", eventKey: "engine-host:codex:thread-one:7" },
  });
  expect(await client.producerCursor("codex-app-server", "engine-host:codex:thread-one:")).toBe(7);
  const operation = await client.command({
    kind: "send",
    conversationId: "one",
    operationId: "op-socket-queue",
    idempotencyKey: "socket-queue-key",
    text: "continue",
    policy: "queue",
  });

  expect(operation.receipt.status).toBe("queued");
  const initialEffects = await client.effectBatch();
  expect(initialEffects).toHaveLength(1);
  expect(await client.effectBatch(undefined, initialEffects[0]!.eventSeq)).toEqual([]);
  await expect(client.effectBatch(undefined, -1)).rejects.toThrow("runtime effect cursor is invalid");
  expect((await client.transitionOperation("op-socket-queue", "delivering")).receipt.status).toBe("delivering");
  await expect(client.transitionOperation(
    "op-socket-queue",
    "failed",
    { reason: "delivery-discarded" },
    { fromStatuses: ["pending", "queued"] },
  )).rejects.toThrow("runtime operation moved before its transition");
  expect((await client.operationStatus("op-socket-queue"))?.receipt.status).toBe("delivering");
  expect((await client.transitionOperation("op-socket-queue", "failed", { reason: "write failed" })).receipt.status).toBe("failed");
  expect(await client.effectBatch()).toEqual([]);
  expect((await client.retryOperation("op-socket-queue")).receipt.status).toBe("queued");
  expect(await client.effectBatch(["runtime.send", "runtime.steer"])).toHaveLength(1);
  expect((await client.transitionOperation("op-socket-queue", "delivering")).receipt.status).toBe("delivering");
  expect((await client.transitionOperation("op-socket-queue", "delivered", { turnId: "turn-one" })).receipt.status).toBe("delivered");
  expect(await client.effectBatch()).toEqual([]);

  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  journal.close();
});

test("runtime host fencing reclaims a stale process identity", () => {
  const dir = sandbox("stale-fence");
  const filename = path.join(dir, "runtime.lock");
  fs.writeFileSync(filename, JSON.stringify({ pid: 42, startIdentity: "42:old" }), { mode: 0o600 });
  const fence = new RuntimeHostFence(filename, () => false);
  fence.acquire();
  expect(JSON.parse(fs.readFileSync(filename, "utf8"))).toMatchObject({
    pid: process.pid,
    acquisitionId: expect.any(String),
  });
  fence.release();
  const successor = new RuntimeHostFence(filename);
  successor.acquire();
  successor.release();
});

test("issue 367: a failed structured spawn retires its registering placeholder with the terminal receipt", () => {
  const dir = sandbox("spawn-failed-placeholder");
  const journal = new RuntimeJournal(path.join(dir, "events.sqlite"), { maxEvents: 100, now: () => 100, structuredHosts: true });
  journal.executeOperation({
    kind: "spawn",
    conversationId: "conversation_fable_one",
    operationId: "launch-6799487f",
    idempotencyKey: "launch-6799487f",
    engine: "claude",
    cwd: "/repo",
    "prompt": "Implement the follow-up",
    accountId: "botfat\x68erdev-2",
  });
  expect(journal.snapshot().sessions[0]).toMatchObject({
    conversationId: "conversation_fable_one",
    hostKind: "claude-broker",
    host: "registering",
    turn: "unknown",
  });

  const failed = journal.transitionOperation("launch-6799487f", "failed", { reason: "runtime host request timed out" });
  expect(failed.receipt.status).toBe("failed");
  const snapshot = journal.snapshot();
  expect(snapshot.sessions).toHaveLength(1);
  expect(snapshot.sessions[0]).toMatchObject({
    conversationId: "conversation_fable_one",
    host: "dead",
    turn: "idle",
    activeTurnId: null,
    attentionIds: [],
  });
  expect(snapshot.runtime.health).toBe("ready");

  const replayed = journal.transitionOperation("launch-6799487f", "failed", { reason: "runtime host request timed out" });
  expect(replayed.replayed).toBe(true);
  journal.close();
});

test("issue 367: a delivered spawn keeps its placeholder for the launcher's hosted projection", () => {
  const dir = sandbox("spawn-delivered-placeholder");
  const journal = new RuntimeJournal(path.join(dir, "events.sqlite"), { maxEvents: 100, now: () => 100, structuredHosts: true });
  journal.executeOperation({
    kind: "spawn",
    conversationId: "conversation_fable_live",
    operationId: "launch-live",
    idempotencyKey: "launch-live",
    engine: "claude",
    cwd: "/repo",
    "prompt": "Implement",
  });
  journal.transitionOperation("launch-live", "delivered");
  expect(journal.snapshot().sessions[0]).toMatchObject({
    conversationId: "conversation_fable_live",
    host: "registering",
  });
  journal.close();
});

test("issue 367: a new host epoch retires registering placeholders abandoned by prior-epoch launches", () => {
  const dir = sandbox("epoch-registering-sweep");
  const filename = path.join(dir, "events.sqlite");
  const journal = new RuntimeJournal(filename, { maxEvents: 100, now: () => 100, structuredHosts: true });
  for (const conversation of ["conversation_stale_a", "conversation_stale_b"]) {
    journal.executeOperation({
      kind: "spawn",
      conversationId: conversation,
      operationId: `launch-${conversation}`,
      idempotencyKey: `launch-${conversation}`,
      engine: "claude",
      cwd: "/repo",
      "prompt": "Implement",
    });
  }
  journal.append({
    scope: runtimeScope("session", "conversation_hosted"),
    kind: "session-status",
    payload: {
      conversationId: "conversation_hosted",
      sessionKey: { engine: "claude", sessionId: "session-hosted" },
      hostKind: "claude-broker",
      host: "hosted",
      turn: "running",
      activeTurnId: "turn-live",
      provenance: "structured",
      capabilities: { steer: false, structuredAttention: true },
    },
  });
  journal.close();

  const restarted = new RuntimeJournal(filename, { maxEvents: 100, now: () => 200, structuredHosts: true });
  const epoch = restarted.claimHostEpoch();
  expect(epoch).toBe(2);
  const sessions = new Map(restarted.snapshot().sessions.map((session) => [session.conversationId, session]));
  expect(sessions.get("conversation_stale_a")).toMatchObject({ host: "dead", turn: "idle", activeTurnId: null });
  expect(sessions.get("conversation_stale_b")).toMatchObject({ host: "dead", turn: "idle", activeTurnId: null });
  expect(sessions.get("conversation_hosted")).toMatchObject({ host: "hosted", turn: "running", activeTurnId: "turn-live" });

  const again = restarted.claimHostEpoch();
  expect(again).toBe(3);
  expect(restarted.snapshot().sessions.filter((session) => session.host === "registering")).toEqual([]);
  restarted.close();
});

for (const order of ["reconfigure-then-kill", "kill-then-reconfigure"] as const) {
  test(`a delivered kill durably fences a same-generation reconfigure admitted ${order}`, () => {
    const dir = sandbox(`kill-reconfigure-${order}`);
    const filename = path.join(dir, "events.sqlite");
    const journal = new RuntimeJournal(filename, { structuredHosts: true, now: () => 100 });
    journal.append({
      scope: runtimeScope("session", "conv-kill-reconfigure"),
      kind: "session-status",
      payload: {
        conversationId: "conv-kill-reconfigure",
        sessionKey: { engine: "codex", sessionId: "thread-one" },
        hostKind: "codex-app-server",
        host: "hosted",
        turn: "idle",
        provenance: "structured",
        capabilities: { steer: true, structuredAttention: true },
      },
    });
    const reconfigure = {
      kind: "reconfigure" as const,
      operationId: "reconfigure-one",
      idempotencyKey: "reconfigure-one",
      conversationId: "conv-kill-reconfigure",
      sessionKey: { engine: "codex" as const, sessionId: "thread-one" },
      model: "gpt-5.6-sol",
      effort: "high",
      fast: false,
    };
    const kill = {
      kind: "kill" as const,
      operationId: "kill-one",
      idempotencyKey: "kill-one",
      conversationId: "conv-kill-reconfigure",
      sessionKey: { engine: "codex" as const, sessionId: "thread-one" },
    };
    for (const command of order === "reconfigure-then-kill" ? [reconfigure, kill] : [kill, reconfigure]) {
      journal.executeOperation(command);
    }

    journal.transitionOperation(kill.operationId, "delivering");
    journal.transitionOperation(kill.operationId, "delivered");
    journal.close();

    const reopened = new RuntimeJournal(filename, { structuredHosts: true, now: () => 200 });
    expect(reopened.operationResult(reconfigure.operationId)?.receipt).toMatchObject({
      status: "failed",
      reason: "conversation-killed",
    });
    expect(reopened.effectBatch(100, ["runtime.reconfigure"])).toEqual([]);
    expect(reopened.snapshot().sessions[0]).toMatchObject({ host: "dead", pendingReconfigure: null });
    reopened.close();
  });
}

test("issue 367: a delivered structured kill converges host and turn projection with its receipt", () => {
  const dir = sandbox("kill-terminal-projection");
  const journal = new RuntimeJournal(path.join(dir, "events.sqlite"), { maxEvents: 100, now: () => 100, structuredHosts: true });
  journal.append({
    scope: runtimeScope("session", "conversation_limit"),
    kind: "session-status",
    payload: {
      conversationId: "conversation_limit",
      sessionKey: { engine: "claude", sessionId: "session-limit" },
      hostKind: "claude-broker",
      host: "hosted",
      turn: "running",
      activeTurnId: "turn-spend-limit",
      attentionIds: ["attention-open"],
      provenance: "structured",
      artifactPath: "/sessions/limit.jsonl",
      capabilities: { steer: false, structuredAttention: true },
    },
  });

  const queued = journal.executeOperation({
    kind: "kill",
    conversationId: "conversation_limit",
    operationId: "op-kill-limit",
    idempotencyKey: "op-kill-limit",
    sessionKey: { engine: "claude", sessionId: "session-limit" },
  });
  expect(queued.receipt.status).toBe("queued");
  expect(journal.snapshot().sessions[0]).toMatchObject({ host: "hosted", turn: "running" });

  journal.transitionOperation("op-kill-limit", "delivering");
  expect(journal.snapshot().sessions[0]).toMatchObject({ host: "hosted", turn: "running" });

  const delivered = journal.transitionOperation("op-kill-limit", "delivered");
  expect(delivered.receipt.status).toBe("delivered");
  const session = journal.snapshot().sessions[0];
  expect(session).toMatchObject({
    conversationId: "conversation_limit",
    host: "dead",
    turn: "idle",
    activeTurnId: null,
    attentionIds: [],
  });

  const replayed = journal.transitionOperation("op-kill-limit", "delivered");
  expect(replayed.replayed).toBe(true);
  expect(journal.snapshot().sessions[0]).toMatchObject({ host: "dead", turn: "idle" });
  journal.close();
});

test("a delivered kill retains its original admission boundary through compaction", () => {
  const dir = sandbox("kill-boundary-compaction");
  const filename = path.join(dir, "events.sqlite");
  let journal = new RuntimeJournal(filename, { structuredHosts: true });
  journal.append({
    scope: runtimeScope("session", "conversation_boundary"),
    kind: "session-status",
    payload: {
      conversationId: "conversation_boundary",
      sessionKey: { engine: "claude", sessionId: "session-boundary" },
      hostKind: "claude-broker",
      host: "hosted",
      turn: "running",
      activeTurnId: "turn-boundary",
      provenance: "structured",
      capabilities: { steer: false, structuredAttention: true },
    },
  });
  journal.executeOperation({
    kind: "kill",
    conversationId: "conversation_boundary",
    operationId: "op-kill-boundary",
    idempotencyKey: "op-kill-boundary",
    sessionKey: { engine: "claude", sessionId: "session-boundary" },
  });
  const admissionEventSeq = journal.effectBatch(100, ["runtime.kill"])[0]!.eventSeq;

  journal.transitionOperation("op-kill-boundary", "delivering");
  journal.transitionOperation("op-kill-boundary", "delivered");

  expect(journal.effectBatch()).toEqual([]);
  expect(journal.effectBatch(100, ["runtime.kill-boundary"])).toEqual([{
    id: "kill-boundary:conversation_boundary",
    kind: "runtime.kill-boundary",
    eventSeq: admissionEventSeq,
    payload: {
      operationId: "op-kill-boundary",
      conversationId: "conversation_boundary",
      admissionEventSeq,
    },
  }]);
  journal.compact(1);
  journal.close();

  journal = new RuntimeJournal(filename, { structuredHosts: true });
  expect(journal.effectBatch(100, ["runtime.kill-boundary"])).toEqual([
    expect.objectContaining({ eventSeq: admissionEventSeq }),
  ]);
  journal.close();
});

test("issue 367: a failed structured kill leaves the live projection untouched", () => {
  const dir = sandbox("kill-failed-projection");
  const journal = new RuntimeJournal(path.join(dir, "events.sqlite"), { maxEvents: 100, now: () => 100, structuredHosts: true });
  journal.append({
    scope: runtimeScope("session", "conversation_alive"),
    kind: "session-status",
    payload: {
      conversationId: "conversation_alive",
      sessionKey: { engine: "claude", sessionId: "session-alive" },
      hostKind: "claude-broker",
      host: "hosted",
      turn: "running",
      activeTurnId: "turn-live",
      provenance: "structured",
      capabilities: { steer: false, structuredAttention: true },
    },
  });
  journal.executeOperation({
    kind: "kill",
    conversationId: "conversation_alive",
    operationId: "op-kill-alive",
    idempotencyKey: "op-kill-alive",
    sessionKey: { engine: "claude", sessionId: "session-alive" },
  });
  journal.transitionOperation("op-kill-alive", "failed", { reason: "structured host termination is unavailable" });
  expect(journal.effectBatch(100, ["runtime.kill-boundary"])).toEqual([]);
  expect(journal.snapshot().sessions[0]).toMatchObject({
    host: "hosted",
    turn: "running",
    activeTurnId: "turn-live",
  });
  journal.close();
});

test("snapshotJson rebuilds only when the database has changed", () => {
  const dir = sandbox("snapshot-cache");
  const journal = new RuntimeJournal(path.join(dir, "events.sqlite"), { maxEvents: 100, now: () => 100 });
  journal.append({ scope: runtimeScope("session", "one"), kind: "turn.started", payload: { turnId: "a" } });
  const first = journal.snapshotJson();
  expect(JSON.parse(first)).toEqual(JSON.parse(JSON.stringify(journal.snapshot())));
  // Identity equality proves the cached string was reused, not rebuilt.
  expect(journal.snapshotJson()).toBe(first);
  journal.append({ scope: runtimeScope("session", "one"), kind: "turn.completed", payload: { turnId: "a" } });
  const second = journal.snapshotJson();
  expect(second).not.toBe(first);
  expect(JSON.parse(second).snapshotSeq).toBe(2);
  journal.close();
});

test("snapshotJson expires terminal-session edges without a database change", () => {
  const dir = sandbox("snapshot-cache-edge-expiry");
  let now = 100;
  const journal = new RuntimeJournal(path.join(dir, "events.sqlite"), { maxEvents: 100, now: () => now });
  journal.executeOperation({
    kind: "spawn",
    conversationId: "child-expiring-edge",
    operationId: "operation-expiring-edge",
    idempotencyKey: "spawn-expiring-edge",
    engine: "codex",
    cwd: "repo",
    "prompt": "Run the fixture",
    parentConversationId: "parent",
    sessionId: "session-expiring-edge",
  });
  journal.append({
    scope: runtimeScope("session", "child-expiring-edge"),
    kind: "session-status",
    payload: { host: "dead", turn: "idle" },
  });

  const before = journal.snapshotJson();
  const beforeSnapshot = JSON.parse(before) as ReturnType<RuntimeJournal["snapshot"]>;
  expect(beforeSnapshot.edges.map((edge) => edge.id)).toEqual(["edge-operation-expiring-edge"]);
  expect(journal.snapshotJson()).toBe(before);

  now += RUNTIME_SNAPSHOT_STALE_EDGE_RETENTION_MS;
  expect(journal.snapshotJson()).toBe(before);
  now += 1;
  const after = journal.snapshotJson();
  const afterSnapshot = JSON.parse(after) as ReturnType<RuntimeJournal["snapshot"]>;
  expect(afterSnapshot.snapshotSeq).toBe(beforeSnapshot.snapshotSeq);
  expect(afterSnapshot.edges).toEqual([]);
  expect(journal.snapshot().edges).toEqual([]);
  journal.close();
});

test("receipt maintenance keeps only the latest engine receipt per session prefix", () => {
  const dir = sandbox("receipt-sweep-engine");
  const filename = path.join(dir, "events.sqlite");
  const journal = new RuntimeJournal(filename, { maxEvents: 100, now: () => 100 });
  journal.append({
    scope: runtimeScope("session", "one"),
    kind: "turn.started",
    payload: { turnId: "a" },
    producer: { kind: "codex-app-server", eventKey: "engine-host:codex:legacy-session:50" },
  });
  journal.close();
  // Legacy accumulation predating the append-path dedupe: rows the sweep,
  // not a future append in the same prefix, must reclaim.
  const raw = new Database(filename, { strict: true });
  for (let sequence = 0; sequence < 40; sequence += 1) {
    raw.query("INSERT INTO producer_receipts(producer_kind, producer_key, event_json) VALUES (?, ?, ?)")
      .run("codex-app-server", `engine-host:codex:legacy-session:${sequence}`, JSON.stringify({ seq: 1 }));
  }
  raw.close();
  const reopened = new RuntimeJournal(filename, { maxEvents: 100, now: () => 200 });
  let deleted = 0;
  for (let pass = 0; pass < 10; pass += 1) {
    const result = reopened.maintainProducerReceipts(16);
    deleted += result.deleted;
    if (result.cycled && result.deleted === 0) break;
  }
  expect(deleted).toBe(40);
  const survivors = new Database(filename, { readonly: true })
    .query<{ producer_key: string }, []>("SELECT producer_key FROM producer_receipts WHERE producer_key LIKE 'engine-host:codex:legacy-session:%'")
    .all();
  expect(survivors.map((row) => row.producer_key)).toEqual(["engine-host:codex:legacy-session:50"]);
  reopened.close();
});

test("receipt maintenance expires non-engine receipts below the compaction anchor and keeps the rest", () => {
  const dir = sandbox("receipt-sweep-anchor");
  const filename = path.join(dir, "events.sqlite");
  const journal = new RuntimeJournal(filename, { maxEvents: 2, now: () => 100 });
  journal.append({ scope: runtimeScope("session", "one"), kind: "turn.started", payload: { turnId: "a" }, producerKey: "native:a" });
  journal.append({ scope: runtimeScope("session", "one"), kind: "turn.completed", payload: { turnId: "a" }, producerKey: "native:b" });
  // Third append compacts the first event beneath the anchor.
  journal.append({ scope: runtimeScope("session", "one"), kind: "turn.started", payload: { turnId: "b" }, producerKey: "native:c" });
  const anchor = JSON.parse(journal.snapshotJson()).retentionFloorSeq as number;
  expect(anchor).toBeGreaterThanOrEqual(1);
  const before = new Database(filename, { readonly: true })
    .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM producer_receipts").get()!.n;
  expect(before).toBe(3);
  const result = journal.maintainProducerReceipts();
  expect(result.cycled).toBe(true);
  expect(result.deleted).toBe(1);
  const survivors = new Database(filename, { readonly: true })
    .query<{ producer_key: string }, []>("SELECT producer_key FROM producer_receipts ORDER BY producer_key").all();
  expect(survivors.map((row) => row.producer_key)).toEqual(["native:b", "native:c"]);
  journal.close();
});

test("snapshot over the socket splices the cached frame and stays a valid response", async () => {
  const dir = sandbox("snapshot-socket-splice");
  const journal = new RuntimeJournal(path.join(dir, "events.sqlite"), { maxEvents: 100, now: () => 100 });
  journal.append({ scope: runtimeScope("session", "one"), kind: "turn.started", payload: { turnId: "a" } });
  const host = new RuntimeHost(journal);
  const socketPath = path.join(dir, "host.sock");
  const server = serveRuntimeHost(socketPath, host);
  try {
    const client = new UnixRuntimeHostClient(socketPath);
    const snapshot = await client.snapshot();
    expect(snapshot.snapshotSeq).toBe(1);
    expect(snapshot.sessions).toHaveLength(1);
  } finally {
    server.close();
    journal.close();
  }
});

test("issue 1100: tool items project into the session's live turn on both lifecycle phases and survive reopen", () => {
  const dir = sandbox("live-turn-tools");
  const filename = path.join(dir, "events.sqlite");
  const journal = new RuntimeJournal(filename, { maxEvents: 100, now: () => 100 });
  const scope = runtimeScope("session", "conversation_tools");
  journal.append({ scope, kind: "host.connected", payload: { conversationId: "conversation_tools", sessionKey: { engine: "codex", sessionId: "thread-tools" } } });
  journal.append({ scope, kind: "turn-started", payload: { conversationId: "conversation_tools", turnId: "turn-tools" } });
  journal.append({
    scope,
    kind: "item",
    payload: {
      conversationId: "conversation_tools",
      turnId: "turn-tools",
      phase: "started",
      item: { type: "commandExecution", id: "call_build", command: "bun run build", cwd: "/repo", status: "inProgress" },
    },
  });
  journal.append({ scope, kind: "delta", payload: { conversationId: "conversation_tools", turnId: "turn-tools", text: "Building…" } });
  journal.append({
    scope,
    kind: "item",
    payload: {
      conversationId: "conversation_tools",
      turnId: "turn-tools",
      phase: "completed",
      item: { type: "assistant", uuid: "uuid-claude-tool", message: { role: "assistant", content: [
        { type: "tool_use", id: "toolu_read", name: "Read", input: { file_path: "/repo/README.md" } },
      ] } },
    },
  });
  const running = journal.sessionState("conversation_tools")?.liveTurn?.items ?? [];
  expect(running.map((item) => item.tool ? `${item.itemId}:${item.tool.status}` : `text:${item.text}`))
    .toEqual(["call_build:run", "text:Building…", "toolu_read:run"]);
  journal.append({
    scope,
    kind: "item",
    payload: {
      conversationId: "conversation_tools",
      turnId: "turn-tools",
      phase: "completed",
      item: { type: "commandExecution", id: "call_build", command: "bun run build", cwd: "/repo", status: "completed", exitCode: 1 },
    },
  });
  journal.close();

  /* A reopened journal (host restart) rebuilds the same rows from the durable events. */
  const reopened = new RuntimeJournal(filename, { maxEvents: 100, now: () => 100 });
  const items = reopened.sessionState("conversation_tools")?.liveTurn?.items ?? [];
  expect(items.map((item) => item.tool ? `${item.itemId}:${item.tool.status}` : `text:${item.text}`))
    .toEqual(["call_build:err", "text:Building…", "toolu_read:run"]);
  expect(items[0]?.tool).toMatchObject({ name: "shell", engine: "codex", args: { cmd: "bun run build", workdir: "/repo" } });
  expect(reopened.snapshot().sessions.find((session) => session.conversationId === "conversation_tools")?.liveTurn?.items).toHaveLength(3);
  reopened.close();
});
