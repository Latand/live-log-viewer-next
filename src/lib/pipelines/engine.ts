import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { accountManager } from "@/lib/accounts/manager";
import { mirroredClaudeTranscriptPath } from "@/lib/accounts/claude";
import { emptyLaunchProfile, type ViewerConversationId } from "@/lib/accounts/migration/contracts";
import { freshSpecFor } from "@/lib/agent/cli";
import { agentRegistry, type DurableMembershipInput, type TmuxHostEvidence } from "@/lib/agent/registry";
import { forEachCooperatively } from "@/lib/cooperative";
import { transcriptAllowed } from "@/lib/agent/spawnParent";
import { sessionKeyFromTranscript, sessionKeyId } from "@/lib/agent/sessionKey";
import { headCwd } from "@/lib/agent/transcript";
import { MAX_FLOW_NOTE_LENGTH, closeFlow, createFlowFromRequest, isRecoverableLegacyRelayFailurePause, patchFlow } from "@/lib/flows/commands";
import { lastAssistantMessage } from "@/lib/flows/findings";
import { loadFlows } from "@/lib/flows/store";
import type { CreateFlowRequest, Flow, RoleConfig } from "@/lib/flows/types";
import { persistHandoffLineage, rememberHandoffChild } from "@/lib/handoffLineage";
import { runtimeHostClient, type RuntimeHostClient } from "@/lib/runtime/client";
import { spawnStructuredConversation } from "@/lib/runtime/structuredSpawn";
import { projectForCwd } from "@/lib/scanner/describe";
import { loadTasks } from "@/lib/tasks/store";
import type { BoardTask } from "@/lib/tasks/types";
import { claudeProjectRootFor, codexSessionRootFor } from "@/lib/scanner/roots";
import { isShellCommand } from "@/lib/status";
import { killTmuxHostIfMatches, paneInfo } from "@/lib/tmux";
import type { FileEntry } from "@/lib/types";
import { realExec, type ExecPort } from "@/lib/workflows/provision";

import { requestPipelineTick } from "./controllerSignal";
import { durableStageTurnEvidence, type StageTurnEvidence } from "./durableEvidence";
import { commitPipelineStage, currentPipelineBranchHead, currentPipelineRemoteBranchHead, pipelineWorktreeChanges, provisionPipelineWorktree, publishPipelineBranch, resetPipelineStage, resolvePipelineBase, synchronizePipelineRetryHead } from "./git";
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
import { PIPELINE_ROLE_IDS, pipelineRoleLookup, resolvePipelineRole, validatePipelineRoleParams, type PipelineRoleLookup } from "./roles";
import { pipelineValidationError, type PipelineValidationViolation } from "./validation";
import { buildPipeline, isEffectiveRole, loadPipelines, pipelineGraphError, pipelineIdentity, pipelineTaskLinkError, PipelineStoreError, withPipelineControllerMutation, withPipelineMutation } from "./store";
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
  PipelineTerminalReap,
  PipelineUnconfirmedHost,
} from "./types";
import { parseStageVerdict, stageVerdictRejectionReason, type ParsedStageVerdict } from "./verdict";

export type PipelineStageSpawn = {
  launchId: string;
  conversationId: string;
  sessionId: string | null;
  "transcript": string | null;
  paneId: string | null;
};

/** Identity of the agent host a stage attempt owns, as a close reports it. */
export type PipelineStageHostRef = {
  stageId: string;
  attempt: number;
  conversationId: string | null;
  agentPath: string | null;
  paneId: string | null;
  /** Set for a conversation a stage agent spawned and the pipeline adopted, so
      the report distinguishes it from the stage's own launch. */
  adopted?: true;
};

export type PipelineStageStopResult =
  /** Termination is evidenced: the kill was delivered, or the host is gone. */
  | { outcome: "stopped" }
  | { outcome: "not-running" }
  /** The kill was accepted (a `queued` receipt is the normal first answer) but
      termination was not evidenced inside the confirmation budget. The host may
      still be alive, so a close carrying one of these never claims a clean stop. */
  | { outcome: "unconfirmed"; operationId: string | null; detail: string }
  | { outcome: "failed"; error: string };

/**
 * What closing a pipeline did to its stage hosts, and what it left on disk
 * (#670). `stopped` is empty and `alreadyStopped` may be populated when nothing
 * was burning quota; a non-empty `stillRunning` means the close was refused.
 */
export type PipelineCloseReport = {
  /** Hosts this close terminated, with termination evidenced. */
  stopped: PipelineStageHostRef[];
  /** Launched stages — settled or parked included — whose host was already gone. */
  alreadyStopped: PipelineStageHostRef[];
  /** Kills the runtime accepted without confirming termination in time. The
      operation id keeps the possible survivor addressable. */
  unconfirmed: Array<PipelineStageHostRef & { operationId: string | null; detail: string }>;
  /** Review rounds whose live reviewer this close terminated through the flow.
      Headless reviewers are child processes with no registry entry, so they are
      counted here rather than in `stopped`. */
  reviewers: Array<{ stageId: string; attempt: number; flowId: string; round: number }>;
  /** Unconfirmed hosts the operator explicitly dismissed on this close. */
  acknowledged: Array<PipelineStageHostRef & { detail: string }>;
  /** Hosts that survived teardown, so the close cannot claim to be clean. */
  stillRunning: Array<PipelineStageHostRef & { error: string }>;
  /** Uncommitted stage work preserved in the worktree; null when unprovisioned. */
  worktree: { dir: string; uncommitted: string[]; truncated: boolean; error?: string } | null;
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
  /** Terminates the host that owns a stage attempt's agent. `not-running` means
      no host was resident, so a close can tell an idle lane from one it stopped. */
  stopStageAgent(target: PipelineStageHostRef): Promise<PipelineStageStopResult>;
  /** Identity-verified teardown of a stage attempt's tmux pane, for a
      pane-hosted agent the registry can no longer address. `unknown` means the
      pane could not be proven to be this stage's, so nothing was signalled. */
  stopStagePane(target: PipelineStageHostRef): Promise<
    | { outcome: "stopped" | "not-running" }
    | { outcome: "unknown"; detail: string }
    | { outcome: "failed"; error: string }
  >;
  /** Residency read with no side effects: `false` means the host is
      demonstrably gone. Used to retire an unconfirmed kill without re-killing. */
  stageHostResident(target: PipelineStageHostRef): Promise<boolean>;
  /** Monotonic milliseconds, kept apart from `now()` so a teardown budget can be
      bounded independently of the ISO timestamps written to the record. */
  monotonicNow(): number;
  /** Whether the pipeline worktree is still on disk. A checkout removed after a
      merge is a tidy close, not an unreadable worktree. */
  worktreePresent(dir: string): boolean;
  conversationAgentActive(conversationId: string): Promise<boolean | null>;
  /** Null means hosted, a timestamp means dead/absent since then, and undefined
      means the registry cannot provide authoritative host evidence. */
  conversationHostUnavailableSince?(conversationId: string): Promise<string | null | undefined>;
  sleep?(milliseconds: number): Promise<void>;
  durableTurnEvidence(engine: EffectivePipelineRole["engine"], transcriptPath: string): Promise<StageTurnEvidence | null>;
  headCwd(transcriptPath: string): string | null;
  lastMessage(entry: FileEntry): { text: string; ts: number } | null;
  pathForConversation(conversationId: string): string | null;
  sourcePathAllowed(pathname: string): boolean;
  conversationIdForPath(pathname: string): string | null;
  pipelineAdoptionCandidates(pipelineId: string): PipelineAdoptionCandidate[];
  createFlow(req: CreateFlowRequest, entries: FileEntry[]): Promise<{ flow?: Flow; error?: string }>;
  patchFlow(id: string, action: "advance" | "pause" | "resume", note?: string): { error?: string; status?: number };
  closeFlow(id: string): Promise<{
    flow?: Flow;
    error?: string;
    status?: number;
    stoppedReviewer?: { round: number } | null;
  } | void>;
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
    accountPin: true,
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

/** Confirmation window for an accepted kill. The whole close runs inside the
    pipelines file transaction, so this stays short enough that a slow host
    cannot stall every other pipeline mutation and the controller tick. */
const KILL_CONFIRMATION_BUDGET_MS = 1_500;
const KILL_CONFIRMATION_INTERVAL_MS = 250;
const KILL_CONFIRMATION_MAX_POLLS = 8;
/** Receipt states that terminally settle a kill operation: the delivery queue
    transitions a terminated host to `delivered` and a refused termination to
    `failed`; everything else (`queued`, `delivering`, …) is still in flight. */
const KILL_DELIVERED_STATES = new Set(["delivered"]);
const KILL_REFUSED_STATES = new Set(["failed", "rejected"]);

export type StageStopProbes = {
  client?: RuntimeHostClient | null;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  budgetMs?: number;
  intervalMs?: number;
};

/**
 * Terminates the agent host a stage attempt owns, through the same control path
 * an operator's kill uses — structured hosts go over the runtime command
 * channel, legacy panes down the tmux ladder. Nothing on disk is touched: the
 * worktree, including uncommitted stage work, is left exactly as the agent left
 * it. Residency is read from the durable registry first so a lane whose host is
 * already gone reports `not-running` instead of a manufactured kill.
 *
 * A structured kill answers `queued` before the host has gone anywhere, so an
 * accepted receipt is not termination. Within a bounded window this re-reads
 * host residency (the registry file signature invalidates the read cache, so a
 * teardown written by the host process is visible here) and the durable
 * operation receipt. Kills are idempotent, so re-checking is free of side
 * effects. Only evidence yields `stopped`; a terminally refused operation
 * yields `failed`; anything still in flight yields `unconfirmed` with its
 * operation id, and the close reports that instead of a clean stop.
 */
/** Resolved identity of a stage host plus a live residency read. Null when the
    registry has no trace of the conversation at all. */
type StageHostProbe = {
  conversationId: ViewerConversationId;
  transcriptPath: string;
  resident(): boolean;
  /** Durable tmux evidence recorded for this session, if any. It is the only
      thing that can identify a stored pane id as still being this agent's. */
  host(): TmuxHostEvidence | null;
};

async function stageHostProbe(target: PipelineStageHostRef): Promise<StageHostProbe | null> {
  const registry = agentRegistry();
  /* applyConversationAction resolves by id or by path; residency must too, or a
     prefixed id the registry cannot resolve short-circuits to not-running while
     the attempt's transcript would have found the live conversation. */
  const byId = target.conversationId?.startsWith("conversation_")
    ? registry.conversation(target.conversationId as ViewerConversationId)
    : null;
  const conversation = byId ?? (target.agentPath ? registry.conversationForPath(target.agentPath) : null);
  const generation = conversation?.generations.at(-1) ?? null;
  if (!conversation || !generation) return null;
  const sessionKey = sessionKeyId({ engine: conversation.engine, sessionId: generation.id });
  const { structuredHostProcessAlive } = await import("@/lib/runtime/structuredRecovery");
  return {
    conversationId: conversation.id,
    transcriptPath: generation.path,
    /* Re-read every call: the registry read cache invalidates on the file
       signature, so a teardown written by the host process is visible here. */
    resident: () => {
      const entry = registry.readOnlySnapshot().entries[sessionKey];
      if (!entry || entry.status === "dead" || entry.status === "unhosted") return false;
      return structuredHostProcessAlive(entry.structuredHost?.process ?? null) || Boolean(entry.host);
    },
    host: () => registry.readOnlySnapshot().entries[sessionKey]?.host ?? null,
  };
}

export type StagePaneProbes = {
  killHostIfMatches?: (host: TmuxHostEvidence) => Promise<boolean>;
  /** What the pane shows right now. Null when tmux has no such pane. */
  paneSnapshot?: (paneId: string) => Promise<{ windowName: string; command: string } | null>;
};

/**
 * Last resort for a pane-hosted stage agent, gated on identity rather than
 * liveness. A tmux pane id is unique only within one server lifetime and
 * restarts at %0, while the attempt's stored id outlives that — and this path
 * runs exactly when the registry has no resident host, which is when a stale id
 * is most likely. "This pane runs something that is not a shell" would therefore
 * happily kill an unrelated agent, so the kill goes through
 * killTmuxHostIfMatches, which verifies the tmux server, the pane pid, the
 * window name and the agent's process start identity before signalling. Without
 * durable evidence to match, nothing is killed: the host is reported unknown so
 * the operator decides. A refused close is a nuisance; killing someone else's
 * agent is not recoverable.
 */
export async function stopPipelineStagePane(
  target: PipelineStageHostRef,
  probes: StagePaneProbes = {},
): Promise<{ outcome: "stopped" | "not-running" } | { outcome: "unknown"; detail: string } | { outcome: "failed"; error: string }> {
  const paneId = target.paneId;
  if (!paneId) return { outcome: "not-running" };
  const snapshot = probes.paneSnapshot ?? paneInfo;
  /* Name what the pane actually shows. An operator handed "pane %3 now runs
     codex in window review" can find it in tmux and decide; "it could not be
     identified" alone leaves them nothing to act on. */
  const describe = (info: { windowName: string; command: string } | null): string =>
    info ? `pane ${paneId} now runs ${info.command} in window ${info.windowName}` : `pane ${paneId}`;
  try {
    const probe = await stageHostProbe(target);
    const host = probe?.host() ?? null;
    if (!host || host.paneId !== paneId) {
      /* No durable evidence ties this id to this agent. Report what is there,
         but never signal it. */
      const info = await snapshot(paneId);
      if (!info || isShellCommand(info.command)) return { outcome: "not-running" };
      return {
        outcome: "unknown",
        detail: `${describe(info)} and cannot be identified as this stage's agent; stop it yourself if it is the orphan, or close again with acknowledgeHosts to dismiss it`,
      };
    }
    const killed = await (probes.killHostIfMatches ?? killTmuxHostIfMatches)(host);
    if (killed) return { outcome: "stopped" };
    const info = await snapshot(paneId);
    if (!info || isShellCommand(info.command)) return { outcome: "not-running" };
    return {
      outcome: "unknown",
      detail: `${describe(info)}; it changed or its agent did not exit, so it was left running`,
    };
  } catch (error) {
    return { outcome: "failed", error: error instanceof Error ? error.message : String(error) };
  }
}

export async function stopPipelineStageAgent(
  target: PipelineStageHostRef,
  probes: StageStopProbes = {},
): Promise<PipelineStageStopResult> {
  try {
    const probe = await stageHostProbe(target);
    if (!probe || !probe.resident()) return { outcome: "not-running" };
    const { conversationId, transcriptPath, resident } = probe;

    const { applyConversationAction } = await import("@/lib/conversation/actions");
    const result = await applyConversationAction({ conversationId, transcriptPath, action: "kill" });
    const body = result.body as { ok?: boolean; error?: string; operationId?: string; receipt?: { status?: string } };
    if (result.status >= 400 || body.ok !== true) {
      return { outcome: "failed", error: body.error ?? `stage host kill was refused with status ${result.status}` };
    }
    /* No receipt means the control settled synchronously — the legacy pane
       ladder, or a replayed terminal kill on an already-dead host. */
    const receiptStatus = body.receipt?.status ?? null;
    if (!receiptStatus || KILL_DELIVERED_STATES.has(receiptStatus)) return { outcome: "stopped" };

    const operationId = body.operationId ?? null;
    const client = probes.client === undefined ? runtimeHostClient() : probes.client;
    const now = probes.now ?? Date.now;
    const sleep = probes.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const deadline = now() + (probes.budgetMs ?? KILL_CONFIRMATION_BUDGET_MS);
    const interval = probes.intervalMs ?? KILL_CONFIRMATION_INTERVAL_MS;
    for (let poll = 0; poll < KILL_CONFIRMATION_MAX_POLLS; poll += 1) {
      if (!resident()) return { outcome: "stopped" };
      if (operationId && client) {
        const durable = await client.operationStatus(operationId).catch(() => null);
        const status = durable?.receipt.status ?? null;
        if (status && KILL_DELIVERED_STATES.has(status)) return { outcome: "stopped" };
        if (status && KILL_REFUSED_STATES.has(status)) {
          return {
            outcome: "failed",
            error: durable?.receipt.reason ?? `stage host kill ${status} (operation ${operationId})`,
          };
        }
      }
      if (now() >= deadline) break;
      await sleep(interval);
    }
    if (!resident()) return { outcome: "stopped" };
    return {
      outcome: "unconfirmed",
      operationId,
      detail: `kill accepted as ${receiptStatus} but termination was not confirmed`,
    };
  } catch (error) {
    return { outcome: "failed", error: error instanceof Error ? error.message : String(error) };
  }
}

export function defaultPipelinePorts(): PipelinePorts {
  let runtimeSnapshot: ReturnType<NonNullable<ReturnType<typeof runtimeHostClient>>["snapshot"]> | null = null;
  const registry = agentRegistry();
  let registrySnapshot: ReturnType<typeof registry.readOnlySnapshot> | null = null;
  let adoptionCandidatesByPipeline: Map<string, PipelineAdoptionCandidate[]> | null = null;
  let flowSnapshot: Flow[] | null = null;
  const snapshot = () => registrySnapshot ??= registry.readOnlySnapshot();
  const flows = () => flowSnapshot ??= loadFlows();
  const invalidateRegistryProjection = () => {
    registrySnapshot = null;
    adoptionCandidatesByPipeline = null;
  };
  const adoptionCandidates = () => {
    if (adoptionCandidatesByPipeline) return adoptionCandidatesByPipeline;
    const current = snapshot();
    const receiptsByConversation = new Map(
      Object.values(current.receipts).map((receipt) => [receipt.conversationId, receipt] as const),
    );
    const grouped = new Map<string, PipelineAdoptionCandidate[]>();
    for (const [conversationId, memberships] of Object.entries(current.memberships)) {
      for (const membership of memberships) {
        if (membership.kind !== "pipeline" || !membership.containerId
          || !membership.slot.startsWith("adopt:") || !membership.stageId || !membership.parentConversationId) continue;
        const receipt = receiptsByConversation.get(conversationId as ViewerConversationId) ?? null;
        const conversation = current.conversations[conversationId as ViewerConversationId] ?? null;
        const generation = conversation?.generations.at(-1) ?? null;
        const agentPath = receipt?.artifactPath ?? generation?.path ?? null;
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
        const candidates = grouped.get(membership.containerId) ?? [];
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
        grouped.set(membership.containerId, candidates);
      }
    }
    adoptionCandidatesByPipeline = grouped;
    return grouped;
  };
  return {
    exec: realExec,
    preflightRepo: preflightPipelineRepo,
    roleLookup: pipelineRoleLookup,
    spawnAgent: async (input, onReserved) => {
      const result = await spawnPipelineAgent(input, onReserved);
      invalidateRegistryProjection();
      return result;
    },
    spawnReceipt: (launchId) => {
      const receipt = snapshot().receipts[launchId];
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
    claimSpawnRetry: (launchId, claimId) => {
      const result = registry.claimFailedSpawnForRetry(launchId, claimId).kind;
      invalidateRegistryProjection();
      return result;
    },
    paneAgentAlive: async (paneId) => {
      const info = await paneInfo(paneId);
      return info !== null && !isShellCommand(info.command);
    },
    stopStageAgent: (target) => stopPipelineStageAgent(target),
    stopStagePane: (target) => stopPipelineStagePane(target),
    stageHostResident: async (target) => {
      try {
        const probe = await stageHostProbe(target);
        return probe ? probe.resident() : false;
      } catch {
        /* An unreadable probe is not evidence of death; keep the record. */
        return true;
      }
    },
    monotonicNow: () => Date.now(),
    worktreePresent: (dir) => Boolean(dir) && fs.existsSync(dir),
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
    conversationHostUnavailableSince: async (conversationId) => {
      if (!conversationId.startsWith("conversation_")) return undefined;
      const current = snapshot();
      const conversation = current.conversations[conversationId as ViewerConversationId];
      const generation = conversation?.generations.at(-1);
      if (!conversation || !generation) return undefined;
      const key = sessionKeyFromTranscript(conversation.engine, generation.path);
      if (!key) return undefined;
      const entry = current.entries[sessionKeyId(key)];
      if (!entry) return generation.createdAt;
      return entry.status === "dead" || entry.status === "unhosted" ? entry.updatedAt : null;
    },
    sleep: (milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
    durableTurnEvidence: durableStageTurnEvidence,
    headCwd: (transcriptPath) => headCwd(transcriptPath),
    lastMessage: lastAssistantMessage,
    pathForConversation: (conversationId) => conversationId.startsWith("conversation_")
      ? snapshot().conversations[conversationId as ViewerConversationId]?.generations.at(-1)?.path ?? null
      : null,
    sourcePathAllowed: transcriptAllowed,
    conversationIdForPath: (pathname) => {
      for (const conversation of Object.values(snapshot().conversations)) {
        if (conversation.generations.some((generation) => generation.path === pathname)) return conversation.id;
      }
      return null;
    },
    pipelineAdoptionCandidates: (pipelineId) => adoptionCandidates().get(pipelineId) ?? [],
    createFlow: async (request, entries) => {
      const result = await createFlowFromRequest(request, entries);
      flowSnapshot = null;
      return result;
    },
    patchFlow: (id, action, note) => {
      const result = patchFlow(id, { action, ...(note ? { note } : {}) });
      flowSnapshot = null;
      return result;
    },
    closeFlow: async (id) => {
      const result = await closeFlow(id);
      flowSnapshot = null;
      return result;
    },
    getFlow: (id) => flows().find((flow) => flow.id === id) ?? null,
    findFlow: (implementerPath, implementerConversationId, baseRef, targetSha) => flows()
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
const MISSING_STAGE_VERDICT = "stage completed without a valid final JSON verdict";
const HISTORICAL_MISSING_STAGE_VERDICT = "historical attempt completed without a valid final JSON verdict";
const VERDICT_RECOVERY_MAX_CHECKS = 3;
const VERDICT_RECOVERY_INTERVAL_MS = 30_000;
const SPAWN_HANDSHAKE_MAX_ATTEMPTS = 3;
const SPAWN_HANDSHAKE_RETRY_DELAY_MS = 1_000;
const DEAD_RUNNING_ATTEMPT_GRACE_MS = 3 * 60_000;
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

function recoveryCheckAt(now: string): string {
  return new Date(unixMs(now) + VERDICT_RECOVERY_INTERVAL_MS).toISOString();
}

function markVerdictRecoverySucceeded(attempt: PipelineStageAttempt, now: string, messageTs: number): void {
  const recovery = attempt.verdictRecovery;
  if (!recovery || recovery.state === "recovered") return;
  attempt.verdictRecovery = {
    ...recovery,
    state: "recovered",
    lastCheckedAt: now,
    nextCheckAt: null,
    messageTs,
  };
}

function recordVerdictRecoveryMiss(
  pipeline: Pipeline,
  attempt: PipelineStageAttempt,
  ports: PipelinePorts,
  reason: string,
  messageTs: number | null,
): void {
  const now = ports.now();
  const recovery = attempt.verdictRecovery?.state === "pending"
    ? attempt.verdictRecovery
    : null;
  const newerMessage = messageTs !== null
    && recovery?.messageTs !== null
    && recovery?.messageTs !== undefined
    && messageTs > recovery.messageTs;
  if (recovery && !newerMessage && unixMs(now) < unixMs(recovery.nextCheckAt)) return;

  const checks = (recovery?.checks ?? 0) + 1;
  const next = {
    state: checks >= VERDICT_RECOVERY_MAX_CHECKS ? "exhausted" as const : "pending" as const,
    checks,
    maxChecks: VERDICT_RECOVERY_MAX_CHECKS,
    startedAt: recovery?.startedAt ?? now,
    lastCheckedAt: now,
    nextCheckAt: checks >= VERDICT_RECOVERY_MAX_CHECKS ? null : recoveryCheckAt(now),
    reason,
    messageTs,
  };
  attempt.verdictRecovery = next;
  if (next.state === "exhausted") {
    attempt.completedAt = now;
    park(
      pipeline,
      `stage verdict recovery exhausted after ${VERDICT_RECOVERY_MAX_CHECKS} checks: ${reason}`,
      attempt,
    );
    return;
  }
  attempt.state = "running";
  attempt.error = null;
  pipeline.state = "running";
  pipeline.stateDetail = `re-evaluating terminal stage verdict (${checks}/${VERDICT_RECOVERY_MAX_CHECKS}): ${reason}`;
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
        attempt.error = HISTORICAL_MISSING_STAGE_VERDICT;
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
    sourceRevision: flow.revision ?? 0,
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
    const synchronizedRevision = synchronized.sourceRevision ?? 0;
    if (synchronizedRevision > 0 && snapshot.sourceRevision <= synchronizedRevision) return false;
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

function keepPassedStageUnpublished(
  pipeline: Pipeline,
  attempt: PipelineStageAttempt,
  detail: string,
): void {
  const message = `passed but unpublished: ${detail}`;
  attempt.error = message;
  pipeline.state = "running";
  pipeline.stateDetail = message;
}

/** A terminal pass cannot close until its accepted revision is remotely
    durable. The pass receipt stays terminal and the committing cursor becomes
    a publication retry seam, so later ticks never rerun or reset stage work. */
function retryTerminalStagePublication(
  pipeline: Pipeline,
  stage: PipelineStage,
  attempt: PipelineStageAttempt,
  ports: PipelinePorts,
): void {
  const published = publishPipelineBranch(pipeline, ports.exec, {
    acceptedSha: pipeline.lastPassedCommit,
    publishedSha: pipeline.publishedCommit ?? null,
  });
  if (!published.ok) {
    park(pipeline, `publishing the passed stage: ${published.error}`, attempt);
    return;
  }
  if (published.remote === "unreachable") {
    keepPassedStageUnpublished(pipeline, attempt, published.detail);
    return;
  }
  pipeline.publishedCommit = published.remote === "published" ? published.sha : null;
  attempt.error = null;
  advancePipeline(pipeline, stage, ports, attempt);
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

function routeFailedAttempt(
  pipeline: Pipeline,
  stage: PipelineStage,
  attempt: PipelineStageAttempt,
  input: string | null,
  detail: string,
): boolean {
  if (!stage.onFail) return false;
  const targetStage = pipeline.stages.find((candidate) => candidate.id === stage.onFail!.to);
  const used = failEdgeRoundsUsed(pipeline, stage);
  if (targetStage && used < stage.onFail.maxRounds) {
    pipeline.cursor = {
      stageId: targetStage.id,
      state: "pending",
      input,
      activatedBy: { stageId: stage.id, attempt: attempt.n, edge: "fail" },
    };
    pipeline.state = "running";
    pipeline.stateDetail = null;
    pipeline.pausedState = null;
    return true;
  }
  if (targetStage) {
    park(pipeline, `fail-edge budget exhausted after ${used} round(s): ${detail}`, attempt);
    return true;
  }
  return false;
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
  /* Publish before the next stage can gate on the publication (#729). A review
     stage fences every round on `origin/<branch>` through captureReviewHead, so
     a builder that produced a usable head strands the whole handoff unless the
     orchestrator itself pushes it — waiting for a stage to have run `git push`
     is what left pipeline 2ae14391 parked for over seven hours. Publication
     failure is its own recoverable class: the commit is already durable in
     `lastPassedCommit`, so nothing is lost while the operator resolves it. */
  const published = publishPipelineBranch(pipeline, ports.exec, {
    acceptedSha: result.sha,
    publishedSha: pipeline.publishedCommit ?? null,
  });
  if (!published.ok) {
    park(pipeline, `publishing the passed stage: ${published.error}`, attempt);
    return;
  }
  pipeline.publishedCommit = published.remote === "published" ? published.sha : null;
  attempt.state = "passed";
  attempt.completedAt = ports.now();
  if (published.remote === "unreachable" && stage.next === null) {
    keepPassedStageUnpublished(pipeline, attempt, published.detail);
    return;
  }
  advancePipeline(pipeline, stage, ports, attempt);
  if (published.remote === "unreachable") {
    keepPassedStageUnpublished(pipeline, attempt, published.detail);
  }
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
    if (
      parsed.verdict.status === "fail"
      && routeFailedAttempt(
        pipeline,
        stage,
        attempt,
        failEdgeInput(parsed),
        parsed.verdict.findings?.[0] ?? "stage verdict: fail",
      )
    ) {
      return;
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

  if (attempt.state === "passed" && pipeline.cursor?.state === "committing") {
    retryTerminalStagePublication(pipeline, stage, attempt, ports);
    return;
  }

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
      const spawnInput: Parameters<PipelinePorts["spawnAgent"]>[0] = {
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
      };
      let spawned: PipelineStageSpawn | null = null;
      for (let spawnAttempt = 1; spawnAttempt <= SPAWN_HANDSHAKE_MAX_ATTEMPTS; spawnAttempt += 1) {
        try {
          spawned = await ports.spawnAgent({
            ...spawnInput,
            clientAttemptId: spawnAttempt === 1
              ? spawnInput.clientAttemptId
              : `handshake_retry_${spawnAttempt - 1}_${spawnInput.clientAttemptId}`.slice(0, 128),
          }, (reservation) => {
            attempt.launchId = reservation.launchId;
            attempt.conversationId = reservation.conversationId;
            persist();
          });
          break;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const transient = isTransientStructuredSpawnFailure(message);
          if (!transient || spawnAttempt === SPAWN_HANDSHAKE_MAX_ATTEMPTS) {
            if (transient) {
              throw new Error(`stage spawn failed after ${spawnAttempt - 1} retries: ${message}`);
            }
            throw error;
          }
          const sleep = ports.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
          await sleep(SPAWN_HANDSHAKE_RETRY_DELAY_MS);
        }
      }
      if (!spawned) throw new Error("stage spawn failed without a result");
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
  const unavailableSince = !attempt.paneId && attempt.conversationId
    ? await ports.conversationHostUnavailableSince?.(attempt.conversationId)
    : null;
  const unavailableAt = unavailableSince ? unixMs(unavailableSince) : 0;
  const hostUnavailablePastGrace = unavailableAt > 0
    && unixMs(ports.now()) - unavailableAt >= DEAD_RUNNING_ATTEMPT_GRACE_MS;
  if (entry && structuredActive !== false && scanProjectsOpenTurn && !hostUnavailablePastGrace) return;

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
      markVerdictRecoverySucceeded(attempt, ports.now(), durable.message!.ts);
      settleStageVerdict(pipeline, stage, attempt, parsed, ports, persist);
      return;
    }
    recordVerdictRecoveryMiss(
      pipeline,
      attempt,
      ports,
      stageVerdictRejectionReason(durable.message!.text),
      durable.message!.ts,
    );
    return;
  }
  if (hostUnavailablePastGrace) {
    attempt.state = "failed";
    attempt.completedAt = ports.now();
    attempt.error = HISTORICAL_MISSING_STAGE_VERDICT;
    if (routeFailedAttempt(pipeline, stage, attempt, HISTORICAL_MISSING_STAGE_VERDICT, HISTORICAL_MISSING_STAGE_VERDICT)) return;
    park(pipeline, HISTORICAL_MISSING_STAGE_VERDICT, attempt);
    return;
  }
  if (!entry) {
    /* A readable durable artifact means the disappearance is a projection loss,
       not an ended stage — wait for the scan or the terminal turn evidence. */
    if (durable) return;
    if (structuredActive === false) {
      recordVerdictRecoveryMiss(
        pipeline,
        attempt,
        ports,
        "canonical stage transcript is not yet readable after structured stage termination",
        null,
      );
    } else if (attempt.paneId && !(await ports.paneAgentAlive(attempt.paneId))) {
      recordVerdictRecoveryMiss(
        pipeline,
        attempt,
        ports,
        "canonical stage transcript is not yet readable after agent termination",
        null,
      );
    }
    return;
  }
  if (structuredActive === true) return;
  /* A recovered idle host over a mid-turn transcript must not terminalize the
     attempt; completion needs turn evidence, not just a trailing message — even
     one that parses as a valid fenced verdict. */
  if (durable?.turn === "busy" && !attempt.paneId) return;
  const message = ports.lastMessage(entry);
  if (!message || message.ts <= unixMs(attempt.startedAt)) {
    if (structuredActive === false) {
      recordVerdictRecoveryMiss(
        pipeline,
        attempt,
        ports,
        "canonical completed assistant turn has not been ingested after structured stage termination",
        message?.ts ?? null,
      );
    } else if (attempt.paneId && !(await ports.paneAgentAlive(attempt.paneId))) {
      recordVerdictRecoveryMiss(
        pipeline,
        attempt,
        ports,
        "canonical completed assistant turn has not been ingested after agent termination",
        message?.ts ?? null,
      );
    }
    return;
  }
  const parsed = parseStageVerdict(message.text);
  if (!parsed) {
    recordVerdictRecoveryMiss(
      pipeline,
      attempt,
      ports,
      stageVerdictRejectionReason(message.text),
      message.ts,
    );
    return;
  }
  markVerdictRecoverySucceeded(attempt, ports.now(), message.ts);
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

/**
 * Exact-head publication as a precondition of review ingress.
 *
 * Publishing on the pass path alone is not enough: a migrated record with no
 * `publishedCommit`, an operator `skip-stage`, and a fail edge whose target is a
 * review-loop stage all reach this point without ever having published, and the
 * flow would then fence on an `origin/<branch>` that does not exist. Every route
 * into a review flow goes through here, so the guarantee holds regardless of how
 * the cursor arrived.
 *
 * The local head must already BE the accepted review head. When it is not — a
 * failed stage that committed on its own, a worktree someone advanced by hand —
 * this parks WITHOUT pushing, so a revision the pipeline never accepted is never
 * published. A dirty worktree fails the same way and its work is left untouched.
 *
 * The cached `publishedCommit` is deliberately not trusted here: ingress passes
 * null so the remote is genuinely probed, which is what makes a stale or
 * migrated record safe. Publication itself stays fast-forward-only.
 */
function publishReviewIngressHead(
  pipeline: Pipeline,
  attempt: PipelineStageAttempt,
  ports: PipelinePorts,
): { ok: true } | { ok: false; retryable: boolean; detail: string } {
  const expected = attempt.expectedReviewHeadSha;
  if (!expected) return { ok: false, retryable: false, detail: "review-loop stage requires a verified pipeline commit" };

  const local = currentPipelineBranchHead(pipeline, ports.exec);
  if (!local.ok) {
    return { ok: false, retryable: false, detail: `review stage could not verify the pipeline head before publishing: ${local.error}` };
  }
  if (local.sha !== expected) {
    return {
      ok: false,
      retryable: false,
      detail: `review stage head mismatch: the accepted review head is ${expected}, but the pipeline worktree is at ${local.sha}; nothing was published`,
    };
  }

  /* `publishedSha` is deliberately omitted: ingress probes the remote for real
     rather than trusting a durable record that may be stale or migrated. */
  const published = publishPipelineBranch(pipeline, ports.exec, { acceptedSha: expected });
  if (!published.ok) {
    return { ok: false, retryable: false, detail: `review stage could not publish the accepted head ${expected}: ${published.error}` };
  }
  if (published.remote === "unreachable") {
    return { ok: false, retryable: true, detail: `passed but unpublished: ${published.detail}` };
  }
  if (published.remote === "unavailable") {
    return {
      ok: false,
      retryable: false,
      detail: `review stage requires a published pipeline branch, but this repository has no origin remote to publish ${expected} to`,
    };
  }
  pipeline.publishedCommit = published.sha;
  return { ok: true };
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
  if (attempt.state === "passed" && pipeline.cursor?.state === "committing") {
    retryTerminalStagePublication(pipeline, stage, attempt, ports);
    return;
  }
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
    const ingress = publishReviewIngressHead(pipeline, attempt, ports);
    if (!ingress.ok) {
      if (ingress.retryable) {
        attempt.error = ingress.detail;
        pipeline.state = "running";
        pipeline.stateDetail = ingress.detail;
        return;
      }
      park(pipeline, ingress.detail, attempt);
      return;
    }
    attempt.error = null;
    pipeline.stateDetail = null;
    persist();
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
    const phase = flow.pausedState && flow.pausedState !== "paused" ? flow.pausedState : "unknown phase";
    park(pipeline, `review flow paused in ${phase}: ${flow.stateDetail ?? "operator decision required"}`, attempt);
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
  "paused",
  "needs_decision",
  "done_comment",
  "closed",
]);
const RECONCILABLE_BOUND_FLOW_ERRORS = [
  "review flow startup paused:",
  "review flow paused in ",
  /* Compatibility with pipeline attempts parked before the phase-specific
     wording shipped. */
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
  let flow = attempt?.flowId ? ports.getFlow(attempt.flowId) : null;
  if (
    !attemptError
    || !RECONCILABLE_BOUND_FLOW_ERRORS.some((prefix) => attemptError.startsWith(prefix))
    || !flow
    || !RECONCILABLE_REVIEW_FLOW_STATES.has(flow.state)
  ) return false;
  if (flow.state === "paused") {
    if (!isRecoverableLegacyRelayFailurePause(flow)) return false;
    const resumed = ports.patchFlow(flow.id, "resume");
    if (resumed.error) return false;
    flow = ports.getFlow(flow.id);
    if (!flow || flow.state !== "relaying") return false;
  }
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

async function reconcileExhaustedVerdictRecovery(
  pipeline: Pipeline,
  ports: PipelinePorts,
  persist: () => void,
): Promise<boolean> {
  if (pipeline.state !== "needs_decision") return false;
  const stage = currentStage(pipeline);
  if (!stage || stage.kind !== "run") return false;
  const attempt = currentAttempt(pipeline, stage.id);
  const recovery = attempt?.verdictRecovery;
  if (!attempt?.agentPath || recovery?.state !== "exhausted") return false;

  const durable = await ports.durableTurnEvidence(attempt.effectiveRole.engine, attempt.agentPath);
  const message = durable?.turn === "terminal" ? durable.message : null;
  if (
    !message
    || message.ts <= unixMs(attempt.startedAt)
    || message.ts <= (recovery.messageTs ?? 0)
  ) return false;
  const parsed = parseStageVerdict(message.text);
  if (!parsed || "failureReason" in parsed) return false;

  attempt.state = "running";
  attempt.completedAt = null;
  attempt.error = null;
  pipeline.state = "running";
  pipeline.stateDetail = null;
  markVerdictRecoverySucceeded(attempt, ports.now(), message.ts);
  settleStageVerdict(pipeline, stage, attempt, parsed, ports, persist);
  return true;
}

function reconcileParkedVerdictMiss(pipeline: Pipeline, ports: PipelinePorts): boolean {
  if (pipeline.state !== "needs_decision") return false;
  const stage = currentStage(pipeline);
  if (!stage || stage.kind !== "run") return false;
  const attempt = currentAttempt(pipeline, stage.id);
  if (
    !attempt
    || attempt.state !== "needs_decision"
    || attempt.completedAt !== null
    || attempt.output !== null
    || attempt.verdict !== null
    || attempt.error !== MISSING_STAGE_VERDICT
  ) return false;
  const now = ports.now();
  attempt.verdictRecovery = {
    state: "pending",
    checks: 0,
    maxChecks: VERDICT_RECOVERY_MAX_CHECKS,
    startedAt: now,
    lastCheckedAt: now,
    nextCheckAt: now,
    reason: MISSING_STAGE_VERDICT,
    messageTs: null,
  };
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
    || isTransientStructuredSpawnFailure(failure);
}

function isTransientStructuredSpawnFailure(failure: string): boolean {
  return failure.includes("structured delivery controller is unavailable")
    || failure.includes("structured initial message")
    || failure.includes("runtime host request timed out");
}

/**
 * Retires the unconfirmed-host records a close left behind, once each host is
 * demonstrably gone (#670). Without this a lane that has actually finished would
 * sit on the board forever claiming a survivor it no longer has. The probe has
 * no side effects — nothing is re-killed here; a host that is still resident
 * keeps its record and the lane stays visible.
 */
async function reconcileUnconfirmedHosts(pipeline: Pipeline, ports: PipelinePorts): Promise<boolean> {
  const outstanding = pipeline.unconfirmedHosts;
  if (!outstanding?.length) return false;
  const remaining: PipelineUnconfirmedHost[] = [];
  for (const host of outstanding) {
    const target: PipelineStageHostRef = {
      stageId: host.stageId,
      attempt: host.attempt,
      conversationId: host.conversationId,
      agentPath: host.agentPath,
      paneId: host.paneId ?? null,
    };
    const resident = await ports.stageHostResident(target);
    const paneAlive = !resident && target.paneId ? await ports.paneAgentAlive(target.paneId) : false;
    if (resident || paneAlive) remaining.push(host);
  }
  if (remaining.length === outstanding.length) return false;
  pipeline.unconfirmedHosts = remaining.length > 0 ? remaining : undefined;
  /* The last survivor retired: the lane has nothing left to surface, so the
     closed record hides like any other. */
  if (!pipeline.unconfirmedHosts && pipeline.state === "closed") {
    pipeline.hiddenAt = pipeline.closedAt ?? ports.now();
  }
  return true;
}

/** Ceiling on one terminal reap sweep. Like a close's teardown, the sweep runs
    inside the pipelines transaction, so a slow host defers the rest of its
    pipeline's candidates to the next tick instead of stalling every mutation. */
const TERMINAL_REAP_BUDGET_MS = 5_000;
/** Sweeps one pipeline's terminal reap may spend before surfacing survivors. */
const TERMINAL_REAP_MAX_ROUNDS = 5;

/**
 * Reaps a completed pipeline's finished stage hosts (#574).
 *
 * advancePipeline marks the pipeline completed the moment its last stage
 * passes, but nothing stopped the hosts its stages left behind: every finished
 * builder kept an idle resume process resident on a paid quota, and a machine
 * running many pipelines accumulated hundreds of them. A close tears hosts
 * down (#670); completion now does the same, through the identical
 * identity-verified control path, with `closed` staying the close action's job
 * so an operator's acknowledge decision is never overridden by a later sweep.
 *
 * Only hosts whose attempt finished its turn (a verdict or a completion stamp)
 * are candidates, and the runtime gets the last word: a conversation it
 * reports actively running is preserved, as are the pipeline's creator
 * conversation and transcript. The sweep is bounded twice — a per-sweep budget
 * so the transaction cannot stall behind slow kills, and a durable round
 * ceiling so a host that will not die becomes a visible unconfirmed host
 * (retired by reconcileUnconfirmedHosts once it is demonstrably gone) instead
 * of receiving a kill on every tick forever.
 */
async function reconcileTerminalStageHosts(pipeline: Pipeline, ports: PipelinePorts): Promise<boolean> {
  if (pipeline.state !== "completed" || pipeline.terminalReap?.settledAt) return false;
  const reap: PipelineTerminalReap = pipeline.terminalReap
    ?? { rounds: 0, stopped: 0, lastAt: ports.now(), settledAt: null };
  const deadline = ports.monotonicNow() + TERMINAL_REAP_BUDGET_MS;
  const candidates = launchedStageHosts(pipeline).filter(({ target, turnSettled }) => turnSettled
    && !(target.conversationId && target.conversationId === pipeline.srcConversationId)
    && !(target.agentPath && target.agentPath === pipeline.srcPath));
  const survivors: Array<PipelineStageHostRef & { operationId: string | null; detail: string }> = [];
  let attempted = false;
  let deferred = false;
  for (const [index, { target }] of candidates.entries()) {
    if (ports.monotonicNow() >= deadline) {
      deferred = true;
      /* Normally the next sweep picks these up; recorded here so that a reap
         whose every round expires still names what it never probed once the
         round ceiling settles it below. */
      if (reap.rounds + 1 >= TERMINAL_REAP_MAX_ROUNDS) {
        survivors.push(...candidates.slice(index).map(({ target: remaining }) => ({
          ...remaining,
          operationId: null,
          detail: "terminal reap budget expired before this host was probed",
        })));
      }
      break;
    }
    if (!(await ports.stageHostResident(target))) continue;
    /* The attempt's own evidence says its turn ended, but a host the runtime
       still reports mid-turn (an adopted helper on a fresh turn) is live work,
       so it stays; the idle-TTL reaper owns it from here. */
    if (target.conversationId && await ports.conversationAgentActive(target.conversationId) === true) continue;
    attempted = true;
    const result = await ports.stopStageAgent(target);
    if (result.outcome === "stopped") reap.stopped += 1;
    else if (result.outcome === "unconfirmed") survivors.push({ ...target, operationId: result.operationId, detail: result.detail });
    else if (result.outcome === "failed") survivors.push({ ...target, operationId: null, detail: result.error });
  }
  reap.lastAt = ports.now();
  if (attempted || deferred) reap.rounds += 1;
  const clean = !deferred && survivors.length === 0;
  if (clean || reap.rounds >= TERMINAL_REAP_MAX_ROUNDS) {
    reap.settledAt = reap.lastAt;
    if (survivors.length > 0) {
      const known = new Set((pipeline.unconfirmedHosts ?? []).map((host) => `${host.stageId}:${host.attempt}`));
      pipeline.unconfirmedHosts = [
        ...(pipeline.unconfirmedHosts ?? []),
        ...survivors.filter((host) => !known.has(`${host.stageId}:${host.attempt}`)).map((host) => ({
          stageId: host.stageId,
          attempt: host.attempt,
          conversationId: host.conversationId,
          agentPath: host.agentPath,
          paneId: host.paneId,
          operationId: host.operationId,
          detail: host.detail,
          at: reap.settledAt!,
        })),
      ];
    }
  }
  pipeline.terminalReap = reap;
  return true;
}

export async function tickPipelines(entries: FileEntry[], ports: PipelinePorts = defaultPipelinePorts()): Promise<{ pipelines: Pipeline[]; changed: boolean }> {
  if (tickStore.__llvPipelineTick) return { pipelines: [], changed: false };
  tickStore.__llvPipelineTick = true;
  let followUp = false;
  try {
    const result = await withPipelineControllerMutation(async (pipelines, persist) => {
      let changed = false;
      await forEachCooperatively(pipelines, async (pipeline) => {
        const persistPipeline = () => persist([pipeline]);
        let pipelineChanged = reconcilePipelineEmbeddedFlows(pipeline, ports);
        pipelineChanged = reconcilePendingPipelineAdoptions(pipeline, ports) || pipelineChanged;
        pipelineChanged = await reconcileHistoricalAttempts(pipeline, entries, ports) || pipelineChanged;
        pipelineChanged = rebindPipelineAttemptPaths(pipeline, ports) || pipelineChanged;
        pipelineChanged = await reconcileExhaustedVerdictRecovery(pipeline, ports, persistPipeline) || pipelineChanged;
        pipelineChanged = reconcileParkedVerdictMiss(pipeline, ports) || pipelineChanged;
        pipelineChanged = reconcileParkedStructuredSpawn(pipeline, ports) || pipelineChanged;
        pipelineChanged = reconcileBoundReviewFlow(pipeline, ports) || pipelineChanged;
        pipelineChanged = await reconcileUnconfirmedHosts(pipeline, ports) || pipelineChanged;
        pipelineChanged = await reconcileTerminalStageHosts(pipeline, ports) || pipelineChanged;
        if (!TERMINAL_STATES.has(pipeline.state) && pipeline.state !== "paused" && pipeline.state !== "needs_decision") {
          pipelineChanged = await tickPipeline(pipeline, entries, ports, persistPipeline) || pipelineChanged;
        }
        if (pipelineChanged) {
          changed = true;
          persistPipeline();
        }
      }, { batchSize: 4, timeBudgetMs: 16 });
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

/* #1026: the expected shape each stage constraint names, shared by the batched
   error response and the MCP tool schema's field descriptions so a caller reads
   the same contract whether it asks the schema or trips the validator. */
const STAGE_OBJECT_SHAPE = "{id, kind, prompt, next, onFail?, role?, engine?/model?/effort?/access? overrides}";
const STAGE_PROMPT_SHAPE = `non-empty string up to ${MAX_STAGE_PROMPT_LENGTH} characters`;
const STAGE_ROLE_SHAPE = `{roleId: one of ${PIPELINE_ROLE_IDS.join(" | ")}, params?: {<key>: string | number}} — runtime overrides belong on the stage, not in role`;
const STAGE_ROLE_ID_SHAPE = `one of ${PIPELINE_ROLE_IDS.join(" | ")}`;
const STAGE_ROLE_PARAMS_SHAPE = "object of the role's declared parameters, values string or number";
const STAGE_RUNTIME_SHAPE = "a role and stage-level engine/model/effort/access the role registry can resolve";
const STAGE_NEXT_SHAPE = "id of another stage, or null to terminate the pass chain";
const STAGE_ON_FAIL_SHAPE = `null, or {to: <existing stage id>, maxRounds?: 1–${MAX_FAIL_EDGE_ROUNDS}} — run stages only`;
const STAGE_GRAPH_SHAPE = "acyclic next chains over existing stage ids, with every review-loop reachable from a run stage";

function stageViolations(violations: PipelineValidationViolation[]): { error: string; violations: PipelineValidationViolation[] } {
  return { error: pipelineValidationError(violations), violations };
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
): { stages?: PipelineStage[]; error?: string; violations?: PipelineValidationViolation[] } {
  if (!Array.isArray(value) || value.length < minStages || value.length > MAX_PIPELINE_STAGES) {
    return stageViolations([{
      field: "stages",
      message: minStages === 0
        ? `pipelines require at most ${MAX_PIPELINE_STAGES} stages`
        : `pipelines require ${MIN_STARTED_PIPELINE_STAGES}–${MAX_PIPELINE_STAGES} stages`,
      expected: `array of ${minStages}–${MAX_PIPELINE_STAGES} stage objects`,
    }]);
  }
  const stages: PipelineStage[] = [];
  const ids = new Set<string>();
  /* #1026: every stage is checked, and every violation it holds is collected,
     before the request is answered. A stage that failed contributes no
     normalized record, so the loop keeps going with the next one instead of
     handing the caller one constraint per round trip. */
  const violations: PipelineValidationViolation[] = [];
  /* The graph rules read only id/kind/next/onFail. When those four are
     well-formed on every stage the graph is validated in the same pass, even if
     other fields failed — so a missing pass edge is reported beside the field
     errors rather than one call later. */
  const graphView: Array<Pick<PipelineStage, "id" | "kind" | "next"> & { onFail?: Pipeline["stages"][number]["onFail"] }> = [];
  let graphViewComplete = true;
  for (const [index, raw] of (value as unknown[]).entries()) {
    const at = (field: string) => `stages[${index}]${field ? `.${field}` : ""}`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      violations.push({ field: at(""), message: "invalid pipeline stage", expected: STAGE_OBJECT_SHAPE });
      graphViewComplete = false;
      continue;
    }
    const before = violations.length;
    const stage = raw as Partial<PipelineStageInput>;
    const id = typeof stage.id === "string" ? stage.id.trim() : "";
    const idValid = /^[A-Za-z0-9_-]{1,64}$/.test(id) && !ids.has(id);
    if (!idValid) {
      violations.push({ field: at("id"), message: "stage ids must be unique URL-safe names", expected: "1–64 characters of A–Z a–z 0–9 _ -, unique across stages" });
    }
    const preservedStage = preservedStages?.get(id);
    const kindValid = stage.kind === "run" || stage.kind === "review-loop";
    if (!kindValid) violations.push({ field: at("kind"), message: "stage kind must be run or review-loop", expected: `"run" | "review-loop"` });
    const rawOnFail = (raw as { onFail?: unknown }).onFail;
    let onFailValid = true;
    if (rawOnFail !== undefined && rawOnFail !== null) {
      if (!rawOnFail || typeof rawOnFail !== "object" || Array.isArray(rawOnFail)) {
        violations.push({ field: at("onFail"), message: `stage ${id} onFail must be an object or null`, expected: STAGE_ON_FAIL_SHAPE });
        onFailValid = false;
      } else {
        const edge = rawOnFail as { to?: unknown; maxRounds?: unknown };
        if (typeof edge.to !== "string" || !edge.to.trim()) {
          violations.push({ field: at("onFail.to"), message: `stage ${id} onFail requires a target stage id`, expected: "id of an existing stage" });
          onFailValid = false;
        }
        const maxRounds = edge.maxRounds === undefined ? DEFAULT_FAIL_EDGE_ROUNDS : edge.maxRounds;
        if (!Number.isInteger(maxRounds) || (maxRounds as number) < 1 || (maxRounds as number) > MAX_FAIL_EDGE_ROUNDS) {
          violations.push({
            field: at("onFail.maxRounds"),
            message: `stage ${id} onFail maxRounds must be an integer between 1 and ${MAX_FAIL_EDGE_ROUNDS}`,
            expected: `integer 1–${MAX_FAIL_EDGE_ROUNDS} (default ${DEFAULT_FAIL_EDGE_ROUNDS})`,
          });
          onFailValid = false;
        }
      }
    }
    const prompt = typeof stage.prompt === "string" ? stage.prompt.trim() : "";
    if (!prompt) violations.push({ field: at("prompt"), message: `stage ${id} prompt is required`, expected: STAGE_PROMPT_SHAPE });
    else if (prompt.length > MAX_STAGE_PROMPT_LENGTH) {
      violations.push({ field: at("prompt"), message: `stage ${id} prompt exceeds ${MAX_STAGE_PROMPT_LENGTH} characters`, expected: STAGE_PROMPT_SHAPE });
    }
    const roleValue = (raw as { role?: unknown }).role;
    let roleShapeValid = true;
    if (roleValue !== undefined && (!roleValue || typeof roleValue !== "object" || Array.isArray(roleValue))) {
      violations.push({ field: at("role"), message: `stage ${id} role must be an object`, expected: STAGE_ROLE_SHAPE });
      roleShapeValid = false;
    }
    if (roleShapeValid && roleValue && Object.keys(roleValue).some((key) => key !== "roleId" && key !== "params")) {
      violations.push({
        field: at("role"),
        message: `stage ${id} role only accepts roleId and params; place runtime overrides on the stage`,
        expected: STAGE_ROLE_SHAPE,
      });
      roleShapeValid = false;
    }
    const roleId = roleShapeValid && roleValue && typeof (roleValue as { roleId?: unknown }).roleId === "string"
      ? (roleValue as { roleId: string }).roleId.trim()
      : "";
    if (roleShapeValid && roleValue && !roleId) {
      violations.push({ field: at("role.roleId"), message: `stage ${id} roleId is required when role is present`, expected: STAGE_ROLE_ID_SHAPE });
      roleShapeValid = false;
    }
    const rawParams = roleShapeValid ? (roleValue as { params?: unknown } | undefined)?.params : undefined;
    if (rawParams !== undefined && (!rawParams || typeof rawParams !== "object" || Array.isArray(rawParams))) {
      violations.push({ field: at("role.params"), message: `stage ${id} role params must be an object`, expected: STAGE_ROLE_PARAMS_SHAPE });
      roleShapeValid = false;
    }
    const roleParams = roleShapeValid ? rawParams as Record<string, unknown> | undefined : undefined;
    if (roleParams && Object.values(roleParams).some((value) => typeof value !== "string" && typeof value !== "number")) {
      violations.push({ field: at("role.params"), message: `stage ${id} role params must be strings or numbers`, expected: STAGE_ROLE_PARAMS_SHAPE });
      roleShapeValid = false;
    }
    if (roleShapeValid && roleParams && !roleId) {
      violations.push({ field: at("role.roleId"), message: `stage ${id} role params require a roleId`, expected: STAGE_ROLE_ID_SHAPE });
      roleShapeValid = false;
    }
    if (roleShapeValid && roleId && roleParams && !preservedStage) {
      /* Canonical value checks (options, integer bounds, text length, unknown
         keys) so an invalid param can't freeze into the stored scaffold. */
      const paramError = validatePipelineRoleParams(roleId, roleParams as Record<string, string | number>);
      if (paramError) {
        violations.push({ field: at("role.params"), message: `stage ${id} ${paramError}`, expected: STAGE_ROLE_PARAMS_SHAPE });
        roleShapeValid = false;
      }
    }
    if (stage.model !== undefined && stage.model !== null && typeof stage.model !== "string") {
      violations.push({ field: at("model"), message: `stage ${id} model must be a string or null`, expected: "model id string, or null to inherit the role default" });
    }
    if (stage.effort !== undefined && stage.effort !== null && typeof stage.effort !== "string") {
      violations.push({ field: at("effort"), message: `stage ${id} effort must be a string or null`, expected: "effort string supported by the stage engine, or null to inherit the role default" });
    }
    const nextValid = stage.next === undefined || stage.next === null || typeof stage.next === "string";
    if (!nextValid) {
      violations.push({ field: at("next"), message: `stage ${id} next must be a stage id or null`, expected: STAGE_NEXT_SHAPE });
    }
    if (idValid && kindValid && onFailValid && nextValid) {
      graphView.push({
        id,
        kind: stage.kind as PipelineStage["kind"],
        next: stage.next ?? null,
        onFail: rawOnFail
          ? { to: (rawOnFail as { to: string }).to.trim(), maxRounds: ((rawOnFail as { maxRounds?: number }).maxRounds ?? DEFAULT_FAIL_EDGE_ROUNDS) }
          : null,
      });
    } else {
      graphViewComplete = false;
    }
    if (idValid) ids.add(id);
    if (violations.length > before) continue;
    const onFailEdge = rawOnFail
      ? {
          to: (rawOnFail as { to: string }).to.trim(),
          maxRounds: ((rawOnFail as { maxRounds?: number }).maxRounds ?? DEFAULT_FAIL_EDGE_ROUNDS),
        }
      : null;
    const input: PipelineStageInput = {
      id,
      kind: stage.kind as PipelineStage["kind"],
      ...(roleId ? { role: { roleId: roleId as PipelineRoleId, ...(roleParams && Object.keys(roleParams).length ? { params: roleParams as Record<string, string | number> } : {}) } } : {}),
      ...(stage.engine !== undefined ? { engine: stage.engine } : {}),
      ...(stage.model !== undefined ? { model: typeof stage.model === "string" ? stage.model.trim() || null : null } : {}),
      ...(stage.effort !== undefined ? { effort: typeof stage.effort === "string" ? stage.effort.trim() || null : null } : {}),
      ...(stage.access !== undefined ? { access: stage.access } : {}),
      prompt,
      next: stage.next ?? null,
      onFail: onFailEdge,
    };
    const resolved = preservedStage ? { role: preservedStage.effectiveRole } : resolvePipelineRole(input, stage.kind as PipelineStage["kind"], lookup);
    if (!resolved.role) {
      const field = "field" in resolved && resolved.field === "model" ? "model" : "role";
      violations.push({
        field: at(field),
        message: "error" in resolved && resolved.error ? resolved.error : "invalid stage role",
        expected: field === "model" ? "model id from the selected engine's curated catalog" : STAGE_RUNTIME_SHAPE,
      });
      continue;
    }
    const normalizedStage: PipelineStage = { ...input, effectiveRole: structuredClone(resolved.role) };
    stages.push(normalizedStage);
  }
  /* v3 graph contract: acyclic pass edges over valid targets, bounded fail
     edges, review-loop pass-reachability — shared with the store validator. */
  const graphError = graphViewComplete ? pipelineGraphError(graphView) : null;
  if (graphError) violations.push({ field: "stages[].next", message: graphError, expected: STAGE_GRAPH_SHAPE });
  if (violations.length) return stageViolations(violations);
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
): { error?: string; violations?: PipelineValidationViolation[] } {
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
  if (!normalized.stages) return { error: normalized.error ?? "invalid stages", ...(normalized.violations ? { violations: normalized.violations } : {}) };
  /* The entry stage (the draft cursor rests on stages[0]) must be a run: a
     review-loop entry has no preceding run to review and would park on Start.
     Preserved edges let a fronted review stay graph-reachable from a later run,
     so the array-position guard runs explicitly here (matching the client's
     reviewLoopChainValid). */
  if (normalized.stages[0] && normalized.stages[0].kind !== "run") {
    /* #1026: name the stage and the rule it breaks, not an ordering the caller
       is left to guess at. */
    return { error: `review-loop stage ${normalized.stages[0].id} may not be the entry stage: the plan starts on its first stage, which must be a run stage whose session a review-loop then reviews` };
  }
  pipeline.stages = normalized.stages;
  pipeline.runs = normalized.stages.map((stage) => ({ stageId: stage.id, attempts: [] }));
  pipeline.cursor = normalized.stages.length
    ? { stageId: normalized.stages[0]!.id, state: "pending", input: null, activatedBy: null }
    : null;
  return {};
}

export type PipelineMutationResult = {
  pipeline?: Pipeline;
  error?: string;
  status?: number;
  code?: PipelineRepoPreflightErrorCode;
  field?: "repoDir";
  path?: string;
  /** #1026: every request-shape constraint the call violated, each naming its
      field and the shape that field expects. Present on a batched validation
      rejection; `error` renders the same list. */
  violations?: PipelineValidationViolation[];
  /** Set by the close action: what its host teardown stopped and preserved. */
  close?: PipelineCloseReport;
};

type PipelineCreatorLineage = {
  srcPath: string | null;
  srcConversationId: string | null;
};

/** #1026: the roots a creator transcript may live under, named in every `src`
    rejection. A Claude-engine caller knows only its native path, so the message
    has to say which address the viewer records — and that the native one is
    accepted whenever the shared mirror holds the same file. */
export const PIPELINE_SRC_ROOT_GUIDANCE =
  "src must be a .jsonl transcript under an accepted root: the shared Claude transcript store (<viewer config dir>/shared/claude/projects), a Claude account's own projects root, or a Codex sessions root (~/.codex/sessions). A native ~/.claude/projects path is accepted and normalized to the shared store when the mirrored file exists there.";

function resolvePipelineCreatorLineage(
  value: unknown,
  ports: Pick<PipelinePorts, "sourcePathAllowed" | "conversationIdForPath">,
): { lineage?: PipelineCreatorLineage; error?: string; status?: number } {
  const requested = typeof value === "string" ? value.trim() : "";
  if (!requested) return { error: "pipeline creator lineage is required; pass src", status: 400 };
  /* The native `<claude home>/projects/...` path and its shared-store mirror
     name the same file; viewer records address the shared one. Try what the
     caller passed first, so nothing about an already-canonical path changes. */
  for (const srcPath of [requested, mirroredClaudeTranscriptPath(requested)]) {
    if (!srcPath || !ports.sourcePathAllowed(srcPath)) continue;
    const srcConversationId = ports.conversationIdForPath(srcPath);
    if (srcConversationId) return { lineage: { srcPath, srcConversationId } };
  }
  if (!ports.sourcePathAllowed(requested)) {
    return { error: `src path is not an allowed conversation transcript. ${PIPELINE_SRC_ROOT_GUIDANCE}`, status: 400 };
  }
  return { error: `src conversation does not exist. ${PIPELINE_SRC_ROOT_GUIDANCE}`, status: 400 };
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
  /* #1026: every request-shape constraint is evaluated before the request is
     answered, and the response carries all of them. The checks and their
     verdicts are the ones that were here before, only their reporting is
     batched; the repo preflight and base resolution below still answer alone,
     because each carries its own code, field and status. */
  const violations: PipelineValidationViolation[] = [];
  const task = typeof req.task === "string" ? req.task.trim() : "";
  if (!task) violations.push({ field: "task", message: "task is required", expected: `non-empty string up to ${MAX_TASK_LENGTH} characters` });
  else if (task.length > MAX_TASK_LENGTH) violations.push({ field: "task", message: `task exceeds ${MAX_TASK_LENGTH} characters`, expected: `non-empty string up to ${MAX_TASK_LENGTH} characters` });
  const spec = typeof req.spec === "string" && req.spec.trim() ? req.spec.trim() : undefined;
  if (req.spec !== undefined && typeof req.spec !== "string") violations.push({ field: "spec", message: "spec must be a string", expected: `string up to ${MAX_SPEC_LENGTH} characters` });
  if (spec && spec.length > MAX_SPEC_LENGTH) violations.push({ field: "spec", message: `spec exceeds ${MAX_SPEC_LENGTH} characters`, expected: `string up to ${MAX_SPEC_LENGTH} characters` });
  if (req.autoStart !== undefined && typeof req.autoStart !== "boolean") violations.push({ field: "autoStart", message: "autoStart must be a boolean", expected: "boolean (false creates a draft the operator starts)" });
  if (req.baseBranch !== undefined && typeof req.baseBranch !== "string") violations.push({ field: "baseBranch", message: "baseBranch must be a string", expected: "branch name string" });
  if (req.baseRef !== undefined && typeof req.baseRef !== "string") violations.push({ field: "baseRef", message: "baseRef must be a string", expected: "commit-ish string resolved against repoDir" });
  if (req.taskIds !== undefined && (!Array.isArray(req.taskIds) || req.taskIds.some((taskId) => typeof taskId !== "string" || !taskId.trim()))) {
    violations.push({ field: "taskIds", message: "taskIds must be an array of non-empty strings", expected: "array of board task ids" });
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
  /* A task-spawn lineage failure is a launch-identity conflict, not a request
     the caller can fix by editing fields, so it answers alone as it always did. */
  if (!creator.lineage && taskSpawn) return { error: creator.error, status: creator.status };
  if (!creator.lineage) violations.push({ field: "src", message: creator.error ?? "pipeline creator lineage is required; pass src", expected: PIPELINE_SRC_ROOT_GUIDANCE });
  const taskIds = [...new Set((req.taskIds ?? []).map((taskId) => taskId.trim()))];
  const requestedRepoDir = typeof req.repoDir === "string" ? req.repoDir.trim() : "";
  if (!requestedRepoDir) violations.push({ field: "repoDir", message: "repoDir is required", expected: "absolute path of an existing git repository" });
  /* A draft (autoStart:false) may be created empty and assembled on the canvas
     (#136); an immediately-started pipeline needs at least its one implement
     conversation (#353). */
  const normalized = normalizeStages(req.stages, ports.roleLookup, undefined, req.autoStart === false ? 0 : MIN_STARTED_PIPELINE_STAGES);
  if (!normalized.stages) {
    violations.push(...(normalized.violations ?? [{ field: "stages", message: normalized.error ?? "invalid stages", expected: STAGE_OBJECT_SHAPE }]));
  }
  /* Read after the type checks above recorded their verdicts: with batching a
     non-string baseRef reaches here, so the trims must not assume a string. */
  const explicitBaseRef = typeof req.baseRef === "string" ? req.baseRef.trim() : undefined;
  const requestedBaseBranch = typeof req.baseBranch === "string" ? req.baseBranch.trim() : "";
  if (req.autoStart === false && requestedBaseBranch && !explicitBaseRef) {
    violations.push({
      field: "baseRef",
      message: "a draft baseBranch requires an explicit baseRef",
      expected: "commit SHA the draft is pinned to, resolved by the caller (a draft is not provisioned, so the viewer cannot resolve the branch itself)",
    });
  }
  if (violations.length || !normalized.stages || !creator.lineage) {
    return { error: pipelineValidationError(violations), violations, status: 400 };
  }
  const admission = ports.preflightRepo(requestedRepoDir);
  if (!admission.ok) return preflightFailure(admission);
  const repoDir = admission.repoDir;
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

function verdictRecoveryResetRefusal(attempt: PipelineStageAttempt | null): { error: string; status: number } | null {
  if (attempt?.verdictRecovery?.state !== "exhausted") return null;
  return {
    error: "automatic verdict recovery exhausted; preserve its worktree and conversation lineage, then continue the same conversation or close the pipeline",
    status: 409,
  };
}

/**
 * Every host this pipeline ever launched, as a close must consider it.
 *
 * A terminal attempt state says nothing about whether its host is still
 * resident: `park()` writes `needs_decision` precisely when a hosted session
 * went idle, produced an unparseable verdict, or stopped reporting — the agent
 * process is still there, still holding the account's quota. Those parked lanes
 * are the orphans #670 was filed for, so residency is decided downstream from
 * evidence about the host (the registry, then the pane), never from the attempt
 * state machine.
 *
 * Adopted (`historical`) attempts count too. They are not passive evidence: a
 * stage agent spawned that conversation through the viewer, adoptAttempt seats
 * it running with its own launch, conversation and pane, and the tick tracks it
 * as a live host until it produces a verdict. Skipping them let a helper the
 * pipeline started keep burning quota behind a lane that had already left the
 * board — this issue again, through another door.
 */
function launchedStageHosts(pipeline: Pipeline): StageHostCandidate[] {
  const candidates: StageHostCandidate[] = [];
  const seen = new Set<string>();
  for (const run of pipeline.runs) {
    for (const attempt of run.attempts) {
      if (!attempt.conversationId && !attempt.agentPath && !attempt.paneId) continue;
      /* Rounds can share a host identity (a review round re-reads its reviewer
         conversation); probing one host once keeps the counts truthful. */
      const identity = `${attempt.conversationId ?? ""}|${attempt.agentPath ?? ""}|${attempt.paneId ?? ""}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      candidates.push({
        target: {
          stageId: run.stageId,
          attempt: attempt.n,
          conversationId: attempt.conversationId,
          agentPath: attempt.agentPath,
          paneId: attempt.paneId,
          ...(attempt.historical ? { adopted: true as const } : {}),
        },
        /* Same reading orphanAgentPane uses: a verdict or a completion stamp
           means the turn ended, so what is left in the pane is an idle CLI. A
           parked attempt has neither (park writes only state and error), which
           is why the pane heuristic still applies to it. */
        turnSettled: Boolean(attempt.verdict || attempt.completedAt),
      });
    }
  }
  return candidates;
}

/** A launched host plus whether its attempt's turn ended, which decides only
    whether the pane heuristic may speak for it. */
type StageHostCandidate = { target: PipelineStageHostRef; turnSettled: boolean };

/** Ceiling on a close's whole host teardown, holding the pipelines transaction. */
const CLOSE_TEARDOWN_BUDGET_MS = 10_000;

function stageHostLabel(target: PipelineStageHostRef): string {
  const what = target.adopted ? "adopted agent of stage" : "stage";
  return `${what} ${target.stageId} attempt ${target.attempt} (${target.conversationId ?? target.agentPath ?? "unknown host"})`;
}

/** Reads the uncommitted work a close leaves behind. Skipped while the pipeline
    has no provisioned worktree to read. */
function closeWorktreeReport(pipeline: Pipeline, ports: PipelinePorts): PipelineCloseReport["worktree"] {
  if (pipeline.state === "provisioning" || !pipeline.lastPassedCommit) return null;
  /* A worktree cleaned up after a merge has nothing to preserve and nothing to
     report; only a checkout that is present but unreadable is a finding. */
  if (!ports.worktreePresent(pipeline.worktreeDir)) return null;
  const changes = pipelineWorktreeChanges(pipeline, ports.exec);
  if (!changes.ok) return { dir: pipeline.worktreeDir, uncommitted: [], truncated: false, error: changes.error };
  return { dir: pipeline.worktreeDir, uncommitted: changes.paths, truncated: changes.truncated };
}

/** Durable one-line account of a close, so the board and the API agree on
    whether anything was stopped, what could not be confirmed, and what was
    preserved. An unreadable worktree is reported as such — never as the silence
    that a verified-clean worktree produces. */
function closeSummary(report: PipelineCloseReport): string | null {
  const parts: string[] = [];
  const adopted = report.stopped.filter((item) => item.adopted).length;
  const launched = report.stopped.length - adopted;
  if (launched > 0) parts.push(`stopped ${launched} stage host${launched === 1 ? "" : "s"}`);
  if (adopted > 0) parts.push(`stopped ${adopted} adopted agent${adopted === 1 ? "" : "s"}`);
  if (report.reviewers.length > 0) {
    parts.push(`stopped ${report.reviewers.length} review round${report.reviewers.length === 1 ? "" : "s"}`);
  }
  for (const item of report.unconfirmed) {
    parts.push(`${item.detail} for ${stageHostLabel(item)}${item.operationId ? ` (operation ${item.operationId})` : ""}`);
  }
  if (report.acknowledged.length > 0) {
    parts.push(`dismissed ${report.acknowledged.length} unconfirmed host${report.acknowledged.length === 1 ? "" : "s"} on the operator's word`);
  }
  if (report.worktree?.error) {
    parts.push(`could not read the worktree at ${report.worktree.dir}: ${report.worktree.error}`);
  } else {
    const kept = report.worktree?.uncommitted.length ?? 0;
    if (kept > 0) {
      parts.push(`kept ${kept}${report.worktree?.truncated ? "+" : ""} uncommitted path${kept === 1 ? "" : "s"} in the worktree`);
    }
  }
  return parts.length > 0 ? `closed; ${parts.join("; ")}` : null;
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
      if (replaced.error) return { error: replaced.error, status: 400, ...(replaced.violations ? { violations: replaced.violations } : {}) };
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
      if (replaced.error) return { error: replaced.error, status: 400, ...(replaced.violations ? { violations: replaced.violations } : {}) };
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
      if (replaced.error) return { error: replaced.error, status: 400, ...(replaced.violations ? { violations: replaced.violations } : {}) };
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
        pipeline.pausedAt = ports.now();
        pipeline.stateDetail = "paused by user";
        if (flow && flow.state !== "paused" && flow.state !== "closed") ports.patchFlow(flow.id, "pause");
      }
    } else if (req.action === "resume") {
      if (pipeline.state !== "paused") return { error: "pipeline is not paused", status: 409 };
      pipeline.state = pipeline.pausedState ?? "running";
      pipeline.pausedState = null;
      pipeline.resumedAt = ports.now();
      pipeline.stateDetail = null;
      if (flow?.state === "paused") ports.patchFlow(flow.id, "resume");
    } else if (req.action === "retry-stage") {
      if (pipeline.state !== "needs_decision") return { error: "pipeline does not have a stage awaiting retry", status: 409 };
      const recoveryRefusal = verdictRecoveryResetRefusal(attempt);
      if (recoveryRefusal) return recoveryRefusal;
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
        /* A retried reviewer fences on the published head exactly like the first
           one. Without this, a local repair the operator committed in the
           worktree would park the retry on the same unavailable remote the
           retry was meant to escape — an unbounded operator loop. */
        const republished = publishPipelineBranch(pipeline, ports.exec, {
          acceptedSha: retryReviewHead!.sha,
          publishedSha: pipeline.publishedCommit ?? null,
        });
        if (!republished.ok) {
          pipeline.stateDetail = republished.error;
          persist();
          return { error: republished.error, status: 409 };
        }
        pipeline.publishedCommit = republished.remote === "published" ? republished.sha : null;
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
      const recoveryRefusal = verdictRecoveryResetRefusal(attempt);
      if (recoveryRefusal) return recoveryRefusal;
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
      /* #670: a close used to leave the stage host resident, so the agent kept
         executing on a paid quota and the board kept a live-looking chip. Tear
         the hosts down before the flow and the state write, and report exactly
         what was stopped. Nothing on disk is touched — uncommitted stage work
         stays in the worktree and is named in the report instead. */
      if (req.acknowledgeHosts !== undefined && typeof req.acknowledgeHosts !== "boolean") {
        return { error: "acknowledgeHosts must be a boolean", status: 400 };
      }
      const close: PipelineCloseReport = { stopped: [], alreadyStopped: [], unconfirmed: [], acknowledged: [], reviewers: [], stillRunning: [], worktree: null };
      /* Each host's confirmation is bounded, but N of them multiply, and this
         whole loop holds the pipelines file transaction — every other pipeline
         mutation and the controller tick queue behind it. So the aggregate is
         bounded too, and the hosts the budget cut off are reported as
         unconfirmed rather than silently skipped: the lane stays visible and a
         later close picks the work up where this one stopped. */
      const teardownDeadline = ports.monotonicNow() + CLOSE_TEARDOWN_BUDGET_MS;
      const candidates = launchedStageHosts(pipeline);
      for (let index = 0; index < candidates.length; index += 1) {
        const { target, turnSettled } = candidates[index]!;
        if (index > 0 && ports.monotonicNow() >= teardownDeadline) {
          for (const remaining of candidates.slice(index)) {
            close.unconfirmed.push({
              ...remaining.target,
              operationId: null,
              detail: "close teardown budget expired before this host was probed",
            });
          }
          break;
        }
        const result = await ports.stopStageAgent(target);
        if (result.outcome === "stopped") close.stopped.push(target);
        else if (result.outcome === "failed") close.stillRunning.push({ ...target, error: result.error });
        else if (result.outcome === "unconfirmed") {
          close.unconfirmed.push({ ...target, operationId: result.operationId, detail: result.detail });
        } else if (!turnSettled && target.paneId) {
          /* The registry knows no host, but the attempt never finished its turn
             and its pane may still hold the agent. The teardown kills it only
             when durable evidence proves the pane is still this stage's. */
          const pane = await ports.stopStagePane(target);
          if (pane.outcome === "stopped") close.stopped.push(target);
          else if (pane.outcome === "failed") close.stillRunning.push({ ...target, error: pane.error });
          else if (pane.outcome === "unknown") close.unconfirmed.push({ ...target, operationId: null, detail: pane.detail });
          else close.alreadyStopped.push(target);
        } else close.alreadyStopped.push(target);
      }
      close.worktree = closeWorktreeReport(pipeline, ports);
      if (close.stillRunning.length > 0) {
        /* A host that survived teardown must not be reported as a clean close:
           the pipeline keeps its state so the survivor stays visible and
           addressable instead of hiding behind a closed lane. */
        const detail = `could not stop ${close.stillRunning.map((item) => `${stageHostLabel(item)}: ${item.error}`).join("; ")}`;
        pipeline.stateDetail = detail;
        persist();
        return { error: detail, status: 409, close };
      }
      if (flow && flow.state !== "closed") {
        const closed = await ports.closeFlow(flow.id);
        if (closed?.error) {
          /* A reviewer that would not die is a survivor like any other, so it
             leaves through the same report the host teardown uses. */
          if (stage && attempt) close.stillRunning.push({
            stageId: stage.id,
            attempt: attempt.n,
            conversationId: attempt.conversationId,
            agentPath: attempt.agentPath,
            paneId: attempt.paneId,
            error: closed.error,
          });
          pipeline.stateDetail = closed.error;
          persist();
          return { error: closed.error, status: closed.status ?? 409, close };
        }
        /* closeFlow terminates a live reviewer itself; counting what it stopped
           is what keeps a mid-review close from reporting "nothing was running"
           (#670). Headless reviewers never reach the agent registry, so the host
           teardown above cannot see them. */
        if (closed?.stoppedReviewer && stage && attempt) {
          close.reviewers.push({ stageId: stage.id, attempt: attempt.n, flowId: flow.id, round: closed.stoppedReviewer.round });
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
      /* The operator's way out of an unresolvable host (#670): a pane whose id
         was recycled can look alive forever, so the lane would otherwise stay
         pinned to the board with no dismissal. An acknowledgement clears only
         hosts that are unconfirmed — anything proven to be still running has
         already refused this close above. */
      if (req.acknowledgeHosts === true && close.unconfirmed.length > 0) {
        close.acknowledged.push(...close.unconfirmed.map((item) => ({ ...item, detail: item.detail })));
        close.unconfirmed.length = 0;
      }
      pipeline.stateDetail = closeSummary(close);
      pipeline.closedAt = ports.now();
      /* An unconfirmed kill may have left a resident host. Hiding the lane would
         make that survivor invisible on the board, which is the opposite of
         surfacing it, so the closed record stays visible (and durable) until a
         later close confirms the host is gone and clears it. */
      pipeline.unconfirmedHosts = close.unconfirmed.length > 0
        ? close.unconfirmed.map((item) => ({
            stageId: item.stageId,
            attempt: item.attempt,
            conversationId: item.conversationId,
            agentPath: item.agentPath,
            paneId: item.paneId,
            operationId: item.operationId,
            detail: item.detail,
            at: pipeline.closedAt!,
          }))
        : undefined;
      pipeline.hiddenAt = pipeline.unconfirmedHosts ? null : pipeline.closedAt;
      persist();
      return { pipeline, close };
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
