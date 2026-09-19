import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { translate } from "@/lib/i18n";
import type { BoardTask, TaskStatus } from "@/lib/tasks/types";

import type { TaskMutationPorts } from "./useTaskMutations";

/* + Task, + Agent and agent drafts on the kanban board (#1695 K9a), rendered by
   React against invented tasks. The task route is a scripted fetch; no store or
   state directory is touched. */

const dom = new Window({ url: "http://localhost/" });
const matchMedia = () => ({ matches: false, media: "", addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false });
(dom as unknown as { matchMedia: typeof matchMedia }).matchMedia = matchMedia;
/* The board's width, as its ResizeObserver reports it: wide enough for the bar's labelled tier (#1801). */
let boardWidth = 1760;
const resizeCallbacks = new Set<() => void>();
class TestResizeObserver {
  private readonly callback: () => void;
  constructor(callback: () => void) { this.callback = callback; }
  observe() { resizeCallbacks.add(this.callback); }
  unobserve() {}
  disconnect() { resizeCallbacks.delete(this.callback); }
}
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
  matchMedia,
  ResizeObserver: TestResizeObserver,
  IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } },
  requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
});
const measure = dom.HTMLElement.prototype.getBoundingClientRect;
dom.HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
  const rect = measure.call(this);
  return this.classList?.contains("kb") ? { ...rect, width: boardWidth, right: boardWidth } as DOMRect : rect;
} as typeof measure;
(dom.HTMLElement.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {};

const { KanbanBoard } = await import("./KanbanBoard");

const roots: Root[] = [];
let posts: Array<{ url: string; body: Record<string, unknown> }> = [];
let taskAnswer: (body: Record<string, unknown>) => Response = () => new Response("{}", { status: 500 });
let previousFetch: typeof fetch;
beforeEach(() => {
  boardWidth = 1760;
  posts = [];
  previousFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/tasks" && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      posts.push({ url, body });
      return taskAnswer(body);
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = previousFetch;
  for (const root of roots.splice(0)) flushSync(() => root.unmount());
  resizeCallbacks.clear();
  document.body.replaceChildren();
  dom.localStorage.clear();
  dom.sessionStorage.clear();
});

function task(id: string, status: TaskStatus, text: string): BoardTask {
  return {
    id, project: "fixture", text, status, placement: "unplaced", assignments: [],
    createdAt: "2026-09-14T10:00:00.000Z", updatedAt: "2026-09-14T10:00:00.000Z",
    revision: `task-v1:00000000-0000-4000-8000-${"1".padStart(12, "0")}`,
  } as BoardTask;
}

const inertPorts: TaskMutationPorts = { patch: async () => ({ ok: false, status: 500, error: "unused" }), read: async () => null, changed: () => {} };
const settle = async (rounds = 6) => {
  for (let index = 0; index < rounds; index += 1) await new Promise((resolve) => setTimeout(resolve, 5));
};

type Extra = Partial<React.ComponentProps<typeof KanbanBoard>>;
function mount(tasks: BoardTask[], extra: Extra = {}) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  const render = (next: Extra = {}) => flushSync(() => root.render(
    <KanbanBoard
      project="fixture"
      groups={[]}
      manual={[]}
      files={[]}
      flows={[]}
      pipelines={[]}
      tasks={[]}
      allTasks={tasks}
      drafts={[]}
      now={1_800_000_000}
      loaded
      catalogFailures={0}
      selection={new Set()}
      onOpenConversations={() => {}}
      seatRefs={null}
      mutationPorts={inertPorts}
      readerStorage={null}
      {...extra}
      {...next}
    />,
  ));
  render();
  return { host, render };
}

const click = (element: Element | null | undefined) => {
  expect(element).toBeTruthy();
  flushSync(() => (element as HTMLElement).click());
};
/* React's own onChange: happy-dom's input event does not reach a controlled textarea. */
const type = (field: Element | null, value: string) => {
  expect(field).toBeTruthy();
  const key = Object.keys(field as object).find((name) => name.startsWith("__reactProps$"))!;
  flushSync(() => (field as unknown as Record<string, { onChange: (event: unknown) => void }>)[key]!.onChange({ target: { value } }));
};
const columnOf = (element: Element | null | undefined) => element?.closest<HTMLElement>(".column")?.dataset.status ?? null;

test("+ Task opens a card at the top of Inbox, creates the task once with its request id and draws it at once", async () => {
  taskAnswer = (body) => new Response(JSON.stringify({ task: { ...task("created", "inbox", String(body.text)), placement: body.placement } }), { status: 200, headers: { "content-type": "application/json" } });
  const { host } = mount([task("a", "inbox", "An older inbox task")]);
  click(host.querySelector("[data-new-task]"));
  const composer = host.querySelector("[data-kanban-new-task]");
  expect(columnOf(composer)).toBe("inbox");
  /* First in the column, above every card. */
  expect(composer?.parentElement?.firstElementChild === composer).toBe(true);
  expect(host.querySelector("[data-new-task]")?.getAttribute("aria-expanded")).toBe("true");

  type(composer!.querySelector('textarea[aria-label="Task text"]'), "Write the migration guide\nFor the release notes");
  flushSync(() => composer!.dispatchEvent(new dom.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event));
  await settle();

  expect(posts).toHaveLength(1);
  expect(posts[0]!.body).toMatchObject({ project: "fixture", text: "Write the migration guide\nFor the release notes", placement: "unplaced" });
  expect(typeof posts[0]!.body.clientRequestId).toBe("string");
  expect(host.querySelector("[data-kanban-new-task]")).toBeNull();
  /* Drawn before the tasks poll carries it, in Inbox, with a receipt. */
  expect(columnOf(host.querySelector('.card[data-id="task:created"]'))).toBe("inbox");
  expect([...host.querySelectorAll("[data-kanban-receipt] .msg")].map((node) => node.textContent)).toContain("Created «Write the migration guide» in Inbox");
});

test("a created task drawn ahead of the poll leaves with the next tasks payload that does not carry it, and stays with one that does", async () => {
  taskAnswer = (body) => new Response(JSON.stringify({ task: { ...task("created", "inbox", String(body.text)), placement: body.placement } }), { status: 200, headers: { "content-type": "application/json" } });
  const stored = [task("a", "inbox", "An older inbox task")];
  const { host, render } = mount(stored);
  const create = async (text: string) => {
    click(host.querySelector("[data-new-task]"));
    const composer = host.querySelector("[data-kanban-new-task]")!;
    type(composer.querySelector('textarea[aria-label="Task text"]'), text);
    flushSync(() => composer.dispatchEvent(new dom.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event));
    await settle();
  };
  await create("Deleted before the poll");
  expect(host.querySelector('.card[data-id="task:created"]')).not.toBeNull();
  /* The next payload has no such task: it was deleted, or moved to another project, before the poll. */
  render({ allTasks: [...stored] });
  expect(host.querySelector('.card[data-id="task:created"]')).toBeNull();

  await create("Carried by the poll");
  expect(host.querySelector('.card[data-id="task:created"]')).not.toBeNull();
  render({ allTasks: [...stored, task("created", "inbox", "Carried by the poll")] });
  expect(host.querySelector('.card[data-id="task:created"]')).not.toBeNull();
  expect(host.querySelectorAll('.card[data-id="task:created"]')).toHaveLength(1);
});

test("a refused create keeps the text on the new card and says why; Escape closes it without writing", async () => {
  taskAnswer = () => new Response(JSON.stringify({ error: "Project task limit reached" }), { status: 409, headers: { "content-type": "application/json" } });
  const { host } = mount([]);
  click(host.querySelector("[data-new-task]"));
  const composer = host.querySelector("[data-kanban-new-task]")!;
  type(composer.querySelector('textarea[aria-label="Task text"]'), "Refused text stays");
  flushSync(() => composer.dispatchEvent(new dom.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event));
  await settle();
  expect(posts).toHaveLength(1);
  expect(host.querySelector("[data-kanban-new-task]")).not.toBeNull();
  expect((host.querySelector('[data-kanban-new-task] textarea[aria-label="Task text"]') as HTMLTextAreaElement).value).toBe("Refused text stays");
  expect(host.querySelector("[data-kanban-new-task]")?.textContent).toContain("Project task limit reached");
  expect(host.querySelector('.card[data-id^="task:"]')).toBeNull();

  flushSync(() => host.querySelector("[data-kanban-new-task]")!.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }) as unknown as Event));
  expect(host.querySelector("[data-kanban-new-task]")).toBeNull();
  expect(posts).toHaveLength(1);
});

test("+ Agent in the bar asks for a draft once the board has loaded; a card's + Agent asks for one on that card", () => {
  const asked: string[] = [];
  const onCard: Array<{ id: string; taskId: string | null; title: string }> = [];
  const { host, render } = mount([task("a", "assigned", "Repair old links")], {
    loaded: false,
    onNewAgent: () => asked.push("bar"),
    onAddAgent: (band) => onCard.push({ id: band.id, taskId: band.task?.id ?? null, title: band.title }),
  });
  const bar = host.querySelector<HTMLButtonElement>("[data-new-agent]");
  expect(bar?.getAttribute("aria-label")).toBe("New conversation with an agent");
  expect(bar?.disabled).toBe(true);

  render({ loaded: true });
  click(host.querySelector("[data-new-agent]"));
  expect(asked).toEqual(["bar"]);

  const add = host.querySelector('.card[data-id="task:a"] [data-add-agent]');
  expect(add?.getAttribute("aria-label")).toBe("Add an agent to «Repair old links»");
  click(add);
  expect(onCard).toEqual([{ id: "task:a", taskId: "a", title: "Repair old links" }]);
});

test("a draft is drawn inside the card that holds it, is never sent to Conversations, and its close hands the id back", async () => {
  const closed: string[] = [];
  const { host } = mount([task("a", "inbox", "Repair old links")], {
    drafts: ["draft-on-a", "draft-alone"],
    draftBands: new Map([["draft-on-a", "task:a"]]),
    onDraftClose: (id) => closed.push(id),
  });
  await settle();
  const onA = host.querySelector('.card[data-id="task:a"] [data-kanban-draft="draft-on-a"]');
  expect(onA?.querySelector('[aria-label="Draft of a new agent conversation"]')).not.toBeNull();
  expect(host.querySelector('.card[data-id="task:a"] .refs')).toBeNull();
  /* A draft no task holds is a card of its own under Not on a task. */
  const alone = host.querySelector('[data-kanban-draft="draft-alone"]')?.closest(".card");
  expect(alone?.getAttribute("data-id")).toBe("draft:draft-alone");
  expect(columnOf(alone)).toBe("inbox");
  /* A shelf column holding a draft widens to reading width. */
  expect(host.querySelector(".column[data-status=inbox]")?.classList.contains("reading")).toBe(true);

  click(onA!.querySelector(`button[aria-label="${translate("en", "draft.dismiss")}"]`));
  expect(closed).toEqual(["draft-on-a"]);
});

test("crossing a width breakpoint keeps a card's draft pane mounted", async () => {
  const { host } = mount([task("a", "inbox", "Repair old links")], { drafts: ["draft-on-a"], draftBands: new Map([["draft-on-a", "task:a"]]) });
  await settle();
  const pane = host.querySelector('[data-kanban-draft="draft-on-a"] section');
  expect(pane).not.toBeNull();
  expect(host.querySelector("[data-kanban-board]")?.getAttribute("data-mode")).toBe("wide");

  for (const [width, mode] of [[1280, "narrow"], [900, "scroll"], [700, "tabs"], [1440, "wide"]] as const) {
    boardWidth = width;
    flushSync(() => { for (const callback of resizeCallbacks) callback(); });
    expect(host.querySelector("[data-kanban-board]")?.getAttribute("data-mode")).toBe(mode);
    /* The same element: identity, compared as such (a matcher may compare DOM nodes by shape). */
    expect(host.querySelector('[data-kanban-draft="draft-on-a"] section') === pane).toBe(true);
  }
});
