import { describe, expect, test } from "bun:test";

import type { FileEntry } from "@/lib/types";
import { clockDuration, humanizeDuration, recencyTurnInfo, turnDurationSeconds, workedCaption } from "./turnDuration";

describe("clockDuration", () => {
  test("minutes and padded seconds", () => {
    expect(clockDuration(0)).toBe("0:00");
    expect(clockDuration(7)).toBe("0:07");
    expect(clockDuration(4 * 60 + 32)).toBe("4:32");
  });
  test("hours pad both lower fields", () => {
    expect(clockDuration(3600 + 4 * 60 + 9)).toBe("1:04:09");
    expect(clockDuration(2 * 3600)).toBe("2:00:00");
  });
  test("clamps negatives and fractions", () => {
    expect(clockDuration(-5)).toBe("0:00");
    expect(clockDuration(59.9)).toBe("0:59");
  });
});

describe("humanizeDuration", () => {
  test("seconds only", () => {
    expect(humanizeDuration(45, "en")).toBe("45s");
    expect(humanizeDuration(45, "uk")).toBe("45 с");
  });
  test("minutes and seconds, two units deep", () => {
    expect(humanizeDuration(12 * 60 + 30, "en")).toBe("12m 30s");
    expect(humanizeDuration(12 * 60 + 30, "uk")).toBe("12 хв 30 с");
  });
  test("drops a zero lower unit", () => {
    expect(humanizeDuration(12 * 60, "en")).toBe("12m");
    expect(humanizeDuration(3600, "uk")).toBe("1 год");
  });
  test("hours and minutes", () => {
    expect(humanizeDuration(3600 + 5 * 60, "en")).toBe("1h 5m");
    expect(humanizeDuration(3600 + 5 * 60, "uk")).toBe("1 год 5 хв");
  });
  test("clamps negatives to zero", () => {
    expect(humanizeDuration(-10, "en")).toBe("0s");
  });
});

const file = (lastTurn: FileEntry["lastTurn"], activity: FileEntry["activity"] = "idle") =>
  ({ lastTurn, activity }) as Pick<FileEntry, "lastTurn" | "activity">;

describe("turn caption + recency", () => {
  test("workedCaption is null while running, set once idle", () => {
    expect(workedCaption(file({ startedAt: 0, endedAt: null }), "en")).toBeNull();
    expect(workedCaption(file({ startedAt: 0, endedAt: 90_000 }), "en")).toBe("Worked for 1m 30s");
    expect(workedCaption(file({ startedAt: 0, endedAt: 90_000 }), "uk")).toBe("Працював 1 хв 30 с");
  });

  test("turnDurationSeconds guards missing/running turns", () => {
    expect(turnDurationSeconds(file(null))).toBeNull();
    expect(turnDurationSeconds(file({ startedAt: 0, endedAt: null }))).toBeNull();
    expect(turnDurationSeconds(file({ startedAt: 0, endedAt: 5_000 }))).toBe(5);
  });

  test("live open turn shows running elapsed, no idle tooltip", () => {
    const info = recencyTurnInfo(file({ startedAt: 0, endedAt: null }, "live"), 4 * 60 * 1000, "en");
    expect(info.running).toBe("working 4m");
    expect(info.idleTitle).toBeNull();
  });

  test("finished turn parks run length in the idle tooltip", () => {
    const info = recencyTurnInfo(file({ startedAt: 0, endedAt: 12 * 60 * 1000 }, "idle"), Date.now(), "uk");
    expect(info.running).toBeNull();
    expect(info.idleTitle).toBe("останній прогін: 12 хв");
  });

  test("open turn on a non-live card yields neither label", () => {
    const info = recencyTurnInfo(file({ startedAt: 0, endedAt: null }, "stalled"), Date.now(), "en");
    expect(info).toEqual({ running: null, idleTitle: null });
  });
});
