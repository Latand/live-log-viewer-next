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
