import { expect, test } from "bun:test";

import { tooltipPlacement } from "./TooltipBubble";

const desktop = { width: 1440, height: 900 };
const size = { width: 98, height: 23 };

test("the send hint sits above the button with its right edge on the button's", () => {
  const send = { top: 320, bottom: 352, left: 1310, right: 1348, width: 38 };
  expect(tooltipPlacement(send, size, desktop, "top", "right")).toEqual({ left: 1348 - 98, top: 320 - 6 - 23 });
});

test("a centred hint is centred over its control", () => {
  const button = { top: 400, bottom: 432, left: 600, right: 640, width: 40 };
  expect(tooltipPlacement(button, size, desktop, "top", "center")).toEqual({ left: 620 - 49, top: 371 });
});

test("with no room above it opens below instead", () => {
  const button = { top: 10, bottom: 42, left: 600, right: 640, width: 40 };
  expect(tooltipPlacement(button, size, desktop, "top", "center").top).toBe(48);
});

test("with no room below a bottom hint opens above", () => {
  const chip = { top: 860, bottom: 880, left: 20, right: 80, width: 60 };
  expect(tooltipPlacement(chip, size, desktop, "bottom", "left").top).toBe(860 - 6 - 23);
});

test("it never leaves the window sideways", () => {
  const edge = { top: 400, bottom: 432, left: 0, right: 30, width: 30 };
  expect(tooltipPlacement(edge, size, desktop, "top", "center").left).toBe(8);
  const far = { top: 400, bottom: 432, left: 1420, right: 1440, width: 20 };
  expect(tooltipPlacement(far, size, desktop, "top", "left").left).toBe(1440 - 98 - 8);
});
