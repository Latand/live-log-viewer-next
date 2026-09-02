import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import type { ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";

import { emptyStore } from "@/components/runtime/runtimeModel";
import { translate } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";

/*
 * The pin in the phone's OTHER two leaves (PRD #976 decision 5, issue #979).
 *
 * `ProjectDashboard` chooses between three mobile leaves — the focus view, the
 * catalog list behind the Схема/Список toggle, and the empty project — and the
 * operator's requirement is one row that is always first in the project's
 * conversation list, not one row in whichever leaf happens to be showing. The
 * focus view's own strip is covered by `mobileOrchestratorRow.dom.test.tsx`;
 * these cases mount the REAL dashboard at 390×844 and drive it into the other
 * two, because that is where the row went missing.
 *
 * What each case proves is structural, and happy-dom does no layout: the row is
 * a SIBLING of the leaf rather than one of its rows, so nothing the leaf does
 * with its own data — order it, search it, empty it — can reach the pin.
 */

const actualRuntimeHooks = await import("@/hooks/useRuntime");
const actualConversationCatalogHooks = await import("@/hooks/useConversationCatalog");
const inertRuntime = { enabled: false, connection: "offline" as const, resyncedAt: null, store: emptyStore() };
mock.module("@/hooks/useRuntime", () => ({
  ...actualRuntimeHooks,
  useRuntimeBusState: () => ({ ...inertRuntime, lastEventAt: null }),
  useRuntime: () => inertRuntime,
  useRuntimeEnabled: () => false,
  useRuntimeSession: () => null,
  useRuntimeSessionByArtifact: () => null,
  useRuntimeReceiptsForArtifact: () => [],
  useRuntimeFlow: () => null,
}));
/* The catalog answers the list leaf. `query` drives it, so a search that
   narrows the list to nothing is a real narrowing, not a fixed empty answer. */
let catalogRows: FileEntry[] = [];
mock.module("@/hooks/useConversationCatalog", () => ({
  useConversationCatalog: ({ query }: { query?: string }) => {
    const needle = (query ?? "").trim().toLowerCase();
    const items = needle ? catalogRows.filter((file) => file.title.toLowerCase().includes(needle)) : catalogRows;
    return { items, nextCursor: null, total: items.length, loading: false, error: false, loadMore: () => {}, retry: () => {} };
  },
}));

const { ProjectDashboard } = await import("@/components/ProjectDashboard");

const dom = new Window({ url: "http://localhost/", width: 390, height: 844 });
const G = globalThis as Record<string, unknown>;
(dom as unknown as { matchMedia: (query: string) => unknown }).matchMedia = (query: string) => ({
  matches: /max-width|pointer: coarse/.test(String(query)),
  media: String(query), onchange: null,
  addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; },
});

let boardRevision = 1;
let boardPrefs: Record<string, unknown> = {};
let seatAnswer: unknown = { seat: null, pending: null, exists: true, viewerMcpRegistered: false };
const seatPosts: Record<string, unknown>[] = [];
const emptyPrefs = () => ({
  manual: [], hidden: [], expanded: [], favorites: [], foldedEngineChildIds: [],
  expandedEngineTrayParentIds: [], viewMode: null, taskPanelOpen: false,
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
  PointerEvent: dom.MouseEvent,
  sessionStorage: dom.sessionStorage,
  localStorage: dom.localStorage,
  requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } },
  fetch: (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("/api/board")) {
      if (init?.method === "PATCH") {
        const body = JSON.parse(String(init.body)) as { patch?: Record<string, unknown> };
        if (body.patch) boardPrefs = { ...boardPrefs, ...body.patch };
        boardRevision += 1;
      }
      return jsonResponse({ board: boardState() });
    }
    if (url.startsWith("/api/orchestrator/seat")) {
      if ((init?.method ?? "GET") === "POST") {
        seatPosts.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
        return jsonResponse({ ok: true, state: "starting" });
      }
      return jsonResponse(seatAnswer);
    }
    if (url.startsWith("/api/accounts")) return jsonResponse({ claude: { active: "", accounts: [] }, codex: { active: "", accounts: [] } });
    return jsonResponse({});
  }) as unknown as typeof fetch,
};
const HAS: Record<string, boolean> = {};
const SAVED: Record<string, unknown> = {};

const settle = async () => { for (let round = 0; round < 4; round += 1) await new Promise((r) => setTimeout(r, 0)); };
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
  mock.module("@/hooks/useConversationCatalog", () => actualConversationCatalogHooks);
});

const PROJECT = "atlas";

const conversation = (over: Partial<FileEntry>): FileEntry => ({
  path: "/repo/atlas/quiet.jsonl", root: "claude-projects", name: "quiet.jsonl", project: PROJECT,
  title: "Some earlier work", engine: "claude", kind: "session", fmt: "claude", parent: null,
  mtime: 9_000, size: 4_096, activity: "idle", proc: null, pid: null, model: "claude-opus-4-8",
  conversationId: "conversation_quiet", cwd: "/repo/atlas", projectRoot: "/repo/atlas",
  pendingQuestion: null, waitingInput: null,
  ...over,
} as unknown as FileEntry);

type DashboardProps = ComponentProps<typeof ProjectDashboard>;
const dashboardProps = (over: Partial<DashboardProps> = {}): DashboardProps => ({
  files: [], flows: [], pipelines: [], workflows: [], tasks: [],
  project: PROJECT, loaded: true, openNonce: 0, archived: false,
  catalogKnown: false, catalogConversationCount: 0,
  projectCwd: "/repo/atlas", onArchive: () => {}, onUnarchive: () => {},
  ...over,
});

let roots: Root[] = [];
beforeEach(() => {
  roots = [];
  boardRevision += 1;
  boardPrefs = {};
  catalogRows = [];
  seatAnswer = { seat: null, pending: null, exists: true, viewerMcpRegistered: false };
  seatPosts.length = 0;
  dom.document.body.replaceChildren();
  dom.sessionStorage.clear();
  dom.localStorage.clear();
});
afterEach(async () => { for (const root of roots) flushSync(() => root.unmount()); roots = []; await settle(); });

function mount(props: Partial<DashboardProps> = {}): HTMLElement {
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as Element);
  flushSync(() => root.render(<ProjectDashboard {...dashboardProps(props)} />));
  roots.push(root);
  return host as unknown as HTMLElement;
}

const rows = (host: HTMLElement) => [...host.querySelectorAll("[data-orchestrator-row]")];
const row = (host: HTMLElement) => rows(host)[0] as unknown as HTMLElement;
const slot = (host: HTMLElement) => host.querySelector('[data-testid="mobile-orchestrator-slot"]') as unknown as HTMLElement;
const listLeaf = (host: HTMLElement) => (host.querySelector("input[type=search]")?.closest(".overflow-y-auto") ?? null) as unknown as HTMLElement | null;
const openButton = (host: HTMLElement) => host.querySelector("[data-orchestrator-row-open]") as unknown as HTMLButtonElement;

/** The pin, wherever it is mounted: exactly one, before the leaf in document
    order, and outside whatever that leaf scrolls. */
function expectPinnedBefore(host: HTMLElement, leaf: HTMLElement): void {
  expect(rows(host)).toHaveLength(1);
  const pinned = row(host);
  expect(pinned.compareDocumentPosition(leaf) & dom.Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(leaf.contains(pinned as unknown as never)).toBe(false);
  expect(pinned.closest(".overflow-y-auto")).toBeNull();
  expect(pinned.closest(".overflow-x-auto")).toBeNull();
  expect(openButton(host).className).toContain("h-11");
}

test("the catalog list leaf carries the pin first, outside the scroller, and never as one of its rows", async () => {
  catalogRows = [
    conversation({ path: "/repo/atlas/a.jsonl", conversationId: "conversation_a", title: "Alpha lane" }),
    conversation({ path: "/repo/atlas/b.jsonl", conversationId: "conversation_b", title: "Beta lane" }),
  ];
  boardPrefs = { viewMode: "list" };
  const host = mount({ files: catalogRows, catalogKnown: true, catalogConversationCount: 2 });
  expect(await waitFor(() => listLeaf(host) !== null)).toBe(true);

  const leaf = listLeaf(host)!;
  expectPinnedBefore(host, leaf);
  /* It is the dashboard's own slot, above the list — not an item the catalog
     could sort, page or drop. */
  expect(slot(host)).not.toBeNull();
  /* Once the seat read answers, this leaf's row is the create affordance — the
     same one the focus view shows, from the same projection. */
  expect(await waitFor(() => row(host)?.getAttribute("data-orchestrator-row-state") === "draft")).toBe(true);
  expect(openButton(host).textContent).toContain(translate("en", "orchMobile.create"));
  expect(leaf.querySelectorAll("[data-orchestrator-row]")).toHaveLength(0);
});

test("searching the list cannot filter the pin away", async () => {
  catalogRows = [
    conversation({ path: "/repo/atlas/a.jsonl", conversationId: "conversation_a", title: "Alpha lane" }),
    conversation({ path: "/repo/atlas/b.jsonl", conversationId: "conversation_b", title: "Beta lane" }),
  ];
  boardPrefs = { viewMode: "list" };
  const host = mount({ files: catalogRows, catalogKnown: true, catalogConversationCount: 2 });
  expect(await waitFor(() => listLeaf(host) !== null)).toBe(true);

  const search = host.querySelector("input[type=search]") as unknown as HTMLInputElement;
  const props = Object.keys(search).find((name) => name.startsWith("__reactProps$"))!;
  const handlers = (search as unknown as Record<string, { onChange(event: unknown): void }>)[props]!;
  /* A query that matches nothing at all: the list empties, the pin does not. */
  search.value = "zzzz-no-such-conversation";
  flushSync(() => handlers.onChange({ target: search }));
  await settle();

  const leaf = listLeaf(host)!;
  expect(leaf.textContent).toContain(translate("en", "common.nothingFound"));
  expectPinnedBefore(host, leaf);
});

test("a project with nothing in it still offers the create row — the leaf where an orchestrator is most wanted", async () => {
  const host = mount();
  expect(await waitFor(() => row(host)?.getAttribute("data-orchestrator-row-state") === "draft")).toBe(true);

  const empty = [...host.querySelectorAll("div")].find((node) => node.textContent === translate("en", "dash.emptyTitle"))!;
  expectPinnedBefore(host, empty as unknown as HTMLElement);
  expect(row(host).getAttribute("data-orchestrator-row-state")).toBe("draft");
  expect(openButton(host).textContent).toContain(translate("en", "orchMobile.create"));

  /* And it is the same create path, not a second one: the sheet the row opens
     posts the draft to the seat route. */
  flushSync(() => openButton(host).click());
  await settle();
  const sheet = host.querySelector('[data-testid="mobile-orchestrator-sheet"]') as unknown as HTMLElement;
  expect(sheet).not.toBeNull();
  expect(sheet.querySelector("[data-viewer-mcp-status]")?.textContent).toContain("scripts/install-mcp.sh");
  expect(sheet.querySelector("[data-viewer-mcp-status]")?.textContent).toContain("claude mcp add viewer");
  expect((sheet.querySelector("[data-orchestrator-mandate]") as unknown as HTMLTextAreaElement).value.length).toBeGreaterThan(0);
  flushSync(() => (sheet.querySelector("[data-orchestrator-confirm]") as unknown as HTMLButtonElement).click());
  expect(await waitFor(() => seatPosts.length === 1)).toBe(true);
  expect(seatPosts[0]!.project).toBe(PROJECT);
  expect(String(seatPosts[0]!.clientRequestId)).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
});

test("the board leaf carries the single pin above its sections, and opening a conversation hands it to the focus view's strip", async () => {
  const files = [conversation({ activity: "live", proc: "running", pid: 42 })];
  const host = mount({ files, catalogKnown: true, catalogConversationCount: 1 });
  /* The phone's first leaf is the board (mobile v2 lane 2): the pin is its
     Orchestrator card, above every section row and outside what the list
     scrolls. */
  expect(await waitFor(() => host.querySelector("[data-mobile2-board]") !== null)).toBe(true);
  const board = host.querySelector("[data-mobile2-board]") as unknown as HTMLElement;
  expect(rows(host)).toHaveLength(1);
  expect(slot(host)).not.toBeNull();
  const firstRow = board.querySelector('[data-mobile2-row="conversation"]') as unknown as HTMLElement;
  expect(firstRow).not.toBeNull();
  expect(row(host).compareDocumentPosition(firstRow) & dom.Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

  /* Opening a row pushes the conversation, and the pin travels with it into
     the focus view's own strip: one row exists at a time, never two. */
  flushSync(() => firstRow.click());
  expect(await waitFor(() => host.querySelector('[data-testid="mobile-chat-shell"]') !== null)).toBe(true);
  expect(rows(host)).toHaveLength(1);
  expect(slot(host)).toBeNull();
  expect(row(host).closest('[data-testid="mobile-chat-shell"]')).not.toBeNull();
});
