import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "bun:test";

import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { AgentRegistry } from "@/lib/agent/registry";

import {
  collectHandoffCandidates,
  HandoffQueue,
  InMemoryHandoffQueueStore,
  type HandoffCandidateSnapshot,
  type HandoffRowInput,
} from "./handoffQueue";

function rowInput(overrides: Partial<HandoffRowInput> = {}): HandoffRowInput {
  return {
    operationId: overrides.operationId ?? "handoff_root_1",
    conversationId: overrides.conversationId ?? "conversation_root",
    engine: overrides.engine ?? "codex",
    engineSessionId: overrides.engineSessionId ?? "session_root",
    kind: overrides.kind ?? "root",
    parentConversationId: overrides.parentConversationId ?? null,
    hostGeneration: overrides.hostGeneration ?? "gen-blue",
    accountId: overrides.accountId ?? "acct-a",
    turnState: overrides.turnState ?? "idle",
    pendingDeliveries: overrides.pendingDeliveries ?? [],
  };
}

function queue(): { store: InMemoryHandoffQueueStore; q: HandoffQueue } {
  const store = new InMemoryHandoffQueueStore();
  return { store, q: new HandoffQueue(store) };
}

describe("handoff queue enqueue (protocol step 1)", () => {
  test("persists conversation identity, engine session, generation, account, turn state and ordered deliveries", () => {
    const { q } = queue();
    q.enqueue([rowInput({
      turnState: "busy",
      pendingDeliveries: [
        { deliveryId: "d2", clientMessageId: "c2", seq: 2 },
        { deliveryId: "d1", clientMessageId: "c1", seq: 1 },
      ],
    })]);
    const row = q.row("handoff_root_1")!;
    expect(row.conversationId).toBe("conversation_root");
    expect(row.engineSessionId).toBe("session_root");
    expect(row.hostGeneration).toBe("gen-blue");
    expect(row.accountId).toBe("acct-a");
    expect(row.turnState).toBe("busy");
    expect(row.status).toBe("pending");
    // Deliveries are stored in ascending seq order regardless of enqueue order.
    expect(row.pendingDeliveries.map((d) => d.deliveryId)).toEqual(["d1", "d2"]);
  });

  test("is idempotent by operation id and never duplicates a conversation card", () => {
    const { q } = queue();
    q.enqueue([rowInput()]);
    q.beginDrain("gen-blue");
    // A repeated pre-promotion snapshot must not reset drain state or fan out a second row.
    q.enqueue([rowInput()]);
    expect(q.rows()).toHaveLength(1);
    expect(q.row("handoff_root_1")!.status).toBe("draining");
  });
});

describe("handoff queue draining (protocol step 3)", () => {
  test("moves the outgoing generation rows to draining and stops admitting new hosts", () => {
    const { q } = queue();
    q.enqueue([rowInput()]);
    expect(q.isAdmittingNewHosts("gen-blue")).toBe(true);
    q.beginDrain("gen-blue");
    expect(q.row("handoff_root_1")!.status).toBe("draining");
    expect(q.isAdmittingNewHosts("gen-blue")).toBe(false);
  });

  test("accepts new UI messages into the durable queue while draining", () => {
    const { q } = queue();
    q.enqueue([rowInput({ pendingDeliveries: [{ deliveryId: "d1", clientMessageId: "c1", seq: 1 }] })]);
    q.beginDrain("gen-blue");
    const admitted = q.admitMessage("handoff_root_1", { deliveryId: "d2", clientMessageId: "c2", seq: 2 });
    expect(admitted).toBe(true);
    expect(q.row("handoff_root_1")!.pendingDeliveries.map((d) => d.deliveryId)).toEqual(["d1", "d2"]);
  });

  test("persists a fenced busy-to-terminal refresh across restart", () => {
    const store = new InMemoryHandoffQueueStore();
    const outgoing = new HandoffQueue(store);
    outgoing.enqueue([rowInput({ turnState: "busy" })]);
    outgoing.beginDrain("gen-blue");
    expect(outgoing.refreshTurnState("handoff_root_1", "gen-stale", "terminal")).toBe(false);
    expect(outgoing.refreshTurnState("handoff_root_1", "gen-blue", "terminal")).toBe(true);

    const successor = new HandoffQueue(store);
    const claimed = successor.claim("handoff_root_1", { fromGeneration: "gen-blue", toGeneration: "gen-green" });
    expect(claimed.row).toMatchObject({
      turnState: "terminal",
      status: "terminal",
      interruptionOutcome: "completed",
    });
  });
});

describe("handoff queue lease handoff (protocol step 4 CAS fence)", () => {
  test("idle root: successor claims the same identity and replays queued messages in order", () => {
    const { q } = queue();
    q.enqueue([rowInput({
      pendingDeliveries: [
        { deliveryId: "d1", clientMessageId: "c1", seq: 1 },
        { deliveryId: "d2", clientMessageId: "c2", seq: 2 },
      ],
    })]);
    q.beginDrain("gen-blue");
    const result = q.claim("handoff_root_1", { fromGeneration: "gen-blue", toGeneration: "gen-green" });
    expect(result.ok).toBe(true);
    expect(result.replay.map((d) => d.deliveryId)).toEqual(["d1", "d2"]);
    const row = q.row("handoff_root_1")!;
    expect(row.status).toBe("claimed");
    expect(row.hostGeneration).toBe("gen-green");
    // Terminal predecessor -> successor link is recorded.
    expect(row.predecessorGeneration).toBe("gen-blue");
    expect(row.successorGeneration).toBe("gen-green");
  });

  test("busy root at drain deadline resumes from the durable transcript with an interruption outcome", () => {
    const { q } = queue();
    q.enqueue([rowInput({
      turnState: "busy",
      pendingDeliveries: [{ deliveryId: "d1", clientMessageId: "c1", seq: 1 }],
    })]);
    q.beginDrain("gen-blue");
    const result = q.claim("handoff_root_1", { fromGeneration: "gen-blue", toGeneration: "gen-green" });
    expect(result.ok).toBe(true);
    expect(result.replay.map((d) => d.deliveryId)).toEqual(["d1"]);
    expect(q.row("handoff_root_1")!.interruptionOutcome).toBe("interrupted");
  });

  test("completed turn hands off normally to a terminal row", () => {
    const { q } = queue();
    q.enqueue([rowInput({ turnState: "terminal" })]);
    const result = q.claim("handoff_root_1", { fromGeneration: "gen-blue", toGeneration: "gen-green" });
    expect(result.ok).toBe(true);
    expect(q.row("handoff_root_1")!.status).toBe("terminal");
    expect(q.row("handoff_root_1")!.interruptionOutcome).toBe("completed");
  });

  test("rejects a claim whose fromGeneration does not match the fenced host generation", () => {
    const { q } = queue();
    q.enqueue([rowInput()]);
    const result = q.claim("handoff_root_1", { fromGeneration: "gen-stale", toGeneration: "gen-green" });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("generation-fence");
    expect(q.row("handoff_root_1")!.status).toBe("pending");
  });
});

describe("engine-native child recovery (parent survives)", () => {
  test("a child thread is claimed independently while its parent row is left untouched", () => {
    const { q } = queue();
    q.enqueue([
      rowInput({ operationId: "handoff_parent", conversationId: "conversation_parent", engineSessionId: "session_parent" }),
      rowInput({
        operationId: "handoff_child",
        conversationId: "conversation_child",
        engineSessionId: "session_child",
        kind: "engine-native-child",
        parentConversationId: "conversation_parent",
        pendingDeliveries: [{ deliveryId: "dc1", clientMessageId: "cc1", seq: 1 }],
      }),
    ]);
    q.beginDrain("gen-blue");
    const child = q.claim("handoff_child", { fromGeneration: "gen-blue", toGeneration: "gen-green" });
    expect(child.ok).toBe(true);
    expect(child.replay.map((d) => d.deliveryId)).toEqual(["dc1"]);
    expect(q.row("handoff_child")!.status).toBe("claimed");
    expect(q.row("handoff_child")!.parentConversationId).toBe("conversation_parent");
    // Parent is a distinct row and must not be transferred by the child claim.
    expect(q.row("handoff_parent")!.status).toBe("draining");
    expect(q.row("handoff_parent")!.hostGeneration).toBe("gen-blue");
  });
});

describe("multi-project promotion with independent accounts", () => {
  test("each conversation transfers on its own identity and account", () => {
    const { q } = queue();
    q.enqueue([
      rowInput({ operationId: "h1", conversationId: "conversation_a", engineSessionId: "s_a", accountId: "acct-a" }),
      rowInput({ operationId: "h2", conversationId: "conversation_b", engineSessionId: "s_b", accountId: "acct-b", engine: "claude" }),
    ]);
    q.beginDrain("gen-blue");
    expect(q.claim("h1", { fromGeneration: "gen-blue", toGeneration: "gen-green" }).ok).toBe(true);
    expect(q.claim("h2", { fromGeneration: "gen-blue", toGeneration: "gen-green" }).ok).toBe(true);
    expect(q.row("h1")!.accountId).toBe("acct-a");
    expect(q.row("h2")!.accountId).toBe("acct-b");
    expect(q.row("h2")!.engine).toBe("claude");
  });
});

describe("candidate health failure and rollback (protocol step 6)", () => {
  test("a failed candidate releases its claimed rows back to the outgoing generation", () => {
    const { q } = queue();
    q.enqueue([rowInput({ pendingDeliveries: [{ deliveryId: "d1", clientMessageId: "c1", seq: 1 }] })]);
    q.beginDrain("gen-blue");
    q.claim("handoff_root_1", { fromGeneration: "gen-blue", toGeneration: "gen-green" });
    // Reaching `claimed` is the retirement boundary for the outgoing generation.
    expect(q.retirable("gen-blue")).toBe(true);

    q.failCandidate("gen-green");
    const row = q.row("handoff_root_1")!;
    expect(row.hostGeneration).toBe("gen-blue");
    expect(row.status).toBe("draining");
    expect(row.successorGeneration).toBeNull();
    // Rollback keeps the outgoing generation available: it is no longer retirable.
    expect(q.retirable("gen-blue")).toBe(false);
    // The reverted delivery is queued again for the next candidate — no silent loss.
    const retry = q.claim("handoff_root_1", { fromGeneration: "gen-blue", toGeneration: "gen-green-2" });
    expect(retry.ok).toBe(true);
    expect(retry.replay.map((d) => d.deliveryId)).toEqual(["d1"]);
  });

  test("rollback preserves acknowledgements inherited from earlier promotions", () => {
    const { q } = queue();
    const delivery = (deliveryId: string, seq: number) => ({
      deliveryId,
      clientMessageId: `client-${deliveryId}`,
      seq,
    });

    q.enqueue([rowInput({
      operationId: "handoff_blue",
      pendingDeliveries: [delivery("d1", 1)],
    })]);
    q.beginDrain("gen-blue");
    q.claim("handoff_blue", { fromGeneration: "gen-blue", toGeneration: "gen-green" });
    expect(q.acknowledgeReplay("handoff_blue", "gen-green", ["d1"])).toBe(true);

    q.enqueue([rowInput({
      operationId: "handoff_green",
      hostGeneration: "gen-green",
      pendingDeliveries: [delivery("d1", 1), delivery("d2", 2)],
    })]);
    q.beginDrain("gen-green");
    q.claim("handoff_green", { fromGeneration: "gen-green", toGeneration: "gen-teal" });
    expect(q.acknowledgeReplay("handoff_green", "gen-teal", ["d2"])).toBe(true);

    q.failCandidate("gen-teal");
    expect(q.claim("handoff_green", {
      fromGeneration: "gen-green",
      toGeneration: "gen-teal-retry",
    }).replay.map(({ deliveryId }) => deliveryId)).toEqual(["d2"]);
    expect(q.acknowledgeReplay("handoff_green", "gen-teal-retry", ["d2"])).toBe(true);

    q.enqueue([rowInput({
      operationId: "handoff_teal",
      hostGeneration: "gen-teal-retry",
      pendingDeliveries: [delivery("d1", 1), delivery("d2", 2), delivery("d3", 3)],
    })]);
    q.beginDrain("gen-teal-retry");
    expect(q.claim("handoff_teal", {
      fromGeneration: "gen-teal-retry",
      toGeneration: "gen-purple",
    }).replay.map(({ deliveryId }) => deliveryId)).toEqual(["d3"]);
  });

  test("outgoing generation is only retirable once every row is claimed, terminal, or explicitly failed", () => {
    const { q } = queue();
    q.enqueue([
      rowInput({ operationId: "h1", conversationId: "conversation_a", engineSessionId: "s_a" }),
      rowInput({ operationId: "h2", conversationId: "conversation_b", engineSessionId: "s_b" }),
    ]);
    q.beginDrain("gen-blue");
    q.claim("h1", { fromGeneration: "gen-blue", toGeneration: "gen-green" });
    expect(q.retirable("gen-blue")).toBe(false);
    q.markRetryableFailure("h2", "resume unavailable");
    expect(q.retirable("gen-blue")).toBe(true);
  });
});

describe("crash during lease transfer and idempotent replay", () => {
  test("a restart before delivery acknowledgement offers the replay again", () => {
    const store = new InMemoryHandoffQueueStore();
    const first = new HandoffQueue(store);
    first.enqueue([rowInput({ pendingDeliveries: [{ deliveryId: "d1", clientMessageId: "c1", seq: 1 }] })]);
    first.beginDrain("gen-blue");
    const initial = first.claim("handoff_root_1", { fromGeneration: "gen-blue", toGeneration: "gen-green" });
    expect(initial.replay.map((d) => d.deliveryId)).toEqual(["d1"]);

    // The successor crashes after claiming ownership and before delivering d1.
    const successor = new HandoffQueue(store);
    const replayAgain = successor.claim("handoff_root_1", { fromGeneration: "gen-blue", toGeneration: "gen-green" });
    expect(replayAgain.ok).toBe(true);
    expect(replayAgain.replay.map((delivery) => delivery.deliveryId)).toEqual(["d1"]);
    expect(successor.rows()).toHaveLength(1);
  });

  test("a restart midway through a replay offers only deliveries awaiting acknowledgement", () => {
    const store = new InMemoryHandoffQueueStore();
    const first = new HandoffQueue(store);
    first.enqueue([rowInput({ pendingDeliveries: [
      { deliveryId: "d1", clientMessageId: "c1", seq: 1 },
      { deliveryId: "d2", clientMessageId: "c2", seq: 2 },
    ] })]);
    first.beginDrain("gen-blue");
    const claimed = first.claim("handoff_root_1", { fromGeneration: "gen-blue", toGeneration: "gen-green" });
    expect(claimed.replay.map((delivery) => delivery.deliveryId)).toEqual(["d1", "d2"]);

    expect(first.acknowledgeReplay("handoff_root_1", "gen-green", ["d1"])).toBe(true);

    const successor = new HandoffQueue(store);
    const remaining = successor.claim("handoff_root_1", { fromGeneration: "gen-blue", toGeneration: "gen-green" });
    expect(remaining.replay.map((delivery) => delivery.deliveryId)).toEqual(["d2"]);
  });

  test("a restart after delivery acknowledgement keeps the replay complete", () => {
    const store = new InMemoryHandoffQueueStore();
    const first = new HandoffQueue(store);
    first.enqueue([rowInput({
      pendingDeliveries: [{ deliveryId: "d1", clientMessageId: "c1", seq: 1 }],
    })]);
    first.beginDrain("gen-blue");
    first.claim("handoff_root_1", { fromGeneration: "gen-blue", toGeneration: "gen-green" });
    expect(first.acknowledgeReplay("handoff_root_1", "gen-stale", ["d1"])).toBe(false);
    expect(first.acknowledgeReplay("handoff_root_1", "gen-green", ["d1"])).toBe(true);

    const successor = new HandoffQueue(store);
    const complete = successor.claim("handoff_root_1", { fromGeneration: "gen-blue", toGeneration: "gen-green" });
    expect(complete.replay).toEqual([]);
  });
});

describe("repeated deploy/restart without duplicate turns or cards", () => {
  test("sequential promotions replay only new deliveries and keep a single card", () => {
    const store = new InMemoryHandoffQueueStore();
    const q = new HandoffQueue(store);
    q.enqueue([rowInput({ pendingDeliveries: [{ deliveryId: "d1", clientMessageId: "c1", seq: 1 }] })]);
    q.beginDrain("gen-blue");
    expect(q.claim("handoff_root_1", { fromGeneration: "gen-blue", toGeneration: "gen-green" }).replay.map((d) => d.deliveryId)).toEqual(["d1"]);
    expect(q.acknowledgeReplay("handoff_root_1", "gen-green", ["d1"])).toBe(true);

    // Second deploy: a new user message arrives, then green -> teal promotion.
    q.admitMessage("handoff_root_1", { deliveryId: "d2", clientMessageId: "c2", seq: 2 });
    q.beginDrain("gen-green");
    // Draining the now-outgoing generation makes its already-claimed row block
    // retirement again until the teal successor owns it.
    expect(q.row("handoff_root_1")!.status).toBe("draining");
    expect(q.retirable("gen-green")).toBe(false);
    const second = q.claim("handoff_root_1", { fromGeneration: "gen-green", toGeneration: "gen-teal" });
    expect(second.replay.map((d) => d.deliveryId)).toEqual(["d2"]);
    expect(q.retirable("gen-green")).toBe(true);
    expect(q.rows()).toHaveLength(1);
  });

  test("collect-claim-collect-claim keeps one active lease and replays only new deliveries", () => {
    const promotionSnapshot = (identity: string, epoch: number, deliveryId: string): HandoffCandidateSnapshot => ({
      conversations: {
        conversation_root: {
          id: "conversation_root",
          engine: "codex",
          supersededBy: null,
          turn: { state: "idle" },
          generations: [{
            id: "session_root",
            accountId: "acct-a",
            host: { identity, epoch },
          }],
        },
      },
      entries: {
        "codex:session_root": { structuredHost: { kind: "codex-app-server" }, accountId: "acct-a" },
      },
      lineageEdges: {},
      heldDeliveries: {
        [deliveryId]: { conversationId: "conversation_root", state: "held", createdAt: `2026-01-01T00:00:0${epoch}Z` },
      },
    });

    const { q } = queue();
    const firstInput = collectHandoffCandidates(promotionSnapshot("host-blue", 1, "d1"))[0]!;
    q.enqueue([firstInput]);
    q.beginDrain(firstInput.hostGeneration);
    const first = q.claim(firstInput.operationId, {
      fromGeneration: firstInput.hostGeneration,
      toGeneration: "host-green:2",
    });
    expect(first.replay.map((delivery) => delivery.deliveryId)).toEqual(["d1"]);
    expect(q.acknowledgeReplay(firstInput.operationId, "host-green:2", ["d1"])).toBe(true);

    const secondSnapshot = promotionSnapshot("host-green", 2, "d2");
    secondSnapshot.heldDeliveries.d1 = {
      conversationId: "conversation_root",
      state: "held",
      createdAt: "2026-01-01T00:00:01Z",
    };
    const secondInput = collectHandoffCandidates(secondSnapshot)[0]!;
    q.enqueue([secondInput]);
    expect(q.rows()).toHaveLength(1);
    expect(q.history()).toEqual([expect.objectContaining({
      operationId: firstInput.operationId,
      predecessorGeneration: firstInput.hostGeneration,
      successorGeneration: "host-green:2",
      status: "claimed",
    })]);

    q.beginDrain(secondInput.hostGeneration);
    const second = q.claim(secondInput.operationId, {
      fromGeneration: secondInput.hostGeneration,
      toGeneration: "host-teal:3",
    });
    expect(second.replay.map((delivery) => delivery.deliveryId)).toEqual(["d2"]);
  });
});

describe("collectHandoffCandidates registry projection", () => {
  function snapshot(): HandoffCandidateSnapshot {
    return {
      conversations: {
        conversation_root: {
          id: "conversation_root",
          engine: "codex",
          supersededBy: null,
          turn: { state: "busy" },
          generations: [{
            id: "session_root",
            accountId: "acct-a",
            host: { identity: "codex-app-server-7", epoch: 3 },
          }],
        },
        conversation_child: {
          id: "conversation_child",
          engine: "codex",
          supersededBy: null,
          turn: { state: "idle" },
          generations: [{
            id: "session_child",
            accountId: "acct-a",
            host: { identity: "codex-app-server-7", epoch: 3 },
          }],
        },
        conversation_dead: {
          id: "conversation_dead",
          engine: "codex",
          supersededBy: null,
          turn: { state: "terminal" },
          generations: [{ id: "session_dead", accountId: "acct-a", host: null }],
        },
        conversation_gone: {
          id: "conversation_gone",
          engine: "codex",
          supersededBy: { conversationId: "conversation_root", at: "x", reason: "manual" },
          turn: { state: "busy" },
          generations: [{ id: "session_gone", accountId: "acct-a", host: null }],
        },
      },
      entries: {
        "codex:session_root": { structuredHost: { kind: "codex-app-server" }, accountId: "acct-a" },
        "codex:session_child": { structuredHost: { kind: "codex-app-server" }, accountId: "acct-a" },
        "codex:session_dead": { structuredHost: null, accountId: "acct-a" },
      },
      lineageEdges: {
        e1: { childConversationId: "conversation_child", parentConversationId: "conversation_root", source: "engine-native" },
      },
      heldDeliveries: {
        held1: { conversationId: "conversation_root", state: "held", createdAt: "2026-01-01T00:00:02Z" },
        held2: { conversationId: "conversation_root", state: "held", createdAt: "2026-01-01T00:00:01Z" },
        delivered: { conversationId: "conversation_root", state: "delivered", createdAt: "2026-01-01T00:00:00Z" },
      },
    };
  }

  test("captures active structured roots and engine-native children, skipping terminal and superseded", () => {
    const rows = collectHandoffCandidates(snapshot());
    const byConversation = new Map(rows.map((r) => [r.conversationId, r]));
    expect([...byConversation.keys()].sort()).toEqual(["conversation_child", "conversation_root"]);

    const root = byConversation.get("conversation_root")!;
    expect(root.kind).toBe("root");
    expect(root.hostGeneration).toBe("codex-app-server-7:3");
    expect(root.turnState).toBe("busy");
    // Held deliveries become ordered pending deliveries; delivered ones are excluded.
    expect(root.pendingDeliveries.map((d) => d.deliveryId)).toEqual(["held2", "held1"]);

    const child = byConversation.get("conversation_child")!;
    expect(child.kind).toBe("engine-native-child");
    expect(child.parentConversationId).toBe("conversation_root");
  });

  test("collects a persisted engine-native child through its hosted ancestor", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-handoff-child-"));
    const filename = path.join(directory, "agent-registry.json");
    const registry = new AgentRegistry(filename);
    const parentSessionId = "11111111-2222-3333-4444-555555555555";
    const parentPath = `/claude/project/${parentSessionId}.jsonl`;
    const childPath = `/claude/project/${parentSessionId}/subagents/agent-child.jsonl`;
    const observation = (artifactPath: string, parentArtifactPath: string | null, state: "busy" | "idle") => ({
      engine: "claude" as const,
      path: artifactPath,
      accountId: "acct-a",
      launchProfile: emptyLaunchProfile({ cwd: "/repo", project: "project" }),
      turn: { state, source: "assistant" as const, terminalAt: null },
      observedAt: "2026-07-20T12:00:00.000Z",
      parentArtifactPath,
    });

    try {
      registry.reconcileConversations([
        observation(childPath, parentPath, "busy"),
        observation(parentPath, null, "idle"),
      ]);
      const parent = registry.conversationForPath(parentPath)!;
      const child = registry.conversationForPath(childPath)!;
      const parentGeneration = parent.generations.at(-1)!;
      registry.upsert({
        key: { engine: "claude", sessionId: parentGeneration.id },
        artifactPath: parentGeneration.path,
        cwd: "/repo",
        accountId: "acct-a",
        launchProfile: parentGeneration.launchProfile,
        status: "live",
        host: null,
        structuredHost: {
          kind: "claude-broker",
          endpoint: "stdio:parent",
          process: null,
          eventCursor: 1,
          protocolVersion: "1",
          writerClaimEpoch: 0,
          activeTurnRef: null,
          pendingAttention: [],
          activeFlags: [],
        },
        claimEpoch: 0,
        claimOwner: null,
        pendingAction: null,
      });

      const restarted = new AgentRegistry(filename);
      expect(restarted.snapshot().entries[`claude:${child.generations.at(-1)!.id}`]).toBeUndefined();
      const rows = collectHandoffCandidates(restarted.snapshot());
      const root = rows.find((row) => row.conversationId === parent.id)!;
      const collectedChild = rows.find((row) => row.conversationId === child.id)!;
      expect(collectedChild).toMatchObject({
        kind: "engine-native-child",
        parentConversationId: parent.id,
        engineSessionId: child.generations.at(-1)!.id,
        accountId: "acct-a",
        hostGeneration: root.hostGeneration,
      });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("uses an explicit durable parent binding when lineage has not materialized", () => {
    const fixture = snapshot();
    fixture.lineageEdges = {};
    fixture.conversations.conversation_child!.generations[0]!.launchProfile = {
      parentConversationId: "conversation_root",
    };
    delete fixture.entries["codex:session_child"];

    const child = collectHandoffCandidates(fixture)
      .find((row) => row.conversationId === "conversation_child");
    expect(child).toMatchObject({
      kind: "engine-native-child",
      parentConversationId: "conversation_root",
      hostGeneration: "codex-app-server-7:3",
    });
  });

  test("keeps viewer-spawn lineage authoritative over an explicit profile parent", () => {
    const fixture = snapshot();
    fixture.lineageEdges.e1!.source = "viewer-spawn";
    fixture.conversations.conversation_child!.generations[0]!.launchProfile = {
      parentConversationId: "conversation_root",
    };
    delete fixture.entries["codex:session_child"];

    expect(collectHandoffCandidates(fixture)
      .some((row) => row.conversationId === "conversation_child")).toBe(false);
  });

  test("produces a deterministic operation id so re-collection is idempotent", () => {
    const first = collectHandoffCandidates(snapshot());
    const second = collectHandoffCandidates(snapshot());
    expect(first.map((r) => r.operationId)).toEqual(second.map((r) => r.operationId));
  });
});
