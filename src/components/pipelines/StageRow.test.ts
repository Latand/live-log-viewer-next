import { describe, expect, test } from "bun:test";

import type { RoleConfig } from "@/lib/roles/types";

import { paramChangeRuntime, roleRuntime, type RoleCatalogItem } from "./StageRow";

function role(id: string, config: RoleConfig): RoleCatalogItem {
  return { id, name: id, description: "", config, parameters: [], capabilities: ["read-write"], promptScaffold: "", safetyFences: [], promptPreview: "" } as unknown as RoleCatalogItem;
}

const builder = role("builder", { engine: "codex", model: "gpt-5.6-sol", effort: "medium" });
const architect = role("architect", { engine: "claude", model: "fable", effort: "high" });

describe("paramChangeRuntime (§1.3 explicit runtime wins over autofill)", () => {
  test("Builder domain=frontend autofills the Opus runtime when not overridden", () => {
    expect(paramChangeRuntime(builder, { domain: "frontend" }, false)).toEqual(roleRuntime(builder, { domain: "frontend" }));
    expect(paramChangeRuntime(builder, { domain: "frontend" }, false)).toMatchObject({ engine: "claude", model: "opus" });
  });

  test("Builder mode=apply-fixes autofills the Terra runtime when not overridden", () => {
    expect(paramChangeRuntime(builder, { mode: "apply-fixes" }, false)).toMatchObject({ engine: "codex", model: "gpt-5.6-terra", effort: "low" });
  });

  test("an explicit operator override freezes the runtime through a param change", () => {
    /* The operator hand-picked a runtime; changing domain/mode must not clobber it. */
    expect(paramChangeRuntime(builder, { domain: "frontend" }, true)).toBeNull();
    expect(paramChangeRuntime(builder, { mode: "apply-fixes" }, true)).toBeNull();
  });

  test("non-Builder roles never re-autofill on a param change", () => {
    expect(paramChangeRuntime(architect, { domain: "frontend" }, false)).toBeNull();
    expect(paramChangeRuntime(null, { domain: "frontend" }, false)).toBeNull();
  });
});
