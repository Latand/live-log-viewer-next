import { afterAll, afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

/*
 * #1858: the image preview and the portalled menus never take focus, so an
 * Escape pressed over them targets the body. The expanded conversation's own
 * listener sits on the document and skips only keys that are already handled
 * or that come from a field, a menu or a dialog; before this hook the preview
 * and the menu listened on the window's bubble phase, after the document, and
 * one press closed them together with the modal under them.
 */

const dom = new Window({ url: "http://localhost/" });
const G = globalThis as Record<string, unknown>;
const OVERRIDES: Record<string, unknown> = {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  KeyboardEvent: dom.KeyboardEvent,
  IS_REACT_ACT_ENVIRONMENT: true,
};
const HAD: Record<string, boolean> = {};
const SAVED: Record<string, unknown> = {};
for (const key of Object.keys(OVERRIDES)) { HAD[key] = key in G; SAVED[key] = G[key]; G[key] = OVERRIDES[key]; }

const { useOverlayEscape } = await import("./useOverlayEscape");
const { Lightbox } = await import("@/components/feed/Lightbox");

let root: Root | null = null;
let host: HTMLElement | null = null;
const cleanups: (() => void)[] = [];

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  for (const cleanup of cleanups.splice(0)) cleanup();
});

afterAll(() => {
  for (const key of Object.keys(OVERRIDES)) {
    if (HAD[key]) G[key] = SAVED[key];
    else delete G[key];
  }
});

function mount(node: React.ReactNode) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(node));
}

/** The expanded conversation's listener, in the shape the kanban board ships. */
function modalUnder(): { closed: () => number } {
  let closed = 0;
  const onKey = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest?.("input, textarea, select, [contenteditable='true'], [role='menu'], [role='dialog']")) return;
    closed += 1;
  };
  document.addEventListener("keydown", onKey);
  cleanups.push(() => document.removeEventListener("keydown", onKey));
  return { closed: () => closed };
}

function pressEscape() {
  act(() => {
    document.body.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }) as unknown as Event);
  });
}

test("one Escape over the image preview closes the preview and leaves the modal under it open", () => {
  const modal = modalUnder();
  let open = true;
  let closes = 0;
  function Harness() {
    return open ? <Lightbox src="/pixel.png" alt="a screenshot" onClose={() => { closes += 1; open = false; act(() => root!.render(<Harness />)); }} /> : null;
  }
  mount(<Harness />);
  expect(document.querySelector("[role='dialog']")).not.toBeNull();

  pressEscape();
  expect(closes).toBe(1);
  expect(modal.closed()).toBe(0);

  /* With nothing over it, the next Escape is the modal's again. */
  pressEscape();
  expect(modal.closed()).toBe(1);
});

test("stacked overlays close newest first, one per press", () => {
  const order: string[] = [];
  function Overlay({ name }: { name: string }) {
    useOverlayEscape(() => order.push(name));
    return null;
  }
  mount(<><Overlay name="preview" /><Overlay name="menu" /></>);
  pressEscape();
  expect(order).toEqual(["menu"]);
});

test("an overlay that is not enabled leaves Escape alone", () => {
  const modal = modalUnder();
  const heard: string[] = [];
  function Overlay() {
    useOverlayEscape(() => heard.push("overlay"), false);
    return null;
  }
  mount(<Overlay />);
  pressEscape();
  expect(heard).toEqual([]);
  expect(modal.closed()).toBe(1);
});
