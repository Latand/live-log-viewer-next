import { describe, expect, test } from "bun:test";

import {
  BOARD_HISTORY_LIMIT,
  canRedo,
  canUndo,
  emptyHistory,
  parseHistory,
  peekRedo,
  peekUndo,
  recordAction,
  stepBack,
  stepForward,
  type BoardActionHistoryV1,
  type BoardHistoryEntry,
} from "./history";

const close = (path: string, title = path): BoardHistoryEntry => ({ kind: "close", path, title });

describe("board action history reducer", () => {
  test("empty history has nothing to undo or redo", () => {
    const h = emptyHistory();
    expect(canUndo(h)).toBe(false);
    expect(canRedo(h)).toBe(false);
    expect(peekUndo(h)).toBeNull();
    expect(peekRedo(h)).toBeNull();
  });

  test("recording an action makes it undoable, not redoable", () => {
    const h = recordAction(emptyHistory(), close("a.jsonl", "Alpha"));
    expect(canUndo(h)).toBe(true);
    expect(canRedo(h)).toBe(false);
    expect(peekUndo(h)).toEqual(close("a.jsonl", "Alpha"));
  });

  test("undo then redo round-trips the same entry and cursor", () => {
    const recorded = recordAction(emptyHistory(), close("a.jsonl"));
    const back = stepBack(recorded);
    expect(back.entry).toEqual(close("a.jsonl"));
    expect(canUndo(back.history)).toBe(false);
    expect(canRedo(back.history)).toBe(true);
    expect(peekRedo(back.history)).toEqual(close("a.jsonl"));

    const forward = stepForward(back.history);
    expect(forward.entry).toEqual(close("a.jsonl"));
    expect(forward.history).toEqual(recorded);
  });

  test("stepping past an edge is a no-op with a null entry", () => {
    const empty = emptyHistory();
    expect(stepBack(empty)).toEqual({ history: empty, entry: null });
    expect(stepForward(empty)).toEqual({ history: empty, entry: null });
  });

  test("recording after an undo discards the redo branch", () => {
    let h = recordAction(emptyHistory(), close("a.jsonl"));
    h = recordAction(h, close("b.jsonl"));
    h = stepBack(h).history; // b undone, cursor at 1
    expect(canRedo(h)).toBe(true);
    h = recordAction(h, close("c.jsonl")); // forks a new future
    expect(canRedo(h)).toBe(false);
    expect(h.entries.map((e) => e.path)).toEqual(["a.jsonl", "c.jsonl"]);
    expect(h.cursor).toBe(2);
  });

  test("history is bounded, dropping the oldest entries", () => {
    let h = emptyHistory();
    for (let i = 0; i < BOARD_HISTORY_LIMIT + 10; i += 1) h = recordAction(h, close(`c${i}.jsonl`));
    expect(h.entries.length).toBe(BOARD_HISTORY_LIMIT);
    expect(h.cursor).toBe(BOARD_HISTORY_LIMIT);
    expect(h.entries[0]!.path).toBe("c10.jsonl");
    expect(h.entries.at(-1)!.path).toBe(`c${BOARD_HISTORY_LIMIT + 9}.jsonl`);
  });

  test("multi-step undo walks back through the log in order", () => {
    let h = emptyHistory();
    h = recordAction(h, close("a.jsonl"));
    h = recordAction(h, close("b.jsonl"));
    h = recordAction(h, close("c.jsonl"));
    const first = stepBack(h);
    expect(first.entry!.path).toBe("c.jsonl");
    const second = stepBack(first.history);
    expect(second.entry!.path).toBe("b.jsonl");
    const third = stepBack(second.history);
    expect(third.entry!.path).toBe("a.jsonl");
    expect(canUndo(third.history)).toBe(false);
  });
});

describe("parseHistory", () => {
  test("round-trips a valid serialized log", () => {
    const h: BoardActionHistoryV1 = { entries: [close("a.jsonl", "Alpha")], cursor: 1 };
    expect(parseHistory(JSON.parse(JSON.stringify(h)))).toEqual(h);
  });

  test("non-objects and malformed shapes reset to empty", () => {
    expect(parseHistory(null)).toEqual(emptyHistory());
    expect(parseHistory("nope")).toEqual(emptyHistory());
    expect(parseHistory({ entries: "x", cursor: 0 })).toEqual(emptyHistory());
    expect(parseHistory({ entries: [{ kind: "move" }], cursor: 1 })).toEqual(emptyHistory());
    expect(parseHistory({ entries: [{ kind: "close", path: 1, title: "" }], cursor: 1 })).toEqual(emptyHistory());
  });

  test("an out-of-range cursor is clamped into the entries", () => {
    expect(parseHistory({ entries: [close("a.jsonl")], cursor: 9 })).toEqual({ entries: [close("a.jsonl")], cursor: 1 });
    expect(parseHistory({ entries: [close("a.jsonl")], cursor: -3 })).toEqual({ entries: [close("a.jsonl")], cursor: 0 });
  });
});
