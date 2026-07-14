"use client";

import { useEffect, useState } from "react";

import {
  canRedo as historyCanRedo,
  canUndo as historyCanUndo,
  emptyHistory,
  parseHistory,
  peekRedo,
  peekUndo,
  recordAction,
  stepBack,
  stepForward,
  type BoardActionHistoryV1,
  type BoardHistoryEntry,
} from "@/lib/board/history";

/* Per-project, per-browser log. The board arrangement itself moved to the
   shared server store (#38), but the undo/redo log stays client-side (issue
   #184): it is a personal, device-local trail of *this* user's recent actions,
   not durable board membership. localStorage keeps it across reloads. */
const storageKey = (project: string) => `llvBoardHistory:${project}`;

function readStorage(project: string): BoardActionHistoryV1 {
  if (typeof window === "undefined") return emptyHistory();
  try {
    const raw = window.localStorage.getItem(storageKey(project));
    return raw ? parseHistory(JSON.parse(raw)) : emptyHistory();
  } catch {
    return emptyHistory();
  }
}

function writeStorage(project: string, history: BoardActionHistoryV1): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey(project), JSON.stringify(history));
  } catch {
    /* private mode / quota: the log still works for this session, just not persisted */
  }
}

export interface BoardActionHistory {
  canUndo: boolean;
  canRedo: boolean;
  /** The entry the next undo would reverse (last close), or null at the edge. */
  undoEntry: BoardHistoryEntry | null;
  /** The entry the next redo would re-apply, or null at the edge. */
  redoEntry: BoardHistoryEntry | null;
  /** Append a freshly performed action, forking a new future. */
  record(entry: BoardHistoryEntry): void;
  /** Step back one action; returns the undone entry for the caller to reverse. */
  undo(): BoardHistoryEntry | null;
  /** Step forward one action; returns the redone entry to re-apply. */
  redo(): BoardHistoryEntry | null;
}

/**
 * React binding over the pure history reducer. Holds one log per project in
 * component state, seeded from localStorage and persisted on every change.
 * `project === null` (overview) has no board, so the log is inert.
 *
 * `record`/`undo`/`redo` operate on the current render's snapshot and are
 * re-created each render; callers that need a stable handle (a global key
 * listener) capture the latest through their own ref, so nothing here goes
 * stale.
 */
export function useBoardActionHistory(project: string | null): BoardActionHistory {
  const [history, setHistory] = useState<BoardActionHistoryV1>(emptyHistory);

  /* Reload the log whenever the active project changes — the arrangement it
     mirrors is per-project (like useBoardState's own per-project store). */
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- syncing to the per-project localStorage log
    setHistory(project === null ? emptyHistory() : readStorage(project));
  }, [project]);

  const commit = (next: BoardActionHistoryV1) => {
    setHistory(next);
    if (project !== null) writeStorage(project, next);
  };

  const record = (entry: BoardHistoryEntry) => {
    if (project !== null) commit(recordAction(history, entry));
  };

  const undo = (): BoardHistoryEntry | null => {
    const { history: next, entry } = stepBack(history);
    if (entry !== null) commit(next);
    return entry;
  };

  const redo = (): BoardHistoryEntry | null => {
    const { history: next, entry } = stepForward(history);
    if (entry !== null) commit(next);
    return entry;
  };

  return {
    canUndo: historyCanUndo(history),
    canRedo: historyCanRedo(history),
    undoEntry: peekUndo(history),
    redoEntry: peekRedo(history),
    record,
    undo,
    redo,
  };
}
