import { expect, test } from "bun:test";

import { backendMenuPlacement } from "./MicButton";

const desktop = { width: 1440, height: 900 };
const phone = { width: 390, height: 844 };

test("the transcription menu opens above the microphone, right edges aligned, when it fits there", () => {
  const placement = backendMenuPlacement({ top: 800, bottom: 832, right: 1300 }, 230, desktop);
  expect(placement).toEqual({ left: 1000, bottom: 900 - 800 + 6, maxHeight: 800 - 6 - 8 });
  expect(placement.top).toBeUndefined();
});

test("near the top of the window it opens below the microphone instead", () => {
  const placement = backendMenuPlacement({ top: 90, bottom: 122, right: 1300 }, 230, desktop);
  expect(placement.bottom).toBeUndefined();
  expect(placement.top).toBe(128);
  expect(placement.maxHeight).toBe(900 - 122 - 6 - 8);
});

test("on a phone the menu never runs off the left edge", () => {
  /* The microphone sits near the left of the composer: a right-aligned 300px
     menu would start at x = -80. */
  const placement = backendMenuPlacement({ top: 780, bottom: 812, right: 220 }, 230, phone);
  expect(placement.left).toBe(8);
  expect(placement.left + 300).toBeLessThanOrEqual(phone.width - 8);
});

test("a menu taller than both sides takes the roomier side and scrolls within it", () => {
  const placement = backendMenuPlacement({ top: 300, bottom: 332, right: 380 }, 900, phone);
  expect(placement.top).toBe(338);
  expect(placement.maxHeight).toBe(844 - 332 - 6 - 8);
});
