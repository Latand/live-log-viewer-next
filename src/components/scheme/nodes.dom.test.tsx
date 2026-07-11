import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { Window as HappyWindow } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import type { Flow } from "@/lib/flows/types";
import type { FileEntry } from "@/lib/types";
import { emptyStore } from "@/components/runtime/runtimeModel";

import type { DeckNode, DraftNode, MiniStack, SchemeLayout, SchemeNode } from "./layout";

const dom = new HappyWindow();
const resizeCallbacks = new Set<() => void>();

class TestResizeObserver {
  private readonly notify: () => void;

  constructor(callback: ResizeObserverCallback) {
    this.notify = () => callback([], this as unknown as ResizeObserver);
    resizeCallbacks.add(this.notify);
  }

  observe() {}
  unobserve() {}
  disconnect() {
    resizeCallbacks.delete(this.notify);
  }
}

function bindDomGlobals() {
  Object.assign(globalThis, {
    window: dom,
    document: dom.document,
    navigator: dom.navigator,
    Node: dom.Node,
    HTMLElement: dom.HTMLElement,
    HTMLButtonElement: dom.HTMLButtonElement,
    HTMLInputElement: dom.HTMLInputElement,
    Event: dom.Event,
    CustomEvent: dom.CustomEvent,
    MouseEvent: dom.MouseEvent,
    sessionStorage: dom.sessionStorage,
    localStorage: dom.localStorage,
    ResizeObserver: TestResizeObserver,
    IntersectionObserver: undefined,
  });
}

bindDomGlobals();

const actualRuntimeHooks = await import("@/hooks/useRuntime");
const actualLogTail = await import("@/hooks/useLogTail");
const inertRuntime = { enabled: false, connection: "offline" as const, resyncedAt: null, store: emptyStore() };
mock.module("@/hooks/useRuntime", () => ({
  ...actualRuntimeHooks,
  useRuntimeBusState: () => ({ ...inertRuntime, lastEventAt: null }),
  useRuntime: () => inertRuntime,
  useRuntimeSession: () => null,
  useRuntimeReceiptsForArtifact: () => [],
  useRuntimeFlow: () => null,
}));

const tails = new Map<string, string[]>();
const tailStarts = new Map<string, number>();
mock.module("@/hooks/useLogTail", () => ({
  useLogTail: (entry: FileEntry | null) => ({
    lines: entry ? (tails.get(entry.path) ?? []) : [],
    linesStart: entry ? (tailStarts.get(entry.path) ?? 0) : 0,
    size: entry?.size ?? 0,
    loading: false,
    error: null,
    tickTime: null,
    paused: false,
    setPaused: () => undefined,
    clear: () => undefined,
    hasMore: false,
    loadingOlder: false,
    loadOlder: async () => 0,
    prependGen: 0,
  }),
}));

const { NodesLayer } = await import("./nodes");

const roots = new Set<Root>();
const realNow = Date.now;

beforeEach(bindDomGlobals);

afterAll(() => {
  mock.module("@/hooks/useRuntime", () => actualRuntimeHooks);
  mock.module("@/hooks/useLogTail", () => actualLogTail);
});

afterEach(() => {
  for (const root of roots) flushSync(() => root.unmount());
  roots.clear();
  resizeCallbacks.clear();
  tails.clear();
  tailStarts.clear();
  Date.now = realNow;
  dom.document.body.replaceChildren();
  dom.sessionStorage.clear();
});

function file(path: string, title: string): FileEntry {
  return {
    path,
    root: "codex-sessions",
    name: path,
    project: "project",
    title,
    engine: "codex",
    kind: "session",
    fmt: "codex",
    parent: null,
    mtime: 1,
    size: 1,
    activity: "recent",
    proc: "running",
    pid: 1,
    model: null,
    pendingQuestion: null,
    waitingInput: null,
  };
}

function node(entry: FileEntry, x: number): SchemeNode {
  return { file: entry, tasks: [], under: [], isRoot: true, x, y: 0, w: 600, h: 780 };
}

function flow(id: string, implementerPath: string): Flow {
  return {
    id,
    template: "implement-review-loop",
    project: "project",
    cwd: "/project",
    implementerPath,
    roles: {
      implementer: { engine: "codex", model: null, effort: null },
      reviewer: { engine: "codex", model: null, effort: null },
    },
    baseRef: "base",
    baseMode: "head",
    mode: "auto",
    reviewerMode: "headless",
    roundLimit: 5,
    state: "waiting_ready",
    stateDetail: null,
    rounds: [],
    createdAt: "2026-07-12T00:00:00Z",
    closedAt: null,
  };
}

function stack(key: string, x: number): MiniStack {
  return { key, parent: "/parent", items: [{ file: file(`${key}/item`, key), branches: 0 }], x, y: 0, w: 360, h: 70 };
}

function deck(key: string, x: number): DeckNode {
  return { key, flow: flow(`flow-${key}`, "/node-a"), rounds: [], x, y: 0, w: 600, h: 780 };
}

function draft(key: string, x: number): DraftNode {
  return { key, id: key, x, y: 0, w: 600, h: 780 };
}

function layout(parts: Partial<SchemeLayout> = {}): SchemeLayout {
  return {
    nodes: [],
    edges: [],
    stacks: [],
    decks: [],
    loops: [],
    links: [],
    drafts: [],
    byPath: new Map(),
    width: 2000,
    height: 1000,
    ...parts,
  };
}

function mountHost(): { host: HTMLElement; root: Root } {
  const element = dom.document.createElement("div");
  dom.document.body.append(element);
  const host = element as unknown as HTMLElement;
  const root = createRoot(host);
  roots.add(root);
  return { host, root };
}

function renderLayer(root: Root, next: SchemeLayout, options: { lite?: boolean; dormant?: boolean; selected?: string } = {}) {
  const flows = next.decks.map((item) => item.flow);
  flushSync(() => {
    root.render(
      <NodesLayer
        layout={next}
        project="project"
        files={next.nodes.map((item) => item.file)}
        interactive
        lite={options.lite ?? false}
        dormant={options.dormant ?? true}
        selected={options.selected ?? null}
        multi={new Set()}
        session={false}
        focus={null}
        attentionPaths={null}
        flowsByImpl={new Map()}
        flows={flows}
        pipelineStrips={new Map()}
        deckFocus={null}
        onSelect={() => undefined}
        onClose={() => undefined}
        onFocusRound={() => undefined}
        onDraftClose={() => undefined}
        onDraftSpawned={() => undefined}
        onExpand={() => undefined}
      />,
    );
  });
}

async function settle() {
  await Bun.sleep(0);
  await Bun.sleep(0);
}

function triggerResize() {
  for (const callback of [...resizeCallbacks]) callback();
}

function scrollerFor(host: HTMLElement, path: string): HTMLElement {
  const scroller = host.querySelector(`[data-scheme-node="${path}"] .overflow-y-auto`);
  expect(scroller).toBeTruthy();
  return scroller as HTMLElement;
}

function setScrollerGeometry(element: HTMLElement, initialHeight: number, viewport: number) {
  let height = initialHeight;
  let client = viewport;
  let top = 0;
  Object.defineProperties(element, {
    scrollHeight: { configurable: true, get: () => height },
    clientHeight: { configurable: true, get: () => client },
    scrollTop: {
      configurable: true,
      get: () => top,
      set: (value: number) => {
        top = Math.max(0, Math.min(Number(value), Math.max(0, height - client)));
      },
    },
  });
  return {
    resize(nextHeight: number, nextViewport = client) {
      height = nextHeight;
      client = nextViewport;
    },
    setTop(value: number) {
      element.scrollTop = value;
    },
    fromBottom() {
      return Math.max(0, height - client - top);
    },
  };
}

function assistantLine(text: string): string {
  return JSON.stringify({
    type: "response_item",
    timestamp: "2026-07-12T00:00:00Z",
    payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] },
  });
}

function rect(top: number, height: number): DOMRect {
  return {
    x: 0,
    y: top,
    top,
    left: 0,
    width: 600,
    height,
    right: 600,
    bottom: top + height,
    toJSON: () => ({}),
  } as DOMRect;
}

function setViewportRects(scroller: HTMLElement, rows: Map<HTMLElement, { top: number; height: number }>, viewport = 200) {
  scroller.getBoundingClientRect = () => rect(0, viewport);
  for (const [row, box] of rows) {
    row.getBoundingClientRect = () => rect(box.top - scroller.scrollTop, box.height);
  }
}

test("every scheme host collection keeps stable DOM siblings while geometry changes", () => {
  const nodeA = node(file("/node-a", "Node A"), 100);
  const nodeB = node(file("/node-b", "Node B"), 700);
  const initial = layout({
    stacks: [stack("stack::b", 700), stack("stack::a", 100)],
    decks: [deck("deck::b", 700), deck("deck::a", 100)],
    drafts: [draft("draft::b", 700), draft("draft::a", 100)],
    nodes: [nodeB, nodeA],
  });
  const overtaken = layout({
    stacks: [stack("stack::a", 900), stack("stack::b", 300)],
    decks: [deck("deck::a", 900), deck("deck::b", 300)],
    drafts: [draft("draft::a", 900), draft("draft::b", 300)],
    nodes: [node(file("/node-a", "Node A"), 900), node(file("/node-b", "Node B"), 300)],
  });
  const { host, root } = mountHost();

  renderLayer(root, initial, { lite: true });
  const keys = ["stack::a", "stack::b", "deck::a", "deck::b", "draft::a", "draft::b", "/node-a", "/node-b"];
  const originalHosts = new Map(keys.map((key) => [key, host.querySelector(`[data-scheme-node="${key}"]`)]));
  const originalOrder = Array.from(host.querySelectorAll<HTMLElement>("[data-scheme-node]"), (item) => item.dataset.schemeNode);

  renderLayer(root, overtaken, { lite: true });

  expect(Array.from(host.querySelectorAll<HTMLElement>("[data-scheme-node]"), (item) => item.dataset.schemeNode)).toEqual(originalOrder);
  for (const key of keys) expect(host.querySelector(`[data-scheme-node="${key}"]`)).toBe(originalHosts.get(key) ?? null);
  expect((host.querySelector('[data-scheme-node="stack::a"]') as HTMLElement).style.transform).toContain("900px");
  expect((host.querySelector('[data-scheme-node="/node-a"]') as HTMLElement).style.transform).toContain("900px");
});

test("an anchored production feed survives overtakes and a short remount window", async () => {
  let now = 1_000;
  Date.now = () => now;
  tails.set("/reader", [assistantLine("Reader anchor")]);
  tails.set("/overtaker", [assistantLine("Overtaker tail")]);
  const reader = file("/reader", "Reader pane");
  const overtaker = file("/overtaker", "Overtaker pane");
  const initial = layout({ nodes: [node(reader, 100), node(overtaker, 700)] });
  const overtaken = layout({ nodes: [node(overtaker, 100), node(reader, 700)] });
  const { host, root } = mountHost();

  renderLayer(root, initial, { selected: "/reader" });
  await settle();
  const readerHost = host.querySelector('[data-scheme-node="/reader"]');
  const scroller = scrollerFor(host, "/reader");
  const geometry = setScrollerGeometry(scroller, 1_000, 200);
  triggerResize();
  expect(geometry.fromBottom()).toBe(0);
  expect(readerHost?.textContent).toContain("Reader anchor");

  now += 1_000;
  geometry.setTop(400);
  flushSync(() => scroller.dispatchEvent(new dom.Event("scroll", { bubbles: true }) as unknown as Event));
  expect(geometry.fromBottom()).toBe(400);

  renderLayer(root, overtaken, { selected: "/reader" });
  expect(host.querySelector('[data-scheme-node="/reader"]')).toBe(readerHost);
  expect(scrollerFor(host, "/reader")).toBe(scroller);
  expect(geometry.fromBottom()).toBe(400);

  renderLayer(root, layout());
  renderLayer(root, overtaken, { selected: "/reader" });
  await settle();
  const remountedScroller = scrollerFor(host, "/reader");
  const remountedGeometry = setScrollerGeometry(remountedScroller, 220, 200);
  triggerResize();
  expect(remountedScroller.scrollTop).toBe(0);

  remountedGeometry.resize(1_000);
  triggerResize();
  expect(remountedGeometry.fromBottom()).toBe(400);
  expect(host.querySelector('[data-scheme-node="/reader"]')?.textContent).toContain("Reader anchor");
});

test("an account-migration successor inherits its conversation scroll state", async () => {
  let now = 5_000;
  Date.now = () => now;
  tails.set("/predecessor", [
    assistantLine("Predecessor before"),
    assistantLine("Predecessor visible anchor"),
    assistantLine("Predecessor tail"),
  ]);
  tails.set("/successor", [
    assistantLine("Successor unrelated first"),
    assistantLine("Successor unrelated second"),
    assistantLine("Successor unrelated third"),
  ]);
  const predecessor = { ...file("/predecessor", "Predecessor"), conversationId: "conversation-stable" };
  const successor = {
    ...file("/successor", "Successor"),
    conversationId: "conversation-stable",
    predecessorPath: "/predecessor",
  };
  const { host, root } = mountHost();

  renderLayer(root, layout({ nodes: [node(predecessor, 100)] }));
  await settle();
  const predecessorScroller = scrollerFor(host, "/predecessor");
  const predecessorGeometry = setScrollerGeometry(predecessorScroller, 1_000, 200);
  const predecessorRows = Array.from(host.querySelectorAll<HTMLElement>('[data-scheme-node="/predecessor"] [data-feed-key]'));
  const predecessorBefore = predecessorRows.find((row) => row.textContent?.includes("Predecessor before"));
  const predecessorAnchor = predecessorRows.find((row) => row.textContent?.includes("Predecessor visible anchor"));
  const predecessorTail = predecessorRows.find((row) => row.textContent?.includes("Predecessor tail"));
  setViewportRects(predecessorScroller, new Map([
    [predecessorBefore!, { top: 300, height: 80 }],
    [predecessorAnchor!, { top: 380, height: 80 }],
    [predecessorTail!, { top: 500, height: 80 }],
  ]));
  predecessorGeometry.setTop(400);
  now += 1_000;
  flushSync(() => predecessorScroller.dispatchEvent(new dom.Event("scroll", { bubbles: true }) as unknown as Event));
  expect(predecessorGeometry.fromBottom()).toBe(400);
  expect(predecessorAnchor!.getBoundingClientRect().top).toBe(-20);

  renderLayer(root, layout());
  renderLayer(root, layout({ nodes: [node(successor, 100)] }));
  await settle();
  const successorScroller = scrollerFor(host, "/successor");
  const successorGeometry = setScrollerGeometry(successorScroller, 1_000, 200);
  const successorRows = Array.from(host.querySelectorAll<HTMLElement>('[data-scheme-node="/successor"] [data-feed-key]'));
  setViewportRects(successorScroller, new Map(successorRows.map((row, index) => [row, { top: 100 + index * 80, height: 70 }])));
  triggerResize();

  expect(successorGeometry.fromBottom()).toBe(400);
  expect(successorScroller.scrollTop).toBe(400);
  expect(host.querySelector('[data-scheme-node="/successor"]')?.textContent).toContain("Successor unrelated second");
});

test("an anchored feed item keeps its viewport offset while the transcript grows during remount", async () => {
  let now = 8_000;
  Date.now = () => now;
  const path = "/anchor-growth";
  const initialLines = [
    assistantLine("Before anchor"),
    assistantLine("Visible anchor row"),
    assistantLine("Existing tail row"),
  ];
  tails.set(path, initialLines);
  const entry = file(path, "Growing transcript");
  const { host, root } = mountHost();

  renderLayer(root, layout({ nodes: [node(entry, 100)] }));
  await settle();
  const scroller = scrollerFor(host, path);
  const geometry = setScrollerGeometry(scroller, 1_000, 200);
  const rows = Array.from(host.querySelectorAll<HTMLElement>(`[data-scheme-node="${path}"] [data-feed-key]`));
  const before = rows.find((row) => row.textContent?.includes("Before anchor"));
  const anchor = rows.find((row) => row.textContent?.includes("Visible anchor row"));
  const tail = rows.find((row) => row.textContent?.includes("Existing tail row"));
  expect(before).toBeTruthy();
  expect(anchor).toBeTruthy();
  expect(tail).toBeTruthy();
  setViewportRects(scroller, new Map([
    [before!, { top: 300, height: 80 }],
    [anchor!, { top: 380, height: 80 }],
    [tail!, { top: 500, height: 80 }],
  ]));
  geometry.setTop(400);
  now += 1_000;
  flushSync(() => scroller.dispatchEvent(new dom.Event("scroll", { bubbles: true }) as unknown as Event));
  expect(anchor!.getBoundingClientRect().top).toBe(-20);

  renderLayer(root, layout());
  tails.set(path, initialLines.concat([
    assistantLine("Arrived while unmounted one"),
    assistantLine("Arrived while unmounted two"),
  ]));
  renderLayer(root, layout({ nodes: [node(entry, 100)] }));
  await settle();

  const remountedScroller = scrollerFor(host, path);
  const remountedGeometry = setScrollerGeometry(remountedScroller, 1_400, 200);
  const remountedRows = Array.from(host.querySelectorAll<HTMLElement>(`[data-scheme-node="${path}"] [data-feed-key]`));
  const remountedBefore = remountedRows.find((row) => row.textContent?.includes("Before anchor"));
  const remountedAnchor = remountedRows.find((row) => row.textContent?.includes("Visible anchor row"));
  const remountedTail = remountedRows.find((row) => row.textContent?.includes("Existing tail row"));
  expect(remountedAnchor).toBeTruthy();
  setViewportRects(remountedScroller, new Map([
    [remountedBefore!, { top: 300, height: 80 }],
    [remountedAnchor!, { top: 380, height: 80 }],
    [remountedTail!, { top: 500, height: 80 }],
  ]));
  triggerResize();

  expect(remountedScroller.scrollTop).toBe(400);
  expect(remountedAnchor!.getBoundingClientRect().top).toBe(-20);
  expect(remountedGeometry.fromBottom()).toBe(800);
});

test("an anchored feed item survives parser reset after history is prepended", async () => {
  let now = 12_000;
  Date.now = () => now;
  const path = "/prepend-anchor";
  const initialLines = [
    assistantLine("Original before"),
    assistantLine("Original visible anchor"),
    assistantLine("Original tail"),
  ];
  tails.set(path, initialLines);
  const entry = file(path, "Prepended transcript");
  const { host, root } = mountHost();

  renderLayer(root, layout({ nodes: [node(entry, 100)] }));
  await settle();
  const scroller = scrollerFor(host, path);
  const geometry = setScrollerGeometry(scroller, 1_000, 200);
  const rows = Array.from(host.querySelectorAll<HTMLElement>(`[data-scheme-node="${path}"] [data-feed-key]`));
  const before = rows.find((row) => row.textContent?.includes("Original before"));
  const anchor = rows.find((row) => row.textContent?.includes("Original visible anchor"));
  const tail = rows.find((row) => row.textContent?.includes("Original tail"));
  setViewportRects(scroller, new Map([
    [before!, { top: 300, height: 80 }],
    [anchor!, { top: 380, height: 80 }],
    [tail!, { top: 500, height: 80 }],
  ]));
  geometry.setTop(400);
  now += 1_000;
  flushSync(() => scroller.dispatchEvent(new dom.Event("scroll", { bubbles: true }) as unknown as Event));
  expect(anchor!.getBoundingClientRect().top).toBe(-20);

  renderLayer(root, layout());
  tails.set(path, [assistantLine("Older one"), assistantLine("Older two"), ...initialLines]);
  tailStarts.set(path, -2);
  renderLayer(root, layout({ nodes: [node(entry, 100)] }));
  await settle();

  const remountedScroller = scrollerFor(host, path);
  const remountedGeometry = setScrollerGeometry(remountedScroller, 1_160, 200);
  const remountedRows = Array.from(host.querySelectorAll<HTMLElement>(`[data-scheme-node="${path}"] [data-feed-key]`));
  const boxes = new Map<HTMLElement, { top: number; height: number }>();
  const positions = new Map([
    ["Older one", 100],
    ["Older two", 180],
    ["Original before", 460],
    ["Original visible anchor", 540],
    ["Original tail", 660],
  ]);
  for (const row of remountedRows) {
    const match = [...positions].find(([text]) => row.textContent?.includes(text));
    if (match) boxes.set(row, { top: match[1], height: 80 });
  }
  const remountedAnchor = remountedRows.find((row) => row.textContent?.includes("Original visible anchor"));
  expect(remountedAnchor).toBeTruthy();
  setViewportRects(remountedScroller, boxes);
  triggerResize();

  expect(remountedScroller.scrollTop).toBe(560);
  expect(remountedAnchor!.getBoundingClientRect().top).toBe(-20);
  expect(remountedGeometry.fromBottom()).toBe(400);
});

test("a bottom-following production feed returns to the tail after remount", async () => {
  let now = 10_000;
  Date.now = () => now;
  tails.set("/follower", [assistantLine("Follower tail")]);
  const followerLayout = layout({ nodes: [node(file("/follower", "Follower pane"), 100)] });
  const { host, root } = mountHost();

  renderLayer(root, followerLayout);
  await settle();
  const scroller = scrollerFor(host, "/follower");
  const geometry = setScrollerGeometry(scroller, 1_000, 200);
  triggerResize();
  expect(geometry.fromBottom()).toBe(0);
  expect(host.textContent).toContain("Follower tail");

  now += 1_000;
  flushSync(() => scroller.dispatchEvent(new dom.Event("scroll", { bubbles: true }) as unknown as Event));
  renderLayer(root, layout());
  renderLayer(root, followerLayout);
  await settle();

  const remountedScroller = scrollerFor(host, "/follower");
  const remountedGeometry = setScrollerGeometry(remountedScroller, 1_600, 200);
  triggerResize();
  expect(remountedGeometry.fromBottom()).toBe(0);
  expect(host.textContent).toContain("Follower tail");
});
