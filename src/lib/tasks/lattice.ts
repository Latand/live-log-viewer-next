/**
 * Bounded shelf used by curator/inbox task capture. The durable position is a
 * seed only: board placement may move the rendered card around obstacles.
 * Freed seeds are reused, and additional capacity grows sideways in column
 * pairs so a long task history cannot stretch the world downward forever.
 */
export const AUTO_LATTICE_X = 740;
export const AUTO_LATTICE_Y = 120;
export const AUTO_LATTICE_COLUMN_STEP = 300;
export const AUTO_LATTICE_ROW_STEP = 120;
export const AUTO_LATTICE_ROWS = 24;
const AUTO_LATTICE_PAIR_SIZE = AUTO_LATTICE_ROWS * 2;

export const AUTO_LATTICE_MAX_Y = AUTO_LATTICE_Y + (AUTO_LATTICE_ROWS - 1) * AUTO_LATTICE_ROW_STEP;

interface LatticeCard {
  source?: unknown;
  pos?: { x: number; y: number };
}

/** Slot number for a current bounded-shelf seed, or null for any other point. */
export function autoTaskSlot(pos: { x: number; y: number }): number | null {
  const col = (pos.x - AUTO_LATTICE_X) / AUTO_LATTICE_COLUMN_STEP;
  const row = (pos.y - AUTO_LATTICE_Y) / AUTO_LATTICE_ROW_STEP;
  if (!Number.isInteger(col) || col < 0 || !Number.isInteger(row) || row < 0 || row >= AUTO_LATTICE_ROWS) return null;
  const pair = Math.floor(col / 2);
  return pair * AUTO_LATTICE_PAIR_SIZE + row * 2 + (col % 2);
}

/** Position of one bounded shelf slot. */
export function autoTaskSlotPosition(slot: number): { x: number; y: number } {
  const safe = Math.max(0, Math.floor(slot));
  const pair = Math.floor(safe / AUTO_LATTICE_PAIR_SIZE);
  const within = safe % AUTO_LATTICE_PAIR_SIZE;
  const col = within % 2;
  const row = Math.floor(within / 2);
  return {
    x: AUTO_LATTICE_X + pair * AUTO_LATTICE_COLUMN_STEP * 2 + col * AUTO_LATTICE_COLUMN_STEP,
    y: AUTO_LATTICE_Y + row * AUTO_LATTICE_ROW_STEP,
  };
}

/** First unoccupied shelf seed. Cards dragged away release their former slot. */
export function autoTaskPosition(cards: readonly LatticeCard[]): { x: number; y: number } {
  const occupied = new Set<number>();
  for (const card of cards) {
    if (!card.source || !card.pos) continue;
    const slot = autoTaskSlot(card.pos);
    if (slot !== null) occupied.add(slot);
  }
  let slot = 0;
  while (occupied.has(slot)) slot += 1;
  return autoTaskSlotPosition(slot);
}

/**
 * Recognize both bounded-shelf seeds and legacy two-column seeds. Legacy rows
 * remain movable presentation inputs; their stored coordinates stay unchanged.
 */
export function isAutoTaskSeed(pos: { x: number; y: number }): boolean {
  if (autoTaskSlot(pos) !== null) return true;
  const legacyColumn = pos.x === AUTO_LATTICE_X || pos.x === AUTO_LATTICE_X + AUTO_LATTICE_COLUMN_STEP;
  const legacyRow = pos.y - AUTO_LATTICE_Y;
  return legacyColumn && legacyRow >= 0 && legacyRow % AUTO_LATTICE_ROW_STEP === 0;
}
