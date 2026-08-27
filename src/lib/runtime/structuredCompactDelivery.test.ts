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
import { CLAUDE_COMPACT_UNOBSERVED_REASON } from "./claudeStreamBrokerHost";
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
    id: "effect:op-one",
    kind: "runtime.compact",
    eventSeq: 7,
    payload: {
      kind: "compact",
      operationId: "op-one",
      conversationId: "conversation-one",
      idempotencyKey: "op-one",
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
  expect(transitions).toEqual([["op-one", "delivering", undefined]]);
  expect(requests).toEqual([{ operationId: "op-one", threadId: "thread-one" }]);
  expect(sent).toEqual([]);

  releaseEvidence("compaction-one");
  await settled;

  expect(transitions.at(-1)).toEqual(["op-one", "delivered", "compaction:compaction-one"]);
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
  expect(transitions[0]![0]).toBe("op-one");
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
    ["op-one", "failed", "Codex app-server host was lost"],
  ]);
  expect(sent.map((entry) => entry.id)).toEqual(["op-send"]);
});

test("an in-flight compaction holds messages but never holds kill", async () => {
  const sent: QueueEntry[] = [];
  const terminations: string[] = [];
  const host: CompactCapableHost = Object.assign(baseHost(sent), {
    /* A compaction that never settles: in production this window is minutes. */
    compact: async () => new Promise<{ compactionId: string | null }>(() => {}),
  });
  const effects = [
    compactEffect(),
    {
      id: "effect:op-kill",
      kind: "runtime.kill",
      eventSeq: 8,
      payload: {
        kind: "kill",
        operationId: "op-kill",
        conversationId: "conversation-one",
        idempotencyKey: "op-kill",
        sessionKey: { engine: "codex", sessionId: "thread-one" },
      },
    } satisfies StructuredDeliveryEffect,
    {
      id: "effect:op-send",
      kind: "runtime.send",
      eventSeq: 9,
      payload: {
        kind: "send",
        operationId: "op-send",
        conversationId: "conversation-one",
        idempotencyKey: "op-send",
        text: "this must wait for the compaction",
        policy: "queue",
      },
    } satisfies StructuredDeliveryEffect,
  ];
  const { port, transitions } = recorder(effects, ["delivered"]);
  const queue = new StructuredDeliveryQueue(port, () => host, async (conversationId) => {
    terminations.push(conversationId);
    return true;
  });

  await queue.drain();

  /* Kill is the operator's safety valve: it must reach the host while the
     compaction is still running. The message must not. */
  expect(terminations).toEqual(["conversation-one"]);
  expect(transitions.filter(([operationId]) => operationId === "op-kill").map(([, status]) => status))
    .toEqual(["delivering", "delivered"]);
  expect(sent).toEqual([]);
  expect(transitions.some(([operationId]) => operationId === "op-send")).toBe(false);
});

test("a second compaction for a thread already compacting waits instead of compacting twice", async () => {
  const sent: QueueEntry[] = [];
  const issued: string[] = [];
  let releaseFirst: () => void = () => {};
  const host: CompactCapableHost = Object.assign(baseHost(sent), {
    compact: async (request: { operationId: string; threadId: string }) => {
      issued.push(request.operationId);
      if (issued.length > 1) return { compactionId: `compaction-${request.operationId}` };
      return new Promise<{ compactionId: string | null }>((resolve) => {
        releaseFirst = () => resolve({ compactionId: "compaction-one" });
      });
    },
  });
  const second = compactEffect({ operationId: "op-two", idempotencyKey: "op-two" });
  second.id = "effect:op-two";
  second.eventSeq = 8;
  const { port, transitions } = recorder([compactEffect(), second], ["delivered", "failed", "uncertain"]);
  const queue = new StructuredDeliveryQueue(port, () => host);

  await queue.drain();

  /* Journal admission cannot refuse the second request — a compaction is not a
     turn — so the queue is what keeps one thread to one compaction. The second
     effect is left pending and untouched, not failed. */
  expect(issued).toEqual(["op-one"]);
  expect(transitions).toEqual([["op-one", "delivering", undefined]]);

  releaseFirst();
  await Bun.sleep(0);
  await queue.drain();

  expect(issued).toEqual(["op-one", "op-two"]);
  expect(transitions.filter(([operationId]) => operationId === "op-two").map(([, status]) => status))
    .toEqual(["delivering", "delivered"]);
});

test("a compaction on an unavailable host still lets a kill behind it run in the same pass", async () => {
  const sent: QueueEntry[] = [];
  const terminations: string[] = [];
  const recoveries: string[] = [];
  const kill = {
    id: "effect:op-kill",
    kind: "runtime.kill",
    eventSeq: 8,
    payload: {
      kind: "kill",
      operationId: "op-kill",
      conversationId: "conversation-one",
      idempotencyKey: "op-kill",
      sessionKey: { engine: "codex", sessionId: "thread-one" },
    },
  } satisfies StructuredDeliveryEffect;
  const { port, transitions } = recorder([compactEffect(), kill], ["delivered", "failed"]);
  const queue = new StructuredDeliveryQueue(
    port,
    () => null,
    async (conversationId) => { terminations.push(conversationId); return true; },
    undefined,
    async (conversationId) => { recoveries.push(conversationId); return false; },
  );

  await queue.drain();

  /* Compact sorts ahead of the kill because it is a control too, so a barrier
     here would be the first time one control could stop another. */
  expect(recoveries).toEqual(["conversation-one"]);
  expect(terminations).toEqual(["conversation-one"]);
  expect(transitions.filter(([operationId]) => operationId === "op-kill").map(([, status]) => status))
    .toEqual(["delivering", "delivered"]);
  expect(sent).toEqual([]);
});

test("a compaction admitted before a successful kill is not allowed to respawn the conversation", async () => {
  const sent: QueueEntry[] = [];
  let compactions = 0;
  const recoveries: string[] = [];
  const host: CompactCapableHost = Object.assign(baseHost(sent), {
    compact: async () => { compactions += 1; return { compactionId: "compaction-one" }; },
  });
  /* The durable kill boundary the journal retains for a conversation whose
     host the operator deliberately terminated. */
  const boundary = {
    id: "kill-boundary:conversation-one",
    kind: "runtime.kill-boundary",
    eventSeq: 9,
    payload: { operationId: "op-kill", conversationId: "conversation-one", admissionEventSeq: 9 },
  } satisfies StructuredDeliveryEffect;
  const { port, transitions, settled } = recorder([boundary, compactEffect()]);
  const queue = new StructuredDeliveryQueue(
    port,
    () => host,
    undefined,
    undefined,
    async (conversationId) => { recoveries.push(conversationId); return true; },
  );

  await queue.drain();
  await settled;

  expect(compactions).toBe(0);
  expect(recoveries).toEqual([]);
  expect(transitions).toHaveLength(1);
  expect(transitions[0]!.slice(0, 2)).toEqual(["op-one", "failed"]);
  expect(transitions[0]![2]).toContain("intentionally terminated");
});

test("a compact effect whose durable receipt cannot be read falls through to the host checks", async () => {
  const sent: QueueEntry[] = [];
  let compactions = 0;
  const host: CompactCapableHost = Object.assign(baseHost(sent), {
    compact: async () => { compactions += 1; return { compactionId: "compaction-one" }; },
  });
  const { port, transitions, settled } = recorder([compactEffect()]);
  /* A drain pass is shared by every conversation, so an unreadable receipt must
     not take the other groups down with it. */
  port.status = async () => { throw new Error("runtime host request timed out"); };
  const queue = new StructuredDeliveryQueue(port, () => host);

  await queue.drain();
  await settled;

  expect(compactions).toBe(1);
  expect(transitions.at(-1)).toEqual(["op-one", "delivered", "compaction:compaction-one"]);
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
  expect(transitions).toEqual([["op-one", "failed", "busy-turn"]]);
});

test("an engine without a compact control reports a typed capability failure", async () => {
  const sent: QueueEntry[] = [];
  const { port, transitions } = recorder([compactEffect({ sessionKey: { engine: "claude", sessionId: "session-one" } })]);
  const queue = new StructuredDeliveryQueue(port, () => baseHost(sent));

  await queue.drain();

  expect(sent).toEqual([]);
  expect(transitions).toEqual([["op-one", "failed", "unsupported-capability"]]);
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
    "op-one",
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
    "op-one",
    "uncertain",
    "Codex app-server host was lost",
  ]);
});

test("a Claude compaction nobody witnessed terminalizes uncertain with its own reason (#1214)", async () => {
  const sent: QueueEntry[] = [];
  const host: CompactCapableHost = Object.assign(baseHost(sent), {
    compact: async () => {
      throw new StructuredCompactError(CLAUDE_COMPACT_UNOBSERVED_REASON, "unverified");
    },
  });
  const { port, transitions, settled } = recorder([
    compactEffect({ sessionKey: { engine: "claude", sessionId: "thread-one" } }),
  ]);

  await new StructuredDeliveryQueue(port, () => host).drain();
  await settled;

  /* The durable receipt says what happened — the command went and nothing
     witnessed the compaction — instead of claiming success or spinning. */
  expect(transitions.at(-1)).toEqual(["op-one", "uncertain", CLAUDE_COMPACT_UNOBSERVED_REASON]);
  /* Even on the path whose mechanism IS a message, the queue never turns the
     control into a delivery: the `/compact` belongs to the host. */
  expect(sent).toEqual([]);
});

test("a recovered host lets a queued compaction reach the engine on the next pass", async () => {
  /* Controls sort ahead of sends, so a compaction parked in front of the queue
     must not be the reason nobody asks the host to come back. */
  const sent: QueueEntry[] = [];
  let compactions = 0;
  const recovered: CompactCapableHost = Object.assign(baseHost(sent), {
    compact: async () => { compactions += 1; return { compactionId: "compaction-one" }; },
  });
  let hosted = false;
  const recoveries: string[] = [];
  const { port, transitions, settled } = recorder([compactEffect()]);
  const queue = new StructuredDeliveryQueue(
    port,
    () => (hosted ? recovered : null),
    undefined,
    undefined,
    async (conversationId) => {
      recoveries.push(conversationId);
      hosted = true;
      return true;
    },
  );

  await queue.drain();
  await settled;

  expect(recoveries).toEqual(["conversation-one"]);
  expect(compactions).toBe(1);
  expect(transitions).toEqual([
    ["op-one", "queued", "dead-host"],
    ["op-one", "delivering", undefined],
    ["op-one", "delivered", "compaction:compaction-one"],
  ]);
});

test("a dead host asks for recovery and terminalizes the compaction when none starts", async () => {
  const sent: QueueEntry[] = [];
  const dead: CompactCapableHost = Object.assign(baseHost(sent), {
    compact: async () => ({ compactionId: null }),
  });
  dead.health = async () => idleState({ status: "dead" });
  const recoveries: string[] = [];
  const { port, transitions, settled } = recorder([compactEffect()]);
  const queue = new StructuredDeliveryQueue(
    port,
    () => dead,
    undefined,
    undefined,
    async (conversationId) => { recoveries.push(conversationId); return false; },
  );

  await queue.drain();
  await settled;

  expect(recoveries).toEqual(["conversation-one"]);
  expect(transitions.map(([, status]) => status)).toEqual(["queued", "failed"]);
  expect(transitions.at(-1)![2]).toContain("recovery");
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
  expect(transitions.map(([operationId]) => operationId)).toEqual(["op-one"]);

  releaseEvidence();
  await settled;
  /* The barrier is cleared in the compaction's `finally`, one tick after the
     terminal transition — production reaches the next pass through the
     `retrySoon` fired from that same callback. */
  await Bun.sleep(0);
  await queue.drain();

  expect(sent.map((entry) => entry.id)).toEqual(["op-send"]);
});
