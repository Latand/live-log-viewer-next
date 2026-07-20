import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { EdgeChips } from "./EdgeChips";
import type { BoardCluster } from "./offscreenClusters";

const dom = new Window();

/* Query-aware matchMedia so a test can toggle coarse pointer / reduced motion
   independently. Defaults model a fine-pointer desktop with motion allowed. */
const mediaState = { coarse: false, reducedMotion: false, narrow: false };
function matches(query: string): boolean {
  if (query.includes("pointer: coarse")) return mediaState.coarse;
  if (query.includes("prefers-reduced-motion")) return mediaState.reducedMotion;
  if (query.includes("max-width")) return mediaState.narrow;
  return false;
}
(dom as unknown as { matchMedia: (query: string) => unknown }).matchMedia = (query: string) => ({
  get matches() { return matches(query); },
  media: query,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
  onchange: null,
  dispatchEvent: () => false,
});

Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLButtonElement: dom.HTMLButtonElement,
  HTMLSpanElement: dom.HTMLSpanElement,
  KeyboardEvent: dom.KeyboardEvent,
  MouseEvent: dom.MouseEvent,
  PointerEvent: dom.PointerEvent,
  FocusEvent: dom.FocusEvent,
  Event: dom.Event,
});

const roots = new Set<Root>();
beforeEach(() => {
  mediaState.coarse = false;
  mediaState.reducedMotion = false;
  mediaState.narrow = false;
});
afterEach(() => {
  for (const root of roots) flushSync(() => root.unmount());
  roots.clear();
  document.body.replaceChildren();
});

/* React 19 dispatches hover/enter/leave as *continuous* priority: the state
   update they schedule commits on a later macrotask, not synchronously inside
   the dispatching flushSync. Real pointer moves re-render fine; a test just has
   to let React's scheduler drain before asserting. */
const settle = async () => {
  for (let index = 0; index < 3; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  flushSync(() => undefined);
};

/* One long-titled cluster far off the right edge → a single right-anchored
   chip whose label overflows its resting width. */
const clusters: BoardCluster[] = [{
  key: "long",
  label: "Deterministic capture pipeline — stage two builder",
  rect: { x: 4_000, y: 300, w: 100, h: 100 },
  priority: 10,
  color: "red",
}];

function mount(onFit: (rect: { x: number; y: number }) => void = () => {}) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.add(root);
  flushSync(() => root.render(
    <EdgeChips
      clusters={clusters}
      cam={{ x: 0, y: 0, z: 1 }}
      vp={{ w: 1_000, h: 700 }}
      hidden={false}
      onFit={onFit}
    />,
  ));
  return host;
}

function chip(host: HTMLElement): HTMLButtonElement {
  return host.querySelector("[data-edge-chip]") as HTMLButtonElement;
}

/** Stub the title's layout so overflow + end-of-title geometry are deterministic
    under happy-dom (which reports zeros). */
function stubTitle(title: HTMLElement, opts: { scrollWidth: number; clientWidth: number; right: number }) {
  Object.defineProperty(title, "scrollWidth", { configurable: true, value: opts.scrollWidth });
  Object.defineProperty(title, "clientWidth", { configurable: true, value: opts.clientWidth });
  title.getBoundingClientRect = () => ({
    left: opts.right - opts.clientWidth,
    right: opts.right,
    top: 0,
    bottom: 44,
    width: opts.clientWidth,
    height: 44,
    x: opts.right - opts.clientWidth,
    y: 0,
    toJSON() {},
  }) as DOMRect;
}

test("resting chip reserves a control zone before the title so the arrow never overlaps the label", () => {
  const host = mount();
  const button = chip(host);
  const control = button.querySelector("[data-edge-chip-control]") as HTMLElement;
  const title = button.querySelector("[data-edge-chip-title]") as HTMLElement;
  expect(control).toBeTruthy();
  expect(title).toBeTruthy();
  /* Control leads the title in document order and owns the direction glyph, so
     the reserved control box is a layout sibling of the label — never over it.
     The fixture cluster sits far off the *right* edge, so its glyph is "→". */
  expect(control.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(control.textContent).toContain("→");
  expect(title.textContent).toBe(clusters[0]!.label);
  expect(title.textContent).not.toContain("→");
});

test("the chip and its revealed title are one continuous surface — the title lives inside the chip button", () => {
  const host = mount();
  const button = chip(host);
  const title = button.querySelector("[data-edge-chip-title]") as HTMLElement;
  expect(title.closest("[data-edge-chip]")).toBe(button);
  /* No detached tooltip that would drop hover in the gap between chip and popup. */
  expect(host.querySelector('[role="tooltip"]')).toBeNull();
});

test("progressive reveal advances one segment when the pointer reaches the truncated end", async () => {
  const host = mount();
  const button = chip(host);
  const title = button.querySelector("[data-edge-chip-title]") as HTMLElement;
  expect(title.getAttribute("data-reveal")).toBe("0");
  const base = Number.parseFloat(title.style.maxWidth);
  expect(base).toBeGreaterThan(0);

  stubTitle(title, { scrollWidth: 500, clientWidth: 120, right: 200 });
  button.dispatchEvent(new PointerEvent("pointermove", { clientX: 199, bubbles: true }));
  await settle();
  expect(title.getAttribute("data-reveal")).toBe("1");
  const grown = Number.parseFloat(title.style.maxWidth);
  expect(grown).toBeGreaterThan(base);

  button.dispatchEvent(new PointerEvent("pointermove", { clientX: 199, bubbles: true }));
  await settle();
  expect(title.getAttribute("data-reveal")).toBe("2");

  /* A move away from the truncated end does not advance the reveal. */
  button.dispatchEvent(new PointerEvent("pointermove", { clientX: 20, bubbles: true }));
  await settle();
  expect(title.getAttribute("data-reveal")).toBe("2");
});

test("a fully visible title stops revealing — no runaway growth", async () => {
  const host = mount();
  const button = chip(host);
  const title = button.querySelector("[data-edge-chip-title]") as HTMLElement;
  /* Not overflowing: content fits inside the current width. */
  stubTitle(title, { scrollWidth: 118, clientWidth: 120, right: 200 });
  button.dispatchEvent(new PointerEvent("pointermove", { clientX: 199, bubbles: true }));
  await settle();
  expect(title.getAttribute("data-reveal")).toBe("0");
});

test("leaving the chip collapses the reveal back to its resting segment", async () => {
  const host = mount();
  const button = chip(host);
  const title = button.querySelector("[data-edge-chip-title]") as HTMLElement;
  stubTitle(title, { scrollWidth: 500, clientWidth: 120, right: 200 });
  button.dispatchEvent(new PointerEvent("pointermove", { clientX: 199, bubbles: true }));
  await settle();
  expect(title.getAttribute("data-reveal")).toBe("1");
  /* React synthesizes onPointerLeave from a native pointerout with no
     related target — dispatch that, not a raw (non-bubbling) pointerleave. */
  button.dispatchEvent(new PointerEvent("pointerout", { bubbles: true }));
  await settle();
  expect(title.getAttribute("data-reveal")).toBe("0");
});

test("keyboard focus reveals the full title without a pointer", async () => {
  const host = mount();
  const button = chip(host);
  const title = button.querySelector("[data-edge-chip-title]") as HTMLElement;
  /* React delegates onFocus/onBlur to the bubbling focusin/focusout events. */
  button.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
  await settle();
  expect(title.getAttribute("data-reveal")).toBe("full");
  /* Full reveal drops the width cap so the whole title shows. */
  expect(title.style.maxWidth === "" || title.style.maxWidth === "none").toBe(true);
  button.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  await settle();
  expect(title.getAttribute("data-reveal")).toBe("0");
});

test("reduced motion reveals fully on hover instead of animating segments", async () => {
  mediaState.reducedMotion = true;
  const host = mount();
  const button = chip(host);
  const title = button.querySelector("[data-edge-chip-title]") as HTMLElement;
  /* React synthesizes onPointerEnter from a native pointerover. */
  button.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
  await settle();
  expect(title.getAttribute("data-reveal")).toBe("full");
});

test("clicking the chip still fits its cluster", () => {
  const fitted: string[] = [];
  const host = mount((rect) => fitted.push(`${rect.x}:${rect.y}`));
  const button = chip(host);
  flushSync(() => button.click());
  expect(fitted).toEqual([`${clusters[0]!.rect.x}:${clusters[0]!.rect.y}`]);
});

test("coarse pointers hide every edge chip from the conversation canvas", () => {
  mediaState.coarse = true;
  const host = mount();
  expect(host.querySelector("nav")).toBeNull();
  expect(host.querySelector("[data-edge-chip]")).toBeNull();
});
