import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import type { Pipeline } from "@/lib/pipelines/types";
import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";

import { SchemeBoard } from "./SchemeBoard";

/**
 * Catalog opens of historical agents (#1625).
 *
 * The desktop catalog is how the operator reaches a conversation the board is
 * not already showing: clicking a row admits it as an isolated ephemeral manual
 * node and asks the board to focus it. That request arrives WITH the board —
 * the list unmounts and the board mounts in the same gesture — so the first
 * band projection it can be answered against is the provisional one, built at
 * the initial zoom and viewport width before the camera's own measurements have
 * reached the layout. On a deep stack of task bands the requested conversation
 * settles thousands of world pixels away from that provisional rectangle, and a
 * one-shot aim taken against it left the operator's own conversation far
 * outside the viewport with nothing left to correct it.
 *
 * The composition here is the reported one: many preceding task bands, a
 * COMPLETED pipeline folded into its band, and the requested conversation a
 * member of a band near the bottom of the stack — not the generic top-band
 * agent that the earlier rendered acceptance opened and that passes either way.
 */

const dom = new Window();
const VIEWPORT = { x: 0, y: 0, left: 0, top: 0, right: 1600, bottom: 1000, width: 1600, height: 1000 };
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
/* happy-dom holds a mutation observer's callback in a WeakRef and nothing else
   references it, so the first collection after observe() silences it; the board
   defers rank moves on a later report. Hand it a non-collecting reference for
   the duration of observe(), exactly as SchemeBoard.bands.dom.test.tsx does. */
class StrongRef<T> {
  constructor(private readonly value: T) {}
  deref(): T { return this.value; }
}
class TestMutationObserver extends dom.MutationObserver {
  observe(...args: Parameters<InstanceType<typeof dom.MutationObserver>["observe"]>) {
    const collecting = globalThis.WeakRef;
    (globalThis as unknown as { WeakRef: unknown }).WeakRef = StrongRef;
    try { super.observe(...args); } finally { (globalThis as unknown as { WeakRef: unknown }).WeakRef = collecting; }
  }
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
  MutationObserver: TestMutationObserver,
  IntersectionObserver: undefined,
  requestAnimationFrame: requestFrame,
  cancelAnimationFrame: (id: number) => dom.clearTimeout(id as never),
});

const roots = new Set<Root>();
let previousFetch: typeof fetch | undefined;
afterEach(() => {
  if (previousFetch) globalThis.fetch = previousFetch;
  for (const root of roots) flushSync(() => root.unmount());
  roots.clear();
  document.body.replaceChildren();
  dom.sessionStorage.clear();
  dom.localStorage.clear();
});

const settle = async () => {
  for (let index = 0; index < 8; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  flushSync(() => undefined);
};

const PROJECT = "catalog-focus";
/* Enough bands, with enough members each, that the requested conversation lands
   thousands of world pixels down the stack — the pressure the operator's board
   carries and the earlier synthetic capture did not. */
const BANDS = 15;
const PER_BAND = 6;
/* Late enough to be far from the top framing, with bands still below it. */
const TARGET_BAND = 11;
const TARGET_MEMBER = 4;
const pathOf = (band: number, member: number) => `/agents/band-${band}/agent-${member}.jsonl`;
const TARGET = pathOf(TARGET_BAND, TARGET_MEMBER);
/* The completed pipeline the operator opened from: folded into its own band,
   two stages, both finished. */
const PIPELINE_BAND = TARGET_BAND;

function file(band: number, member: number): FileEntry {
  const path = pathOf(band, member);
  return {
    path,
    root: "claude-projects",
    name: `agent-${member}.jsonl`,
    project: PROJECT,
    title: `Band ${band} agent ${member}`,
    engine: "claude",
    kind: "session",
    fmt: "claude",
    parent: null,
    mtime: 2,
    size: 1,
    activity: "idle",
    proc: null,
    pid: null,
    model: null,
    pendingQuestion: null,
    waitingInput: null,
    conversationId: `conversation-band-${band}-agent-${member}`,
    authoritativeTurn: { state: "idle", source: "lifecycle", terminalAt: null },
  } as FileEntry;
}

function task(band: number, entries: FileEntry[]): BoardTask {
  const createdAt = `2026-0${1 + (band % 9)}-1${band % 9}T00:00:00.000Z`;
  return {
    id: `task-band-${band}`,
    project: PROJECT,
    status: "assigned",
    text: `Task band ${band}`,
    placement: "unplaced",
    assignments: entries.map((entry) => ({ path: entry.path, conversationId: entry.conversationId!, panePid: null, state: "delivered", error: null, at: createdAt })),
    createdAt,
    updatedAt: createdAt,
  } as BoardTask;
}

/** A finished pipeline whose two stage conversations are members of its band. */
function completedPipeline(): Pipeline {
  const role = (id: string) => ({ roleId: id === "implement" ? "builder" : "reviewer", engine: "claude" as const, model: "opus", effort: "high", access: "read-write" as const, promptScaffold: null });
  const stage = (id: string, next: string | null) => ({ id, kind: "run" as const, prompt: "", next, onFail: null, effectiveRole: role(id) });
  const attempt = (id: string, member: number) => ({
    n: 1,
    state: "passed" as const,
    effectiveRole: role(id),
    launchId: `launch-band-${id}`,
    conversationId: `conversation-band-${TARGET_BAND}-agent-${member}`,
    sessionId: `session-band-${id}`,
    agentPath: pathOf(TARGET_BAND, member),
    paneId: null,
    flowId: null,
    startedAt: "2026-02-01T00:00:00.000Z",
    completedAt: "2026-02-01T01:00:00.000Z",
    input: null,
    activatedBy: null,
    output: "done",
    verdict: { status: "pass" as const },
    error: null,
  });
  return {
    id: "band-pipeline",
    task: `Task band ${PIPELINE_BAND}`,
    taskIds: [`task-band-${PIPELINE_BAND}`],
    project: PROJECT,
    repoDir: "/repo",
    worktreeDir: "/repo-band-pipeline",
    branch: "pipeline/band",
    baseBranch: "main",
    baseRef: "aaaaaaa",
    lastPassedCommit: "aaaaaaa",
    stages: [stage("implement", "review"), stage("review", null)],
    runs: [
      { stageId: "implement", attempts: [attempt("implement", TARGET_MEMBER)] },
      { stageId: "review", attempts: [attempt("review", TARGET_MEMBER + 1)] },
    ],
    cursor: { stageId: "review", state: "passed", input: null, activatedBy: null },
    state: "completed",
    pausedState: null,
    stateDetail: null,
    srcPath: null,
    srcConversationId: null,
    createdAt: "2026-02-01T00:00:00.000Z",
    closedAt: "2026-02-02T00:00:00.000Z",
  } as unknown as Pipeline;
}

const files: FileEntry[] = [];
const tasks: BoardTask[] = [];
for (let band = 0; band < BANDS; band += 1) {
  const entries = Array.from({ length: PER_BAND }, (_, member) => file(band, member));
  files.push(...entries);
  tasks.push(task(band, entries));
}
const pipelines = [completedPipeline()];
/* What a catalog open leaves behind: the requested transcript admitted on its
   own, outside every group, exactly as ProjectDashboard's ephemeral pass does. */
const ISOLATED: ReadonlySet<string> = new Set([TARGET]);

function mountBoard(focus: string | null) {
  previousFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.add(root);
  const render = (next: string | null, extraTasks: BoardTask[] = []) => flushSync(() => root.render(
    <SchemeBoard
      project={PROJECT}
      groups={[]}
      manual={files}
      files={files}
      flows={[]}
      pipelines={pipelines}
      surfacePipelines={pipelines}
      tasks={[...tasks, ...extraTasks]}
      allTasks={[...tasks, ...extraTasks]}
      drafts={[]}
      isolatedManualPaths={ISOLATED}
      focus={next}
      onSelect={() => {}}
      onClose={() => {}}
      onDraftClose={() => {}}
      onDraftSpawned={() => {}}
    />,
  ));
  render(focus);
  return { host, render };
}

const viewportOf = (host: HTMLElement) => host.querySelector('[aria-label^="Agent board"]') as HTMLDivElement;
const worldOf = (viewport: HTMLElement) => Array.from(viewport.children).find((child) => (child as HTMLElement).style.transform.includes("scale(")) as HTMLElement;
function cameraOf(viewport: HTMLElement) {
  const match = /translate\((-?[\d.e+-]+)px, (-?[\d.e+-]+)px\) scale\(([\d.e+-]+)\)/.exec(worldOf(viewport).style.transform)!;
  return { x: parseFloat(match[1]!), y: parseFloat(match[2]!), z: parseFloat(match[3]!) };
}
/** Where the requested conversation actually is on screen, and whether enough
    of it is there to read — the acceptance question, asked of the DOM. */
function onScreen(host: HTMLElement, path: string) {
  const shell = host.querySelector(`[data-scheme-node="${path}"]`) as HTMLElement | null;
  if (!shell) return null;
  const cam = cameraOf(viewportOf(host));
  const match = /translate\((-?[\d.e+-]+)px, (-?[\d.e+-]+)px\)/.exec(shell.style.transform)!;
  const x = parseFloat(match[1]!);
  const y = parseFloat(match[2]!);
  const w = parseFloat(shell.style.width);
  const h = parseFloat(shell.style.height);
  const top = cam.y + y * cam.z;
  const left = cam.x + x * cam.z;
  return {
    top,
    left,
    /* At least the head: the title row and the first lines under it. */
    readable: top >= 0 && top + Math.min(h * cam.z, 120) <= VIEWPORT.height && left < VIEWPORT.width && left + w * cam.z > 0,
    presentation: shell.getAttribute("data-scheme-node-presentation"),
  };
}
function pan(host: HTMLElement, dy: number) {
  const viewport = viewportOf(host);
  const wheel = new dom.WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: dy });
  Object.defineProperties(wheel, { clientX: { value: 800 }, clientY: { value: 500 }, ctrlKey: { value: false } });
  flushSync(() => viewport.dispatchEvent(wheel as unknown as Event));
}

test("a catalog open that mounts the board with its request standing brings the requested conversation on screen and readable", async () => {
  const { host } = mountBoard(TARGET);
  await settle();

  /* The composition really is the reported one: a deep band stack with the
     completed pipeline's stage conversations folded into a band near the
     bottom, not a top-band agent under no layout pressure. */
  expect(host.querySelectorAll("[data-scheme-band]").length).toBe(BANDS);
  const placed = onScreen(host, TARGET);
  expect(placed).not.toBeNull();
  expect(placed!.readable).toBe(true);
  /* Opened means opened: the requested conversation reads natively, so what is
     on screen is its content and not a tile of it. */
  expect(placed!.presentation).toBe("native");
  /* And it is genuinely deep in the stack — a fixture that stopped placing it
     far down would pass this test without asking the question. The depth is
     measured against the viewport's own height, in the board pixels the world
     uses now (it once counter-scaled every coordinate by the zoom, #1641, and
     a bare pixel constant written in that unit rotted with it): at the zooms
     the board frames a reader, a head more than a whole viewport down the
     stack cannot share a screen with the top of it, so the open has to move
     the camera. A target in the first band sits a few dozen pixels down. */
  const shell = host.querySelector(`[data-scheme-node="${TARGET}"]`) as HTMLElement;
  const depth = parseFloat(/translate\((?:-?[\d.e+-]+)px, (-?[\d.e+-]+)px\)/.exec(shell.style.transform)![1]!);
  expect(depth).toBeGreaterThan(VIEWPORT.height);
});

test("a repeated catalog open of the same conversation brings it back after the operator has panned away", async () => {
  const { host, render } = mountBoard(TARGET);
  await settle();
  expect(onScreen(host, TARGET)!.readable).toBe(true);

  /* The highlight expires; the operator scrolls the board somewhere else. */
  render(null);
  await settle();
  pan(host, 4_000);
  await settle();
  const wandered = onScreen(host, TARGET);
  expect(wandered === null || !wandered.readable).toBe(true);

  /* Opening the same row again is a new request and moves the view again. */
  render(TARGET);
  await settle();
  expect(onScreen(host, TARGET)!.readable).toBe(true);
});

test("a pan after the open is respected: a later scanner poll reflows the bands and the camera stays where the operator left it", async () => {
  const { host, render } = mountBoard(TARGET);
  await settle();
  expect(onScreen(host, TARGET)!.readable).toBe(true);

  /* The operator pans away with the request still standing. */
  pan(host, 3_000);
  await settle();
  const parked = cameraOf(viewportOf(host));

  /* A poll delivers another task: every band below it reflows, which is the
     event the old rule used to answer by pulling the view back. The request is
     over — the camera must not move on its own. */
  const extra = task(BANDS, [file(BANDS, 0)]);
  render(TARGET, [extra]);
  await settle();
  const after = cameraOf(viewportOf(host));
  expect(after.y).toBeCloseTo(parked.y, 3);
  expect(after.z).toBeCloseTo(parked.z, 6);

  /* And with the highlight expired it stays put through one more reflow. */
  render(null, [extra]);
  await settle();
  expect(cameraOf(viewportOf(host)).y).toBeCloseTo(parked.y, 3);
});

test("without a request the board opens on the camera the operator left, untouched", async () => {
  dom.sessionStorage.setItem("llvCam:" + PROJECT, JSON.stringify({ z: 0.58, x: 0, y: -2400 }));
  const { host } = mountBoard(null);
  await settle();
  const cam = cameraOf(viewportOf(host));
  expect(cam.z).toBeCloseTo(0.58, 6);
  expect(cam.y).toBeCloseTo(-2400, 3);
});
