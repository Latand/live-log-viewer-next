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

test("an active wakeup is a quiet row: full reason plus ONE fused schedule element", () => {
  const html = render(info());
  expect(html).toContain("Fallback poll");
  // The absolute time and the countdown are one element, stated exactly once.
  expect(html.split("wakes at").length - 1).toBe(1);
  expect(html.split("in 20 min").length - 1).toBe(1);
  // Routine scheduling carries no alarm chrome and never truncates the reason.
  expect(html).not.toContain("warning");
  expect(html).not.toContain("truncate");
  // The raw plan stays collapsed and unmounted until the row is expanded.
  expect(html).not.toContain("Continue the issue");
  expect(html).not.toContain('open="');
});

test("a superseded FUTURE wakeup reads an inactive 'was set for' element", () => {
  const html = render(info({ superseded: true }));
  expect(html).toContain("superseded");
  expect(html).toContain("was set for");
  expect(html).not.toContain("wakes at");
});

test("an elapsed wakeup renders the fired state without a countdown", () => {
  const html = render(info({ fireAt: PAST }));
  expect(html).toContain("fired at");
  expect(html).not.toContain("· in");
});

test("a wakeup without a fire time still shows its reason", () => {
  const html = render(info({ fireAt: null }));
  expect(html).toContain("Fallback poll");
  expect(html).toContain("wakeup scheduled");
});

test("a rejected wakeup keeps the alarm: danger edge, open, harness error visible", () => {
  const html = render(info({ failed: true }), { status: "err", outputPreview: "delaySeconds must be between 60 and 3600", outputTruncated: false });
  expect(html).toContain("scheduling failed");
  expect(html).toContain("border-danger");
  expect(html).toContain('open=""');
  // No live countdown for a rejected schedule.
  expect(html).not.toContain("· in");
  // The actionable rejection reason stays visible.
  expect(html).toContain("delaySeconds must be between 60 and 3600");
});

test("the wake plan renders as marked internal monospace payload, not prose", () => {
  const html = render(info({ failed: true, prompt: "## Stage verify\nResume the review round" }), { status: "err" });
  expect(html).toContain("wake plan");
  expect(html).toContain("internal prompt");
  // The raw text stays literal in a mono <pre>: markdown never becomes prose.
  expect(html).toContain("## Stage verify");
  expect(html).not.toContain("<h2");
  expect(html).toMatch(/<pre[^>]*font-mono/);
});
