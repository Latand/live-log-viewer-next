import { describe, expect, test } from "bun:test";

import { speakMenuPlacement } from "./SpeakMenu";

/* Issue #1024: the read-aloud menu used to be an inline `absolute` popover —
   clipped by the message it belonged to and painted under the next message.
   It is a fixed body portal now, so nothing clips it; these are the rules that
   keep it inside the viewport once it is free of the feed. */
describe("speakMenuPlacement (#1024: the menu is never clipped)", () => {
  const viewport = { width: 1200, height: 800 };
  const menu = { width: 300, height: 260 };

  test("hangs below the trigger, right edges aligned", () => {
    const place = speakMenuPlacement({ top: 100, bottom: 124, right: 900 }, menu, viewport);
    expect(place).toEqual({ left: 600, top: 132 });
  });

  test("flips above a trigger with no room under it", () => {
    /* 40px of viewport left below the button, 700 above: the menu goes up. */
    const place = speakMenuPlacement({ top: 736, bottom: 760, right: 900 }, menu, viewport);
    expect(place.top).toBe(468);
    expect(place.top + menu.height).toBeLessThanOrEqual(736);
  });

  test("stays below when neither side fits, clamped whole into the viewport", () => {
    const tall = { width: 300, height: 780 };
    const place = speakMenuPlacement({ top: 300, bottom: 324, right: 900 }, tall, viewport);
    expect(place.top).toBe(12);
    expect(place.top + tall.height).toBeLessThanOrEqual(viewport.height - 8);
  });

  /* #1030: the flip branch carried only a lower bound, so a trigger scrolled
     far below the fold — the `scroll` re-measure keeps an open menu on it —
     placed the menu below the fold with it, off screen entirely. */
  test("clamps a flip against the bottom edge when the trigger is below the fold", () => {
    const place = speakMenuPlacement({ top: 5000, bottom: 5024, right: 900 }, menu, viewport);
    expect(place.top).toBe(532);
    expect(place.top + menu.height).toBeLessThanOrEqual(viewport.height - 8);
  });

  test("clamps against the right edge instead of spilling off it", () => {
    const place = speakMenuPlacement({ top: 100, bottom: 124, right: 1198 }, menu, viewport);
    expect(place.left).toBe(892);
    expect(place.left + menu.width).toBeLessThanOrEqual(viewport.width - 8);
  });

  test("clamps against the left edge for a trigger in a narrow column", () => {
    const place = speakMenuPlacement({ top: 100, bottom: 124, right: 120 }, menu, { width: 390, height: 800 });
    expect(place.left).toBe(8);
  });
});
