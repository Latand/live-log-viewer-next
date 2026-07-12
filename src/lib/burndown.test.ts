import { expect, test } from "bun:test";

import { burndownForActiveAccount, computePace, idealRemaining, mergeSamples, WINDOW_SECONDS } from "./burndown";
import type { BurndownPayload, BurndownSeries, EngineBurndown } from "./types";

const start = 1_000_000;
const week = WINDOW_SECONDS.weekly;
const reset = start + week;

const emptyEngine = (): EngineBurndown => ({
  session: { windowStart: null, resetsAt: null, windowSeconds: WINDOW_SECONDS.session, samples: [] },
  weekly: { windowStart: null, resetsAt: null, windowSeconds: WINDOW_SECONDS.weekly, samples: [] },
});

const burndownPayload = (over: Partial<BurndownPayload> = {}): BurndownPayload => ({
  claude: emptyEngine(),
  codex: emptyEngine(),
  claudeAccountId: "claude-a",
  codexAccountId: "codex-a",
  historySince: null,
  ...over,
});

test("burndownForActiveAccount returns the engine series when the account stamp matches", () => {
  const payload = burndownPayload();
  expect(burndownForActiveAccount(payload, "claude", "claude-a")).toBe(payload.claude);
  expect(burndownForActiveAccount(payload, "codex", "codex-a")).toBe(payload.codex);
});

test("burndownForActiveAccount masks a response whose account stamp changed (post-switch race)", () => {
  const payload = burndownPayload();
  expect(burndownForActiveAccount(payload, "claude", "claude-b")).toBeNull();
  expect(burndownForActiveAccount(payload, "codex", "codex-b")).toBeNull();
});

test("burndownForActiveAccount masks on a null payload or empty active id", () => {
  expect(burndownForActiveAccount(null, "claude", "claude-a")).toBeNull();
  expect(burndownForActiveAccount(burndownPayload({ claudeAccountId: null }), "claude", "claude-a")).toBeNull();
  expect(burndownForActiveAccount(burndownPayload(), "claude", "")).toBeNull();
});

test("idealRemaining runs a straight 100→0 line across the window", () => {
  expect(idealRemaining(start, reset, start)).toBe(100);
  expect(idealRemaining(start, reset, reset)).toBe(0);
  expect(idealRemaining(start, reset, start + week / 2)).toBeCloseTo(50, 5);
});

test("idealRemaining clamps outside the window and guards a zero-length window", () => {
  expect(idealRemaining(start, reset, start - 999)).toBe(100);
  expect(idealRemaining(start, reset, reset + 999)).toBe(0);
  expect(idealRemaining(start, start, start)).toBe(0);
});

test("mergeSamples dedupes by second, keeping the last value, and sorts ascending", () => {
  const merged = mergeSamples(
    [{ t: 30, remaining: 90 }, { t: 10, remaining: 100 }],
    [{ t: 30, remaining: 80 }, { t: 20, remaining: 95 }],
  );
  expect(merged).toEqual([
    { t: 10, remaining: 100 },
    { t: 20, remaining: 95 },
    { t: 30, remaining: 80 },
  ]);
});

const series = (samples: BurndownSeries["samples"]): BurndownSeries => ({
  windowStart: start,
  resetsAt: reset,
  windowSeconds: week,
  samples,
});

test("computePace flags burning ahead of pace when the curve sits below the diagonal", () => {
  // Halfway through the window the ideal says 50% left; the user has 30%.
  const now = start + week / 2;
  const pace = computePace(series([{ t: start, remaining: 100 }, { t: now, remaining: 30 }]), now);
  expect(pace).not.toBeNull();
  expect(pace!.ideal).toBeCloseTo(50, 5);
  expect(pace!.actual).toBe(30);
  expect(pace!.delta).toBeCloseTo(-20, 5);
  // Consumed 70% over half a week → hits 0 well before the reset.
  expect(pace!.zeroCrossing).not.toBeNull();
  expect(pace!.zeroCrossing! - now).toBeCloseTo((30 / 70) * (week / 2), 0);
  expect(pace!.zeroCrossing!).toBeLessThan(reset);
});

test("computePace reports underuse when the curve sits above the diagonal", () => {
  const now = start + week / 2;
  const pace = computePace(series([{ t: start, remaining: 100 }, { t: now, remaining: 80 }]), now);
  expect(pace!.delta).toBeCloseTo(30, 5);
});

test("computePace returns null without a defined window or any samples", () => {
  expect(computePace({ windowStart: null, resetsAt: reset, windowSeconds: week, samples: [{ t: 1, remaining: 5 }] }, 1)).toBeNull();
  expect(computePace(series([]), start)).toBeNull();
});

test("computePace leaves zeroCrossing null when nothing has been consumed", () => {
  const pace = computePace(series([{ t: start, remaining: 100 }]), start);
  expect(pace!.zeroCrossing).toBeNull();
});

test("computePace suppresses the projection for a flat series", () => {
  const now = start + week / 2;
  const pace = computePace(series([{ t: start, remaining: 50 }, { t: now, remaining: 50 }]), now);
  expect(pace!.zeroCrossing).toBeNull();
});

test("computePace suppresses the projection when the quota is climbing (a refill)", () => {
  const now = start + week / 2;
  const pace = computePace(series([{ t: start, remaining: 30 }, { t: now, remaining: 60 }]), now);
  expect(pace!.zeroCrossing).toBeNull();
});

test("computePace suppresses the projection for a mid-window refill even when it ends below the start", () => {
  const third = week / 3;
  // 80 → 20 → 60: net drop is positive, but the 20 → 60 rise is a refill.
  const pace = computePace(
    series([
      { t: start, remaining: 80 },
      { t: start + third, remaining: 20 },
      { t: start + 2 * third, remaining: 60 },
    ]),
    start + 2 * third,
  );
  expect(pace!.zeroCrossing).toBeNull();
});

test("computePace tolerates sub-epsilon sampling jitter on a draining series", () => {
  const day = 86_400;
  const pace = computePace(
    series([
      { t: start, remaining: 60 },
      { t: start + day, remaining: 39.8 },
      { t: start + 2 * day, remaining: 40.1 }, // +0.3 rise, within jitter tolerance
      { t: start + 3 * day, remaining: 39.5 },
    ]),
    start + 3 * day,
  );
  expect(pace!.zeroCrossing).not.toBeNull();
});

test("computePace projects from the observed slope, not an assumed full start", () => {
  // Never hit 100%: 60% → 40% over a day → 2%/half-day, so ~20 half-days to 0.
  const day = 86_400;
  const pace = computePace(series([{ t: start, remaining: 60 }, { t: start + day, remaining: 40 }]), start + day);
  // 40% remaining at 20%/day → 2 more days.
  expect(pace!.zeroCrossing! - (start + day)).toBeCloseTo(2 * day, 0);
});
