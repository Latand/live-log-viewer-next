import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { EdgeChips } from "./EdgeChips";
import type { BoardCluster } from "./offscreenClusters";

const dom = new Window();
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLButtonElement: dom.HTMLButtonElement,
  KeyboardEvent: dom.KeyboardEvent,
  Event: dom.Event,
});
const roots = new Set<Root>();
afterEach(() => {
  for (const root of roots) flushSync(() => root.unmount());
  roots.clear();
  document.body.replaceChildren();
});

const clusters: BoardCluster[] = Array.from({ length: 6 }, (_, index) => ({
  key: `c${index}`,
  label: `Cluster ${index}`,
  rect: { x: 1_400 + index * 20, y: 200, w: 100, h: 100 },
  priority: 10 - index,
  color: "red",
}));

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

test("renders bounded chips, opens overflow, and fits the chosen cluster", () => {
  const fitted: string[] = [];
  const host = mount((rect) => fitted.push(`${rect.x}:${rect.y}`));

  expect(host.querySelectorAll("[data-edge-chip]")).toHaveLength(4);
  const more = host.querySelector('button[aria-label="Show 2 more off-screen clusters"]') as HTMLButtonElement;
  expect(more).toBeTruthy();
  flushSync(() => more.click());
  const item = Array.from(host.querySelectorAll("[data-overflow-chip]")).find((node) => node.textContent?.includes("Cluster 4")) as HTMLButtonElement;
  expect(item).toBeTruthy();
  flushSync(() => item.click());
  expect(fitted).toEqual([`${clusters[4]!.rect.x}:${clusters[4]!.rect.y}`]);
  /* Choosing an item closes the disclosure again. */
  expect(host.querySelector("[data-overflow-chip]")).toBeNull();
});

test("the overflow is a truthful disclosure: no menu roles, expanded state wired to its list (round-1 finding 3)", () => {
  const host = mount();
  const more = host.querySelector('button[aria-label="Show 2 more off-screen clusters"]') as HTMLButtonElement;
  expect(more.getAttribute("aria-expanded")).toBe("false");
  expect(more.hasAttribute("aria-haspopup")).toBe(false);

  flushSync(() => more.click());
  expect(more.getAttribute("aria-expanded")).toBe("true");
  const listId = more.getAttribute("aria-controls");
  expect(listId).toBeTruthy();
  const list = host.querySelector(`[id="${listId}"]`)!;
  expect(list).toBeTruthy();
  /* Items are plain tab-reachable buttons — menu roles promised arrow-key
     semantics the widget doesn't implement. */
  expect(host.querySelector('[role="menu"]')).toBeNull();
  expect(host.querySelector('[role="menuitem"]')).toBeNull();
  expect(list.querySelectorAll("button")).toHaveLength(2);
});

test("Escape closes the open overflow and returns focus to its trigger", () => {
  const host = mount();
  const more = host.querySelector('button[aria-label="Show 2 more off-screen clusters"]') as HTMLButtonElement;
  flushSync(() => more.click());
  const item = host.querySelector("[data-overflow-chip]") as HTMLButtonElement;
  expect(item).toBeTruthy();
  item.focus();

  flushSync(() => {
    item.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  expect(host.querySelector("[data-overflow-chip]")).toBeNull();
  expect(more.getAttribute("aria-expanded")).toBe("false");
  expect(document.activeElement).toBe(more);
});

test("a press outside the open overflow dismisses it", () => {
  const host = mount();
  const more = host.querySelector('button[aria-label="Show 2 more off-screen clusters"]') as HTMLButtonElement;
  flushSync(() => more.click());
  expect(host.querySelector("[data-overflow-chip]")).toBeTruthy();

  flushSync(() => {
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
  });
  expect(host.querySelector("[data-overflow-chip]")).toBeNull();

  /* A press inside the popup does not dismiss it. */
  flushSync(() => more.click());
  const item = host.querySelector("[data-overflow-chip]") as HTMLButtonElement;
  flushSync(() => {
    item.dispatchEvent(new Event("pointerdown", { bubbles: true }));
  });
  expect(host.querySelector("[data-overflow-chip]")).toBeTruthy();
});

test("re-homes the «+N» aggregate off a fully blocked edge, keeping it a keyboard-reachable disclosure clear of the obstacle (issue #474)", () => {
  /* A keep-out wall covers the whole right edge — the border every overflow
     cluster folds toward. The aggregate must not dock over the wall: it re-homes
     to a clear border and stays a labelled, tab-reachable disclosure so keyboard
     navigation to the off-screen clusters is preserved. */
  const rightWall = { x: 940, y: 0, w: 60, h: 700 };
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
      obstacles={[rightWall]}
      onFit={() => {}}
    />,
  ));
  const more = Array.from(host.querySelectorAll("button")).find((b) => /^\+\d+$/.test((b.textContent || "").trim())) as HTMLButtonElement;
  expect(more).toBeTruthy();
  expect(more.tagName).toBe("BUTTON"); // still keyboard-focusable
  flushSync(() => more.click());
  const listId = more.getAttribute("aria-controls");
  expect(listId).toBeTruthy();
  /* Re-homed off the walled right edge onto a clear border. */
  expect(listId).not.toBe("edge-chip-overflow-right");
  expect(host.querySelectorAll("[data-overflow-chip]").length).toBeGreaterThan(0);
});

test("opens the «+N» list inward from its edge, width-constrained and clamped inside the viewport (issue #474)", () => {
  /* The default clusters all fold onto the RIGHT edge, so the disclosure opens
     its list LEFT — inward — never off the right border. The list carries the
     computed inline geometry (a right offset, a bounded width and max-height),
     and reconstructing its box from the anchor proves it stays on-board. */
  const host = mount();
  const more = host.querySelector('button[aria-label="Show 2 more off-screen clusters"]') as HTMLButtonElement;
  flushSync(() => more.click());
  const listEl = host.querySelector("[data-overflow-list]") as HTMLElement;
  expect(listEl).toBeTruthy();
  expect(listEl.getAttribute("data-overflow-list")).toBe("right");
  const style = listEl.style;
  // Inward: a right-edge list opens left (right offset set), never rightward.
  expect(parseFloat(style.right)).toBeGreaterThan(0);
  expect(style.left).toBe("");
  const width = parseFloat(style.width);
  const maxHeight = parseFloat(style.maxHeight);
  expect(width).toBeGreaterThan(0);
  expect(maxHeight).toBeGreaterThan(0);
  /* Container sits at the trigger anchor (right edge midpoint of a 1000×700
     viewport). Reconstruct the list box and require it fully on-board. */
  const container = listEl.parentElement as HTMLElement;
  const anchorX = parseFloat(container.style.left);
  const anchorY = parseFloat(container.style.top);
  const boxRight = anchorX - parseFloat(style.right);
  const boxLeft = boxRight - width;
  const boxTop = anchorY + parseFloat(style.top);
  expect(boxLeft).toBeGreaterThanOrEqual(8 - 1e-6);
  expect(boxRight).toBeLessThanOrEqual(1_000);
  expect(boxTop).toBeGreaterThanOrEqual(8 - 1e-6);
  expect(boxTop + maxHeight).toBeLessThanOrEqual(700 - 8 + 1e-6);
});

test("hides every chip during map/pan/marquee modes", () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.add(root);
  flushSync(() => root.render(
    <EdgeChips clusters={clusters} cam={{ x: 0, y: 0, z: 1 }} vp={{ w: 1_000, h: 700 }} hidden onFit={() => {}} />,
  ));
  expect(host.querySelector("nav")).toBeNull();
});
