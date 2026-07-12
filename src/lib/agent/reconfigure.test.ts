import { describe, expect, test } from "bun:test";

import { reconfigurationFromBody } from "./reconfigure";

describe("reconfigurationFromBody", () => {
  test("accepts a known codex model with its extended effort scale and speed", () => {
    expect(reconfigurationFromBody("codex", { model: "gpt-5.6-sol", effort: "ultra", fast: true })).toEqual({
      value: { model: "gpt-5.6-sol", effort: "ultra", fast: true },
    });
  });

  test("accepts claude family aliases and omits speed", () => {
    expect(reconfigurationFromBody("claude", { model: "sonnet", effort: "high" })).toEqual({
      value: { model: "sonnet", effort: "high", fast: null },
    });
  });

  test("rejects cross-engine and invalid combinations", () => {
    expect(reconfigurationFromBody("claude", { model: "gpt-5.6-sol", effort: "high" }).error).toContain("model");
    expect(reconfigurationFromBody("codex", { model: "gpt-5.6-terra", effort: "minimal", fast: false }).error).toContain("effort");
    expect(reconfigurationFromBody("claude", { model: "opus", effort: "max", fast: true }).error).toContain("speed");
  });
});
