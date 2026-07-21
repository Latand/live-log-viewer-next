import { describe, expect, test } from "bun:test";

import { KEEPOUT_CLEARANCE_PX } from "@/components/scheme/offscreenClusters";

import { SUBAGENT_RAIL_MIN_BOTTOM_PX, subagentRailBottom } from "./subagentRailLift";

/* Issue #474 follow-up: the phone's side agent rail (and every reveal it can
   expand) must sit strictly above the composer/input/Send bounds, with the same
   stable clearance gutter the board reserves around keep-out chrome — however
   tall the composer grows (multiline drafts reach min(38dvh, 20rem)). */
describe("subagentRailBottom", () => {
  test("without a composer the rail rests at its minimum offset", () => {
    expect(subagentRailBottom(800, null)).toBe(SUBAGENT_RAIL_MIN_BOTTOM_PX);
  });

  test("a composer taller than the resting offset lifts the rail above it, clearance included", () => {
    /* Pane area bottom at 800, composer top at 640 → the composer occupies the
       bottom 160px; the rail's lowest badge must clear it by the gutter. */
    expect(subagentRailBottom(800, 640)).toBe(160 + KEEPOUT_CLEARANCE_PX);
    expect(subagentRailBottom(800, 640)).toBeGreaterThan(SUBAGENT_RAIL_MIN_BOTTOM_PX);
  });

  test("a short composer never pulls the rail below its resting minimum", () => {
    /* Composer occupies the bottom 50px; 50 + clearance < the resting offset,
       so the rail stays put — no downward layout jump toward the input. */
    expect(subagentRailBottom(800, 750)).toBe(SUBAGENT_RAIL_MIN_BOTTOM_PX);
  });

  test("degenerate measurements fall back to the resting minimum", () => {
    expect(subagentRailBottom(0, 0)).toBe(SUBAGENT_RAIL_MIN_BOTTOM_PX);
    expect(subagentRailBottom(800, Number.NaN)).toBe(SUBAGENT_RAIL_MIN_BOTTOM_PX);
    expect(subagentRailBottom(Number.NaN, 640)).toBe(SUBAGENT_RAIL_MIN_BOTTOM_PX);
  });

  test("fractional measurements round up so the clearance is never undercut", () => {
    expect(subagentRailBottom(800.4, 640.9)).toBe(Math.ceil(800.4 - 640.9) + KEEPOUT_CLEARANCE_PX);
  });
});
