import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { applyBoardMutations, type BoardMutationV1 } from "@/lib/board/mutations";
import { en } from "@/lib/i18n/en";
import type { FileEntry } from "@/lib/types";
import type { BoardProjectStateV1 } from "@/lib/view/types";

/*
 * P1 — the canonical `#c=<conversationId>` deep link silently bounced instead
 * of opening the conversation. Two client-side defects, both against the same
 * invariant (resolution is level-triggered against arriving data, and failure
 * is VISIBLE, never a silent landing on the default view):
 *
 * 1. When the only generation of the conversation in the payload is an
 *    archived predecessor (`migratedTo` set; the successor transcript sits
 *    beyond the capped feed — 44 of 52 migrated rows on the machine that
 *    reproduced this), the resolver correctly picked that row, but
 *    `withoutArchivedPredecessors` then folded it out of every rendering
 *    surface: the board had no node for the focused path, nothing opened, no
 *    error anywhere.
 *
 * 2. The catalog-pin release effect read the EMPTY scope-transition
 *    placeholder (`loaded: false`) as evidence the pinned transcript was gone
 *    and released a freshly hydrated pin, so even a healthy beyond-cap deep
 *    link lost its pinned row and its focus request right after resolving.
 *
 * These mount the real Viewer with the hash pre-set — the row arriving only
 * via the pinned fetch, exactly like a pasted deep link on a fresh tab.
 */

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
  IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } },
  requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
});

const matchMedia = (query: string) => ({
  matches: false,
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

/* happy-dom has no Web Animations API; useFlip animates board children. */
(dom.HTMLElement.prototype as unknown as { animate: () => unknown }).animate = () => ({
  cancel() {},
  addEventListener() {},
});

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

const CONVERSATION_ID = "conversation_deeplink-target";
const TARGET_PATH = "/sessions/deep-link-target.jsonl";
const TARGET_PROJECT = "deep-link-project";

function fileEntry(overrides: Partial<FileEntry>): FileEntry {
  return {
    path: "/sessions/a.jsonl",
    root: "claude-projects",
    name: "a.jsonl",
    project: "other-project",
    title: "Session",
    engine: "claude",
    kind: "session",
    fmt: "claude",
    parent: null,
    mtime: 1_000,
    size: 1,
    activity: "idle",
    proc: null,
    pid: null,
    model: null,
    pendingQuestion: null,
    waitingInput: null,
    ...overrides,
  } as FileEntry;
}

const otherRow = fileEntry({ path: "/sessions/other.jsonl", title: "Other" });
const targetRow = fileEntry({
  path: TARGET_PATH,
  name: "deep-link-target.jsonl",
  project: TARGET_PROJECT,
  title: "The deep-linked conversation",
  conversationId: CONVERSATION_ID,
});
/* The production shape of the P1: the conversation's ONLY row in the payload is
   an archived predecessor — its account migration recorded a successor path the
   capped feed does not carry. */
const predecessorRow = fileEntry({
  ...targetRow,
  migratedTo: "/beyond-cap/successor-generation.jsonl",
});

const originalFetch = globalThis.fetch;
const requestLog: string[] = [];
let historyWrites: string[] = [];
let boards: Record<string, BoardProjectStateV1> = {};

const emptyBoard = (): BoardProjectStateV1 => ({
  schemaVersion: 1,
  revision: 0,
  updatedAt: new Date(0).toISOString(),
  pathAliases: {},
  prefs: { manual: [], hidden: [], expanded: [], favorites: [], foldedEngineChildIds: [], expandedEngineTrayParentIds: [], viewMode: null, taskPanelOpen: false },
});

/* Wrapped ONCE at module scope: re-wrapping per test would stack the loggers
   and double-count every write in later tests. */
const origPush = dom.history.pushState.bind(dom.history);
const origReplace = dom.history.replaceState.bind(dom.history);
dom.history.pushState = (s: unknown, t: string, u?: string | URL) => { historyWrites.push(`push:${u}`); return origPush(s, t, u); };
dom.history.replaceState = (s: unknown, t: string, u?: string | URL) => { historyWrites.push(`replace:${u}`); return origReplace(s, t, u); };

beforeEach(() => {
  resetFilesClientCacheForTests();
  dom.localStorage.clear();
  dom.sessionStorage.clear();
  document.body.replaceChildren();
  requestLog.length = 0;
  historyWrites = [];
  boards = {};
});

afterEach(() => {
  unmountViewer();
  globalThis.fetch = originalFetch;
  document.body.replaceChildren();
  dom.location.hash = "";
});

/** `/api/files` serves `filesByPin` keyed by the request's `path` param
    (`""` = the unpinned global scope); `/api/board` is a real in-memory board
    so the focus request can actually place its card. Everything else 404s. */
function stubFetch(filesByPin: (pin: string) => FileEntry[]) {
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requestLog.push(url);
    if (url.startsWith("/api/files")) {
      const pin = new URL(url, "http://localhost").searchParams.get("path") ?? "";
      return new Response(
        JSON.stringify({ files: filesByPin(pin), projectCatalog: [] }),
        { headers: { "content-type": "application/json" } },
      );
    }
    if (url.startsWith("/api/board")) {
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "GET") {
        const project = new URL(url, "http://localhost").searchParams.get("project") ?? "";
        return Response.json({ ok: true, board: boards[project] ?? emptyBoard() });
      }
      const body = JSON.parse(String(init?.body)) as { project: string; mutations?: BoardMutationV1[] };
      const current = boards[body.project] ?? emptyBoard();
      const reduced = applyBoardMutations(current, body.mutations ?? []);
      const next = { ...reduced, schemaVersion: 1 as const, revision: current.revision + 1, updatedAt: new Date(0).toISOString(), pathAliases: reduced.pathAliases ?? {} };
      boards[body.project] = next;
      return Response.json({ ok: true, applied: true, board: next });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

let mounted: { unmount: () => void } | null = null;

async function mountViewer(): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted = root;
  await act(async () => { root.render(<Viewer />); });
  await act(async () => { await Bun.sleep(50); });
  return host as unknown as HTMLElement;
}

function unmountViewer() {
  if (!mounted) return;
  const root = mounted;
  mounted = null;
  act(() => { root.unmount(); });
}

/** Level-triggered settling: polls until the condition holds or the bounded
    window elapses, driving timers/microtasks through `act` between checks. */
async function waitFor(check: () => boolean, timeoutMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await act(async () => { await Bun.sleep(40); });
  }
  return check();
}

/** The navigation-loop oracle, applied to EVERY ordering: once the run under
    test settles, resolution must not have pushed a single history entry (a
    push loop grows the stack and breaks Back), must write nothing further,
    and must leave the tab on the same URL. Valid only alongside an assertion
    about the outcome itself — a quiescence check over a failed open says
    nothing, which is exactly how the first version of the loop test passed
    on the defective base. */
async function expectNavigationQuiescence(): Promise<void> {
  const settled = historyWrites.length;
  const hashAtSettle = dom.location.hash;
  await act(async () => { await Bun.sleep(300); });
  expect(historyWrites.every((write) => write.startsWith("replace:"))).toBe(true);
  expect(historyWrites.length).toBe(settled);
  expect(dom.location.hash).toBe(hashAtSettle);
}

test("#c= to a conversation whose only present generation is an archived predecessor opens it", async () => {
  dom.location.hash = `#c=${encodeURIComponent(CONVERSATION_ID)}`;
  /* The global scope is capped past the conversation; the pinned scope (by id
     or by the resolved transcript path) serves the archived predecessor row. */
  stubFetch((pin) => (pin === CONVERSATION_ID || pin === TARGET_PATH ? [otherRow, predecessorRow] : [otherRow]));

  const host = await mountViewer();

  /* The conversation's project is selected and its card materializes. */
  expect(await waitFor(() => host.querySelector(`[data-scheme-node="${TARGET_PATH}"]`) !== null)).toBe(true);
  expect(dom.localStorage.getItem("llvProject")).toBe(TARGET_PROJECT);
  /* The canonical link survives resolution. */
  expect(dom.location.hash).toBe(`#c=${encodeURIComponent(CONVERSATION_ID)}`);
  /* No visible failure state: this link RESOLVED. */
  expect(host.querySelector("[data-stale-focus-notice]")).toBeNull();
  await expectNavigationQuiescence();
});

test("#c= resolution OPENS the conversation and never navigates in a loop", async () => {
  dom.location.hash = `#c=${encodeURIComponent(CONVERSATION_ID)}`;
  stubFetch((pin) => (pin === CONVERSATION_ID || pin === TARGET_PATH ? [otherRow, predecessorRow] : [otherRow]));

  const host = await mountViewer();
  /* The loop oracle is conditioned on a SUCCESSFUL open: on the defective base
     the card never materializes and this assertion REDs. The first version of
     this test ignored the waitFor result and green-lit the base. */
  expect(await waitFor(() => host.querySelector(`[data-scheme-node="${TARGET_PATH}"]`) !== null)).toBe(true);
  /* The canonical link survives resolution untouched — the observed prod
     symptom retyped the same URL four times; here the resolver may retype the
     entry it stands on at most a bounded number of times, all replaces. */
  expect(dom.location.hash).toBe(`#c=${encodeURIComponent(CONVERSATION_ID)}`);
  expect(historyWrites.length).toBeLessThanOrEqual(3);
  await expectNavigationQuiescence();
});

test("#c= from a tab standing on another project switches to the target's project and opens", async () => {
  dom.localStorage.setItem("llvProject", "other-project");
  dom.location.hash = `#c=${encodeURIComponent(CONVERSATION_ID)}`;
  stubFetch((pin) => (pin === CONVERSATION_ID || pin === TARGET_PATH ? [otherRow, targetRow] : [otherRow]));

  const host = await mountViewer();

  expect(await waitFor(() => host.querySelector(`[data-scheme-node="${TARGET_PATH}"]`) !== null)).toBe(true);
  expect(dom.localStorage.getItem("llvProject")).toBe(TARGET_PROJECT);
  expect(host.querySelector("[data-stale-focus-notice]")).toBeNull();
  await expectNavigationQuiescence();
});

test("#c= whose row arrives only via the pinned fetch keeps its pin after resolving", async () => {
  dom.location.hash = `#c=${encodeURIComponent(CONVERSATION_ID)}`;
  stubFetch((pin) => (pin === CONVERSATION_ID || pin === TARGET_PATH ? [otherRow, targetRow] : [otherRow]));

  const host = await mountViewer();

  expect(await waitFor(() => host.querySelector(`[data-scheme-node="${TARGET_PATH}"]`) !== null)).toBe(true);
  expect(dom.localStorage.getItem("llvProject")).toBe(TARGET_PROJECT);
  await act(async () => { await Bun.sleep(200); });
  /* The scope transition after resolution serves an EMPTY placeholder before
     its own fetch lands; that placeholder must not release the hydrated pin.
     A released pin shows up here as a trailing UNPINNED /api/files request —
     and as the card evaporating from the board. */
  const filesRequests = requestLog.filter((url) => url.startsWith("/api/files"));
  expect(filesRequests.length).toBeGreaterThan(0);
  expect(filesRequests[filesRequests.length - 1]).toContain("path=");
  expect(host.querySelector(`[data-scheme-node="${TARGET_PATH}"]`)).not.toBeNull();
  await expectNavigationQuiescence();
});

test("legacy #f= to an archived predecessor transcript opens it the same way", async () => {
  dom.location.hash = `#f=${encodeURIComponent(TARGET_PATH)}`;
  /* Resolution retypes the entry to the canonical `#c=` form, so the follow-up
     intent pins by conversation id — the server answers both, and so does this
     stub. */
  stubFetch((pin) => (pin === TARGET_PATH || pin === CONVERSATION_ID ? [otherRow, predecessorRow] : [otherRow]));

  const host = await mountViewer();

  expect(await waitFor(() => host.querySelector(`[data-scheme-node="${TARGET_PATH}"]`) !== null)).toBe(true);
  expect(dom.localStorage.getItem("llvProject")).toBe(TARGET_PROJECT);
  await expectNavigationQuiescence();
});

test("an id no payload can resolve gets a visible notice, never a silent landing", async () => {
  dom.location.hash = "#c=conversation_nowhere-to-be-found";
  stubFetch(() => [otherRow]);

  const host = await mountViewer();

  /* Bounded by the same deadline a Back/Forward replay uses (8s). */
  expect(await waitFor(() => host.querySelector("[data-stale-focus-notice]") !== null, 10_000)).toBe(true);
  expect(host.textContent).toContain(en["viewer.staleFocusEntry"]);
  /* Failing must not navigate either: the hash the operator pasted stays. */
  await expectNavigationQuiescence();
}, 15_000);

test("a true-miss notice is DURABLE: it outlives the old self-dismiss window and clears on navigation", async () => {
  dom.location.hash = "#c=conversation_nowhere-to-be-found";
  stubFetch(() => [otherRow]);

  const host = await mountViewer();

  expect(await waitFor(() => host.querySelector("[data-stale-focus-notice]") !== null, 10_000)).toBe(true);
  /* Pre-fix the notice evaporated 6s after appearing while the dead #c= hash
     stayed put — the operator was back on the silent default view. */
  await act(async () => { await Bun.sleep(6_500); });
  expect(host.querySelector("[data-stale-focus-notice]")).not.toBeNull();
  /* Navigation is a legitimate exit: moving to a project retires the claim. */
  await act(async () => { dom.location.hash = "#p=other-project"; });
  expect(await waitFor(() => host.querySelector("[data-stale-focus-notice]") === null)).toBe(true);
}, 30_000);

test("the durable not-found notice has an explicit dismiss", async () => {
  dom.location.hash = "#c=conversation_nowhere-to-be-found";
  stubFetch(() => [otherRow]);

  const host = await mountViewer();

  expect(await waitFor(() => host.querySelector("[data-stale-focus-notice]") !== null, 10_000)).toBe(true);
  const dismiss = host.querySelector("[data-stale-focus-dismiss]") as HTMLElement | null;
  expect(dismiss).not.toBeNull();
  await act(async () => { dismiss!.click(); });
  expect(host.querySelector("[data-stale-focus-notice]")).toBeNull();
}, 20_000);
