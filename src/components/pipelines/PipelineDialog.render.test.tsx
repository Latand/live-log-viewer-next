import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { RoleConfig } from "@/lib/roles/types";

import type { TFunction } from "@/lib/i18n";
import type { RoleParameter } from "@/lib/roles/types";

import { PipelineDialog, coerceStage, pipelineValidationError, roleParamError, stagesFromTemplate, templateReady } from "./PipelineDialog";
import { PIPELINE_TEMPLATES, type DraftStage } from "./pipelineModel";
import type { RoleCatalogItem } from "./StageRow";

const fakeT = ((key: string, vars?: Record<string, unknown>) => (vars ? `${key}:${JSON.stringify(vars)}` : key)) as unknown as TFunction;
const stage = (over: Partial<DraftStage>): DraftStage => ({ key: "k", kind: "run", roleId: "", engine: "codex", model: "", effort: "", access: "read-write", prompt: "do it", roleParams: {}, ...over });

const FALLBACK: RoleConfig = { engine: "codex", model: "gpt-5.6-sol", effort: "medium" };

function role(id: string, config: RoleConfig): RoleCatalogItem {
  return { id, name: id, description: "", config, parameters: [], capabilities: id === "reviewer" ? ["read-only"] : ["read-write"], promptScaffold: "", safetyFences: [], promptPreview: "" } as unknown as RoleCatalogItem;
}

const CATALOG: RoleCatalogItem[] = [
  role("architect", { engine: "claude", model: "fable", effort: "high" }),
  role("builder", { engine: "codex", model: "gpt-5.6-sol", effort: "medium" }),
  role("reviewer", { engine: "codex", model: "gpt-5.6-sol", effort: "xhigh" }),
];

const planBuildReview = PIPELINE_TEMPLATES.find((template) => template.id === "planBuildReview")!;
const blank = PIPELINE_TEMPLATES.find((template) => template.id === "blank")!;

/* SSR runs no effects (roles/dirs stay empty) and has no sessionStorage, so the
   dialog renders its fresh two-Run-stage default. Interactive behavior (role
   autofill, reorder, template fill, POST) lives in the browser; here we assert
   the static structure and the invariants baked into the markup. */
function render() {
  return renderToStaticMarkup(<PipelineDialog project="proj" onClose={() => {}} />);
}

test("renders the modal frame with task, spec and repository fields", () => {
  const html = render();
  expect(html).toContain('role="dialog"');
  expect(html).toContain('aria-modal="true"');
  expect(html).toContain("New pipeline");
  expect(html).toContain("Chain 2–4 agents on one task, one worktree");
  expect(html).toContain("What should this chain accomplish?");
});

test("opens with two Run stages and the four starter templates", () => {
  const html = render();
  expect(html).toContain("Stage 1");
  expect(html).toContain("Stage 2");
  expect(html).not.toContain("Stage 3");
  expect(html).toContain("Plan → Build → Review");
  expect(html).toContain("Build → Review");
  expect(html).toContain("Build → Verify");
  expect(html).toContain("Blank");
});

test("stage 1 cannot be a review-loop and cannot insert {{prev.output}}", () => {
  const html = render();
  /* Review-loop needs a preceding run — the whole error class killed in the UI. */
  expect(html).toContain("Review-loop needs a preceding run stage");
  expect(html).toContain('aria-disabled="true"');
  /* The prev-output chip is disabled on the first stage with its hint. */
  expect(html).toContain("no previous stage");
});

test("delete is disabled at the 2-stage floor", () => {
  const html = render();
  /* Both remove buttons carry disabled at the minimum stage count. */
  const removeDisabled = html.match(/Remove stage \d+"[^>]*disabled/g) ?? [];
  expect(removeDisabled.length).toBe(2);
});

test("the start and cancel controls are present", () => {
  const html = render();
  expect(html).toContain("Start pipeline");
  expect(html).toContain("Cancel");
});

test("a template seeds each role's own resolved runtime, not the Builder fallback", () => {
  const [architect, builder, reviewer] = stagesFromTemplate(planBuildReview, CATALOG, FALLBACK);
  /* The architect stage keeps its own model/effort so its runtime line is right. */
  expect(architect).toMatchObject({ roleId: "architect", engine: "claude", model: "fable", effort: "high" });
  expect(builder).toMatchObject({ roleId: "builder", model: "gpt-5.6-sol", effort: "medium" });
  expect(reviewer).toMatchObject({ roleId: "reviewer", kind: "review-loop", access: "read-only" });
});

test("pipelineValidationError mirrors the API's cross-engine model check", () => {
  const base = { task: "t", spec: "", repoDir: "/r", roles: [], defaultRuntime: FALLBACK };
  /* A Claude stage carrying a codex model would 400 server-side — block it. */
  const bad = pipelineValidationError(fakeT, { ...base, stages: [stage({ engine: "claude", model: "gpt-5.6-sol" }), stage({ key: "k2" })] });
  expect(bad).toContain("modelEngineMismatch");
  /* A Claude stage with a Claude model, and codex with a gpt model, both pass. */
  const ok = pipelineValidationError(fakeT, { ...base, stages: [stage({ engine: "claude", model: "opus" }), stage({ key: "k2", engine: "codex", model: "gpt-5.6-terra" })] });
  expect(ok).toBeNull();
});

test("pipelineValidationError enforces the API task-length cap", () => {
  const err = pipelineValidationError(fakeT, { task: "x".repeat(4_001), spec: "", repoDir: "/r", roles: [], defaultRuntime: FALLBACK, stages: [stage({}), stage({ key: "k2" })] });
  expect(err).toContain("tooLong");
});

test("pipelineValidationError mirrors the API's codex bounds and effort check", () => {
  const base = { task: "t", spec: "", repoDir: "/r", roles: [], defaultRuntime: FALLBACK };
  /* A codex model over 128 chars would 400; the client must catch it too. */
  const longModel = pipelineValidationError(fakeT, { ...base, stages: [stage({ engine: "codex", model: `gpt-${"x".repeat(200)}` }), stage({ key: "k2" })] });
  expect(longModel).toContain("modelEngineMismatch");
  /* max effort is valid on claude but not codex — the API rejects it, so does this. */
  const badEffort = pipelineValidationError(fakeT, { ...base, stages: [stage({ engine: "codex", effort: "max" }), stage({ key: "k2" })] });
  expect(badEffort).toContain("effortEngineMismatch");
  /* A codex-legal effort passes. */
  const ok = pipelineValidationError(fakeT, { ...base, stages: [stage({ engine: "codex", effort: "high" }), stage({ key: "k2" })] });
  expect(ok).toBeNull();
});

test("coerceStage repairs a malformed persisted stage instead of crashing on restore", () => {
  /* A stale draft missing model/roleParams and carrying wrong-typed fields must
     become a well-formed DraftStage, not blow up later on .trim()/property access. */
  const repaired = coerceStage({ kind: "bogus", engine: "nope", access: "sideways", model: 5, roleId: 7, roleParams: [1, 2] });
  expect(repaired).toMatchObject({ kind: "run", engine: "codex", access: "read-write", model: "", roleId: "", roleParams: {} });
  expect(() => repaired.model.trim()).not.toThrow();
  /* Valid fields survive; only string/number role params are kept. */
  const kept = coerceStage({ kind: "review-loop", engine: "claude", access: "read-only", roleParams: { a: "x", b: 2, c: { nested: true } } });
  expect(kept).toMatchObject({ kind: "review-loop", engine: "claude", access: "read-only", roleParams: { a: "x", b: 2 } });
  expect("c" in kept.roleParams).toBe(false);
});

test("roleParamError mirrors the API: values checked, absent allowed", () => {
  const select: RoleParameter = { key: "lens", label: "Lens", description: "", kind: "select", options: ["correctness", "scope"] };
  const integer: RoleParameter = { key: "parallelN", label: "Parallel passes", description: "", kind: "integer", min: 1, max: 8 };
  const text: RoleParameter = { key: "diffSource", label: "Diff source", description: "", kind: "text", required: true };
  /* Absent/blank resolves to a registry default server-side, so it is not blocked. */
  expect(roleParamError(text, "")).toBeNull();
  expect(roleParamError(text, undefined)).toBeNull();
  /* Supplied values are validated against options / bounds / length. */
  expect(roleParamError(select, "bogus")).toBe("pipelineDialog.errors.paramInvalid");
  expect(roleParamError(select, "scope")).toBeNull();
  expect(roleParamError(integer, 999)).toBe("pipelineDialog.errors.paramInvalid");
  expect(roleParamError(integer, 4)).toBeNull();
  expect(roleParamError(text, "x".repeat(2_001))).toBe("pipelineDialog.errors.paramInvalid");
  /* Whitespace-only text trims to empty → treated as absent (serializer drops
     it), matching the server rather than sneaking a value it would reject. */
  expect(roleParamError(text, "   ")).toBeNull();
});

test("role-seeded templates wait for the catalog; role-less ones are always ready", () => {
  /* Applying planBuildReview before /api/roles resolves would strip every role. */
  expect(templateReady(planBuildReview, [])).toBe(false);
  expect(templateReady(planBuildReview, CATALOG)).toBe(true);
  /* The blank template seeds no roles, so it needs nothing loaded. */
  expect(templateReady(blank, [])).toBe(true);
});
