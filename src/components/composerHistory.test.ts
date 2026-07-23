import { describe, expect, test } from "bun:test";

import { recallHistory } from "./composerHistory";

/* Newest first, exactly as outboxHistory yields: a queued draft ahead of two
   already-sent messages (issue #561 item 2). */
const HISTORY = ["queued draft", "second sent", "first sent"];

/** Walk a sequence of arrow presses from the own-draft position and return the
    text placed in the composer after each. */
function walk(keys: ("ArrowUp" | "ArrowDown")[], composerEmpty = true): string[] {
  let index = -1;
  let empty = composerEmpty;
  const seen: string[] = [];
  for (const key of keys) {
    const recall = recallHistory(index, key, HISTORY, empty);
    if (!recall) {
      seen.push("<none>");
      continue;
    }
    index = recall.index;
    empty = recall.text.length === 0;
    seen.push(recall.text);
  }
  return seen;
}

describe("recallHistory", () => {
  test("ArrowUp from an empty composer walks oldest-way and clamps at the last entry", () => {
    expect(walk(["ArrowUp", "ArrowUp", "ArrowUp", "ArrowUp"])).toEqual([
      "queued draft",
      "second sent",
      "first sent",
      "<none>", // clamped: no further step
    ]);
  });

  test("ArrowDown walks back toward the newest, then returns to the operator's own empty draft", () => {
    expect(walk(["ArrowUp", "ArrowUp", "ArrowDown", "ArrowDown", "ArrowDown"])).toEqual([
      "queued draft",
      "second sent",
      "queued draft",
      "", // back to the own draft
      "<none>", // already at -1: ArrowDown does nothing
    ]);
  });

  test("queued messages come before sent ones because the caller ordered them so", () => {
    /* recallHistory is order-preserving: the queue-first ordering is the model's
       (outboxHistory), and index 0 is whatever the caller put newest. */
    expect(recallHistory(-1, "ArrowUp", HISTORY, true)?.text).toBe("queued draft");
  });

  test("a non-empty composer that has not entered recall leaves the arrows as caret movement", () => {
    expect(recallHistory(-1, "ArrowUp", HISTORY, false)).toBeNull();
    expect(recallHistory(-1, "ArrowDown", HISTORY, false)).toBeNull();
  });

  test("once recall is active the arrows keep navigating even though the field is non-empty", () => {
    /* index 0 means a recalled message is showing (field non-empty); ArrowUp
       must still step to index 1 rather than falling back to caret movement. */
    expect(recallHistory(0, "ArrowUp", HISTORY, false)).toEqual({ index: 1, text: "second sent" });
  });

  test("no history means the arrows never take over", () => {
    expect(recallHistory(-1, "ArrowUp", [], true)).toBeNull();
  });
});
