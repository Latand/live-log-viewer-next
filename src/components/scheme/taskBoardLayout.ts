import type { SchemeGroup, SchemeRect } from "./layout";
import type { PlacedTask } from "./taskGeometry";

export function overlaps(a: SchemeRect, b: SchemeRect, gap = 0): boolean {
  return a.x < b.x + b.w + gap && a.x + a.w + gap > b.x && a.y < b.y + b.h + gap && a.y + a.h + gap > b.y;
}

/** Preview and commit share the same collision decision. Existing pins are
 * obstacles; automatic neighbours can be placed around the accepted drop. */
export function legalTaskDrop(task: PlacedTask, point: { x: number; y: number }, groups: readonly SchemeGroup[], pinnedIds: ReadonlySet<string>): { x: number; y: number } {
  const own = groups.find(group => group.taskId === task.id);
  if (!own) return point;
  const moving = { ...own, x: own.x + point.x - task.pos.x, y: own.y + point.y - task.pos.y };
  const obstacles = groups.filter(group => group.taskId !== task.id && group.taskId && pinnedIds.has(group.taskId));
  if (!obstacles.some(rect => overlaps(moving, rect, 32))) return point;
  const candidates = obstacles.flatMap(rect => [
    { ...moving, x: rect.x - moving.w - 32 }, { ...moving, x: rect.x + rect.w + 32 },
    { ...moving, y: rect.y - moving.h - 32 }, { ...moving, y: rect.y + rect.h + 32 },
  ]).filter(candidate => !obstacles.some(rect => overlaps(candidate, rect, 31.99)));
  candidates.sort((a, b) => Math.hypot(a.x - moving.x, a.y - moving.y) - Math.hypot(b.x - moving.x, b.y - moving.y));
  const accepted = candidates[0];
  return accepted ? { x: Math.round(point.x + accepted.x - moving.x), y: Math.round(point.y + accepted.y - moving.y) } : task.pos;
}
