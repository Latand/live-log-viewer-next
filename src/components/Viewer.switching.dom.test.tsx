/**
 * Switching profile and regression pins for issue #1432: switching between
 * conversations and between projects must be smooth and fast, measured.
 *
 * The real Viewer mounts here under fake timers over an invented corpus of
 * three conversation shapes (short, long, tool-heavy) in two projects (see
 * `switchingFixtures`). Every step records three things:
 *
 *   - virtual ms: how much fake time had to pass before the milestone showed
 *     (0 = it was on screen in the same synchronous flush as the gesture);
 *   - real ms: wall time since the gesture, read from the OS clock through a
 *     subprocess (every in-process clock is fake here) — nothing sleeps for
 *     real, so this is the work React, the parser and the layout did;
 *   - render counts: mounts and re-renders per component from the DevTools
 *     commit hook, so a switch that rebuilds the dashboard or re-renders every
 *     card is caught even when it is fast on this machine.
 *
 * The table is printed at the end so the same file produces the before and
 * after rows of the PR profile.
 */
import { afterAll, afterEach, beforeEach, expect, jest, mock, test } from "bun:test";
import { Window } from "happy-dom";

import { installActEnv } from "@/test-helpers/actEnv";
import { installRenderProbe } from "@/test-helpers/renderProbe";
import { appendedLine, fileEntryFor, switchingCorpus, transcriptText } from "@/test-helpers/switchingFixtures";
import { applyBoardMutations, type BoardMutationV1 } from "@/lib/board/mutations";
import { en } from "@/lib/i18n/en";
import type { FileEntry, LogChunk } from "@/lib/types";
import type { BoardProjectStateV1 } from "@/lib/view/types";
import { MOBILE_LAYOUT_QUERY } from "@/lib/attention/eligibility";

installActEnv();
/* Before react-dom loads: the renderer reads the DevTools hook once. */
const probe = installRenderProbe();

const dom = new Window({ url: "http://localhost/" });
let mobile = false;
const matchMedia = (query: string) => ({
  matches: mobile && (String(query) === MOBILE_LAYOUT_QUERY || String(query).includes("pointer: coarse")),
  media: String(query),
  onchange: null,
  addListener() {},
  removeListener() {},
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent() { return false; },
});
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
  TouchEvent: dom.TouchEvent,
  MutationObserver: dom.MutationObserver,
  /* The board camera reads its viewport size from the first ResizeObserver
     callback; without one it fits the world into a 0×0 box, zooms out to the
     floor and puts every pane to sleep (dormant), so no feed ever subscribes. */
  ResizeObserver: class {
    constructor(private readonly callback: (entries: Array<{ target: Element; contentRect: DOMRect }>) => void) {}
    observe(target: Element) { this.callback([{ target, contentRect: target.getBoundingClientRect() }]); }
    unobserve() {}
    disconnect() {}
  },
  /* Every pane is on screen: BranchPane pauses the feed of a pane its observer
     has not reported visible, so the double answers "intersecting" at once. */
  IntersectionObserver: class {
    constructor(private readonly callback: (entries: Array<{ isIntersecting: boolean }>) => void) {}
    observe() { this.callback([{ isIntersecting: true }]); }
    unobserve() {}
    disconnect() {}
    takeRecords() { return []; }
  },
  requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  matchMedia,
});
Object.assign(dom, { matchMedia });
(dom.HTMLElement.prototype as unknown as { animate: () => unknown }).animate = () => ({ cancel() {}, addEventListener() {} });
(dom.HTMLElement.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {};
/* happy-dom lays nothing out: every rect is 0×0. The board viewport is the one
   element whose size decides behaviour (the camera's fit and the dormant
   threshold), so it alone reports a desktop-sized box. */
const BOARD_RECT = { x: 0, y: 0, left: 0, top: 0, right: 1200, bottom: 800, width: 1200, height: 800, toJSON() {} };
const elementPrototype = dom.HTMLElement.prototype as unknown as { getBoundingClientRect(this: HTMLElement): unknown };
const realRect = elementPrototype.getBoundingClientRect;
elementPrototype.getBoundingClientRect = function (this: HTMLElement) {
  if ((this.getAttribute("aria-label") ?? "").startsWith("Agent board")) return BOARD_RECT;
  return realRect.call(this);
};

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

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { Viewer } = await import("./Viewer");
const { resetFilesClientCacheForTests } = await import("@/hooks/useFiles");
const { resetLogTailCacheForTests } = await import("@/hooks/useLogTail");
const { resetFeedSessionPoolForTests } = await import("./feed/sessionPool");
const { resetPendingOpensForTest, resetSelectionSessionsForTest } = await import("@/hooks/useBoardState");
const { OPEN_KEY } = await import("./orchestrator/OrchestratorDock");

/* ── corpus ─────────────────────────────────────────────────────────────── */

const corpus = switchingCorpus();
const byShape = (project: string, shape: string) => corpus.find((entry) => entry.project === project && entry.shape === shape)!;
const SHORT = byShape("alpha", "short");
const LONG = byShape("alpha", "long");
const TOOLS = byShape("alpha", "toolheavy");
const BETA_A = byShape("beta", "short");
const BETA_B = byShape("beta", "long");
/* Beyond the capped feed: served only to a pinned request, the way a deep link
   to an old conversation reaches the client. */
const GAMMA = { ...byShape("alpha", "short"), conversationId: "conv-alpha-gamma", path: "/sessions/alpha/gamma.jsonl", title: "Gamma archive" };

/** Live transcript bytes per path; a pushed tail record appends here. */
let transcripts = new Map<string, string>();
const bytes = (text: string) => new TextEncoder().encode(text).length;

function seedTranscripts(): void {
  transcripts = new Map([...corpus, GAMMA].map((entry) => [entry.path, transcriptText(entry.lines)]));
}

function tailChunk(path: string, offset: number): LogChunk | null {
  const text = transcripts.get(path) ?? "";
  const size = bytes(text);
  if (offset >= size) return null;
  return { data: text.slice(offset), offset: size, size, start: offset };
}

let appended = 0;
function appendRecord(path: string, project: string): void {
  appended += 1;
  transcripts.set(path, (transcripts.get(path) ?? "") + appendedLine(project, 5_000 + appended, String(appended)) + "\n");
}

function allFiles(): FileEntry[] {
  return [
    fileEntryFor(SHORT),
    /* The long conversation continues the short one: its card carries the
       lineage chip, which is one of the `#c=` deep links the addendum names. */
    fileEntryFor(LONG, { continues: { conversationId: SHORT.conversationId, path: SHORT.path, round: 1 } }),
    fileEntryFor(TOOLS),
    fileEntryFor(BETA_A),
    /* A cross-project link: a beta card that continues the alpha tool run. */
    fileEntryFor(BETA_B, { continues: { conversationId: TOOLS.conversationId, path: TOOLS.path, round: 2 } }),
  ];
}

const projectCatalog = [
  { project: "alpha", smt: 4_102_488_000, conversations: 4 },
  { project: "beta", smt: 4_102_487_000, conversations: 2 },
];

/* ── transport doubles ──────────────────────────────────────────────────── */

/** Server-side latency the fake transport charges every response. */
const RTT_MS = 20;
/** The log bus reconnects its stream on a short window for a subscriber that
    arrives on a settled stream (a switch), the long one for churn. */
const PROMPT_RECONNECT_MS = 40;

let boards: Record<string, BoardProjectStateV1> = {};
const emptyBoard = (): BoardProjectStateV1 => ({
  schemaVersion: 1,
  revision: 0,
  updatedAt: new Date(0).toISOString(),
  pathAliases: {},
  prefs: { manual: [], hidden: [], expanded: [], favorites: [], foldedEngineChildIds: [], expandedEngineTrayParentIds: [], viewMode: null, taskPanelOpen: false },
});
function seededBoard(manual: string[]): BoardProjectStateV1 {
  return { ...emptyBoard(), revision: 1, explicitManual: manual, prefs: { ...emptyBoard().prefs, manual } };
}

const requests: string[] = [];
const delayed = <T,>(value: T): Promise<T> => new Promise((resolve) => setTimeout(() => resolve(value), RTT_MS));

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  requests.push(url);
  const method = (init?.method ?? "GET").toUpperCase();
  if (url.startsWith("/api/files")) {
    const pin = new URL(url, "http://localhost").searchParams.get("path") ?? "";
    const files = pin === GAMMA.conversationId || pin === GAMMA.path ? [...allFiles(), fileEntryFor(GAMMA)] : allFiles();
    return delayed(Response.json({ files, projectCatalog, flows: [], pipelines: [], workflows: [], tasks: [], systemHealth: { tmux: { status: "healthy" } } }));
  }
  if (url.startsWith("/api/board")) {
    if (method === "GET") {
      const project = new URL(url, "http://localhost").searchParams.get("project") ?? "";
      return delayed(Response.json({ ok: true, board: boards[project] ?? emptyBoard() }));
    }
    const body = JSON.parse(String(init?.body)) as { project: string; mutations?: BoardMutationV1[] };
    const current = boards[body.project] ?? emptyBoard();
    const reduced = applyBoardMutations(current, body.mutations ?? []);
    const next = { ...reduced, schemaVersion: 1 as const, revision: current.revision + 1, updatedAt: new Date(0).toISOString(), pathAliases: reduced.pathAliases ?? {} };
    boards[body.project] = next;
    return delayed(Response.json({ ok: true, applied: true, board: next }));
  }
  if (url === "/api/logs" && method === "POST") {
    const { reqs } = JSON.parse(String(init?.body)) as { reqs: Array<{ id: string; path: string; offset: number }> };
    const chunks: Record<string, LogChunk> = {};
    for (const req of reqs) {
      const size = bytes(transcripts.get(req.path) ?? "");
      chunks[req.id] = tailChunk(req.path, req.offset) ?? { data: "", offset: size, size, start: req.offset };
    }
    return delayed(Response.json({ chunks }));
  }
  if (url.startsWith("/api/log?")) return delayed(Response.json({ data: "", offset: 0, start: 0, size: 0 }));
  return delayed(new Response("not found", { status: 404 }));
}) as unknown as typeof fetch;

/**
 * The tail stream as the browser sees it: one EventSource per subscription
 * set, answering each subscription from its offset after RTT_MS, and pushing
 * whatever `appendRecord` added when the test says the tail moved.
 */
class FakeEventSource {
  static open: FakeEventSource[] = [];
  static connects = 0;
  private listeners = new Map<string, Set<(event: { data: string }) => void>>();
  private closed = false;
  readonly subs: Array<{ id: string; path: string; offset: number }>;
  onerror: (() => void) | null = null;
  constructor(url: string) {
    FakeEventSource.connects += 1;
    this.subs = JSON.parse(new URL(url, "http://localhost").searchParams.get("subs") ?? "[]") as FakeEventSource["subs"];
    FakeEventSource.open.push(this);
    setTimeout(() => {
      if (this.closed) return;
      for (const sub of this.subs) this.deliver(sub);
    }, RTT_MS);
  }
  addEventListener(type: string, listener: (event: { data: string }) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }
  removeEventListener(type: string, listener: (event: { data: string }) => void): void {
    this.listeners.get(type)?.delete(listener);
  }
  close(): void {
    this.closed = true;
    FakeEventSource.open = FakeEventSource.open.filter((source) => source !== this);
  }
  private deliver(sub: { id: string; path: string; offset: number }): void {
    const chunk = tailChunk(sub.path, sub.offset);
    if (!chunk) return;
    sub.offset = chunk.offset;
    for (const listener of this.listeners.get("chunk") ?? []) listener({ data: JSON.stringify({ id: sub.id, chunk }) });
  }
  /** The tail of `path` grew: every open subscription for it gets the delta after RTT_MS. */
  static push(path: string): void {
    for (const source of [...FakeEventSource.open]) {
      for (const sub of source.subs) {
        if (sub.path !== path) continue;
        setTimeout(() => { if (!source.closed) source.deliver(sub); }, RTT_MS);
      }
    }
  }
}
(globalThis as { EventSource?: unknown }).EventSource = FakeEventSource;

/* ── clock, settling, measurement ───────────────────────────────────────── */

/* Under bun's fake timers EVERY in-process clock — Date, performance,
   process.hrtime, Bun.nanoseconds — advances only with the fake time, so real
   CPU cost is unmeasurable from JS. A subprocess reads the OS clock (~1 ms per
   read); it is read once at the start of a step and once at each milestone,
   never inside the settle loop. Nothing here sleeps for real, so the elapsed
   real time of a step is the work React, the parser and the layout did. */
function realNowMs(): number {
  return Number(Buffer.from(Bun.spawnSync(["date", "+%s%N"]).stdout).toString().trim()) / 1e6;
}
let stepStartedAt = realNowMs();
/** Start a measured step: render counts and the real clock both restart. */
function beginStep(): void {
  probe.reset();
  stepStartedAt = realNowMs();
}
async function flush(): Promise<void> {
  await act(async () => {
    for (let round = 0; round < 12; round += 1) await Promise.resolve();
  });
}
/** Let `ms` of fake time pass, then settle. */
async function advance(ms: number): Promise<void> {
  await act(async () => {
    jest.advanceTimersByTime(ms);
    for (let round = 0; round < 12; round += 1) await Promise.resolve();
  });
  await flush();
}

interface Milestone {
  virtualMs: number;
  /** Real milliseconds since `beginStep`, cumulative within the step. */
  workMs: number;
}
let currentHost: HTMLElement | null = null;
/** What the harness can see when a milestone never arrives. */
function describeHost(): string {
  const host = currentHost;
  if (!host) return "no host";
  const nodes = Array.from(host.querySelectorAll("[data-scheme-node]")).map((element) => element.getAttribute("data-scheme-node"));
  const tails = Array.from(host.querySelectorAll("[data-tail-line-count]")).map((element) => element.getAttribute("data-tail-line-count"));
  return [
    `nodes=${JSON.stringify(nodes)}`,
    `skeleton=${host.querySelector('[role="status"][aria-busy="true"]') !== null}`,
    `feedRows=${host.querySelectorAll("[data-feed-kind]").length}`,
    `tailLineCounts=${JSON.stringify(tails)}`,
    `streams=${FakeEventSource.connects} open=${FakeEventSource.open.length}`,
    `requests=${JSON.stringify(requests.slice(-8))}`,
    `text=${(host.textContent ?? "").slice(0, 300)}`,
  ].join("\n");
}

/** Fake ms (in 5 ms steps) until `check` holds; throws after `maxMs`. */
async function until(check: () => boolean, maxMs = 5_000): Promise<Milestone> {
  await flush();
  let virtualMs = 0;
  while (!check()) {
    if (virtualMs >= maxMs) throw new Error(`milestone not reached within ${maxMs} virtual ms\n${describeHost()}`);
    await advance(5);
    virtualMs += 5;
  }
  return { virtualMs, workMs: realNowMs() - stepStartedAt };
}

interface Row {
  surface: string;
  step: string;
  virtualMs: number | string;
  workMs: number | string;
  renders: string;
}
const rows: Row[] = [];
const record = (surface: string, step: string, milestone: Milestone, renders = ""): void => {
  rows.push({ surface, step, virtualMs: milestone.virtualMs, workMs: Math.round(milestone.workMs), renders });
};

afterAll(() => {
  const header = "| surface | step | fake ms until on screen | real ms since gesture | renders / mounts |\n|---|---|---:|---:|---|";
  const body = rows.map((row) => `| ${row.surface} | ${row.step} | ${row.virtualMs} | ${row.workMs} | ${row.renders} |`).join("\n");
  console.log(`\n#1432 switching profile (bun DOM, fake timers)\n${header}\n${body}\n`);
  probe.uninstall();
});

/* ── harness ────────────────────────────────────────────────────────────── */

let mounted: { unmount: () => void } | null = null;

beforeEach(() => {
  jest.useFakeTimers();
  mobile = false;
  seedTranscripts();
  appended = 0;
  requests.length = 0;
  FakeEventSource.open = [];
  FakeEventSource.connects = 0;
  boards = {
    alpha: seededBoard([SHORT.path, LONG.path, TOOLS.path]),
    beta: seededBoard([BETA_A.path, BETA_B.path]),
  };
  dom.localStorage.clear();
  dom.sessionStorage.clear();
  dom.location.hash = "";
  document.body.replaceChildren();
  resetFilesClientCacheForTests();
  resetLogTailCacheForTests();
  resetFeedSessionPoolForTests();
  resetPendingOpensForTest();
  resetSelectionSessionsForTest();
  beginStep();
});

afterEach(() => {
  if (mounted) {
    const root = mounted;
    mounted = null;
    act(() => { root.unmount(); });
  }
  document.body.replaceChildren();
  dom.location.hash = "";
  /* happy-dom delivers hashchange on a window timer. Under fake timers that
     timer only fires when advanced; leaving it pending across useRealTimers
     wedges every later hashchange in this process, so drain it now with no
     listeners left. */
  jest.advanceTimersByTime(50);
  jest.useRealTimers();
});

async function mountViewer(project: string): Promise<HTMLElement> {
  dom.localStorage.setItem("llvProject", project);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted = root;
  await act(async () => { root.render(<Viewer />); });
  await flush();
  currentHost = host as unknown as HTMLElement;
  return currentHost;
}

const node = (host: HTMLElement, path: string) => host.querySelector(`[data-scheme-node="${path}"]`);
const ringed = (host: HTMLElement, path: string) => (node(host, path)?.querySelector(":scope > .ring-2") ?? null) !== null;
/* A conversation pane on either surface: the board card's section and the
   phone's focused pane both carry the transcript path as their link target. */
const pane = (host: HTMLElement, path: string) => host.querySelector(`[data-link-path="${path}"]`);
const feedRows = (host: HTMLElement, path: string) => pane(host, path)?.querySelectorAll("[data-feed-kind]").length ?? 0;
const tailLines = (scope: Element | null) => Number(scope?.querySelector("[data-tail-line-count]")?.getAttribute("data-tail-line-count") ?? "0");
const skeleton = (host: HTMLElement) => host.querySelector('[role="status"][aria-busy="true"]') !== null;
const railButton = (host: HTMLElement, label: string) =>
  Array.from(host.querySelectorAll("button")).find((button) => (button.textContent ?? "").trim().startsWith(label)) as HTMLButtonElement | undefined;
const currentRail = (host: HTMLElement) => (host.querySelector('button[aria-current="page"]')?.textContent ?? "").trim();

function dispatch(target: EventTarget, event: unknown): boolean {
  return target.dispatchEvent(event as Event);
}
async function click(element: Element): Promise<void> {
  await act(async () => {
    dispatch(element, new dom.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}
async function keydown(key: string): Promise<void> {
  await act(async () => {
    dispatch(window, new dom.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
}
/** A browser's default action on an in-document `#…` link: change the hash,
    unless the click was handled in-app. */
async function clickAnchor(anchor: HTMLAnchorElement): Promise<{ handledInApp: boolean }> {
  let handledInApp = false;
  await act(async () => {
    const event = new dom.MouseEvent("click", { bubbles: true, cancelable: true });
    const notPrevented = dispatch(anchor, event);
    handledInApp = !notPrevented;
    const href = anchor.getAttribute("href") ?? "";
    if (notPrevented && href.startsWith("#") && dom.location.hash !== href) dom.location.hash = href;
  });
  return { handledInApp };
}

/** Whether the cold feeds of every path have painted: rows in each card. */
const painted = (host: HTMLElement, paths: string[]) => paths.every((path) => feedRows(host, path) > 0);

async function mountAlphaDesktop(): Promise<{ host: HTMLElement; paint: Milestone }> {
  const host = await mountViewer("alpha");
  const paint = await until(() => painted(host, [SHORT.path, LONG.path, TOOLS.path]));
  return { host, paint };
}

/* ── desktop ────────────────────────────────────────────────────────────── */

test("desktop: an in-app «Open conversation» link focuses the card without rebuilding the board", async () => {
  dom.localStorage.setItem(`${OPEN_KEY}:alpha`, "1");
  const { host, paint } = await mountAlphaDesktop();
  const boot = probe.snapshot();
  expect(boot.mounts.ProjectDashboardView ?? 0).toBe(1);
  expect(boot.mounts.OrchestratorDock ?? 0).toBe(1);
  expect(boot.mounts.OrchestratorPanel ?? 0).toBe(1);
  record("desktop", "mount → three cards painted (cold)", paint, `NodeShell mounts ${boot.mounts.NodeShell ?? 0}, LogFeed renders ${boot.renders.LogFeed ?? 0}`);

  /* The lineage chip on the long card deep-links the short one. */
  const chip = node(host, LONG.path)?.querySelector("a[data-continues-chip]") as HTMLAnchorElement | null;
  expect(chip).not.toBeNull();
  beginStep();
  let sawSkeleton = false;
  const { handledInApp } = await clickAnchor(chip!);
  sawSkeleton ||= skeleton(host);
  const highlight = await until(() => {
    sawSkeleton ||= skeleton(host);
    return ringed(host, SHORT.path);
  });
  const after = probe.snapshot();
  const otherFeedRenders = [LONG.path, TOOLS.path].reduce((sum, path) => sum + probe.rendersFor("LogFeed", path), 0);
  record("desktop", "«Open conversation» link → target ringed", highlight,
    `in-app ${handledInApp ? "yes" : "no (hash navigation)"}; skeleton ${sawSkeleton ? "shown" : "never"}; dashboard mounts +${after.mounts.ProjectDashboardView ?? 0}; dock mounts +${after.mounts.OrchestratorDock ?? 0}; orchestrator panel mounts +${after.mounts.OrchestratorPanel ?? 0}; NodeShell mounts +${after.mounts.NodeShell ?? 0}; other cards' LogFeed renders ${otherFeedRenders}; /api/files requests ${requests.filter((url) => url.startsWith("/api/files")).length}`);

  /* Issue #1432 acceptance: no dashboard remount, no orchestrator panel
     reload, no card rebuild, and the highlight lands in the same flush. */
  expect(handledInApp).toBe(true);
  expect(sawSkeleton).toBe(false);
  expect(after.mounts.ProjectDashboardView ?? 0).toBe(0);
  expect(after.mounts.OrchestratorDock ?? 0).toBe(0);
  expect(after.mounts.OrchestratorPanel ?? 0).toBe(0);
  expect(after.mounts.NodeShell ?? 0).toBe(0);
  expect(highlight.virtualMs).toBe(0);
  /* The URL still carries the deep link, so reload and share keep working. */
  expect(dom.location.hash).toBe(`#c=${encodeURIComponent(SHORT.conversationId)}`);
  /* Focusing one card must not re-render the feeds of the others. */
  expect(otherFeedRenders).toBe(0);
});

test("desktop: a cross-project link switches the project, then focuses — from the last known catalog", async () => {
  const { host } = await mountAlphaDesktop();
  /* A focus has already happened in this session: the lineage chip on the
     long card ringed the short one. The cross-project open below must still
     move, which it did not while the request nonce restarted after the
     project switch cleared the request (the real-browser profile's sequence). */
  await clickAnchor(node(host, LONG.path)?.querySelector("a[data-continues-chip]") as HTMLAnchorElement);
  await until(() => ringed(host, SHORT.path));
  /* Visit beta once so its board is known, then come back. */
  await click(railButton(host, "beta")!);
  await until(() => painted(host, [BETA_A.path, BETA_B.path]));
  beginStep();
  const filesBefore = requests.filter((url) => url.startsWith("/api/files")).length;

  const chip = node(host, BETA_B.path)?.querySelector("a[data-continues-chip]") as HTMLAnchorElement | null;
  expect(chip).not.toBeNull();
  let sawSkeleton = false;
  const { handledInApp } = await clickAnchor(chip!);
  const switched = await until(() => {
    sawSkeleton ||= skeleton(host);
    return currentRail(host).startsWith("alpha");
  });
  const boardPaint = await until(() => {
    sawSkeleton ||= skeleton(host);
    return painted(host, [SHORT.path, LONG.path, TOOLS.path]);
  });
  const highlight = await until(() => ringed(host, TOOLS.path));
  const after = probe.snapshot();
  record("desktop", "cross-project link → rail switched", switched, `in-app ${handledInApp ? "yes" : "no"}`);
  record("desktop", "cross-project link → alpha cards painted from cache", { virtualMs: switched.virtualMs + boardPaint.virtualMs, workMs: boardPaint.workMs }, `skeleton ${sawSkeleton ? "shown" : "never"}; dashboard mounts +${after.mounts.ProjectDashboardView ?? 0}; LogFeed renders ${after.renders.LogFeed ?? 0}; /api/files requests +${requests.filter((url) => url.startsWith("/api/files")).length - filesBefore}`);
  record("desktop", "cross-project link → target ringed", { virtualMs: switched.virtualMs + boardPaint.virtualMs + highlight.virtualMs, workMs: highlight.workMs });

  expect(handledInApp).toBe(true);
  expect(sawSkeleton).toBe(false);
  expect(after.mounts.ProjectDashboardView ?? 0).toBe(0);
  expect(switched.virtualMs).toBe(0);
  expect(boardPaint.virtualMs).toBe(0);
  expect(dom.location.hash).toBe(`#c=${encodeURIComponent(TOOLS.conversationId)}`);
});

test("desktop: a project switch paints the revisited board synchronously and never remounts the dashboard", async () => {
  const { host } = await mountAlphaDesktop();
  beginStep();

  /* First visit: the board GET is the only thing that can gate the paint. */
  let sawSkeleton = false;
  await click(railButton(host, "beta")!);
  const railFirst = await until(() => currentRail(host).startsWith("beta"));
  const firstPaint = await until(() => {
    sawSkeleton ||= skeleton(host);
    return painted(host, [BETA_A.path, BETA_B.path]);
  });
  const firstVisit = probe.snapshot();
  record("desktop", "project switch (first visit) → rail highlight", railFirst);
  record("desktop", "project switch (first visit) → cards painted (cold)", firstPaint, `skeleton ${sawSkeleton ? "shown while /api/board loads" : "never"}; dashboard mounts +${firstVisit.mounts.ProjectDashboardView ?? 0}; NodeShell mounts ${firstVisit.mounts.NodeShell ?? 0}`);

  /* Revisit: everything is known — the board, the tails, the parsed feeds. */
  beginStep();
  sawSkeleton = false;
  await click(railButton(host, "alpha")!);
  const railBack = await until(() => currentRail(host).startsWith("alpha"));
  const revisitPaint = await until(() => {
    sawSkeleton ||= skeleton(host);
    return painted(host, [SHORT.path, LONG.path, TOOLS.path]);
  });
  const revisit = probe.snapshot();
  record("desktop", "project switch (revisit) → rail highlight", railBack);
  record("desktop", "project switch (revisit) → cards painted from cache", revisitPaint, `skeleton ${sawSkeleton ? "shown" : "never"}; dashboard mounts +${revisit.mounts.ProjectDashboardView ?? 0}; NodeShell mounts ${revisit.mounts.NodeShell ?? 0}; LogFeed renders ${revisit.renders.LogFeed ?? 0}`);
  /* A fresh catalog does not gate any of this: the files feed is global. */
  const catalogRequests = requests.filter((url) => url.startsWith("/api/files")).length;

  expect(railFirst.virtualMs).toBe(0);
  expect(railBack.virtualMs).toBe(0);
  expect(firstVisit.mounts.ProjectDashboardView ?? 0).toBe(0);
  expect(revisit.mounts.ProjectDashboardView ?? 0).toBe(0);
  expect(sawSkeleton).toBe(false);
  expect(revisitPaint.virtualMs).toBe(0);
  expect(catalogRequests).toBe(1);
});

test("desktop: moving the focus between cards re-renders only the cards whose ring changed", async () => {
  const { host } = await mountAlphaDesktop();
  /* First move through the in-app link channel (the long card's chip focuses
     the short one), second move by clicking another card on the board. Both
     are gestures the board answers without a network round trip. */
  const chip = node(host, LONG.path)?.querySelector("a[data-continues-chip]") as HTMLAnchorElement;
  await clickAnchor(chip);
  await until(() => ringed(host, SHORT.path));
  beginStep();
  /* Second move: the switchboard-style select of another card on the board. */
  const toolsCard = node(host, TOOLS.path)!;
  await act(async () => {
    dispatch(toolsCard, new dom.MouseEvent("pointerdown", { bubbles: true, cancelable: true }));
    dispatch(toolsCard, new dom.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await flush();
  const after = probe.snapshot();
  record("desktop", "focus moves short → tool-heavy (click on card)", { virtualMs: 0, workMs: realNowMs() - stepStartedAt },
    `NodeShell renders ${after.renders.NodeShell ?? 0} (${Object.entries(after.byPath).filter(([key]) => key.startsWith("NodeShell:")).length} cards); LogFeed renders ${after.renders.LogFeed ?? 0}; BranchPane renders ${after.renders.BranchPane ?? 0}; dashboard renders ${after.renders.ProjectDashboardView ?? 0}`);
  /* The long card is neither the previous nor the new focus: nothing about it
     changed on screen, so it must not have rendered. */
  expect(probe.rendersFor("NodeShell", LONG.path)).toBe(0);
  expect(probe.rendersFor("LogFeed", LONG.path)).toBe(0);
});

test("desktop: a fresh tail record on one card leaves the other cards' panes untouched", async () => {
  const { host } = await mountAlphaDesktop();
  const rowsBefore = feedRows(host, SHORT.path);
  const firstRow = pane(host, SHORT.path)!.querySelector("[data-feed-key]");
  beginStep();
  appendRecord(SHORT.path, "alpha");
  FakeEventSource.push(SHORT.path);
  const fresh = await until(() => feedRows(host, SHORT.path) > rowsBefore);
  const after = probe.snapshot();
  const otherFeedRenders = [LONG.path, TOOLS.path].reduce((sum, path) => sum + probe.rendersFor("LogFeed", path), 0);
  record("desktop", "fresh tail record → appended to the short card", fresh,
    `LogFeed renders ${after.renders.LogFeed ?? 0}; other cards' LogFeed renders ${otherFeedRenders}; NodeShell renders ${after.renders.NodeShell ?? 0}; first row node preserved ${pane(host, SHORT.path)!.querySelector("[data-feed-key]") === firstRow ? "yes" : "no"}`);
  expect(fresh.virtualMs).toBeLessThanOrEqual(PROMPT_RECONNECT_MS + RTT_MS + 5);
  expect(pane(host, SHORT.path)!.querySelector("[data-feed-key]")).toBe(firstRow);
  expect(otherFeedRenders).toBe(0);
});

test("desktop: an Arrow key moves the ring to the neighbour card and re-renders nothing else", async () => {
  const { host } = await mountAlphaDesktop();
  const shortCard = node(host, SHORT.path)!;
  await act(async () => {
    dispatch(shortCard, new dom.MouseEvent("pointerdown", { bubbles: true, cancelable: true }));
    dispatch(shortCard, new dom.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await until(() => ringed(host, SHORT.path));
  beginStep();
  await keydown("ArrowRight");
  const moved = await until(() => !ringed(host, SHORT.path) && [LONG.path, TOOLS.path].some((path) => ringed(host, path)));
  const after = probe.snapshot();
  const target = [LONG.path, TOOLS.path].find((path) => ringed(host, path))!;
  const untouched = [LONG.path, TOOLS.path].find((path) => path !== target)!;
  record("desktop", "ArrowRight → ring moves to the neighbour card", moved,
    `NodeShell renders ${after.renders.NodeShell ?? 0}; LogFeed renders ${after.renders.LogFeed ?? 0}; untouched card NodeShell renders ${probe.rendersFor("NodeShell", untouched)}; dashboard renders ${after.renders.ProjectDashboardView ?? 0}`);
  expect(moved.virtualMs).toBe(0);
  expect(probe.rendersFor("NodeShell", untouched)).toBe(0);
  expect(probe.rendersFor("LogFeed", untouched)).toBe(0);
});

test("desktop: a cold deep link from the URL still resolves a beyond-cap conversation", async () => {
  dom.location.hash = `#c=${encodeURIComponent(GAMMA.conversationId)}`;
  const host = await mountViewer("beta");
  const resolved = await until(() => node(host, GAMMA.path) !== null);
  record("desktop", "cold URL deep link (beyond cap) → card on board", resolved, `/api/files requests ${requests.filter((url) => url.startsWith("/api/files")).length}`);
  expect(currentRail(host).startsWith("alpha")).toBe(true);
  expect(dom.location.hash).toBe(`#c=${encodeURIComponent(GAMMA.conversationId)}`);
  expect(host.querySelector("[data-stale-focus-notice]")).toBeNull();
});

/* ── phone (390px) ──────────────────────────────────────────────────────── */

const focusedPane = (host: HTMLElement) => host.querySelector('[data-testid="mobile-focused-pane"]');
const focusedTitle = (host: HTMLElement) => focusedPane(host)?.querySelector("header")?.textContent ?? "";
const chipFor = (host: HTMLElement, title: string) => host.querySelector(`button[title="${title}"]`) as HTMLButtonElement | null;
const chipActive = (host: HTMLElement, title: string) => chipFor(host, title)?.className.includes("border-accent/60") ?? false;

function swipe(header: HTMLElement, dx: number): void {
  const start = { clientX: 200, clientY: 40 };
  const end = { clientX: 200 + dx, clientY: 40 };
  dispatch(header, new dom.TouchEvent("touchstart", { bubbles: true, touches: [start] } as never));
  dispatch(header, new dom.TouchEvent("touchend", { bubbles: true, changedTouches: [end] } as never));
}

test("phone: A → B → A shows A's previous rows synchronously, then the fresh tail lands without a flash", async () => {
  mobile = true;
  const host = await mountViewer("alpha");
  const firstPane = await until(() => focusedPane(host) !== null && tailLines(focusedPane(host)) > 0);
  const firstTitle = focusedTitle(host);
  record("phone", `mount → focused pane (${firstTitle.includes("Tool") ? "tool-heavy" : firstTitle.includes("Long") ? "long" : "short"}) painted (cold)`, firstPane);

  /* A: the short conversation. Cold unless the first pane already was it. */
  beginStep();
  await click(chipFor(host, SHORT.title)!);
  const aChip = await until(() => chipActive(host, SHORT.title));
  const aRows = await until(() => focusedTitle(host).includes(SHORT.title) && tailLines(focusedPane(host)) === SHORT.lines.length);
  record("phone", "tap chip A (cold) → chip highlighted", aChip);
  record("phone", "tap chip A (cold) → A rows painted", { virtualMs: aChip.virtualMs + aRows.virtualMs, workMs: aRows.workMs }, `LogFeed renders ${probe.renders("LogFeed")}`);

  /* B: the long conversation, cold. */
  beginStep();
  await click(chipFor(host, LONG.title)!);
  const bChip = await until(() => chipActive(host, LONG.title));
  const bRows = await until(() => focusedTitle(host).includes(LONG.title) && tailLines(focusedPane(host)) === LONG.lines.length);
  record("phone", "tap chip B (cold, long) → chip highlighted", bChip);
  record("phone", "tap chip B (cold, long) → B rows painted", { virtualMs: bChip.virtualMs + bRows.virtualMs, workMs: bRows.workMs }, `LogFeed renders ${probe.renders("LogFeed")}`);

  /* Back to A: cached. The rows must be there in the same flush as the tap. */
  beginStep();
  await click(chipFor(host, SHORT.title)!);
  const backChip = await until(() => chipActive(host, SHORT.title));
  const cachedRows = await until(() => focusedTitle(host).includes(SHORT.title) && feedRows(host, SHORT.path) > 0);
  const cached = probe.snapshot();
  record("phone", "tap chip A again (cached) → chip highlighted", backChip);
  record("phone", "tap chip A again (cached) → A's previous rows on screen", { virtualMs: backChip.virtualMs + cachedRows.virtualMs, workMs: cachedRows.workMs }, `LogFeed renders ${cached.renders.LogFeed ?? 0}; MobileFocusView mounts +${cached.mounts.MobileFocusView ?? 0}; dashboard mounts +${cached.mounts.ProjectDashboardView ?? 0}`);
  expect(backChip.virtualMs).toBe(0);
  expect(cachedRows.virtualMs).toBe(0);
  expect(cached.mounts.ProjectDashboardView ?? 0).toBe(0);
  expect(cached.mounts.MobileFocusView ?? 0).toBe(0);
  expect(feedRows(host, SHORT.path)).toBeGreaterThan(0);

  /* The tail moves: the new record appends; the rows already on screen keep
     their DOM nodes (no flash, no remount). */
  const firstRow = focusedPane(host)!.querySelector("[data-feed-key]");
  const rowsBefore = feedRows(host, SHORT.path);
  beginStep();
  appendRecord(SHORT.path, "alpha");
  FakeEventSource.push(SHORT.path);
  const fresh = await until(() => feedRows(host, SHORT.path) > rowsBefore);
  record("phone", "fresh tail record → appended to A", fresh, `first row node preserved ${focusedPane(host)!.querySelector("[data-feed-key]") === firstRow ? "yes" : "no"}`);
  expect(focusedPane(host)!.querySelector("[data-feed-key]")).toBe(firstRow);
  expect(fresh.virtualMs).toBeLessThanOrEqual(PROMPT_RECONNECT_MS + RTT_MS + 5);
});

test("phone: the header swipe hops panes with the same cached paint", async () => {
  mobile = true;
  const host = await mountViewer("alpha");
  await until(() => focusedPane(host) !== null && tailLines(focusedPane(host)) > 0);
  /* Visit both neighbours once so their feeds are cached. */
  await click(chipFor(host, SHORT.title)!);
  await until(() => focusedTitle(host).includes(SHORT.title) && tailLines(focusedPane(host)) > 0);
  await click(chipFor(host, LONG.title)!);
  await until(() => focusedTitle(host).includes(LONG.title) && tailLines(focusedPane(host)) > 0);
  await click(chipFor(host, TOOLS.title)!);
  await until(() => focusedTitle(host).includes(TOOLS.title) && tailLines(focusedPane(host)) > 0);
  /* Strip order is layout order; a swipe hops to the neighbour. */
  const chips = Array.from(host.querySelectorAll('button[title]')).map((button) => button.getAttribute("title") ?? "").filter((title) => [SHORT.title, LONG.title, TOOLS.title].includes(title));
  const index = chips.indexOf(TOOLS.title);
  const target = index > 0 ? chips[index - 1]! : chips[index + 1]!;
  const dx = index > 0 ? 120 : -120;

  beginStep();
  await act(async () => { swipe(focusedPane(host)!.querySelector("header") as HTMLElement, dx); });
  const hop = await until(() => focusedTitle(host).includes(target) && chipActive(host, target));
  const rowsOnScreen = await until(() => feedRows(host, byShape("alpha", target === SHORT.title ? "short" : target === LONG.title ? "long" : "toolheavy").path) > 0);
  record("phone", "header swipe → neighbour pane highlighted", hop);
  record("phone", "header swipe → neighbour rows (cached) on screen", { virtualMs: hop.virtualMs + rowsOnScreen.virtualMs, workMs: rowsOnScreen.workMs }, `LogFeed renders ${probe.renders("LogFeed")}`);
  expect(hop.virtualMs).toBe(0);
  expect(rowsOnScreen.virtualMs).toBe(0);
});

test("phone: switching project through the project sheet paints the revisited board from cache", async () => {
  mobile = true;
  const host = await mountViewer("alpha");
  await until(() => focusedPane(host) !== null && tailLines(focusedPane(host)) > 0);
  /* The bar's title cell is the project switcher (mobile v2 lane 1): it opens
     the project sheet over the board, and a row replaces the board. */
  const openProjects = () => host.querySelector(`[data-mobile2-open="projects"]`) as HTMLButtonElement;
  const projectRow = (project: string) => host.querySelector(`[data-mobile2-project="${project}"]`) as HTMLButtonElement;

  await click(openProjects());
  await click(projectRow("beta"));
  await until(() => focusedPane(host) !== null && focusedTitle(host).includes("Beta") && tailLines(focusedPane(host)) > 0);

  beginStep();
  let sawSkeleton = false;
  await click(openProjects());
  await click(projectRow("alpha"));
  const paint = await until(() => {
    sawSkeleton ||= skeleton(host);
    return focusedPane(host) !== null && !focusedTitle(host).includes("Beta") && feedRows(host, SHORT.path) + feedRows(host, LONG.path) + feedRows(host, TOOLS.path) > 0;
  });
  const after = probe.snapshot();
  record("phone", "drawer project switch (revisit) → focused pane painted from cache", paint, `skeleton ${sawSkeleton ? "shown" : "never"}; dashboard mounts +${after.mounts.ProjectDashboardView ?? 0}; MobileFocusView mounts +${after.mounts.MobileFocusView ?? 0}; BranchPane mounts ${after.mounts.BranchPane ?? 0}`);
  expect(sawSkeleton).toBe(false);
  expect(paint.virtualMs).toBe(0);
  expect(after.mounts.ProjectDashboardView ?? 0).toBe(0);
  /* Exactly one pane mounts: the remembered focus, not a wrong first guess
     that is torn down a frame later. */
  expect(after.mounts.BranchPane ?? 0).toBe(1);
});
