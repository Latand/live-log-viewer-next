import { describe, expect, test } from "bun:test";

import { caretAtEnd, clampHeight, keyboardInset, shouldPin, visibleViewportHeight } from "./composerScroll";

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

describe("visibleViewportHeight — the keyboard-aware layout budget (#983)", () => {
  test("no visualViewport falls back to the layout viewport", () => {
    expect(visibleViewportHeight(800, null)).toBe(800);
    expect(visibleViewportHeight(800, undefined)).toBe(800);
  });

  test("an open keyboard (iOS: layout viewport unchanged) shrinks the budget", () => {
    expect(visibleViewportHeight(800, { height: 400, scale: 1 })).toBe(400);
  });

  test("pinch zoom cancels out: scale restores the layout-px measure", () => {
    expect(visibleViewportHeight(800, { height: 400, scale: 2 })).toBe(800);
  });

  test("rounding noise never exceeds the layout viewport", () => {
    expect(visibleViewportHeight(800, { height: 400.4, scale: 2 })).toBe(800);
  });
});

describe("keyboardInset — the keyboard's overlap with a 100dvh surface (#983)", () => {
  test("the iOS keyboard's slice of the layout viewport", () => {
    expect(keyboardInset(800, { height: 448, scale: 1 })).toBe(352);
  });

  test("zero when the viewports agree (keyboard closed, or resizes-content honored)", () => {
    expect(keyboardInset(800, { height: 800, scale: 1 })).toBe(0);
    expect(keyboardInset(391, { height: 391, scale: 1 })).toBe(0);
  });

  test("zero without visualViewport and never negative", () => {
    expect(keyboardInset(800, null)).toBe(0);
    expect(keyboardInset(800, { height: 801, scale: 1 })).toBe(0);
  });
});
