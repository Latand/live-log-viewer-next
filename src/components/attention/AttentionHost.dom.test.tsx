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
import { UNREAD_FRAME_RECT } from "@/lib/attention/frames";
import { validateAttentionEvent } from "@/lib/attention/validation";

import { buildFocusFrameIndex, type FocusLayoutSlice } from "@/components/scheme/focusFrames";
import type { MiniStack, SchemeRect } from "@/components/scheme/layout";

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
  unreachable = new Set<string>();
  /* The return-project memory lives here and is keyed by request id, which the
     tests reuse; a leak between them would hide the case where it is empty. */
  dom.localStorage.clear();
  /* The tests that wait a clock out move this, so it is put back rather than
     leaking a later `now` into whichever test runs next. */
  now = new Date("2026-07-01T10:00:00.000Z");
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

/** Event kinds whose POST cannot reach the server right now. A dropped request
    is NOT a refusal: nothing was decided, and the record is untouched — which is
    exactly the case the surface has to tell apart from success. */
let unreachable = new Set<string>();

/** The two routes, answering exactly as `/api/attention` does — including the
    409-with-state that a refused transition comes back as. */
function transport(): typeof fetch {
  return (async (url: string, init?: { body?: string }) => {
    if (init?.body && unreachable.has((JSON.parse(init.body) as { kind: string }).kind)) {
      throw new TypeError("Failed to fetch");
    }
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

/** The board the handoff lands on. `project` names which project's layout this
    is — the tests that pass another one are the ones about a camera or a name
    that must not cross a project boundary. */
function board(rects: Record<string, FocusRect>, project = "demo") {
  const bus = createFocusHandoffBus();
  const log: BoardLog = { moved: [], restored: [] };
  const opened: string[] = [];
  const controller: BoardFocusController = {
    project,
    index: {
      project,
      boardRevision: 9,
      rectFor: (key) => rects[key] ?? null,
      named: [{ key: ANCHOR, label: "Reviewer — login fix", rect: LIVE_RECT }],
    },
    moveTo: ({ rect }) => { log.moved.push(rect); return true; },
    restoreCamera: (camera) => { log.restored.push(camera); return true; },
  };
  bus.setBoard(controller);
  bus.setShell({ project, openProject: () => {}, openPath: (path) => { opened.push(path); } });
  return { bus, log, opened };
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
/** One poll tick. Coming back to the tab is a poll like any other, and it is
    the one a test can trigger without waiting out the interval. */
async function poll() {
  dom.document.dispatchEvent(new dom.Event("visibilitychange"));
  await settle();
}

/** Raise a second, genuinely distinct focus event. */
function raiseSecond(rect: FocusRect = RAISED_RECT) {
  return raiseAttentionRequest({
    origin: "root-agent",
    target: { kind: "conversation", path: ANCHOR },
    frameAtCreation: { project: "demo", rect, boardRevision: 4 },
    intent: "show",
    reason: "The reviewer answered again.",
  }, { now, id: "attention_2" }).request;
}

function mountMobile(bus: ReturnType<typeof board>["bus"], fetchFn: typeof fetch) {
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as Element);
  flushSync(() => root.render(
    <AttentionHost mobile bus={bus} deviceId={DEVICE} fetchFn={fetchFn} pollMs={100_000} timing={{ timeoutMs: 0, pollMs: 0 }} />,
  ));
  roots.push(root);
}

/* ── Desktop follows immediately, once ──────────────────────────────────── */

test("an explicit focus event moves the desktop view immediately, with no prompt and no menu", async () => {
  raise();
  expect(record().state).toBe("pending");
  const { bus, log } = board({ [ANCHOR]: LIVE_RECT });

  mount(bus);
  await settle();

  /* The move happened on its own: nothing was ever put in front of the operator
     to agree to. */
  expect(log.moved).toEqual([LIVE_RECT]);
  expect(record().state).toBe("following");
  /* And the record says what it was: the desktop followed on its own. Calling
     this the operator's own act would tell the agent they chose to come. */
  expect(record().acceptedVia).toBe("auto-follow");
});

test("the whole confirmation panel is gone: no accept, preview, decline, message or pop-out control renders", async () => {
  raise();
  const { bus } = board({ [ANCHOR]: LIVE_RECT });

  mount(bus);
  await settle();

  /* Negative evidence for the rejected product. Every one of these was on the
     panel the operator rejected; none of them may come back. */
  for (const gone of [
    "attention-request",
    "attention-accept",
    "attention-preview",
    "attention-preview-card",
    "attention-preview-close",
    "attention-decline",
    "attention-withdrawn",
    "attention-refused",
    "attention-auto-follow",
    "overlay-action-row",
    "root-overlay-dock",
  ]) {
    expect(one(`[data-testid='${gone}']`)).toBeNull();
  }
  /* And no composer to message the agent from, anywhere on this surface. */
  expect(dom.document.querySelector("textarea")).toBeNull();
  expect(dom.document.querySelector("form")).toBeNull();
});

test("control releases after the one move: polls, renders and refreshes never move the view again", async () => {
  raise();
  const { bus, log } = board({ [ANCHOR]: LIVE_RECT });

  mount(bus);
  await settle();
  expect(log.moved).toHaveLength(1);

  /* Twenty heartbeats with the record sitting in `following` — the state that
     used to be re-read as "still owed a move". */
  for (let i = 0; i < 20; i += 1) await poll();

  expect(log.moved).toHaveLength(1);
  expect(record().state).toBe("following");
});

test("a replayed, idempotent retry of the same focus event does not move the view a second time", async () => {
  raise();
  const { bus, log } = board({ [ANCHOR]: LIVE_RECT });
  mount(bus);
  await settle();
  expect(log.moved).toHaveLength(1);

  /* The agent retries with the same clientRequestId, so the same request id
     comes back down the poll. Same event, already applied. */
  raiseAttentionRequest({
    origin: "root-agent",
    target: { kind: "conversation", path: ANCHOR },
    frameAtCreation: { project: "demo", rect: RAISED_RECT, boardRevision: 4 },
    intent: "show",
    reason: "The reviewer finished with request-changes.",
  }, { now, id: "attention_1" });
  await poll();
  await poll();

  expect(log.moved).toHaveLength(1);
});

test("a distinct focus event may move the view once more, and then releases too", async () => {
  raise();
  const { bus, log } = board({ [ANCHOR]: LIVE_RECT });
  mount(bus);
  await settle();
  expect(log.moved).toHaveLength(1);

  /* Returning first, so the first request stops being the live one. */
  click(one("[data-testid='attention-return']")!);
  await settle();

  raiseSecond();
  await poll();
  await settle();

  expect(log.moved).toHaveLength(2);
  for (let i = 0; i < 5; i += 1) await poll();
  expect(log.moved).toHaveLength(2);
});

/* ── The Back arrow, and nothing else ───────────────────────────────────── */

test("the only thing left on screen is one small Back control, and only while there is somewhere to go back to", async () => {
  raise();
  const { bus } = board({ [ANCHOR]: LIVE_RECT });

  mount(bus);
  await settle();

  const chip = one("[data-testid='focus-return-chip']");
  expect(chip).not.toBeNull();
  /* One control, no copy: the chip carries a single button and no text node of
     its own. A sentence here would be the panel coming back in miniature. */
  expect(chip!.querySelectorAll("button")).toHaveLength(1);
  expect((chip!.textContent ?? "").trim()).toBe("");
});

test("the Back control is a real button with an accessible name and keyboard focus", async () => {
  raise();
  const { bus } = board({ [ANCHOR]: LIVE_RECT });
  mount(bus);
  await settle();

  const back = one("[data-testid='attention-return']")!;
  expect(back.tagName).toBe("BUTTON");
  /* Typed, so it can never submit a form it is nested in. */
  expect(back.getAttribute("type")).toBe("button");
  /* Icon-only, so the accessible name has to come from the label rather than
     from contents a screen reader would find empty. */
  expect(back.getAttribute("aria-label")).toBe("Back to where you were");
  expect(back.getAttribute("title")).toBe("Back to where you were");
  /* It is in the tab order without being forced there. */
  expect(back.getAttribute("tabindex")).toBeNull();
  expect(back.hasAttribute("disabled")).toBe(false);
  /* Nothing here claims a mode: a pressed/toggled control would read as an
     ongoing follow, which is exactly what this design removed. */
  expect(back.getAttribute("aria-pressed")).toBeNull();
  /* The icon is decorative; the button's own label is the name. */
  expect(back.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
});

test("Back restores the exact viewport the operator was at before the automatic move", async () => {
  raise();
  const { bus, log } = board({ [ANCHOR]: LIVE_RECT });
  mount(bus);
  await settle();

  click(one("[data-testid='attention-return']")!);
  await settle();

  expect(log.restored).toEqual([{ x: 120, y: 340, zoom: 0.55 }]);
  expect(record().state).toBe("returned");
  expect(record().returnedVia).toBe("control");
  /* And once taken, the way back is no longer on offer. */
  expect(one("[data-testid='focus-return-chip']")).toBeNull();
});

test("nothing renders at all while there is nothing to go back to", async () => {
  const { bus } = board({ [ANCHOR]: LIVE_RECT });
  mount(bus);
  await settle();

  expect(dom.document.body.textContent).toBe("");
  expect(one("[data-testid='focus-return-chip']")).toBeNull();
});

test("a target that resolved to nothing moves nothing and puts nothing on screen", async () => {
  /* Exactly what the MCP tool records: a request raised through the agent's
     tool has no board in front of it, so it carries an unread frame. With the
     anchor gone from the board too, there is nowhere to land — degrading to a
     zero-area frame would drop the operator at the world origin. */
  raise(UNREAD_FRAME_RECT);
  const { bus, log } = board({});
  mount(bus);
  await settle();

  expect(log.moved).toEqual([]);
  expect(one("[data-testid='focus-return-chip']")).toBeNull();
  /* The failure is reported to the record — and through it to the agent — never
     as a banner over the operator's board. */
  expect(record().state).toBe("expired");
  expect(record().expiredCause).toBe("lost");
});

/* ── Mobile is chat-only ────────────────────────────────────────────────── */

test("mobile never moves its board, renders nothing, and leaves the request for a desktop", async () => {
  raise();
  const { bus, log } = board({ [ANCHOR]: LIVE_RECT });

  const calls: string[] = [];
  const spy = (async (url: string, init?: { body?: string }) => {
    calls.push(String(url));
    return transport()(url as unknown as string, init as never);
  }) as unknown as typeof fetch;

  mountMobile(bus, spy);
  await settle();
  for (let i = 0; i < 5; i += 1) await poll();

  /* Not one request, so the phone cannot even report having seen the offer. */
  expect(calls).toEqual([]);
  expect(log.moved).toEqual([]);
  expect(dom.document.body.textContent).toBe("");
  expect(one("[data-testid='focus-return-chip']")).toBeNull();
  /* Still waiting for a surface that can actually go there. */
  expect(record().state).toBe("pending");
  expect(record().offeredTo).toEqual([]);
});

test("a hidden desktop surface moves nothing and reports nothing, and the request expires unseen", async () => {
  visibility = "hidden";
  raise();
  const { bus, log } = board({ [ANCHOR]: LIVE_RECT });

  mount(bus);
  await settle();

  /* A backgrounded tab claiming the operator saw an offer teaches the agent the
     wrong lesson about whether to ask again — and moving a view nobody is
     looking at is worse still. */
  expect(record().state).toBe("pending");
  expect(log.moved).toEqual([]);

  now = at(OFFER_TTL_MS + 1);
  const swept = attentionForDevice(DEVICE, { now });
  now = new Date("2026-07-01T10:00:00.000Z");

  expect(swept.expired).toEqual(["attention_1"]);
  expect(record().expiredCause).toBe("ttl");
});

/* ── Cards the board is drawing, but not as a rect of their own ─────────── */

const STACK_KEY = "/tmp/root.jsonl::stack";
const STACK_RECT: FocusRect = { x: 2_400, y: 900, w: 240, h: 400 };

function stackHolding(paths: string[]): MiniStack {
  return {
    ...(STACK_RECT as SchemeRect),
    key: STACK_KEY,
    parent: "/tmp/root.jsonl",
    items: paths.map((path) => ({ file: { path } as never, branches: 0 })),
  };
}

/**
 * A board that resolves through the REAL frame index, over a layout the board
 * would actually produce. The seam this closes is between the two: the record
 * and the host were both fine, and the request still died because the index the
 * board publishes did not know its own layout was drawing the target.
 */
function layoutBoard(slice: FocusLayoutSlice, onOpenPath?: (path: string, publish: (next: FocusLayoutSlice) => void) => void) {
  const bus = createFocusHandoffBus();
  const log: BoardLog = { moved: [], restored: [] };
  const opened: string[] = [];
  const publish = (next: FocusLayoutSlice) => {
    bus.setBoard({
      project: "demo",
      index: buildFocusFrameIndex(next, "demo", { boardRevision: 9 }),
      moveTo: ({ rect }) => { log.moved.push(rect); return true; },
      restoreCamera: (camera) => { log.restored.push(camera); return true; },
    });
  };
  publish(slice);
  bus.setShell({
    project: "demo",
    openProject: () => {},
    openPath: (path) => { opened.push(path); onOpenPath?.(path, publish); },
  });
  return { bus, log, opened };
}

test("a worker folded into its parent's stack is followed to the stack that is drawing it", async () => {
  /* The live failure, end to end. An orchestration worker collapses once it goes
     quiet, so the board draws it as a row inside a mini-stack rather than as a
     node — and a request raised through the agent's tool carries no frame to
     fall back on. Nothing moved, the record was closed as `lost`, and the agent
     was told the operator never arrived while its card was on their screen. */
  raise(UNREAD_FRAME_RECT);
  const { bus, log } = layoutBoard({
    nodes: [],
    groups: [],
    stacks: [stackHolding([ANCHOR])],
    byPath: new Map<string, SchemeRect>([[STACK_KEY, STACK_RECT as SchemeRect]]),
  });

  mount(bus);
  await settle();

  expect(log.moved).toEqual([STACK_RECT]);
  expect(record().state).toBe("following");
  expect(record().resolution).toBe("exact");

  /* And the way back is on offer, which is the half the operator loses when the
     move never happens. */
  click(one("[data-testid='attention-return']")!);
  await settle();
  expect(log.restored).toEqual([{ x: 120, y: 340, zoom: 0.55 }]);
  expect(record().state).toBe("returned");
});

test("a conversation the board is not showing is asked for, followed once, and returned from", async () => {
  raise(UNREAD_FRAME_RECT);
  const empty: FocusLayoutSlice = { nodes: [], groups: [], stacks: [], byPath: new Map() };
  const { bus, log, opened } = layoutBoard(empty, (path, publish) => {
    /* What the shell does with a path the layout left out: the card enters. */
    publish({ ...empty, byPath: new Map<string, SchemeRect>([[path, LIVE_RECT as SchemeRect]]) });
  });

  mount(bus);
  await settle();

  expect(opened).toEqual([ANCHOR]);
  expect(log.moved).toEqual([LIVE_RECT]);
  expect(record().state).toBe("following");

  /* Once, and only once: the poll re-delivers the same offer every few seconds
     and the card was placed by an edge that must not re-arm. */
  for (let i = 0; i < 5; i += 1) await poll();
  expect(log.moved).toHaveLength(1);
  expect(opened).toEqual([ANCHOR]);

  click(one("[data-testid='attention-return']")!);
  await settle();
  expect(log.restored).toEqual([{ x: 120, y: 340, zoom: 0.55 }]);
  expect(record().state).toBe("returned");
});
