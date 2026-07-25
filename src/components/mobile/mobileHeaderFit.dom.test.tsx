import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";

import { emptyStore } from "@/components/runtime/runtimeModel";
import { translate } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";
import type { BoardTask } from "@/lib/tasks/types";

/*
 * Issue #613 — the phone header must fit a 390px viewport. happy-dom does no
 * layout, so this guards the *structural* contract the geometry depends on
 * (issue613Evidence.browser.test.tsx measures the pixels in Chromium):
 *
 *   - the row carries only fixed 44px targets plus ONE elastic cell, the
 *     project name, which truncates;
 *   - the attention badge keeps its own width — it is an action, not filler;
 *   - the 94px scheme/list segmented pair no longer rides the row: both faces
 *     live in the «⋯» menu as radio options and still switch the board.
 */

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
    items: [], nextCursor: null, total: 0, loading: false, error: false, loadMore: () => {}, retry: () => {},
  }),
}));

const { ProjectDashboard } = await import("@/components/ProjectDashboard");

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
  PointerEvent: dom.MouseEvent,
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
  path: "/repo/worktrees/mobile-header/0f1e2d3c.jsonl",
  root: "claude-projects", name: "0f1e2d3c.jsonl", project: PROJECT,
  title: "Builder · keep the conversation header inside a 390px viewport (#613)",
  engine: "claude", kind: "session", fmt: "claude", parent: null, mtime: 9_000, size: 4_096,
  activity: "live", proc: null, pid: null, model: "claude-opus-4-8", effort: "high", ctx: 62,
  renamable: true, conversationId: "conversation_613mobile", pendingQuestion: null, waitingInput: null,
} as unknown as FileEntry;

const task = {
  id: "t-613", project: PROJECT, status: "inbox", text: "Keep the header inside 390px",
  placement: "pinned", pos: { x: 720, y: 140 }, assignments: [],
  createdAt: "2026-07-25T00:00:00.000Z", updatedAt: "2026-07-25T00:00:00.000Z",
} as unknown as BoardTask;

const ATTENTION_LABEL = translate("en", "attention.badge", { count: 3 });

const dashboardProps = () => ({
  files: [conversation], flows: [], pipelines: [], workflows: [], tasks: [task],
  project: PROJECT, loaded: true, openNonce: 0, archived: false,
  catalogKnown: true, catalogConversationCount: 1,
  projectCwd: "/repo", onArchive: () => {}, onUnarchive: () => {},
  onMenu: () => {},
  attention: (
    <button type="button" className="inline-flex min-h-11 items-center px-3.5" aria-label={ATTENTION_LABEL}>3</button>
  ),
});

let roots: Root[] = [];
beforeEach(() => {
  roots = [];
  boardRevision = 1;
  boardPrefs = {};
  dom.document.body.replaceChildren();
  dom.sessionStorage.clear();
  dom.localStorage.clear();
  /* A closed card in the device-local log → the header offers undo (#184). */
  dom.localStorage.setItem(
    `llvBoardHistory:${PROJECT}`,
    JSON.stringify({ entries: [{ kind: "close", path: "/repo/closed.jsonl", title: "Closed card" }], cursor: 1 }),
  );
});
afterEach(async () => { for (const root of roots) flushSync(() => root.unmount()); roots = []; await settle(); });

function mount(): HTMLElement {
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as Element);
  flushSync(() => root.render(<ProjectDashboard {...dashboardProps()} />));
  roots.push(root);
  return host as unknown as HTMLElement;
}

const header = (host: HTMLElement) => host.querySelector('[data-testid="mobile-project-header"]') as unknown as HTMLElement;
const label = (el: Element) => el.getAttribute("aria-label") ?? el.textContent?.trim() ?? "";

const shelfReady = (host: HTMLElement) => host.querySelector('[data-testid="mobile-shelf-trigger"]') !== null;

test("the 390px header row keeps one elastic cell — the project name — and fixed 44px targets (#613)", async () => {
  const host = mount();
  /* Wait for the fully populated row — the shelf trigger is the last control to
     appear, once the board arrangement settles. */
  expect(await waitFor(() => shelfReady(host))).toBe(true);
  const row = header(host);
  expect(row).not.toBeNull();

  /* The project name is the cell that gives way: capped, truncating, and NOT
     shrink-0 — as shrink-0 it held 45vw and pushed the row past the viewport. */
  const title = row.querySelector("h1") as unknown as HTMLElement;
  expect(title.className).toContain("min-w-0");
  expect(title.className).toContain("max-w-[45vw]");
  expect(title.className).toContain("truncate");
  expect(title.className).not.toContain("shrink-0");

  /* The attention badge holds its own width beside the name. */
  const attention = row.querySelector(`[aria-label="${ATTENTION_LABEL}"]`) as unknown as HTMLElement;
  expect(attention).not.toBeNull();
  expect((attention.parentElement as unknown as HTMLElement).className).toContain("shrink-0");

  /* Every direct control of the row is a fixed 44px (h-11) target. */
  const triggers = Array.from(row.querySelectorAll("button")).filter((el) => label(el) !== ATTENTION_LABEL);
  expect(triggers.length).toBeGreaterThanOrEqual(4);
  for (const trigger of triggers) {
    expect(`${trigger.className} `).toMatch(/(^|\s)(h-11|min-h-11)(\s|$)/);
    expect(`${trigger.className} `).toMatch(/(^|\s)(w-11|min-w-11|w-full)(\s|$)/);
  }

  /* The controls the operator relies on are all still in the row. */
  const labels = triggers.map(label);
  for (const key of ["dash.openProjects", "dash.hiddenShelf", "dash.createMenu", "dash.moreMenu"] as const) {
    expect(labels.some((entry) => entry.startsWith(translate("en", key)))).toBe(true);
  }
  expect(labels.some((entry) => entry.startsWith(translate("en", "board.undo")))).toBe(true);

  /* And the 94px segmented scheme/list pair is gone from the row. */
  expect(labels).not.toContain(translate("en", "dash.viewScheme"));
  expect(labels).not.toContain(translate("en", "dash.viewList"));
});

test("both board faces stay one tap away inside the «more» menu and still switch the board (#613)", async () => {
  const host = mount();
  expect(await waitFor(() => shelfReady(host))).toBe(true);
  const row = header(host);

  const more = Array.from(row.querySelectorAll("button")).find(
    (el) => label(el) === translate("en", "dash.moreMenu"),
  ) as unknown as HTMLButtonElement;
  expect(more).not.toBeNull();
  flushSync(() => more.click());
  await settle();

  const options = Array.from(row.querySelectorAll('[role="menuitemradio"]'));
  expect(options.map(label)).toEqual([translate("en", "dash.viewSchemeMenu"), translate("en", "dash.viewListMenu")]);
  /* The face currently shown is announced, not merely tinted. */
  expect(options[0]!.getAttribute("aria-checked")).toBe("true");
  expect(options[1]!.getAttribute("aria-checked")).toBe("false");

  /* The focused chat is the scheme face; picking the list swaps the board. */
  expect(host.querySelector('[data-testid="mobile-chat-shell"]')).not.toBeNull();
  flushSync(() => (options[1] as unknown as HTMLButtonElement).click());
  await settle();
  expect(await waitFor(() => host.querySelector('[data-testid="mobile-chat-shell"]') === null)).toBe(true);

  /* Reopening the menu shows the list face checked — the switch is reversible. */
  const moreAgain = Array.from(header(host).querySelectorAll("button")).find(
    (el) => label(el) === translate("en", "dash.moreMenu"),
  ) as unknown as HTMLButtonElement;
  flushSync(() => moreAgain.click());
  await settle();
  const reopened = Array.from(header(host).querySelectorAll('[role="menuitemradio"]'));
  expect(reopened[1]!.getAttribute("aria-checked")).toBe("true");
});
