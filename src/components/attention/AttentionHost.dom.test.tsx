import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";

import { viewBus, type ViewSlice } from "@/hooks/viewPresenceBus";
import { answerAttentionRequest, attentionForDevice, raiseAttentionRequest } from "@/lib/attention/service";
import { readAttentionFile } from "@/lib/attention/store";
import { OFFER_TTL_MS, type FocusRect } from "@/lib/attention/types";
import { validateAttentionEvent } from "@/lib/attention/validation";

import { AttentionHost } from "./AttentionHost";
import { createFocusHandoffBus, type BoardFocusController } from "./focusHandoffBus";

/*
 * #688's last mile, end to end on a device.
 *
 * These drive the REAL record through the real service — only the transport and
 * the board are stood in for — because the failures this closes were all in the
 * seam between them: a request nothing polled, an offer nothing rendered, and an
 * acceptance that moved nothing. A test that mocked the record would have passed
 * against the broken build.
 */

const dom = new Window({ url: "http://localhost/" });
const G = globalThis as Record<string, unknown>;
const OVERRIDES: Record<string, unknown> = {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  Event: dom.Event,
  MouseEvent: dom.MouseEvent,
  localStorage: dom.localStorage,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
};
const HAS: Record<string, boolean> = {};
const SAVED: Record<string, unknown> = {};
const settle = async () => { for (let i = 0; i < 8; i += 1) await new Promise((r) => setTimeout(r, 0)); };

let sandbox = "";
let previousStateDir: string | undefined;
let visibility: "visible" | "hidden" = "visible";

beforeAll(() => {
  for (const key of Object.keys(OVERRIDES)) { HAS[key] = key in G; SAVED[key] = G[key]; G[key] = OVERRIDES[key]; }
  /* The hidden-surface contract is the default `document.visibilityState` read,
     so the test drives that rather than a seam the production mount never uses. */
  Object.defineProperty(dom.document, "visibilityState", { get: () => visibility, configurable: true });
});
afterAll(async () => {
  await settle();
  for (const key of Object.keys(OVERRIDES)) { if (HAS[key]) G[key] = SAVED[key]; else delete G[key]; }
});

let roots: Root[] = [];
beforeEach(() => {
  dom.document.body.replaceChildren();
  roots = [];
  visibility = "visible";
  previousStateDir = process.env.LLV_STATE_DIR;
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-attention-host-"));
  process.env.LLV_STATE_DIR = sandbox;
  viewBus.reportContext({ project: "demo", board: { renderedRevision: null, durableRevision: null, sync: "unavailable" } });
  viewBus.reportSlice(WHERE_I_WAS);
});
afterEach(async () => {
  for (const root of roots) flushSync(() => root.unmount());
  roots = [];
  await settle();
  if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousStateDir;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const DEVICE = "device-desktop";
const ANCHOR = "/tmp/reviewer.jsonl";
const LIVE_RECT: FocusRect = { x: 900, y: 1_400, w: 600, h: 780 };
const RAISED_RECT: FocusRect = { x: 10, y: 20, w: 600, h: 780 };

/** The viewport the operator is at before anything moves. */
const WHERE_I_WAS: ViewSlice = {
  mode: "scheme",
  focusedPath: "/tmp/what-i-was-reading.jsonl",
  selectedPaths: [],
  visiblePaths: [],
  camera: { x: 120, y: 340, zoom: 0.55, worldRect: { x: 0, y: 0, width: 1_000, height: 800 } },
};

let now = new Date("2026-07-01T10:00:00.000Z");
const at = (ms: number) => new Date(now.getTime() + ms);

/** The two routes, answering exactly as `/api/attention` does — including the
    409-with-state that a refused transition comes back as. */
function transport(): typeof fetch {
  return (async (url: string, init?: { body?: string }) => {
    if (!init?.body) {
      return { ok: true, status: 200, json: async () => ({ ok: true, ...attentionForDevice(DEVICE, { now }) }) };
    }
    const id = decodeURIComponent(url.split("/").pop()!);
    const outcome = answerAttentionRequest(id, validateAttentionEvent(JSON.parse(init.body)), { now });
    if (outcome.ok) return { ok: true, status: 200, json: async () => ({ ok: true, request: outcome.request }) };
    if (outcome.reason === "not-found") return { ok: false, status: 404, json: async () => ({ error: "NOT_FOUND" }) };
    return { ok: false, status: 409, json: async () => ({ error: outcome.reason, state: outcome.state }) };
  }) as unknown as typeof fetch;
}

interface BoardLog {
  moved: FocusRect[];
  restored: { x: number; y: number; zoom: number }[];
}

function board(rects: Record<string, FocusRect>) {
  const bus = createFocusHandoffBus();
  const log: BoardLog = { moved: [], restored: [] };
  const controller: BoardFocusController = {
    project: "demo",
    index: { project: "demo", boardRevision: 9, rectFor: (key) => rects[key] ?? null },
    moveTo: ({ rect }) => { log.moved.push(rect); return true; },
    restoreCamera: (camera) => { log.restored.push(camera); return true; },
  };
  bus.setBoard(controller);
  bus.setShell({ project: "demo", openProject: () => {}, openPath: () => {} });
  return { bus, log };
}

function raise(rect: FocusRect = RAISED_RECT) {
  return raiseAttentionRequest({
    origin: "root-agent",
    target: { kind: "conversation", path: ANCHOR },
    frameAtCreation: { project: "demo", rect, boardRevision: 4 },
    intent: "show",
    reason: "The reviewer finished with request-changes.",
  }, { now, id: "attention_1" }).request;
}

function mount(bus: ReturnType<typeof board>["bus"]) {
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as Element);
  flushSync(() => root.render(
    <AttentionHost mobile={false} bus={bus} deviceId={DEVICE} fetchFn={transport()} pollMs={100_000} timing={{ timeoutMs: 0, pollMs: 0 }} />,
  ));
  roots.push(root);
}

const one = (selector: string) => dom.document.querySelector(selector) as unknown as HTMLElement | null;
const click = (element: HTMLElement) => element.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event);
const record = () => readAttentionFile().requests[0]!;

test("a raised request renders within one poll and the record moves pending → offered", async () => {
  raise();
  expect(record().state).toBe("pending");
  const { bus } = board({ [ANCHOR]: LIVE_RECT });

  mount(bus);
  await settle();

  /* On screen, answerable, with the agent's sentence and which of show/open the
     operator is about to agree to. */
  expect(one("[data-testid='attention-request']")).not.toBeNull();
  expect(one("[data-testid='attention-accept']")).not.toBeNull();
  /* And the record now says a device showed it — which is what makes the
     eventual expiry line "you never saw it" or "you said nothing", honestly. */
  expect(record().state).toBe("offered");
  expect(record().offeredTo).toEqual([DEVICE]);
});

test("a hidden surface renders nothing and reports nothing, and the request expires unseen", async () => {
  visibility = "hidden";
  raise();
  const { bus } = board({ [ANCHOR]: LIVE_RECT });

  mount(bus);
  await settle();

  /* A background tab claiming the operator saw an offer teaches the agent the
     wrong lesson about whether to ask again. The operator's Viewer is
     frequently backgrounded, so this is the common case, not the edge one. */
  expect(record().state).toBe("pending");
  expect(record().offeredTo).toEqual([]);
  expect(one("[data-testid='attention-request']")).toBeNull();

  now = at(OFFER_TTL_MS + 1);
  const swept = attentionForDevice(DEVICE, { now });
  now = new Date("2026-07-01T10:00:00.000Z");

  expect(swept.expired).toEqual(["attention_1"]);
  expect(record().state).toBe("expired");
  expect(record().expiredCause).toBe("ttl");
  expect(record().offeredTo).toEqual([]);
});

test("accepting resolves the target against the live board, moves the view, and records the arrival", async () => {
  raise();
  const { bus, log } = board({ [ANCHOR]: LIVE_RECT });
  mount(bus);
  await settle();

  click(one("[data-testid='attention-accept']")!);
  await settle();

  /* The rect the board holds NOW, not the one the request was raised against. */
  expect(log.moved).toEqual([LIVE_RECT]);
  expect(record().state).toBe("following");
  expect(record().resolution).toBe("exact");
  expect(record().acknowledgedBy).toBe(DEVICE);
});

test("the return point is this device's viewport from before the move, and returning restores it", async () => {
  raise();
  const { bus, log } = board({ [ANCHOR]: LIVE_RECT });
  mount(bus);
  await settle();

  click(one("[data-testid='attention-accept']")!);
  await settle();

  /* Captured before anything moved, against this device — presence is
     per-device and two devices in the same seat do not share a framing. */
  expect(record().returnPoints).toEqual([{
    deviceId: DEVICE,
    mode: "scheme",
    camera: { x: 120, y: 340, zoom: 0.55 },
    focusedPath: "/tmp/what-i-was-reading.jsonl",
    capturedAt: expect.any(String) as unknown as string,
  }]);

  /* The board has since moved on, exactly as it would have after a real glide. */
  viewBus.reportSlice({ ...WHERE_I_WAS, focusedPath: ANCHOR, camera: { x: -900, y: -1_400, zoom: 0.9, worldRect: { x: 0, y: 0, width: 10, height: 10 } } });

  click(one("[data-testid='attention-return']")!);
  await settle();

  expect(log.restored).toEqual([{ x: 120, y: 340, zoom: 0.55 }]);
  expect(record().state).toBe("returned");
  expect(record().returnedVia).toBe("control");
});

test("a vanished anchor degrades to where it was rather than failing or landing anywhere", async () => {
  raise();
  /* The reviewer's card is gone from the board; the frame the request was
     raised against is still a place the operator can be taken. */
  const { bus, log } = board({ "/tmp/somebody-else.jsonl": LIVE_RECT });
  mount(bus);
  await settle();

  click(one("[data-testid='attention-accept']")!);
  await settle();

  expect(log.moved).toEqual([RAISED_RECT]);
  expect(record().state).toBe("following");
  expect(record().resolution).toBe("approximate");
});

test("a target that resolved to nothing is refused out loud rather than passing for an arrival", async () => {
  /* No live anchor and no frame worth degrading to. The record refuses to call
     that a follow, and the surface that asked says so — a control that appeared
     to work while the view never moved is the failure this whole row exists to
     avoid. */
  raiseAttentionRequest({
    origin: "root-agent",
    target: { kind: "conversation", path: ANCHOR },
    frameAtCreation: { project: "demo", rect: { x: 0, y: 0, w: 0, h: 0 }, boardRevision: null },
    intent: "show",
    reason: "The reviewer finished with request-changes.",
  }, { now, id: "attention_1" });
  const { bus, log } = board({});
  mount(bus);
  await settle();

  click(one("[data-testid='attention-accept']")!);
  await settle();

  expect(log.moved).toEqual([]);
  expect(record().state).toBe("accepted");
  expect(record().resolution).toBeUndefined();
  expect(one("[data-testid='attention-refused']")).not.toBeNull();
});

test("nothing renders while there is nothing to answer", async () => {
  const { bus } = board({ [ANCHOR]: LIVE_RECT });

  mount(bus);
  await settle();

  expect(dom.document.body.textContent).toBe("");
  expect(one("[data-testid='root-overlay-dock']")).toBeNull();
});
