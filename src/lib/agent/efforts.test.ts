import { describe, expect, test } from "bun:test";

import { effortMeter, effortScale } from "./efforts";

describe("effortScale", () => {
  test("claude models all share the CLI scale low through max", () => {
    for (const model of ["fable-5", "opus-4-8", "sonnet-5", "haiku-4-5", null]) {
      expect(effortScale("claude", model)).toEqual(["low", "medium", "high", "xhigh", "max"]);
    }
  });

  test("codex gpt-5.6 sol/terra carry the max and ultra tiers", () => {
    expect(effortScale("codex", "gpt-5.6-sol")).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
    expect(effortScale("codex", "gpt-5.6-terra")).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
  });

  test("other gpt-5.6 models top out at max", () => {
    expect(effortScale("codex", "gpt-5.6-luna")).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(effortScale("codex", "gpt-5.6")).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  test("older and unknown codex models run the classic low through xhigh", () => {
    for (const model of ["gpt-5.5", "gpt-5.4-mini", "gpt-5.3-codex-spark", "codex-auto-review", null]) {
      expect(effortScale("codex", model)).toEqual(["low", "medium", "high", "xhigh"]);
    }
  });

  test("engines without a reasoning dial have no scale", () => {
    expect(effortScale("shell", null)).toBeNull();
  });
});

describe("effortMeter", () => {
  test("claude low is the single lowest bar of a five-slot meter", () => {
    expect(effortMeter("claude", "fable-5", "low")).toEqual({ level: 1, slots: 5 });
  });

  test("claude walks low through max onto 1..5", () => {
    expect(effortMeter("claude", "fable-5", "medium")).toEqual({ level: 2, slots: 5 });
    expect(effortMeter("claude", "opus-4-8", "high")).toEqual({ level: 3, slots: 5 });
    expect(effortMeter("claude", "sonnet-5", "xhigh")).toEqual({ level: 4, slots: 5 });
    expect(effortMeter("claude", "fable-5", "max")).toEqual({ level: 5, slots: 5 });
  });

  test("codex xhigh fills the whole meter on the classic four-tier models", () => {
    expect(effortMeter("codex", "gpt-5.5", "xhigh")).toEqual({ level: 4, slots: 4 });
    expect(effortMeter("codex", null, "xhigh")).toEqual({ level: 4, slots: 4 });
  });

  test("codex xhigh sits below max and ultra on gpt-5.6 sol/terra", () => {
    expect(effortMeter("codex", "gpt-5.6-sol", "xhigh")).toEqual({ level: 4, slots: 6 });
    expect(effortMeter("codex", "gpt-5.6-sol", "max")).toEqual({ level: 5, slots: 6 });
    expect(effortMeter("codex", "gpt-5.6-terra", "ultra")).toEqual({ level: 6, slots: 6 });
    expect(effortMeter("codex", "gpt-5.6-sol", "low")).toEqual({ level: 1, slots: 6 });
  });

  test("recognized tiers outside the model's scale clamp to the nearest end", () => {
    // A legacy transcript recording `minimal` still shows the lowest bar.
    expect(effortMeter("codex", "gpt-5.5", "minimal")).toEqual({ level: 1, slots: 4 });
    // A tier above the known scale appears at the top.
    expect(effortMeter("codex", "gpt-5.5", "max")).toEqual({ level: 4, slots: 4 });
    expect(effortMeter("codex", "gpt-5.6-luna", "ultra")).toEqual({ level: 5, slots: 5 });
  });

  test("hides on unknown, absent, or unscaled input", () => {
    expect(effortMeter("claude", "fable-5", null)).toEqual({ level: 0, slots: 0 });
    expect(effortMeter("claude", "fable-5", undefined)).toEqual({ level: 0, slots: 0 });
    expect(effortMeter("codex", "gpt-5.6-sol", "")).toEqual({ level: 0, slots: 0 });
    expect(effortMeter("codex", "gpt-5.6-sol", "bogus")).toEqual({ level: 0, slots: 0 });
    expect(effortMeter("shell", null, "high")).toEqual({ level: 0, slots: 0 });
  });
});
