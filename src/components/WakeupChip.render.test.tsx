import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { PendingWakeup } from "@/lib/types";

import { WakeupChip } from "./WakeupChip";

test("renders a compact countdown as a focusable button carrying the reason", () => {
  const wakeup: PendingWakeup = { fireAt: Date.now() + 12 * 60 * 1000, reason: "Fallback poll" };
  const html = renderToStaticMarkup(<WakeupChip wakeup={wakeup} />);
  expect(html).toContain("data-wakeup");
  expect(html).toContain("min");
  // Interactive by default: a real button that carries the reason for tap/hover.
  expect(html).toContain("<button");
  expect(html).toContain("Fallback poll");
  expect(html).toContain("aria-expanded");
});

test("the passive variant is a non-interactive, aria-hidden visual chip", () => {
  const wakeup: PendingWakeup = { fireAt: Date.now() + 12 * 60 * 1000, reason: "r" };
  const html = renderToStaticMarkup(<WakeupChip wakeup={wakeup} interactive={false} />);
  expect(html).toContain("data-wakeup");
  expect(html).toContain("min");
  // No button and no focus target in an always-hidden host (far-zoom label).
  expect(html).not.toContain("<button");
  expect(html).toContain("aria-hidden");
});

test("renders nothing once the fire time has passed", () => {
  const wakeup: PendingWakeup = { fireAt: Date.now() - 60_000, reason: "r" };
  expect(renderToStaticMarkup(<WakeupChip wakeup={wakeup} />)).toBe("");
});

test("renders nothing when there is no wakeup", () => {
  expect(renderToStaticMarkup(<WakeupChip wakeup={null} />)).toBe("");
});
