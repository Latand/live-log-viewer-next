import { expect, test } from "bun:test";

import type { DeliveryReceipt, EngineHost, HostState, QueueEntry, RuntimeEvent } from "./engineHost";
import { StructuredDeliveryQueue, type StructuredDeliveryQueuePort } from "./structuredDeliveryQueue";
import { STRUCTURED_IMAGE_CAPABILITY, structuredContentDigest, type StructuredImageRef } from "./structuredContent";

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

test("a busy structured turn keeps reconfigure queued and applies it before later messages", async () => {
  const actions: string[] = [];
  const terminal = new Set<string>();
  let active = true;
  const currentHost = host(async (entry) => {
    actions.push(`send:${entry.id}`);
    return { outcome: "turn-started", turnId: `turn-${entry.id}` };
  });
  currentHost.health = async () => ({
    ...idleState(),
    status: active ? "active" : "idle",
    activeTurnRef: active ? "turn-current" : null,
  });
  const effects = [
    {
      id: "effect:switch-model",
      kind: "runtime.reconfigure",
      eventSeq: 1,
      payload: {
        operationId: "switch-model", conversationId: "conversation-one",
        model: "gpt-5.6-sol", effort: "high", fast: false,
      },
    },
    {
      id: "effect:message-after-switch",
      kind: "runtime.send",
      eventSeq: 2,
      payload: { operationId: "message-after-switch", conversationId: "conversation-one", text: "next", policy: "queue" },
    },
  ];
  const queue = new StructuredDeliveryQueue({
    effects: async () => effects.filter((effect) => !terminal.has(String(effect.payload.operationId))),
    transition: async (operationId, status) => {
      actions.push(`${status}:${operationId}`);
      if (status === "applied" || status === "failed" || status === "delivered") terminal.add(operationId);
    },
  }, () => currentHost, undefined, undefined, undefined, async (effect) => {
    actions.push(`reconfigure:${effect.model}:${effect.effort}`);
  });

  await queue.drain();
  expect(actions).toEqual([]);

  active = false;
  await queue.drain();
  expect(actions).toEqual([
    "applying:switch-model",
    "reconfigure:gpt-5.6-sol:high",
    "applied:switch-model",
    "delivering:message-after-switch",
    "send:message-after-switch",
    "delivered:message-after-switch",
  ]);
});

test("queued reconfigures are last-write-wins with one host restart", async () => {
  const transitions: Array<[string, string, string | null | undefined]> = [];
  const applied: string[] = [];
  const queue = new StructuredDeliveryQueue({
    effects: async () => [
      {
        id: "effect:switch-one", kind: "runtime.reconfigure", eventSeq: 1,
        payload: { operationId: "switch-one", conversationId: "conversation-one", model: "gpt-5.5", effort: "high", fast: false },
      },
      {
        id: "effect:switch-two", kind: "runtime.reconfigure", eventSeq: 2,
        payload: { operationId: "switch-two", conversationId: "conversation-one", model: "gpt-5.6-sol", effort: "xhigh", fast: true },
      },
    ],
    transition: async (operationId, status, details) => { transitions.push([operationId, status, details?.reason]); },
  }, () => host(async () => ({ outcome: "turn-started", turnId: "unused" })), undefined, undefined, undefined, async (effect) => {
    applied.push(effect.operationId);
  });

  await queue.drain();

  expect(applied).toEqual(["switch-two"]);
  expect(transitions).toEqual([
    ["switch-one", "failed", "superseded"],
    ["switch-two", "applying", undefined],
    ["switch-two", "applied", undefined],
  ]);
});

test("a reconfigure admitted during an active apply supersedes it before publication", async () => {
  const effects = [{
    id: "effect:switch-b",
    kind: "runtime.reconfigure",
    eventSeq: 10,
    payload: { operationId: "switch-b", conversationId: "conversation-one", model: "gpt-5.6-sol", effort: "high", fast: false, accountId: "b" },
  }];
  const terminal = new Set<string>();
  const transitions: Array<[string, string, string | null | undefined]> = [];
  const applied: string[] = [];
  let releaseB!: () => void;
  let enteredB!: () => void;
  const bGate = new Promise<void>((resolve) => { releaseB = resolve; });
  const bEntered = new Promise<void>((resolve) => { enteredB = resolve; });
  const queue = new StructuredDeliveryQueue({
    effects: async () => effects.filter((item) => !terminal.has(String(item.payload.operationId))),
    transition: async (operationId, status, details) => {
      transitions.push([operationId, status, details?.reason]);
      if (status === "applied" || status === "failed") terminal.add(operationId);
    },
  }, () => null, undefined, undefined, undefined, async (effect, ownership) => {
    if (effect.operationId === "switch-b") {
      enteredB();
      await bGate;
    }
    if (!await ownership.isCurrent()) throw new Error("superseded");
    applied.push(effect.operationId);
  });

  const firstDrain = queue.drain();
  await bEntered;
  effects.push({
    id: "effect:switch-c",
    kind: "runtime.reconfigure",
    eventSeq: 11,
    payload: { operationId: "switch-c", conversationId: "conversation-one", model: "gpt-5.6-terra", effort: "xhigh", fast: true, accountId: "c" },
  });
  const rerun = queue.drain();
  releaseB();
  await Promise.all([firstDrain, rerun]);

  expect(applied).toEqual(["switch-c"]);
  expect(transitions).toEqual([
    ["switch-b", "applying", undefined],
    ["switch-b", "failed", "superseded"],
    ["switch-c", "applying", undefined],
    ["switch-c", "applied", undefined],
  ]);
});

test("a dead host applies pending reconfigure before queued delivery recovery", async () => {
  const actions: string[] = [];
  let recovered = false;
  const queue = new StructuredDeliveryQueue({
    effects: async () => [
      {
        id: "effect:switch-after-crash", kind: "runtime.reconfigure", eventSeq: 1,
        payload: { operationId: "switch-after-crash", conversationId: "conversation-one", model: "claude-opus-4-6", effort: "high", fast: null },
      },
      {
        id: "effect:message-after-crash", kind: "runtime.send", eventSeq: 2,
        payload: { operationId: "message-after-crash", conversationId: "conversation-one", text: "continue", policy: "queue" },
      },
    ],
    transition: async (operationId, status) => { actions.push(`${status}:${operationId}`); },
  }, () => recovered ? host(async (entry) => {
    actions.push(`send:${entry.id}`);
    return { outcome: "turn-started", turnId: "turn-recovered" };
  }) : null, undefined, undefined, undefined, async () => {
    actions.push("recover");
    recovered = true;
  });

  await queue.drain();

  expect(actions).toEqual([
    "applying:switch-after-crash",
    "recover",
    "applied:switch-after-crash",
    "delivering:message-after-crash",
    "send:message-after-crash",
    "delivered:message-after-crash",
  ]);
});

test("a runtime settings snapshot on the durable effect rides the queue entry to the host (issue #390 §10)", async () => {
  const entries: QueueEntry[] = [];
  const port: StructuredDeliveryQueuePort = {
    effects: async () => [
      {
        id: "effect:op-runtime",
        kind: "runtime.send",
        eventSeq: 1,
        payload: {
          kind: "send", operationId: "op-runtime", conversationId: "conversation-one",
          text: "run at ultra", idempotencyKey: "one", policy: "queue",
          runtime: { effort: "ultra", fast: true },
        },
      },
      {
        id: "effect:op-plain",
        kind: "runtime.send",
        eventSeq: 2,
        payload: {
          kind: "send", operationId: "op-plain", conversationId: "conversation-one",
          text: "host defaults", idempotencyKey: "two", policy: "queue",
          // A malformed snapshot drops silently — the message itself delivers.
          runtime: "ultra",
        },
      },
    ],
    transition: async () => {},
  };
  const queue = new StructuredDeliveryQueue(port, () => host(async (entry) => {
    entries.push(entry);
    return { outcome: "turn-started", turnId: `turn-${entry.id}` };
  }));

  await queue.drain();

  expect(entries).toHaveLength(2);
  expect(entries[0]!.runtime).toEqual({ effort: "ultra", fast: true });
  expect(entries[1]!.runtime).toBeUndefined();
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

  expect(requestedKinds).toEqual([[
    "runtime.send",
    "runtime.steer",
    "runtime.answer",
    "runtime.interrupt",
    "runtime.kill",
    "runtime.kill-boundary",
    "runtime.reconfigure",
    "runtime.compact",
  ]]);
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

test("a retained successful-kill boundary fences only earlier operations", async () => {
  const pending = new Set(["send-before", "send-after"]);
  const transitions: Array<[string, string]> = [];
  const writes: string[] = [];
  const queue = new StructuredDeliveryQueue({
    effects: async (_kinds, afterEventSeq = 0) => [{
      id: "effect:send-before",
      kind: "runtime.send",
      eventSeq: 1,
      payload: { operationId: "send-before", conversationId: "conversation-one", text: "stale", policy: "queue" },
    }, {
      id: "kill-boundary:conversation-one",
      kind: "runtime.kill-boundary",
      eventSeq: 2,
      payload: { operationId: "kill-one", conversationId: "conversation-one", admissionEventSeq: 2 },
    }, {
      id: "effect:send-after",
      kind: "runtime.send",
      eventSeq: 3,
      payload: { operationId: "send-after", conversationId: "conversation-one", text: "successor", policy: "queue" },
    }].filter((effect) => effect.eventSeq > afterEventSeq
      && (effect.kind === "runtime.kill-boundary" || pending.has(String(effect.payload.operationId)))),
    transition: async (operationId, status) => {
      transitions.push([operationId, status]);
      if (status === "delivered" || status === "failed") pending.delete(operationId);
    },
  }, () => host(async (entry) => {
    writes.push(entry.id);
    return { outcome: "turn-started", turnId: `turn:${entry.id}` };
  }));

  await queue.drain();
  await queue.drain();

  expect(writes).toEqual(["send-after"]);
  expect(transitions).toEqual([
    ["send-before", "failed"],
    ["send-after", "delivering"],
    ["send-after", "delivered"],
  ]);
});

test("a host that cannot answer for a send it was handed settles it unverified", async () => {
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

  /* The send was already in the host's hands when the write threw, and a live
     host proves nothing about it either: the confirmed-delivery record that
     could have said is the very thing this call failed to get. `failed` is what
     the receipt reads as fenced and answers `resend: "safe"` — and a resend
     goes out under a new request id, which nothing on the host side would
     dedupe against this attempt — so the fate is recorded as unknown (#1131). */
  expect(transitions).toEqual([
    ["op-failed", "delivering", undefined],
    ["op-failed", "uncertain", "delivery was started and the structured host did not answer; whether it reached the recipient is unverified: engine write failed"],
  ]);
});

test("a Codex thread/read timeout retries within the bounded drain", async () => {
  const transitions: Array<[string, string, string | null | undefined]> = [];
  let attempts = 0;
  const slowHost = host(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("thread/read timed out");
    return { outcome: "steered", turnId: "turn-slow-read" };
  });
  slowHost.health = async () => ({ ...idleState(), status: "active", activeTurnRef: "turn-slow-read" });
  const queue = new StructuredDeliveryQueue({
    effects: async () => [{
      id: "effect:op-slow-read",
      kind: "runtime.send",
      eventSeq: 21,
      payload: {
        operationId: "op-slow-read",
        conversationId: "conversation-slow-read",
        text: "please keep going",
        policy: "steer-if-active",
      },
    }],
    transition: async (operationId, status, details) => {
      transitions.push([operationId, status, details?.reason]);
    },
  }, () => slowHost);

  await queue.drain();

  expect(attempts).toBe(2);
  expect(transitions).toEqual([
    ["op-slow-read", "delivering", undefined],
    ["op-slow-read", "delivered", undefined],
  ]);
});

test("an exhausted thread/read budget stays queued for automatic delivery", async () => {
  const transitions: Array<[string, string, string | null | undefined]> = [];
  let attempts = 0;
  let retries = 0;
  const slowHost = host(async () => {
    attempts += 1;
    throw new Error("Codex app-server request timed out: thread/read");
  });
  slowHost.health = async () => ({ ...idleState(), status: "active", activeTurnRef: "turn-slow-read" });
  const queue = new StructuredDeliveryQueue({
    effects: async () => [{
      id: "effect:op-slow-read-retry",
      kind: "runtime.send",
      eventSeq: 22,
      payload: {
        operationId: "op-slow-read-retry",
        conversationId: "conversation-slow-read",
        text: "keep this safe",
        policy: "steer-if-active",
      },
    }],
    transition: async (operationId, status, details) => {
      transitions.push([operationId, status, details?.reason]);
    },
  }, () => slowHost, undefined, () => { retries += 1; });

  await queue.drain();

  expect(attempts).toBe(2);
  expect(retries).toBe(1);
  expect(transitions).toEqual([
    ["op-slow-read-retry", "delivering", undefined],
    ["op-slow-read-retry", "queued", "delivery-auto-retry"],
  ]);
});

test("a host crash leaves the message it took unverified, never queued as unexecuted", async () => {
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

  /* The host HAD the instruction before it died — that is what `sent` records —
     so putting the operation back to `queued` said it was never executed, and a
     receipt read from that called a resend safe. It is absorbing and uncertain
     instead (#1131); the effect behind it still waits for recovery. */
  expect(sent).toEqual(["op-crash"]);
  expect(transitions).toEqual([
    ["op-crash", "delivering", undefined],
    ["op-crash", "uncertain", "delivery was started and the structured host did not answer; whether it reached the recipient is unverified: engine child exited"],
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
  /* The stalled target's own send was already in the host's hands when the
     confirmation timed out and the host died, so it settles as unverified
     rather than going back to `queued`. */
  expect(transitions).toContainEqual(["op-stalled", "uncertain"]);
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

test("structured delivery preserves ordered image refs and their content digest", async () => {
  const transitions: Array<[string, string, string | null | undefined]> = [];
  const sent: QueueEntry[] = [];
  const images: StructuredImageRef[] = [
    { sha256: "a".repeat(64), mime: "image/png", bytes: 67 },
    { sha256: "b".repeat(64), mime: "image/jpeg", bytes: 91 },
  ];
  const contentDigest = structuredContentDigest({ text: "see images", images });
  const imageHost = host(async (entry) => {
    sent.push(entry);
    return { outcome: "turn-started", turnId: "turn-image" };
  });
  imageHost.health = async () => ({ ...idleState(), activeFlags: [STRUCTURED_IMAGE_CAPABILITY] });
  const queue = new StructuredDeliveryQueue({
    effects: async () => [{
      id: "effect:op-image",
      kind: "runtime.send",
      eventSeq: 21,
      payload: {
        kind: "send",
        operationId: "op-image",
        conversationId: "conversation-one",
        text: "see images",
        images,
        contentDigest,
        idempotencyKey: "image",
        policy: "queue",
      },
    }],
    transition: async (operationId, status, details) => {
      transitions.push([operationId, status, details?.reason]);
    },
  }, () => imageHost);

  await queue.drain();

  expect(sent).toEqual([{
    id: "op-image",
    content: { text: "see images", images },
    contentDigest,
    text: "see images",
    images,
    expectedTurnId: null,
  }]);
  expect(transitions).toEqual([
    ["op-image", "delivering", undefined],
    ["op-image", "delivered", undefined],
  ]);
});

test("an image effect reaches the host when capability discovery is still pending", async () => {
  const transitions: Array<[string, string, string | null | undefined]> = [];
  let sends = 0;
  const images: StructuredImageRef[] = [{ sha256: "c".repeat(64), mime: "image/png", bytes: 67 }];
  const contentDigest = structuredContentDigest({ text: "probe again", images });
  const imageHost = host(async () => {
    sends += 1;
    throw new Error("Codex image capability discovery is temporarily unavailable; retry shortly.");
  });
  imageHost.health = async () => ({ ...idleState(), activeFlags: [] });
  const queue = new StructuredDeliveryQueue({
    effects: async () => [{
      id: "effect:op-image-probe",
      kind: "runtime.send",
      eventSeq: 22,
      payload: {
        operationId: "op-image-probe",
        conversationId: "conversation-one",
        text: "probe again",
        images,
        contentDigest,
        policy: "queue",
      },
    }],
    transition: async (operationId, status, details) => {
      transitions.push([operationId, status, details?.reason]);
    },
  }, () => imageHost);

  await queue.drain();

  expect(sends).toBe(1);
  /* A capability the host refused by throwing is indistinguishable, from out
     here, from a write that reached the engine and could not be confirmed —
     `host.send` either returns a receipt or does not. So it settles unverified
     too: one caller verification is the cheaper of the two errors, and the
     alternative is telling them a resend is safe on a send that may have
     landed (#1131). */
  expect(transitions).toEqual([
    ["op-image-probe", "delivering", undefined],
    ["op-image-probe", "uncertain", "delivery was started and the structured host did not answer; whether it reached the recipient is unverified: Codex image capability discovery is temporarily unavailable; retry shortly."],
  ]);
});

test("an invalid durable image effect is terminalized instead of disappearing from the queue", async () => {
  const transitions: Array<[string, string, string | null | undefined]> = [];
  let hostResolutions = 0;
  const queue = new StructuredDeliveryQueue({
    effects: async () => [{
      id: "effect:op-invalid-image",
      kind: "runtime.send",
      eventSeq: 22,
      payload: {
        operationId: "op-invalid-image",
        conversationId: "conversation-one",
        text: "see image",
        images: [{ sha256: "a".repeat(64), mime: "image/png", bytes: 67 }],
        contentDigest: "b".repeat(64),
        policy: "queue",
      },
    }],
    transition: async (operationId, status, details) => {
      transitions.push([operationId, status, details?.reason]);
    },
  }, () => {
    hostResolutions += 1;
    return null;
  });

  await queue.drain();

  expect(hostResolutions).toBe(0);
  expect(transitions).toEqual([["op-invalid-image", "failed", "structured delivery effect is invalid"]]);
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

test("interrupt-active stops the current turn before starting the user message", async () => {
  const actions: string[] = [];
  const transitions: Array<[string, string, string | null | undefined]> = [];
  let active = true;
  const replacingHost = host(async (entry) => {
    actions.push(`send:${String(entry.expectedTurnId)}`);
    return { outcome: "turn-started", turnId: "turn-new" };
  });
  replacingHost.health = async () => ({
    ...idleState(),
    status: active ? "active" : "idle",
    activeTurnRef: active ? "turn-current" : null,
  });
  replacingHost.interrupt = async (turnId) => {
    actions.push(`interrupt:${turnId}`);
    active = false;
  };
  const queue = new StructuredDeliveryQueue({
    effects: async () => [{
      id: "effect:op-replace",
      kind: "runtime.send",
      eventSeq: 31,
      payload: {
        operationId: "op-replace",
        conversationId: "conversation-one",
        text: "new direction",
        policy: "interrupt-active",
      },
    }],
    transition: async (operationId, status, details) => {
      transitions.push([operationId, status, details?.turnId]);
    },
  }, () => replacingHost);

  await queue.drain();

  expect(actions).toEqual(["interrupt:turn-current", "send:null"]);
  expect(transitions).toEqual([
    ["op-replace", "delivering", "turn-current"],
    ["op-replace", "delivered", "turn-new"],
  ]);
});

test("interrupt-active waits for the interrupted turn to become idle before sending", async () => {
  const actions: string[] = [];
  const transitions: Array<[string, string, string | null | undefined]> = [];
  const effect = {
    id: "effect:op-wait-for-interrupt",
    kind: "runtime.send",
    eventSeq: 32,
    payload: {
      operationId: "op-wait-for-interrupt",
      conversationId: "conversation-one",
      text: "start after interruption",
      policy: "interrupt-active",
    } as Record<string, unknown>,
  };
  let active = true;
  let pending = true;
  const replacingHost = host(async (entry) => {
    actions.push(`send:${String(entry.expectedTurnId)}`);
    pending = false;
    return { outcome: "turn-started", turnId: "turn-new" };
  });
  replacingHost.health = async () => ({
    ...idleState(),
    status: active ? "active" : "idle",
    activeTurnRef: active ? "turn-current" : null,
  });
  replacingHost.interrupt = async (turnId) => {
    actions.push(`interrupt:${turnId}`);
  };
  const queue = new StructuredDeliveryQueue({
    effects: async () => pending ? [effect] : [],
    transition: async (operationId, status, details) => {
      transitions.push([operationId, status, details?.turnId]);
      if (status === "delivering" && effect.payload.turnId === undefined) {
        effect.payload.turnId = details?.turnId;
      }
    },
  }, () => replacingHost);

  await queue.drain();
  expect(actions).toEqual(["interrupt:turn-current"]);

  active = false;
  await queue.drain();

  expect(actions).toEqual(["interrupt:turn-current", "send:null"]);
  expect(transitions).toEqual([
    ["op-wait-for-interrupt", "delivering", "turn-current"],
    ["op-wait-for-interrupt", "queued", undefined],
    ["op-wait-for-interrupt", "delivering", "turn-current"],
    ["op-wait-for-interrupt", "delivered", "turn-new"],
  ]);
});

test("interrupt-active preserves a newer turn during ambiguous delivery recovery", async () => {
  const actions: string[] = [];
  let activeTurn: string | null = "turn-newer";
  let pending = true;
  const recoveringHost = host(async (entry) => {
    actions.push(`send:${String(entry.expectedTurnId)}`);
    pending = false;
    return { outcome: "turn-started", turnId: "turn-recovered" };
  });
  recoveringHost.health = async () => ({
    ...idleState(),
    status: activeTurn ? "active" : "idle",
    activeTurnRef: activeTurn,
  });
  recoveringHost.interrupt = async (turnId) => {
    actions.push(`interrupt:${turnId}`);
  };
  const queue = new StructuredDeliveryQueue({
    effects: async () => pending ? [{
      id: "effect:op-recover-replacement",
      kind: "runtime.send",
      eventSeq: 33,
      payload: {
        operationId: "op-recover-replacement",
        conversationId: "conversation-one",
        text: "recover safely",
        policy: "interrupt-active",
        turnId: "turn-original",
      },
    }] : [],
    transition: async () => {},
  }, () => recoveringHost);

  await queue.drain();
  expect(actions).toEqual([]);

  activeTurn = null;
  await queue.drain();
  expect(actions).toEqual(["send:null"]);
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

test("a send an earlier executor already took is settled, not delivered a second time", async () => {
  /* The durable receipt is the fence. A process that died between `delivering`
     and its terminal transition leaves the effect in the outbox, and whoever
     drains next — this process after a runtime-host restart, a successor
     release, a Viewer that came back — would otherwise deliver an instruction
     the recipient may already have. The same guard `drainCompact` applies to a
     control (#1131). */
  const sent: string[] = [];
  const transitions: Array<[string, string, string | null | undefined]> = [];
  const queue = new StructuredDeliveryQueue({
    effects: async () => [{
      id: "effect:op-stranded",
      kind: "runtime.send",
      eventSeq: 40,
      payload: { kind: "send", operationId: "op-stranded", conversationId: "conversation-one", text: "roll the release forward", policy: "queue" },
    }],
    transition: async (operationId, status, details) => {
      transitions.push([operationId, status, details?.reason]);
    },
    status: async () => ({ status: "delivering" }),
  }, () => host(async (entry) => {
    sent.push(entry.text ?? "");
    return { outcome: "turn-started", turnId: "turn-stranded" };
  }));

  await queue.drain();

  expect(sent).toEqual([]);
  expect(transitions).toEqual([
    ["op-stranded", "uncertain", "delivery was started by an earlier executor; whether it reached the recipient is unverified"],
  ]);
});

test("a steered send the dying host took is not delivered again when the host returns", async () => {
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
      if (status === "failed" || status === "uncertain") pending = false;
    },
  }, () => recoveredHost);

  await queue.drain();
  recovered = true;
  await queue.drain();

  /* The host took this steer under `turn-old` and then died. Re-delivering it
     when the host came back was a SECOND actuation of an instruction that may
     already have landed, so the recovered host is handed nothing at all and the
     receipt says the fate is unknown. The turn fence a live host preserves
     across attempts is covered by the stale-steer test above. */
  expect(expectedTurns).toEqual(["turn-old"]);
  expect(transitions.map(([operationId, status]) => [operationId, status])).toEqual([
    ["op-ambiguous-steer", "delivering"],
    ["op-ambiguous-steer", "uncertain"],
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

test("a post-admission barrier starts a fresh pass after an active drain", async () => {
  let releasePreAdmissionPass!: () => void;
  const preAdmissionPass = new Promise<void>((resolve) => { releasePreAdmissionPass = resolve; });
  let preAdmissionPassStarted!: () => void;
  const preAdmissionPassEntered = new Promise<void>((resolve) => { preAdmissionPassStarted = resolve; });
  let passes = 0;
  let initialDrainSettled = false;
  let pending = false;
  let sends = 0;
  const queue = new StructuredDeliveryQueue({
    effects: async () => {
      const pendingAtPassStart = pending;
      passes += 1;
      if (passes === 1) {
        preAdmissionPassStarted();
        await preAdmissionPass;
      }
      return pendingAtPassStart ? [{
        id: "effect:post-admission",
        kind: "runtime.send",
        eventSeq: 1,
        payload: {
          kind: "send",
          operationId: "post-admission",
          conversationId: "conversation-one",
          text: "recover",
          idempotencyKey: "post-admission",
          policy: "queue",
        },
      }] : [];
    },
    transition: async (_operationId, status) => {
      if (status === "delivered") pending = false;
    },
  }, () => host(async () => {
    expect(initialDrainSettled).toBe(true);
    sends += 1;
    return { outcome: "turn-started", turnId: "turn-recovered" };
  }));

  const initialDrain = queue.drain();
  void initialDrain.then(() => { initialDrainSettled = true; });
  await preAdmissionPassEntered;
  pending = true;
  const settled = queue.drainAfterAdmission();
  releasePreAdmissionPass();
  await Promise.all([initialDrain, settled]);

  expect(passes).toBe(2);
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

for (const order of ["reconfigure-then-kill", "kill-then-reconfigure"] as const) {
  test(`a delivered kill fences a pending same-generation reconfigure admitted ${order}`, async () => {
    const reconfigure = {
      id: "reconfigure-one",
      kind: "runtime.reconfigure",
      eventSeq: order === "reconfigure-then-kill" ? 1 : 2,
      payload: {
        operationId: "reconfigure-one",
        conversationId: "conversation-one",
        sessionKey: { engine: "codex", sessionId: "thread-one" },
        model: "gpt-5.6-sol",
        effort: "high",
        fast: false,
      },
    };
    const kill = {
      id: "kill-one",
      kind: "runtime.kill",
      eventSeq: order === "reconfigure-then-kill" ? 2 : 1,
      payload: {
        operationId: "kill-one",
        conversationId: "conversation-one",
        sessionKey: { engine: "codex", sessionId: "thread-one" },
      },
    };
    const transitions: Array<[string, string, string | null | undefined]> = [];
    const actions: string[] = [];
    let hosted = true;
    const target = host(async () => ({ outcome: "turn-started", turnId: "unexpected" }));
    const queue = new StructuredDeliveryQueue({
      effects: async () => [reconfigure, kill],
      transition: async (operationId, status, details) => {
        transitions.push([operationId, status, details?.reason]);
      },
    }, () => hosted ? target : null, async () => {
      actions.push("terminate");
      hosted = false;
      return true;
    }, undefined, undefined, async () => {
      actions.push("recover");
      hosted = true;
    });

    await queue.drain();

    expect(actions).toEqual(["terminate"]);
    expect(hosted).toBeFalse();
    expect(transitions).toEqual([
      ["kill-one", "delivering", undefined],
      ["kill-one", "delivered", undefined],
      ["reconfigure-one", "failed", "conversation-killed"],
    ]);
  });
}

test("a failed kill leaves the queued send eligible for its live host", async () => {
  const pending = new Set(["send-one", "kill-one"]);
  const transitions: Array<[string, string, string | null | undefined]> = [];
  const writes: string[] = [];
  const target = host(async (entry) => {
    writes.push(entry.id);
    return { outcome: "turn-started", turnId: `turn:${entry.id}` };
  });
  const queue = new StructuredDeliveryQueue({
    effects: async () => [{
      id: "send-one",
      kind: "runtime.send",
      eventSeq: 1,
      payload: {
        operationId: "send-one",
        conversationId: "conversation-one",
        text: "deliver after the failed kill",
        policy: "queue",
      },
    }, {
      id: "kill-one",
      kind: "runtime.kill",
      eventSeq: 2,
      payload: {
        operationId: "kill-one",
        conversationId: "conversation-one",
        sessionKey: { engine: "codex", sessionId: "thread-one" },
      },
    }].filter((effect) => pending.has(String(effect.payload.operationId))),
    transition: async (operationId, status, details) => {
      transitions.push([operationId, status, details?.reason]);
      if (status === "delivered" || status === "failed") pending.delete(operationId);
    },
  }, () => target, async () => false);

  await queue.drain();

  expect(writes).toEqual(["send-one"]);
  expect(transitions).toEqual([
    ["kill-one", "delivering", undefined],
    ["kill-one", "failed", "structured host termination is unavailable"],
    ["send-one", "delivering", undefined],
    ["send-one", "delivered", undefined],
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

/**
 * A durable delivery journal small enough to be read twice, by two executors
 * (#1131). The receipt keeps whatever reason the transition recorded, because
 * that is where an executor stamps the claim it is delivering under.
 */
function ownershipJournal(claim: () => string | null): {
  port: StructuredDeliveryQueuePort;
  receipts: Map<string, { status: string; reason?: string | null }>;
  writes: string[];
  pending: Set<string>;
  transitions: Array<[string, string, string | null]>;
} {
  const receipts = new Map<string, { status: string; reason?: string | null }>([
    ["op-owned", { status: "queued", reason: null }],
  ]);
  const pending = new Set(["op-owned"]);
  const writes: string[] = [];
  const transitions: Array<[string, string, string | null]> = [];
  return {
    receipts,
    writes,
    pending,
    transitions,
    port: {
      effects: async () => [...pending].map((operationId) => ({
        id: `effect:${operationId}`,
        kind: "runtime.send",
        eventSeq: 21,
        payload: { kind: "send", operationId, conversationId: "conversation-one", text: "ship it", idempotencyKey: "owned", policy: "queue" },
      })),
      transition: async (operationId, status, details) => {
        transitions.push([operationId, status, details?.reason ?? null]);
        receipts.set(operationId, { status, reason: details?.reason ?? null });
        if (status !== "queued" && status !== "delivering") pending.delete(operationId);
      },
      status: async (operationId) => receipts.get(operationId) ?? null,
      hostClaim: () => claim(),
    },
  };
}

test("a delivering send whose executor still owns the host is left to that executor", async () => {
  /* The row an executor writes before it calls the engine says only that
     actuation began; whether it was ABANDONED is a separate question, and the
     answer used to be assumed. A second executor draining the same journal
     during a release succession would terminalize a send the first one was
     still delivering — the durable fence dropping work that was going
     somewhere. The claim it recorded is the evidence: while it still owns the
     host, the row is its to settle. */
  let claim: string | null = "claim-alpha:3";
  const journal = ownershipJournal(() => claim);
  const writes: string[] = [];
  const engine = () => host(async (entry) => {
    writes.push(entry.id);
    return { outcome: "turn-started" as const, turnId: "turn-owned" };
  });

  /* The owner takes it into delivery and does not come back within this pass —
     the send is on the wire. */
  const owner = new StructuredDeliveryQueue(journal.port, engine);
  await owner.drain();
  expect(writes).toEqual(["op-owned"]);
  const recorded = journal.transitions.find(([, status]) => status === "delivering")?.[2] ?? null;
  expect(recorded).toContain("delivering-owner:");
  journal.receipts.set("op-owned", { status: "delivering", reason: recorded });
  journal.pending.add("op-owned");

  /* A second executor, drained while the first still holds the claim. */
  const successor = new StructuredDeliveryQueue(journal.port, engine);
  await successor.drain();
  expect(writes).toEqual(["op-owned"]);
  expect(journal.receipts.get("op-owned")).toMatchObject({ status: "delivering", reason: recorded });

  /* Ownership actually changes — the host was re-adopted, so the earlier
     executor can no longer write to the engine and can no longer answer for the
     send either. NOW it is abandoned, and it ends the only way an actuated send
     may: unverified, never queued, never written again. */
  claim = "claim-beta:4";
  const afterHandover = new StructuredDeliveryQueue(journal.port, engine);
  await afterHandover.drain();
  expect(writes).toEqual(["op-owned"]);
  expect(journal.receipts.get("op-owned")).toMatchObject({
    status: "uncertain",
    reason: "delivery was started by an earlier executor; whether it reached the recipient is unverified",
  });
});

test("a delivering send whose ownership evidence cannot be read is left to its executor", async () => {
  /* The finding this closes: an absent or failing claim read arrived at the
     comparison as `null` and lost it, so a gap in the claim projection was
     enough to terminalize a send another executor was actuating right then.
     Absence of evidence is not evidence of a handover. Both shapes of "cannot
     read" — a projection with nothing recorded, and one that throws — leave the
     row where it is; the receipt deadline is what ends a send whose owner never
     comes back, and it needs none of this to be healthy. */
  let claim: () => string | null = () => "claim-alpha:3";
  const journal = ownershipJournal(() => claim());
  const writes: string[] = [];
  const engine = () => host(async (entry) => {
    writes.push(entry.id);
    return { outcome: "turn-started" as const, turnId: "turn-owned" };
  });

  const owner = new StructuredDeliveryQueue(journal.port, engine);
  await owner.drain();
  const recorded = journal.transitions.find(([, status]) => status === "delivering")?.[2] ?? null;
  expect(recorded).toContain("delivering-owner:");
  const stillDelivering = () => {
    journal.receipts.set("op-owned", { status: "delivering", reason: recorded });
    journal.pending.add("op-owned");
  };

  /* Nothing recorded for the conversation. */
  claim = () => null;
  stillDelivering();
  await new StructuredDeliveryQueue(journal.port, engine).drain();
  expect(writes).toEqual(["op-owned"]);
  expect(journal.receipts.get("op-owned")).toMatchObject({ status: "delivering", reason: recorded });

  /* The read itself fails. */
  claim = () => { throw new Error("claim projection is unavailable"); };
  stillDelivering();
  await new StructuredDeliveryQueue(journal.port, engine).drain();
  expect(writes).toEqual(["op-owned"]);
  expect(journal.receipts.get("op-owned")).toMatchObject({ status: "delivering", reason: recorded });

  /* No pass has terminalized it, and none has sent it again either — the row is
     still exactly where its executor left it. */
  expect(journal.transitions.filter(([, status]) => status === "uncertain")).toEqual([]);

  /* And an explicitly DIFFERENT claim, which is the only evidence that proves
     the executor can no longer write to the engine, still ends it. */
  claim = () => "claim-beta:4";
  stillDelivering();
  await new StructuredDeliveryQueue(journal.port, engine).drain();
  expect(writes).toEqual(["op-owned"]);
  expect(journal.receipts.get("op-owned")).toMatchObject({
    status: "uncertain",
    reason: "delivery was started by an earlier executor; whether it reached the recipient is unverified",
  });
});

test("a delivering send this executor abandoned itself settles unverified rather than waiting on itself", async () => {
  /* Ownership evidence must never become a way to hang: a row this executor
     wrote and then lost — a pass that threw between the engine write and the
     transition — matches the current claim, and there is nobody but this pass
     to end it. */
  const journal = ownershipJournal(() => "claim-alpha:3");
  const writes: string[] = [];
  const queue = new StructuredDeliveryQueue(journal.port, () => host(async (entry) => {
    writes.push(entry.id);
    throw new Error("runtime stopped before confirmation commit");
  }));

  await queue.drain().catch(() => undefined);
  expect(journal.receipts.get("op-owned")?.status).toBe("uncertain");
  /* The pass that threw before its own transition landed: the row is still
     `delivering`, stamped by this very executor. */
  journal.receipts.set("op-owned", {
    status: "delivering",
    reason: journal.transitions.find(([, status]) => status === "delivering")?.[2] ?? null,
  });
  journal.pending.add("op-owned");
  await queue.drain();

  expect(writes).toEqual(["op-owned"]);
  expect(journal.receipts.get("op-owned")?.status).toBe("uncertain");
});
