import { expect, test } from "bun:test";

import {
  MIN_TRANSCRIPT_SHARE,
  SECONDARY_CHROME,
  chatBudget,
  type SecondaryKey,
} from "./chatBudget";

/*
 * Issue #419 — chat-first mobile viewport budget. The transcript must own at
 * least 60% of the usable viewport before the keyboard opens, at both pinned
 * phone frames, and ONLY once the secondary chrome (memory/goal chips + detailed
 * runtime controls) defaults to collapsed. These assertions are the arithmetic
 * half of the acceptance; `BranchPane.mobileChrome.dom.test.tsx` proves the DOM
 * collapses those exact surfaces by default.
 */

const ALL_SECONDARY = Object.keys(SECONDARY_CHROME) as SecondaryKey[];

test("collapsed, the transcript clears 60% at 390×844 including the home indicator", () => {
  const budget = chatBudget({ height: 844, safeBottom: 34 });
  expect(budget.share).toBeGreaterThanOrEqual(MIN_TRANSCRIPT_SHARE);
  expect(budget.meetsMinimum).toBe(true);
});

test("collapsed, the transcript clears 60% at 430×932 including the home indicator", () => {
  const budget = chatBudget({ height: 932, safeBottom: 34 });
  expect(budget.share).toBeGreaterThanOrEqual(MIN_TRANSCRIPT_SHARE);
  expect(budget.meetsMinimum).toBe(true);
});

test("collapsed clears 60% even with no safe-area inset (in-browser phone)", () => {
  expect(chatBudget({ height: 844 }).meetsMinimum).toBe(true);
  expect(chatBudget({ height: 932 }).meetsMinimum).toBe(true);
});

test("expanding every secondary disclosure drops the transcript below 60% — so collapse is load-bearing", () => {
  const budget = chatBudget({ height: 844, open: ALL_SECONDARY });
  expect(budget.share).toBeLessThan(MIN_TRANSCRIPT_SHARE);
  expect(budget.meetsMinimum).toBe(false);
});

test("each disclosure only reduces the transcript, and by exactly its declared height", () => {
  const base = chatBudget({ height: 844 });
  for (const key of ALL_SECONDARY) {
    const opened = chatBudget({ height: 844, open: [key] });
    expect(opened.transcript).toBe(base.transcript - SECONDARY_CHROME[key]);
    expect(opened.chrome).toBe(base.chrome + SECONDARY_CHROME[key]);
    expect(opened.transcript).toBeLessThan(base.transcript);
  }
});

test("the usable height excludes both safe-area insets", () => {
  expect(chatBudget({ height: 844, safeTop: 20, safeBottom: 34 }).usable).toBe(790);
});

test("a degenerate zero-height viewport yields a zero share, never NaN", () => {
  const budget = chatBudget({ height: 0 });
  expect(budget.transcript).toBe(0);
  expect(budget.share).toBe(0);
  expect(budget.meetsMinimum).toBe(false);
});
