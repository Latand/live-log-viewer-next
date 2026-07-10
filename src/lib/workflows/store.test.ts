import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AgentRegistry } from "@/lib/agent/registry";

/* The state dir must point at a sandbox before store.ts computes its
   module-level constants, so the store loads dynamically after the env set. */
process.env.LLV_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "llv-wf-store-test-"));
const { buildWorkflow, DEFAULT_FIXER, loadTemplates, loadWorkflows, mergeSeededTemplates, normalizeStages, normalizeTemplate, reconcileWorkflowConversationOwnership, roleConfigFromReference, saveWorkflows } =
  await import("./store");

type WorkflowTemplate = import("./types").WorkflowTemplate;

afterAll(() => {
  fs.rmSync(process.env.LLV_STATE_DIR!, { recursive: true, force: true });
});

const IMPLEMENT = {
  kind: "implement",
  agent: { engine: "codex", model: null, effort: "xhigh" },
  scope: "Backend/API",
} as const;

const REVIEW = {
  kind: "review-loop",
  reviewer: { engine: "codex", model: null, effort: "xhigh" },
  fixer: { engine: "codex", model: null, effort: "low" },
  roundLimit: 5,
  reviewerMode: "headless",
} as const;

test("normalizeStages accepts implement+ then one closing review-loop", () => {
  const ok = normalizeStages([IMPLEMENT, IMPLEMENT, REVIEW]);
  expect("stages" in ok && ok.stages.length).toBe(3);
});

test("normalizeStages rejects a pipeline without a review-loop", () => {
  const res = normalizeStages([IMPLEMENT, IMPLEMENT]);
  expect("error" in res).toBe(true);
});

test("normalizeStages rejects a review-loop that is not last", () => {
  const res = normalizeStages([REVIEW, IMPLEMENT]);
  expect("error" in res).toBe(true);
});

test("normalizeStages rejects a second review-loop", () => {
  const res = normalizeStages([IMPLEMENT, REVIEW, REVIEW]);
  expect("error" in res).toBe(true);
});

test("normalizeStages injects the codex-low fixer default and review defaults", () => {
  const res = normalizeStages([IMPLEMENT, { kind: "review-loop", reviewer: { engine: "claude", model: "fable" } }]);
  if ("error" in res) throw new Error(res.error);
  const review = res.stages[1]!;
  if (review.kind !== "review-loop") throw new Error("expected review stage");
  expect(review.fixer).toEqual(DEFAULT_FIXER);
  expect(review.roundLimit).toBe(5);
  expect(review.reviewerMode).toBe("headless");
});

test("fixer overrides keep the W5 contract: always codex at low effort", () => {
  const claudeFixer = normalizeStages([IMPLEMENT, { ...REVIEW, fixer: { engine: "claude", model: "fable", effort: null } }]);
  if ("error" in claudeFixer) throw new Error(claudeFixer.error);
  const claudeStage = claudeFixer.stages[1]!;
  if (claudeStage.kind !== "review-loop") throw new Error("expected review stage");
  expect(claudeStage.fixer).toEqual(DEFAULT_FIXER);

  /* A codex fixer may pick its model; the effort still clamps to low. */
  const codexFixer = normalizeStages([IMPLEMENT, { ...REVIEW, fixer: { engine: "codex", model: "gpt-5.5", effort: "xhigh" } }]);
  if ("error" in codexFixer) throw new Error(codexFixer.error);
  const codexStage = codexFixer.stages[1]!;
  if (codexStage.kind !== "review-loop") throw new Error("expected review stage");
  expect(codexStage.fixer).toEqual({ engine: "codex", model: "gpt-5.5", effort: "low" });
});

test("normalizeTemplate defaults finish to pr and trims optional commands", () => {
  const template = normalizeTemplate({ name: " demo ", stages: [IMPLEMENT, REVIEW], setup: " bun install " });
  expect(template?.name).toBe("demo");
  expect(template?.finish).toBe("pr");
  expect(template?.setup).toBe("bun install");
  expect(template?.verify).toBeUndefined();
});

test("normalizeTemplate rejects an invalid stage list", () => {
  expect(normalizeTemplate({ name: "bad", stages: [IMPLEMENT] })).toBeNull();
});

test("workflow role references resolve to a frozen effective config", () => {
  expect(roleConfigFromReference({ role: "builder", roleParams: { mode: "tdd" } })).toEqual({
    engine: "codex",
    model: "gpt-5.6-sol",
    effort: "medium",
  });
  const template = normalizeTemplate({ name: "role template", stages: [
    { kind: "implement", role: "builder", roleParams: { mode: "plain" }, scope: "Backend/API" },
    { kind: "review-loop", role: "reviewer", roleParams: { diffSource: "main...HEAD", lens: "all" } },
  ] });
  expect(template?.stages[0]).toMatchObject({ agent: { model: "gpt-5.6-sol", effort: "medium" } });
  expect(template?.stages[1]).toMatchObject({ reviewer: { model: "gpt-5.6-sol", effort: "xhigh" } });
});

test("templates seed the canonical fullstack pipeline on first load", () => {
  const templates = loadTemplates();
  expect(templates.map((template) => template.name)).toContain("fullstack");
  const fullstack = templates.find((template) => template.name === "fullstack")!;
  expect(fullstack.stages.at(-1)?.kind).toBe("review-loop");
  expect(fullstack.stages[0]?.kind === "implement" && fullstack.stages[0].agent).toMatchObject({ model: "gpt-5.6-sol", effort: "medium" });
  expect(fullstack.stages[1]?.kind === "implement" && fullstack.stages[1].agent.model).toBe("opus");
  const review = fullstack.stages.at(-1)!;
  expect(review.kind === "review-loop" && review.reviewer.model).toBe("gpt-5.6-sol");
  expect(templates.map((template) => template.name)).toContain("Sol medium → Sol xhigh review");
});

test("template seed migration upgrades the untouched legacy fullstack definition", () => {
  const legacy = normalizeTemplate({
    name: "fullstack",
    setup: "bun install",
    verify: "bun test && bun run build",
    finish: "pr",
    stages: [
      {
        kind: "implement",
        agent: { engine: "codex", model: null, effort: "high" },
        scope: "Backend/API: server logic, data layer, API routes. Leave UI components alone.",
      },
      {
        kind: "implement",
        agent: { engine: "claude", model: "fable", effort: null },
        scope: "UI/frontend: components, hooks, styling, i18n labels. Build on the backend contract from the previous stage.",
      },
      {
        kind: "review-loop",
        reviewer: { engine: "codex", model: null, effort: "xhigh" },
        fixer: { engine: "codex", model: null, effort: "low" },
        roundLimit: 5,
        reviewerMode: "headless",
      },
    ],
  })!;
  const merged = mergeSeededTemplates([legacy]);
  const fullstack = merged.find((template) => template.name === "fullstack")!;
  expect(fullstack.stages[0]?.kind === "implement" && fullstack.stages[0].agent.model).toBe("gpt-5.6-sol");
});

test("an untouched pre-registry workflow template updates from role defaults", () => {
  const previous = normalizeTemplate({
    name: "Terra → Sol review",
    verify: "bun test && bun run build",
    finish: "pr",
    stages: [
      { kind: "implement", agent: { engine: "codex", model: "gpt-5.6-terra", effort: "high" }, scope: "Implement the requested change end to end, including focused tests and documentation updates." },
      { kind: "review-loop", reviewer: { engine: "codex", model: "gpt-5.6-sol", effort: "xhigh" }, fixer: { engine: "codex", model: "gpt-5.6-terra", effort: "low" }, roundLimit: 5, reviewerMode: "headless" },
    ],
  })!;
  const migrated = mergeSeededTemplates([previous]).find((template) => template.name === "Sol medium → Sol xhigh review")!;
  expect(migrated.stages[0]).toMatchObject({ agent: { model: "gpt-5.6-sol", effort: "medium" } });
});


test("workflows round-trip through the store", () => {
  const template = normalizeTemplate({ name: "demo", stages: [IMPLEMENT, REVIEW], finish: "merge" })!;
  const wf = buildWorkflow({
    id: "abcd1234",
    name: "demo",
    task: "Fix the login flow",
    project: "repo",
    repoDir: "/home/user/proj/repo",
    template,
    mode: "manual",
    now: "2026-07-05T00:00:00.000Z",
  });
  saveWorkflows([wf]);
  const loaded = loadWorkflows();
  expect(loaded).toEqual([wf]);
});

test("workflow bindings follow the active conversation generation", () => {
  const registry = new AgentRegistry(path.join(process.env.LLV_STATE_DIR!, "workflow-registry.json"));
  const owner = registry.ensureConversation("codex", "/stage-a.jsonl", "a");
  registry.setConversationMigration(owner.id, { intentId: "workflow", phase: "verifying", targetId: "b", revision: 1, error: null, updatedAt: "now" });
  registry.commitSuccessor(owner.id, { id: "stage-b", path: "/stage-b.jsonl", accountId: "b" }, 1);
  const template = normalizeTemplate({ name: "owner-demo", stages: [IMPLEMENT, REVIEW] })!;
  const workflow = buildWorkflow({ id: "owner123", name: "owner-demo", task: "Ship", project: "repo", repoDir: "/repo", template, mode: "manual", now: "now" });
  workflow.srcPath = "/stage-a.jsonl";
  workflow.srcConversationId = owner.id;
  workflow.fixerPath = "/stage-a.jsonl";
  workflow.fixerConversationId = owner.id;
  workflow.stageRuns[0]!.agentPath = "/stage-a.jsonl";
  workflow.stageRuns[0]!.agentConversationId = owner.id;
  saveWorkflows([workflow]);

  reconcileWorkflowConversationOwnership(registry);

  const reconciled = loadWorkflows()[0]!;
  expect(reconciled).toMatchObject({
    srcPath: "/stage-b.jsonl",
    fixerPath: "/stage-b.jsonl",
  });
  expect(reconciled.stageRuns[0]).toMatchObject({ agentPath: "/stage-b.jsonl", agentConversationId: owner.id });
});

test("buildWorkflow derives sibling worktree dir and wf/ branch from the task", () => {
  const template = normalizeTemplate({ name: "demo", stages: [IMPLEMENT, REVIEW] })!;
  const wf = buildWorkflow({
    id: "abcd1234",
    name: "demo",
    task: "Fix the LOGIN flow!!",
    project: "repo",
    repoDir: "/home/user/proj/repo",
    template,
    mode: "auto",
    now: "2026-07-05T00:00:00.000Z",
  });
  expect(wf.worktreeDir).toBe("/home/user/proj/repo-wf-abcd1234");
  expect(wf.branch).toBe("wf/fix-the-login-flow-abcd1234");
  expect(wf.stageRuns.length).toBe(2);
  expect(wf.state).toBe("provisioning");
});

test("buildWorkflow freezes the template: later template mutation stays invisible", () => {
  const template = normalizeTemplate({ name: "demo", stages: [IMPLEMENT, REVIEW] }) as WorkflowTemplate;
  const wf = buildWorkflow({
    id: "abcd1234",
    name: "demo",
    task: "task",
    project: "repo",
    repoDir: "/home/user/proj/repo",
    template,
    mode: "auto",
    now: "2026-07-05T00:00:00.000Z",
  });
  const stage = template.stages[0]!;
  if (stage.kind === "implement") stage.scope = "MUTATED";
  template.name = "mutated";
  const frozen = wf.template.stages[0]!;
  expect(frozen.kind === "implement" && frozen.scope).toBe("Backend/API");
  expect(wf.template.name).toBe("demo");
});
