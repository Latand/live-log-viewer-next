import crypto from "node:crypto";
import path from "node:path";

import { accountManager } from "@/lib/accounts/manager";
import { emptyLaunchProfile, type ViewerConversationId } from "@/lib/accounts/migration/contracts";
import { freshSpecFor } from "@/lib/agent/cli";
import { agentRegistry } from "@/lib/agent/registry";
import { sessionKeyFromTranscript } from "@/lib/agent/sessionKey";
import { resolveSpawnedTranscriptPath } from "@/lib/agent/spawnedTranscript";
import { headCwd } from "@/lib/agent/transcript";
import { closeFlow, createFlowFromRequest, patchFlow } from "@/lib/flows/commands";
import { lastAssistantMessage } from "@/lib/flows/findings";
import { loadFlows } from "@/lib/flows/store";
import type { CreateFlowRequest, Flow, RoleConfig } from "@/lib/flows/types";
import { persistHandoffLineage, rememberHandoffChild } from "@/lib/handoffLineage";
import { isNativeCodexSubagentTranscript } from "@/lib/scanner/codexNative";
import { projectForCwd } from "@/lib/scanner/describe";
import { claudeProjectRootFor, codexSessionRootFor } from "@/lib/scanner/roots";
import { isShellCommand } from "@/lib/status";
import { paneInfo, spawnAgentWithPrompt, verifyTmuxHostEvidence } from "@/lib/tmux";
import type { FileEntry } from "@/lib/types";
import { realExec, type ExecPort } from "@/lib/workflows/provision";

import { commitPipelineStage, provisionPipelineWorktree, resetPipelineStage } from "./git";
import { renderStagePrompt } from "./prompts";
import { resolvePipelineRole, type PipelineRoleLookup } from "./roles";
import { buildPipeline, loadPipelines, savePipelines } from "./store";
import type {
  CreatePipelineRequest,
  EffectivePipelineRole,
  PatchPipelineRequest,
  Pipeline,
  PipelineRoleId,
  PipelineStage,
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

export interface PipelinePorts {
  exec: ExecPort;
  roleLookup?: PipelineRoleLookup | null;
  spawnAgent(input: {
    role: EffectivePipelineRole;
    cwd: string;
    prompt: string;
    parentPath: string | null;
    clientAttemptId: string;
  }): Promise<PipelineStageSpawn>;
  paneAgentAlive(paneId: string): Promise<boolean>;
  headCwd(transcriptPath: string): string | null;
  lastMessage(entry: FileEntry): { text: string; ts: number } | null;
  pathForConversation(conversationId: string): string | null;
  conversationIdForPath(pathname: string): string | null;
  createFlow(req: CreateFlowRequest, entries: FileEntry[]): Promise<{ flow?: Flow; error?: string }>;
  patchFlow(id: string, action: "advance" | "pause" | "resume", note?: string): void;
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

async function spawnPipelineAgent(input: Parameters<PipelinePorts["spawnAgent"]>[0]): Promise<PipelineStageSpawn> {
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
    spawnAgent: spawnPipelineAgent,
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
    patchFlow: (id, action, note) => void patchFlow(id, { action, ...(note ? { note } : {}) }),
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
  pipeline.pausedState = "running";
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

function newAttempt(pipeline: Pipeline, stage: PipelineStage, ports: PipelinePorts): PipelineStageAttempt | null {
  const resolved = resolvePipelineRole(stage, stage.kind, ports.roleLookup);
  if (!resolved.role) {
    park(pipeline, resolved.error ?? "stage role cannot be resolved");
    return null;
  }
  const run = runFor(pipeline, stage.id);
  if (!run) {
    park(pipeline, "pipeline stage run record is missing");
    return null;
  }
  const attempt: PipelineStageAttempt = {
    n: run.attempts.length + 1,
    state: "pending",
    effectiveRole: resolved.role,
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
  const result = commitPipelineStage(pipeline, stage.id, ports.exec);
  if (!result.ok) {
    park(pipeline, result.error, attempt);
    return;
  }
  pipeline.lastPassedCommit = result.sha;
  attempt.state = "passed";
  attempt.completedAt = ports.now();
  advancePipeline(pipeline, stage, ports);
}

function isNativeCodexSubagentEntry(entry: FileEntry): boolean {
  return entry.root === "codex-sessions" && entry.path.endsWith(".jsonl") && isNativeCodexSubagentTranscript(entry.path, entry.size);
}

function claimedPaths(pipeline: Pipeline): Set<string> {
  return new Set(pipeline.runs.flatMap((run) => run.attempts.flatMap((attempt) => attempt.agentPath ? [attempt.agentPath] : [])));
}

function updateAttemptIdentity(pipeline: Pipeline, attempt: PipelineStageAttempt, entries: FileEntry[], ports: PipelinePorts): void {
  if (!attempt.agentPath && attempt.conversationId) attempt.agentPath = ports.pathForConversation(attempt.conversationId);
  if (!attempt.agentPath && attempt.sessionId) {
    attempt.agentPath = entries.find((entry) => path.basename(entry.path).includes(attempt.sessionId!))?.path ?? null;
  }
  if (!attempt.agentPath && attempt.startedAt) {
    const started = unixMs(attempt.startedAt) / 1000 - 5;
    const taken = claimedPaths(pipeline);
    attempt.agentPath = entries
      .filter((entry) => entry.engine === attempt.effectiveRole.engine && entry.mtime >= started && !taken.has(entry.path) && !isNativeCodexSubagentEntry(entry) && ports.headCwd(entry.path) === pipeline.worktreeDir)
      .sort((left, right) => right.mtime - left.mtime)[0]?.path ?? null;
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
    ? newAttempt(pipeline, stage, ports)
    : prior ?? newAttempt(pipeline, stage, ports);
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
    }
    return;
  }

  if (attempt.state === "spawning") {
    if (!spawnsThisProcess.has(attemptKey(pipeline, stage, attempt)) && !attempt.launchId) {
      park(pipeline, "stage spawn was interrupted before durable launch evidence", attempt);
      return;
    }
    attempt.state = "running";
  }

  updateAttemptIdentity(pipeline, attempt, entries, ports);
  if (!attempt.agentPath) {
    if (attempt.paneId && !(await ports.paneAgentAlive(attempt.paneId))) park(pipeline, "stage agent exited before its session was discovered", attempt);
    return;
  }
  const entry = entries.find((candidate) => candidate.path === attempt!.agentPath);
  if (!entry) return;
  if (entry.activity === "live" || entry.activityReason === "jsonl_turn_open" || entry.activityReason === "jsonl_turn_stalled") return;
  const message = ports.lastMessage(entry);
  if (!message || message.ts <= unixMs(attempt.startedAt)) return;
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

function reviewNote(pipeline: Pipeline, stage: PipelineStage): string {
  return stage.prompt
    .split("{{task}}").join(pipeline.task)
    .split("{{prev.output}}").join(normalizedOutput(pipeline))
    .trim()
    .slice(0, 2_000);
}

async function tickReviewStage(
  pipeline: Pipeline,
  stage: PipelineStage,
  entries: FileEntry[],
  ports: PipelinePorts,
  persist: () => void,
): Promise<void> {
  const attempt = currentAttempt(pipeline, stage.id) ?? newAttempt(pipeline, stage, ports);
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
    ports.patchFlow(created.flow.id, "advance", reviewNote(pipeline, stage));
    return;
  }

  const flow = ports.getFlow(attempt.flowId);
  if (!flow) {
    park(pipeline, "embedded review flow record disappeared", attempt);
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
  if (tickStore.__llvPipelineTick) return { pipelines: loadPipelines(), changed: false };
  tickStore.__llvPipelineTick = true;
  const pipelines = loadPipelines();
  try {
    let changed = false;
    for (const pipeline of pipelines) {
      if (TERMINAL_STATES.has(pipeline.state) || pipeline.state === "paused" || pipeline.state === "needs_decision") continue;
      if (await tickPipeline(pipeline, entries, ports, () => savePipelines(pipelines))) changed = true;
      if (changed) savePipelines(pipelines);
    }
    if (changed) savePipelines(pipelines);
    return { pipelines, changed };
  } finally {
    tickStore.__llvPipelineTick = false;
  }
}

function normalizeStages(value: unknown, lookup?: PipelineRoleLookup | null): { stages?: PipelineStage[]; error?: string } {
  if (!Array.isArray(value) || value.length < 2 || value.length > 4) return { error: "pipelines require 2–4 stages" };
  const stages: PipelineStage[] = [];
  const ids = new Set<string>();
  let hasRun = false;
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "invalid pipeline stage" };
    const stage = raw as Partial<PipelineStage>;
    const id = typeof stage.id === "string" ? stage.id.trim() : "";
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || ids.has(id)) return { error: "stage ids must be unique URL-safe names" };
    if (stage.kind !== "run" && stage.kind !== "review-loop") return { error: "stage kind must be run or review-loop" };
    if (stage.kind === "review-loop" && !hasRun) return { error: "review-loop stage requires a preceding run stage" };
    const prompt = typeof stage.prompt === "string" ? stage.prompt.trim() : "";
    if (!prompt) return { error: `stage ${id} prompt is required` };
    const roleValue = (raw as { role?: unknown }).role;
    if (roleValue !== undefined && (!roleValue || typeof roleValue !== "object" || Array.isArray(roleValue))) {
      return { error: `stage ${id} role must be an object` };
    }
    if (roleValue && Object.keys(roleValue).some((key) => key !== "roleId")) {
      return { error: `stage ${id} role only accepts roleId; place overrides on the stage` };
    }
    const roleId = roleValue && typeof (roleValue as { roleId?: unknown }).roleId === "string"
      ? (roleValue as { roleId: string }).roleId.trim()
      : "";
    if (roleValue && !roleId) return { error: `stage ${id} roleId is required when role is present` };
    if (stage.model !== undefined && stage.model !== null && typeof stage.model !== "string") return { error: `stage ${id} model must be a string or null` };
    if (stage.effort !== undefined && stage.effort !== null && typeof stage.effort !== "string") return { error: `stage ${id} effort must be a string or null` };
    const normalizedStage: PipelineStage = {
      id,
      kind: stage.kind,
      ...(roleId ? { role: { roleId: roleId as PipelineRoleId } } : {}),
      ...(stage.engine !== undefined ? { engine: stage.engine } : {}),
      ...(stage.model !== undefined ? { model: typeof stage.model === "string" ? stage.model.trim() || null : null } : {}),
      ...(stage.effort !== undefined ? { effort: typeof stage.effort === "string" ? stage.effort.trim() || null : null } : {}),
      ...(stage.access !== undefined ? { access: stage.access } : {}),
      prompt,
      next: stage.next ?? null,
    };
    const resolved = resolvePipelineRole(normalizedStage, stage.kind, lookup);
    if (!resolved.role) return { error: resolved.error };
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

export function createPipelineFromRequest(
  req: CreatePipelineRequest,
  ports: PipelinePorts = defaultPipelinePorts(),
): { pipeline?: Pipeline; error?: string; status?: number } {
  const task = typeof req.task === "string" ? req.task.trim() : "";
  if (!task) return { error: "task is required", status: 400 };
  const spec = typeof req.spec === "string" && req.spec.trim() ? req.spec.trim() : undefined;
  if (req.spec !== undefined && typeof req.spec !== "string") return { error: "spec must be a string", status: 400 };
  const repoDir = typeof req.repoDir === "string" ? req.repoDir.trim() : "";
  if (!repoDir) return { error: "repoDir is required", status: 400 };
  const git = ports.exec("git", ["rev-parse", "--git-dir"], repoDir);
  if (git.code !== 0) return { error: `not a git repository: ${repoDir}`, status: 400 };
  const normalized = normalizeStages(req.stages, ports.roleLookup);
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
  });
  const pipelines = loadPipelines();
  pipelines.push(pipeline);
  savePipelines(pipelines);
  return { pipeline };
}

export async function patchPipeline(
  id: string,
  req: PatchPipelineRequest,
  ports: PipelinePorts = defaultPipelinePorts(),
): Promise<{ pipeline?: Pipeline; error?: string; status?: number }> {
  const pipelines = loadPipelines();
  const pipeline = pipelines.find((item) => item.id === id);
  if (!pipeline) return { error: "pipeline not found", status: 404 };
  const stage = currentStage(pipeline);
  const attempt = stage ? currentAttempt(pipeline, stage.id) : null;
  const flow = attempt?.flowId ? ports.getFlow(attempt.flowId) : null;

  if (req.action === "pause") {
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
  } else if (req.action === "close") {
    if (flow && flow.state !== "closed") await ports.closeFlow(flow.id);
    pipeline.state = "closed";
    pipeline.pausedState = null;
    pipeline.stateDetail = null;
    pipeline.closedAt = ports.now();
  } else {
    return { error: "unknown pipeline action", status: 400 };
  }
  savePipelines(pipelines);
  return { pipeline };
}

export function getPipelines(): { pipelines: Pipeline[] } {
  return { pipelines: loadPipelines() };
}
