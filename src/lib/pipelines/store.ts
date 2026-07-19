import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { statePath } from "@/lib/configDir";
import { isEngineEffort } from "@/lib/agent/efforts";
import { normalizeClaudeLaunchModel } from "@/lib/agent/models";
import { MAX_SCAFFOLD_LENGTH } from "@/lib/roles/store";

import { MAX_FAIL_EDGE_ROUNDS, MAX_PIPELINE_STAGES } from "./limits";
import type { EffectivePipelineRole, Pipeline, PipelineEdgeActivation, PipelineStage } from "./types";
import { stageVerdictFrom } from "./verdict";

export const PIPELINES_SCHEMA_VERSION = 3;
/** v2 (linear 2–4 stage chains) is migrated in memory on load; the file is
    rewritten as v3 by the next successful mutation, never by a read. */
const MIGRATABLE_SCHEMA_VERSIONS = new Set([2, PIPELINES_SCHEMA_VERSION]);
const pipelinesFile = () => statePath("pipelines.json");
const artifactsRoot = () => statePath("pipelines");

type PipelineFile = { schemaVersion: number; pipelines: Pipeline[] };
const PIPELINE_ROLE_IDS = ["orchestrator", "reviewer", "verifier", "builder", "architect", "cleaner", "prod-auditor", "deployer"] as const;

export class PipelineStoreError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PipelineStoreError";
  }
}

function atomicWriteJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", "utf8");
  fs.renameSync(temp, filePath);
}
function readJson(filePath: string): unknown | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new PipelineStoreError(`could not read pipeline registry: ${filePath}`, { cause: error });
  }
}

export function isEffectiveRole(value: unknown): value is EffectivePipelineRole {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const role = value as Partial<EffectivePipelineRole>;
  if (role.engine !== "claude" && role.engine !== "codex") return false;
  if (role.model !== null && typeof role.model !== "string") return false;
  if (role.model && role.engine === "claude" && !normalizeClaudeLaunchModel(role.model)) return false;
  if (role.model && role.engine === "codex" && (role.model.length > 128 || !role.model.startsWith("gpt-") || /[\u0000-\u001f\u007f]/.test(role.model))) return false;
  if (role.effort !== null && (typeof role.effort !== "string" || !isEngineEffort(role.engine, role.effort))) return false;
  return (
    (role.roleId === null || PIPELINE_ROLE_IDS.includes(role.roleId as typeof PIPELINE_ROLE_IDS[number])) &&
    (role.access === "read-only" || role.access === "read-write") &&
    (role.promptScaffold === null || (typeof role.promptScaffold === "string" && role.promptScaffold.length <= MAX_SCAFFOLD_LENGTH))
  );
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isVerdict(value: unknown): boolean {
  return value === null || stageVerdictFrom(value) !== null;
}

function isActivation(value: unknown): value is PipelineEdgeActivation | null {
  if (value === null || value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const activation = value as Partial<PipelineEdgeActivation>;
  return (
    typeof activation.stageId === "string" &&
    Number.isInteger(activation.attempt) &&
    (activation.attempt as number) >= 1 &&
    (activation.edge === "pass" || activation.edge === "fail")
  );
}

function isAttempt(value: unknown, index: number): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const attempt = value as Record<string, unknown>;
  return (
    attempt.n === index + 1 &&
    ["pending", "spawning", "running", "reviewing", "committing", "passed", "failed", "needs_decision", "skipped"].includes(String(attempt.state)) &&
    isEffectiveRole(attempt.effectiveRole) &&
    isNullableString(attempt.launchId) &&
    isNullableString(attempt.conversationId) &&
    isNullableString(attempt.sessionId) &&
    isNullableString(attempt.agentPath) &&
    isNullableString(attempt.paneId) &&
    isNullableString(attempt.flowId) &&
    isNullableString(attempt.startedAt) &&
    isNullableString(attempt.completedAt) &&
    (attempt.input === undefined || isNullableString(attempt.input)) &&
    isActivation(attempt.activatedBy) &&
    isNullableString(attempt.output) &&
    isVerdict(attempt.verdict) &&
    isNullableString(attempt.error)
  );
}

function isRun(value: unknown): value is Pipeline["runs"][number] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const run = value as { stageId?: unknown; attempts?: unknown };
  return typeof run.stageId === "string" && Array.isArray(run.attempts) && run.attempts.every(isAttempt);
}

function isFailEdge(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const edge = value as { to?: unknown; maxRounds?: unknown };
  return (
    typeof edge.to === "string" &&
    Number.isInteger(edge.maxRounds) &&
    (edge.maxRounds as number) >= 1 &&
    (edge.maxRounds as number) <= MAX_FAIL_EDGE_ROUNDS
  );
}

function isStage(value: unknown): value is PipelineStage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const stage = value as Partial<PipelineStage>;
  const role = (value as { role?: unknown }).role;
  if (!(
    typeof stage.id === "string" &&
    (stage.kind === "run" || stage.kind === "review-loop") &&
    typeof stage.prompt === "string" &&
    (stage.next === null || typeof stage.next === "string") &&
    isFailEdge(stage.onFail) &&
    (role === undefined || Boolean(role && typeof role === "object" && !Array.isArray(role) && (PIPELINE_ROLE_IDS as readonly unknown[]).includes((role as { roleId?: unknown }).roleId))) &&
    (stage.engine === undefined || stage.engine === "claude" || stage.engine === "codex") &&
    (stage.model === undefined || stage.model === null || typeof stage.model === "string") &&
    (stage.effort === undefined || stage.effort === null || typeof stage.effort === "string") &&
    (stage.access === undefined || stage.access === "read-only" || stage.access === "read-write") &&
    isEffectiveRole(stage.effectiveRole)
  )) return false;
  const effective = stage.effectiveRole;
  const referencedRoleId = role === undefined ? null : (role as { roleId: EffectivePipelineRole["roleId"] }).roleId;
  if (effective.roleId !== referencedRoleId) return false;
  if (stage.kind === "review-loop" && effective.access !== "read-only") return false;
  if (stage.engine !== undefined && stage.engine !== effective.engine) return false;
  if (stage.model !== undefined && stage.model !== effective.model) return false;
  if (stage.effort !== undefined && stage.effort !== effective.effort) return false;
  if (stage.access !== undefined && stage.access !== effective.access) return false;
  if (referencedRoleId === null && effective.promptScaffold !== null) return false;
  if (referencedRoleId !== null && !effective.promptScaffold?.trim()) return false;
  return true;
}

/**
 * The v3 conversation-graph contract (#353). Verdict-keyed successors: each
 * stage has at most one pass edge (`next`) and one fail edge (`onFail`). The
 * pass graph must be acyclic (so every pass path terminates at `null`), edge
 * targets must exist, and every review-loop must be pass-reachable from a run
 * stage (it reviews a run's session). Fail edges may target any stage — cycles
 * live there, terminated by the per-edge round budget. Shared by the store
 * validator, the create-time normalizer, and the set-edge action so no path can
 * persist a graph another path would reject.
 */
export function pipelineGraphError(
  stages: ReadonlyArray<Pick<PipelineStage, "id" | "kind" | "next"> & { onFail?: Pipeline["stages"][number]["onFail"] }>,
): string | null {
  const ids = new Set(stages.map((stage) => stage.id));
  const nextOf = new Map(stages.map((stage) => [stage.id, stage.next] as const));
  for (const stage of stages) {
    if (stage.next !== null && !ids.has(stage.next)) return `stage ${stage.id} next must reference an existing stage`;
    if (stage.next === stage.id) return `stage ${stage.id} pass edge may not target itself`;
    const onFail = stage.onFail ?? null;
    if (onFail && !ids.has(onFail.to)) return `stage ${stage.id} onFail must reference an existing stage`;
    if (onFail && (!Number.isInteger(onFail.maxRounds) || onFail.maxRounds < 1 || onFail.maxRounds > MAX_FAIL_EDGE_ROUNDS)) {
      return `stage ${stage.id} onFail maxRounds must be an integer between 1 and ${MAX_FAIL_EDGE_ROUNDS}`;
    }
  }
  /* Out-degree-1 pass graph: walking `next` from any stage must terminate
     within |stages| hops, else a pass cycle exists. */
  for (const stage of stages) {
    let cursor: string | null = stage.next;
    for (let hops = 0; cursor !== null; hops += 1) {
      if (cursor === stage.id || hops > stages.length) return `pipeline pass edges form a cycle through stage ${stage.id}`;
      cursor = nextOf.get(cursor) ?? null;
    }
  }
  for (const stage of stages) {
    if (stage.kind !== "review-loop") continue;
    const reachable = stages.some((candidate) => {
      if (candidate.kind !== "run") return false;
      let cursor: string | null = candidate.next;
      for (let hops = 0; cursor !== null && hops <= stages.length; hops += 1) {
        if (cursor === stage.id) return true;
        cursor = nextOf.get(cursor) ?? null;
      }
      return false;
    });
    if (!reachable) return "review-loop stage requires a preceding run stage";
  }
  return null;
}

function isPipeline(value: unknown): value is Pipeline {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const pipeline = value as Partial<Pipeline>;
  if (!(
    typeof pipeline.id === "string" &&
    typeof pipeline.task === "string" &&
    (pipeline.spec === undefined || typeof pipeline.spec === "string") &&
    typeof pipeline.project === "string" &&
    typeof pipeline.repoDir === "string" &&
    typeof pipeline.worktreeDir === "string" &&
    typeof pipeline.branch === "string" &&
    typeof pipeline.baseBranch === "string" &&
    typeof pipeline.baseRef === "string" &&
    typeof pipeline.lastPassedCommit === "string" &&
    Array.isArray(pipeline.stages) &&
    pipeline.stages.every(isStage) &&
    Array.isArray(pipeline.runs) &&
    pipeline.runs.every(isRun) &&
    ["draft", "provisioning", "running", "needs_decision", "paused", "completed", "closed"].includes(String(pipeline.state)) &&
    (pipeline.pausedState === null || ["provisioning", "running", "needs_decision", "completed", "closed"].includes(String(pipeline.pausedState))) &&
    isNullableString(pipeline.stateDetail) &&
    isNullableString(pipeline.srcPath) &&
    isNullableString(pipeline.srcConversationId) &&
    typeof pipeline.createdAt === "string" &&
    isNullableString(pipeline.closedAt) &&
    (pipeline.hiddenAt === undefined || isNullableString(pipeline.hiddenAt)) &&
    (pipeline.restored === undefined || typeof pipeline.restored === "boolean")
  )) return false;
  const stages = pipeline.stages as PipelineStage[];
  const runs = pipeline.runs as Pipeline["runs"];
  /* A draft is a scratchpad the operator assembles on the canvas (#136), so it
     may hold 0–8 stages (v2 legacy shells are seeded on migration, but a raw
     empty draft still loads and stays off the board projection). Every
     non-draft state keeps the 1–8 invariant (#353: the minimum graph is one
     implement conversation). */
  const minStages = pipeline.state === "draft" ? 0 : 1;
  if (stages.length < minStages || stages.length > MAX_PIPELINE_STAGES || runs.length !== stages.length) return false;
  const ids = stages.map((stage) => stage.id);
  if (new Set(ids).size !== ids.length) return false;
  if (pipelineGraphError(stages) !== null) return false;
  if (runs.some((run, index) => run.stageId !== stages[index]!.id)) return false;
  const expectedWorktree = path.join(path.dirname(pipeline.repoDir!), `${path.basename(pipeline.repoDir!)}-pipeline-${pipeline.id}`);
  if (pipeline.worktreeDir !== expectedWorktree || pipeline.branch !== `pipeline/${slugify(pipeline.task!)}-${pipeline.id}`) return false;
  const cursor = pipeline.cursor;
  if (cursor !== null && (
    !cursor ||
    typeof cursor !== "object" ||
    !ids.includes(cursor.stageId) ||
    !["pending", "spawning", "running", "reviewing", "committing"].includes(cursor.state) ||
    !(cursor.input === undefined || isNullableString(cursor.input)) ||
    !isActivation(cursor.activatedBy) ||
    (cursor.activatedBy != null && !ids.includes(cursor.activatedBy.stageId))
  )) return false;
  if ((pipeline.state === "completed" || pipeline.state === "closed") && cursor !== null) return false;
  if (pipeline.state === "draft") {
    /* An empty draft has no stage to point the cursor at; once it holds stages the
       cursor rests on the first, pending (Start spawns from there). */
    if (stages.length === 0) {
      if (cursor !== null) return false;
    } else if (cursor?.stageId !== stages[0]!.id || cursor.state !== "pending") return false;
    if (runs.some((run) => run.attempts.length > 0)) return false;
    const baseEmpty = !pipeline.baseBranch && !pipeline.baseRef && !pipeline.lastPassedCommit;
    const basePinned = Boolean(
      pipeline.baseBranch &&
      /^[0-9a-f]{40}$/i.test(pipeline.baseRef!) &&
      pipeline.lastPassedCommit === pipeline.baseRef,
    );
    if ((!baseEmpty && !basePinned) || pipeline.closedAt) return false;
  }
  return true;
}

/** The seeded default action (#353): every pipeline, including a migrated v2
    empty shell, holds at least one implement conversation. Role-less claude/
    read-write defaults keep the seed independent of the role registry, so a
    read-only load can never fail on role resolution. */
function defaultImplementStage(): PipelineStage {
  return {
    id: "implement",
    kind: "run",
    prompt: "{{task}}",
    next: null,
    onFail: null,
    effectiveRole: { roleId: null, engine: "claude", model: null, effort: null, access: "read-write", promptScaffold: null },
  };
}

/**
 * In-memory v2 → v3 migration (#353). Purely additive on history: every stage
 * gains `onFail: null`, every attempt/cursor gains `input: null` /
 * `activatedBy: null` (truthful "unknown provenance" — the engine's positional
 * fallback keeps an in-flight v2 pipeline running byte-identically), and a
 * zero-stage draft shell is seeded with the default implement stage. The file
 * itself is rewritten as v3 only by the next successful mutation.
 */
function migrateV2Pipeline(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const pipeline = raw as Record<string, unknown>;
  const stages = Array.isArray(pipeline.stages)
    ? (pipeline.stages as unknown[]).map((stage) => (stage && typeof stage === "object" ? { onFail: null, ...(stage as Record<string, unknown>) } : stage))
    : pipeline.stages;
  const runs = Array.isArray(pipeline.runs)
    ? (pipeline.runs as unknown[]).map((run) => (run && typeof run === "object" && Array.isArray((run as { attempts?: unknown }).attempts)
        ? {
            ...(run as Record<string, unknown>),
            attempts: (run as { attempts: unknown[] }).attempts.map((attempt) =>
              (attempt && typeof attempt === "object" ? { input: null, activatedBy: null, ...(attempt as Record<string, unknown>) } : attempt)),
          }
        : run))
    : pipeline.runs;
  const cursor = pipeline.cursor && typeof pipeline.cursor === "object"
    ? { input: null, activatedBy: null, ...(pipeline.cursor as Record<string, unknown>) }
    : pipeline.cursor;
  const migrated: Record<string, unknown> = { ...pipeline, stages, runs, cursor };
  if (migrated.state === "draft" && Array.isArray(migrated.stages) && migrated.stages.length === 0) {
    const seed = defaultImplementStage();
    migrated.stages = [seed];
    migrated.runs = [{ stageId: seed.id, attempts: [] }];
    migrated.cursor = { stageId: seed.id, state: "pending", input: null, activatedBy: null };
  }
  return migrated;
}

export function loadPipelines(): Pipeline[] {
  const raw = readJson(pipelinesFile());
  if (raw === null) return [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new PipelineStoreError("pipeline registry must be an object");
  const file = raw as Partial<PipelineFile>;
  if (typeof file.schemaVersion !== "number" || !MIGRATABLE_SCHEMA_VERSIONS.has(file.schemaVersion)) {
    throw new PipelineStoreError(`unsupported pipeline registry schema: ${String(file.schemaVersion)}`);
  }
  if (!Array.isArray(file.pipelines)) throw new PipelineStoreError("pipeline registry contains malformed records");
  const records = file.schemaVersion === 2 ? file.pipelines.map(migrateV2Pipeline) : file.pipelines;
  if (!records.every(isPipeline)) throw new PipelineStoreError("pipeline registry contains malformed records");
  return records.map((pipeline) => ({
    ...pipeline,
    spec: typeof pipeline.spec === "string" ? pipeline.spec : undefined,
    baseBranch: pipeline.baseBranch ?? "",
    baseRef: pipeline.baseRef ?? "",
    lastPassedCommit: pipeline.lastPassedCommit ?? "",
    pausedState: pipeline.pausedState ?? null,
    stateDetail: pipeline.stateDetail ?? null,
    srcPath: pipeline.srcPath ?? null,
    srcConversationId: pipeline.srcConversationId ?? null,
    closedAt: pipeline.closedAt ?? null,
    hiddenAt: pipeline.hiddenAt ?? null,
    restored: undefined,
    stages: pipeline.stages.map((stage) => ({ ...stage, onFail: stage.onFail ?? null })),
    cursor: pipeline.cursor
      ? { ...pipeline.cursor, input: pipeline.cursor.input ?? null, activatedBy: pipeline.cursor.activatedBy ?? null }
      : null,
    runs: pipeline.runs.map((run) => ({
      ...run,
      attempts: Array.isArray(run.attempts)
        ? run.attempts.map((attempt) => ({
            ...attempt,
            launchId: attempt.launchId ?? null,
            conversationId: attempt.conversationId ?? null,
            sessionId: attempt.sessionId ?? null,
            agentPath: attempt.agentPath ?? null,
            paneId: attempt.paneId ?? null,
            flowId: attempt.flowId ?? null,
            startedAt: attempt.startedAt ?? null,
            completedAt: attempt.completedAt ?? null,
            input: attempt.input ?? null,
            activatedBy: attempt.activatedBy ?? null,
            output: attempt.output ?? null,
            verdict: attempt.verdict ?? null,
            error: attempt.error ?? null,
          }))
        : [],
    })),
  }));
}

type PipelineMutationState = { tail: Promise<void> };
const mutationState = globalThis as typeof globalThis & { __llvPipelineMutationState?: PipelineMutationState };
mutationState.__llvPipelineMutationState ??= { tail: Promise.resolve() };

/** Serialize every production read-modify-write, including async spawn/flow work. */
export async function withPipelineMutation<T>(
  mutate: (pipelines: Pipeline[], persist: () => void) => Promise<T> | T,
): Promise<T> {
  const state = mutationState.__llvPipelineMutationState!;
  const previous = state.tail;
  let release!: () => void;
  state.tail = new Promise<void>((resolve) => { release = resolve; });
  await previous.catch(() => undefined);
  try {
    const pipelines = loadPipelines();
    return await mutate(pipelines, () => savePipelines(pipelines));
  } finally {
    release();
  }
}

export function savePipelines(pipelines: Pipeline[]): void {
  /* The loader rejects the whole file on one malformed record, so a writer
     bug must become a failed mutation here, never a poisoned registry that
     only a hand edit can recover. */
  for (const pipeline of pipelines) {
    const id = pipeline.id;
    if (!isPipeline(pipeline)) throw new PipelineStoreError(`refusing to persist a malformed pipeline record: ${id}`);
  }
  atomicWriteJson(pipelinesFile(), { schemaVersion: PIPELINES_SCHEMA_VERSION, pipelines });
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "") || "task";
}

export function pipelineIdentity(id: string, task: string, repoDir: string): Pick<Pipeline, "worktreeDir" | "branch"> {
  const repoName = path.basename(repoDir);
  return {
    worktreeDir: path.join(path.dirname(repoDir), `${repoName}-pipeline-${id}`),
    branch: `pipeline/${slugify(task)}-${id}`,
  };
}

export function buildPipeline(input: {
  id: string;
  task: string;
  spec?: string;
  project: string;
  repoDir: string;
  stages: PipelineStage[];
  srcPath: string | null;
  srcConversationId: string | null;
  now: string;
  state?: "draft" | "provisioning";
}): Pipeline {
  const identity = pipelineIdentity(input.id, input.task, input.repoDir);
  return {
    id: input.id,
    task: input.task,
    ...(input.spec ? { spec: input.spec } : {}),
    project: input.project,
    repoDir: input.repoDir,
    ...identity,
    baseBranch: "",
    baseRef: "",
    lastPassedCommit: "",
    stages: (JSON.parse(JSON.stringify(input.stages)) as PipelineStage[]).map((stage) => ({ ...stage, onFail: stage.onFail ?? null })),
    runs: input.stages.map((stage) => ({ stageId: stage.id, attempts: [] })),
    cursor: input.stages.length ? { stageId: input.stages[0]!.id, state: "pending", input: null, activatedBy: null } : null,
    state: input.state ?? "provisioning",
    pausedState: null,
    stateDetail: null,
    srcPath: input.srcPath,
    srcConversationId: input.srcConversationId,
    createdAt: input.now,
    closedAt: null,
    hiddenAt: null,
  };
}

export function pipelineArtifactsDir(pipelineId: string): string {
  return path.join(artifactsRoot(), pipelineId);
}
