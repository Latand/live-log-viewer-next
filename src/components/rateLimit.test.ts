import { expect, test } from "bun:test";

import { translate } from "@/lib/i18n";

import { windowLabel } from "./rateLimit";

const en = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>) => translate("en", key, params);
const uk = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>) => translate("uk", key, params);

test("a window is labelled by the horizon it declares, whichever tab it sits on", () => {
  expect(windowLabel(en, "session", 300)).toBe("5h");
  expect(windowLabel(en, "weekly", 10_080)).toBe("Week");
  // The issue-#606 case: weekly-horizon data reaching the session slot must not
  // be called "5h" — the label follows the data.
  expect(windowLabel(en, "session", 10_080)).toBe("Week");
});

test("an undeclared horizon falls back to the slot's nominal name", () => {
  expect(windowLabel(en, "session", null)).toBe("5h");
  expect(windowLabel(en, "weekly", undefined)).toBe("Week");
  expect(windowLabel(en, "session", 0)).toBe("5h");
});

test("other declared lengths are spelled out in the reader's units", () => {
  expect(windowLabel(en, "session", 60)).toBe("1h");
  expect(windowLabel(en, "session", 45)).toBe("45m");
  expect(windowLabel(en, "weekly", 43_200)).toBe("30d");
  expect(windowLabel(uk, "session", 45)).toBe("45 хв");
  expect(windowLabel(uk, "weekly", 43_200)).toBe("30 д");
  expect(windowLabel(uk, "session", 10_080)).toBe("Тиждень");
});
