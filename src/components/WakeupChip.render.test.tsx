import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { PendingWakeup } from "@/lib/types";

import { WakeupChip } from "./WakeupChip";

test("renders a compact countdown for a pending wakeup", () => {
  const wakeup: PendingWakeup = { fireAt: Date.now() + 12 * 60 * 1000, reason: "Fallback poll" };
  const html = renderToStaticMarkup(<WakeupChip wakeup={wakeup} />);
  expect(html).toContain("data-wakeup");
  expect(html).toContain("min");
});

test("renders nothing once the fire time has passed", () => {
  const wakeup: PendingWakeup = { fireAt: Date.now() - 60_000, reason: "r" };
  expect(renderToStaticMarkup(<WakeupChip wakeup={wakeup} />)).toBe("");
});

test("renders nothing when there is no wakeup", () => {
  expect(renderToStaticMarkup(<WakeupChip wakeup={null} />)).toBe("");
});
