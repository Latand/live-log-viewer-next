import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";

import { emptyStore } from "@/components/runtime/runtimeModel";
import { translate } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";
import type { BoardTask } from "@/lib/tasks/types";

/*
 * The project board on the phone under the shell (mobile v2 lane 1, README §8
 * row 1). happy-dom does no layout, so this guards the structural contract the
 * capture harness measures in Chromium (`bun scripts/capture-mobile-v2.ts`):
 *
 *   - the bar carries the title cell plus at most three 44 px targets, and the
 *     old five-target header row is gone;
 *   - no docked background-task rows on the phone — they are host data in the
 *     host sheet behind ⋯ › Host details;
 *   - ⋯ opens the board menu over the board, whose rows still reach every
 *     former header control: the two board faces, undo, accounts, the host
 *     sheet, archive — and archive answers with a receipt carrying Restore.
 */

const actualRuntimeHooks = await import("@/hooks/useRuntime");
const actualConversationCatalogHooks = await import("@/hooks/useConversationCatalog");
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
mock.module("@/hooks/useConversationCatalog", () => ({
  useConversationCatalog: () => ({
    items: [], nextCursor: null, total: 0, loading: false, error: false, loadMore: () => {}, retry: () => {},
  }),
}));

const { ProjectDashboard } = await import("@/components/ProjectDashboard");
const { MobileSheet } = await import("@/components/mobile/MobileSheet");
const { getMobileNav } = await import("@/components/mobile/mobileNav");
const { receipts } = await import("@/components/mobile/MobileReceipt");
type MobileShellHost = NonNullable<React.ComponentProps<typeof ProjectDashboard>["mobileShell"]>;

const dom = new Window({ url: "http://localhost/", width: 390, height: 844 });
const G = globalThis as Record<string, unknown>;
(dom as unknown as { matchMedia: (query: string) => unknown }).matchMedia = (query: string) => ({
  matches: /max-width|pointer: coarse/.test(String(query)),
  media: String(query), onchange: null,
  addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; },
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
  IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } },
  /* A tiny in-memory board API: the view switch writes through /api/board, and
     the store needs a real `{ board }` envelope back to fold the write in. */
  fetch: (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("/api/board")) {
      if (init?.method === "PATCH") {
        const body = JSON.parse(String(init.body)) as {
          patch?: Record<string, unknown>;
          mutations?: Array<{ kind: string; viewMode?: "scheme" | "list" | null }>;
        };
        for (const mutation of body.mutations ?? []) {
          if (mutation.kind === "set-presentation" && mutation.viewMode !== undefined) boardPrefs.viewMode = mutation.viewMode;
        }
        if (body.patch) boardPrefs = { ...boardPrefs, ...body.patch };
        boardRevision += 1;
      }
      return jsonResponse({ board: boardState() });
    }
    if (url.startsWith("/api/conversations")) return jsonResponse({ items: [], nextCursor: null });
    /* The accounts screen's limits blocks read this; an unavailable answer
       leaves them in their loading state, which is all this file needs. */
    if (url.startsWith("/api/limits")) return { ok: false, status: 503, json: async () => ({}), text: async () => "" };
    return jsonResponse({});
  }) as unknown as typeof fetch,
};

let boardRevision = 1;
let boardPrefs: Record<string, unknown> = {};
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
  mock.module("@/hooks/useConversationCatalog", () => actualConversationCatalogHooks);
});

const PROJECT = "live-log-viewer-next-mobile";

const conversation = {
  path: "/repo/worktrees/mobile-shell/0f1e2d3c.jsonl",
  root: "claude-projects", name: "0f1e2d3c.jsonl", project: PROJECT,
  title: "Builder · keep the conversation header inside a 390px viewport (#613)",
  engine: "claude", kind: "session", fmt: "claude", parent: null, mtime: 9_000, size: 4_096,
  activity: "live", proc: null, pid: null, model: "claude-opus-4-8", effort: "high", ctx: 62,
  renamable: true, conversationId: "conversation_613mobile", pendingQuestion: null, waitingInput: null,
} as unknown as FileEntry;

/* The same conversation after its turn: recent, so the board keeps its card,
   and not live, so the project may be archived (the desktop button's rule). */
const settled = { ...conversation, activity: "recent", proc: null, mtime: Math.floor(Date.now() / 1000) } as unknown as FileEntry;

/* A parentless background process: on the desktop it docks as a strip under
   the header; on the phone it is host detail. */
const backgroundTask = {
  path: "/repo/worktrees/mobile-shell/next-dev.log",
  root: "claude-projects", name: "next-dev.log", project: PROJECT,
  title: "next dev · port 8899", cmdDesc: "next dev · port 8899",
  engine: "shell", kind: "task", fmt: "text", parent: null, mtime: 9_100, size: 512,
  activity: "live", proc: "running", pid: 41822, model: null, pendingQuestion: null, waitingInput: null,
} as unknown as FileEntry;

const task = {
  id: "t-613", project: PROJECT, status: "inbox", text: "Keep the header inside 390px",
  placement: "pinned", pos: { x: 720, y: 140 }, assignments: [],
  createdAt: "2026-07-25T00:00:00.000Z", updatedAt: "2026-07-25T00:00:00.000Z",
} as unknown as BoardTask;

let searchOpens = 0;
let archived: string[] = [];
let unarchived: string[] = [];
let sheetOpens: string[] = [];
const host: MobileShellHost = {
  attentionCount: 3,
  arrival: null,
  renderSheet: (name, close) => {
    sheetOpens.push(name);
    return (
      <MobileSheet name={name} title={name} onClose={close}>
        <div data-testid={`${name}-sheet-stub`} />
      </MobileSheet>
    );
  },
};

const dashboardProps = (over: Partial<React.ComponentProps<typeof ProjectDashboard>> = {}) => ({
  files: [conversation], flows: [], pipelines: [], workflows: [], tasks: [task],
  project: PROJECT, loaded: true, openNonce: 0, archived: false,
  catalogKnown: true, catalogConversationCount: 1,
  projectCwd: "/repo", onArchive: (project: string) => { archived.push(project); }, onUnarchive: (project: string) => { unarchived.push(project); },
  onOpenSearch: () => { searchOpens += 1; },
  mobileShell: host,
  ...over,
});

let roots: Root[] = [];
beforeEach(() => {
  roots = [];
  searchOpens = 0;
  archived = [];
  unarchived = [];
  sheetOpens = [];
  boardRevision = 1;
  boardPrefs = {};
  dom.document.body.replaceChildren();
  dom.document.body.style.overflow = "";
  dom.sessionStorage.clear();
  dom.localStorage.clear();
  dom.location.hash = "#p=" + encodeURIComponent(PROJECT);
  getMobileNav().home();
  receipts.dismiss();
  /* A closed card in the device-local log → the menu offers undo (#184). */
  dom.localStorage.setItem(
    `llvBoardHistory:${PROJECT}`,
    JSON.stringify({ entries: [{ kind: "close", path: "/repo/closed.jsonl", title: "Closed card" }], cursor: 1 }),
  );
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
const label = (el: Element) => el.getAttribute("aria-label") ?? el.textContent?.trim() ?? "";
const click = (el: HTMLElement | null) => { expect(el).not.toBeNull(); flushSync(() => el!.click()); };
/* The leaf under the bar arrives with `boardReady`: the focus view on the
   scheme face, the pinned orchestrator slot on the list and empty leaves. */
const boardReady = (root: HTMLElement) => q(root, '[data-testid="mobile-chat-shell"]') !== null || q(root, '[data-testid="mobile-orchestrator-slot"]') !== null;
const chatShell = (root: HTMLElement) => q(root, '[data-testid="mobile-chat-shell"]') !== null;
const openMenu = async (root: HTMLElement) => { click(q(root, '[data-mobile2-open="menu"]')); await settle(); expect(q(root, '[data-mobile2-sheet="menu"]')).not.toBeNull(); };

test("the phone board mounts the shell: one bar, the title cell as the switcher, three 44 px targets, and no five-target header", async () => {
  const root = mount();
  expect(await waitFor(() => boardReady(root))).toBe(true);
  expect(q(root, '[data-testid="mobile-project-header"]')).toBeNull();
  expect(q(root, '[data-mobile2-screen="board"]')).not.toBeNull();
  const bar = q(root, "[data-mobile2-bar]")!;
  const title = q(root, "[data-mobile2-title]")!;
  expect(title.textContent).toContain(PROJECT);
  expect(title.getAttribute("data-mobile2-open")).toBe("projects");
  expect(title.className).toContain("flex-1");
  expect(title.className).toContain("min-w-0");
  const targets = Array.from(bar.querySelectorAll("button")).filter((el) => el !== (title as unknown as Element));
  expect(targets.map(label)).toEqual([
    translate("en", "mobile2.bar.attention", { count: 3 }),
    translate("en", "mobile2.bar.search"),
    translate("en", "mobile2.bar.more"),
  ]);
  for (const target of targets) expect(`${target.className} `).toMatch(/(^|\s)h-11(\s|$)/);
  /* The search target is wired to the shell's palette, not decoration. */
  const search = q(root, '[data-testid="dash-search"]')!;
  expect(search.className).toContain("w-11");
  click(search);
  expect(searchOpens).toBe(1);
  /* The old header's controls are gone from the row: no hamburger, no shelf
     trigger, no create menu, no scheme/list pair. */
  const labels = targets.map(label);
  for (const key of ["dash.openProjects", "dash.hiddenShelf", "dash.createMenu", "dash.viewScheme", "dash.viewList"] as const) {
    expect(labels).not.toContain(translate("en", key));
  }
});

test("the title cell opens the project switcher the Viewer renders, over the board; × closes back onto it", async () => {
  const root = mount();
  expect(await waitFor(() => boardReady(root))).toBe(true);
  click(q(root, "[data-mobile2-title]"));
  expect(sheetOpens).toEqual(["projects"]);
  expect(q(root, '[data-mobile2-sheet="projects"]')).not.toBeNull();
  expect(boardReady(root)).toBe(true);
  click(q(root, "[data-mobile2-close]"));
  expect(q(root, "[data-mobile2-sheet]")).toBeNull();
  expect(boardReady(root)).toBe(true);
});

test("no docked task rows on the phone: a background process is host data in the host sheet behind ⋯ › Host details", async () => {
  const root = mount({ files: [conversation, backgroundTask] });
  expect(await waitFor(() => boardReady(root))).toBe(true);
  const strip = (scope: HTMLElement | null) => Array.from(scope?.querySelectorAll("button") ?? []).find((el) => label(el).includes("background task")) ?? null;
  expect(strip(q(root, '[data-mobile2-screen="board"]'))).toBeNull();
  await openMenu(root);
  const hostRow = q(root, '[data-mobile2-open="host"]')!;
  expect(hostRow.textContent).toContain(translate("en", "mobile2.menu.host"));
  expect(hostRow.textContent).toContain(translate("en", "mobile2.menu.hostTasks", { count: 1 }));
  click(hostRow);
  const shelf = q(root, '[data-testid="mobile-bottom-shelf"]')!;
  expect(shelf).not.toBeNull();
  expect(q(root, '[data-mobile2-sheet="menu"]')).toBeNull();
  const docked = q(root, "[data-mobile2-host-tasks]")!;
  expect(docked).not.toBeNull();
  expect(shelf.contains(docked as never)).toBe(true);
  expect(strip(docked)).not.toBeNull();
  expect(strip(docked)!.textContent).toContain("next dev · port 8899");
});

test("⋯ opens the board menu over the board with every former header control as a row, in the design's order", async () => {
  const root = mount({ files: [settled] });
  expect(await waitFor(() => boardReady(root))).toBe(true);
  await openMenu(root);
  expect(boardReady(root)).toBe(true);
  const rows = Array.from(root.querySelectorAll("[data-mobile2-menu-row]")).map((el) => el.getAttribute("data-mobile2-menu-row"));
  expect(rows).toEqual(["new-agent", "new-task", "new-pipeline", "tasks", "view-board", "view-catalog", "accounts", "host", "undo", "archive"]);
  for (const row of root.querySelectorAll("[data-mobile2-menu-row]")) expect((row as unknown as HTMLElement).className).toContain("min-h-11");
  expect(q(root, '[data-mobile2-go="accounts"]')).not.toBeNull();
  expect(q(root, '[data-mobile2-open="host"]')).not.toBeNull();
  /* The device-local settings ride as rows too. */
  expect(q(root, '[data-mobile2-sheet="menu"]')!.textContent).toContain(translate("en", "mobile2.menu.sound"));
  /* Delete project is cut on the phone (README §6): nothing in the menu is
     in danger colour. */
  expect(q(root, '[data-mobile2-sheet="menu"]')!.querySelector(".text-danger")).toBeNull();
});

test("both board faces stay one tap away inside the menu, announced as radio rows, and still switch the board", async () => {
  const root = mount();
  expect(await waitFor(() => chatShell(root))).toBe(true);
  await openMenu(root);
  const options = Array.from(root.querySelectorAll('[role="menuitemradio"]'));
  const rowLabel = (el: Element) => el.querySelector(".truncate")?.textContent ?? "";
  expect(options.map(rowLabel)).toEqual([translate("en", "mobile2.menu.board"), translate("en", "mobile2.menu.catalog")]);
  expect(options[0]!.getAttribute("aria-checked")).toBe("true");
  expect(options[1]!.getAttribute("aria-checked")).toBe("false");
  click(options[1] as unknown as HTMLElement);
  await settle();
  expect(q(root, '[data-mobile2-sheet="menu"]')).toBeNull();
  expect(await waitFor(() => !chatShell(root))).toBe(true);
  await openMenu(root);
  const reopened = Array.from(root.querySelectorAll('[role="menuitemradio"]'));
  expect(reopened[1]!.getAttribute("aria-checked")).toBe("true");
});

test("board undo folded into the menu is still one tap and still undoes (#1054)", async () => {
  const root = mount();
  expect(await waitFor(() => boardReady(root))).toBe(true);
  await openMenu(root);
  click(q(root, '[data-mobile2-menu-row="undo"]'));
  await settle();
  expect(q(root, '[data-mobile2-sheet="menu"]')).toBeNull();
  await openMenu(root);
  expect(q(root, '[data-mobile2-menu-row="undo"]')).toBeNull();
  expect(q(root, '[data-mobile2-menu-row="redo"]')).not.toBeNull();
});

test("Accounts & limits pushes the shell's accounts screen; ‹ returns to the board", async () => {
  const root = mount();
  expect(await waitFor(() => boardReady(root))).toBe(true);
  await openMenu(root);
  click(q(root, '[data-mobile2-go="accounts"]'));
  await settle();
  expect(q(root, '[data-mobile2-screen="accounts"]')).not.toBeNull();
  expect(q(root, '[data-mobile2-screen="board"]')).toBeNull();
  expect(q(root, "[data-mobile2-sheet]")).toBeNull();
  expect(q(root, "[data-mobile2-accounts]")).not.toBeNull();
  const bar = q(root, "[data-mobile2-bar]")!;
  expect(q(bar, "[data-mobile2-back]")).not.toBeNull();
  expect(q(bar, '[data-mobile2-open="menu"]')).not.toBeNull();
  expect(q(bar, '[data-testid="dash-search"]')).toBeNull();
  click(q(root, "[data-mobile2-back]"));
  await settle();
  expect(await waitFor(() => q(root, '[data-mobile2-screen="board"]') !== null)).toBe(true);
  expect(q(root, '[data-mobile2-screen="accounts"]')).toBeNull();
});

test("Archive project acts on the tap and answers with a receipt whose Restore unarchives", async () => {
  const root = mount({ files: [settled] });
  expect(await waitFor(() => boardReady(root))).toBe(true);
  await openMenu(root);
  click(q(root, '[data-mobile2-menu-row="archive"]'));
  expect(archived).toEqual([PROJECT]);
  expect(q(root, '[data-mobile2-sheet="menu"]')).toBeNull();
  const receipt = q(root, '[data-mobile2-receipt-placement="flow"]')!;
  expect(receipt).not.toBeNull();
  expect(receipt.textContent).toContain(translate("en", "mobile2.menu.archived"));
  click(q(root, '[data-mobile2-receipt-undo="restore"]'));
  expect(unarchived).toEqual([PROJECT]);
  expect(q(root, "[data-mobile2-receipt]")).toBeNull();
});

test("an archived project offers Unarchive instead, and a project with a live agent offers neither", async () => {
  const shelved = mount({ archived: true });
  expect(await waitFor(() => boardReady(shelved))).toBe(true);
  await openMenu(shelved);
  expect(q(shelved, '[data-mobile2-menu-row="unarchive"]')).not.toBeNull();
  expect(q(shelved, '[data-mobile2-menu-row="archive"]')).toBeNull();
  click(q(shelved, '[data-mobile2-menu-row="unarchive"]'));
  expect(unarchived).toEqual([PROJECT]);
  for (const root of roots) flushSync(() => root.unmount());
  roots = [];
  dom.document.body.replaceChildren();
  const live = mount({ files: [{ ...conversation, proc: "running" } as FileEntry] });
  expect(await waitFor(() => boardReady(live))).toBe(true);
  await openMenu(live);
  expect(q(live, '[data-mobile2-menu-row="archive"]')).toBeNull();
  expect(q(live, '[data-mobile2-menu-row="unarchive"]')).toBeNull();
});
