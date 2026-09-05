import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { statePath } from "@/lib/configDir";
import { canonicalProject } from "@/lib/projects/aliases";
import { effortScale } from "@/lib/agent/efforts";
import { normalizeClaudeLaunchModel } from "@/lib/agent/models";
import { MAX_SCAFFOLD_LENGTH } from "@/lib/roles/store";
import { initializeStateCollections, readStateCollectionsRows, SqliteStateCollection, type StateCollectionSeed } from "@/lib/state/sqliteStateStore";
import type { BoardTask } from "@/lib/tasks/types";

import { MAX_FAIL_EDGE_ROUNDS, MAX_PIPELINE_STAGES, MAX_STAGE_OUTPUTS } from "./limits";
import { normalizeStageOutputPath } from "./stageAccess";
import type { EffectivePipelineRole, Pipeline, PipelineCreationIntent, PipelineEdgeActivation, PipelineStage, PipelineTerminalReap, PipelineUnconfirmedHost } from "./types";
import { stageVerdictFrom } from "./verdict";

export const PIPELINES_SCHEMA_VERSION = 5;
/** Older registries are migrated in memory on load; the file is rewritten in
    the current shape by the next successful mutation, never by a read. */
const MIGRATABLE_SCHEMA_VERSIONS = new Set([2, 3, 4, PIPELINES_SCHEMA_VERSION]);
const pipelinesFile = () => statePath("pipelines.json");
const pipelinesArchiveFile = () => statePath("pipelines-archive.json");
const stateDatabaseFile = () => statePath("state.sqlite");
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
  if (role.effort !== null && (typeof role.effort !== "string" || !effortScale(role.engine, role.model)!.includes(role.effort))) return false;
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

function isReviewFlowSync(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const sync = value as Record<string, unknown>;
  const hostClaim = sync.hostClaim as Record<string, unknown> | null | undefined;
  const hostClaimValid = hostClaim === undefined || hostClaim === null || (
    typeof hostClaim === "object"
    && !Array.isArray(hostClaim)
    && /^(?:claude|codex):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(String(hostClaim.sessionKey))
    && /^(?:default|unknown|managed:[0-9a-f]{12})$/.test(String(hostClaim.accountRef))
  );
  const flowStates = ["waiting_ready", "spawn_pending", "spawning", "reviewing", "relay_pending", "relaying", "fixing", "approved", "done_comment", "needs_decision", "paused", "closed"];
  return typeof sync.generation === "string"
    && (sync.sourceRevision === undefined || (Number.isInteger(sync.sourceRevision) && (sync.sourceRevision as number) >= 0))
    && Number.isInteger(sync.roundCount) && (sync.roundCount as number) >= 0
    && isNullableString(sync.implementerHeadSha)
    && isNullableString(sync.reviewerHeadSha)
    && (sync.verdict === null || ["APPROVE", "REQUEST_CHANGES", "COMMENT"].includes(String(sync.verdict)))
    && flowStates.includes(String(sync.relayState))
    && (sync.terminalState === null || flowStates.includes(String(sync.terminalState)))
    && hostClaimValid
    && typeof sync.synchronizedAt === "string"
    && isNullableString(sync.sourceUpdatedAt)
    && (sync.lagMs === null || (typeof sync.lagMs === "number" && Number.isFinite(sync.lagMs) && sync.lagMs >= 0));
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

function isVerdictRecovery(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const recovery = value as Record<string, unknown>;
  return (
    ["pending", "recovered", "exhausted"].includes(String(recovery.state))
    && Number.isInteger(recovery.checks)
    && (recovery.checks as number) >= 0
    && Number.isInteger(recovery.maxChecks)
    && (recovery.maxChecks as number) >= 1
    && (recovery.checks as number) <= (recovery.maxChecks as number)
    && typeof recovery.startedAt === "string"
    && typeof recovery.lastCheckedAt === "string"
    && isNullableString(recovery.nextCheckAt)
    && typeof recovery.reason === "string"
    && recovery.reason.length > 0
    && recovery.reason.length <= 1_000
    && (recovery.messageTs === null
      || (typeof recovery.messageTs === "number" && Number.isFinite(recovery.messageTs) && recovery.messageTs >= 0))
  );
}

function isAttempt(value: unknown, index: number): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const attempt = value as Record<string, unknown>;
  return (
    attempt.n === index + 1 &&
    (attempt.historical === undefined || typeof attempt.historical === "boolean") &&
    ["pending", "spawning", "running", "reviewing", "committing", "passed", "failed", "needs_decision", "skipped"].includes(String(attempt.state)) &&
    isEffectiveRole(attempt.effectiveRole) &&
    isNullableString(attempt.launchId) &&
    isNullableString(attempt.conversationId) &&
    isNullableString(attempt.sessionId) &&
    isNullableString(attempt.agentPath) &&
    isNullableString(attempt.paneId) &&
    (attempt.accountId === undefined || isNullableString(attempt.accountId)) &&
    (attempt.usageLimitedAccounts === undefined || (
      Array.isArray(attempt.usageLimitedAccounts)
      && attempt.usageLimitedAccounts.every((limited) => (
        limited !== null
        && typeof limited === "object"
        && !Array.isArray(limited)
        && typeof limited.accountId === "string"
        && limited.accountId.length > 0
        && (limited.resetsAt === null || (Number.isSafeInteger(limited.resetsAt) && limited.resetsAt >= 0))
      ))
      && new Set(attempt.usageLimitedAccounts.map((limited) => limited.accountId)).size === attempt.usageLimitedAccounts.length
    )) &&
    isNullableString(attempt.flowId) &&
    (attempt.expectedReviewHeadSha === undefined || isNullableString(attempt.expectedReviewHeadSha)) &&
    (attempt.reviewHeadSha === undefined || isNullableString(attempt.reviewHeadSha)) &&
    isReviewFlowSync(attempt.reviewFlowSync) &&
    isNullableString(attempt.startedAt) &&
    isNullableString(attempt.completedAt) &&
    (attempt.input === undefined || isNullableString(attempt.input)) &&
    isActivation(attempt.activatedBy) &&
    isNullableString(attempt.output) &&
    isVerdict(attempt.verdict) &&
    isNullableString(attempt.error) &&
    isVerdictRecovery(attempt.verdictRecovery) &&
    isUnresolvedTermination(attempt.unresolvedTermination)
  );
}

function isUnresolvedTermination(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.error === "string"
    && typeof record.recordedAt === "string"
    && Array.isArray(record.survivors)
    && record.survivors.every((survivor) => survivor !== null
      && typeof survivor === "object"
      && Number.isSafeInteger((survivor as { pid: unknown }).pid)
      && isNullableString((survivor as { startIdentity: unknown }).startIdentity)
      && ((survivor as { bootEpoch: unknown }).bootEpoch === undefined
        || isNullableString((survivor as { bootEpoch: unknown }).bootEpoch)));
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

function isCreationIntent(value: unknown): value is PipelineCreationIntent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const intent = value as Partial<PipelineCreationIntent>;
  return intent.kind === "task-spawn"
    && typeof intent.taskId === "string" && Boolean(intent.taskId.trim())
    && typeof intent.launchId === "string" && Boolean(intent.launchId.trim());
}

function isUnconfirmedHost(value: unknown): value is PipelineUnconfirmedHost {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const host = value as Partial<PipelineUnconfirmedHost>;
  return typeof host.stageId === "string"
    && Number.isInteger(host.attempt)
    && isNullableString(host.conversationId)
    && isNullableString(host.agentPath)
    && (host.paneId === undefined || isNullableString(host.paneId))
    && isNullableString(host.operationId)
    && typeof host.detail === "string"
    && typeof host.at === "string";
}

function isTerminalReap(value: unknown): value is PipelineTerminalReap {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const reap = value as Partial<PipelineTerminalReap>;
  return Number.isInteger(reap.rounds) && (reap.rounds as number) >= 0
    && Number.isInteger(reap.stopped) && (reap.stopped as number) >= 0
    && typeof reap.lastAt === "string"
    && (reap.settledAttempts === undefined
      || (Array.isArray(reap.settledAttempts) && reap.settledAttempts.every((key) => typeof key === "string")))
    && isNullableString(reap.settledAt);
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
    (stage.sandbox === undefined || stage.sandbox === "full" || stage.sandbox === "restricted") &&
    (stage.outputs === undefined || (
      stage.kind === "run" &&
      Array.isArray(stage.outputs) &&
      stage.outputs.length > 0 && stage.outputs.length <= MAX_STAGE_OUTPUTS &&
      stage.outputs.every((output, index) => normalizeStageOutputPath(output) === output && stage.outputs!.indexOf(output) === index)
    )) &&
    isEffectiveRole(stage.effectiveRole)
  )) return false;
  const effective = stage.effectiveRole;
  const referencedRoleId = role === undefined ? null : (role as { roleId: EffectivePipelineRole["roleId"] }).roleId;
  if (stage.outputs !== undefined && effective.access !== "read-only") return false;
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
 * stage (it reviews a run's session). Run-stage fail edges may target any stage;
 * their cycles terminate at the per-edge round budget. Review-loop stages use
 * their bound flow for verdict recovery and cannot define `onFail`. Shared by
 * the store validator, the create-time normalizer, and the set-edge action so
 * every mutation path applies the same graph contract.
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
    if (stage.kind === "review-loop" && onFail) return `review-loop stage ${stage.id} does not support onFail`;
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
    /* #1026: this used to say "review-loop stage requires a preceding run
       stage", which reads as an ordering rule and sent a caller reordering an
       array that was already in the right order. The defect is a missing pass
       edge: stages default to `next: null`, so nothing reaches the review-loop.
       Name the unreachable stage and the edge that would reach it. */
    if (!reachable) {
      const runStages = stages.filter((candidate) => candidate.kind === "run");
      if (runStages.length === 0) {
        return `review-loop stage ${stage.id} is unreachable: the pipeline has no run stage, and a review-loop reviews the session of a run stage that reaches it`;
      }
      const source = runStages.findLast((candidate) => candidate.next === null) ?? runStages.at(-1)!;
      return `review-loop stage ${stage.id} is unreachable: no run stage's next chain reaches it — set next: "${stage.id}" on run stage ${source.id}`;
    }
  }
  return null;
}

function isPipeline(value: unknown): value is Pipeline {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const pipeline = value as Partial<Pipeline>;
  if (!(
    typeof pipeline.id === "string" &&
    typeof pipeline.task === "string" &&
    Array.isArray(pipeline.taskIds) &&
    pipeline.taskIds.every((taskId) => typeof taskId === "string") &&
    new Set(pipeline.taskIds).size === pipeline.taskIds.length &&
    (pipeline.creationIntent === undefined || isCreationIntent(pipeline.creationIntent)) &&
    (pipeline.spec === undefined || typeof pipeline.spec === "string") &&
    typeof pipeline.project === "string" &&
    typeof pipeline.repoDir === "string" &&
    typeof pipeline.worktreeDir === "string" &&
    typeof pipeline.branch === "string" &&
    typeof pipeline.baseBranch === "string" &&
    typeof pipeline.baseRef === "string" &&
    typeof pipeline.lastPassedCommit === "string" &&
    (pipeline.publishedCommit === undefined || isNullableString(pipeline.publishedCommit)) &&
    Array.isArray(pipeline.stages) &&
    pipeline.stages.every(isStage) &&
    Array.isArray(pipeline.runs) &&
    pipeline.runs.every(isRun) &&
    ["draft", "provisioning", "running", "needs_decision", "paused", "completed", "closed"].includes(String(pipeline.state)) &&
    (pipeline.pausedState === null || ["provisioning", "running", "needs_decision", "completed", "closed"].includes(String(pipeline.pausedState))) &&
    (pipeline.pausedAt === undefined || isNullableString(pipeline.pausedAt)) &&
    (pipeline.resumedAt === undefined || isNullableString(pipeline.resumedAt)) &&
    isNullableString(pipeline.stateDetail) &&
    isNullableString(pipeline.srcPath) &&
    isNullableString(pipeline.srcConversationId) &&
    typeof pipeline.createdAt === "string" &&
    isNullableString(pipeline.closedAt) &&
    (pipeline.hiddenAt === undefined || isNullableString(pipeline.hiddenAt)) &&
    (pipeline.unconfirmedHosts === undefined
      || (Array.isArray(pipeline.unconfirmedHosts) && pipeline.unconfirmedHosts.every(isUnconfirmedHost))) &&
    (pipeline.terminalReap === undefined || isTerminalReap(pipeline.terminalReap)) &&
    (pipeline.restored === undefined || typeof pipeline.restored === "boolean") &&
    (pipeline.pos === undefined || (
      typeof pipeline.pos === "object" && pipeline.pos !== null &&
      Number.isFinite(pipeline.pos.x) && Number.isFinite(pipeline.pos.y)
    ))
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
    "prompt": "{{task}}",
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

function migrateTaskIds(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  return { taskIds: [], ...(raw as Record<string, unknown>) };
}

/** v4 accepted review-loop fail edges even though the embedded flow owns every
    review verdict and no engine path could traverse those edges. Clear that
    unreachable configuration before the v5 graph validator runs. */
function migrateReviewLoopFailEdges(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const pipeline = raw as Record<string, unknown>;
  if (!Array.isArray(pipeline.stages)) return raw;
  return {
    ...pipeline,
    stages: pipeline.stages.map((stage) => {
      if (!stage || typeof stage !== "object" || Array.isArray(stage)) return stage;
      const record = stage as Record<string, unknown>;
      return record.kind === "review-loop" ? { ...record, onFail: null } : stage;
    }),
  };
}

function migratePipelineRecord(raw: unknown, schemaVersion: number): unknown {
  let migrated = schemaVersion === 2 ? migrateV2Pipeline(raw) : raw;
  if (schemaVersion < 4) migrated = migrateTaskIds(migrated);
  if (schemaVersion < 5) migrated = migrateReviewLoopFailEdges(migrated);
  return migrated;
}

export function loadPipelines(): Pipeline[] {
  return pipelineStore().snapshot();
}

/** Startup needs fresh, complete authority, including cold records. Read both
    collections in one SQLite snapshot without projection caches or lenient
    archive decoding. Before cutover, validate the legacy sources in memory;
    this evidence read never migrates or rewrites an unreadable source. */
export function loadPipelinesForStartup(): Pipeline[] {
  const collections = readStateCollectionsRows(stateDatabaseFile(), ["pipelines", "pipelines_archive"]);
  const active = collections.get("pipelines");
  const archived = collections.get("pipelines_archive");
  if ((active === null) !== (archived === null)) {
    throw new PipelineStoreError("pipeline startup collections are incomplete");
  }
  const records = active === null && archived === null
    ? [...parsePipelinesFile(pipelinesFile(), false), ...parsePipelinesFile(pipelinesArchiveFile(), false)]
    : [...(active ?? []), ...(archived ?? [])];
  if (!records.every(isPipeline)) throw new PipelineStoreError("pipeline registry contains malformed records");
  if (new Set(records.map((record) => record.id)).size !== records.length) {
    throw new PipelineStoreError("pipeline startup records have contradictory identities");
  }
  return records.map(reviveLoadedPipeline);
}

function parsePipelinesFile(filename: string, lenient: boolean): Pipeline[] {
  const raw = readJson(filename);
  if (raw === null) return [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    if (lenient) return [];
    throw new PipelineStoreError("pipeline registry must be an object");
  }
  const file = raw as Partial<PipelineFile>;
  if (typeof file.schemaVersion !== "number" || !MIGRATABLE_SCHEMA_VERSIONS.has(file.schemaVersion)) {
    if (lenient) return [];
    throw new PipelineStoreError(`unsupported pipeline registry schema: ${String(file.schemaVersion)}`);
  }
  if (!Array.isArray(file.pipelines)) {
    if (lenient) return [];
    throw new PipelineStoreError("pipeline registry contains malformed records");
  }
  const records = file.pipelines.map((pipeline) => migratePipelineRecord(pipeline, file.schemaVersion!));
  if (!lenient && !records.every(isPipeline)) throw new PipelineStoreError("pipeline registry contains malformed records");
  const accepted = lenient ? records.filter(isPipeline) : records as Pipeline[];
  if (lenient && accepted.length !== records.length) {
    console.error(`[pipelines] skipped ${records.length - accepted.length} malformed archived pipeline record(s)`);
  }
  return accepted.map(reviveLoadedPipeline);
}

export function planPipelineStateMigration(): {
  pipelines: { records: number; keys: string[] };
  archive: { records: number; keys: string[] };
} {
  const pipelines = parsePipelinesFile(pipelinesFile(), false);
  const archive = parsePipelinesFile(pipelinesArchiveFile(), true);
  return {
    pipelines: { records: pipelines.length, keys: pipelines.map((pipeline) => pipeline.id) },
    archive: { records: archive.length, keys: archive.map((pipeline) => pipeline.id) },
  };
}

/** Fresh per-call copies of every layer a caller may write (pipeline, stage,
    run, attempt, cursor rows), so cached records stay pristine while callers
    receive independently mutable structures. Deep config leaves are shared. */
function reviveLoadedPipeline(pipeline: Pipeline): Pipeline {
  const settledAttempts = pipeline.terminalReap?.settledAttempts
    ?? (pipeline.terminalReap?.settledAt
      ? pipeline.runs.flatMap((run) => run.attempts
          .filter((attempt) => Boolean(attempt.verdict || attempt.completedAt))
          .map((attempt) => `${run.stageId}:${attempt.n}`))
      : []);
  return {
    ...pipeline,
    project: canonicalProject(pipeline.project),
    taskIds: [...pipeline.taskIds],
    creationIntent: pipeline.creationIntent ? { ...pipeline.creationIntent } : undefined,
    spec: typeof pipeline.spec === "string" ? pipeline.spec : undefined,
    baseBranch: pipeline.baseBranch ?? "",
    baseRef: pipeline.baseRef ?? "",
    lastPassedCommit: pipeline.lastPassedCommit ?? "",
    publishedCommit: pipeline.publishedCommit ?? null,
    pausedState: pipeline.pausedState ?? null,
    stateDetail: pipeline.stateDetail ?? null,
    srcPath: pipeline.srcPath ?? null,
    srcConversationId: pipeline.srcConversationId ?? null,
    closedAt: pipeline.closedAt ?? null,
    hiddenAt: pipeline.hiddenAt ?? null,
    unconfirmedHosts: pipeline.unconfirmedHosts?.length
      ? pipeline.unconfirmedHosts.map((host) => ({ ...host }))
      : undefined,
    terminalReap: pipeline.terminalReap
      ? { ...pipeline.terminalReap, settledAttempts: [...settledAttempts] }
      : undefined,
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
            ...(attempt.usageLimitedAccounts
              ? { usageLimitedAccounts: attempt.usageLimitedAccounts.map((limited) => ({ ...limited })) }
              : {}),
            flowId: attempt.flowId ?? null,
            expectedReviewHeadSha: attempt.expectedReviewHeadSha ?? null,
            reviewHeadSha: attempt.reviewHeadSha ?? null,
            reviewFlowSync: attempt.reviewFlowSync ? { ...attempt.reviewFlowSync } : undefined,
            startedAt: attempt.startedAt ?? null,
            completedAt: attempt.completedAt ?? null,
            input: attempt.input ?? null,
            activatedBy: attempt.activatedBy ?? null,
            output: attempt.output ?? null,
            verdict: attempt.verdict ?? null,
            error: attempt.error ?? null,
            verdictRecovery: attempt.verdictRecovery ? { ...attempt.verdictRecovery } : undefined,
            unresolvedTermination: attempt.unresolvedTermination
              ? { ...attempt.unresolvedTermination, survivors: attempt.unresolvedTermination.survivors.map((survivor) => ({ ...survivor })) }
              : undefined,
          }))
        : [],
    })),
  };
}

let projectionCache: { signature: string; pipelines: Pipeline[] } | null = null;
const pipelineStores = new Map<string, {
  active: SqliteStateCollection<Pipeline>;
  archive: SqliteStateCollection<Pipeline>;
}>();

function decodePipeline(value: unknown): Pipeline | null {
  if (!isPipeline(value)) throw new PipelineStoreError("pipeline registry contains malformed records");
  return reviveLoadedPipeline(value);
}

function pipelineControllerActive(pipeline: Pipeline): boolean {
  if (pipeline.state === "closed") return Boolean(pipeline.unconfirmedHosts?.length);
  if (pipeline.state === "completed") {
    return Boolean(pipeline.unconfirmedHosts?.length) || !pipeline.terminalReap?.settledAt;
  }
  return true;
}

export function pipelineStateCollectionSeeds(): [StateCollectionSeed<Pipeline>, StateCollectionSeed<Pipeline>] {
  return [
    {
      collection: "pipelines",
      schemaVersion: PIPELINES_SCHEMA_VERSION,
      migrationId: "pipelines-json-v1",
      loadRecords: () => parsePipelinesFile(pipelinesFile(), false),
      key: (pipeline: Pipeline) => pipeline.id,
      controllerActive: pipelineControllerActive,
    },
    {
      collection: "pipelines_archive",
      schemaVersion: PIPELINES_SCHEMA_VERSION,
      migrationId: "pipelines-archive-json-v1",
      loadRecords: () => parsePipelinesFile(pipelinesArchiveFile(), true),
      key: (pipeline: Pipeline) => pipeline.id,
      controllerActive: () => false,
    },
  ];
}

function stores(): { active: SqliteStateCollection<Pipeline>; archive: SqliteStateCollection<Pipeline> } {
  const filename = stateDatabaseFile();
  const held = pipelineStores.get(filename);
  if (held) return held;
  initializeStateCollections(filename, pipelineStateCollectionSeeds());
  const common = {
    schemaVersion: PIPELINES_SCHEMA_VERSION,
    busyMessage: "pipeline state is busy",
    key: (pipeline: Pipeline) => pipeline.id,
    decode: decodePipeline,
    clone: reviveLoadedPipeline,
    decodeError: (error: unknown) => error instanceof PipelineStoreError
      ? error
      : new PipelineStoreError("pipeline registry contains malformed records", { cause: error }),
    validate: (pipeline: Pipeline) => {
      if (!isPipeline(pipeline)) {
        throw new PipelineStoreError("refusing to persist a malformed pipeline record");
      }
    },
  };
  const active = new SqliteStateCollection<Pipeline>(filename, {
    ...common,
    collection: "pipelines",
    controllerActive: pipelineControllerActive,
    strictDecode: true,
  });
  const archive = new SqliteStateCollection<Pipeline>(filename, {
    ...common,
    collection: "pipelines_archive",
    onDecodeError: (error) => console.error("[pipelines] skipped malformed archived SQLite row", error),
  });
  const created = { active, archive };
  pipelineStores.set(filename, created);
  return created;
}

function pipelineStore(): SqliteStateCollection<Pipeline> {
  return stores().active;
}

function archiveStore(): SqliteStateCollection<Pipeline> {
  return stores().archive;
}

function pipelinesFileSignature(): string {
  return pipelineStore().signature();
}

/** The validated pipeline projection keeps the signature cache introduced for
    the JSON store. SQLite collection revisions invalidate it across processes.
    The records are the cache itself — only the exported readers below decide
    what a caller may do with them. */
function cachedPipelines(): Pipeline[] {
  const before = pipelinesFileSignature();
  if (projectionCache?.signature === before) return projectionCache.pipelines;
  const pipelines = [...pipelineStore().loadReadonly()];
  const after = pipelinesFileSignature();
  if (before === after) projectionCache = { signature: after, pipelines };
  return pipelines;
}

/** Read-only load for request-path projections (issue #798): no lease, and the
    validated registry is cached against the SQLite collection revision.
    Every call still returns independently mutable records via the same revive
    pass `loadPipelines` uses, so a projection overlay can never write into the
    cache. */
export function loadPipelinesForProjection(): Pipeline[] {
  return cachedPipelines().map(reviveLoadedPipeline);
}

/** The registry read behind bounded list projections (issue #863).
 *
 * Deliberately skips the per-caller `reviveLoadedPipeline` pass that every other
 * reader pays: a list page filters and slices these records and then copies only
 * the handful of scalars a row needs, so materializing mutable copies of 500
 * pipelines' nested stage/attempt history — for rows that are about to be
 * dropped, out of fields a list never returns — is pure waste.
 *
 * The price is that these ARE the cached records. Read them; never write them.
 * Anything that mutates a pipeline goes through `withPipelineMutation`, and
 * anything that overlays one takes `loadPipelinesForProjection`.
 */
export function loadPipelinesForList(): readonly Pipeline[] {
  return cachedPipelines();
}

/** Serialize every production read-modify-write across Viewer and MCP processes. */
export async function withPipelineMutation<T>(
  mutate: (pipelines: Pipeline[], persist: {
    (): void;
    (records: readonly Pipeline[]): void;
  }) => Promise<T> | T,
): Promise<T> {
  return pipelineStore().mutate(mutate);
}

export async function withPipelineControllerMutation<T>(
  mutate: (pipelines: Pipeline[], persist: {
    (): void;
    (records: readonly Pipeline[]): void;
  }) => Promise<T> | T,
): Promise<T> {
  return pipelineStore().mutate(mutate, undefined, true);
}

/** Hold the existing cross-process mutation lease through startup admission.
 * Unavailable state or authority permits only the caller's deferred path.
 * Never reinterpret a failure inside admission as permission to run it again.
 */
export async function withPipelineStartupAdmission<T>(
  admit: (available: boolean) => Promise<T>,
): Promise<T> {
  let entered = false;
  try {
    // Refuse malformed legacy archives before the ordinary store can migrate
    // them leniently. Admission rereads under the lease before any effects.
    loadPipelinesForStartup();
    return await withPipelineMutation(() => {
      entered = true;
      return admit(true);
    });
  } catch (error) {
    if (entered) throw error;
    return admit(false);
  }
}

export function savePipelines(pipelines: Pipeline[]): void {
  pipelineStore().replaceSync(pipelines);
}

/** Settled records leave the hot registry after this long; the archive keeps
    the full record for the closed list and by-id reads. */
const SETTLED_PIPELINE_ARCHIVE_AFTER_MS = 3 * 24 * 60 * 60 * 1000;

/** Lenient read: the archive is cold storage, so a malformed or legacy record
    is skipped with a log line instead of poisoning every closed-list read. */
export function loadArchivedPipelines(): Pipeline[] {
  return archiveStore().snapshot();
}

function pipelineSettledForArchive(pipeline: Pipeline, nowMs: number): boolean {
  /* Closed records archive on closedAt. A discarded draft now closes like
     anything else (#1274), but records discarded before that fix are hidden
     with no closedAt at all, so their hiddenAt still stands in. Anything still
     actionable (running, needs_decision, visible drafts) stays hot. */
  const settledAt = pipeline.closedAt ?? (pipeline.state === "draft" ? pipeline.hiddenAt : null);
  if (!settledAt) return false;
  const parsed = Date.parse(settledAt);
  return Number.isFinite(parsed) && nowMs - parsed > SETTLED_PIPELINE_ARCHIVE_AFTER_MS;
}

/** Move settled records out of the hot registry. The former JSON path parsed
    and rewrote every record here; the archive collection now receives only the
    settled rows before the active collection drops them. */
export async function archiveSettledPipelines(
  nowMs = Date.now(),
  options: { beforeCommit?: () => void } = {},
): Promise<number> {
  return pipelineStore().moveMatchingTo(
    archiveStore(),
    (pipeline) => pipelineSettledForArchive(pipeline, nowMs),
    options,
  );
}

export function checkpointPipelineRollbackMirrorsForDemotion(): { pipelines: number; pipelinesArchive: number } {
  const { active, archive } = stores();
  const pipelines = active.checkpointMirrorForDemotion((pipelines, revision) => {
    atomicWriteJson(pipelinesFile(), { schemaVersion: PIPELINES_SCHEMA_VERSION, _sqliteRevision: revision, pipelines });
  });
  const pipelinesArchive = archive.checkpointMirrorForDemotion((pipelines, revision) => {
    atomicWriteJson(pipelinesArchiveFile(), { schemaVersion: PIPELINES_SCHEMA_VERSION, _sqliteRevision: revision, pipelines });
  });
  return { pipelines, pipelinesArchive };
}

/** Full-record read by id: the hot registry first, then the archive. */
export function findPipelineRecord(pipelineId: string): Pipeline | null {
  return loadPipelines().find((pipeline) => pipeline.id === pipelineId)
    ?? loadArchivedPipelines().find((pipeline) => pipeline.id === pipelineId)
    ?? null;
}

/** Validates durable task membership at the pipeline store seam. */
export function pipelineTaskLinkError(
  pipeline: Pick<Pipeline, "project">,
  taskIds: readonly string[],
  tasks: readonly BoardTask[],
  options: { allowMissing?: boolean } = {},
): string | null {
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  for (const taskId of taskIds) {
    const task = tasksById.get(taskId);
    if (!task) {
      if (options.allowMissing) continue;
      return `task not found: ${taskId}`;
    }
    if (task.project !== pipeline.project) return `task project does not match pipeline project: ${taskId}`;
  }
  return null;
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
  taskIds?: string[];
  creationIntent?: PipelineCreationIntent;
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
    taskIds: [...new Set(input.taskIds ?? [])],
    ...(input.creationIntent ? { creationIntent: { ...input.creationIntent } } : {}),
    ...(input.spec ? { spec: input.spec } : {}),
    project: input.project,
    repoDir: input.repoDir,
    ...identity,
    baseBranch: "",
    baseRef: "",
    lastPassedCommit: "",
    publishedCommit: null,
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
