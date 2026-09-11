import { expect, test } from "bun:test";

import type { DeliveryReceipt, EngineHost, HostState, QueueEntry, RuntimeEvent, RuntimeInjectOutcome, RuntimeInjectRequest } from "./engineHost";
import { StructuredInjectError } from "./engineHost";
import type { StructuredDeliveryEffect } from "./structuredDeliveryQueue";
import {
  INJECTION_ACKNOWLEDGED_BUT_UNOBSERVED,
  INJECTION_INTO_HISTORY,
  INJECTION_INTO_RUNNING_TURN,
  StructuredDeliveryQueue,
} from "./structuredDeliveryQueue";
import { structuredContent } from "./structuredContent";

interface Transition {
  operationId: string;
  status: string;
  turnId?: string | null;
  reason?: string | null;
}

function state(activeTurnRef: string | null, sessionKey = "thread-one"): HostState {
  return {
    status: activeTurnRef ? "active" : "idle",
    sessionKey,
    endpoint: "test:host",
    pid: 1,
    processStartIdentity: "1",
    eventCursor: 0,
    protocolVersion: "0.154.0",
    activeTurnRef,
    pendingAttention: [],
    activeFlags: ["native-inject"],
    account: null,
  };
}

interface HostProbe {
  host: EngineHost;
  sends: QueueEntry[];
  interrupts: string[];
  injections: RuntimeInjectRequest[];
}

function probeHost(options: {
  activeTurnRef?: string | null;
  inject?: (request: RuntimeInjectRequest) => Promise<RuntimeInjectOutcome>;
  observe?: () => Promise<boolean>;
  canInject?: boolean;
  sessionKey?: string;
} = {}): HostProbe {
  const sends: QueueEntry[] = [];
  const interrupts: string[] = [];
  const injections: RuntimeInjectRequest[] = [];
  const base = {
    supportsSteer: true,
    attach: () => ({ async *[Symbol.asyncIterator](): AsyncIterator<RuntimeEvent> {} }),
    send: async (entry: QueueEntry): Promise<DeliveryReceipt> => {
      sends.push(entry);
      return { outcome: "turn-started", turnId: "turn-from-send" };
    },
    interrupt: async (turnRef: string) => { interrupts.push(turnRef); },
    answer: async () => {},
    health: async () => state(options.activeTurnRef ?? null, options.sessionKey),
    release: async () => {},
  };
  const host = (options.canInject === false ? base : {
    ...base,
    inject: async (request: RuntimeInjectRequest) => {
      injections.push(request);
      return options.inject
        ? options.inject(request)
        : {
            placement: request.expectedTurnId || options.activeTurnRef ? "pending-input" as const : "history" as const,
            turnId: options.activeTurnRef ?? null,
            observe: options.observe ?? (async () => true),
          };
    },
  }) as EngineHost;
  return { host, sends, interrupts, injections };
}

function injectQueue(probe: HostProbe, payload: Record<string, unknown> = {}) {
  const transitions: Transition[] = [];
  const text = typeof payload.text === "string" ? payload.text : "extra context";
  const queue = new StructuredDeliveryQueue({
    effects: async () => [{
      id: "effect:inject-one",
      kind: "runtime.inject",
      eventSeq: 1,
      payload: {
        kind: "inject",
        operationId: "inject-one",
        conversationId: "conversation-one",
        text,
        contentDigest: structuredContent(text, []).contentDigest,
        binding: { threadId: "thread-one", accountId: null, writerClaim: "owner:1" },
        ...payload,
      },
    }],
    status: async () => ({ status: "queued", revision: 1 }),
    hostClaim: async () => "owner:1",
    injectionBinding: () => ({ threadId: "thread-one", accountId: null, writerClaim: "owner:1" }),
    transition: async (operationId, status, details) => {
      transitions.push({ operationId, status, ...details });
    },
  }, () => probe.host);
  return { queue, transitions };
}

test("an injection reaches the host and never interrupts, steers or starts a turn", async () => {
  const probe = probeHost({ activeTurnRef: "turn-live" });
  const { queue, transitions } = injectQueue(probe);
  await queue.drain();

  expect(probe.injections).toHaveLength(1);
  expect(probe.injections[0]!.text).toBe("extra context");
  expect(probe.injections[0]!.threadId).toBe("thread-one");
  /* THE POINT OF THE OPERATION. The running turn is untouched: nothing was
     interrupted and nothing went down the send path, which is where a
     `turn/steer` or a `turn/start` would have come from. */
  expect(probe.interrupts).toEqual([]);
  expect(probe.sends).toEqual([]);

  const terminal = transitions.at(-1)!;
  expect(terminal.status).toBe("delivered");
  expect(terminal.turnId).toBe("turn-live");
  expect(terminal.reason).toBe(INJECTION_INTO_RUNNING_TURN);
});

test("an idle injection settles with the history wording, not the running-turn wording", async () => {
  const probe = probeHost({ activeTurnRef: null });
  const { queue, transitions } = injectQueue(probe);
  await queue.drain();

  const terminal = transitions.at(-1)!;
  expect(terminal.status).toBe("delivered");
  expect(terminal.reason).toBe(INJECTION_INTO_HISTORY);
  expect(probe.interrupts).toEqual([]);
  expect(probe.sends).toEqual([]);
});

test("an acknowledged but unobserved insertion settles uncertain, never delivered", async () => {
  const probe = probeHost({ activeTurnRef: "turn-live", observe: async () => false });
  const { queue, transitions } = injectQueue(probe);
  await queue.drain();

  const terminal = transitions.at(-1)!;
  /* An empty acknowledgement is a statement about the request, not about the
     thread. `uncertain` is the status that says exactly that, and it is
     absorbing — so nothing retries this insertion into a duplicate. */
  expect(terminal.status).toBe("uncertain");
  expect(terminal.reason).toContain(INJECTION_ACKNOWLEDGED_BUT_UNOBSERVED);
  expect(transitions.some((entry) => entry.status === "delivered")).toBe(false);
  expect(transitions.some((entry) => entry.status === "queued")).toBe(false);
});

test("a host without the capability fails the operation and never falls back to a send", async () => {
  const probe = probeHost({ activeTurnRef: "turn-live", canInject: false });
  const { queue, transitions } = injectQueue(probe);
  await queue.drain();

  const terminal = transitions.at(-1)!;
  expect(terminal.status).toBe("failed");
  expect(terminal.reason).toBe("unsupported-injection");
  /* NO SILENT SUBSTITUTE. The operator asked for injection; an engine that
     cannot do it says so rather than delivering a message. */
  expect(probe.sends).toEqual([]);
  expect(probe.interrupts).toEqual([]);
});

test("a refused injection fails and an unverified one is absorbed as uncertain", async () => {
  for (const [phase, status] of [["refused", "failed"], ["unverified", "uncertain"]] as const) {
    const probe = probeHost({
      activeTurnRef: null,
      inject: async () => { throw new StructuredInjectError("engine said no", phase); },
    });
    const { queue, transitions } = injectQueue(probe);
    await queue.drain();
    const terminal = transitions.at(-1)!;
    expect(terminal.status).toBe(status);
    /* Neither branch may put the row back in the queue: a requeued injection
       is a second insertion, and the engine does not deduplicate. */
    expect(transitions.some((entry) => entry.status === "queued")).toBe(false);
  }
});

test("a stale turn fence is refused before the host is entered at all", async () => {
  const probe = probeHost({ activeTurnRef: "turn-live" });
  /* `null` asks for the idle placement while a turn is running. */
  const { queue, transitions } = injectQueue(probe, { turnId: null });
  await queue.drain();

  expect(probe.injections).toEqual([]);
  const terminal = transitions.at(-1)!;
  expect(terminal.status).toBe("failed");
  expect(terminal.reason).toBe("stale-turn");
  /* Refused BEFORE `delivering`, so a stale fence leaves no actuation record. */
  expect(transitions.some((entry) => entry.status === "delivering")).toBe(false);
});

test("an injection effect carrying images is not executed at all", async () => {
  const probe = probeHost({ activeTurnRef: null });
  const { queue, transitions } = injectQueue(probe, {
    images: [{ sha256: "a".repeat(64), mime: "image/png", bytes: 12 }],
  });
  await queue.drain();

  /* A corrupt record is never executed in a REDUCED form — the operator's
     payload is not silently shrunk to the part that fits — and it is not left
     stranded either: the effect fails to parse, so the queue terminalizes the
     operation instead of retrying it for ever. */
  expect(probe.injections).toEqual([]);
  expect(probe.sends).toEqual([]);
  expect(transitions).toEqual([{
    operationId: "inject-one",
    status: "failed",
    reason: "structured delivery effect is invalid",
  }]);
});

test("a message admitted during a slow injection is not held behind its observation", async () => {
  /* THE STALL THIS GUARDS AGAINST. An active injection's item is written when
     its turn reaches the next model request, so the observation legitimately
     waits behind a long tool call — minutes, by design.

     `drainAfterAdmission` awaits the drain already running before it starts its
     own pass. So an observation awaited INSIDE the pass makes every later
     admission — a send, a steer, an interrupt, on any conversation — wait out
     the whole window before it is even looked at. Nothing else here holds a
     pass that long: a compaction is detached for exactly this reason. */
  let releaseObservation: (() => void) | null = null;
  const held = new Promise<void>((resolve) => { releaseObservation = resolve; });
  const sends: QueueEntry[] = [];
  const injections: RuntimeInjectRequest[] = [];
  const transitions: Transition[] = [];

  const slowHost = {
    supportsSteer: true,
    attach: () => ({ async *[Symbol.asyncIterator](): AsyncIterator<RuntimeEvent> {} }),
    send: async (entry: QueueEntry): Promise<DeliveryReceipt> => {
      sends.push(entry);
      return { outcome: "turn-started", turnId: "turn-other" };
    },
    interrupt: async () => {},
    answer: async () => {},
    health: async () => state("turn-live", "thread-slow"),
    release: async () => {},
    inject: async (request: RuntimeInjectRequest) => {
      injections.push(request);
      /* The acknowledgement comes back at once, as the engine's does. What is
         slow is reading the insertion back, which is the phase held here. */
      return {
        placement: "pending-input" as const,
        turnId: "turn-live",
        observe: async () => { await held; return true; },
      };
    },
  } as EngineHost;
  const otherHost = { ...slowHost, health: async () => state(null, "thread-other") } as EngineHost;

  const injectEffect: StructuredDeliveryEffect = {
    id: "effect:slow-inject",
    kind: "runtime.inject",
    eventSeq: 1,
    payload: {
      kind: "inject",
      operationId: "slow-inject",
      binding: { threadId: "thread-slow", accountId: null, writerClaim: "owner:1" },
      conversationId: "conversation-slow",
      text: "context for the busy thread",
      contentDigest: structuredContent("context for the busy thread", []).contentDigest,
    },
  };
  const laterSend: StructuredDeliveryEffect = {
    id: "effect:later-send",
    kind: "runtime.send",
    eventSeq: 2,
    payload: {
      kind: "send",
      operationId: "later-send",
      conversationId: "conversation-other",
      text: "an unrelated message",
      policy: "queue",
    },
  };
  /* The later send does not exist yet — it is admitted while the injection's
     observation is in flight, which is the case that matters. */
  let effects: StructuredDeliveryEffect[] = [injectEffect];

  const queue = new StructuredDeliveryQueue({
    effects: async () => effects,
    status: async () => ({ status: "queued", revision: 1 }),
    hostClaim: async () => "owner:1",
    injectionBinding: () => ({ threadId: "thread-slow", accountId: null, writerClaim: "owner:1" }),
    transition: async (operationId, status, details) => { transitions.push({ operationId, status, ...details }); },
  }, (conversationId) => (conversationId === "conversation-slow" ? slowHost : otherHost));

  const pass = queue.drain();
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(injections).toHaveLength(1);

  effects = [injectEffect, laterSend];
  const admitted = queue.drainAfterAdmission();

  /* The admission's own pass must run rather than queue behind an observation
     on a different thread. Bounded so a regression fails instead of hanging. */
  await Promise.race([admitted, new Promise((resolve) => setTimeout(resolve, 500))]);
  expect(sends.map((entry) => entry.id)).toEqual(["later-send"]);

  releaseObservation!();
  await pass;
  await admitted;
  await queue.drain();

  /* And the injection still settles correctly once its observation lands. */
  const settled = transitions.filter((entry) => entry.operationId === "slow-inject").at(-1)!;
  expect(settled.status).toBe("delivered");
  expect(settled.reason).toBe(INJECTION_INTO_RUNNING_TURN);
});

for (const [name, binding] of [
  ["thread", { threadId: "thread-old", accountId: null, writerClaim: "owner:1" }],
  ["account", { threadId: "thread-one", accountId: "account-old", writerClaim: "owner:1" }],
  ["writer generation", { threadId: "thread-one", accountId: null, writerClaim: "owner:0" }],
  ["missing binding", undefined],
] as const) {
  test(`injection refuses changed ${name} before delivery with zero writes`, async () => {
    const probe = probeHost();
    const { queue, transitions } = injectQueue(probe, { binding });
    await queue.drain();
    expect(probe.injections).toEqual([]);
    expect(transitions).toEqual([{ operationId: "inject-one", status: "failed", reason: "stale-generation" }]);
  });
}

test("the admitted binding is also compared with the actual host thread", async () => {
  const probe = probeHost({ sessionKey: "thread-other" });
  const { queue, transitions } = injectQueue(probe);
  await queue.drain();
  expect(probe.injections).toEqual([]);
  expect(transitions).toEqual([{ operationId: "inject-one", status: "failed", reason: "stale-generation" }]);
});
