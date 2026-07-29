/**
 * Board selection UX (issue #771), driven through the real SchemeBoard:
 *
 * - a background drag always lassos and leaves no native text selection behind,
 *   including while the rect crosses a card, and hands text selection back the
 *   moment the gesture ends;
 * - the hover-revealed check toggles exactly one card in and out of the same
 *   canonical set, by pointer and by keyboard.
 *
 * Every gesture is checked against `viewBus`'s published `selectedPaths`, which
 * is the contract the orchestrator reads the operator's selection from.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { viewBus } from "@/hooks/viewPresenceBus";
import type { FileEntry } from "@/lib/types";

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
function bindDomGlobals() {
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
    KeyboardEvent: dom.KeyboardEvent,
    WheelEvent: dom.WheelEvent,
    sessionStorage: dom.sessionStorage,
    localStorage: dom.localStorage,
    ResizeObserver: TestResizeObserver,
    IntersectionObserver: undefined,
    requestAnimationFrame: requestFrame,
    cancelAnimationFrame: (id: number) => dom.clearTimeout(id as never),
  });
}
bindDomGlobals();

const { SchemeBoard } = await import("./SchemeBoard");

const roots = new Set<Root>();
let previousFetch: typeof fetch;
beforeEach(() => {
  bindDomGlobals();
  previousFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = previousFetch;
  for (const root of roots) flushSync(() => root.unmount());
  roots.clear();
  dom.document.body.replaceChildren();
  dom.sessionStorage.clear();
  dom.localStorage.clear();
});

const settle = async () => {
  for (let index = 0; index < 3; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  flushSync(() => undefined);
};

function file(path: string, title: string, mtime: number): FileEntry {
  return {
    path,
    root: "claude-projects",
    name: `${title}.jsonl`,
    project: "selection-ux",
    title,
    engine: "claude",
    kind: "session",
    fmt: "claude",
    parent: null,
    mtime,
    size: 1,
    activity: "idle",
    proc: null,
    pid: null,
    model: null,
    pendingQuestion: null,
    waitingInput: null,
  };
}

const alpha = file("/alpha", "Alpha conversation", 2);
const beta = file("/beta", "Beta conversation", 1);

const VIEWPORT = { x: 0, y: 0, left: 0, top: 0, right: 1400, bottom: 900, width: 1400, height: 900 };

function mountBoard(): HTMLElement {
  const host = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.append(host as never);
  const root = createRoot(host);
  roots.add(root);
  flushSync(() =>
    root.render(
      <SchemeBoard
        project="selection-ux"
        groups={[]}
        manual={[alpha, beta]}
        files={[alpha, beta]}
        flows={[]}
        tasks={[]}
        drafts={[]}
        focus={null}
        onSelect={() => {}}
        onClose={() => {}}
        onDraftClose={() => {}}
        onDraftSpawned={() => {}}
      />,
    ),
  );
  return host;
}

function viewportOf(host: HTMLElement): HTMLElement {
  const viewport = host.querySelector('[aria-label^="Agent board"]') as HTMLElement;
  Object.defineProperty(viewport, "getBoundingClientRect", {
    configurable: true,
    value: () => ({ ...VIEWPORT, toJSON() {} }),
  });
  return viewport;
}

/** The camera transform the world div carries, so screen coordinates for a card
    can be computed the same way the board itself does. */
function cameraOf(viewport: HTMLElement): { x: number; y: number; z: number } {
  const world = Array.from(viewport.children).find((child) =>
    (child as HTMLElement).style.transform.includes("scale("),
  ) as HTMLElement;
  const match = /translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\(([\d.]+)\)/.exec(world.style.transform);
  expect(match).toBeTruthy();
  return { x: Number(match![1]), y: Number(match![2]), z: Number(match![3]) };
}

/** A card's rect in viewport coordinates, from the transform the board wrote. */
function cardRect(host: HTMLElement, viewport: HTMLElement, path: string) {
  const shell = host.querySelector(`[data-scheme-node="${path}"]`) as HTMLElement;
  const match = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(shell.style.transform);
  expect(match).toBeTruthy();
  const cam = cameraOf(viewport);
  const left = Number(match![1]) * cam.z + cam.x;
  const top = Number(match![2]) * cam.z + cam.y;
  const w = Number.parseFloat(shell.style.width) * cam.z;
  const h = Number.parseFloat(shell.style.height) * cam.z;
  return { left, top, w, h, cx: left + w / 2, cy: top + h / 2, bottom: top + h };
}

/** A background point just under a card, and a drag that crosses only that card. */
function crossingDrag(host: HTMLElement, viewport: HTMLElement, path: string) {
  const rect = cardRect(host, viewport, path);
  return {
    from: { x: rect.cx, y: rect.bottom + 24 },
    to: { x: rect.cx, y: rect.cy },
  };
}

function pointer(type: string, point: { x: number; y: number }, extra: Record<string, unknown> = {}) {
  return new dom.PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    isPrimary: true,
    pointerId: 91,
    pointerType: "mouse",
    button: 0,
    clientX: point.x,
    clientY: point.y,
    ...extra,
  }) as unknown as Event;
}

/** The lasso tracks the drag on window listeners, so moves and releases go there. */
function fireOnWindow(event: Event) {
  (dom as unknown as { dispatchEvent: (event: Event) => boolean }).dispatchEvent(event);
}

/** Is a fresh selectstart on this element allowed through? That is exactly the
    question the browser asks before it starts highlighting text. */
function selectStartAllowed(target: Element): boolean {
  const event = new dom.Event("selectstart", { bubbles: true, cancelable: true });
  target.dispatchEvent(event as never);
  return !event.defaultPrevented;
}

function selectionText(): string {
  return String(dom.document.getSelection() ?? "");
}

/** Highlight the card's own title, the way an operator dragging over text would. */
function highlightInside(host: HTMLElement, path: string) {
  const shell = host.querySelector(`[data-scheme-node="${path}"]`) as HTMLElement;
  const range = dom.document.createRange();
  range.selectNodeContents(shell as unknown as Node as never);
  const selection = dom.document.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range as never);
  expect(selectionText().length).toBeGreaterThan(0);
}

function selectedPaths(): string[] {
  return viewBus.getSlice().selectedPaths;
}

function checkFor(host: HTMLElement, path: string): HTMLElement {
  const check = host.querySelector(`[data-select-check="${path}"]`) as HTMLElement;
  expect(check).toBeTruthy();
  return check;
}

/**
 * Enter and Space on a focused native button activate it — the default action
 * happy-dom does not implement. Assert the element really is an activatable
 * button (a `<span>` would never receive this in a browser), then replay the
 * click the browser would dispatch.
 */
function pressKey(element: HTMLElement, key: "Enter" | " ") {
  expect(element.tagName).toBe("BUTTON");
  expect((element as HTMLButtonElement).disabled).toBe(false);
  expect(element.getAttribute("tabindex")).toBeNull();
  element.focus();
  expect(dom.document.activeElement).toBe(element as never);
  const down = new dom.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  element.dispatchEvent(down as never);
  if (!down.defaultPrevented) element.dispatchEvent(new dom.MouseEvent("click", { bubbles: true, cancelable: true }) as never);
}

test("a background drag across a card lassos it and leaves no native text selection", async () => {
  const host = mountBoard();
  await settle();
  const viewport = viewportOf(host);
  const shell = host.querySelector('[data-scheme-node="/alpha"]') as HTMLElement;
  expect(shell).toBeTruthy();

  /* An older highlight inside a transcript: a background press is the gesture
     that clears it natively, so the lasso must clear it too. */
  highlightInside(host, "/alpha");
  /* Press on empty canvas just under the card, then drag up into it, so the rect
     really crosses transcript text on its way. */
  const { from, to } = crossingDrag(host, viewport, "/alpha");

  const down = pointer("pointerdown", from);
  flushSync(() => viewport.dispatchEvent(down));
  /* The claim suppresses the compatibility mousedown: no selection anchor is
     ever set on the canvas, which is what used to highlight cards mid-drag. */
  expect(down.defaultPrevented).toBe(true);
  expect(selectionText()).toBe("");

  flushSync(() => fireOnWindow(pointer("pointermove", { x: from.x, y: from.y - 20 })));
  flushSync(() => fireOnWindow(pointer("pointermove", to)));
  await settle();

  /* Mid-gesture: the marquee is up, the viewport suppresses selection, and the
     browser may not start highlighting the card the rect is crossing. */
  expect(viewport.className).toContain("select-none");
  expect(selectStartAllowed(shell)).toBe(false);

  flushSync(() => fireOnWindow(pointer("pointerup", to)));
  await settle();

  expect(selectedPaths()).toEqual(["/alpha"]);
  expect(selectionText()).toBe("");
  /* Released: the suppression was scoped to the gesture, so deliberate selection
     inside conversation content works again and the class is gone. */
  expect(viewport.className).not.toContain("select-none");
  expect(selectStartAllowed(shell)).toBe(true);
});

test("a cancelled background drag also releases the selection suppression", async () => {
  const host = mountBoard();
  await settle();
  const viewport = viewportOf(host);
  const shell = host.querySelector('[data-scheme-node="/alpha"]') as HTMLElement;
  const { from, to } = crossingDrag(host, viewport, "/alpha");

  flushSync(() => viewport.dispatchEvent(pointer("pointerdown", from)));
  flushSync(() => fireOnWindow(pointer("pointermove", to)));
  await settle();
  expect(viewport.className).toContain("select-none");

  flushSync(() => fireOnWindow(new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as never));
  await settle();

  expect(selectedPaths()).toEqual([]);
  expect(viewport.className).not.toContain("select-none");
  expect(selectStartAllowed(shell)).toBe(true);
});

test("the hover check reveals on approach and toggles one card in and out of the selection", async () => {
  const host = mountBoard();
  await settle();
  viewportOf(host);

  const check = checkFor(host, "/alpha");
  /* Mounted from the start — the reveal is opacity only, so nothing reflows and
     no card content is covered when it appears. */
  expect(check.getAttribute("data-select-check-revealed")).toBe("false");
  expect(check.className).toContain("opacity-0");
  expect(check.getAttribute("aria-pressed")).toBe("false");

  /* React derives enter/leave from pointerover/pointerout. */
  const zone = check.parentElement as HTMLElement;
  flushSync(() =>
    zone.dispatchEvent(new dom.PointerEvent("pointerover", { bubbles: true, relatedTarget: null } as never) as never),
  );
  await settle();
  expect(check.getAttribute("data-select-check-revealed")).toBe("true");
  expect(check.className).toContain("opacity-100");
  expect(host.querySelector('[data-scheme-node="/alpha"]')?.getAttribute("data-select-check-hover")).toBe("true");

  flushSync(() => check.dispatchEvent(new dom.MouseEvent("click", { bubbles: true, cancelable: true }) as never));
  await settle();
  expect(selectedPaths()).toEqual(["/alpha"]);
  expect(checkFor(host, "/alpha").getAttribute("aria-pressed")).toBe("true");
  /* One shared model: the check's member enters the same session the marquee
     commits into — bbox, count and member tint all follow it. */
  expect(host.textContent).toContain("1 selected");
  expect(host.querySelector('[data-scheme-node="/alpha"]')?.getAttribute("data-lasso-selected")).toBe("true");
  /* A session shows every card's toggle: touch has no hover, and the panes go
     click-through, so a card hover can no longer reveal one. */
  expect(checkFor(host, "/beta").getAttribute("data-select-check-revealed")).toBe("true");

  flushSync(() => checkFor(host, "/beta").dispatchEvent(new dom.MouseEvent("click", { bubbles: true, cancelable: true }) as never));
  await settle();
  expect(selectedPaths()).toEqual(["/alpha", "/beta"]);

  /* Clicking a member's check again takes it back out. */
  flushSync(() => checkFor(host, "/alpha").dispatchEvent(new dom.MouseEvent("click", { bubbles: true, cancelable: true }) as never));
  await settle();
  expect(selectedPaths()).toEqual(["/beta"]);
  expect(checkFor(host, "/alpha").getAttribute("aria-pressed")).toBe("false");

  flushSync(() => checkFor(host, "/beta").dispatchEvent(new dom.MouseEvent("click", { bubbles: true, cancelable: true }) as never));
  await settle();
  expect(selectedPaths()).toEqual([]);
  expect(host.querySelector('[data-scheme-node="/alpha"]')?.getAttribute("data-lasso-selected")).toBeNull();
});

test("the check is keyboard reachable and Enter / Space toggle the same set", async () => {
  const host = mountBoard();
  await settle();
  viewportOf(host);

  const check = checkFor(host, "/beta");
  expect(check.className).toContain("focus-visible:ring-2");

  pressKey(check, "Enter");
  await settle();
  expect(selectedPaths()).toEqual(["/beta"]);

  pressKey(checkFor(host, "/beta"), " ");
  await settle();
  expect(selectedPaths()).toEqual([]);
});

test("a lasso commit and a check toggle write the same set, in layout order", async () => {
  const host = mountBoard();
  await settle();
  const viewport = viewportOf(host);

  /* Check /beta first, then lasso /alpha additively with Shift: one set, ordered
     by the layout rather than by the order the gestures happened in. */
  flushSync(() => checkFor(host, "/beta").dispatchEvent(new dom.MouseEvent("click", { bubbles: true, cancelable: true }) as never));
  await settle();
  expect(selectedPaths()).toEqual(["/beta"]);

  const { from, to } = crossingDrag(host, viewport, "/alpha");
  flushSync(() => viewport.dispatchEvent(pointer("pointerdown", from, { shiftKey: true })));
  flushSync(() => fireOnWindow(pointer("pointermove", { x: from.x, y: from.y - 20 }, { shiftKey: true })));
  flushSync(() => fireOnWindow(pointer("pointermove", to, { shiftKey: true })));
  await settle();
  flushSync(() => fireOnWindow(pointer("pointerup", to, { shiftKey: true })));
  await settle();

  expect(selectedPaths()).toEqual(["/alpha", "/beta"]);
});
