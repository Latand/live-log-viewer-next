import type { SchemeRect } from "./layout";

/** Geometry-only index. Camera frames inspect intersecting buckets without
 * touching conversation props, summaries or native readers. */
export function createVisibilityIndex(entries: readonly (SchemeRect & { id: string })[], cellSize = 1200) {
  const cells = new Map<string, (SchemeRect & { id: string })[]>();
  for (const entry of entries) {
    for (let x = Math.floor(entry.x / cellSize); x <= Math.floor((entry.x + entry.w) / cellSize); x++) {
      for (let y = Math.floor(entry.y / cellSize); y <= Math.floor((entry.y + entry.h) / cellSize); y++) {
        const key = `${x}:${y}`;
        const cell = cells.get(key) ?? [];
        cell.push(entry);
        cells.set(key, cell);
      }
    }
  }
  return (rect: SchemeRect): ReadonlySet<string> => {
    const result = new Set<string>();
    for (let x = Math.floor(rect.x / cellSize); x <= Math.floor((rect.x + rect.w) / cellSize); x++) {
      for (let y = Math.floor(rect.y / cellSize); y <= Math.floor((rect.y + rect.h) / cellSize); y++) {
        for (const entry of cells.get(`${x}:${y}`) ?? []) {
          if (entry.x < rect.x + rect.w && entry.x + entry.w > rect.x && entry.y < rect.y + rect.h && entry.y + entry.h > rect.y) result.add(entry.id);
        }
      }
    }
    return result;
  };
}
