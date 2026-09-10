import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import type { SchemeLayout, SchemeRect } from "./layout";
import { READABLE_Z, useSchemeCamera, type SchemeCamera } from "./useSchemeCamera";

/**
 * The focus contract at the hook, with no board around it (#1625).
 *
 * A focus request asks for a READABLE framing of the conversation it names, not
 * merely for the node's rectangle to be somewhere in the viewport. Coming back
 * to a conversation on a board zoomed out to the overview scale therefore has
 * to zoom in to it, even though the node is technically on screen the whole
 * time — a chip is not something the operator can read.
 *
 * That guarantee is old (`centerOn(node, READABLE_Z)` has always carried it)
 * and easy to lose to a completion predicate that answers "is it visible?"
 * before the first move is made, so it is pinned here on its own.
 */

const dom = new Window();
const VIEWPORT = { x: 0, y: 0, left: 0, top: 0, right: 1400, bottom: 900, width: 1400, height: 900, toJSON() {} };
class TestResizeObserver {
  constructor(private callback: () => void) {}
  observe(element: HTMLElement) {
    Object.defineProperty(element, "getBoundingClientRect", { configurable: true, value: () => VIEWPORT });
    queueMicrotask(this.callback);
  }
  unobserve() {}
  disconnect() {}
}
(dom as unknown as { matchMedia: (query: string) => unknown }).matchMedia = () => ({
  matches: false, media: "", addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false,
});
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLDivElement: dom.HTMLDivElement,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
  MouseEvent: dom.MouseEvent,
  PointerEvent: dom.PointerEvent,
  WheelEvent: dom.WheelEvent,
  sessionStorage: dom.sessionStorage,
  localStorage: dom.localStorage,
  ResizeObserver: TestResizeObserver,
  requestAnimationFrame: (callback: FrameRequestCallback) => dom.setTimeout(() => callback(0), 0),
  cancelAnimationFrame: (id: number) => dom.clearTimeout(id as never),
});

let root: Root | null = null;
let camera: SchemeCamera;
afterEach(() => {
  flushSync(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
  dom.sessionStorage.clear();
  dom.localStorage.clear();
});
const settle = async () => {
  for (let index = 0; index < 8; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  flushSync(() => undefined);
};

const PROJECT = "focus-zoom";
/* Small enough, and near enough the origin, that it is already inside the
   viewport at the overview scale the board opens on. */
const target = { file: { path: "/target" }, x: 100, y: 100, w: 600, h: 780 };
const layout = {
  nodes: [target], drafts: [], groups: [], decks: [], stacks: [], slots: [], regionTasks: [],
  byPath: new Map<string, SchemeRect>([["/target", target as SchemeRect]]),
} as unknown as SchemeLayout;
const world = { x: 0, y: 0, w: 2_000, h: 4_000 };

function Harness({ focus }: { focus: string | null }) {
  camera = useSchemeCamera({ project: PROJECT, layout, world, mapMode: false, focus, setSelected: () => {} });
  return <div aria-label="Agent board" ref={camera.viewportRef} />;
}
function mount(focus: string | null) {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  flushSync(() => root!.render(<Harness focus={focus} />));
}
const render = (focus: string | null) => flushSync(() => root!.render(<Harness focus={focus} />));

test("a board restored at the overview scale zooms in to the conversation it opens with", async () => {
  dom.sessionStorage.setItem(`llvCam:${PROJECT}`, JSON.stringify({ x: 0, y: 0, z: 0.2 }));
  mount("/target");
  await settle();
  expect(camera.cam.z).toBeGreaterThanOrEqual(READABLE_Z);
});

test("a focus that arrives after the viewport is measured still zooms in, even though the node was already on screen", async () => {
  dom.sessionStorage.setItem(`llvCam:${PROJECT}`, JSON.stringify({ x: 0, y: 0, z: 0.2 }));
  mount(null);
  await settle();
  /* The saved overview camera is restored untouched, and at it the node's
     rectangle already overlaps the viewport — «visible» and «readable» are
     different questions, and only the second one is the request. */
  expect(camera.cam.z).toBe(0.2);
  const sx = camera.cam.x + target.x * camera.cam.z;
  const sy = camera.cam.y + target.y * camera.cam.z;
  expect(sx).toBeGreaterThanOrEqual(0);
  expect(sy).toBeGreaterThanOrEqual(0);
  expect(sx).toBeLessThan(VIEWPORT.width);
  expect(sy).toBeLessThan(VIEWPORT.height);

  render("/target");
  await settle();
  expect(camera.cam.z).toBeGreaterThanOrEqual(READABLE_Z);
  /* And it is framed, not merely scaled: head near the top of the viewport. */
  expect(camera.cam.y + target.y * camera.cam.z).toBeGreaterThanOrEqual(0);
  expect(camera.cam.y + target.y * camera.cam.z).toBeLessThan(VIEWPORT.height / 2);
});

test("a focus already framed at a readable scale is left exactly where it is", async () => {
  mount("/target");
  await settle();
  const framed = { ...camera.cam };
  expect(framed.z).toBeGreaterThanOrEqual(READABLE_Z);
  /* The request is complete. Re-rendering with the SAME focus is not a new
     request and must not move the camera again. */
  render("/target");
  await settle();
  expect(camera.cam).toEqual(framed);
});
