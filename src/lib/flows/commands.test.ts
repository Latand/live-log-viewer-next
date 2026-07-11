import { expect, test } from "bun:test";

import { applyRoleOverride, normalizeFlowSpec } from "./commands";
import type { RoleConfig } from "./types";

test("flow spec request accepts trimmed text and rejects non-text input", () => {
  expect(normalizeFlowSpec("  Add reviewer context\nAC1: Include it every round  ")).toEqual({
    ok: true,
    spec: "Add reviewer context\nAC1: Include it every round",
  });
  expect(normalizeFlowSpec(undefined)).toEqual({ ok: true });
  expect(normalizeFlowSpec(["AC1"])).toEqual({ ok: false });
});

const base: RoleConfig = { engine: "codex", model: "gpt-5.6", effort: "high" };

test("applyRoleOverride merges only the provided fields and blanks to null (issue #118)", () => {
  /* A partial override touches just the reviewer model, keeping engine/effort. */
  expect(applyRoleOverride(base, { model: "fable" })).toEqual({ engine: "codex", model: "fable", effort: "high" });
  /* An explicit blank model/effort resolves to the engine default (null). */
  expect(applyRoleOverride(base, { model: "  ", effort: "" })).toEqual({ engine: "codex", model: null, effort: null });
  /* Reseating the engine is allowed. */
  expect(applyRoleOverride(base, { engine: "claude", model: "opus" })).toEqual({ engine: "claude", model: "opus", effort: "high" });
});

test("applyRoleOverride rejects an unknown engine and non-object patches", () => {
  expect(applyRoleOverride(base, { engine: "gemini" as never })).toBeNull();
  expect(applyRoleOverride(base, null)).toBeNull();
  expect(applyRoleOverride(base, [])).toBeNull();
  expect(applyRoleOverride(base, { model: 5 as never })).toBeNull();
});
