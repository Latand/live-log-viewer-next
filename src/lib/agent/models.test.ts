import { expect, test } from "bun:test";

import {
  CODEX_SOL_MODEL,
  CODEX_TERRA_MODEL,
  defaultModelFor,
  ENGINE_MODELS,
  modelFromBody,
  normalizeClaudeLaunchModel,
} from "./models";

test("the Codex catalog exposes Sol for review and Terra for implementation", () => {
  expect(ENGINE_MODELS.codex).toEqual([
    { id: CODEX_SOL_MODEL, label: "GPT-5.6-Sol", use: "review" },
    { id: CODEX_TERRA_MODEL, label: "GPT-5.6-Terra", use: "implement" },
  ]);
  expect(defaultModelFor("codex")).toBe(CODEX_SOL_MODEL);
  expect(defaultModelFor("claude")).toBe("");
});

test("spawn model validation accepts CLI ids and rejects control characters", () => {
  expect(modelFromBody({ model: " gpt-5.6-terra " })).toEqual({ model: CODEX_TERRA_MODEL });
  expect(modelFromBody({})).toEqual({ model: null });
  expect(modelFromBody({ model: "terra\n--help" }).error).toBeDefined();
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
