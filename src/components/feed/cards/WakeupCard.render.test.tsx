import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { ToolEvent } from "../parse";
import type { WakeupEventInfo } from "../parse";
import { WakeupCard } from "./WakeupCard";

const FUTURE = Date.now() + 20 * 60 * 1000;
const PAST = Date.now() - 20 * 60 * 1000;

function info(over: Partial<WakeupEventInfo> = {}): WakeupEventInfo {
  return { fireAt: FUTURE, delaySeconds: 1200, reason: "Fallback poll", prompt: "Continue the issue", superseded: false, failed: false, ...over };
}

function event(wakeup: WakeupEventInfo, over: Partial<ToolEvent> = {}): ToolEvent {
  return {
    kind: "tool", id: "w1", ts: "2026-07-07T10:00:00Z", srcCall: 0, family: "plan", tool: "ScheduleWakeup", icon: "clock",
    summary: wakeup.reason, chips: [], status: "ok", statusLabel: "ok", outputPreview: "", outputTruncated: false, open: false, wakeup, ...over,
  };
}

function render(wakeup: WakeupEventInfo, over: Partial<ToolEvent> = {}) {
  return renderToStaticMarkup(<WakeupCard event={event(wakeup, over)} wakeup={wakeup} />);
}

test("an active wakeup renders the reason, an absolute time and a countdown", () => {
  const html = render(info());
  expect(html).toContain("Fallback poll");
  expect(html).toContain("wakes at");
  expect(html).toContain("in ");
  // The plan (prompt) is present behind its expander.
  expect(html).toContain("Continue the issue");
  expect(html).toContain("wake plan");
});

test("a superseded FUTURE wakeup reads an inactive 'was set for' headline", () => {
  const html = render(info({ superseded: true }));
  expect(html).toContain("superseded");
  expect(html).toContain("was set for");
  expect(html).not.toContain("wakes at");
});

test("an elapsed wakeup renders the fired state", () => {
  const html = render(info({ fireAt: PAST }));
  expect(html).toContain("fired at");
});

test("a wakeup without a fire time still shows its reason and plan", () => {
  const html = render(info({ fireAt: null }));
  expect(html).toContain("Fallback poll");
  expect(html).toContain("Continue the issue");
});

test("a failed (rejected) wakeup shows the failed state and the harness error", () => {
  const html = render(info({ failed: true }), { status: "err", outputPreview: "delaySeconds must be between 60 and 3600", outputTruncated: false });
  expect(html).toContain("scheduling failed");
  // No live countdown for a rejected schedule.
  expect(html).not.toContain("in 20 min");
  // The actionable rejection reason stays visible.
  expect(html).toContain("delaySeconds must be between 60 and 3600");
});
