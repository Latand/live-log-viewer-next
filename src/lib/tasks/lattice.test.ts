import { describe, expect, test } from "bun:test";

import { AUTO_LATTICE_MAX_Y, autoTaskPosition } from "./lattice";

describe("auto task lattice", () => {
  test("reuses the first freed shelf slot", () => {
    const first = autoTaskPosition([]);
    const second = autoTaskPosition([{ source: {}, pos: first }]);
    const reused = autoTaskPosition([{ source: {}, pos: second }]);

    expect(first).toEqual({ x: 740, y: 120 });
    expect(second).toEqual({ x: 1040, y: 120 });
    expect(reused).toEqual(first);
  });

  test("500 auto cards wrap across column pairs without growing the shelf downward", () => {
    const cards: Array<{ source: object; pos: { x: number; y: number } }> = [];
    for (let index = 0; index < 500; index += 1) {
      cards.push({ source: {}, pos: autoTaskPosition(cards) });
    }

    expect(new Set(cards.map((card) => `${card.pos.x}:${card.pos.y}`)).size).toBe(500);
    expect(Math.max(...cards.map((card) => card.pos.y))).toBe(AUTO_LATTICE_MAX_Y);
    expect(AUTO_LATTICE_MAX_Y).toBeLessThanOrEqual(2_900);
  });
});
