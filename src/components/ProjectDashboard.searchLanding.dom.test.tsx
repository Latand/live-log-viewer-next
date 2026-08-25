import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";

import { emptyStore } from "@/components/runtime/runtimeModel";
import { translate } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";

/*
 * Issue #1054 review, HIGH — "find, open, continue" stopped at open.
 *
 * The global search palette hands its selection to the shell's own resolver,
 * which pins the transcript, selects its project and issues a focus request.
 * That materializes the node — but a SAVED «Список» preference still won view
 * resolution, so both form factors kept rendering the catalog list: no card, no
 * composer, and the operator landed back on the surface they searched to leave.
 *
 * The landing now outranks the saved preference for as long as it stands, on
 * desktop and on the phone, WITHOUT writing that preference — the operator's
 * saved view is one tap away and comes back untouched.
 *
 * These mount the REAL ProjectDashboard with `viewMode: "list"` already stored,
 * and drive the resolver's own channel: `focusRequest` carrying `catalog: true`,
 * which is exactly what Viewer.openPinnedFile issues for a search selection, an
 * `#f=`/`#c=` deep link and a catalog row.
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
/* The catalog list has rows of its own, so «Список» is a real face here — the
   defect needs a list worth resolving to. */
mock.module("@/hooks/useConversationCatalog", () => ({
  useConversationCatalog: () => ({
    items: [], nextCursor: null, total: 3, loading: false, error: false, loadMore: () => {}, retry: () => {},
  }),
}));

const { ProjectDashboard } = await import("@/components/ProjectDashboard");

const dom = new Window({ url: "http://localhost/", width: 1440, height: 900 });
const G = globalThis as Record<string, unknown>;

let mobile = false;
(dom as unknown as { matchMedia: (query: string) => unknown }).matchMedia = (query: string) => ({
  matches: mobile && /max-width|pointer: coarse/.test(String(query)),
  media: String(query), onchange: null,
  addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; },
});

let boardRevision = 1;
let boardPrefs: Record<string, unknown> = {};
/** Every presentation write the board received — the assertion that the saved
    preference is never clobbered by a landing. */
let presentationWrites: Array<"scheme" | "list" | null> = [];

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
        const body = JSON.parse(String(init.body)) as {
          patch?: Record<string, unknown>;
          mutations?: Array<{ kind: string; viewMode?: "scheme" | "list" | null }>;
        };
        for (const mutation of body.mutations ?? []) {
          if (mutation.kind === "set-presentation" && mutation.viewMode !== undefined) {
            presentationWrites.push(mutation.viewMode ?? null);
            boardPrefs.viewMode = mutation.viewMode;
          }
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
  (dom.HTMLElement.prototype as unknown as { animate: () => unknown }).animate = () => ({ cancel() {}, addEventListener() {} });
});
afterAll(async () => {
  await settle();
  for (const key of Object.keys(OVERRIDES)) { if (HAS[key]) G[key] = SAVED[key]; else delete G[key]; }
  mock.module("@/hooks/useRuntime", () => actualRuntimeHooks);
  mock.module("@/hooks/useConversationCatalog", () => actualConversationCatalogHooks);
});

const PROJECT = "search-landing-project";
/* Invented placeholder content — no operator strings anywhere in this file. */
const FOUND_PATH = "/repo/sessions/found-conversation.jsonl";

const found = {
  path: FOUND_PATH,
  root: "claude-projects", name: "found-conversation.jsonl", project: PROJECT,
  title: "The conversation the operator went looking for",
  engine: "claude", kind: "session", fmt: "claude", parent: null, mtime: 9_000, size: 4_096,
  activity: "idle", proc: null, pid: null, model: "claude-opus-4-8", effort: "high",
  renamable: true, conversationId: "conversation_search_landing", pendingQuestion: null, waitingInput: null,
} as unknown as FileEntry;

const dashboardProps = (focusRequest: { path: string; nonce: number; catalog?: boolean } | null) => ({
  files: [found], flows: [], pipelines: [], workflows: [], tasks: [],
  project: PROJECT, loaded: true, openNonce: 0, archived: false,
  catalogKnown: true, catalogConversationCount: 3,
  projectCwd: "/repo", onArchive: () => {}, onUnarchive: () => {},
  focusRequest,
  onOpenSearch: () => {},
});

let roots: Root[] = [];
beforeEach(() => {
  roots = [];
  mobile = false;
  boardRevision = 1;
  /* The operator's saved face: «Список». */
  boardPrefs = { viewMode: "list" };
  presentationWrites = [];
  dom.document.body.replaceChildren();
  dom.sessionStorage.clear();
  dom.localStorage.clear();
});
afterEach(async () => { for (const root of roots) flushSync(() => root.unmount()); roots = []; await settle(); });

function mount(focusRequest: { path: string; nonce: number; catalog?: boolean } | null): {
  host: HTMLElement;
  rerender: (next: { path: string; nonce: number; catalog?: boolean } | null) => void;
} {
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as Element);
  flushSync(() => root.render(<ProjectDashboard {...dashboardProps(focusRequest)} />));
  roots.push(root);
  return {
    host: host as unknown as HTMLElement,
    rerender: (next) => flushSync(() => root.render(<ProjectDashboard {...dashboardProps(next)} />)),
  };
}

const listShown = (host: HTMLElement) => host.textContent?.includes(translate("en", "list.title")) ?? false;
const composer = (host: HTMLElement) => host.querySelector("textarea");
const card = (host: HTMLElement) => host.querySelector(`[data-scheme-node="${FOUND_PATH}"]`);
const chatShell = (host: HTMLElement) => host.querySelector('[data-testid="mobile-chat-shell"]');

test("desktop: a search landing opens the conversation with its composer even from saved «Список»", async () => {
  const { host, rerender } = mount(null);
  /* The saved preference is honoured until something asks otherwise. */
  expect(await waitFor(() => listShown(host))).toBe(true);
  expect(card(host)).toBeNull();

  /* The resolver's landing — what Viewer issues after pinning a search result. */
  rerender({ path: FOUND_PATH, nonce: 1, catalog: true });

  expect(await waitFor(() => card(host) !== null)).toBe(true);
  /* Ready to CONTINUE: the conversation's own composer is on screen. */
  expect(await waitFor(() => composer(host) !== null)).toBe(true);
  expect(listShown(host)).toBe(false);
  /* The durable preference was never rewritten — the override is view state. */
  expect(presentationWrites).toEqual([]);
});

test("phone: the same landing renders the focused chat, not the catalog list", async () => {
  mobile = true;
  const { host, rerender } = mount(null);
  expect(await waitFor(() => listShown(host))).toBe(true);
  expect(chatShell(host)).toBeNull();

  rerender({ path: FOUND_PATH, nonce: 1, catalog: true });

  expect(await waitFor(() => chatShell(host) !== null)).toBe(true);
  expect(await waitFor(() => composer(host) !== null)).toBe(true);
  expect(listShown(host)).toBe(false);
  expect(presentationWrites).toEqual([]);
});

test("the operator's «Список» tap takes the view back and the saved preference is intact", async () => {
  const { host, rerender } = mount(null);
  expect(await waitFor(() => listShown(host))).toBe(true);
  rerender({ path: FOUND_PATH, nonce: 1, catalog: true });
  expect(await waitFor(() => card(host) !== null)).toBe(true);

  /* The floating Схема/Список tabs are the desktop face of that control. */
  const listTab = Array.from(host.querySelectorAll("button")).find(
    (el) => (el.textContent ?? "").trim() === translate("en", "dash.viewList"),
  ) as unknown as HTMLButtonElement | undefined;
  expect(listTab).toBeDefined();
  flushSync(() => listTab!.click());

  expect(await waitFor(() => listShown(host))).toBe(true);
  expect(card(host)).toBeNull();
  /* It wrote «list» — the face it was already saved as. Nothing ever wrote
     «scheme» on the operator's behalf. */
  expect(presentationWrites).not.toContain("scheme");
});

test("a plain focus jump does NOT commandeer the view — only a resolver landing does", async () => {
  const { host, rerender } = mount(null);
  expect(await waitFor(() => listShown(host))).toBe(true);

  /* An attention jump / N-cycle carries `catalog: false`: it asks the board to
     move to a node, not to answer a search with a conversation. The saved list
     stays, exactly as before this fix. */
  rerender({ path: FOUND_PATH, nonce: 1, catalog: false });
  await settle();
  await new Promise((r) => setTimeout(r, 120));

  expect(listShown(host)).toBe(true);
  expect(card(host)).toBeNull();
});
