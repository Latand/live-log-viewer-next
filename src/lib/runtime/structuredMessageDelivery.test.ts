import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, expect, test } from "bun:test";

import { AgentRegistry } from "@/lib/agent/registry";
import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import type { RuntimeHostClient } from "./client";
import type { RuntimeSnapshot } from "./contracts";

import { deliverHeldStructuredMessage, enqueueStructuredMessage } from "./structuredMessageDelivery";

const artifactPath = "/sessions/11111111-1111-4111-8111-111111111111.jsonl";
const conversationId = "conversation_11111111-1111-4111-8111-111111111111";
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-structured-message-"));
let registryNumber = 0;

afterAll(() => fs.rmSync(sandbox, { recursive: true, force: true }));

function registryWithConversation(accountId = "default") {
  const registry = new AgentRegistry(path.join(sandbox, `registry-${registryNumber += 1}.json`));
  registry.reconcileConversations([{
    engine: "codex",
    path: artifactPath,
    accountId,
    launchProfile: emptyLaunchProfile({ cwd: "/repo", project: "repo" }),
    turn: { state: "idle", source: "empty", terminalAt: null },
    observedAt: "2026-07-13T00:00:00.000Z",
  }]);
  const conversation = registry.conversationForPath(artifactPath)!;
  return { registry, conversation };
}

function snapshot(ownedConversationId = conversationId): RuntimeSnapshot {
  return {
    schemaVersion: 1,
    snapshotSeq: 1,
    retentionFloorSeq: 0,
    serverTime: "2026-07-13T00:00:00.000Z",
    runtime: { hostEpoch: 1, health: "ready" },
    filesRevision: 0,
    sessions: [{
      conversationId: ownedConversationId,
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

test("structured message routing falls through after startup adoption leaves no runtime client", async () => {
  const result = await enqueueStructuredMessage(
    { path: artifactPath, text: "hello", hasImages: false },
    { enabled: () => true, client: () => null },
  );

  expect(result).toBeNull();
});

test("structured message routing falls through when the snapshot has no owner for the session", async () => {
  const client = {
    snapshot: async () => ({ ...snapshot(), sessions: [] }),
  } as unknown as RuntimeHostClient;

  const result = await enqueueStructuredMessage(
    { path: artifactPath, text: "hello", hasImages: false },
    { enabled: () => true, client: () => client },
  );

  expect(result).toBeNull();
});

test("structured message routing falls through when the startup snapshot is unavailable", async () => {
  const client = {
    snapshot: async () => { throw new Error("startup adoption failed"); },
  } as unknown as RuntimeHostClient;

  const result = await enqueueStructuredMessage(
    { path: artifactPath, text: "hello", hasImages: false },
    { enabled: () => true, client: () => client },
  );

  expect(result).toBeNull();
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

test("structured message routing falls through for an unhosted owner", async () => {
  const unhostedSnapshot = snapshot();
  unhostedSnapshot.sessions[0] = { ...unhostedSnapshot.sessions[0]!, hostKind: "unhosted" };
  const client = { snapshot: async () => unhostedSnapshot } as unknown as RuntimeHostClient;

  const result = await enqueueStructuredMessage(
    { path: artifactPath, text: "hello", hasImages: false },
    { enabled: () => true, client: () => client },
  );

  expect(result).toBeNull();
});

test("structured message routing returns the durable queued receipt immediately", async () => {
  const { registry, conversation } = registryWithConversation();
  let command: unknown;
  let kicked = 0;
  const client = {
    snapshot: async () => snapshot(conversation.id),
    command: async (value: unknown) => {
      command = value;
      return {
        operationId: "op-one",
        replayed: false,
        receipt: {
          operationId: "op-one",
          idempotencyKey: "message-one",
          conversationId: conversation.id,
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
    { enabled: () => true, client: () => client, registry: () => registry, kick: () => { kicked += 1; } },
  );

  expect(command).toMatchObject({ conversationId: conversation.id, text: "hello", idempotencyKey: "message-one", policy: "queue" });
  expect(result).toMatchObject({ ok: true, structured: true, outcome: "queued", operationId: "op-one" });
  expect(kicked).toBe(1);
  expect(registry.pendingDeliveries(conversation.id)).toMatchObject([{
    clientMessageId: "message-one",
    state: "delivery-uncertain",
  }]);
});

test("migration-held delivery settles through the runtime journal after EngineHost completion", async () => {
  const { conversation } = registryWithConversation();
  let command: unknown;
  let status = "queued" as "queued" | "delivered";
  const receipt = () => ({
    operationId: "held-delivery-one",
    idempotencyKey: "held-message-one",
    conversationId: conversation.id,
    kind: "send" as const,
    status,
    queuePosition: 1,
    at: "2026-07-13T00:00:00.000Z",
    revision: status === "queued" ? 1 : 2,
  });
  const client = {
    snapshot: async () => snapshot(conversation.id),
    command: async (value: unknown) => {
      command = value;
      return { operationId: "held-delivery-one", replayed: false, receipt: receipt() };
    },
    operationStatus: async () => ({ operationId: "held-delivery-one", replayed: true, receipt: receipt() }),
  } as unknown as RuntimeHostClient;

  const outcome = await deliverHeldStructuredMessage(
    {
      conversationId: conversation.id,
      path: artifactPath,
      deliveryId: "held-delivery-one",
      clientMessageId: "held-message-one",
      text: "after migration",
    },
    {
      enabled: () => true,
      client: () => client,
      kick: async () => { status = "delivered"; },
    },
  );

  expect(command).toMatchObject({
    kind: "send",
    operationId: "held-delivery-one",
    conversationId: conversation.id,
    idempotencyKey: "held-message-one",
    text: "after migration",
    policy: "queue",
  });
  expect(outcome).toBe("delivered");
});

test("held delivery falls through when structured ownership is unavailable", async () => {
  const request = {
    conversationId: "conversation_missing",
    path: artifactPath,
    deliveryId: "held-missing-owner",
    clientMessageId: "held-missing-owner-message",
    text: "continue through tmux",
  };
  const missingSessionClient = {
    snapshot: async () => ({ ...snapshot(), sessions: [] }),
  } as unknown as RuntimeHostClient;

  expect(await deliverHeldStructuredMessage(request, {
    enabled: () => true,
    client: () => null,
  })).toBeNull();
  expect(await deliverHeldStructuredMessage(request, {
    enabled: () => true,
    client: () => missingSessionClient,
  })).toBeNull();
});

test("structured message routing holds composer delivery when migration owns the fence", async () => {
  const { registry, conversation } = registryWithConversation("managed");
  registry.commitMigrationIntent({
    engine: "codex",
    targetId: "default",
    origin: "manual",
    requestId: "structured-migration",
    expectedRevision: registry.engineRouting("codex").revision,
    scope: "all",
  });
  registry.requestConversationMigrationToActiveAccount(conversation.id);
  let commands = 0;
  let migrationTicks = 0;
  const client = {
    snapshot: async () => snapshot(conversation.id),
    command: async () => {
      commands += 1;
      throw new Error("the predecessor host received a fenced message");
    },
  } as unknown as RuntimeHostClient;

  const result = await enqueueStructuredMessage(
    { path: artifactPath, text: "after migration", clientMessageId: "migration-message", hasImages: false },
    {
      enabled: () => true,
      client: () => client,
      registry: () => registry,
      requestMigrationTick: () => { migrationTicks += 1; },
    },
  );

  expect(result).toMatchObject({ ok: true, structured: true, target: conversation.id, outcome: "held" });
  expect(commands).toBe(0);
  expect(migrationTicks).toBe(1);
  expect(registry.pendingDeliveries(conversation.id)).toMatchObject([{
    state: "held",
    clientMessageId: "migration-message",
    text: "after migration",
  }]);
});
