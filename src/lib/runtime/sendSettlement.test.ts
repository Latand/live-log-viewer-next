import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "bun:test";

/* Isolated state only: this suite writes real registry files and a real runtime
   journal, neither of which may be the operator's. Nothing here addresses a
   real conversation — every send is built in a fixture. */
const isolated = fs.mkdtempSync(path.join(os.tmpdir(), "llv-send-settlement-"));
const isolatedEnvironment = {
  HOME: path.join(isolated, "home"),
  XDG_CONFIG_HOME: path.join(isolated, "config"),
  LLV_STATE_DIR: path.join(isolated, "state"),
  TMPDIR: path.join(isolated, "tmp"),
};
/* Restored in afterAll: a bun run that carries several test files shares one
   process, so an isolated TMPDIR this file then deletes would strand every
   later file's mkdtemp. */
const ambientEnvironment = Object.fromEntries(
  Object.keys(isolatedEnvironment).map((name) => [name, process.env[name]]),
);
for (const [name, directory] of Object.entries(isolatedEnvironment)) {
  fs.mkdirSync(directory, { recursive: true });
  process.env[name] = directory;
}

const { AgentRegistry, setAgentRegistryForTests } = await import("@/lib/agent/registry");
const { emptyLaunchProfile } = await import("@/lib/accounts/migration/contracts");
const { RuntimeJournal } = await import("@/runtime-host/journal");
const { StructuredDeliveryQueue } = await import("./structuredDeliveryQueue");
const {
  SEND_LOST_REASON,
  SEND_UNSETTLEABLE_REASON,
  SEND_UNRECORDED_REASON,
  SEND_UNVERIFIED_REASON,
  resolveSendReceipt,
  runtimeReceiptForSend,
  sendIsSettled,
  sendReceiptFor,
} = await import("./sendSettlement");
const { handleRuntimeOperationQuery, handleRuntimeRetry } = await import("./http");
const { NextRequest } = await import("next/server");
type AgentRegistry = InstanceType<typeof AgentRegistry>;
type RuntimeJournal = InstanceType<typeof RuntimeJournal>;
type RuntimeHostClient = import("./client").RuntimeHostClient;
type StructuredDeliveryQueuePort = import("./structuredDeliveryQueue").StructuredDeliveryQueuePort;
type EngineHost = import("./engineHost").EngineHost;
type HostState = import("./engineHost").HostState;
type QueueEntry = import("./engineHost").QueueEntry;
type DeliveryReceipt = import("./engineHost").DeliveryReceipt;
type ViewerConversationId = `conversation_${string}`;

afterAll(() => {
  for (const [name, value] of Object.entries(ambientEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  fs.rmSync(isolated, { recursive: true, force: true });
});

const SETTLEMENT_WINDOW_MS = 10 * 60_000;
/** Every fixture send is accepted "now"; the settlement is driven from a clock
    past the window instead of sleeping through it. */
const AFTER_THE_WINDOW = () => Date.now() + SETTLEMENT_WINDOW_MS + 60_000;

function runtimeClient(journal: RuntimeJournal): RuntimeHostClient {
  return {
    snapshot: async () => journal.snapshot(),
    events: async (after: number) => journal.replay(after),
    waitEvents: async (after: number) => journal.replay(after),
    append: async (event) => journal.append(event),
    operation: async (event) => journal.append(event),
    command: async (command) => journal.executeOperation(command),
    operationStatus: async (operationId: string, options?: { currentRetryLeaf?: boolean }) =>
      (options?.currentRetryLeaf ? journal.currentRetryResult(operationId) : journal.operationResult(operationId)),
    producerCursor: async (producerKind: string, eventKeyPrefix: string) =>
      journal.producerCursor(producerKind, eventKeyPrefix),
    effectBatch: async (kinds, afterEventSeq) => journal.effectBatch(100, kinds, afterEventSeq),
    transitionOperation: async (operationId, status, details) => journal.transitionOperation(operationId, status, details),
    retryOperation: async (operationId, nextIdempotencyKey) => journal.retryOperation(operationId, nextIdempotencyKey),
  } as RuntimeHostClient;
}

function idleState(sessionKey: string): HostState {
  return {
    status: "idle",
    sessionKey,
    endpoint: "fixture:host",
    pid: 1,
    processStartIdentity: "1",
    eventCursor: 0,
    protocolVersion: "fixture",
    activeTurnRef: null,
    pendingAttention: [],
    activeFlags: [],
    account: null,
  };
}

/** A host that records everything handed to it, so "was never delivered" is an
    assertion about the recipient rather than about a receipt. */
function recordingHost(sessionKey: string): { host: EngineHost; received: string[] } {
  const received: string[] = [];
  return {
    received,
    host: {
      attach: () => ({ async *[Symbol.asyncIterator]() {} }),
      send: async (entry: QueueEntry): Promise<DeliveryReceipt> => {
        received.push(entry.text ?? "");
        return { outcome: "turn-started", turnId: `turn-${entry.id}` };
      },
      interrupt: async () => {},
      answer: async () => {},
      health: async () => idleState(sessionKey),
      release: async () => {},
    },
  };
}

interface Fixture {
  registry: AgentRegistry;
  registryPath: string;
  journal: RuntimeJournal;
  client: RuntimeHostClient;
  conversationId: ViewerConversationId;
  generationId: string;
  transcriptPath: string;
  close(): void;
}

function fixture(name: string, options: { now?: () => number } = {}): Fixture {
  const directory = fs.mkdtempSync(path.join(isolated, `${name}-`));
  const registry = new AgentRegistry(
    path.join(directory, "agent-registry.json"),
    undefined,
    undefined,
    ...(options.now ? [{ now: options.now }] as const : []),
  );
  const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
  const transcriptPath = path.join(directory, `${name}.jsonl`);
  const launchProfile = emptyLaunchProfile({ cwd: directory });
  registry.reconcileConversations([{
    engine: "codex",
    path: transcriptPath,
    accountId: "settlement-fixture-account",
    launchProfile,
    turn: { state: "idle", source: "assistant", terminalAt: null },
    observedAt: "2026-08-30T10:00:00.000Z",
  }]);
  const conversation = Object.values(registry.snapshot().conversations)[0];
  const generation = conversation?.generations.at(-1);
  if (!conversation || !generation) throw new Error("fixture conversation is missing");
  registry.upsert({
    key: { engine: "codex", sessionId: generation.id },
    artifactPath: transcriptPath,
    cwd: directory,
    accountId: "settlement-fixture-account",
    launchProfile,
    status: "idle",
    host: null,
    structuredHost: {
      kind: "codex-app-server",
      endpoint: "fixture:settlement-host",
      process: null,
      eventCursor: 0,
      protocolVersion: "fixture-v1",
      writerClaimEpoch: 0,
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: null,
  });
  /* The runtime journal only admits a send for a hosted session, so the fixture
     publishes the same host state a live structured host would. */
  journal.append({
    scope: { type: "session", id: conversation.id },
    kind: "session-status",
    payload: {
      conversationId: conversation.id,
      sessionKey: { engine: "codex", sessionId: generation.id },
      hostKind: "codex-app-server",
      host: "hosted",
      turn: "idle",
      provenance: "structured",
      artifactPath: transcriptPath,
      capabilities: { steer: true, structuredAttention: true },
    },
  });
  return {
    registry,
    registryPath: path.join(directory, "agent-registry.json"),
    journal,
    client: runtimeClient(journal),
    conversationId: conversation.id,
    generationId: generation.id,
    transcriptPath,
    close: () => journal.close(),
  };
}

/**
 * Admits one send exactly the way the structured send path does: a durable
 * reservation, a claimed attempt, then the runtime-journal operation. What
 * comes back is the operation id an MCP caller would have been handed with
 * `outcome: "queued"`.
 */
function acceptSend(
  active: Fixture,
  options: { text?: string; clientMessageId?: string; operationId?: string } = {},
): { operationId: string; deliveryId: string } {
  const clientMessageId = options.clientMessageId ?? "fixture-message-key";
  const operationId = options.operationId ?? `op_${clientMessageId}`;
  const text = options.text ?? "hold the cutover until I say go";
  const reservation = active.registry.holdDelivery(
    active.conversationId,
    text,
    clientMessageId,
    "text",
    [],
    null,
    { operationId, kind: "send", policy: "queue" },
  );
  if (reservation.state !== "assigned") throw new Error(`fixture reservation is ${reservation.state}`);
  const claimed = active.registry.beginDeliveryAttempt(reservation.id, active.generationId);
  if (!claimed) throw new Error("fixture reservation could not claim its attempt");
  const admitted = active.journal.executeOperation({
    kind: "send",
    operationId,
    conversationId: active.conversationId,
    idempotencyKey: clientMessageId,
    text,
    policy: "queue",
  });
  expect(admitted.receipt.status).toBe("queued");
  return { operationId, deliveryId: reservation.id };
}

/** An executor that had already batched this effect before anything settled it
    — the exact race a fence has to survive. */
function stalePortFor(
  active: Fixture,
  operationId: string,
  clientMessageId: string,
  text: string,
): StructuredDeliveryQueuePort {
  return {
    effects: async () => [{
      id: `effect:${operationId}`,
      kind: "runtime.send",
      eventSeq: 1,
      payload: {
        kind: "send",
        operationId,
        conversationId: active.conversationId,
        text,
        idempotencyKey: clientMessageId,
        policy: "queue",
      },
    }],
    transition: async (id, status, details) => {
      await active.client.transitionOperation(id, status, details);
    },
    /* Wired exactly as the controller wires them, so the two pre-actuation
       checks these tests depend on are the production ones and not stubs. */
    status: async (id) => (await active.client.operationStatus(id))?.receipt ?? null,
    settled: (id) => sendIsSettled(active.registry.readOnlySnapshot(), id),
  };
}

function receiptOf(active: Fixture, operationId: string) {
  return sendReceiptFor(active.registry.readOnlySnapshot(), operationId);
}

test("an accepted send that the journal delivered reconciles rather than being reported lost", async () => {
  const active = fixture("delivered");
  try {
    const { operationId, deliveryId } = acceptSend(active, { clientMessageId: "delivered-key" });
    /* The executor did its job; only the projection onto the reservation was
       missed, which must never be mistaken for a loss. */
    active.journal.transitionOperation(operationId, "delivering");
    active.journal.transitionOperation(operationId, "delivered", { turnId: "turn-1" });
    expect(receiptOf(active, operationId)?.state).toBe("in-flight");

    const answered = await resolveSendReceipt(operationId, {
      registry: active.registry,
      client: active.client,
      now: AFTER_THE_WINDOW,
    });

    expect(answered?.state).toBe("delivered");
    expect(answered?.resend).toBe("not-needed");
    expect(answered?.duplicateRisk).toBe(false);
    expect(answered?.evidence).toBe("delivery-journal");
    /* Reconciled onto the record, so every later reader agrees without asking
       the journal again. */
    expect(active.registry.readOnlySnapshot().heldDeliveries[deliveryId]?.state).toBe("delivered");
    const receipt = receiptOf(active, operationId);
    expect(receipt?.state).toBe("delivered");
    expect(receipt?.resend).toBe("not-needed");
    expect(receipt?.evidence).toBe("delivery-record");
  } finally {
    active.close();
  }
});

test("a dropped send settles as failed, and the fence stops the queue from delivering it afterwards", async () => {
  const active = fixture("dropped");
  try {
    const { operationId, deliveryId } = acceptSend(active, {
      clientMessageId: "dropped-key",
      text: "resume the cutover",
    });
    /* Nothing else happens to it: this is the incident's shape — accepted,
       answered `queued`, and then silence. */
    expect(active.journal.operationResult(operationId)?.receipt.status).toBe("queued");
    /* Inside the window it is still in flight: a send that is merely young is
       not a send that was lost. */
    expect((await resolveSendReceipt(operationId, {
      registry: active.registry,
      client: active.client,
    }))?.state).toBe("in-flight");

    const answered = await resolveSendReceipt(operationId, {
      registry: active.registry,
      client: active.client,
      now: AFTER_THE_WINDOW,
    });

    expect(answered?.state).toBe("failed");
    expect(answered?.evidence).toBe("delivery-journal");
    expect(active.registry.readOnlySnapshot().heldDeliveries[deliveryId]?.state).toBe("failed");
    const receipt = receiptOf(active, operationId);
    expect(receipt?.state).toBe("failed");
    expect(receipt?.reason).toBe(SEND_LOST_REASON);
    expect(receipt?.duplicateRisk).toBe(false);
    expect(receipt?.resend).toBe("safe");

    /* The fence, proved against the real queue rather than asserted: the effect
       is gone from the outbox, and an executor that had already batched it is
       refused at the `delivering` transition — before `host.send` is reached. */
    expect(await active.journal.effectBatch(100, ["runtime.send"])).toEqual([]);
    const { host, received } = recordingHost(active.generationId);
    const stalePort = stalePortFor(active, operationId, "dropped-key", "resume the cutover");
    await new StructuredDeliveryQueue(stalePort, () => host).drain().catch(() => undefined);
    expect(received).toEqual([]);
    expect(active.journal.operationResult(operationId)?.receipt.status).toBe("failed");
  } finally {
    active.close();
  }
});

test("the same queue pass delivers a send the settlement has not fenced", async () => {
  /* The control for the fence above: with the operation left open, this exact
     port, queue and host do deliver, so the empty recipient in that test is the
     fence's doing and not the harness's. */
  const active = fixture("unfenced");
  try {
    const { operationId } = acceptSend(active, { clientMessageId: "unfenced-key", text: "resume the cutover" });
    const { host, received } = recordingHost(active.generationId);
    await new StructuredDeliveryQueue(stalePortFor(active, operationId, "unfenced-key", "resume the cutover"), () => host).drain();
    expect(received).toEqual(["resume the cutover"]);
    expect(active.journal.operationResult(operationId)?.receipt.status).toBe("delivered");
  } finally {
    active.close();
  }
});

test("a send whose first attempt is uncertain settles as failed and refuses to call a resend safe", async () => {
  const active = fixture("uncertain");
  try {
    const { operationId, deliveryId } = acceptSend(active, { clientMessageId: "uncertain-key" });
    /* The executor took it and never came back. Nothing can prove the recipient
       did not receive it, so nothing here may pretend otherwise. */
    active.journal.transitionOperation(operationId, "delivering", { turnId: "turn-7" });

    const answered = await resolveSendReceipt(operationId, {
      registry: active.registry,
      client: active.client,
      now: AFTER_THE_WINDOW,
    });

    expect(answered?.state).toBe("failed");
    expect(answered?.duplicateRisk).toBe(true);
    expect(active.registry.readOnlySnapshot().heldDeliveries[deliveryId]?.state).toBe("failed");
    expect(active.journal.operationResult(operationId)?.receipt.status).toBe("uncertain");
    const receipt = receiptOf(active, operationId);
    expect(receipt?.state).toBe("failed");
    expect(receipt?.reason).toBe(SEND_UNVERIFIED_REASON);
    expect(receipt?.duplicateRisk).toBe(true);
    expect(receipt?.resend).toBe("verify-first");
    /* Terminal either way: an unverified send is still fenced against being
       executed a second time by the queue. */
    expect(await active.journal.effectBatch(100, ["runtime.send"])).toEqual([]);
  } finally {
    active.close();
  }
});

test("a send queued behind the recipient's own turn waits, and stops being exempt at the ceiling", async () => {
  const active = fixture("in-turn");
  try {
    const { operationId } = acceptSend(active, { clientMessageId: "in-turn-key" });
    active.registry.setStructuredHost({ engine: "codex", sessionId: active.generationId }, {
      kind: "codex-app-server",
      endpoint: "fixture:settlement-host",
      process: null,
      eventCursor: 1,
      protocolVersion: "fixture-v1",
      writerClaimEpoch: 0,
      activeTurnRef: "turn-in-progress",
      pendingAttention: [],
      activeFlags: [],
    });

    const inTurn = await resolveSendReceipt(operationId, {
      registry: active.registry,
      client: active.client,
      now: AFTER_THE_WINDOW,
    });
    expect(inTurn?.state).toBe("in-flight");
    expect(active.journal.operationResult(operationId)?.receipt.status).toBe("queued");
    expect(receiptOf(active, operationId)?.state).toBe("in-flight");

    /* A host wedged mid-turn must not make `queued` permanent again. */
    const pastCeiling = await resolveSendReceipt(operationId, {
      registry: active.registry,
      client: active.client,
      now: () => Date.now() + 61 * 60_000,
    });
    expect(pastCeiling?.state).toBe("failed");
    expect(pastCeiling?.reason).toBe(SEND_LOST_REASON);
    expect(receiptOf(active, operationId)?.state).toBe("failed");
  } finally {
    active.close();
  }
});

test("a retried send is judged by its current attempt, not by the ancestor it replaced", async () => {
  const active = fixture("retried");
  try {
    const { operationId, deliveryId } = acceptSend(active, { clientMessageId: "retried-key" });
    /* The first attempt died with the host; a fresh attempt was admitted under a
       new idempotency key and delivered. The reservation still names the
       ancestor, so reading the ancestor would report a delivered message as a
       loss — and would then try to fence an operation already terminal. */
    active.journal.transitionOperation(operationId, "failed", { reason: "dead-host" });
    const retry = active.journal.retryOperation(operationId, "retried-key-second");
    expect(retry.operationId).not.toBe(operationId);
    active.journal.transitionOperation(retry.operationId, "delivering");
    active.journal.transitionOperation(retry.operationId, "delivered", { turnId: "turn-9" });

    const answered = await resolveSendReceipt(operationId, {
      registry: active.registry,
      client: active.client,
      now: AFTER_THE_WINDOW,
    });

    expect(answered?.state).toBe("delivered");
    expect(active.registry.readOnlySnapshot().heldDeliveries[deliveryId]?.state).toBe("delivered");
    expect(receiptOf(active, operationId)?.state).toBe("delivered");
  } finally {
    active.close();
  }
});

test("a runtime host that cannot be reached still ends the send, and never calls it lost", async () => {
  /* The outage case, which is the one a background sweep could never answer:
     nothing is healthy, so nothing can ask the journal what became of the send.
     `queued` may not be the last word through an outage of any length, so the
     deadline ends it anyway — as UNVERIFIED, because not being able to look is
     a reason to know less and never a proof that nothing executed. */
  const active = fixture("unreachable");
  try {
    const { operationId, deliveryId } = acceptSend(active, {
      clientMessageId: "unreachable-key",
      text: "resume the cutover",
    });
    const unreachable = {
      ...active.client,
      operationStatus: async () => { throw new Error("runtime host request timed out"); },
    } as RuntimeHostClient;

    /* Inside the window nothing is claimed: a send that is merely young during
       a blip is still in flight. */
    expect((await resolveSendReceipt(operationId, {
      registry: active.registry,
      client: unreachable,
    }))?.state).toBe("in-flight");
    expect((await resolveSendReceipt(operationId, {
      registry: active.registry,
      client: null,
    }))?.state).toBe("in-flight");

    const answered = await resolveSendReceipt(operationId, {
      registry: active.registry,
      client: null,
      now: AFTER_THE_WINDOW,
    });
    expect(answered?.state).toBe("failed");
    expect(answered?.reason).toBe(SEND_UNSETTLEABLE_REASON);
    expect(answered?.duplicateRisk).toBe(true);
    expect(answered?.resend).toBe("verify-first");

    /* Once, however often it is asked and whichever way the runtime is
       unreachable: the record is terminal, so every later answer replays it
       rather than writing a second settlement. */
    const settledAt = answered?.settledAt;
    for (const client of [null, unreachable, active.client]) {
      const again = await resolveSendReceipt(operationId, {
        registry: active.registry,
        client,
        now: AFTER_THE_WINDOW,
      });
      expect(again?.state).toBe("failed");
      expect(again?.reason).toBe(SEND_UNSETTLEABLE_REASON);
      expect(again?.settledAt).toBe(settledAt!);
    }
    expect(active.registry.readOnlySnapshot().heldDeliveries[deliveryId]?.state).toBe("failed");
  } finally {
    active.close();
  }
});

test("a journal that answers reads and refuses the fence still ends the send, and the record fences it", async () => {
  /* The half-outage: the runtime host is reachable enough to say the send is
     still open, and will not accept the write that would fence it — a socket
     that died between the two calls, or a database gone read-only. Leaving the
     send in flight here would make `queued` permanent exactly as a full outage
     would, so it ends the same way, on the durable record alone. */
  const active = fixture("fence-refused");
  const { host, received } = recordingHost(active.generationId);
  try {
    const { operationId, deliveryId } = acceptSend(active, {
      clientMessageId: "fence-refused-key",
      text: "resume the cutover",
    });
    const refusesTheFence = {
      ...active.client,
      transitionOperation: async () => { throw new Error("runtime journal is read-only"); },
    } as RuntimeHostClient;

    const answered = await resolveSendReceipt(operationId, {
      registry: active.registry,
      client: refusesTheFence,
      now: AFTER_THE_WINDOW,
    });
    expect(answered?.state).toBe("failed");
    expect(answered?.reason).toBe(SEND_UNSETTLEABLE_REASON);
    expect(answered?.duplicateRisk).toBe(true);
    expect(answered?.resend).toBe("verify-first");
    expect(active.registry.readOnlySnapshot().heldDeliveries[deliveryId]?.state).toBe("failed");

    /* And the answer stays true: the operation is still open in the journal, so
       an executor reaching it later would deliver a message the sender was told
       had not arrived. The settled record is what stops it. */
    await new StructuredDeliveryQueue(
      stalePortFor(active, operationId, "fence-refused-key", "resume the cutover"),
      () => host,
    ).drain();
    expect(received).toEqual([]);
    expect(active.journal.operationResult(operationId)?.receipt.status).toBe("uncertain");
    expect(receiptOf(active, operationId)?.resend).toBe("verify-first");
  } finally {
    active.close();
  }
});

test("an operation id nothing ever admitted is answered with nothing, not an invented in-flight state", () => {
  const active = fixture("unknown");
  try {
    expect(receiptOf(active, "op_never_admitted")).toBeNull();
  } finally {
    active.close();
  }
});

test("the caller's own replay of a settled loss is answered with the settlement, never with a second delivery", async () => {
  /* The fence proved against the OTHER way the same instruction could arrive
     twice: not a stale executor, but the sender deciding to send it again. The
     settled operation still owns its idempotency key, so an identical send is
     answered with the settled receipt and admits no new effect — which is why
     `resend: "safe"` means a NEW request id rather than a repeat of this one. */
  const active = fixture("replayed");
  try {
    const { operationId } = acceptSend(active, {
      clientMessageId: "replayed-key",
      text: "resume the cutover",
    });
    await resolveSendReceipt(operationId, {
      registry: active.registry,
      client: active.client,
      now: AFTER_THE_WINDOW,
    });
    expect(receiptOf(active, operationId)?.resend).toBe("safe");

    const replay = active.journal.executeOperation({
      kind: "send",
      operationId,
      conversationId: active.conversationId,
      idempotencyKey: "replayed-key",
      text: "resume the cutover",
      policy: "queue",
    });

    expect(replay).toMatchObject({ operationId, replayed: true });
    expect(replay.receipt.status).toBe("failed");
    expect(replay.receipt.reason).toBe(SEND_LOST_REASON);
    /* Nothing new to execute, and the queue that would execute it delivers
       nothing when it is asked. */
    expect(await active.journal.effectBatch(100, ["runtime.send"])).toEqual([]);
    const { host, received } = recordingHost(active.generationId);
    await new StructuredDeliveryQueue(
      stalePortFor(active, operationId, "replayed-key", "resume the cutover"),
      () => host,
    ).drain().catch(() => undefined);
    expect(received).toEqual([]);
  } finally {
    active.close();
  }
});

/* ── The regressions this successor lane exists for ──────────────────────── */

/** A host that takes the instruction and then dies without answering — the
    crash the lane's own fixture showed happening BEFORE the queue moved the
    send back to `queued` and called it safe to send again. */
function crashingHost(sessionKey: string): { host: EngineHost; received: string[] } {
  const received: string[] = [];
  let dead = false;
  return {
    received,
    host: {
      attach: () => ({ async *[Symbol.asyncIterator]() {} }),
      send: async (entry: QueueEntry): Promise<DeliveryReceipt> => {
        received.push(entry.text ?? "");
        dead = true;
        throw new Error("engine child exited");
      },
      interrupt: async () => {},
      answer: async () => {},
      health: async () => ({ ...idleState(sessionKey), status: dead ? "dead" : "idle" }),
      release: async () => {},
    },
  };
}

test("a send the host took before it died stays uncertain, and no fresh request delivers it twice", async () => {
  /* The whole point of this lane. The queue used to move this exact case back
     to `queued`, which settlement read as "never executed" and reported as
     `resend: "safe"` — on a channel that carries deployment control. */
  const active = fixture("crashed");
  try {
    const { operationId, deliveryId } = acceptSend(active, {
      clientMessageId: "crashed-key",
      text: "hold the cutover until I say go",
    });
    const crashed = crashingHost(active.generationId);

    /* The real crash path, over the real journal: no stub stands in for the
       transition, the outbox, or the host that dies mid-send. */
    await new StructuredDeliveryQueue(
      stalePortFor(active, operationId, "crashed-key", "hold the cutover until I say go"),
      () => crashed.host,
    ).drain();

    expect(crashed.received).toEqual(["hold the cutover until I say go"]);
    /* Absorbing and uncertain: never `queued`, which would say it was never
       executed, and never `failed`, which the receipt reads as fenced. */
    expect(active.journal.operationResult(operationId)?.receipt.status).toBe("uncertain");
    expect(await active.journal.effectBatch(100, ["runtime.send"])).toEqual([]);

    const answered = await resolveSendReceipt(operationId, {
      registry: active.registry,
      client: active.client,
    });
    expect(answered?.state).toBe("failed");
    expect(answered?.duplicateRisk).toBe(true);
    expect(answered?.resend).toBe("verify-first");
    expect(active.registry.readOnlySnapshot().heldDeliveries[deliveryId]?.state).toBe("failed");
    const receipt = receiptOf(active, operationId);
    expect(receipt?.state).toBe("failed");
    expect(receipt?.duplicateRisk).toBe(true);
    expect(receipt?.resend).toBe("verify-first");

    /* A fresh request cannot produce a second delivery: the settled operation
       still owns the idempotency key, so admission replays the uncertain
       receipt and admits no effect, and a queue handed the stale effect
       delivers nothing. */
    const replay = active.journal.executeOperation({
      kind: "send",
      operationId,
      conversationId: active.conversationId,
      idempotencyKey: "crashed-key",
      text: "hold the cutover until I say go",
      policy: "queue",
    });
    expect(replay.receipt.status).toBe("uncertain");
    const survivor = recordingHost(active.generationId);
    await new StructuredDeliveryQueue(
      stalePortFor(active, operationId, "crashed-key", "hold the cutover until I say go"),
      () => survivor.host,
    ).drain().catch(() => undefined);
    expect(survivor.received).toEqual([]);
  } finally {
    active.close();
  }
});

/** A host that takes the instruction, fails to answer for it, and STAYS
    STANDING — the failure a live host cannot distinguish from a refusal. */
function unansweringHost(sessionKey: string): { host: EngineHost; received: string[] } {
  const received: string[] = [];
  return {
    received,
    host: {
      attach: () => ({ async *[Symbol.asyncIterator]() {} }),
      send: async (entry: QueueEntry): Promise<DeliveryReceipt> => {
        received.push(entry.text ?? "");
        throw new Error("engine answer never arrived");
      },
      interrupt: async () => {},
      answer: async () => {},
      health: async () => idleState(sessionKey),
      release: async () => {},
    },
  };
}

test("a live host that cannot answer for a send it took is unverified, never safe to send again", async () => {
  /* The other half of the same finding. A host that dies is not the only way a
     send's fate goes unknown: the call that would have confirmed it can fail
     with the host still standing, and out here that is indistinguishable from a
     refusal. This used to settle `failed`, which the receipt reads as fenced
     and answers `resend: "safe"` — and a resend is issued under a NEW request
     id, so nothing on the host side would dedupe it against this attempt. */
  const active = fixture("unanswered");
  try {
    const { operationId, deliveryId } = acceptSend(active, {
      clientMessageId: "unanswered-key",
      text: "restart the deployment",
    });
    const unanswered = unansweringHost(active.generationId);

    await new StructuredDeliveryQueue(
      stalePortFor(active, operationId, "unanswered-key", "restart the deployment"),
      () => unanswered.host,
    ).drain();

    expect(unanswered.received).toEqual(["restart the deployment"]);
    expect(active.journal.operationResult(operationId)?.receipt.status).toBe("uncertain");
    expect(await active.journal.effectBatch(100, ["runtime.send"])).toEqual([]);

    const answered = await resolveSendReceipt(operationId, {
      registry: active.registry,
      client: active.client,
    });
    expect(answered?.state).toBe("failed");
    expect(answered?.duplicateRisk).toBe(true);
    expect(active.registry.readOnlySnapshot().heldDeliveries[deliveryId]?.state).toBe("failed");
    const receipt = receiptOf(active, operationId);
    expect(receipt?.reason).toBe(SEND_UNVERIFIED_REASON);
    expect(receipt?.duplicateRisk).toBe(true);
    expect(receipt?.resend).toBe("verify-first");

    /* And the same fence: a fresh request under the key replays the settled
       answer, and a queue handed the stale effect delivers nothing. */
    const replay = active.journal.executeOperation({
      kind: "send",
      operationId,
      conversationId: active.conversationId,
      idempotencyKey: "unanswered-key",
      text: "restart the deployment",
      policy: "queue",
    });
    expect(replay.receipt.status).toBe("uncertain");
    const survivor = recordingHost(active.generationId);
    await new StructuredDeliveryQueue(
      stalePortFor(active, operationId, "unanswered-key", "restart the deployment"),
      () => survivor.host,
    ).drain().catch(() => undefined);
    expect(survivor.received).toEqual([]);
  } finally {
    active.close();
  }
});

test("permanent runtime loss then recovery ends in one terminal receipt and no late delivery", async () => {
  /* The whole of finding 3, end to end. The runtime host is gone for good as
     far as anyone asking can tell, so the settlement ends the send from the
     durable record alone — and that record is then the fence: the first drain
     after recovery reads it and refuses to deliver, rather than putting the
     instruction in front of the recipient long after the sender was told it had
     not arrived. Nothing here needs a sweep, a timer or a healthy process. */
  const active = fixture("recovered");
  try {
    const { operationId, deliveryId } = acceptSend(active, {
      clientMessageId: "recovered-key",
      text: "resume the cutover",
    });

    const duringOutage = await resolveSendReceipt(operationId, {
      registry: active.registry,
      client: null,
      now: AFTER_THE_WINDOW,
    });
    expect(duringOutage?.state).toBe("failed");
    expect(duringOutage?.resend).toBe("verify-first");
    expect(receiptOf(active, operationId)?.state).toBe("failed");
    /* Nothing was written to the journal — there was nothing to write to — so
       the effect is still sitting in the outbox, waiting for an executor. */
    expect(active.journal.operationResult(operationId)?.receipt.status).toBe("queued");
    expect(await active.journal.effectBatch(100, ["runtime.send"])).toMatchObject([{ kind: "runtime.send" }]);

    /* Recovery: the runtime is back and the queue drains the effect it left
       behind. The recipient receives NOTHING. */
    const afterRecovery = recordingHost(active.generationId);
    await new StructuredDeliveryQueue(
      stalePortFor(active, operationId, "recovered-key", "resume the cutover"),
      () => afterRecovery.host,
    ).drain();
    expect(afterRecovery.received).toEqual([]);
    expect(active.journal.operationResult(operationId)?.receipt.status).toBe("uncertain");
    expect(await active.journal.effectBatch(100, ["runtime.send"])).toEqual([]);

    /* And the answer the caller already holds is still the answer, with the
       runtime back and able to speak for itself. */
    const settled = await resolveSendReceipt(operationId, {
      registry: active.registry,
      client: active.client,
      now: AFTER_THE_WINDOW,
    });
    expect(settled?.state).toBe("failed");
    expect(settled?.duplicateRisk).toBe(true);
    expect(settled?.resend).toBe("verify-first");
    expect(active.registry.readOnlySnapshot().heldDeliveries[deliveryId]?.state).toBe("failed");
  } finally {
    active.close();
  }
});

test("a retry's own operation id is answerable, settles at its own deadline, and is not delivered late", async () => {
  /* The finding: a retry is admitted as a FRESH operation with a new id, and
     that id is what the caller is handed — while everything durable stayed
     keyed to the presentation operation the attempt replaced. So the id in the
     caller's hand named nothing: a query during a runtime outage found no
     record, no deadline could ever end it, and the queue's own fence had
     nothing to read either. A caller could hold an operation id that nothing in
     the system would ever settle.

     Four things have to hold at once, and the third and fourth pull against
     each other: the attempt is answerable, it is deliberately still eligible
     for ONE fresh execution, its deadline ends it, and after that ending a
     recovery may not deliver it. */
  const active = fixture("retry-attempt");
  try {
    const { operationId } = acceptSend(active, {
      clientMessageId: "retry-attempt-key",
      text: "roll the release forward",
    });
    /* The first attempt reached an executor and failed there, which is what
       makes a retry offerable at all. */
    active.journal.transitionOperation(operationId, "delivering");
    active.journal.transitionOperation(operationId, "failed", { reason: "dead-host" });
    active.registry.recordDeliveryOutcomeForOperation(active.conversationId, operationId, "failed", "dead-host");
    expect(receiptOf(active, operationId)?.state).toBe("failed");

    let kicks = 0;
    /* The route's OWN dependency wiring records the attempt — this fixture
       registry stands in for the process registry so the default path is the
       one under test, not a stub of it. */
    setAgentRegistryForTests(active.registry);
    const response = await handleRuntimeRetry(
      new NextRequest(`http://127.0.0.1/api/runtime/operations/${operationId}`, {
        method: "POST",
        headers: { host: "127.0.0.1", "content-type": "application/json" },
      }),
      operationId,
      {
        enabled: () => true,
        client: () => active.client,
        recover: async () => ({
          target: null,
          path: active.transcriptPath,
          conversationId: active.conversationId,
          spawned: false,
        }),
        kick: () => { kicks += 1; },
      },
    );
    expect(response.status).toBe(202);
    const admitted = await response.json() as { operationId: string };
    const retryOperationId = admitted.operationId;
    expect(retryOperationId).not.toBe(operationId);
    expect(kicks).toBe(1);

    /* ONE: the id the caller was handed is answerable, and it answers about the
       attempt it names rather than about the dead one it replaced. */
    const accepted = receiptOf(active, retryOperationId);
    expect(accepted?.state).toBe("in-flight");
    expect(accepted?.conversationId).toBe(active.conversationId);

    /* TWO: the attempt is still eligible for its one fresh execution — the
       durable fence the queue reads before it actuates anything does not hold
       it. */
    expect(sendIsSettled(active.registry.readOnlySnapshot(), retryOperationId)).toBeFalse();

    /* THREE: the runtime is lost, and the id is answered from the durable
       record instead of a 503 — then ENDED by its own deadline, which is
       measured from when this attempt was admitted rather than from the send it
       replaced. */
    const duringLoss = await handleRuntimeOperationQuery(retryOperationId, {
      client: () => null,
      rolledBack: () => false,
      settle: (asked, asClient) => resolveSendReceipt(asked, { registry: active.registry, client: asClient }),
    });
    expect(duringLoss.status).toBe(200);
    expect(await duringLoss.json()).toMatchObject({
      operationId: retryOperationId,
      receipt: { status: "queued" },
      send: { state: "in-flight" },
    });

    const settled = await resolveSendReceipt(retryOperationId, {
      registry: active.registry,
      client: null,
      now: AFTER_THE_WINDOW,
    });
    expect(settled?.state).toBe("failed");
    expect(settled?.reason).toBe(SEND_UNSETTLEABLE_REASON);
    expect(settled?.duplicateRisk).toBeTrue();
    expect(settled?.resend).toBe("verify-first");
    expect(settled?.evidence).toBe("delivery-record");

    /* FOUR: recovery. The retry effect is still in the outbox and an executor
       picks it up with the runtime healthy again — and finds the record that
       ended it. The recipient receives nothing, because the caller has already
       been told this attempt did not arrive. */
    expect(sendIsSettled(active.registry.readOnlySnapshot(), retryOperationId)).toBeTrue();
    const afterRecovery = recordingHost(active.generationId);
    await new StructuredDeliveryQueue(
      stalePortFor(active, retryOperationId, "retry-attempt-key", "roll the release forward"),
      () => afterRecovery.host,
    ).drain();
    expect(afterRecovery.received).toEqual([]);
    expect(active.journal.operationResult(retryOperationId)?.receipt.status).toBe("uncertain");
    expect(await active.journal.effectBatch(100, ["runtime.send"])).toEqual([]);

    /* And the answer stays the answer once the runtime can speak again — and
       across the restart of the process that wrote it, because a settlement
       nothing has to be running to honour is the whole point of keeping it on
       the durable record. */
    const afterwards = await resolveSendReceipt(retryOperationId, {
      registry: active.registry,
      client: active.client,
      now: AFTER_THE_WINDOW,
    });
    expect(afterwards?.state).toBe("failed");
    expect(afterwards?.resend).toBe("verify-first");
    const reloaded = sendReceiptFor(new AgentRegistry(active.registryPath).readOnlySnapshot(), retryOperationId);
    expect(reloaded?.state).toBe("failed");
    expect(reloaded?.resend).toBe("verify-first");
  } finally {
    setAgentRegistryForTests(null);
    active.close();
  }
});

test("a migration-cancelled held send admits the one-tap retry its receipt offers", async () => {
  const active = fixture("migration-cancelled-retry");
  try {
    const migration = active.registry.requestConversationReseat(active.conversationId, "successor-account").migration!;
    const operationId = "operation-migration-cancelled-retry";
    const idempotencyKey = "migration-cancelled-retry-key";
    const text = "deliver after choosing another account";
    const held = active.registry.holdDelivery(
      active.conversationId,
      text,
      idempotencyKey,
      "text",
      [],
      null,
      { operationId, kind: "send", policy: "queue" },
    );
    expect(held).toMatchObject({ state: "held", attempts: 0 });
    active.journal.executeOperation({
      kind: "send",
      operationId,
      conversationId: active.conversationId,
      idempotencyKey,
      text,
      policy: "queue",
    });

    active.registry.setMigrationIntentState(migration.intentId, "stopped");
    expect(receiptOf(active, operationId)).toMatchObject({
      state: "failed",
      reason: expect.stringContaining("migration was stopped"),
      resend: "safe",
    });
    expect(active.journal.operationResult(operationId)?.receipt.status).toBe("queued");

    let kicks = 0;
    setAgentRegistryForTests(active.registry);
    const response = await handleRuntimeRetry(
      new NextRequest(`http://127.0.0.1/api/runtime/operations/${operationId}`, {
        method: "POST",
        headers: { host: "127.0.0.1", "content-type": "application/json" },
      }),
      operationId,
      {
        enabled: () => true,
        client: () => active.client,
        recover: async () => ({
          target: null,
          path: active.transcriptPath,
          conversationId: active.conversationId,
          spawned: false,
        }),
        kick: () => { kicks += 1; },
      },
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ receipt: { status: "queued" } });
    expect(kicks).toBe(1);
  } finally {
    setAgentRegistryForTests(null);
    active.close();
  }
});

test("an unverified delivery record needs an explicit same-identity retry before rearming the queued journal", async () => {
  const active = fixture("unverified-migration-retry");
  try {
    const { operationId, deliveryId } = acceptSend(active, {
      clientMessageId: "unverified-migration-retry-key",
      text: "do not duplicate this instruction",
    });
    active.registry.recordDeliveryOutcome(
      deliveryId,
      "failed",
      "a prior delivery attempt may have arrived",
      "unverified",
    );
    const unverified = receiptOf(active, operationId);
    expect(unverified).toMatchObject({ state: "failed", resend: "verify-first" });
    expect(runtimeReceiptForSend(unverified!)).toMatchObject({ status: "failed", resend: "verify-first" });

    const response = await handleRuntimeRetry(
      new NextRequest(`http://127.0.0.1/api/runtime/operations/${operationId}`, {
        method: "POST",
        headers: { host: "127.0.0.1", "content-type": "application/json" },
      }),
      operationId,
      {
        enabled: () => true,
        client: () => active.client,
        registry: () => active.registry,
        kick: () => { throw new Error("unverified retry must not kick delivery"); },
      },
    );

    expect(response.status).toBe(409);
    expect(active.journal.operationResult(operationId)?.receipt.status).toBe("queued");

    let kicks = 0;
    const explicit = await handleRuntimeRetry(
      new NextRequest(`http://127.0.0.1/api/runtime/operations/${operationId}`, {
        method: "POST",
        headers: { host: "127.0.0.1", "content-type": "application/json" },
        body: JSON.stringify({ action: "retry-uncertain" }),
      }),
      operationId,
      {
        enabled: () => true,
        client: () => active.client,
        registry: () => active.registry,
        kick: () => { kicks += 1; },
      },
    );
    expect(explicit.status).toBe(202);
    expect(await explicit.json()).toMatchObject({ operationId, receipt: { operationId, status: "queued" } });
    expect(active.registry.readOnlySnapshot().heldDeliveries[deliveryId]).toMatchObject({
      state: "delivery-uncertain",
      attempts: 2,
      command: { operationId },
    });
    expect(kicks).toBe(1);
  } finally {
    active.close();
  }
});

test("a legacy send with no journal record settles unverified rather than provably lost", async () => {
  /* The legacy delivery path writes to a transcript host and creates no runtime
     operation at all, so the journal can never say what became of it. A missing
     record used to be read as proof the send never executed — the same unsafe
     classification, on the path with the least evidence of all. */
  const active = fixture("legacy");
  try {
    const reservation = active.registry.holdDelivery(
      active.conversationId,
      "restart the deployment",
      "legacy-key",
      "text",
      [],
      null,
      {},
    );
    const claimed = active.registry.beginDeliveryAttempt(reservation.id, active.generationId);
    expect(claimed?.state).toBe("delivery-uncertain");
    const operationId = reservation.command.operationId;
    expect(active.journal.operationResult(operationId)).toBeNull();

    const answered = await resolveSendReceipt(operationId, {
      registry: active.registry,
      client: active.client,
      now: AFTER_THE_WINDOW,
    });

    expect(answered?.state).toBe("failed");
    expect(answered?.duplicateRisk).toBe(true);
    expect(active.registry.readOnlySnapshot().heldDeliveries[reservation.id]?.state).toBe("failed");
    const receipt = receiptOf(active, operationId);
    expect(receipt?.state).toBe("failed");
    expect(receipt?.reason).toBe(SEND_UNRECORDED_REASON);
    expect(receipt?.duplicateRisk).toBe(true);
    expect(receipt?.resend).toBe("verify-first");
  } finally {
    active.close();
  }
});

test("a delivered journal operation answers as delivered before the deadline", async () => {
  /* The receipt is a question about now. The projection can lag the journal by
     a whole drain, and answering `in-flight` from it while the journal holds a
     delivered operation is the send-time guess this issue set out to replace —
     and this answer does not wait for any deadline to say so. */
  const active = fixture("current");
  try {
    const { operationId, deliveryId } = acceptSend(active, { clientMessageId: "current-key" });
    active.journal.transitionOperation(operationId, "delivering");
    active.journal.transitionOperation(operationId, "delivered", { turnId: "turn-current" });
    expect(receiptOf(active, operationId)?.state).toBe("in-flight");

    const receipt = await resolveSendReceipt(operationId, {
      registry: active.registry,
      client: active.client,
    });

    expect(receipt?.state).toBe("delivered");
    expect(receipt?.resend).toBe("not-needed");
    expect(receipt?.evidence).toBe("delivery-journal");
    /* Reconciled on the spot, so the record and the answer agree afterwards. */
    expect(active.registry.readOnlySnapshot().heldDeliveries[deliveryId]?.state).toBe("delivered");
    expect(receiptOf(active, operationId)?.state).toBe("delivered");
  } finally {
    active.close();
  }
});

test("an accepted hold answers by its own operation id, and answers terminally either way", async () => {
  /* #1131: a delivery parked behind an account migration is an ACCEPTED send —
     `/api/runtime/send` and `send_message` both hand its reservation's
     operation id back — so it has to be queryable like every other acceptance,
     and the query has to reach a terminal answer whichever way the coordinator
     that owns it settles it. Nothing here has a journal record: the whole
     answer comes from the durable delivery record. */
  const active = fixture("held");
  try {
    const delivered = acceptSend(active, { clientMessageId: "held-delivered-key", operationId: "op_held_delivered" });
    const failed = acceptSend(active, { clientMessageId: "held-failed-key", operationId: "op_held_failed" });
    const emptyJournal = { ...active.client, operationStatus: async () => null } as RuntimeHostClient;
    expect((await resolveSendReceipt(delivered.operationId, {
      registry: active.registry,
      client: emptyJournal,
    }))?.state).toBe("in-flight");

    active.registry.recordDeliveryOutcome(delivered.deliveryId, "delivered", null, "delivered");
    active.registry.recordDeliveryOutcome(failed.deliveryId, "failed", "the migration could not deliver it");

    const arrived = await resolveSendReceipt(delivered.operationId, {
      registry: active.registry,
      client: emptyJournal,
    });
    expect(arrived?.state).toBe("delivered");
    expect(arrived?.resend).toBe("not-needed");
    const lost = await resolveSendReceipt(failed.operationId, {
      registry: active.registry,
      client: emptyJournal,
    });
    expect(lost?.state).toBe("failed");
    /* Settled by a path that proved nothing about execution, so it says so. */
    expect(lost?.duplicateRisk).toBe(true);
    expect(lost?.resend).toBe("verify-first");
  } finally {
    active.close();
  }
});

test("compaction retires the reservation and keeps what it proved about the send", async () => {
  /* The reservation carries the reason; the owner row is what outlives it. When
     only `terminalState` survived, both answers collapsed into one — an
     unverified failure came back `resend: "safe"`, and a fenced one lost the
     evidence that earned it. Both directions are pinned here, because a record
     that cannot tell them apart is the duplicate hazard either way. */
  let clock = Date.now();
  const active = fixture("compacted", { now: () => clock });
  try {
    const unverified = acceptSend(active, { clientMessageId: "compacted-uncertain-key", operationId: "op_compacted_uncertain" });
    active.journal.transitionOperation(unverified.operationId, "delivering", { turnId: "turn-compacted" });
    const fenced = acceptSend(active, { clientMessageId: "compacted-dropped-key", operationId: "op_compacted_dropped" });
    for (const operationId of [unverified.operationId, fenced.operationId]) {
      await resolveSendReceipt(operationId, {
        registry: active.registry,
        client: active.client,
        now: AFTER_THE_WINDOW,
      });
    }
    expect(receiptOf(active, unverified.operationId)?.resend).toBe("verify-first");
    expect(receiptOf(active, fenced.operationId)?.resend).toBe("safe");

    /* Forced: terminal reservations are retired a week after they settle, and
       any later settlement on the conversation runs that compaction. */
    clock += 8 * 24 * 60 * 60 * 1000;
    const later = acceptSend(active, { clientMessageId: "compacting-key", operationId: "op_compacting_key" });
    active.registry.recordDeliveryOutcome(later.deliveryId, "delivered", null, "delivered");
    const remaining = active.registry.readOnlySnapshot().heldDeliveries;
    expect(remaining[unverified.deliveryId]).toBeUndefined();
    expect(remaining[fenced.deliveryId]).toBeUndefined();

    const afterCompaction = receiptOf(active, unverified.operationId);
    expect(afterCompaction?.state).toBe("failed");
    expect(afterCompaction?.duplicateRisk).toBe(true);
    expect(afterCompaction?.resend).toBe("verify-first");
    expect(afterCompaction?.reason).toBe(SEND_UNVERIFIED_REASON);
    expect(afterCompaction?.settledAt).not.toBeNull();
    /* And the send that was genuinely fenced still says so, so the durable
       disposition is doing work in both directions rather than answering
       "verify first" to everything. */
    const fencedAfterCompaction = receiptOf(active, fenced.operationId);
    expect(fencedAfterCompaction?.reason).toBe(SEND_LOST_REASON);
    expect(fencedAfterCompaction?.duplicateRisk).toBe(false);
    expect(fencedAfterCompaction?.resend).toBe("safe");
  } finally {
    active.close();
  }
});
