import type { BurndownPayload, BurndownSeries, EngineBurndown, LimitSample } from "./types";

/** Standard window lengths in seconds. Codex transcripts can carry an exact
    `window_minutes`, which overrides these when present. */
export const WINDOW_SECONDS = { session: 5 * 3600, weekly: 7 * 24 * 3600 } as const;

export type WindowKey = keyof typeof WINDOW_SECONDS;

/** Ownership gate for the burndown chart, mirroring LimitsFooter's
    `limitsForActiveAccount`: an account switch can let a history request started
    for the previous account resolve after the switch, so its series is used only
    when the payload's account stamp still matches the active account. A mismatch
    (or a null/empty stamp) masks the data instead of charting the wrong account. */
export function burndownForActiveAccount(payload: BurndownPayload | null, engine: "claude" | "codex", activeAccountId: string): EngineBurndown | null {
  if (!payload || !activeAccountId) return null;
  const payloadAccountId = engine === "claude" ? payload.claudeAccountId : payload.codexAccountId;
  if (payloadAccountId !== activeAccountId) return null;
  return engine === "claude" ? payload.claude : payload.codex;
}

/** Clamp a percentage into the drawable 0–100 range. */
export function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

/** Ideal even-pace remaining % at time `t`: 100 at `windowStart`, 0 at
    `resetsAt`. Spending exactly this fast lands on empty right at the reset. */
export function idealRemaining(windowStart: number, resetsAt: number, t: number): number {
  if (resetsAt <= windowStart) return 0;
  const frac = (resetsAt - t) / (resetsAt - windowStart);
  return clampPercent(frac * 100);
}

/** Merge two sample streams into one oldest-first series, collapsing points
    that share the same second (the live "now" point coincides with a forward
    sample, forward polls can coincide with a transcript event). */
export function mergeSamples(...streams: LimitSample[][]): LimitSample[] {
  const byT = new Map<number, number>();
  for (const stream of streams) {
    for (const sample of stream) {
      if (!Number.isFinite(sample.t) || !Number.isFinite(sample.remaining)) continue;
      byT.set(sample.t, clampPercent(sample.remaining));
    }
  }
  return [...byT.entries()].map(([t, remaining]) => ({ t, remaining })).sort((a, b) => a.t - b.t);
}

export interface PaceSummary {
  /** Where even pace says the user should be right now (% remaining). */
  ideal: number;
  /** Where the user actually is (latest sample, % remaining). */
  actual: number;
  /** actual − ideal. Positive = above the diagonal (underusing / safe);
      negative = below it (burning ahead of pace). */
  delta: number;
  /** Unix seconds the current slope projects quota to hit 0%, or null when the
      window is not depleting (flat or refilled) or the start is unknown. */
  zeroCrossing: number | null;
}

/** A consecutive rise beyond this (percentage points) counts as a refill rather
    than sampling jitter on an otherwise draining series. */
const REFILL_EPSILON = 0.5;

/** Projects when the quota hits 0% from the slope of the *observed* samples
    (first → latest of the window), not an assumed full start. Returns null when
    the series is flat, ends higher than it started, or contains any mid-series
    rise (a refill / window reset), so neither a steady 50%→50% nor an
    80→20→60 replenishment ever produces a bogus "empty by …" forecast. */
function projectZeroCrossing(samples: LimitSample[], actual: number): number | null {
  if (samples.length < 2) return null;
  for (let i = 1; i < samples.length; i++) {
    if (samples[i].remaining > samples[i - 1].remaining + REFILL_EPSILON) return null;
  }
  const first = samples[0];
  const last = samples[samples.length - 1];
  const dt = last.t - first.t;
  const drop = first.remaining - last.remaining; // positive = quota being spent
  if (dt <= 0 || drop <= 0) return null;
  return last.t + actual / (drop / dt);
}

/** Pace read for the current window: compares the latest actual sample against
    the ideal diagonal and projects the observed consumption slope to zero. */
export function computePace(series: BurndownSeries, now: number): PaceSummary | null {
  const { windowStart, resetsAt, samples } = series;
  if (windowStart === null || resetsAt === null || samples.length === 0) return null;
  const latest = samples[samples.length - 1];
  const actual = clampPercent(latest.remaining);
  const clampedNow = Math.min(Math.max(now, windowStart), resetsAt);
  const ideal = idealRemaining(windowStart, resetsAt, clampedNow);
  return { ideal, actual, delta: actual - ideal, zeroCrossing: projectZeroCrossing(samples, actual) };
}
