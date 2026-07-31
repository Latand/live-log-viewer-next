import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { useEffect } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import {
  pendingBridgeAcknowledgements,
  rememberBridgeAcknowledgement,
  resetBridgeAcknowledgementsForTests,
} from "@/lib/bridge/pendingAcknowledgements";
import { installActEnv } from "@/test-helpers/actEnv";
import type { RuntimeVoiceDelivery } from "@/lib/runtime/voiceDelivery";

import {
  bridgeSessionRetirement,
  commitBridgeTurn,
  resetBridgeRelayStateForTests,
  retirePendingBridgeAcknowledgements,
  useBridgeReportRelay,
  useBridgeTurnStartDrain,
  type BridgeRelayState,
} from "./useBridgeReportRelay";
import type { DeadlineScheduler } from "@/lib/deadline";

/**
 * The relay drives the loop, in the order that keeps reports exactly-once.
 *
 * Asserted against a scripted server rather than a real one, because what is under
 * test is the client's obligations: deliver before acknowledging, acknowledge a
 * lost-ack batch without re-delivering it, and never poll when no call is up.
 */

installActEnv();

const dom = new Window({ url: "http://localhost/" });
const G = globalThis as Record<string, unknown>;
const HAS: Record<string, boolean> = {};
const SAVED: Record<string, unknown> = {};

const OVERRIDES = (): Record<string, unknown> => ({
  window: dom,
  document: dom.document,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
});

const settle = async () => { for (let index = 0; index < 10; index += 1) await new Promise((r) => setTimeout(r, 0)); };

beforeAll(() => {
  const overrides = OVERRIDES();
  for (const key of Object.keys(overrides)) {
    HAS[key] = key in G;
    SAVED[key] = G[key];
    G[key] = overrides[key];
  }
});

afterAll(async () => {
  await settle();
  for (const key of Object.keys(HAS)) {
    if (HAS[key]) G[key] = SAVED[key];
    else delete G[key];
  }
});

let roots: Root[] = [];
let calls: { url: string; method: string; body: unknown }[] = [];
let delivered: RuntimeVoiceDelivery[][] = [];
let plans: unknown[] = [];

/**
 * Stands in for the realtime client, including the part that matters most here:
 * `reconcileWorkerDeliveries` only ENQUEUES. Durable delivery is confirmed later,
 * when the host answers `acknowledged: true`, and the client announces it then.
 */
let acknowledgeListeners: ((deliveryId: string) => void)[] = [];
const client = {
  reconcileWorkerDeliveries(deliveries: readonly RuntimeVoiceDelivery[]) {
    delivered.push([...deliveries]);
  },
  onDeliveryAcknowledged(listener: (deliveryId: string) => void) {
    acknowledgeListeners.push(listener);
    return () => { acknowledgeListeners = acknowledgeListeners.filter((entry) => entry !== listener); };
  },
  realtimeSession: () => sessionCredential,
};

/** The credential this peer holds for its own call; null before the SDP exchange. */
let sessionCredential: string | null = "rt_sess_relay";

/** The host confirming the write, which is the only thing that may move a cursor. */
function confirmDurableDelivery(deliveryId: string): void {
  flushSync(() => {
    for (const listener of [...acknowledgeListeners]) listener(deliveryId);
  });
}

function delivery(seq: number): RuntimeVoiceDelivery {
  return {
    deliveryId: `voice:["bridge:${seq}",["report:${seq}"]]`,
    turnId: `bridge:${seq}`,
    responses: [{ responseId: `report:${seq}`, text: `[completed] report ${seq}` }],
    ready: true,
  };
}

/**
 * Scripted acknowledgement outcomes, consumed in order; anything unscripted is a
 * plain 200.
 *
 * `hold` keeps the POST in flight until the test releases it, which is the only way to
 * observe the ordering the relay owes: a drain started while a retry is still
 * outstanding asks the server a question that retry is busy changing.
 */
let postOutcomes: { status: number; hold?: Promise<void> }[] = [];

/** Scripted GET statuses, consumed in order; anything unscripted answers 200. */
let getStatuses: number[] = [];
/** The highest number of requests the relay ever had in flight at once (#845). */
let inFlight = 0;
let peakInFlight = 0;
/** Every signal the relay handed to `fetch`, so a test can prove cancellation. */
let requestSignals: AbortSignal[] = [];

const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  calls.push({
    url,
    method: init?.method ?? "GET",
    body: init?.body ? JSON.parse(String(init.body)) as unknown : null,
  });
  if (init?.signal) requestSignals.push(init.signal);
  inFlight += 1;
  peakInFlight = Math.max(peakInFlight, inFlight);
  try {
    if ((init?.method ?? "GET") === "GET") {
      const status = getStatuses.shift() ?? 200;
      if (status !== 200) return new Response(JSON.stringify({ error: "refused" }), { status });
      const plan = plans.shift() ?? { kind: "idle" };
      return new Response(JSON.stringify({ ok: true, plan }), { status: 200 });
    }
    const outcome = postOutcomes.shift();
    if (outcome?.hold) await outcome.hold;
    const status = outcome?.status ?? 200;
    return new Response(JSON.stringify(status === 200 ? { ok: true } : { error: "refused" }), { status });
  } finally {
    inFlight -= 1;
  }
}) as unknown as typeof fetch;

/**
 * A scheduler whose clock only moves when the test says so.
 *
 * Thirty simulated minutes of a refused poll have to cost milliseconds, and the
 * assertion that matters — how many requests that half hour produced — is only
 * meaningful against a clock the test controls.
 */
function virtualScheduler(): DeadlineScheduler & {
  advance(ms: number): void;
  pending(): number;
  delays: number[];
} {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; handler: () => void }>();
  return {
    delays: [],
    setTimeout(handler, ms) {
      const id = nextId++;
      this.delays.push(ms);
      timers.set(id, { at: now + ms, handler });
      return id;
    },
    clearTimeout(handle) {
      timers.delete(handle as number);
    },
    advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers].sort((left, right) => left[1].at - right[1].at)) {
        if (timer.at > now) continue;
        timers.delete(id);
        timer.handler();
      }
    },
    pending: () => timers.size,
  };
}

beforeEach(() => {
  roots = [];
  calls = [];
  delivered = [];
  plans = [];
  postOutcomes = [];
  getStatuses = [];
  inFlight = 0;
  peakInFlight = 0;
  requestSignals = [];
  acknowledgeListeners = [];
  sessionCredential = "rt_sess_relay";
  /* Retirement is module-scoped for the same reason the token store is — it must
     survive a call-phase transition — so it also survives a test unless cleared. */
  resetBridgeRelayStateForTests();
  /* The parked-token store is module-scoped by design (it must outlive components),
     so it also outlives a test unless cleared. */
  resetBridgeAcknowledgementsForTests();
});

afterEach(async () => {
  for (const root of roots) flushSync(() => root.unmount());
  roots = [];
  await settle();
});

function mount(live: boolean, pollMs = 5_000) {
  function Probe({ isLive }: { isLive: boolean }) {
    useBridgeReportRelay(client, isLive, { fetchFn, pollMs });
    return null;
  }
  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  roots.push(root);
  flushSync(() => root.render(<Probe isLive={live} />));
  return root;
}

test("no call means no poll — nothing pushes when there is nothing to interject into", async () => {
  mount(false);
  await settle();
  expect(calls).toEqual([]);
});

test("the cursor does NOT move on enqueue — only durable delivery may advance it", async () => {
  /* Inverting this is inverting exactly-once. `reconcileWorkerDeliveries` puts the
     batch in an in-memory queue; a crash between that and the host's write loses
     the report while the cursor claims it was delivered. */
  plans = [{ kind: "deliver", delivery: delivery(4), ackToken: "ack_4" }];
  mount(true);
  await settle();

  expect(delivered).toHaveLength(1);
  expect(calls.filter((call) => call.method === "POST")).toEqual([]);
});

test("the cursor advances once the host confirms the durable write", async () => {
  plans = [{ kind: "deliver", delivery: delivery(4), ackToken: "ack_4" }];
  mount(true);
  await settle();

  confirmDurableDelivery(delivery(4).deliveryId);
  await settle();

  const acknowledgement = calls.find((call) => call.method === "POST");
  expect(acknowledgement?.body).toEqual({ ackToken: "ack_4", realtimeSessionId: "rt_sess_relay" });

  /* Order matters: the cursor must not move past something the call never got. */
  const deliveryIndex = calls.findIndex((call) => call.method === "GET");
  const ackIndex = calls.findIndex((call) => call.method === "POST");
  expect(deliveryIndex).toBeLessThan(ackIndex);
});

test("a confirmation for some other delivery never advances this batch's cursor", async () => {
  plans = [{ kind: "deliver", delivery: delivery(4), ackToken: "ack_4" }];
  mount(true);
  await settle();

  confirmDurableDelivery("voice:[\"bridge:99\",[\"report:99\"]]");
  await settle();
  expect(calls.filter((call) => call.method === "POST")).toEqual([]);
});

test("a lost-ack batch is acknowledged without being spoken again", async () => {
  plans = [{ kind: "already-acknowledged", ackToken: "ack_7" }];
  mount(true);
  await settle();

  expect(delivered).toEqual([]);
  expect(calls.find((call) => call.method === "POST")?.body).toEqual({ ackToken: "ack_7", realtimeSessionId: "rt_sess_relay" });
});

test("hold and idle acknowledge nothing", async () => {
  plans = [{ kind: "hold" }];
  mount(true);
  await settle();
  expect(calls.filter((call) => call.method === "POST")).toEqual([]);
  expect(delivered).toEqual([]);
});

test("the poll carries what this client already played, so the server can suppress it", async () => {
  plans = [
    { kind: "deliver", delivery: delivery(2), ackToken: "ack_2" },
    { kind: "idle" },
  ];
  const root = mount(true);
  await settle();
  /* Force a second poll by remounting the effect with the same inputs. */
  flushSync(() => root.render(<div />));
  await settle();

  const first = calls.find((call) => call.method === "GET")!;
  expect(first.url).not.toContain("acked=");
  expect(delivered).toHaveLength(1);
});

test("a failing poll is a retry, not an incident", async () => {
  const failing = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
  function Probe() {
    useBridgeReportRelay(client, true, { fetchFn: failing, pollMs: 5_000 });
    return null;
  }
  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  roots.push(root);
  flushSync(() => root.render(<Probe />));
  await settle();

  expect(delivered).toEqual([]);
});

test("a call with no session credential yet reads nothing at all", async () => {
  /* The inbox carries deploy nonces, so a peer that has not finished its SDP
     exchange has nothing to present and must wait rather than be trusted. */
  sessionCredential = null;
  plans = [{ kind: "deliver", delivery: delivery(1), ackToken: "ack_1" }];
  mount(true);
  await settle();

  expect(calls).toEqual([]);
  expect(delivered).toEqual([]);
});

test("the poll presents this call's credential", async () => {
  plans = [{ kind: "idle" }];
  mount(true);
  await settle();

  const poll = calls.find((call) => call.method === "GET");
  expect(poll?.url).toContain("realtimeSessionId=rt_sess_relay");
});

test("turn-start drains with NO live call — that is the path it exists for", async () => {
  /* Requiring a live session here meant the inbox drained only while it was not
     needed. The turn-start path authenticates as the operator instead. */
  const requests: { url: string; method: string; body: unknown }[] = [];
  const turnFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) as unknown : null });
    if ((init?.method ?? "GET") === "GET") {
      return new Response(JSON.stringify({
        ok: true,
        prelude: { text: "While you were away…", ackToken: "ack_turn" },
      }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as unknown as typeof fetch;

  /* Published from an effect, so the probe stays a pure component. */
  const drains: (() => Promise<{ text: string; ackToken: string; commit: () => void }>)[] = [];
  function Probe({ publish }: { publish: (drain: () => Promise<{ text: string; ackToken: string; commit: () => void }>) => void }) {
    const drain = useBridgeTurnStartDrain(true, {
      fetchFn: turnFetch,
      conversationId: "conversation_project_a_seat",
    });
    useEffect(() => { publish(drain); }, [drain, publish]);
    return null;
  }
  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  roots.push(root);
  const publish = (drain: () => Promise<{ text: string; ackToken: string; commit: () => void }>) => { drains.push(drain); };
  flushSync(() => root.render(<Probe publish={publish} />));
  await settle();

  const turn = await drains.at(-1)!();
  expect(turn.text).toContain("While you were away");
  expect(turn.ackToken).toBe("ack_turn");
  /* No session id anywhere in the request: there is no call to have one. */
  expect(requests[0]!.url).not.toContain("realtimeSessionId");
  expect(requests[0]!.url).toContain("conversationId=conversation_project_a_seat");

  /* And nothing was acknowledged by draining alone. */
  expect(requests.filter((entry) => entry.method === "POST")).toEqual([]);
  turn.commit();
  await settle();
  expect(requests.find((entry) => entry.method === "POST")?.body).toEqual({ ackToken: "ack_turn" });
});

test("commitBridgeTurn settles a batch by token, long after the closure is gone", async () => {
  const posts: unknown[] = [];
  const tokenFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    posts.push(init?.body ? JSON.parse(String(init.body)) as unknown : null);
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as unknown as typeof fetch;

  commitBridgeTurn("ack_late", tokenFetch);
  await settle();
  expect(posts).toEqual([{ ackToken: "ack_late" }]);

  /* An empty token is a no-op rather than a malformed request. */
  commitBridgeTurn("", tokenFetch);
  await settle();
  expect(posts).toHaveLength(1);
});

/**
 * What an acknowledgement RESPONSE means (#691 round 9).
 *
 * The relay used to await the acknowledgement fetch and treat whatever came back as a
 * settle. `fetch` rejects only on transport failure, so a 403, a 409 on a token the
 * server no longer holds, and a 500 mid-write all arrived as success — and success is
 * what deletes the token. The one thing that could settle the batch was destroyed in
 * exactly the case where the batch had NOT settled: the server's cursor never moved,
 * and nothing was left able to move it, so those reports were gone for good.
 */

test("a REFUSED acknowledgement keeps the token — the cursor did not move", async () => {
  plans = [{ kind: "deliver", delivery: delivery(11), ackToken: "ack_11" }];
  postOutcomes = [{ status: 403 }];
  mount(true);
  await settle();

  confirmDurableDelivery(delivery(11).deliveryId);
  await settle();

  expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
  /* Still parked, and still the only thing that can settle this batch. */
  expect(pendingBridgeAcknowledgements().map((entry) => entry.ackToken)).toEqual(["ack_11"]);
});

test("a server error keeps it too — 500 is not a settle", async () => {
  plans = [{ kind: "deliver", delivery: delivery(12), ackToken: "ack_12" }];
  postOutcomes = [{ status: 500 }];
  mount(true);
  await settle();
  confirmDurableDelivery(delivery(12).deliveryId);
  await settle();

  expect(pendingBridgeAcknowledgements().map((entry) => entry.ackToken)).toEqual(["ack_12"]);
});

test("an ACCEPTED acknowledgement is the only thing that drops the token", async () => {
  plans = [{ kind: "deliver", delivery: delivery(13), ackToken: "ack_13" }];
  mount(true);
  await settle();
  confirmDurableDelivery(delivery(13).deliveryId);
  await settle();

  expect(pendingBridgeAcknowledgements()).toEqual([]);
});

/* A fresh mount polls immediately, so remounting drives the next poll without racing
   an interval — and it is also the real case the retry exists for: a call-phase
   transition tears the effect down, and the confirmation that would have settled the
   batch has already fired and will not fire again. */
async function repoll(): Promise<void> {
  for (const root of roots) flushSync(() => root.unmount());
  roots = [];
  await settle();
  mount(true);
  await settle();
}

test("a token refused once is spent by the next poll, without re-delivering the batch", async () => {
  plans = [{ kind: "deliver", delivery: delivery(14), ackToken: "ack_14" }, { kind: "idle" }];
  postOutcomes = [{ status: 503 }];
  mount(true);
  await settle();
  confirmDurableDelivery(delivery(14).deliveryId);
  await settle();
  expect(pendingBridgeAcknowledgements()).toHaveLength(1);

  /* The POST is unscripted now, so it succeeds. */
  await repoll();

  const acknowledgements = calls.filter((call) => call.method === "POST");
  expect(acknowledgements).toHaveLength(2);
  expect(acknowledgements.every((call) => (call.body as { ackToken: string }).ackToken === "ack_14")).toBe(true);
  expect(pendingBridgeAcknowledgements()).toEqual([]);
  /* Retried, never re-spoken: the batch reached the session the first time. */
  expect(delivered).toHaveLength(1);
});

test("the drain waits for the retry it just started", async () => {
  /* Unfenced, the GET went out while the retry was still in flight — so the server
     answered about a batch that was in the act of settling, handed out a SECOND token
     for it, and the acknowledgement that landed second was refused against a cursor
     that had already moved. */
  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });

  plans = [{ kind: "deliver", delivery: delivery(15), ackToken: "ack_15" }, { kind: "idle" }];
  postOutcomes = [{ status: 503 }, { status: 200, hold: held }];
  mount(true);
  await settle();
  confirmDurableDelivery(delivery(15).deliveryId);
  await settle();

  const beforeRetry = calls.length;
  await repoll();

  /* The retry POST is out; the drain GET behind it must NOT be. */
  const since = calls.slice(beforeRetry);
  expect(since.filter((call) => call.method === "POST")).toHaveLength(1);
  expect(since.filter((call) => call.method === "GET")).toEqual([]);

  release();
  await settle();

  expect(calls.slice(beforeRetry).filter((call) => call.method === "GET")).toHaveLength(1);
});

test("a turn-start commit that is refused does not report success", async () => {
  /* The inline commit closure posted its own fetch and swallowed the outcome, so a
     403 read as a settled batch on the one path that runs when no call is live. */
  const refusing = (async () => new Response(JSON.stringify({ error: "refused" }), { status: 403 })) as unknown as typeof fetch;
  await expect(commitBridgeTurn("ack_refused", refusing)).rejects.toThrow(/403/);
});

test("a refused composer token is retained and retried to completion before the next drain", async () => {
  /* The failure this closes: a refused acknowledgement was dropped, so the cursor sat
     parked and the batch's reports repeated on every later turn. */
  let refuse = true;
  const seen: { url: string; method: string; body: unknown }[] = [];
  const flaky = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    seen.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) as unknown : null });
    if (method === "POST") {
      if (refuse) return new Response("no", { status: 503 });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true, prelude: null }), { status: 200 });
  }) as unknown as typeof fetch;

  rememberBridgeAcknowledgement("composer-key-1", "ack_parked");

  await retirePendingBridgeAcknowledgements(flaky);
  /* Refused, so it is NOT forgotten. */
  expect(pendingBridgeAcknowledgements()).toEqual([{ waitingOn: "composer-key-1", ackToken: "ack_parked", sessionId: null }]);

  refuse = false;
  await retirePendingBridgeAcknowledgements(flaky);
  expect(pendingBridgeAcknowledgements()).toEqual([]);
  expect(seen.filter((entry) => entry.method === "POST")).toHaveLength(2);
});

test("the retry runs BEFORE the drain, so a new batch never lands on an unsettled one", async () => {
  const order: string[] = [];
  const ordered = (async (input: string | URL | Request, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    order.push(method === "POST" ? "settle" : "drain");
    if (method === "POST") return new Response(JSON.stringify({ ok: true }), { status: 200 });
    return new Response(JSON.stringify({ ok: true, prelude: null }), { status: 200 });
  }) as unknown as typeof fetch;

  rememberBridgeAcknowledgement("composer-key-1", "ack_parked");

  const drains: (() => Promise<{ text: string; ackToken: string; commit: () => void }>)[] = [];
  function Probe({ publish }: { publish: (drain: () => Promise<{ text: string; ackToken: string; commit: () => void }>) => void }) {
    const drain = useBridgeTurnStartDrain(true, { fetchFn: ordered });
    useEffect(() => { publish(drain); }, [drain, publish]);
    return null;
  }
  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  roots.push(root);
  flushSync(() => root.render(<Probe publish={(drain) => { drains.push(drain); }} />));
  await settle();

  await drains.at(-1)!();
  expect(order).toEqual(["settle", "drain"]);
});

/**
 * #845 — the retry storm, and every bound that was missing around it.
 *
 * A live non-root or stale `realtimeSessionId` is answered 403 by the gateway
 * authority, correctly and permanently. The loop treated that like a blip: a fixed
 * ten-second interval, no deadline, no backoff, no ceiling, and a confirmation
 * listener that could POST beside a poll. Left open, one tab produced six refused
 * requests a minute forever, each of which asked the server to rebuild the whole
 * registry.
 *
 * These assert the bounds, not the mechanism: how many requests half an hour of
 * refusal costs, that two are never in flight at once, and that nothing survives the
 * component that wanted it.
 */

/** Mounts with a clock the test owns, returning the scheduler that drives it. */
const REQUEST_TIMEOUT_MS = 7_000;

function mountWithClock(options: { pollMs?: number; onState?: (state: BridgeRelayState) => void } = {}) {
  const scheduler = virtualScheduler();
  const pollMs = options.pollMs ?? 10_000;
  function Probe() {
    useBridgeReportRelay(client, true, {
      fetchFn,
      pollMs,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
      scheduler,
      /* Pinned so a backoff assertion is about the policy rather than the dice. */
      random: () => 0,
      ...(options.onState ? { onState: options.onState } : {}),
    });
    return null;
  }
  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  roots.push(root);
  flushSync(() => root.render(<Probe />));
  return { scheduler, root, pollMs };
}

/** Advance the virtual clock in poll-sized steps, letting each cycle settle. */
async function runFor(scheduler: ReturnType<typeof virtualScheduler>, totalMs: number, stepMs: number): Promise<void> {
  await settle();
  for (let elapsed = 0; elapsed < totalMs; elapsed += stepMs) {
    scheduler.advance(stepMs);
    await settle();
  }
}

test("thirty simulated minutes of 403 costs one request, not one hundred and eighty", async () => {
  getStatuses = Array.from({ length: 500 }, () => 403);
  const { scheduler } = mountWithClock({ pollMs: 10_000 });

  await runFor(scheduler, 30 * 60_000, 10_000);

  const requests = calls.filter((call) => call.url.includes("/api/bridge"));
  /* One refusal is the whole answer. The credential either is the live root's or is
     not, and asking again cannot change that. */
  expect(requests).toHaveLength(1);
  expect(requests[0]!.method).toBe("GET");
  expect(bridgeSessionRetirement("rt_sess_relay")).toEqual({ sessionId: "rt_sess_relay", status: 403 });
});

test("a 401 retires the session exactly as a 403 does", async () => {
  getStatuses = Array.from({ length: 20 }, () => 401);
  const { scheduler } = mountWithClock({ pollMs: 10_000 });
  await runFor(scheduler, 5 * 60_000, 10_000);

  expect(calls).toHaveLength(1);
  expect(bridgeSessionRetirement("rt_sess_relay")?.status).toBe(401);
});

test("two requests are never in flight at once, across half an hour of traffic", async () => {
  plans = Array.from({ length: 200 }, (_value, index) => ({
    kind: "deliver",
    delivery: delivery(index),
    ackToken: `ack_${index}`,
  }));
  const { scheduler } = mountWithClock({ pollMs: 10_000 });
  await settle();

  for (let tick = 0; tick < 180; tick += 1) {
    /* The host confirms mid-flight, which is exactly when the old listener started a
       POST beside the poll. It now wakes the loop instead. */
    confirmDurableDelivery(delivery(tick).deliveryId);
    scheduler.advance(0);
    await settle();
    scheduler.advance(10_000);
    await settle();
  }

  expect(peakInFlight).toBe(1);
  expect(calls.length).toBeGreaterThan(1);
});

test("a refused session stops polling, and a genuinely new session starts clean", async () => {
  getStatuses = [403];
  const states: BridgeRelayState[] = [];
  const { scheduler } = mountWithClock({ pollMs: 10_000, onState: (state) => { states.push(state); } });
  await runFor(scheduler, 60_000, 10_000);

  expect(calls).toHaveLength(1);
  expect(states.some((state) => state.kind === "retired" && state.sessionId === "rt_sess_relay")).toBe(true);

  /* The call rolled over and the backend minted a new session id. Nothing about the
     refused one says anything about this one. */
  sessionCredential = "rt_sess_successor";
  plans = [{ kind: "idle" }];
  scheduler.advance(10_000);
  await settle();

  const fresh = calls.slice(1);
  expect(fresh).toHaveLength(1);
  expect(fresh[0]!.url).toContain("realtimeSessionId=rt_sess_successor");
  expect(bridgeSessionRetirement("rt_sess_successor")).toBeNull();
});

test("retryable failures back off exponentially with a ceiling instead of hammering", async () => {
  getStatuses = Array.from({ length: 40 }, () => 503);
  const { scheduler } = mountWithClock({ pollMs: 10_000 });
  await settle();

  /* Long enough for the ceiling to be reached and held. */
  for (let tick = 0; tick < 400; tick += 1) {
    scheduler.advance(10_000);
    await settle();
  }

  /* Request deadlines share the clock, so only the CYCLE spacing is the subject. */
  const spacing = scheduler.delays.filter((delay) => delay > 0 && delay !== REQUEST_TIMEOUT_MS);
  expect(spacing.length).toBeGreaterThan(3);
  expect(spacing[0]).toBe(10_000);
  expect(spacing[1]).toBe(20_000);
  expect(spacing[2]).toBe(40_000);
  /* Bounded above, always. */
  for (const delay of spacing) expect(delay).toBeLessThanOrEqual(300_000);
  expect(Math.max(...spacing)).toBe(300_000);

  /* And far fewer requests than a fixed interval would have produced over the same
     simulated hour. */
  expect(calls.length).toBeLessThan(30);
});

test("a 429 is retryable rather than a refusal, and never retires the session", async () => {
  getStatuses = [429, 429, 200];
  const { scheduler } = mountWithClock({ pollMs: 10_000 });
  await settle();
  for (let tick = 0; tick < 10; tick += 1) {
    scheduler.advance(60_000);
    await settle();
  }
  expect(bridgeSessionRetirement("rt_sess_relay")).toBeNull();
  expect(calls.length).toBeGreaterThanOrEqual(3);
});

test("unmounting aborts the request in flight and leaves no timer or listener behind", async () => {
  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  plans = [{ kind: "deliver", delivery: delivery(30), ackToken: "ack_30" }];
  postOutcomes = [{ status: 200, hold: held }];

  const { scheduler, root } = mountWithClock({ pollMs: 10_000 });
  await settle();
  confirmDurableDelivery(delivery(30).deliveryId);
  /* The confirmation wakes the loop rather than fetching beside it, so the clock has
     to tick before its acknowledgement leaves. */
  scheduler.advance(0);
  await settle();

  /* The acknowledgement POST is parked in flight; the operator navigates away. */
  expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
  expect(acknowledgeListeners).toHaveLength(1);
  flushSync(() => root.unmount());
  roots = roots.filter((entry) => entry !== root);

  expect(requestSignals.at(-1)!.aborted).toBe(true);
  expect(acknowledgeListeners).toHaveLength(0);
  expect(scheduler.pending()).toBe(0);

  release();
  await settle();
  /* And nothing rescheduled itself out of the ashes. */
  expect(scheduler.pending()).toBe(0);
});

test("a request that never answers is deadlined rather than holding the loop forever", async () => {
  const neverAnswers = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method ?? "GET", body: null });
    return await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => { reject(init.signal!.reason); }, { once: true });
    });
  }) as unknown as typeof fetch;

  const scheduler = virtualScheduler();
  function Probe() {
    useBridgeReportRelay(client, true, {
      fetchFn: neverAnswers,
      pollMs: 10_000,
      requestTimeoutMs: 8_000,
      scheduler,
      random: () => 0,
    });
    return null;
  }
  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  roots.push(root);
  flushSync(() => root.render(<Probe />));
  await settle();

  expect(calls).toHaveLength(1);
  scheduler.advance(8_000);
  await settle();
  /* Deadlined, counted as retryable, and rescheduled — not wedged holding the one
     in-flight slot for the rest of the call. */
  expect(scheduler.pending()).toBe(1);
  scheduler.advance(10_000);
  await settle();
  expect(calls).toHaveLength(2);
});

test("the parked-token sweep is bounded per cycle instead of fanning out the whole store", async () => {
  for (let index = 0; index < 32; index += 1) {
    rememberBridgeAcknowledgement(`voice:parked-${index}`, `ack_parked_${index}`, { sessionId: "rt_sess_relay" });
  }
  postOutcomes = Array.from({ length: 64 }, () => ({ status: 503 }));
  const { scheduler } = mountWithClock({ pollMs: 10_000 });
  await settle();

  const firstCycle = calls.filter((call) => call.method === "POST");
  expect(firstCycle).toHaveLength(4);
  /* Oldest first: a backlog drains from the batch that has waited longest. */
  expect((firstCycle[0]!.body as { ackToken: string }).ackToken).toBe("ack_parked_0");

  scheduler.advance(10_000);
  await settle();
  expect(calls.filter((call) => call.method === "POST")).toHaveLength(8);
  /* Nothing was dropped by not being attempted. */
  expect(pendingBridgeAcknowledgements()).toHaveLength(32);
});

test("the sweep only spends tokens the current session parked", async () => {
  rememberBridgeAcknowledgement("voice:from-old-call", "ack_old", { sessionId: "rt_sess_previous" });
  rememberBridgeAcknowledgement("voice:from-this-call", "ack_mine", { sessionId: "rt_sess_relay" });
  rememberBridgeAcknowledgement("voice:from-a-reload", "ack_unclaimed", {});

  mountWithClock({ pollMs: 10_000 });
  await settle();

  const spent = calls.filter((call) => call.method === "POST").map((call) => (call.body as { ackToken: string }).ackToken);
  /* A token from a previous call names a batch THAT call received; spending it under
     this credential moves a cursor for reports this session never heard. */
  expect(spent).not.toContain("ack_old");
  expect(spent).toContain("ack_mine");
  /* An unclaimed token is this call's or nobody's, so it is still swept. */
  expect(spent).toContain("ack_unclaimed");
});

test("a 409 stops occupying a bounded slot — that token can never settle anything again", async () => {
  /* Parked forever was the old behaviour: 409 threw, the token was kept, and it sat
     in a thirty-two entry store displacing tokens that could still settle a batch. */
  rememberBridgeAcknowledgement("voice:spent", "ack_spent", { sessionId: "rt_sess_relay" });
  postOutcomes = [{ status: 409 }];
  mountWithClock({ pollMs: 10_000 });
  await settle();

  expect(pendingBridgeAcknowledgements()).toEqual([]);
  expect(bridgeSessionRetirement("rt_sess_relay")).toBeNull();
});

test("a refusal met while sweeping retires the session before any drain goes out", async () => {
  rememberBridgeAcknowledgement("voice:parked", "ack_parked", { sessionId: "rt_sess_relay" });
  postOutcomes = [{ status: 403 }];
  const { scheduler } = mountWithClock({ pollMs: 10_000 });
  await runFor(scheduler, 10 * 60_000, 10_000);

  expect(calls.filter((call) => call.method === "GET")).toEqual([]);
  expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
  /* Still parked: a 403 says "not you", never "that batch is settled". */
  expect(pendingBridgeAcknowledgements()).toHaveLength(1);
});

test("a batch drained while the session rolls over is dropped rather than misapplied", async () => {
  plans = [{ kind: "deliver", delivery: delivery(40), ackToken: "ack_40" }];
  const rolling = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method ?? "GET", body: null });
    /* The credential rolls while the answer is on the wire. */
    sessionCredential = "rt_sess_after_rollover";
    return new Response(JSON.stringify({ ok: true, plan: plans.shift() ?? { kind: "idle" } }), { status: 200 });
  }) as unknown as typeof fetch;

  function Probe() {
    useBridgeReportRelay(client, true, { fetchFn: rolling, pollMs: 10_000, scheduler: virtualScheduler() });
    return null;
  }
  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  roots.push(root);
  flushSync(() => root.render(<Probe />));
  await settle();

  /* The server's cursor did not move, so the batch is handed out again — to the call
     that can actually speak it. Applying it to a new call would be far worse. */
  expect(delivered).toEqual([]);
  expect(pendingBridgeAcknowledgements()).toEqual([]);
});
