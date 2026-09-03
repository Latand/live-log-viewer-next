import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { Window as HappyWindow } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import type { FileEntry } from "@/lib/types";
import { emptyStore } from "@/components/runtime/runtimeModel";

/*
 * Issue #419 (reopened), as mobile v2 lane 3 settles it. The chat-first shell
 * asked for ONE compact conversation header on the phone, with the metadata
 * chips and the runtime controls folded behind a disclosure. Lane 3 goes the
 * rest of the way and removes the header entirely: the identity moved into the
 * shell bar's title cell and every control became a labelled row in the
 * conversation's `⋯` menu, so the pane spends ZERO height on chrome and the
 * disclosure that used to hide it has nothing left to hide.
 *
 * Desktop is untouched — both header rows, every chip, and the runtime strip
 * stay inline, with no fold control anywhere.
 */

const desktop = new HappyWindow({ width: 1280, height: 800 });
const phone = new HappyWindow({ width: 390, height: 844 });

function stubMatchMedia(dom: HappyWindow, mobile: boolean) {
  (dom as unknown as { matchMedia: (query: string) => unknown }).matchMedia = (query: string) => ({
    matches: mobile && query.includes("max-width"),
    media: query,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    onchange: null,
    dispatchEvent: () => false,
  });
}
stubMatchMedia(desktop, false);
stubMatchMedia(phone, true);

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function bindDomGlobals(dom: HappyWindow) {
  Object.assign(globalThis, {
    ResizeObserver: TestResizeObserver,
    window: dom,
    document: dom.document,
    navigator: dom.navigator,
    Node: dom.Node,
    HTMLElement: dom.HTMLElement,
    HTMLButtonElement: dom.HTMLButtonElement,
    Event: dom.Event,
    CustomEvent: dom.CustomEvent,
    MouseEvent: dom.MouseEvent,
    KeyboardEvent: dom.KeyboardEvent,
    sessionStorage: dom.sessionStorage,
    localStorage: dom.localStorage,
    IntersectionObserver: undefined,
  });
}

bindDomGlobals(desktop);

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
mock.module("@/hooks/useLogTail", () => ({
  useLogTail: () => ({
    lines: [],
    linesStart: 0,
    size: 0,
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

const { BranchPane } = await import("./BranchPane");

const roots = new Set<Root>();
afterEach(() => {
  for (const root of roots) flushSync(() => root.unmount());
  roots.clear();
  desktop.document.body.replaceChildren();
  phone.document.body.replaceChildren();
});
afterAll(() => {
  mock.module("@/hooks/useRuntime", () => actualRuntimeHooks);
  mock.module("@/hooks/useLogTail", () => actualLogTail);
});

/* A live root with memory (plan), a goal, and an observed model, so every
   secondary chip that eats a header row is present to fold. */
function file(overrides: Partial<FileEntry> = {}): FileEntry {
  return {
    path: "/pane.jsonl",
    root: "claude-projects",
    name: "pane.jsonl",
    project: "project",
    title: "A conversation with a genuinely long operator-facing title",
    engine: "claude",
    kind: "session",
    fmt: "claude",
    parent: null,
    mtime: 1,
    size: 1,
    activity: "live",
    proc: "running",
    pid: 7,
    model: "sonnet",
    effort: "high",
    pendingQuestion: null,
    waitingInput: null,
    conversationId: "conversation-1",
    plan: { steps: [{ text: "step", status: "in_progress" }], done: 1, total: 4, current: "step", updatedAt: null },
    goal: { objective: "Ship the chat-first repair", status: "active", tokensUsed: null, timeUsedSeconds: null },
    ...overrides,
  } as FileEntry;
}

function mount(dom: HappyWindow, node: React.ReactElement) {
  bindDomGlobals(dom);
  const host = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.appendChild(host as never);
  const root = createRoot(host);
  roots.add(root);
  flushSync(() => root.render(node));
  return host;
}

test("the phone pane renders no conversation header at all: no chips, no disclosure, no inline strip", () => {
  const host = mount(phone, <BranchPane file={file()} tasks={[]} isRoot />);

  /* The whole two-row header is gone — with it the metadata row, the runtime
     strip and the disclosure that used to fold them. Nothing here reserves
     height, and nothing here is an icon whose meaning is untouchable. */
  expect(host.querySelector("header")).toBeNull();
  expect(host.querySelector('[data-testid="mobile-conv-meta"]')).toBeNull();
  expect(host.querySelector("[data-agent-control-strip]")).toBeNull();
  expect(host.querySelector('[data-testid="mobile-details-toggle"]')).toBeNull();

  /* What remains is what the operator came for: the transcript and a composer. */
  expect(host.querySelector("textarea")).toBeTruthy();
  bindDomGlobals(desktop);
});

test("desktop is untouched: both header rows stay inline, with no fold control", () => {
  const host = mount(desktop, <BranchPane file={file()} tasks={[]} isRoot />);

  const header = host.querySelector("header") as HTMLElement;
  expect(header).toBeTruthy();
  expect(host.querySelector('[data-testid="mobile-details-toggle"]')).toBeNull();

  /* The identity row: the status word and the title. */
  expect(header.textContent).toContain("A conversation with a genuinely long operator-facing title");

  /* The metadata row, inline and unfolded: the observed model, the effort bars
     the phone never had, and the goal objective on its chip. */
  const meta = host.querySelector('[data-testid="mobile-conv-meta"]') as HTMLElement;
  expect(meta).toBeTruthy();
  expect(meta.textContent).toContain("sonnet");
  expect(meta.querySelector("[data-effort-pills]")).toBeTruthy();
  expect(meta.querySelector('[aria-label*="Ship the chat-first repair"]')).toBeTruthy();
});
