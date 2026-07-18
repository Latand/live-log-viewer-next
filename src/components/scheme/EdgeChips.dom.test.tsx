import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { EdgeChips } from "./EdgeChips";
import type { BoardCluster } from "./offscreenClusters";

const dom = new Window();
Object.assign(globalThis, { window: dom, document: dom.document, navigator: dom.navigator, HTMLElement: dom.HTMLElement });
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

test("renders bounded chips, opens overflow, and fits the chosen cluster", () => {
  const fitted: string[] = [];
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
      onFit={(rect) => fitted.push(`${rect.x}:${rect.y}`)}
    />,
  ));

  expect(host.querySelectorAll("[data-edge-chip]")).toHaveLength(4);
  const more = host.querySelector('button[aria-label="Show 2 more off-screen clusters"]') as HTMLButtonElement;
  expect(more).toBeTruthy();
  flushSync(() => more.click());
  const item = Array.from(host.querySelectorAll('[role="menuitem"]')).find((node) => node.textContent?.includes("Cluster 4")) as HTMLButtonElement;
  expect(item).toBeTruthy();
  flushSync(() => item.click());
  expect(fitted).toEqual([`${clusters[4]!.rect.x}:${clusters[4]!.rect.y}`]);
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
