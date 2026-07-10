import { describe, expect, test } from "bun:test";

import { en } from "./en";
import { translate } from "./index";
import { uk } from "./uk";

describe("translation parity between en and uk", () => {
  test("both locales define exactly the same keys", () => {
    expect(Object.keys(uk).sort()).toEqual(Object.keys(en).sort());
  });

  test("no message in either locale is empty", () => {
    for (const [key, value] of Object.entries(en)) {
      expect(typeof value === "string" ? value.trim().length : 1, `en ${key}`).toBeGreaterThan(0);
    }
    for (const [key, value] of Object.entries(uk)) {
      expect(typeof value === "string" ? value.trim().length : 1, `uk ${key}`).toBeGreaterThan(0);
    }
  });
});

describe("new dictation-cap copy is present and interpolates", () => {
  const keys = ["mic.dictateHint", "mic.timeLeft", "mic.capStopped", "dictation.capWarn", "dictation.capStopped"] as const;

  test("every new key exists in both locales", () => {
    for (const key of keys) {
      expect(key in en, `en ${key}`).toBe(true);
      expect(key in uk, `uk ${key}`).toBe(true);
    }
  });

  test("the cap moved to ten minutes in the dictate hint", () => {
    expect(en["mic.dictateHint"]).toContain("10 min");
    expect(uk["mic.dictateHint"]).toContain("10 хв");
    expect(en["mic.dictateHint"]).not.toContain("2 min");
  });

  test("the countdown copy interpolates the remaining time", () => {
    expect(translate("en", "mic.timeLeft", { time: "0:45" })).toBe("0:45 left before auto-stop");
    expect(translate("uk", "mic.timeLeft", { time: "0:45" })).toContain("0:45");
    expect(translate("uk", "mic.timeLeft", { time: "0:45" })).not.toContain("{time}");
  });
});

describe("attach copy (issue #68) is present in both locales", () => {
  const keys = [
    "attach.attach",
    "attach.readonly",
    "attach.copy",
    "attach.copyReadonly",
    "attach.hint",
    "attach.readonlyHint",
    "attach.loading",
    "attach.copied",
    "attach.copiedReadonly",
    "attach.stale",
    "attach.restarted",
    "attach.unavailable",
    "attach.badRequest",
    "attach.network",
    "attach.clipboard",
    "attach.refresh",
  ] as const;

  test("every attach key exists in en and uk", () => {
    for (const key of keys) {
      expect(key in en, `en ${key}`).toBe(true);
      expect(key in uk, `uk ${key}`).toBe(true);
    }
  });

  test("the stale/restart copy tells the user to refresh in both languages", () => {
    expect(en["attach.stale"]).toBe("This pane changed or closed. Refresh and try again.");
    expect(uk["attach.stale"]).toContain("Онови");
    expect(en["attach.restarted"]).toContain("Refresh");
    expect(uk["attach.restarted"]).toContain("Онови");
  });
});
