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

const { AgentRegistry } = await import("@/lib/agent/registry");
const { emptyLaunchProfile } = await import("@/lib/accounts/migration/contracts");
const { RuntimeJournal } = await import("@/runtime-host/journal");
const { StructuredDeliveryQueue } = await import("./structuredDeliveryQueue");
const {
  SEND_LOST_REASON,
  SEND_UNRECORDED_REASON,
  SEND_UNVERIFIED_REASON,
  resolveSendReceipt,
  sendReceiptFor,
  settleUnsettledSends,
  unsettledSends,
} = await import("./sendSettlement");
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
/** Every fixture send is accepted "now"; the sweep is driven from a clock past
    the window instead of sleeping through it. */
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
    /* Wired exactly as the controller wires it, so the pre-actuation check
       these tests depend on is the production one and not a stub. */
    status: async (id) => (await active.client.operationStatus(id))?.receipt ?? null,
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

    const report = await settleUnsettledSends({
      registry: active.registry,
      client: active.client,
      now: AFTER_THE_WINDOW,
    });

    expect(report.settled).toEqual([{
      operationId,
      deliveryId,
      conversationId: active.conversationId,
      state: "delivered",
      disposition: "reconciled",
      duplicateRisk: false,
    }]);
    const receipt = receiptOf(active, operationId);
    expect(receipt?.state).toBe("delivered");
    expect(receipt?.resend).toBe("not-needed");
    expect(receipt?.duplicateRisk).toBe(false);
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
    expect(unsettledSends(active.registry.readOnlySnapshot(), { now: AFTER_THE_WINDOW() })).toMatchObject([
      { operationId, deliveryId, awaitingTurn: false },
    ]);

    const report = await settleUnsettledSends({
      registry: active.registry,
      client: active.client,
      now: AFTER_THE_WINDOW,
    });

    expect(report.settled).toEqual([{
      operationId,
      deliveryId,
      conversationId: active.conversationId,
      state: "failed",
      disposition: "lost",
      duplicateRisk: false,
    }]);
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

    const report = await settleUnsettledSends({
      registry: active.registry,
      client: active.client,
      now: AFTER_THE_WINDOW,
    });

    expect(report.settled).toEqual([{
      operationId,
      deliveryId,
      conversationId: active.conversationId,
      state: "failed",
      disposition: "unverified",
      duplicateRisk: true,
    }]);
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

    const inTurn = await settleUnsettledSends({
      registry: active.registry,
      client: active.client,
      now: AFTER_THE_WINDOW,
    });
    expect(inTurn).toMatchObject({ examined: 0, settled: [], deferred: [] });
    expect(receiptOf(active, operationId)?.state).toBe("in-flight");

    /* A host wedged mid-turn must not make `queued` permanent again. */
    const pastCeiling = await settleUnsettledSends({
      registry: active.registry,
      client: active.client,
      now: () => Date.now() + 61 * 60_000,
    });
    expect(pastCeiling.settled).toMatchObject([{ operationId, state: "failed", disposition: "lost" }]);
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

    const report = await settleUnsettledSends({
      registry: active.registry,
      client: active.client,
      now: AFTER_THE_WINDOW,
    });

    expect(report.settled).toMatchObject([{ operationId, deliveryId, state: "delivered", disposition: "reconciled" }]);
    expect(receiptOf(active, operationId)?.state).toBe("delivered");
  } finally {
    active.close();
  }
});

test("an unreadable delivery journal defers the send instead of declaring it lost", async () => {
  const active = fixture("deferred");
  try {
    const { operationId } = acceptSend(active, { clientMessageId: "deferred-key" });

    const withoutHost = await settleUnsettledSends({
      registry: active.registry,
      client: null,
      now: AFTER_THE_WINDOW,
    });
    expect(withoutHost.settled).toEqual([]);
    expect(withoutHost.deferred).toEqual([{ operationId, reason: "runtime host is unavailable" }]);

    const unreachable = await settleUnsettledSends({
      registry: active.registry,
      client: {
        ...active.client,
        operationStatus: async () => { throw new Error("runtime host request timed out"); },
      } as RuntimeHostClient,
      now: AFTER_THE_WINDOW,
    });
    expect(unreachable.settled).toEqual([]);
    expect(unreachable.deferred).toEqual([{ operationId, reason: "runtime host request timed out" }]);
    /* Still open, still unfenced: knowing less is never a licence to declare a
       message lost while it may be sitting in a live outbox. */
    expect(active.journal.operationResult(operationId)?.receipt.status).toBe("queued");
    expect(receiptOf(active, operationId)?.state).toBe("in-flight");
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
    await settleUnsettledSends({
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

    const report = await settleUnsettledSends({
      registry: active.registry,
      client: active.client,
      now: AFTER_THE_WINDOW,
    });
    expect(report.settled).toEqual([{
      operationId,
      deliveryId,
      conversationId: active.conversationId,
      state: "failed",
      disposition: "reconciled",
      duplicateRisk: true,
    }]);
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

    const report = await settleUnsettledSends({
      registry: active.registry,
      client: active.client,
      now: AFTER_THE_WINDOW,
    });
    expect(report.settled).toMatchObject([{ operationId, deliveryId, state: "failed", duplicateRisk: true }]);
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
  /* The executor was killed after it handed the send to the engine, so the
     journal is left holding `delivering` and the effect is still in the outbox.
     Nothing can settle that while the socket is gone — and nothing has to: the
     fence is the durable row itself, so the first drain after recovery reads it
     and refuses to deliver rather than delivering it late. */
  const active = fixture("recovered");
  try {
    const { operationId, deliveryId } = acceptSend(active, {
      clientMessageId: "recovered-key",
      text: "resume the cutover",
    });
    active.journal.transitionOperation(operationId, "delivering", { turnId: "turn-recovered" });

    const duringOutage = await settleUnsettledSends({
      registry: active.registry,
      client: null,
      now: AFTER_THE_WINDOW,
    });
    expect(duringOutage.settled).toEqual([]);
    expect(duringOutage.deferred).toEqual([{ operationId, reason: "runtime host is unavailable" }]);
    expect(receiptOf(active, operationId)?.state).toBe("in-flight");

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

    const settled = await settleUnsettledSends({
      registry: active.registry,
      client: active.client,
      now: AFTER_THE_WINDOW,
    });
    expect(settled.settled).toMatchObject([{ operationId, deliveryId, state: "failed", duplicateRisk: true }]);
    const receipt = receiptOf(active, operationId);
    expect(receipt?.state).toBe("failed");
    expect(receipt?.resend).toBe("verify-first");

    /* Exactly one: the send is settled, so the next sweep has nothing left to
       examine and cannot write a second answer. */
    const again = await settleUnsettledSends({
      registry: active.registry,
      client: active.client,
      now: AFTER_THE_WINDOW,
    });
    expect(again).toEqual({ examined: 0, settled: [], deferred: [] });
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

    const report = await settleUnsettledSends({
      registry: active.registry,
      client: active.client,
      now: AFTER_THE_WINDOW,
    });

    expect(report.settled).toEqual([{
      operationId,
      deliveryId: reservation.id,
      conversationId: active.conversationId,
      state: "failed",
      disposition: "unverified",
      duplicateRisk: true,
    }]);
    const receipt = receiptOf(active, operationId);
    expect(receipt?.state).toBe("failed");
    expect(receipt?.reason).toBe(SEND_UNRECORDED_REASON);
    expect(receipt?.duplicateRisk).toBe(true);
    expect(receipt?.resend).toBe("verify-first");
  } finally {
    active.close();
  }
});

test("a delivered journal operation answers as delivered before any sweep runs", async () => {
  /* The receipt is a question about now. The projection can lag the journal by
     a whole sweep, and answering `in-flight` from it while the journal holds a
     delivered operation is the send-time guess this issue set out to replace. */
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

test("compaction retires the reservation and keeps what it proved about the send", async () => {
  /* The reservation carries the reason; the owner row is what outlives it. When
     only `terminalState` survived, both answers collapsed into one — an
     unverified failure came back `resend: "safe"`, and a fenced one lost the
     evidence that earned it. Both directions are pinned here, because a record
     that cannot tell them apart is the duplicate hazard either way. */
  let clock = Date.parse("2026-08-30T10:00:00.000Z");
  const active = fixture("compacted", { now: () => clock });
  try {
    const unverified = acceptSend(active, { clientMessageId: "compacted-uncertain-key", operationId: "op_compacted_uncertain" });
    active.journal.transitionOperation(unverified.operationId, "delivering", { turnId: "turn-compacted" });
    const fenced = acceptSend(active, { clientMessageId: "compacted-dropped-key", operationId: "op_compacted_dropped" });
    await settleUnsettledSends({
      registry: active.registry,
      client: active.client,
      now: AFTER_THE_WINDOW,
    });
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
