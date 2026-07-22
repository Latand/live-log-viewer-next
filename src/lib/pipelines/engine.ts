import crypto from "node:crypto";
import path from "node:path";

import { accountManager } from "@/lib/accounts/manager";
import { emptyLaunchProfile, type ViewerConversationId } from "@/lib/accounts/migration/contracts";
import { freshSpecFor } from "@/lib/agent/cli";
import { agentRegistry, type DurableMembershipInput } from "@/lib/agent/registry";
import { transcriptAllowed } from "@/lib/agent/spawnParent";
import { sessionKeyFromTranscript } from "@/lib/agent/sessionKey";
import { headCwd } from "@/lib/agent/transcript";
import { MAX_FLOW_NOTE_LENGTH, closeFlow, createFlowFromRequest, patchFlow } from "@/lib/flows/commands";
import { lastAssistantMessage } from "@/lib/flows/findings";
import { loadFlows } from "@/lib/flows/store";
import type { CreateFlowRequest, Flow, RoleConfig } from "@/lib/flows/types";
import { persistHandoffLineage, rememberHandoffChild } from "@/lib/handoffLineage";
import { runtimeHostClient } from "@/lib/runtime/client";
import { spawnStructuredConversation } from "@/lib/runtime/structuredSpawn";
import { projectForCwd } from "@/lib/scanner/describe";
import { loadTasks } from "@/lib/tasks/store";
import type { BoardTask } from "@/lib/tasks/types";
import { claudeProjectRootFor, codexSessionRootFor } from "@/lib/scanner/roots";
import { isShellCommand } from "@/lib/status";
import { paneInfo } from "@/lib/tmux";
import type { FileEntry } from "@/lib/types";
import { realExec, type ExecPort } from "@/lib/workflows/provision";

import { requestPipelineTick } from "./controllerSignal";
import { durableStageTurnEvidence, type StageTurnEvidence } from "./durableEvidence";
import { commitPipelineStage, currentPipelineBranchHead, currentPipelineRemoteBranchHead, provisionPipelineWorktree, resetPipelineStage, resolvePipelineBase, synchronizePipelineRetryHead } from "./git";
import {
  DEFAULT_FAIL_EDGE_ROUNDS,
  MAX_FAIL_EDGE_ROUNDS,
  MAX_PIPELINE_STAGES,
  MAX_SPEC_LENGTH,
  MAX_STAGE_PROMPT_LENGTH,
  MAX_TASK_LENGTH,
  MIN_STARTED_PIPELINE_STAGES,
} from "./limits";
import { pipelineRepoPreflightError, pipelineRepoPreflightStatus, preflightPipelineRepo } from "./preflight";
import { renderStagePrompt } from "./prompts";
import { pipelineRoleLookup, resolvePipelineRole, validatePipelineRoleParams, type PipelineRoleLookup } from "./roles";
import { buildPipeline, isEffectiveRole, loadPipelines, pipelineGraphError, pipelineIdentity, pipelineTaskLinkError, PipelineStoreError, withPipelineMutation } from "./store";
import { ensurePipelineForTask, isTaskSpawnPipelineParams, type TaskPipelineSpawnParams, type TaskSpawnPipelineParams } from "./taskBinding";
import type {
  CreatePipelineRequest,
  EffectivePipelineRole,
  PatchPipelineRequest,
  Pipeline,
  PipelineRoleId,
  PipelineRepoPreflight,
  PipelineRepoPreflightErrorCode,
  PipelineStage,
  PipelineStageInput,
  PipelineStageAttempt,
} from "./types";
import { parseStageVerdict, type ParsedStageVerdict } from "./verdict";

export type PipelineStageSpawn = {
  launchId: string;
  conversationId: string;
  sessionId: string | null;
  "transcript": string | null;
  paneId: string | null;
};

export type PipelineStageLaunchReservation = Pick<PipelineStageSpawn, "launchId" | "conversationId">;
export type PipelineSpawnReceipt = PipelineStageSpawn & {
  state: "starting" | "pane-bound" | "host-verified" | "prompt-delivered" | "path-pending" | "completed" | "failed" | "conflicted";
};

export interface PipelinePorts {
  exec: ExecPort;
  preflightRepo(repoDir: string): PipelineRepoPreflight;
  roleLookup?: PipelineRoleLookup | null;
  spawnAgent(input: {
    role: EffectivePipelineRole;
    cwd: string;
    "prompt": string;
    parentPath: string | null;
    clientAttemptId: string;
    membership: DurableMembershipInput;
    /** Pipeline creator (#393): the container acts for the conversation that
        created it, so reviewer-isolation and depth admission key on this —
        never on the lineage parent, which may be a passed review stage. */
    creatorConversationId: string | null;
    /** Prior-attempt conversation this stage retry terminally supersedes
        (issue #383); attempt chains become round chains automatically. */
    supersedes?: string | null;
  }, onReserved: (reservation: PipelineStageLaunchReservation) => void): Promise<PipelineStageSpawn>;
  spawnReceipt(launchId: string): PipelineSpawnReceipt | null;
  claimSpawnRetry(launchId: string, claimId: string): "claimed" | "settled" | "conflict";
  paneAgentAlive(paneId: string): Promise<boolean>;
  conversationAgentActive(conversationId: string): Promise<boolean | null>;
  durableTurnEvidence(engine: EffectivePipelineRole["engine"], transcriptPath: string): Promise<StageTurnEvidence | null>;
  headCwd(transcriptPath: string): string | null;
  lastMessage(entry: FileEntry): { text: string; ts: number } | null;
  pathForConversation(conversationId: string): string | null;
  sourcePathAllowed(pathname: string): boolean;
  conversationIdForPath(pathname: string): string | null;
  pipelineAdoptionCandidates(pipelineId: string): PipelineAdoptionCandidate[];
  createFlow(req: CreateFlowRequest, entries: FileEntry[]): Promise<{ flow?: Flow; error?: string }>;
  patchFlow(id: string, action: "advance" | "pause" | "resume", note?: string): { error?: string; status?: number };
  closeFlow(id: string): Promise<{ flow?: Flow; error?: string; status?: number } | void>;
  getFlow(id: string): Flow | null;
  findFlow(implementerPath: string, implementerConversationId: string | null, baseRef: string, targetSha: string): Flow | null;
  projectForCwd(cwd: string): string | null;
  now(): string;
}

function engineForTranscript(transcript: string): "claude" | "codex" | null {
  if (codexSessionRootFor(transcript)) return "codex";
  if (claudeProjectRootFor(transcript)) return "claude";
  return null;
}

/**
 * Viewer-managed Claude stages run autonomously. Their role access remains a
 * product-scope contract, while the CLI permission mode must allow ordinary
 * repository reads, GitHub inspection, screenshots, and verification commands
 * without an interactive permission wall.
 */
export function pipelineClaudePermissionMode(role: EffectivePipelineRole): string | null {
  return role.engine === "claude" ? "bypassPermissions" : null;
}

function parentIdentity(parentPath: string | null): {
  conversationId: ViewerConversationId | null;
  sessionKey: ReturnType<typeof sessionKeyFromTranscript>;
} {
  if (!parentPath) return { conversationId: null, sessionKey: null };
  const engine = engineForTranscript(parentPath);
  if (!engine) return { conversationId: null, sessionKey: null };
  const registry = agentRegistry();
  const conversation = registry.conversationForPath(parentPath) ?? registry.ensureConversation(engine, parentPath, null);
  return { conversationId: conversation.id, sessionKey: sessionKeyFromTranscript(engine, parentPath) };
}

async function spawnPipelineAgent(
  input: Parameters<PipelinePorts["spawnAgent"]>[0],
  onReserved: (reservation: PipelineStageLaunchReservation) => void,
): Promise<PipelineStageSpawn> {
  const account = accountManager.resolveSpawn(input.role.engine);
  const parent = parentIdentity(input.parentPath);
  const specBase = freshSpecFor(input.role.engine, input.cwd, {
    model: input.role.model,
    effort: input.role.effort,
    readOnly: input.role.access === "read-only",
    permissionMode: pipelineClaudePermissionMode(input.role),
    codexHome: input.role.engine === "codex" ? account.home : null,
    claudeConfigDir: input.role.engine === "claude" ? account.home : null,
    claudeProjectsDir: input.role.engine === "claude" ? account.transcriptRoot : null,
  });
  const launchProfile = emptyLaunchProfile({
    ...(specBase.launchProfile ?? {}),
    cwd: input.cwd,
    parentConversationId: parent.conversationId,
  });
  const registry = agentRegistry();
  /* Stage-retry supersedence (issue #383): the retry names the prior attempt's
     conversation so its round terminally retires once this spawn settles. A
     reference the registry cannot resolve is dropped, never parks the
     pipeline — the board then simply keeps today's sibling rendering. */
  const supersedes = input.supersedes?.startsWith("conversation_")
    && registry.conversation(input.supersedes as ViewerConversationId)
    ? registry.canonicalConversationId(input.supersedes as ViewerConversationId)
    : null;
  const digest = crypto.createHash("sha256").update(JSON.stringify({
    engine: input.role.engine,
    model: input.role.model,
    effort: input.role.effort,
    cwd: input.cwd,
    parentConversationId: parent.conversationId,
    ...(supersedes ? { supersedes } : {}),
    "prompt": input.prompt,
  })).digest("hex");
  const creatorConversationId = input.creatorConversationId?.startsWith("conversation_")
    ? registry.canonicalConversationId(input.creatorConversationId as ViewerConversationId)
    : null;
  const begun = registry.beginSpawnRequest({
    engine: input.role.engine,
    cwd: input.cwd,
    transport: "structured",
    accountId: account.accountId,
    parentConversationId: parent.conversationId,
    parentSessionKey: parent.sessionKey,
    parentArtifactPath: parent.conversationId ? input.parentPath : null,
    role: input.role.roleId,
    /* Container origin (#393): admission keys on the pipeline creator, so a
       reviewer-lineage-parent stage stays admissible while a reviewer-created
       pipeline is terminally rejected. Retries reuse the same origin, so
       delegation depth is stable across rounds. */
    origin: {
      kind: "container",
      container: "pipeline",
      containerId: input.membership.containerId,
      creatorConversationId,
    },
    memberships: [{ ...input.membership, parentConversationId: parent.conversationId }],
    launchProfile,
    clientAttemptId: input.clientAttemptId,
    requestDigest: digest,
    supersedes,
    supersedesReason: "stage-retry",
  });
  if (begun.kind === "conflict") throw new Error("pipeline spawn attempt conflicts with its original request");
  onReserved({ launchId: begun.receipt.launchId, conversationId: begun.receipt.conversationId });
  if (begun.kind === "replay") {
    const conversation = registry.conversation(begun.receipt.conversationId);
    const transcript = begun.receipt.artifactPath ?? conversation?.generations.at(-1)?.path ?? null;
    return {
      launchId: begun.receipt.launchId,
      conversationId: begun.receipt.conversationId,
      sessionId: begun.receipt.key?.sessionId ?? null,
      transcript,
      paneId: begun.receipt.verifiedHost?.paneId ?? begun.receipt.pane?.paneId ?? null,
    };
  }

  const spec = { ...specBase, launchProfile };
  const client = runtimeHostClient();
  if (!client) throw new Error("pipeline structured runtime host is unavailable");
  const response = await spawnStructuredConversation({
    engine: input.role.engine,
    receipt: begun.receipt,
    spec,
    account,
    "prompt": input.prompt,
    registry,
    client,
  });
  const transcript = response.path ?? null;
  const key = transcript ? sessionKeyFromTranscript(input.role.engine, transcript) : null;
  if (transcript && input.parentPath && parent.conversationId) {
    rememberHandoffChild(transcript, input.parentPath);
    persistHandoffLineage();
  }
  return {
    launchId: begun.receipt.launchId,
    conversationId: begun.receipt.conversationId,
    sessionId: key?.sessionId ?? null,
    transcript,
    paneId: null,
  };
}

export function defaultPipelinePorts(): PipelinePorts {
  let runtimeSnapshot: ReturnType<NonNullable<ReturnType<typeof runtimeHostClient>>["snapshot"]> | null = null;
  return {
    exec: realExec,
    preflightRepo: preflightPipelineRepo,
    roleLookup: pipelineRoleLookup,
    spawnAgent: spawnPipelineAgent,
    spawnReceipt: (launchId) => {
      const receipt = agentRegistry().readOnlySnapshot().receipts[launchId];
      if (!receipt) return null;
      return {
        state: receipt.state,
        launchId: receipt.launchId,
        conversationId: receipt.conversationId,
        sessionId: receipt.key?.sessionId ?? null,
        "transcript": receipt.artifactPath,
        paneId: receipt.verifiedHost?.paneId ?? receipt.pane?.paneId ?? null,
      };
    },
    claimSpawnRetry: (launchId, claimId) => agentRegistry().claimFailedSpawnForRetry(launchId, claimId).kind,
    paneAgentAlive: async (paneId) => {
      const info = await paneInfo(paneId);
      return info !== null && !isShellCommand(info.command);
    },
    conversationAgentActive: async (conversationId) => {
      const client = runtimeHostClient();
      if (!client) return null;
      runtimeSnapshot ??= client.snapshot();
      let snapshot;
      try {
        snapshot = await runtimeSnapshot;
      } catch {
        return null;
      }
      const session = snapshot.sessions.find((item) => item.conversationId === conversationId);
      if (!session) return null;
      if (["dead", "unhosted", "conflict"].includes(session.host)) return false;
      if (session.turn === "idle") return false;
      if (session.turn === "running" || session.turn === "interrupt_requested" || session.attentionIds.length > 0) return true;
      return null;
    },
    durableTurnEvidence: durableStageTurnEvidence,
    headCwd: (transcriptPath) => headCwd(transcriptPath),
    lastMessage: lastAssistantMessage,
    pathForConversation: (conversationId) => conversationId.startsWith("conversation_")
      ? agentRegistry().conversation(conversationId as ViewerConversationId)?.generations.at(-1)?.path ?? null
      : null,
    sourcePathAllowed: transcriptAllowed,
    conversationIdForPath: (pathname) => agentRegistry().conversationForPath(pathname)?.id ?? null,
    pipelineAdoptionCandidates: (pipelineId) => {
      const snapshot = agentRegistry().readOnlySnapshot();
      const receipts = Object.values(snapshot.receipts);
      const candidates: PipelineAdoptionCandidate[] = [];
      for (const [conversationId, memberships] of Object.entries(snapshot.memberships)) {
        for (const membership of memberships) {
          if (membership.kind !== "pipeline" || membership.containerId !== pipelineId
            || !membership.slot.startsWith("adopt:") || !membership.stageId || !membership.parentConversationId) continue;
          const receipt = receipts.find((candidate) => candidate.conversationId === conversationId) ?? null;
          const conversation = snapshot.conversations[conversationId as ViewerConversationId] ?? null;
          const generation = conversation?.generations.at(-1) ?? null;
          const agentPath = receipt?.artifactPath ?? conversation?.generations.at(-1)?.path ?? null;
          if (!agentPath) continue;
          const runtime = membership.runtime ?? (receipt ? {
            engine: receipt.engine,
            model: receipt.launchProfile.model,
            effort: receipt.launchProfile.effort,
          } : conversation ? {
            engine: conversation.engine,
            model: generation?.launchProfile.model ?? null,
            effort: generation?.launchProfile.effort ?? null,
          } : null);
          candidates.push({
            stageId: membership.stageId,
            sourceConversationId: membership.parentConversationId,
            launchId: receipt?.launchId ?? null,
            conversationId,
            sessionId: receipt?.key?.sessionId ?? null,
            agentPath,
            paneId: receipt?.verifiedHost?.paneId ?? receipt?.pane?.paneId ?? null,
            startedAt: receipt?.createdAt ?? membership.createdAt,
            runtime,
          });
        }
      }
      return candidates;
    },
    createFlow: createFlowFromRequest,
    patchFlow: (id, action, note) => patchFlow(id, { action, ...(note ? { note } : {}) }),
    closeFlow,
    getFlow: (id) => loadFlows().find((flow) => flow.id === id) ?? null,
    findFlow: (implementerPath, implementerConversationId, baseRef, targetSha) => loadFlows()
      .filter((flow) =>
        flow.baseRef === baseRef
        && flow.targetSha === targetSha
        && flow.closedAt === null
        && flow.state !== "closed"
        && (flow.implementerPath === implementerPath
          || Boolean(implementerConversationId && flow.implementerConversationId === implementerConversationId)))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0] ?? null,
    projectForCwd,
    now: () => new Date().toISOString(),
  };
}

const spawnsThisProcess = new Set<string>();
const TERMINAL_STATES = new Set<Pipeline["state"]>(["completed", "closed"]);
/** Attempt states that end a round; a pending cursor over one of these queues a
    fresh attempt on the next tick (tickRunStage/tickReviewStage). */
const TERMINAL_ATTEMPT_STATES = new Set<PipelineStageAttempt["state"]>(["passed", "failed", "needs_decision", "skipped"]);


function attemptKey(pipeline: Pipeline, stage: PipelineStage, attempt: PipelineStageAttempt): string {
  return `${pipeline.id}:${stage.id}:${attempt.n}`;
}

function clientAttemptId(pipeline: Pipeline, stage: PipelineStage, attempt: PipelineStageAttempt): string {
  return `pipeline_${pipeline.id}_${stage.id}_${attempt.n}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 128);
}

function currentStage(pipeline: Pipeline): PipelineStage | null {
  if (!pipeline.cursor) return null;
  return pipeline.stages.find((stage) => stage.id === pipeline.cursor?.stageId) ?? null;
}

function runFor(pipeline: Pipeline, stageId: string) {
  return pipeline.runs.find((run) => run.stageId === stageId) ?? null;
}

function currentAttempt(pipeline: Pipeline, stageId: string): PipelineStageAttempt | null {
  return runFor(pipeline, stageId)?.attempts.findLast((attempt) => !attempt.historical) ?? null;
}

function unixMs(value: string | null): number {
  const parsed = value ? Date.parse(value) : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

function park(pipeline: Pipeline, detail: string, attempt?: PipelineStageAttempt | null): void {
  if (attempt && attempt.state !== "failed") attempt.state = "needs_decision";
  if (attempt) attempt.error = detail;
  pipeline.state = "needs_decision";
  pipeline.pausedState = null;
  pipeline.stateDetail = detail;
}

/** Moves the cursor's lifecycle state while preserving the durable relay record
    (#353): the persisted input/activatedBy of the current activation survive
    every pending → spawning → running → committing transition, so a crash at
    any point replays the identical prompt. A move to a DIFFERENT stage must go
    through advance/fail-edge routing, which writes a fresh relay record. */
function setCursorState(pipeline: Pipeline, stageId: string, state: NonNullable<Pipeline["cursor"]>["state"]): void {
  const keep = pipeline.cursor?.stageId === stageId
    ? { input: pipeline.cursor.input, activatedBy: pipeline.cursor.activatedBy }
    : { input: null, activatedBy: null };
  pipeline.cursor = { stageId, state, ...keep };
}

function normalizedOutput(pipeline: Pipeline): string {
  if (!pipeline.cursor) return "";
  const currentIndex = pipeline.stages.findIndex((stage) => stage.id === pipeline.cursor?.stageId);
  for (let index = currentIndex - 1; index >= 0; index -= 1) {
    const attempt = currentAttempt(pipeline, pipeline.stages[index]!.id);
    if (attempt?.output) return attempt.output;
  }
  return "";
}

/** The durable activation that placed a stage's current attempt here (#353): the
    attempt's own `activatedBy`, or the cursor's while the attempt is still
    forming. Null for the root stage and for migrated pre-v3 attempts (unknown
    provenance), which signals the positional scan. */
function stageActivation(pipeline: Pipeline, stageId: string): PipelineStageAttempt["activatedBy"] {
  return currentAttempt(pipeline, stageId)?.activatedBy
    ?? (pipeline.cursor?.stageId === stageId ? pipeline.cursor.activatedBy : null);
}

/** Walks the durable activation lineage backwards from a stage's current
    attempt, yielding each graph ancestor (nearest first) along the recorded
    provenance chain, so merges, jumps, and fail loops resolve to the stage that
    activated this one. The walk stops at the migration boundary — an ancestor
    whose own `activatedBy` is null (a migrated pre-v3 attempt, or the root) —
    and marks it with `boundary: true`, so a caller resumes the positional scan
    there. A repeated activation key ends the walk to bound a cycle. */
function* activationLineage(pipeline: Pipeline, stageId: string): Generator<{ stage: PipelineStage; attempt: PipelineStageAttempt; boundary: boolean }> {
  const seen = new Set<string>();
  let activation = stageActivation(pipeline, stageId);
  while (activation) {
    const key = `${activation.stageId}:${activation.attempt}`;
    if (seen.has(key)) break;
    seen.add(key);
    const stage = pipeline.stages.find((candidate) => candidate.id === activation!.stageId) ?? null;
    const attempt = runFor(pipeline, activation.stageId)?.attempts.find((candidate) => candidate.n === activation!.attempt) ?? null;
    if (!stage || !attempt) break;
    yield { stage, attempt, boundary: attempt.activatedBy == null };
    activation = attempt.activatedBy;
  }
}

/** The lineage parent transcript a fresh stage inherits (#353): the nearest
    passed or skipped ancestor along the durable activation graph. The positional
    scan resumes at the lineage's migration boundary (an ancestor with
    activatedBy null) and for an anchor with no provenance, so a migrated pre-v3
    pipeline and a mixed v2/v3 history keep the legacy parent selection. */
function latestCompletedAgentPath(pipeline: Pipeline, beforeStageId?: string): string | null {
  let atBoundary = true;
  if (beforeStageId) {
    for (const step of activationLineage(pipeline, beforeStageId)) {
      if (step.attempt.agentPath && (step.attempt.state === "passed" || step.attempt.state === "skipped")) return step.attempt.agentPath;
      atBoundary = step.boundary;
    }
  }
  if (!atBoundary) return pipeline.srcPath;
  const stop = beforeStageId ? pipeline.stages.findIndex((stage) => stage.id === beforeStageId) : pipeline.stages.length;
  for (let index = stop - 1; index >= 0; index -= 1) {
    const attempt = currentAttempt(pipeline, pipeline.stages[index]!.id);
    if (attempt?.agentPath && (attempt.state === "passed" || attempt.state === "skipped")) return attempt.agentPath;
  }
  return pipeline.srcPath;
}

/** The run whose session a review-loop stage reviews (#353): the nearest passed
    run ancestor along the activation graph, so a merge or jump review binds to
    the run that activated it. The positional scan resumes at the migration
    boundary and for an anchor with no provenance, so migrated and mixed v2/v3
    histories keep the legacy implementer selection. */
function latestPassedRun(pipeline: Pipeline, stageId: string): PipelineStageAttempt | null {
  let atBoundary = true;
  for (const step of activationLineage(pipeline, stageId)) {
    if (step.stage.kind === "run" && step.attempt.state === "passed" && step.attempt.agentPath) return step.attempt;
    atBoundary = step.boundary;
  }
  if (!atBoundary) return null;
  const stop = pipeline.stages.findIndex((stage) => stage.id === stageId);
  for (let index = stop - 1; index >= 0; index -= 1) {
    const stage = pipeline.stages[index]!;
    if (stage.kind !== "run") continue;
    const attempt = currentAttempt(pipeline, stage.id);
    if (attempt?.state === "passed" && attempt.agentPath) return attempt;
  }
  return null;
}

function newAttempt(pipeline: Pipeline, stage: PipelineStage): PipelineStageAttempt | null {
  const run = runFor(pipeline, stage.id);
  if (!run) {
    park(pipeline, "pipeline stage run record is missing");
    return null;
  }
  const cursorRelay = pipeline.cursor?.stageId === stage.id ? pipeline.cursor : null;
  const attempt: PipelineStageAttempt = {
    n: run.attempts.length + 1,
    state: "pending",
    effectiveRole: structuredClone(stage.effectiveRole),
    launchId: null,
    conversationId: null,
    sessionId: null,
    agentPath: null,
    paneId: null,
    flowId: null,
    expectedReviewHeadSha: null,
    reviewHeadSha: null,
    startedAt: null,
    completedAt: null,
    /* The activation's persisted relay record becomes the attempt's durable
       provenance; the spawn digest derives from it, so it is stable across
       restarts and sibling-record evolution (#353 exactly-once). */
    input: cursorRelay?.input ?? null,
    activatedBy: cursorRelay?.activatedBy ? { ...cursorRelay.activatedBy } : null,
    output: null,
    verdict: null,
    error: null,
  };
  run.attempts.push(attempt);
  return attempt;
}

export type PipelineAttemptConversationRef = {
  sourceConversationId: string;
  launchId: string | null;
  conversationId: string;
  sessionId: string | null;
  agentPath: string;
  paneId: string | null;
  startedAt: string | null;
  runtime?: Pick<EffectivePipelineRole, "engine" | "model" | "effort"> | null;
};

export type PipelineAdoptionCandidate = PipelineAttemptConversationRef & { stageId: string };

export type PipelineAttemptTarget = {
  pipelineId: string;
  stageId: string;
  stageOrder: number;
  role: string;
};

/** Resolves the durable container slot that owns a fallback spawn source. */
export function pipelineAttemptTargetForSource(sourceConversationId: string): PipelineAttemptTarget | null {
  for (const pipeline of loadPipelines()) {
    for (let stageOrder = 0; stageOrder < pipeline.runs.length; stageOrder += 1) {
      const run = pipeline.runs[stageOrder]!;
      const source = run.attempts.find((attempt) => attempt.conversationId === sourceConversationId);
      if (!source) continue;
      return {
        pipelineId: pipeline.id,
        stageId: run.stageId,
        stageOrder,
        role: source.effectiveRole.roleId ?? "agent",
      };
    }
  }
  return null;
}

/** Adds a lineage child as historical evidence on its source stage. */
export function adoptAttempt(
  pipeline: Pipeline,
  stageId: string,
  conversationRef: PipelineAttemptConversationRef,
): PipelineStageAttempt | null {
  const run = runFor(pipeline, stageId);
  const stage = pipeline.stages.find((candidate) => candidate.id === stageId) ?? null;
  if (!run || !stage) return null;
  const existing = run.attempts.find((attempt) =>
    attempt.conversationId === conversationRef.conversationId
    || (conversationRef.launchId !== null && attempt.launchId === conversationRef.launchId));
  if (existing) return existing;
  const source = run.attempts.find((attempt) => attempt.conversationId === conversationRef.sourceConversationId) ?? null;
  if (!source) return null;
  const effectiveRole = structuredClone(source.effectiveRole ?? stage.effectiveRole);
  if (conversationRef.runtime) {
    effectiveRole.engine = conversationRef.runtime.engine;
    effectiveRole.model = conversationRef.runtime.model;
    effectiveRole.effort = conversationRef.runtime.effort;
  }
  const attempt: PipelineStageAttempt = {
    n: run.attempts.length + 1,
    historical: true,
    state: "running",
    effectiveRole,
    launchId: conversationRef.launchId,
    conversationId: conversationRef.conversationId,
    sessionId: conversationRef.sessionId,
    agentPath: conversationRef.agentPath,
    paneId: conversationRef.paneId,
    flowId: null,
    expectedReviewHeadSha: null,
    reviewHeadSha: null,
    startedAt: conversationRef.startedAt,
    completedAt: null,
    input: source.input,
    activatedBy: source.activatedBy ? { ...source.activatedBy } : null,
    output: null,
    verdict: null,
    error: null,
  };
  run.attempts.push(attempt);
  return attempt;
}

export async function adoptPipelineAttemptFromSource(
  sourceConversationId: string,
  conversationRef: Omit<PipelineAttemptConversationRef, "sourceConversationId">,
): Promise<{ pipeline: Pipeline; stageId: string; attempt: PipelineStageAttempt } | null> {
  return withPipelineMutation((pipelines, persist) => {
    for (const pipeline of pipelines) {
      for (const run of pipeline.runs) {
        if (!run.attempts.some((attempt) => attempt.conversationId === sourceConversationId)) continue;
        const attempt = adoptAttempt(pipeline, run.stageId, { ...conversationRef, sourceConversationId });
        if (!attempt) return null;
        persist();
        return { pipeline, stageId: run.stageId, attempt };
      }
    }
    return null;
  });
}

function reconcilePendingPipelineAdoptions(pipeline: Pipeline, ports: PipelinePorts): boolean {
  let changed = false;
  for (const candidate of ports.pipelineAdoptionCandidates(pipeline.id)) {
    const run = runFor(pipeline, candidate.stageId);
    const existing = run?.attempts.find((attempt) =>
      attempt.conversationId === candidate.conversationId
      || (candidate.launchId !== null && attempt.launchId === candidate.launchId));
    if (existing) continue;
    const adopted = adoptAttempt(pipeline, candidate.stageId, candidate);
    changed = adopted !== null || changed;
  }
  return changed;
}

async function reconcileHistoricalAttempts(pipeline: Pipeline, entries: FileEntry[], ports: PipelinePorts): Promise<boolean> {
  let changed = false;
  for (const run of pipeline.runs) {
    for (const attempt of run.attempts) {
      if (!attempt.historical || !["spawning", "running"].includes(attempt.state)) continue;
      const before = JSON.stringify(attempt);
      updateAttemptIdentity(pipeline, attempt, entries, ports);
      if (!attempt.agentPath) {
        if (attempt.launchId) {
          const receipt = ports.spawnReceipt(attempt.launchId);
          if (receipt) {
            attempt.conversationId = receipt.conversationId;
            attempt.sessionId = receipt.sessionId;
            attempt.agentPath = receipt.transcript;
            attempt.paneId = receipt.paneId;
            if (receipt.state === "failed" || receipt.state === "conflicted") {
              attempt.state = "failed";
              attempt.completedAt = ports.now();
              attempt.error = `historical spawn ended in receipt state ${receipt.state}`;
            }
          }
        }
        changed = JSON.stringify(attempt) !== before || changed;
        continue;
      }
      const durable = await ports.durableTurnEvidence(attempt.effectiveRole.engine, attempt.agentPath);
      const terminal = durable?.turn === "terminal" && durable.message !== null && durable.message.ts > unixMs(attempt.startedAt);
      if (!terminal) {
        changed = JSON.stringify(attempt) !== before || changed;
        continue;
      }
      const parsed = parseStageVerdict(durable.message!.text);
      attempt.completedAt = new Date(durable.message!.ts).toISOString();
      attempt.output = null;
      if (!parsed) {
        attempt.state = "failed";
        attempt.error = "historical attempt completed without a valid final JSON verdict";
      } else if ("failureReason" in parsed) {
        attempt.state = "failed";
        attempt.error = parsed.failureReason;
      } else {
        attempt.verdict = parsed.verdict;
        attempt.state = parsed.verdict.status === "pass" ? "passed" : parsed.verdict.status === "fail" ? "failed" : "needs_decision";
        attempt.error = parsed.verdict.findings?.[0] ?? null;
      }
      changed = JSON.stringify(attempt) !== before || changed;
    }
  }
  return changed;
}

function attachReviewFlowAttempt(attempt: PipelineStageAttempt, flow: Flow): void {
  attempt.flowId = flow.id;
  const round = flow.rounds.at(-1);
  attempt.launchId = round?.launchId ?? attempt.launchId;
  attempt.sessionId = round?.sessionId ?? attempt.sessionId;
  attempt.agentPath = round?.reviewerPath ?? attempt.agentPath;
  attempt.conversationId = round?.reviewerConversationId ?? attempt.conversationId;
  attempt.paneId = round?.reviewerPane?.paneId ?? attempt.paneId;
}

const TERMINAL_REVIEW_FLOW_STATES: ReadonlySet<Flow["state"]> = new Set([
  "approved", "done_comment", "needs_decision", "closed",
]);

function flowSourceUpdatedAt(flow: Flow): string | null {
  const values = [flow.createdAt, flow.closedAt];
  for (const round of flow.rounds) {
    values.push(round.startedAt, round.spawnStartedAt ?? null, round.reviewedAt, round.relayStartedAt ?? null,
      round.relayedAt, round.terminalAt ?? null);
  }
  return values.filter((value): value is string => Boolean(value))
    .sort((left, right) => right.localeCompare(left))[0] ?? null;
}

function synchronizeReviewFlowAttempt(attempt: PipelineStageAttempt, flow: Flow, synchronizedAt: string): boolean {
  const round = flow.rounds.at(-1) ?? null;
  const implementerHeadSha = flow.rounds.findLast((candidate) => candidate.reviewHeadSha)?.reviewHeadSha ?? flow.targetSha ?? null;
  const reviewerHeadSha = round?.reviewHeadSha ?? null;
  const sourceUpdatedAt = flowSourceUpdatedAt(flow);
  const sourceMs = sourceUpdatedAt ? Date.parse(sourceUpdatedAt) : Number.NaN;
  const syncMs = Date.parse(synchronizedAt);
  const snapshot = {
    roundCount: flow.rounds.length,
    implementerHeadSha,
    reviewerHeadSha,
    verdict: round?.verdict ?? null,
    relayState: flow.state,
    terminalState: TERMINAL_REVIEW_FLOW_STATES.has(flow.state) ? flow.state : null,
    sourceUpdatedAt,
  };
  const generation = crypto.createHash("sha256").update(JSON.stringify({
    ...snapshot,
    stateDetail: flow.stateDetail,
    implementerPath: flow.implementerPath,
    implementerConversationId: flow.implementerConversationId ?? null,
    rounds: flow.rounds.map((candidate) => ({
      n: candidate.n,
      reviewerPath: candidate.reviewerPath,
      reviewerConversationId: candidate.reviewerConversationId ?? null,
      reviewHeadSha: candidate.reviewHeadSha ?? null,
      verdict: candidate.verdict,
      reviewedAt: candidate.reviewedAt,
      relayStartedAt: candidate.relayStartedAt ?? null,
      relayedAt: candidate.relayedAt,
      terminalAt: candidate.terminalAt ?? null,
      error: candidate.error,
    })),
  })).digest("hex").slice(0, 16);
  if (attempt.reviewFlowSync?.generation === generation) return false;
  const synchronized = attempt.reviewFlowSync;
  if (synchronized) {
    if (snapshot.roundCount < synchronized.roundCount) return false;
    const synchronizedSourceMs = synchronized.sourceUpdatedAt ? Date.parse(synchronized.sourceUpdatedAt) : Number.NaN;
    if (snapshot.roundCount === synchronized.roundCount
      && Number.isFinite(sourceMs)
      && Number.isFinite(synchronizedSourceMs)
      && sourceMs < synchronizedSourceMs) return false;
  }
  attachReviewFlowAttempt(attempt, flow);
  if (reviewerHeadSha) {
    attempt.expectedReviewHeadSha = reviewerHeadSha;
    attempt.reviewHeadSha = reviewerHeadSha;
  }
  attempt.reviewFlowSync = {
    generation,
    ...snapshot,
    synchronizedAt,
    lagMs: Number.isFinite(sourceMs) && Number.isFinite(syncMs) ? Math.max(0, syncMs - sourceMs) : null,
  };
  return true;
}

/** Apply the embedded flow's current durable generation to every bound parent.
    Shared by controller recovery and the board read path. */
export function reconcileEmbeddedReviewFlows(
  pipelines: Pipeline[],
  flows: readonly Flow[],
  synchronizedAt = new Date().toISOString(),
): boolean {
  const byId = new Map(flows.map((flow) => [flow.id, flow] as const));
  const claimedFlowIds = new Set(pipelines.flatMap((pipeline) =>
    pipeline.runs.flatMap((run) => run.attempts.flatMap((attempt) => attempt.flowId ? [attempt.flowId] : []))));
  let changed = false;
  for (const pipeline of pipelines) {
    /* Flow creation commits before the parent can persist flowId. Recover that
       flow-first crash only from the same unique identity used at creation;
       ambiguity fails closed so projection cannot claim a foreign flow. */
    for (const stage of pipeline.stages) {
      if (stage.kind !== "review-loop") continue;
      const attempt = currentAttempt(pipeline, stage.id);
      if (!attempt || attempt.flowId || !attempt.expectedReviewHeadSha) continue;
      const implementer = latestPassedRun(pipeline, stage.id);
      if (!implementer?.agentPath) continue;
      const candidates = flows.filter((flow) =>
        !claimedFlowIds.has(flow.id)
        && flow.baseRef === pipeline.baseRef
        && flow.targetSha === attempt.expectedReviewHeadSha
        && flow.closedAt === null
        && flow.state !== "closed"
        && (flow.implementerPath === implementer.agentPath
          || Boolean(implementer.conversationId && flow.implementerConversationId === implementer.conversationId)));
      if (candidates.length === 1) {
        attempt.flowId = candidates[0]!.id;
        claimedFlowIds.add(candidates[0]!.id);
        changed = true;
      }
    }
    for (const run of pipeline.runs) {
      for (const attempt of run.attempts) {
        const flow = attempt.flowId ? byId.get(attempt.flowId) : null;
        if (flow) changed = synchronizeReviewFlowAttempt(attempt, flow, synchronizedAt) || changed;
      }
    }
  }
  return changed;
}

/** Advance along the pass edge, persisting the relay record: the completed
    attempt's output is the next activation's `{{prev.output}}`, written in the
    same mutation as the verdict/commit that produced it (exactly-once, #353). */
function advancePipeline(pipeline: Pipeline, stage: PipelineStage, ports: PipelinePorts, attempt?: PipelineStageAttempt | null): void {
  if (stage.next === null) {
    pipeline.cursor = null;
    pipeline.state = "completed";
    pipeline.stateDetail = null;
    pipeline.pausedState = null;
    pipeline.closedAt = ports.now();
    return;
  }
  pipeline.cursor = {
    stageId: stage.next,
    state: "pending",
    input: attempt?.output ?? null,
    activatedBy: attempt ? { stageId: stage.id, attempt: attempt.n, edge: "pass" } : null,
  };
  pipeline.state = "running";
  pipeline.stateDetail = null;
  pipeline.pausedState = null;
}

/** Attempts of the fail edge's target that this stage's fail edge activated —
    the derived (never stored) loop budget, so counts cannot drift from the
    durable evidence. */
function failEdgeRoundsUsed(pipeline: Pipeline, stage: PipelineStage): number {
  if (!stage.onFail) return 0;
  const target = runFor(pipeline, stage.onFail.to);
  if (!target) return 0;
  return target.attempts.filter((attempt) => !attempt.historical && attempt.activatedBy?.edge === "fail" && attempt.activatedBy.stageId === stage.id).length;
}

/** The `{{prev.output}}` payload a fail edge forwards: the failed attempt's
    narrative output plus its structured findings, so the loop target sees what
    to fix without re-deriving it from transcripts. */
function failEdgeInput(parsed: ParsedStageVerdict): string | null {
  const findings = parsed.verdict.findings?.length
    ? `Fail verdict findings:\n${parsed.verdict.findings.map((finding) => `- ${finding}`).join("\n")}`
    : "";
  const combined = [parsed.output, findings].filter(Boolean).join("\n\n").trim();
  return combined || null;
}

function commitPassedStage(
  pipeline: Pipeline,
  stage: PipelineStage,
  attempt: PipelineStageAttempt,
  ports: PipelinePorts,
): void {
  const allowCommit = stage.kind === "run" && attempt.effectiveRole.access === "read-write";
  const result = commitPipelineStage(pipeline, stage.id, allowCommit, ports.exec);
  if (!result.ok) {
    park(pipeline, result.error, attempt);
    return;
  }
  if (stage.kind === "review-loop" && result.sha !== attempt.reviewHeadSha) {
    park(
      pipeline,
      `approved review flow head mismatch during settlement: reviewed ${attempt.reviewHeadSha ?? "no exact head"}, settled ${result.sha}`,
      attempt,
    );
    return;
  }
  pipeline.lastPassedCommit = result.sha;
  attempt.state = "passed";
  attempt.completedAt = ports.now();
  advancePipeline(pipeline, stage, ports, attempt);
}

/** One-shot settlement of a completed stage turn. Semantic contradictions park
    with their parser reason. Valid verdicts are recorded before settlement. */
function settleStageVerdict(
  pipeline: Pipeline,
  stage: PipelineStage,
  attempt: PipelineStageAttempt,
  parsed: NonNullable<ReturnType<typeof parseStageVerdict>>,
  ports: PipelinePorts,
  persist: () => void,
): void {
  attempt.output = parsed.output;
  if ("failureReason" in parsed) {
    attempt.completedAt = ports.now();
    park(pipeline, parsed.failureReason, attempt);
    return;
  }
  attempt.verdict = parsed.verdict;
  if (parsed.verdict.status !== "pass") {
    attempt.state = parsed.verdict.status === "fail" ? "failed" : "needs_decision";
    attempt.completedAt = ports.now();
    /* Fail-edge routing (#353): a fail verdict on a stage with a fail edge and
       remaining round budget advances the cursor along that edge instead of
       parking. The failed attempt keeps its truthful failed state and verdict;
       the relay record (input + fail activation) lands in the SAME atomic
       mutation as the verdict. No worktree reset — the target continues from
       lastPassedCommit plus its own committed passes. needs_decision always
       parks; an exhausted budget parks with an actionable detail. */
    if (parsed.verdict.status === "fail" && stage.onFail) {
      const targetStage = pipeline.stages.find((candidate) => candidate.id === stage.onFail!.to);
      const used = failEdgeRoundsUsed(pipeline, stage);
      if (targetStage && used < stage.onFail.maxRounds) {
        pipeline.cursor = {
          stageId: targetStage.id,
          state: "pending",
          input: failEdgeInput(parsed),
          activatedBy: { stageId: stage.id, attempt: attempt.n, edge: "fail" },
        };
        pipeline.state = "running";
        pipeline.stateDetail = null;
        pipeline.pausedState = null;
        return;
      }
      if (targetStage) {
        park(pipeline, `fail-edge budget exhausted after ${used} round(s): ${parsed.verdict.findings?.[0] ?? "stage verdict: fail"}`, attempt);
        return;
      }
    }
    park(pipeline, parsed.verdict.findings?.[0] ?? `stage verdict: ${parsed.verdict.status}`, attempt);
    return;
  }
  attempt.state = "committing";
  setCursorState(pipeline, stage.id, "committing");
  persist();
  commitPassedStage(pipeline, stage, attempt, ports);
}

function updateAttemptIdentity(pipeline: Pipeline, attempt: PipelineStageAttempt, entries: FileEntry[], ports: PipelinePorts): void {
  if (attempt.conversationId) {
    const currentPath = ports.pathForConversation(attempt.conversationId);
    if (currentPath) attempt.agentPath = currentPath;
  }
  if (!attempt.agentPath && attempt.sessionId) {
    attempt.agentPath = entries.find((entry) => path.basename(entry.path).includes(attempt.sessionId!))?.path ?? null;
  }
  if (attempt.agentPath) {
    attempt.conversationId ??= ports.conversationIdForPath(attempt.agentPath);
    attempt.sessionId ??= sessionKeyFromTranscript(attempt.effectiveRole.engine, attempt.agentPath)?.sessionId ?? null;
  }
}

function rebindPipelineAttemptPaths(pipeline: Pipeline, ports: PipelinePorts): boolean {
  let changed = false;
  if (pipeline.srcConversationId) {
    const currentPath = ports.pathForConversation(pipeline.srcConversationId);
    if (currentPath && currentPath !== pipeline.srcPath) {
      pipeline.srcPath = currentPath;
      changed = true;
    }
  }
  for (const run of pipeline.runs) {
    for (const attempt of run.attempts) {
      if (!attempt.conversationId) continue;
      const currentPath = ports.pathForConversation(attempt.conversationId);
      if (!currentPath || currentPath === attempt.agentPath) continue;
      attempt.agentPath = currentPath;
      changed = true;
    }
  }
  return changed;
}

async function tickRunStage(
  pipeline: Pipeline,
  stage: PipelineStage,
  entries: FileEntry[],
  ports: PipelinePorts,
  persist: () => void,
): Promise<void> {
  const prior = currentAttempt(pipeline, stage.id);
  const attempt = pipeline.cursor?.state === "pending" && prior && ["passed", "failed", "needs_decision", "skipped"].includes(prior.state)
    ? newAttempt(pipeline, stage)
    : prior ?? newAttempt(pipeline, stage);
  if (!attempt || pipeline.state === "needs_decision") return;

  if (attempt.state === "committing") {
    commitPassedStage(pipeline, stage, attempt, ports);
    return;
  }

  if (attempt.state === "pending") {
    attempt.state = "spawning";
    attempt.startedAt = ports.now();
    setCursorState(pipeline, stage.id, "spawning");
    spawnsThisProcess.add(attemptKey(pipeline, stage, attempt));
    persist();
    try {
      /* {{prev.output}} comes from the attempt's persisted relay input (#353),
         so the spawn digest is stable across restarts; a migrated pre-v3
         attempt (input === null with no recorded activation) keeps the legacy
         positional scan byte-identically. */
      const prompt = renderStagePrompt(
        pipeline,
        stage,
        attempt.effectiveRole,
        attempt.activatedBy ? attempt.input ?? "" : attempt.input ?? normalizedOutput(pipeline),
      );
      /* The retried attempt supersedes its predecessor's round (issue #383):
         the prior attempt of the SAME stage that carries a conversation. */
      const priorAttempt = runFor(pipeline, stage.id)?.attempts.filter((candidate) => !candidate.historical).at(-2) ?? null;
      const spawned = await ports.spawnAgent({
        role: attempt.effectiveRole,
        cwd: pipeline.worktreeDir,
        prompt,
        parentPath: latestCompletedAgentPath(pipeline, stage.id),
        clientAttemptId: clientAttemptId(pipeline, stage, attempt),
        creatorConversationId: pipeline.srcConversationId,
        supersedes: priorAttempt?.conversationId ?? null,
        membership: {
          kind: "pipeline",
          containerId: pipeline.id,
          role: attempt.effectiveRole.roleId ?? "agent",
          slot: `${stage.id}:${attempt.n}`,
          stageId: stage.id,
          stageOrder: pipeline.stages.indexOf(stage),
          round: attempt.n,
          parentConversationId: null,
        },
      }, (reservation) => {
        attempt.launchId = reservation.launchId;
        attempt.conversationId = reservation.conversationId;
        persist();
      });
      attempt.launchId = spawned.launchId;
      attempt.conversationId = spawned.conversationId;
      attempt.sessionId = spawned.sessionId;
      attempt.agentPath = spawned.transcript;
      attempt.paneId = spawned.paneId;
      attempt.state = "running";
      setCursorState(pipeline, stage.id, "running");
    } catch (error) {
      park(pipeline, error instanceof Error ? error.message : String(error), attempt);
    } finally {
      /* The key only means "this spawn is in flight in this process". */
      spawnsThisProcess.delete(attemptKey(pipeline, stage, attempt));
    }
    return;
  }

  if (attempt.state === "spawning") {
    if (!spawnsThisProcess.has(attemptKey(pipeline, stage, attempt)) && !attempt.launchId) {
      park(pipeline, "stage spawn was interrupted before durable launch evidence", attempt);
      return;
    }
    if (!spawnsThisProcess.has(attemptKey(pipeline, stage, attempt)) && attempt.launchId) {
      const receipt = ports.spawnReceipt(attempt.launchId);
      if (!receipt) {
        park(pipeline, "stage spawn receipt disappeared before recovery", attempt);
        return;
      }
      attempt.conversationId = receipt.conversationId;
      attempt.sessionId = receipt.sessionId;
      attempt.agentPath = receipt.transcript;
      attempt.paneId = receipt.paneId;
      if (receipt.state === "failed" || receipt.state === "conflicted" || (receipt.state === "starting" && !receipt.paneId && !receipt.transcript)) {
        park(pipeline, `stage spawn cannot recover from receipt state ${receipt.state}`, attempt);
        return;
      }
    }
    attempt.state = "running";
  }

  updateAttemptIdentity(pipeline, attempt, entries, ports);
  const structuredActive = !attempt.paneId && attempt.conversationId
    ? await ports.conversationAgentActive(attempt.conversationId)
    : null;
  if (!attempt.agentPath) {
    if (structuredActive === false) park(pipeline, "structured stage ended before its session was discovered", attempt);
    else if (attempt.paneId && !(await ports.paneAgentAlive(attempt.paneId))) park(pipeline, "stage agent exited before its session was discovered", attempt);
    return;
  }
  const entry = entries.find((candidate) => candidate.path === attempt!.agentPath);
  /* Cheap live path: the scan projects an open turn and the runtime ledger does
     not contradict it — no durable read needed while the agent works. A stalled
     projection is only cheap evidence for pane-hosted attempts (their liveness
     probe guards settlement): scanner resource-scope inheritance keeps
     `jsonl_turn_stalled` frozen at the final byte size, and a stale `running`
     runtime ledger cannot contradict it, so a pane-less structured attempt must
     fall through to the durable transcript read instead (#337). */
  const scanProjectsOpenTurn = entry?.activity === "live"
    || entry?.activityReason === "jsonl_turn_open"
    || (entry?.activityReason === "jsonl_turn_stalled" && attempt.paneId !== null);
  if (entry && structuredActive !== false && scanProjectsOpenTurn) return;

  /* The transcript artifact is the completion authority (#337). A terminal turn
     whose completion evidence belongs to this attempt and ends in a valid fenced
     verdict settles once — even when the runtime ledger is stale `running`, the
     scan projection transiently lost the transcript, or the host is already
     gone. A busy turn is mid-work: its messages are never verdict candidates. */
  const durable = await ports.durableTurnEvidence(attempt.effectiveRole.engine, attempt.agentPath);
  const durableTerminal = durable?.turn === "terminal" && durable.message !== null && durable.message.ts > unixMs(attempt.startedAt);
  if (durable && durableTerminal) {
    const parsed = parseStageVerdict(durable.message!.text);
    if (parsed) {
      settleStageVerdict(pipeline, stage, attempt, parsed, ports, persist);
      return;
    }
  }
  if (!entry) {
    if (durableTerminal) park(pipeline, "stage completed without a valid final JSON verdict", attempt);
    /* A readable durable artifact means the disappearance is a projection loss,
       not an ended stage — wait for the scan or the terminal turn evidence. */
    else if (durable) return;
    else if (structuredActive === false) park(pipeline, "structured stage ended after its transcript disappeared from the scan", attempt);
    else if (attempt.paneId && !(await ports.paneAgentAlive(attempt.paneId))) park(pipeline, "stage agent exited after its transcript disappeared from the scan", attempt);
    return;
  }
  if (structuredActive === true) return;
  /* A recovered idle host over a mid-turn transcript must not terminalize the
     attempt; completion needs turn evidence, not just a trailing message — even
     one that parses as a valid fenced verdict. */
  if (durable?.turn === "busy" && !attempt.paneId) return;
  const message = ports.lastMessage(entry);
  if (!message || message.ts <= unixMs(attempt.startedAt)) {
    if (structuredActive === false) park(pipeline, "structured stage ended without producing a verdict", attempt);
    else if (attempt.paneId && !(await ports.paneAgentAlive(attempt.paneId))) park(pipeline, "stage agent exited without producing a verdict", attempt);
    return;
  }
  const parsed = parseStageVerdict(message.text);
  if (!parsed) {
    park(pipeline, "stage completed without a valid final JSON verdict", attempt);
    return;
  }
  settleStageVerdict(pipeline, stage, attempt, parsed, ports, persist);
}

/** Substitute the {{task}}/{{prev.output}} placeholders and trim. The relay
    payload prefers the cursor's persisted input (#353), falling back to the
    legacy positional scan only for pre-v3 activations without provenance. */
function renderNoteTemplate(text: string, pipeline: Pipeline): string {
  const relay = pipeline.cursor?.activatedBy
    ? pipeline.cursor.input ?? ""
    : pipeline.cursor?.input ?? normalizedOutput(pipeline);
  return text
    .split("{{task}}").join(pipeline.task)
    .split("{{prev.output}}").join(relay)
    .trim();
}

const FENCE_MARKER = "\n\nSafety fences:\n";

/**
 * Fits the review-loop stage's directive + role scaffold into the flow note's
 * transmissible cap (MAX_FLOW_NOTE_LENGTH; the flow layer truncates anything
 * longer). The operator's directive and the role's safety fences always survive
 * whole; the scaffold *body* (supplementary role guidance) is what gets trimmed
 * to make room. When the directive and fences together already exceed the cap,
 * any truncation would drop acceptance criteria, so this returns an actionable
 * error for the caller to park on.
 */
export function reviewNote(pipeline: Pipeline, stage: PipelineStage, role: EffectivePipelineRole): { note: string } | { error: string } {
  const prompt = renderNoteTemplate(stage.prompt, pipeline);
  const scaffold = role.roleId && role.promptScaffold ? renderNoteTemplate(role.promptScaffold, pipeline) : "";
  const fenceIndex = scaffold ? scaffold.lastIndexOf(FENCE_MARKER) : -1;
  const body = fenceIndex >= 0 ? scaffold.slice(0, fenceIndex) : scaffold;
  const fences = fenceIndex >= 0 ? scaffold.slice(fenceIndex) : "";

  /* The directive + fences are non-negotiable; if they don't both fit, park. */
  if (prompt.length + fences.length > MAX_FLOW_NOTE_LENGTH) {
    return {
      error: `review directive is too long for the reviewer note (${prompt.length + fences.length} chars after expansion; the reviewer receives at most ${MAX_FLOW_NOTE_LENGTH}). Shorten this stage's prompt.`,
    };
  }
  if (!scaffold) return { note: prompt };

  const header = `\n\nReviewer role scaffold (${role.roleId}):\n`;
  const bodyBudget = MAX_FLOW_NOTE_LENGTH - prompt.length - header.length - fences.length;
  const trimmedBody = bodyBudget > 0 ? body.slice(0, bodyBudget) : "";
  return { note: trimmedBody ? `${prompt}${header}${trimmedBody}${fences}` : `${prompt}${fences}` };
}

async function tickReviewStage(
  pipeline: Pipeline,
  stage: PipelineStage,
  entries: FileEntry[],
  ports: PipelinePorts,
  persist: () => void,
): Promise<void> {
  const prior = currentAttempt(pipeline, stage.id);
  const attempt = pipeline.cursor?.state === "pending" && prior && ["passed", "failed", "needs_decision", "skipped"].includes(prior.state)
    ? newAttempt(pipeline, stage)
    : prior ?? newAttempt(pipeline, stage);
  if (!attempt || pipeline.state === "needs_decision") return;
  if (attempt.state === "committing") {
    const fenceError = reviewHeadFenceError(pipeline, attempt, ports);
    if (fenceError) {
      park(pipeline, fenceError, attempt);
      return;
    }
    commitPassedStage(pipeline, stage, attempt, ports);
    return;
  }
  const implementer = latestPassedRun(pipeline, stage.id);
  if (!implementer?.agentPath) {
    park(pipeline, "review-loop stage requires a passed run session", attempt);
    return;
  }
  if (!attempt.startedAt) attempt.startedAt = ports.now();
  attempt.state = "reviewing";
  setCursorState(pipeline, stage.id, "reviewing");

  if (!attempt.expectedReviewHeadSha) {
    if (!pipeline.lastPassedCommit) {
      park(pipeline, "review-loop stage requires a verified pipeline commit", attempt);
      return;
    }
    attempt.expectedReviewHeadSha = pipeline.lastPassedCommit;
    persist();
  }

  if (!attempt.flowId) {
    const existing = ports.findFlow(implementer.agentPath, implementer.conversationId, pipeline.baseRef, attempt.expectedReviewHeadSha);
    if (existing) {
      attachReviewFlowAttempt(attempt, existing);
      persist();
      return;
    }
    persist();
    const implementerRole: RoleConfig = {
      engine: implementer.effectiveRole.engine,
      model: implementer.effectiveRole.model,
      effort: implementer.effectiveRole.effort,
    };
    const reviewerRole: RoleConfig = {
      engine: attempt.effectiveRole.engine,
      model: attempt.effectiveRole.model,
      effort: attempt.effectiveRole.effort,
    };
    const created = await ports.createFlow({
      implementerPath: implementer.agentPath,
      ...(implementer.conversationId ? { implementerConversationId: implementer.conversationId } : {}),
      deliverKickoff: false,
      roles: { implementer: implementerRole, reviewer: reviewerRole },
      baseMode: "head",
      baseRef: pipeline.baseRef,
      headRef: pipeline.branch,
      targetSha: attempt.expectedReviewHeadSha,
      spec: pipeline.spec ?? pipeline.task,
      mode: "auto",
      reviewerMode: "headless",
      roundLimit: 5,
    }, entries);
    if (!created.flow) {
      park(pipeline, `creating the review flow failed: ${created.error ?? "unknown error"}`, attempt);
      return;
    }
    attachReviewFlowAttempt(attempt, created.flow);
    persist();
    if (created.flow.state === "paused") {
      park(pipeline, `review flow startup paused: ${created.flow.stateDetail ?? "kickoff delivery failed"}`, attempt);
      return;
    }
    const note = reviewNote(pipeline, stage, attempt.effectiveRole);
    if ("error" in note) {
      park(pipeline, note.error, attempt);
      return;
    }
    const advanced = ports.patchFlow(created.flow.id, "advance", note.note);
    if (advanced.error) park(pipeline, `advancing the review flow failed: ${advanced.error}`, attempt);
    return;
  }

  const flow = ports.getFlow(attempt.flowId);
  if (!flow) {
    park(pipeline, "embedded review flow record disappeared", attempt);
    return;
  }
  if (flow.state === "paused") {
    park(pipeline, `review flow paused during startup: ${flow.stateDetail ?? "operator decision required"}`, attempt);
    return;
  }
  /* Advance appends round 1 synchronously, so waiting_ready with zero rounds
     means the advance never landed (crash between persisting flowId and the
     patch) — without a re-issue the flow waits forever for a ready marker a
     verdict-terminated stage transcript will not produce. */
  if (flow.state === "waiting_ready" && flow.rounds.length === 0) {
    const note = reviewNote(pipeline, stage, attempt.effectiveRole);
    if ("error" in note) {
      park(pipeline, note.error, attempt);
      return;
    }
    const advanced = ports.patchFlow(flow.id, "advance", note.note);
    if (advanced.error) park(pipeline, `advancing the review flow failed: ${advanced.error}`, attempt);
    return;
  }
  attachReviewFlowAttempt(attempt, flow);
  const capturedReviewHead = flow.rounds.findLast((round) => round.reviewHeadSha)?.reviewHeadSha ?? null;
  if (capturedReviewHead && attempt.reviewHeadSha !== capturedReviewHead) {
    /* Each repair round establishes a new immutable approval fence. Persist
       both fields together so restart/reload cannot retain the pre-repair SHA
       while the active reviewer and worktree have advanced. */
    attempt.expectedReviewHeadSha = capturedReviewHead;
    attempt.reviewHeadSha = capturedReviewHead;
    persist();
  }
  if (flow.state === "approved") {
    const fenceError = reviewHeadFenceError(pipeline, attempt, ports);
    if (fenceError) {
      park(pipeline, fenceError, attempt);
      return;
    }
    attempt.output = `Review loop approved after ${flow.rounds.length} round(s).`;
    attempt.verdict = { status: "pass", confidence: 1 };
    attempt.state = "committing";
    setCursorState(pipeline, stage.id, "committing");
    persist();
    commitPassedStage(pipeline, stage, attempt, ports);
  } else {
    const terminalError = terminalReviewFlowError(flow);
    if (terminalError) park(pipeline, terminalError, attempt);
  }
}

async function tickPipeline(pipeline: Pipeline, entries: FileEntry[], ports: PipelinePorts, persist: () => void): Promise<boolean> {
  const before = JSON.stringify(pipeline);
  if (pipeline.state === "provisioning") {
    if (!pipeline.baseBranch || !pipeline.baseRef || !pipeline.lastPassedCommit) {
      const base = resolvePipelineBase(pipeline.repoDir, {}, ports.exec);
      if (!base.ok) {
        park(pipeline, base.error);
        return JSON.stringify(pipeline) !== before;
      }
      pipeline.baseBranch = base.baseBranch;
      pipeline.baseRef = base.baseRef;
      pipeline.lastPassedCommit = base.baseRef;
      persist();
    }
    const provisioned = provisionPipelineWorktree(pipeline, ports.exec);
    if (!provisioned.ok) park(pipeline, provisioned.error);
    else {
      pipeline.baseBranch = provisioned.baseBranch ?? "";
      pipeline.baseRef = provisioned.sha;
      pipeline.lastPassedCommit = provisioned.sha;
      pipeline.state = "running";
      pipeline.stateDetail = null;
    }
  } else if (pipeline.state === "running") {
    const stage = currentStage(pipeline);
    if (!stage) park(pipeline, "pipeline cursor points to an unknown stage");
    else if (stage.kind === "run") await tickRunStage(pipeline, stage, entries, ports, persist);
    else await tickReviewStage(pipeline, stage, entries, ports, persist);
  }
  return JSON.stringify(pipeline) !== before;
}

const tickStore = globalThis as unknown as { __llvPipelineTick?: boolean };
const RECONCILABLE_REVIEW_FLOW_STATES: ReadonlySet<Flow["state"]> = new Set([
  "waiting_ready",
  "spawn_pending",
  "spawning",
  "reviewing",
  "relay_pending",
  "relaying",
  "fixing",
  "approved",
  "needs_decision",
  "done_comment",
  "closed",
]);
const RECONCILABLE_BOUND_FLOW_ERRORS = [
  "review flow startup paused:",
  "review flow paused during startup:",
  "advancing the review flow failed:",
  "review loop ended in ",
  "embedded review flow record disappeared",
] as const;

function reviewHeadFenceError(pipeline: Pipeline, attempt: PipelineStageAttempt, ports: PipelinePorts): string | null {
  if (!attempt.reviewHeadSha || attempt.expectedReviewHeadSha !== attempt.reviewHeadSha) {
    return `approved review flow envelope mismatch: expected ${attempt.expectedReviewHeadSha ?? "no exact head"}, reviewed ${attempt.reviewHeadSha ?? "no exact head"}`;
  }
  const currentHead = currentPipelineBranchHead(pipeline, ports.exec);
  if (!currentHead.ok) return `approved review flow could not verify the current pipeline head: ${currentHead.error}`;
  if (attempt.reviewHeadSha !== currentHead.sha) {
    return `approved review flow head mismatch: reviewed ${attempt.reviewHeadSha}, current pipeline head is ${currentHead.sha}`;
  }
  const remoteHead = currentPipelineRemoteBranchHead(pipeline, ports.exec);
  if (!remoteHead.ok) return `approved review flow could not verify the remote pipeline head: ${remoteHead.error}`;
  if (attempt.reviewHeadSha !== remoteHead.sha) {
    return `approved review flow head mismatch: reviewed ${attempt.reviewHeadSha}, remote pipeline head is ${remoteHead.sha}`;
  }
  return null;
}

function terminalReviewFlowError(flow: Flow): string | null {
  if (flow.state !== "needs_decision" && flow.state !== "done_comment" && flow.state !== "closed") return null;
  return `review loop ended in ${flow.state}: ${flow.stateDetail ?? "operator decision required"}`;
}

function reconcileBoundReviewFlow(pipeline: Pipeline, ports: PipelinePorts): boolean {
  if (pipeline.state !== "needs_decision") return false;
  const stage = currentStage(pipeline);
  if (stage?.kind !== "review-loop") return false;
  const attempt = currentAttempt(pipeline, stage.id);
  const attemptError = attempt?.error;
  const flow = attempt?.flowId ? ports.getFlow(attempt.flowId) : null;
  if (
    !attemptError
    || !RECONCILABLE_BOUND_FLOW_ERRORS.some((prefix) => attemptError.startsWith(prefix))
    || !flow
    || !RECONCILABLE_REVIEW_FLOW_STATES.has(flow.state)
  ) return false;
  if (attemptError === terminalReviewFlowError(flow)) return false;
  pipeline.state = "running";
  pipeline.stateDetail = null;
  attempt.state = "reviewing";
  attempt.error = null;
  synchronizeReviewFlowAttempt(attempt, flow, ports.now());
  setCursorState(pipeline, stage.id, "reviewing");
  return true;
}

function reconcilePipelineEmbeddedFlows(pipeline: Pipeline, ports: PipelinePorts): boolean {
  let changed = false;
  for (const run of pipeline.runs) {
    for (const attempt of run.attempts) {
      const flow = attempt.flowId ? ports.getFlow(attempt.flowId) : null;
      if (flow) changed = synchronizeReviewFlowAttempt(attempt, flow, ports.now()) || changed;
    }
  }
  return changed;
}

function reconcileParkedStructuredSpawn(pipeline: Pipeline, ports: PipelinePorts): boolean {
  if (pipeline.state !== "needs_decision") return false;
  const stage = currentStage(pipeline);
  if (!stage || stage.kind !== "run") return false;
  const attempt = currentAttempt(pipeline, stage.id);
  if (!attempt?.launchId || attempt.paneId || attempt.verdict || attempt.completedAt) return false;
  if (!isStructuredSpawnPark(pipeline, attempt)) return false;
  const receipt = ports.spawnReceipt(attempt.launchId);
  if (
    receipt?.state !== "completed"
    || receipt.launchId !== attempt.launchId
    || receipt.conversationId !== attempt.conversationId
  ) return false;
  attempt.sessionId = receipt.sessionId;
  attempt.agentPath = receipt.transcript;
  attempt.paneId = receipt.paneId;
  attempt.state = "running";
  attempt.error = null;
  pipeline.state = "running";
  pipeline.stateDetail = null;
  setCursorState(pipeline, stage.id, "running");
  return true;
}

function isStructuredSpawnPark(pipeline: Pipeline, attempt: PipelineStageAttempt): boolean {
  const failure = attempt.error ?? pipeline.stateDetail ?? "";
  return failure.startsWith("stage spawn")
    || failure.includes("structured initial message")
    || failure.includes("runtime host request timed out");
}

export async function tickPipelines(entries: FileEntry[], ports: PipelinePorts = defaultPipelinePorts()): Promise<{ pipelines: Pipeline[]; changed: boolean }> {
  if (tickStore.__llvPipelineTick) return { pipelines: [], changed: false };
  tickStore.__llvPipelineTick = true;
  let followUp = false;
  try {
    const result = await withPipelineMutation(async (pipelines, persist) => {
      let changed = false;
      for (const pipeline of pipelines) {
        let pipelineChanged = reconcilePipelineEmbeddedFlows(pipeline, ports);
        pipelineChanged = reconcilePendingPipelineAdoptions(pipeline, ports) || pipelineChanged;
        pipelineChanged = await reconcileHistoricalAttempts(pipeline, entries, ports) || pipelineChanged;
        pipelineChanged = rebindPipelineAttemptPaths(pipeline, ports) || pipelineChanged;
        pipelineChanged = reconcileParkedStructuredSpawn(pipeline, ports) || pipelineChanged;
        pipelineChanged = reconcileBoundReviewFlow(pipeline, ports) || pipelineChanged;
        if (!TERMINAL_STATES.has(pipeline.state) && pipeline.state !== "paused" && pipeline.state !== "needs_decision") {
          pipelineChanged = await tickPipeline(pipeline, entries, ports, persist) || pipelineChanged;
        }
        if (pipelineChanged) {
          changed = true;
          persist();
        }
      }
      if (changed) persist();
      return { pipelines, changed };
    });
    /* A pass that ends on a pending cursor (a stage just passed and advanced,
       or provisioning finished) must not wait for an unrelated wake-up to
       materialize the next attempt (#337). */
    followUp = result.pipelines.some((pipeline) => pipeline.state === "running" && pipeline.cursor?.state === "pending");
    return result;
  } catch (error) {
    /* The store fails closed on malformed state, but this tick runs inside
       the shared reconcile pass — flows, workflows, and the task inbox must
       keep ticking when only the pipelines registry is unreadable. */
    if (!(error instanceof PipelineStoreError)) throw error;
    console.error("[pipelines] skipping tick; registry unreadable", error);
    return { pipelines: [], changed: false };
  } finally {
    tickStore.__llvPipelineTick = false;
    /* Scheduled after the re-entry guard clears so the microtask tick cannot
       be swallowed by it. */
    if (followUp) requestPipelineTick();
  }
}

function normalizeStages(
  value: unknown,
  lookup?: PipelineRoleLookup | null,
  preservedStages?: ReadonlyMap<string, PipelineStage>,
  /* Drafts assemble from zero on the canvas (#136), so their edit path accepts
     0–8 stages; the run path (create-and-start) keeps the 1-stage floor (#353:
     the minimum graph is one implement conversation). The graph rules —
     acyclic pass edges, valid fail edges, review-loop reachability — apply
     either way. */
  minStages: number = MIN_STARTED_PIPELINE_STAGES,
): { stages?: PipelineStage[]; error?: string } {
  if (!Array.isArray(value) || value.length < minStages || value.length > MAX_PIPELINE_STAGES) {
    return {
      error: minStages === 0
        ? `pipelines require at most ${MAX_PIPELINE_STAGES} stages`
        : `pipelines require ${MIN_STARTED_PIPELINE_STAGES}–${MAX_PIPELINE_STAGES} stages`,
    };
  }
  const stages: PipelineStage[] = [];
  const ids = new Set<string>();
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "invalid pipeline stage" };
    const stage = raw as Partial<PipelineStageInput>;
    const id = typeof stage.id === "string" ? stage.id.trim() : "";
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || ids.has(id)) return { error: "stage ids must be unique URL-safe names" };
    const preservedStage = preservedStages?.get(id);
    if (stage.kind !== "run" && stage.kind !== "review-loop") return { error: "stage kind must be run or review-loop" };
    const rawOnFail = (raw as { onFail?: unknown }).onFail;
    if (rawOnFail !== undefined && rawOnFail !== null) {
      if (!rawOnFail || typeof rawOnFail !== "object" || Array.isArray(rawOnFail)) return { error: `stage ${id} onFail must be an object or null` };
      const edge = rawOnFail as { to?: unknown; maxRounds?: unknown };
      if (typeof edge.to !== "string" || !edge.to.trim()) return { error: `stage ${id} onFail requires a target stage id` };
      const maxRounds = edge.maxRounds === undefined ? DEFAULT_FAIL_EDGE_ROUNDS : edge.maxRounds;
      if (!Number.isInteger(maxRounds) || (maxRounds as number) < 1 || (maxRounds as number) > MAX_FAIL_EDGE_ROUNDS) {
        return { error: `stage ${id} onFail maxRounds must be an integer between 1 and ${MAX_FAIL_EDGE_ROUNDS}` };
      }
    }
    const prompt = typeof stage.prompt === "string" ? stage.prompt.trim() : "";
    if (!prompt) return { error: `stage ${id} prompt is required` };
    if (prompt.length > MAX_STAGE_PROMPT_LENGTH) return { error: `stage ${id} prompt exceeds ${MAX_STAGE_PROMPT_LENGTH} characters` };
    const roleValue = (raw as { role?: unknown }).role;
    if (roleValue !== undefined && (!roleValue || typeof roleValue !== "object" || Array.isArray(roleValue))) {
      return { error: `stage ${id} role must be an object` };
    }
    if (roleValue && Object.keys(roleValue).some((key) => key !== "roleId" && key !== "params")) {
      return { error: `stage ${id} role only accepts roleId and params; place runtime overrides on the stage` };
    }
    const roleId = roleValue && typeof (roleValue as { roleId?: unknown }).roleId === "string"
      ? (roleValue as { roleId: string }).roleId.trim()
      : "";
    if (roleValue && !roleId) return { error: `stage ${id} roleId is required when role is present` };
    const rawParams = (roleValue as { params?: unknown } | undefined)?.params;
    if (rawParams !== undefined && (!rawParams || typeof rawParams !== "object" || Array.isArray(rawParams))) {
      return { error: `stage ${id} role params must be an object` };
    }
    const roleParams = rawParams as Record<string, unknown> | undefined;
    if (roleParams && Object.values(roleParams).some((value) => typeof value !== "string" && typeof value !== "number")) {
      return { error: `stage ${id} role params must be strings or numbers` };
    }
    if (roleParams && !roleId) return { error: `stage ${id} role params require a roleId` };
    if (roleId && roleParams && !preservedStage) {
      /* Canonical value checks (options, integer bounds, text length, unknown
         keys) so an invalid param can't freeze into the stored scaffold. */
      const paramError = validatePipelineRoleParams(roleId, roleParams as Record<string, string | number>);
      if (paramError) return { error: `stage ${id} ${paramError}` };
    }
    if (stage.model !== undefined && stage.model !== null && typeof stage.model !== "string") return { error: `stage ${id} model must be a string or null` };
    if (stage.effort !== undefined && stage.effort !== null && typeof stage.effort !== "string") return { error: `stage ${id} effort must be a string or null` };
    const onFailEdge = rawOnFail
      ? {
          to: (rawOnFail as { to: string }).to.trim(),
          maxRounds: ((rawOnFail as { maxRounds?: number }).maxRounds ?? DEFAULT_FAIL_EDGE_ROUNDS),
        }
      : null;
    const input: PipelineStageInput = {
      id,
      kind: stage.kind,
      ...(roleId ? { role: { roleId: roleId as PipelineRoleId, ...(roleParams && Object.keys(roleParams).length ? { params: roleParams as Record<string, string | number> } : {}) } } : {}),
      ...(stage.engine !== undefined ? { engine: stage.engine } : {}),
      ...(stage.model !== undefined ? { model: typeof stage.model === "string" ? stage.model.trim() || null : null } : {}),
      ...(stage.effort !== undefined ? { effort: typeof stage.effort === "string" ? stage.effort.trim() || null : null } : {}),
      ...(stage.access !== undefined ? { access: stage.access } : {}),
      prompt,
      next: stage.next ?? null,
      onFail: onFailEdge,
    };
    const resolved = preservedStage ? { role: preservedStage.effectiveRole } : resolvePipelineRole(input, stage.kind, lookup);
    if (!resolved.role) return { error: "error" in resolved ? resolved.error : "invalid stage role" };
    const normalizedStage: PipelineStage = { ...input, effectiveRole: structuredClone(resolved.role) };
    ids.add(id);
    stages.push(normalizedStage);
  }
  /* v3 graph contract: acyclic pass edges over valid targets, bounded fail
     edges, review-loop pass-reachability — shared with the store validator. */
  const graphError = pipelineGraphError(stages);
  if (graphError) return { error: graphError };
  return { stages };
}

/** Snapshots the draft's stages as editable inputs, preserving each stage's
    intentional pass (`next`) and fail (`onFail`) edges verbatim (#353): a
    structural edit (add/remove/reorder/override) keeps a custom jump/merge or
    fail loop as authored, and the caller rewires only the edit's own seam. */
function draftStageInputs(stages: PipelineStage[]): PipelineStageInput[] {
  return stages.map((stage) => ({
    id: stage.id,
    kind: stage.kind,
    ...(stage.role ? { role: structuredClone(stage.role) } : {}),
    ...(stage.engine !== undefined ? { engine: stage.engine } : {}),
    ...(stage.model !== undefined ? { model: stage.model } : {}),
    ...(stage.effort !== undefined ? { effort: stage.effort } : {}),
    ...(stage.access !== undefined ? { access: stage.access } : {}),
    "prompt": stage.prompt,
    next: stage.next ?? null,
    onFail: stage.onFail ?? null,
  }));
}

function replaceDraftStages(
  pipeline: Pipeline,
  inputs: PipelineStageInput[],
  lookup?: PipelineRoleLookup | null,
): { error?: string } {
  /* Custom edges survive structural edits (#353): each kept stage's intentional
     pass and fail edge is preserved as-is, and the add/remove handlers rewire
     only the edit's own seam. This safety net clears an edge whose target left
     the plan, or a pass edge left pointing at its own stage, so the graph stays
     free of dangling references. */
  const keptIds = new Set(inputs.map((stage) => stage.id));
  const relinked = inputs.map((stage) => ({
    ...stage,
    next: stage.next != null && stage.next !== stage.id && keptIds.has(stage.next) ? stage.next : null,
    onFail: stage.onFail && keptIds.has(stage.onFail.to) ? stage.onFail : null,
  }));
  const preserved = new Map(pipeline.stages.map((stage) => [stage.id, stage]));
  /* Draft edits may empty the plan entirely (remove down to zero); the 1-stage
     floor is enforced only at Start (#136, #353). */
  const normalized = normalizeStages(relinked, lookup, preserved, 0);
  if (!normalized.stages) return { error: normalized.error ?? "invalid stages" };
  /* The entry stage (the draft cursor rests on stages[0]) must be a run: a
     review-loop entry has no preceding run to review and would park on Start.
     Preserved edges let a fronted review stay graph-reachable from a later run,
     so the array-position guard runs explicitly here (matching the client's
     reviewLoopChainValid). */
  if (normalized.stages[0] && normalized.stages[0].kind !== "run") {
    return { error: "review-loop stage requires a preceding run stage" };
  }
  pipeline.stages = normalized.stages;
  pipeline.runs = normalized.stages.map((stage) => ({ stageId: stage.id, attempts: [] }));
  pipeline.cursor = normalized.stages.length
    ? { stageId: normalized.stages[0]!.id, state: "pending", input: null, activatedBy: null }
    : null;
  return {};
}

type PipelineMutationResult = {
  pipeline?: Pipeline;
  error?: string;
  status?: number;
  code?: PipelineRepoPreflightErrorCode;
  field?: "repoDir";
  path?: string;
};

type PipelineCreatorLineage = {
  srcPath: string | null;
  srcConversationId: string | null;
};

function resolvePipelineCreatorLineage(
  value: unknown,
  ports: Pick<PipelinePorts, "sourcePathAllowed" | "conversationIdForPath">,
): { lineage?: PipelineCreatorLineage; error?: string; status?: number } {
  const srcPath = typeof value === "string" ? value.trim() : "";
  if (!srcPath) return { error: "pipeline creator lineage is required; pass src", status: 400 };
  if (!ports.sourcePathAllowed(srcPath)) return { error: "src path is not an allowed conversation transcript", status: 400 };
  const srcConversationId = ports.conversationIdForPath(srcPath);
  if (!srcConversationId) return { error: "src conversation does not exist", status: 400 };
  return { lineage: { srcPath, srcConversationId } };
}

type CreatePipelineOptions = {
  ensureTask?: BoardTask;
  spawnParams?: TaskPipelineSpawnParams;
  allowOperatorDraftWithoutLineage?: boolean;
};

function taskSpawnCreatorLineage(
  spawnParams: TaskSpawnPipelineParams,
  ports: Pick<PipelinePorts, "sourcePathAllowed" | "conversationIdForPath">,
): { lineage?: PipelineCreatorLineage; error?: string; status?: number } {
  if (!spawnParams.launchId || !spawnParams.conversationId) {
    return { error: "task pipeline creation requires launch and conversation identity", status: 400 };
  }
  if (spawnParams.srcPath === null) {
    return { lineage: { srcPath: null, srcConversationId: spawnParams.conversationId } };
  }
  const resolved = resolvePipelineCreatorLineage(spawnParams.srcPath, ports);
  if (!resolved.lineage) return resolved;
  if (resolved.lineage.srcConversationId !== spawnParams.conversationId) {
    return { error: "task pipeline creator path does not match its launch conversation", status: 409 };
  }
  return resolved;
}

function reconcileTaskPipelineCreation(
  pipeline: Pipeline,
  task: BoardTask,
  spawnParams: TaskSpawnPipelineParams,
  ports: Pick<PipelinePorts, "sourcePathAllowed" | "conversationIdForPath" | "spawnReceipt">,
): { changed: boolean; error?: string; status?: number } {
  const intent = pipeline.creationIntent;
  if (!intent) return { changed: false };
  if (intent.kind !== "task-spawn" || intent.taskId !== task.id) {
    return { changed: false, error: "task pipeline creation intent does not match its task", status: 409 };
  }

  let changed = false;
  if (intent.launchId !== spawnParams.launchId) {
    const priorReceipt = ports.spawnReceipt(intent.launchId);
    const priorLaunchFailed = priorReceipt?.state === "failed" || priorReceipt?.state === "conflicted";
    const replacesPendingIntent = pipeline.srcPath === null
      && (spawnParams.retryOfLaunchId === intent.launchId || priorLaunchFailed);
    if (!replacesPendingIntent) return { changed: false };
    pipeline.creationIntent = { ...intent, launchId: spawnParams.launchId };
    pipeline.srcConversationId = spawnParams.conversationId;
    changed = true;
  }

  const activeIntent = pipeline.creationIntent;
  if (!activeIntent || activeIntent.launchId !== spawnParams.launchId) return { changed };
  if (pipeline.srcConversationId !== spawnParams.conversationId) {
    return { changed: false, error: "task pipeline launch conversation changed during reconciliation", status: 409 };
  }
  if (spawnParams.srcPath === null || pipeline.srcPath === spawnParams.srcPath) return { changed };
  const creator = taskSpawnCreatorLineage(spawnParams, ports);
  if (!creator.lineage) return { changed: false, error: creator.error, status: creator.status };
  pipeline.srcPath = creator.lineage.srcPath;
  return { changed: true };
}

function preflightFailure(result: Extract<PipelineRepoPreflight, { ok: false }>): PipelineMutationResult {
  return {
    error: pipelineRepoPreflightError(result),
    status: pipelineRepoPreflightStatus(result.code),
    code: result.code,
    field: "repoDir",
    path: result.path,
  };
}

export async function createPipelineFromRequest(
  req: CreatePipelineRequest,
  ports: PipelinePorts = defaultPipelinePorts(),
  options: CreatePipelineOptions = {},
): Promise<PipelineMutationResult> {
  const task = typeof req.task === "string" ? req.task.trim() : "";
  if (!task) return { error: "task is required", status: 400 };
  if (task.length > MAX_TASK_LENGTH) return { error: `task exceeds ${MAX_TASK_LENGTH} characters`, status: 400 };
  const spec = typeof req.spec === "string" && req.spec.trim() ? req.spec.trim() : undefined;
  if (req.spec !== undefined && typeof req.spec !== "string") return { error: "spec must be a string", status: 400 };
  if (spec && spec.length > MAX_SPEC_LENGTH) return { error: `spec exceeds ${MAX_SPEC_LENGTH} characters`, status: 400 };
  if (req.autoStart !== undefined && typeof req.autoStart !== "boolean") return { error: "autoStart must be a boolean", status: 400 };
  if (req.baseBranch !== undefined && typeof req.baseBranch !== "string") return { error: "baseBranch must be a string", status: 400 };
  if (req.baseRef !== undefined && typeof req.baseRef !== "string") return { error: "baseRef must be a string", status: 400 };
  if (req.taskIds !== undefined && (!Array.isArray(req.taskIds) || req.taskIds.some((taskId) => typeof taskId !== "string" || !taskId.trim()))) {
    return { error: "taskIds must be an array of non-empty strings", status: 400 };
  }
  const taskSpawn = options.ensureTask && options.spawnParams && isTaskSpawnPipelineParams(options.spawnParams)
    ? { task: options.ensureTask, params: options.spawnParams }
    : null;
  const operatorDraftWithoutLineage = options.allowOperatorDraftWithoutLineage
    && req.autoStart === false
    && (typeof req.src !== "string" || !req.src.trim());
  const creator = taskSpawn
    ? taskSpawnCreatorLineage(taskSpawn.params, ports)
    : operatorDraftWithoutLineage
      ? { lineage: { srcPath: null, srcConversationId: null } }
    : resolvePipelineCreatorLineage(req.src, ports);
  if (!creator.lineage) return { error: creator.error, status: creator.status };
  const taskIds = [...new Set((req.taskIds ?? []).map((taskId) => taskId.trim()))];
  const requestedRepoDir = typeof req.repoDir === "string" ? req.repoDir.trim() : "";
  if (!requestedRepoDir) return { error: "repoDir is required", status: 400 };
  const admission = ports.preflightRepo(requestedRepoDir);
  if (!admission.ok) return preflightFailure(admission);
  const repoDir = admission.repoDir;
  /* A draft (autoStart:false) may be created empty and assembled on the canvas
     (#136); an immediately-started pipeline needs at least its one implement
     conversation (#353). */
  const normalized = normalizeStages(req.stages, ports.roleLookup, undefined, req.autoStart === false ? 0 : MIN_STARTED_PIPELINE_STAGES);
  if (!normalized.stages) return { error: normalized.error ?? "invalid stages", status: 400 };
  const explicitBaseRef = req.baseRef?.trim();
  if (req.autoStart === false && req.baseBranch?.trim() && !explicitBaseRef) {
    return { error: "a draft baseBranch requires an explicit baseRef", status: 400 };
  }
  const base = req.autoStart === false && !explicitBaseRef
    ? null
    : resolvePipelineBase(repoDir, { baseBranch: req.baseBranch, baseRef: explicitBaseRef }, ports.exec);
  if (base && !base.ok) return { error: base.error, status: 409 };
  const pipeline = buildPipeline({
    id: crypto.randomUUID().slice(0, 8),
    task,
    taskIds,
    ...(taskSpawn ? { creationIntent: { kind: "task-spawn" as const, taskId: taskSpawn.task.id, launchId: taskSpawn.params.launchId } } : {}),
    ...(spec ? { spec } : {}),
    project: ports.projectForCwd(repoDir) ?? path.basename(repoDir),
    repoDir,
    stages: normalized.stages,
    srcPath: creator.lineage.srcPath,
    srcConversationId: creator.lineage.srcConversationId,
    now: ports.now(),
    state: req.autoStart === false ? "draft" : "provisioning",
  });
  if (base?.ok) {
    pipeline.baseBranch = base.baseBranch;
    pipeline.baseRef = base.baseRef;
    pipeline.lastPassedCommit = base.baseRef;
  }
  return withPipelineMutation((pipelines, persist) => {
    if (options.ensureTask && options.spawnParams) {
      const decision = ensurePipelineForTask(options.ensureTask, pipelines, options.spawnParams);
      if (decision === null) {
        const existing = pipelines.find((candidate) =>
          candidate.taskIds.includes(options.ensureTask!.id)
          && candidate.state !== "closed"
          && !candidate.hiddenAt);
        if (!existing) return { error: "task pipeline binding changed during creation", status: 409 };
        if (isTaskSpawnPipelineParams(options.spawnParams)) {
          const reconciled = reconcileTaskPipelineCreation(existing, options.ensureTask, options.spawnParams, ports);
          if (reconciled.error) return { error: reconciled.error, status: reconciled.status };
          if (reconciled.changed) persist();
        }
        return { pipeline: existing };
      }
    }
    const taskLinkError = pipelineTaskLinkError(pipeline, taskIds, loadTasks());
    if (taskLinkError) return { error: taskLinkError, status: 400 };
    pipelines.push(pipeline);
    persist();
    return { pipeline };
  });
}

export async function ensureTaskPipelineForAssignment(
  task: BoardTask,
  spawnParams: TaskPipelineSpawnParams,
  ports: PipelinePorts = defaultPipelinePorts(),
): Promise<PipelineMutationResult> {
  const pipelines = loadPipelines();
  const request = ensurePipelineForTask(task, pipelines, spawnParams);
  if (request === null) {
    return withPipelineMutation((current, persist) => {
      const pipeline = current.find((candidate) =>
        candidate.taskIds.includes(task.id) && candidate.state !== "closed" && !candidate.hiddenAt);
      if (!pipeline) return { error: "task pipeline binding changed during lookup", status: 409 };
      if (isTaskSpawnPipelineParams(spawnParams)) {
        const reconciled = reconcileTaskPipelineCreation(pipeline, task, spawnParams, ports);
        if (reconciled.error) return { error: reconciled.error, status: reconciled.status };
        if (reconciled.changed) persist();
      }
      return { pipeline };
    });
  }
  return createPipelineFromRequest(request, ports, { ensureTask: task, spawnParams });
}

/** A park without a verdict (interrupted spawn, vanished transcript) can
    leave the stage agent mid-turn in its pane; retry/skip would reset the
    worktree under it and the next passed stage would commit its strays. An
    attempt with a verdict or terminal completion timestamp finished its turn;
    an idle interactive CLI in the pane is safe to leave behind. */
async function orphanAgentPane(
  attempt: PipelineStageAttempt | null,
  ports: PipelinePorts,
): Promise<{ error: string; status: number } | null> {
  if (!attempt || attempt.verdict || attempt.completedAt || !attempt.paneId) return null;
  if (!(await ports.paneAgentAlive(attempt.paneId))) return null;
  return { error: `stage agent may still be running in pane ${attempt.paneId}; wait for it to exit or kill the pane first`, status: 409 };
}

export async function patchPipeline(
  id: string,
  req: PatchPipelineRequest,
  ports: PipelinePorts = defaultPipelinePorts(),
): Promise<PipelineMutationResult> {
  return withPipelineMutation(async (pipelines, persist) => {
    const pipeline = pipelines.find((item) => item.id === id);
    if (!pipeline) return { error: "pipeline not found", status: 404 };
    const stage = currentStage(pipeline);
    const attempt = stage ? currentAttempt(pipeline, stage.id) : null;
    const flow = attempt?.flowId ? ports.getFlow(attempt.flowId) : null;

    if (req.action === "set-src") {
      if (req.overwrite !== undefined && typeof req.overwrite !== "boolean") {
        return { error: "overwrite must be a boolean", status: 400 };
      }
      const creator = resolvePipelineCreatorLineage(req.srcPath, ports);
      if (!creator.lineage) return { error: creator.error, status: creator.status };
      const hasLineage = pipeline.srcPath !== null || pipeline.srcConversationId !== null;
      const sameLineage = pipeline.srcPath === creator.lineage.srcPath
        && pipeline.srcConversationId === creator.lineage.srcConversationId;
      if (hasLineage && !sameLineage && req.overwrite !== true) {
        return { error: "pipeline creator lineage already exists; pass overwrite: true to replace it", status: 409 };
      }
      pipeline.srcPath = creator.lineage.srcPath;
      pipeline.srcConversationId = creator.lineage.srcConversationId;
    } else if (req.action === "link-task") {
      const taskId = typeof req.taskId === "string" ? req.taskId.trim() : "";
      if (!taskId) return { error: "taskId is required", status: 400 };
      const taskLinkError = pipelineTaskLinkError(pipeline, [taskId], loadTasks());
      if (taskLinkError) return { error: taskLinkError, status: 400 };
      if (!pipeline.taskIds.includes(taskId)) pipeline.taskIds.push(taskId);
    } else if (req.action === "unlink-task") {
      const taskId = typeof req.taskId === "string" ? req.taskId.trim() : "";
      if (!taskId) return { error: "taskId is required", status: 400 };
      pipeline.taskIds = pipeline.taskIds.filter((candidate) => candidate !== taskId);
    } else if (req.action === "start") {
      if (pipeline.state !== "draft") return { error: "pipeline is not a draft", status: 409 };
      /* Start enforces the 1-stage floor (#353): the minimum graph is a single
         implement conversation. The graph rules (acyclic pass edges,
         review-loop reachability) already held on every draft edit. */
      if (pipeline.stages.length < MIN_STARTED_PIPELINE_STAGES) return { error: `add at least ${MIN_STARTED_PIPELINE_STAGES} stage before starting`, status: 409 };
      const admission = ports.preflightRepo(pipeline.repoDir);
      if (!admission.ok) return preflightFailure(admission);
      if (admission.repoDir !== pipeline.repoDir) {
        const project = ports.projectForCwd(admission.repoDir) ?? path.basename(admission.repoDir);
        const taskLinkError = pipelineTaskLinkError({ project }, pipeline.taskIds, loadTasks(), { allowMissing: true });
        if (taskLinkError) return { error: taskLinkError, status: 400 };
        pipeline.repoDir = admission.repoDir;
        pipeline.project = project;
        Object.assign(pipeline, pipelineIdentity(pipeline.id, pipeline.task, admission.repoDir));
      }
      if (!pipeline.baseBranch || !pipeline.baseRef || !pipeline.lastPassedCommit) {
        const base = resolvePipelineBase(pipeline.repoDir, {}, ports.exec);
        if (!base.ok) return { error: base.error, status: 409 };
        pipeline.baseBranch = base.baseBranch;
        pipeline.baseRef = base.baseRef;
        pipeline.lastPassedCommit = base.baseRef;
      }
      pipeline.state = "provisioning";
      pipeline.stateDetail = null;
    } else if (req.action === "update-draft") {
      if (pipeline.state !== "draft") return { error: "pipeline is not a draft", status: 409 };
      if (req.task === undefined && req.spec === undefined && req.repoDir === undefined) return { error: "update-draft needs at least one field to change", status: 400 };
      const task = req.task === undefined ? pipeline.task : typeof req.task === "string" ? req.task.trim() : "";
      if (!task) return { error: "task is required", status: 400 };
      if (task.length > MAX_TASK_LENGTH) return { error: `task exceeds ${MAX_TASK_LENGTH} characters`, status: 400 };
      if (req.spec !== undefined && typeof req.spec !== "string") return { error: "spec must be a string", status: 400 };
      const spec = req.spec === undefined ? pipeline.spec : req.spec.trim() || undefined;
      if (spec && spec.length > MAX_SPEC_LENGTH) return { error: `spec exceeds ${MAX_SPEC_LENGTH} characters`, status: 400 };
      const requestedRepoDir = req.repoDir === undefined ? pipeline.repoDir : typeof req.repoDir === "string" ? req.repoDir.trim() : "";
      if (!requestedRepoDir) return { error: "repoDir is required", status: 400 };
      let repoDir = pipeline.repoDir;
      if (requestedRepoDir !== pipeline.repoDir) {
        const admission = ports.preflightRepo(requestedRepoDir);
        if (!admission.ok) return preflightFailure(admission);
        repoDir = admission.repoDir;
      }
      const repoChanged = repoDir !== pipeline.repoDir;
      const project = ports.projectForCwd(repoDir) ?? path.basename(repoDir);
      if (repoChanged) {
        const taskLinkError = pipelineTaskLinkError({ project }, pipeline.taskIds, loadTasks(), { allowMissing: true });
        if (taskLinkError) return { error: taskLinkError, status: 400 };
      }
      pipeline.task = task;
      if (spec) pipeline.spec = spec;
      else delete pipeline.spec;
      pipeline.repoDir = repoDir;
      pipeline.project = project;
      Object.assign(pipeline, pipelineIdentity(pipeline.id, task, repoDir));
      if (repoChanged) {
        pipeline.baseBranch = "";
        pipeline.baseRef = "";
        pipeline.lastPassedCommit = "";
      }
    } else if (req.action === "set-position") {
      if (!req.pos || typeof req.pos !== "object" || !Number.isFinite(req.pos.x) || !Number.isFinite(req.pos.y)) {
        return { error: "position requires finite x and y", status: 400 };
      }
      pipeline.pos = { x: Math.round(req.pos.x), y: Math.round(req.pos.y) };
    } else if (req.action === "add-stage") {
      if (pipeline.state !== "draft") return { error: "pipeline is not a draft", status: 409 };
      if (!req.stage || typeof req.stage !== "object" || Array.isArray(req.stage)) return { error: "stage is required", status: 400 };
      const inputs = draftStageInputs(pipeline.stages);
      const index = req.index === undefined ? inputs.length : req.index;
      if (!Number.isInteger(index) || index < 0 || index > inputs.length) return { error: "stage index is out of range", status: 400 };
      /* Splice the new stage into the chain at its own seam only: it inherits the
         predecessor's former pass target and the predecessor now points at it, so
         every OTHER stage's intentional edge is untouched (#353). Inserting at the
         front makes the new stage the head, pointing at the old head. */
      const predecessor = index > 0 ? inputs[index - 1] : null;
      const seamNext = predecessor ? predecessor.next ?? null : inputs[index]?.id ?? null;
      const inserted: PipelineStageInput = { ...req.stage, next: seamNext };
      inputs.splice(index, 0, inserted);
      if (predecessor) predecessor.next = inserted.id;
      const replaced = replaceDraftStages(pipeline, inputs, ports.roleLookup);
      if (replaced.error) return { error: replaced.error, status: 400 };
    } else if (req.action === "remove-stage") {
      if (pipeline.state !== "draft") return { error: "pipeline is not a draft", status: 409 };
      /* A draft can be emptied entirely on the canvas (#136); the 2-stage floor is
         a Start-time gate. remove that would orphan a review-loop (drop its only
         preceding run) is still rejected by replaceDraftStages' normalization. */
      if (pipeline.stages.length === 0) return { error: "no stage to remove", status: 409 };
      /* Every pipeline keeps at least one default action (#353): the last stage
         can be reconfigured but not removed, so no empty shell can re-form. */
      if (pipeline.stages.length === 1) return { error: "a pipeline keeps at least one stage; reconfigure it instead", status: 409 };
      const index = pipeline.stages.findIndex((stage) => stage.id === req.stageId);
      if (index < 0) return { error: "stage not found", status: 404 };
      const removed = pipeline.stages[index]!;
      const inputs = draftStageInputs(pipeline.stages);
      inputs.splice(index, 1);
      /* Heal only the edges that pointed AT the removed stage, preserving every
         other intentional edge (#353): a pass edge bypasses to the removed
         stage's own target (the chain stays connected past it); a fail edge that
         targeted it parks instead (there is no meaningful bypass for a loop). */
      const bypass = removed.next && removed.next !== removed.id ? removed.next : null;
      for (const input of inputs) {
        if (input.next === removed.id) input.next = bypass;
        if (input.onFail?.to === removed.id) input.onFail = null;
      }
      const replaced = replaceDraftStages(pipeline, inputs, ports.roleLookup);
      if (replaced.error) return { error: replaced.error, status: 400 };
    } else if (req.action === "reorder-stage") {
      if (pipeline.state !== "draft") return { error: "pipeline is not a draft", status: 409 };
      const inputs = draftStageInputs(pipeline.stages);
      let ordered: PipelineStageInput[];
      if (Array.isArray(req.stageIds)) {
        const currentIds = new Set(inputs.map((stage) => stage.id));
        if (req.stageIds.length !== inputs.length || new Set(req.stageIds).size !== inputs.length || req.stageIds.some((id) => !currentIds.has(id))) {
          return { error: "stageIds must contain every stage exactly once", status: 400 };
        }
        const byId = new Map(inputs.map((stage) => [stage.id, stage]));
        ordered = req.stageIds.map((id) => byId.get(id)!);
      } else {
        const from = inputs.findIndex((stage) => stage.id === req.stageId);
        if (from < 0) return { error: "stage not found", status: 404 };
        const toIndex = req.toIndex;
        if (!Number.isInteger(toIndex) || toIndex! < 0 || toIndex! >= inputs.length) return { error: "stage index is out of range", status: 400 };
        ordered = [...inputs];
        const [moved] = ordered.splice(from, 1);
        ordered.splice(toIndex!, 0, moved!);
      }
      const replaced = replaceDraftStages(pipeline, ordered, ports.roleLookup);
      if (replaced.error) return { error: replaced.error, status: 400 };
    } else if (req.action === "set-edge") {
      /* Conversation-graph editing (#353): rewires a stage's pass or fail edge.
         Edits always shape the future, never rewrite evidence: a stage that has
         already run keeps its pass edge frozen (its history names its
         successor), and a fail edge freezes once traversed. Accepted for drafts
         AND running/parked pipelines — that is the point of an editable graph. */
      if (TERMINAL_STATES.has(pipeline.state)) return { error: "pipeline is closed or completed", status: 409 };
      const from = typeof req.stageId === "string" ? pipeline.stages.find((item) => item.id === req.stageId) ?? null : null;
      if (!from) return { error: "stage not found", status: 404 };
      if (req.edge !== "pass" && req.edge !== "fail") return { error: "edge must be pass or fail", status: 400 };
      if (req.to === undefined) return { error: "to is required (null clears the edge)", status: 400 };
      if (req.to !== null && (typeof req.to !== "string" || !pipeline.stages.some((item) => item.id === req.to))) {
        return { error: "edge target stage not found", status: 400 };
      }
      if (req.edge === "pass") {
        if (req.maxRounds !== undefined) return { error: "maxRounds applies only to fail edges", status: 400 };
        const fromRun = pipeline.runs.find((item) => item.stageId === from.id);
        if (fromRun && fromRun.attempts.length > 0) return { error: "stage has already run; its pass edge is frozen evidence", status: 409 };
        const candidate = pipeline.stages.map((item) => (item.id === from.id ? { ...item, next: req.to as string | null } : item));
        const graphError = pipelineGraphError(candidate);
        if (graphError) return { error: graphError, status: 400 };
        from.next = req.to;
      } else {
        /* A fail edge freezes the instant its verdict routes the cursor along it,
           while the target attempt is still forming: the activation lands on the
           durable cursor in the same mutation as the failing verdict and survives
           a restart, so the target it forwarded evidence to stays frozen through
           the in-flight round (#353). */
        const traversed = (pipeline.cursor?.activatedBy?.edge === "fail" && pipeline.cursor.activatedBy.stageId === from.id)
          || pipeline.runs.some((run) =>
            run.attempts.some((item) => !item.historical && item.activatedBy?.edge === "fail" && item.activatedBy.stageId === from.id));
        if (traversed) return { error: "fail edge has already been traversed; it is frozen evidence", status: 409 };
        if (req.to === null) {
          if (req.maxRounds !== undefined) return { error: "maxRounds requires a fail-edge target", status: 400 };
          from.onFail = null;
        } else {
          const maxRounds = req.maxRounds === undefined ? DEFAULT_FAIL_EDGE_ROUNDS : req.maxRounds;
          if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > MAX_FAIL_EDGE_ROUNDS) {
            return { error: `maxRounds must be an integer between 1 and ${MAX_FAIL_EDGE_ROUNDS}`, status: 400 };
          }
          const candidate = pipeline.stages.map((item) => (item.id === from.id ? { ...item, onFail: { to: req.to as string, maxRounds } } : item));
          const graphError = pipelineGraphError(candidate);
          if (graphError) return { error: graphError, status: 400 };
          from.onFail = { to: req.to, maxRounds };
        }
      }
    } else if (req.action === "pause") {
      if (pipeline.state === "draft") return { error: "draft pipelines can only be started, edited, or deleted", status: 409 };
      if (!TERMINAL_STATES.has(pipeline.state) && pipeline.state !== "paused") {
        pipeline.pausedState = pipeline.state;
        pipeline.state = "paused";
        pipeline.stateDetail = "paused by user";
        if (flow && flow.state !== "paused" && flow.state !== "closed") ports.patchFlow(flow.id, "pause");
      }
    } else if (req.action === "resume") {
      if (pipeline.state !== "paused") return { error: "pipeline is not paused", status: 409 };
      pipeline.state = pipeline.pausedState ?? "running";
      pipeline.pausedState = null;
      pipeline.stateDetail = null;
      if (flow?.state === "paused") ports.patchFlow(flow.id, "resume");
    } else if (req.action === "retry-stage") {
      if (pipeline.state !== "needs_decision") return { error: "pipeline does not have a stage awaiting retry", status: 409 };
      const explicitReceiptRetry = req.stageId !== undefined || req.launchId !== undefined;
      if (explicitReceiptRetry && (typeof req.stageId !== "string" || typeof req.launchId !== "string")) {
        return { error: "receipt retry requires both stageId and launchId", status: 400 };
      }
      const retryStageId = explicitReceiptRetry ? req.stageId! : stage?.id ?? null;
      const retryLaunchId = explicitReceiptRetry ? req.launchId! : attempt?.launchId ?? null;
      const receiptRetry = (explicitReceiptRetry || attempt?.paneId === null)
        && retryStageId !== null
        && retryLaunchId !== null;
      if (explicitReceiptRetry && stage?.id !== retryStageId) {
        return { error: "the clicked launch belongs to a different pipeline stage", status: 409 };
      }
      if (explicitReceiptRetry && attempt?.launchId !== retryLaunchId) {
        return { error: "the clicked launch is no longer the current failed attempt", status: 409 };
      }
      const validateRetryReceipt = (settlementWasPending = false): { conflict: { error: string; status: number } | null; claimRequired: boolean } => {
        if (!receiptRetry) return { conflict: null, claimRequired: false };
        const receipt = ports.spawnReceipt(retryLaunchId);
        if (!receipt) return {
          conflict: { error: "the clicked launch receipt is no longer available", status: 409 },
          claimRequired: false,
        };
        if (receipt.state === "failed" || receipt.state === "conflicted") {
          return { conflict: null, claimRequired: true };
        }
        if (
          explicitReceiptRetry
          || settlementWasPending
          || (attempt !== null && isStructuredSpawnPark(pipeline, attempt))
          || receipt.state !== "completed"
        ) {
          return {
            conflict: { error: `the clicked launch settled as ${receipt.state}; retry was cancelled`, status: 409 },
            claimRequired: false,
          };
        }
        return { conflict: null, claimRequired: false };
      };
      const initialReceipt = validateRetryReceipt();
      if (initialReceipt.conflict) return initialReceipt.conflict;
      const orphan = await orphanAgentPane(attempt, ports);
      if (orphan) return orphan;
      if (flow && flow.state !== "closed") {
        const closed = await ports.closeFlow(flow.id);
        if (closed?.error) {
          pipeline.stateDetail = closed.error;
          persist();
          return { error: closed.error, status: closed.status ?? 409 };
        }
      }
      /* Pane/flow cleanup can yield while a structured receipt reconciles.
         This final durable read fences the synchronous reset and cursor update. */
      const settledReceipt = validateRetryReceipt(initialReceipt.claimRequired);
      if (settledReceipt.conflict) return settledReceipt.conflict;
      if (settledReceipt.claimRequired) {
        if (!retryLaunchId || !retryStageId) {
          return { error: "structured retry identity is unavailable", status: 409 };
        }
        const claim = ports.claimSpawnRetry(retryLaunchId, `${pipeline.id}:${retryStageId}:${retryLaunchId}`);
        if (claim !== "claimed") {
          return {
            error: claim === "settled"
              ? "the clicked launch settled before its retry could be claimed"
              : "the clicked launch is already claimed by another retry",
            status: 409,
          };
        }
      }
      const retryReviewHead = stage?.kind === "review-loop" ? synchronizePipelineRetryHead(pipeline, ports.exec) : null;
      if (retryReviewHead && !retryReviewHead.ok) {
        pipeline.stateDetail = retryReviewHead.error;
        persist();
        return { error: retryReviewHead.error, status: 409 };
      }
      if (pipeline.runs.every((run) => run.attempts.length === 0)) {
        pipeline.state = "provisioning";
      } else if (stage?.kind === "review-loop") {
        pipeline.lastPassedCommit = retryReviewHead!.sha;
        pipeline.state = "running";
      } else if (pipeline.lastPassedCommit) {
        const reset = resetPipelineStage(pipeline, ports.exec);
        if (!reset.ok) return { error: reset.error, status: 409 };
        pipeline.state = "running";
      } else {
        pipeline.state = "provisioning";
      }
      /* Re-activate the cursor stage preserving its persisted relay record, so
         the retried attempt receives the identical {{prev.output}} (#353). */
      if (stage) setCursorState(pipeline, stage.id, "pending");
      pipeline.pausedState = null;
      pipeline.stateDetail = null;
    } else if (req.action === "skip-stage") {
      if (pipeline.state !== "needs_decision" || !stage) return { error: "pipeline does not have a stage awaiting a decision", status: 409 };
      const orphan = await orphanAgentPane(attempt, ports);
      if (orphan) return orphan;
      if (flow && flow.state !== "closed") {
        const closed = await ports.closeFlow(flow.id);
        if (closed?.error) {
          pipeline.stateDetail = closed.error;
          persist();
          return { error: closed.error, status: closed.status ?? 409 };
        }
      }
      if (!pipeline.lastPassedCommit) return { error: "pipeline worktree has not been provisioned", status: 409 };
      const reset = resetPipelineStage(pipeline, ports.exec);
      if (!reset.ok) return { error: reset.error, status: 409 };
      if (attempt) {
        attempt.state = "skipped";
        attempt.completedAt = ports.now();
        attempt.output = "Skipped by operator.";
      }
      advancePipeline(pipeline, stage, ports, attempt);
    } else if (req.action === "override-stage") {
      if (TERMINAL_STATES.has(pipeline.state)) return { error: "pipeline is closed or completed", status: 409 };
      const targetId = typeof req.stageId === "string" ? req.stageId : null;
      const target = targetId ? pipeline.stages.find((item) => item.id === targetId) ?? null : null;
      if (!target) return { error: "stage not found", status: 404 };
      /* Every attempt snapshots the stage's effectiveRole/prompt when it is
         created (newAttempt), so an override only takes effect on a stage that
         has not started; editing a stage mid-attempt would silently no-op. */
      const run = pipeline.runs.find((item) => item.stageId === target.id);
      if (run && run.attempts.length > 0) return { error: "stage has already started", status: 409 };
      const changesRoleOrRuntime = req.role !== undefined || req.engine !== undefined || req.model !== undefined || req.effort !== undefined;
      if (!changesRoleOrRuntime && req.prompt === undefined) return { error: "override-stage needs at least one field to change", status: 400 };
      /* Validate the runtime types up front: resolvePipelineRole treats a
         non-string, non-null model/effort as absent and silently uses the
         fallback, so a raw `model: 123` / `effort: false` would 200 with the old
         config instead of the required 400 (issue #118 Finding 3). */
      if (req.engine !== undefined && req.engine !== "claude" && req.engine !== "codex") return { error: "engine must be claude or codex", status: 400 };
      if (req.model !== undefined && req.model !== null && typeof req.model !== "string") return { error: "model must be a string or null", status: 400 };
      if (req.effort !== undefined && req.effort !== null && typeof req.effort !== "string") return { error: "effort must be a string or null", status: 400 };

      /* Resolve the role/runtime combination through the same path creation uses
         (resolvePipelineRole), so a stage override honors canonical role
         resolution, param validation, disallowed-role and engine/model/effort
         bounds — never persisting a record the create path would have rejected.
         Skipped for a prompt-only edit so it can't drift the runtime on a registry
         change unrelated to what the operator touched. */
      if (changesRoleOrRuntime) {
        let roleRef = target.role;
        if (req.role !== undefined) {
          if (req.role === null) {
            roleRef = undefined;
          } else {
            if (typeof req.role !== "object" || Array.isArray(req.role)) return { error: "role must be an object or null", status: 400 };
            const roleId = typeof req.role.roleId === "string" ? req.role.roleId.trim() : "";
            if (!roleId) return { error: "role requires a roleId", status: 400 };
            const params = req.role.params;
            if (params !== undefined && (!params || typeof params !== "object" || Array.isArray(params))) return { error: "role params must be an object", status: 400 };
            if (params && Object.values(params).some((value) => typeof value !== "string" && typeof value !== "number")) return { error: "role params must be strings or numbers", status: 400 };
            const paramError = params ? validatePipelineRoleParams(roleId, params as Record<string, string | number>) : null;
            if (paramError) return { error: paramError, status: 400 };
            roleRef = { roleId: roleId as PipelineRoleId, ...(params && Object.keys(params).length ? { params: params as Record<string, string | number> } : {}) };
          }
        }
        /* Changing the role drops any unpinned runtime so the new role's defaults
           apply; an explicit engine/model/effort in the request still wins. When
           the role is unchanged, unpinned fields keep the stage's existing values. */
        const resetRuntime = req.role !== undefined;
        const resolved = resolvePipelineRole(
          {
            role: roleRef,
            engine: req.engine !== undefined ? req.engine : resetRuntime ? undefined : target.engine,
            model: req.model !== undefined ? req.model : resetRuntime ? undefined : target.model,
            effort: req.effort !== undefined ? req.effort : resetRuntime ? undefined : target.effort,
            access: target.access,
          },
          target.kind,
          ports.roleLookup,
        );
        if (!resolved.role) return { error: resolved.error ?? "invalid stage role", status: 400 };
        /* The store keeps a stage's input-level role/engine/model/effort
           consistent with its effectiveRole (isStage), so mirror the resolution
           onto both: the effectiveRole is what a fresh attempt snapshots, the
           input fields keep the persisted record valid. */
        target.effectiveRole = resolved.role;
        target.role = roleRef;
        target.engine = resolved.role.engine;
        target.model = resolved.role.model;
        target.effort = resolved.role.effort;
        target.access = resolved.role.access;
        /* Belt-and-braces: resolvePipelineRole already enforces these bounds, but
           re-check so a future resolver change can never persist a poisoned record. */
        if (!isEffectiveRole(target.effectiveRole)) return { error: "stage role is not a valid engine/model/effort combination", status: 400 };
      }

      if (req.prompt !== undefined) {
        if (typeof req.prompt !== "string" || !req.prompt.trim()) return { error: "prompt must be a non-empty string", status: 400 };
        const prompt = req.prompt.trim();
        /* Same ceiling creation enforces (normalizeStages), so an override can
           never persist a record larger than the create path would accept and
           later balloon a run prompt / park review-loop delivery. */
        if (prompt.length > MAX_STAGE_PROMPT_LENGTH) return { error: `stage prompt exceeds ${MAX_STAGE_PROMPT_LENGTH} characters`, status: 400 };
        target.prompt = prompt;
      }
    } else if (req.action === "delete") {
      if (pipeline.state !== "draft") return { error: "only draft pipelines can be deleted", status: 409 };
      pipeline.hiddenAt = ports.now();
      persist();
      return { pipeline };
    } else if (req.action === "close") {
      if (pipeline.state === "draft") {
        pipeline.hiddenAt = ports.now();
        persist();
        return { pipeline };
      }
      if (flow && flow.state !== "closed") {
        const closed = await ports.closeFlow(flow.id);
        if (closed?.error) {
          pipeline.stateDetail = closed.error;
          persist();
          return { error: closed.error, status: closed.status ?? 409 };
        }
      }
      /* A cursor can rest at state pending before its round's attempt
         materializes: the initial stage right after provisioning, the next stage
         in the window after an advance, or a fail-edge target whose latest attempt
         is an older terminal round. Record that resting round as a truthful pending
         attempt so the cursorless projection keeps the k/n position once the cursor
         clears — matching the attempt the next tick would create. The attempt
         inherits the cursor's durable relay record (including fail-edge
         activatedBy) and carries no run timestamps (it never started). */
      if (stage && (!attempt || (pipeline.cursor?.state === "pending" && TERMINAL_ATTEMPT_STATES.has(attempt.state)))) {
        newAttempt(pipeline, stage);
      }
      pipeline.state = "closed";
      pipeline.cursor = null;
      pipeline.pausedState = null;
      pipeline.stateDetail = null;
      pipeline.closedAt = ports.now();
      pipeline.hiddenAt = pipeline.closedAt;
    } else {
      return { error: "unknown pipeline action", status: 400 };
    }
    persist();
    return { pipeline };
  });
}

export function getPipelines(): { pipelines: Pipeline[] } {
  return { pipelines: loadPipelines() };
}
