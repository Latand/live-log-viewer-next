import { expect, test } from "bun:test";

import {
  CODEX_SOL_MODEL,
  CODEX_TERRA_MODEL,
  CODEX_LUNA_MODEL,
  defaultModelFor,
  ENGINE_MODELS,
  modelFromBody,
  normalizeClaudeLaunchModel,
  validateLaunchModel, claudeModelGatedByFlagshipWeekly, claudeTierDisplayName } from "./models";

test("the model catalog exposes Opus 5 as the Claude default", () => {
  expect(ENGINE_MODELS.claude[0]).toEqual({ id: "opus", label: "Opus 5", shortLabel: "Opus 5", use: "review" });
  expect(ENGINE_MODELS.codex).toEqual([
    { id: CODEX_SOL_MODEL, label: "GPT-5.6-Sol", shortLabel: "5.6-Sol", use: "review" },
    { id: CODEX_TERRA_MODEL, label: "GPT-5.6-Terra", shortLabel: "5.6-Terra", use: "implement" },
    { id: CODEX_LUNA_MODEL, label: "GPT-5.6-Luna", shortLabel: "5.6-Luna", use: "general" },
  ]);
  expect(defaultModelFor("codex")).toBe(CODEX_SOL_MODEL);
  expect(defaultModelFor("claude")).toBe("opus");
});

test("spawn model validation accepts CLI ids and rejects control characters", () => {
  expect(modelFromBody({ model: " gpt-5.6-terra " })).toEqual({ model: CODEX_TERRA_MODEL });
  expect(modelFromBody({})).toEqual({ model: null });
  expect(modelFromBody({ model: "terra\n--help" }).error).toBeDefined();
});

test("explicit launch models are admitted only from the selected engine catalog", () => {
  expect(validateLaunchModel("codex", CODEX_TERRA_MODEL)).toEqual({ model: CODEX_TERRA_MODEL });
  expect(validateLaunchModel("codex", "gpt-5.6-codex")).toEqual({
    error: `invalid codex model id "gpt-5.6-codex"; valid codex model ids: ${ENGINE_MODELS.codex.map((option) => option.id).join(", ")}`,
  });
  expect(validateLaunchModel("claude", "claude-fable-5")).toEqual({
    error: `invalid claude model id "claude-fable-5"; valid claude model ids: ${ENGINE_MODELS.claude.map((option) => option.id).join(", ")}`,
  });
});

test("Claude transcript model families normalize to stable launch aliases", () => {
  expect(normalizeClaudeLaunchModel("fable")).toBe("fable");
  expect(normalizeClaudeLaunchModel("claude-fable")).toBe("fable");
  expect(normalizeClaudeLaunchModel("fable-20260701")).toBe("fable");
  expect(normalizeClaudeLaunchModel("claude-opus-4-8-20260630")).toBe("opus");
  expect(normalizeClaudeLaunchModel("claude-sonnet-5-20260701")).toBe("sonnet");
  expect(normalizeClaudeLaunchModel("claude-3-5-haiku-20241022")).toBe("haiku");
});

test("unknown or unsafe Claude transcript model ids omit the launch override", () => {
  expect(normalizeClaudeLaunchModel("mythos-1")).toBeNull();
  expect(normalizeClaudeLaunchModel("claude-opus\n--dangerously-skip-permissions")).toBeNull();
  expect(normalizeClaudeLaunchModel(" ")).toBeNull();
  expect(normalizeClaudeLaunchModel(null)).toBeNull();
});

test("flagship-class Claude models draw on the flagship weekly; lower tiers and Codex do not (#1358)", () => {
  // The launch default is flagship class, so an unstated model is gated too.
  expect(claudeModelGatedByFlagshipWeekly(null)).toBeTrue();
  expect(claudeModelGatedByFlagshipWeekly(undefined)).toBeTrue();
  expect(claudeModelGatedByFlagshipWeekly("fable")).toBeTrue();
  expect(claudeModelGatedByFlagshipWeekly("claude-fable-5-1")).toBeTrue();
  expect(claudeModelGatedByFlagshipWeekly("opus")).toBeTrue();
  expect(claudeModelGatedByFlagshipWeekly("claude-opus-5")).toBeTrue();
  expect(claudeModelGatedByFlagshipWeekly("sonnet")).toBeFalse();
  expect(claudeModelGatedByFlagshipWeekly("claude-haiku-4-5-20251001")).toBeFalse();
});

test("a provider tier bucket names its row by the tier, capitalised when unknown", () => {
  expect(claudeTierDisplayName("opus")).toBe("Opus");
  expect(claudeTierDisplayName("fable")).toBe("Fable");
  expect(claudeTierDisplayName("mythos")).toBe("Mythos");
  expect(claudeTierDisplayName("sonnet")).toBe("Sonnet");
  expect(claudeTierDisplayName("nova")).toBe("Nova");
});
