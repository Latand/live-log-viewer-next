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
