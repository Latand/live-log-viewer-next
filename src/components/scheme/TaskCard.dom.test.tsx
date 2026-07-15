import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window as HappyWindow } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";

import type { Camera } from "./Minimap";
import { TaskCard, type TaskCardHandlers } from "./TaskCard";
import type { PlacedTask } from "./taskGeometry";

const dom = new HappyWindow();

function bindDomGlobals() {
  Object.assign(globalThis, {
    window: dom,
    document: dom.document,
    navigator: dom.navigator,
    Node: dom.Node,
    HTMLElement: dom.HTMLElement,
    HTMLButtonElement: dom.HTMLButtonElement,
    HTMLTextAreaElement: dom.HTMLTextAreaElement,
    Event: dom.Event,
    CustomEvent: dom.CustomEvent,
    MouseEvent: dom.MouseEvent,
    PointerEvent: dom.PointerEvent ?? dom.MouseEvent,
    sessionStorage: dom.sessionStorage,
    localStorage: dom.localStorage,
  });
}

bindDomGlobals();

const roots = new Set<Root>();

beforeEach(bindDomGlobals);

afterEach(() => {
  for (const root of roots) flushSync(() => root.unmount());
  roots.clear();
  dom.document.body.replaceChildren();
  dom.localStorage.clear();
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

function boardTask(over: Partial<BoardTask> & { id: string }): PlacedTask {
  return {
    project: "project",
    status: "assigned",
    text: "title line\nbody line",
    placement: "pinned",
    pos: { x: 0, y: 0 },
    assignments: [],
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...over,
  } as PlacedTask;
}

interface Calls {
  toggled: string[];
  opened: FileEntry[];
  patched: string[];
}

function handlers(calls: Calls): TaskCardHandlers {
  return {
    patch: async (id) => {
      calls.patched.push(id);
      return null;
    },
    remove: () => undefined,
    handoff: async () => null,
    draft: () => undefined,
    unassign: () => undefined,
    center: () => undefined,
    toggleExpand: (id) => calls.toggled.push(id),
    openAgent: (entry) => calls.opened.push(entry),
  };
}

const camRef = { current: { x: 0, y: 0, z: 1 } as Camera };

function render(task: PlacedTask, opts: { expanded?: boolean; files?: FileEntry[]; calls?: Calls } = {}): { host: HTMLElement; calls: Calls } {
  const calls = opts.calls ?? { toggled: [], opened: [], patched: [] };
  const host = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.appendChild(host as never);
  const root = createRoot(host);
  roots.add(root);
  flushSync(() =>
    root.render(
      <TaskCard task={task} files={opts.files ?? []} selected={false} expanded={opts.expanded ?? false} camRef={camRef} handlers={handlers(calls)} />,
    ),
  );
  return { host, calls };
}

const LONG_TEXT = "A long task title\n" + Array.from({ length: 20 }, (_, i) => `durable body line ${i}`).join("\n");

test("collapsed card clamps its text with no internal scrollbar and offers «Expand task»", () => {
  const { host } = render(boardTask({ id: "t1", text: LONG_TEXT }));
  const body = host.querySelector("[data-task-body]")!;
  /* No scroll container: the collapsed presentation clamps via line-clamp. */
  expect(body.className.includes("overflow-y-auto")).toBe(false);
  expect((body as HTMLElement).style.maxHeight).toBe("");
  expect(body.querySelector(".line-clamp-2")).not.toBeNull();
  expect(body.querySelector(".line-clamp-3")).not.toBeNull();
  const disclosure = host.querySelector("[data-task-disclosure]")!;
  expect(disclosure.getAttribute("aria-expanded")).toBe("false");
  expect(disclosure.textContent).toContain("Expand task");
});

test("expanded card shows the full text unclamped and offers «Collapse task»", () => {
  const { host } = render(boardTask({ id: "t1", text: LONG_TEXT }), { expanded: true });
  const body = host.querySelector("[data-task-body]")!;
  expect(body.querySelector(".line-clamp-2")).toBeNull();
  expect(body.querySelector(".line-clamp-3")).toBeNull();
  expect(body.textContent).toContain("durable body line 19");
  const disclosure = host.querySelector("[data-task-disclosure]")!;
  expect(disclosure.getAttribute("aria-expanded")).toBe("true");
  expect(disclosure.textContent).toContain("Collapse task");
});

test("the disclosure toggles through the board-owned handler and never edits the task", () => {
  const { host, calls } = render(boardTask({ id: "t1", text: LONG_TEXT }));
  (host.querySelector("[data-task-disclosure]") as HTMLButtonElement).click();
  expect(calls.toggled).toEqual(["t1"]);
  expect(calls.patched).toEqual([]);
});

test("a short card renders no disclosure", () => {
  const { host } = render(boardTask({ id: "t1", text: "short\ntiny" }));
  expect(host.querySelector("[data-task-disclosure]")).toBeNull();
});

test("a live assignment gets an enabled open-agent control that activates the canonical opener", () => {
  const agent = file("/agents/one.jsonl", "Reviewer");
  const task = boardTask({
    id: "t1",
    assignments: [{ path: agent.path, panePid: null, state: "delivered", error: null, at: "2026-07-01T00:00:00.000Z" }],
  });
  const { host, calls } = render(task, { files: [agent] });
  const open = host.querySelector("[data-task-open-agent]") as HTMLButtonElement;
  expect(open.hasAttribute("disabled")).toBe(false);
  expect(open.getAttribute("aria-label")).toContain("Reviewer");
  open.click();
  expect(calls.opened.map((f) => f.path)).toEqual([agent.path]);
  /* Opening an agent is never an edit/drag/delete/mutation. */
  expect(calls.patched).toEqual([]);
});

test("multiple assignments stay individually reachable with distinct labels", () => {
  const one = file("/agents/one.jsonl", "Implementer");
  const two = file("/agents/two.jsonl", "Reviewer");
  const task = boardTask({
    id: "t1",
    assignments: [
      { path: one.path, panePid: null, state: "delivered", error: null, at: "2026-07-01T00:00:00.000Z" },
      { path: two.path, panePid: null, state: "handoff", error: null, at: "2026-07-01T00:00:00.000Z" },
    ],
  });
  const { host, calls } = render(task, { files: [one, two] });
  const opens = [...host.querySelectorAll("[data-task-open-agent]")] as HTMLButtonElement[];
  expect(opens).toHaveLength(2);
  expect(opens[0]!.getAttribute("aria-label")).toContain("Implementer");
  expect(opens[1]!.getAttribute("aria-label")).toContain("Reviewer");
  opens[1]!.click();
  expect(calls.opened.map((f) => f.path)).toEqual([two.path]);
});

test("a dead assignment renders a truthful disabled control; a spawning one renders none", () => {
  const task = boardTask({
    id: "t1",
    assignments: [
      { path: "/gone.jsonl", panePid: null, state: "delivered", error: null, at: "2026-07-01T00:00:00.000Z" },
      { path: null, panePid: null, state: "spawning", error: null, at: "2026-07-01T00:00:00.000Z" },
    ],
  });
  const { host, calls } = render(task);
  const opens = [...host.querySelectorAll("[data-task-open-agent]")] as HTMLButtonElement[];
  /* One control for the dead path, none for the spawning chip. */
  expect(opens).toHaveLength(1);
  expect(opens[0]!.hasAttribute("disabled")).toBe(true);
  opens[0]!.click();
  expect(calls.opened).toEqual([]);
});
