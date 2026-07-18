import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { Window as HappyWindow } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";
import { emptyStore } from "@/components/runtime/runtimeModel";

/* Desktop board viewport and the 390px production phone viewport: the relation
   strip must hold its reserved, non-overlaying slot in both. */
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

function file(overrides: Partial<FileEntry> = {}): FileEntry {
  return {
    path: "/pane.jsonl",
    root: "codex-sessions",
    name: "pane.jsonl",
    project: "project",
    title: "Conversation pane",
    engine: "codex",
    kind: "session",
    fmt: "codex",
    parent: null,
    mtime: 1,
    size: 1,
    activity: "live",
    proc: "running",
    pid: 7,
    model: null,
    pendingQuestion: null,
    waitingInput: null,
    conversationId: "conversation-1",
    ...overrides,
  };
}

function boardTask(overrides: Partial<BoardTask> & { id: string; text: string }): BoardTask {
  return {
    project: "project",
    status: "assigned",
    placement: "pinned",
    pos: { x: 0, y: 0 },
    assignments: [],
    createdAt: "2026-07-18T00:00:00.000Z",
    updatedAt: "2026-07-18T00:00:00.000Z",
    ...overrides,
  } as BoardTask;
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

const RELATIONS = [
  { task: boardTask({ id: "assigned-task", text: "Repair the deploy gate\ndetails" }), relation: "assignment" as const },
  { task: boardTask({ id: "captured-task", text: "Captured follow-up", status: "inbox" }), relation: "source" as const },
];

test("the desktop pane reserves an in-flow relation strip that opens tasks both ways", () => {
  const opened: string[] = [];
  const host = mount(
    desktop,
    <BranchPane
      file={file()}
      tasks={[]}
      isRoot
      relatedTasks={RELATIONS}
      onOpenTask={(task) => opened.push(task.id)}
    />,
  );

  const strip = host.querySelector("[data-task-relations]") as HTMLElement;
  expect(strip).toBeTruthy();
  expect(strip.getAttribute("aria-label")).toBe("Related tasks");
  /* Reserved layout space: the strip participates in the pane's flex column —
     it must never float over the transcript. */
  expect(strip.className).toContain("shrink-0");
  expect(strip.className).not.toContain("absolute");
  const section = host.querySelector("section")!;
  expect(section.contains(strip)).toBe(true);
  /* The strip sits between the header and the feed body in DOM order. */
  const header = section.querySelector("header")!;
  expect(header.compareDocumentPosition(strip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

  const chips = [...strip.querySelectorAll("button[data-task-relation]")] as HTMLButtonElement[];
  expect(chips).toHaveLength(2);
  expect(chips[0]!.getAttribute("aria-label")).toBe("Open task Repair the deploy gate");
  expect(chips[1]!.getAttribute("aria-label")).toBe("Open task Captured follow-up");
  expect(chips[1]!.title).toContain("captured from this conversation");
  /* Wide pointer + coarse-pointer hit paths are part of the chip contract. */
  expect(chips[0]!.className).toContain("min-h-7");
  expect(chips[0]!.className).toContain("pointer-coarse:min-h-11");

  chips[0]!.click();
  expect(opened).toEqual(["assigned-task"]);
});

test("without relations or an opener the pane renders no strip", () => {
  const bare = mount(desktop, <BranchPane file={file()} tasks={[]} isRoot relatedTasks={[]} onOpenTask={() => {}} />);
  expect(bare.querySelector("[data-task-relations]")).toBeNull();
  const unwired = mount(desktop, <BranchPane file={file()} tasks={[]} isRoot relatedTasks={RELATIONS} />);
  expect(unwired.querySelector("[data-task-relations]")).toBeNull();
});

test("the 390px production pane keeps the strip reserved and tappable", () => {
  const opened: string[] = [];
  const host = mount(
    phone,
    <BranchPane
      file={file()}
      tasks={[]}
      isRoot
      relatedTasks={RELATIONS}
      onOpenTask={(task) => opened.push(task.id)}
    />,
  );

  const strip = host.querySelector("[data-task-relations]") as HTMLElement;
  expect(strip).toBeTruthy();
  expect(strip.className).toContain("shrink-0");
  expect(strip.className).not.toContain("absolute");
  const chip = strip.querySelector("button[data-task-relation]") as HTMLButtonElement;
  chip.click();
  expect(opened).toEqual(["assigned-task"]);
  bindDomGlobals(desktop);
});
