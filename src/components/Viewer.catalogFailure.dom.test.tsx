import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { en } from "@/lib/i18n/en";

/*
 * Issue #696, review finding 1 — the whole path, end to end.
 *
 * `catalogFailures` reached the overview board and the rail, but not the surface
 * an operator actually lands on: a project restored from `localStorage` or a
 * `#p=` hash opens `ProjectDashboard` directly, which rendered `SchemeSkeleton`
 * indefinitely when `/api/files` never succeeded. On a phone the rail is behind
 * a drawer, so nothing on screen named the failure at all.
 *
 * This mounts the real `Viewer` — restoring a project exactly as the app does —
 * against a failing fetch, and asserts what the operator sees.
 */

/** Flipped per test to drive `useIsMobile`. */
let phoneWidth = false;

/* React needs this before `act` will drive effects. */
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

/* `useIsMobile` reads `window.matchMedia`, which resolves to happy-dom's own
   Window — so the stub has to live there, not only on globalThis. Phone width
   is what makes this defect invisible: the shell swaps the rail for a drawer,
   leaving the dashboard as the only surface on screen. */
const matchMedia = (query: string) => ({
  matches: phoneWidth && query.includes("max-width: 767px"),
  media: query,
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => false,
});
Object.assign(globalThis, { matchMedia });
Object.assign(dom, { matchMedia });

/* The runtime bus is a separate plane; this test is about the catalog fetch.
   The constants ride along because other modules in the Viewer's import graph
   read them from the mocked module. */
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

const RESTORED_PROJECT = "restored-project";
const originalFetch = globalThis.fetch;

beforeEach(() => {
  phoneWidth = false;
  resetFilesClientCacheForTests();
  dom.localStorage.clear();
  dom.sessionStorage.clear();
  document.body.replaceChildren();
});

afterEach(() => {
  unmountViewer();
  globalThis.fetch = originalFetch;
  document.body.replaceChildren();
});

/** Everything `Viewer` fetches. Only `/api/files` is under test; every other
    endpoint 404s so its owner takes its own "no data" path rather than needing
    a hand-built fixture here. */
function stubFetch(filesResponse: () => Response) {
  let filesCalls = 0;
  globalThis.fetch = mock(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.startsWith("/api/files")) {
      filesCalls += 1;
      return filesResponse();
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  return () => filesCalls;
}

let mounted: { unmount: () => void } | null = null;

async function mountViewer(): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted = root;
  await act(async () => { root.render(<Viewer />); });
  /* Let the failed hydration settle and publish its count. */
  await act(async () => { await Bun.sleep(60); });
  return host as unknown as HTMLElement;
}

/** Unmount before the next test, so this Viewer's timers stop with it. */
function unmountViewer() {
  if (!mounted) return;
  const root = mounted;
  mounted = null;
  act(() => { root.unmount(); });
}

test("a project restored from localStorage names the catalog failure instead of loading forever", async () => {
  dom.localStorage.setItem("llvProject", RESTORED_PROJECT);
  const calls = stubFetch(() => new Response("upstream is down", { status: 500 }));

  const host = await mountViewer();

  /* The fetch really was attempted and really did fail. */
  expect(calls()).toBeGreaterThan(0);
  /* The operator is told, on the surface they landed on. */
  expect(host.querySelector('[data-catalog-error="true"]')).toBeTruthy();
  expect(host.textContent).toContain(en["catalog.errorTitle"]);
  expect(host.textContent).toContain(en["catalog.retry"]);
  /* And never the affirmative idle copy for a catalog nobody could read. */
  expect(host.textContent).not.toContain(en["common.nothingRunning"]);
  expect(host.textContent).not.toContain(en["overview.firstRunTitle"]);
});

test("a project restored from a #p= hash gets the same failure treatment", async () => {
  dom.location.hash = `#p=${encodeURIComponent(RESTORED_PROJECT)}`;
  const calls = stubFetch(() => new Response("upstream is down", { status: 500 }));

  const host = await mountViewer();

  expect(calls()).toBeGreaterThan(0);
  expect(host.querySelector('[data-catalog-error="true"]')).toBeTruthy();
  expect(host.textContent).toContain(en["catalog.errorTitle"]);
  dom.location.hash = "";
});

test("on a phone, where the rail is behind a drawer, the failure is still named", async () => {
  /* The review's core point: with the rail hidden the dashboard is the only
     surface on screen, so before the fix a dead server was indistinguishable
     from a slow load — no failure was visible ANYWHERE. */
  phoneWidth = true;
  dom.localStorage.setItem("llvProject", RESTORED_PROJECT);
  stubFetch(() => new Response("upstream is down", { status: 500 }));

  const host = await mountViewer();

  /* The rail really is gone. */
  expect(host.textContent).not.toContain(en["rail.title"]);
  /* And the failure is named anyway, with its recovery action. */
  expect(host.querySelector('[data-catalog-error="true"]')).toBeTruthy();
  expect(host.textContent).toContain(en["catalog.errorTitle"]);
  expect(host.textContent).toContain(en["catalog.retry"]);
  expect(host.textContent).not.toContain(en["common.nothingRunning"]);
});

test("a healthy catalog on the same restored project shows no failure at all", async () => {
  dom.localStorage.setItem("llvProject", RESTORED_PROJECT);
  stubFetch(() => new Response(JSON.stringify({ files: [], projectCatalog: [] })));

  const host = await mountViewer();

  expect(host.querySelector('[data-catalog-error="true"]')).toBeNull();
  expect(host.textContent).not.toContain(en["catalog.errorTitle"]);
});
