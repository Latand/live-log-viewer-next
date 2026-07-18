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

describe("compact pipeline lineage copy (#353)", () => {
  const keys = [
    "pipelineStrip.configureStage",
    "pipelineStrip.lineageAria",
    "pipelineStrip.previousStage",
    "pipelineStrip.nextStage",
    "pipelineStrip.evidenceAria",
    "pipelineStrip.linkedTasks",
    "pipelineStrip.openTask",
  ] as const;

  test("English and Ukrainian define every compact-stage accessibility label", () => {
    for (const key of keys) {
      expect(en[key]).toBeTruthy();
      expect(uk[key]).toBeTruthy();
    }
  });

  test("Ukrainian lineage and evidence labels interpolate every spoken value", () => {
    const lineage = translate("uk", "pipelineStrip.lineageAria", { from: "Архітектор", to: "Розробник" });
    const evidence = translate("uk", "pipelineStrip.evidenceAria", { label: "Розробник", verdict: "пройдено", duration: "1:30", model: "GPT-5.6" });
    expect(lineage).toContain("Архітектор");
    expect(lineage).toContain("Розробник");
    expect(evidence).toContain("пройдено");
    expect(evidence).toContain("1:30");
    expect(evidence).toContain("GPT-5.6");
  });

  test("template guidance describes compact groups and on-demand configuration in both locales", () => {
    expect(en["pipelineTemplates.subtitle"]).toContain("compact group");
    expect(en["pipelineTemplates.subtitle"]).toContain("on demand");
    expect(uk["pipelineTemplates.subtitle"]).toContain("компакт");
    expect(uk["pipelineTemplates.subtitle"]).toContain("за запитом");
  });

  test("every connector and verdict action names its stage and state", () => {
    expect(translate("en", "pipelineStrip.previousStage", { label: "Build", state: "passed" })).toContain("passed");
    expect(translate("en", "pipelineStrip.nextStage", { label: "Review", state: "pending" })).toContain("pending");
    expect(translate("uk", "pipelineStrip.openVerdict", { label: "Збірка", state: "пройдено" })).toContain("пройдено");
    expect(translate("en", "pipelineMobile.prevStage", { label: "Build", state: "passed" })).toContain("Build");
    expect(translate("uk", "pipelineMobile.nextStage", { label: "Рев’ю", state: "очікує" })).toContain("очікує");
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
