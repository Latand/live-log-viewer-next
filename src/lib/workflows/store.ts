import fs from "node:fs";
import path from "node:path";

import { statePath } from "@/lib/configDir";
import { CODEX_SOL_MODEL, CODEX_TERRA_MODEL } from "@/lib/agent/models";
import { agentRegistry, type AgentRegistry } from "@/lib/agent/registry";
import type { RoleConfig } from "@/lib/flows/types";
import { atomicWriteText } from "@/lib/flows/store";

import type { FinishAction, ImplementStage, ReviewStage, Workflow, WorkflowStage, WorkflowTemplate } from "./types";

const WORKFLOWS_FILE = statePath("workflows.json");
const TEMPLATES_FILE = statePath("workflow-templates.json");
const ARTIFACT_DIR = statePath("workflows");

/** The hard fixer default (W5): Terra supplies fast hands for applying findings. */
export const DEFAULT_FIXER: RoleConfig = { engine: "codex", model: CODEX_TERRA_MODEL, effort: "low" };

/* The user's canonical template (design doc example), seeded on first load
   the way flow presets are. */
const LEGACY_SEEDED_TEMPLATES: WorkflowTemplate[] = [
  {
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
  },
];

export const SEEDED_TEMPLATES: WorkflowTemplate[] = [
  {
    name: "fullstack",
    setup: "bun install",
    verify: "bun test && bun run build",
    finish: "pr",
    stages: [
      {
        kind: "implement",
        agent: { engine: "codex", model: CODEX_TERRA_MODEL, effort: "high" },
        scope: "Backend/API: server logic, data layer, API routes. Leave UI components alone.",
      },
      {
        kind: "implement",
        agent: { engine: "claude", model: "fable", effort: null },
        scope: "UI/frontend: components, hooks, styling, i18n labels. Build on the backend contract from the previous stage.",
      },
      {
        kind: "review-loop",
        reviewer: { engine: "codex", model: CODEX_SOL_MODEL, effort: "xhigh" },
        fixer: { ...DEFAULT_FIXER },
        roundLimit: 5,
        reviewerMode: "headless",
      },
    ],
  },
  {
    name: "Terra → Sol review",
    verify: "bun test && bun run build",
    finish: "pr",
    stages: [
      {
        kind: "implement",
        agent: { engine: "codex", model: CODEX_TERRA_MODEL, effort: "high" },
        scope: "Implement the requested change end to end, including focused tests and documentation updates.",
      },
      {
        kind: "review-loop",
        reviewer: { engine: "codex", model: CODEX_SOL_MODEL, effort: "xhigh" },
        fixer: { ...DEFAULT_FIXER },
        roundLimit: 5,
        reviewerMode: "headless",
      },
    ],
  },
];

type WorkflowFile = { workflows?: unknown };
type TemplateFile = { templates?: unknown };

function atomicWriteJson(filePath: string, value: unknown): void {
  atomicWriteText(filePath, JSON.stringify(value, null, 2) + "\n");
}

function readJson(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  } catch {
    return null;
  }
}

function roleOf(value: unknown): RoleConfig | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const role = value as Partial<RoleConfig>;
  if (role.engine !== "claude" && role.engine !== "codex") return null;
  return {
    engine: role.engine,
    model: typeof role.model === "string" && role.model.trim() ? role.model.trim() : null,
    effort: typeof role.effort === "string" && role.effort.trim() ? role.effort.trim() : null,
  };
}

function implementStageOf(value: Partial<ImplementStage>): ImplementStage | null {
  const agent = roleOf(value.agent);
  if (!agent || typeof value.scope !== "string" || !value.scope.trim()) return null;
  return { kind: "implement", agent, scope: value.scope.trim() };
}

/** W5 holds regardless of what the templates file says: the fixer is always
    codex at low effort. A codex fixer may still name a model; anything else
    collapses to the default. */
function normalizeFixer(value: unknown): RoleConfig {
  const role = roleOf(value);
  if (!role || role.engine !== "codex") return { ...DEFAULT_FIXER };
  return { engine: "codex", model: role.model, effort: "low" };
}

/** Missing fixer/limits fall back to the W5/W9 defaults instead of failing. */
function reviewStageOf(value: Partial<ReviewStage>): ReviewStage | null {
  const reviewer = roleOf(value.reviewer);
  if (!reviewer) return null;
  return {
    kind: "review-loop",
    reviewer,
    fixer: normalizeFixer(value.fixer),
    roundLimit: Number.isInteger(value.roundLimit) && (value.roundLimit as number) >= 0 ? Math.min(value.roundLimit as number, 50) : 5,
    reviewerMode: value.reviewerMode === "pane" ? "pane" : "headless",
  };
}

export function normalizeStage(value: unknown): WorkflowStage | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const kind = (value as { kind?: unknown }).kind;
  if (kind === "implement") return implementStageOf(value as Partial<ImplementStage>);
  if (kind === "review-loop") return reviewStageOf(value as Partial<ReviewStage>);
  return null;
}

/**
 * Stage-list validation per W1: at least one implement stage, then exactly
 * one review-loop as the closing stage. Returns the normalized list (fixer
 * default injected) or an error message.
 */
export function normalizeStages(value: unknown): { stages: WorkflowStage[] } | { error: string } {
  if (!Array.isArray(value) || value.length < 2) {
    return { error: "a workflow needs at least one implement stage and a closing review-loop" };
  }
  const stages: WorkflowStage[] = [];
  for (const raw of value) {
    const stage = normalizeStage(raw);
    if (!stage) return { error: "invalid stage definition" };
    stages.push(stage);
  }
  const reviewCount = stages.filter((stage) => stage.kind === "review-loop").length;
  if (reviewCount !== 1 || stages.at(-1)?.kind !== "review-loop") {
    return { error: "stages must be implement+ followed by exactly one review-loop last" };
  }
  return { stages };
}

export function normalizeTemplate(value: unknown): WorkflowTemplate | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Partial<WorkflowTemplate>;
  if (typeof raw.name !== "string" || !raw.name.trim()) return null;
  const normalized = normalizeStages(raw.stages);
  if ("error" in normalized) return null;
  const finish: FinishAction = raw.finish === "merge" ? "merge" : "pr";
  return {
    name: raw.name.trim(),
    stages: normalized.stages,
    finish,
    ...(typeof raw.setup === "string" && raw.setup.trim() ? { setup: raw.setup.trim() } : {}),
    ...(typeof raw.verify === "string" && raw.verify.trim() ? { verify: raw.verify.trim() } : {}),
  };
}

function isWorkflow(value: unknown): value is Workflow {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const wf = value as Partial<Workflow>;
  return (
    typeof wf.id === "string" &&
    typeof wf.task === "string" &&
    typeof wf.repoDir === "string" &&
    typeof wf.worktreeDir === "string" &&
    typeof wf.branch === "string" &&
    Array.isArray(wf.stageRuns) &&
    typeof wf.stageIndex === "number" &&
    normalizeTemplate(wf.template) !== null
  );
}

export function loadWorkflows(): Workflow[] {
  const raw = readJson(WORKFLOWS_FILE) as WorkflowFile | null;
  const workflows = Array.isArray(raw?.workflows) ? raw.workflows.filter(isWorkflow) : [];
  return workflows.map((wf) => ({
    ...wf,
    project: wf.project ?? "",
    pausedState: wf.pausedState ?? null,
    setupPid: wf.setupPid ?? null,
    srcPath: wf.srcPath ?? null,
    srcConversationId: wf.srcConversationId ?? null,
    flowId: wf.flowId ?? null,
    fixerPath: wf.fixerPath ?? null,
    fixerConversationId: wf.fixerConversationId ?? null,
    stageRuns: wf.stageRuns.map((run) => ({ ...run, agentConversationId: run.agentConversationId ?? null })),
    prUrl: wf.prUrl ?? null,
  }));
}

export function reconcileWorkflowConversationOwnership(registry: AgentRegistry = agentRegistry()): void {
  const workflows = loadWorkflows();
  let dirty = false;
  for (const workflow of workflows) {
    if (workflow.srcConversationId?.startsWith("conversation_")) {
      const current = registry.conversation(workflow.srcConversationId as `conversation_${string}`)?.generations.at(-1)?.path;
      if (current && current !== workflow.srcPath) { workflow.srcPath = current; dirty = true; }
    } else if (workflow.srcPath) {
      const owner = registry.conversationForPath(workflow.srcPath);
      if (owner) { workflow.srcConversationId = owner.id; dirty = true; }
    }
    if (workflow.fixerConversationId?.startsWith("conversation_")) {
      const current = registry.conversation(workflow.fixerConversationId as `conversation_${string}`)?.generations.at(-1)?.path;
      if (current && current !== workflow.fixerPath) { workflow.fixerPath = current; dirty = true; }
    } else if (workflow.fixerPath) {
      const owner = registry.conversationForPath(workflow.fixerPath);
      if (owner) { workflow.fixerConversationId = owner.id; dirty = true; }
    }
    for (const run of workflow.stageRuns) {
      if (run.agentConversationId?.startsWith("conversation_")) {
        const current = registry.conversation(run.agentConversationId as `conversation_${string}`)?.generations.at(-1)?.path;
        if (current && current !== run.agentPath) { run.agentPath = current; dirty = true; }
      } else if (run.agentPath) {
        const owner = registry.conversationForPath(run.agentPath);
        if (owner) { run.agentConversationId = owner.id; dirty = true; }
      }
    }
  }
  if (dirty) saveWorkflows(workflows);
}

export function saveWorkflows(workflows: Workflow[]): void {
  atomicWriteJson(WORKFLOWS_FILE, { workflows });
}

export function loadTemplates(): WorkflowTemplate[] {
  const raw = readJson(TEMPLATES_FILE) as TemplateFile | null;
  const templates = Array.isArray(raw?.templates)
    ? raw.templates.map(normalizeTemplate).filter((template): template is WorkflowTemplate => template !== null)
    : [];
  const merged = mergeSeededTemplates(templates);
  if (JSON.stringify(merged) !== JSON.stringify(templates)) saveTemplates(merged);
  return merged;
}

export function saveTemplates(templates: WorkflowTemplate[]): void {
  atomicWriteJson(TEMPLATES_FILE, { templates });
}

/** Upgrade untouched built-in templates and keep user-authored definitions. */
export function mergeSeededTemplates(templates: WorkflowTemplate[]): WorkflowTemplate[] {
  const legacy = new Set(LEGACY_SEEDED_TEMPLATES.map((template) => JSON.stringify(normalizeTemplate(template))));
  const custom = templates.filter((template) => !legacy.has(JSON.stringify(template)));
  const names = new Set(custom.map((template) => template.name));
  const missingSeeds = SEEDED_TEMPLATES.filter((template) => !names.has(template.name));
  return [...missingSeeds, ...custom];
}

function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return slug || "task";
}

/**
 * A fresh Workflow record for launch: branch and worktree names derive from
 * the task and the id (W3), and the template is deep-copied so later edits to
 * the templates file never mutate a running workflow (W8).
 */
export function buildWorkflow(input: {
  id: string;
  name: string;
  task: string;
  project: string;
  repoDir: string;
  template: WorkflowTemplate;
  mode: "auto" | "manual";
  now: string;
}): Workflow {
  const repoName = path.basename(input.repoDir);
  return {
    id: input.id,
    name: input.name,
    task: input.task,
    project: input.project,
    repoDir: input.repoDir,
    worktreeDir: path.join(path.dirname(input.repoDir), `${repoName}-wf-${input.id}`),
    branch: `wf/${slugify(input.task)}-${input.id}`,
    baseBranch: "",
    baseRef: "",
    template: JSON.parse(JSON.stringify(input.template)) as WorkflowTemplate,
    stageRuns: input.template.stages.map((_, index) => ({
      index,
      agentPath: null,
      agentConversationId: null,
      paneId: null,
      startedAt: null,
      doneAt: null,
      doneNote: null,
    })),
    stageIndex: 0,
    flowId: null,
    fixerPath: null,
    fixerConversationId: null,
    state: "provisioning",
    pausedState: null,
    stateDetail: null,
    mode: input.mode,
    setupPid: null,
    srcPath: null,
    srcConversationId: null,
    prUrl: null,
    createdAt: input.now,
    closedAt: null,
  };
}

export function workflowArtifactsDir(workflowId: string): string {
  return path.join(ARTIFACT_DIR, workflowId);
}

export function setupStdoutPath(workflowId: string): string {
  return path.join(workflowArtifactsDir(workflowId), "setup-stdout.log");
}

export function setupStderrPath(workflowId: string): string {
  return path.join(workflowArtifactsDir(workflowId), "setup-stderr.log");
}

export function setupExitPath(workflowId: string): string {
  return path.join(workflowArtifactsDir(workflowId), "setup-exit");
}
