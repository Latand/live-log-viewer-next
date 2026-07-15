import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import type { Camera } from "./Minimap";
import type { SchemeLayout, SchemeRect } from "./layout";
import { taskNavKey, type TaskNavTarget } from "./spatialNav";
import { useSpatialNav } from "./useSpatialNav";

/* Same standing-globals discipline as the sibling scheme DOM tests: React's
   scheduler drains deferred work after teardown and would throw if `window`
   vanished, so the happy-dom globals stay installed and only per-test roots are
   torn down. */
const dom = new Window();
(dom as unknown as { matchMedia: (q: string) => unknown }).matchMedia = () => ({
  matches: false, media: "", addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false,
});
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  Event: dom.Event,
  sessionStorage: dom.sessionStorage,
  localStorage: dom.localStorage,
});

const roots = new Set<Root>();
afterEach(() => {
  for (const root of roots) flushSync(() => root.unmount());
  roots.clear();
  document.body.replaceChildren();
});

/* A board whose only nav targets are task cards — the node layout is empty, so
   `taskNav` is the sole thing that moves the followed anchor (the exact case the
   reflow effect must react to). */
const emptyLayout: SchemeLayout = { nodes: [], stacks: [], byPath: new Map<string, SchemeRect>() } as unknown as SchemeLayout;
const CAM: Camera = { x: 0, y: 0, z: 1 };
const VP = { w: 1600, h: 900 };

function card(x: number, y: number, label = "Do the thing"): TaskNavTarget {
  return { key: taskNavKey("t1"), x, y, w: 260, h: 90, label };
}

/* Harness: drive the hook with a controllable `taskNav` and capture the camera
   callbacks it fires, so a re-render with a moved/removed card exercises the
   follow lifecycle end-to-end. */
function Harness({ taskNav, selected, setSelected, glideBy }: { taskNav: TaskNavTarget[]; selected: string | null; setSelected: (v: string | null) => void; glideBy: (dx: number, dy: number) => void }) {
  useSpatialNav({
    enabled: true,
    layout: emptyLayout,
    taskNav,
    cam: CAM,
    vp: VP,
    selected,
    setSelected,
    centerOn: () => {},
    glideBy,
    glideFrame: () => {},
    manualNonce: 0,
  });
  return null;
}

/* Passive effects (arm-follow, reflow) settle across a few macrotasks; drain
   them, then flush any pending render synchronously — mirrors the sibling
   SchemeBoard DOM tests. */
const settle = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  flushSync(() => undefined);
};

test("a followed task card that moves translates the camera by its world delta", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.add(root);

  const glides: Array<[number, number]> = [];
  const glideBy = (dx: number, dy: number) => glides.push([dx, dy]);
  const sel = taskNavKey("t1");

  /* Select the card at (100,100): arms follow and seeds the reflow baseline. */
  flushSync(() => root.render(<Harness taskNav={[card(100, 100)]} selected={sel} setSelected={() => {}} glideBy={glideBy} />));
  await settle();
  expect(glides).toHaveLength(0); // no motion just from landing

  /* Re-place the card at (150,130) with the node layout untouched — only
     `taskNav` changed, which previously left the anchor unfollowed. */
  flushSync(() => root.render(<Harness taskNav={[card(150, 130)]} selected={sel} setSelected={() => {}} glideBy={glideBy} />));
  await settle();
  expect(glides).toEqual([[50, 30]]);
});

test("a followed task card that is removed drops the selection", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.add(root);

  const selectedCalls: Array<string | null> = [];
  const setSelected = (v: string | null) => selectedCalls.push(v);
  const sel = taskNavKey("t1");

  flushSync(() => root.render(<Harness taskNav={[card(100, 100)]} selected={sel} setSelected={setSelected} glideBy={() => {}} />));
  await settle();

  /* The card leaves the board (deleted / poll drop) — `taskNav` empties while
     `layout` stays put; the follow must drop the ring rather than stranding it. */
  flushSync(() => root.render(<Harness taskNav={[]} selected={sel} setSelected={setSelected} glideBy={() => {}} />));
  await settle();
  expect(selectedCalls).toContain(null);
});
