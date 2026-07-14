import { expect, test } from "bun:test";

import { pointerNearRect } from "./useProximity";

const rect = { left: 100, top: 100, right: 200, bottom: 160 };

test("a pointer inside the rect is always near", () => {
  expect(pointerNearRect(rect, 150, 130, 40)).toBe(true);
});

test("proximity extends the rect by the radius on every edge", () => {
  // 30px left of the edge, within a 40px radius.
  expect(pointerNearRect(rect, 70, 130, 40)).toBe(true);
  // 50px left of the edge, outside a 40px radius.
  expect(pointerNearRect(rect, 50, 130, 40)).toBe(false);
});

test("corners measure true euclidean distance, not a bounding box", () => {
  // (40, 40) past the top-left corner: distance √3200 ≈ 56.6 > 50.
  expect(pointerNearRect(rect, 60, 60, 50)).toBe(false);
  // Same offset, larger radius clears it.
  expect(pointerNearRect(rect, 60, 60, 60)).toBe(true);
});
