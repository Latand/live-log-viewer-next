import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import type { FileEntry } from "@/lib/types";

import { SchemeBoard } from "./SchemeBoard";

const dom = new Window();
class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(dom as unknown as { matchMedia: (query: string) => unknown }).matchMedia = () => ({
  matches: false,
  media: "",
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
  onchange: null,
  dispatchEvent: () => false,
});

const requestFrame = (callback: FrameRequestCallback) => dom.setTimeout(() => callback(0), 0);
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLButtonElement: dom.HTMLButtonElement,
  HTMLDivElement: dom.HTMLDivElement,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
  MouseEvent: dom.MouseEvent,
  PointerEvent: dom.PointerEvent,
  WheelEvent: dom.WheelEvent,
  sessionStorage: dom.sessionStorage,
  localStorage: dom.localStorage,
  ResizeObserver: TestResizeObserver,
  IntersectionObserver: undefined,
  requestAnimationFrame: requestFrame,
  cancelAnimationFrame: (id: number) => dom.clearTimeout(id as never),
});

const roots = new Set<Root>();
afterEach(() => {
  for (const root of roots) flushSync(() => root.unmount());
  roots.clear();
  document.body.replaceChildren();
  dom.sessionStorage.clear();
  dom.localStorage.clear();
});

const settle = async () => {
  for (let index = 0; index < 3; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  flushSync(() => undefined);
};

test("the scheme viewport keeps its minimap and camera gestures after descendant focus scrolling", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.add(root);
  flushSync(() => {
    root.render(
      <SchemeBoard
        project="camera-regression"
        groups={[]}
        manual={[]}
        files={[]}
        flows={[]}
        tasks={[]}
        drafts={[]}
        focus={null}
        onSelect={() => {}}
        onClose={() => {}}
        onDraftClose={() => {}}
        onDraftSpawned={() => {}}
      />,
    );
  });
  await settle();

  const viewport = host.querySelector('[aria-label^="Agent board"]') as HTMLDivElement;
  const minimap = host.querySelector('[title^="Minimap"]');
  const world = Array.from(viewport.children).find((child) =>
    (child as HTMLElement).style.transform.includes("scale("),
  ) as HTMLElement;
  expect(viewport).toBeTruthy();
  expect(minimap).toBeTruthy();
  expect(world).toBeTruthy();

  /* A focused runtime control in a distant card can scroll an overflow-clipped
     ancestor. The camera viewport owns a fixed scroll origin. */
  viewport.scrollLeft = 180;
  viewport.scrollTop = 90;
  flushSync(() =>
    viewport.dispatchEvent(new dom.Event("scroll", { bubbles: true }) as unknown as Event),
  );
  expect({ left: viewport.scrollLeft, top: viewport.scrollTop }).toEqual({ left: 0, top: 0 });

  const beforeWheel = world.style.transform;
  const wheel = new dom.WheelEvent("wheel", {
    bubbles: true,
    cancelable: true,
    deltaY: -100,
  });
  Object.defineProperties(wheel, {
    clientX: { value: 400 },
    clientY: { value: 300 },
    ctrlKey: { value: true },
  });
  flushSync(() => viewport.dispatchEvent(wheel as unknown as Event));
  await settle();
  expect(world.style.transform).not.toBe(beforeWheel);

  const hand = Array.from(host.querySelectorAll("button")).find((button) =>
    button.title.startsWith("Hand"),
  ) as HTMLButtonElement;
  flushSync(() =>
    hand.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event),
  );
  await settle();
  expect(hand.getAttribute("aria-pressed")).toBe("true");

  const beforeDrag = world.style.transform;
  flushSync(() =>
    viewport.dispatchEvent(new dom.PointerEvent("pointerdown", {
      bubbles: true,
      isPrimary: true,
      pointerId: 7,
      pointerType: "mouse",
      button: 0,
      clientX: 400,
      clientY: 300,
    }) as unknown as Event),
  );
  await settle();
  expect(viewport.className).toContain("cursor-grabbing");
  flushSync(() =>
    viewport.dispatchEvent(new dom.PointerEvent("pointermove", {
      bubbles: true,
      isPrimary: true,
      pointerId: 7,
      pointerType: "mouse",
      button: 0,
      clientX: 340,
      clientY: 300,
    }) as unknown as Event),
  );
  await settle();
  flushSync(() =>
    window.dispatchEvent(new dom.PointerEvent("pointerup", {
      bubbles: true,
      isPrimary: true,
      pointerId: 7,
      pointerType: "mouse",
      button: 0,
      clientX: 340,
      clientY: 300,
    }) as unknown as Event),
  );
  await settle();
  expect(world.style.transform).not.toBe(beforeDrag);
});

test("0 frames current work, repeated 0 escalates to all, and Shift+0 fits all directly", async () => {
  const active: FileEntry = {
    path: "/active", root: "claude-projects", name: "active.jsonl", project: "fit-keys", title: "Active work",
    engine: "claude", kind: "session", fmt: "claude", parent: null, mtime: 2, size: 1, activity: "live",
    proc: "running", pid: 1, model: null, pendingQuestion: null, waitingInput: null,
  };
  const quiet: FileEntry = {
    ...active, path: "/quiet", name: "quiet.jsonl", title: "Quiet history", mtime: 1, activity: "idle", proc: null, pid: null,
  };
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.add(root);
  flushSync(() => {
    root.render(
      <SchemeBoard
        project="fit-keys"
        groups={[]}
        manual={[quiet, active]}
        files={[quiet, active]}
        flows={[]}
        tasks={[]}
        drafts={[]}
        focus={null}
        onSelect={() => {}}
        onClose={() => {}}
        onDraftClose={() => {}}
        onDraftSpawned={() => {}}
      />,
    );
  });
  await settle();

  const viewport = host.querySelector('[aria-label^="Agent board"]') as HTMLDivElement;
  Object.defineProperty(viewport, "getBoundingClientRect", {
    configurable: true,
    value: () => ({ x: 0, y: 0, left: 0, top: 0, right: 1200, bottom: 800, width: 1200, height: 800, toJSON() {} }),
  });
  const world = Array.from(viewport.children).find((child) =>
    (child as HTMLElement).style.transform.includes("scale("),
  ) as HTMLElement;
  const key = (shiftKey = false) => window.dispatchEvent(
    new dom.KeyboardEvent("keydown", { key: "0", shiftKey, bubbles: true }) as unknown as Event,
  );

  flushSync(() => key());
  await settle();
  const current = world.style.transform;
  expect(host.textContent).toContain("Framed current work");

  flushSync(() => key());
  await settle();
  const all = world.style.transform;
  expect(all).not.toBe(current);
  expect(host.textContent).toContain("Framed all content");

  flushSync(() => key());
  await settle();
  expect(world.style.transform).toBe(current);
  flushSync(() => key(true));
  await settle();
  expect(world.style.transform).toBe(all);

  expect(host.querySelector('button[title="Fit current work (0)"]')).toBeTruthy();
  expect(host.querySelector('button[title^="Fit all content"]')).toBeTruthy();
});

test("arrow navigation lands on a placed task with a visible ring and spoken title", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.add(root);
  flushSync(() => {
    root.render(
      <SchemeBoard
        project="task-nav"
        groups={[]}
        manual={[]}
        files={[]}
        flows={[]}
        tasks={[{
          id: "nav-task", project: "task-nav", status: "assigned", text: "Navigate to bounded task",
          placement: "pinned", pos: { x: 100, y: 120 }, assignments: [],
          createdAt: "2026-07-18T00:00:00.000Z", updatedAt: "2026-07-18T00:00:00.000Z",
        }]}
        drafts={[]}
        focus={null}
        onSelect={() => {}}
        onClose={() => {}}
        onDraftClose={() => {}}
        onDraftSpawned={() => {}}
      />,
    );
  });
  await settle();

  flushSync(() => window.dispatchEvent(
    new dom.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }) as unknown as Event,
  ));
  await settle();

  const task = host.querySelector('[data-scheme-task="nav-task"]')!;
  expect(task.firstElementChild?.className).toContain("ring-2");
  expect(host.textContent).toContain("Navigate to bounded task");
  expect(document.activeElement).not.toBe(task);
});

test("expanding full task text reflows a covered neighbour without persisting positions", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.add(root);
  const fetchCalls: string[] = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    fetchCalls.push(String(input));
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const longText = Array.from({ length: 30 }, (_, index) => `line ${index}`).join("\n");
    flushSync(() => {
      root.render(
        <SchemeBoard
          project="task-expand"
          groups={[]}
          manual={[]}
          files={[]}
          flows={[]}
          tasks={[
            { id: "older", project: "task-expand", status: "assigned", text: longText, placement: "pinned", pos: { x: 0, y: 0 }, assignments: [], createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-01T00:00:00.000Z" },
            { id: "younger", project: "task-expand", status: "assigned", text: "Neighbour", placement: "pinned", pos: { x: 0, y: 200 }, assignments: [], createdAt: "2026-07-02T00:00:00.000Z", updatedAt: "2026-07-02T00:00:00.000Z" },
          ]}
          drafts={[]}
          focus={null}
          onSelect={() => {}}
          onClose={() => {}}
          onDraftClose={() => {}}
          onDraftSpawned={() => {}}
        />,
      );
    });
    await settle();

    const older = host.querySelector('[data-scheme-task="older"]') as HTMLElement;
    const younger = host.querySelector('[data-scheme-task="younger"]') as HTMLElement;
    expect(younger.style.transform).toBe("translate(0px, 200px)");
    flushSync(() => (older.querySelector("[data-task-disclosure]") as HTMLButtonElement).click());
    await settle();
    expect(younger.style.transform).not.toBe("translate(0px, 200px)");
    expect(fetchCalls).toEqual([]);

    flushSync(() => (older.querySelector("[data-task-disclosure]") as HTMLButtonElement).click());
    await settle();
    expect(younger.style.transform).toBe("translate(0px, 200px)");
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("a pane's reserved relation strip opens the assigned task without floating chips over the feed", async () => {
  const agent: FileEntry = {
    path: "/agent.jsonl", root: "claude-projects", name: "agent.jsonl", project: "relation-strip", title: "Working agent",
    engine: "claude", kind: "session", fmt: "claude", parent: null, mtime: 2, size: 1, activity: "live",
    proc: "running", pid: 42, model: null, pendingQuestion: null, waitingInput: null, conversationId: "conversation-1",
  };
  const openedTasks: string[] = [];
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.add(root);
  flushSync(() => {
    root.render(
      <SchemeBoard
        project="relation-strip"
        groups={[]}
        manual={[agent]}
        files={[agent]}
        flows={[]}
        tasks={[{
          id: "strip-task", project: "relation-strip", status: "assigned", text: "Bidirectional navigation",
          placement: "pinned", pos: { x: 900, y: 0 },
          assignments: [{ path: "/agent.jsonl", conversationId: "conversation-1", panePid: 42, state: "delivered", error: null, at: "2026-07-18T00:00:00.000Z" }],
          createdAt: "2026-07-18T00:00:00.000Z", updatedAt: "2026-07-18T00:00:00.000Z",
        }]}
        drafts={[]}
        focus={null}
        onSelect={() => {}}
        onOpenTask={(task) => openedTasks.push(task.id)}
        onClose={() => {}}
        onDraftClose={() => {}}
        onDraftSpawned={() => {}}
      />,
    );
  });
  await settle();

  /* The relation control lives inside the pane's own reserved column — never a
     viewport-floating chip layer that can cover conversation content. */
  const pane = host.querySelector('[data-scheme-node="/agent.jsonl"]')!;
  const strip = pane.querySelector("[data-task-relations]") as HTMLElement;
  expect(strip).toBeTruthy();
  expect(strip.className).not.toContain("absolute");
  expect(host.querySelector("[data-edge-chip]")).toBeNull();

  const chip = strip.querySelector("button[data-task-relation]") as HTMLButtonElement;
  expect(chip.getAttribute("aria-label")).toBe("Open task Bidirectional navigation");
  flushSync(() => chip.click());
  await settle();
  expect(openedTasks).toEqual(["strip-task"]);
});

test("an assignment chip opens the current conversation generation and centers its pane", async () => {
  const agent: FileEntry = {
    path: "/agent-current", root: "claude-projects", name: "agent-current.jsonl", project: "task-open", title: "Current agent",
    engine: "claude", kind: "session", fmt: "claude", parent: null, mtime: 2, size: 1, activity: "live",
    proc: "running", pid: 42, model: null, pendingQuestion: null, waitingInput: null, conversationId: "conversation-1",
  };
  const selected: string[] = [];
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.add(root);
  flushSync(() => {
    root.render(
      <SchemeBoard
        project="task-open"
        groups={[]}
        manual={[agent]}
        files={[agent]}
        flows={[]}
        tasks={[{
          id: "open-task", project: "task-open", status: "assigned", text: "Open the live agent",
          placement: "pinned", pos: { x: 0, y: 0 },
          assignments: [{ path: "/agent-archived", conversationId: "conversation-1", panePid: 42, state: "delivered", error: null, at: "2026-07-18T00:00:00.000Z" }],
          createdAt: "2026-07-18T00:00:00.000Z", updatedAt: "2026-07-18T00:00:00.000Z",
        }]}
        drafts={[]}
        focus={null}
        onSelect={(file) => selected.push(file.path)}
        onClose={() => {}}
        onDraftClose={() => {}}
        onDraftSpawned={() => {}}
      />,
    );
  });
  await settle();

  const viewport = host.querySelector('[aria-label^="Agent board"]') as HTMLDivElement;
  const world = Array.from(viewport.children).find((child) =>
    (child as HTMLElement).style.transform.includes("scale("),
  ) as HTMLElement;
  const before = world.style.transform;
  flushSync(() => (host.querySelector("[data-task-open-agent]") as HTMLButtonElement).click());
  await settle();

  expect(selected).toEqual(["/agent-current"]);
  expect(world.style.transform).not.toBe(before);
  expect(world.style.transform).toContain("scale(0.75)");
});
