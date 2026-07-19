import { expect, test } from "bun:test";

import { buildMobileMapFixture } from "./mobileMapFixture";
import { buildMobileMapModel, markerPickKeys, MAP_MARKER_CAP } from "./mobileMapModel";

test("the marker set is capped and the overflow folds into spatial clusters (#418)", () => {
  const { layout, tasks, workerStacks } = buildMobileMapFixture(500);
  const model = buildMobileMapModel(layout, tasks, workerStacks);

  /* Never more than the cap of individual markers, however large the board. */
  expect(model.markers.length).toBeLessThanOrEqual(MAP_MARKER_CAP);
  /* The board is bigger than the cap, so the surplus must be clustered, not lost. */
  expect(model.total).toBeGreaterThan(MAP_MARKER_CAP);
  expect(model.clusters.length).toBeGreaterThan(0);
  const clustered = model.clusters.reduce((sum, cluster) => sum + cluster.count, 0);
  expect(model.markers.length + clustered).toBe(model.total);
});

test("a small board renders every occupant individually with no clusters", () => {
  const { layout, tasks, workerStacks } = buildMobileMapFixture(20);
  const model = buildMobileMapModel(layout, tasks, workerStacks);
  expect(model.clusters).toHaveLength(0);
  expect(model.markers.length).toBe(model.total);
});

test("collapsed worker stacks always ride the map — their per-origin dots live nowhere else (#136)", () => {
  const { layout, tasks, workerStacks } = buildMobileMapFixture(20);
  const model = buildMobileMapModel(layout, tasks, workerStacks);
  const workers = model.markers.filter((marker) => marker.kind === "worker");
  expect(workers).toHaveLength(workerStacks.length);
  /* An empty stack still shows a dot (map reachability) but is not pickable. */
  const empty = workers.find((marker) => marker.count === 0);
  expect(empty).toBeDefined();
  expect(empty!.pickKey).toBeNull();
  /* A worker stack with members opens its top worker's transcript. */
  const populated = workers.find((marker) => (marker.count ?? 0) > 0);
  expect(populated!.pickKey).toContain("/codex/worker-");
});

test("every pickable marker key round-trips through the pickFromMap contract", () => {
  const { layout, tasks, workerStacks } = buildMobileMapFixture(30);
  const model = buildMobileMapModel(layout, tasks, workerStacks);
  const keys = markerPickKeys(model);
  const nodePaths = new Set(layout.nodes.map((node) => node.file.path));
  const deckKeys = new Set(layout.decks.map((deck) => deck.key));
  const draftKeys = new Set(layout.drafts.map((draft) => draft.key));
  const stackTops = new Set(layout.stacks.map((stack) => stack.items[0]?.file.path).filter(Boolean));
  const workerTops = new Set(workerStacks.flatMap((stack) => stack.items[0] ? [stack.items[0].path] : []));
  for (const key of keys) {
    const resolvable =
      key.startsWith("task::") ||
      nodePaths.has(key) ||
      deckKeys.has(key) ||
      draftKeys.has(key) ||
      stackTops.has(key) ||
      workerTops.has(key);
    expect(resolvable, `pick key ${key} must resolve`).toBe(true);
  }
  /* Tasks are reachable from the map so a status-stacked card is never orphaned. */
  expect(keys.some((key) => key.startsWith("task::"))).toBe(true);
});

test("the focused marker survives the cap instead of vanishing into a cluster (PR #431)", () => {
  const { layout, tasks, workerStacks } = buildMobileMapFixture(500);
  /* Node 450 sits past the 400-marker cap, so without focus it is clustered. */
  const focusKey = "/codex/session-450.jsonl";
  const base = buildMobileMapModel(layout, tasks, workerStacks);
  expect(base.total).toBeGreaterThan(MAP_MARKER_CAP);
  expect(base.markers.some((marker) => marker.key === focusKey)).toBe(false);

  /* Focused, that same key must be an individual marker — the ring and the
     "current" frame need a rect — while the cap and the accounting hold. */
  const model = buildMobileMapModel(layout, tasks, workerStacks, focusKey);
  expect(model.markers.some((marker) => marker.key === focusKey)).toBe(true);
  expect(model.markers.length).toBeLessThanOrEqual(MAP_MARKER_CAP);
  const clustered = model.clusters.reduce((sum, cluster) => sum + cluster.count, 0);
  expect(model.markers.length + clustered).toBe(model.total);

  /* A focus key already inside the cap (or absent) changes nothing. */
  const kept = buildMobileMapModel(layout, tasks, workerStacks, "/codex/session-0.jsonl");
  expect(kept.markers.map((marker) => marker.key)).toEqual(base.markers.map((marker) => marker.key));
});

test("lineage edges only connect kept markers — no dangling endpoint into a cluster", () => {
  const { layout, tasks, workerStacks } = buildMobileMapFixture(500);
  const model = buildMobileMapModel(layout, tasks, workerStacks);
  expect(model.edges.length).toBeGreaterThan(0);
  for (const edge of model.edges) {
    expect(Number.isFinite(edge.x1) && Number.isFinite(edge.y2)).toBe(true);
  }
});

test("focus retention keeps lineage only when both endpoint markers remain visible", () => {
  const { layout, tasks, workerStacks } = buildMobileMapFixture(500);
  const visibleSource = layout.nodes[0]!;
  const clusteredSource = layout.nodes[MAP_MARKER_CAP - 1]!;
  const focusedDestination = layout.nodes[450]!;
  const edgeFrom = (source: typeof visibleSource) => ({
    to: focusedDestination.file.path,
    x1: source.x + 40,
    y1: source.y + source.h,
    x2: focusedDestination.x + focusedDestination.w / 2,
    y2: focusedDestination.y,
    color: "#888",
    live: false,
  });
  const visibleEdge = edgeFrom(visibleSource);
  layout.edges = [edgeFrom(clusteredSource), visibleEdge];

  const model = buildMobileMapModel(layout, tasks, workerStacks, focusedDestination.file.path);
  const visibleKeys = new Set(model.markers.map((marker) => marker.key));
  expect(visibleKeys.has(visibleSource.file.path)).toBe(true);
  expect(visibleKeys.has(clusteredSource.file.path)).toBe(false);
  expect(visibleKeys.has(focusedDestination.file.path)).toBe(true);
  expect(model.edges).toEqual([{ x1: visibleEdge.x1, y1: visibleEdge.y1, x2: visibleEdge.x2, y2: visibleEdge.y2 }]);
});

test("all-frame bounds span negative and distant markers plus overflow clusters", () => {
  const { layout, tasks, workerStacks } = buildMobileMapFixture(500);
  layout.nodes[0]!.x = -1_200;
  layout.nodes[0]!.y = -800;
  layout.nodes[399]!.x = layout.width + 20_000;
  layout.nodes[400]!.x = layout.width + 60_000;
  layout.nodes[400]!.y = layout.height + 30_000;

  const model = buildMobileMapModel(layout, tasks, workerStacks);
  const rects = [...model.markers, ...model.clusters].map((item) => item.rect);
  const left = Math.min(0, ...rects.map((rect) => rect.x));
  const top = Math.min(0, ...rects.map((rect) => rect.y));
  const right = Math.max(layout.width, ...rects.map((rect) => rect.x + rect.w));
  const bottom = Math.max(layout.height, ...rects.map((rect) => rect.y + rect.h));

  expect(model.clusters.some((cluster) => cluster.rect.x > layout.width)).toBe(true);
  expect(model.world).toEqual({ x: left, y: top, w: right - left, h: bottom - top });
});

test("a memberless pipeline contributes a mobile outline plus All and Current bounds", () => {
  const source = buildMobileMapFixture(8);
  const layout = {
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
  const outline = {
    id: "pipeline-only",
    title: "Synthetic pipeline",
    rect: { x: 720, y: 240, w: 360, h: 76 },
  };
  const model = buildMobileMapModel(layout, [], [], null, [outline]);
  const marker = model.markers.find((candidate) => candidate.key === "pipeline::pipeline-only");

  expect(marker).toMatchObject({ kind: "pipeline", rect: outline.rect, pickKey: null });
  expect(model.world.x + model.world.w).toBeGreaterThanOrEqual(outline.rect.x + outline.rect.w);
  expect(model.world.y + model.world.h).toBeGreaterThanOrEqual(outline.rect.y + outline.rect.h);
  expect(model.current).toEqual(outline.rect);
  expect(model.currentCount).toBe(1);
});
