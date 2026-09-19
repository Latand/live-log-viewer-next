/**
 * The project board's one header bar (#1801, docs/design/board-header.md).
 *
 * Before it, a project showed two stacked bars that told the same facts twice
 * («N branches running» over «N agents working», «N need you» beside the
 * island, «N tasks on the board» beside «Tasks N»), carried two search
 * affordances, and a view switch whose pressed segment the board's button
 * reset painted exactly like the other. These cases hold the bar to: one bar,
 * every fact once, one search, a switch that marks its side and stays put when
 * the view changes, and every control that existed still reachable (in the bar
 * or behind its ⋯) except Undo and Redo, which the operator took out of the
 * header (a kanban undo is #1856).
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
import { setLocale, translate } from "@/lib/i18n";
import { en } from "@/lib/i18n/en";
import { uk } from "@/lib/i18n/uk";

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
const { resetSelectionSessionsForTest } = await import("@/hooks/useBoardState");
const { ProjectDashboard } = await import("@/components/ProjectDashboard");

const dom = new Window({ url: "http://localhost/" });
/* happy-dom lays nothing out: the Board and the other leaves' bar report the width the case sets. */
let barWidth = 2292;
const measureRect = dom.HTMLElement.prototype.getBoundingClientRect;
dom.HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
  const rect = measureRect.call(this);
  return this.classList?.contains("kb") || this.hasAttribute?.("data-project-bar") ? { ...rect, width: barWidth, right: barWidth } as DOMRect : rect;
} as typeof measureRect;
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
let searches = 0;
let boardWrites = 0;
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
      boardWrites += 1;
      const body = JSON.parse(String(init?.body)) as { project: string; mutations?: BoardMutationV1[] };
      const current = boards[body.project] ?? emptyBoard();
      const reduced = applyBoardMutations(current, body.mutations ?? []);
      const next = { ...reduced, schemaVersion: 1 as const, revision: current.revision + 1, updatedAt: new Date(0).toISOString(), pathAliases: reduced.pathAliases ?? {} };
      boards[body.project] = next;
      return { ok: true, status: 200, json: async () => ({ ok: true, applied: true, board: next }), text: async () => "" };
    }
    if (url.startsWith("/api/account-project-bindings")) {
      const body = { project: PROJECT, engines: { claude: { restricted: true, allowed: [{ accountId: "acct-a", label: "Account A" }], carrying: [], outsidePool: [] } } };
      return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
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
  PROJECT = `header-bar-${projectCounter}`;
  barWidth = 2292;
  boards = { [PROJECT]: seededBoard() };
  tmuxCalls = [];
  searches = 0;
  boardWrites = 0;
  dom.localStorage.clear();
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
        onOpenSearch={() => { searches += 1; }}
        onToggleOrchestratorPanel={() => {}}
      />,
    ),
  );
  roots.push(root);
  return host as unknown as HTMLElement;
}


const bar = (host: HTMLElement) => host.querySelector("header.bar, [data-project-bar]") as HTMLElement;
const text = (element: Element | null) => (element?.textContent ?? "").replace(/\s+/g, " ");
function click(element: Element | null) {
  expect(element).toBeTruthy();
  flushSync(() => element!.dispatchEvent(new dom.MouseEvent("click", { bubbles: true, cancelable: true }) as never));
}
const openMore = (host: HTMLElement) => {
  click(bar(host).querySelector("[data-bar-more]"));
  return host.querySelector("[data-bar-more-menu]") as HTMLElement;
};
/* A running conversation, so the old header would have said «1 branch running» over «1 agent working». */
const running = () => ({ ...alphaOf(), activity: "live" as const, proc: "running" as const });

test("the Board has one header bar, and it says each fact once", async () => {
  const host = mount([running(), betaOf()]);
  expect(await waitFor(() => host.querySelector("[data-kanban-board]") !== null)).toBe(true);
  await settle();

  expect(host.querySelectorAll("header.bar, [data-project-bar]")).toHaveLength(1);
  /* The project's name is in that bar, once, rather than in a row of its own above it. */
  const names = Array.from(host.querySelectorAll("h1"));
  expect(names).toHaveLength(1);
  expect(bar(host).contains(names[0]!)).toBe(true);
  expect(host.querySelector(".h-10")).toBeNull();
  /* «What is happening» is one count: the working one. */
  expect(bar(host).querySelectorAll("[data-bar-working]")).toHaveLength(1);
  const said = text(host);
  expect(said).not.toMatch(/branch(es)? running/);
  expect(said).not.toMatch(/tasks? on the board/);
  expect(said).not.toMatch(/needs? you/);
});

test("the Board's bar has one search, and the message search moved into ⋯", async () => {
  const host = mount();
  expect(await waitFor(() => host.querySelector("[data-kanban-board]") !== null)).toBe(true);
  await settle();

  const searches_ = () => host.querySelectorAll('input[type="search"], [data-testid="dash-search"]');
  expect(searches_()).toHaveLength(1);
  expect(bar(host).querySelector("[data-kanban-search]")).not.toBeNull();

  const menu = openMore(host);
  const message = menu.querySelector('[data-testid="dash-search"]');
  expect(text(message)).toContain(en["search.open"]);
  click(message);
  expect(searches).toBe(1);
});

test("Conversations shows one search too: the message search in the bar's find slot", async () => {
  const host = mount();
  expect(await waitFor(() => host.querySelector("[data-kanban-board]") !== null)).toBe(true);
  await settle();
  click(host.querySelector('button[data-view-tab="list"]'));
  expect(await waitFor(() => host.querySelector("[data-desktop-conversations-scroll]") !== null)).toBe(true);
  await settle();

  expect(host.querySelectorAll("header.bar, [data-project-bar]")).toHaveLength(1);
  expect(host.querySelectorAll('[data-project-bar] input[type="search"], [data-project-bar] [data-testid="dash-search"]')).toHaveLength(1);
  expect(openMore(host).querySelector('[data-testid="dash-search"]')).toBeNull();
});

test("the view switch marks its selected side", async () => {
  const host = mount();
  expect(await waitFor(() => host.querySelector("[data-kanban-board]") !== null)).toBe(true);
  await settle();

  const board = host.querySelector('button[data-view-tab="kanban"]') as HTMLElement;
  const list = host.querySelector('button[data-view-tab="list"]') as HTMLElement;
  expect(board.getAttribute("aria-pressed")).toBe("true");
  expect(list.getAttribute("aria-pressed")).toBe("false");
  /* Pressing the other side moves the mark with the view. */
  click(list);
  expect(await waitFor(() => host.querySelector('button[data-view-tab="list"]')?.getAttribute("aria-pressed") === "true")).toBe(true);
  expect(host.querySelector('button[data-view-tab="kanban"]')!.getAttribute("aria-pressed")).toBe("false");
});

test("every control the two bars held is still reachable, wide", async () => {
  const host = mount([alphaOf(), betaOf()]);
  expect(await waitFor(() => host.querySelector("[data-kanban-board]") !== null)).toBe(true);
  await settle();
  expect(await waitFor(() => bar(host).querySelector("[data-account-switch-engine]") !== null)).toBe(true);

  const inBar = bar(host);
  expect(inBar.getAttribute("data-bar-tier")).toBe("wide");
  for (const selector of ["[data-kanban-search]", "[data-hidden-pill]", "[data-view-tab=kanban]", "[data-view-tab=list]", "[data-new-task]", "[data-new-agent]", "[data-orchestrator-toggle]", "[data-task-panel-toggle]", "[data-account-switch-engine]"]) {
    expect({ selector, found: inBar.querySelector(selector) !== null }).toEqual({ selector, found: true });
  }
  expect(text(inBar.querySelector("[data-orchestrator-toggle]"))).toContain(en["orchPanel.title"]);

  const menu = openMore(host);
  const rows = text(menu);
  for (const label of [en["search.open"], en["sound.mute"], en["sound.settings"], en["trash.toArchive"], en["trash.deleteProject"]]) {
    expect({ label, found: rows.includes(label) }).toEqual({ label, found: true });
  }
  /* The account switch stays in the bar while it is wide, so ⋯ does not repeat it. */
  expect(menu.querySelector("[data-account-switch-engine]")).toBeNull();
  const account = inBar.querySelector("[data-account-switch-engine] button") as HTMLElement;
  expect(account.getAttribute("data-account-switch-appearance")).toBe("bar");
  /* Sound levels open in place, inside the menu. */
  click(menu.querySelector('[data-testid="sound-settings-trigger"]'));
  expect(menu.querySelector('[data-testid="sound-settings"]')).not.toBeNull();
});

test("narrow, the bar keeps one row: icons, one + with both creators, and the accounts behind ⋯", async () => {
  barWidth = 1032;
  const host = mount([alphaOf(), betaOf()]);
  expect(await waitFor(() => host.querySelector("[data-kanban-board]") !== null)).toBe(true);
  await settle();

  const inBar = bar(host);
  expect(inBar.getAttribute("data-bar-tier")).toBe("narrow");
  expect(inBar.querySelector("[data-account-switch-engine]")).toBeNull();
  expect(text(inBar.querySelector("[data-orchestrator-toggle]"))).toBe("");
  expect(inBar.querySelector("[data-orchestrator-toggle]")!.getAttribute("aria-label")).toBe(en["orchPanel.toggleAria"]);
  expect(text(inBar.querySelector('[data-view-tab="list"]'))).toBe("");
  expect(inBar.querySelector('[data-view-tab="list"]')!.getAttribute("aria-label")).toBe(en["dash.viewList"]);

  expect(inBar.querySelector("[data-new-task]")).toBeNull();
  click(inBar.querySelector("[data-bar-create]"));
  const create = host.querySelector('.menu[role="menu"]') as HTMLElement;
  expect(text(create)).toContain(en["dash.newTask"]);
  expect(text(create)).toContain(en["dash.newConvo"]);

  /* In ⋯ the account switch is one menu row per engine, never a pill. */
  const menu = openMore(host);
  expect(await waitFor(() => menu.querySelector("[data-account-switch-engine]") !== null)).toBe(true);
  const row = menu.querySelector("[data-account-switch-engine] button") as HTMLElement;
  expect(row.getAttribute("data-account-switch-appearance")).toBe("menu");
  expect(row.className).toContain("w-full");
  expect(row.closest("[data-bar-menu-group]")!.getAttribute("data-bar-menu-group")).toBe("accounts");
});

test("Undo and Redo are gone from the header, its ⋯ and Ctrl+Z, even with a close in the log (#1856)", async () => {
  /* A closed card in the device-local log, which used to light the undo row. */
  dom.localStorage.setItem(
    `llvBoardHistory:${PROJECT}`,
    JSON.stringify({ entries: [{ kind: "close", path: "/gamma", title: "Gamma" }], cursor: 1 }),
  );
  const host = mount();
  expect(await waitFor(() => host.querySelector("[data-kanban-board]") !== null)).toBe(true);
  await settle();

  const menu = openMore(host);
  expect(host.querySelector("[data-board-undo], [data-board-redo]")).toBeNull();
  expect(text(bar(host))).not.toMatch(/undo|redo/i);
  expect(text(menu)).not.toMatch(/undo|redo/i);

  const writes = boardWrites;
  flushSync(() => dom.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true }) as never));
  await settle();
  expect(boardWrites).toBe(writes);
});

test("⋯ draws no rule next to a group with nothing in it", async () => {
  /* A running conversation stands Archive and Delete down, which used to leave a rule under the last row. */
  const host = mount([running(), betaOf()]);
  expect(await waitFor(() => host.querySelector("[data-kanban-board]") !== null)).toBe(true);
  await settle();

  const menu = openMore(host);
  expect(menu.querySelector('[role="separator"]')).toBeNull();
  const project = menu.querySelector('[data-bar-menu-group="project"]') as HTMLElement;
  expect(project.childNodes).toHaveLength(0);
});

test("the view switch keeps its place when the view changes: Conversations reserves the create group", async () => {
  for (const width of [2292, 1032]) {
    barWidth = width;
    const host = mount();
    expect(await waitFor(() => host.querySelector("[data-kanban-board]") !== null)).toBe(true);
    await settle();
    const order = (root: HTMLElement) => Array.from(root.querySelectorAll("[data-bar-group]"))
      .map((element) => element.getAttribute("data-bar-group"))
      .filter((group) => group === "view" || group === "create" || group === "panels" || group === "more");
    const boardCreate = bar(host).querySelector('[data-bar-group="create"]') as HTMLElement;
    const boardControls = Array.from(boardCreate.querySelectorAll("button")).map((element) => [element.className, text(element)]);
    expect(order(bar(host))).toEqual(["view", "create", "panels", "more"]);

    click(host.querySelector('button[data-view-tab="list"]'));
    expect(await waitFor(() => host.querySelector("[data-desktop-conversations-scroll]") !== null)).toBe(true);
    await settle();
    const listBar = bar(host);
    expect(order(listBar)).toEqual(["view", "create", "panels", "more"]);
    const reserve = listBar.querySelector("[data-bar-create-reserve]") as HTMLElement;
    expect(reserve.getAttribute("aria-hidden")).toBe("true");
    expect(reserve.hasAttribute("inert")).toBe(true);
    expect(reserve.className).toContain("invisible");
    /* Same controls, same classes, same words: the same width, so nothing right of the spacer moves. */
    expect(Array.from(reserve.children).map((element) => [element.className, text(element)])).toEqual(boardControls);
    expect(reserve.querySelector("button")).toBeNull();
    for (const root of roots) flushSync(() => root.unmount());
    roots = [];
    dom.document.body.replaceChildren();
    PROJECT = `${PROJECT}-narrow`;
    boards = { [PROJECT]: seededBoard() };
    resetSelectionSessionsForTest();
  }
});

test("hover never paints a control in the accent, and + is an icon in the control's own colour", async () => {
  const host = mount();
  expect(await waitFor(() => host.querySelector("[data-kanban-board]") !== null)).toBe(true);
  await settle();

  for (const selector of ["[data-new-task]", "[data-new-agent]", "[data-task-panel-toggle]", "[data-orchestrator-toggle]"]) {
    const control = bar(host).querySelector(selector) as HTMLElement;
    expect({ selector, accentHover: /hover:(text|border)-accent/.test(control.className) }).toEqual({ selector, accentHover: false });
  }
  for (const selector of ["[data-new-task]", "[data-new-agent]"]) {
    const control = bar(host).querySelector(selector) as HTMLElement;
    expect(control.querySelector("svg")).not.toBeNull();
    expect(control.querySelector(".plus")).toBeNull();
    expect(text(control).trim().startsWith("+")).toBe(false);
  }
});

test("1602 px of bar (a 1850 px viewport) is the narrow tier: the uk labels did not fit there", async () => {
  barWidth = 1602;
  const host = mount();
  expect(await waitFor(() => host.querySelector("[data-kanban-board]") !== null)).toBe(true);
  await settle();
  expect(bar(host).getAttribute("data-bar-tier")).toBe("narrow");
});

test("narrow, a long project name truncates to its floor instead of pushing the row under the island", async () => {
  barWidth = 1032;
  const host = mount();
  expect(await waitFor(() => host.querySelector("[data-kanban-board]") !== null)).toBe(true);
  await settle();
  const name = bar(host).querySelector("h1") as HTMLElement;
  expect(name.className).toContain("truncate");
  /* The name's floor and the row's fit are measured by the board-geometry capture; here, the
     other leaves' status line gives way too. */
  click(host.querySelector('button[data-view-tab="list"]'));
  expect(await waitFor(() => host.querySelector("[data-project-bar]") !== null)).toBe(true);
  await settle();
  const status = host.querySelector('[data-project-bar] [data-bar-group="status"]') as HTMLElement;
  expect(status.className).not.toContain("shrink-0");
  expect(status.className).toContain("truncate");
});

test("the Tasks panel opens under the Board's one bar, so the bar spans it and stays one row", async () => {
  barWidth = 1032;
  const host = mount();
  expect(await waitFor(() => host.querySelector("[data-kanban-board]") !== null)).toBe(true);
  await settle();
  click(bar(host).querySelector("[data-task-panel-toggle]"));
  expect(await waitFor(() => host.querySelector(`aside[aria-label="${en["tasks.panelTitle"]}"]`) !== null)).toBe(true);
  await settle();

  const panel = host.querySelector(`aside[aria-label="${en["tasks.panelTitle"]}"]`) as HTMLElement;
  expect(host.querySelectorAll(`aside[aria-label="${en["tasks.panelTitle"]}"]`)).toHaveLength(1);
  const board = host.querySelector("[data-kanban-board]") as HTMLElement;
  /* The panel is inside the board, below the bar: the bar is the board's first row and the panel
     sits in the row under it, beside the columns. */
  expect(board.contains(panel)).toBe(true);
  expect(board.firstElementChild).toBe(bar(host));
  expect(bar(host).contains(panel)).toBe(false);
  expect(panel.closest(".kb-body")?.previousElementSibling).toBe(bar(host));
  expect(bar(host).querySelector("[data-task-panel-toggle]")!.getAttribute("aria-pressed")).toBe("true");
  /* 1032 px of bar is one row whether the panel is open or not; only a bar under 768 px wraps. */
  expect(bar(host).hasAttribute("data-bar-wrap")).toBe(false);

  /* The toggle in the bar still closes it. */
  click(bar(host).querySelector("[data-task-panel-toggle]"));
  expect(await waitFor(() => host.querySelector(`aside[aria-label="${en["tasks.panelTitle"]}"]`) === null)).toBe(true);
});

test("a bar under 768 px, and only there, wraps", async () => {
  barWidth = 700;
  const host = mount();
  expect(await waitFor(() => host.querySelector("[data-kanban-board]") !== null)).toBe(true);
  await settle();
  expect(bar(host).hasAttribute("data-bar-wrap")).toBe(true);
});

test("uk: the switch, the working count and ⋯ read in Ukrainian", async () => {
  setLocale("uk");
  try {
    const host = mount();
    expect(await waitFor(() => host.querySelector("[data-kanban-board]") !== null)).toBe(true);
    await settle();
    expect(text(host.querySelector('button[data-view-tab="kanban"]'))).toContain(translate("uk", "kanban.viewTab"));
    expect(text(host.querySelector('button[data-view-tab="list"]'))).toContain(translate("uk", "dash.viewList"));
    expect(text(bar(host).querySelector("[data-bar-working]"))).toBe(translate("uk", "kanban.summaryWorking", { count: 0 }));
    const menu = openMore(host);
    expect(text(menu)).toContain(translate("uk", "search.open"));
  } finally {
    setLocale("en");
  }
});

test("narrow, Hidden is its icon and count, the shape Tasks has; wide, it keeps its label", async () => {
  barWidth = 1032;
  const narrow = mount();
  expect(await waitFor(() => narrow.querySelector("[data-kanban-board]") !== null)).toBe(true);
  await settle();
  const pill = bar(narrow).querySelector("[data-hidden-pill]") as HTMLElement;
  expect(pill.querySelector("svg")).not.toBeNull();
  expect(text(pill)).not.toContain(en["kanban.hidden"]);
  expect(pill.getAttribute("title")).toBe(pill.getAttribute("aria-label"));
  expect(pill.querySelector(".count")).not.toBeNull();
  for (const root of roots) flushSync(() => root.unmount());
  roots = [];
  dom.document.body.replaceChildren();

  barWidth = 2292;
  const wide = mount();
  expect(await waitFor(() => wide.querySelector("[data-kanban-board]") !== null)).toBe(true);
  await settle();
  expect(text(bar(wide).querySelector("[data-hidden-pill]"))).toContain(en["kanban.hidden"]);
});

test("narrow, the create menu's two rows carry icons, like the ⋯ rows", async () => {
  barWidth = 1032;
  const host = mount();
  expect(await waitFor(() => host.querySelector("[data-kanban-board]") !== null)).toBe(true);
  await settle();
  click(bar(host).querySelector("[data-bar-create]"));
  const items = Array.from(host.querySelectorAll('.menu[role="menu"] [role="menuitem"]'));
  expect(items).toHaveLength(2);
  for (const item of items) expect(item.querySelector("svg.ico")).not.toBeNull();
});

test("narrow Conversations: a short search label and only the live count, so only the name truncates", async () => {
  barWidth = 1032;
  const host = mount([running(), betaOf()]);
  expect(await waitFor(() => host.querySelector("[data-kanban-board]") !== null)).toBe(true);
  await settle();
  click(host.querySelector('button[data-view-tab="list"]'));
  expect(await waitFor(() => host.querySelector("[data-project-bar]") !== null)).toBe(true);
  await settle();
  const find = host.querySelector('[data-project-bar] [data-testid="dash-search"]') as HTMLElement;
  expect(text(find).trim()).toBe(en["dash.searchShort"]);
  /* The full wording and its «/» hint stay as the name and the tooltip. */
  expect(find.getAttribute("aria-label")).toBe(en["search.open"]);
  expect(find.getAttribute("title")).toBe(en["search.open"]);
  const status = text(host.querySelector('[data-project-bar] [data-bar-group="status"]'));
  expect(status).toMatch(/running/);
  expect(status).not.toMatch(/tree/);
  /* Short now, it holds its width; the name is what gives way. */
  expect((host.querySelector('[data-project-bar] [data-bar-group="status"]') as HTMLElement).className).toContain("shrink-0");
  expect(uk["dash.searchShort"]).toBe("Пошук");
});
