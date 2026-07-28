import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { installActEnv } from "@/test-helpers/actEnv";
import { reportCallPhase, resetActiveCallsForTest } from "@/lib/realtime/activeCall";

import { requestVoiceFloat, resetVoiceFloatRequestForTest } from "./floatRequest";
import { publishVoiceDockSlot, resetVoiceSlotsForTest } from "./voiceSlots";
import { VoicePipHost } from "./VoicePipHost";

/**
 * #691, ownership inverted — one panel, two containments.
 *
 * The host is the SOLE renderer of the voice panel; the card publishes an empty
 * dock slot and the floating window is a PiP document the host owns. So the
 * assertions here are about placement and window lifetime: the panel is in exactly
 * one document at a time, the window opens once per call and closes with it, and
 * the PiP tree constructs no second transport.
 */

installActEnv();

const dom = new Window({ url: "http://localhost/" });
const pip = new Window({ url: "http://localhost/" });

const G = globalThis as Record<string, unknown>;
const HAS: Record<string, boolean> = {};
const SAVED: Record<string, unknown> = {};

let audioConstructions = 0;
let userMediaCalls = 0;
let peerConstructions = 0;
let requestedWindows = 0;
let requestWindowRejects = false;
let supported = true;
let closed = 0;

const OVERRIDES = (): Record<string, unknown> => ({
  window: dom,
  document: dom.document,
  /* Spelled out rather than spread from `dom.navigator`: spreading a host object
     drops its prototype getters, so `navigator.language` came back undefined and
     the locale hook threw inside render. */
  navigator: {
    language: "en-US",
    languages: ["en-US"],
    userAgent: "test",
    mediaDevices: { getUserMedia: async () => { userMediaCalls += 1; return {} as MediaStream; } },
  },
  localStorage: dom.localStorage,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  Event: dom.Event,
  MouseEvent: dom.MouseEvent,
  Audio: class { constructor() { audioConstructions += 1; } },
  RTCPeerConnection: class { constructor() { peerConstructions += 1; } },
});

const settle = async () => { for (let i = 0; i < 8; i += 1) await new Promise((r) => setTimeout(r, 0)); };

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
let retractDockSlot: (() => void) | null = null;

beforeEach(() => {
  dom.document.body.replaceChildren();
  pip.document.body.replaceChildren();
  pip.document.head.replaceChildren();
  roots = [];
  audioConstructions = 0;
  userMediaCalls = 0;
  peerConstructions = 0;
  requestedWindows = 0;
  requestWindowRejects = false;
  supported = true;
  closed = 0;
  retractDockSlot = null;
  resetActiveCallsForTest();
  resetVoiceSlotsForTest();
  resolutions = [];
  listeners.clear();
  clientSnapshot = snapshotFor("idle");

  /* The stub stands exactly where Chromium's API does, so the hook under test runs
     its real code path — including the stylesheet adoption. */
  Object.defineProperty(dom, "documentPictureInPicture", {
    configurable: true,
    get: () => (supported
      ? {
        window: null,
        requestWindow: async () => {
          requestedWindows += 1;
          if (requestWindowRejects) throw new Error("denied");
          return pip as unknown as Window;
        },
      }
      : undefined),
  });
  resetVoiceFloatRequestForTest();
  /* Defined rather than assigned: happy-dom's real `close()` destroys the window,
     and a destroyed document under a live React portal hangs the render. */
  Object.defineProperty(pip, "close", { configurable: true, writable: true, value: () => { closed += 1; } });
});

afterEach(async () => {
  retractDockSlot?.();
  for (const root of roots) flushSync(() => root.unmount());
  roots = [];
  await settle();
});

const CONVERSATION = "conversation_root_691";

type Phase = "idle" | "connecting" | "live" | "stopping" | "error";

let resolutions: string[] = [];
const listeners = new Set<() => void>();
let clientSnapshot = snapshotFor("idle");

function snapshotFor(phase: Phase) {
  return {
    phase,
    lines: phase === "idle"
      ? ([] as const)
      : ([{ id: "l1", role: "assistant" as const, text: "listening", final: true }] as const),
    error: null,
    startedAt: phase === "live" ? 1_000 : null,
    micMuted: false,
    outputMuted: false,
  };
}

const CLIENT = {
  subscribe: (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getSnapshot: () => clientSnapshot,
  micStream: () => null,
  toggleMic: () => undefined,
  toggleOutput: () => undefined,
  start: async () => undefined,
  stop: async () => undefined,
};

const resolveClient = (conversationId: string) => {
  resolutions.push(conversationId);
  return CLIENT;
};

function mount(props: Partial<Parameters<typeof VoicePipHost>[0]> = {}) {
  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  roots.push(root);
  const render = (overrides: Partial<Parameters<typeof VoicePipHost>[0]> = {}) =>
    flushSync(() => root.render(
      <VoicePipHost mobile={false} resolveClient={resolveClient} {...props} {...overrides} />,
    ));
  render();
  return { root, render };
}

/** The card's side of the seam: an empty dock slot published for the conversation. */
function publishDockSlot(): HTMLElement {
  const slot = dom.document.createElement("div") as unknown as HTMLElement;
  slot.setAttribute("data-testid", "voice-dock-slot");
  dom.document.body.appendChild(slot as never);
  flushSync(() => { retractDockSlot = publishVoiceDockSlot(CONVERSATION, slot); });
  return slot;
}

/** A call starting: the client's phase moves and the registry hears about it, in the
    order production does it (client subscribers first, then the registry). */
function startCall(phase: Phase = "connecting") {
  clientSnapshot = snapshotFor(phase);
  flushSync(() => {
    for (const listener of listeners) listener();
    reportCallPhase(CONVERSATION, phase);
  });
}

const panelIn = (doc: typeof dom.document | typeof pip.document) =>
  doc.querySelector("section[data-phase]");

test("no call means no window, no panel, nothing rendered", async () => {
  publishDockSlot();
  mount();
  await settle();
  expect(requestedWindows).toBe(0);
  expect(panelIn(pip.document)).toBeNull();
  expect(panelIn(dom.document)).toBeNull();
});

test("a voice start opens exactly one window and the ONE panel moves into it (U4)", async () => {
  const slot = publishDockSlot();
  const { render } = mount();
  startCall();
  await settle();
  render();
  await settle();

  expect(requestedWindows).toBe(1);
  expect(panelIn(pip.document)).not.toBeNull();
  /* One containment at a time: the dock slot is empty while the window is open. */
  expect(slot.querySelector("section[data-phase]")).toBeNull();
  /* And the host offered the card a composer slot inside the window. */
  expect(pip.document.querySelector("[data-testid='voice-pip-composer-slot']")).not.toBeNull();
  expect(pip.document.querySelector("[data-testid='voice-float-dock']")).not.toBeNull();
});

test("without PiP support the panel docks into the card's published slot (AC8)", async () => {
  supported = false;
  const slot = publishDockSlot();
  const { render } = mount();
  startCall("live");
  await settle();
  render();
  await settle();

  expect(requestedWindows).toBe(0);
  expect(slot.querySelector("section[data-phase='live']")).not.toBeNull();
  expect(dom.document.querySelector("[role='alert']")).toBeNull();
});

test("the PiP tree constructs no audio, no microphone and no peer connection (§4 rules 1–2)", async () => {
  publishDockSlot();
  const { render } = mount();
  startCall();
  await settle();
  render();
  await settle();

  expect(panelIn(pip.document)).not.toBeNull();
  expect(audioConstructions).toBe(0);
  expect(userMediaCalls).toBe(0);
  expect(peerConstructions).toBe(0);
  /* And it emits no sound: no media element of any kind in that document. */
  expect(pip.document.querySelectorAll("audio, video")).toHaveLength(0);
});

test("docking is presentation only — the panel returns to the card and the call is untouched (AC6)", async () => {
  const slot = publishDockSlot();
  const { render } = mount();
  startCall("live");
  await settle();
  render();
  await settle();

  const dock = pip.document.querySelector("[data-testid='voice-float-dock']") as unknown as HTMLButtonElement;
  flushSync(() => dock.click());
  await settle();
  render();
  await settle();

  expect(closed).toBe(1);
  expect(panelIn(pip.document)).toBeNull();
  /* The same panel, back in the card's slot: containment changed, nothing else. */
  expect(slot.querySelector("section[data-phase='live']")).not.toBeNull();
  expect(audioConstructions).toBe(0);

  /* And it stays closed. A host that re-opened whenever a call was up with no window
     would make this button do nothing at all. */
  for (let renders = 0; renders < 3; renders += 1) {
    render();
    await settle();
  }
  expect(requestedWindows).toBe(1);
  expect(panelIn(pip.document)).toBeNull();
});

test("the card's float control re-opens the same call without a new window per render (§5)", async () => {
  publishDockSlot();
  const { render } = mount();
  startCall("live");
  await settle();
  render();
  await settle();

  const dock = pip.document.querySelector("[data-testid='voice-float-dock']") as unknown as HTMLButtonElement;
  flushSync(() => dock.click());
  await settle();
  expect(panelIn(pip.document)).toBeNull();

  flushSync(() => requestVoiceFloat());
  await settle();
  render();
  await settle();
  expect(requestedWindows).toBe(2);
  expect(panelIn(pip.document)).not.toBeNull();

  /* One request, one window: further renders do not ask again. */
  for (let renders = 0; renders < 3; renders += 1) {
    render();
    await settle();
  }
  expect(requestedWindows).toBe(2);
});

test("the host resolves one client per conversation, never one per render", async () => {
  publishDockSlot();
  const { render } = mount();
  startCall("live");
  await settle();
  for (let renders = 0; renders < 5; renders += 1) {
    render();
    await settle();
  }
  /* Resolutions are memoized on the conversation id, and every one of them returns
     the same instance — the registry's guarantee, not re-implemented here. */
  expect(new Set(resolutions).size).toBe(1);
  expect(resolutions[0]).toBe(CONVERSATION);
});

test("the call ending closes the window and the ended transcript stays docked", async () => {
  const slot = publishDockSlot();
  const { render } = mount();
  startCall("live");
  await settle();
  render();
  await settle();
  expect(panelIn(pip.document)).not.toBeNull();

  /* Hang up: phase back to idle, but the transcript lines survive in the client. */
  clientSnapshot = { ...snapshotFor("live"), phase: "idle" as Phase } as typeof clientSnapshot;
  flushSync(() => {
    for (const listener of listeners) listener();
    reportCallPhase(CONVERSATION, "idle");
  });
  await settle();
  render();
  await settle();

  expect(closed).toBe(1);
  expect(panelIn(pip.document)).toBeNull();
  /* The panel outlives the call, exactly as it did when the card rendered it:
     the operator keeps reading the transcript after a hangup. */
  expect(slot.querySelector("section[data-phase='idle']")).not.toBeNull();
});

test("a refused requestWindow is asked once, not in a loop", async () => {
  requestWindowRejects = true;
  publishDockSlot();
  const { render } = mount();
  startCall();
  await settle();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    render();
    await settle();
  }
  expect(requestedWindows).toBe(1);
  expect(panelIn(pip.document)).toBeNull();
});

test("mobile never opens a floater, and still docks the panel (§7)", async () => {
  const slot = publishDockSlot();
  const { render } = mount({ mobile: true });
  startCall("live");
  await settle();
  render();
  await settle();

  expect(requestedWindows).toBe(0);
  expect(panelIn(pip.document)).toBeNull();
  expect(slot.querySelector("section[data-phase='live']")).not.toBeNull();
});

test("the floating window keeps working while the board is elsewhere (AC13)", async () => {
  /* No dock slot at all: the card is unmounted. The window must not care. */
  const { render } = mount();
  startCall("live");
  await settle();
  render();
  await settle();

  for (let navigation = 0; navigation < 3; navigation += 1) {
    render();
    await settle();
  }
  expect(requestedWindows).toBe(1);
  expect(panelIn(pip.document)).not.toBeNull();
});

test("the transcript keeps its live region and the dock control its label (AC14)", async () => {
  publishDockSlot();
  const { render } = mount();
  startCall("live");
  await settle();
  render();
  await settle();

  expect(pip.document.querySelector("[aria-live='polite']")).not.toBeNull();
  expect(pip.document.querySelector("[role='status']")).not.toBeNull();
  const dock = pip.document.querySelector("[data-testid='voice-float-dock']");
  expect(dock?.getAttribute("aria-label")).toBeTruthy();
});

test("the floater adopts the opener's styles, language and direction", async () => {
  dom.document.documentElement.lang = "uk";
  dom.document.documentElement.dir = "ltr";
  publishDockSlot();
  const { render } = mount();
  startCall();
  await settle();
  render();
  await settle();

  expect(pip.document.documentElement.lang).toBe("uk");
  expect(pip.document.documentElement.dir).toBe("ltr");
});
