import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";

import { emptyStore } from "@/components/runtime/runtimeModel";

/* No-flash regression for the board's first paint (#172). The board used to
   paint the raw scan snapshot before the persisted board state loaded, then cull
   it (closes/worker-collapse/caps applying late) — a visible flash of nodes. The
   dashboard now holds a skeleton until BOTH the scan and the persisted board
   state resolve, so the first real frame equals the settled arrangement.

   This mounts the real ProjectDashboard and asserts the content region shows the
   busy skeleton on the first frame and never any node before the board settles;
   only after the persisted state lands does the real content render. */

const actualRuntimeHooks = await import("@/hooks/useRuntime");
const actualConversationCatalogHooks = await import("@/hooks/useConversationCatalog");
const inertRuntime = { enabled: false, connection: "offline" as const, resyncedAt: null, store: emptyStore() };
mock.module("@/hooks/useRuntime", () => ({
  ...actualRuntimeHooks,
  useRuntimeBusState: () => ({ ...inertRuntime, lastEventAt: null }),
  useRuntime: () => inertRuntime,
  useRuntimeSession: () => null,
  useRuntimeReceiptsForArtifact: () => [],
  useRuntimeFlow: () => null,
}));
mock.module("@/hooks/useConversationCatalog", () => ({
  useConversationCatalog: () => ({
    items: [],
    nextCursor: null,
    total: 0,
    loading: false,
    error: false,
    loadMore: () => {},
    retry: () => {},
  }),
}));

const { ProjectDashboard } = await import("@/components/ProjectDashboard");

const dom = new Window({ url: "http://localhost/" });
const G = globalThis as Record<string, unknown>;

/* Desktop surface (matchMedia never matches) so the scheme/skeleton renders in
   the main content column rather than the phone focus view. */
const desktopMatchMedia = (query: string) => ({
  matches: false,
  media: String(query),
  onchange: null,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
  dispatchEvent() { return false; },
});

/* Gate the board GET so the "before settle" assertion observes the real holding
   window; every other request resolves inert. */
let releaseBoard = () => {};
const boardGate = new Promise<void>((resolve) => (releaseBoard = resolve));
const OVERRIDES: Record<string, unknown> = {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  Event: dom.Event,
  MouseEvent: dom.MouseEvent,
  sessionStorage: dom.sessionStorage,
  localStorage: dom.localStorage,
  matchMedia: desktopMatchMedia,
  requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } },
  fetch: (async (input: string | URL | Request) => {
    const url = String(input);
    const body = url.startsWith("/api/conversations") ? { items: [], nextCursor: null } : {};
    if (url.startsWith("/api/board")) await boardGate;
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  }) as unknown as typeof fetch,
};
const HAS: Record<string, boolean> = {};
const SAVED: Record<string, unknown> = {};

const settle = async () => {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
};
const waitFor = async (pred: () => boolean, timeoutMs = 4000): Promise<boolean> => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 15));
  }
  return pred();
};

beforeAll(() => {
  for (const key of Object.keys(OVERRIDES)) {
    HAS[key] = key in G;
    SAVED[key] = G[key];
    G[key] = OVERRIDES[key];
  }
  (dom.HTMLElement.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {};
});
afterAll(async () => {
  releaseBoard();
  await settle();
  for (const key of Object.keys(OVERRIDES)) {
    if (HAS[key]) G[key] = SAVED[key];
    else delete G[key];
  }
  mock.module("@/hooks/useRuntime", () => actualRuntimeHooks);
  mock.module("@/hooks/useConversationCatalog", () => actualConversationCatalogHooks);
});

let roots: Root[] = [];
beforeEach(() => {
  roots = [];
});
afterEach(() => {
  for (const root of roots) flushSync(() => root.unmount());
});

const dashboardProps = (project: string) => ({
  files: [],
  flows: [],
  pipelines: [],
  workflows: [],
  tasks: [],
  project,
  loaded: true,
  openNonce: 0,
  archived: false,
  catalogKnown: false,
  projectCwd: `/home/tester/Projects/${project}`,
  catalogConversationCount: 0,
  onArchive: () => {},
  onUnarchive: () => {},
});

function mount(node: React.ReactElement): { root: Root; host: HTMLElement } {
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as Element);
  flushSync(() => root.render(node));
  roots.push(root);
  return { root, host: host as unknown as HTMLElement };
}

const skeleton = (host: HTMLElement) => host.querySelector('[role="status"][aria-busy="true"]');

test("the first frame is the busy skeleton, never a node, until the persisted board state lands (#172)", async () => {
  const { host } = mount(<ProjectDashboard {...dashboardProps("flash-guard")} />);

  /* First paint: the board GET is still gated, so the content column must hold
     the busy skeleton and show no settled content yet. */
  expect(skeleton(host)).not.toBeNull();
  expect(host.textContent ?? "").not.toContain("empty for now");

  /* The persisted state resolves; the skeleton clears and the real (here empty)
     content renders. Because the skeleton preceded it, no node was ever painted
     and then removed. */
  releaseBoard();
  const settled = await waitFor(() => skeleton(host) === null);
  expect(settled).toBe(true);
  expect(skeleton(host)).toBeNull();
  await settle();
});
