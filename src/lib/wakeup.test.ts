import { describe, expect, test } from "bun:test";

import { harnessKind, parseScheduleWakeup, refineWakeupFromResult, wakeupPhase } from "./wakeup";

const TS = Date.parse("2026-07-07T10:09:45.030Z");

/* Mirrors the parser's fireAtFromClock: the result's absolute HH:MM:SS anchored
   to the record's LOCAL day (tz-independent, since both sides use local time). */
function clockEpoch(tsMs: number, h: number, m: number, s: number): number {
  const d = new Date(tsMs);
  d.setHours(h, m, s, 0);
  let e = d.getTime();
  if (e < tsMs - 60_000) e += 86_400_000;
  return e;
}

describe("harnessKind", () => {
  test("maps the harness self-scheduling tools", () => {
    expect(harnessKind("ScheduleWakeup")).toBe("wakeup");
    expect(harnessKind("CronCreate")).toBe("cron");
    expect(harnessKind("Monitor")).toBe("monitor");
    expect(harnessKind("Bash")).toBeNull();
  });
});

describe("parseScheduleWakeup", () => {
  test("derives fire time from timestamp + delaySeconds", () => {
    const info = parseScheduleWakeup(
      { delaySeconds: 1200, reason: "Fallback", prompt: "Continue writing the issue" },
      TS,
    );
    expect(info.fireAt).toBe(TS + 1200 * 1000);
    expect(info.delaySeconds).toBe(1200);
    expect(info.reason).toBe("Fallback");
    expect(info.prompt).toBe("Continue writing the issue");
  });

  test("the resolved result clock is authoritative over the requested delay", () => {
    const info = parseScheduleWakeup(
      { delaySeconds: 120, reason: "r", prompt: "p" },
      TS,
      "Next wakeup scheduled for 17:00:00 (in 135s).",
    );
    // The result's exact 17:00:00 wins over ts + 120s and even over ts + 135s.
    expect(info.delaySeconds).toBe(135);
    expect(info.fireAt).toBe(clockEpoch(TS, 17, 0, 0));
  });

  test("uses the result's absolute clock when the input lacks a delay", () => {
    const info = parseScheduleWakeup(
      { reason: "r", prompt: "p" },
      TS,
      "Next wakeup scheduled for 13:30:00 (in 1215s). Nothing more to do this turn.",
    );
    expect(info.delaySeconds).toBe(1215);
    expect(info.fireAt).toBe(clockEpoch(TS, 13, 30, 0));
  });

  test("uses the resolved (in Ns) when the result carries no absolute clock", () => {
    const info = parseScheduleWakeup({ reason: "r", prompt: "p" }, TS, "Rescheduled — in 1215s.");
    expect(info.delaySeconds).toBe(1215);
    expect(info.fireAt).toBe(TS + 1215 * 1000);
  });

  test("falls back to the absolute clock when neither delay nor timestamp is usable", () => {
    const info = parseScheduleWakeup({ reason: "r", prompt: "p" }, TS, "Next wakeup scheduled for 13:30:00.");
    expect(info.delaySeconds).toBeNull();
    // Anchored to the record's local day at 13:30:00.
    expect(info.fireAt).not.toBeNull();
    const d = new Date(info.fireAt!);
    expect(d.getHours()).toBe(13);
    expect(d.getMinutes()).toBe(30);
  });

  test("is total on garbage input", () => {
    expect(parseScheduleWakeup(null, null)).toEqual({ fireAt: null, delaySeconds: null, reason: "", prompt: "" });
    expect(parseScheduleWakeup("nope", TS)).toEqual({ fireAt: null, delaySeconds: null, reason: "", prompt: "" });
  });
});

describe("refineWakeupFromResult", () => {
  test("fills a missing fire time from the result", () => {
    const base = parseScheduleWakeup({ reason: "r", prompt: "p" }, null);
    expect(base.fireAt).toBeNull();
    const refined = refineWakeupFromResult(base, TS, "Next wakeup scheduled for 13:30:00 (in 1215s).");
    expect(refined.fireAt).toBe(clockEpoch(TS, 13, 30, 0));
  });

  test("overrides the requested-delay fire time with the resolved schedule", () => {
    const base = parseScheduleWakeup({ delaySeconds: 600, reason: "r", prompt: "p" }, TS);
    expect(base.fireAt).toBe(TS + 600 * 1000);
    // Once the result attaches, its exact 10:20:00 is authoritative over 600s.
    const refined = refineWakeupFromResult(base, TS, "Next wakeup scheduled for 10:20:00 (in 615s).");
    expect(refined.fireAt).toBe(clockEpoch(TS, 10, 20, 0));
  });

  test("keeps the call-time fire time when the result carries no schedule", () => {
    const base = parseScheduleWakeup({ delaySeconds: 600, reason: "r", prompt: "p" }, TS);
    const refined = refineWakeupFromResult(base, TS, "Scheduling acknowledged.");
    expect(refined.fireAt).toBe(TS + 600 * 1000);
  });
});

describe("wakeupPhase", () => {
  const now = TS + 100_000;
  test("a future fire time is pending", () => {
    expect(wakeupPhase(now + 60_000, now)).toBe("pending");
  });
  test("a past fire time has fired", () => {
    expect(wakeupPhase(now - 60_000, now)).toBe("fired");
  });
  test("an unknown fire time is unknown", () => {
    expect(wakeupPhase(null, now)).toBe("unknown");
  });
});
