import { expect, test } from "bun:test";

import {
  StructuredCompactError,
  type CompactCapableHost,
  type DeliveryReceipt,
  type EngineHost,
  type HostState,
  type QueueEntry,
  type RuntimeEvent,
} from "./engineHost";
import {
  StructuredDeliveryQueue,
  type StructuredDeliveryEffect,
  type StructuredDeliveryQueuePort,
} from "./structuredDeliveryQueue";

function idleState(overrides: Partial<HostState> = {}): HostState {
  return {
    status: "idle",
    sessionKey: "thread-one",
    endpoint: "test:host",
    pid: 1,
    processStartIdentity: "1",
    eventCursor: 0,
    protocolVersion: "test",
    activeTurnRef: null,
    pendingAttention: [],
    activeFlags: [],
    account: null,
    ...overrides,
  };
}

function baseHost(sent: QueueEntry[]): EngineHost {
  return {
    attach: () => ({ async *[Symbol.asyncIterator](): AsyncIterator<RuntimeEvent> {} }),
    send: async (entry: QueueEntry): Promise<DeliveryReceipt> => {
      sent.push(entry);
      return { outcome: "turn-started", turnId: `turn-${entry.id}` };
    },
    interrupt: async () => {},
    answer: async () => {},
    health: async () => idleState(),
    release: async () => {},
  };
}

function compactEffect(overrides: Partial<Record<string, unknown>> = {}): StructuredDeliveryEffect {
  return {
    id: "effect:op-compact",
    kind: "runtime.compact",
    eventSeq: 7,
    payload: {
      kind: "compact",
      operationId: "op-compact",
      conversationId: "conversation-one",
      idempotencyKey: "op-compact",
      sessionKey: { engine: "codex", sessionId: "thread-one" },
      ...overrides,
    },
  };
}

interface Recorder {
  port: StructuredDeliveryQueuePort;
  transitions: Array<[string, string, string | null | undefined]>;
  settled: Promise<void>;
}

function recorder(effects: StructuredDeliveryEffect[], terminalStatuses = ["delivered", "failed", "uncertain"]): Recorder {
  const transitions: Array<[string, string, string | null | undefined]> = [];
  const completed = new Set<string>();
  let resolveSettled: () => void = () => {};
  const settled = new Promise<void>((resolve) => { resolveSettled = resolve; });
  const port: StructuredDeliveryQueuePort = {
    effects: async (_kinds, afterEventSeq = 0) => effects.filter((effect) =>
      effect.eventSeq > afterEventSeq && !completed.has(String(effect.payload.operationId))),
    transition: async (operationId, status, details) => {
      transitions.push([operationId, status, details?.reason]);
      if (terminalStatuses.includes(status)) {
        completed.add(operationId);
        resolveSettled();
      }
    },
  };
  return { port, transitions, settled };
}

test("a compact effect issues the engine control and terminalizes on compaction evidence", async () => {
  const sent: QueueEntry[] = [];
  const requests: Array<{ operationId: string; threadId: string }> = [];
  let releaseEvidence: (id: string) => void = () => {};
  const host: CompactCapableHost = Object.assign(baseHost(sent), {
    compact: async (request: { operationId: string; threadId: string }) => {
      requests.push(request);
      return new Promise<{ compactionId: string | null }>((resolve) => {
        releaseEvidence = (id) => resolve({ compactionId: id });
      });
    },
  });
  const { port, transitions, settled } = recorder([compactEffect()]);
  const queue = new StructuredDeliveryQueue(port, () => host);

  await queue.drain();

  /* The control is durably marked in flight before the engine hears about it,
     and it never becomes a message. */
  expect(transitions).toEqual([["op-compact", "delivering", undefined]]);
  expect(requests).toEqual([{ operationId: "op-compact", threadId: "thread-one" }]);
  expect(sent).toEqual([]);

  releaseEvidence("compaction-one");
  await settled;

  expect(transitions.at(-1)).toEqual(["op-compact", "delivered", "compaction:compaction-one"]);
});

test("a second drain never reissues a compaction that is still awaiting evidence", async () => {
  const sent: QueueEntry[] = [];
  let calls = 0;
  let releaseEvidence: () => void = () => {};
  const host: CompactCapableHost = Object.assign(baseHost(sent), {
    compact: async () => {
      calls += 1;
      return new Promise<{ compactionId: string | null }>((resolve) => {
        releaseEvidence = () => resolve({ compactionId: "compaction-one" });
      });
    },
  });
  const { port, transitions, settled } = recorder([compactEffect()]);
  const queue = new StructuredDeliveryQueue(port, () => host);

  await queue.drain();
  await queue.drain();
  await queue.drain();

  expect(calls).toBe(1);
  expect(transitions.filter(([, status]) => status === "delivering")).toHaveLength(1);

  releaseEvidence();
  await settled;
  expect(calls).toBe(1);
});

test("a compaction an earlier executor issued is never issued a second time", async () => {
  const sent: QueueEntry[] = [];
  let calls = 0;
  const host: CompactCapableHost = Object.assign(baseHost(sent), {
    compact: async () => { calls += 1; return { compactionId: "compaction-one" }; },
  });
  const { port, transitions, settled } = recorder([compactEffect()]);
  /* The durable receipt already says `delivering`: the control reached the
     engine under a Viewer that is no longer running. */
  port.status = async () => ({ status: "delivering" });
  const queue = new StructuredDeliveryQueue(port, () => host);

  await queue.drain();
  await settled;

  expect(calls).toBe(0);
  expect(sent).toEqual([]);
  expect(transitions).toHaveLength(1);
  expect(transitions[0]![0]).toBe("op-compact");
  expect(transitions[0]![1]).toBe("uncertain");
  expect(transitions[0]![2]).toContain("unverified");
});

test("a runtime-host that rejects the uncertain status still settles the operation", async () => {
  const sent: QueueEntry[] = [];
  const host: CompactCapableHost = Object.assign(baseHost(sent), {
    compact: async () => { throw new StructuredCompactError("Codex app-server host was lost", "unverified"); },
  });
  const effects = [
    compactEffect(),
    {
      id: "effect:op-send",
      kind: "runtime.send",
      eventSeq: 9,
      payload: {
        kind: "send",
        operationId: "op-send",
        conversationId: "conversation-one",
        idempotencyKey: "op-send",
        text: "continue after the compaction",
        policy: "queue",
      },
    } satisfies StructuredDeliveryEffect,
  ];
  const { port, transitions, settled } = recorder(effects);
  const accept = port.transition;
  /* A runtime-host from before #862 does not know the status. The operation
     must still terminalize, or every later pass re-enters the same branch and
     the conversation's queue never drains again. */
  port.transition = async (operationId, status, details) => {
    if (status === "uncertain") throw new Error("runtime operation transition status is invalid");
    await accept(operationId, status, details);
  };
  const queue = new StructuredDeliveryQueue(port, () => host);

  await queue.drain();
  await settled;
  await queue.drain();

  expect(transitions.filter(([, status]) => status === "failed")).toEqual([
    ["op-compact", "failed", "Codex app-server host was lost"],
  ]);
  expect(sent.map((entry) => entry.id)).toEqual(["op-send"]);
});

test("a busy structured turn fails the compact control instead of steering it", async () => {
  const sent: QueueEntry[] = [];
  let calls = 0;
  const host: CompactCapableHost = Object.assign(baseHost(sent), {
    compact: async () => { calls += 1; return { compactionId: null }; },
  });
  host.health = async () => idleState({ status: "active", activeTurnRef: "turn-live" });
  const { port, transitions } = recorder([compactEffect()]);
  const queue = new StructuredDeliveryQueue(port, () => host);

  await queue.drain();

  expect(calls).toBe(0);
  expect(sent).toEqual([]);
  expect(transitions).toEqual([["op-compact", "failed", "busy-turn"]]);
});

test("an engine without a compact control reports a typed capability failure", async () => {
  const sent: QueueEntry[] = [];
  const { port, transitions } = recorder([compactEffect({ sessionKey: { engine: "claude", sessionId: "session-one" } })]);
  const queue = new StructuredDeliveryQueue(port, () => baseHost(sent));

  await queue.drain();

  expect(sent).toEqual([]);
  expect(transitions).toEqual([["op-compact", "failed", "unsupported-capability"]]);
});

test("a rejected compact request terminalizes as failed and an unverified one as uncertain", async () => {
  const sent: QueueEntry[] = [];
  const rejecting: CompactCapableHost = Object.assign(baseHost(sent), {
    compact: async () => { throw new StructuredCompactError("thread/compact/start was refused", "refused"); },
  });
  const rejected = recorder([compactEffect()]);
  await new StructuredDeliveryQueue(rejected.port, () => rejecting).drain();
  await rejected.settled;
  expect(rejected.transitions.at(-1)).toEqual([
    "op-compact",
    "failed",
    "thread/compact/start was refused",
  ]);

  const losing: CompactCapableHost = Object.assign(baseHost(sent), {
    compact: async () => { throw new StructuredCompactError("Codex app-server host was lost", "unverified"); },
  });
  const unverified = recorder([compactEffect()]);
  await new StructuredDeliveryQueue(unverified.port, () => losing).drain();
  await unverified.settled;
  expect(unverified.transitions.at(-1)).toEqual([
    "op-compact",
    "uncertain",
    "Codex app-server host was lost",
  ]);
});

test("a lost host keeps the compact control queued for recovery", async () => {
  const { port, transitions } = recorder([compactEffect()], ["failed", "uncertain", "delivered"]);
  const queue = new StructuredDeliveryQueue(port, () => null);

  await queue.drain();

  expect(transitions).toEqual([]);

  const sent: QueueEntry[] = [];
  const dead: CompactCapableHost = Object.assign(baseHost(sent), {
    compact: async () => ({ compactionId: null }),
  });
  dead.health = async () => idleState({ status: "dead" });
  const deadRun = recorder([compactEffect()], ["queued"]);
  await new StructuredDeliveryQueue(deadRun.port, () => dead).drain();
  expect(deadRun.transitions).toEqual([["op-compact", "queued", "dead-host"]]);
});

test("a queued message behind an in-flight compaction waits for the control to settle", async () => {
  const sent: QueueEntry[] = [];
  let releaseEvidence: () => void = () => {};
  const host: CompactCapableHost = Object.assign(baseHost(sent), {
    compact: async () => new Promise<{ compactionId: string | null }>((resolve) => {
      releaseEvidence = () => resolve({ compactionId: "compaction-one" });
    }),
  });
  const effects = [
    compactEffect(),
    {
      id: "effect:op-send",
      kind: "runtime.send",
      eventSeq: 9,
      payload: {
        kind: "send",
        operationId: "op-send",
        conversationId: "conversation-one",
        idempotencyKey: "op-send",
        text: "continue with the handoff",
        policy: "queue",
      },
    } satisfies StructuredDeliveryEffect,
  ];
  const { port, transitions, settled } = recorder(effects);
  const queue = new StructuredDeliveryQueue(port, () => host);

  await queue.drain();

  expect(sent).toEqual([]);
  expect(transitions.map(([operationId]) => operationId)).toEqual(["op-compact"]);

  releaseEvidence();
  await settled;
  await queue.drain();

  expect(sent.map((entry) => entry.id)).toEqual(["op-send"]);
});
