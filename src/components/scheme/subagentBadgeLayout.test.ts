import { expect, test } from "bun:test";

import { layoutBadges } from "./subagentBadgeLayout";

test("layoutBadges stacks spawn order bottom-up and wraps into columns to the right", () => {
  const positions = layoutBadges(
    [{ id: "first" }, { id: "second" }, { id: "third" }],
    { x: 100, y: 200, w: 600, h: 70 },
    30,
    6,
  );

  expect(positions).toEqual([
    { kind: "badge", child: { id: "first" }, x: 706, y: 240, size: 30, column: 0, row: 0 },
    { kind: "badge", child: { id: "second" }, x: 706, y: 204, size: 30, column: 0, row: 1 },
    { kind: "badge", child: { id: "third" }, x: 742, y: 240, size: 30, column: 1, row: 0 },
  ]);
});

test("layoutBadges reserves the final capped slot for the complete hidden count", () => {
  const children = Array.from({ length: 14 }, (_, index) => ({ id: `child-${index + 1}` }));
  const positions = layoutBadges(children, { x: 100, y: 200, w: 600, h: 70 }, 30, 6);

  expect(positions).toHaveLength(12);
  expect(positions.slice(0, -1).map((position) => position.kind === "badge" ? position.child.id : "overflow")).toEqual(
    children.slice(0, 11).map((child) => child.id),
  );
  expect(positions.at(-1)).toEqual({
    kind: "overflow",
    count: 3,
    x: 886,
    y: 204,
    size: 30,
    column: 5,
    row: 1,
  });
});

test("layoutBadges uses one row per column for a very short card and returns no positions for zero children", () => {
  expect(layoutBadges([], { x: 10, y: 20, w: 100, h: 20 }, 30, 6)).toEqual([]);
  expect(layoutBadges([{ id: "first" }, { id: "second" }], { x: 10, y: 20, w: 100, h: 20 }, 30, 6)).toEqual([
    { kind: "badge", child: { id: "first" }, x: 116, y: 20, size: 30, column: 0, row: 0 },
    { kind: "badge", child: { id: "second" }, x: 152, y: 20, size: 30, column: 1, row: 0 },
  ]);
});
