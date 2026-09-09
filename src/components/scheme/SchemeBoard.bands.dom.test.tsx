import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import type { Pipeline } from "@/lib/pipelines/types";
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
let VIEWPORT = { x: 0, y: 0, left: 0, top: 0, right: 1400, bottom: 900, width: 1400, height: 900 };
const setViewportWidth = (width: number) => { VIEWPORT = { ...VIEWPORT, right: width, width }; };
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
  MutationObserver: dom.MutationObserver,
  IntersectionObserver: undefined,
  requestAnimationFrame: requestFrame,
  cancelAnimationFrame: (id: number) => dom.clearTimeout(id as never),
});

const roots = new Set<Root>();
let previousFetch: typeof fetch;
afterEach(() => {
  if (previousFetch) globalThis.fetch = previousFetch;
  setViewportWidth(1400);
  document.getSelection()?.removeAllRanges();
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

test("opening a shared conversation from its reference tile anchors the surface at the clicked tile", async () => {
  const shared = file("/shared", "Shared implementer", false);
  const only = file("/only", "Only member", false);
  const sharedFiles = [shared, only];
  const sharedTasks = [
    task("first", "Restore search results", "2026-01-01T00:00:00.000Z", [shared, only]),
    task("second", "Simplify export settings", "2026-02-01T00:00:00.000Z", [shared]),
  ];
  previousFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.add(root);
  flushSync(() => root.render(
    <SchemeBoard project="bands" groups={[]} manual={sharedFiles} files={sharedFiles} flows={[]} tasks={sharedTasks} allTasks={sharedTasks} drafts={[]} focus={null} onSelect={() => {}} onClose={() => {}} onDraftClose={() => {}} onDraftSpawned={() => {}} />,
  ));
  await settle();
  const viewport = viewportOf(host);
  /* The shared conversation is a member of the earlier task and a tile in the later one. */
  select(viewport, "/shared");
  await settle();
  const mirror = host.querySelector('[data-scheme-mirror="/shared"]') as HTMLElement;
  expect(mirror.closest("[data-scheme-band]")!.getAttribute("data-scheme-band-task")).toBe("second");
  const before = cameraOf(viewport);
  const band = mirror.closest("[data-scheme-band]") as HTMLElement;
  const mirrorScreen = { sx: before.x + (parseFloat(band.style.left) + parseFloat(mirror.style.left)) * before.z, sy: before.y + (parseFloat(band.style.top) + parseFloat(mirror.style.top)) * before.z };
  flushSync(() => mirror.click());
  await settle();
  /* The surface now lives in the clicked band, on the tile's screen point: the
     bands reflow around it (the source band shrinks), the camera absorbs that. */
  const shell = host.querySelector('[data-scheme-node="/shared"]') as HTMLElement;
  const now = screenOf(viewport, "/shared");
  expect(Math.hypot(now.sx - mirrorScreen.sx, now.sy - mirrorScreen.sy)).toBeLessThanOrEqual(2);
  const hostBand = Array.from(host.querySelectorAll<HTMLElement>("[data-scheme-band]")).find((candidate) => {
    const x = parseFloat(/translate\((-?[\d.e+-]+)px, (-?[\d.e+-]+)px\)/.exec(shell.style.transform)![1]!);
    const y = parseFloat(/translate\((-?[\d.e+-]+)px, (-?[\d.e+-]+)px\)/.exec(shell.style.transform)![2]!);
    return x >= parseFloat(candidate.style.left) && y >= parseFloat(candidate.style.top) && y < parseFloat(candidate.style.top) + parseFloat(candidate.style.height);
  });
  expect(hostBand?.getAttribute("data-scheme-band-task")).toBe("second");
  expect((host.querySelector('[data-scheme-mirror="/shared"]') as HTMLElement).closest("[data-scheme-band]")!.getAttribute("data-scheme-band-task")).toBe("first");
});

const bandOrder = (host: HTMLElement) => Array.from(host.querySelectorAll<HTMLElement>("[data-scheme-band]")).sort((a, b) => parseFloat(a.style.top) - parseFloat(b.style.top)).map((band) => band.getAttribute("data-scheme-band-task"));
const shellBox = (shell: HTMLElement) => {
  const match = /translate\((-?[\d.e+-]+)px, (-?[\d.e+-]+)px\)(?: scale\(([\d.e+-]+)\))?/.exec(shell.style.transform)!;
  const fit = match[3] ? parseFloat(match[3]) : 1;
  return { x: parseFloat(match[1]!), y: parseFloat(match[2]!), w: parseFloat(shell.style.width) * fit, h: parseFloat(shell.style.height) * fit, fit };
};

function mountLive(initialFiles: FileEntry[], extra: Partial<Parameters<typeof SchemeBoard>[0]> = {}) {
  previousFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.add(root);
  const render = (current: FileEntry[]) => flushSync(() => root.render(
    <SchemeBoard project="bands" groups={[]} manual={current} files={current} flows={[]} tasks={tasks} allTasks={tasks} drafts={[]} focus={null} onSelect={() => {}} onClose={() => {}} onDraftClose={() => {}} onDraftSpawned={() => {}} {...extra} />,
  ));
  render(initialFiles);
  return { host, render };
}

test("rank moves wait while text is selected inside the board or a disclosure is open; the order applies when the interaction ends", async () => {
  const { host, render } = mountLive(files);
  await settle();
  expect(bandOrder(host)).toEqual(["younger-working", "older-idle"]);
  /* The operator selects a title inside the idle band. */
  const shell = host.querySelector('[data-scheme-node="/quiet-one"]') as HTMLElement;
  const range = document.createRange();
  range.selectNodeContents(shell);
  const selection = document.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  flushSync(() => document.dispatchEvent(new dom.Event("selectionchange") as unknown as Event));
  await settle();
  /* Working counts flip: the labels update, the order does not. */
  const flipped = [file("/busy", "Busy implementer", false), file("/quiet-one", "Quiet reviewer", true), quietTwo];
  render(flipped);
  await settle();
  expect(bandOrder(host)).toEqual(["younger-working", "older-idle"]);
  expect((host.querySelector('[data-scheme-band-task="older-idle"]') as HTMLElement).getAttribute("data-scheme-band-working")).toBe("1");
  expect(host.querySelector("[data-scheme-order-updated]")).not.toBeNull();
  selection.removeAllRanges();
  flushSync(() => document.dispatchEvent(new dom.Event("selectionchange") as unknown as Event));
  await settle();
  expect(bandOrder(host)).toEqual(["older-idle", "younger-working"]);
  expect(host.querySelector("[data-scheme-order-updated]")).toBeNull();

  /* An open disclosure or action menu inside the board holds the order too. */
  const trigger = host.querySelector("[data-scheme-band-add]") as HTMLElement;
  trigger.setAttribute("aria-expanded", "true");
  await settle();
  render(files);
  await settle();
  expect(bandOrder(host)).toEqual(["older-idle", "younger-working"]);
  expect(host.querySelector("[data-scheme-order-updated]")).not.toBeNull();
  trigger.setAttribute("aria-expanded", "false");
  await settle();
  expect(bandOrder(host)).toEqual(["younger-working", "older-idle"]);
  expect(host.querySelector("[data-scheme-order-updated]")).toBeNull();
});

test("on a narrow board a draft pane and a planned stage slot are scaled to fit inside their band", async () => {
  setViewportWidth(490);
  const pipeline: Pipeline = {
    id: "narrow-pipeline", task: "Narrow pipeline", taskIds: [], project: "bands", repoDir: "/repo", worktreeDir: "/repo-narrow", branch: "pipeline/narrow", baseBranch: "main", baseRef: "abc", lastPassedCommit: "abc",
    stages: [{ id: "build", kind: "run", "prompt": "", next: null, effectiveRole: { roleId: null, engine: "codex", model: null, effort: null, access: "read-write", promptScaffold: null } }],
    runs: [], cursor: { stageId: "build", state: "running", input: null, activatedBy: null }, state: "running", pausedState: null, stateDetail: null, srcPath: null, srcConversationId: null, createdAt: "2025-06-01T00:00:00.000Z", closedAt: null,
  };
  const { host } = mountLive(files, { drafts: ["d1"], draftBands: new Map([["d1", "task:younger-working"]]), pipelines: [pipeline], surfacePipelines: [pipeline] });
  await settle();
  const viewport = viewportOf(host);
  /* 100% zoom on a 490px board: the band's inner width is 426px, a draft or
     slot is 600px wide by nature. */
  for (let step = 0; step < 40 && cameraOf(viewport).z < 0.95; step += 1) {
    wheelZoom(viewport, -220, { x: 200, y: 300 });
    await settle();
  }
  expect(cameraOf(viewport).z).toBeGreaterThanOrEqual(0.95);
  const bands = Array.from(host.querySelectorAll<HTMLElement>("[data-scheme-band]"));
  const bandOf = (shell: HTMLElement) => bands.find((band) => {
    const box = shellBox(shell);
    return box.y >= parseFloat(band.style.top) && box.y < parseFloat(band.style.top) + parseFloat(band.style.height);
  })!;
  for (const key of ["draft::d1", "slot::narrow-pipeline::build"]) {
    const shell = host.querySelector(`[data-scheme-node="${key}"]`) as HTMLElement;
    expect(shell).not.toBeNull();
    const box = shellBox(shell);
    const band = bandOf(shell);
    expect(band).toBeTruthy();
    /* Natural size is 600 wide; the band is narrower, so the shell is scaled
       uniformly and its right edge stays inside the band. */
    expect(box.fit).toBeLessThan(1);
    expect(parseFloat(shell.style.width)).toBeCloseTo(600, 3);
    expect(box.x + box.w).toBeLessThanOrEqual(parseFloat(band.style.left) + parseFloat(band.style.width) + 0.001);
    expect(box.x).toBeGreaterThanOrEqual(parseFloat(band.style.left) - 0.001);
  }
});
