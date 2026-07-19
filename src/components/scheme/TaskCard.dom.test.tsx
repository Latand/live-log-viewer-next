import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window as HappyWindow } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import type { AssignmentRef, BoardTask } from "@/lib/tasks/types";
import type { Pipeline } from "@/lib/pipelines/types";
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

function render(task: PlacedTask, options: { expanded?: boolean; files?: FileEntry[]; completedPipelines?: Pipeline[]; onOpenPipelineHistory?: (pipeline: Pipeline) => void } = {}) {
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
      completedPipelines={options.completedPipelines}
      onOpenPipelineHistory={options.onOpenPipelineHistory}
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

test("a completed linked pipeline collapses to one task-card history chip", () => {
  const opened: string[] = [];
  const completed = {
    id: "pipeline-done",
    task: "Completed pipeline",
    state: "completed",
    stages: [],
    runs: [],
    cursor: null,
  } as unknown as Pipeline;
  const { host } = render(boardTask({ id: "task" }), {
    completedPipelines: [completed],
    onOpenPipelineHistory: (pipeline) => opened.push(pipeline.id),
  });

  const chip = host.querySelector('[data-task-pipeline-history="pipeline-done"]') as HTMLButtonElement;
  expect(chip).toBeTruthy();
  expect(chip.textContent).toContain("✓ pipeline");
  chip.click();
  expect(opened).toEqual(["pipeline-done"]);
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
  const unavailable = gone.host.querySelector("[data-task-open-source]") as HTMLButtonElement;
  /* Truthful accessibility (issue #292 fresh review): the control stays in the
     tab order and announces *why* it can't open, instead of vanishing from
     keyboard and screen-reader reach behind a native `disabled`. */
  expect(unavailable.disabled).toBe(false);
  expect(unavailable.getAttribute("aria-disabled")).toBe("true");
  expect(unavailable.getAttribute("aria-label")).toBe(
    "Open source conversation origin.jsonl — unavailable: the source conversation is not on the board",
  );
  expect(unavailable.title).toBe("the source conversation is not on the board");
  unavailable.click();
  expect(gone.calls.opened).toEqual([]);
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
  expect(openControls).toHaveLength(2);
  const [failedOpen, killedOpen] = openControls as [HTMLButtonElement, HTMLButtonElement];
  /* Unresolvable (failed) controls stay keyboard-reachable, announce their
     reason, and remain inert on activation (issue #292 fresh review). */
  expect(failedOpen.getAttribute("aria-disabled")).toBe("true");
  expect(failedOpen.getAttribute("aria-label")).toContain("unavailable");
  failedOpen.click();
  expect(calls.opened).toEqual([]);
  /* A killed host still resolves a transcript on the board — navigation stays
     available (fresh-review Finding 1) while the chip keeps its truthful
     killed presentation. */
  expect(killedOpen.getAttribute("aria-disabled")).toBeNull();
  killedOpen.click();
  expect(calls.opened.map((entry) => entry.path)).toEqual(["/killed.jsonl"]);
  const detach = [...host.querySelectorAll('button[title="detach"]')] as HTMLButtonElement[];
  expect(detach).toHaveLength(3);
  detach[0]!.click();
  expect(calls.detached[0]).toEqual({ launchId: null, path: null, conversationId: "failed-conversation", panePid: 77 });
});

test("stalled and idle assigned agents keep an enabled navigation control (fresh-review Finding 1)", () => {
  const stalled = file("/stalled.jsonl", "Stalled agent", { proc: null, activity: "stalled" });
  const idle = file("/idle.jsonl", "Idle agent", { proc: null, activity: "idle" });
  const item = boardTask({
    id: "task",
    assignments: [
      { path: stalled.path, conversationId: "stalled-conversation", panePid: 11, state: "delivered", error: null, at: "now" },
      { path: idle.path, conversationId: "idle-conversation", panePid: 12, state: "delivered", error: null, at: "now" },
    ],
  });
  const { host, calls } = render(item, { files: [stalled, idle] });
  const openControls = [...host.querySelectorAll("[data-task-open-agent]")] as HTMLButtonElement[];
  expect(openControls).toHaveLength(2);
  for (const control of openControls) {
    expect(control.getAttribute("aria-disabled")).toBeNull();
    control.click();
  }
  expect(calls.opened.map((entry) => entry.path)).toEqual(["/stalled.jsonl", "/idle.jsonl"]);
});

test("a pathless spawning assignment keeps a stable launch handle for detach", () => {
  const item = boardTask({
    id: "task",
    assignments: [
      { launchId: "launch-9", path: null, conversationId: null, panePid: null, state: "spawning", error: null, at: "now" },
    ],
  });
  const { host, calls } = render(item);
  const detach = host.querySelector('button[title="detach"]') as HTMLButtonElement;
  detach.click();
  expect(calls.detached[0]).toEqual({ launchId: "launch-9", path: null, conversationId: null, panePid: null });
});

test("a handle-less legacy spawning assignment hides detach instead of offering a doomed 400 (fresh-review Finding 2)", () => {
  /* Pre-launch-id stores can hold a spawning assignment whose launchId, path,
     conversationId, and panePid are all null. The DELETE route rejects that
     empty ref, so a rendered detach control could only ever fail — the visible
     control must always succeed or be absent. */
  const item = boardTask({
    id: "task",
    assignments: [{ path: null, conversationId: null, panePid: null, state: "spawning", error: null, at: "now" }],
  });
  const { host, calls } = render(item);
  expect(host.querySelectorAll(".animate-spin")).toHaveLength(1);
  expect(host.querySelector('button[title="detach"]')).toBeNull();
  expect(calls.detached).toEqual([]);

  /* Any single usable handle restores the control, and the ref it carries is
     one the route accepts. */
  const withPane = boardTask({
    id: "task-2",
    assignments: [{ path: null, conversationId: null, panePid: 41, state: "spawning", error: null, at: "now" }],
  });
  const restored = render(withPane);
  const detach = restored.host.querySelector('button[title="detach"]') as HTMLButtonElement;
  expect(detach).toBeTruthy();
  detach.click();
  expect(restored.calls.detached[0]).toEqual({ launchId: null, path: null, conversationId: null, panePid: 41 });
});

/* Emulate a real layout engine on top of happy-dom (which reports zero heights,
   the signal TaskCard treats as «no layout — keep the estimate»): fixed
   client/scroll heights stand in for the browser's clamp measurement. */
function withLayoutMetrics(metrics: { clientHeight: number; scrollHeight: number }, run: () => void) {
  const proto = dom.HTMLElement.prototype as unknown as Record<string, unknown>;
  const originals = {
    clientHeight: Object.getOwnPropertyDescriptor(proto, "clientHeight"),
    scrollHeight: Object.getOwnPropertyDescriptor(proto, "scrollHeight"),
  };
  Object.defineProperty(proto, "clientHeight", { configurable: true, get: () => metrics.clientHeight });
  Object.defineProperty(proto, "scrollHeight", { configurable: true, get: () => metrics.scrollHeight });
  try {
    run();
  } finally {
    for (const [key, descriptor] of Object.entries(originals)) {
      if (descriptor) Object.defineProperty(proto, key, descriptor);
      else delete proto[key];
    }
  }
}

/* 40 wide glyphs: the conservative wrap model (13px per glyph) estimates three
   title rows — past the two-row clamp — while a real proportional font fits the
   clamp. The card must trust the browser's clamp state, not the estimate. */
const OVERESTIMATED_TEXT = "W".repeat(40);

test("real layout measuring unclipped suppresses the phantom disclosure and fade", () => {
  /* Without layout (zero heights) the estimate stays authoritative… */
  const fallback = render(boardTask({ id: "estimated", text: OVERESTIMATED_TEXT }));
  expect(fallback.host.querySelector("[data-task-disclosure]")).toBeTruthy();

  /* …but once the DOM reports the clamped elements as not truncated, the
     Expand control and the fade both disappear — no phantom expansion. */
  withLayoutMetrics({ clientHeight: 34, scrollHeight: 34 }, () => {
    const { host } = render(boardTask({ id: "short-real", text: OVERESTIMATED_TEXT }));
    expect(host.querySelector("[data-task-disclosure]")).toBeNull();
    const body = host.querySelector("[data-task-body]") as HTMLElement;
    expect(body.hasAttribute("data-task-clipped")).toBe(false);
    expect(body.style.maskImage || "").toBe("");
  });
});

test("real clamp overflow keeps the disclosure and fade truthful", () => {
  withLayoutMetrics({ clientHeight: 34, scrollHeight: 120 }, () => {
    const { host } = render(boardTask({ id: "clipped-real", text: OVERESTIMATED_TEXT }));
    expect(host.querySelector("[data-task-disclosure]")).toBeTruthy();
    const body = host.querySelector("[data-task-body]") as HTMLElement;
    expect(body.hasAttribute("data-task-clipped")).toBe(true);
    expect(body.style.maskImage).toContain("linear-gradient");
  });
});

test("a pathless failed assignment shows its terminal state with a compact retry launch control (#334)", async () => {
  const fetches: Array<{ url: string; body: unknown }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    fetches.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
    return new Response(JSON.stringify({ ok: true, task: { id: "retry-task" }, assignment: "spawning" }), {
      status: 202,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    const task = boardTask({
      id: "retry-task",
      assignments: [{
        launchId: "launch-334",
        clientAttemptId: "task_334_attempt",
        path: null,
        conversationId: "conversation_334",
        panePid: null,
        state: "failed",
        error: "structured spawn runtime snapshot has no session after 300000ms",
        at: "2026-07-19T10:00:00.000Z",
      }],
    });
    const { host } = render(task);

    /* Terminal, not a spinner: the failed chip never renders the spawning
       loader, and its ⚠ badge plus error title stay visible. */
    const chip = host.querySelector("[data-task-retry-launch]")?.closest("span");
    expect(chip).toBeTruthy();
    expect(chip!.textContent).toContain("delivery failed");
    expect(chip!.getAttribute("title")).toContain("no session after 300000ms");
    expect(chip!.querySelector(".animate-spin")).toBeNull();

    const retry = host.querySelector("[data-task-retry-launch]") as HTMLButtonElement;
    expect(retry.getAttribute("aria-label")).toBe("Retry the failed launch for delivery failed");
    retry.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetches).toEqual([{
      url: "/api/tasks/retry-task/spawn",
      body: { retryOfLaunchId: "launch-334" },
    }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a live assignment offers no retry launch control", () => {
  const agent = file("/agent.jsonl", "Live agent");
  const task = boardTask({
    id: "live-task",
    assignments: [{
      launchId: "launch-live",
      clientAttemptId: null,
      path: "/agent.jsonl",
      conversationId: "conversation_live",
      panePid: 42,
      state: "delivered",
      error: null,
      at: "2026-07-19T10:00:00.000Z",
    }],
  });
  const { host } = render(task, { files: [agent] });
  expect(host.querySelector("[data-task-retry-launch]")).toBeNull();
});
