import { expect, test } from "bun:test";

import { canonicalWindowMinutes, relabelCachedWindows, routeWindowsByHorizon, windowKeyForMinutes } from "./limitWindows";

/** Shapes below mirror the Codex rate-limit payloads seen in the wild: until
    mid-July 2026 a plan reported a 300-minute primary plus a 10080-minute
    secondary; afterwards the same plan reports only the 10080-minute window,
    and it arrives in the `primary` slot (issue #606). */

test("a declared window length decides the horizon, not the slot it arrived in", () => {
  expect(windowKeyForMinutes(300)).toBe("session");
  expect(windowKeyForMinutes(10_080)).toBe("weekly");
  // Boundary: a day-long window is still short-horizon, longer is weekly.
  expect(windowKeyForMinutes(1440)).toBe("session");
  expect(windowKeyForMinutes(1441)).toBe("weekly");
  // Nothing to go on.
  expect(windowKeyForMinutes(null)).toBeNull();
  expect(windowKeyForMinutes(0)).toBeNull();
  expect(windowKeyForMinutes(Number.NaN)).toBeNull();
});

/** One rate-limit window as the provider hands it over: a used percentage plus
    the length of the window it belongs to (absent when never declared). */
const win = (usedPercent: number, windowMinutes: number | null = null) => ({ usedPercent, windowMinutes });

test("a weekly-only plan files its primary window under weekly, leaving no 5h value", () => {
  const routed = routeWindowsByHorizon(win(15, 10_080), null);
  expect(routed.weekly).toEqual(win(15, 10_080));
  expect(routed.session).toBeNull();
});

test("a plan with both windows keeps each on its own horizon", () => {
  const routed = routeWindowsByHorizon(win(2, 300), win(54, 10_080));
  expect(routed.session).toEqual(win(2, 300));
  expect(routed.weekly).toEqual(win(54, 10_080));
});

test("windows arriving in the reversed slots follow their declared lengths", () => {
  const routed = routeWindowsByHorizon(win(54, 10_080), win(2, 300));
  expect(routed.session).toEqual(win(2, 300));
  expect(routed.weekly).toEqual(win(54, 10_080));
});

test("windows that declare no length keep their conventional slots", () => {
  const routed = routeWindowsByHorizon(win(37), win(61));
  expect(routed.session).toEqual(win(37));
  expect(routed.weekly).toEqual(win(61));
});

test("an undeclared window whose slot is taken is dropped rather than guessed at", () => {
  // The secondary declares nothing and its conventional slot is already held by
  // a window that named the weekly horizon. Parking it on the session tab would
  // present it as a 5h figure on no evidence at all — the very bug of #606.
  const routed = routeWindowsByHorizon(win(15, 10_080), win(61));
  expect(routed.weekly).toEqual(win(15, 10_080));
  expect(routed.session).toBeNull();
});

test("an undeclared window whose reset outruns 5 hours is filed as weekly", () => {
  // Finding 2: the same reset-horizon evidence the cache repair uses, applied
  // at ingestion, so a live snapshot with no declared length is never labelled
  // 5h when its reset is a week out.
  const capturedAt = 1_784_914_879;
  const weeklyHorizon = routeWindowsByHorizon({ usedPercent: 15, windowMinutes: null, resetsAt: capturedAt + 7 * 86_400 }, null, capturedAt);
  expect(weeklyHorizon.weekly?.usedPercent).toBe(15);
  expect(weeklyHorizon.session).toBeNull();

  const sessionHorizon = routeWindowsByHorizon({ usedPercent: 15, windowMinutes: null, resetsAt: capturedAt + 3 * 3_600 }, null, capturedAt);
  expect(sessionHorizon.session?.usedPercent).toBe(15);
  expect(sessionHorizon.weekly).toBeNull();
});

test("without a capture time or a reset, an undeclared window keeps its slot", () => {
  const capturedAt = 1_784_914_879;
  expect(routeWindowsByHorizon({ usedPercent: 15, windowMinutes: null, resetsAt: capturedAt + 7 * 86_400 }, null).session?.usedPercent).toBe(15);
  expect(routeWindowsByHorizon({ usedPercent: 15, windowMinutes: null, resetsAt: null }, null, capturedAt).session?.usedPercent).toBe(15);
});

test("a declared length is snapped to the horizon it is reporting, and only that", () => {
  // Real transcripts report a week as 10080 and as 10081 minutes.
  expect(canonicalWindowMinutes(10_081)).toBe(10_080);
  expect(canonicalWindowMinutes(10_080)).toBe(10_080);
  expect(canonicalWindowMinutes(299)).toBe(300);
  // Horizons of their own keep their length.
  expect(canonicalWindowMinutes(1440)).toBeNull();
  expect(canonicalWindowMinutes(43_200)).toBeNull();
  expect(canonicalWindowMinutes(null)).toBeNull();
});

test("a cached weekly-horizon value stored under session is relabelled on read", () => {
  const capturedAt = 1_784_914_879;
  const healed = relabelCachedWindows({
    // ~5.1 days out: further than a 5-hour window can ever reach.
    session: { usedPercent: 100, resetsAt: capturedAt + 437_631 },
    weekly: null,
    plan: "pro",
    capturedAt,
  });
  expect(healed?.session).toBeNull();
  expect(healed?.weekly).toEqual({ usedPercent: 100, resetsAt: capturedAt + 437_631 });
  expect(healed?.plan).toBe("pro");
});

test("a genuine 5h snapshot, a declared window, and an unknown capture time are left alone", () => {
  const capturedAt = 1_784_914_879;
  const genuine = { session: { usedPercent: 40, resetsAt: capturedAt + 3_600 }, weekly: null, plan: "pro", capturedAt };
  expect(relabelCachedWindows(genuine)).toBe(genuine);

  const declared = { session: { usedPercent: 40, resetsAt: capturedAt + 437_631, windowMinutes: 300 }, weekly: null, plan: "pro", capturedAt };
  expect(relabelCachedWindows(declared)).toBe(declared);

  const undated = { session: { usedPercent: 40, resetsAt: capturedAt + 437_631 }, weekly: null, plan: "pro", capturedAt: null };
  expect(relabelCachedWindows(undated)).toBe(undated);

  const bothWindows = { session: { usedPercent: 40, resetsAt: capturedAt + 437_631 }, weekly: { usedPercent: 10, resetsAt: capturedAt + 500_000 }, plan: "pro", capturedAt };
  expect(relabelCachedWindows(bothWindows)).toBe(bothWindows);

  expect(relabelCachedWindows(null)).toBeNull();
});
