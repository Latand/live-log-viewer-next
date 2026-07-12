import type { BoardTask } from "@/lib/tasks/types";

import type { SchemeRect } from "./layout";
import { TASK_W, taskCardHeight } from "./taskGeometry";

/* Minimum clear gap between a task card and any card or pane it is nudged
   away from — the board reads as sticky notes, so a small breathing gutter is
   enough to keep every card and its dashed edge legible. */
export const TASK_GUTTER = 16;

/* How far the slot search fans out before giving up. A ring is one card step;
   48 rings clears any realistic burst of curator/inbox cards while staying a
   hard bound so the pass always terminates. */
const MAX_RING = 48;

/** Everything the placement pass needs from a task — kept structural so the
    module tests with plain literals instead of full BoardTask fixtures. */
export type PlaceableTask = Pick<BoardTask, "id" | "pos" | "text" | "assignments" | "source" | "pinned">;

/** Do two rects come within `gap` of each other? Touching or closer counts;
    exactly `gap` apart does not, so a resolved slot keeps a real gutter. */
function clash(a: SchemeRect, b: SchemeRect, gap: number): boolean {
  return a.x < b.x + b.w + gap && a.x + a.w + gap > b.x && a.y < b.y + b.h + gap && a.y + a.h + gap > b.y;
}

function clashesAny(rect: SchemeRect, rects: readonly SchemeRect[], gap: number): boolean {
  for (const other of rects) {
    if (clash(rect, other, gap)) return true;
  }
  return false;
}

/* Deterministic outward spiral of grid offsets. Each ring tries its bottom row
   first, then upward, left-to-right, so a displaced card slides *below* its
   original spot before spreading sideways — matching the top-down board and
   keeping a card near its owner. Memoized: the offsets never change. */
let spiralCache: ReadonlyArray<readonly [number, number]> | null = null;
function spiralOffsets(): ReadonlyArray<readonly [number, number]> {
  if (spiralCache) return spiralCache;
  const out: Array<readonly [number, number]> = [];
  for (let r = 1; r <= MAX_RING; r++) {
    for (let dy = r; dy >= -r; dy--) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) === r) out.push([dx, dy]);
      }
    }
  }
  spiralCache = out;
  return out;
}

/**
 * Find a display slot for one auto-positioned card. It keeps its stored
 * position only when that spot is clear of every already-placed card *and*
 * every pane obstacle — so an untidy lattice card sitting inside a pane is
 * nudged out even when no other card contends for the spot. Any card that
 * would collide is relocated, spiralling outward to the nearest slot that
 * clears both cards and panes (falling back to a card-clear slot if panes box
 * it in). Pinned cards never reach here — they hold their exact spot.
 */
function findSlot(card: SchemeRect, placedCards: readonly SchemeRect[], obstacles: readonly SchemeRect[]): { x: number; y: number } {
  if (!clashesAny(card, placedCards, TASK_GUTTER) && !clashesAny(card, obstacles, TASK_GUTTER)) return { x: card.x, y: card.y };

  const stepX = card.w + TASK_GUTTER;
  const stepY = card.h + TASK_GUTTER;
  let cardClearFallback: { x: number; y: number } | null = null;

  for (const [dx, dy] of spiralOffsets()) {
    const x = Math.round(card.x + dx * stepX);
    const y = Math.round(card.y + dy * stepY);
    const candidate: SchemeRect = { x, y, w: card.w, h: card.h };
    if (clashesAny(candidate, placedCards, TASK_GUTTER)) continue;
    if (!clashesAny(candidate, obstacles, TASK_GUTTER)) return { x, y };
    if (!cardClearFallback) cardClearFallback = { x, y };
  }

  return cardClearFallback ?? { x: card.x, y: card.y };
}

/**
 * Collision-aware placement for the board's task cards (issue #17). Cards piled
 * at the same auto-position — the curator/inbox lattice packs them 120px apart
 * while a card runs well over that tall — are spread into non-overlapping slots
 * so their text and dashed edges stay readable, and an auto card that lands on a
 * pane is nudged into the gap beside it.
 *
 * Pure and deterministic: the result depends only on card geometry, the pinned
 * flags, and the pane obstacles, never on input order. A pinned card (one a
 * human placed or dragged) holds its exact coordinates untouched and anchors
 * the pass as an immovable obstacle, so hand-arranged boards pass through
 * unchanged. An auto card keeps its stored spot only while it clears every other
 * card and every pane; otherwise it relocates in reading order — top-to-bottom
 * then left-to-right, id as the final tiebreak — so the topmost card of a pileup
 * settles first and the rest flow down around it.
 */
export function resolveTaskPlacements(tasks: readonly PlaceableTask[], obstacles: readonly SchemeRect[]): Map<string, { x: number; y: number }> {
  const cards = tasks.map((task) => ({ id: task.id, x: task.pos.x, y: task.pos.y, w: TASK_W, h: taskCardHeight(task), pinned: task.pinned === true }));

  const placed: SchemeRect[] = [];
  const result = new Map<string, { x: number; y: number }>();
  /* Pinned cards land first at their exact spot and join `placed` as anchors,
     so auto cards flow around them no matter the input order. */
  for (const card of cards) {
    if (!card.pinned) continue;
    const spot = { x: card.x, y: card.y };
    result.set(card.id, spot);
    placed.push({ x: spot.x, y: spot.y, w: card.w, h: card.h });
  }

  const order = cards
    .filter((card) => !card.pinned)
    .sort((a, b) => a.y - b.y || a.x - b.x || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const card of order) {
    const spot = findSlot(card, placed, obstacles);
    result.set(card.id, spot);
    placed.push({ x: spot.x, y: spot.y, w: card.w, h: card.h });
  }
  return result;
}
