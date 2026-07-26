import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";

import { expiryFrom } from "@/lib/attention/machine";
import type { DeviceAttentionView } from "@/lib/attention/service";
import type { AttentionRequestV1, ReturnPoint } from "@/lib/attention/types";

import { useAttentionOffers, type AttentionOffersHandle } from "./useAttentionOffers";

/*
 * #688 slice 3, client side. The record is the authority; this hook only reads
 * it and posts answers back. Two behaviours are worth pinning here because
 * neither is visible from the server tests: that rendering an offer is itself
 * reported, and that the return point is captured from THIS device immediately
 * before the move.
 */

const dom = new Window({ url: "http://localhost/" });
const G = globalThis as Record<string, unknown>;
const OVERRIDES: Record<string, unknown> = {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
};
const HAS: Record<string, boolean> = {};
const SAVED: Record<string, unknown> = {};
const settle = async () => { for (let i = 0; i < 6; i += 1) await new Promise((r) => setTimeout(r, 0)); };

beforeAll(() => {
  for (const key of Object.keys(OVERRIDES)) { HAS[key] = key in G; SAVED[key] = G[key]; G[key] = OVERRIDES[key]; }
});
afterAll(async () => {
  await settle();
  for (const key of Object.keys(OVERRIDES)) { if (HAS[key]) G[key] = SAVED[key]; else delete G[key]; }
});

let roots: Root[] = [];
beforeEach(() => { dom.document.body.replaceChildren(); roots = []; });
afterEach(async () => { for (const root of roots) flushSync(() => root.unmount()); roots = []; await settle(); });

const DEVICE = "device-a";
const created = new Date("2026-07-01T10:00:00.000Z");

function request(state: AttentionRequestV1["state"]): AttentionRequestV1 {
  return {
    id: "attention_1",
    createdAt: created.toISOString(),
    requestedBy: { rootId: "root_fixed" },
    origin: "root-agent",
    target: { kind: "conversation", path: "/tmp/reviewer.jsonl" },
    frameAtCreation: { project: "demo", rect: { x: 0, y: 0, w: 600, h: 780 }, boardRevision: 4 },
    intent: "show",
    zoom: "situate",
    reason: "The reviewer finished with request-changes.",
    state,
    stateChangedAt: created.toISOString(),
    expiresAt: expiryFrom(created),
    offeredTo: state === "pending" ? [] : [DEVICE],
    returnPoints: [],
    revision: 1,
  };
}

function view(state: AttentionRequestV1["state"]): DeviceAttentionView {
  const entry = { request: request(state), status: state === "pending" ? "none" as const : "actionable" as const, returnAvailable: false };
  return { rootId: "root_fixed", offer: state === "pending" ? null : entry, live: [entry], expired: [] };
}

interface Call { url: string; body: unknown }

/** A server that hands out `pending` until the device reports rendering it. */
function fakeServer(): { fetchFn: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  let state: AttentionRequestV1["state"] = "pending";
  const fetchFn = (async (url: string, init?: { body?: string }) => {
    const body = init?.body ? JSON.parse(init.body) as { kind?: string } : null;
    calls.push({ url, body });
    if (body?.kind === "offer") state = "offered";
    if (body?.kind === "accept") state = "accepted";
    return { ok: true, status: 200, json: async () => view(state) };
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

const viewport: Pick<ReturnPoint, "mode" | "camera" | "focusedPath"> = {
  mode: "scheme",
  camera: { x: 120, y: 340, zoom: 0.55 },
  focusedPath: "/tmp/what-i-was-reading.jsonl",
};

function mount(fetchFn: typeof fetch, surfaceVisible?: () => boolean, refusalTtlMs?: number): { current: AttentionOffersHandle | null } {
  const box: { current: AttentionOffersHandle | null } = { current: null };
  function Harness() {
    box.current = useAttentionOffers({
      deviceId: DEVICE,
      captureViewport: () => viewport,
      fetchFn,
      pollMs: 100_000,
      ...(refusalTtlMs === undefined ? {} : { refusalTtlMs }),
      ...(surfaceVisible ? { surfaceVisible } : {}),
    });
    return null;
  }
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as Element);
  flushSync(() => root.render(<Harness />));
  roots.push(root);
  return box;
}

test("rendering an offer is reported, so silence and never-seen stay different facts", async () => {
  const server = fakeServer();
  const handle = mount(server.fetchFn);
  await settle();

  const posts = server.calls.filter((call) => call.body !== null);
  expect(posts).toHaveLength(1);
  expect(posts[0]!.body).toEqual({ kind: "offer", deviceId: DEVICE });
  /* And the second read reflects the transition, so the card is answerable. */
  expect(handle.current!.offer?.request.state).toBe("offered");
});

test("accepting posts the operator's own agreement", async () => {
  const server = fakeServer();
  const handle = mount(server.fetchFn);
  await settle();

  await handle.current!.accept(request("offered"));
  await settle();

  expect(server.calls.at(-2)!.body).toEqual({ kind: "accept", deviceId: DEVICE, via: "operator" });
});

test("landing captures the viewport this device is leaving, and nobody else's", async () => {
  const server = fakeServer();
  const handle = mount(server.fetchFn);
  await settle();

  await handle.current!.arrive(request("accepted"), "exact");
  await settle();

  const arrival = server.calls.map((call) => call.body).find((body) => (body as { kind?: string })?.kind === "arrive") as {
    returnPoint: ReturnPoint;
    resolution: string;
  };
  expect(arrival.resolution).toBe("exact");
  /* Mode, camera and focused path, recorded against this device — presence is
     per-device and two devices in the same seat do not share a framing. */
  expect(arrival.returnPoint.deviceId).toBe(DEVICE);
  expect(arrival.returnPoint.mode).toBe("scheme");
  expect(arrival.returnPoint.camera).toEqual(viewport.camera);
  expect(arrival.returnPoint.focusedPath).toBe(viewport.focusedPath);
  expect(typeof arrival.returnPoint.capturedAt).toBe("string");
});

test("going back, declining and closing a preview each post their own answer", async () => {
  const server = fakeServer();
  const handle = mount(server.fetchFn);
  await settle();

  await handle.current!.goBack(request("following"));
  await handle.current!.decline(request("offered"));
  await handle.current!.preview(request("offered"));
  /* Closing a preview is `dismiss`, never `decline`: the machine refuses
     `decline` from `previewing`, so wiring the close control to it would leave
     the request to run out its TTL and be recorded as silence. */
  await handle.current!.dismiss(request("previewing"));
  await settle();

  const kinds = server.calls.map((call) => (call.body as { kind?: string } | null)?.kind).filter(Boolean);
  /* And the offer is reported exactly once: once the record says a device has
     rendered it, later refreshes find nothing pending and post nothing, which
     is what keeps the read loop from feeding itself. */
  expect(kinds).toEqual(["offer", "return", "decline", "preview", "dismiss"]);
});

test("a surface nobody can see reads the record but never claims the offer was shown", async () => {
  const server = fakeServer();
  const handle = mount(server.fetchFn, () => false);
  await settle();

  /* Reads, yes — a hidden tab that stops polling would show a stale card the
     moment it came back. Reporting, no: `pending` means no active device
     rendered it, and that is what makes an expiry line honest. */
  expect(server.calls.filter((call) => call.body !== null)).toHaveLength(0);
  expect(server.calls.length).toBeGreaterThan(0);
  expect(handle.current!.view!.live[0]!.request.state).toBe("pending");
});

test("a visible surface still reports on the first tick", async () => {
  const server = fakeServer();
  mount(server.fetchFn, () => true);
  await settle();

  expect(server.calls.filter((call) => call.body !== null).map((call) => (call.body as { kind: string }).kind))
    .toEqual(["offer"]);
});

test("a refused answer re-reads the record and is visible, rather than passing for success", async () => {
  /* The route answers an out-of-order transition with 409 and the state the
     record is actually in. Discarding that makes a dead control indistinguishable
     from a working one. */
  const calls: Call[] = [];
  const fetchFn = (async (url: string, init?: { body?: string }) => {
    const body = init?.body ? JSON.parse(init.body) as { kind?: string } : null;
    calls.push({ url, body });
    if (body?.kind === "decline") {
      return { ok: false, status: 409, json: async () => ({ error: "invalid-transition", state: "previewing" }) };
    }
    return { ok: true, status: 200, json: async () => view("previewing") };
  }) as unknown as typeof fetch;

  const handle = mount(fetchFn);
  await settle();

  await handle.current!.decline(request("previewing"));
  await settle();

  expect(handle.current!.refusal).toEqual({ requestId: "attention_1", reason: "invalid-transition", state: "previewing" });
  /* And the surface is showing the truth from the record, not the state this
     device hoped it had reached. */
  expect(handle.current!.offer!.request.state).toBe("previewing");
  expect(calls.at(-1)!.body).toBeNull();

  /* The next answer that lands clears it, so a stale warning never outlives the
     thing it was about. */
  await handle.current!.preview(request("offered"));
  await settle();
  expect(handle.current!.refusal).toBeNull();
});

test("a refusal takes itself off screen, and can be taken off sooner", async () => {
  const refusing = (async () => ({
    ok: false,
    status: 409,
    json: async () => ({ error: "invalid-transition", state: "previewing" }),
  })) as unknown as typeof fetch;

  const handle = mount(refusing, undefined, 20);
  await settle();
  await handle.current!.decline(request("previewing"));
  await settle();
  expect(handle.current!.refusal).not.toBeNull();

  /* A one-off race must not leave a warning band standing for the rest of the
     session — nothing else ever clears it if no further answer is sent. */
  await new Promise((resolve) => setTimeout(resolve, 40));
  await settle();
  expect(handle.current!.refusal).toBeNull();

  await handle.current!.decline(request("previewing"));
  await settle();
  expect(handle.current!.refusal).not.toBeNull();
  handle.current!.dismissRefusal();
  await settle();
  expect(handle.current!.refusal).toBeNull();
});

test("a handoff with nowhere to land closes the request rather than reporting an arrival", async () => {
  const posted: unknown[] = [];
  const fetchFn = (async (_url: string, init?: { body?: string }) => {
    if (init?.body) posted.push(JSON.parse(init.body));
    return { ok: true, status: 200, json: async () => view("offered") };
  }) as unknown as typeof fetch;

  const handle = mount(fetchFn);
  await settle();
  posted.length = 0;

  await handle.current!.arrive(request("accepted"), "lost");
  await settle();

  /* `arrive` with a lost resolution is refused by the machine and leaves the
     request agreed-to forever, so this device closes it instead — and never
     sends a return point for a move that did not happen. */
  expect(posted).toEqual([{ kind: "abandon", deviceId: DEVICE }]);
  /* The operator pressed a control and the view stayed put; the surface says so
     on the same band a refusal uses. */
  expect(handle.current!.refusal).toEqual({ requestId: "attention_1", reason: "lost-target", state: null });
});

test("a server that cannot be reached is not a refusal", async () => {
  const failing = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
  const handle = mount(failing);
  await settle();

  await handle.current!.decline(request("offered"));
  await settle();

  /* Nothing was decided, so nothing is announced and the poll simply retries. */
  expect(handle.current!.refusal).toBeNull();
});

test("a server that cannot be reached leaves the last known offer on screen", async () => {
  const failing = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
  const handle = mount(failing);
  await settle();

  /* The record is durable, so the answer is still valid when the connection
     returns; nothing here invents an empty state to render. */
  expect(handle.current!.view).toBeNull();
  expect(handle.current!.offer).toBeNull();
});
