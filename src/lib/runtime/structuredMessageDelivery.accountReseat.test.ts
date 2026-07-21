import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, expect, test } from "bun:test";

import { AgentRegistry } from "@/lib/agent/registry";
import { advanceConversationMigration, drainHeldDeliveries } from "@/lib/accounts/migration/coordinator";
import { emptyLaunchProfile, type SuccessorProviderPort, type TurnState } from "@/lib/accounts/migration/contracts";
import type { RuntimeHostClient } from "./client";
import type { RuntimeSnapshot, RuntimeTurnAxis } from "./contracts";
import { runtimeImageCapability } from "./runtimeImageStore";
import type { StructuredImageRef } from "./structuredContent";

import { enqueueStructuredMessage } from "./structuredMessageDelivery";

const artifactPath = "/sessions/native-source.jsonl";
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-account-reseat-"));
const PNG_BASE64 = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489", "hex").toString("base64");
let registryNumber = 0;

afterAll(() => fs.rmSync(sandbox, { recursive: true, force: true }));

function registryWithConversation(
  accountId = "seat-source",
  engine: "codex" | "claude" = "codex",
  turnState: Exclude<TurnState["state"], "terminal"> = "idle",
) {
  const registry = new AgentRegistry(path.join(sandbox, `registry-${registryNumber += 1}.json`));
  registry.reconcileConversations([{
    engine,
    path: artifactPath,
    accountId,
    launchProfile: emptyLaunchProfile({ cwd: "/repo", project: "project" }),
    turn: { state: turnState, source: turnState === "idle" ? "empty" : "assistant", terminalAt: null },
    observedAt: "2026-07-21T00:00:00.000Z",
  }]);
  return { registry, conversation: registry.conversationForPath(artifactPath)! };
}

function snapshot(
  conversationId: string,
  engine: "codex" | "claude" = "codex",
  host: "hosted" | "dead" = "hosted",
  turn: RuntimeTurnAxis = "idle",
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
      turn,
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
      activeTurnId: turn === "running" ? "turn-source" : null,
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

function deliveredClient(
  conversationId: string,
  onCommand: () => void,
  turn: RuntimeTurnAxis = "idle",
): RuntimeHostClient {
  return {
    snapshot: async () => snapshot(conversationId, "codex", "hosted", turn),
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

function recordStructuredOwner(
  registry: AgentRegistry,
  conversation: ReturnType<typeof registryWithConversation>["conversation"],
): void {
  const generation = conversation.generations.at(-1)!;
  registry.upsert({
    key: { engine: conversation.engine, sessionId: generation.id },
    artifactPath: generation.path,
    cwd: generation.launchProfile.cwd,
    accountId: generation.accountId,
    launchProfile: generation.launchProfile,
    status: "idle",
    host: null,
    structuredHost: {
      kind: "codex-app-server",
      endpoint: "stdio:deployment-window",
      process: { pid: 101, startIdentity: "runtime-before-restart" },
      eventCursor: 17,
      protocolVersion: "v2",
      writerClaimEpoch: 4,
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 4,
    claimOwner: "structured-host:runtime-before-restart",
    pendingAction: null,
  });
}

type RuntimeSynchronization = "live" | "absent-client" | "snapshot-failure" | "missing-session";

function synchronizationClient(
  synchronization: RuntimeSynchronization,
  conversationId: string,
  runtimeTurn: RuntimeTurnAxis,
  onCommand: () => void,
): RuntimeHostClient | null {
  switch (synchronization) {
    case "live":
      return deliveredClient(conversationId, onCommand, runtimeTurn);
    case "absent-client":
      return null;
    case "snapshot-failure":
      return { snapshot: async () => { throw new Error("runtime snapshot failed"); } } as unknown as RuntimeHostClient;
    case "missing-session":
      return { snapshot: async () => ({ ...snapshot(conversationId), sessions: [] }) } as unknown as RuntimeHostClient;
  }
}

async function expectWaitingTurnReseatRestart(
  turnState: Extract<TurnState["state"], "busy" | "unknown">,
  synchronization: RuntimeSynchronization = "live",
) {
  const { registry, conversation } = registryWithConversation("seat-source", "codex", turnState);
  registry.setEngineRouting("codex", "seat-active");
  const sourceGeneration = conversation.generations.at(-1)!;
  let predecessorCommands = 0;
  const runtimeTurn = turnState === "busy" ? "running" : "unknown";
  if (synchronization !== "live") recordStructuredOwner(registry, conversation);
  const client = synchronizationClient(
    synchronization,
    conversation.id,
    runtimeTurn,
    () => { predecessorCommands += 1; },
  );
  const clientMessageId = `${synchronization}-${turnState}-account-reseat`;

  const result = await enqueueStructuredMessage({
    path: artifactPath,
    conversationId: conversation.id,
    clientMessageId,
    text: `deliver after ${turnState} turn account adoption`,
  }, {
    enabled: () => true,
    client: () => client,
    registry: () => registry,
    requestMigrationTick: () => {},
    kick: () => {},
  });

  expect(result).toMatchObject({ ok: true, structured: true, target: conversation.id, outcome: "held" });
  expect(predecessorCommands).toBe(0);
  expect(registry.conversation(conversation.id)).toMatchObject({
    id: conversation.id,
    migration: { targetId: "seat-active", phase: "waiting-turn" },
    generations: [{ id: sourceGeneration.id, path: sourceGeneration.path, accountId: "seat-source" }],
  });
  expect(registry.pendingDeliveries(conversation.id)).toMatchObject([{
    clientMessageId,
    state: "held",
    generationId: null,
  }]);

  const restarted = new AgentRegistry(registry.filename);
  const successorId = `native-successor-${turnState}`;
  const successorPath = `/sessions/${successorId}.jsonl`;
  let successorCreates = 0;
  const provider: SuccessorProviderPort = {
    virtualSource: true,
    async create(input) {
      successorCreates += 1;
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
  const successorDeliveries: string[] = [];
  const delivery = {
    async deliver(input: { delivery: { text: string }; path: string; clientMessageId: string }) {
      if (input.path === artifactPath) predecessorCommands += 1;
      else {
        expect(input.path).toBe(successorPath);
        successorDeliveries.push(input.clientMessageId);
      }
      return "delivered" as const;
    },
  };

  await drainHeldDeliveries(conversation.id, delivery, restarted);
  await advanceConversationMigration(conversation.id, restarted, provider, { deferBoardRepair: true });
  expect({ predecessorCommands, successorCreates, successorDeliveries }).toEqual({
    predecessorCommands: 0,
    successorCreates: 0,
    successorDeliveries: [],
  });
  expect(restarted.conversation(conversation.id)?.migration?.phase).toBe("waiting-turn");
  expect(restarted.pendingDeliveries(conversation.id)).toMatchObject([{ clientMessageId, state: "held", generationId: null }]);

  restarted.reconcileConversations([{
    engine: "codex",
    path: artifactPath,
    accountId: "seat-source",
    launchProfile: emptyLaunchProfile({ cwd: "/repo", project: "project" }),
    turn: { state: "idle", source: "assistant", terminalAt: null },
    observedAt: "2026-07-21T00:02:00.000Z",
  }]);
  await advanceConversationMigration(conversation.id, restarted, provider, { deferBoardRepair: true });
  await drainHeldDeliveries(conversation.id, delivery, restarted);
  await drainHeldDeliveries(conversation.id, delivery, restarted);

  expect({ predecessorCommands, successorCreates, successorDeliveries }).toEqual({
    predecessorCommands: 0,
    successorCreates: 1,
    successorDeliveries: [clientMessageId],
  });
  expect(restarted.conversation(conversation.id)).toMatchObject({
    id: conversation.id,
    migration: { targetId: "seat-active", phase: "committed" },
    generations: [
      { id: sourceGeneration.id, path: sourceGeneration.path, accountId: "seat-source", archivedAt: expect.any(String) },
      { id: successorId, path: successorPath, accountId: "seat-active", archivedAt: null },
    ],
  });
}

test("a newly admitted busy-turn reseat stays held through restart and drains once to the successor", async () => {
  await expectWaitingTurnReseatRestart("busy");
});

test("a newly admitted unknown-turn reseat stays held through restart and drains once to the successor", async () => {
  await expectWaitingTurnReseatRestart("unknown");
});

test("an absent runtime client keeps a busy-turn reseat held through restart and drains once to the successor", async () => {
  await expectWaitingTurnReseatRestart("busy", "absent-client");
});

test("an absent runtime client keeps an unknown-turn reseat held through restart and drains once to the successor", async () => {
  await expectWaitingTurnReseatRestart("unknown", "absent-client");
});

test("a failed runtime snapshot keeps a busy-turn reseat held through restart and drains once to the successor", async () => {
  await expectWaitingTurnReseatRestart("busy", "snapshot-failure");
});

test("a failed runtime snapshot keeps an unknown-turn reseat held through restart and drains once to the successor", async () => {
  await expectWaitingTurnReseatRestart("unknown", "snapshot-failure");
});

test("a missing runtime session keeps a busy-turn reseat held through restart and drains once to the successor", async () => {
  await expectWaitingTurnReseatRestart("busy", "missing-session");
});

test("a missing runtime session keeps an unknown-turn reseat held through restart and drains once to the successor", async () => {
  await expectWaitingTurnReseatRestart("unknown", "missing-session");
});

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
  expect(Object.values(registry.snapshot().heldDeliveries)).toHaveLength(1);
});

test("a mismatched-account image rejection leaves migration state untouched", async () => {
  const { registry, conversation } = registryWithConversation();
  registry.setEngineRouting("codex", "seat-active");
  const before = registry.snapshot();
  const imageRef: StructuredImageRef = { sha256: "a".repeat(64), mime: "image/png", bytes: 67 };
  let migrationTicks = 0;

  const result = await enqueueStructuredMessage({
    path: artifactPath,
    conversationId: conversation.id,
    clientMessageId: "rejected-account-reseat-image",
    text: "ambiguous image payload",
    images: [{ base64: PNG_BASE64, mime: "image/png" }],
    imageRefs: [imageRef],
  }, {
    enabled: () => true,
    client: () => ({ snapshot: async () => snapshot(conversation.id) }) as unknown as RuntimeHostClient,
    registry: () => registry,
    requestMigrationTick: () => { migrationTicks += 1; },
  });

  expect(result).toMatchObject({
    ok: false,
    outcome: "failed",
    error: "structured image payload is ambiguous",
  });
  expect(migrationTicks).toBe(0);
  expect(registry.snapshot()).toEqual(before);
});

test("a synchronization idempotency conflict leaves mismatched-account migration state untouched", async () => {
  const { registry, conversation } = registryWithConversation();
  recordStructuredOwner(registry, conversation);
  registry.setEngineRouting("codex", "seat-active");
  registry.holdDelivery(conversation.id, "original payload", "conflicting-account-reseat");
  const before = registry.snapshot();
  let migrationTicks = 0;

  const result = await enqueueStructuredMessage({
    path: artifactPath,
    conversationId: conversation.id,
    clientMessageId: "conflicting-account-reseat",
    text: "changed payload",
  }, {
    enabled: () => true,
    client: () => null,
    registry: () => registry,
    requestMigrationTick: () => { migrationTicks += 1; },
  });

  expect(result).toMatchObject({
    ok: false,
    outcome: "failed",
    status: 409,
    error: "client message id is already reserved for another request",
  });
  expect(migrationTicks).toBe(0);
  expect(registry.snapshot()).toEqual(before);
});

test("synchronization terminal replays leave mismatched-account migration state untouched", async () => {
  for (const terminalState of ["delivered", "failed"] as const) {
    const { registry, conversation } = registryWithConversation();
    recordStructuredOwner(registry, conversation);
    const operationId = `terminal-account-reseat-operation-${terminalState}`;
    const clientMessageId = `terminal-account-reseat-client-${terminalState}`;
    const terminal = registry.holdDelivery(
      conversation.id,
      `already ${terminalState}`,
      clientMessageId,
      "text",
      [],
      null,
      { operationId },
    );
    registry.beginDeliveryAttempt(terminal.id, terminal.generationId!);
    registry.recordDeliveryOutcome(terminal.id, terminalState);
    const compacted = registry.snapshot();
    delete compacted.heldDeliveries[terminal.id];
    fs.writeFileSync(registry.filename, JSON.stringify(compacted));

    const restarted = new AgentRegistry(registry.filename);
    restarted.setEngineRouting("codex", "seat-active");
    const before = restarted.snapshot();
    let migrationTicks = 0;

    const result = await enqueueStructuredMessage({
      path: artifactPath,
      conversationId: conversation.id,
      clientMessageId,
      operationId,
      text: `already ${terminalState}`,
    }, {
      enabled: () => true,
      client: () => null,
      registry: () => restarted,
      requestMigrationTick: () => { migrationTicks += 1; },
    });

    if (terminalState === "delivered") {
      expect(result).toMatchObject({
        ok: true,
        outcome: "delivered",
        operationId,
        receipt: { status: "delivered" },
      });
    } else {
      expect(result).toMatchObject({
        ok: false,
        outcome: "failed",
        status: 409,
        error: "delivery failed",
      });
    }
    expect(migrationTicks).toBe(0);
    expect(restarted.snapshot()).toEqual(before);
  }
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

test("an explicit migration opt-out keeps a synchronization hold assigned to the source account", async () => {
  const { registry, conversation } = registryWithConversation();
  recordStructuredOwner(registry, conversation);
  const sourceGeneration = conversation.generations.at(-1)!;
  const intent = registry.commitMigrationIntent({
    engine: "codex",
    targetId: "seat-active",
    origin: "manual",
    requestId: "synchronization-opt-out-before-send",
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

  const result = await enqueueStructuredMessage({
    path: artifactPath,
    conversationId: conversation.id,
    clientMessageId: "synchronization-opted-out-send",
    text: "stay on the source through synchronization",
  }, {
    enabled: () => true,
    client: () => null,
    registry: () => registry,
    requestMigrationTick: () => {},
  });

  expect(result).toMatchObject({ ok: true, outcome: "held", target: conversation.id });
  expect(migrationRequests).toBe(1);
  expect(registry.conversation(conversation.id)).toMatchObject({
    migration: { phase: "rolled-back", targetId: "seat-active" },
    migrationOptOut: { targetId: "seat-active" },
  });
  expect(registry.pendingDeliveries(conversation.id)).toMatchObject([{
    clientMessageId: "synchronization-opted-out-send",
    state: "assigned",
    generationId: sourceGeneration.id,
  }]);

  const restarted = new AgentRegistry(registry.filename);
  const sourceDeliveries: string[] = [];
  const delivery = {
    async deliver(input: { path: string; clientMessageId: string }) {
      expect(input.path).toBe(artifactPath);
      sourceDeliveries.push(input.clientMessageId);
      return "delivered" as const;
    },
  };
  await drainHeldDeliveries(conversation.id, delivery, restarted);
  await drainHeldDeliveries(conversation.id, delivery, restarted);
  expect(sourceDeliveries).toEqual(["synchronization-opted-out-send"]);
});

test("runtime synchronization preserves an already-claimed source delivery during reseat", async () => {
  const { registry, conversation } = registryWithConversation("seat-source", "codex", "busy");
  recordStructuredOwner(registry, conversation);
  const sourceGeneration = conversation.generations.at(-1)!;
  const claimed = registry.holdDelivery(
    conversation.id,
    "finish the claimed source delivery",
    "synchronization-claimed-source",
  );
  expect(registry.beginDeliveryAttempt(claimed.id, sourceGeneration.id)).toMatchObject({ state: "delivery-uncertain" });
  registry.setEngineRouting("codex", "seat-active");

  const result = await enqueueStructuredMessage({
    path: artifactPath,
    conversationId: conversation.id,
    clientMessageId: "synchronization-claimed-source",
    text: "finish the claimed source delivery",
  }, {
    enabled: () => true,
    client: () => null,
    registry: () => registry,
    requestMigrationTick: () => {},
  });

  expect(result).toMatchObject({ ok: true, outcome: "held", target: conversation.id });
  expect(registry.conversation(conversation.id)?.migration).toMatchObject({ phase: "waiting-turn", targetId: "seat-active" });
  expect(registry.pendingDeliveries(conversation.id)).toMatchObject([{
    id: claimed.id,
    state: "delivery-uncertain",
    generationId: sourceGeneration.id,
    attempts: 1,
  }]);

  const restarted = new AgentRegistry(registry.filename);
  const sourceReconciliations: string[] = [];
  const delivery = {
    async deliver() {
      throw new Error("a claimed source delivery was treated as fresh work");
    },
    async reconcileUncertain(input: { path: string; clientMessageId: string }) {
      expect(input.path).toBe(artifactPath);
      sourceReconciliations.push(input.clientMessageId);
      return "delivered" as const;
    },
  };
  await drainHeldDeliveries(conversation.id, delivery, restarted);
  await drainHeldDeliveries(conversation.id, delivery, restarted);
  expect(sourceReconciliations).toEqual(["synchronization-claimed-source"]);
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
