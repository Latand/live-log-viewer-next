import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import type { Pipeline } from "@/lib/pipelines/types";
import type { FileEntry } from "@/lib/types";

import { SchemeBoard } from "./SchemeBoard";

const dom = new Window();
class TestResizeObserver {
  constructor(private callback: () => void) {}
  observe(element: HTMLElement) {
    if (element.getAttribute('aria-label')?.startsWith('Agent board')) {
      Object.defineProperty(element, 'getBoundingClientRect', { configurable: true, value: () => ({ x:0,y:0,left:0,top:0,right:1400,bottom:900,width:1400,height:900,toJSON() {} }) });
      queueMicrotask(this.callback);
    }
  }
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

function pipeline(index: number): Pipeline {
  return {
    id: `camera-pipeline-${index}`,
    task: `Camera pipeline ${index}`,
    taskIds: [],
    project: "pipeline-camera",
    repoDir: "/repo",
    worktreeDir: `/repo-pipeline-${index}`,
    branch: `pipeline/${index}`,
    baseBranch: "main",
    baseRef: "abc",
    lastPassedCommit: "abc",
    stages: [{
      id: "build",
      kind: "run",
      "prompt": "",
      next: null,
      effectiveRole: { roleId: null, engine: "codex", model: null, effort: null, access: "read-write", promptScaffold: null },
    }],
    runs: [],
    cursor: { stageId: "build", state: "running", input: null, activatedBy: null },
    state: "running",
    pausedState: null,
    stateDetail: null,
    srcPath: null,
    srcConversationId: null,
    createdAt: `2026-07-19T00:00:${String(index).padStart(2, "0")}.000Z`,
    closedAt: null,
  };
}

test("hand, Space-pan, and lasso own pipeline header gestures without position PATCHes", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.add(root);
  const requests: string[] = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    requests.push(String(input));
    return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const values = Array.from({ length: 16 }, (_, index) => pipeline(index));
    flushSync(() => root.render(
      <SchemeBoard
        project="pipeline-interaction"
        groups={[]}
        manual={[]}
        files={[]}
        flows={[]}
        pipelines={values}
        surfacePipelines={values}
        tasks={[]}
        drafts={[]}
        focus={null}
        onSelect={() => {}}
        onClose={() => {}}
        onDraftClose={() => {}}
        onDraftSpawned={() => {}}
      />,
    ));
    await settle();

    const viewport = host.querySelector('[aria-label^="Agent board"]') as HTMLDivElement;
    const world = Array.from(viewport.children).find((child) =>
      (child as HTMLElement).style.transform.includes("scale("),
    ) as HTMLElement;
    /* The colored pipeline halos are the sole pipeline regions; no detached,
       draggable PipelineGroup control card exists to intercept a tool gesture or
       emit a set-position PATCH (#353). */
    expect(host.querySelector("[data-pipeline-group-drag]")).toBeNull();
    expect(host.querySelectorAll('[data-scheme-group="pipeline"]').length).toBeGreaterThan(0);

    const hand = Array.from(host.querySelectorAll("button")).find((button) => button.title.startsWith("Hand")) as HTMLButtonElement;
    flushSync(() => hand.click());
    await settle();
    /* Under the hand tool the halo header is inert (disabled): it can neither open
       config nor mutate the pipeline. */
    const header = host.querySelector("[data-pipeline-group-header]") as HTMLButtonElement;
    expect(header).toBeTruthy();
    expect(header.disabled).toBe(true);

    /* Bands span the viewport (#1586), so the world's x axis is locked and a
       pan shows on the y axis: the drag carries a vertical component. */
    const before = world.style.transform;
    flushSync(() => viewport.dispatchEvent(new dom.PointerEvent("pointerdown", {
      bubbles: true, isPrimary: true, pointerId: 41, pointerType: "mouse", button: 0, clientX: 500, clientY: 300,
    }) as unknown as Event));
    flushSync(() => viewport.dispatchEvent(new dom.PointerEvent("pointermove", {
      bubbles: true, isPrimary: true, pointerId: 41, pointerType: "mouse", button: 0, clientX: 420, clientY: 240,
    }) as unknown as Event));
    flushSync(() => viewport.dispatchEvent(new dom.PointerEvent("pointerup", {
      bubbles: true, isPrimary: true, pointerId: 41, pointerType: "mouse", button: 0, clientX: 420, clientY: 240,
    }) as unknown as Event));
    await settle();

    /* The hand-tool drag pans the world and never mutates a pipeline (no
       set-position PATCH — there is no draggable pipeline card anymore). A benign
       GET for the placeholder role picker is unrelated. */
    expect(world.style.transform).not.toBe(before);
    expect(requests.filter((url) => url.includes("/api/pipelines"))).toEqual([]);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

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
  /* A diagonal drag: the band board is a document whose stack fits the
     viewport here, so only the vertical component can move it (#1641), and
     the camera already rests at the strip-keeping top bound, so it moves down. */
  flushSync(() =>
    viewport.dispatchEvent(new dom.PointerEvent("pointermove", {
      bubbles: true,
      isPrimary: true,
      pointerId: 7,
      pointerType: "mouse",
      button: 0,
      clientX: 340,
      clientY: 360,
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
  /* A fresh band board opens on the current-work framing itself, so move the
     camera first; otherwise the first 0 correctly escalates straight to all. */
  const pan = new dom.WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 240 });
  Object.defineProperties(pan, { clientX: { value: 600 }, clientY: { value: 400 }, ctrlKey: { value: false } });
  flushSync(() => viewport.dispatchEvent(pan as unknown as Event));
  await settle();

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

test("arrow navigation lands on a task band with a visible ring and spoken title", async () => {
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

  /* Task-centered board (#1586): the task is a full-width band, so keyboard
     navigation rings the band header, never a floating card. */
  expect(host.querySelector("[data-scheme-task]")).toBeNull();
  const band = host.querySelector('[data-scheme-band-task="nav-task"]')!;
  expect(band).toBeTruthy();
  const header = band.querySelector("[data-scheme-band-header]") as HTMLElement;
  expect(header.className).toContain("ring-2");
  expect(host.textContent).toContain("Navigate to bounded task");
  expect(document.activeElement).not.toBe(band);
});

test("empty tasks share a compact row in creation order and persist nothing", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.add(root);
  /* Only writes matter here: text expansion must persist nothing. The board's own
     GET is bookkeeping — the board store backs the canonical selection (#771), so
     a standalone board mount loads it — and is excluded by method, not by URL, so
     a set-position PATCH could never hide behind the same path. */
  const writes: string[] = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    if (method !== "GET") writes.push(`${method} ${String(input)}`);
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
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

    /* Empty tasks share a compact row in creation order. Their authored pins
       remain untouched by presentation; no writes occur. */
    expect(host.querySelector("[data-scheme-task]")).toBeNull();
    const older = host.querySelector('[data-scheme-band-task="older"]') as HTMLElement;
    const younger = host.querySelector('[data-scheme-band-task="younger"]') as HTMLElement;
    expect(older).toBeTruthy();
    expect(younger).toBeTruthy();
    expect(parseFloat(younger.style.left)).toBeGreaterThan(parseFloat(older.style.left) + parseFloat(older.style.width));
    expect(older.style.width).toBe(younger.style.width);
    expect(younger.style.top).toBe(older.style.top);
    expect(host.textContent).toContain("Neighbour");
    expect(writes).toEqual([]);
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
        focus={agent.path}
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

test("a task's assigned conversation resolves to its current generation inside the task's band", async () => {
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

  /* The assignment names an archived path; the band shows the conversation's
     current generation as its member and opens exactly that one. */
  const band = host.querySelector('[data-scheme-band-task="open-task"]') as HTMLElement;
  expect(band).toBeTruthy();
  const node = host.querySelector('[data-scheme-node="/agent-current"]') as HTMLElement;
  expect(node.getAttribute("data-scheme-node-presentation")).toBe("summary");
  const bandBox = { x: parseFloat(band.style.left), y: parseFloat(band.style.top), w: parseFloat(band.style.width), h: parseFloat(band.style.height) };
  const match = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(node.style.transform)!;
  const nodeBox = { x: parseFloat(match[1]!), y: parseFloat(match[2]!), w: parseFloat(node.style.width), h: parseFloat(node.style.height) };
  expect(nodeBox.x).toBeGreaterThanOrEqual(bandBox.x);
  expect(nodeBox.y).toBeGreaterThanOrEqual(bandBox.y);
  expect(nodeBox.x + nodeBox.w).toBeLessThanOrEqual(bandBox.x + bandBox.w + 0.001);
  expect(nodeBox.y + nodeBox.h).toBeLessThanOrEqual(bandBox.y + bandBox.h + 0.001);
  flushSync(() => (node.querySelector("button[data-scheme-summary]") as HTMLButtonElement).click());
  await settle();
  expect(selected).toEqual(["/agent-current"]);
});

/* The saved camera and the board it was saved against (#1614). Two tasks make a
   short band stack a few hundred pixels tall — the shape a 390-task board takes
   once its empty bands are off it — while the stored camera is the one the
   operator actually had: parked 25 000px down the stack the board no longer has. */
const bandBoardTasks = (project: string) => [
  { id: "first", project, status: "assigned" as const, text: "First task", placement: "pinned" as const, pos: { x: 0, y: 0 }, assignments: [], createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-01T00:00:00.000Z" },
  { id: "second", project, status: "assigned" as const, text: "Second task", placement: "pinned" as const, pos: { x: 0, y: 200 }, assignments: [], createdAt: "2026-07-02T00:00:00.000Z", updatedAt: "2026-07-02T00:00:00.000Z" },
];

async function mountBandBoard(project: string): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.add(root);
  flushSync(() => {
    root.render(
      <SchemeBoard
        project={project}
        groups={[]}
        manual={[]}
        files={[]}
        flows={[]}
        tasks={bandBoardTasks(project)}
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
  return host;
}

const worldTransform = (host: HTMLElement) => {
  const viewport = host.querySelector('[aria-label^="Agent board"]') as HTMLElement;
  const world = Array.from(viewport.children).find((child) => (child as HTMLElement).style.transform.includes("scale(")) as HTMLElement;
  return world.style.transform;
};

test("a saved camera the board shrank out from under is re-fitted, not restored onto empty canvas", async () => {
  dom.sessionStorage.setItem("llvCam:camera-offworld", JSON.stringify({ x: 0, y: -25239.92, z: 1.6 }));
  const host = await mountBandBoard("camera-offworld");
  /* The standing rule waits for the board to settle before it judges a framing
     (a board mid-measure reports a world a pixel wide), so wait past it. */
  await new Promise((resolve) => setTimeout(resolve, 500));
  await settle();

  const transform = worldTransform(host);
  /* Not the stored coordinates: that camera looks 25 000px past the last band. */
  expect(transform).not.toContain("-25239.92px");
  /* And what it framed instead actually holds the board: both bands are inside
     the viewport the board was measured at (1400x900). */
  const viewport = host.querySelector('[aria-label^="Agent board"]') as HTMLElement;
  const camera = /translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\(([\d.]+)\)/.exec(transform)!;
  const [x, y, z] = [Number(camera[1]), Number(camera[2]), Number(camera[3])];
  const bands = Array.from(host.querySelectorAll<HTMLElement>("[data-scheme-band-task]"));
  expect(bands).toHaveLength(2);
  for (const band of bands) {
    const top = parseFloat(band.style.top) * z + y;
    const left = parseFloat(band.style.left) * z + x;
    expect(top).toBeGreaterThan(-1);
    expect(top).toBeLessThan(viewport.getBoundingClientRect().height);
    expect(left).toBeGreaterThan(-1);
    expect(left).toBeLessThan(viewport.getBoundingClientRect().width);
  }
});

test("a saved camera that still shows the board is restored exactly as it was left", async () => {
  dom.sessionStorage.setItem("llvCam:camera-inbounds", JSON.stringify({ x: 0, y: 0, z: 0.9 }));
  const host = await mountBandBoard("camera-inbounds");
  await new Promise((resolve) => setTimeout(resolve, 500));
  await settle();
  /* Scroll position is state: an in-bounds camera is never silently re-framed,
     including after the settle window the rule above waits out. */
  expect(worldTransform(host)).toBe("translate(0px, 0px) scale(0.9)");
});

test("hiding the empty task bands under a camera parked deep in the stack brings the board back", async () => {
  /* The production sequence, in order: the board is opened deep in a long band
     stack, and the one-time migration then takes 384 empty bands off it. The
     camera was in bounds when it was set, so nothing rejects it at restore —
     the world moves out from under it while the board is mounted. */
  const many = Array.from({ length: 40 }, (_, index) => ({
    id: `task-${index}`, project: "camera-shrink", status: "assigned" as const,
    text: `Task ${index}`, placement: "pinned" as const, pos: { x: 0, y: index * 200 },
    assignments: [], createdAt: `2026-07-${String((index % 27) + 1).padStart(2, "0")}T00:00:00.000Z`,
    updatedAt: "2026-07-01T00:00:00.000Z",
  }));
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.add(root);
  const render = (tasks: typeof many) => flushSync(() => {
    root.render(
      <SchemeBoard
        project="camera-shrink" groups={[]} manual={[]} files={[]} flows={[]}
        tasks={tasks} drafts={[]} focus={null}
        onSelect={() => {}} onClose={() => {}} onDraftClose={() => {}} onDraftSpawned={() => {}}
      />,
    );
  });
  render(many);
  await settle();

  const viewport = host.querySelector('[aria-label^="Agent board"]') as HTMLElement;
  const world = Array.from(viewport.children).find((child) => (child as HTMLElement).style.transform.includes("scale(")) as HTMLElement;
  /* Park the camera at the bottom of the long stack by wheeling there, so the
     position under test is one the board itself produced and clamped. */
  for (let step = 0; step < 12; step += 1) {
    const wheel = new dom.WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 900 });
    Object.defineProperties(wheel, { clientX: { value: 600 }, clientY: { value: 400 }, ctrlKey: { value: false } });
    flushSync(() => viewport.dispatchEvent(wheel as unknown as Event));
    await settle();
  }
  const parked = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(world.style.transform)!;
  expect(Number(parked[2])).toBeLessThan(-500);

  /* The migration: every empty band leaves the board. */
  render(many.slice(0, 2));
  await settle();
  await new Promise((resolve) => setTimeout(resolve, 500));
  await settle();

  /* The board is on screen again, and the bands with it. */
  const camera = /translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\(([\d.]+)\)/.exec(world.style.transform)!;
  const [x, y, z] = [Number(camera[1]), Number(camera[2]), Number(camera[3])];
  expect(y).toBeGreaterThan(Number(parked[2]));
  const bands = Array.from(host.querySelectorAll<HTMLElement>("[data-scheme-band-task]"));
  expect(bands.length).toBeGreaterThan(0);
  for (const band of bands) {
    const top = parseFloat(band.style.top) * z + y;
    const left = parseFloat(band.style.left) * z + x;
    expect(top).toBeGreaterThan(-1);
    expect(top).toBeLessThan(900);
    expect(left).toBeGreaterThan(-1);
    expect(left).toBeLessThan(1400);
  }
});
