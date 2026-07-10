import { describe, expect, test } from "bun:test";

import { caretAtEnd, clampHeight, shouldPin } from "./composerScroll";

describe("clampHeight grows to fit then caps", () => {
  test("adds the 2px border allowance below the cap", () => {
    expect(clampHeight(40, 160)).toBe(42);
  });

  test("never exceeds the max height", () => {
    expect(clampHeight(500, 160)).toBe(160);
    expect(clampHeight(160, 160)).toBe(160);
  });

  test("never drops below the min height when given one", () => {
    expect(clampHeight(10, 260, 84)).toBe(84);
    expect(clampHeight(200, 260, 84)).toBe(202);
    expect(clampHeight(400, 260, 84)).toBe(260);
  });

  test("min defaults to zero (single-row composers)", () => {
    expect(clampHeight(0, 160)).toBe(2);
  });
});

describe("caretAtEnd detects an end-of-text collapsed caret", () => {
  test("true only when both selection edges sit at the length", () => {
    expect(caretAtEnd(5, 5, 5)).toBe(true);
    expect(caretAtEnd(0, 0, 0)).toBe(true);
  });

  test("false mid-text or across a selection", () => {
    expect(caretAtEnd(3, 3, 5)).toBe(false); // caret parked mid-text
    expect(caretAtEnd(0, 5, 5)).toBe(false); // a range is selected
    expect(caretAtEnd(5, 3, 5)).toBe(false);
  });
});

describe("shouldPin — keep the newest text visible only when appending", () => {
  test("live dictation pins unconditionally, even with the caret mid-text", () => {
    expect(shouldPin({ pinned: true, caretAtEnd: false })).toBe(true);
    expect(shouldPin({ pinned: true, caretAtEnd: true })).toBe(true);
  });

  test("typing pins only when the caret is at the end", () => {
    expect(shouldPin({ pinned: false, caretAtEnd: true })).toBe(true);
    expect(shouldPin({ pinned: false, caretAtEnd: false })).toBe(false);
  });
});
