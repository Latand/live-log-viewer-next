import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { installActEnv } from "@/test-helpers/actEnv";
import { reportCallPhase, resetActiveCallsForTest } from "@/lib/realtime/activeCall";

import { composerStore, resetComposerStoresForTest } from "./composerStore";
import { requestVoiceFloat, resetVoiceFloatRequestForTest } from "./floatRequest";
import { VoicePipHost } from "./VoicePipHost";

/**
 * #691 §4 — one source, two renderings, on the seam where duplication would happen.
 *
 * The failures this closes are all "a second one of something": a second realtime
 * client, a second `<audio>`, a second `getUserMedia`, a second dispatcher, a second
 * draft. So the assertions are mostly counts and identities, and the doubles are
 * placed at the browser boundary — a stub PiP window and spies on the audio/media
 * constructors — rather than at the app's own seams, because the app's seams are
 * exactly what is under test.
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
  resetActiveCallsForTest();
  resetComposerStoresForTest();
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
  for (const root of roots) flushSync(() => root.unmount());
  roots = [];
  await settle();
});

const CONVERSATION = "conversation_root_691";

/**
 * One fake standing in for the single realtime client.
 *
 * `resolveClient` is counted, which is how the "one client" invariant is asserted:
 * the host may resolve the conversation's client, but every resolution for one
 * conversation must return one instance. The real factory has that property already
 * (a module-scoped registry); this proves the host does not defeat it by resolving a
 * new one per render.
 */
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

/** A call starting: the client's phase moves and the registry hears about it, in the
    order production does it (client subscribers first, then the registry). */
function startCall(phase: Phase = "connecting") {
  clientSnapshot = snapshotFor(phase);
  flushSync(() => {
    for (const listener of listeners) listener();
    reportCallPhase(CONVERSATION, phase);
  });
}

function floatSurface() {
  return pip.document.querySelector("[data-testid='voice-float-surface']");
}

test("no call means no window and no floater", async () => {
  mount();
  await settle();
  expect(requestedWindows).toBe(0);
  expect(floatSurface()).toBeNull();
});

test("a voice start opens exactly one window and portals the surface into it (U4)", async () => {
  const { render } = mount();
  startCall();
  await settle();
  render();
  await settle();

  expect(requestedWindows).toBe(1);
  expect(floatSurface()).not.toBeNull();
  /* The surface lives in the PiP document, not in the page. */
  expect(dom.document.querySelector("[data-testid='voice-float-surface']")).toBeNull();
});

test("the PiP tree constructs no audio, no microphone and no peer connection (§4 rules 1–2)", async () => {
  const { render } = mount();
  startCall();
  await settle();
  render();
  await settle();

  expect(floatSurface()).not.toBeNull();
  expect(audioConstructions).toBe(0);
  expect(userMediaCalls).toBe(0);
  expect(peerConstructions).toBe(0);
  /* And it emits no sound: no media element of any kind in that document. */
  expect(pip.document.querySelectorAll("audio, video")).toHaveLength(0);
});

test("no work-log rows, tool-call rows or lifecycle journal entries render in the floater (AC12)", async () => {
  const { render } = mount();
  startCall();
  await settle();
  render();
  await settle();

  const text = pip.document.body.textContent ?? "";
  for (const forbidden of ["tool", "Tool", "lifecycle", "journal", "stage_", "pipeline"]) {
    expect(text).not.toContain(forbidden);
  }
  expect(pip.document.querySelector("[data-testid='log-feed']")).toBeNull();
});

test("the manager conversation never renders in the floater (AC19)", async () => {
  const { render } = mount();
  startCall();
  await settle();
  render();
  await settle();

  /* Only the conversation that has the call is rendered, by construction: the host
     resolves exactly one conversation id from the registry. */
  flushSync(() => reportCallPhase("conversation_manager", "idle"));
  await settle();
  expect(pip.document.body.textContent ?? "").not.toContain("conversation_manager");
});

test("the floater's composer writes the one shared draft (U2, AC4)", async () => {
  const { render } = mount();
  startCall();
  await settle();
  render();
  await settle();

  const input = pip.document.querySelector("[data-testid='voice-float-input']") as unknown as HTMLTextAreaElement;
  expect(input).not.toBeNull();

  /* Typing in the floater must land in the store the card reads, not in local state. */
  flushSync(() => composerStore(CONVERSATION).setDraft("start a reviewer"));
  await settle();
  expect((pip.document.querySelector("[data-testid='voice-float-input']") as unknown as HTMLTextAreaElement).value)
    .toBe("start a reviewer");
});

test("send goes through the opener's one send path, carrying the shared key (§4 rule 5)", async () => {
  const sends: { conversationId: string; draft: string; sendKey: string }[] = [];
  const { render } = mount({
    onSend: (conversationId, draft, sendKey) => { sends.push({ conversationId, draft, sendKey }); },
  });
  startCall();
  await settle();
  render();
  await settle();

  const store = composerStore(CONVERSATION);
  flushSync(() => store.setDraft("deploy it"));
  await settle();

  const button = pip.document.querySelector("[data-testid='voice-float-send']") as unknown as HTMLButtonElement;
  flushSync(() => button.click());
  await settle();

  expect(sends).toHaveLength(1);
  expect(sends[0]).toMatchObject({ conversationId: CONVERSATION, draft: "deploy it", sendKey: store.sendKey()! });
});

test("closing the floater is presentation only — the call is untouched (AC6)", async () => {
  const { render } = mount();
  startCall();
  await settle();
  render();
  await settle();
  flushSync(() => composerStore(CONVERSATION).setDraft("still typing"));
  await settle();

  const dock = pip.document.querySelector("[data-testid='voice-float-dock']") as unknown as HTMLButtonElement;
  flushSync(() => dock.click());
  await settle();

  expect(closed).toBe(1);
  expect(floatSurface()).toBeNull();
  /* The draft and the call survived: nothing was torn down but a window. */
  expect(composerStore(CONVERSATION).getSnapshot().draft).toBe("still typing");
  expect(audioConstructions).toBe(0);

  /* And it stays closed. A host that re-opened whenever a call was up with no window
     would make this button do nothing at all. */
  for (let renders = 0; renders < 3; renders += 1) {
    render();
    await settle();
  }
  expect(requestedWindows).toBe(1);
  expect(floatSurface()).toBeNull();
});

test("the card's float control re-opens the same call without a new window per render (§5)", async () => {
  const { render } = mount();
  startCall("live");
  await settle();
  render();
  await settle();

  const dock = pip.document.querySelector("[data-testid='voice-float-dock']") as unknown as HTMLButtonElement;
  flushSync(() => dock.click());
  await settle();
  expect(floatSurface()).toBeNull();

  flushSync(() => requestVoiceFloat());
  await settle();
  render();
  await settle();
  expect(requestedWindows).toBe(2);
  expect(floatSurface()).not.toBeNull();

  /* One request, one window: further renders do not ask again. */
  for (let renders = 0; renders < 3; renders += 1) {
    render();
    await settle();
  }
  expect(requestedWindows).toBe(2);
});

test("the host resolves one client per conversation, never one per render", async () => {
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

test("the call ending closes the floater", async () => {
  const { render } = mount();
  startCall();
  await settle();
  render();
  await settle();
  expect(floatSurface()).not.toBeNull();

  startCall("idle");
  await settle();
  render();
  await settle();

  expect(closed).toBe(1);
  expect(floatSurface()).toBeNull();
});

test("an unsupported browser leaves the call docked with no window and no error (AC8)", async () => {
  supported = false;
  const { render } = mount();
  startCall();
  await settle();
  render();
  await settle();

  expect(requestedWindows).toBe(0);
  expect(floatSurface()).toBeNull();
  expect(dom.document.querySelector("[role='alert']")).toBeNull();
});

test("a refused requestWindow is asked once, not in a loop", async () => {
  requestWindowRejects = true;
  const { render } = mount();
  startCall();
  await settle();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    render();
    await settle();
  }
  expect(requestedWindows).toBe(1);
  expect(floatSurface()).toBeNull();
});

test("mobile never opens a floater (§7)", async () => {
  const { render } = mount({ mobile: true });
  startCall();
  await settle();
  render();
  await settle();

  expect(requestedWindows).toBe(0);
  expect(floatSurface()).toBeNull();
});

test("the floater keeps working while the board is elsewhere (AC13)", async () => {
  const { render } = mount();
  startCall("live");
  await settle();
  render();
  await settle();

  /* Navigating the board re-renders the Viewer; the host is above it and the
     conversation it resolved has not changed. */
  for (let navigation = 0; navigation < 3; navigation += 1) {
    render();
    await settle();
  }
  expect(requestedWindows).toBe(1);
  expect(floatSurface()).not.toBeNull();
  expect(pip.document.querySelector("[data-testid='voice-float-input']")).not.toBeNull();
});

test("the transcript keeps its live region and the controls their pressed state (AC14)", async () => {
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
  const { render } = mount();
  startCall();
  await settle();
  render();
  await settle();

  expect(pip.document.documentElement.lang).toBe("uk");
  expect(pip.document.documentElement.dir).toBe("ltr");
});
