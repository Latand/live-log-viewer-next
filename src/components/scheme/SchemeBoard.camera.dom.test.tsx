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
