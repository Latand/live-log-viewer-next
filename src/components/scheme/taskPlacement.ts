import type { BoardTask } from "@/lib/tasks/types";
import { AUTO_LATTICE_MAX_Y, AUTO_LATTICE_X, isAutoTaskSeed } from "@/lib/tasks/lattice";

import type { SchemeRect } from "./layout";
import { TASK_W, taskCardHeight } from "./taskGeometry";

/* Minimum clear gap between a task card and any card or pane it is nudged
   away from — the board reads as sticky notes, so a small breathing gutter is
   enough to keep every card and its dashed edge legible. */
export const TASK_GUTTER = 16;

/** Maximum local display displacement from a durable auto seed. */
export const MAX_AUTO_DRIFT = 1_200;
/** Saturated local searches append to this deterministic grid. */
export const AUTO_OVERFLOW_Y = AUTO_LATTICE_MAX_Y + 320;
const AUTO_OVERFLOW_COLUMNS = 12;
const AUTO_OVERFLOW_ROW_STEP = 640;
const AUTO_OVERFLOW_LIMIT = 4_096;

/** Everything the placement pass needs from a task — kept structural so the
    module tests with plain literals; no full BoardTask fixtures are needed. Only
    placed cards reach the pass (the board filters `unplaced` first), so `pos` is
    required here even though it is optional on `BoardTask`. */
export type PlaceableTask = Pick<BoardTask, "id" | "text" | "assignments" | "source" | "createdAt"> & { pos: { x: number; y: number } };

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

/* Deterministic outward spiral constrained by MAX_AUTO_DRIFT on both axes. */
function spiralOffsets(stepX: number, stepY: number): ReadonlyArray<readonly [number, number]> {
  const out: Array<readonly [number, number]> = [];
  const maxX = Math.floor(MAX_AUTO_DRIFT / stepX);
  const maxY = Math.floor(MAX_AUTO_DRIFT / stepY);
  const maxRing = Math.max(maxX, maxY);
  for (let r = 1; r <= maxRing; r++) {
    for (let dy = r; dy >= -r; dy--) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        if (Math.abs(dx) > maxX || Math.abs(dy) > maxY) continue;
        out.push([dx, dy]);
      }
    }
  }
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

  for (const [dx, dy] of spiralOffsets(stepX, stepY)) {
    const x = Math.round(card.x + dx * stepX);
    const y = Math.round(card.y + dy * stepY);
    const candidate: SchemeRect = { x, y, w: card.w, h: card.h };
    if (clashesAny(candidate, placedCards, TASK_GUTTER)) continue;
    if (!clashesAny(candidate, obstacles, TASK_GUTTER)) return { x, y };
    if (!cardClearFallback) cardClearFallback = { x, y };
  }

  /* Local shelf saturated: append below it in a compact, deterministic grid.
     The candidate scan still clears every card and prefers obstacle clearance;
     stored seeds remain untouched because this result is render-only. */
  for (let index = 0; index < AUTO_OVERFLOW_LIMIT; index += 1) {
    const col = index % AUTO_OVERFLOW_COLUMNS;
    const row = Math.floor(index / AUTO_OVERFLOW_COLUMNS);
    const x = AUTO_LATTICE_X + col * stepX;
    const y = AUTO_OVERFLOW_Y + row * AUTO_OVERFLOW_ROW_STEP;
    const candidate: SchemeRect = { x, y, w: card.w, h: card.h };
    if (clashesAny(candidate, placedCards, TASK_GUTTER)) continue;
    if (!clashesAny(candidate, obstacles, TASK_GUTTER)) return { x, y };
    if (!cardClearFallback) cardClearFallback = { x, y };
  }

  return cardClearFallback ?? { x: card.x, y: card.y };
}

/* The autoPos lattice both curator.ts and inboxScanner.ts write: x ∈ {740, 1040}
   (740 + (i%2)·300), y = 120 + k·120. A sourced card still resting on it was
   never moved by a human and is fair game to spread; anything nudged off it reads
   as a deliberate placement and is held. */
/**
 * Is this card the pass's to move? Only auto-captured curator/inbox cards still
 * resting on their lattice seed are. Everything else — a card placed with the
 * «task» tool (no `source`), or a curator card a human has since dragged off the
 * lattice — is a deliberate placement and is held exactly where it sits, even
 * atop a pane. A user drag lands a `pinned` placement and (all but pixel-exactly)
 * moves the card off the lattice, so `source` + lattice cleanly separates the two.
 */
export function isAutoPlaceable(task: PlaceableTask): boolean {
  if (!task.source) return false;
  return isAutoTaskSeed(task.pos);
}

/**
 * Collision-aware placement for the board's task cards (issue #17). Cards piled
 * at the same auto-position — the curator/inbox lattice packs them 120px apart
 * while a card runs well over that tall — are spread into non-overlapping slots
 * so their text and dashed edges stay readable, and an auto card that lands on a
 * pane is nudged into the gap beside it.
 *
 * Pure and deterministic: the result depends only on card geometry, each card's
 * classification (see {@link isAutoPlaceable}), and the pane obstacles, never on
 * input order. A held card — pinned, hand-created, or a legacy card off the
 * lattice — keeps its exact coordinates untouched and anchors the pass as an
 * immovable obstacle, so hand-arranged boards pass through unchanged. An auto
 * card keeps its stored spot only while it clears every other card and every
 * pane; otherwise it relocates. Auto cards settle in creation order (oldest
 * first, id as the final tiebreak), so the oldest card of a pileup holds the
 * anchor and each new one flows around those already there — adding a task can
 * never reshuffle the cards that predate it.
 */
export function resolveTaskPlacements(tasks: readonly PlaceableTask[], obstacles: readonly SchemeRect[]): Map<string, { x: number; y: number }> {
  const cards = tasks.map((task) => ({
    id: task.id,
    createdAt: task.createdAt,
    x: task.pos.x,
    y: task.pos.y,
    w: TASK_W,
    h: taskCardHeight(task),
    auto: isAutoPlaceable(task),
  }));

  const placed: SchemeRect[] = [];
  const result = new Map<string, { x: number; y: number }>();
  /* Held cards land first at their exact spot and join `placed` as anchors, so
     auto cards flow around them no matter the input order. */
  for (const card of cards) {
    if (card.auto) continue;
    const spot = { x: card.x, y: card.y };
    result.set(card.id, spot);
    placed.push({ x: spot.x, y: spot.y, w: card.w, h: card.h });
  }

  const order = cards
    .filter((card) => card.auto)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const card of order) {
    const spot = findSlot(card, placed, obstacles);
    result.set(card.id, spot);
    placed.push({ x: spot.x, y: spot.y, w: card.w, h: card.h });
  }
  return result;
}
