import { expect, test } from "bun:test";

import type { DeliveryReceipt, EngineHost, HostState, QueueEntry, RuntimeEvent } from "./engineHost";
import { StructuredDeliveryQueue, type StructuredDeliveryQueuePort } from "./structuredDeliveryQueue";

function idleState(sessionKey = "session-one"): HostState {
  return {
    status: "idle",
    sessionKey,
    endpoint: "test:host",
    pid: 1,
    processStartIdentity: "1",
    eventCursor: 0,
    protocolVersion: "test",
    activeTurnRef: null,
    pendingAttention: [],
    activeFlags: [],
    account: null,
  };
}

function host(send: (entry: QueueEntry) => Promise<DeliveryReceipt>): EngineHost {
  return {
    attach: () => ({ async *[Symbol.asyncIterator](): AsyncIterator<RuntimeEvent> {} }),
    send,
    interrupt: async () => {},
    answer: async () => {},
    health: async () => idleState(),
    release: async () => {},
  };
}

test("structured delivery preserves queue order within one conversation", async () => {
  const sent: string[] = [];
  const transitions: Array<[string, string]> = [];
  const port: StructuredDeliveryQueuePort = {
    effects: async () => [
      {
        id: "effect:op-two",
        kind: "runtime.send",
        eventSeq: 12,
        payload: { kind: "send", operationId: "op-two", conversationId: "conversation-one", text: "second", idempotencyKey: "two", policy: "queue" },
      },
      {
        id: "effect:op-one",
        kind: "runtime.send",
        eventSeq: 11,
        payload: { kind: "send", operationId: "op-one", conversationId: "conversation-one", text: "first", idempotencyKey: "one", policy: "queue" },
      },
    ],
    transition: async (operationId, status) => {
      transitions.push([operationId, status]);
    },
  };
  const queue = new StructuredDeliveryQueue(port, () => host(async (entry) => {
    sent.push(entry.id);
    return { outcome: "turn-started", turnId: `turn-${entry.id}` };
  }));

  await queue.drain();

  expect(sent).toEqual(["op-one", "op-two"]);
  expect(transitions).toEqual([
    ["op-one", "delivering"],
    ["op-one", "delivered"],
    ["op-two", "delivering"],
    ["op-two", "delivered"],
  ]);
});

test("unrelated outbox effects cannot starve structured message delivery", async () => {
  const allEffects = [
    ...Array.from({ length: 100 }, (_, index) => ({
      id: `effect:spawn-${index}`,
      kind: "runtime.spawn",
      eventSeq: index + 1,
      payload: { operationId: `spawn-${index}` },
    })),
    {
      id: "effect:op-after-spawns",
      kind: "runtime.send",
      eventSeq: 101,
      payload: { operationId: "op-after-spawns", conversationId: "conversation-one", text: "deliver me", policy: "queue" },
    },
  ];
  const requestedKinds: Array<readonly string[]> = [];
  const sent: string[] = [];
  const queue = new StructuredDeliveryQueue({
    effects: async (kinds?: readonly string[]) => {
      requestedKinds.push(kinds ?? []);
      return allEffects.filter((effect) => !kinds || kinds.includes(effect.kind)).slice(0, 100);
    },
    transition: async () => {},
  }, () => host(async (entry) => {
    sent.push(entry.id);
    return { outcome: "turn-started", turnId: "turn-after-spawns" };
  }));

  await queue.drain();

  expect(requestedKinds).toEqual([["runtime.send", "runtime.steer"]]);
  expect(sent).toEqual(["op-after-spawns"]);
});

test("structured delivery surfaces a host actuation failure", async () => {
  const transitions: Array<[string, string, string | null | undefined]> = [];
  const port: StructuredDeliveryQueuePort = {
    effects: async () => [{
      id: "effect:op-failed",
      kind: "runtime.send",
      eventSeq: 20,
      payload: { kind: "send", operationId: "op-failed", conversationId: "conversation-one", text: "hello", idempotencyKey: "failed", policy: "queue" },
    }],
    transition: async (operationId, status, details) => {
      transitions.push([operationId, status, details?.reason]);
    },
  };
  const queue = new StructuredDeliveryQueue(port, () => host(async () => {
    throw new Error("engine write failed");
  }));

  await queue.drain();

  expect(transitions).toEqual([
    ["op-failed", "delivering", undefined],
    ["op-failed", "failed", "engine write failed"],
  ]);
});

test("a host crash leaves the conversation head queued for recovery", async () => {
  const sent: string[] = [];
  const transitions: Array<[string, string, string | null | undefined]> = [];
  let dead = false;
  const crashHost = host(async (entry) => {
    sent.push(entry.id);
    dead = true;
    throw new Error("engine child exited");
  });
  crashHost.health = async () => ({ ...idleState(), status: dead ? "dead" : "idle" });
  const queue = new StructuredDeliveryQueue({
    effects: async () => [
      {
        id: "effect:op-crash",
        kind: "runtime.send",
        eventSeq: 22,
        payload: { operationId: "op-crash", conversationId: "conversation-one", text: "first", policy: "queue" },
      },
      {
        id: "effect:op-after-crash",
        kind: "runtime.send",
        eventSeq: 23,
        payload: { operationId: "op-after-crash", conversationId: "conversation-one", text: "second", policy: "queue" },
      },
    ],
    transition: async (operationId, status, details) => {
      transitions.push([operationId, status, details?.reason]);
    },
  }, () => crashHost);

  await queue.drain();

  expect(sent).toEqual(["op-crash"]);
  expect(transitions).toEqual([
    ["op-crash", "delivering", undefined],
    ["op-crash", "queued", "engine child exited"],
  ]);
});

test("an unavailable host keeps the conversation head queued", async () => {
  const transitions: Array<[string, string, string | null | undefined]> = [];
  let sends = 0;
  const deadHost = host(async () => {
    sends += 1;
    return { outcome: "turn-started", turnId: "unexpected" };
  });
  deadHost.health = async () => ({ ...idleState(), status: "dead" });
  const queue = new StructuredDeliveryQueue({
    effects: async () => [{
      id: "effect:op-waiting",
      kind: "runtime.send",
      eventSeq: 24,
      payload: { operationId: "op-waiting", conversationId: "conversation-one", text: "hello", policy: "queue" },
    }],
    transition: async (operationId, status, details) => {
      transitions.push([operationId, status, details?.reason]);
    },
  }, () => deadHost);

  await queue.drain();

  expect(sends).toBe(0);
  expect(transitions).toEqual([["op-waiting", "queued", "dead-host"]]);
});

test("structured delivery fails image effects before engine actuation", async () => {
  const transitions: Array<[string, string, string | null | undefined]> = [];
  let sends = 0;
  const queue = new StructuredDeliveryQueue({
    effects: async () => [{
      id: "effect:op-image",
      kind: "runtime.send",
      eventSeq: 21,
      payload: {
        kind: "send",
        operationId: "op-image",
        conversationId: "conversation-one",
        text: "see image",
        images: ["/inbox/image.png"],
        idempotencyKey: "image",
        policy: "queue",
      },
    }],
    transition: async (operationId, status, details) => {
      transitions.push([operationId, status, details?.reason]);
    },
  }, () => host(async () => {
    sends += 1;
    return { outcome: "turn-started", turnId: "turn-image" };
  }));

  await queue.drain();

  expect(sends).toBe(0);
  expect(transitions).toEqual([["op-image", "failed", "structured host image delivery is unavailable"]]);
});

test("structured delivery retries the same durable entry after a host race", async () => {
  const sent: string[] = [];
  const transitions: Array<[string, string]> = [];
  let attempt = 0;
  const port: StructuredDeliveryQueuePort = {
    effects: async () => [{
      id: "effect:op-retry",
      kind: "runtime.send",
      eventSeq: 30,
      payload: { kind: "send", operationId: "op-retry", conversationId: "conversation-one", text: "retry", idempotencyKey: "retry", policy: "queue" },
    }],
    transition: async (operationId, status) => {
      transitions.push([operationId, status]);
    },
  };
  const queue = new StructuredDeliveryQueue(port, () => host(async (entry) => {
    sent.push(entry.id);
    attempt += 1;
    return attempt === 1
      ? { outcome: "rejected", reason: "dead-host" }
      : { outcome: "turn-started", turnId: "turn-retry" };
  }));

  await queue.drain();
  await queue.drain();

  expect(sent).toEqual(["op-retry", "op-retry"]);
  expect(transitions).toEqual([
    ["op-retry", "delivering"],
    ["op-retry", "queued"],
    ["op-retry", "delivering"],
    ["op-retry", "delivered"],
  ]);
});

test("a stale steer never retries as a fresh turn after the host becomes idle", async () => {
  const expectedTurns: Array<string | null | undefined> = [];
  const transitions: Array<[string, string, string | null | undefined]> = [];
  let active = true;
  let pending = true;
  const steerHost = host(async (entry) => {
    expectedTurns.push(entry.expectedTurnId);
    active = false;
    return entry.expectedTurnId === "turn-old"
      ? { outcome: "rejected", reason: "stale-turn" }
      : { outcome: "turn-started", turnId: "fresh-turn" };
  });
  steerHost.health = async () => ({
    ...idleState(),
    status: active ? "active" : "idle",
    activeTurnRef: active ? "turn-current" : null,
  });
  const queue = new StructuredDeliveryQueue({
    effects: async () => pending ? [{
      id: "effect:op-stale-steer",
      kind: "runtime.steer",
      eventSeq: 31,
      payload: { operationId: "op-stale-steer", conversationId: "conversation-one", text: "amend", turnId: "turn-old" },
    }] : [],
    transition: async (operationId, status, details) => {
      transitions.push([operationId, status, details?.reason]);
      if (status === "failed") pending = false;
    },
  }, () => steerHost);

  await queue.drain();
  await queue.drain();

  expect(expectedTurns).toEqual(["turn-old"]);
  expect(transitions).toEqual([
    ["op-stale-steer", "delivering", undefined],
    ["op-stale-steer", "failed", "stale-turn"],
  ]);
});

test("overlapping queue kicks share one drain", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let sends = 0;
  let pending = true;
  const port: StructuredDeliveryQueuePort = {
    effects: async () => pending ? [{
      id: "effect:op-one",
      kind: "runtime.send",
      eventSeq: 1,
      payload: { kind: "send", operationId: "op-one", conversationId: "conversation-one", text: "hello", idempotencyKey: "one", policy: "queue" },
    }] : [],
    transition: async (_operationId, status) => {
      if (status === "delivered") pending = false;
    },
  };
  const queue = new StructuredDeliveryQueue(port, () => host(async () => {
    sends += 1;
    await gate;
    return { outcome: "turn-started", turnId: "turn-one" };
  }));

  const first = queue.drain();
  await Promise.resolve();
  await Promise.resolve();
  const second = queue.drain();
  release();
  await Promise.all([first, second]);

  expect(sends).toBe(1);
});
