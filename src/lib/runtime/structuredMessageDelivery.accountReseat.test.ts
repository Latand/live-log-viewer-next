import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, expect, test } from "bun:test";

import { AgentRegistry } from "@/lib/agent/registry";
import { advanceConversationMigration, drainHeldDeliveries } from "@/lib/accounts/migration/coordinator";
import { emptyLaunchProfile, type SuccessorProviderPort } from "@/lib/accounts/migration/contracts";
import type { RuntimeHostClient } from "./client";
import type { RuntimeSnapshot } from "./contracts";
import { runtimeImageCapability } from "./runtimeImageStore";
import type { StructuredImageRef } from "./structuredContent";

import { enqueueStructuredMessage } from "./structuredMessageDelivery";

const artifactPath = "/sessions/native-source.jsonl";
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-account-reseat-"));
const PNG_BASE64 = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489", "hex").toString("base64");
let registryNumber = 0;

afterAll(() => fs.rmSync(sandbox, { recursive: true, force: true }));

function registryWithConversation(accountId = "seat-source", engine: "codex" | "claude" = "codex") {
  const registry = new AgentRegistry(path.join(sandbox, `registry-${registryNumber += 1}.json`));
  registry.reconcileConversations([{
    engine,
    path: artifactPath,
    accountId,
    launchProfile: emptyLaunchProfile({ cwd: "/repo", project: "project" }),
    turn: { state: "idle", source: "empty", terminalAt: null },
    observedAt: "2026-07-21T00:00:00.000Z",
  }]);
  return { registry, conversation: registry.conversationForPath(artifactPath)! };
}

function snapshot(
  conversationId: string,
  engine: "codex" | "claude" = "codex",
  host: "hosted" | "dead" = "hosted",
): RuntimeSnapshot {
  return {
    schemaVersion: 1,
    snapshotSeq: 1,
    retentionFloorSeq: 0,
    serverTime: "2026-07-21T00:00:00.000Z",
    runtime: { hostEpoch: 1, health: "ready" },
    filesRevision: 0,
    sessions: [{
      conversationId,
      sessionKey: { engine, sessionId: "native-source" },
      hostKind: engine === "codex" ? "codex-app-server" : "claude-broker",
      host,
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
      capabilities: {
        steer: engine === "codex",
        structuredAttention: true,
        imageInput: runtimeImageCapability(engine, false),
      },
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

function deliveredClient(conversationId: string, onCommand: () => void): RuntimeHostClient {
  return {
    snapshot: async () => snapshot(conversationId),
    command: async (command: { operationId: string; idempotencyKey: string; conversationId: string }) => {
      onCommand();
      return {
        operationId: command.operationId,
        replayed: false,
        receipt: {
          operationId: command.operationId,
          idempotencyKey: command.idempotencyKey,
          conversationId: command.conversationId,
          kind: "send" as const,
          status: "delivered" as const,
          at: "2026-07-21T00:00:00.000Z",
          revision: 1,
        },
      };
    },
  } as unknown as RuntimeHostClient;
}

test("a live structured send starts an active-account reseat and holds the operator message", async () => {
  const { registry, conversation } = registryWithConversation();
  registry.setEngineRouting("codex", "seat-active");
  const nativeGeneration = conversation.generations.at(-1)!;
  let commands = 0;
  let migrationTicks = 0;
  const client = {
    snapshot: async () => snapshot(conversation.id),
    command: async () => {
      commands += 1;
      throw new Error("the predecessor host received a fenced message");
    },
  } as unknown as RuntimeHostClient;

  const result = await enqueueStructuredMessage({
    path: artifactPath,
    conversationId: conversation.id,
    clientMessageId: "live-account-reseat",
    text: "continue after migration",
  }, {
    enabled: () => true,
    client: () => client,
    registry: () => registry,
    requestMigrationTick: () => { migrationTicks += 1; },
  });

  expect(result).toMatchObject({ ok: true, structured: true, target: conversation.id, outcome: "held" });
  expect({ commands, migrationTicks }).toEqual({ commands: 0, migrationTicks: 1 });
  expect(registry.conversationForPath(artifactPath)).toMatchObject({
    id: conversation.id,
    migration: { targetId: "seat-active", phase: "requested" },
    generations: [{ id: nativeGeneration.id, path: nativeGeneration.path, accountId: "seat-source" }],
  });
  expect(registry.pendingDeliveries(conversation.id)).toMatchObject([{
    clientMessageId: "live-account-reseat",
    text: "continue after migration",
    state: "held",
  }]);
});

test("a dead structured send is durable before predecessor recovery", async () => {
  const { registry, conversation } = registryWithConversation("seat-source", "claude");
  registry.setEngineRouting("claude", "seat-active");
  const imageRef: StructuredImageRef = { sha256: "d".repeat(64), mime: "image/png", bytes: 67 };
  let republishes = 0;
  let recoveries = 0;
  let commands = 0;
  let storedImages = 0;
  let migrationTicks = 0;
  const client = {
    snapshot: async () => snapshot(conversation.id, "claude", "dead"),
    command: async () => {
      commands += 1;
      throw new Error("the predecessor received the held message");
    },
  } as unknown as RuntimeHostClient;

  const result = await enqueueStructuredMessage({
    path: artifactPath,
    conversationId: conversation.id,
    clientMessageId: "dead-account-reseat",
    text: "continue with the successor",
    images: [{ base64: PNG_BASE64, mime: "image/png" }],
  }, {
    enabled: () => true,
    client: () => client,
    registry: () => registry,
    republish: async () => { republishes += 1; return true; },
    recover: async () => {
      recoveries += 1;
      throw new Error("predecessor recovery ran during account reseat");
    },
    previewImageRefs: () => [imageRef],
    storeImages: () => { storedImages += 1; return [imageRef]; },
    requestMigrationTick: () => { migrationTicks += 1; },
  });

  expect(result).toMatchObject({ ok: true, structured: true, target: conversation.id, outcome: "held" });
  expect({ republishes, recoveries, commands, storedImages, migrationTicks }).toEqual({
    republishes: 0,
    recoveries: 0,
    commands: 0,
    storedImages: 1,
    migrationTicks: 1,
  });
  expect(registry.pendingDeliveries(conversation.id)).toMatchObject([{
    clientMessageId: "dead-account-reseat",
    payloadKind: "runtime-images",
    runtimeImages: [imageRef],
    state: "held",
  }]);
});

test("a matching account keeps the direct structured delivery path", async () => {
  const { registry, conversation } = registryWithConversation();
  registry.setEngineRouting("codex", "seat-source");
  registry.requestConversationMigrationToActiveAccount = (() => {
    throw new Error("matching-account delivery attempted a migration write");
  }) as typeof registry.requestConversationMigrationToActiveAccount;
  let commands = 0;

  const result = await enqueueStructuredMessage({
    path: artifactPath,
    conversationId: conversation.id,
    clientMessageId: "matching-account-send",
    text: "continue directly",
  }, {
    enabled: () => true,
    client: () => deliveredClient(conversation.id, () => { commands += 1; }),
    registry: () => registry,
    kick: () => {},
  });

  expect(result).toMatchObject({ ok: true, outcome: "delivered", target: conversation.id });
  expect(commands).toBe(1);
  expect(registry.conversation(conversation.id)?.migration).toBeNull();
});

test("an explicit migration opt-out keeps structured delivery on the source account", async () => {
  const { registry, conversation } = registryWithConversation();
  const intent = registry.commitMigrationIntent({
    engine: "codex",
    targetId: "seat-active",
    origin: "manual",
    requestId: "opt-out-before-send",
    expectedRevision: registry.engineRouting("codex").revision,
    scope: "all",
  });
  registry.setMigrationIntentState(intent.id, "stopped", intent.revision);
  const requestMigration = registry.requestConversationMigrationToActiveAccount.bind(registry);
  let migrationRequests = 0;
  registry.requestConversationMigrationToActiveAccount = ((id) => {
    migrationRequests += 1;
    return requestMigration(id);
  }) as typeof registry.requestConversationMigrationToActiveAccount;
  let commands = 0;

  const result = await enqueueStructuredMessage({
    path: artifactPath,
    conversationId: conversation.id,
    clientMessageId: "opted-out-send",
    text: "stay on the source",
  }, {
    enabled: () => true,
    client: () => deliveredClient(conversation.id, () => { commands += 1; }),
    registry: () => registry,
    kick: () => {},
  });

  expect(result).toMatchObject({ ok: true, outcome: "delivered", target: conversation.id });
  expect({ migrationRequests, commands }).toEqual({ migrationRequests: 1, commands: 1 });
  expect(registry.conversation(conversation.id)).toMatchObject({
    migration: { phase: "rolled-back", targetId: "seat-active" },
    migrationOptOut: { targetId: "seat-active" },
  });
});

test("an exact retry reuses one account migration and one held delivery", async () => {
  const { registry, conversation } = registryWithConversation();
  registry.setEngineRouting("codex", "seat-active");
  let commands = 0;
  let migrationTicks = 0;
  const client = {
    snapshot: async () => snapshot(conversation.id),
    command: async () => {
      commands += 1;
      throw new Error("a held retry reached the predecessor");
    },
  } as unknown as RuntimeHostClient;
  const request = {
    path: artifactPath,
    conversationId: conversation.id,
    clientMessageId: "idempotent-account-reseat",
    text: "deliver once",
  };
  const dependencies = {
    enabled: () => true,
    client: () => client,
    registry: () => registry,
    requestMigrationTick: () => { migrationTicks += 1; },
  };

  const first = await enqueueStructuredMessage(request, dependencies);
  const firstMigration = registry.conversation(conversation.id)?.migration;
  const retry = await enqueueStructuredMessage(request, dependencies);

  expect(first).toMatchObject({ ok: true, outcome: "held" });
  expect(retry).toMatchObject({ ok: true, outcome: "held" });
  expect({ commands, migrationTicks }).toEqual({ commands: 0, migrationTicks: 2 });
  expect(registry.conversation(conversation.id)?.migration).toMatchObject({
    intentId: firstMigration?.intentId,
    operationId: firstMigration?.operationId,
    revision: firstMigration?.revision,
  });
  expect(registry.pendingDeliveries(conversation.id)).toMatchObject([{
    clientMessageId: request.clientMessageId,
    text: request.text,
    state: "held",
    attempts: 0,
  }]);
});

test("restart preserves one Viewer conversation and drains once after account adoption", async () => {
  const { registry, conversation } = registryWithConversation();
  registry.setEngineRouting("codex", "seat-active");
  const sourceGeneration = conversation.generations.at(-1)!;
  const client = {
    snapshot: async () => snapshot(conversation.id),
    command: async () => { throw new Error("a held delivery reached the source host"); },
  } as unknown as RuntimeHostClient;

  expect(await enqueueStructuredMessage({
    path: artifactPath,
    conversationId: conversation.id,
    clientMessageId: "restart-safe-account-reseat",
    text: "deliver after adoption",
  }, {
    enabled: () => true,
    client: () => client,
    registry: () => registry,
    requestMigrationTick: () => {},
  })).toMatchObject({ ok: true, outcome: "held" });

  const restarted = new AgentRegistry(registry.filename);
  const successorId = "native-successor";
  const successorPath = `/sessions/${successorId}.jsonl`;
  const provider: SuccessorProviderPort = {
    virtualSource: true,
    async create(input) {
      expect(input).toMatchObject({
        conversationId: conversation.id,
        targetAccountId: "seat-active",
        source: { id: sourceGeneration.id, path: sourceGeneration.path, accountId: "seat-source" },
      });
      return {
        operationId: input.operationId,
        nativeId: successorId,
        path: successorPath,
        continuityPaths: [successorPath],
        historyHash: "synthetic-history",
        host: {
          kind: "codex-app-server",
          identity: successorId,
          epoch: 1,
          verifiedAt: "2026-07-21T00:01:00.000Z",
        },
      };
    },
    async verify() {},
  };

  await advanceConversationMigration(conversation.id, restarted, provider, { deferBoardRepair: true });
  expect(restarted.conversation(conversation.id)).toMatchObject({
    id: conversation.id,
    migration: { phase: "committed", targetId: "seat-active" },
    generations: [
      { id: sourceGeneration.id, path: sourceGeneration.path, accountId: "seat-source", archivedAt: expect.any(String) },
      { id: successorId, path: successorPath, accountId: "seat-active", archivedAt: null },
    ],
  });

  const delivered: string[] = [];
  const delivery = {
    async deliver(input: { delivery: { text: string }; path: string; clientMessageId: string }) {
      delivered.push(input.clientMessageId);
      expect(input).toMatchObject({
        path: successorPath,
        clientMessageId: "restart-safe-account-reseat",
        delivery: { text: "deliver after adoption" },
      });
      return "delivered" as const;
    },
  };
  await drainHeldDeliveries(conversation.id, delivery, restarted);
  await drainHeldDeliveries(conversation.id, delivery, restarted);

  expect(delivered).toEqual(["restart-safe-account-reseat"]);
  expect(Object.values(restarted.snapshot().heldDeliveries)).toMatchObject([{
    clientMessageId: "restart-safe-account-reseat",
    state: "delivered",
    text: "",
    generationId: successorId,
  }]);
});
