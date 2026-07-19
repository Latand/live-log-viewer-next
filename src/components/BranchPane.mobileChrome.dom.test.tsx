import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { Window as HappyWindow } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import type { FileEntry } from "@/lib/types";
import { emptyStore } from "@/components/runtime/runtimeModel";

/*
 * Issue #419 (reopened) — chat-first mobile conversation shell. With a
 * conversation focused at 390px, the shell must show ONE compact conversation
 * header by default: the memory/goal/model metadata chips and the detailed
 * runtime controls fold behind a single conversation-details disclosure and
 * reserve ZERO height while collapsed, handing the transcript its budget. The
 * fold is mobile-only — desktop keeps every chip and the runtime strip inline.
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

test("the phone pane defaults to one compact header: meta chips and runtime controls reserve zero height", () => {
  const host = mount(phone, <BranchPane file={file()} tasks={[]} isRoot />);

  /* Collapsed by default — the metadata row and the runtime strip are absent
     from the DOM entirely, so neither reserves any height. */
  expect(host.querySelector('[data-testid="mobile-conv-meta"]')).toBeNull();
  expect(host.querySelector("[data-agent-control-strip]")).toBeNull();

  /* The disclosure that reveals them is a 44px target, closed, EN-labelled. */
  const toggle = host.querySelector('[data-testid="mobile-details-toggle"]') as HTMLButtonElement;
  expect(toggle).toBeTruthy();
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(toggle.getAttribute("aria-label")).toBe("Show conversation details");
  expect(toggle.className).toContain("h-11");
  expect(toggle.className).toContain("w-11");

  /* The compact header still owns the transcript below it (the composer mounts). */
  expect(host.querySelector("textarea")).toBeTruthy();
  bindDomGlobals(desktop);
});

test("opening the disclosure reveals the memory/goal chips and the runtime controls, and is reversible", () => {
  const host = mount(phone, <BranchPane file={file()} tasks={[]} isRoot />);
  const toggle = host.querySelector('[data-testid="mobile-details-toggle"]') as HTMLButtonElement;

  flushSync(() => toggle.click());
  const meta = host.querySelector('[data-testid="mobile-conv-meta"]') as HTMLElement;
  expect(meta).toBeTruthy();
  /* memory + goal live inside the revealed meta row (the aria-controls target):
     the model/reasoning chip is visible; the goal objective rides its label. */
  expect(toggle.getAttribute("aria-controls")).toBe(meta.id);
  expect(meta.textContent).toContain("sonnet");
  expect(meta.querySelector('[aria-label*="Ship the chat-first repair"]')).toBeTruthy();
  expect(host.querySelector("[data-agent-control-strip]")).toBeTruthy();
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(toggle.getAttribute("aria-label")).toBe("Hide conversation details");

  /* Reversible: tapping again folds both surfaces back to zero height. */
  flushSync(() => toggle.click());
  expect(host.querySelector('[data-testid="mobile-conv-meta"]')).toBeNull();
  expect(host.querySelector("[data-agent-control-strip]")).toBeNull();
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  bindDomGlobals(desktop);
});

test("desktop is untouched: every metadata chip and the runtime strip stay inline, no fold control", () => {
  const host = mount(desktop, <BranchPane file={file()} tasks={[]} isRoot />);

  expect(host.querySelector('[data-testid="mobile-details-toggle"]')).toBeNull();
  const meta = host.querySelector('[data-testid="mobile-conv-meta"]') as HTMLElement;
  expect(meta).toBeTruthy();
  expect(meta.querySelector('[aria-label*="Ship the chat-first repair"]')).toBeTruthy();
  expect(host.querySelector("[data-agent-control-strip]")).toBeTruthy();
});
