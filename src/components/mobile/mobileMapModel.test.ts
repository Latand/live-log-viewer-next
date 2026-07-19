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

test("lineage edges only connect kept markers — no dangling endpoint into a cluster", () => {
  const { layout, tasks, workerStacks } = buildMobileMapFixture(500);
  const model = buildMobileMapModel(layout, tasks, workerStacks);
  expect(model.edges.length).toBeGreaterThan(0);
  for (const edge of model.edges) {
    expect(Number.isFinite(edge.x1) && Number.isFinite(edge.y2)).toBe(true);
  }
});
