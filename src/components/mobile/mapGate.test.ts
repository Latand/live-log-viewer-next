import { expect, test } from "bun:test";

import { mapReachable } from "./mapGate";

test("collapsed worker stacks make the mobile map reachable, not just >1 node (#136 finding 3)", () => {
  /* A worker-heavy board — one visible root plus collapsed stacks — must still
     open the map so the per-origin dots are reachable. */
  expect(mapReachable(1, 2)).toBe(true);
  expect(mapReachable(0, 1)).toBe(true);
  /* Original availability is preserved. */
  expect(mapReachable(2, 0)).toBe(true);
  /* A lone node with nothing collapsed keeps the map hidden. */
  expect(mapReachable(1, 0)).toBe(false);
  expect(mapReachable(0, 0)).toBe(false);
});

test("an active pipeline makes an otherwise empty mobile map reachable", () => {
  expect(mapReachable(0, 0, 1)).toBe(true);
});
