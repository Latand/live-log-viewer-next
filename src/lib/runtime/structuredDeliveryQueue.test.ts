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

  expect(requestedKinds).toEqual([["runtime.send", "runtime.steer", "runtime.answer", "runtime.interrupt", "runtime.kill"]]);
  expect(sent).toEqual(["op-after-spawns"]);
});

test("a full page from one busy conversation cannot hide a later ready conversation", async () => {
  const effects = [
    ...Array.from({ length: 100 }, (_, index) => ({
      id: `effect:blocked-${index}`,
      kind: "runtime.send",
      eventSeq: index + 1,
      payload: {
        operationId: `blocked-${index}`,
        conversationId: "conversation-blocked",
        text: `blocked ${index}`,
        policy: "queue",
      },
    })),
    {
      id: "effect:ready-101",
      kind: "runtime.send",
      eventSeq: 101,
      payload: {
        operationId: "ready-101",
        conversationId: "conversation-ready",
        text: "deliver me",
        policy: "queue",
      },
    },
  ];
  const sent: string[] = [];
  let busySends = 0;
  const busyHost = host(async () => {
    busySends += 1;
    return { outcome: "turn-started", turnId: "unexpected" };
  });
  busyHost.health = async () => ({ ...idleState("session-blocked"), status: "active", activeTurnRef: "turn-blocked" });
  const queue = new StructuredDeliveryQueue({
    effects: async (_kinds, afterEventSeq = 0) => effects
      .filter((effect) => effect.eventSeq > afterEventSeq)
      .slice(0, 100),
    transition: async () => {},
  }, (conversationId) => conversationId === "conversation-blocked"
    ? busyHost
    : host(async (entry) => {
      sent.push(entry.id);
      return { outcome: "turn-started", turnId: "turn-ready" };
    }));

  await queue.drain();

  expect(sent).toEqual(["ready-101"]);
  expect(busySends).toBe(0);
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

test("a bounded stalled target still delivers another ready conversation", async () => {
  let rejectStalled!: (error: Error) => void;
  const stalled = new Promise<DeliveryReceipt>((_resolve, reject) => { rejectStalled = reject; });
  let stalledDead = false;
  const stalledHost = host(async () => stalled);
  stalledHost.health = async () => ({ ...idleState("session-stalled"), status: stalledDead ? "dead" : "idle" });
  const sent: string[] = [];
  const transitions: Array<[string, string]> = [];
  const queue = new StructuredDeliveryQueue({
    effects: async () => [
      {
        id: "effect:op-stalled",
        kind: "runtime.send",
        eventSeq: 25,
        payload: { operationId: "op-stalled", conversationId: "conversation-stalled", text: "wait", policy: "queue" },
      },
      {
        id: "effect:op-ready",
        kind: "runtime.send",
        eventSeq: 26,
        payload: { operationId: "op-ready", conversationId: "conversation-ready", text: "deliver", policy: "queue" },
      },
    ],
    transition: async (operationId, status) => { transitions.push([operationId, status]); },
  }, (conversationId) => conversationId === "conversation-stalled"
    ? stalledHost
    : host(async (entry) => {
      sent.push(entry.id);
      return { outcome: "turn-started", turnId: "turn-ready" };
    }));

  const drain = queue.drain();
  await Bun.sleep(0);
  expect(sent).toEqual(["op-ready"]);

  stalledDead = true;
  rejectStalled(new Error("Claude delivery confirmation timed out; outcome is uncertain"));
  await drain;

  expect(transitions).toContainEqual(["op-ready", "delivered"]);
  expect(transitions).toContainEqual(["op-stalled", "queued"]);
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

test("an idle queue admission keeps its null turn fence when a turn starts before send", async () => {
  const expectedTurns: Array<string | null | undefined> = [];
  const transitions: Array<[string, string, string | null | undefined, string | null | undefined]> = [];
  const racingHost = host(async (entry) => {
    expectedTurns.push(entry.expectedTurnId);
    return { outcome: "rejected", reason: "stale-turn" };
  });
  racingHost.health = async () => idleState();
  const queue = new StructuredDeliveryQueue({
    effects: async () => [{
      id: "effect:op-idle-race",
      kind: "runtime.send",
      eventSeq: 30,
      payload: {
        operationId: "op-idle-race",
        conversationId: "conversation-one",
        text: "queue after the active turn",
        policy: "queue",
      },
    }],
    transition: async (operationId, status, details) => {
      transitions.push([operationId, status, details?.turnId, details?.reason]);
    },
  }, () => racingHost);

  await queue.drain();

  expect(expectedTurns).toEqual([null]);
  expect(transitions).toEqual([
    ["op-idle-race", "delivering", null, undefined],
    ["op-idle-race", "queued", undefined, "stale-turn"],
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

test("an ambiguous steered send keeps its original turn fence after host recovery", async () => {
  const expectedTurns: Array<string | null | undefined> = [];
  const transitions: Array<[string, string, string | null | undefined]> = [];
  const effect = {
    id: "effect:op-ambiguous-steer",
    kind: "runtime.send",
    eventSeq: 32,
    payload: {
      operationId: "op-ambiguous-steer",
      conversationId: "conversation-one",
      text: "amend",
      policy: "steer-if-active",
    } as Record<string, unknown>,
  };
  let recovered = false;
  let pending = true;
  const recoveredHost = host(async (entry) => {
    expectedTurns.push(entry.expectedTurnId);
    if (!recovered) throw new Error("engine child exited");
    return entry.expectedTurnId === "turn-old"
      ? { outcome: "rejected", reason: "stale-turn" }
      : { outcome: "turn-started", turnId: "fresh-turn" };
  });
  recoveredHost.health = async () => ({
    ...idleState(),
    status: recovered ? "idle" : expectedTurns.length > 0 ? "dead" : "active",
    activeTurnRef: recovered ? null : "turn-old",
  });
  const queue = new StructuredDeliveryQueue({
    effects: async () => pending ? [effect] : [],
    transition: async (operationId, status, details) => {
      transitions.push([operationId, status, details?.turnId]);
      if (status === "delivering" && details?.turnId !== undefined) effect.payload.turnId = details.turnId;
      if (status === "failed") pending = false;
    },
  }, () => recoveredHost);

  await queue.drain();
  recovered = true;
  await queue.drain();

  expect(expectedTurns).toEqual(["turn-old", "turn-old"]);
  expect(transitions.map(([operationId, status]) => [operationId, status])).toEqual([
    ["op-ambiguous-steer", "delivering"],
    ["op-ambiguous-steer", "queued"],
    ["op-ambiguous-steer", "delivering"],
    ["op-ambiguous-steer", "failed"],
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

test("an answer reaches the host command channel before queued messages", async () => {
  const calls: string[] = [];
  const transitions: Array<[string, string]> = [];
  const target = host(async (entry) => {
    calls.push(`send:${entry.text}`);
    return { outcome: "turn-started", turnId: "turn-next" };
  });
  target.answer = async (attentionId, resolution) => {
    calls.push(`answer:${attentionId}:${JSON.stringify(resolution)}`);
  };
  const queue = new StructuredDeliveryQueue({
    effects: async () => [
      { id: "send", kind: "runtime.send", eventSeq: 1, payload: { operationId: "send", conversationId: "conversation-one", text: "resume" } },
      { id: "answer", kind: "runtime.answer", eventSeq: 2, payload: { operationId: "answer", conversationId: "conversation-one", attentionId: "question-one", resolution: { answer: "yes" } } },
    ],
    transition: async (operationId, status) => { transitions.push([operationId, status]); },
  }, () => target);

  await queue.drain();

  expect(calls).toEqual([
    'answer:question-one:{"answer":"yes"}',
    "send:resume",
  ]);
  expect(transitions).toContainEqual(["answer", "answered"]);
});

test("interrupt actuates a deliberately held fake-host turn", async () => {
  const calls: string[] = [];
  const target = host(async () => ({ outcome: "queued-next-turn", turnId: "turn-held" }));
  target.health = async () => ({ ...idleState(), status: "active", activeTurnRef: "turn-held" });
  target.interrupt = async (turnId) => { calls.push(turnId); };
  const transitions: Array<[string, string]> = [];
  const queue = new StructuredDeliveryQueue({
    effects: async () => [{
      id: "interrupt",
      kind: "runtime.interrupt",
      eventSeq: 3,
      payload: { operationId: "interrupt", conversationId: "conversation-one", turnId: "turn-held" },
    }],
    transition: async (operationId, status) => { transitions.push([operationId, status]); },
  }, () => target);

  await queue.drain();

  expect(calls).toEqual(["turn-held"]);
  expect(transitions).toEqual([
    ["interrupt", "delivering"],
    ["interrupt", "interrupted"],
  ]);
});

test("a control operation behind a full message page still reaches the active host", async () => {
  const effects = [
    ...Array.from({ length: 100 }, (_, index) => ({
      id: `send-${index}`,
      kind: "runtime.send",
      eventSeq: index + 1,
      payload: { operationId: `send-${index}`, conversationId: "conversation-one", text: `message ${index}`, policy: "queue" },
    })),
    {
      id: "interrupt-after-page",
      kind: "runtime.interrupt",
      eventSeq: 101,
      payload: { operationId: "interrupt-after-page", conversationId: "conversation-one", turnId: "turn-held" },
    },
  ];
  let active = true;
  const interrupts: string[] = [];
  const target = host(async () => ({ outcome: "turn-started", turnId: "unexpected" }));
  target.health = async () => ({ ...idleState(), status: active ? "active" : "idle", activeTurnRef: active ? "turn-held" : null });
  target.interrupt = async (turnId) => { interrupts.push(turnId); active = false; };
  const completed = new Set<string>();
  const queue = new StructuredDeliveryQueue({
    effects: async (_kinds, afterEventSeq = 0) => effects
      .filter((effect) => effect.eventSeq > afterEventSeq && !completed.has(String(effect.payload.operationId)))
      .slice(0, 100),
    transition: async (operationId, status) => {
      if (status === "interrupted" || status === "delivered" || status === "failed") completed.add(operationId);
    },
  }, () => target);

  await queue.drain();

  expect(interrupts).toEqual(["turn-held"]);
});

test("a structured kill terminates its host and completes its receipt", async () => {
  const transitions: Array<[string, string]> = [];
  const terminated: string[] = [];
  const target = host(async () => ({ outcome: "turn-started", turnId: "unexpected" }));
  const queue = new StructuredDeliveryQueue({
    effects: async () => [{
      id: "kill-one",
      kind: "runtime.kill",
      eventSeq: 1,
      payload: {
        operationId: "kill-one",
        conversationId: "conversation-one",
        sessionKey: { engine: "codex", sessionId: "thread-one" },
      },
    }],
    transition: async (operationId, status) => { transitions.push([operationId, status]); },
  }, () => target, async (conversationId, sessionKey) => {
    terminated.push(`${conversationId}:${sessionKey.engine}:${sessionKey.sessionId}`);
    return true;
  });

  await queue.drain();

  expect(terminated).toEqual(["conversation-one:codex:thread-one"]);
  expect(transitions).toEqual([
    ["kill-one", "delivering"],
    ["kill-one", "delivered"],
  ]);
});

test("concurrent kills finish after the first kill removes the host", async () => {
  const pending = new Set(["kill-one", "kill-two"]);
  const transitions: Array<[string, string]> = [];
  let hosted = true;
  let terminations = 0;
  const target = host(async () => ({ outcome: "turn-started", turnId: "unexpected" }));
  const queue = new StructuredDeliveryQueue({
    effects: async () => [...pending].map((operationId, index) => ({
      id: operationId,
      kind: "runtime.kill",
      eventSeq: index + 1,
      payload: {
        operationId,
        conversationId: "conversation-one",
        sessionKey: { engine: "codex", sessionId: "thread-one" },
      },
    })),
    transition: async (operationId, status) => {
      transitions.push([operationId, status]);
      if (status === "delivered" || status === "failed") pending.delete(operationId);
    },
  }, () => hosted ? target : null, async () => {
    terminations += 1;
    hosted = false;
    return true;
  });

  await queue.drain();

  expect(terminations).toBe(2);
  expect(transitions).toEqual([
    ["kill-one", "delivering"],
    ["kill-one", "delivered"],
    ["kill-two", "delivering"],
    ["kill-two", "delivered"],
  ]);
  expect(pending.size).toBe(0);
});

test("an absent-host kill retries after terminal projection fails", async () => {
  let pending = true;
  let attempts = 0;
  const transitions: Array<[string, string, string | null | undefined]> = [];
  const queue = new StructuredDeliveryQueue({
    effects: async () => pending ? [{
      id: "kill-retry",
      kind: "runtime.kill",
      eventSeq: 1,
      payload: {
        operationId: "kill-retry",
        conversationId: "conversation-one",
        sessionKey: { engine: "codex", sessionId: "thread-one" },
      },
    }] : [],
    transition: async (operationId, status, details) => {
      transitions.push([operationId, status, details?.reason]);
      if (status === "delivered" || status === "failed") pending = false;
    },
  }, () => null, async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("dead projection unavailable");
    return true;
  });

  await expect(queue.drain()).rejects.toThrow("dead projection unavailable");

  expect(pending).toBeTrue();
  expect(transitions).toEqual([
    ["kill-retry", "queued", "dead projection unavailable"],
  ]);

  await queue.drain();

  expect(pending).toBeFalse();
  expect(transitions).toEqual([
    ["kill-retry", "queued", "dead projection unavailable"],
    ["kill-retry", "delivering", undefined],
    ["kill-retry", "delivered", undefined],
  ]);
});

test("an active-host kill retries after terminal projection fails", async () => {
  let pending = true;
  let attempts = 0;
  const transitions: Array<[string, string, string | null | undefined]> = [];
  const target = host(async () => ({ outcome: "turn-started", turnId: "unexpected" }));
  const queue = new StructuredDeliveryQueue({
    effects: async () => pending ? [{
      id: "kill-active-retry",
      kind: "runtime.kill",
      eventSeq: 1,
      payload: {
        operationId: "kill-active-retry",
        conversationId: "conversation-one",
        sessionKey: { engine: "codex", sessionId: "thread-one" },
      },
    }] : [],
    transition: async (operationId, status, details) => {
      transitions.push([operationId, status, details?.reason]);
      if (status === "delivered" || status === "failed") pending = false;
    },
  }, () => target, async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("dead projection unavailable");
    return true;
  });

  await expect(queue.drain()).rejects.toThrow("dead projection unavailable");

  expect(pending).toBeTrue();
  expect(transitions).toEqual([
    ["kill-active-retry", "delivering", undefined],
    ["kill-active-retry", "queued", "dead projection unavailable"],
  ]);

  await queue.drain();

  expect(pending).toBeFalse();
  expect(transitions).toEqual([
    ["kill-active-retry", "delivering", undefined],
    ["kill-active-retry", "queued", "dead projection unavailable"],
    ["kill-active-retry", "delivering", undefined],
    ["kill-active-retry", "delivered", undefined],
  ]);
});
