import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveRole } from "./registry";

import { loadRoleDefinitions, loadRoleOverrides, saveRoleOverrides } from "./store";

test("role overrides persist with a schema version and merge only the selected role", () => {
  const previous = process.env.LLV_STATE_DIR;
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "llv-role-store-"));
  process.env.LLV_STATE_DIR = state;
  try {
    saveRoleOverrides({ builder: { config: { model: "gpt-custom-builder" }, promptScaffold: "Custom {{mode}} scaffold" } });
    expect(JSON.parse(fs.readFileSync(path.join(state, "role-presets.json"), "utf8"))).toMatchObject({
      schemaVersion: 1,
      overrides: { builder: { config: { model: "gpt-custom-builder" } } },
    });
    expect(loadRoleOverrides().schemaVersion).toBe(1);
    const builder = loadRoleDefinitions().find((role) => role.id === "builder")!;
    const reviewer = loadRoleDefinitions().find((role) => role.id === "reviewer")!;
    expect(builder.config.model).toBe("gpt-custom-builder");
    expect(builder.promptScaffold).toBe("Custom {{mode}} scaffold");
    expect(reviewer.config.model).toBe("gpt-6-astra");
  } finally {
    if (previous === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previous;
    fs.rmSync(state, { recursive: true, force: true });
  }
});

test("role overrides fail closed and preserve malformed or future-schema bytes", () => {
  const previous = process.env.LLV_STATE_DIR;
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "llv-role-store-corrupt-"));
  process.env.LLV_STATE_DIR = state;
  const file = path.join(state, "role-presets.json");
  try {
    for (const content of [
      "{",
      JSON.stringify({ schemaVersion: 2, overrides: {} }),
      JSON.stringify({ schemaVersion: 1, overrides: { builder: { config: { engine: "invalid" } } } }),
      JSON.stringify({ schemaVersion: 1, overrides: { builder: { config: { model: "fable", effort: "banana" } } } }),
      JSON.stringify({ schemaVersion: 1, overrides: { builder: { unexpected: true } } }),
    ]) {
      fs.writeFileSync(file, content, "utf8");
      expect(() => loadRoleOverrides()).toThrow();
      expect(fs.readFileSync(file, "utf8")).toBe(content);
    }
  } finally {
    if (previous === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previous;
    fs.rmSync(state, { recursive: true, force: true });
  }
});

for (const effort of ["max", "ultra"]) {
  test(`Astra orchestrator preset at ${effort} persists and resolves`, () => {
    const previous = process.env.LLV_STATE_DIR;
    const state = fs.mkdtempSync(path.join(os.tmpdir(), "llv-astra-preset-"));
    process.env.LLV_STATE_DIR = state;
    try {
      const config = { engine: "codex" as const, model: "gpt-6-astra", effort };
      saveRoleOverrides({ orchestrator: { config }, builder: { config: { model: "gpt-5.6-sol" } } });
      expect(loadRoleOverrides().overrides.orchestrator?.config).toEqual(config);
      expect(resolveRole("orchestrator")).toMatchObject({ ok: true, value: { config } });
      expect(resolveRole("builder")).toMatchObject({ ok: true, value: { config: { model: "gpt-5.6-sol" } } });
      expect(JSON.parse(fs.readFileSync(path.join(state, "role-presets.json"), "utf8")).overrides.orchestrator.config).toEqual(config);
    } finally {
      if (previous === undefined) delete process.env.LLV_STATE_DIR;
      else process.env.LLV_STATE_DIR = previous;
      fs.rmSync(state, { recursive: true, force: true });
    }
  });
}

for (const [engine, model] of [["codex", "gpt-5.6-luna"], ["claude", "opus"]] as const) {
  test(`orchestrator preset refuses ${model}/ultra on save and load with model options`, () => {
    const previous = process.env.LLV_STATE_DIR;
    const state = fs.mkdtempSync(path.join(os.tmpdir(), "llv-invalid-preset-"));
    process.env.LLV_STATE_DIR = state;
    try {
      const overrides = { orchestrator: { config: { engine, model, effort: "ultra" } } };
      const message = `effort for ${engine}/${model} must be one of: low, medium, high, xhigh, max`;
      expect(() => saveRoleOverrides(overrides)).toThrow(message);
      const file = path.join(state, "role-presets.json");
      const bytes = JSON.stringify({ schemaVersion: 1, overrides });
      fs.writeFileSync(file, bytes);
      expect(() => loadRoleOverrides()).toThrow(message);
      expect(fs.readFileSync(file, "utf8")).toBe(bytes);
    } finally {
      if (previous === undefined) delete process.env.LLV_STATE_DIR;
      else process.env.LLV_STATE_DIR = previous;
      fs.rmSync(state, { recursive: true, force: true });
    }
  });
}
