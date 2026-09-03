import { describe, expect, test } from "bun:test";

import {
  caretAtEnd,
  clampHeight,
  keyboardInset,
  MOBILE_COMPOSER_CHROME_PX,
  MOBILE_COMPOSER_UNIT_CHROME_PX,
  mobileComposerCeiling,
  mobileComposerUnitMax,
  shouldPin,
  visibleViewportHeight,
} from "./composerScroll";

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

describe("mobileComposerCeiling — the phone grow ceiling against the visible viewport (#983, #1483)", () => {
  test("a full portrait viewport grows to what the composer box can show", () => {
    /* #983 read this as a flat 40% of the visible viewport (320px at 800).
       That share ignored the box the field lives in: 320 + the unit's own
       chrome overflows the composer's `max-h-[min(38dvh,20rem)]`, and the
       overflow is the tools row. The field takes the box's budget instead. */
    expect(mobileComposerCeiling(800, 800)).toBe(mobileComposerUnitMax(800) - MOBILE_COMPOSER_UNIT_CHROME_PX);
    expect(mobileComposerCeiling(800, 800)).toBe(239);
  });

  test("a portrait keyboard-open viewport holds the 160px cap — the chrome still fits", () => {
    expect(mobileComposerCeiling(400, 800)).toBe(160);
    expect(160 + MOBILE_COMPOSER_CHROME_PX).toBeLessThanOrEqual(400);
  });

  test("the 40% grow rule still governs the range between the cap and the box budget", () => {
    /* 390×844 and 430×932 with the keyboard up: 40% of what the operator can
       see, unchanged by #1483 — the box has room for it. */
    expect(mobileComposerCeiling(508, 844)).toBe(203);
    expect(mobileComposerCeiling(596, 932)).toBe(238);
  });

  test("a rotated keyboard-open viewport yields below 160px to keep the chrome visible (round 2)", () => {
    /* Landscape: the layout viewport is 390px tall, so the composer box's own
       38dvh cap is the tighter of the two bounds and the field yields to it. */
    expect(mobileComposerCeiling(280, 390)).toBe(mobileComposerUnitMax(390) - MOBILE_COMPOSER_UNIT_CHROME_PX);
    expect(mobileComposerCeiling(280, 390)).toBe(83);
    expect(mobileComposerCeiling(240, 390)).toBe(83);
  });

  test("a visible viewport too short for the box budget yields to the keyboard instead", () => {
    /* Below ~200px visible the bar plus the unit's chrome is what binds, and
       the field gives up the difference. */
    expect(mobileComposerCeiling(180, 390)).toBe(180 - MOBILE_COMPOSER_CHROME_PX);
  });

  test("never collapses below one 44px tap-target row", () => {
    /* The one case that outranks the reachability arithmetic below: on a
       viewport this small no field height keeps the tools row in view, and a
       0px field would be worse than an overflowing one. */
    expect(mobileComposerCeiling(150, 390)).toBe(44);
    expect(mobileComposerCeiling(0, 0)).toBe(44);
  });
});

/*
 * Issue #1483 — dictation must never push Stop out of reach. The mobile v2
 * composer is ONE box: the field on top and the tools row (chip · attach ·
 * dictate · send slot) under it, inside the same border, inside a form whose
 * own `max-h-[min(38dvh,20rem)]` scrolls what it cannot show. So the ceiling
 * has two bounds to respect at once, and the operator loses Stop when either
 * is broken: the field must fit its own box beside the tools row, AND the
 * whole unit must fit the visible area under the bar.
 */
describe("mobileComposerCeiling — the grown field never pushes its own tools row out of reach (#1483)", () => {
  const PHONES = [
    { name: "390×844 portrait, keyboard closed (dictating)", visible: 844, layout: 844 },
    { name: "390×844 portrait, keyboard open", visible: 508, layout: 844 },
    { name: "430×932 portrait, keyboard closed (dictating)", visible: 932, layout: 932 },
    { name: "430×932 portrait, keyboard open", visible: 596, layout: 932 },
    { name: "375×667 portrait, keyboard closed", visible: 667, layout: 667 },
    { name: "375×667 portrait, keyboard open", visible: 331, layout: 667 },
    { name: "844×390 landscape, keyboard closed", visible: 390, layout: 390 },
    { name: "844×390 landscape, keyboard open", visible: 280, layout: 390 },
  ];

  for (const phone of PHONES) {
    test(`${phone.name}: the tools row stays inside the box and above the keyboard`, () => {
      const field = mobileComposerCeiling(phone.visible, phone.layout);
      /* Inside the composer's own scroll box: past this the FORM scrolls, and
         reaching Stop costs a scroll that the next dictated chunk undoes. */
      expect(field + MOBILE_COMPOSER_UNIT_CHROME_PX).toBeLessThanOrEqual(mobileComposerUnitMax(phone.layout));
      /* Inside what the operator can see, under the one bar. */
      expect(field + MOBILE_COMPOSER_CHROME_PX).toBeLessThanOrEqual(phone.visible);
      /* Still a comfortable multi-line input: at 22px leading, four rows. */
      expect(field).toBeGreaterThanOrEqual(83);
    });
  }

  test("the reserve is the chrome the phone actually renders: the bar plus the unit's own", () => {
    /* 52 (the one bar) + 65 (tools row 44, box padding and border 8, form
       padding and top border 13). The #983 number reserved 156 for a docked
       focus strip, a separate conversation header and a picker row under the
       input, and mobile v2 renders none of those. */
    expect(MOBILE_COMPOSER_UNIT_CHROME_PX).toBe(65);
    expect(MOBILE_COMPOSER_CHROME_PX).toBe(52 + MOBILE_COMPOSER_UNIT_CHROME_PX);
  });

  test("the box budget follows the form's own max-height, in layout px", () => {
    /* `min(38dvh, 20rem)`. `dvh` ignores the on-screen keyboard, so the budget
       reads the LAYOUT viewport and an open keyboard never shrinks it. */
    expect(mobileComposerUnitMax(844)).toBe(320);
    expect(mobileComposerUnitMax(932)).toBe(320);
    expect(mobileComposerUnitMax(667)).toBe(253);
    expect(mobileComposerUnitMax(390)).toBe(148);
  });

  test("the field still grows past the desktop cap wherever the box has room", () => {
    /* The point of the phone ceiling (#177 item 3) survives: a portrait phone
       opens the field well past the shared 160px cap. */
    expect(mobileComposerCeiling(844, 844)).toBeGreaterThan(160);
    expect(mobileComposerCeiling(932, 932)).toBeGreaterThan(160);
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
