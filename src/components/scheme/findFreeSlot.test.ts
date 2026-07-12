import { describe, expect, test } from "bun:test";

import { findFreeSlot, OB_GUTTER, RING_MAX, SLOT_Q } from "./findFreeSlot";
import type { SchemeRect } from "./layout";

const SIZE = { w: 260, h: 120 };

function overlaps(x: number, y: number, o: SchemeRect): boolean {
  return x < o.x + o.w + OB_GUTTER && x + SIZE.w + OB_GUTTER > o.x && y < o.y + o.h + OB_GUTTER && y + SIZE.h + OB_GUTTER > o.y;
}

describe("findFreeSlot", () => {
  test("returns the anchor when it is already free", () => {
    expect(findFreeSlot({ x: 100, y: 200 }, SIZE, [])).toEqual({ x: 100, y: 200 });
  });

  test("rounds the anchor to whole pixels", () => {
    expect(findFreeSlot({ x: 10.4, y: 20.6 }, SIZE, [])).toEqual({ x: 10, y: 21 });
  });

  test("steps off an obstacle to a non-overlapping slot", () => {
    const obstacles: SchemeRect[] = [{ x: 100, y: 200, w: 260, h: 120 }];
    const slot = findFreeSlot({ x: 100, y: 200 }, SIZE, obstacles);
    expect(obstacles.some((o) => overlaps(slot.x, slot.y, o))).toBe(false);
  });

  test("is deterministic under obstacle permutation", () => {
    const a: SchemeRect[] = [
      { x: 100, y: 200, w: 260, h: 120 },
      { x: 140, y: 260, w: 260, h: 120 },
      { x: 60, y: 140, w: 260, h: 120 },
    ];
    const b = [a[2]!, a[0]!, a[1]!];
    expect(findFreeSlot({ x: 100, y: 200 }, SIZE, a)).toEqual(findFreeSlot({ x: 100, y: 200 }, SIZE, b));
  });

  test("never overlaps on a moderately dense board within RING_MAX", () => {
    const obstacles: SchemeRect[] = [];
    for (let i = 0; i < 5; i += 1) {
      for (let j = 0; j < 5; j += 1) obstacles.push({ x: i * SLOT_Q, y: j * SLOT_Q, w: 260, h: 120 });
    }
    const slot = findFreeSlot({ x: 0, y: 0 }, SIZE, obstacles);
    expect(obstacles.some((o) => overlaps(slot.x, slot.y, o))).toBe(false);
  });

  test("terminates with a deterministic offset when the ring is exhausted", () => {
    /* One obstacle spanning every candidate slot forces exhaustion. */
    const wall: SchemeRect[] = [{ x: -100000, y: -100000, w: 200000, h: 200000 }];
    const slot = findFreeSlot({ x: 0, y: 0 }, SIZE, wall);
    expect(slot).toEqual({ x: (RING_MAX + 1) * SLOT_Q, y: (RING_MAX + 1) * SLOT_Q });
  });
});
