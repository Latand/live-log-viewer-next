import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { emptyStore } from "@/components/runtime/runtimeModel";
import type { Pipeline } from "@/lib/pipelines/types";
import type { FileEntry } from "@/lib/types";

/*
 * The phone's CONVERSATION SCREEN (docs/design/mobile-v2/README.md §3.2, §3.3,
 * §4.2; issue #1439 lane 3), on the real component inside the real shell.
 *
 * What the screen replaced: a 56 px strip carrying the pinned seat, a scroller
 * of engine-labelled chips ("Claude · Claude · Claude"), the pipeline hop chips
 * and a right cluster of map and task buttons — and, under it, a pane header
 * with five to six 44 px controls that left the title one to four characters.
 *
 * What must hold in its place:
 *  - the bar carries the title on one line and a meta line under it whose state
 *    phrase never truncates, with `stage k/n` only while this conversation is
 *    the stage its pipeline is on;
 *  - the title cell is the switcher, and a row REPLACES the top of the stack,
 *    so ‹ still leaves the way the operator came in;
 *  - a swipe across the bar walks the switcher's order and bumps at its ends;
 *  - ‹ from a stage conversation returns to the pipeline it came from.
 */

const actualRuntimeHooks = await import("@/hooks/useRuntime");
const actualLogTail = await import("@/hooks/useLogTail");
const liveRuntime = { enabled: false, connection: "live" as const, resyncedAt: null, store: emptyStore() };
mock.module("@/hooks/useRuntime", () => ({
  ...actualRuntimeHooks,
  useRuntimeBusState: () => ({ ...liveRuntime, lastEventAt: null }),
  useRuntime: () => liveRuntime,
  useRuntimeSession: () => null,
  useRuntimeSessionByArtifact: () => null,
  useRuntimeReceiptsForArtifact: () => [],
  useRuntimeFlow: () => null,
}));
mock.module("@/hooks/useLogTail", () => ({
  useLogTail: () => ({
    lines: [], linesStart: 0, size: 0, loading: false, error: null, tickTime: null,
    paused: false, setPaused: () => undefined, clear: () => undefined,
    hasMore: false, loadingOlder: false, loadOlder: async () => 0, prependGen: 0,
  }),
}));

const { MobileFocusView, BUMP_MS } = await import("./MobileFocusView");
import type { MobileNav, MobileNavHost } from "./mobileNav";

const { MobileNavContext, createMobileNav, topScreen } = await import("./mobileNav");

const dom = new Window({ url: "http://localhost/#p=demo" });
const G = globalThis as Record<string, unknown>;
const OVERRIDES: Record<string, unknown> = {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLButtonElement: dom.HTMLButtonElement,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
  MouseEvent: dom.MouseEvent,
  sessionStorage: dom.sessionStorage,
  localStorage: dom.localStorage,
  /* The phone layout: useIsMobile must answer true. */
  matchMedia: (q: string) => ({ matches: true, media: String(q), onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } }),
  requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } },
};
const HAS: Record<string, boolean> = {};
const SAVED: Record<string, unknown> = {};
const settle = async () => { await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0)); };

beforeAll(() => {
  for (const key of Object.keys(OVERRIDES)) { HAS[key] = key in G; SAVED[key] = G[key]; G[key] = OVERRIDES[key]; }
  (dom.HTMLElement.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {};
});
afterAll(async () => {
  await settle();
  for (const key of Object.keys(OVERRIDES)) { if (HAS[key]) G[key] = SAVED[key]; else delete G[key]; }
  mock.module("@/hooks/useRuntime", () => actualRuntimeHooks);
  mock.module("@/hooks/useLogTail", () => actualLogTail);
});

let roots: Root[] = [];
let detach: (() => void) | null = null;
beforeEach(() => { dom.document.body.replaceChildren(); roots = []; });
afterEach(async () => {
  for (const r of roots) flushSync(() => r.unmount());
  roots = [];
  detach?.();
  detach = null;
  await settle();
  dom.sessionStorage.clear();
});

/** A model of the browser's same-document history, so a pop is a real pop. */
function browser() {
  const entries: { state: unknown; url: string }[] = [{ state: null, url: "http://localhost/#p=demo" }];
  let index = 0;
  let listener: ((state: unknown) => void) | null = null;
  const host: MobileNavHost = {
    history: {
      get state() { return entries[index]!.state; },
      pushState(state, _unused, url) { entries.splice(index + 1); entries.push({ state, url: url ?? entries[index]!.url }); index += 1; },
      replaceState(state, _unused, url) { entries[index] = { state, url: url ?? entries[index]!.url }; },
      back() { if (index === 0) return; index -= 1; listener?.(entries[index]!.state); },
    },
    href: () => entries[index]!.url,
    onPopstate(next) { listener = next; return () => { listener = null; }; },
  };
  return { host, depth: () => entries.length };
}

function entry(over: Partial<FileEntry> & Pick<FileEntry, "path" | "title">): FileEntry {
  return {
    root: "claude-projects", name: over.path.slice(1), project: "demo", engine: "claude", kind: "session",
    fmt: "claude", parent: null, mtime: 1_000, size: 1, activity: "idle", proc: null, pid: null,
    conversationId: null, model: "Opus", effort: "high", pendingQuestion: null, waitingInput: null,
    ...over,
  } as FileEntry;
}

const stageConversation = entry({
  path: "/implement.jsonl",
  title: "Rebuild the board status projection",
  conversationId: "conv-implement",
  activity: "live",
  mtime: 9_000,
});
const sibling = entry({ path: "/other.jsonl", title: "Fix the flaky reseat test", conversationId: "conv-other", activity: "live", mtime: 8_000 });
const blocked = entry({
  path: "/export.jsonl",
  title: "Implement the export endpoint",
  conversationId: "conv-export",
  activity: "live",
  mtime: 7_000,
  pendingQuestion: { toolUseId: "q1" } as FileEntry["pendingQuestion"],
});

const pipeline = {
  id: "p1", task: "Fast conversation switching", project: "demo", repoDir: "/r", worktreeDir: "/w",
  branch: "b", baseBranch: "main", baseRef: "a", lastPassedCommit: "a",
  stages: [
    { id: "design", kind: "run", prompt: "", next: "implement" },
    { id: "implement", kind: "run", prompt: "", next: null },
  ],
  runs: [{ stageId: "implement", attempts: [{ n: 1, state: "running", agentPath: stageConversation.path, flowId: null }] }],
  cursor: { stageId: "implement", state: "running", input: null, activatedBy: null },
  state: "running", pausedState: null, stateDetail: null, srcPath: null, srcConversationId: null,
  createdAt: "2026-09-01T00:00:00Z", closedAt: null,
} as unknown as Pipeline;

/** Hand-off drafts the screen asked the board for, by conversation path. */
const handoffs: string[] = [];

function mount(nav: MobileNav, files: FileEntry[], focus: string | null, pipelines: Pipeline[] = []): void {
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as Element);
  roots.push(root);
  flushSync(() => root.render(
    <MobileNavContext.Provider value={nav}>
      <MobileFocusView
        project="demo"
        projectName="atlas"
        groups={[]}
        manual={files}
        files={files}
        flows={[]}
        pipelines={pipelines}
        surfacePipelines={pipelines}
        tasks={[]}
        drafts={[]}
        loaded
        focus={focus}
        onHandoff={(file) => handoffs.push(file.path)}
        onSelect={() => {}}
        onClose={() => {}}
        onDraftClose={() => {}}
        onDraftSpawned={() => {}}
      />
    </MobileNavContext.Provider>,
  ));
}

const barTitle = () => dom.document.querySelector("[data-mobile2-title-text]")?.textContent ?? "";
const metaState = () => dom.document.querySelector("[data-mobile2-chat-state]")?.textContent ?? "";
const bar = () => dom.document.querySelector("[data-mobile2-bar]") as unknown as HTMLElement;

function swipe(zone: HTMLElement, dx: number): void {
  const start = new dom.Event("touchstart", { bubbles: true });
  Object.assign(start, { touches: [{ clientX: 300, clientY: 200 }] });
  const end = new dom.Event("touchend", { bubbles: true });
  Object.assign(end, { touches: [], changedTouches: [{ clientX: 300 + dx, clientY: 200 }] });
  flushSync(() => { zone.dispatchEvent(start as unknown as Event); });
  flushSync(() => { zone.dispatchEvent(end as unknown as Event); });
}

test("the bar carries the title on one line and a meta line under it, with `stage k/n` on the current stage", async () => {
  const { host } = browser();
  const nav = createMobileNav(host);
  detach = nav.attach();
  mount(nav, [stageConversation], stageConversation.path, [pipeline]);
  await settle();

  expect(barTitle()).toBe("Rebuild the board status projection");
  /* The state phrase leads the meta line and never truncates: it is the one
     thing on the line that must survive any width (2026-08 findings 3 and 4). */
  const state = dom.document.querySelector("[data-mobile2-chat-state]") as unknown as HTMLElement;
  expect(state.className).toContain("shrink-0");
  expect(state.className).toContain("whitespace-nowrap");
  expect(state.className).toContain("text-success");
  /* The model and its reasoning tier are what give way first. */
  const model = state.parentElement!.querySelector(".truncate") as unknown as HTMLElement;
  expect(model.textContent).toContain("Opus");
  expect(model.textContent).toContain("high");
  expect(model.className).toContain("min-w-0");
  expect(dom.document.querySelector("[data-mobile2-chat-stage]")?.textContent).toBe("stage 2/2");
  /* The engine rides the line as a MARK, never as a word (§3.2): spelling it
     out is what made the strip read "Claude · Claude · Claude", and the model
     beside it already carries the identity the operator reads. */
  const mark = state.parentElement!.querySelector("[data-mobile2-engine]");
  expect(mark?.getAttribute("data-mobile2-engine")).toBe("claude");
  expect(mark!.getAttribute("aria-hidden")).toBe("true");
  expect(dom.document.querySelector("[data-mobile2-chat-title]")?.textContent).not.toContain("Claude");
});

test("offline is screen-level: the meta line says so instead of the last state, and drops the identity", async () => {
  mock.module("@/hooks/useRuntime", () => ({
    ...actualRuntimeHooks,
    useRuntimeBusState: () => ({ enabled: true, connection: "offline", resyncedAt: null, lastEventAt: null, store: emptyStore() }),
    useRuntime: () => ({ enabled: true, connection: "offline", resyncedAt: null, store: emptyStore() }),
    useRuntimeSession: () => null,
    useRuntimeSessionByArtifact: () => null,
    useRuntimeReceiptsForArtifact: () => [],
    useRuntimeFlow: () => null,
  }));
  const { MobileFocusView: Offline } = await import("./MobileFocusView");
  const { host } = browser();
  const nav = createMobileNav(host);
  detach = nav.attach();
  const root = createRoot(dom.document.body.appendChild(dom.document.createElement("div")) as unknown as Element);
  roots.push(root);
  flushSync(() => root.render(
    <MobileNavContext.Provider value={nav}>
      <Offline
        project="demo" projectName="atlas" groups={[]} manual={[stageConversation]} files={[stageConversation]}
        flows={[]} pipelines={[pipeline]} surfacePipelines={[pipeline]} tasks={[]} drafts={[]} loaded
        focus={stageConversation.path} onSelect={() => {}} onClose={() => {}} onDraftClose={() => {}} onDraftSpawned={() => {}}
      />
    </MobileNavContext.Provider>,
  ));
  await settle();

  expect(metaState()).toBe("offline · reconnecting");
  /* Nothing else shares the line: the model, the reasoning and `stage k/n` are
     not facts the phone can still vouch for while the host is gone. */
  expect(dom.document.querySelector("[data-mobile2-chat-stage]")).toBeNull();
  expect(dom.document.querySelector("[data-mobile2-chat-title]")?.textContent).not.toContain("Opus");

  mock.module("@/hooks/useRuntime", () => ({
    ...actualRuntimeHooks,
    useRuntimeBusState: () => ({ ...liveRuntime, lastEventAt: null }),
    useRuntime: () => liveRuntime,
    useRuntimeSession: () => null,
    useRuntimeSessionByArtifact: () => null,
    useRuntimeReceiptsForArtifact: () => [],
    useRuntimeFlow: () => null,
  }));
});

test("the title cell is the switcher, its sections are the board's, and a row REPLACES the top of the stack", async () => {
  const model = browser();
  const nav = createMobileNav(model.host);
  detach = nav.attach();
  mount(nav, [stageConversation, sibling, blocked], stageConversation.path);
  await settle();

  const cell = dom.document.querySelector('[data-mobile2-open="switch"]') as unknown as HTMLButtonElement;
  expect(cell).not.toBeNull();
  flushSync(() => cell.click());
  await settle();
  const sheet = dom.document.querySelector('[data-mobile2-sheet="switch"]') as unknown as HTMLElement;
  expect(sheet).not.toBeNull();
  /* The switcher mirrors the board: the blocked conversation is under Needs
     you, the running ones under Working, and Needs you comes first. */
  const sections = [...sheet.querySelectorAll("[data-mobile2-section]")].map((row) => row.getAttribute("data-mobile2-section"));
  expect(sections).toEqual(["needs", "working", "working"]);
  /* The current one is checked, and only it. */
  const current = [...sheet.querySelectorAll("[data-mobile2-conversation]")].filter((row) => row.getAttribute("aria-current") === "true");
  expect(current.map((row) => row.getAttribute("data-mobile2-conversation"))).toEqual(["conv-implement"]);
  /* Every row identifies its engine the way the bar does — a mark beside the
     model, never the engine's word, which is what the chip strip spent its
     width on. */
  const rows = [...sheet.querySelectorAll("[data-mobile2-conversation]")];
  expect(rows.every((row) => row.querySelector('[data-mobile2-engine="claude"]') !== null)).toBe(true);
  expect(rows.every((row) => !(row.textContent ?? "").includes("Claude"))).toBe(true);

  const depthBefore = model.depth();
  const row = sheet.querySelector('[data-mobile2-conversation="conv-export"]') as unknown as HTMLButtonElement;
  flushSync(() => row.click());
  await settle();
  expect(barTitle()).toBe("Implement the export endpoint");
  /* A sibling switch REPLACES: it never grows the history, so ‹ still leaves
     the way the operator came in (§3.3). */
  expect(model.depth()).toBe(depthBefore);
  expect(dom.document.querySelector('[data-mobile2-sheet="switch"]')).toBeNull();
});

test("a swipe across the bar walks the switcher's order and bumps at its ends", async () => {
  const { host } = browser();
  const nav = createMobileNav(host);
  detach = nav.attach();
  mount(nav, [stageConversation, sibling, blocked], blocked.path);
  await settle();
  /* The switcher's order is Needs you, then Working — so the blocked one is
     first, and there is nothing to its left. */
  expect(barTitle()).toBe("Implement the export endpoint");

  swipe(bar(), 120);
  await settle();
  expect(barTitle()).toBe("Implement the export endpoint");
  expect(dom.document.querySelector("[data-mobile2-title]")?.getAttribute("data-mobile2-bump")).toBe("left");

  swipe(bar(), -120);
  await settle();
  expect(barTitle()).toBe("Rebuild the board status projection");
  expect(dom.document.querySelector("[data-mobile2-title]")?.getAttribute("data-mobile2-bump")).toBeNull();

  swipe(bar(), -120);
  await settle();
  expect(barTitle()).toBe("Fix the flaky reseat test");

  swipe(bar(), -120);
  await settle();
  expect(barTitle()).toBe("Fix the flaky reseat test");
  expect(dom.document.querySelector("[data-mobile2-title]")?.getAttribute("data-mobile2-bump")).toBe("right");
  /* The marker OUTLIVES the displacement. The 12 px shift springs back after
     BUMP_MS, but a reader arriving after the gesture settled — the capture's
     swipe flow does, a quarter of a second later — must still find the end of
     the list recorded, exactly as the prototype leaves its class on. */
  await new Promise((resolve) => setTimeout(resolve, BUMP_MS + 60));
  expect(dom.document.querySelector("[data-mobile2-title]")?.getAttribute("data-mobile2-bump")).toBe("right");
  /* And the cell itself is back at rest. */
  expect((dom.document.querySelector("[data-mobile2-chat-title]") as unknown as HTMLElement).className).not.toContain("translate-x-3");
});

test("a vertical drag, and a touch outside the bar and dock, never switch the conversation", async () => {
  const { host } = browser();
  const nav = createMobileNav(host);
  detach = nav.attach();
  mount(nav, [stageConversation, sibling], stageConversation.path);
  await settle();

  /* Mostly-vertical: the operator is scrolling, not switching. */
  const start = new dom.Event("touchstart", { bubbles: true });
  Object.assign(start, { touches: [{ clientX: 300, clientY: 200 }] });
  const end = new dom.Event("touchend", { bubbles: true });
  Object.assign(end, { touches: [], changedTouches: [{ clientX: 200, clientY: 500 }] });
  flushSync(() => { bar().dispatchEvent(start as unknown as Event); });
  flushSync(() => { bar().dispatchEvent(end as unknown as Event); });
  await settle();
  expect(barTitle()).toBe("Rebuild the board status projection");

  /* And the feed keeps its own gestures: only the bar and the dock switch. */
  const pane = dom.document.querySelector('[data-testid="mobile-focused-pane"]') as unknown as HTMLElement;
  swipe(pane, -120);
  await settle();
  expect(barTitle()).toBe("Rebuild the board status projection");
});

test("‹ from a stage conversation returns to the pipeline it came from", async () => {
  const model = browser();
  const nav = createMobileNav(model.host);
  detach = nav.attach();
  /* The route the operator took: board → pipeline → the stage's conversation. */
  nav.push({ kind: "pipeline", id: "p1" });
  nav.push({ kind: "chat", id: "conv-implement" });
  mount(nav, [stageConversation, sibling], stageConversation.path, [pipeline]);
  await settle();

  const back = dom.document.querySelector("[data-mobile2-back]") as unknown as HTMLButtonElement;
  expect(back).not.toBeNull();
  flushSync(() => back.click());
  await settle();
  expect(topScreen(nav.getState())).toEqual({ kind: "pipeline", id: "p1" });
  expect(nav.getState().motion).toBe("pop");

  /* And the switcher's header offers the same way out, so a sibling switch
     followed by ‹ still lands on the pipeline rather than on a sheet. */
  const cell = dom.document.querySelector('[data-mobile2-open="switch"]') as unknown as HTMLButtonElement;
  flushSync(() => cell.click());
  expect(dom.document.querySelector('[data-mobile2-sheet="switch"] [data-mobile2-go="board"]')).not.toBeNull();
});

test("a stage conversation reaches its own pipeline from the menu's first row (P2-9)", async () => {
  const { host } = browser();
  const nav = createMobileNav(host);
  detach = nav.attach();
  mount(nav, [stageConversation], stageConversation.path, [pipeline]);
  await settle();

  const more = dom.document.querySelector('[data-mobile2-open="menu"]') as unknown as HTMLButtonElement;
  flushSync(() => more.click());
  await settle();
  const row = dom.document.querySelector('[data-testid="mobile-menu-pipeline"]') as unknown as HTMLElement;
  expect(row).not.toBeNull();
  expect(row.textContent).toContain("Fast conversation switching");
  expect(row.textContent).toContain("stage 2/2");
  /* It is the FIRST row: the pipeline a stage belongs to outranks every
     identity action in the menu. */
  const rows = [...dom.document.querySelectorAll("[data-mobile2-menu-row]")].map((node) => node.getAttribute("data-mobile2-menu-row"));
  expect(rows[0]).toBe("pipeline");
});

test("Hand off is a labelled row in the menu, between Crown and Compact context", async () => {
  const { host } = browser();
  const nav = createMobileNav(host);
  detach = nav.attach();
  handoffs.length = 0;
  mount(nav, [stageConversation], stageConversation.path, [pipeline]);
  await settle();

  const more = dom.document.querySelector('[data-mobile2-open="menu"]') as unknown as HTMLButtonElement;
  flushSync(() => more.click());
  await settle();
  /* §4.2's order for the identity group: Rename · Crown · Hand off, then the
     host rows. Crown needs a favorites host this mount has none of, so the
     row it follows here is Rename. The control the phone used to reach only
     through the folded bottom shelf is a row with a word on it, like every
     other former header control (2026-08 audit finding 18). */
  const rows = [...dom.document.querySelectorAll("[data-mobile2-menu-row]")].map((node) => node.getAttribute("data-mobile2-menu-row"));
  expect(rows.indexOf("handoff")).toBe(rows.indexOf("rename") + 1);
  expect(rows.indexOf("handoff")).toBeLessThan(rows.indexOf("host"));

  const row = dom.document.querySelector('[data-mobile2-menu-row="handoff"]') as unknown as HTMLElement;
  expect(row.textContent).toContain("Hand off");
  /* It acts on the tap and takes the sheet with it: the draft lands under the
     conversation, so nothing is left covering it (§2 rule 9). */
  flushSync(() => (row as HTMLButtonElement).click());
  await settle();
  expect(handoffs).toEqual([stageConversation.path]);
  expect(dom.document.querySelector('[data-mobile2-sheet="menu"]')).toBeNull();
});
