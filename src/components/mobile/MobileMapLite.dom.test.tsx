import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { buildMobileMapFixture } from "./mobileMapFixture";
import { MobileMapLite } from "./MobileMapLite";
import { MOBILE_MAP_DOM_BUDGET } from "./mobileMapModel";

const dom = new Window({ url: "http://localhost/" });
const G = globalThis as Record<string, unknown>;
let fetchCalls = 0;
const OVERRIDES: Record<string, unknown> = {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  Event: dom.Event,
  MouseEvent: dom.MouseEvent,
  WheelEvent: dom.WheelEvent,
  sessionStorage: dom.sessionStorage,
  localStorage: dom.localStorage,
  matchMedia: (q: string) => ({ matches: /max-width/.test(String(q)), media: String(q), onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } }),
  requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  fetch: (async () => { fetchCalls += 1; return { ok: true, status: 200, json: async () => ({}), text: async () => "" }; }) as unknown as typeof fetch,
};
const HAS: Record<string, boolean> = {};
const SAVED: Record<string, unknown> = {};
const settle = async () => { await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0)); };

let roots: Root[] = [];
beforeAll(() => {
  for (const key of Object.keys(OVERRIDES)) { HAS[key] = key in G; SAVED[key] = G[key]; G[key] = OVERRIDES[key]; }
  (dom.HTMLElement.prototype as unknown as { setPointerCapture: () => void }).setPointerCapture = () => {};
});
afterAll(async () => {
  await settle();
  for (const key of Object.keys(OVERRIDES)) { if (HAS[key]) G[key] = SAVED[key]; else delete G[key]; }
});
beforeEach(() => { dom.document.body.replaceChildren(); roots = []; fetchCalls = 0; });
afterEach(async () => { for (const r of roots) flushSync(() => r.unmount()); roots = []; await settle(); });

function mount(node: React.ReactElement): Root {
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as Element);
  flushSync(() => root.render(node));
  roots.push(root);
  return root;
}

const fixture = buildMobileMapFixture(500);

test("the open map commits a skeleton first, then the markers (issue #418)", async () => {
  mount(<MobileMapLite layout={fixture.layout} tasks={fixture.tasks} workerStacks={fixture.workerStacks} frame="all" ringKey={null} onPick={() => {}} />);
  /* Synchronous first paint: the skeleton is up, markers are not yet committed. */
  expect(dom.document.querySelector('[data-testid="mobile-map-skeleton"]')).not.toBeNull();
  expect(dom.document.querySelector('[data-testid="mobile-map-marker"]')).toBeNull();
  await settle();
  expect(dom.document.querySelector('[data-testid="mobile-map-skeleton"]')).toBeNull();
  expect(dom.document.querySelectorAll('[data-testid="mobile-map-marker"]').length).toBeGreaterThan(0);
});

test("opening the map on the largest board stays under the DOM budget and fetches nothing (#418)", async () => {
  mount(<MobileMapLite layout={fixture.layout} tasks={fixture.tasks} workerStacks={fixture.workerStacks} frame="all" ringKey={null} onPick={() => {}} />);
  await settle();
  const total = dom.document.querySelectorAll("*").length;
  expect(total).toBeLessThanOrEqual(MOBILE_MAP_DOM_BUDGET);
  /* Reading already-polled state — the overlay must issue zero requests, which is
     what lets it survive a slow Tailscale link and reconnects. */
  expect(fetchCalls).toBe(0);
});

test("the lite map mounts no transcript feed or pane (#418)", async () => {
  mount(<MobileMapLite layout={fixture.layout} tasks={fixture.tasks} workerStacks={fixture.workerStacks} frame="all" ringKey={null} onPick={() => {}} />);
  await settle();
  expect(dom.document.querySelector('[data-testid="log-feed"]')).toBeNull();
  expect(dom.document.querySelector('[data-branch-pane]')).toBeNull();
  expect(dom.document.querySelector("textarea")).toBeNull();
});

test("tapping a marker emits its exact pickFromMap key", async () => {
  const picks: string[] = [];
  mount(<MobileMapLite layout={fixture.layout} tasks={fixture.tasks} workerStacks={fixture.workerStacks} frame="all" ringKey={null} onPick={(key) => picks.push(key)} />);
  await settle();
  const marker = dom.document.querySelector(`[data-map-key="${fixture.sampleNodePath}"]`) as unknown as HTMLButtonElement | null;
  expect(marker).not.toBeNull();
  flushSync(() => marker!.click());
  expect(picks).toEqual([fixture.sampleNodePath]);
});

test("all framing consumes the negative world origin", async () => {
  const source = buildMobileMapFixture(8);
  const node = { ...source.layout.nodes[0]!, x: -500, y: 0, w: 40, h: 40 };
  const layout = {
    ...source.layout,
    nodes: [node],
    edges: [],
    stacks: [],
    decks: [],
    drafts: [],
    byPath: new Map([[node.file.path, node]]),
    width: 1,
    height: 1,
  };

  mount(<MobileMapLite layout={layout} tasks={[]} workerStacks={[]} frame="all" ringKey={null} onPick={() => {}} />);
  await settle();

  const marker = dom.document.querySelector(`[data-map-key="${node.file.path}"]`) as unknown as HTMLElement;
  expect(Number.parseFloat(marker.style.left)).toBeCloseTo(28, 5);
});

test("all framing fits negative, distant, and clustered bounds while wheel zoom stays continuous", async () => {
  const source = buildMobileMapFixture(500);
  source.layout.nodes[0]!.x = -1_200;
  source.layout.nodes[0]!.y = -800;
  source.layout.nodes[399]!.x = source.layout.width + 20_000;
  source.layout.nodes[400]!.x = source.layout.width + 60_000;
  source.layout.nodes[400]!.y = source.layout.height + 30_000;

  mount(<MobileMapLite layout={source.layout} tasks={source.tasks} workerStacks={source.workerStacks} frame="all" ringKey={null} onPick={() => {}} />);
  await settle();

  const map = dom.document.querySelector('[data-testid="mobile-map"]') as unknown as HTMLElement;
  const markers = [...dom.document.querySelectorAll('[data-testid="mobile-map-marker"]')] as unknown as HTMLElement[];
  const clusters = [...dom.document.querySelectorAll('[data-testid="mobile-map-cluster"]')] as unknown as HTMLElement[];
  expect(markers).toHaveLength(400);
  expect(clusters.length).toBeGreaterThan(0);

  for (const element of [...markers, ...clusters]) {
    const left = Number.parseFloat(element.style.left);
    const top = Number.parseFloat(element.style.top);
    const width = element.dataset.testid === "mobile-map-marker" ? Number.parseFloat(element.style.width) : 40;
    const height = element.dataset.testid === "mobile-map-marker" ? Number.parseFloat(element.style.height) : 40;
    expect(left).toBeGreaterThanOrEqual(0);
    expect(top).toBeGreaterThanOrEqual(0);
    expect(left + width).toBeLessThanOrEqual(390);
    expect(top + height).toBeLessThanOrEqual(620);
  }
  expect(markers.every((marker) => Number.parseFloat(marker.style.width) >= 40 && Number.parseFloat(marker.style.height) >= 40)).toBe(true);

  const negativeMarker = dom.document.querySelector(`[data-map-key="${source.layout.nodes[0]!.file.path}"]`) as unknown as HTMLElement;
  const leftBeforeZoom = Number.parseFloat(negativeMarker.style.left);
  const zoomIn = new dom.WheelEvent("wheel", { bubbles: true, deltaY: -100 });
  Object.defineProperties(zoomIn, { clientX: { value: 195 }, clientY: { value: 310 } });
  flushSync(() => map.dispatchEvent(zoomIn as unknown as Event));
  await settle();
  const leftAfterZoomIn = Number.parseFloat(negativeMarker.style.left);
  expect(leftAfterZoomIn).toBeLessThan(leftBeforeZoom);
  expect(Math.abs(leftAfterZoomIn - leftBeforeZoom)).toBeLessThan(100);

  const zoomOut = new dom.WheelEvent("wheel", { bubbles: true, deltaY: 100 });
  Object.defineProperties(zoomOut, { clientX: { value: 195 }, clientY: { value: 310 } });
  flushSync(() => map.dispatchEvent(zoomOut as unknown as Event));
  await settle();
  expect(Number.parseFloat(negativeMarker.style.left)).toBeCloseTo(leftBeforeZoom, 5);
});

test("current framing centers the retained focus marker at interactive scale", async () => {
  const source = buildMobileMapFixture(500);
  const focused = source.layout.nodes[450]!;
  mount(
    <MobileMapLite
      layout={source.layout}
      tasks={source.tasks}
      workerStacks={source.workerStacks}
      frame="current"
      ringKey={focused.file.path}
      onPick={() => {}}
    />,
  );
  await settle();

  const marker = dom.document.querySelector(`[data-map-key="${focused.file.path}"]`) as unknown as HTMLElement;
  const left = Number.parseFloat(marker.style.left);
  const top = Number.parseFloat(marker.style.top);
  const width = Number.parseFloat(marker.style.width);
  const height = Number.parseFloat(marker.style.height);
  expect(left + width / 2).toBeCloseTo(195, 5);
  expect(top + height / 2).toBeCloseTo(310, 5);
  expect({ width, height }).toEqual({ width: focused.w, height: focused.h });
});

test("current framing fits a focused conversation and a distant active pipeline", async () => {
  const source = buildMobileMapFixture(8);
  const focused = { ...source.layout.nodes[0]!, x: 100, y: 100, w: 300, h: 220 };
  const layout = {
    ...source.layout,
    nodes: [focused],
    edges: [],
    groups: [],
    stacks: [],
    decks: [],
    drafts: [],
    slots: [],
    links: [],
    loops: [],
    byPath: new Map([[focused.file.path, focused]]),
    width: 500,
    height: 420,
  };
  mount(
    <MobileMapLite
      layout={layout}
      tasks={[]}
      workerStacks={[]}
      pipelineOutlines={[{ id: "far", title: "Synthetic pipeline", rect: { x: 2_200, y: 100, w: 360, h: 76 } }]}
      frame="current"
      ringKey={focused.file.path}
      onPick={() => {}}
    />,
  );
  await settle();

  const focusedMarker = dom.document.querySelector(`[data-map-key="${focused.file.path}"]`) as unknown as HTMLElement;
  const pipelineMarker = dom.document.querySelector('[data-map-kind="pipeline"]') as unknown as HTMLElement;
  for (const marker of [focusedMarker, pipelineMarker]) {
    const left = Number.parseFloat(marker.style.left);
    const top = Number.parseFloat(marker.style.top);
    const width = Number.parseFloat(marker.style.width);
    const height = Number.parseFloat(marker.style.height);
    expect(left).toBeGreaterThanOrEqual(0);
    expect(top).toBeGreaterThanOrEqual(0);
    expect(left + width).toBeLessThanOrEqual(390);
    expect(top + height).toBeLessThanOrEqual(620);
  }
});

test("current framing fits separated pipeline-only outlines", async () => {
  const source = buildMobileMapFixture(8);
  const emptyLayout = {
    ...source.layout,
    nodes: [],
    edges: [],
    groups: [],
    stacks: [],
    decks: [],
    drafts: [],
    slots: [],
    links: [],
    loops: [],
    byPath: new Map(),
    width: 1,
    height: 1,
  };
  mount(
    <MobileMapLite
      layout={emptyLayout}
      tasks={[]}
      workerStacks={[]}
      pipelineOutlines={[
        { id: "left", title: "Left pipeline", rect: { x: 100, y: 100, w: 360, h: 76 } },
        { id: "right", title: "Right pipeline", rect: { x: 100_000, y: 500, w: 360, h: 76 } },
      ]}
      frame="current"
      ringKey={null}
      onPick={() => {}}
    />,
  );
  await settle();

  const markers = [...dom.document.querySelectorAll('[data-map-kind="pipeline"]')] as unknown as HTMLElement[];
  expect(markers).toHaveLength(2);
  for (const marker of markers) {
    const left = Number.parseFloat(marker.style.left);
    const top = Number.parseFloat(marker.style.top);
    const width = Number.parseFloat(marker.style.width);
    const height = Number.parseFloat(marker.style.height);
    expect(left).toBeGreaterThanOrEqual(0);
    expect(top).toBeGreaterThanOrEqual(0);
    expect(left + width).toBeLessThanOrEqual(390);
    expect(top + height).toBeLessThanOrEqual(620);
  }
});

test("current framing without a ring keeps the fitted fallback gesture floor", async () => {
  const source = buildMobileMapFixture(8);
  const leftNode = { ...source.layout.nodes[0]!, x: -5_000 };
  const rightNode = { ...source.layout.nodes[1]!, x: 5_000 };
  const layout = {
    ...source.layout,
    nodes: [leftNode, rightNode],
    edges: [],
    stacks: [],
    decks: [],
    drafts: [],
    byPath: new Map([[leftNode.file.path, leftNode], [rightNode.file.path, rightNode]]),
    width: 1,
    height: 1,
  };
  mount(<MobileMapLite layout={layout} tasks={[]} workerStacks={[]} frame="current" ringKey={null} onPick={() => {}} />);
  await settle();

  const map = dom.document.querySelector('[data-testid="mobile-map"]') as unknown as HTMLElement;
  const marker = dom.document.querySelector(`[data-map-key="${leftNode.file.path}"]`) as unknown as HTMLElement;
  const leftBeforeZoom = Number.parseFloat(marker.style.left);
  const zoomIn = new dom.WheelEvent("wheel", { bubbles: true, deltaY: -100 });
  Object.defineProperties(zoomIn, { clientX: { value: 195 }, clientY: { value: 310 } });
  flushSync(() => map.dispatchEvent(zoomIn as unknown as Event));
  await settle();

  const leftAfterZoom = Number.parseFloat(marker.style.left);
  expect(leftAfterZoom).toBeLessThan(leftBeforeZoom);
  expect(Math.abs(leftAfterZoom - leftBeforeZoom)).toBeLessThan(100);
});

test("pipeline-only All and Current framing preserve a manual camera across equivalent polls", async () => {
  const source = buildMobileMapFixture(8);
  const emptyLayout = {
    ...source.layout,
    nodes: [],
    edges: [],
    groups: [],
    stacks: [],
    decks: [],
    drafts: [],
    slots: [],
    links: [],
    loops: [],
    byPath: new Map(),
    width: 1,
    height: 1,
  };
  const outline = { id: "pipeline-only", title: "Synthetic pipeline", rect: { x: 720, y: 240, w: 360, h: 76 } };
  const render = (root: Root, frame: "all" | "current", poll = false) => flushSync(() => root.render(
    <MobileMapLite
      layout={poll ? { ...emptyLayout, byPath: new Map() } : emptyLayout}
      tasks={[]}
      workerStacks={[]}
      pipelineOutlines={[{ ...outline, rect: { ...outline.rect } }]}
      frame={frame}
      ringKey={null}
      onPick={() => {}}
    />,
  ));
  const root = mount(
    <MobileMapLite
      layout={emptyLayout}
      tasks={[]}
      workerStacks={[]}
      pipelineOutlines={[outline]}
      frame="all"
      ringKey={null}
      onPick={() => {}}
    />,
  );
  await settle();

  const marker = () => dom.document.querySelector('[data-map-kind="pipeline"]') as unknown as HTMLElement;
  const map = dom.document.querySelector('[data-testid="mobile-map"]') as unknown as HTMLElement;
  const initialLeft = Number.parseFloat(marker().style.left);
  const initialTop = Number.parseFloat(marker().style.top);
  const initialWidth = Number.parseFloat(marker().style.width);
  const initialHeight = Number.parseFloat(marker().style.height);
  expect(initialLeft).toBeGreaterThanOrEqual(0);
  expect(initialTop).toBeGreaterThanOrEqual(0);
  expect(initialLeft + initialWidth).toBeLessThanOrEqual(390);
  expect(initialTop + initialHeight).toBeLessThanOrEqual(620);

  const zoomIn = new dom.WheelEvent("wheel", { bubbles: true, deltaY: -180 });
  Object.defineProperties(zoomIn, { clientX: { value: 195 }, clientY: { value: 310 } });
  flushSync(() => map.dispatchEvent(zoomIn as unknown as Event));
  await settle();
  const manualLeft = Number.parseFloat(marker().style.left);
  expect(manualLeft).not.toBeCloseTo(initialLeft, 5);

  render(root, "all", true);
  await settle();
  expect(Number.parseFloat(marker().style.left)).toBeCloseTo(manualLeft, 5);

  render(root, "current", true);
  await settle();
  expect(Number.parseFloat(marker().style.left) + Number.parseFloat(marker().style.width) / 2).toBeCloseTo(195, 5);
  expect(Number.parseFloat(marker().style.top) + Number.parseFloat(marker().style.height) / 2).toBeCloseTo(310, 5);
  expect(Number.parseFloat(marker().style.width)).toBe(outline.rect.w);
  expect(Number.parseFloat(marker().style.height)).toBe(outline.rect.h);

  render(root, "all", true);
  await settle();
  expect(Number.parseFloat(marker().style.left)).toBeCloseTo(initialLeft, 5);
});
