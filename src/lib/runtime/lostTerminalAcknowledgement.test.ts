import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "bun:test";

/* Isolated state only: this suite drives the process-scoped delivery
   controller, a real runtime journal and a real agent registry, none of which
   may touch the operator's live state. */
const isolated = fs.mkdtempSync(path.join(os.tmpdir(), "llv-lost-ack-"));
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
const { createFakeDeliveryLedger, FakeEngineHost } = await import("./fixtures/fakeEngineHost");
const { RuntimeHostUnavailableError } = await import("./client");
const { bindStructuredDeliveryQueue } = await import("./structuredDeliveryController");
const { kickStructuredDeliveryQueue } = await import("./structuredDeliverySignal");
const { structuredContentDigest } = await import("./structuredContent");
type AgentRegistry = InstanceType<typeof AgentRegistry>;
type RuntimeJournal = InstanceType<typeof RuntimeJournal>;
type RuntimeHostClient = import("./client").RuntimeHostClient;
type SessionKey = import("@/lib/agent/sessionKey").SessionKey;

afterAll(() => {
  for (const [name, value] of Object.entries(ambientEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  fs.rmSync(isolated, { recursive: true, force: true });
});

interface Faults {
  /** Applies the delivered transition and loses only its answer — the incident. */
  loseDeliveredAcknowledgement: boolean;
  /** Every receipt read fails from that moment: the outcome is committed and
      unreadable, which is the compound outage the incident ran inside. */
  unreadableAfterLostAcknowledgement: boolean;
  /** Live state of the read fault, flipped by the loss above and by tests. */
  statusUnreadable: boolean;
}

interface HostGeneration {
  /** Drops the projection-retention option, as a runtime host released before
      it does, and answers "unsupported" for the acknowledgement itself. */
  legacy?: boolean;
  /** Present, but rejecting: the acknowledgement must never take a drain down. */
  acknowledgementRejects?: boolean;
}

function runtimeClient(
  journal: RuntimeJournal,
  faults: Faults,
  acknowledged: string[],
  generation: HostGeneration = {},
): RuntimeHostClient {
  const client: Record<string, unknown> = {
    snapshot: async () => journal.snapshot(),
    events: async (after: number) => journal.replay(after),
    waitEvents: async (after: number) => journal.replay(after),
    append: async (event: unknown) => journal.append(event as Parameters<RuntimeJournal["append"]>[0]),
    operation: async (event: unknown) => journal.append(event as Parameters<RuntimeJournal["append"]>[0]),
    command: async (command: unknown) => journal.executeOperation(command as Parameters<RuntimeJournal["executeOperation"]>[0]),
    operationStatus: async (operationId: string) => {
      if (faults.statusUnreadable) throw new RuntimeHostUnavailableError("runtime host request timed out");
      return journal.operationResult(operationId);
    },
    producerCursor: async (producerKind: string, eventKeyPrefix: string) => journal.producerCursor(producerKind, eventKeyPrefix),
    effectBatch: async (kinds?: readonly string[], afterEventSeq?: number) => journal.effectBatch(100, kinds, afterEventSeq),
    transitionOperation: async (
      operationId: string,
      status: Parameters<RuntimeJournal["transitionOperation"]>[1],
      details: Parameters<RuntimeJournal["transitionOperation"]>[2],
      options: Parameters<RuntimeJournal["transitionOperation"]>[3],
    ) => {
      const result = journal.transitionOperation(operationId, status, details, generation.legacy ? {} : options ?? {});
      if (faults.loseDeliveredAcknowledgement && status === "delivered") {
        faults.loseDeliveredAcknowledgement = false;
        if (faults.unreadableAfterLostAcknowledgement) faults.statusUnreadable = true;
        throw new RuntimeHostUnavailableError("runtime host request timed out");
      }
      return result;
    },
  };
  if (generation.acknowledgementRejects) {
    client.acknowledgeTerminalProjection = async () => {
      throw new RuntimeHostUnavailableError("runtime request method is unsupported");
    };
  } else if (!generation.legacy) {
    client.acknowledgeTerminalProjection = async (operationIds: readonly string[]) => {
      acknowledged.push(...operationIds);
      return journal.acknowledgeTerminalProjection(operationIds);
    };
  }
  return client as unknown as RuntimeHostClient;
}

function seedConversation(registry: AgentRegistry, directory: string, name: string): { conversationId: `conversation_${string}`; key: SessionKey } {
  const artifactPath = path.join(directory, `${name}.jsonl`);
  const launchProfile = emptyLaunchProfile({ cwd: directory });
  registry.reconcileConversations([{
    engine: "codex",
    path: artifactPath,
    accountId: "lost-ack-fixture-account",
    launchProfile,
    turn: { state: "idle", source: "assistant", terminalAt: null },
    observedAt: "2026-09-09T19:49:00.000Z",
  }]);
  const conversation = registry.conversationForPath(artifactPath);
  const generation = conversation?.generations.at(-1);
  if (!conversation || !generation) throw new Error("seeded conversation is missing");
  const key: SessionKey = { engine: "codex", sessionId: generation.id };
  registry.upsert({
    key,
    artifactPath,
    cwd: directory,
    accountId: "lost-ack-fixture-account",
    launchProfile,
    status: "idle",
    host: null,
    structuredHost: {
      kind: "codex-app-server",
      endpoint: "fake:lost-ack-fixture-host",
      process: null,
      eventCursor: 0,
      protocolVersion: "fake-v1",
      writerClaimEpoch: 0,
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: null,
  });
  return { conversationId: conversation.id as `conversation_${string}`, key };
}

const ORIGINAL_TEXT = "the original message, delivered exactly once";

function fixture(name: string, generation: HostGeneration = {}) {
  const directory = fs.mkdtempSync(path.join(isolated, `${name}-`));
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"), undefined, undefined, { sqliteMode: "off" });
  const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
  const faults: Faults = {
    loseDeliveredAcknowledgement: false,
    unreadableAfterLostAcknowledgement: false,
    statusUnreadable: false,
  };
  const acknowledged: string[] = [];
  const client = runtimeClient(journal, faults, acknowledged, generation);
  const ledger = createFakeDeliveryLedger();
  const host = Object.assign(new FakeEngineHost(ledger), { onStateChange: () => () => {} });
  const { conversationId, key } = seedConversation(registry, directory, name);
  journal.append({
    scope: { type: "session", id: conversationId },
    kind: "session-status",
    payload: {
      conversationId,
      sessionKey: key,
      hostKind: "codex-app-server",
      host: "hosted",
      turn: "idle",
      provenance: "structured",
      artifactPath: path.join(directory, `${name}.jsonl`),
      capabilities: { steer: true, structuredAttention: true },
    },
  });
  const operationId = `op-${name}`;
  const clientMessageId = `client-${name}`;
  const contentDigest = structuredContentDigest({ text: ORIGINAL_TEXT, images: [] });
  return {
    directory,
    registry,
    journal,
    client,
    host,
    ledger,
    faults,
    acknowledged,
    conversationId,
    key,
    operationId,
    clientMessageId,
    contentDigest,
    /** Reserves the operator's message and admits its runtime operation under
        the identity the composer minted, exactly as production does. */
    admit(): string {
      const held = registry.holdDelivery(
        conversationId,
        ORIGINAL_TEXT,
        clientMessageId,
        "text",
        [],
        contentDigest,
        { operationId, kind: "send", policy: "queue", turnId: null },
      );
      registry.beginDeliveryAttempt(held.id, held.generationId!);
      journal.executeOperation({
        kind: "send",
        operationId,
        idempotencyKey: clientMessageId,
        conversationId,
        text: ORIGINAL_TEXT,
        contentDigest,
        policy: "queue",
      });
      return held.id;
    },
    delivery(deliveryId: string) {
      return registry.readOnlySnapshot().heldDeliveries[deliveryId]!;
    },
    async bind(): Promise<void> {
      await bindStructuredDeliveryQueue([{ key, host }], { registry, client });
    },
    async release(): Promise<void> {
      await bindStructuredDeliveryQueue([], { registry, client: null });
      journal.close();
    },
  };
}

/** Drains the queue the way the controller's own retry does, tolerating a pass
    that fails: a failing drain is part of several cases here. */
async function drain(times = 3): Promise<void> {
  for (let attempt = 0; attempt < times; attempt += 1) {
    await Promise.resolve(kickStructuredDeliveryQueue()).catch(() => undefined);
  }
}

async function settles(assertion: () => boolean, what: string, budgetMs = 2_000): Promise<void> {
  for (let waited = 0; waited < budgetMs; waited += 10) {
    if (assertion()) return;
    await Bun.sleep(10);
  }
  throw new Error(`${what} did not settle`);
}

test("a lost delivered acknowledgement settles the original reservation in the same drain, with one recipient write", async () => {
  const subject = fixture("lost-ack");
  try {
    await subject.bind();
    const deliveryId = subject.admit();
    subject.faults.loseDeliveredAcknowledgement = true;

    await drain();

    const delivery = subject.delivery(deliveryId);
    expect(delivery.state).toBe("delivered");
    expect(subject.journal.operationResult(subject.operationId)?.receipt.status).toBe("delivered");
    expect(subject.ledger.writes.length).toBe(1);
    // The identity the operator submitted under is untouched by the repair.
    expect(delivery.command.operationId).toBe(subject.operationId);
    expect(delivery.clientMessageId).toBe(subject.clientMessageId);
    expect(subject.ledger.writes[0]!.text).toBe(ORIGINAL_TEXT);
    expect(subject.ledger.writes[0]!.contentDigest).toBe(subject.contentDigest);
    // The retention the terminal transition took is released once, by id.
    expect(subject.acknowledged).toEqual([subject.operationId]);
    expect(subject.journal.unprojectedTerminalOperationIds()).toEqual([]);
  } finally {
    await subject.release();
  }
});

test("an intact acknowledgement settles the same way and leaves no retention behind", async () => {
  const subject = fixture("intact-ack");
  try {
    await subject.bind();
    const deliveryId = subject.admit();

    await drain(1);

    expect(subject.delivery(deliveryId).state).toBe("delivered");
    expect(subject.ledger.writes.length).toBe(1);
    expect(subject.acknowledged).toEqual([subject.operationId]);
    expect(subject.journal.unprojectedTerminalOperationIds()).toEqual([]);
  } finally {
    await subject.release();
  }
});

test("repeated drains and a controller rebind after the repair write nothing further", async () => {
  const subject = fixture("idempotent-repair");
  try {
    await subject.bind();
    const deliveryId = subject.admit();
    subject.faults.loseDeliveredAcknowledgement = true;
    await drain();
    const repaired = subject.delivery(deliveryId);
    expect(repaired.state).toBe("delivered");

    await drain(3);
    await subject.bind();
    await drain(2);

    const settled = subject.delivery(deliveryId);
    expect(settled.state).toBe("delivered");
    expect(settled.deliveredAt).toBe(repaired.deliveredAt);
    expect(subject.ledger.writes.length).toBe(1);
    // Nothing re-acknowledges a receipt whose retention is already released.
    expect(subject.acknowledged).toEqual([subject.operationId]);
  } finally {
    await subject.release();
  }
});

test("compaction cannot take a terminal receipt whose projection is still owed", async () => {
  const subject = fixture("compaction-before-projection");
  try {
    await subject.bind();
    const deliveryId = subject.admit();
    // The whole gap at once: the answer is lost AND the journal goes unreadable
    // with it, so the repair establishes nothing in the pass that lost it.
    subject.faults.loseDeliveredAcknowledgement = true;
    subject.faults.unreadableAfterLostAcknowledgement = true;
    await drain();
    expect(subject.delivery(deliveryId).state).toBe("delivery-uncertain");

    // Retention pressure arrives before the repair does.
    subject.journal.append({
      scope: { type: "session", id: subject.conversationId },
      kind: "session-status",
      payload: { conversationId: subject.conversationId, host: "hosted", turn: "idle" },
    });
    subject.journal.compact(1);
    expect(subject.journal.operationResult(subject.operationId)?.receipt.status).toBe("delivered");
    expect(subject.journal.unprojectedTerminalOperationIds()).toEqual([subject.operationId]);

    subject.faults.statusUnreadable = false;
    await settles(
      () => subject.delivery(deliveryId).state === "delivered",
      "the retained receipt's projection",
    );
    expect(subject.ledger.writes.length).toBe(1);
    expect(subject.journal.unprojectedTerminalOperationIds()).toEqual([]);
  } finally {
    await subject.release();
  }
});

test("compaction after the projection is acknowledged releases the receipt as it always did", async () => {
  const subject = fixture("compaction-after-projection");
  try {
    await subject.bind();
    const deliveryId = subject.admit();
    subject.faults.loseDeliveredAcknowledgement = true;
    await drain();
    expect(subject.delivery(deliveryId).state).toBe("delivered");

    subject.journal.append({
      scope: { type: "session", id: subject.conversationId },
      kind: "session-status",
      payload: { conversationId: subject.conversationId, host: "hosted", turn: "idle" },
    });
    subject.journal.compact(1);

    expect(subject.journal.operationResult(subject.operationId)).toBeNull();
    expect(subject.delivery(deliveryId).state).toBe("delivered");
    expect(subject.ledger.writes.length).toBe(1);
  } finally {
    await subject.release();
  }
});

test("an unreadable journal leaves the fate unknown and moves nothing", async () => {
  const subject = fixture("unreadable-journal");
  try {
    await subject.bind();
    const deliveryId = subject.admit();
    subject.faults.loseDeliveredAcknowledgement = true;
    subject.faults.unreadableAfterLostAcknowledgement = true;

    await drain();

    const delivery = subject.delivery(deliveryId);
    expect(delivery.state).toBe("delivery-uncertain");
    expect(delivery.deliveredAt).toBeNull();
    // The reservation keeps the payload it would need to be acted on again.
    expect(delivery.text).toBe(ORIGINAL_TEXT);
    expect(subject.ledger.writes.length).toBe(1);
    expect(subject.acknowledged).toEqual([]);
  } finally {
    await subject.release();
  }
});

test("a terminal receipt naming another conversation settles no reservation", async () => {
  const subject = fixture("target-mismatch");
  try {
    const other = seedConversation(subject.registry, subject.directory, "target-mismatch-other");
    subject.journal.append({
      scope: { type: "session", id: other.conversationId },
      kind: "session-status",
      payload: {
        conversationId: other.conversationId,
        sessionKey: other.key,
        hostKind: "codex-app-server",
        host: "hosted",
        turn: "idle",
        provenance: "structured",
        capabilities: { steer: true, structuredAttention: true },
      },
    });
    /* One operation id, two targets: the reservation is held against this
       conversation while the runtime operation belongs to the other one. */
    const held = subject.registry.holdDelivery(
      subject.conversationId,
      ORIGINAL_TEXT,
      subject.clientMessageId,
      "text",
      [],
      subject.contentDigest,
      { operationId: subject.operationId, kind: "send", policy: "queue", turnId: null },
    );
    subject.registry.beginDeliveryAttempt(held.id, held.generationId!);
    subject.journal.executeOperation({
      kind: "send",
      operationId: subject.operationId,
      idempotencyKey: subject.clientMessageId,
      conversationId: other.conversationId,
      text: "a different message on a different target",
      contentDigest: structuredContentDigest({ text: "a different message on a different target", images: [] }),
      policy: "queue",
    });
    subject.registry.recordDeliveryOutcome(held.id, "delivery-uncertain", "delivery result is uncertain");
    subject.journal.transitionOperation(subject.operationId, "delivered", {}, { awaitProjection: true });

    await subject.bind();
    await drain();

    expect(subject.delivery(held.id).state).toBe("delivery-uncertain");
    expect(subject.acknowledged).toEqual([]);
  } finally {
    await subject.release();
  }
});

test("a runtime host without projection retention behaves exactly as it does today", async () => {
  const subject = fixture("legacy-host", { legacy: true });
  try {
    await subject.bind();
    const deliveryId = subject.admit();
    subject.faults.loseDeliveredAcknowledgement = true;

    await drain();

    // The drain-time repair needs no protocol addition at all.
    expect(subject.delivery(deliveryId).state).toBe("delivered");
    expect(subject.ledger.writes.length).toBe(1);
    // Nothing was retained, so compaction behaves as it did before this repair.
    expect(subject.journal.unprojectedTerminalOperationIds()).toEqual([]);
    subject.journal.append({
      scope: { type: "session", id: subject.conversationId },
      kind: "session-status",
      payload: { conversationId: subject.conversationId, host: "hosted", turn: "idle" },
    });
    subject.journal.compact(1);
    expect(subject.journal.operationResult(subject.operationId)).toBeNull();
  } finally {
    await subject.release();
  }
});

test("an acknowledgement the runtime host refuses never fails the delivery it belongs to", async () => {
  const subject = fixture("acknowledgement-refused", { acknowledgementRejects: true });
  try {
    await subject.bind();
    const deliveryId = subject.admit();

    await drain(1);

    expect(subject.delivery(deliveryId).state).toBe("delivered");
    expect(subject.ledger.writes.length).toBe(1);
    // The receipt simply stays retained, which is the safe direction.
    expect(subject.journal.unprojectedTerminalOperationIds()).toEqual([subject.operationId]);
  } finally {
    await subject.release();
  }
});

test("a lost acknowledgement for an operation no reservation owns settles nothing and stops asking", async () => {
  const subject = fixture("no-reservation");
  try {
    await subject.bind();
    /* A runtime operation with no held delivery behind it — the shape a send
       admitted outside the composer leaves. */
    subject.journal.executeOperation({
      kind: "send",
      operationId: subject.operationId,
      idempotencyKey: subject.clientMessageId,
      conversationId: subject.conversationId,
      text: ORIGINAL_TEXT,
      contentDigest: subject.contentDigest,
      policy: "queue",
    });
    subject.faults.loseDeliveredAcknowledgement = true;

    await drain();

    expect(subject.journal.operationResult(subject.operationId)?.receipt.status).toBe("delivered");
    expect(subject.ledger.writes.length).toBe(1);
    expect(Object.keys(subject.registry.readOnlySnapshot().heldDeliveries)).toEqual([]);
    // Established, so the receipt is released rather than retained for ever.
    expect(subject.acknowledged).toEqual([subject.operationId]);
    expect(subject.journal.unprojectedTerminalOperationIds()).toEqual([]);
  } finally {
    await subject.release();
  }
});
