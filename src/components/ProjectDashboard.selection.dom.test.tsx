/**
 * The #771 publication contract, driven through the real ProjectDashboard: the
 * canonical selection is one set that survives a MODE SWITCH, and every view
 * publishes it — the scheme board, the flat list, and both phone modes.
 *
 * Before the lift, `multi` was local state inside SchemeBoard: switching to the
 * list unmounted the board and destroyed the selection, and both non-scheme
 * publishers hardcoded `selectedPaths: []`.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";

import { emptyStore } from "@/components/runtime/runtimeModel";
import { applyBoardMutations, type BoardMutationV1 } from "@/lib/board/mutations";
import type { FileEntry } from "@/lib/types";
import type { BoardProjectStateV1 } from "@/lib/view/types";

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
  useConversationCatalog: () => ({ items: [], nextCursor: null, total: 0, loading: false, error: false, loadMore: () => {}, retry: () => {} }),
}));
const { viewBus } = await import("@/hooks/viewPresenceBus");
const { resetSelectionSessionsForTest } = await import("@/hooks/useBoardState");
const { ProjectDashboard } = await import("@/components/ProjectDashboard");

const dom = new Window({ url: "http://localhost/" });
const G = globalThis as Record<string, unknown>;

/* Switchable surface: the same selection has to be published by the desktop
   board and by the phone's focus view, so the tests flip this between mounts. */
let mobile = false;
const matchMediaFor = (query: string) => ({
  matches: mobile && String(query).includes("max-width: 767px"),
  media: String(query),
  onchange: null,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
  dispatchEvent() { return false; },
});

/* In-memory board API over the real mutation reducer: the view-mode switch below
   is a genuine PATCH, so the mode really changes the way it does in the app. */
/* A distinct project per test: the board store keeps a module-level session cache
   of the last confirmed board per project, so reusing one name would let a
   durable close in one case prime the next case's first frame. */
let projectCounter = 0;
let PROJECT = "selection-contract-0";
let boards: Record<string, BoardProjectStateV1> = {};
const emptyBoard = (): BoardProjectStateV1 => ({
  schemaVersion: 1,
  revision: 0,
  updatedAt: new Date(0).toISOString(),
  pathAliases: {},
  prefs: { manual: [], hidden: [], expanded: [], favorites: [], foldedEngineChildIds: [], expandedEngineTrayParentIds: [], viewMode: null, taskPanelOpen: false },
});

/* An operator who already has both conversations on their board, so the scheme
   opens with two real cards (and therefore two hover checks) to select. */
const seededBoard = (): BoardProjectStateV1 => ({
  ...emptyBoard(),
  revision: 1,
  explicitManual: ["/alpha", "/beta"],
  prefs: { ...emptyBoard().prefs, manual: ["/alpha", "/beta"] },
});

const OVERRIDES: Record<string, unknown> = {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLButtonElement: dom.HTMLButtonElement,
  HTMLDivElement: dom.HTMLDivElement,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
  MouseEvent: dom.MouseEvent,
  PointerEvent: dom.PointerEvent,
  KeyboardEvent: dom.KeyboardEvent,
  WheelEvent: dom.WheelEvent,
  sessionStorage: dom.sessionStorage,
  localStorage: dom.localStorage,
  matchMedia: matchMediaFor,
  requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } },
  fetch: (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.startsWith("/api/board")) {
      if (method === "GET") {
        const project = new URL(url, "http://x").searchParams.get("project")!;
        return { ok: true, status: 200, json: async () => ({ ok: true, board: boards[project] ?? emptyBoard() }), text: async () => "" };
      }
      const body = JSON.parse(String(init?.body)) as { project: string; mutations?: BoardMutationV1[] };
      const current = boards[body.project] ?? emptyBoard();
      const reduced = applyBoardMutations(current, body.mutations ?? []);
      const next = { ...reduced, schemaVersion: 1 as const, revision: current.revision + 1, updatedAt: new Date(0).toISOString(), pathAliases: reduced.pathAliases ?? {} };
      boards[body.project] = next;
      return { ok: true, status: 200, json: async () => ({ ok: true, applied: true, board: next }), text: async () => "" };
    }
    const body = url.startsWith("/api/conversations") ? { items: [], nextCursor: null } : {};
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  }) as unknown as typeof fetch,
};
const HAS: Record<string, boolean> = {};
const SAVED: Record<string, unknown> = {};

beforeAll(() => {
  for (const key of Object.keys(OVERRIDES)) {
    HAS[key] = key in G;
    SAVED[key] = G[key];
    G[key] = OVERRIDES[key];
  }
  (dom.HTMLElement.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {};
  /* useIsMobile asks `window.matchMedia`, and `window` here is the happy-dom
     instance — overriding the global alone would leave its real implementation
     answering from happy-dom's own (desktop) viewport. */
  (dom as unknown as { matchMedia: (query: string) => unknown }).matchMedia = matchMediaFor;
});
afterAll(async () => {
  /* Let React finish any scheduled work before the DOM globals go away. */
  for (let index = 0; index < 8; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
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
  mobile = false;
  projectCounter += 1;
  PROJECT = `selection-contract-${projectCounter}`;
  boards = { [PROJECT]: seededBoard() };
  resetSelectionSessionsForTest();
});
afterEach(() => {
  for (const root of roots) flushSync(() => root.unmount());
  dom.document.body.replaceChildren();
});

const settle = async () => {
  for (let index = 0; index < 6; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  flushSync(() => undefined);
};
const waitFor = async (predicate: () => boolean, timeoutMs = 4000): Promise<boolean> => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  return predicate();
};

function file(path: string, title: string, mtime: number): FileEntry {
  return {
    path, root: "claude-projects", name: `${title}.jsonl`, project: PROJECT, title,
    engine: "claude", kind: "session", fmt: "claude", parent: null, mtime, size: 1,
    activity: "idle", proc: null, pid: null, model: null, pendingQuestion: null, waitingInput: null,
  };
}
/* Built per call, because each test runs under its own project key. */
const alphaOf = () => file("/alpha", "Alpha", 2);
const betaOf = () => file("/beta", "Beta", 1);
const alpha = { path: "/alpha" };
const beta = { path: "/beta" };

function mount(files: FileEntry[] = [alphaOf(), betaOf()]): HTMLElement {
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as Element);
  flushSync(() =>
    root.render(
      <ProjectDashboard
        files={files}
        flows={[]}
        pipelines={[]}
        workflows={[]}
        tasks={[]}
        project={PROJECT}
        loaded
        openNonce={0}
        archived={false}
        catalogKnown
        catalogConversationCount={files.length}
        onArchive={() => {}}
        onUnarchive={() => {}}
      />,
    ),
  );
  roots.push(root);
  return host as unknown as HTMLElement;
}

const slice = () => viewBus.getSlice();
const checkIn = (host: HTMLElement, path: string) => host.querySelector(`[data-select-check="${path}"]`) as HTMLElement | null;
const clickCheck = (host: HTMLElement, path: string) => {
  const check = checkIn(host, path);
  expect(check).not.toBeNull();
  flushSync(() => check!.dispatchEvent(new dom.MouseEvent("click", { bubbles: true, cancelable: true }) as never));
};
/** The list's own row order: quiet history is freshest-first by mtime. */
const listOrder = [alpha.path, beta.path];

/** The view toggle an operator actually clicks. */
function clickViewTab(host: HTMLElement, view: "scheme" | "list") {
  const label = view === "scheme" ? "scheme" : "conversations";
  const tab = Array.from(host.querySelectorAll("button[aria-pressed]")).find(
    (button) => (button.getAttribute("aria-label") ?? "") === label,
  ) as HTMLButtonElement | undefined;
  expect(tab).toBeTruthy();
  flushSync(() => tab!.dispatchEvent(new dom.MouseEvent("click", { bubbles: true, cancelable: true }) as never));
}

test("a selection made in scheme mode is still published after switching to the list, and survives the round trip", async () => {
  const host = mount();
  expect(await waitFor(() => checkIn(host, "/beta") !== null)).toBe(true);
  await settle();
  expect(slice().mode).toBe("scheme");

  clickCheck(host, "/beta");
  await settle();
  expect(slice().selectedPaths).toEqual(["/beta"]);

  /* Switch to the list the way the operator does — the view tab, which PATCHes
     the durable view mode and unmounts the board. */
  clickViewTab(host, "list");
  expect(await waitFor(() => slice().mode === "list")).toBe(true);
  await settle();

  /* THE REGRESSION: this used to be `[]`. The board is gone; the selection is not. */
  expect(host.querySelector("[data-scheme-node]")).toBeNull();
  expect(slice().selectedPaths).toEqual(["/beta"]);
  /* Published in the LIST's own row order, and the list's rows are visible. */
  expect(slice().visiblePaths).toEqual(listOrder);

  /* Back to scheme: same set, no re-selection needed. */
  clickViewTab(host, "scheme");
  expect(await waitFor(() => slice().mode === "scheme")).toBe(true);
  await settle();
  expect(slice().selectedPaths).toEqual(["/beta"]);
  expect(host.querySelector('[data-scheme-node="/beta"]')?.getAttribute("data-lasso-selected")).toBe("true");
});

test("the list publishes a multi-card selection in its own row order", async () => {
  const host = mount();
  expect(await waitFor(() => checkIn(host, "/beta") !== null)).toBe(true);
  await settle();
  clickCheck(host, "/beta");
  clickCheck(host, "/alpha");
  await settle();
  expect([...slice().selectedPaths].sort()).toEqual(["/alpha", "/beta"]);

  clickViewTab(host, "list");
  expect(await waitFor(() => slice().mode === "list")).toBe(true);
  await settle();
  /* Same set, projected onto the list's freshest-first row order. */
  expect(slice().selectedPaths).toEqual(listOrder);
});

test("the phone's focus and map modes publish the selection the desktop board made", async () => {
  const desktop = mount();
  expect(await waitFor(() => checkIn(desktop, "/beta") !== null)).toBe(true);
  await settle();
  clickCheck(desktop, "/beta");
  await settle();
  expect(slice().selectedPaths).toEqual(["/beta"]);

  /* The desktop board goes away — the operator picked up their phone. Unmounting
     it first is what makes this a real hand-off rather than two live publishers. */
  flushSync(() => roots.pop()!.unmount());
  await settle();

  /* Same project, phone width: MobileFocusView takes over the slice. */
  mobile = true;
  const phone = mount();
  expect(await waitFor(() => slice().mode === "mobile-focus" || slice().mode === "mobile-map")).toBe(true);
  await settle();
  expect(slice().mode).toBe("mobile-focus");
  /* This used to be `[]`, so a selection vanished from the snapshot the moment
     the phone view owned the slice. */
  expect(slice().selectedPaths).toEqual(["/beta"]);

  /* The phone's OTHER mode: the map reports the whole board in its own layout
     order — and the same selection. */
  const mapButton = Array.from(phone.querySelectorAll("button")).find(
    (button) => (button.getAttribute("aria-label") ?? "") === "Open the project map",
  ) as HTMLButtonElement | undefined;
  expect(mapButton).toBeTruthy();
  flushSync(() => mapButton!.dispatchEvent(new dom.MouseEvent("click", { bubbles: true, cancelable: true }) as never));
  expect(await waitFor(() => slice().mode === "mobile-map")).toBe(true);
  await settle();
  expect(slice().selectedPaths).toEqual(["/beta"]);
  expect(slice().visiblePaths).toEqual(["/alpha", "/beta"]);
});

/** Re-render the same dashboard root with a different scan. */
function rescan(files: FileEntry[]) {
  const root = roots[roots.length - 1]!;
  flushSync(() =>
    root.render(
      <ProjectDashboard
        files={files}
        flows={[]}
        pipelines={[]}
        workflows={[]}
        tasks={[]}
        project={PROJECT}
        loaded
        openNonce={0}
        archived={false}
        catalogKnown
        catalogConversationCount={files.length}
        onArchive={() => {}}
        onUnarchive={() => {}}
      />,
    ),
  );
}

test("a conversation that disappears from the scan is dropped from the SET, not just from this view's order", async () => {
  const host = mount();
  expect(await waitFor(() => checkIn(host, "/beta") !== null)).toBe(true);
  await settle();
  clickCheck(host, "/beta");
  clickCheck(host, "/alpha");
  await settle();
  expect([...slice().selectedPaths].sort()).toEqual(["/alpha", "/beta"]);

  /* /beta's conversation is gone. Its absence from the published order proves
     nothing on its own — no view can list a card it does not render. */
  rescan([alphaOf()]);
  expect(await waitFor(() => slice().selectedPaths.length === 1)).toBe(true);
  expect(slice().selectedPaths).toEqual(["/alpha"]);

  /* THE REAL ASSERTION: the conversation comes back. If it was only omitted
     rather than pruned, it would resurrect as selected — the exact thing the
     original prune existed to prevent. */
  rescan([alphaOf(), betaOf()]);
  expect(await waitFor(() => host.querySelector('[data-scheme-node="/beta"]') !== null)).toBe(true);
  await settle();
  expect(slice().selectedPaths).toEqual(["/alpha"]);
  expect(host.querySelector('[data-scheme-node="/beta"]')?.getAttribute("data-lasso-selected")).toBeNull();
});

test("a selected conversation the board stops PLACING stays in the set — pruning is not per-view", async () => {
  const host = mount();
  expect(await waitFor(() => checkIn(host, "/beta") !== null)).toBe(true);
  await settle();
  clickCheck(host, "/beta");
  await settle();
  expect(slice().selectedPaths).toEqual(["/beta"]);

  /* Close /beta's window: it leaves the board LAYOUT (a durable tombstone) while
     its conversation stays in the SCAN and in the list. Pruning against a layout
     instead of the scan would delete the membership here — the mode-switch bug
     wearing a different hat. */
  const closeBeta = Array.from(host.querySelectorAll('[data-scheme-node="/beta"] button')).find(
    (button) => (button.getAttribute("aria-label") ?? "").startsWith("Remove column"),
  ) as HTMLButtonElement | undefined;
  expect(closeBeta).toBeTruthy();
  flushSync(() => closeBeta!.dispatchEvent(new dom.MouseEvent("click", { bubbles: true, cancelable: true }) as never));
  expect(await waitFor(() => host.querySelector('[data-scheme-node="/beta"]') === null)).toBe(true);
  await settle();

  /* A scan tick with /beta still present — this is the moment a prune runs. The
     conversation exists, the board just does not place it. */
  rescan([alphaOf(), betaOf()]);
  await settle();
  expect(host.querySelector('[data-scheme-node="/beta"]')).toBeNull();

  /* Observed through the LIST's projection, whose order is the scan's rows — so
     a path the board does not place still shows up when it is still selected. */
  clickViewTab(host, "list");
  expect(await waitFor(() => slice().mode === "list")).toBe(true);
  await settle();
  expect(slice().selectedPaths).toEqual(["/beta"]);
});

test("an empty scan never prunes the selection", async () => {
  const host = mount();
  expect(await waitFor(() => checkIn(host, "/beta") !== null)).toBe(true);
  await settle();
  clickCheck(host, "/beta");
  await settle();
  expect(slice().selectedPaths).toEqual(["/beta"]);

  /* A failed poll reads as zero entries. Treating that as "every conversation
     disappeared" would silently wipe the operator's selection. */
  rescan([]);
  await settle();
  /* No view renders it now, so no view lists it — but it is still in the set, and
     comes back with the conversation. */
  rescan([alphaOf(), betaOf()]);
  expect(await waitFor(() => slice().selectedPaths.length === 1)).toBe(true);
  expect(slice().selectedPaths).toEqual(["/beta"]);
});
