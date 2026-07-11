import { describe, expect, test } from "bun:test";

import { verdictPlacement } from "./PipelineStrip";

const viewport = { width: 1000, height: 800 };
const content = { width: 260, height: 200 };

describe("verdictPlacement (#93 finding: popover never renders off-screen)", () => {
  test("places the popover above a mid-page chip", () => {
    const anchor = { top: 400, bottom: 424, left: 470, width: 60 };
    const p = verdictPlacement(anchor, content, viewport);
    expect(p.below).toBe(false);
    expect(p.top).toBe(392); // anchor.top - margin
    expect(p.left).toBe(500); // chip center, unclamped
  });

  test("flips below when a chip near the page header leaves no room above", () => {
    /* 24px from the top: a 200px popover cannot fit above, and below has room. */
    const anchor = { top: 24, bottom: 48, left: 470, width: 60 };
    const p = verdictPlacement(anchor, content, viewport);
    expect(p.below).toBe(true);
    expect(p.top).toBe(56); // anchor.bottom + margin
  });

  test("clamps a chip near the left edge so the box stays on-screen", () => {
    const anchor = { top: 400, bottom: 424, left: 0, width: 20 };
    const p = verdictPlacement(anchor, content, viewport);
    /* center would be 10, but half-width 130 + 8 margin forces left = 138. */
    expect(p.left).toBe(138);
  });

  test("clamps a chip near the right edge symmetrically", () => {
    const anchor = { top: 400, bottom: 424, left: 990, width: 20 };
    const p = verdictPlacement(anchor, content, viewport);
    /* center 1000 clamps to viewport.width - half - margin = 1000 - 130 - 8 = 862. */
    expect(p.left).toBe(862);
  });

  test("keeps the popover above when both sides are cramped but above has more room", () => {
    const anchor = { top: 300, bottom: 780, left: 470, width: 60 };
    const p = verdictPlacement(anchor, content, viewport);
    /* roomAbove 292 > roomBelow 12, so it stays above rather than flipping into a
       worse spot. */
    expect(p.below).toBe(false);
  });
});
