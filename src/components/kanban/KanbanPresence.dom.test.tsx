import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { Root } from "react-dom/client";

import type { BoardTask, TaskStatus } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";

import type { TaskMutationPorts } from "./useTaskMutations";

/*
 * What the board reports it can SEE (#1546).
 *
 * The measurement reads every card's rect, so it no longer runs once per scroll
 * frame and no longer writes React state. These cases hold the two properties
 * that has to keep: presence is EXACT once a gesture settles, and a gesture is
 * answered by a bounded number of measurements rather than one per frame.
 *
 * Rects are scripted, because happy-dom has no layout: a card is "on screen"
 * exactly when this test says its box overlaps its column's.
 */

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const dom = new Window({ url: "http://localhost/" });
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  localStorage: dom.localStorage,
  sessionStorage: dom.sessionStorage,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLInputElement: dom.HTMLInputElement,
  HTMLTextAreaElement: dom.HTMLTextAreaElement,
  HTMLButtonElement: dom.HTMLButtonElement,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
  MouseEvent: dom.MouseEvent,
  KeyboardEvent: dom.KeyboardEvent,
  PointerEvent: dom.PointerEvent ?? dom.MouseEvent,
  IntersectionObserver: undefined,
  ResizeObserver: TestResizeObserver,
  requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
});
(dom as unknown as { matchMedia: (query: string) => unknown }).matchMedia = (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} });
globalThis.fetch = (async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

/* The board's scroll offset, in "cards": every card above it is out of frame. */
let scrolledPast = 0;
/* How many measurements the board asked the layout for, counted where it reads. */
let measurements = 0;
const CARD_HEIGHT = 100;
const VIEW_HEIGHT = 250;
const rect = (top: number, height: number) => ({ top, bottom: top + height, left: 0, right: 400, width: 400, height, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
(dom.HTMLElement.prototype as unknown as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect = function boundingRect(this: HTMLElement): DOMRect {
  if (this.classList.contains("card")) {
    measurements += 1;
    const cards = [...(this.closest(".col-body")?.querySelectorAll(".card") ?? [])];
    return rect((cards.indexOf(this) - scrolledPast) * CARD_HEIGHT, CARD_HEIGHT);
  }
  return rect(0, VIEW_HEIGHT);
};

const { flushSync } = await import("react-dom");
const { createRoot } = await import("react-dom/client");
const { viewBus } = await import("@/hooks/viewPresenceBus");
const { KanbanBoard } = await import("./KanbanBoard");

const roots: Root[] = [];
beforeEach(() => {
  scrolledPast = 0;
  measurements = 0;
});
afterEach(() => {
  for (const root of roots.splice(0)) flushSync(() => root.unmount());
  document.body.replaceChildren();
  localStorage.clear();
});

const NOW = 1_800_000_000;
const REV = ["task-v1:00000000", "0000", "4000", "8000", "000000000001"].join("-");
const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

function conversation(index: number): FileEntry {
  return {
    path: `/fixture/conversation-${index}.jsonl`,
    conversationId: `conversation_fixture_${index}`,
    title: `Conversation ${index}`,
    project: "fixture",
    root: "claude-projects",
    kind: "session",
    fmt: "claude",
    engine: "claude",
    mtime: NOW - 600,
    size: 0,
    activity: "idle",
    proc: null,
    pid: null,
    parent: null,
    model: "claude-opus",
    effort: "high",
    pendingQuestion: null,
    waitingInput: null,
    name: `conversation-${index}`,
  } as FileEntry;
}

function task(id: string, status: TaskStatus, text: string, files: readonly FileEntry[]): BoardTask {
  return {
    id,
    project: "fixture",
    text,
    status,
    placement: "unplaced",
    assignments: files.map((file) => ({ path: file.path, conversationId: file.conversationId, panePid: null, state: "handoff", error: null, at: "2026-09-14T10:00:00.000Z" })),
    createdAt: "2026-09-14T10:00:00.000Z",
    updatedAt: "2026-09-14T10:00:00.000Z",
    revision: REV,
  } as BoardTask;
}

const idlePorts: TaskMutationPorts = { patch: async () => ({ ok: false, status: 500, error: "unused" }), read: async () => null, changed: () => {} };

function mount(tasks: BoardTask[], files: FileEntry[]) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  flushSync(() => root.render(
    <KanbanBoard
      project="fixture"
      groups={[]}
      manual={files}
      files={files}
      flows={[]}
      pipelines={[]}
      tasks={[]}
      allTasks={tasks}
      drafts={[]}
      now={NOW}
      loaded
      catalogFailures={0}
      selection={new Set()}
      onOpenConversations={() => {}}
      mutationPorts={idlePorts}
    />,
  ));
  return host;
}

/** Five stacked cards in one column; at rest the first three are in frame. */
function board() {
  const files = [1, 2, 3, 4, 5].map(conversation);
  return { files, host: mount(files.map((file, index) => task(`t${index}`, "assigned", `Task ${index}`, [file])), files) };
}

const visible = () => viewBus.getSlice().visiblePaths;
const scroll = (host: HTMLElement) => {
  const body = host.querySelector(".column[data-status='assigned'] .col-body");
  body?.dispatchEvent(new Event("scroll", { bubbles: true }));
};

test("presence names what is in frame, and follows a settled scroll exactly", async () => {
  const { files, host } = board();
  await tick(20);
  expect(visible()).toEqual([files[0]!.path, files[1]!.path, files[2]!.path]);

  /* Two cards scroll out of the top; the report follows once the gesture ends. */
  scrolledPast = 2;
  scroll(host);
  await tick(200);
  expect(visible()).toEqual([files[2]!.path, files[3]!.path, files[4]!.path]);

  /* And back, so the set is a function of the position, not of a direction. */
  scrolledPast = 0;
  scroll(host);
  await tick(200);
  expect(visible()).toEqual([files[0]!.path, files[1]!.path, files[2]!.path]);
});

test("a scroll gesture is answered by a bounded number of measurements, not one per frame", async () => {
  const { files, host } = board();
  await tick(20);
  expect(measurements).toBeGreaterThan(0);

  /* Forty scroll events, each on its own frame — how a wheel gesture arrives.
     One scan reads all five cards' rects, and a scan per frame is the forced
     layout #1546 measured; scrolling changes nothing the board DRAWS, so this
     scan is the whole cost a gesture can carry. */
  const CARDS = 5;
  const FRAMES = 40;
  measurements = 0;
  for (let i = 0; i < FRAMES; i++) {
    scroll(host);
    await tick(5);
  }
  await tick(250);
  /* Bounded by the throttle and the settle, well under a scan per frame. */
  expect(measurements).toBeLessThan(CARDS * FRAMES / 4);

  /* And the gesture settles at a new position with presence exact again. */
  scrolledPast = 2;
  for (let i = 0; i < FRAMES; i++) {
    scroll(host);
    await tick(5);
  }
  await tick(250);
  expect(visible()).toEqual([files[2]!.path, files[3]!.path, files[4]!.path]);
});
