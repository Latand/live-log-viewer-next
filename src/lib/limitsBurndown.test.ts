import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { computePace } from "./burndown";
import { buildSeries, collectCodexRateLimitSeries } from "./limits";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-codex-series-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** Write a Codex session JSONL under YYYY/MM/DD derived from `day`. */
function writeSession(name: string, day: string, events: { ts: string; primary?: [number, number, number]; secondary?: [number, number, number] }[]): void {
  const [y, m, d] = day.split("-");
  const dir = path.join(root, y, m, d);
  fs.mkdirSync(dir, { recursive: true });
  const win = (w?: [number, number, number]) =>
    w ? { used_percent: w[0], window_minutes: w[1], resets_at: w[2] } : undefined;
  const lines = events.map((e) =>
    JSON.stringify({
      timestamp: e.ts,
      payload: { rate_limits: { primary: win(e.primary), secondary: win(e.secondary), plan_type: "pro" } },
    }),
  );
  fs.writeFileSync(path.join(dir, name), lines.join("\n") + "\n", "utf8");
}

test("reconstructs primary/secondary curves across events with window metadata", () => {
  const reset5h = 1_783_544_991;
  const resetWeek = 1_783_994_379;
  writeSession("s.jsonl", "2026-07-08", [
    { ts: "2026-07-08T15:00:00.000Z", primary: [10, 300, reset5h], secondary: [40, 10080, resetWeek] },
    { ts: "2026-07-08T17:28:49.000Z", primary: [35, 300, reset5h], secondary: [58, 10080, resetWeek] },
  ]);
  const series = collectCodexRateLimitSeries(root, 0);
  expect(series.session).toEqual([
    { t: Math.round(Date.parse("2026-07-08T15:00:00.000Z") / 1000), remaining: 90 },
    { t: Math.round(Date.parse("2026-07-08T17:28:49.000Z") / 1000), remaining: 65 },
  ]);
  expect(series.weekly.map((s) => s.remaining)).toEqual([60, 42]);
  // Newest event fixes each window definition.
  expect(series.sessionWindowSeconds).toBe(300 * 60);
  expect(series.weeklyWindowSeconds).toBe(10080 * 60);
  expect(series.sessionResetsAt).toBe(reset5h);
  expect(series.weeklyResetsAt).toBe(resetWeek);
});

test("drops events older than the cutoff and dedupes identical timestamps", () => {
  const reset = 1_783_544_991;
  writeSession("a.jsonl", "2026-07-08", [
    { ts: "2026-07-08T10:00:00.000Z", primary: [10, 300, reset] },
    { ts: "2026-07-08T12:00:00.000Z", primary: [20, 300, reset] },
    { ts: "2026-07-08T12:00:00.000Z", primary: [99, 300, reset] }, // duplicate second → ignored
  ]);
  const cutoff = Math.round(Date.parse("2026-07-08T11:00:00.000Z") / 1000);
  const series = collectCodexRateLimitSeries(root, cutoff);
  expect(series.session).toEqual([{ t: Math.round(Date.parse("2026-07-08T12:00:00.000Z") / 1000), remaining: 80 }]);
});

test("returns empty series for a sessions dir with no transcripts", () => {
  const series = collectCodexRateLimitSeries(path.join(root, "missing"), 0);
  expect(series.session).toEqual([]);
  expect(series.weekly).toEqual([]);
  expect(series.sessionResetsAt).toBeNull();
});

test("buildSeries drops pre-reset samples so a draining window after a rollover still projects", () => {
  const windowSeconds = 18_000; // 5h
  const now = 10_000_000;
  const resetsAt = now + 9_000;
  const windowStart = resetsAt - windowSeconds; // now - 9000
  // A low pre-reset sample inside the old 60s grace, then a normal rollover to
  // ~100% and a draining new window.
  const forward = [
    { t: windowStart - 30, remaining: 5 }, // previous window — must be excluded
    { t: windowStart + 100, remaining: 100 },
    { t: windowStart + 4_500, remaining: 90 },
  ];
  const series = buildSeries(forward, [], { usedPercent: 15, resetsAt }, now, windowSeconds, null);
  // The pre-reset value is gone, so there is no boundary rise.
  expect(series.samples.some((s) => s.remaining === 5)).toBe(false);
  expect(series.samples[0].remaining).toBe(100);
  expect(computePace(series, now)!.zeroCrossing).not.toBeNull();
});
