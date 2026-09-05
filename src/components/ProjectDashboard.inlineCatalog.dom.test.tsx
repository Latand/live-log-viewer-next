import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";

import { translate } from "@/lib/i18n";
import { emptyStore } from "@/components/runtime/runtimeModel";
import type { FileEntry } from "@/lib/types";

/* Real Home and catalog hook. Fetch is fully intercepted; deferred responses
   exercise the same cursor and navigation seams used by the browser fixture. */

const actualRuntimeHooks = await import("@/hooks/useRuntime");
const inertRuntime = { enabled: false, connection: "live" as const, resyncedAt: null, store: emptyStore(), structuredHostsEnabled: false, lastEventAt: null };
mock.module("@/hooks/useRuntime", () => ({
  ...actualRuntimeHooks,
  useRuntimeBusState: () => inertRuntime,
  useRuntime: () => inertRuntime,
  useRuntimeSelector: (selector: (state: typeof inertRuntime) => unknown) => selector(inertRuntime),
  useRuntimeSession: () => null,
  useRuntimeReceiptsForArtifact: () => [],
  useRuntimeFlow: () => null,
}));


const { ProjectDashboard } = await import("@/components/ProjectDashboard");
const { MobileSheet } = await import("@/components/mobile/MobileSheet");
const { getMobileNav, topScreen } = await import("@/components/mobile/mobileNav");
const { receipts } = await import("@/components/mobile/MobileReceipt");
const { resetOrchestratorSeatCacheForTests } = await import("@/components/orchestrator/useOrchestratorSeat");
type MobileShellHost = NonNullable<React.ComponentProps<typeof ProjectDashboard>["mobileShell"]>;

const dom = new Window({ url: "http://localhost/", width: 390, height: 844 });
const G = globalThis as Record<string, unknown>;
(dom as unknown as { matchMedia: (query: string) => unknown }).matchMedia = (query: string) => ({
  matches: /max-width|pointer: coarse/.test(String(query)),
  media: String(query), onchange: null,
  addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; },
});

let boardRevision = 1;
let boardPrefs: Record<string, unknown> = {};
let mutations: Array<Record<string, unknown>> = [];
const emptyPrefs = () => ({
  manual: [], hidden: [], expanded: [], favorites: [], foldedEngineChildIds: [],
  expandedEngineTrayParentIds: [], viewMode: null, taskPanelOpen: false, seenAt: {},
});
const boardState = () => ({
  schemaVersion: 1, revision: boardRevision, updatedAt: new Date(0).toISOString(),
  pathAliases: {}, explicitManual: [], prefs: { ...emptyPrefs(), ...boardPrefs },
});
const jsonResponse = (body: unknown) => ({
  ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body),
});

const OVERRIDES: Record<string, unknown> = {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLButtonElement: dom.HTMLButtonElement,
  Event: dom.Event,
  KeyboardEvent: dom.KeyboardEvent,
  MouseEvent: dom.MouseEvent,
  PointerEvent: dom.PointerEvent,
  sessionStorage: dom.sessionStorage,
  localStorage: dom.localStorage,
  requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IntersectionObserver: class {
    callback: () => void;
    constructor(callback: (entries: { isIntersecting: boolean }[]) => void) { this.callback = () => callback([{ isIntersecting: true }]); }
    observe(target: HTMLElement) { if (target.hasAttribute("data-catalog-sentinel")) observers.add(this.callback); }
    unobserve() {}
    disconnect() { observers.delete(this.callback); }
    takeRecords() { return []; }
  },
  fetch: (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("/api/board")) {
      if (init?.method === "PATCH") {
        const body = JSON.parse(String(init.body)) as {
          patch?: Record<string, unknown>;
          mutations?: Array<Record<string, unknown>>;
        };
        for (const mutation of body.mutations ?? []) mutations.push(mutation);
        if (body.patch) boardPrefs = { ...boardPrefs, ...body.patch };
        boardRevision += 1;
      }
      return jsonResponse({ board: boardState() });
    }
    if (url.startsWith("/api/conversations")) { catalogRequests.push(url); return catalogReply(new URL(url, "http://localhost")); }
    /* No orchestrator seat in this project by default: the board's seat slot
       invites one and no row is filtered out of the sections. A test that needs
       the footer seats one first. */
    if (url.startsWith("/api/orchestrator/seat")) {
      seatReads += 1;
      if (seatFailure) return { ok: false, status: 503, json: async () => ({}) };
      return jsonResponse({ seat: seatAnswer, pending: null, exists: true });
    }
    if (url.startsWith("/api/limits")) return { ok: false, status: 503, json: async () => ({}), text: async () => "" };
    return jsonResponse({});
  }) as unknown as typeof fetch,
};
/** The project's seat, as `/api/orchestrator/seat` answers it; null by default. */
let seatAnswer: Record<string, unknown> | null = null;
/** How many times this phone has asked for it. */
let seatReads = 0;

const HAS: Record<string, boolean> = {};
const SAVED: Record<string, unknown> = {};

const settle = async () => { await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0)); };
const waitFor = async (pred: () => boolean, timeoutMs = 4000): Promise<boolean> => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 15));
  }
  return pred();
};

beforeAll(() => {
  for (const key of Object.keys(OVERRIDES)) { HAS[key] = key in G; SAVED[key] = G[key]; G[key] = OVERRIDES[key]; }
  (dom.HTMLElement.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {};
});
afterAll(async () => {
  await settle();
  for (const key of Object.keys(OVERRIDES)) { if (HAS[key]) G[key] = SAVED[key]; else delete G[key]; }
  mock.module("@/hooks/useRuntime", () => actualRuntimeHooks);
});

const PROJECT = "atlas";
const NOW = Math.floor(Date.now() / 1000);

const file = (over: Partial<FileEntry> & { path: string }): FileEntry => ({
  root: "claude-projects", name: over.path.split("/").pop(), project: PROJECT,
  title: "A conversation", engine: "claude", kind: "session", fmt: "claude", parent: null,
  mtime: NOW - 120, size: 2_048, activity: "idle", proc: null, pid: null, model: "opus",
  pendingQuestion: null, waitingInput: null, conversationId: `conversation_${over.path}`,
  ...over,
} as unknown as FileEntry);

const asking = file({
  path: "/repo/ask.jsonl",
  title: "Implement the export endpoint",
  activity: "live", proc: "running", pid: 4_402,
  lastTurn: { startedAt: (NOW - 600) * 1_000, endedAt: null },
  pendingQuestion: {
    kind: "question", toolUseId: "toolu-export", transcriptPath: "/repo/ask.jsonl", pid: 4_402, paneTarget: null,
    askedAt: new Date((NOW - 540) * 1_000).toISOString(),
    questions: [{ question: "Which format?", header: "Format", multiSelect: false, options: [] }],
  },
} as unknown as Partial<FileEntry> & { path: string });

const running = file({
  path: "/repo/run.jsonl",
  title: "Rebuild the board status projection",
  activity: "live", proc: "running", pid: 4_401, mtime: NOW - 30,
  lastTurn: { startedAt: (NOW - 760) * 1_000, endedAt: null },
  plan: { steps: [], done: 2, total: 5, current: "Add the held precedence", updatedAt: null },
} as unknown as Partial<FileEntry> & { path: string });

const finished = file({ path: "/repo/done.jsonl", title: "Tail: pipeline archive TTL", activity: "recent", mtime: NOW - 900 });

let sheetOpens: string[] = [];
let opened: string[] = [];
const host = (attentionCount: number): MobileShellHost => ({
  attentionCount,
  arrival: null,
  renderSheet: (name, close) => {
    sheetOpens.push(name);
    return (
      <MobileSheet name={name} title={name} onClose={close}>
        <div data-testid={`${name}-sheet-stub`} />
      </MobileSheet>
    );
  },
});

const dashboardProps = (over: Partial<React.ComponentProps<typeof ProjectDashboard>> = {}) => ({
  files: [asking, running, finished], flows: [], pipelines: [], workflows: [], tasks: [],
  project: PROJECT, loaded: true, openNonce: 0, archived: false,
  catalogKnown: true, catalogConversationCount: 12,
  projectCwd: "/repo",
  onArchive: () => {}, onUnarchive: () => {},
  onOpenSearch: () => {},
  onOpenCatalogFile: (entry: FileEntry) => { opened.push(entry.path); },
  mobileShell: host(1),
  ...over,
});

let roots: Root[] = [];
beforeEach(() => {
  roots = [];
  catalogRequests.length = 0;
  observers.clear();
  seatFailure = false;
  catalogReply = defaultCatalogReply;
  sheetOpens = [];
  opened = [];
  mutations = [];
  boardRevision = 1;
  boardPrefs = {};
  dom.document.body.replaceChildren();
  dom.document.body.style.overflow = "";
  dom.sessionStorage.clear();
  dom.localStorage.clear();
  dom.location.hash = "#p=" + encodeURIComponent(PROJECT);
  getMobileNav().home();
  receipts.dismiss();
  seatAnswer = null;
  seatReads = 0;
  /* The seat read is cached per project for the whole module (#1149), so a
     test that seats one has to start from an unanswered cache. */
  resetOrchestratorSeatCacheForTests();
});
afterEach(async () => { for (const root of roots) flushSync(() => root.unmount()); roots = []; receipts.dismiss(); await settle(); });

function mount(over: Partial<React.ComponentProps<typeof ProjectDashboard>> = {}): HTMLElement {
  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  flushSync(() => root.render(<ProjectDashboard {...dashboardProps(over)} />));
  roots.push(root);
  return container as unknown as HTMLElement;
}

const q = (root: HTMLElement, selector: string) => root.querySelector(selector) as unknown as HTMLElement | null;
const all = (root: HTMLElement, selector: string) => Array.from(root.querySelectorAll(selector)) as unknown as HTMLElement[];
const click = (el: HTMLElement | null) => { expect(el).not.toBeNull(); flushSync(() => el!.click()); };
const board = (root: HTMLElement) => q(root, "[data-mobile2-board]");

const observers = new Set<() => void>();
let seatFailure = false;
const catalogRequests: string[] = [];
const catalogItems = Array.from({ length: 45 }, (_, i) => file({ path: `/repo/history-${i}.jsonl`, title: `History ${i}` }));

const defaultCatalogReply = (url: URL) => {
  const offset = Number(url.searchParams.get("cursor") ?? 0);
  return jsonResponse({ items: catalogItems.slice(offset, offset + 20), nextCursor: offset + 20 < 45 ? String(offset + 20) : null, total: 4232 });
};
let catalogReply: (url: URL) => unknown = defaultCatalogReply;
const intersect = () => flushSync(() => { for (const callback of [...observers]) callback(); });

test("Home expands the real catalog in place and requests twenty stored entries", async () => {
  catalogRequests.length = 0;
  const root = mount();
  expect(await waitFor(() => board(root) !== null)).toBe(true);
  const hash = dom.location.hash;
  click(q(root, '[data-mobile2-row="catalog"]'));
  expect(await waitFor(() => all(root, '[data-catalog-path]').length === 20)).toBe(true);
  expect(board(root)).not.toBeNull();
  expect(dom.location.hash).toBe(hash);
  expect(catalogRequests).toHaveLength(1);
  expect(new URL(catalogRequests[0]!, "http://localhost").searchParams.get("limit")).toBe("20");
  expect(q(root, '[data-mobile2-row="catalog"]')!.textContent).toContain("4232");
});

test("existing manager with null seat path resolves by durable identity in the footer", async () => {
  seatAnswer = { project: PROJECT, seatEpoch: 1, conversationId: running.conversationId, path: null,
    mandate: "Coordinate", state: "active", designatedAt: "2100-01-02T13:00:00.000Z",
    intent: { clientRequestId: "seat-atlas-null", mode: "existing", launchId: null, error: null } };
  const root = mount();
  expect(await waitFor(() => seatReads > 0 && q(root, '[data-mobile2-board-dock]') !== null)).toBe(true);
  await settle();
  expect(q(root, '[data-mobile2-board-dock]')!.textContent).toContain(translate("en", "mobile2.board.tellOrchestrator"));
  click(q(root, '[data-mobile2-board-dock]'));
  expect(await waitFor(() => topScreen(getMobileNav().getState()).kind === "chat")).toBe(true);
});


test("Home observer appends once across polls, preserves collapse/reopen and the final page", async () => {
  const root = mount();
  expect(await waitFor(() => board(root) !== null)).toBe(true);
  click(q(root, '[data-mobile2-row="catalog"]'));
  expect(await waitFor(() => all(root, '[data-catalog-path]').length === 20)).toBe(true);
  await settle();
  intersect(); intersect();
  expect(await waitFor(() => all(root, '[data-catalog-path]').length === 40)).toBe(true);
  expect(catalogRequests).toHaveLength(2);
  flushSync(() => roots[0]!.render(<ProjectDashboard {...dashboardProps({ files: [asking, { ...running, mtime: NOW + 90 }, finished] })} />));
  await settle(); expect(catalogRequests).toHaveLength(2);
  expect(all(root, '[data-catalog-path]').map((el) => el.dataset.catalogPath)).toEqual(catalogItems.slice(0, 40).map((file) => file.path));
  click(q(root, '[data-mobile2-row="catalog"]'));
  expect(all(root, '[data-catalog-path]')).toHaveLength(0);
  click(q(root, '[data-mobile2-row="catalog"]'));
  expect(all(root, '[data-catalog-path]')).toHaveLength(40);
  expect(catalogRequests).toHaveLength(2);
  await settle(); intersect();
  expect(await waitFor(() => all(root, '[data-catalog-path]').length === 45)).toBe(true);
  intersect(); await settle(); expect(catalogRequests).toHaveLength(3);
});

test("Home keeps each project's expansion and search query; search retains global scope", async () => {
  const root = mount();
  expect(await waitFor(() => board(root) !== null)).toBe(true);
  click(q(root, '[data-mobile2-row="catalog"]'));
  expect(await waitFor(() => all(root, '[data-catalog-path]').length === 20)).toBe(true);
  const search = q(root, 'input[type="search"]') as HTMLInputElement;
  const key = Object.keys(search).find((key) => key.startsWith("__reactProps$"))!;
  flushSync(() => (search as unknown as Record<string, { onChange: (e: unknown) => void }>)[key]!.onChange({ target: { value: "history" } }));
  expect(await waitFor(() => catalogRequests.length === 2)).toBe(true);
  const request = new URL(catalogRequests[1]!, "http://localhost");
  expect(request.searchParams.get("q")).toBe("history"); expect(request.searchParams.has("project")).toBe(false);
  flushSync(() => roots[0]!.render(<ProjectDashboard {...dashboardProps({ project: "beta", files: [file({ path: "/repo/beta.jsonl", project: "beta" })] })} />));
  await settle(); expect(all(root, '[data-catalog-path]')).toHaveLength(0);
  flushSync(() => roots[0]!.render(<ProjectDashboard {...dashboardProps()} />));
  expect(await waitFor(() => all(root, '[data-catalog-path]').length === 20)).toBe(true);
  expect((q(root, 'input[type="search"]') as HTMLInputElement).value).toBe("history");
  expect(catalogRequests).toHaveLength(2);
});

test("failed seat read and an unresolved designation never offer Create", async () => {
  seatFailure = true;
  const root = mount();
  expect(await waitFor(() => seatReads > 0)).toBe(true); await settle();
  const dock = q(root, '[data-mobile2-board-dock]')!;
  expect(dock.textContent).not.toContain(translate("en", "mobile2.seat.createDock"));
  click(dock); expect(getMobileNav().getState().sheet).toBe("seat");
  getMobileNav().closeSheet();
  seatFailure = false;
  seatAnswer = { project: PROJECT, seatEpoch: 1, conversationId: "conversation_unhydrated", path: null,
    mandate: "Coordinate", state: "active", designatedAt: "2100-01-02T13:00:00.000Z",
    intent: { clientRequestId: "seat-unhydrated", mode: "existing", launchId: null, error: null } };
  resetOrchestratorSeatCacheForTests();
  const second = mount();
  expect(await waitFor(() => q(second, '[data-mobile2-board-dock]') !== null)).toBe(true); await settle();
  expect(q(second, '[data-mobile2-board-dock]')!.textContent).not.toContain(translate("en", "mobile2.seat.createDock"));
  click(q(second, '[data-mobile2-board-dock]')); expect(getMobileNav().getState().sheet).toBe("seat");
});

test("a failed vacancy poll disables creation on both Home surfaces until revalidated", async () => {
  const root = mount();
  expect(await waitFor(() => q(root, '[data-mobile2-seat-invitation]') !== null)).toBe(true);
  expect(q(root, '[data-mobile2-board-dock]')!.textContent).toContain(translate("en", "mobile2.seat.createDock"));
  seatFailure = true;
  const reads = seatReads;
  expect(await waitFor(() => seatReads > reads, 8000)).toBe(true);
  await settle();
  expect(q(root, '[data-mobile2-seat-invitation]')).toBeNull();
  expect(q(root, '[data-mobile2-board-dock]')!.textContent).not.toContain(translate("en", "mobile2.seat.createDock"));
  click(q(root, '[data-mobile2-seat-open]'));
  expect(getMobileNav().getState().sheet).toBe("seat");
  flushSync(() => getMobileNav().closeSheet());
  click(q(root, '[data-mobile2-board-dock]'));
  expect(getMobileNav().getState().sheet).toBe("seat");
  flushSync(() => getMobileNav().closeSheet());
  seatFailure = false;
  expect(await waitFor(() => q(root, '[data-mobile2-seat-invitation]') !== null, 8000)).toBe(true);
  expect(q(root, '[data-mobile2-board-dock]')!.textContent).toContain(translate("en", "mobile2.seat.createDock"));
}, 20000);

test("a failed poll preserves the known null-path incumbent on both Home surfaces", async () => {
  seatAnswer = { project: PROJECT, seatEpoch: 1, conversationId: running.conversationId, path: null,
    mandate: "Coordinate", state: "active", designatedAt: "2100-01-02T13:00:00.000Z",
    intent: { clientRequestId: "seat-known-incumbent", mode: "existing", launchId: null, error: null } };
  const root = mount();
  expect(await waitFor(() => q(root, '[data-mobile2-seat-tap="conversation"]') !== null)).toBe(true);
  seatFailure = true;
  const reads = seatReads;
  expect(await waitFor(() => seatReads > reads, 8000)).toBe(true);
  await settle();
  expect(q(root, '[data-mobile2-seat-tap="conversation"]')).not.toBeNull();
  expect(q(root, '[data-mobile2-board-dock]')!.textContent).toContain(translate("en", "mobile2.board.tellOrchestrator"));
  expect(q(root, '[data-mobile2-seat-invitation]')).toBeNull();
}, 12000);

test("Home retains visible rows during deferred append, expired cursor and failed refresh", async () => {
  let respond: ((value: unknown) => void) | undefined;
  catalogReply = (url) => url.searchParams.has("cursor")
    ? new Promise((resolve) => { respond = resolve; }) : defaultCatalogReply(url);
  const root = mount();
  expect(await waitFor(() => board(root) !== null)).toBe(true);
  click(q(root, '[data-mobile2-row="catalog"]'));
  expect(await waitFor(() => all(root, '[data-catalog-path]').length === 20)).toBe(true);
  await settle(); intersect();
  expect(await waitFor(() => respond !== undefined)).toBe(true);
  flushSync(() => roots[0]!.render(<ProjectDashboard {...dashboardProps({ files: [asking, { ...running, title: "Updated title" }, finished] })} />));
  expect(all(root, '[data-catalog-path]')).toHaveLength(20);
  respond!({ ok: false, status: 409, json: async () => ({}) });
  expect(await waitFor(() => root.textContent!.includes(translate("en", "mobile.catalog.expired")))).toBe(true);
  intersect(); await settle(); expect(catalogRequests).toHaveLength(2);
  expect(all(root, '[data-catalog-path]')).toHaveLength(20);
  catalogReply = () => ({ ok: false, status: 503, json: async () => ({}) });
  click(q(root, '[data-mobile-inline-catalog] [role="status"] button'));
  expect(await waitFor(() => catalogRequests.length === 3)).toBe(true); await settle();
  expect(new URL(catalogRequests[2]!, "http://localhost").searchParams.has("cursor")).toBe(false);
  expect(all(root, '[data-catalog-path]')).toHaveLength(20);
  catalogReply = () => jsonResponse({ items: [catalogItems[44]], total: 1, nextCursor: null });
  click(q(root, '[data-mobile-inline-catalog] [role="status"] button'));
  expect(await waitFor(() => all(root, '[data-catalog-path]').length === 1)).toBe(true);
  expect(all(root, '[data-catalog-path]')[0]!.dataset.catalogPath).toBe(catalogItems[44]!.path);
});
