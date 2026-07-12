import type { BurndownSeries, LimitSample } from "./types";

/** Standard window lengths in seconds. Codex transcripts can carry an exact
    `window_minutes`, which overrides these when present. */
export const WINDOW_SECONDS = { session: 5 * 3600, weekly: 7 * 24 * 3600 } as const;

export type WindowKey = keyof typeof WINDOW_SECONDS;

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

/** Pace read for the current window: compares the latest actual sample against
    the ideal diagonal and projects the observed slope to zero. */
export function computePace(series: BurndownSeries, now: number): PaceSummary | null {
  const { windowStart, resetsAt, samples } = series;
  if (windowStart === null || resetsAt === null || samples.length === 0) return null;
  const latest = samples[samples.length - 1];
  const actual = clampPercent(latest.remaining);
  const clampedNow = Math.min(Math.max(now, windowStart), resetsAt);
  const ideal = idealRemaining(windowStart, resetsAt, clampedNow);
  const elapsed = latest.t - windowStart;
  const consumed = 100 - actual;
  let zeroCrossing: number | null = null;
  if (elapsed > 0 && consumed > 0) {
    const ratePerSecond = consumed / elapsed;
    zeroCrossing = latest.t + actual / ratePerSecond;
  }
  return { ideal, actual, delta: actual - ideal, zeroCrossing };
}
