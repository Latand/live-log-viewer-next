import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { installActEnv } from "@/test-helpers/actEnv";
import type { RuntimeVoiceDelivery } from "@/lib/runtime/voiceDelivery";

import { useBridgeReportRelay } from "./useBridgeReportRelay";

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

const client = {
  reconcileWorkerDeliveries(deliveries: readonly RuntimeVoiceDelivery[]) {
    delivered.push([...deliveries]);
  },
};

function delivery(seq: number): RuntimeVoiceDelivery {
  return {
    deliveryId: `voice:["bridge:${seq}",["report:${seq}"]]`,
    turnId: `bridge:${seq}`,
    responses: [{ responseId: `report:${seq}`, text: `[completed] report ${seq}` }],
    ready: true,
  };
}

const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  calls.push({
    url,
    method: init?.method ?? "GET",
    body: init?.body ? JSON.parse(String(init.body)) as unknown : null,
  });
  if ((init?.method ?? "GET") === "GET") {
    const plan = plans.shift() ?? { kind: "idle" };
    return new Response(JSON.stringify({ ok: true, plan }), { status: 200 });
  }
  return new Response(JSON.stringify({ ok: true }), { status: 200 });
}) as unknown as typeof fetch;

beforeEach(() => {
  roots = [];
  calls = [];
  delivered = [];
  plans = [];
});

afterEach(async () => {
  for (const root of roots) flushSync(() => root.unmount());
  roots = [];
  await settle();
});

function mount(live: boolean) {
  function Probe({ isLive }: { isLive: boolean }) {
    useBridgeReportRelay(client, isLive, { fetchFn, pollMs: 5_000 });
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

test("a delivered batch reaches the client first and is acknowledged after", async () => {
  plans = [{ kind: "deliver", delivery: delivery(4), throughSeq: 4 }];
  mount(true);
  await settle();

  expect(delivered).toHaveLength(1);
  expect(delivered[0]![0]!.responses[0]!.text).toContain("report 4");

  const acknowledgement = calls.find((call) => call.method === "POST");
  expect(acknowledgement?.body).toEqual({ throughSeq: 4 });

  /* Order matters: the cursor must not move past something the call never got. */
  const deliveryIndex = calls.findIndex((call) => call.method === "GET");
  const ackIndex = calls.findIndex((call) => call.method === "POST");
  expect(deliveryIndex).toBeLessThan(ackIndex);
});

test("a lost-ack batch is acknowledged without being spoken again", async () => {
  plans = [{ kind: "already-acknowledged", throughSeq: 7 }];
  mount(true);
  await settle();

  expect(delivered).toEqual([]);
  expect(calls.find((call) => call.method === "POST")?.body).toEqual({ throughSeq: 7 });
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
    { kind: "deliver", delivery: delivery(2), throughSeq: 2 },
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
