/**
 * Board action history — a bounded, generic undo/redo log for reversible board
 * actions. v1 records conversation-card closes so an accidental close can be
 * undone (the card reopens through the existing restore path). The entry union
 * is discriminated on `kind` so later reversible actions (move, collapse, pin,
 * task edits) can join the log without migrating persisted state or reshaping
 * this reducer.
 *
 * The log is a single array with a `cursor`: entries in `[0, cursor)` are
 * applied (undoable), entries in `[cursor, length)` were undone and can be
 * redone. Recording a fresh action drops the redo branch, mirroring every
 * editor's undo stack.
 */

export type BoardHistoryEntry = {
  kind: "close";
  /** Absolute conversation path the close/restore acts on. */
  path: string;
  /** Conversation title captured at close time, for the button tooltip. May be
      empty when the title was unknown. */
  title: string;
};

export interface BoardActionHistoryV1 {
  entries: BoardHistoryEntry[];
  /** Count of applied entries: `[0, cursor)` undoable, `[cursor, len)` redoable. */
  cursor: number;
}

/** Bounded so the persisted log never grows without limit (issue #184). */
export const BOARD_HISTORY_LIMIT = 50;

export function emptyHistory(): BoardActionHistoryV1 {
  return { entries: [], cursor: 0 };
}

export function canUndo(history: BoardActionHistoryV1): boolean {
  return history.cursor > 0;
}

export function canRedo(history: BoardActionHistoryV1): boolean {
  return history.cursor < history.entries.length;
}

/** The entry an undo would act on (the last applied action), or null. */
export function peekUndo(history: BoardActionHistoryV1): BoardHistoryEntry | null {
  return canUndo(history) ? history.entries[history.cursor - 1]! : null;
}

/** The entry a redo would re-apply (the first undone action), or null. */
export function peekRedo(history: BoardActionHistoryV1): BoardHistoryEntry | null {
  return canRedo(history) ? history.entries[history.cursor]! : null;
}

/**
 * Append a freshly performed action. Any undone tail is discarded first — a new
 * action forks a new future — then the log is trimmed from the oldest end to the
 * bound. The cursor always ends at the top, so the new action is immediately
 * undoable and nothing is redoable.
 */
export function recordAction(history: BoardActionHistoryV1, entry: BoardHistoryEntry): BoardActionHistoryV1 {
  const applied = history.entries.slice(0, history.cursor);
  const grown = [...applied, entry];
  const overflow = Math.max(0, grown.length - BOARD_HISTORY_LIMIT);
  const entries = overflow ? grown.slice(overflow) : grown;
  return { entries, cursor: entries.length };
}

/** Step back one action. Returns the undone entry (to be reversed by the caller)
    and the new history, or the same history with a null entry at the edge. */
export function stepBack(
  history: BoardActionHistoryV1,
): { history: BoardActionHistoryV1; entry: BoardHistoryEntry | null } {
  if (!canUndo(history)) return { history, entry: null };
  const entry = history.entries[history.cursor - 1]!;
  return { history: { entries: history.entries, cursor: history.cursor - 1 }, entry };
}

/** Step forward one action. Returns the redone entry (to be re-applied by the
    caller) and the new history, or the same history with a null entry. */
export function stepForward(
  history: BoardActionHistoryV1,
): { history: BoardActionHistoryV1; entry: BoardHistoryEntry | null } {
  if (!canRedo(history)) return { history, entry: null };
  const entry = history.entries[history.cursor]!;
  return { history: { entries: history.entries, cursor: history.cursor + 1 }, entry };
}

function isEntry(value: unknown): value is BoardHistoryEntry {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return record.kind === "close" && typeof record.path === "string" && typeof record.title === "string";
}

/**
 * Parse a persisted log defensively: a corrupt or foreign blob (old schema, a
 * hand-edited value, a cursor out of range) resets to empty rather than throwing
 * into render. Unknown entry kinds are dropped so a log written by a newer build
 * degrades instead of crashing an older one.
 */
export function parseHistory(raw: unknown): BoardActionHistoryV1 {
  if (typeof raw !== "object" || raw === null) return emptyHistory();
  const record = raw as Record<string, unknown>;
  if (!Array.isArray(record.entries) || typeof record.cursor !== "number") return emptyHistory();
  const entries = record.entries.filter(isEntry);
  if (entries.length !== record.entries.length) return emptyHistory();
  const cursor = Number.isInteger(record.cursor) ? Math.min(Math.max(0, record.cursor), entries.length) : entries.length;
  return { entries, cursor };
}
