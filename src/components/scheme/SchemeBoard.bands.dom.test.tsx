import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";

import { SchemeBoard } from "./SchemeBoard";

/**
 * Task-centered board (#1586), mounted: bands stack by working count, the
 * overview scale turns members into chips, and the selected conversation's
 * header keeps its screen position through wheel zoom, toolbar zoom and the
 * semantic-mode crossings that reflow every band.
 */

const dom = new Window();
const VIEWPORT = { x: 0, y: 0, left: 0, top: 0, right: 1400, bottom: 900, width: 1400, height: 900 };
class TestResizeObserver {
  constructor(private callback: () => void) {}
  observe(element: HTMLElement) {
    if (element.getAttribute("aria-label")?.startsWith("Agent board")) {
      Object.defineProperty(element, "getBoundingClientRect", { configurable: true, value: () => ({ ...VIEWPORT, toJSON() {} }) });
      queueMicrotask(this.callback);
    }
  }
  unobserve() {}
  disconnect() {}
}
(dom as unknown as { matchMedia: (query: string) => unknown }).matchMedia = () => ({
  matches: false, media: "", addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false,
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
  KeyboardEvent: dom.KeyboardEvent,
  sessionStorage: dom.sessionStorage,
  localStorage: dom.localStorage,
  ResizeObserver: TestResizeObserver,
  IntersectionObserver: undefined,
  requestAnimationFrame: requestFrame,
  cancelAnimationFrame: (id: number) => dom.clearTimeout(id as never),
});

const roots = new Set<Root>();
let previousFetch: typeof fetch;
afterEach(() => {
  if (previousFetch) globalThis.fetch = previousFetch;
  for (const root of roots) flushSync(() => root.unmount());
  roots.clear();
  document.body.replaceChildren();
  dom.sessionStorage.clear();
  dom.localStorage.clear();
});

const settle = async () => {
  for (let index = 0; index < 4; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  flushSync(() => undefined);
};

function file(path: string, title: string, busy: boolean): FileEntry {
  return {
    path, root: "claude-projects", name: `${path.slice(1)}.jsonl`, project: "bands", title, engine: "claude", kind: "session", fmt: "claude",
    parent: null, mtime: 2, size: 1, activity: busy ? "live" : "idle", proc: busy ? "running" : null, pid: busy ? 7 : null, model: null,
    pendingQuestion: null, waitingInput: null, conversationId: `conversation-${path.slice(1)}`,
    ...(busy ? { authoritativeTurn: { state: "busy", source: "lifecycle", terminalAt: null } } : { authoritativeTurn: { state: "idle", source: "lifecycle", terminalAt: null } }),
  } as FileEntry;
}
function task(id: string, text: string, createdAt: string, files: FileEntry[]): BoardTask {
  return {
    id, project: "bands", status: "assigned", text, placement: "unplaced",
    assignments: files.map((entry) => ({ path: entry.path, conversationId: entry.conversationId!, panePid: null, state: "delivered", error: null, at: createdAt })),
    createdAt, updatedAt: createdAt,
  } as BoardTask;
}

const busy = file("/busy", "Busy implementer", true);
const quietOne = file("/quiet-one", "Quiet reviewer", false);
const quietTwo = file("/quiet-two", "Quiet verifier", false);
const files = [busy, quietOne, quietTwo];
const tasks = [
  task("older-idle", "Repair old links", "2026-01-01T00:00:00.000Z", [quietOne, quietTwo]),
  task("younger-working", "Restore search results", "2026-02-01T00:00:00.000Z", [busy]),
];

function mount(onAddAgent?: (band: { id: string; task: BoardTask | null; title: string }) => void) {
  previousFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.add(root);
  flushSync(() => root.render(
    <SchemeBoard
      project="bands"
      groups={[]}
      manual={files}
      files={files}
      flows={[]}
      tasks={tasks}
      allTasks={tasks}
      drafts={[]}
      focus={null}
      onSelect={() => {}}
      onClose={() => {}}
      onDraftClose={() => {}}
      onDraftSpawned={() => {}}
      onAddAgent={onAddAgent}
    />,
  ));
  return host;
}

const viewportOf = (host: HTMLElement) => host.querySelector('[aria-label^="Agent board"]') as HTMLDivElement;
const worldOf = (viewport: HTMLElement) => Array.from(viewport.children).find((child) => (child as HTMLElement).style.transform.includes("scale(")) as HTMLElement;
function cameraOf(viewport: HTMLElement) {
  const match = /translate\((-?[\d.e+-]+)px, (-?[\d.e+-]+)px\) scale\(([\d.e+-]+)\)/.exec(worldOf(viewport).style.transform)!;
  return { x: parseFloat(match[1]!), y: parseFloat(match[2]!), z: parseFloat(match[3]!) };
}
/** Screen top-left of a node shell: camera translation plus its world translate × zoom. */
function screenOf(viewport: HTMLElement, path: string) {
  const cam = cameraOf(viewport);
  const shell = viewport.querySelector(`[data-scheme-node="${path}"]`) as HTMLElement;
  const match = /translate\((-?[\d.e+-]+)px, (-?[\d.e+-]+)px\)/.exec(shell.style.transform)!;
  return { sx: cam.x + parseFloat(match[1]!) * cam.z, sy: cam.y + parseFloat(match[2]!) * cam.z, z: cam.z };
}
function wheelZoom(viewport: HTMLElement, deltaY: number, at = { x: 900, y: 700 }) {
  const wheel = new dom.WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY });
  Object.defineProperties(wheel, { clientX: { value: at.x }, clientY: { value: at.y }, ctrlKey: { value: true } });
  flushSync(() => viewport.dispatchEvent(wheel as unknown as Event));
}
function select(viewport: HTMLElement, path: string) {
  const shell = viewport.querySelector(`[data-scheme-node="${path}"]`) as HTMLElement;
  flushSync(() => shell.dispatchEvent(new dom.PointerEvent("pointerdown", { bubbles: true, isPrimary: true, pointerId: 3, pointerType: "mouse", button: 0, clientX: 300, clientY: 300 }) as unknown as Event));
  flushSync(() => window.dispatchEvent(new dom.PointerEvent("pointerup", { bubbles: true, isPrimary: true, pointerId: 3, pointerType: "mouse", button: 0, clientX: 300, clientY: 300 }) as unknown as Event));
}

test("bands stack full width with the working task on top, and every conversation sits inside its band", async () => {
  const host = mount();
  await settle();
  expect(host.querySelector("[data-scheme-task]")).toBeNull();
  const bands = Array.from(host.querySelectorAll<HTMLElement>("[data-scheme-band]")).sort((a, b) => parseFloat(a.style.top) - parseFloat(b.style.top));
  expect(bands.map((band) => band.getAttribute("data-scheme-band-task"))).toEqual(["younger-working", "older-idle"]);
  expect(bands.map((band) => band.getAttribute("data-scheme-band-working"))).toEqual(["1", "0"]);
  expect(bands[0]!.style.left).toBe(bands[1]!.style.left);
  expect(bands[0]!.style.width).toBe(bands[1]!.style.width);
  const viewport = viewportOf(host);
  const cam = cameraOf(viewport);
  /* Full available width: the band spans the 1400px viewport minus two 24px gutters. */
  expect(parseFloat(bands[0]!.style.width) * cam.z).toBeCloseTo(1400 - 48, 3);
  expect(cam.x).toBeCloseTo(0, 6);
  for (const [path, taskId] of [["/busy", "younger-working"], ["/quiet-one", "older-idle"], ["/quiet-two", "older-idle"]] as const) {
    const band = host.querySelector(`[data-scheme-band-task="${taskId}"]`) as HTMLElement;
    const shell = host.querySelector(`[data-scheme-node="${path}"]`) as HTMLElement;
    const match = /translate\((-?[\d.e+-]+)px, (-?[\d.e+-]+)px\)/.exec(shell.style.transform)!;
    const x = parseFloat(match[1]!);
    const y = parseFloat(match[2]!);
    expect(x).toBeGreaterThanOrEqual(parseFloat(band.style.left));
    expect(y).toBeGreaterThanOrEqual(parseFloat(band.style.top));
    expect(x + parseFloat(shell.style.width)).toBeLessThanOrEqual(parseFloat(band.style.left) + parseFloat(band.style.width) + 0.001);
    expect(y + parseFloat(shell.style.height)).toBeLessThanOrEqual(parseFloat(band.style.top) + parseFloat(band.style.height) + 0.001);
  }
  expect(host.textContent).toContain("Restore search results");
  expect(host.textContent).toContain("1 working");
  expect(host.querySelectorAll("[data-scheme-band-add]").length).toBe(2);
});

test("the selected conversation holds its screen anchor through wheel zoom, toolbar zoom and semantic-mode reflow", async () => {
  const host = mount();
  await settle();
  const viewport = viewportOf(host);
  select(viewport, "/quiet-two");
  await settle();
  const start = screenOf(viewport, "/quiet-two");
  /* Both axes hold at every step, mode crossings included: the camera
     translates so the selected header keeps its screen point even when the
     row layout gives the tile another column. */
  const drift = (label: string) => {
    const now = screenOf(viewport, "/quiet-two");
    const delta = Math.hypot(now.sx - start.sx, now.sy - start.sy);
    if (delta > 2) throw new Error(`${label}: selected header drifted ${delta.toFixed(2)}px at zoom ${now.z}`);
    return delta;
  };
  /* Wheel zoom in, five notches, each anchored (the scale is capped, so only
     the first notch is required to move). */
  wheelZoom(viewport, -120);
  await settle();
  expect(cameraOf(viewport).z).toBeGreaterThan(start.z);
  drift("wheel in 0");
  for (let step = 1; step < 5; step += 1) {
    wheelZoom(viewport, -120);
    await settle();
    drift(`wheel in ${step}`);
  }
  /* Out to the overview: members become chips and reflow, anchor holds. */
  for (let step = 0; step < 14 && cameraOf(viewport).z >= 0.22; step += 1) {
    wheelZoom(viewport, 220);
    await settle();
    drift(`wheel out ${step}`);
  }
  expect(cameraOf(viewport).z).toBeLessThan(0.22);
  expect((host.querySelector('[data-scheme-node="/quiet-two"]') as HTMLElement).getAttribute("data-scheme-node-presentation")).toBe("chip");
  /* Back in past the near threshold: the selected reader goes native, still anchored. */
  for (let step = 0; step < 30 && cameraOf(viewport).z < 0.82; step += 1) {
    wheelZoom(viewport, -220);
    await settle();
    drift(`wheel back ${step}`);
  }
  expect(cameraOf(viewport).z).toBeGreaterThanOrEqual(0.82);
  expect((host.querySelector('[data-scheme-node="/quiet-two"]') as HTMLElement).getAttribute("data-scheme-node-presentation")).toBe("native");
  /* Toolbar buttons zoom about the viewport centre by default; the anchor wins. */
  const zoomOut = host.querySelector('button[title^="Zoom out"]') as HTMLButtonElement;
  const zoomIn = host.querySelector('button[title^="Zoom in"]') as HTMLButtonElement;
  for (let cycle = 0; cycle < 20; cycle += 1) {
    flushSync(() => zoomOut.click());
    await settle();
    drift(`toolbar out ${cycle}`);
    flushSync(() => zoomIn.click());
    await settle();
    drift(`toolbar in ${cycle}`);
  }
  /* Twenty forward/reverse cycles: cumulative drift stays under 4px on both axes. */
  const end = screenOf(viewport, "/quiet-two");
  expect(Math.hypot(end.sx - start.sx, end.sy - start.sy)).toBeLessThanOrEqual(4);
});

test("without a selection a wheel zoom keeps the pointer's world point; a pan is never undone", async () => {
  const host = mount();
  await settle();
  const viewport = viewportOf(host);
  const before = cameraOf(viewport);
  const pointer = { x: 700, y: 450 };
  const worldUnderPointer = { x: (pointer.x - before.x) / before.z, y: (pointer.y - before.y) / before.z };
  wheelZoom(viewport, -120, pointer);
  await settle();
  const after = cameraOf(viewport);
  expect(after.z).toBeGreaterThan(before.z);
  /* Zoom keeps the band's left edge in place (the world is one viewport wide);
     the vertical pointer point is preserved. */
  expect(after.x).toBeCloseTo(0, 6);
  expect(after.y + worldUnderPointer.y * after.z).toBeCloseTo(pointer.y, 3);
  /* A selected band member does not stop a plain pan from moving the camera. */
  select(viewport, "/busy");
  await settle();
  const panned = cameraOf(viewport);
  const wheel = new dom.WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 80 });
  Object.defineProperties(wheel, { clientX: { value: 700 }, clientY: { value: 450 }, ctrlKey: { value: false } });
  flushSync(() => viewport.dispatchEvent(wheel as unknown as Event));
  await settle();
  expect(cameraOf(viewport).y).toBeCloseTo(panned.y - 80, 3);
});

test("the band-local «+ Agent» reports its task, and the overview keeps one in the header", async () => {
  const added: { id: string; task: BoardTask | null; title: string }[] = [];
  const host = mount((band) => added.push(band));
  await settle();
  const older = host.querySelector('[data-scheme-band-task="older-idle"]') as HTMLElement;
  flushSync(() => (older.querySelector("[data-scheme-band-add]") as HTMLButtonElement).click());
  expect(added.map((band) => [band.id, band.task?.id, band.title])).toEqual([["task:older-idle", "older-idle", "Repair old links"]]);
  const viewport = viewportOf(host);
  for (let step = 0; step < 14 && cameraOf(viewport).z >= 0.22; step += 1) {
    wheelZoom(viewport, 220);
    await settle();
  }
  const overviewAdd = (host.querySelector('[data-scheme-band-task="younger-working"]') as HTMLElement).querySelector("[data-scheme-band-add]") as HTMLButtonElement;
  expect(overviewAdd.closest("[data-scheme-band-header]")).toBeTruthy();
  flushSync(() => overviewAdd.click());
  expect(added.at(-1)?.task?.id).toBe("younger-working");
});
