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
    { enabled: () => true, client: () => null, startupFailed: () => true },
  );

  expect(result).toBeNull();
});

test("structured message routing fences a missing runtime client without startup failure evidence", async () => {
  const result = await enqueueStructuredMessage(
    { path: artifactPath, text: "hello", hasImages: false },
    { enabled: () => true, client: () => null, startupFailed: () => false },
  );

  expect(result).toMatchObject({ ok: false, structured: true, outcome: "failed", status: 503 });
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

test("structured message routing falls through when failed startup adoption leaves the snapshot unavailable", async () => {
  const client = {
    snapshot: async () => { throw new Error("startup adoption failed"); },
  } as unknown as RuntimeHostClient;

  const result = await enqueueStructuredMessage(
    { path: artifactPath, text: "hello", hasImages: false },
    { enabled: () => true, client: () => client, startupFailed: () => true },
  );

  expect(result).toBeNull();
});

test("structured message routing fences a transient snapshot failure", async () => {
  const client = {
    snapshot: async () => { throw new Error("runtime socket timed out"); },
  } as unknown as RuntimeHostClient;

  const result = await enqueueStructuredMessage(
    { path: artifactPath, text: "hello", hasImages: false },
    { enabled: () => true, client: () => client, startupFailed: () => false },
  );

  expect(result).toMatchObject({
    ok: false,
    structured: true,
    outcome: "failed",
    status: 503,
  });
});

test("structured ownership recovery revokes startup-failure fallback authorization", async () => {
  let startupFailed = true;
  let snapshots = 0;
  const client = {
    snapshot: async () => {
      snapshots += 1;
      if (snapshots === 1) return snapshot();
      throw new Error("runtime socket timed out after recovery");
    },
  } as unknown as RuntimeHostClient;
  const dependencies = {
    enabled: () => true,
    client: () => client,
    startupFailed: () => startupFailed,
    startupRecovered: () => { startupFailed = false; },
  };

  expect(await enqueueStructuredMessage(
    { path: artifactPath, text: "observe recovery", hasImages: true },
    dependencies,
  )).toMatchObject({ ok: false, structured: true, status: 409 });
  expect(startupFailed).toBe(false);
  expect(await enqueueStructuredMessage(
    { path: artifactPath, text: "remain fenced", hasImages: false },
    dependencies,
  )).toMatchObject({ ok: false, structured: true, status: 503 });
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

test("dead structured message routing recovers the host before admitting the send", async () => {
  const { registry, conversation } = registryWithConversation();
  const deadSnapshot = snapshot(conversation.id);
  deadSnapshot.sessions[0] = { ...deadSnapshot.sessions[0]!, host: "dead" };
  let recovered = false;
  const commands: unknown[] = [];
  const client = {
    snapshot: async () => deadSnapshot,
    command: async (command: {
      kind: "send";
      operationId?: string;
      idempotencyKey: string;
      conversationId: string;
      text: string;
    }) => {
      commands.push(command);
      return {
        operationId: command.operationId ?? "recovered-send-one",
        replayed: false,
        receipt: {
          operationId: command.operationId ?? "recovered-send-one",
          idempotencyKey: command.idempotencyKey,
          conversationId: command.conversationId,
          kind: command.kind,
          status: recovered ? "queued" as const : "rejected" as const,
          reason: recovered ? null : "dead-host",
          queuePosition: recovered ? 1 : null,
          at: "2026-07-15T00:00:00.000Z",
          revision: 1,
        },
      };
    },
  } as unknown as RuntimeHostClient;

  const result = await enqueueStructuredMessage(
    {
      path: artifactPath,
      conversationId: conversation.id,
      clientMessageId: "recovered-message-one",
      text: "continue after host loss",
      hasImages: false,
    },
    {
      enabled: () => true,
      client: () => client,
      registry: () => registry,
      recover: async () => {
        recovered = true;
        return { target: null, path: artifactPath, conversationId: conversation.id, spawned: true };
      },
      kick: () => {},
    } as never,
  );

  expect(recovered).toBe(true);
  expect(commands).toHaveLength(1);
  expect(result).toMatchObject({
    ok: true,
    structured: true,
    target: null,
    spawned: true,
    outcome: "queued",
    receipt: { idempotencyKey: "recovered-message-one", status: "queued" },
  });
});

test("structured recovery failures remain admitted, avoid delivery, and allow a later retry", async () => {
  const { registry, conversation } = registryWithConversation();
  const deadSnapshot = snapshot(conversation.id);
  deadSnapshot.sessions[0] = { ...deadSnapshot.sessions[0]!, host: "dead" };
  let recoveryAttempts = 0;
  const commands: unknown[] = [];
  const client = {
    snapshot: async () => deadSnapshot,
    command: async (command: unknown) => {
      commands.push(command);
      return {
        operationId: "recovery-retry-message",
        replayed: false,
        receipt: {
          operationId: "recovery-retry-message",
          idempotencyKey: "recovery-retry-message",
          conversationId: conversation.id,
          kind: "send" as const,
          status: "queued" as const,
          queuePosition: 1,
          at: "2026-07-15T00:00:00.000Z",
          revision: 1,
        },
      };
    },
  } as unknown as RuntimeHostClient;
  const dependencies = {
    enabled: () => true,
    client: () => client,
    registry: () => registry,
    recover: async () => {
      recoveryAttempts += 1;
      if (recoveryAttempts === 1) throw new Error("recovery spawn failed");
      return { target: null, path: artifactPath, conversationId: conversation.id, spawned: true };
    },
    kick: () => {},
  } as never;
  const request = {
    path: artifactPath,
    conversationId: conversation.id,
    clientMessageId: "recovery-retry-message",
    text: "retain this draft through recovery failure",
    hasImages: false,
  };

  await expect(enqueueStructuredMessage(request, dependencies)).resolves.toMatchObject({
    ok: false,
    structured: true,
    outcome: "failed",
    status: 503,
  });
  expect(commands).toEqual([]);
  expect(registry.pendingDeliveries(conversation.id)).toEqual([]);

  await expect(enqueueStructuredMessage(request, dependencies)).resolves.toMatchObject({
    ok: true,
    structured: true,
    spawned: true,
    outcome: "queued",
  });
  expect(commands).toHaveLength(1);
});

test("structured ownership stays fenced while its registry projection is missing", async () => {
  const client = {
    snapshot: async () => snapshot(),
  } as unknown as RuntimeHostClient;
  const { registry } = registryWithConversation("missing-projection");

  const result = await enqueueStructuredMessage(
    { path: artifactPath, conversationId, text: "stay structured", hasImages: false },
    {
      enabled: () => true,
      client: () => client,
      registry: () => new AgentRegistry(path.join(path.dirname(registry.filename), "missing.json")),
    },
  );

  expect(result).toMatchObject({ ok: false, structured: true, outcome: "failed", status: 503 });
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

  expect(command).toMatchObject({
    conversationId: conversation.id,
    text: "hello",
    idempotencyKey: "message-one",
    policy: "interrupt-active",
  });
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
    policy: "interrupt-active",
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
    startupFailed: () => true,
  })).toBeNull();
  expect(await deliverHeldStructuredMessage(request, {
    enabled: () => true,
    client: () => missingSessionClient,
  })).toBeNull();
});

test("held delivery fences a missing runtime client without startup failure evidence", async () => {
  expect(await deliverHeldStructuredMessage({
    conversationId,
    path: artifactPath,
    deliveryId: "held-missing-client",
    clientMessageId: "held-missing-client-message",
    text: "stay fenced",
  }, {
    enabled: () => true,
    client: () => null,
    startupFailed: () => false,
  })).toBe("delivery-uncertain");
});

test("held delivery stays uncertain during a transient structured snapshot failure", async () => {
  const client = {
    snapshot: async () => { throw new Error("runtime socket timed out"); },
  } as unknown as RuntimeHostClient;

  expect(await deliverHeldStructuredMessage({
    conversationId,
    path: artifactPath,
    deliveryId: "held-transient-snapshot",
    clientMessageId: "held-transient-snapshot-message",
    text: "stay fenced",
  }, {
    enabled: () => true,
    client: () => client,
    startupFailed: () => false,
  })).toBe("delivery-uncertain");
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
