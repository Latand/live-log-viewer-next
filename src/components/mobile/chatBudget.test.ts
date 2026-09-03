import { expect, test } from "bun:test";

import {
  BANNER_PX,
  BAR_PX,
  COMPOSER_PX,
  KEYBOARD_PX,
  MIN_KEYBOARD_TRANSCRIPT_SHARE,
  MIN_TRANSCRIPT_SHARE,
  PERSISTENT_CHROME,
  SUGGESTED_CHIPS_PX,
  SUPERSEDED_CHROME,
  UNCOUNTED_CHROME,
  chatBudget,
} from "./chatBudget";

/*
 * Mobile v2 lane 5 (#1439) — the viewport budget of README §3.4, held to its
 * published numbers. The table says 161 px of chrome, 206 with the banner, and
 * 81% / 76% / 62% of the transcript; nothing here restates the implementation,
 * every assertion is a number a reader can find in the design document.
 */

test("the chrome band is the §3.4 total: 161 px, and 206 with the banner slot up", () => {
  expect(chatBudget({ height: 844 }).chrome).toBe(161);
  expect(chatBudget({ height: 844, banner: true }).chrome).toBe(206);
});

test("161 is the bar plus the composer unit, and nothing else is persistent", () => {
  /* Two regions, both nameable. A third row appearing in this sum is the #419
     failure returning: chrome the budget counts but the design does not have. */
  expect(Object.values(PERSISTENT_CHROME).reduce((a, b) => a + b, 0)).toBe(161);
  expect(BAR_PX + COMPOSER_PX).toBe(161);
  expect(BAR_PX + COMPOSER_PX + BANNER_PX).toBe(206);
});

test("at 390×844 the transcript keeps 81% of the viewport, and 76% under a banner", () => {
  const plain = chatBudget({ height: 844 });
  expect(plain.transcript).toBe(683);
  expect(Math.round(plain.share * 100)).toBe(81);
  expect(plain.meetsMinimum).toBe(true);

  const banner = chatBudget({ height: 844, banner: true });
  expect(banner.transcript).toBe(638);
  expect(Math.round(banner.share * 100)).toBe(76);
  expect(banner.meetsMinimum).toBe(true);
});

test("the guarantee is what the worst persistent case clears — the banner one", () => {
  /* The floor is not a wish: the banner case is the tightest chrome-closed
     screen there is, so it is what MIN_TRANSCRIPT_SHARE is set from. */
  expect(chatBudget({ height: 844, banner: true }).share).toBeGreaterThanOrEqual(MIN_TRANSCRIPT_SHARE);
  expect(MIN_TRANSCRIPT_SHARE).toBeGreaterThan(0.6);
});

test("the taller phone frame clears the same guarantee", () => {
  expect(chatBudget({ height: 932 }).meetsMinimum).toBe(true);
  expect(chatBudget({ height: 932, banner: true }).meetsMinimum).toBe(true);
});

test("keyboard open, the transcript keeps 315 px — 62% of the 508 that are visible", () => {
  const budget = chatBudget({ height: 844, chips: true, keyboard: KEYBOARD_PX });
  expect(budget.usable).toBe(508);
  expect(budget.chrome).toBe(193);
  expect(budget.transcript).toBe(315);
  expect(Math.round(budget.share * 100)).toBe(62);
  expect(budget.meetsMinimum).toBe(true);
  expect(MIN_KEYBOARD_TRANSCRIPT_SHARE).toBe(0.6);
});

test("the suggested-reply chips stay while the keyboard is open, and cost their 32 px", () => {
  const withChips = chatBudget({ height: 844, chips: true, keyboard: KEYBOARD_PX });
  const without = chatBudget({ height: 844, keyboard: KEYBOARD_PX });
  expect(without.transcript - withChips.transcript).toBe(SUGGESTED_CHIPS_PX);
});

test("each region only ever reduces the transcript, and by exactly its declared height", () => {
  const base = chatBudget({ height: 844 });
  expect(chatBudget({ height: 844, banner: true }).transcript).toBe(base.transcript - BANNER_PX);
  expect(chatBudget({ height: 844, chips: true }).transcript).toBe(base.transcript - SUGGESTED_CHIPS_PX);
  expect(chatBudget({ height: 844, keyboard: KEYBOARD_PX }).transcript).toBe(base.transcript - KEYBOARD_PX);
});

test("v2 reaches 161 from the 264 the old band budgeted, by name", () => {
  /* 264 was green while the phone showed ~440–480 of chrome, so the arithmetic
     has to account for both halves: the rows v2 removed outright, and the rows
     it merged into the composer unit. */
  const old = Object.values(SUPERSEDED_CHROME).reduce((a, b) => a + b, 0);
  expect(old).toBe(264);
  const removed = SUPERSEDED_CHROME.focusStrip + SUPERSEDED_CHROME.conversationHeader + SUPERSEDED_CHROME.composerRuntimePill;
  const merged = COMPOSER_PX - SUPERSEDED_CHROME.composerPrimary;
  expect(old - removed + merged).toBe(161);
  expect(SUPERSEDED_CHROME.shellHeader).toBe(BAR_PX);
});

test("the rows the old budget never counted are all zero in v2", () => {
  /* Each of these was on screen and outside the sum (§1.6). They are absent
     from PERSISTENT_CHROME now because the design removed the surfaces, not
     because the budget stopped looking at them. */
  expect(Object.values(UNCOUNTED_CHROME).reduce((a, b) => a + b, 0)).toBe(188);
  const band = Object.values(PERSISTENT_CHROME) as number[];
  for (const height of Object.values(UNCOUNTED_CHROME)) expect(band).not.toContain(height);
  /* The observed band the operator photographed: 264 counted plus the docked
     strip, the toast, the tray, the pill and the status bar under it. */
  expect(264 + Object.values(UNCOUNTED_CHROME).reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(440);
});

test("a degenerate viewport yields a zero share, never NaN", () => {
  const budget = chatBudget({ height: 0 });
  expect(budget.transcript).toBe(0);
  expect(budget.share).toBe(0);
  expect(budget.meetsMinimum).toBe(false);
});

test("a keyboard taller than the viewport leaves no transcript and fails the floor", () => {
  const budget = chatBudget({ height: 300, keyboard: 400 });
  expect(budget.usable).toBe(0);
  expect(budget.transcript).toBe(0);
  expect(budget.meetsMinimum).toBe(false);
});
