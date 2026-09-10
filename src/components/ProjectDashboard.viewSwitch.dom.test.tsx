/**
 * The desktop board/list switch is reachable (#1614).
 *
 * The switch used to be floated by the dashboard at `absolute left-3 top-3
 * z-30` while `SchemeBoard` floats its tool palette at the same corner at
 * `z-40`. Both rendered; only one could be clicked. In a real browser
 * `document.elementFromPoint` at the centre of «Список» resolved to the task
 * tool, so the operator had no way into the agent list at all.
 *
 * happy-dom lays nothing out and cannot hit-test, so this file asserts the
 * structural fact that makes the overlap impossible instead of the hit itself:
 * on the board, exactly one element claims that corner, and the switch is
 * inside it. The hit test itself is taken in a real browser against a
 * production build by `scripts/capture-issue-1614-board.ts`.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";

import { emptyStore } from "@/components/runtime/runtimeModel";
import { applyBoardMutations, type BoardMutationV1 } from "@/lib/board/mutations";
import type { FileEntry } from "@/lib/types";
import type { BoardProjectStateV1 } from "@/lib/view/types";
import { MOBILE_LAYOUT_QUERY } from "@/lib/attention/eligibility";

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
  matches: mobile && String(query) === MOBILE_LAYOUT_QUERY,
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
let tmuxCalls: Array<Record<string, unknown>> = [];
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
    if (url === "/api/tmux") {
      tmuxCalls.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => "" };
    }
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
  tmuxCalls = [];
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

function mount(files: FileEntry[] = [alphaOf(), betaOf()], manual?: string[], expanded: string[] = []): HTMLElement {
  if (manual || expanded.length) {
    const seed = seededBoard();
    const nextManual = manual ?? seed.prefs.manual;
    boards = {
      [PROJECT]: {
        ...seed,
        explicitManual: nextManual,
        prefs: { ...seed.prefs, manual: nextManual, expanded },
      },
    };
  }
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
/** The view toggle an operator actually clicks. */
function clickViewTab(host: HTMLElement, view: "scheme" | "list") {
  const label = view === "scheme" ? "scheme" : "conversations";
  const tab = Array.from(host.querySelectorAll("button[aria-pressed]")).find(
    (button) => (button.getAttribute("aria-label") ?? "") === label,
  ) as HTMLButtonElement | undefined;
  expect(tab).toBeTruthy();
  flushSync(() => tab!.dispatchEvent(new dom.MouseEvent("click", { bubbles: true, cancelable: true }) as never));
}


const TOP_LEFT_CORNER = "[class*='absolute'][class*='left-3'][class*='top-3']";
const tabsIn = (host: HTMLElement) => host.querySelector("[data-project-view-tabs]") as HTMLElement | null;
const viewButtons = (host: HTMLElement) => Array.from(host.querySelectorAll("button[aria-pressed]"))
  .filter((button) => ["scheme", "conversations"].includes(button.getAttribute("aria-label") ?? ""));

test("on the board the view switch shares the tool palette, so nothing floats over it", async () => {
  const host = mount();
  expect(await waitFor(() => host.querySelector("[data-scheme-band]") !== null)).toBe(true);
  await settle();
  expect(slice().mode).toBe("scheme");

  /* Both tabs are rendered, and neither is disabled. */
  expect(viewButtons(host).map((button) => button.getAttribute("aria-label"))).toEqual(["scheme", "conversations"]);
  expect(viewButtons(host).some((button) => (button as HTMLButtonElement).disabled)).toBe(false);

  /* THE REGRESSION: two separately positioned elements in the same corner. The
     board's palette is the only one, and it holds the switch. */
  const corners = Array.from(host.querySelectorAll(TOP_LEFT_CORNER));
  expect(corners).toHaveLength(1);
  const palette = corners[0] as HTMLElement;
  expect(palette.hasAttribute("data-scheme-ui")).toBe(true);
  expect(palette.contains(tabsIn(host))).toBe(true);
  /* Same palette as the zoom controls — one row, not two stacked layers. */
  expect(palette.querySelector("button[title^='Zoom']")).toBeTruthy();
  /* And the switch itself no longer positions anything of its own. */
  expect(tabsIn(host)!.className).not.toContain("absolute");
});

test("the switch still opens the agent list, and stays reachable once the board is gone", async () => {
  const host = mount();
  expect(await waitFor(() => host.querySelector("[data-scheme-band]") !== null)).toBe(true);
  await settle();

  clickViewTab(host, "list");
  expect(await waitFor(() => slice().mode === "list")).toBe(true);
  await settle();

  /* The board unmounted with its palette, so on the list the switch floats on
     its own again — and it is the only thing in that corner there too. */
  expect(host.querySelector("[data-scheme-band]")).toBeNull();
  expect(Array.from(host.querySelectorAll(TOP_LEFT_CORNER))).toHaveLength(1);
  expect(tabsIn(host)!.className).toContain("absolute");
  expect(viewButtons(host)).toHaveLength(2);

  /* And back: the round trip is the operator's, through the switch itself. */
  clickViewTab(host, "scheme");
  expect(await waitFor(() => slice().mode === "scheme")).toBe(true);
  await settle();
  expect(await waitFor(() => host.querySelector("[data-scheme-band]") !== null)).toBe(true);
  const corners = Array.from(host.querySelectorAll(TOP_LEFT_CORNER));
  expect(corners).toHaveLength(1);
  expect((corners[0] as HTMLElement).contains(tabsIn(host))).toBe(true);
});
