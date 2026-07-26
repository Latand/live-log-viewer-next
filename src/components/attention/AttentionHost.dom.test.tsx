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
import { FOLLOW_HOLD_MS, OFFER_TTL_MS, RETURN_WINDOW_MS, type FocusRect } from "@/lib/attention/types";
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

/** Drive a request all the way to `following` on this device without going
    through the host — a record that outlived whatever tab accepted it. */
function seedFollowing(focusedPath: string | null = "/tmp/what-i-was-reading.jsonl") {
  const request = raise();
  answerAttentionRequest(request.id, { kind: "offer", deviceId: DEVICE }, { now });
  answerAttentionRequest(request.id, { kind: "accept", deviceId: DEVICE }, { now });
  answerAttentionRequest(request.id, {
    kind: "arrive",
    deviceId: DEVICE,
    resolution: "exact",
    returnPoint: { deviceId: DEVICE, mode: "scheme", camera: { x: 120, y: 340, zoom: 0.55 }, focusedPath, capturedAt: now.toISOString() },
  }, { now });
  return request;
}

test("a return with no memory of where the camera was captured never restores it into another project", async () => {
  /* The record's ReturnPoint carries a camera but no project, and this browser
     has no memory of capturing it: the tab that accepted is gone, or this is a
     second tab that shares the device id and renders the same return control.
     World coordinates from one project's layout mean nothing in another's. */
  seedFollowing();
  const { bus, log, opened } = board({ [ANCHOR]: LIVE_RECT }, "elsewhere");
  mount(bus);
  await settle();

  click(one("[data-testid='attention-return']")!);
  await settle();

  expect(log.restored).toEqual([]);
  /* The focused path names a thing rather than a coordinate, so it is the part
     of that viewport that survives not knowing which project it belonged to. */
  expect(opened).toEqual(["/tmp/what-i-was-reading.jsonl"]);
  expect(record().state).toBe("returned");
});

test("the capture project outlives the tab, so a return after a reload restores the camera", async () => {
  raise();
  const first = board({ [ANCHOR]: LIVE_RECT });
  mount(first.bus);
  await settle();
  click(one("[data-testid='attention-accept']")!);
  await settle();

  /* The reload: this component's memory is gone, the record and the device id
     are not. */
  for (const root of roots) flushSync(() => root.unmount());
  roots = [];
  dom.document.body.replaceChildren();

  const second = board({ [ANCHOR]: LIVE_RECT });
  mount(second.bus);
  await settle();

  click(one("[data-testid='attention-return']")!);
  await settle();

  expect(second.log.restored).toEqual([{ x: 120, y: 340, zoom: 0.55 }]);
  expect(record().state).toBe("returned");
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

/** A request with no live anchor and no frame worth degrading to: there is
    nowhere on the board to take anyone. */
function raiseUnlandable(id = "attention_1", reason = "The reviewer finished with request-changes.") {
  return raiseAttentionRequest({
    origin: "root-agent",
    target: { kind: "conversation", path: ANCHOR },
    frameAtCreation: { project: "demo", rect: { x: 0, y: 0, w: 0, h: 0 }, boardRevision: null },
    intent: "show",
    reason,
  }, { now, id }).request;
}

test("a target that resolved to nothing ends the request then and there, as its own kind of ending", async () => {
  /* The record refuses to call that a follow, and the surface that asked says
     so — a control that appeared to work while the view never moved is the
     failure this whole row exists to avoid. */
  raiseUnlandable();
  const { bus, log } = board({});
  mount(bus);
  await settle();

  click(one("[data-testid='attention-accept']")!);
  await settle();

  expect(log.moved).toEqual([]);
  /* Terminal within the same answer, and never recorded as an arrival. The
     alternative — leaving it `accepted` — is unrecoverable: no event is legal
     from there, so it stays this device's oldest live entry for the life of the
     record. */
  expect(record().state).toBe("expired");
  expect(record().expiredCause).toBe("lost");
  expect(record().resolution).toBeUndefined();
  /* Not a refusal, and not "they never answered": three different things to be
     able to say, and this is the third. */
  expect(record().state).not.toBe("declined");
  expect(attentionForDevice(DEVICE, { now }).offer).toBeNull();
  expect(one("[data-testid='attention-refused']")).not.toBeNull();
});

test("a request raised after a handoff that could not land is rendered and answerable", async () => {
  raiseUnlandable();
  /* The anchor arrives on the board only after the first handoff has failed —
     the reviewer's card appearing a moment later, which is the ordinary way
     this happens. */
  const rects: Record<string, FocusRect> = {};
  const { bus } = board(rects);
  mount(bus);
  await settle();

  click(one("[data-testid='attention-accept']")!);
  await settle();
  rects[ANCHOR] = LIVE_RECT;

  /* The second ask is the one that matters. With the first wedged in
     `accepted` it would be stamped `offered` by the poll, rendered by nothing,
     and expire looking exactly like "they saw it and said nothing" — the record
     lying about the operator, permanently, on that device. */
  const second = raiseAttentionRequest({
    origin: "root-agent",
    target: { kind: "conversation", path: ANCHOR },
    frameAtCreation: { project: "demo", rect: RAISED_RECT, boardRevision: 4 },
    intent: "show",
    reason: "The verifier is blocked on you.",
  }, { now, id: "attention_2" }).request;

  await poll();

  expect(one("[data-testid='attention-request']")!.textContent).toContain("The verifier is blocked on you.");
  expect(attentionForDevice(DEVICE, { now }).offer?.request.id).toBe(second.id);

  click(one("[data-testid='attention-accept']")!);
  await settle();

  const stored = readAttentionFile().requests.find((entry) => entry.id === "attention_2")!;
  expect(stored.state).toBe("following");
});

test("a request raised after a follow the operator never closed is rendered and answerable", async () => {
  /* The same silent swallow as the lost landing above, by the other route.
     `following` admits no event but Return, so an operator who follows and then
     walks away leaves that request live for good — and, being the oldest live
     entry, it is the only thing this device is ever shown again. */
  raise();
  const { bus } = board({ [ANCHOR]: LIVE_RECT });
  mount(bus);
  await settle();

  click(one("[data-testid='attention-accept']")!);
  await settle();
  expect(record().state).toBe("following");

  /* Long enough that the card has stopped naming where they came from, so there
     is nothing left on it to take away. */
  now = new Date(now.getTime() + RETURN_WINDOW_MS + 1);
  const second = raiseAttentionRequest({
    origin: "root-agent",
    target: { kind: "conversation", path: ANCHOR },
    frameAtCreation: { project: "demo", rect: RAISED_RECT, boardRevision: 4 },
    intent: "show",
    reason: "The verifier is blocked on you.",
  }, { now, id: "attention_2" }).request;

  await poll();

  expect(one("[data-testid='attention-request']")!.textContent).toContain("The verifier is blocked on you.");
  expect(attentionForDevice(DEVICE, { now }).offer?.request.id).toBe(second.id);
  /* Replaced by the agent's newer ask, which is a different fact from the
     operator refusing it and from nobody ever seeing it. */
  expect(record().state).toBe("superseded");

  click(one("[data-testid='attention-accept']")!);
  await settle();
  expect(readAttentionFile().requests.find((entry) => entry.id === "attention_2")!.state).toBe("following");
});

test("a follow nobody closes and nothing replaces is still bounded by the clock", async () => {
  raise();
  const { bus } = board({ [ANCHOR]: LIVE_RECT });
  mount(bus);
  await settle();

  click(one("[data-testid='attention-accept']")!);
  await settle();
  expect(record().state).toBe("following");

  /* Nothing is raised after it and Return is never pressed. Without a clock the
     record stays live indefinitely and the slot with it. */
  now = new Date(now.getTime() + FOLLOW_HOLD_MS);
  await poll();

  expect(record().state).toBe("expired");
  /* Seen, agreed to, never closed — not a refusal, and not "they never saw it". */
  expect(record().expiredCause).toBe("follow-elapsed");
  expect(attentionForDevice(DEVICE, { now }).offer).toBeNull();
  expect(dom.document.body.textContent).toBe("");
});

test("the refusal band can be dismissed, so a one-off refusal is not a permanent warning", async () => {
  raiseUnlandable();
  const { bus } = board({});
  mount(bus);
  await settle();

  click(one("[data-testid='attention-accept']")!);
  await settle();
  expect(one("[data-testid='attention-refused']")).not.toBeNull();

  click(one("[data-testid='attention-refused-dismiss']")!);
  await settle();

  /* Nothing is left to answer and nothing is left to say, so the surface goes
     away entirely rather than leaving a band the operator cannot get rid of. */
  expect(one("[data-testid='attention-refused']")).toBeNull();
  expect(dom.document.body.textContent).toBe("");
});

test("asking for a preview shows what it is about, named by the board when the board knows it", async () => {
  raise();
  const { bus } = board({ [ANCHOR]: LIVE_RECT });
  mount(bus);
  await settle();

  click(one("[data-testid='attention-preview']")!);
  await settle();

  /* The third branch of the loop — accept, decline, or look first — and it has
     to show something, or it is a control that does nothing. */
  const card = one("[data-testid='attention-preview-card']");
  expect(card).not.toBeNull();
  expect(card!.textContent).toContain("Reviewer — login fix");
  expect(card!.textContent).toContain("demo");
  /* Previewing never moves the view, whatever the target. */
  expect(record().state).toBe("previewing");
  expect(one("[data-testid='attention-accept']")).not.toBeNull();
});

test("a preview for a target the board cannot name still says what was asked about", async () => {
  raise();
  /* Another project's board is registered, so no label here may be borrowed
     from it: the same key can mean a different thing in a different layout. */
  const { bus } = board({ [ANCHOR]: LIVE_RECT }, "elsewhere");
  mount(bus);
  await settle();

  click(one("[data-testid='attention-preview']")!);
  await settle();

  const card = one("[data-testid='attention-preview-card']");
  expect(card!.textContent).toContain("reviewer");
  expect(card!.textContent).toContain("demo");
});

test("nothing renders while there is nothing to answer", async () => {
  const { bus } = board({ [ANCHOR]: LIVE_RECT });

  mount(bus);
  await settle();

  expect(dom.document.body.textContent).toBe("");
  expect(one("[data-testid='root-overlay-dock']")).toBeNull();
});
