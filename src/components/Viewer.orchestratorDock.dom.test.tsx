import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot } from "react-dom/client";

/*
 * The dock's place in the shell (issue #977 acceptance): it is PUSHED INTO the
 * layout between the project rail and the board — never an overlay — it follows
 * whichever project the rail has selected, it does not exist on the Overview
 * (which is not a project and has no seat), and its open state survives reload.
 *
 * That open state is the PROJECT's since #1149: each project answers under its
 * own key, the pre-#1149 global flag only seeds a project that never answered,
 * and closing the dock in one project leaves every other project's alone.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const dom = new Window({ url: "http://localhost/" });
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  location: dom.location,
  history: dom.history,
  localStorage: dom.localStorage,
  sessionStorage: dom.sessionStorage,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
  KeyboardEvent: dom.KeyboardEvent,
  MouseEvent: dom.MouseEvent,
  MutationObserver: dom.MutationObserver,
  ResizeObserver: dom.ResizeObserver ?? class { observe() {} unobserve() {} disconnect() {} },
  requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
});

/* Desktop: the dock is a desktop surface. */
const matchMedia = (query: string) => ({
  matches: false, media: query, onchange: null,
  addListener: () => {}, removeListener: () => {},
  addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
});
Object.assign(globalThis, { matchMedia });
Object.assign(dom, { matchMedia });

/* The board children call `animate`; happy-dom has no Web Animations, and
   `useFlip` subscribes to the returned animation's `finish` event. */
(dom.HTMLElement.prototype as unknown as { animate: () => unknown }).animate = () => ({
  finished: Promise.resolve(),
  cancel() {},
  finish() {},
  addEventListener() {},
  removeEventListener() {},
});

/* The runtime bus is a separate plane. Its constants ride along because other
   modules in the Viewer's import graph read them from the mocked module. */
mock.module("@/hooks/runtimeBus", () => ({
  SNAPSHOT_URL: "/api/runtime/snapshot",
  STREAM_URL: "/api/runtime/stream",
  STREAM_RECONNECTED_EVENT: "llv:stream-reconnected",
  isRuntimeUiEnabled: () => false,
  getRuntimeBus: () => ({
    getState: () => ({ connection: "offline" }),
    subscribe: () => () => {},
    subscribeFilesRevision: () => () => {},
  }),
}));

const { Viewer } = await import("./Viewer");
const { resetFilesClientCacheForTests } = await import("@/hooks/useFiles");
const { LEGACY_OPEN_KEY } = await import("./orchestrator/OrchestratorDock");
const openKey = (project: string) => `${LEGACY_OPEN_KEY}:${project}`;

const PROJECT = "atlas";
const OTHER = "borealis";
const originalFetch = globalThis.fetch;

function stubFetch(): void {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.startsWith("/api/files")) {
      return new Response(JSON.stringify({
        files: [],
        projectCatalog: [{ project: PROJECT, conversations: 0 }, { project: OTHER, conversations: 0 }],
      }));
    }
    if (url.startsWith("/api/orchestrator/seat")) {
      return new Response(JSON.stringify({ seat: null, pending: null, exists: true }));
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

let mounted: { unmount: () => void } | null = null;

beforeEach(() => {
  resetFilesClientCacheForTests();
  dom.localStorage.clear();
  dom.sessionStorage.clear();
  dom.location.hash = "";
  dom.document.body.replaceChildren();
  stubFetch();
});

afterEach(() => {
  if (mounted) {
    const root = mounted;
    mounted = null;
    act(() => root.unmount());
  }
  globalThis.fetch = originalFetch;
  dom.document.body.replaceChildren();
});

async function mountViewer(): Promise<HTMLElement> {
  const host = dom.document.createElement("div");
  dom.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  mounted = root;
  await act(async () => { root.render(<Viewer />); });
  await act(async () => { await Bun.sleep(60); });
  return host as unknown as HTMLElement;
}

function dock(host: HTMLElement): HTMLElement | null {
  return host.querySelector("[data-orchestrator-dock]");
}

/** Present or not, as a boolean: a failing `toBeNull()` on a happy-dom element
    prints the whole node graph, which is megabytes of noise around one bit. */
const hasDock = (host: HTMLElement) => dock(host) !== null;

/** Selecting a project the way the rail does — through the hash, which is also
    what a reload of a project URL replays. Explicit, because a test that
    inherits the previous one's hash is a test of the Overview. */
async function goTo(project: string): Promise<void> {
  await act(async () => {
    dom.location.hash = `#p=${encodeURIComponent(project)}`;
    dom.dispatchEvent(new dom.Event("hashchange"));
  });
  await act(async () => { await Bun.sleep(20); });
}

test("a stored open state restores the dock, pushed into the layout between the rail and the board", async () => {
  dom.localStorage.setItem("llvProject", PROJECT);
  dom.localStorage.setItem(openKey(PROJECT), "1");

  const host = await mountViewer();

  const panel = dock(host);
  expect(panel).not.toBeNull();
  expect(panel!.querySelector("[data-orchestrator-panel]")?.getAttribute("data-orchestrator-panel")).toBe(PROJECT);

  /* In the layout, not over it: the shell row is rail → dock → main, and the
     dock is a plain flex sibling with no fixed/absolute positioning. */
  const shell = panel!.parentElement!;
  const children = [...shell.children];
  const rail = shell.querySelector("aside:not([data-orchestrator-dock])");
  expect(children.indexOf(panel!)).toBeGreaterThan(children.indexOf(rail as Element));
  expect(children.indexOf(panel!)).toBeLessThan(children.indexOf(shell.querySelector("main") as Element));
  expect(panel!.className).not.toContain("fixed");
  expect(panel!.className).not.toContain("absolute");
});

test("the Overview has no orchestrator dock, even with the panel remembered open", async () => {
  dom.localStorage.setItem(LEGACY_OPEN_KEY, "1");

  const host = await mountViewer();

  expect(dock(host)).toBeNull();
});

test("the header button toggles the dock and the choice survives a reload", async () => {
  dom.localStorage.setItem("llvProject", PROJECT);

  const host = await mountViewer();
  expect(dock(host)).toBeNull();

  const toggle = host.querySelector("[data-orchestrator-toggle]") as HTMLButtonElement;
  expect(toggle).not.toBeNull();
  expect(toggle.getAttribute("aria-pressed")).toBe("false");

  await act(async () => { toggle.click(); });
  expect(dock(host)).not.toBeNull();
  /* Under the project's own key, and the pre-#1149 global flag is left exactly
     as the operator had it — it seeds, it is never written. */
  expect(dom.localStorage.getItem(openKey(PROJECT))).toBe("1");
  expect(dom.localStorage.getItem(LEGACY_OPEN_KEY)).toBeNull();
  expect((host.querySelector("[data-orchestrator-toggle]") as HTMLButtonElement).getAttribute("aria-pressed")).toBe("true");

  await act(async () => { (host.querySelector("[data-orchestrator-toggle]") as HTMLButtonElement).click(); });
  expect(dock(host)).toBeNull();
  expect(dom.localStorage.getItem(openKey(PROJECT))).toBe("0");
});

test("the dock follows the selected project", async () => {
  dom.localStorage.setItem("llvProject", PROJECT);
  dom.localStorage.setItem(LEGACY_OPEN_KEY, "1");

  const host = await mountViewer();
  expect(dock(host)!.querySelector("[data-orchestrator-panel]")?.getAttribute("data-orchestrator-panel")).toBe(PROJECT);

  await goTo(OTHER);

  expect(dock(host)!.querySelector("[data-orchestrator-panel]")?.getAttribute("data-orchestrator-panel")).toBe(OTHER);
});

test("closing the dock in one project leaves the other project's open", async () => {
  /* Both projects open, from the one flag an operator carries in (#1149 seed). */
  dom.localStorage.setItem("llvProject", PROJECT);
  dom.localStorage.setItem(LEGACY_OPEN_KEY, "1");

  const host = await mountViewer();
  await goTo(PROJECT);
  expect(hasDock(host)).toBe(true);

  /* The operator closes it in the project they are only glancing at... */
  await goTo(OTHER);
  expect(hasDock(host)).toBe(true);
  await act(async () => { (host.querySelector("[data-orchestrator-toggle]") as HTMLButtonElement).click(); });
  expect(hasDock(host)).toBe(false);
  expect(dom.localStorage.getItem(openKey(OTHER))).toBe("0");

  /* ...and the project they are running still has its dock. */
  await goTo(PROJECT);
  expect(hasDock(host)).toBe(true);
  expect(dock(host)!.querySelector("[data-orchestrator-panel]")?.getAttribute("data-orchestrator-panel")).toBe(PROJECT);
  expect(dom.localStorage.getItem(openKey(PROJECT))).toBeNull();

  /* Back again: still closed where it was closed, and nothing wrote the seed. */
  await goTo(OTHER);
  expect(hasDock(host)).toBe(false);
  expect(dom.localStorage.getItem(LEGACY_OPEN_KEY)).toBe("1");
});

test("a project's own answer outranks the pre-#1149 global flag", async () => {
  dom.localStorage.setItem("llvProject", PROJECT);
  dom.localStorage.setItem(LEGACY_OPEN_KEY, "1");
  /* Closed here, and the seed says «open»: the project that answered wins. */
  dom.localStorage.setItem(openKey(PROJECT), "0");

  const host = await mountViewer();
  await goTo(PROJECT);
  expect(hasDock(host)).toBe(false);

  /* The seed still answers for the project that never has. */
  await goTo(OTHER);
  expect(hasDock(host)).toBe(true);
});
