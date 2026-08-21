import { expect, test } from "bun:test";

import { GRID_BASE_TILE, GRID_MIN_SCREEN_PX, gridTilePx } from "./canvasGrid";

test("the dot grid stays sparse across the whole zoom range (issue #962)", () => {
  /* Sweep the camera's practical range (lite-map minimum ~0.12 up to 3×):
     the on-screen spacing never collapses below the sparse floor. */
  for (let zoom = 0.05; zoom <= 3; zoom += 0.01) {
    expect(gridTilePx(zoom)).toBeGreaterThanOrEqual(GRID_MIN_SCREEN_PX);
  }
});

test("spacing doubles in power-of-two steps of the world base, so dots thin in place", () => {
  for (const zoom of [0.12, 0.3, 0.5, 0.75, 1, 1.5, 2]) {
    const ratio = gridTilePx(zoom) / (GRID_BASE_TILE * zoom);
    expect(Math.log2(ratio) % 1).toBeCloseTo(0, 9);
  }
});

test("at zoom 1 and above the native spacing is already sparse and unchanged", () => {
  expect(gridTilePx(1)).toBe(GRID_BASE_TILE);
  expect(gridTilePx(2)).toBe(GRID_BASE_TILE * 2);
});

test("a degenerate zoom falls back to the base tile instead of looping", () => {
  expect(gridTilePx(0)).toBe(GRID_BASE_TILE);
  expect(gridTilePx(-1)).toBe(GRID_BASE_TILE);
  expect(gridTilePx(Number.NaN)).toBe(GRID_BASE_TILE);
});
