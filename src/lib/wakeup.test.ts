import { describe, expect, test } from "bun:test";

import { harnessKind, parseScheduleWakeup, refineWakeupFromResult, wakeupPhase } from "./wakeup";

const TS = Date.parse("2026-07-07T10:09:45.030Z");

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

  test("prefers input delay over the result text", () => {
    const info = parseScheduleWakeup(
      { delaySeconds: 1200, reason: "r", prompt: "p" },
      TS,
      "Next wakeup scheduled for 13:30:00 (in 1215s).",
    );
    // Fire time comes from ts + input delay, not the result's 1215s.
    expect(info.fireAt).toBe(TS + 1200 * 1000);
  });

  test("falls back to the result's (in Ns) when the input lacks a delay", () => {
    const info = parseScheduleWakeup(
      { reason: "r", prompt: "p" },
      TS,
      "Next wakeup scheduled for 13:30:00 (in 1215s). Nothing more to do this turn.",
    );
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
    expect(refined.fireAt).toBe(TS + 1215 * 1000);
  });

  test("keeps an already-known fire time untouched", () => {
    const base = parseScheduleWakeup({ delaySeconds: 600, reason: "r", prompt: "p" }, TS);
    const refined = refineWakeupFromResult(base, TS, "Next wakeup scheduled for 09:00:00 (in 5s).");
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
