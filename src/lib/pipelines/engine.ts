import crypto from "node:crypto";
import path from "node:path";

import { accountManager } from "@/lib/accounts/manager";
import { emptyLaunchProfile, type ViewerConversationId } from "@/lib/accounts/migration/contracts";
import { freshSpecFor } from "@/lib/agent/cli";
import { agentRegistry } from "@/lib/agent/registry";
import { sessionKeyFromTranscript } from "@/lib/agent/sessionKey";
import { resolveSpawnedTranscriptPath } from "@/lib/agent/spawnedTranscript";
import { headCwd } from "@/lib/agent/transcript";
import { MAX_FLOW_NOTE_LENGTH, closeFlow, createFlowFromRequest, patchFlow } from "@/lib/flows/commands";
import { lastAssistantMessage } from "@/lib/flows/findings";
import { loadFlows } from "@/lib/flows/store";
import type { CreateFlowRequest, Flow, RoleConfig } from "@/lib/flows/types";
import { persistHandoffLineage, rememberHandoffChild } from "@/lib/handoffLineage";
import { projectForCwd } from "@/lib/scanner/describe";
import { claudeProjectRootFor, codexSessionRootFor } from "@/lib/scanner/roots";
import { isShellCommand } from "@/lib/status";
import { paneInfo, spawnAgentWithPrompt, verifyTmuxHostEvidence } from "@/lib/tmux";
import type { FileEntry } from "@/lib/types";
import { realExec, type ExecPort } from "@/lib/workflows/provision";

import { commitPipelineStage, provisionPipelineWorktree, resetPipelineStage } from "./git";
import { MAX_SPEC_LENGTH, MAX_STAGE_PROMPT_LENGTH, MAX_TASK_LENGTH } from "./limits";
import { renderStagePrompt } from "./prompts";
import { pipelineRoleLookup, resolvePipelineRole, validatePipelineRoleParams, type PipelineRoleLookup } from "./roles";
import { buildPipeline, isEffectiveRole, loadPipelines, pipelineIdentity, PipelineStoreError, withPipelineMutation } from "./store";
import type {
  CreatePipelineRequest,
  EffectivePipelineRole,
  PatchPipelineRequest,
  Pipeline,
  PipelineRoleId,
  PipelineStage,
  PipelineStageInput,
  PipelineStageAttempt,
} from "./types";
import { parseStageVerdict } from "./verdict";

export type PipelineStageSpawn = {
  launchId: string;
  conversationId: string;
  sessionId: string | null;
  transcript: string | null;
  paneId: string | null;
};

export type PipelineStageLaunchReservation = Pick<PipelineStageSpawn, "launchId" | "conversationId">;
export type PipelineSpawnReceipt = PipelineStageSpawn & {
  state: "starting" | "pane-bound" | "host-verified" | "prompt-delivered" | "path-pending" | "completed" | "failed" | "conflicted";
};

export interface PipelinePorts {
  exec: ExecPort;
  roleLookup?: PipelineRoleLookup | null;
  spawnAgent(input: {
    role: EffectivePipelineRole;
    cwd: string;
    prompt: string;
    parentPath: string | null;
    clientAttemptId: string;
  }, onReserved: (reservation: PipelineStageLaunchReservation) => void): Promise<PipelineStageSpawn>;
  spawnReceipt(launchId: string): PipelineSpawnReceipt | null;
  paneAgentAlive(paneId: string): Promise<boolean>;
  headCwd(transcriptPath: string): string | null;
  lastMessage(entry: FileEntry): { text: string; ts: number } | null;
  pathForConversation(conversationId: string): string | null;
  conversationIdForPath(pathname: string): string | null;
  createFlow(req: CreateFlowRequest, entries: FileEntry[]): Promise<{ flow?: Flow; error?: string }>;
  patchFlow(id: string, action: "advance" | "pause" | "resume", note?: string): { error?: string; status?: number };
  closeFlow(id: string): Promise<unknown>;
  getFlow(id: string): Flow | null;
  findFlow(implementerPath: string, baseRef: string, createdAfter: string): Flow | null;
  projectForCwd(cwd: string): string | null;
  now(): string;
}

function engineForTranscript(transcript: string): "claude" | "codex" | null {
  if (codexSessionRootFor(transcript)) return "codex";
  if (claudeProjectRootFor(transcript)) return "claude";
  return null;
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
    codexHome: input.role.engine === "codex" ? account.home : null,
    claudeConfigDir: input.role.engine === "claude" ? account.home : null,
    claudeProjectsDir: input.role.engine === "claude" ? account.transcriptRoot : null,
  });
  const launchProfile = emptyLaunchProfile({
    ...(specBase.launchProfile ?? {}),
    cwd: input.cwd,
    parentConversationId: parent.conversationId,
  });
  const digest = crypto.createHash("sha256").update(JSON.stringify({
    engine: input.role.engine,
    model: input.role.model,
    effort: input.role.effort,
    cwd: input.cwd,
    parentConversationId: parent.conversationId,
    prompt: input.prompt,
  })).digest("hex");
  const registry = agentRegistry();
  const begun = registry.beginSpawnRequest({
    engine: input.role.engine,
    cwd: input.cwd,
    accountId: account.accountId,
    parentConversationId: parent.conversationId,
    parentSessionKey: parent.sessionKey,
    parentArtifactPath: parent.conversationId ? input.parentPath : null,
    launchProfile,
    clientAttemptId: input.clientAttemptId,
    requestDigest: digest,
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
  const startedAtMs = Date.now();
  const pane = await spawnAgentWithPrompt(spec, input.prompt, begun.receipt);
  const transcript = await resolveSpawnedTranscriptPath({
    engine: input.role.engine,
    knownTranscript: spec.transcript ?? null,
    panePid: pane.panePid ?? null,
    cwd: input.cwd,
    startedAtMs,
    codexSessionsDir: input.role.engine === "codex" ? account.transcriptRoot : null,
  });
  if (!pane.host || !(await verifyTmuxHostEvidence(pane.host))) {
    registry.invalidateSpawnHost(begun.receipt.launchId, "pipeline spawn host disappeared before confirmation");
    throw new Error("pipeline spawn host disappeared before confirmation");
  }
  const key = transcript ? sessionKeyFromTranscript(input.role.engine, transcript) : null;
  if (transcript && key && pane.receipt) {
    const settled = registry.settleSpawn(pane.receipt.launchId, {
      key,
      artifactPath: transcript,
      cwd: input.cwd,
      accountId: account.accountId,
      status: "starting",
      host: pane.host,
      claimEpoch: 0,
      claimOwner: null,
      pendingAction: "spawn",
    });
    if (settled.kind === "conflict") throw new Error(settled.code);
  } else {
    registry.markSpawnPathPending(begun.receipt.launchId);
  }
  if (transcript && input.parentPath && parent.conversationId) {
    rememberHandoffChild(transcript, input.parentPath);
    persistHandoffLineage();
  }
  return {
    launchId: begun.receipt.launchId,
    conversationId: begun.receipt.conversationId,
    sessionId: key?.sessionId ?? null,
    transcript,
    paneId: pane.paneId,
  };
}

export function defaultPipelinePorts(): PipelinePorts {
  return {
    exec: realExec,
    roleLookup: pipelineRoleLookup,
    spawnAgent: spawnPipelineAgent,
    spawnReceipt: (launchId) => {
      const receipt = agentRegistry().snapshot().receipts[launchId];
      if (!receipt) return null;
      return {
        state: receipt.state,
        launchId: receipt.launchId,
        conversationId: receipt.conversationId,
        sessionId: receipt.key?.sessionId ?? null,
        transcript: receipt.artifactPath,
        paneId: receipt.verifiedHost?.paneId ?? receipt.pane?.paneId ?? null,
      };
    },
    paneAgentAlive: async (paneId) => {
      const info = await paneInfo(paneId);
      return info !== null && !isShellCommand(info.command);
    },
    headCwd: (transcriptPath) => headCwd(transcriptPath),
    lastMessage: lastAssistantMessage,
    pathForConversation: (conversationId) => conversationId.startsWith("conversation_")
      ? agentRegistry().conversation(conversationId as ViewerConversationId)?.generations.at(-1)?.path ?? null
      : null,
    conversationIdForPath: (pathname) => agentRegistry().conversationForPath(pathname)?.id ?? null,
    createFlow: createFlowFromRequest,
    patchFlow: (id, action, note) => patchFlow(id, { action, ...(note ? { note } : {}) }),
    closeFlow,
    getFlow: (id) => loadFlows().find((flow) => flow.id === id) ?? null,
    findFlow: (implementerPath, baseRef, createdAfter) => loadFlows()
      .filter((flow) => flow.implementerPath === implementerPath && flow.baseRef === baseRef && flow.createdAt >= createdAfter)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0] ?? null,
    projectForCwd,
    now: () => new Date().toISOString(),
  };
}

const spawnsThisProcess = new Set<string>();
const TERMINAL_STATES = new Set<Pipeline["state"]>(["completed", "closed"]);


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
  return runFor(pipeline, stageId)?.attempts.at(-1) ?? null;
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

function normalizedOutput(pipeline: Pipeline): string {
  if (!pipeline.cursor) return "";
  const currentIndex = pipeline.stages.findIndex((stage) => stage.id === pipeline.cursor?.stageId);
  for (let index = currentIndex - 1; index >= 0; index -= 1) {
    const attempt = currentAttempt(pipeline, pipeline.stages[index]!.id);
    if (attempt?.output) return attempt.output;
  }
  return "";
}

function latestCompletedAgentPath(pipeline: Pipeline, beforeStageId?: string): string | null {
  const stop = beforeStageId ? pipeline.stages.findIndex((stage) => stage.id === beforeStageId) : pipeline.stages.length;
  for (let index = stop - 1; index >= 0; index -= 1) {
    const attempt = currentAttempt(pipeline, pipeline.stages[index]!.id);
    if (attempt?.agentPath && (attempt.state === "passed" || attempt.state === "skipped")) return attempt.agentPath;
  }
  return pipeline.srcPath;
}

function latestPassedRun(pipeline: Pipeline, stageId: string): PipelineStageAttempt | null {
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
    startedAt: null,
    completedAt: null,
    output: null,
    verdict: null,
    error: null,
  };
  run.attempts.push(attempt);
  return attempt;
}

function advancePipeline(pipeline: Pipeline, stage: PipelineStage, ports: PipelinePorts): void {
  if (stage.next === null) {
    pipeline.cursor = null;
    pipeline.state = "completed";
    pipeline.stateDetail = null;
    pipeline.pausedState = null;
    pipeline.closedAt = ports.now();
    return;
  }
  pipeline.cursor = { stageId: stage.next, state: "pending" };
  pipeline.state = "running";
  pipeline.stateDetail = null;
  pipeline.pausedState = null;
}

function commitPassedStage(
  pipeline: Pipeline,
  stage: PipelineStage,
  attempt: PipelineStageAttempt,
  ports: PipelinePorts,
): void {
  const result = commitPipelineStage(pipeline, stage.id, stage.kind === "review-loop" || attempt.effectiveRole.access === "read-write", ports.exec);
  if (!result.ok) {
    park(pipeline, result.error, attempt);
    return;
  }
  pipeline.lastPassedCommit = result.sha;
  attempt.state = "passed";
  attempt.completedAt = ports.now();
  advancePipeline(pipeline, stage, ports);
}

function updateAttemptIdentity(pipeline: Pipeline, attempt: PipelineStageAttempt, entries: FileEntry[], ports: PipelinePorts): void {
  if (!attempt.agentPath && attempt.conversationId) attempt.agentPath = ports.pathForConversation(attempt.conversationId);
  if (!attempt.agentPath && attempt.sessionId) {
    attempt.agentPath = entries.find((entry) => path.basename(entry.path).includes(attempt.sessionId!))?.path ?? null;
  }
  if (attempt.agentPath) {
    attempt.conversationId ??= ports.conversationIdForPath(attempt.agentPath);
    attempt.sessionId ??= sessionKeyFromTranscript(attempt.effectiveRole.engine, attempt.agentPath)?.sessionId ?? null;
  }
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
    pipeline.cursor = { stageId: stage.id, state: "spawning" };
    spawnsThisProcess.add(attemptKey(pipeline, stage, attempt));
    persist();
    try {
      const prompt = renderStagePrompt(pipeline, stage, attempt.effectiveRole, normalizedOutput(pipeline));
      const spawned = await ports.spawnAgent({
        role: attempt.effectiveRole,
        cwd: pipeline.worktreeDir,
        prompt,
        parentPath: latestCompletedAgentPath(pipeline, stage.id),
        clientAttemptId: clientAttemptId(pipeline, stage, attempt),
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
      pipeline.cursor = { stageId: stage.id, state: "running" };
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
  if (!attempt.agentPath) {
    if (attempt.paneId && !(await ports.paneAgentAlive(attempt.paneId))) park(pipeline, "stage agent exited before its session was discovered", attempt);
    return;
  }
  const entry = entries.find((candidate) => candidate.path === attempt!.agentPath);
  if (!entry) {
    if (attempt.paneId && !(await ports.paneAgentAlive(attempt.paneId))) park(pipeline, "stage agent exited after its transcript disappeared from the scan", attempt);
    return;
  }
  if (entry.activity === "live" || entry.activityReason === "jsonl_turn_open" || entry.activityReason === "jsonl_turn_stalled") return;
  const message = ports.lastMessage(entry);
  if (!message || message.ts <= unixMs(attempt.startedAt)) {
    if (attempt.paneId && !(await ports.paneAgentAlive(attempt.paneId))) park(pipeline, "stage agent exited without producing a verdict", attempt);
    return;
  }
  const parsed = parseStageVerdict(message.text);
  if (!parsed) {
    park(pipeline, "stage completed without a valid final JSON verdict", attempt);
    return;
  }
  attempt.output = parsed.output;
  attempt.verdict = parsed.verdict;
  if (parsed.verdict.status !== "pass") {
    attempt.state = parsed.verdict.status === "fail" ? "failed" : "needs_decision";
    attempt.completedAt = ports.now();
    park(pipeline, parsed.verdict.findings?.[0] ?? `stage verdict: ${parsed.verdict.status}`, attempt);
    return;
  }
  attempt.state = "committing";
  pipeline.cursor = { stageId: stage.id, state: "committing" };
  persist();
  commitPassedStage(pipeline, stage, attempt, ports);
}

/** Substitute the {{task}}/{{prev.output}} placeholders and trim. */
function renderNoteTemplate(text: string, pipeline: Pipeline): string {
  return text
    .split("{{task}}").join(pipeline.task)
    .split("{{prev.output}}").join(normalizedOutput(pipeline))
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
  pipeline.cursor = { stageId: stage.id, state: "reviewing" };

  if (!attempt.flowId) {
    const existing = ports.findFlow(implementer.agentPath, pipeline.baseRef, attempt.startedAt);
    if (existing) {
      attempt.flowId = existing.id;
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
      roles: { implementer: implementerRole, reviewer: reviewerRole },
      baseMode: "head",
      baseRef: pipeline.baseRef,
      spec: pipeline.spec ?? pipeline.task,
      mode: "auto",
      reviewerMode: "headless",
      roundLimit: 5,
    }, entries);
    if (!created.flow) {
      park(pipeline, `creating the review flow failed: ${created.error ?? "unknown error"}`, attempt);
      return;
    }
    attempt.flowId = created.flow.id;
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
  const round = flow.rounds.at(-1);
  attempt.sessionId = round?.sessionId ?? attempt.sessionId;
  attempt.agentPath = round?.reviewerPath ?? attempt.agentPath;
  attempt.conversationId = round?.reviewerConversationId ?? attempt.conversationId;
  if (flow.state === "approved") {
    attempt.output = `Review loop approved after ${flow.rounds.length} round(s).`;
    attempt.verdict = { status: "pass", confidence: 1 };
    attempt.state = "committing";
    pipeline.cursor = { stageId: stage.id, state: "committing" };
    persist();
    commitPassedStage(pipeline, stage, attempt, ports);
  } else if (flow.state === "needs_decision" || flow.state === "done_comment" || flow.state === "closed") {
    park(pipeline, `review loop ended in ${flow.state}: ${flow.stateDetail ?? "operator decision required"}`, attempt);
  }
}

async function tickPipeline(pipeline: Pipeline, entries: FileEntry[], ports: PipelinePorts, persist: () => void): Promise<boolean> {
  const before = JSON.stringify(pipeline);
  if (pipeline.state === "provisioning") {
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

export async function tickPipelines(entries: FileEntry[], ports: PipelinePorts = defaultPipelinePorts()): Promise<{ pipelines: Pipeline[]; changed: boolean }> {
  if (tickStore.__llvPipelineTick) return { pipelines: [], changed: false };
  tickStore.__llvPipelineTick = true;
  try {
    return await withPipelineMutation(async (pipelines, persist) => {
      let changed = false;
      for (const pipeline of pipelines) {
        if (TERMINAL_STATES.has(pipeline.state) || pipeline.state === "paused" || pipeline.state === "needs_decision") continue;
        if (await tickPipeline(pipeline, entries, ports, persist)) changed = true;
        if (changed) persist();
      }
      if (changed) persist();
      return { pipelines, changed };
    });
  } catch (error) {
    /* The store fails closed on malformed state, but this tick runs inside
       the shared reconcile pass — flows, workflows, and the task inbox must
       keep ticking when only the pipelines registry is unreadable. */
    if (!(error instanceof PipelineStoreError)) throw error;
    console.error("[pipelines] skipping tick; registry unreadable", error);
    return { pipelines: [], changed: false };
  } finally {
    tickStore.__llvPipelineTick = false;
  }
}

function normalizeStages(
  value: unknown,
  lookup?: PipelineRoleLookup | null,
  preservedStages?: ReadonlyMap<string, PipelineStage>,
  /* Drafts assemble from zero on the canvas (#136), so their edit path accepts
     0–4 stages; the run path (create-and-start) keeps the 2-stage floor. The
     review-loop-needs-a-preceding-run and linear-chain rules apply either way. */
  minStages = 2,
): { stages?: PipelineStage[]; error?: string } {
  if (!Array.isArray(value) || value.length < minStages || value.length > 4) {
    return { error: minStages === 0 ? "pipelines require at most 4 stages" : "pipelines require 2–4 stages" };
  }
  const stages: PipelineStage[] = [];
  const ids = new Set<string>();
  let hasRun = false;
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "invalid pipeline stage" };
    const stage = raw as Partial<PipelineStageInput>;
    const id = typeof stage.id === "string" ? stage.id.trim() : "";
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || ids.has(id)) return { error: "stage ids must be unique URL-safe names" };
    const preservedStage = preservedStages?.get(id);
    if (stage.kind !== "run" && stage.kind !== "review-loop") return { error: "stage kind must be run or review-loop" };
    if (stage.kind === "review-loop" && !hasRun) return { error: "review-loop stage requires a preceding run stage" };
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
    };
    const resolved = preservedStage ? { role: preservedStage.effectiveRole } : resolvePipelineRole(input, stage.kind, lookup);
    if (!resolved.role) return { error: "error" in resolved ? resolved.error : "invalid stage role" };
    const normalizedStage: PipelineStage = { ...input, effectiveRole: structuredClone(resolved.role) };
    ids.add(id);
    if (stage.kind === "run") hasRun = true;
    stages.push(normalizedStage);
  }
  for (let index = 0; index < stages.length; index += 1) {
    const expected = stages[index + 1]?.id ?? null;
    if (stages[index]!.next !== expected) return { error: `stage ${stages[index]!.id} next must be ${expected ?? "null"}` };
  }
  return { stages };
}

function draftStageInputs(stages: PipelineStage[]): PipelineStageInput[] {
  return stages.map((stage, index) => ({
    id: stage.id,
    kind: stage.kind,
    ...(stage.role ? { role: structuredClone(stage.role) } : {}),
    ...(stage.engine !== undefined ? { engine: stage.engine } : {}),
    ...(stage.model !== undefined ? { model: stage.model } : {}),
    ...(stage.effort !== undefined ? { effort: stage.effort } : {}),
    ...(stage.access !== undefined ? { access: stage.access } : {}),
    prompt: stage.prompt,
    next: stages[index + 1]?.id ?? null,
  }));
}

function replaceDraftStages(
  pipeline: Pipeline,
  inputs: PipelineStageInput[],
  lookup?: PipelineRoleLookup | null,
): { error?: string } {
  const relinked = inputs.map((stage, index) => ({ ...stage, next: inputs[index + 1]?.id ?? null }));
  const preserved = new Map(pipeline.stages.map((stage) => [stage.id, stage]));
  /* Draft edits may empty the plan entirely (remove down to zero); the 2-stage
     floor is enforced only at Start (#136). */
  const normalized = normalizeStages(relinked, lookup, preserved, 0);
  if (!normalized.stages) return { error: normalized.error ?? "invalid stages" };
  pipeline.stages = normalized.stages;
  pipeline.runs = normalized.stages.map((stage) => ({ stageId: stage.id, attempts: [] }));
  pipeline.cursor = normalized.stages.length ? { stageId: normalized.stages[0]!.id, state: "pending" } : null;
  return {};
}

export async function createPipelineFromRequest(
  req: CreatePipelineRequest,
  ports: PipelinePorts = defaultPipelinePorts(),
): Promise<{ pipeline?: Pipeline; error?: string; status?: number }> {
  const task = typeof req.task === "string" ? req.task.trim() : "";
  if (!task) return { error: "task is required", status: 400 };
  if (task.length > MAX_TASK_LENGTH) return { error: `task exceeds ${MAX_TASK_LENGTH} characters`, status: 400 };
  const spec = typeof req.spec === "string" && req.spec.trim() ? req.spec.trim() : undefined;
  if (req.spec !== undefined && typeof req.spec !== "string") return { error: "spec must be a string", status: 400 };
  if (spec && spec.length > MAX_SPEC_LENGTH) return { error: `spec exceeds ${MAX_SPEC_LENGTH} characters`, status: 400 };
  if (req.autoStart !== undefined && typeof req.autoStart !== "boolean") return { error: "autoStart must be a boolean", status: 400 };
  const repoDir = typeof req.repoDir === "string" ? req.repoDir.trim() : "";
  if (!repoDir) return { error: "repoDir is required", status: 400 };
  const git = ports.exec("git", ["rev-parse", "--git-dir"], repoDir);
  if (git.code !== 0) return { error: `not a git repository: ${repoDir}`, status: 400 };
  /* A draft (autoStart:false) may be created empty and assembled on the canvas
     (#136); an immediately-started pipeline still needs its full 2–4 stage plan. */
  const normalized = normalizeStages(req.stages, ports.roleLookup, undefined, req.autoStart === false ? 0 : 2);
  if (!normalized.stages) return { error: normalized.error ?? "invalid stages", status: 400 };
  const srcPath = typeof req.src === "string" && req.src.trim() ? req.src.trim() : null;
  const pipeline = buildPipeline({
    id: crypto.randomUUID().slice(0, 8),
    task,
    ...(spec ? { spec } : {}),
    project: ports.projectForCwd(repoDir) ?? path.basename(repoDir),
    repoDir,
    stages: normalized.stages,
    srcPath,
    srcConversationId: srcPath ? ports.conversationIdForPath(srcPath) : null,
    now: ports.now(),
    state: req.autoStart === false ? "draft" : "provisioning",
  });
  return withPipelineMutation((pipelines, persist) => {
    pipelines.push(pipeline);
    persist();
    return { pipeline };
  });
}

/** A park without a verdict (interrupted spawn, vanished transcript) can
    leave the stage agent mid-turn in its pane; retry/skip would reset the
    worktree under it and the next passed stage would commit its strays. An
    attempt that produced a verdict finished its turn — an idle interactive
    CLI in the pane is safe to leave behind. */
async function orphanAgentPane(
  attempt: PipelineStageAttempt | null,
  ports: PipelinePorts,
): Promise<{ error: string; status: number } | null> {
  if (!attempt || attempt.verdict || !attempt.paneId) return null;
  if (!(await ports.paneAgentAlive(attempt.paneId))) return null;
  return { error: `stage agent may still be running in pane ${attempt.paneId}; wait for it to exit or kill the pane first`, status: 409 };
}

export async function patchPipeline(
  id: string,
  req: PatchPipelineRequest,
  ports: PipelinePorts = defaultPipelinePorts(),
): Promise<{ pipeline?: Pipeline; error?: string; status?: number }> {
  return withPipelineMutation(async (pipelines, persist) => {
    const pipeline = pipelines.find((item) => item.id === id);
    if (!pipeline) return { error: "pipeline not found", status: 404 };
    const stage = currentStage(pipeline);
    const attempt = stage ? currentAttempt(pipeline, stage.id) : null;
    const flow = attempt?.flowId ? ports.getFlow(attempt.flowId) : null;

    if (req.action === "start") {
      if (pipeline.state !== "draft") return { error: "pipeline is not a draft", status: 409 };
      /* Start enforces the 2–4 stage floor (#136): a draft may hold zero stages
         while it is assembled on the canvas, and it needs a full stage plan to run.
         The review-loop-needs-a-preceding-run rule already held on every draft edit. */
      if (pipeline.stages.length < 2) return { error: "add at least 2 stages before starting", status: 409 };
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
      const repoDir = req.repoDir === undefined ? pipeline.repoDir : typeof req.repoDir === "string" ? req.repoDir.trim() : "";
      if (!repoDir) return { error: "repoDir is required", status: 400 };
      if (repoDir !== pipeline.repoDir) {
        const git = ports.exec("git", ["rev-parse", "--git-dir"], repoDir);
        if (git.code !== 0) return { error: `not a git repository: ${repoDir}`, status: 400 };
      }
      pipeline.task = task;
      if (spec) pipeline.spec = spec;
      else delete pipeline.spec;
      pipeline.repoDir = repoDir;
      pipeline.project = ports.projectForCwd(repoDir) ?? path.basename(repoDir);
      Object.assign(pipeline, pipelineIdentity(pipeline.id, task, repoDir));
    } else if (req.action === "add-stage") {
      if (pipeline.state !== "draft") return { error: "pipeline is not a draft", status: 409 };
      if (!req.stage || typeof req.stage !== "object" || Array.isArray(req.stage)) return { error: "stage is required", status: 400 };
      const inputs = draftStageInputs(pipeline.stages);
      const index = req.index === undefined ? inputs.length : req.index;
      if (!Number.isInteger(index) || index < 0 || index > inputs.length) return { error: "stage index is out of range", status: 400 };
      inputs.splice(index, 0, req.stage);
      const replaced = replaceDraftStages(pipeline, inputs, ports.roleLookup);
      if (replaced.error) return { error: replaced.error, status: 400 };
    } else if (req.action === "remove-stage") {
      if (pipeline.state !== "draft") return { error: "pipeline is not a draft", status: 409 };
      /* A draft can be emptied entirely on the canvas (#136); the 2-stage floor is
         a Start-time gate. remove that would orphan a review-loop (drop its only
         preceding run) is still rejected by replaceDraftStages' normalization. */
      if (pipeline.stages.length === 0) return { error: "no stage to remove", status: 409 };
      const index = pipeline.stages.findIndex((stage) => stage.id === req.stageId);
      if (index < 0) return { error: "stage not found", status: 404 };
      const inputs = draftStageInputs(pipeline.stages);
      inputs.splice(index, 1);
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
      const orphan = await orphanAgentPane(attempt, ports);
      if (orphan) return orphan;
      if (flow && flow.state !== "closed") await ports.closeFlow(flow.id);
      if (pipeline.lastPassedCommit) {
        const reset = resetPipelineStage(pipeline, ports.exec);
        if (!reset.ok) return { error: reset.error, status: 409 };
        pipeline.state = "running";
      } else {
        pipeline.state = "provisioning";
      }
      if (stage) pipeline.cursor = { stageId: stage.id, state: "pending" };
      pipeline.pausedState = null;
      pipeline.stateDetail = null;
    } else if (req.action === "skip-stage") {
      if (pipeline.state !== "needs_decision" || !stage) return { error: "pipeline does not have a stage awaiting a decision", status: 409 };
      const orphan = await orphanAgentPane(attempt, ports);
      if (orphan) return orphan;
      if (flow && flow.state !== "closed") await ports.closeFlow(flow.id);
      if (!pipeline.lastPassedCommit) return { error: "pipeline worktree has not been provisioned", status: 409 };
      const reset = resetPipelineStage(pipeline, ports.exec);
      if (!reset.ok) return { error: reset.error, status: 409 };
      if (attempt) {
        attempt.state = "skipped";
        attempt.completedAt = ports.now();
        attempt.output = "Skipped by operator.";
      }
      advancePipeline(pipeline, stage, ports);
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
      pipelines.splice(pipelines.indexOf(pipeline), 1);
      persist();
      return { pipeline };
    } else if (req.action === "close") {
      if (pipeline.state === "draft") {
        pipelines.splice(pipelines.indexOf(pipeline), 1);
        persist();
        return { pipeline };
      }
      if (flow && flow.state !== "closed") await ports.closeFlow(flow.id);
      pipeline.state = "closed";
      pipeline.cursor = null;
      pipeline.pausedState = null;
      pipeline.stateDetail = null;
      pipeline.closedAt = ports.now();
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
