import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window as HappyWindow } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import type { AssignmentRef, BoardTask } from "@/lib/tasks/types";
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

function file(path: string, title: string, overrides: Partial<FileEntry> = {}): FileEntry {
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
    ...overrides,
  };
}

function boardTask(overrides: Partial<BoardTask> & { id: string }): PlacedTask {
  return {
    project: "project",
    status: "assigned",
    text: "title line\nbody line",
    placement: "pinned",
    pos: { x: 0, y: 0 },
    assignments: [],
    createdAt: "2026-07-18T00:00:00.000Z",
    updatedAt: "2026-07-18T00:00:00.000Z",
    ...overrides,
  } as PlacedTask;
}

interface Calls {
  toggled: string[];
  opened: FileEntry[];
  detached: AssignmentRef[];
  folded: string[];
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
    unassign: (_task, ref) => calls.detached.push(ref),
    center: () => undefined,
    collapse: (task) => calls.folded.push(task.id),
    toggleExpand: (id) => calls.toggled.push(id),
    openAgent: (entry) => calls.opened.push(entry),
  };
}

const camRef = { current: { x: 0, y: 0, z: 1 } as Camera };
const LONG_TEXT = "A long task title\n" + Array.from({ length: 20 }, (_, index) => `durable body line ${index}`).join("\n");

function render(task: PlacedTask, options: { expanded?: boolean; files?: FileEntry[] } = {}) {
  const calls: Calls = { toggled: [], opened: [], detached: [], folded: [], patched: [] };
  const host = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.appendChild(host as never);
  const root = createRoot(host);
  roots.add(root);
  flushSync(() => root.render(
    <TaskCard
      task={task}
      files={options.files ?? []}
      selected={false}
      expanded={options.expanded ?? false}
      camRef={camRef}
      handlers={handlers(calls)}
    />,
  ));
  return { host, calls };
}

test("compact and expanded cards avoid nested scrolling", () => {
  const compact = render(boardTask({ id: "compact", text: LONG_TEXT }));
  const compactBody = compact.host.querySelector("[data-task-body]") as HTMLElement;
  expect(compactBody.className).not.toContain("overflow-y-auto");
  expect(compactBody.style.maxHeight).toBe("");
  expect(compactBody.querySelector(".line-clamp-2")).toBeTruthy();
  expect(compactBody.querySelector(".line-clamp-3")).toBeTruthy();
  const compactDisclosure = compact.host.querySelector("[data-task-disclosure]") as HTMLButtonElement;
  expect(compactDisclosure.getAttribute("aria-expanded")).toBe("false");
  compactDisclosure.click();
  expect(compact.calls.toggled).toEqual(["compact"]);
  expect(compact.calls.patched).toEqual([]);

  const full = render(boardTask({ id: "full", text: LONG_TEXT }), { expanded: true });
  const fullBody = full.host.querySelector("[data-task-body]") as HTMLElement;
  expect(fullBody.querySelector(".line-clamp-2")).toBeNull();
  expect(fullBody.querySelector(".line-clamp-3")).toBeNull();
  expect(fullBody.textContent).toContain("durable body line 19");
  expect(full.host.querySelector("[data-task-disclosure]")?.getAttribute("aria-expanded")).toBe("true");
});

test("a clipped compact preview fades out and the expanded body drops the fade", () => {
  const compact = render(boardTask({ id: "compact", text: LONG_TEXT }));
  const compactBody = compact.host.querySelector("[data-task-body]") as HTMLElement;
  expect(compactBody.hasAttribute("data-task-clipped")).toBe(true);
  expect(compactBody.style.maskImage).toContain("linear-gradient");

  const short = render(boardTask({ id: "short", text: "fits\nentirely" }));
  const shortBody = short.host.querySelector("[data-task-body]") as HTMLElement;
  expect(shortBody.hasAttribute("data-task-clipped")).toBe(false);
  expect(shortBody.style.maskImage || "").toBe("");

  const full = render(boardTask({ id: "full", text: LONG_TEXT }), { expanded: true });
  const fullBody = full.host.querySelector("[data-task-body]") as HTMLElement;
  expect(fullBody.hasAttribute("data-task-clipped")).toBe(false);
  expect(fullBody.style.maskImage || "").toBe("");
});

test("the action row hides behind hover on compact cards but stays pinned while expanded", () => {
  const compact = render(boardTask({ id: "compact", text: LONG_TEXT }));
  const compactRow = compact.host.querySelector("[data-task-actions]") as HTMLElement;
  expect(compactRow.className).toContain("opacity-0");

  const full = render(boardTask({ id: "full", text: LONG_TEXT }), { expanded: true });
  const fullRow = full.host.querySelector("[data-task-actions]") as HTMLElement;
  expect(fullRow.className).not.toContain("opacity-0");
  expect(fullRow.className).not.toContain("pointer-events-none");
});

test("the source chip opens the originating conversation and disables truthfully when it is gone", () => {
  const origin = file("/origin.jsonl", "Origin conversation");
  const sourced = boardTask({
    id: "sourced",
    source: { path: "/origin.jsonl", ts: null, text: "captured", fingerprint: "f1", engine: "codex" },
  });
  const live = render(sourced, { files: [origin] });
  const open = live.host.querySelector("[data-task-open-source]") as HTMLButtonElement;
  expect(open.disabled).toBe(false);
  expect(open.getAttribute("aria-label")).toBe("Open source conversation Origin conversation");
  open.click();
  expect(live.calls.opened.map((entry) => entry.path)).toEqual(["/origin.jsonl"]);

  const gone = render(sourced, { files: [] });
  const disabled = gone.host.querySelector("[data-task-open-source]") as HTMLButtonElement;
  expect(disabled.disabled).toBe(true);
  expect(disabled.title).toBe("the source conversation is not on the board");
});

test("text disclosure and fold-to-stack remain separate actions", () => {
  const { host, calls } = render(boardTask({ id: "task", text: LONG_TEXT }));
  (host.querySelector("[data-task-disclosure]") as HTMLButtonElement).click();
  (host.querySelector('[aria-label="Fold the card back into its status stack"]') as HTMLButtonElement).click();
  expect(calls.toggled).toEqual(["task"]);
  expect(calls.folded).toEqual(["task"]);
});

test("a live assignment opens the current generation through a 28px control", () => {
  const current = file("/current.jsonl", "Reviewer", { conversationId: "conversation-1", activity: "live" });
  const item = boardTask({
    id: "task",
    assignments: [{ path: "/old.jsonl", conversationId: "conversation-1", panePid: 42, state: "delivered", error: null, at: "now" }],
  });
  const { host, calls } = render(item, { files: [current] });
  const open = host.querySelector("[data-task-open-agent]") as HTMLButtonElement;
  expect(open.disabled).toBe(false);
  expect(open.className).toContain("h-7");
  expect(open.className).toContain("w-7");
  expect(open.getAttribute("aria-label")).toContain("Reviewer");
  open.click();
  expect(calls.opened.map((entry) => entry.path)).toEqual(["/current.jsonl"]);
});

test("failed and unavailable assignments show truthful controls and remain detachable", () => {
  const killed = file("/killed.jsonl", "Stopped agent", { proc: "killed", activity: "idle" });
  const item = boardTask({
    id: "task",
    assignments: [
      { path: null, conversationId: "failed-conversation", panePid: 77, state: "failed", error: "no pane", at: "now" },
      { path: killed.path, conversationId: "killed-conversation", panePid: 88, state: "delivered", error: null, at: "now" },
      { path: null, conversationId: "spawning-conversation", panePid: 99, state: "spawning", error: null, at: "now" },
    ],
  });
  const { host, calls } = render(item, { files: [killed] });
  expect(host.querySelectorAll(".animate-spin")).toHaveLength(1);
  const openControls = [...host.querySelectorAll("[data-task-open-agent]")] as HTMLButtonElement[];
  expect(openControls.every((control) => control.disabled)).toBe(true);
  expect(openControls.some((control) => control.title.includes("killed"))).toBe(true);
  const detach = [...host.querySelectorAll('button[title="detach"]')] as HTMLButtonElement[];
  expect(detach).toHaveLength(3);
  detach[0]!.click();
  expect(calls.detached[0]).toEqual({ path: null, conversationId: "failed-conversation", panePid: 77 });
});
