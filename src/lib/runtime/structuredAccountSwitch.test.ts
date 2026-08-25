import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, expect, test } from "bun:test";

import { advanceConversationMigration } from "@/lib/accounts/migration/coordinator";
import { emptyLaunchProfile, type ProviderReceipt, type SuccessorProviderPort } from "@/lib/accounts/migration/contracts";
import { MigrationTargetUnavailableError } from "@/lib/accounts/migration/safeHistoryCopy";
import { AgentRegistry, type RegistryConversation } from "@/lib/agent/registry";
import type { SessionKey } from "@/lib/agent/sessionKey";
import { setBoardFileForTests } from "@/lib/board/store";
import { procBackend } from "@/lib/proc";

import type { RuntimeHostClient } from "./client";
import type { RuntimeSnapshot, RuntimeTurnAxis } from "./contracts";
import { runtimeImageCapability } from "./runtimeImageStore";
import type { StructuredReconfigureEffect } from "./structuredDeliveryQueue";
import { enqueueStructuredMessage } from "./structuredMessageDelivery";
import { applyStructuredReconfigure } from "./structuredReconfigure";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-structured-account-switch-"));
const PNG_BASE64 = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489", "hex").toString("base64");
let caseNumber = 0;

afterAll(() => fs.rmSync(sandbox, { recursive: true, force: true }));

/** The transcript a completed structured Claude turn actually leaves behind:
    the CLI journals its final assistant record and never writes the `result`
    row the authoritative projection looks for, so nothing in these bytes can
    ever release the turn. */
function claudeTranscript(pathname: string): void {
  fs.writeFileSync(pathname, [
    JSON.stringify({ type: "user", timestamp: "2026-07-21T10:00:00.000Z", message: { role: "user", content: "go" } }),
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-07-21T10:00:26.000Z",
      message: { role: "assistant", model: "claude-opus-5", stop_reason: "end_turn", content: [{ type: "text", text: "worked for 26s" }] },
    }),
  ].join("\n") + "\n");
}

/** The broker process the registry row describes. Structured turn evidence
    only counts while its engine process is verifiably alive, so the fixture
    names this test process. */
function liveProcessIdentity() {
  return { pid: process.pid, startIdentity: procBackend.processIdentity(process.pid) };
}

function recordStructuredHost(
  registry: AgentRegistry,
  key: SessionKey,
  artifactPath: string,
  accountId: string,
  activeTurnRef: string | null,
  status: "live" | "idle" | "dead" = activeTurnRef ? "live" : "idle",
): void {
  registry.upsert({
    key,
    artifactPath,
    cwd: "/repo",
    accountId,
    launchProfile: emptyLaunchProfile({ cwd: "/repo", project: "repo" }),
    status,
    host: null,
    structuredHost: {
      kind: "claude-broker",
      endpoint: "stdio:broker",
      process: liveProcessIdentity(),
      eventCursor: 12,
      protocolVersion: "v1",
      writerClaimEpoch: 1,
      activeTurnRef,
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 1,
    claimOwner: `structured-host:${JSON.stringify(liveProcessIdentity())}`,
    pendingAction: null,
  });
}

function successorProvider(successorPath: string, onCreate?: () => void): SuccessorProviderPort {
  return {
    async create(input): Promise<ProviderReceipt> {
      onCreate?.();
      fs.writeFileSync(successorPath, "");
      return {
        operationId: input.operationId,
        nativeId: "successor-native",
        path: successorPath,
        continuityPaths: [],
        historyHash: "successor-history",
        host: { kind: "claude-stream", identity: "successor-host", epoch: 1, verifiedAt: "2026-07-21T10:01:00.000Z" },
      };
    },
    async verify() {},
  };
}

interface SwitchCase {
  registry: AgentRegistry;
  conversation: RegistryConversation;
  sourceKey: SessionKey;
  sourcePath: string;
  successorPath: string;
  effect: StructuredReconfigureEffect;
  releasedKeys: SessionKey[];
  reconfigure: (provider?: SuccessorProviderPort) => Promise<"applied" | "pending">;
  hostTurn: (activeTurnRef: string | null) => void;
}

/**
 * The reported state: the operator picked another account mid-turn, the
 * structured queue's reconfigure ran, the reseat was recorded — and the switch
 * is sitting in `waiting-turn` behind the running turn.
 */
async function switchRequestedMidTurn(): Promise<SwitchCase> {
  const root = path.join(sandbox, `case-${caseNumber += 1}`);
  fs.mkdirSync(root);
  setBoardFileForTests(path.join(root, "board.json"));
  const registry = new AgentRegistry(path.join(root, "registry.json"));
  const sourcePath = path.join(root, "source.jsonl");
  const successorPath = path.join(root, "successor.jsonl");
  claudeTranscript(sourcePath);
  registry.reconcileConversations([{
    engine: "claude",
    path: sourcePath,
    accountId: "account-a",
    launchProfile: emptyLaunchProfile({ cwd: "/repo", project: "repo" }),
    turn: { state: "busy", source: "assistant", terminalAt: null },
    observedAt: "2026-07-21T10:00:10.000Z",
  }]);
  const admitted = registry.conversationForPath(sourcePath)!;
  const sourceKey: SessionKey = { engine: "claude", sessionId: admitted.generations.at(-1)!.id };
  recordStructuredHost(registry, sourceKey, sourcePath, "account-a", "turn-source");
  const effect: StructuredReconfigureEffect = {
    operationId: "reconfigure-account-switch",
    conversationId: admitted.id,
    kind: "reconfigure",
    model: "claude-opus-5",
    effort: "high",
    fast: false,
    accountId: "account-b",
    eventSeq: 7,
  };
  const releasedKeys: SessionKey[] = [];
  const reconfigure = (provider: SuccessorProviderPort = successorProvider(successorPath)) =>
    applyStructuredReconfigure(effect, {
      registry,
      validateAccount: async () => {},
      resolveAccount: ((engine: string, accountId: string) => ({ accountId, home: root, engine })) as never,
      releaseHost: async (key) => { releasedKeys.push(key); return true; },
      recover: (async () => true) as never,
      migrate: (conversationId, targetAccountId, store, ownsOperation, reconfigureOperationId) =>
        advanceConversationMigration(conversationId, store, provider, {
          ownsOperation,
          reconfigureOperationId,
          deferBoardRepair: true,
        }),
    });
  const hostTurn = (activeTurnRef: string | null) =>
    recordStructuredHost(registry, sourceKey, sourcePath, "account-a", activeTurnRef);

  /* The switch is requested while the turn runs: it records the reseat and
     reports back that it is not done. */
  expect(await reconfigure()).toBe("pending");
  const conversation = registry.conversation(admitted.id)!;
  expect(conversation.migration).toMatchObject({ phase: "waiting-turn", targetId: "account-b" });
  expect(releasedKeys).toEqual([]);

  return { registry, conversation, sourceKey, sourcePath, successorPath, effect, releasedKeys, reconfigure, hostTurn };
}

/** The same pending switch, with no reconfigure owning it: an engine drain or
    the active-account reseat records the migration directly, and the
    coordinator is the only executor. */
async function switchWithoutOwner(): Promise<SwitchCase> {
  const owned = await switchRequestedMidTurn();
  const rebuilt = owned.registry.requestConversationReseat(owned.conversation.id, "account-b");
  owned.registry.settleConversationReconfigure(owned.conversation.id, owned.effect.operationId, owned.effect.eventSeq, "applied");
  expect(rebuilt.migration).toMatchObject({ phase: "waiting-turn", targetId: "account-b" });
  return { ...owned, conversation: owned.registry.conversation(owned.conversation.id)! };
}

function structuredSnapshot(conversation: RegistryConversation, turn: RuntimeTurnAxis, sessions = 1): RuntimeSnapshot {
  const current = conversation.generations.at(-1)!;
  return {
    schemaVersion: 1,
    snapshotSeq: 1,
    retentionFloorSeq: 0,
    serverTime: "2026-07-21T10:00:30.000Z",
    runtime: { hostEpoch: 1, health: "ready" },
    filesRevision: 0,
    sessions: sessions === 0 ? [] : [{
      conversationId: conversation.id,
      sessionKey: { engine: "claude", sessionId: current.id },
      hostKind: "claude-broker",
      host: "hosted",
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
      artifactPath: current.path,
      capabilities: {
        steer: false,
        structuredAttention: true,
        imageInput: runtimeImageCapability("claude", false),
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
  } as unknown as RuntimeSnapshot;
}

function terminatedSource(registry: AgentRegistry, key: SessionKey) {
  return registry.readOnlySnapshot().entries[`${key.engine}:${key.sessionId}`];
}

test("the turn ending executes the switch through the executor that retires the predecessor", async () => {
  const { registry, conversation, sourceKey, successorPath, releasedKeys, reconfigure, hostTurn } = await switchRequestedMidTurn();

  hostTurn(null);
  expect(await reconfigure()).toBe("applied");

  const switched = registry.conversation(conversation.id)!;
  expect(switched.migration?.phase).toBe("committed");
  expect(switched.generations.at(-1)).toMatchObject({ path: successorPath, accountId: "account-b" });
  expect(switched.reconfigure).toMatchObject({ status: "applied" });
  /* The predecessor is not merely archived: its host is released and its
     registry row carries no structured host and no process. */
  expect(releasedKeys).toEqual([sourceKey]);
  expect(terminatedSource(registry, sourceKey)).toMatchObject({ status: "dead", structuredHost: null, claimOwner: null });
});

test("a tick will not commit the switch behind the executor that owns the teardown", async () => {
  const { registry, conversation, sourceKey, successorPath, hostTurn } = await switchRequestedMidTurn();
  hostTurn(null);

  /* The coordinator tick names no reconfigure operation, so it defers. */
  const ticked = await advanceConversationMigration(conversation.id, registry, successorProvider(successorPath), { deferBoardRepair: true });

  expect(ticked.migration?.phase).toBe("waiting-turn");
  expect(ticked.generations.at(-1)?.accountId).toBe("account-a");
  expect(terminatedSource(registry, sourceKey)).toMatchObject({ status: "idle", structuredHost: { activeTurnRef: null } });
});

test("a switch nobody owns still executes when the host reports the turn ended", async () => {
  const { registry, conversation, sourceKey, sourcePath, successorPath, hostTurn } = await switchWithoutOwner();
  hostTurn(null);

  const advanced = await advanceConversationMigration(conversation.id, registry, successorProvider(successorPath), { deferBoardRepair: true });

  expect(advanced.migration?.phase).toBe("committed");
  expect(advanced.generations.at(-1)).toMatchObject({ path: successorPath, accountId: "account-b" });
  expect(sourcePath).toBe(registry.conversation(conversation.id)!.generations.at(-2)!.path);
  expect(terminatedSource(registry, sourceKey)!.structuredHost).not.toBeNull();
});

test("a host still running its turn releases nothing and the switch stays pending", async () => {
  const { registry, conversation, successorPath } = await switchWithoutOwner();

  const advanced = await advanceConversationMigration(conversation.id, registry, successorProvider(successorPath), { deferBoardRepair: true });

  expect(advanced.migration?.phase).toBe("waiting-turn");
  expect(advanced.generations.at(-1)?.accountId).toBe("account-a");
});

test("a host that died is not turn-end evidence", async () => {
  const { registry, conversation, sourceKey, sourcePath, successorPath } = await switchWithoutOwner();
  /* Terminating clears `activeTurnRef` along with the rest of the columns —
     an absent host must not read as a finished turn. */
  recordStructuredHost(registry, sourceKey, sourcePath, "account-a", null, "dead");

  const advanced = await advanceConversationMigration(conversation.id, registry, successorProvider(successorPath), { deferBoardRepair: true });

  expect(advanced.migration?.phase).toBe("waiting-turn");
});

test("a host row left behind by a restart is not turn-end evidence", async () => {
  const { registry, conversation, sourceKey, sourcePath, successorPath } = await switchWithoutOwner();
  /* The row survives a viewer restart with `activeTurnRef: null` — nothing
     recorded a turn on it, which is not the same as a turn ending. */
  registry.upsert({
    key: sourceKey,
    artifactPath: sourcePath,
    cwd: "/repo",
    accountId: "account-a",
    launchProfile: emptyLaunchProfile({ cwd: "/repo", project: "repo" }),
    status: "idle",
    host: null,
    structuredHost: {
      kind: "claude-broker",
      endpoint: "stdio:broker",
      process: { pid: 101, startIdentity: "runtime-before-restart" },
      eventCursor: 12,
      protocolVersion: "v1",
      writerClaimEpoch: 1,
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 1,
    claimOwner: "structured-host:runtime-before-restart",
    pendingAction: null,
  });

  const advanced = await advanceConversationMigration(conversation.id, registry, successorProvider(successorPath), { deferBoardRepair: true });

  expect(advanced.migration?.phase).toBe("waiting-turn");
  expect(advanced.generations.at(-1)?.accountId).toBe("account-a");
});

test("a stuck pre-receipt phase is advanced by the same evidence", async () => {
  const { registry, conversation, successorPath, hostTurn } = await switchWithoutOwner();
  /* A viewer that exited between the phase transition and `create()` leaves
     the migration here, with no provider receipt to show for it. */
  const stuck = registry.transitionConversationMigration(
    conversation.id,
    registry.conversation(conversation.id)!.migration!.revision,
    ["waiting-turn"],
    { phase: "successor-starting" },
  );
  expect(stuck.migration).toMatchObject({ phase: "successor-starting", providerReceipt: null });
  hostTurn(null);

  const advanced = await advanceConversationMigration(conversation.id, registry, successorProvider(successorPath), { deferBoardRepair: true });

  expect(advanced.migration?.phase).toBe("committed");
  expect(advanced.generations.at(-1)).toMatchObject({ path: successorPath, accountId: "account-b" });
});

test("a send forces the pending switch and becomes the successor's first delivery", async () => {
  const { registry, conversation, sourceKey, sourcePath, successorPath, releasedKeys, reconfigure, hostTurn } = await switchRequestedMidTurn();
  hostTurn(null);
  const commands: { conversationId: string; text: string }[] = [];
  let migrationTicks = 0;
  const client = {
    snapshot: async () => structuredSnapshot(registry.conversation(conversation.id)!, "idle"),
    command: async (command: { operationId: string; idempotencyKey: string; conversationId: string; text: string }) => {
      commands.push({ conversationId: command.conversationId, text: command.text });
      return {
        operationId: command.operationId,
        replayed: false,
        receipt: {
          operationId: command.operationId,
          idempotencyKey: command.idempotencyKey,
          conversationId: command.conversationId,
          kind: "send" as const,
          status: "delivered" as const,
          at: "2026-07-21T10:01:00.000Z",
          revision: 1,
        },
      };
    },
  } as unknown as RuntimeHostClient;

  const result = await enqueueStructuredMessage({
    path: sourcePath,
    conversationId: conversation.id,
    clientMessageId: "forced-switch-send",
    text: "continue on the other account",
  }, {
    enabled: () => true,
    client: () => client,
    registry: () => registry,
    requestMigrationTick: () => { migrationTicks += 1; },
    /* What the structured queue's drain does when the send kicks it. */
    kick: async () => { await reconfigure(); },
  });

  expect(result).toMatchObject({ ok: true, outcome: "delivered", target: conversation.id });
  const switched = registry.conversation(conversation.id)!;
  expect(switched.migration?.phase).toBe("committed");
  expect(switched.generations.at(-1)).toMatchObject({ path: successorPath, accountId: "account-b" });
  /* One executor still owned the transition, so the predecessor is gone. */
  expect(releasedKeys).toEqual([sourceKey]);
  expect(terminatedSource(registry, sourceKey)).toMatchObject({ status: "dead", structuredHost: null });
  expect(commands).toEqual([{ conversationId: conversation.id, text: "continue on the other account" }]);
  /* Deliveries held earlier in the same pending window are drained without
     waiting for the controller's poll. */
  expect(migrationTicks).toBeGreaterThan(0);
  expect(Object.values(registry.snapshot().heldDeliveries)).toMatchObject([{
    clientMessageId: "forced-switch-send",
    state: "delivered",
    generationId: "successor-native",
  }]);
});

test("an image send whose successor has no host yet is held durably, never rejected", async () => {
  const { registry, conversation, sourcePath, successorPath, reconfigure, hostTurn } = await switchRequestedMidTurn();
  hostTurn(null);
  let snapshots = 0;
  const client = {
    /* The source is hosted and idle; once the switch commits, the successor's
       host has not published a session yet. */
    snapshot: async () => structuredSnapshot(conversation, "idle", snapshots++ === 0 ? 1 : 0),
    command: async () => { throw new Error("no successor host is published yet"); },
  } as unknown as RuntimeHostClient;

  const result = await enqueueStructuredMessage({
    path: sourcePath,
    conversationId: conversation.id,
    clientMessageId: "forced-switch-image-send",
    text: "look at this",
    images: [{ base64: PNG_BASE64, mime: "image/png" }],
  }, {
    enabled: () => true,
    client: () => client,
    registry: () => registry,
    requestMigrationTick: () => {},
    kick: async () => { await reconfigure(); },
    storeImages: () => [],
  });

  expect(result).toMatchObject({ ok: true, structured: true, outcome: "held" });
  expect(registry.conversation(conversation.id)!.generations.at(-1)).toMatchObject({ path: successorPath, accountId: "account-b" });
  expect(registry.pendingDeliveries(conversation.id)).toMatchObject([{
    clientMessageId: "forced-switch-image-send",
    payloadKind: "runtime-images",
    generationId: "successor-native",
  }]);
});

test("a send during a running turn keeps the promised after-current-turn wait", async () => {
  const { registry, conversation, sourcePath, reconfigure } = await switchRequestedMidTurn();
  let kicks = 0;
  const client = {
    snapshot: async () => structuredSnapshot(registry.conversation(conversation.id)!, "running"),
    command: async () => { throw new Error("the predecessor host received a fenced message"); },
  } as unknown as RuntimeHostClient;

  const result = await enqueueStructuredMessage({
    path: sourcePath,
    conversationId: conversation.id,
    clientMessageId: "mid-turn-send",
    text: "queue this one",
  }, {
    enabled: () => true,
    client: () => client,
    registry: () => registry,
    requestMigrationTick: () => {},
    kick: async () => { kicks += 1; await reconfigure(); },
  });

  expect(result).toMatchObject({ ok: true, outcome: "held" });
  expect(kicks).toBe(0);
  expect(registry.conversation(conversation.id)!.migration?.phase).toBe("waiting-turn");
});

test("a send with no turn evidence keeps waiting instead of tearing a live session down", async () => {
  const { registry, conversation, sourcePath, reconfigure } = await switchRequestedMidTurn();
  let kicks = 0;
  const client = {
    snapshot: async () => structuredSnapshot(registry.conversation(conversation.id)!, "unknown"),
    command: async () => { throw new Error("the predecessor host received a fenced message"); },
  } as unknown as RuntimeHostClient;

  const result = await enqueueStructuredMessage({
    path: sourcePath,
    conversationId: conversation.id,
    clientMessageId: "unknown-turn-send",
    text: "queue this one",
  }, {
    enabled: () => true,
    client: () => client,
    registry: () => registry,
    requestMigrationTick: () => {},
    kick: async () => { kicks += 1; await reconfigure(); },
  });

  expect(result).toMatchObject({ ok: true, outcome: "held" });
  expect(kicks).toBe(0);
  expect(registry.conversation(conversation.id)!.migration?.phase).toBe("waiting-turn");
});

test("a switch that cannot execute surfaces an actionable failure instead of staying pending", async () => {
  const { registry, conversation, hostTurn, reconfigure } = await switchRequestedMidTurn();
  hostTurn(null);
  const unavailable: SuccessorProviderPort = {
    async create(): Promise<ProviderReceipt> {
      throw new MigrationTargetUnavailableError("not-authenticated", "target Claude account is not authenticated");
    },
    async verify() {},
  };

  await expect(reconfigure(unavailable)).rejects.toThrow();

  expect(registry.conversation(conversation.id)!.migration).toMatchObject({
    phase: "failed-recoverable",
    errorCode: "target-account-unavailable",
    error: "target account is not signed in; sign it in or switch to another account",
  });
});
