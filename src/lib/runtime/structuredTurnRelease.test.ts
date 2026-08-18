import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, expect, test } from "bun:test";

import { advanceConversationMigration } from "@/lib/accounts/migration/coordinator";
import { emptyLaunchProfile, type ProviderReceipt, type SuccessorProviderPort } from "@/lib/accounts/migration/contracts";
import { MigrationTargetUnavailableError } from "@/lib/accounts/migration/safeHistoryCopy";
import { AgentRegistry, type RegistryConversation } from "@/lib/agent/registry";
import { setBoardFileForTests } from "@/lib/board/store";

import type { RuntimeHostClient } from "./client";
import type { RuntimeSnapshot, RuntimeTurnAxis } from "./contracts";
import { runtimeImageCapability } from "./runtimeImageStore";
import { enqueueStructuredMessage } from "./structuredMessageDelivery";
import { releaseStructuredTurnForPendingSwitch } from "./structuredTurnRelease";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-structured-turn-release-"));
let caseNumber = 0;

afterAll(() => fs.rmSync(sandbox, { recursive: true, force: true }));

/** The transcript a completed structured Claude turn actually leaves behind:
    the CLI journals its final assistant record and never writes the `result`
    row the authoritative projection looks for. */
function claudeTranscript(pathname: string, extra: string[] = []): void {
  fs.writeFileSync(pathname, [
    JSON.stringify({ type: "user", timestamp: "2026-07-21T10:00:00.000Z", message: { role: "user", content: "go" } }),
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-07-21T10:00:26.000Z",
      message: { role: "assistant", model: "claude-opus-5", stop_reason: "end_turn", content: [{ type: "text", text: "worked for 26s" }] },
    }),
    ...extra,
  ].join("\n") + "\n");
}

interface PendingSwitch {
  registry: AgentRegistry;
  conversation: RegistryConversation;
  sourcePath: string;
  successorPath: string;
}

/** A structured Claude conversation whose account switch was requested while
    the turn was still running, and whose turn has since ended. */
function pendingSwitchMidTurn(): PendingSwitch {
  const root = path.join(sandbox, `case-${caseNumber += 1}`);
  fs.mkdirSync(root);
  setBoardFileForTests(path.join(root, "board.json"));
  const registry = new AgentRegistry(path.join(root, "registry.json"));
  const sourcePath = path.join(root, "source.jsonl");
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
  const conversation = registry.requestConversationReseat(admitted.id, "account-b");
  expect(conversation.migration).toMatchObject({ phase: "waiting-turn", targetId: "account-b" });
  return { registry, conversation, sourcePath, successorPath: path.join(root, "successor.jsonl") };
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

function structuredSnapshot(conversation: RegistryConversation, turn: RuntimeTurnAxis): RuntimeSnapshot {
  const current = conversation.generations.at(-1)!;
  return {
    schemaVersion: 1,
    snapshotSeq: 1,
    retentionFloorSeq: 0,
    serverTime: "2026-07-21T10:00:30.000Z",
    runtime: { hostEpoch: 1, health: "ready" },
    filesRevision: 0,
    sessions: [{
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

test("a structured turn end executes the pending switch with no further transcript events", async () => {
  const { registry, conversation, successorPath } = pendingSwitchMidTurn();
  const provider = successorProvider(successorPath);

  /* The transcript alone never releases a pane-less structured turn, so the
     switch that waits on it stays pending forever (issue #1028). */
  const stalled = await advanceConversationMigration(conversation.id, registry, provider, { deferBoardRepair: true });
  expect(stalled.migration?.phase).toBe("waiting-turn");

  expect(releaseStructuredTurnForPendingSwitch(conversation.id, { registry })).toBe(true);
  const advanced = await advanceConversationMigration(conversation.id, registry, provider, { deferBoardRepair: true });

  expect(advanced.migration?.phase).toBe("committed");
  expect(advanced.generations.at(-1)).toMatchObject({ path: successorPath, accountId: "account-b" });
});

test("a source turn that started again keeps its busy projection and holds the switch", async () => {
  const { registry, conversation, sourcePath, successorPath } = pendingSwitchMidTurn();
  expect(releaseStructuredTurnForPendingSwitch(conversation.id, { registry })).toBe(true);

  claudeTranscript(sourcePath, [JSON.stringify({ type: "user", timestamp: "2026-07-21T10:02:00.000Z", message: { role: "user", content: "one more thing" } })]);
  const future = Date.now() + 60_000;
  fs.utimesSync(sourcePath, future / 1000, future / 1000);

  const advanced = await advanceConversationMigration(conversation.id, registry, successorProvider(successorPath), { deferBoardRepair: true });
  expect(advanced.migration?.phase).toBe("requested");
  expect(advanced.generations.at(-1)?.accountId).toBe("account-a");
});

test("a send arriving while the switch is pending forces it and becomes the successor's first delivery", async () => {
  const { registry, conversation, successorPath } = pendingSwitchMidTurn();
  const commands: { conversationId: string; text: string }[] = [];
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
    path: registry.conversation(conversation.id)!.generations.at(-1)!.path,
    conversationId: conversation.id,
    clientMessageId: "forced-switch-send",
    text: "continue on the other account",
  }, {
    enabled: () => true,
    client: () => client,
    registry: () => registry,
    requestMigrationTick: () => {},
    kick: () => {},
    executeSwitch: (conversationId, store) => advanceConversationMigration(
      conversationId,
      store,
      successorProvider(successorPath),
      { deferBoardRepair: true },
    ),
  });

  expect(result).toMatchObject({ ok: true, outcome: "delivered", target: conversation.id });
  const switched = registry.conversation(conversation.id)!;
  expect(switched.migration?.phase).toBe("committed");
  expect(switched.generations.at(-1)).toMatchObject({ path: successorPath, accountId: "account-b" });
  expect(commands).toEqual([{ conversationId: conversation.id, text: "continue on the other account" }]);
  /* The reservation settles against the successor generation — the operator's
     message was never left queued behind the switch, so nothing has to be
     sent again. Delivered reservations retire their text. */
  expect(Object.values(registry.snapshot().heldDeliveries)).toMatchObject([{
    clientMessageId: "forced-switch-send",
    state: "delivered",
    generationId: "successor-native",
  }]);
});

test("a send during a running turn keeps the promised after-current-turn wait", async () => {
  const { registry, conversation, sourcePath } = pendingSwitchMidTurn();
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
  });

  expect(result).toMatchObject({ ok: true, outcome: "held" });
  expect(registry.conversation(conversation.id)!.turn).toMatchObject({ state: "busy" });
});

test("a send with no turn evidence keeps waiting instead of tearing a live session down", async () => {
  const { registry, conversation, successorPath } = pendingSwitchMidTurn();
  let switches = 0;
  const client = {
    snapshot: async () => structuredSnapshot(registry.conversation(conversation.id)!, "unknown"),
    command: async () => { throw new Error("the predecessor host received a fenced message"); },
  } as unknown as RuntimeHostClient;

  const result = await enqueueStructuredMessage({
    path: registry.conversation(conversation.id)!.generations.at(-1)!.path,
    conversationId: conversation.id,
    clientMessageId: "unknown-turn-send",
    text: "queue this one",
  }, {
    enabled: () => true,
    client: () => client,
    registry: () => registry,
    requestMigrationTick: () => {},
    executeSwitch: (conversationId, store) => {
      switches += 1;
      return advanceConversationMigration(conversationId, store, successorProvider(successorPath), { deferBoardRepair: true });
    },
  });

  expect(result).toMatchObject({ ok: true, outcome: "held" });
  expect(switches).toBe(0);
  expect(registry.conversation(conversation.id)!.migration?.phase).toBe("waiting-turn");
});

test("a switch that cannot execute surfaces an actionable failure instead of staying pending", async () => {
  const { registry, conversation } = pendingSwitchMidTurn();
  expect(releaseStructuredTurnForPendingSwitch(conversation.id, { registry })).toBe(true);
  const provider: SuccessorProviderPort = {
    async create(): Promise<ProviderReceipt> { throw new MigrationTargetUnavailableError("not-authenticated", "target Claude account is not authenticated"); },
    async verify() {},
  };

  const advanced = await advanceConversationMigration(conversation.id, registry, provider, { deferBoardRepair: true });

  expect(advanced.migration).toMatchObject({
    phase: "failed-recoverable",
    errorCode: "target-account-unavailable",
    error: "target account is not signed in; sign it in or switch to another account",
  });
});

test("a release is refused for a conversation with no switch waiting on its turn", () => {
  const { registry, conversation } = pendingSwitchMidTurn();
  registry.rollbackConversationMigration(conversation.id, conversation.migration!.revision);

  expect(releaseStructuredTurnForPendingSwitch(conversation.id, { registry })).toBe(false);
  expect(registry.conversation(conversation.id)!.turn).toMatchObject({ state: "busy" });
});
