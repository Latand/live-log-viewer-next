import { expect, test } from "bun:test";

import type { RuntimeHostClient } from "./client";
import type { RuntimeSnapshot } from "./contracts";

import { enqueueStructuredMessage } from "./structuredMessageDelivery";

const artifactPath = "/sessions/11111111-1111-4111-8111-111111111111.jsonl";
const conversationId = "conversation_11111111-1111-4111-8111-111111111111";

function snapshot(): RuntimeSnapshot {
  return {
    schemaVersion: 1,
    snapshotSeq: 1,
    retentionFloorSeq: 0,
    serverTime: "2026-07-13T00:00:00.000Z",
    runtime: { hostEpoch: 1, health: "ready" },
    filesRevision: 0,
    sessions: [{
      conversationId,
      sessionKey: { engine: "codex", sessionId: "11111111-1111-4111-8111-111111111111" },
      hostKind: "codex-app-server",
      host: "hosted",
      turn: "idle",
      provenance: "structured",
      revision: 1,
      attentionIds: [],
      recentReceipts: [],
      accountId: null,
      parentConversationId: null,
      flowId: null,
      workflowId: null,
      cwd: "/repo",
      artifactPath,
      capabilities: { steer: true, structuredAttention: true },
      activeTurnId: null,
    }],
    attentions: [],
    recentOperations: [],
    edges: [],
    flows: [],
    workflows: [],
    tasks: [],
    deployments: [],
  };
}

test("structured message routing is inert while its gate is disabled", async () => {
  let called = false;
  const result = await enqueueStructuredMessage(
    { path: artifactPath, text: "hello", hasImages: false },
    {
      enabled: () => false,
      client: () => {
        called = true;
        return null;
      },
    },
  );

  expect(result).toBeNull();
  expect(called).toBe(false);
});

test("structured message routing fails closed when runtime ownership is unavailable", async () => {
  const result = await enqueueStructuredMessage(
    { path: artifactPath, text: "hello", hasImages: false },
    { enabled: () => true, client: () => null },
  );

  expect(result).toEqual({
    ok: false,
    structured: true,
    outcome: "failed",
    error: "structured host ownership is unavailable; retry after runtime synchronization",
    status: 503,
  });
});

test("structured message routing fails closed when the snapshot has no owner", async () => {
  const client = {
    snapshot: async () => ({ ...snapshot(), sessions: [] }),
  } as unknown as RuntimeHostClient;

  const result = await enqueueStructuredMessage(
    { path: artifactPath, text: "hello", hasImages: false },
    { enabled: () => true, client: () => client },
  );

  expect(result).toEqual({
    ok: false,
    structured: true,
    outcome: "failed",
    error: "structured host ownership is unavailable; retry after runtime synchronization",
    status: 503,
  });
});

test("structured message routing only falls through for an explicit legacy owner", async () => {
  const legacySnapshot = snapshot();
  legacySnapshot.sessions[0] = { ...legacySnapshot.sessions[0]!, hostKind: "tmux-legacy" };
  const client = {
    snapshot: async () => legacySnapshot,
    command: async () => { throw new Error("legacy delivery reached the structured host"); },
  } as unknown as RuntimeHostClient;

  const result = await enqueueStructuredMessage(
    { path: artifactPath, text: "hello", hasImages: false },
    { enabled: () => true, client: () => client },
  );

  expect(result).toBeNull();
});

test("structured message routing fails closed for an unhosted owner", async () => {
  const unhostedSnapshot = snapshot();
  unhostedSnapshot.sessions[0] = { ...unhostedSnapshot.sessions[0]!, hostKind: "unhosted" };
  const client = { snapshot: async () => unhostedSnapshot } as unknown as RuntimeHostClient;

  const result = await enqueueStructuredMessage(
    { path: artifactPath, text: "hello", hasImages: false },
    { enabled: () => true, client: () => client },
  );

  expect(result).toMatchObject({ ok: false, structured: true, status: 503 });
});

test("structured message routing returns the durable queued receipt immediately", async () => {
  let command: unknown;
  let kicked = 0;
  const client = {
    snapshot: async () => snapshot(),
    command: async (value: unknown) => {
      command = value;
      return {
        operationId: "op-one",
        replayed: false,
        receipt: {
          operationId: "op-one",
          idempotencyKey: "message-one",
          conversationId,
          kind: "send" as const,
          status: "queued" as const,
          queuePosition: 1,
          at: "2026-07-13T00:00:00.000Z",
          revision: 1,
        },
      };
    },
  } as unknown as RuntimeHostClient;

  const result = await enqueueStructuredMessage(
    { path: artifactPath, text: "hello", clientMessageId: "message-one", hasImages: false },
    { enabled: () => true, client: () => client, kick: () => { kicked += 1; } },
  );

  expect(command).toMatchObject({ conversationId, text: "hello", idempotencyKey: "message-one", policy: "queue" });
  expect(result).toMatchObject({ ok: true, structured: true, outcome: "queued", operationId: "op-one" });
  expect(kicked).toBe(1);
});
