import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { RoleConfig } from "@/lib/roles/types";

import { PipelineDialog, stagesFromTemplate, templateReady } from "./PipelineDialog";
import { PIPELINE_TEMPLATES } from "./pipelineModel";
import type { RoleCatalogItem } from "./StageRow";

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

test("role-seeded templates wait for the catalog; role-less ones are always ready", () => {
  /* Applying planBuildReview before /api/roles resolves would strip every role. */
  expect(templateReady(planBuildReview, [])).toBe(false);
  expect(templateReady(planBuildReview, CATALOG)).toBe(true);
  /* The blank template seeds no roles, so it needs nothing loaded. */
  expect(templateReady(blank, [])).toBe(true);
});
