import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot } from "react-dom/client";

/*
 * The dock's place in the shell (issue #977 acceptance): it is PUSHED INTO the
 * layout between the project rail and the board — never an overlay — it follows
 * whichever project the rail has selected, it does not exist on the Overview
 * (which is not a project and has no seat), and its open state survives reload.
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
const { OPEN_KEY } = await import("./orchestrator/OrchestratorDock");

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

test("a stored open state restores the dock, pushed into the layout between the rail and the board", async () => {
  dom.localStorage.setItem("llvProject", PROJECT);
  dom.localStorage.setItem(OPEN_KEY, "1");

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
  dom.localStorage.setItem(OPEN_KEY, "1");

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
  expect(dom.localStorage.getItem(`${OPEN_KEY}:${PROJECT}`)).toBe("1");
  expect((host.querySelector("[data-orchestrator-toggle]") as HTMLButtonElement).getAttribute("aria-pressed")).toBe("true");

  await act(async () => { (host.querySelector("[data-orchestrator-toggle]") as HTMLButtonElement).click(); });
  expect(dock(host)).toBeNull();
  expect(dom.localStorage.getItem(`${OPEN_KEY}:${PROJECT}`)).toBe("0");
});

test("the dock follows the selected project", async () => {
  dom.localStorage.setItem("llvProject", PROJECT);
  dom.localStorage.setItem(OPEN_KEY, "1");

  const host = await mountViewer();
  expect(dock(host)!.querySelector("[data-orchestrator-panel]")?.getAttribute("data-orchestrator-panel")).toBe(PROJECT);

  await act(async () => {
    dom.location.hash = `#p=${encodeURIComponent(OTHER)}`;
    dom.dispatchEvent(new dom.Event("hashchange"));
  });
  await act(async () => { await Bun.sleep(20); });

  expect(dock(host)!.querySelector("[data-orchestrator-panel]")?.getAttribute("data-orchestrator-panel")).toBe(OTHER);
});
