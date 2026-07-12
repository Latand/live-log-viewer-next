import { expect, test } from "bun:test";

import type { FeedEntry } from "./parse";
import { speakableAnswer } from "./speakableAnswer";

test("combines the contiguous prose fragments of one assistant answer", () => {
  const entries: FeedEntry[] = [
    { anchorKey: null, key: "a", item: { kind: "prose", ts: "same", engine: "codex", text: "First." } },
    { anchorKey: null, key: "b", item: { kind: "prose", ts: "same", engine: "codex", text: "Second." } },
    { anchorKey: null, key: "c", item: { kind: "raw", text: "tool", err: false } },
    { anchorKey: null, key: "d", item: { kind: "prose", ts: "same", engine: "codex", text: "Later." } },
  ];
  expect(speakableAnswer(entries, 1)).toEqual({ text: "First.\n\nSecond.", firstIndex: 0, lastIndex: 1 });
  expect(speakableAnswer(entries, 3)?.text).toBe("Later.");
});
