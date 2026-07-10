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
