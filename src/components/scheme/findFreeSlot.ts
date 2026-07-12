import type { SchemeRect } from "./layout";

/** Grid quantum the ring search steps by — cards snap to a tidy lattice. */
export const SLOT_Q = 24;
/** Breathing room kept between a dropped card and every obstacle. */
export const OB_GUTTER = 16;
/** How far the ring search fans out before giving up to a deterministic offset. */
export const RING_MAX = 40;

export interface Size {
  w: number;
  h: number;
}

/**
 * Pure, deterministic placement primitive (the shared first slice of #17): given
 * an anchor world point, a card size, and the boxes already on the board, return
 * the nearest grid slot whose card does not overlap any obstacle (inflated by a
 * gutter). It walks square rings outward from the anchor in a fixed order, so the
 * same inputs always yield the same slot. When RING_MAX is exhausted on a dense
 * board it returns a deterministic offset (which #17's later tidy heals) rather
 * than looping — the search always terminates.
 */
export function findFreeSlot(anchor: { x: number; y: number }, size: Size, obstacles: readonly SchemeRect[]): { x: number; y: number } {
  const overlaps = (x: number, y: number): boolean =>
    obstacles.some(
      (o) =>
        x < o.x + o.w + OB_GUTTER &&
        x + size.w + OB_GUTTER > o.x &&
        y < o.y + o.h + OB_GUTTER &&
        y + size.h + OB_GUTTER > o.y,
    );

  const ax = Math.round(anchor.x);
  const ay = Math.round(anchor.y);
  if (!overlaps(ax, ay)) return { x: ax, y: ay };

  for (let ring = 1; ring <= RING_MAX; ring += 1) {
    for (let dx = -ring; dx <= ring; dx += 1) {
      for (let dy = -ring; dy <= ring; dy += 1) {
        /* Only the ring's perimeter — inner cells were tried on earlier rings. */
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
        const x = ax + dx * SLOT_Q;
        const y = ay + dy * SLOT_Q;
        if (!overlaps(x, y)) return { x, y };
      }
    }
  }
  return { x: ax + (RING_MAX + 1) * SLOT_Q, y: ay + (RING_MAX + 1) * SLOT_Q };
}
