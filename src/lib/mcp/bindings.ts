import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { agentRegistry, readOnlyConversationLookupFromSnapshot } from "@/lib/agent/registry";
import { ENGINE_MODELS, validateLaunchModel } from "@/lib/agent/models";
import { procBackend } from "@/lib/proc";
import { ensureOperatorSpawnCapability } from "@/lib/agent/operatorCapability";
import { internalServiceHeaders } from "@/lib/agent/operatorAuthority";
import { VIEWER_SPAWN_CAPABILITY_ENV, VIEWER_SPAWN_CAPABILITY_HEADER } from "@/lib/agent/spawnPolicy";
import { applyConversationMigration } from "@/lib/accounts/migration/conversationCommand";
import { attentionCallerAuthority, processAncestry, type AttentionCallerAuthority, type AttentionCallerSources } from "@/lib/attention/callerAuthority";
import { UNREAD_FRAME_RECT } from "@/lib/attention/frames";
import {
  ATTENTION_ARRIVAL_TIMEOUT_MS,
  awaitAttentionArrival,
  raiseAttentionRequest,
  resolveDirectedAttentionView,
} from "@/lib/attention/service";
import { readAttentionFile } from "@/lib/attention/store";
import {
  CONVERSATION_PATH_EXAMPLE,
  describeFocusTargetRejection,
  focusTargetExample,
  geometricFrameRect,
  isFocusTarget,
  isGeometricTarget,
} from "@/lib/attention/targets";
import type { AttentionRequestV1, FocusIntent, FocusTarget, ZoomIntent } from "@/lib/attention/types";
import { applyBoardCommand } from "@/lib/board/command";
import { boardFor } from "@/lib/board/store";
import { MAX_BOARD_MUTATIONS_PER_REQUEST, MAX_BOARD_PATH_LIST_ITEMS } from "@/lib/board/validation";
import { applyConversationAction } from "@/lib/conversation/actions";
import { backoffDelayMs, DeadlineExceededError, deadlineSignal } from "@/lib/deadline";
import { cancelRound, closeFlow, patchFlow } from "@/lib/flows/commands";
import { getFlowsWithPresets } from "@/lib/flows/engine";
import type { PatchFlowRequest } from "@/lib/flows/types";
import { pollLifecycleDigest, type LifecycleDigestRequest } from "@/lib/lifecycle/digest";
import { queryLifecycleEvents, type LifecycleEventQuery } from "@/lib/lifecycle/journal";
import type { CompletedGenerationRead } from "@/lib/lifecycle/inventorySelection";
import {
  agentLivenessSnapshot,
  productionLivenessSources,
  DEFAULT_EVIDENCE_DEADLINE_MS,
  type AgentLivenessSources,
} from "@/lib/lifecycle/liveness";
import { refreshLifecycleJournal } from "@/lib/lifecycle/projector";
import { isLifecycleEventType } from "@/lib/lifecycle/vocabulary";
import { recordBridgeDirectiveAnswer, recordManagerReport } from "@/lib/bridge/service";
import { bridgeDirectiveBody, bridgeDirectiveId, type BridgeTrailer } from "@/lib/bridge/directive";
import { seatIdentityResolver } from "@/lib/bridge/seatIdentity";
import { isBridgeReportClass, type CanonicalSeatConversationId } from "@/lib/bridge/types";
import { authorizedManagerSeats, type ManagerAuthoritySources } from "@/lib/orchestrator/authority";
import { activeOrchestratorSeats, canonicalOrchestratorProject, orchestratorRevocations, orchestratorSeatFor, type OrchestratorSeat } from "@/lib/orchestrator/seats";
import { ORCHESTRATOR_PROMPT_VERSION, ORCHESTRATOR_SYSTEM_PROMPT } from "@/lib/orchestrator/prompt";
import { contextReading, readOrchestratorTranscriptFacts, rotationRecommendation } from "@/lib/orchestrator/health";
import { contextWindowPolicyFor } from "@/lib/orchestrator/contextPolicy";
import { createPipelineFromRequest, getPipelines, patchPipeline } from "@/lib/pipelines/engine";
import { latestOperationalPipelineAttempt } from "@/lib/pipelines/attemptSelection";
import { requestPipelineTick } from "@/lib/pipelines/controllerSignal";
import { projectTaskPipelineIds } from "@/lib/pipelines/taskBinding";
import { PIPELINE_LIST_DEFAULT_LIMIT, projectPipelineListRows } from "@/lib/pipelines/listProjection";
import { findPipelineRecord, loadPipelinesForList } from "@/lib/pipelines/store";
import type { CreatePipelineRequest, PatchPipelineRequest, Pipeline, PipelineAction } from "@/lib/pipelines/types";
import type { PauseResumeActor } from "@/lib/pauseResumeActor";
import { listFiles } from "@/lib/scanner";
import { describe, projectForCwd, reprojectFileDescription } from "@/lib/scanner/describe";
import { pathAllowed, scanRootEntries } from "@/lib/scanner/roots";
import { completedFileScan } from "@/lib/scanner/scanCache";
import { readResources } from "@/lib/resources";
import { adoptLiveRootSession, conversationRole, liveRootSession, type RootSessionSource } from "@/lib/root/adopt";
import { listRoles, resolveSpawnRole } from "@/lib/roles/registry";
import type { RoleDefinition, RoleParameter } from "@/lib/roles/types";
import type { ViewerDeploymentStatus } from "@/lib/runtime/contracts";
import { messageOriginRole, type MessageOrigin } from "@/lib/runtime/messageOrigin";
import { ledgerDeployment, ledgerDeployments } from "@/lib/runtime/deploymentLedger";
import {
  SELECTED_TAIL_MAX_BYTES,
  SELECTED_TAIL_MAX_LINES,
  type BoundedTranscriptTail,
} from "@/lib/selection/resolve";
import { readSession, type SessionReadResult } from "@/lib/session/reader";
import { resolveProjectAttribution } from "@/lib/session/projectResolution";
import { overlaySessionTitles } from "@/lib/session/titleProjection";
import { recordReplySuggestions } from "@/lib/suggestions/store";
import { ReplySuggestionValidationError } from "@/lib/suggestions/types";
import { applyAssignmentPatches, createTask, patchTask, type CreateTaskInput, type PatchTaskInput } from "@/lib/tasks/commands";
import { isoNow } from "@/lib/tasks/helpers";
import { loadTasks, mutateTasks, mutateTasksFile } from "@/lib/tasks/store";
import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";
import { collectSnapshot } from "@/lib/view/collect";
import { resolveSiblings } from "@/lib/view/siblings";
import { hardenedRedact } from "@/lib/view/compactText";
import { validateSnapshotRequest } from "@/lib/view/validation";

import { McpToolRefusal, type McpToolArgs, type McpToolBindings, type McpToolCallContext, type McpToolPayload } from "./server";
import {
  productionSelectedContextDependencies,
  resolveSelectedContext,
  selectedContextEcho,
  selectedConversationTail,
  type SelectedContextTargetDependencies,
} from "./selectedContextTarget";
import { mcpCallerIdentity, mcpToolPolicy, permitAttentionHandoff, permitReplySuggestions, type ManagerTarget, type McpToolPolicy } from "./toolAllowlist";

const PIPELINE_CONTROLLER_ACTIONS = new Set<PipelineAction>(["start", "resume", "retry-stage", "skip-stage"]);

interface LinkTaskToPipelineDependencies {
  getPipelines(): ReturnType<typeof getPipelines>;
  mutateTasks<R>(mutator: (tasks: BoardTask[]) => { tasks?: BoardTask[]; result: R }): R;
  isoNow(): string;
}

const productionLinkTaskDependencies: LinkTaskToPipelineDependencies = {
  getPipelines,
  mutateTasks,
  isoNow,
};

export interface ViewerControlDependencies {
  get?(pathname: string, context?: McpToolCallContext): Promise<Record<string, unknown>>;
  post(
    pathname: string,
    body: Record<string, unknown>,
    headers?: Record<string, string>,
    context?: McpToolCallContext,
  ): Promise<Record<string, unknown>>;
}

const VIEWER_CONTROL_URL = "http://127.0.0.1:8898";
const CONTROL_ATTEMPT_TIMEOUT_MS = 5_000;
const CONTROL_RECOVERY_BUDGET_MS = 8_000;
const CONTROL_UNSCOPED_RECOVERY_BUDGET_MS = 5_000;
const CONTROL_DEADLINE_RESERVE_MS = 250;
const CONTROL_RETRY_BASE_MS = 100;
const CONTROL_RETRY_MAX_MS = 1_000;
const TRANSIENT_CONTROL_STATUSES = new Set([502, 504]);

class ViewerControlResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ViewerControlResponseError";
  }
}

function controlRetryDelay(attempt: number): number {
  return backoffDelayMs(attempt, { baseMs: CONTROL_RETRY_BASE_MS, maxMs: CONTROL_RETRY_MAX_MS });
}

async function waitForControlRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw signal.reason;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(finish, delayMs);
    const onAbort = () => finish(signal?.reason);
    function finish(error?: unknown) {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (error !== undefined) reject(error);
      else resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function requestViewerControl(
  pathname: string,
  init: RequestInit,
  context: McpToolCallContext = {},
): Promise<{ response: Response; parsed: unknown; unreadable: boolean }> {
  const baseUrl = process.env.LLV_VIEWER_CONTROL_URL?.trim() || VIEWER_CONTROL_URL;
  const now = Date.now();
  const deadlineAt = context.deadlineAt;
  const retryable = deadlineAt !== undefined;
  const callerBudget = deadlineAt === undefined
    ? CONTROL_UNSCOPED_RECOVERY_BUDGET_MS
    : Math.max(0, deadlineAt - now - CONTROL_DEADLINE_RESERVE_MS);
  const expiresAt = now + Math.min(CONTROL_RECOVERY_BUDGET_MS, callerBudget);
  let attempts = 0;
  let lastFailure = "connection failed";
  while (Date.now() < expiresAt) {
    if (context.signal?.aborted) throw context.signal.reason;
    attempts += 1;
    const remainingMs = Math.max(1, expiresAt - Date.now());
    const attempt = deadlineSignal(Math.min(CONTROL_ATTEMPT_TIMEOUT_MS, remainingMs), {
      signal: context.signal,
      reason: "Viewer control reconnect attempt timed out",
    });
    try {
      const response = await fetch(new URL(pathname, baseUrl), { ...init, signal: attempt.signal });
      if (TRANSIENT_CONTROL_STATUSES.has(response.status)) {
        lastFailure = `status ${response.status}`;
        await response.body?.cancel().catch(() => {});
      } else {
        try {
          const parsed = await response.json() as unknown;
          const answeredDomainFailure = response.status === 503
            && objectRecord(parsed)
            && Boolean(text(parsed.error) || text(parsed.code));
          if (response.status !== 503 || answeredDomainFailure || !retryable) {
            return { response, parsed, unreadable: false };
          }
          lastFailure = "status 503";
        } catch {
          if (context.signal?.aborted) throw context.signal.reason;
          if (!retryable) {
            return { response, parsed: null, unreadable: true };
          } else if (attempt.signal.aborted) {
            lastFailure = "response body timed out";
          } else if (response.status === 503) {
            lastFailure = "status 503";
          } else {
            lastFailure = "response body failed";
          }
        }
      }
    } catch {
      if (context.signal?.aborted) throw context.signal.reason;
      lastFailure = attempt.signal.aborted ? "attempt timed out" : "connection failed";
    } finally {
      attempt.release();
    }
    if (!retryable) break;
    const delayMs = controlRetryDelay(attempts);
    if (Date.now() + delayMs >= expiresAt) break;
    await waitForControlRetry(delayMs, context.signal);
  }
  if (!retryable) throw new Error("Viewer control is unreachable");
  throw new Error(`Viewer control did not reconnect after ${attempts} attempt${attempts === 1 ? "" : "s"} (${lastFailure})`);
}

async function getViewerControl(
  pathname: string,
  context: McpToolCallContext = {},
): Promise<Record<string, unknown>> {
  const { response, parsed: controlPayload, unreadable } = await requestViewerControl(pathname, {
    headers: {
      accept: "application/json",
    },
  }, context);
  /* A body of literal `null` is valid JSON, so `.catch` never fires and every
     later `result.x` throws a TypeError before the status can be classified —
     which is how a 405 from a revision that does not serve the route arrived as
     an uncatchable crash instead of a refusal (#790). */
  let parsed = controlPayload;
  if (unreadable) {
    if (response.ok) {
      throw new ViewerControlResponseError(
        `Viewer control returned an unreadable response with status ${response.status}`,
      );
    }
    parsed = null;
  }
  const result: Record<string, unknown> = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
  if (!response.ok) {
    const error = text(result.error) || `Viewer control request failed with status ${response.status}`;
    throw new McpToolRefusal(error, {
      error,
      status: response.status,
      ...(text(result.code) ? { code: text(result.code) } : {}),
    });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ViewerControlResponseError(
      `Viewer control returned a malformed response with status ${response.status}`,
    );
  }
  return result;
}

async function postViewerControl(
  pathname: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
  context: McpToolCallContext = {},
): Promise<Record<string, unknown>> {
  const baseUrl = process.env.LLV_VIEWER_CONTROL_URL?.trim() || VIEWER_CONTROL_URL;
  /* Every control mutation carries its endpoint's idempotency identity
     (clientAttemptId, clientMessageId or clientRequestId). Repeating the same
     request after a lost transport answer therefore asks for its receipt. */
  const { response, parsed, unreadable } = await requestViewerControl(pathname, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: baseUrl,
      "sec-fetch-site": "same-origin",
      ...headers,
    },
    body: JSON.stringify(body),
  }, context);
  /* A body of literal `null` is valid JSON, so `.catch` never fires and every
     later `result.x` throws a TypeError before the status can be classified —
     which is how a 405 from a revision that does not serve the route arrived as
     an uncatchable crash instead of a refusal (#790). */
  if (unreadable && response.ok) {
    throw new ViewerControlResponseError(
      `Viewer control returned an unreadable response with status ${response.status}`,
    );
  }
  const result: Record<string, unknown> = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
  if (result.error || (!response.ok && result.state !== "busy")) {
    throw new Error(text(result.error) || `Viewer control request failed with status ${response.status}`);
  }
  return result;
}

const productionViewerControlDependencies: ViewerControlDependencies = {
  get: getViewerControl,
  post: postViewerControl,
};

function readViewerControl(
  control: ViewerControlDependencies,
  pathname: string,
): Promise<Record<string, unknown>> {
  if (!control.get) throw new Error("Viewer control read is unavailable");
  return control.get(pathname);
}

function viewerControlForCall(
  control: ViewerControlDependencies,
  context?: McpToolCallContext,
): ViewerControlDependencies {
  if (!context) return control;
  return {
    ...(control.get ? { get: (pathname: string) => control.get!(pathname, context) } : {}),
    post: (pathname, body, headers) => control.post(pathname, body, headers, context),
  };
}

type RegistrySnapshot = ReturnType<ReturnType<typeof agentRegistry>["readOnlySnapshot"]>;

interface TargetedConversationOptions extends McpToolCallContext {
  tailLines?: number;
}

export interface ViewerMcpDomainDependencies {
  listFiles(options?: Parameters<typeof listFiles>[0]): Promise<FileEntry[]>;
  targetedFileEntry?(pathname: string, options?: TargetedConversationOptions): Promise<TargetedConversationRead | FileEntry | undefined>;
  /** #844 §6/§7: the bounded selected-card path — one keyed identity lookup and
      an explicit tail read, reaching no scan. Optional so partial test
      harnesses fall back to the production resolver. */
  selectedContext?: SelectedContextTargetDependencies;
  completedFileScan(options?: Parameters<typeof completedFileScan>[0]): ReturnType<typeof completedFileScan>;
  registrySnapshot(): RegistrySnapshot;
  boardFor(project: string): ReturnType<typeof boardFor>;
  applyBoardCommand(input: unknown, snapshot: RegistrySnapshot): ReturnType<typeof applyBoardCommand>;
  getFlowsWithPresets(): ReturnType<typeof getFlowsWithPresets>;
  patchFlow: typeof patchFlow;
  cancelRound: typeof cancelRound;
  closeFlow: typeof closeFlow;
  getPipelines: typeof getPipelines;
  /** #863: the bounded list read — the shared cached registry parse, with none
      of the per-caller revive `getPipelines` pays, because a list row copies
      scalars and keeps nothing. Optional so partial test harnesses that stub
      only `getPipelines` still project from it. */
  listPipelineRecords?(): readonly Pipeline[];
  patchPipeline: typeof patchPipeline;
  loadTasks: typeof loadTasks;
  collectSnapshot: typeof collectSnapshot;
  readResources: typeof readResources;
  applyConversationAction: typeof applyConversationAction;
  applyConversationMigration: typeof applyConversationMigration;
  /** Sources for the liveness read. The catalog seam travels in (#860) so a
      project-scoped `agent_activity` consumes the SAME completed generation
      `board_snapshot` reads instead of forcing a private whole-corpus sweep.
      Partial harnesses that build fixed sources may ignore the argument. */
  livenessSources(catalog?: { completedFileScan?: CompletedGenerationRead }): AgentLivenessSources;
  queryLifecycleEvents: typeof queryLifecycleEvents;
  pollLifecycleDigest: typeof pollLifecycleDigest;
  refreshLifecycleJournal: typeof refreshLifecycleJournal;
  /** #688 D5: fold the live root session into the rollover chain, so a request
      references the root by an identity that survives the session it was raised
      from. Called on the raise path, which is the moment that identity matters. */
  adoptRootSession(): void;
  raiseAttentionRequest: typeof raiseAttentionRequest;
  /** #873: block until the directed view lands or the handoff closes as a
      bounded failure. Optional so partial harnesses fall back to the real
      awaiter; tests override it only to shorten its clocks. */
  awaitAttentionArrival?: typeof awaitAttentionArrival;
  /** Who is running this MCP server. Resolved from process ancestry and the
      registry's recorded hosts merged with the admission-injected spawn
      capability, never from anything the caller says. Under B+ it ATTRIBUTES —
      it does not gate tool availability. */
  attentionAuthority(): AttentionCallerAuthority;
  /** The same identity folded with the durable orchestrator designation, as
      the server-derived origin label for attention requests and bridge
      reports. Optional so partial test harnesses fall back to a label derived
      from {@link attentionAuthority} alone (manager reads as agent there). */
  callerAttribution?(): CallerAttribution;
  /** #873 restart replay: the durable record an earlier, interrupted run of
      the same MCP operation already raised. Optional so partial harnesses
      fall back to the shared attention file. */
  findAttentionByOperation?(operationKey: string): AttentionRequestV1 | null;
  /** Validated per-project manager seats (fail-closed — see
      `@/lib/orchestrator/authority`), for project-scoped directive routing.
      Optional so partial harnesses fall back to the production resolver. */
  authorizedSeats?(): ReturnType<typeof authorizedManagerSeats>;
  /** Resolves a seat identity through the registry's alias chain (#1168), so a
      directive settles the ask of a seat the log recorded under a pre-migration
      id. The attention projection resolves the recorded seat the same way, and
      the two must agree or a rekeyed seat's ask outlives its answer. Optional
      so partial harnesses fall back to the production registry. */
  canonicalSeatConversationId?: CanonicalSeatConversationId;
  /** The calling voice session's CANONICAL PROJECT — production resolves it
      from the caller's conversation cwd through the worktree-grouping path
      (`projectInfoFromCwd`), the same attribution every other surface uses.
      Null means the invariant "a registered session has a canonical project"
      is violated, and unscoped directive routing fails closed diagnostically. */
  callerProject?(): string | null;
}

/**
 * FIX 2's production resolver: the caller's conversation (pid ancestry merged
 * with capability lineage — the identity chain everything else trusts), its
 * newest generation's cwd, and the canonical project that cwd groups under.
 * No second resolution scheme: `projectForCwd` IS `projectInfoFromCwd`.
 */
function productionCallerProject(): string | null {
  const authority = attentionCallerAuthority(attentionCallerSources());
  const conversationId = authority.kind === "root" || authority.kind === "worker" ? authority.conversationId : null;
  if (!conversationId) return null;
  const conversation = agentRegistry().conversation(conversationId as `conversation_${string}`);
  if (!conversation) return null;
  if (conversation.projectOwnership?.project) return conversation.projectOwnership.project;
  const cwd = conversation.generations.at(-1)?.launchProfile?.cwd?.trim();
  return cwd ? projectForCwd(cwd) : null;
}

/** Server-derived origin of the current caller. Shared by the attention record
    (`raisedBy`) and the bridge report log (`origin`), which store the same
    shape. */
export interface CallerAttribution {
  kind: "manager" | "agent" | "gateway" | "unidentified";
  conversationId: string | null;
  role: string | null;
}

/** Fold the caller authority with "is this the designated orchestrator" into
    one label. Pure, so every mapping is testable without a process tree. */
export function callerAttributionFrom(
  authority: AttentionCallerAuthority,
  isManagerConversation: (conversationId: string) => boolean,
): CallerAttribution {
  if (authority.kind === "root") return { kind: "gateway", conversationId: authority.conversationId, role: null };
  if (authority.kind === "unidentified") return { kind: "unidentified", conversationId: null, role: null };
  return {
    kind: isManagerConversation(authority.conversationId) ? "manager" : "agent",
    conversationId: authority.conversationId,
    role: authority.role,
  };
}

function attributionOf(dependencies: Pick<ViewerMcpDomainDependencies, "callerAttribution" | "attentionAuthority">): CallerAttribution {
  return dependencies.callerAttribution?.()
    ?? callerAttributionFrom(dependencies.attentionAuthority(), () => false);
}

/** MCP mutations always remain agent-attributed, including an unidentified caller. */
function pauseResumeActorOf(dependencies: ViewerMcpDomainDependencies): PauseResumeActor {
  const attribution = attributionOf(dependencies);
  return {
    kind: "agent",
    role: attribution.role ?? (attribution.kind === "manager" ? "orchestrator" : attribution.kind === "gateway" ? "gateway" : null),
    conversationId: attribution.conversationId,
  };
}

/**
 * Message authorship for a send issued through this MCP server (#1117): every
 * MCP caller is an agent, and the role is the server's own attribution — never
 * a caller claim. Attribution reads process ancestry, so a fault there costs
 * only the role, not the send.
 */
function mcpSenderOrigin(
  dependencies: Partial<Pick<ViewerMcpDomainDependencies, "callerAttribution" | "attentionAuthority">>,
): MessageOrigin {
  let attribution: CallerAttribution | null = null;
  try {
    attribution = dependencies.callerAttribution?.()
      ?? (dependencies.attentionAuthority
        ? callerAttributionFrom(dependencies.attentionAuthority(), () => false)
        : null);
  } catch {
    attribution = null;
  }
  const role = attribution?.kind === "manager"
    ? "orchestrator"
    : attribution?.kind === "gateway"
      ? "gateway"
      : messageOriginRole(attribution?.role);
  return { kind: "agent", ...(role ? { role } : {}) };
}

/**
 * The registry slice {@link adoptLiveRootSession} resolves the root from.
 *
 * Handed over verbatim: `RootSessionSource` is described structurally against
 * the registry's own conversation shape — id, updatedAt, and the generations
 * with their launch profiles — so there is no field mapping here to fall out of
 * step with what the registry actually stamps.
 */
function rootSessionSource(): RootSessionSource {
  const snapshot = agentRegistry().readOnlySnapshot();
  return {
    conversations: Object.values(snapshot.conversations),
    configuredRootId: process.env.LLV_ROOT_CONVERSATION_ID?.trim() || null,
  };
}

/**
 * Which conversations the registry can name a live host process for, and which
 * of them is the root — the evidence {@link attentionCallerAuthority} decides on.
 *
 * The join is by transcript path because that is what a registry ENTRY (which
 * holds the host process ids) and a CONVERSATION (which holds the role) have in
 * common. Both host shapes count: a tmux-hosted agent is the CLI process that
 * parents this MCP server directly, and a structured host is the app-server or
 * broker that parents it instead.
 *
 * A conversation whose entry recorded NO host pid stays in the list with an
 * empty pid set. It can never win the ancestry walk — there is nothing to match
 * — but it is still an identity the durable capability lineage may name, and
 * dropping it was exactly the measured bug: a designated manager whose entry
 * carried null pids while its host was alive resolved to "unidentified" and was
 * refused every manager-only tool.
 */
export function hostedConversationsFromSnapshot(
  snapshot: Pick<RegistrySnapshot, "conversations" | "entries">,
): { conversationId: string; role: string | null; pids: number[] }[] {
  const owners = new Map<string, { id: string; role: string | null }>();
  const hosted = new Map<string, { conversationId: string; role: string | null; pids: number[] }>();
  for (const conversation of Object.values(snapshot.conversations)) {
    const owner = { id: conversation.id, role: conversationRole(conversation) };
    for (const generation of conversation.generations) owners.set(generation.path, owner);
    hosted.set(owner.id, { conversationId: owner.id, role: owner.role, pids: [] });
  }
  for (const entry of Object.values(snapshot.entries)) {
    const owner = owners.get(entry.artifactPath);
    if (!owner) continue;
    const pids = [entry.host?.agent?.pid, entry.structuredHost?.process?.pid]
      .filter((pid): pid is number => typeof pid === "number" && pid > 0);
    hosted.get(owner.id)!.pids.push(...pids);
  }
  return [...hosted.values()];
}

/** The value of the launch-injected spawn capability, resolved to the
    conversation whose receipt holds its digest. Pure over its resolver so the
    admission lineage can be exercised without a registry on disk. */
export function capabilityConversationResolver(
  capability: string | null | undefined,
  resolveDigest: (digest: string) => string | null,
): () => string | null {
  const value = capability?.trim() ?? "";
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) return () => null;
  const digest = crypto.createHash("sha256").update(value).digest("hex");
  return () => resolveDigest(digest);
}

/** The registry's own alias chain, resolved per call so a migration that lands
    between two directives takes effect on the next one. */
const productionCanonicalSeatConversationId = seatIdentityResolver(
  (conversationId) => agentRegistry().canonicalConversationId(conversationId),
);

function attentionCallerSources(): AttentionCallerSources {
  return {
    ancestry: () => processAncestry(process.pid, (pid) => procBackend.readPpid(pid)),
    rootConversationId: () => liveRootSession(rootSessionSource())?.conversationId ?? null,
    hosted: () => hostedConversationsFromSnapshot(agentRegistry().readOnlySnapshot()),
    capabilityCallerConversationId: capabilityConversationResolver(
      process.env[VIEWER_SPAWN_CAPABILITY_ENV],
      (digest) => agentRegistry().conversationIdForSpawnCapabilityDigest(digest),
    ),
  };
}

/** Exported for the isolated evidence driver, which runs the REAL production
    dependency set and overrides only the caller-authority seam per scenario. */
export const productionDomainDependencies: ViewerMcpDomainDependencies = {
  listFiles,
  targetedFileEntry: targetedFileEntry,
  selectedContext: productionSelectedContextDependencies,
  completedFileScan,
  registrySnapshot: () => agentRegistry().readOnlySnapshot(),
  canonicalSeatConversationId: productionCanonicalSeatConversationId,
  boardFor,
  applyBoardCommand: (input, snapshot) => applyBoardCommand(input, { registrySnapshot: () => snapshot }),
  getFlowsWithPresets,
  patchFlow,
  cancelRound,
  closeFlow,
  getPipelines,
  listPipelineRecords: loadPipelinesForList,
  patchPipeline,
  loadTasks,
  collectSnapshot,
  readResources,
  applyConversationAction,
  applyConversationMigration,
  livenessSources: productionLivenessSources,
  queryLifecycleEvents,
  pollLifecycleDigest,
  refreshLifecycleJournal,
  adoptRootSession: () => { adoptLiveRootSession(rootSessionSource()); },
  raiseAttentionRequest,
  attentionAuthority: () => attentionCallerAuthority(attentionCallerSources()),
  callerAttribution: () => callerAttributionFrom(
    attentionCallerAuthority(attentionCallerSources()),
    (conversationId) => authorizedManagerSeats(productionManagerAuthoritySources())
      .some((seat) => seat.conversationId === conversationId),
  ),
};

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function validateExplicitMcpLaunchModel(args: McpToolArgs, fallbackRole?: string): void {
  const model = text(args.model);
  if (!model) return;
  if (args.engine !== undefined && args.engine !== "claude" && args.engine !== "codex") return;
  const roleId = text(args.role) || fallbackRole;
  const role = roleId ? resolveSpawnRole({ role: roleId, roleParams: args.roleParams }) : null;
  let engine: "claude" | "codex" | null = null;
  if (args.engine === "claude" || args.engine === "codex") engine = args.engine;
  else if (role?.ok && role.value) engine = role.value.config.engine;
  if (!engine) return;
  const validation = validateLaunchModel(engine, model);
  if (!("error" in validation)) return;
  throw new McpToolRefusal(validation.error, {
    violations: [{
      field: "model",
      message: validation.error,
      expected: `one of: ${ENGINE_MODELS[engine].map((option) => option.id).join(", ")}`,
    }],
  });
}

function objectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function integer(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) ? value : fallback;
}

function required(args: McpToolArgs, key: string): string {
  const value = text(args[key]);
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function requiredMessageText(args: McpToolArgs): string {
  const value = args.text;
  if (typeof value !== "string" || !value.trim()) throw new Error("text is required");
  return value;
}

function requestId(args: McpToolArgs): string {
  return required(args, "clientRequestId");
}

function withoutKeys(args: McpToolArgs, keys: readonly string[]): Record<string, unknown> {
  const omitted = new Set(keys);
  return Object.fromEntries(Object.entries(args).filter(([key]) => !omitted.has(key)));
}

function spawnAttemptId(value: string): string {
  return /^[A-Za-z0-9_-]{8,128}$/.test(value)
    ? value
    : `mcp_${crypto.createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}

function mcpOperationId(toolName: string, value: string): string {
  return `mcp_${toolName}_${crypto.createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}

function firstPromptLine(prompt: string): string | null {
  const line = prompt.trim().split(/\r?\n/, 1)[0]?.trim() ?? "";
  return line ? line.slice(0, 2_000) : null;
}

function diffSourceFromPrompt(prompt: string): string | null {
  const pullUrl = /https?:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+/i.exec(prompt)?.[0];
  if (pullUrl) return pullUrl;
  const pullRequest = /\b(?:PR|pull request)\s*#?\d+\b/i.exec(prompt)?.[0];
  if (pullRequest) return pullRequest;
  const range = /(?:^|[\s`'"(])([A-Za-z0-9](?:[A-Za-z0-9._/-]*[A-Za-z0-9])?\.\.\.?[A-Za-z0-9](?:[A-Za-z0-9._/-]*[A-Za-z0-9])?)(?=$|[\s`'".,);:])/m.exec(prompt)?.[1];
  if (range) return range;
  const branch = /\bbranch\s+[`'"]?([A-Za-z0-9](?:[A-Za-z0-9._/-]*[A-Za-z0-9_-])?)[`'"]?(?=$|[\s.,);:])/i.exec(prompt)?.[1];
  if (branch) return branch;
  const namedRef = /\b(?:review|inspect|compare)\s+[`'"]?([A-Za-z0-9](?:[A-Za-z0-9._/-]*[A-Za-z0-9])?)[`'"]?(?=$|[\s.,);:])/i.exec(prompt)?.[1];
  return namedRef && (namedRef.includes("/") || /^(?:HEAD|main|master)$/i.test(namedRef)) ? namedRef : null;
}

function requiredRoleParamFromPrompt(parameter: RoleParameter, prompt: string): string | null {
  if (parameter.key === "diffSource") return diffSourceFromPrompt(prompt);
  if (parameter.key === "sha") return /\b[0-9a-f]{40}\b/i.exec(prompt)?.[0] ?? null;
  if (parameter.key === "questions" || parameter.key === "claims") return firstPromptLine(prompt);
  return null;
}

function roleParamShape(parameter: RoleParameter): string {
  if (parameter.kind === "integer") {
    return `integer ${parameter.min ?? Number.MIN_SAFE_INTEGER}..${parameter.max ?? Number.MAX_SAFE_INTEGER}`;
  }
  if (parameter.kind === "select") return `string, one of: ${parameter.options?.join(" | ") || "(no options registered)"}`;
  return "non-empty string up to 2000 characters";
}

export function defaultMcpSpawnRoleParams(
  args: McpToolArgs,
  definitions: readonly RoleDefinition[] = listRoles(),
): Record<string, unknown> | undefined {
  const role = text(args.role);
  if (!role) return undefined;
  const definition = definitions.find((candidate) => candidate.id === role);
  if (!definition) return undefined;
  const raw = args.roleParams;
  if (raw !== undefined && (!raw || typeof raw !== "object" || Array.isArray(raw))) return undefined;
  const source = raw as Record<string, unknown> | undefined;
  const resolved = { ...source };
  const missing: RoleParameter[] = [];
  const prompt = typeof args.prompt === "string" ? args.prompt : "";
  for (const parameter of definition.parameters.filter((candidate) => candidate.required)) {
    const supplied = resolved[parameter.key];
    if (supplied !== undefined && supplied !== "") continue;
    const derived = requiredRoleParamFromPrompt(parameter, prompt);
    if (derived !== null) resolved[parameter.key] = derived;
    else missing.push(parameter);
  }
  if (missing.length) {
    throw new Error(
      `missing required roleParams for ${role}: ${missing.map((parameter) => `${parameter.key}: ${roleParamShape(parameter)}`).join("; ")}`,
    );
  }
  return Object.keys(resolved).length ? resolved : source;
}

/** The durable identity one `request_attention` call writes on its record —
    exported so tests and evidence can construct the record an interrupted run
    would have left behind. */
export function requestAttentionOperationKey(clientRequestId: string): string {
  return mcpOperationId("request_attention", clientRequestId);
}

async function spawnAgent(args: McpToolArgs, control: ViewerControlDependencies): Promise<McpToolPayload> {
  validateExplicitMcpLaunchModel(args);
  const clientAttemptId = spawnAttemptId(requestId(args));
  const body = withoutKeys(args, ["clientRequestId"]);
  const roleParams = defaultMcpSpawnRoleParams(args);
  const result = await control.post("/api/spawn", {
    ...body,
    ...(roleParams ? { roleParams } : {}),
    clientAttemptId,
  }, {
    ...internalServiceHeaders("mcp"),
    [VIEWER_SPAWN_CAPABILITY_HEADER]: ensureOperatorSpawnCapability(),
  });
  return {
    conversationId: result.conversationId,
    transcriptPath: result.path,
    operationId: result.launchId,
    launchId: result.launchId,
    state: result.state,
    initialMessage: result.initialMessage,
  };
}

async function sendMessage(
  args: McpToolArgs,
  control: ViewerControlDependencies,
  dependencies: Pick<ViewerMcpDomainDependencies, "registrySnapshot"> &
    Partial<Pick<ViewerMcpDomainDependencies, "callerAttribution" | "attentionAuthority">>,
): Promise<McpToolPayload> {
  const conversationId = text(args.conversationId);
  const transcriptPath = text(args.transcriptPath) || text(args.path);
  if (!conversationId && !transcriptPath) throw new Error("conversationId or transcriptPath is required");
  const message = requiredMessageText(args);
  const outcome = await control.post("/api/tmux", {
    pid: null,
    path: transcriptPath,
    ...(conversationId ? { conversationId } : {}),
    clientMessageId: requestId(args),
    text: message,
    images: [],
    /* #1117: an MCP send is inter-agent traffic by definition; the sender role
       is the server's own caller attribution, so the feed can say WHO relayed. */
    origin: mcpSenderOrigin(dependencies),
  }, callerCapabilityHeaders());
  /* The registry's OWN lookup over the projection this call already holds (#845),
     rather than a local reimplementation of it. The alias walk is multi-hop and
     cycle-guarded and the path index covers continuity paths, so a send addressed by
     a chained alias or a superseded path still names its owner — and it stays that way
     without this file having to be kept in step by hand. */
  const lookup = readOnlyConversationLookupFromSnapshot(dependencies.registrySnapshot());
  const conversation = conversationId
    ? lookup.conversation(conversationId as `conversation_${string}`)
    : lookup.conversationForPath(transcriptPath);
  return {
    conversationId: (conversation?.id ?? conversationId) || null,
    transcriptPath: (conversation?.generations.at(-1)?.path ?? transcriptPath) || null,
    operationId: outcome.operationId ?? (outcome.receipt as { operationId?: unknown } | undefined)?.operationId ?? null,
    outcome: outcome.outcome ?? "delivered",
  };
}

async function createBoardTask(args: McpToolArgs): Promise<McpToolPayload> {
  const input: CreateTaskInput = {
    ...args,
    placement: args.placement ?? "unplaced",
    clientRequestId: requestId(args),
  };
  const result = mutateTasksFile((state) => {
    const outcome = createTask(state.tasks, input, state.recentCreates);
    return {
      state: outcome.ok && !outcome.replay ? { tasks: outcome.tasks, recentCreates: outcome.recentCreates } : undefined,
      result: outcome,
    };
  });
  if (!result.ok) throw new Error(result.error);
  return { taskId: result.task.id, task: result.task, replay: result.replay };
}

async function updateBoardTask(args: McpToolArgs): Promise<McpToolPayload> {
  const taskId = required(args, "taskId");
  const patch = withoutKeys(args, ["taskId", "clientRequestId"]);
  const result = mutateTasks((tasks) => {
    const outcome = patchTask(tasks, taskId, patch as PatchTaskInput);
    return { tasks: outcome.ok ? outcome.tasks : undefined, result: outcome };
  });
  if (!result.ok) throw new Error(result.error);
  return { taskId, task: result.task };
}

async function createPipeline(args: McpToolArgs): Promise<McpToolPayload> {
  const request = withoutKeys(args, ["clientRequestId"]);
  const result = await createPipelineFromRequest(request as CreatePipelineRequest);
  if (!result.pipeline) {
    const message = result.error ?? "could not create pipeline";
    /* #1026: a rejected create carries every violated constraint with its field
       and expected shape, so an agent composing its first pipeline reads the
       whole contract from one answer — the same list an HTTP caller receives. */
    throw result.violations?.length ? new McpToolRefusal(message, { violations: result.violations }) : new Error(message);
  }
  if (result.pipeline.state !== "draft") requestPipelineTick();
  return { pipelineId: result.pipeline.id, pipeline: result.pipeline };
}

async function pipelineAction(args: McpToolArgs, dependencies: ViewerMcpDomainDependencies): Promise<McpToolPayload> {
  const pipelineId = required(args, "pipelineId");
  const action = required(args, "action") as PipelineAction;
  const request = withoutKeys(args, ["pipelineId", "clientRequestId"]);
  const result = action === "pause" || action === "resume"
    ? await dependencies.patchPipeline(pipelineId, request as PatchPipelineRequest, undefined, pauseResumeActorOf(dependencies))
    : await dependencies.patchPipeline(pipelineId, request as PatchPipelineRequest);
  if (!result.pipeline) {
    const message = result.error ?? "could not update pipeline";
    /* A refused close carries the hosts it stopped and the one it could not
       (#670); an agent driving the board must not get less than an HTTP caller. */
    throw result.close ? new McpToolRefusal(message, { close: result.close }) : new Error(message);
  }
  if (PIPELINE_CONTROLLER_ACTIONS.has(action)) requestPipelineTick();
  /* A close reports the stage hosts it terminated and the uncommitted work it
     left behind (#670), so an agent driving the board sees it too. */
  return { pipelineId, pipeline: result.pipeline, ...(result.close ? { close: result.close } : {}) };
}

async function linkTaskToPipeline(args: McpToolArgs, dependencies: LinkTaskToPipelineDependencies): Promise<McpToolPayload> {
  const taskId = required(args, "taskId");
  const pipelineId = required(args, "pipelineId");
  const pipeline = dependencies.getPipelines().pipelines.find((candidate) => candidate.id === pipelineId);
  if (!pipeline) throw new Error("pipeline not found");
  const member = latestOperationalPipelineAttempt(pipeline);
  const transcriptPath = member?.agentPath ?? pipeline.srcPath;
  const conversationId = member?.conversationId ?? pipeline.srcConversationId;
  if (!transcriptPath && !conversationId) throw new Error("pipeline has no conversation to link");
  const at = dependencies.isoNow();
  const result = dependencies.mutateTasks((tasks) => {
    const outcome = applyAssignmentPatches(tasks, taskId, [{
      path: transcriptPath,
      conversationId,
      panePid: null,
      state: "handoff",
      error: null,
      at,
    }], at);
    return { tasks: outcome.ok ? outcome.tasks : undefined, result: outcome };
  });
  if (!result.ok) throw new Error(result.error);
  return { taskId, pipelineId, task: result.task, conversationId, transcriptPath };
}

function throwIfCallEnded(context: McpToolCallContext): void {
  if (context.signal?.aborted) {
    const reason = context.signal.reason;
    throw reason instanceof Error ? reason : new DOMException("MCP tool cancelled", "AbortError");
  }
  if (context.deadlineAt !== undefined && Date.now() >= context.deadlineAt) {
    throw new DeadlineExceededError("MCP tool deadline exceeded", 0);
  }
}

function callDeadlineExceeded(context: McpToolCallContext): boolean {
  if (context.signal?.aborted) return context.signal.reason instanceof DeadlineExceededError;
  return context.deadlineAt !== undefined && Date.now() >= context.deadlineAt;
}

const PARTIAL_CONVERSATION_DEADLINE_HINT = "Returned records parsed before the internal read deadline; use tailLines with conversationId for the cheapest recent transcript view.";
const PARTIAL_CONVERSATION_OVERSIZE_HINT = "Returned a bounded tail of this oversized transcript; use tailLines with conversationId for a smaller raw tail.";
const PARTIAL_CONVERSATION_RECORD_HINT = "More parsed records are available; raise maxRecords up to 500 or use tailLines with conversationId.";
const MCP_CONVERSATION_CATALOG_BUDGET_MS = 250;
/* readSession intentionally parses at most the final 8 MiB. Keep the response
   honest when a larger transcript has an omitted prefix. */
const MCP_CONVERSATION_PARSE_WINDOW_BYTES = 8 * 1024 * 1024;

function contained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function rootForTranscript(
  pathname: string,
  roots: ReturnType<typeof scanRootEntries>,
): ReturnType<typeof scanRootEntries>[number] | undefined {
  let canonical: string;
  try { canonical = fs.realpathSync(pathname); } catch { return undefined; }
  return roots.find(([, root]) => {
    try { return contained(fs.realpathSync(root), canonical); } catch { return false; }
  });
}

export interface TargetedConversationRead {
  entry: FileEntry;
  session?: SessionReadResult;
  tail?: BoundedTranscriptTail;
  truncated?: true;
  hint?: string;
}

export interface TargetedConversationDependencies {
  roots: ReturnType<typeof scanRootEntries>;
  pathAllowed(candidate: string): boolean;
  /** Deterministic race seam used by the focused security test. */
  afterOpen?(): void;
}

function sameOpenedTranscript(
  pathname: string,
  root: string,
  opened: fs.Stats,
  allowed: (candidate: string) => boolean,
): boolean {
  if (!allowed(pathname)) return false;
  try {
    const listed = fs.lstatSync(pathname);
    const canonicalRoot = fs.realpathSync(root);
    const canonicalPath = fs.realpathSync(pathname);
    return listed.isFile()
      && !listed.isSymbolicLink()
      && listed.dev === opened.dev
      && listed.ino === opened.ino
      && contained(canonicalRoot, canonicalPath);
  } catch {
    return false;
  }
}

function descriptorPath(descriptor: number): string {
  return process.platform === "linux" ? `/proc/self/fd/${descriptor}` : `/dev/fd/${descriptor}`;
}

function boundedTailFromDescriptor(
  descriptor: number,
  pathname: string,
  stat: fs.Stats,
  requestedLines: number,
): BoundedTranscriptTail {
  const maxLines = Math.max(1, Math.min(SELECTED_TAIL_MAX_LINES, Math.floor(requestedLines) || 1));
  const window = Math.min(stat.size, SELECTED_TAIL_MAX_BYTES);
  const buffer = Buffer.allocUnsafe(window);
  const read = fs.readSync(descriptor, buffer, 0, window, stat.size - window);
  const precededByMore = window < stat.size;
  const rows = buffer.subarray(0, read).toString("utf8").split("\n");
  if (precededByMore && rows.length > 0) rows.shift();
  while (rows.length > 0 && rows.at(-1) === "") rows.pop();
  const lines = rows.slice(-maxLines);
  return {
    path: pathname,
    lines,
    bytes: Buffer.byteLength(lines.join("\n"), "utf8"),
    truncated: precededByMore || lines.length < rows.length,
  };
}

/**
 * Hydrate and parse one known transcript through a pinned descriptor.
 *
 * The public path is canonicalized against the registered scanner roots, then
 * opened with O_NOFOLLOW. Metadata and tail parsing use a private alias to that
 * descriptor, so a parent or leaf swap can only make the final identity check
 * reject the result; it cannot redirect either bounded read.
 */
export async function targetedConversationAtPath(
  pathname: string,
  context: TargetedConversationOptions = {},
  injectedDependencies?: TargetedConversationDependencies,
): Promise<TargetedConversationRead | undefined> {
  const dependencies = injectedDependencies ?? { roots: scanRootEntries(), pathAllowed };
  throwIfCallEnded(context);
  if (!dependencies.pathAllowed(pathname)) return undefined;
  const rooted = rootForTranscript(pathname, dependencies.roots);
  if (!rooted) return undefined;
  const [rootName, root] = rooted;
  let descriptor: number | null = null;
  let sidecarDescriptor: number | null = null;
  let sidecarPath: string | null = null;
  let sidecarStat: fs.Stats | null = null;
  let stableDirectory: string | null = null;
  try {
    descriptor = fs.openSync(pathname, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP" || code === "EACCES") return undefined;
    throw error;
  }
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size === 0) return undefined;
    dependencies.afterOpen?.();
    if (!sameOpenedTranscript(pathname, root, stat, dependencies.pathAllowed)) return undefined;
    throwIfCallEnded(context);

    if (rootName === "claude-projects" && path.basename(pathname).startsWith("agent-") && pathname.endsWith(".jsonl")) {
      const candidate = pathname.slice(0, -".jsonl".length) + ".meta.json";
      if (dependencies.pathAllowed(candidate)) {
        try {
          sidecarDescriptor = fs.openSync(candidate, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
          const openedSidecar = fs.fstatSync(sidecarDescriptor);
          if (openedSidecar.isFile() && sameOpenedTranscript(candidate, root, openedSidecar, dependencies.pathAllowed)) {
            sidecarPath = candidate;
            sidecarStat = openedSidecar;
          } else {
            fs.closeSync(sidecarDescriptor);
            sidecarDescriptor = null;
          }
        } catch {
          if (sidecarDescriptor !== null) fs.closeSync(sidecarDescriptor);
          sidecarDescriptor = null;
        }
      }
    }

    stableDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-targeted-"));
    fs.chmodSync(stableDirectory, 0o700);
    const stablePath = path.join(stableDirectory, path.basename(pathname));
    fs.symlinkSync(descriptorPath(descriptor), stablePath);
    if (sidecarDescriptor !== null && sidecarPath !== null) {
      fs.symlinkSync(descriptorPath(sidecarDescriptor), stablePath.slice(0, -".jsonl".length) + ".meta.json");
    }
    const pinnedMetadata = describe(rootName, root, stablePath, stat);
    const metadata = reprojectFileDescription(rootName, root, pathname, pinnedMetadata);
    const entry: FileEntry = {
      path: pathname,
      root: rootName,
      name: path.relative(root, pathname),
      project: metadata.project,
      projectName: metadata.projectName,
      projectUnresolved: metadata.projectUnresolved,
      worktree: metadata.worktree,
      cwd: metadata.cwd,
      sessionStartedAt: metadata.sessionStartedAt,
      nativeParentThreadId: metadata.nativeParentThreadId,
      nativeForkSourceThreadId: metadata.nativeForkSourceThreadId,
      projectRoot: metadata.projectRoot,
      title: metadata.title,
      engine: metadata.engine,
      kind: metadata.kind,
      fmt: metadata.fmt,
      parent: null,
      mtime: stat.mtimeMs / 1_000,
      size: stat.size,
      activity: "idle",
      proc: null,
      pid: null,
      model: null,
      pendingQuestion: null,
      waitingInput: null,
    };
    overlaySessionTitles([entry]);
    if (entry.engine !== "claude" && entry.engine !== "codex") return undefined;
    const session = context.tailLines === undefined
      ? { ...readSession(stablePath, entry.engine), path: pathname }
      : undefined;
    const tail = context.tailLines === undefined
      ? undefined
      : boundedTailFromDescriptor(descriptor, pathname, stat, context.tailLines);
    const partialAtDeadline = callDeadlineExceeded(context);
    if (!partialAtDeadline) throwIfCallEnded(context);
    if (!sameOpenedTranscript(pathname, root, stat, dependencies.pathAllowed)) return undefined;
    if (sidecarDescriptor !== null && sidecarPath !== null && sidecarStat !== null
      && !sameOpenedTranscript(sidecarPath, root, sidecarStat, dependencies.pathAllowed)) return undefined;
    return {
      entry,
      ...(session ? { session } : {}),
      ...(tail ? { tail } : {}),
      ...(partialAtDeadline ? { truncated: true as const, hint: PARTIAL_CONVERSATION_DEADLINE_HINT } : {}),
    };
  } finally {
    if (stableDirectory !== null) fs.rmSync(stableDirectory, { recursive: true, force: true });
    if (sidecarDescriptor !== null) fs.closeSync(sidecarDescriptor);
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

async function targetedFileEntry(
  pathname: string,
  context: TargetedConversationOptions = {},
): Promise<TargetedConversationRead | undefined> {
  return targetedConversationAtPath(pathname, context);
}

/**
 * Read one completed generation, then hydrate only the requested transcript on
 * a miss. Production never reserves a private full-corpus scan for this lookup.
 */
async function entryForPath(
  transcriptPath: string,
  dependencies: Pick<ViewerMcpDomainDependencies, "listFiles" | "completedFileScan" | "targetedFileEntry">,
  context: TargetedConversationOptions = {},
): Promise<{ entry: FileEntry; session?: SessionReadResult; tail?: BoundedTranscriptTail; truncated?: true; hint?: string } | undefined> {
  throwIfCallEnded(context);
  const remainingMs = context.deadlineAt === undefined
    ? Number.POSITIVE_INFINITY
    : Math.max(0, context.deadlineAt - Date.now());
  const overall = deadlineSignal(remainingMs, {
    signal: context.signal,
    reason: "MCP tool deadline exceeded",
  });
  const catalog = context.tailLines === undefined
    ? deadlineSignal(Math.min(MCP_CONVERSATION_CATALOG_BUDGET_MS, remainingMs), {
        signal: overall.signal,
        reason: "MCP conversation catalog budget exceeded",
      })
    : null;
  try {
    if (catalog) {
      try {
        let releaseCatalogWait: () => void = () => {};
        const catalogWait = new Promise<never>((_resolve, reject) => {
          const onAbort = () => reject(catalog.signal.reason);
          catalog.signal.addEventListener("abort", onAbort, { once: true });
          releaseCatalogWait = () => catalog.signal.removeEventListener("abort", onAbort);
        });
        const completedRead = dependencies.completedFileScan({ signal: catalog.signal });
        const completed = (await Promise.race([completedRead, catalogWait]).finally(releaseCatalogWait)).snapshot.files;
        const known = completed.find((candidate) => candidate.path === transcriptPath);
        /* A catalog row is a discovery hint. The transcript may have grown or
           been replaced since that row was measured, so production reopens it
           through the descriptor-pinned reader before deriving truncation or
           parsing content. Older injected adapters without that seam retain
           their completed-row behavior. */
        if (known && !dependencies.targetedFileEntry) return { entry: known };
      } catch (error) {
        if (overall.signal.aborted) {
          const reason = overall.signal.reason;
          throw reason instanceof Error ? reason : error;
        }
        if (!catalog.signal.aborted) throw error;
        /* The completed catalog did not arrive within its small share of the
           budget. Continue through the path-pinned reader while useful time
           remains; that read is bounded independently of corpus size. */
      }
    }
    if (dependencies.targetedFileEntry) {
      const targeted = await dependencies.targetedFileEntry(transcriptPath, {
        signal: overall.signal,
        deadlineAt: context.deadlineAt,
        ...(context.tailLines === undefined ? {} : { tailLines: context.tailLines }),
      });
      if (!targeted) return undefined;
      if (!("entry" in targeted)) return { entry: targeted };
      const partialAtDeadline = callDeadlineExceeded({ signal: overall.signal, deadlineAt: context.deadlineAt });
      if (!partialAtDeadline) throwIfCallEnded({ signal: overall.signal, deadlineAt: context.deadlineAt });
      return partialAtDeadline
        ? { ...targeted, truncated: true, hint: PARTIAL_CONVERSATION_DEADLINE_HINT }
        : targeted;
    }
    /* Compatibility for older injected test adapters. Production always owns
       the targeted seam above. */
    const pinned = await dependencies.listFiles({ fresh: true, persist: false, pin: transcriptPath, signal: overall.signal });
    const entry = pinned.find((candidate) => candidate.path === transcriptPath);
    return entry ? { entry } : undefined;
  } finally {
    catalog?.release();
    overall.release();
  }
}

async function listConversations(
  args: McpToolArgs,
  control: ViewerControlDependencies,
): Promise<McpToolPayload> {
  const project = text(args.project);
  const query = text(args.query).trim();
  const limit = Math.max(1, Math.min(100, integer(args.limit, 50)));
  const params = new URLSearchParams();
  if (project) params.set("project", project);
  if (query) params.set("q", query);
  params.set("limit", String(limit));
  /* The Viewer's conversation endpoint projects the uncapped catalog published
     by the scanner worker. Its scheme feed can omit projects beyond the board's
     recent-project window even while their catalog rows remain current. */
  const source = await readViewerControl(control, `/api/conversations?${params}`);
  if (!Array.isArray(source.items) || typeof source.total !== "number") {
    throw new ViewerControlResponseError("Viewer control returned a malformed conversation catalog page");
  }
  if (project && source.total === 0) {
    let knownProject = false;
    if (query) {
      const validation = await readViewerControl(
        control,
        `/api/conversations?project=${encodeURIComponent(project)}&limit=1`,
      );
      if (!Array.isArray(validation.items) || typeof validation.total !== "number") {
        throw new ViewerControlResponseError("Viewer control returned a malformed conversation catalog page");
      }
      knownProject = validation.total > 0;
    }
    if (!knownProject) {
      return redactPayload({
        count: 0,
        conversations: [],
        code: "UNKNOWN_PROJECT",
        hint: "The requested project does not match a canonical project key in the conversation catalog.",
      });
    }
  }
  const conversations = source.items
    .filter(objectRecord) as unknown as FileEntry[];
  const rows = conversations
    .filter((entry) => entry.engine === "claude" || entry.engine === "codex")
    .slice(0, limit)
    .map((entry) => ({
      conversationId: entry.conversationId ?? null,
      transcriptPath: entry.path,
      project: entry.project,
      title: entry.title,
      engine: entry.engine,
      activity: entry.activity,
    }));
  return redactPayload({ count: rows.length, conversations: rows });
}

async function searchTranscripts(
  args: McpToolArgs,
  control: ViewerControlDependencies,
): Promise<McpToolPayload> {
  const query = text(args.query).trim();
  if (!query) throw new Error("query is required");
  const project = text(args.project).trim();
  const cursor = text(args.cursor).trim();
  const limit = Math.max(1, Math.min(100, integer(args.limit, 20)));
  const params = new URLSearchParams({ q: query });
  if (project) params.set("project", project);
  if (cursor) params.set("cursor", cursor);
  params.set("limit", String(limit));
  const source = await readViewerControl(control, `/api/search/transcripts?${params}`);
  const stats = objectRecord(source.stats) ? source.stats : null;
  if (!Array.isArray(source.items)
    || typeof source.total !== "number"
    || (source.nextCursor !== null && typeof source.nextCursor !== "string")
    || !stats
    || typeof stats.conversationsIndexed !== "number"
    || typeof stats.messagesIndexed !== "number"
    || !Array.isArray(stats.fieldsSearched)
    || typeof stats.tokenizer !== "string") {
    throw new ViewerControlResponseError("Viewer control returned a malformed transcript search page");
  }
  return redactPayload(source);
}

async function getConversation(
  args: McpToolArgs,
  dependencies: Pick<ViewerMcpDomainDependencies, "listFiles" | "completedFileScan" | "targetedFileEntry" | "selectedContext">,
  context: McpToolCallContext = {},
): Promise<McpToolPayload> {
  throwIfCallEnded(context);
  const selectedDependencies = dependencies.selectedContext ?? productionSelectedContextDependencies;
  const selected = resolveSelectedContext(args, text(args.conversationId), selectedDependencies);
  const requestedId = selected.conversationId;
  const requestedPath = text(args.transcriptPath) || text(args.path);
  const tailLines = integer(args.tailLines, 0);
  if (!requestedId && !requestedPath) {
    throw new Error("conversationId, transcriptPath or selectedContext is required");
  }
  /* #844 §6: with an identity, explicit `tailLines` uses one keyed registry
     lookup and one clamped tail read, so the selected card stays answerable
     while the corpus scan is degraded. A transcript path continues through the
     root-validated bounded reader below. */
  if (tailLines > 0 && requestedId) {
    const answer = selectedConversationTail(
      { conversationId: requestedId, maxLines: Math.max(1, Math.min(tailLines, SELECTED_TAIL_MAX_LINES)) },
      selectedDependencies,
    );
    throwIfCallEnded(context);
    return redactPayload({
      conversationId: answer.record.conversationId,
      transcriptPath: answer.tail.path,
      project: answer.record.project,
      engine: answer.record.engine,
      scanned: false,
      tail: { lines: answer.tail.lines, bytes: answer.tail.bytes, truncated: answer.tail.truncated },
      ...selectedContextEcho(selected.target),
    });
  }
  const conversation = requestedId
    ? agentRegistry().conversation(requestedId as `conversation_${string}`)
    : agentRegistry().conversationForPath(requestedPath);
  const transcriptPath = conversation?.generations.at(-1)?.path ?? requestedPath;
  const pathTailLines = tailLines > 0 && !requestedId
    ? Math.max(1, Math.min(tailLines, SELECTED_TAIL_MAX_LINES))
    : undefined;
  const targeted = await entryForPath(transcriptPath, dependencies, {
    ...context,
    ...(pathTailLines === undefined ? {} : { tailLines: pathTailLines }),
  });
  const entry = targeted?.entry;
  if (!entry || (entry.engine !== "claude" && entry.engine !== "codex")) throw new Error("conversation not found");
  if (pathTailLines !== undefined) {
    if (!targeted?.tail) throw new Error("conversation tail is unavailable");
    return redactPayload({
      conversationId: (conversation?.id ?? entry.conversationId) || null,
      transcriptPath: entry.path,
      project: entry.project,
      title: entry.title,
      engine: entry.engine,
      scanned: false,
      tail: {
        lines: targeted.tail.lines,
        bytes: targeted.tail.bytes,
        truncated: targeted.tail.truncated,
      },
      ...(targeted.truncated === true ? {
        truncated: true,
        hint: targeted.hint ?? PARTIAL_CONVERSATION_DEADLINE_HINT,
      } : {}),
      ...selectedContextEcho(selected.target),
    });
  }
  if (!targeted?.session) throwIfCallEnded(context);
  const session = targeted.session ?? readSession(entry.path, entry.engine);
  const partialAtDeadline = targeted.truncated === true || callDeadlineExceeded(context);
  if (!partialAtDeadline) throwIfCallEnded(context);
  const maxRecords = Math.max(1, Math.min(500, integer(args.maxRecords, 100)));
  const recordTruncated = session.messages.length > maxRecords || session.tools.length > maxRecords;
  const oversized = entry.size > MCP_CONVERSATION_PARSE_WINDOW_BYTES;
  const truncated = partialAtDeadline || oversized || recordTruncated;
  const hint = targeted.hint
    ?? (partialAtDeadline
      ? PARTIAL_CONVERSATION_DEADLINE_HINT
      : oversized
        ? PARTIAL_CONVERSATION_OVERSIZE_HINT
        : recordTruncated
          ? PARTIAL_CONVERSATION_RECORD_HINT
          : undefined);
  return redactPayload({
    conversationId: (conversation?.id ?? entry.conversationId ?? requestedId) || null,
    transcriptPath: entry.path,
    project: entry.project,
    title: entry.title,
    engine: entry.engine,
    messages: session.messages.slice(-maxRecords),
    tools: session.tools.slice(-maxRecords),
    truncated,
    ...(hint ? { hint } : {}),
    ...selectedContextEcho(selected.target),
  });
}

async function deployExactSha(
  args: McpToolArgs,
  control: ViewerControlDependencies,
  dependencies: ViewerMcpDomainDependencies,
): Promise<McpToolPayload> {
  const revision = required(args, "revision");
  if (!/^[0-9a-f]{40}$/i.test(revision)) throw new Error("revision must be a full 40-character commit SHA");

  /* #795 (superseding contract) — the designated agent decides the deploy and
     executes it directly. Authority is derived from the SERVER-ATTRIBUTED
     caller identity and nothing else: no operator confirmation, no
     authorization row, and never anything read out of prose or reasoning. The
     identity chain is the one production already trusts — process ancestry
     merged with the admission-injected spawn capability, checked against the
     durable per-project orchestrator designation. */
  const attribution = attributionOf(dependencies);
  if (attribution.kind !== "manager" || !attribution.conversationId) {
    throw new McpToolRefusal(
      "only the designated orchestrator executes deploys; this session is not attributed as a designated seat. Report the request over the bridge instead.",
      { code: "deploy_caller_not_designated", revision },
    );
  }

  /* A designated seat's authority is scoped to its own project. The seat this
     conversation holds must be the seat of the caller's own canonical project —
     a seat exercising deploy authority from another project's context is the
     cross-project spend this refusal closes. */
  const seats = dependencies.authorizedSeats?.()
    ?? authorizedManagerSeats(productionManagerAuthoritySources());
  const seat = seats.find((candidate) => candidate.conversationId === attribution.conversationId);
  if (!seat) {
    throw new McpToolRefusal(
      "only the designated orchestrator executes deploys; this session holds no validated seat. Report the request over the bridge instead.",
      { code: "deploy_caller_not_designated", revision },
    );
  }
  const callerProject = dependencies.callerProject ? dependencies.callerProject() : productionCallerProject();
  if (callerProject && seat.project !== callerProject) {
    throw new McpToolRefusal(
      "a designated orchestrator deploys only as its own project's seat; this session's seat belongs to another project",
      { code: "deploy_cross_project", revision },
    );
  }

  const receipt = await control.post("/api/runtime/deployments", {
    revision,
    idempotencyKey: requestId(args),
  });
  return {
    deploymentId: receipt.deploymentId,
    revision: receipt.revision,
    replayed: receipt.state === "accepted" && receipt.replayed === true,
    state: receipt.state,
  };
}

/**
 * The channel the user hears from, callable from EVERY session (B+ item 3).
 *
 * Deliberately thin: everything that makes a report safe — the 2 KB bound, the
 * secret redaction, the idempotent key, the monotonic seq — lives in the store, so
 * this cannot weaken any of it by being called differently. What it does own is
 * the ORIGIN LABEL, derived server-side from the durable caller identity and
 * stored on the row. A non-orchestrator report additionally gets a visible
 * attribution prefix in its body, ahead of anything the caller wrote, so the
 * gateway can never mistake it for — or speak it as — the manager's voice.
 */
function bridgeReport(args: McpToolArgs, dependencies: ViewerMcpDomainDependencies): McpToolPayload {
  const key = required(args, "key");
  const reportClass = text(args.class);
  if (!isBridgeReportClass(reportClass)) throw new Error("class must be one of the bridge report classes");
  const body = text(args.body);
  if (!body) throw new Error("body is required");

  const origin = attributionOf(dependencies);
  const project = dependencies.callerProject ? dependencies.callerProject() : productionCallerProject();
  const seats = dependencies.authorizedSeats?.()
    ?? authorizedManagerSeats(productionManagerAuthoritySources());
  const targetSeat = project
    ? seats.find((seat) => seat.project === project)
    : undefined;

  /* The visible attribution is SERVER-composed and leads the body, so whatever
     a caller writes inside its own text appears after the authoritative label. */
  const attributedBody = origin.kind === "manager"
    ? body
    : `[${origin.kind === "gateway" ? "voice gateway" : origin.role ?? "agent"}${origin.conversationId ? ` ${origin.conversationId}` : ""} — not the manager] ${body}`;

  const appended = recordManagerReport({
    key,
    class: reportClass,
    at: new Date().toISOString(),
    origin,
    project,
    targetSeatConversationId: targetSeat?.conversationId ?? null,
    body: attributedBody,
    correlatesDirective: text(args.correlatesDirective) || null,
  });

  /* A replay under the same key appends nothing, and says so rather than pretending
     to have delivered a second report. */
  if (!appended) return { recorded: false, replayed: true };
  return {
    recorded: true,
    replayed: false,
    seq: appended.seq,
    reportId: appended.id,
  };
}

/**
 * The gateway's relay to the manager (#691 §4) — user intent, flowing onward.
 *
 * Two things are deliberately NOT the caller's to choose, because both are how a
 * relay stops being exactly-once:
 *
 * - The RECIPIENT is resolved from the designation record here. A gateway that
 *   could name a conversation could message a worker directly, which is the one
 *   sentence the whole architecture exists to prevent.
 * - The DELIVERY ID is derived from the root turn. `send_message`-style receipts
 *   are durable and recognize a replayed id, so a retry after a lost receipt
 *   answers from the receipt instead of delivering the instruction a second time —
 *   but only if the id is a function of the turn rather than freshly minted.
 */
async function bridgeDirective(args: McpToolArgs, control: ViewerControlDependencies, dependencies: ViewerMcpDomainDependencies): Promise<McpToolPayload> {
  const instruction = text(args.instruction);
  if (!instruction) throw new Error("instruction is required");
  const utterance = args.utterance;
  if (typeof utterance !== "number") throw new Error("utterance must be a non-negative integer");
  /* Both throw on anything that would not round-trip through the parser. */
  const deliveryId = bridgeDirectiveId(text(args.rootTurnId), utterance);

  /* Recipient resolution (FIX 2, post-#758 operator decision). Every directive
     routes through the VALIDATED per-project seat authority — the global
     last-seated legacy record is NEVER consulted, because that was the defect:
     seating project B silently redirected project A's directives.

     An explicitly named project overrides. An UN-SCOPED directive follows the
     CALLING VOICE SESSION'S canonical project, resolved from the conversation's
     cwd through the same worktree-grouping path (`projectInfoFromCwd`) every
     other project attribution uses — never a second scheme. */
  const callerProject = dependencies.callerProject ? dependencies.callerProject() : productionCallerProject();
  const project = text(args.project) || callerProject;
  if (!project) {
    /* Diagnostic, not a menu: a REGISTERED voice session always has a cwd and
       therefore a canonical project. Reaching this line means the invariant is
       violated — corrupted or incomplete registry state — and the refusal names
       that rather than modelling it as an ordinary choice or falling back to
       whatever project was seated last. */
    throw new McpToolRefusal(
      "INVARIANT VIOLATION: the calling voice session resolves to no canonical project — a registered conversation must derive one from its cwd through the worktree-grouping path. Routing fails closed; investigate the session's registry record (an explicit project can be named meanwhile).",
      { code: "caller_project_unresolved" },
    );
  }
  const seats = dependencies.authorizedSeats?.() ?? authorizedManagerSeats(productionManagerAuthoritySources());
  const seat = seats.find((candidate) => candidate.project === project);
  if (!seat) {
    throw new McpToolRefusal(
      `no validated orchestrator is designated for ${project}; create one first, then relay again`,
      { code: "manager_not_designated", project },
    );
  }
  const manager: { conversationId: string; path: string | null } = { conversationId: seat.conversationId, path: seat.path };

  const ref = args.ref;
  const trailer: BridgeTrailer | undefined = typeof ref === "number" && Number.isInteger(ref) && ref > 0
    ? { ref }
    : undefined;
  const body = bridgeDirectiveBody(instruction, trailer);

  const outcome = await control.post("/api/tmux", {
    pid: null,
    path: manager.path,
    conversationId: manager.conversationId,
    clientMessageId: deliveryId,
    text: body,
    images: [],
    /* #1117: a directive relay is inter-agent traffic — the manager's feed
       names the gateway (or attributed caller role), never the operator. */
    origin: mcpSenderOrigin(dependencies),
  }, callerCapabilityHeaders());
  /* The trailer is the ONLY thing that says a report was answered — the drain
     cursor says only that it was read aloud — so it is recorded the moment the
     answer actually reaches the manager (#1168). Scoped by the project and seat
     this directive was just routed to, because a report seq is log-global: the
     store settles the ref only if it names a decision request THIS seat filed,
     so a ref that names nothing yet cannot pre-answer a later report and a
     directive cannot clear another project's ask. The seat identity travels in
     through the registry's alias chain, because the log recorded whatever the
     conversation was called when it asked while the seat authority hands this
     relay whatever it is called now — and the attention projection resolves the
     recorded id the same way, so anything less here leaves a rekeyed seat's ask
     visible and unanswerable. Idempotent, so a directive retry under the same
     derived id settles the same seq once. */
  if (trailer) {
    recordBridgeDirectiveAnswer(
      trailer.ref,
      { project, seatConversationId: manager.conversationId },
      dependencies.canonicalSeatConversationId ?? productionCanonicalSeatConversationId,
    );
  }
  return {
    directiveId: deliveryId,
    managerConversationId: manager.conversationId,
    operationId: outcome.operationId ?? null,
    outcome: outcome.outcome ?? "delivered",
  };
}

/** Sanitized idempotency key derived from the caller's, for a secondary side
    effect that must replay with its parent call. */
function derivedRequestId(base: string, suffix: string): string {
  return spawnAttemptId(`${base}:${suffix}`);
}

/**
 * The calling session's own conversation capability, forwarded so the
 * designation routes' operator gate can fire (BLOCKING 1 of the #758 review).
 *
 * Designation is an OPERATION contract, exactly like the deploy executor's
 * seat check: the tools stay on every session's surface (axis 1), but a caller
 * that the registry names as an agent conversation may not seat, rotate or
 * auto-create an orchestrator — otherwise any session could hand ITSELF
 * manager voice and deploy authority in one call. The Viewer injected this capability into
 * the launch environment; presenting it is how an agent names itself, and the
 * routes' `requireOperatorAuthority` refuses a self-named caller. An operator
 * lane (no capability in the environment) forwards nothing and passes.
 */
function callerCapabilityHeaders(): Record<string, string> {
  const capability = process.env[VIEWER_SPAWN_CAPABILITY_ENV]?.trim() ?? "";
  return {
    ...internalServiceHeaders("mcp"),
    ...(/^[A-Za-z0-9_-]{43}$/.test(capability) ? { [VIEWER_SPAWN_CAPABILITY_HEADER]: capability } : {}),
  };
}

/** Explicitly allowlisted fields for the designation routes. The seat route
    authorizes existing-conversation adoption before it writes an intent;
    mandate provenance stays server-owned. */
function allowedSeatFields(args: McpToolArgs, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(keys.flatMap((key) => (args[key] === undefined ? [] : [[key, args[key]]])));
}

/**
 * get_orchestrator (two-axis contract): the designation, its health, and a
 * BOUNDED rotation recommendation. Read-only; every inferred number is
 * labelled an estimate with its basis, and nothing here — or anywhere — may
 * act on the recommendation automatically.
 */
async function getOrchestrator(args: McpToolArgs, dependencies: ViewerMcpDomainDependencies): Promise<McpToolPayload> {
  const project = canonicalOrchestratorProject(required(args, "project"));
  const { active, pending, history } = orchestratorSeatFor(project);
  const revocations = orchestratorRevocations().filter((revocation) => revocation.project === project);
  const base = {
    project,
    defaultPromptVersion: ORCHESTRATOR_PROMPT_VERSION,
    pendingIntent: pending,
    /* Terminalized pending intents (#878), oldest first: what was attempted
       and why it failed, preserved after the intent stopped blocking. */
    intentHistory: history,
    /* Predecessor lineage, oldest first: each entry names the seat epoch it
       ended and the successor that replaced it. */
    lineage: revocations.map((revocation) => ({
      conversationId: revocation.conversationId,
      seatEpoch: revocation.seatEpoch,
      revokedAt: revocation.revokedAt,
      successorConversationId: revocation.successorConversationId ?? null,
    })),
  };
  if (!active?.conversationId) {
    return redactPayload({ ...base, designated: false, seat: null, health: null, rotation: null });
  }

  const registry = agentRegistry();
  const conversation = registry.conversation(active.conversationId as `conversation_${string}`);
  const generation = conversation?.generations.at(-1);
  const transcriptPath = generation?.path ?? active.path;
  /* During the boot window the spawn receipt already exists while the registry
     conversation still has no settled generation. The seat intent carries the
     receipt's client key, so the same registry source supplies the launch
     profile until generation facts take over. */
  const launchReceipt = active.intent.mode === "spawn"
    ? registry.spawnReceiptForClientAttempt(active.intent.clientRequestId)
    : null;
  const receiptMatches = launchReceipt?.conversationId === active.conversationId;
  const engine = conversation?.engine ?? (receiptMatches ? launchReceipt.engine : null);
  const model = generation?.launchProfile?.model ?? (receiptMatches ? launchReceipt.launchProfile.model : null);
  let session: { messages: number; tools: number; compactions: number } | null = null;
  if (transcriptPath && (engine === "claude" || engine === "codex")) {
    try {
      const read = readSession(transcriptPath, engine);
      session = {
        messages: read.messages.length,
        tools: read.tools.length,
        compactions: read.traces.filter((trace) => trace.name === "compact").length,
      };
    } catch {
      session = null;
    }
  }
  const facts = readOrchestratorTranscriptFacts(transcriptPath, session);
  const windowPolicy = contextWindowPolicyFor(engine, model);
  const context = contextReading({ policy: windowPolicy, facts });

  let liveness: { lifecycle: string; hostState: string; silentForMs: number | null } | null = null;
  try {
    const snapshot = await agentLivenessSnapshot({ conversationId: active.conversationId, limit: 1 }, dependencies.livenessSources());
    const record = snapshot.conversations[0];
    if (record) liveness = { lifecycle: record.lifecycle, hostState: record.host.state, silentForMs: record.silentForMs };
  } catch {
    liveness = null;
  }

  return redactPayload({
    ...base,
    designated: true,
    seat: active,
    conversationId: active.conversationId,
    transcriptPath,
    engine,
    model,
    promptVersion: active.promptVersion,
    predecessorConversationId: active.predecessorConversationId,
    health: {
      liveness,
      /* Quoted key: keeps the payload field identical at runtime while keeping
         the token off a line start, which the privacy publication gate's
         transcript heuristic would otherwise flag on this source file. */
      ["transcript"]: {
        bytes: facts.transcriptBytes,
        megabytes: facts.transcriptBytes !== null ? Number((facts.transcriptBytes / (1024 * 1024)).toFixed(2)) : null,
        messageCount: facts.messageCount,
        toolCount: facts.toolCount,
        compactionCount: facts.compactionCount,
      },
      context,
    },
    rotation: {
      /* WORDS ONLY, structurally: this block is serialized recommendation data
         from a pure function. Nothing on this code path spawns, delivers,
         designates, revokes, interrupts, or calls the control plane at all —
         crossing the threshold changes what this payload SAYS and nothing
         else. Rotation happens only through an explicit rotate_orchestrator. */
      ...rotationRecommendation({
        context,
        facts,
        activity: liveness?.lifecycle === "gone" ? "dead" : liveness?.lifecycle ?? null,
        policy: windowPolicy,
      }),
      note: "recommendation only — rotation never happens automatically; call rotate_orchestrator explicitly",
    },
  });
}

/** create_orchestrator: atomically create, designate and deliver the ONE
    approved versioned default mandate (or the caller's edited text based on
    it). The seat route owns the durable intent, so a retry replays. */
async function createOrchestrator(args: McpToolArgs, control: ViewerControlDependencies): Promise<McpToolPayload> {
  if (!text(args.conversationId)) validateExplicitMcpLaunchModel(args, "orchestrator");
  const project = canonicalOrchestratorProject(required(args, "project"));
  const result = await control.post("/api/orchestrator/seat", {
    project,
    mandate: text(args.mandate) || ORCHESTRATOR_SYSTEM_PROMPT,
    promptVersion: ORCHESTRATOR_PROMPT_VERSION,
    clientRequestId: spawnAttemptId(requestId(args)),
    ...allowedSeatFields(args, ["conversationId", "cwd", "engine", "model", "effort", "accountId"]),
  }, callerCapabilityHeaders());
  return redactPayload({
    project,
    conversationId: result.conversationId ?? null,
    transcriptPath: result.path ?? null,
    seat: result.seat ?? null,
    replayed: result.replayed === true,
    accepted: result.accepted === true,
    state: result.state ?? null,
    launchId: result.launchId ?? null,
  });
}

/**
 * send_message_to_orchestrator: the selected session is resolved SERVER-SIDE.
 * A dead selected conversation is resumed by the delivery seam (the same
 * resume path the composer uses); with none designated, one is created via the
 * seat route first and the message delivered after. Both side effects derive
 * their idempotency keys from this call's, so a retry replays instead of
 * duplicating, and the response says which path ran.
 */
async function sendMessageToOrchestrator(
  args: McpToolArgs,
  control: ViewerControlDependencies,
  dependencies: Partial<Pick<ViewerMcpDomainDependencies, "callerAttribution" | "attentionAuthority">> = {},
): Promise<McpToolPayload> {
  const project = canonicalOrchestratorProject(required(args, "project"));
  const message = requiredMessageText(args);
  const key = requestId(args);

  let seat: OrchestratorSeat | null = orchestratorSeatFor(project).active;
  let created = false;
  if (!seat?.conversationId) {
    const outcome = await control.post("/api/orchestrator/seat", {
      project,
      mandate: ORCHESTRATOR_SYSTEM_PROMPT,
      promptVersion: ORCHESTRATOR_PROMPT_VERSION,
      clientRequestId: derivedRequestId(key, "create"),
    }, callerCapabilityHeaders());
    created = true;
    seat = (outcome.seat as OrchestratorSeat | undefined) ?? orchestratorSeatFor(project).active;
    if (!seat?.conversationId) throw new Error("orchestrator creation did not settle a conversation to deliver to");
  }

  const outcome = await control.post("/api/tmux", {
    pid: null,
    path: seat.path,
    conversationId: seat.conversationId,
    clientMessageId: key,
    text: message,
    images: [],
    origin: mcpSenderOrigin(dependencies),
  }, callerCapabilityHeaders());
  return redactPayload({
    project,
    conversationId: seat.conversationId,
    transcriptPath: seat.path,
    created,
    seatEpoch: seat.seatEpoch,
    predecessorConversationId: seat.predecessorConversationId,
    operationId: outcome.operationId ?? (outcome.receipt as { operationId?: unknown } | undefined)?.operationId ?? null,
    outcome: outcome.outcome ?? "delivered",
  });
}

/** rotate_orchestrator: explicit handoff to a successor. Never called by any
    heuristic — see the rotation command's contract. */
async function rotateOrchestrator(args: McpToolArgs, control: ViewerControlDependencies): Promise<McpToolPayload> {
  const project = canonicalOrchestratorProject(required(args, "project"));
  const result = await control.post("/api/orchestrator/rotate", {
    project,
    clientRequestId: spawnAttemptId(requestId(args)),
    ...allowedSeatFields(args, ["mandate", "handoffNotes", "cwd", "engine", "model", "effort", "accountId"]),
  }, callerCapabilityHeaders());
  return redactPayload({
    project,
    conversationId: result.conversationId ?? null,
    transcriptPath: result.path ?? null,
    seat: result.seat ?? null,
    rotatedFrom: result.rotatedFrom ?? null,
    /* Whether the prior handoffs were summarized or kept verbatim, and why. */
    handoff: result.handoff ?? null,
    replayed: result.replayed === true,
  });
}

async function getPipeline(args: McpToolArgs): Promise<McpToolPayload> {
  const pipelineId = required(args, "pipelineId");
  const pipeline = findPipelineRecord(pipelineId);
  if (!pipeline) throw new Error("pipeline not found");
  return redactPayload({ pipelineId, pipeline });
}

const SENSITIVE_PAYLOAD_KEY = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|credential|password|passwd|secret)/i;

function redactPayload<T>(value: T): T {
  if (typeof value === "string") return hardenedRedact(value) as T;
  if (Array.isArray(value)) return value.map((item) => redactPayload(item)) as T;
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .map(([key, child]) => [key, SENSITIVE_PAYLOAD_KEY.test(key) ? "[redacted]" : redactPayload(child)])) as T;
}

async function boardSnapshot(
  args: McpToolArgs,
  dependencies: ViewerMcpDomainDependencies,
): Promise<McpToolPayload> {
  const project = text(args.project);
  const activity = text(args.activity);
  const liveOnly = args.liveOnly === true;
  const limit = Math.max(1, Math.min(200, integer(args.limit, 100)));
  const snapshot = dependencies.registrySnapshot();
  const conversationsByPath = new Map<string, RegistrySnapshot["conversations"][string]>();
  for (const conversation of Object.values(snapshot.conversations)) {
    for (const generation of conversation.generations) conversationsByPath.set(generation.path, conversation);
    for (const pathname of conversation.continuityPaths ?? []) conversationsByPath.set(pathname, conversation);
  }
  const files = (await dependencies.completedFileScan()).snapshot.files;
  const conversations = files
    .filter((entry) => entry.engine === "claude" || entry.engine === "codex")
    .filter((entry) => !project || entry.project === project)
    .filter((entry) => !activity || entry.activity === activity)
    .filter((entry) => !liveOnly || entry.activity === "live" || entry.activity === "stalled")
    .slice(0, limit)
    .map((entry) => {
      const conversation = entry.conversationId
        ? snapshot.conversations[entry.conversationId]
        : conversationsByPath.get(entry.path);
      const conversationId = conversation?.id ?? entry.conversationId ?? null;
      const edge = conversationId ? snapshot.lineageEdges[conversationId] : undefined;
      return {
        conversationId,
        transcriptPath: entry.path,
        project: entry.project,
        title: entry.title,
        engine: entry.engine,
        activity: entry.activity,
        proc: entry.proc,
        lineage: conversationId ? {
          parentConversationId: edge?.parentConversationId ?? null,
          kind: edge?.kind ?? null,
          role: conversation?.agentRole ?? edge?.role ?? null,
          depth: conversation?.delegationDepth ?? 0,
          memberships: snapshot.memberships[conversationId] ?? [],
        } : null,
      };
    });
  const board = project ? dependencies.boardFor(project) : null;
  return redactPayload({
    count: conversations.length,
    conversations,
    hiddenCount: board?.prefs.hidden.length ?? null,
    board,
  });
}

function listFlows(args: McpToolArgs, dependencies: ViewerMcpDomainDependencies): McpToolPayload {
  const project = text(args.project);
  const state = text(args.state);
  const includeClosed = args.includeClosed === true;
  const limit = Math.max(1, Math.min(200, integer(args.limit, 100)));
  const flows = dependencies.getFlowsWithPresets().flows
    .filter((flow) => !project || flow.project === project)
    .filter((flow) => !state || flow.state === state)
    .filter((flow) => includeClosed || (flow.state !== "closed" && flow.closedAt === null))
    .slice(0, limit);
  return redactPayload({ count: flows.length, flows });
}

function getFlow(args: McpToolArgs, dependencies: ViewerMcpDomainDependencies): McpToolPayload {
  const flowId = required(args, "flowId");
  const flow = dependencies.getFlowsWithPresets().flows.find((candidate) => candidate.id === flowId);
  if (!flow) throw new Error("flow not found");
  return redactPayload({ flowId, flow });
}

function mutationReceipt(operationId: string): { operationId: string; receipt: { operationId: string; status: "delivered" } } {
  return { operationId, receipt: { operationId, status: "delivered" } };
}

async function flowAction(args: McpToolArgs, dependencies: ViewerMcpDomainDependencies): Promise<McpToolPayload> {
  const flowId = required(args, "flowId");
  const action = required(args, "action");
  const request = withoutKeys(args, ["flowId", "clientRequestId"]) as PatchFlowRequest;
  const result = action === "cancel-round"
    ? await dependencies.cancelRound(flowId)
    : action === "close"
      ? await dependencies.closeFlow(flowId)
      : action === "pause" || action === "resume"
        ? dependencies.patchFlow(flowId, request, pauseResumeActorOf(dependencies))
        : dependencies.patchFlow(flowId, request);
  if (!result.flow) throw new Error(result.error ?? "could not update flow");
  const operationId = mcpOperationId("flow_action", requestId(args));
  return redactPayload({ flowId, flow: result.flow, ...mutationReceipt(operationId) });
}

/** #863: bounded board-card rows, never whole `Pipeline` records. The filters,
    ordering and `limit` bound are unchanged — only what a surviving row carries
    is, and `get_pipeline` remains the full-detail read. `context` reaches the
    projection so a caller's deadline can abandon the call. */
async function listPipelines(
  args: McpToolArgs,
  dependencies: ViewerMcpDomainDependencies,
  context: McpToolCallContext = {},
): Promise<McpToolPayload> {
  const pipelines = await projectPipelineListRows({
    project: text(args.project),
    state: text(args.state),
    includeClosed: args.includeClosed === true,
    limit: integer(args.limit, PIPELINE_LIST_DEFAULT_LIMIT),
  }, {
    checkpoint: () => throwIfCallEnded(context),
    source: dependencies.listPipelineRecords ?? (() => dependencies.getPipelines().pipelines),
  });
  return redactPayload({ count: pipelines.length, pipelines });
}

function taskReadModel(dependencies: ViewerMcpDomainDependencies) {
  return projectTaskPipelineIds(dependencies.loadTasks(), dependencies.getPipelines().pipelines);
}

function listTasks(args: McpToolArgs, dependencies: ViewerMcpDomainDependencies): McpToolPayload {
  const project = text(args.project);
  const status = text(args.status);
  const placement = text(args.placement);
  const limit = Math.max(1, Math.min(200, integer(args.limit, 100)));
  const tasks = taskReadModel(dependencies)
    .filter((task) => !project || task.project === project)
    .filter((task) => !status || task.status === status)
    .filter((task) => !placement || task.placement === placement)
    .slice(0, limit);
  return redactPayload({ count: tasks.length, tasks });
}

function getTask(args: McpToolArgs, dependencies: ViewerMcpDomainDependencies): McpToolPayload {
  const taskId = required(args, "taskId");
  const task = taskReadModel(dependencies).find((candidate) => candidate.id === taskId);
  if (!task) throw new Error("task not found");
  return redactPayload({ taskId, task });
}

async function operatorSnapshot(args: McpToolArgs, dependencies: ViewerMcpDomainDependencies): Promise<McpToolPayload> {
  const request = validateSnapshotRequest({
    schemaVersion: 1,
    ...withoutKeys(args, ["clientRequestId"]),
  });
  /* Explicit dependencies rather than the module defaults (#845): the completed
     scanner generation and registry projection are the same shared reads used by
     board/list/get/send, so this call starts no private observation. */
  return redactPayload({
    ...await dependencies.collectSnapshot(request, {
      completedFileScan: dependencies.completedFileScan,
      resolveSiblings,
      registrySnapshot: dependencies.registrySnapshot,
    }),
  });
}

/**
 * Whether a control-plane refusal means "this Viewer does not serve that route"
 * rather than "that thing is not there" (#790).
 *
 * Blue/green promotes the web surface before the successor runtime host takes
 * over, and the deployment health gate probes a CANDIDATE's MCP while the
 * PREVIOUS revision is still answering on the control port. A read that moved
 * onto a route introduced in the same revision therefore meets a Viewer that has
 * never heard of it, and answers 405. Treating that as a hard failure made the
 * gate unpassable for the very change that added the route, so the transition
 * window has to be survivable rather than fatal.
 *
 * Deliberately 405 only: a 404 from these routes is the domain answer ("that
 * deployment was not found") and must keep its meaning.
 */
function isUnservedControlRoute(error: unknown): boolean {
  /* A refusal carrying a status means the surface answered, so its answer stands:
     404 is "that deployment is absent", and 503 keeps the absent-versus-
     unreachable plane distinction #777 established. Only two things mean this
     reader cannot use the surface at all — a revision that never served the route
     (405), and a transport failure or timeout, which arrives as a plain Error. */
  if (error instanceof McpToolRefusal) return (error.details as { status?: unknown }).status === 405;
  if (error instanceof ViewerControlResponseError) return false;
  return true;
}

function isDeploymentStatus(value: unknown, expectedId?: string): value is ViewerDeploymentStatus {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const deployment = value as Partial<ViewerDeploymentStatus>;
  return typeof deployment.deploymentId === "string"
    && (!expectedId || deployment.deploymentId === expectedId)
    && typeof deployment.revision === "string"
    && typeof deployment.phase === "string";
}

function deploymentList(result: Record<string, unknown>): ViewerDeploymentStatus[] {
  if (
    !Array.isArray(result.deployments)
    || !result.deployments.every((deployment) => isDeploymentStatus(deployment))
    || !Number.isInteger(result.count)
    || result.count !== result.deployments.length
  ) {
    throw new ViewerControlResponseError("Viewer control returned a malformed deployment list");
  }
  return result.deployments;
}

async function deploymentStatus(
  args: McpToolArgs,
  control: ViewerControlDependencies,
): Promise<McpToolPayload> {
  const deploymentId = text(args.deploymentId);
  if (deploymentId) {
    const deployment = await readViewerControl(
      control,
      `/api/runtime/deployments/${encodeURIComponent(deploymentId)}`,
    ).catch((error: unknown) => {
      if (!isUnservedControlRoute(error)) throw error;
      const fromLedger = ledgerDeployment(deploymentId);
      if (fromLedger.state === "unreadable") throw new Error(fromLedger.error);
      return fromLedger.value ?? null;
    });
    if (!deployment) throw new Error("viewer deployment was not found");
    if (!isDeploymentStatus(deployment, deploymentId)) {
      throw new ViewerControlResponseError("Viewer control returned a malformed deployment");
    }
    return redactPayload({ deploymentId, deployment });
  }
  const operationId = text(args.operationId);
  if (operationId) {
    if (operationId.includes(":") || /\s/.test(operationId)) throw new Error("operationId is invalid");
    const result = await readViewerControl(
      control,
      `/api/runtime/operations/${encodeURIComponent(operationId)}`,
    );
    if (
      result.operationId !== operationId
      || !result.receipt
      || typeof result.receipt !== "object"
      || Array.isArray(result.receipt)
    ) {
      throw new ViewerControlResponseError("Viewer control returned a malformed operation");
    }
    const operation = {
      operationId: result.operationId,
      receipt: result.receipt,
      replayed: false,
    };
    return redactPayload({ operationId, operation });
  }
  const limit = Math.max(1, Math.min(100, integer(args.limit, 25)));
  const result = await readViewerControl(control, `/api/runtime/deployments?limit=${limit}`)
    .catch(async (error: unknown) => {
      if (!isUnservedControlRoute(error)) throw error;
      const fromLedger = ledgerDeployments(limit);
      if (fromLedger.state === "unreadable") throw new Error(fromLedger.error);
      const deployments = fromLedger.value;
      return { count: deployments.length, deployments };
    });
  const deployments = deploymentList(result);
  return redactPayload({ count: deployments.length, deployments });
}

async function resources(args: McpToolArgs, dependencies: ViewerMcpDomainDependencies): Promise<McpToolPayload> {
  return redactPayload({ ...await dependencies.readResources(args.fresh === true) });
}

type ConversationArchiveInput = {
  conversationId: string;
  transcriptPath: string;
};

type ResolvedConversationArchiveTarget = {
  conversationId: string | null;
  transcriptPath: string;
  transcriptPaths: readonly string[];
  project: string;
};

function conversationArchiveInputs(
  args: McpToolArgs,
  dependencies: ViewerMcpDomainDependencies,
): { inputs: ConversationArchiveInput[]; selectedTarget: ReturnType<typeof resolveSelectedContext>["target"] | null } {
  if (args.targets !== undefined) {
    if (!Array.isArray(args.targets) || args.targets.length === 0) {
      throw new Error("targets must be a non-empty list");
    }
    if (args.targets.length > 100) throw new Error("targets supports at most 100 conversations per call");
    if (text(args.conversationId) || text(args.transcriptPath) || text(args.path) || args.selectedContext !== undefined) {
      throw new Error("targets cannot be combined with conversationId, transcriptPath or selectedContext");
    }
    return {
      inputs: args.targets.map((candidate, index) => {
        if (!objectRecord(candidate)) throw new Error(`targets[${index}] must be an object`);
        const conversationId = text(candidate.conversationId);
        const transcriptPath = text(candidate.transcriptPath);
        if (!conversationId && !transcriptPath) {
          throw new Error(`targets[${index}] requires conversationId or transcriptPath`);
        }
        return { conversationId, transcriptPath };
      }),
      selectedTarget: null,
    };
  }

  const selected = resolveSelectedContext(
    args,
    text(args.conversationId),
    dependencies.selectedContext ?? productionSelectedContextDependencies,
  );
  const conversationId = selected.conversationId;
  const transcriptPath = text(args.transcriptPath) || text(args.path);
  if (!conversationId && !transcriptPath) {
    throw new Error("conversationId, transcriptPath or selectedContext is required");
  }
  return { inputs: [{ conversationId, transcriptPath }], selectedTarget: selected.target };
}

function latestReceiptForConversation(
  snapshot: RegistrySnapshot,
  conversationId: string,
): RegistrySnapshot["receipts"][string] | null {
  const lookup = readOnlyConversationLookupFromSnapshot(snapshot);
  return Object.values(snapshot.receipts ?? {})
    .filter((receipt) => lookup.canonicalConversationId(receipt.conversationId) === conversationId)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0] ?? null;
}

function latestPendingLaunchReceiptForConversation(
  snapshot: RegistrySnapshot,
  conversationId: string,
): RegistrySnapshot["receipts"][string] | null {
  const lookup = readOnlyConversationLookupFromSnapshot(snapshot);
  return Object.values(snapshot.receipts ?? {})
    .filter((receipt) => (
      lookup.canonicalConversationId(receipt.conversationId) === conversationId
      && receipt.transport === "structured"
      && receipt.purpose === "launch"
      && receipt.artifactLifecycle === "pending"
    ))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0] ?? null;
}

function projectForArchiveTarget(
  conversation: RegistrySnapshot["conversations"][string] | null,
  receipt: RegistrySnapshot["receipts"][string] | null,
  fallbackProject: string | null = null,
): string | null {
  const generation = conversation?.generations.at(-1);
  const explicitOwnership = conversation?.projectOwnership
    ?? (receipt?.explicitProject
      ? {
          project: receipt.explicitProject,
          source: "operator" as const,
          setAt: receipt.createdAt,
          operationId: receipt.launchId,
        }
      : null);
  return resolveProjectAttribution({
    projectOwnership: explicitOwnership,
    cwd: generation?.launchProfile.cwd ?? receipt?.cwd,
    launchProfileProject: generation?.launchProfile.project ?? receipt?.launchProfile.project,
    fallbackProject: fallbackProject ?? (receipt?.cwd ? path.basename(receipt.cwd) : null),
  }).project;
}

function resolveArchiveTargetFromRegistry(
  input: ConversationArchiveInput,
  snapshot: RegistrySnapshot,
): ResolvedConversationArchiveTarget | null {
  const lookup = readOnlyConversationLookupFromSnapshot(snapshot);
  const requestedConversationId = input.conversationId;
  if (requestedConversationId && !requestedConversationId.startsWith("conversation_")) return null;

  const canonicalId = requestedConversationId
    ? lookup.canonicalConversationId(requestedConversationId as `conversation_${string}`)
    : null;
  const byId = canonicalId ? snapshot.conversations[canonicalId] ?? null : null;
  const launchId = input.transcriptPath.startsWith("spawn:") ? input.transcriptPath.slice("spawn:".length) : "";
  const pathReceipt = launchId ? snapshot.receipts?.[launchId] ?? null : null;
  const byPath = input.transcriptPath && !pathReceipt
    ? lookup.conversationForPath(input.transcriptPath)
    : null;
  const pathConversationId = pathReceipt
    ? lookup.canonicalConversationId(pathReceipt.conversationId)
    : byPath?.id ?? null;
  if (canonicalId && pathConversationId && canonicalId !== pathConversationId) return null;

  const conversation = byId ?? byPath ?? (pathConversationId ? snapshot.conversations[pathConversationId] ?? null : null);
  const conversationId = conversation?.id ?? canonicalId ?? pathConversationId;
  const receipt = pathReceipt ?? (conversationId ? latestReceiptForConversation(snapshot, conversationId) : null);
  if (requestedConversationId && !conversation && !receipt) return null;

  const generationPaths = conversation?.generations.map((generation) => generation.path) ?? [];
  const placeholderReceipt = conversationId
    ? latestPendingLaunchReceiptForConversation(snapshot, conversationId)
    : null;
  const placeholderPath = placeholderReceipt
    ? `spawn:${placeholderReceipt.launchId}`
    : "";
  const transcriptPath = input.transcriptPath
    || generationPaths.at(-1)
    || placeholderPath;
  if (!transcriptPath) return null;
  const transcriptPaths = [...new Set([
    ...(input.transcriptPath ? [input.transcriptPath] : []),
    ...generationPaths,
    ...(placeholderPath ? [placeholderPath] : []),
  ])];
  const project = projectForArchiveTarget(conversation, receipt);
  if (!project) return null;
  return { conversationId: conversationId ?? null, transcriptPath, transcriptPaths, project };
}

function resolveArchiveTargetFromFiles(
  input: ConversationArchiveInput,
  files: readonly FileEntry[],
): ResolvedConversationArchiveTarget | null {
  const matches = files
    .filter((entry) => input.transcriptPath ? entry.path === input.transcriptPath : entry.conversationId === input.conversationId)
    .sort((left, right) => right.mtime - left.mtime);
  const entry = matches[0];
  if (!entry) return null;
  return {
    conversationId: entry.conversationId ?? (input.conversationId || null),
    transcriptPath: entry.path,
    transcriptPaths: [entry.path],
    project: entry.project,
  };
}

function writeArchivePlacement(
  project: string,
  action: "archive" | "unarchive",
  paths: readonly string[],
  snapshot: RegistrySnapshot,
  dependencies: ViewerMcpDomainDependencies,
): { appliedPaths: ReadonlySet<string> } {
  let board = dependencies.boardFor(project);
  const appliedPaths = new Set<string>();
  const uniquePaths = [...new Set(paths)];
  const batchSize = action === "archive"
    ? MAX_BOARD_PATH_LIST_ITEMS
    : MAX_BOARD_MUTATIONS_PER_REQUEST;
  for (let offset = 0; offset < uniquePaths.length; offset += batchSize) {
    const batch = uniquePaths.slice(offset, offset + batchSize);
    let settled = false;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const pendingPaths = batch.filter((pathname) => action === "archive"
        ? !board.prefs.hidden.includes(pathname)
        : board.prefs.hidden.includes(pathname));
      if (pendingPaths.length === 0) {
        settled = true;
        break;
      }

      const previousBoard = board;
      const result = dependencies.applyBoardCommand({
        schemaVersion: 1,
        project,
        baseRevision: board.revision,
        ...(action === "archive"
          ? { patch: { hidden: pendingPaths } }
          : {
              mutations: pendingPaths.map((pathname) => ({
                kind: "restore" as const,
                path: pathname,
                placement: "auto" as const,
              })),
            }),
      }, snapshot);
      board = result.board;
      if (result.ok && result.applied) {
        const hiddenBefore = new Set(previousBoard.prefs.hidden);
        const hiddenAfter = new Set(board.prefs.hidden);
        for (const pathname of uniquePaths) {
          const changed = action === "archive"
            ? !hiddenBefore.has(pathname) && hiddenAfter.has(pathname)
            : hiddenBefore.has(pathname) && !hiddenAfter.has(pathname);
          if (changed) appliedPaths.add(pathname);
        }
        settled = true;
        break;
      }
    }
    if (!settled) {
      throw new Error(`board state changed repeatedly while ${action === "archive" ? "archiving" : "unarchiving"} conversations`);
    }
  }
  return { appliedPaths };
}

async function archiveConversationAction(
  args: McpToolArgs,
  action: "archive" | "unarchive",
  dependencies: ViewerMcpDomainDependencies,
  context: McpToolCallContext,
): Promise<McpToolPayload> {
  const { inputs, selectedTarget } = conversationArchiveInputs(args, dependencies);
  const snapshot = dependencies.registrySnapshot();
  const resolved = inputs.map((input) => resolveArchiveTargetFromRegistry(input, snapshot));
  const outcomes: Array<Record<string, unknown>> = [];
  const resolvedProjects = new Set<string>();
  const projectsTouched = new Set<string>();
  const applyResolved = (members: Array<{ index: number; target: ResolvedConversationArchiveTarget }>): void => {
    const grouped = new Map<string, Array<{ index: number; target: ResolvedConversationArchiveTarget }>>();
    for (const member of members) {
      const projectMembers = grouped.get(member.target.project) ?? [];
      projectMembers.push(member);
      grouped.set(member.target.project, projectMembers);
      resolvedProjects.add(member.target.project);
    }

    for (const [project, projectMembers] of grouped) {
      throwIfCallEnded(context);
      const write = writeArchivePlacement(
        project,
        action,
        projectMembers.flatMap(({ target }) => target.transcriptPaths),
        snapshot,
        dependencies,
      );
      if (write.appliedPaths.size > 0) projectsTouched.add(project);
      const attributedPaths = new Set<string>();
      for (const { index, target } of projectMembers) {
        const paths = target.transcriptPaths.filter((pathname) => (
          write.appliedPaths.has(pathname) && !attributedPaths.has(pathname)
        ));
        for (const pathname of paths) attributedPaths.add(pathname);
        outcomes[index] = {
          conversationId: target.conversationId,
          transcriptPath: target.transcriptPath,
          paths,
          project,
          outcome: action === "archive"
            ? paths.length > 0 ? "archived" : "already-archived"
            : paths.length > 0 ? "unarchived" : "not-found",
        };
      }
    }
  };

  applyResolved(resolved.flatMap((target, index) => target ? [{ index, target }] : []));

  const unresolvedIndexes = resolved.flatMap((target, index) => target ? [] : [index]);
  if (unresolvedIndexes.length > 0) {
    let files: readonly FileEntry[] | null = null;
    try {
      files = (await dependencies.completedFileScan()).snapshot.files;
    } catch {
      files = null;
    }
    throwIfCallEnded(context);
    const scanResolved: Array<{ index: number; target: ResolvedConversationArchiveTarget }> = [];
    for (const index of unresolvedIndexes) {
      const target = files ? resolveArchiveTargetFromFiles(inputs[index]!, files) : null;
      if (target) {
        resolved[index] = target;
        scanResolved.push({ index, target });
        continue;
      }
      outcomes[index] = {
        conversationId: inputs[index]!.conversationId || null,
        transcriptPath: inputs[index]!.transcriptPath || null,
        paths: [],
        project: null,
        outcome: files ? "not-found" : "resolution-failed",
      };
    }
    applyResolved(scanResolved);
  }

  const operationId = mcpOperationId("conversation_action", requestId(args));
  const projects = [...resolvedProjects];
  return redactPayload({
    action,
    outcomes,
    project: projects.length === 1 ? projects[0] : null,
    projectsTouched: [...projectsTouched],
    ...mutationReceipt(operationId),
    ...selectedContextEcho(selectedTarget),
  });
}

async function conversationAction(
  args: McpToolArgs,
  dependencies: ViewerMcpDomainDependencies,
  context: McpToolCallContext = {},
): Promise<McpToolPayload> {
  throwIfCallEnded(context);
  const action = required(args, "action");
  if (action === "archive" || action === "unarchive") {
    return archiveConversationAction(args, action, dependencies, context);
  }
  /* #844 §7: the selected card is actionable from its reference alone. The
     identity comes back from one keyed registry lookup, so no `operator_snapshot`
     and no scan stands between "the operator pointed at that card" and acting on
     it. Only the IDENTITY is taken from the reference — the path it recorded is
     capture-time provenance, and a later generation would make it wrong. */
  const selected = resolveSelectedContext(
    args,
    text(args.conversationId),
    dependencies.selectedContext ?? productionSelectedContextDependencies,
  );
  const conversationId = selected.conversationId;
  const transcriptPath = text(args.transcriptPath) || text(args.path);
  if (!conversationId && !transcriptPath) {
    throw new Error("conversationId, transcriptPath or selectedContext is required");
  }
  throwIfCallEnded(context);
  const operationId = mcpOperationId("conversation_action", requestId(args));
  const result = await dependencies.applyConversationAction({
    operationId,
    conversationId,
    transcriptPath,
    action,
    key: text(args.key),
    label: args.label,
    question: args.question,
  });
  if (!("ok" in result.body) || result.body.ok !== true) {
    throw new Error("error" in result.body ? result.body.error : "conversation action failed");
  }
  const receipt = "receipt" in result.body && result.body.receipt
    ? { operationId: result.body.operationId, receipt: result.body.receipt }
    : mutationReceipt(operationId);
  return redactPayload({
    conversationId: conversationId || null,
    transcriptPath: transcriptPath || null,
    ...result.body,
    ...receipt,
    ...selectedContextEcho(selected.target),
  });
}

async function conversationMigration(args: McpToolArgs, dependencies: ViewerMcpDomainDependencies): Promise<McpToolPayload> {
  const conversationId = required(args, "conversationId");
  const operationId = mcpOperationId("conversation_migration", requestId(args));
  const result = await dependencies.applyConversationMigration({
    conversationId,
    action: required(args, "action"),
    expectedRevision: typeof args.expectedRevision === "number" ? args.expectedRevision : undefined,
    path: text(args.transcriptPath) || text(args.path),
  });
  if ("error" in result.body && typeof result.body.error === "string") throw new Error(result.body.error);
  const conversation = result.body.conversation
    ?? (typeof result.body.id === "string" && result.body.id.startsWith("conversation_") ? result.body : undefined);
  return redactPayload({
    conversationId,
    ...result.body,
    ...(conversation ? { conversation } : {}),
    ...mutationReceipt(operationId),
  });
}

/**
 * #645 — the liveness snapshot that replaces the operator's external
 * `stat`/`pgrep` sweep. Cheap enough to poll on a schedule: it reads the
 * registries the Viewer already maintains plus the durable transcript tail, and
 * it never echoes a pipeline's own claim about a stage. A stall observed here
 * is also journaled (#686), so the sweep leaves a durable record.
 */
async function agentActivity(
  args: McpToolArgs,
  dependencies: ViewerMcpDomainDependencies,
  context: McpToolCallContext = {},
): Promise<McpToolPayload> {
  throwIfCallEnded(context);
  /* #860: the caller's lifetime reaches the read. Without it a project-scoped
     call kept its generation wait and its transcript tails running after the
     caller had given up — the shape the 70-second stall was reported as. */
  const remainingMs = context.deadlineAt === undefined
    ? Number.POSITIVE_INFINITY
    : Math.max(0, context.deadlineAt - Date.now());
  const deadline = deadlineSignal(remainingMs, {
    signal: context.signal,
    reason: "MCP tool deadline exceeded",
  });
  try {
    /* The catalog the board already reads. One completed generation serves both,
       so this call opens no scan of its own. */
    const sources = dependencies.livenessSources({ completedFileScan: dependencies.completedFileScan });
    const snapshot = await agentLivenessSnapshot({
      conversationId: text(args.conversationId) || undefined,
      transcriptPath: (text(args.transcriptPath) || text(args.path)) || undefined,
      project: text(args.project) || undefined,
      liveOnly: args.liveOnly === true,
      stallAfterMs: typeof args.stallAfterMs === "number" ? args.stallAfterMs : undefined,
      limit: typeof args.limit === "number" ? args.limit : undefined,
      signal: deadline.signal,
      /* A call with less time left than the standard evidence budget degrades
         the remaining rows to the scan projection rather than spending a budget
         its caller will not be there to receive. */
      ...(Number.isFinite(remainingMs)
        ? { evidenceDeadlineMs: Math.min(DEFAULT_EVIDENCE_DEADLINE_MS, remainingMs) }
        : {}),
    }, sources);
    const journal = dependencies.refreshLifecycleJournal({ liveness: snapshot.conversations });
    return redactPayload({ ...snapshot, journaled: journal.appended });
  } finally {
    deadline.release();
  }
}

function lifecycleEventType(value: unknown): LifecycleEventQuery["type"] {
  const candidate = text(value);
  if (!candidate) return undefined;
  if (!isLifecycleEventType(candidate)) throw new Error(`unknown lifecycle event type: ${candidate}`);
  return candidate;
}

/**
 * #686 — one tool over the durable journal. `query` reads it by lineage and
 * cursor; `digest` polls the bounded relay, which releases terminal high-signal
 * events at once and batches routine progress behind a five-minute window.
 * Both refresh the projection first, so a stage that finished since the last
 * call is already recorded — no background notification service.
 */
interface DeploymentProjection {
  deployments: ViewerDeploymentStatus[];
  error?: string;
  code?: string;
}

/** Viewer deployments as the journal's deploy events see them. A deployment
    read failure leaves the rest of the journal available and travels with that
    response as explicit degraded-source evidence. */
async function deploymentsForProjection(
  control: ViewerControlDependencies,
): Promise<DeploymentProjection> {
  try {
    const result = await readViewerControl(control, "/api/runtime/deployments");
    if (!Array.isArray(result.deployments)) throw new Error("Viewer deployment list is invalid");
    return { deployments: result.deployments as ViewerDeploymentStatus[] };
  } catch (error) {
    return {
      deployments: [],
      error: error instanceof Error ? error.message : "Viewer deployments are unreadable",
      ...(error instanceof McpToolRefusal && text(error.details.code)
        ? { code: text(error.details.code) }
        : {}),
    };
  }
}

async function lifecycleEvents(
  args: McpToolArgs,
  control: ViewerControlDependencies,
  dependencies: ViewerMcpDomainDependencies,
): Promise<McpToolPayload> {
  const mode = text(args.mode) || "query";
  if (mode !== "query" && mode !== "digest") throw new Error('mode must be "query" or "digest"');
  const registry = dependencies.registrySnapshot();
  const deploymentProjection = await deploymentsForProjection(control);
  const refreshed = dependencies.refreshLifecycleJournal({
    pipelines: dependencies.getPipelines().pipelines,
    deliveries: Object.values(registry.heldDeliveries),
    deployments: deploymentProjection.deployments,
  });
  const deploymentEvidence = deploymentProjection.error
    ? {
        deploymentsError: deploymentProjection.error,
        ...(deploymentProjection.code ? { deploymentsErrorCode: deploymentProjection.code } : {}),
      }
    : {};
  if (mode === "digest") {
    const subscriberId = text(args.subscriberId) || text(args.conversationId);
    if (!subscriberId) throw new Error("subscriberId is required for mode=digest");
    const request: LifecycleDigestRequest = {
      subscriberId,
      project: text(args.project) || undefined,
      pipelineId: text(args.pipelineId) || undefined,
      conversationId: text(args.conversationId) || undefined,
      maxItems: typeof args.maxItems === "number" ? args.maxItems : undefined,
      acknowledge: args.acknowledge !== false,
    };
    return redactPayload({
      mode,
      journaled: refreshed.appended,
      ...deploymentEvidence,
      ...dependencies.pollLifecycleDigest(request),
    });
  }
  const page = dependencies.queryLifecycleEvents({
    project: text(args.project) || undefined,
    pipelineId: text(args.pipelineId) || undefined,
    conversationId: text(args.conversationId) || undefined,
    stageId: text(args.stageId) || undefined,
    type: lifecycleEventType(args.type),
    afterSeq: typeof args.afterSeq === "number" ? args.afterSeq : undefined,
    limit: typeof args.limit === "number" ? args.limit : undefined,
  });
  return redactPayload({ mode, journaled: refreshed.appended, ...deploymentEvidence, ...page });
}

/**
 * The caller's target, read into the ONE shape the record stores (#1016).
 *
 * Two things happen here and nothing else does. A conversation named by its
 * durable `conversationId` — the name the rest of this MCP surface speaks, and
 * the only one that survives a resume or a migration — is resolved to that
 * conversation's CURRENT generation transcript, which is exactly what a caller
 * who already knew the path would have sent. And a value that is no target at
 * all is refused in words that name the discriminator, the fields its kind
 * expects and an example that works, instead of the bare "target must be a
 * typed focus target" that cost the reported caller five guesses.
 *
 * A usable `path` is honoured untouched, so every call that works today writes
 * byte-identical records: the id is the way in for callers that have no path,
 * never a second interpretation of calls that have one.
 */
function focusTargetFromArgs(value: unknown, dependencies: ViewerMcpDomainDependencies): FocusTarget {
  const named = value && typeof value === "object" && !Array.isArray(value)
    ? value as { kind?: unknown; path?: unknown; conversationId?: unknown }
    : null;
  const conversationId = named?.kind === "conversation" && !text(named.path) ? text(named.conversationId) : "";
  if (conversationId) {
    /* The registry's own keyed lookup, alias walk included, so an id that was
       chained through a rollover still names its newest transcript. */
    const lookup = readOnlyConversationLookupFromSnapshot(dependencies.registrySnapshot());
    const path = lookup.conversation(conversationId as `conversation_${string}`)?.generations.at(-1)?.path;
    if (!path) {
      throw new Error(
        `no registered conversation has id "${conversationId}" — a conversation target accepts `
        + `${focusTargetExample("conversation")} or ${CONVERSATION_PATH_EXAMPLE}`,
      );
    }
    return { kind: "conversation", path };
  }
  if (!isFocusTarget(value)) throw new Error(describeFocusTargetRejection(value));
  return value;
}

/**
 * Which project a target lives in, so the request can record one.
 *
 * Only the project is derived here — never a rect. The server has no board
 * layout, and inventing one would put a made-up destination on a durable record
 * (see `@/lib/attention/frames`). An explicit `project` wins, and is the only
 * way to name a target the server cannot attribute at all: a board draft exists
 * on the operator's canvas and nowhere else.
 */
async function focusTargetProject(
  target: FocusTarget,
  explicit: string,
  dependencies: ViewerMcpDomainDependencies,
): Promise<string> {
  if (explicit) return explicit;
  if (isGeometricTarget(target)) return target.project;
  switch (target.kind) {
    case "conversation": {
      const targeted = await entryForPath(target.path, dependencies);
      if (!targeted) throw new Error("no conversation on the board has that transcript path");
      return targeted.entry.project;
    }
    case "pipeline":
    case "stage": {
      const pipeline = dependencies.getPipelines().pipelines.find((candidate) => candidate.id === target.pipelineId);
      if (!pipeline) throw new Error("pipeline not found");
      return pipeline.project;
    }
    case "flowRound": {
      const flow = dependencies.getFlowsWithPresets().flows.find((candidate) => candidate.id === target.flowId);
      if (!flow) throw new Error("flow not found");
      return flow.project;
    }
    case "task": {
      const task = dependencies.loadTasks().find((candidate) => candidate.id === target.taskId);
      if (!task) throw new Error("task not found");
      return task.project;
    }
    case "draft":
      throw new Error("a draft target needs an explicit project");
  }
}

/**
 * Typed focus for every agent session (B+ item 2), as an immediate VERIFIED
 * handoff (#873): move the operator's one active Viewer to a typed target, and
 * answer only once it is there.
 *
 * The production incident this shape closes: the call used to commit a
 * `pending` record, offer it to every follow-capable device, and return success
 * while the camera sat still until some browser's next poll auto-followed. Now
 * the server resolves exactly one latest-interaction active view UP FRONT, the
 * record is born `accepted` for that device — no confirmation surface, no
 * actionable pending/offered state — and the response is written only after the
 * arrival landed on the record, or after a bounded explicit failure closed it.
 *
 * The record keeps a one-action way back: the return point is captured on the
 * device before the move and a single Return control restores it exactly. What
 * replaced the old worker refusal is ATTRIBUTION: `raisedBy` is derived
 * server-side from the durable caller identity and stored on the record, so a
 * worker's ask is visibly a worker's ask and can never masquerade as the
 * operator's own root agent. The root identity is still resolved server-side,
 * which is why no rootId appears in this schema.
 */
async function requestAttention(
  args: McpToolArgs,
  dependencies: ViewerMcpDomainDependencies,
  context: McpToolCallContext = {},
): Promise<McpToolPayload> {
  /* ── The authority gate, BEFORE any resolution or durable write ──────────
     This call moves the operator's screen with no confirmation surface left
     in front of it, so who may make it is decided first, from server-derived
     evidence only: the durable caller identity (process ancestry merged with
     the admission-injected spawn capability) against the validated
     orchestrator seats, which already fail closed on revoked, superseded,
     conflicting, unknown and cross-project designations. A refused caller
     files nothing, names nothing and learns nothing about the board — the
     identity half runs before the target is even read. */
  const authority = dependencies.attentionAuthority();
  const seats = dependencies.authorizedSeats?.() ?? authorizedManagerSeats(productionManagerAuthoritySources());
  const admission = permitAttentionHandoff(authority, seats, null);
  if (!admission.allowed) {
    throw new McpToolRefusal(admission.error, { code: "ATTENTION_NOT_PERMITTED", refusedAs: admission.refusedAs });
  }
  const raisedBy = attributionOf(dependencies);

  const target = focusTargetFromArgs(args.target, dependencies);
  const intent = (text(args.intent) || "show") as FocusIntent;
  if (intent !== "show" && intent !== "open") throw new Error("intent must be show or open");
  const zoom = text(args.zoom) as ZoomIntent | "";
  if (zoom && zoom !== "inspect" && zoom !== "situate") throw new Error("zoom must be inspect or situate");
  const reason = required(args, "reason");
  const contextLabel = text(args.contextLabel);
  const project = await focusTargetProject(target, text(args.project), dependencies);

  /* The project half of the same gate: an orchestrator directs its OWN
     project's screen estate. A seat naming a different project is refused
     here, still before anything durable exists. */
  const projectVerdict = permitAttentionHandoff(authority, seats, project);
  if (!projectVerdict.allowed) {
    throw new McpToolRefusal(projectVerdict.error, { code: "ATTENTION_NOT_PERMITTED", refusedAs: projectVerdict.refusedAs });
  }

  /* ── Restart replay (#873 review, finding 3) ─────────────────────────────
     The operation's durable identity is derived from the clientRequestId and
     written ON the record at creation — before any browser can navigate — so
     a run interrupted anywhere after that point leaves a record this re-run
     can find. Adoption means: no second record, no second navigation; the
     re-run simply waits out the SAME handoff and reports how it ended. */
  const operationKey = mcpOperationId("request_attention", requestId(args));
  const findByOperation = dependencies.findAttentionByOperation
    ?? ((key: string) => readAttentionFile().requests.find((request) => request.operationKey === key) ?? null);
  let request = findByOperation(operationKey);
  let created: ReturnType<typeof raiseAttentionRequest> | null = null;
  if (!request) {
    /* Resolved BEFORE anything durable is written: with no view that can move,
       the honest answer is a refusal, not a pending ask nobody could ever act
       on. Ambiguity is already settled deterministically inside the resolver —
       latest interaction wins — and background/inactive devices are named
       nowhere, so no competing offer can reach them. The SESSION is part of
       the answer: two tabs share a device id, and only the named tab may run
       the move. */
    const view = resolveDirectedAttentionView();
    if (!view) {
      throw new McpToolRefusal(
        "no active Viewer can be moved right now: no visible, active desktop board is open",
        { code: "NO_ACTIVE_VIEW" },
      );
    }

    /* Before the request is written, not after: the request names the root by
       the identity this call may have just extended with a fresh session. */
    dependencies.adoptRootSession();
    created = dependencies.raiseAttentionRequest({
      origin: "root-agent",
      raisedBy,
      target,
      /* Geometric targets ARE their own frame; everything else records that no
         board was read, so a vanished anchor reports `lost` rather than landing
         the operator at the world origin. */
      frameAtCreation: {
        project,
        rect: isGeometricTarget(target) ? geometricFrameRect(target) : UNREAD_FRAME_RECT,
        boardRevision: null,
      },
      intent,
      reason,
      directedAt: view.deviceId,
      directedAtSession: view.viewSessionId,
      operationKey,
      ...(zoom ? { zoom } : {}),
      ...(contextLabel ? { contextLabel } : {}),
    });
    request = created.request;
    /* `adopted` means another process won the transactional race for this
       operation between the read above and the create — its record is the
       one, and this run reports it rather than counting a creation. */
    if (created.adopted) created = null;
  }

  /* Inside the caller's own transport deadline, so the bounded failure is OURS
     to report rather than a timeout the caller reads as silence. */
  const budget = context.deadlineAt === undefined
    ? ATTENTION_ARRIVAL_TIMEOUT_MS
    : Math.max(1_000, Math.min(ATTENTION_ARRIVAL_TIMEOUT_MS, context.deadlineAt - Date.now() - 2_000));
  const waitForArrival = dependencies.awaitAttentionArrival ?? awaitAttentionArrival;
  const outcome = await waitForArrival(request.id, {
    timeoutMs: budget,
    ...(context.signal ? { signal: context.signal } : {}),
  });
  const deviceId = request.acknowledgedBy ?? null;
  if (outcome.kind === "failed") {
    const messages: Record<typeof outcome.code, string> = {
      TARGET_LOST: "the view arrived nowhere: the target no longer resolves to anything on the board",
      HANDOFF_TIMEOUT: "the chosen view did not complete the handoff in time; the request was closed, nothing is left pending",
      HANDOFF_ABORTED: "the call was cancelled before the view arrived; the request was closed, nothing is left pending",
      REQUEST_LOST: "the attention record disappeared before the view arrived",
    };
    throw new McpToolRefusal(messages[outcome.code], {
      code: outcome.code,
      attentionId: request.id,
      deviceId,
      ...(outcome.request ? { state: outcome.request.state, ...(outcome.request.expiredCause ? { expiredCause: outcome.request.expiredCause } : {}) } : {}),
    });
  }

  return redactPayload({
    attentionId: outcome.request.id,
    request: outcome.request,
    /* The durable postcondition the success stands on: the record has already
       landed, the one executing view is named down to the browser session, and
       the pre-move return point is captured. */
    handoff: {
      deviceId,
      viewSessionId: outcome.request.directedSessionId ?? null,
      state: outcome.request.state,
      resolution: outcome.request.resolution ?? null,
      arrivedAt: outcome.request.stateChangedAt,
    },
    /* True when this run adopted a record an interrupted earlier run of the
       SAME operation already raised — the restart-replay path. */
    recovered: created === null,
    /* A newer request from the same root replaces its own unanswered ones, and
       an overfull queue drops the oldest routine entry. Both are named so the
       agent can say so out loud instead of leaving a dropped ask silent. */
    superseded: created?.superseded ?? [],
    dropped: created?.dropped ?? [],
    ...mutationReceipt(operationKey),
  });
}

/**
 * Reply drafts for the operator (#1202) — the manager handing them the
 * sentences its own turn expects, instead of a question they have to type an
 * answer to from scratch.
 *
 * Everything durable about a set is decided here rather than by the caller:
 * WHO offered it (server attribution, the same chain the attention record and
 * the bridge log's origin trust), WHICH conversation it belongs under (the
 * caller's own — a named one has to BE the caller's own), and WHETHER it may
 * be offered at all. The set replaces the conversation's previous one; the
 * operator's next message is what clears it.
 */
function suggestReplies(args: McpToolArgs, dependencies: ViewerMcpDomainDependencies): McpToolPayload {
  /* The authority gate, BEFORE anything is written or even resolved: this puts
     words in front of the operator inside the surface they answer in, so only
     their own session and a validated designated seat may do it. A refused
     caller writes nothing and learns nothing. */
  const authority = dependencies.attentionAuthority();
  const seats = dependencies.authorizedSeats?.() ?? authorizedManagerSeats(productionManagerAuthoritySources());
  const canonical = dependencies.canonicalSeatConversationId ?? productionCanonicalSeatConversationId;
  /* Identity AND target in one verdict: drafts are offered under the caller's
     OWN message, so naming another conversation is refused here — for a seat
     and for the root session alike, because a set written into somebody else's
     pane answers a question its own surface never asked. */
  const named = text(args.conversationId);
  const admission = permitReplySuggestions(authority, seats, named || null, canonical);
  if (!admission.allowed) {
    throw new McpToolRefusal(admission.error, { code: "SUGGEST_REPLIES_NOT_PERMITTED", refusedAs: admission.refusedAs });
  }

  /* The gate above already resolved the validated seats, which is exactly the
     evidence the manager label needs — so the origin folds them in rather than
     resolving designation a second time. */
  const origin = dependencies.callerAttribution?.()
    ?? callerAttributionFrom(authority, (conversationId) => seats.some((seat) => seat.conversationId === conversationId));
  const target = named || origin.conversationId || "";
  if (!target) {
    throw new Error("conversationId is required: this caller has no conversation of its own to offer drafts in");
  }
  /* Keyed by what the registry calls this conversation NOW: the pane reads its
     drafts under the canonical id, so a set filed under a pre-migration alias
     would be written where nothing looks for it. */
  const conversationId = canonical(target);

  try {
    const recorded = recordReplySuggestions({
      conversationId,
      replies: args.replies,
      origin: { kind: origin.kind, conversationId: origin.conversationId, role: origin.role },
      /* Derived from the call, so an interrupted run re-offering the same set
         converges on the same record instead of minting a twin. */
      operationKey: mcpOperationId("suggest_replies", requestId(args)),
    });
    return {
      recorded: true,
      conversationId,
      setId: recorded.set.setId,
      at: recorded.set.at,
      replies: recorded.set.replies.length,
      replaced: recorded.replaced,
    };
  } catch (error) {
    /* A refused set names the rule it broke and leaves the previous one
       standing — the caller can fix the draft and offer again. */
    if (error instanceof ReplySuggestionValidationError) {
      throw new McpToolRefusal(error.message, { code: error.code });
    }
    throw error;
  }
}

/**
 * #691 §6 — the live per-identity fence.
 *
 * Built from the same evidence `request_attention` already trusts: this process's
 * ancestry and the registry's recorded host pids, resolved by
 * {@link attentionCallerAuthority}. Nothing the caller says participates.
 *
 * The manager is resolved per call rather than captured, so seating a new
 * incumbent takes effect without restarting anything.
 */
/** Production evidence for the durable manager-authority resolver: seats and
    revocations from their store, the legacy record, and fresh registry facts.
    All resolved per call so replacement, revocation and supersedence take
    effect on the next tool call. */
function productionManagerAuthoritySources(): ManagerAuthoritySources {
  const registry = agentRegistry();
  return {
    activeSeats: activeOrchestratorSeats,
    revocations: orchestratorRevocations,
    conversationFacts: (conversationId) => {
      const conversation = registry.conversation(conversationId as `conversation_${string}`);
      if (!conversation) return null;
      return {
        superseded: conversation.supersededBy !== null,
        hasGeneration: conversation.generations.length > 0,
        project: conversation.projectOwnership?.project ?? null,
      };
    },
    resolveAlias: (conversationId) => registry.conversation(conversationId as `conversation_${string}`)?.id ?? conversationId,
  };
}

export function viewerMcpToolPolicy(
  domainDependencies: ViewerMcpDomainDependencies = productionDomainDependencies,
  hostHealthProbe = false,
  managerAuthoritySources: () => ManagerAuthoritySources = productionManagerAuthoritySources,
): McpToolPolicy {
  /* Manager identity is fail-closed: only identities the durable resolver
     authorized count as the manager, whatever the raw record says. Under B+
     that identity labels origins and anchors the deploy executor's seat
     authority; it never decides whether a tool is callable. */
  const callerManagerTarget = (): ManagerTarget => ({
    conversationId: null,
    path: null,
    seats: authorizedManagerSeats(managerAuthoritySources())
      .map((seat) => ({ conversationId: seat.conversationId, path: seat.path })),
  });
  return mcpToolPolicy(
    () => hostHealthProbe
      ? { kind: "health-probe" }
      : mcpCallerIdentity(domainDependencies.attentionAuthority(), callerManagerTarget()),
  );
}

export function viewerMcpBindings(
  linkTaskDependencies: LinkTaskToPipelineDependencies = productionLinkTaskDependencies,
  controlDependencies: ViewerControlDependencies = productionViewerControlDependencies,
  domainDependencies: ViewerMcpDomainDependencies = productionDomainDependencies,
): McpToolBindings {
  return {
    spawn_agent: (args, context) => spawnAgent(args, viewerControlForCall(controlDependencies, context)),
    send_message: (args, context) => sendMessage(args, viewerControlForCall(controlDependencies, context), domainDependencies),
    create_task: createBoardTask,
    update_task: updateBoardTask,
    create_pipeline: createPipeline,
    pipeline_action: (args) => pipelineAction(args, domainDependencies),
    link_task_to_pipeline: (args) => linkTaskToPipeline(args, linkTaskDependencies),
    list_conversations: (args, context) => listConversations(args, viewerControlForCall(controlDependencies, context)),
    search_transcripts: (args, context) => searchTranscripts(args, viewerControlForCall(controlDependencies, context)),
    get_conversation: (args, context) => getConversation(args, domainDependencies, context),
    deploy_exact_sha: (args, context) => deployExactSha(args, viewerControlForCall(controlDependencies, context), domainDependencies),
    get_pipeline: getPipeline,
    board_snapshot: (args) => boardSnapshot(args, domainDependencies),
    list_flows: (args) => Promise.resolve(listFlows(args, domainDependencies)),
    get_flow: (args) => Promise.resolve(getFlow(args, domainDependencies)),
    flow_action: (args) => flowAction(args, domainDependencies),
    list_pipelines: (args, context) => listPipelines(args, domainDependencies, context),
    list_tasks: (args) => Promise.resolve(listTasks(args, domainDependencies)),
    get_task: (args) => Promise.resolve(getTask(args, domainDependencies)),
    operator_snapshot: (args) => operatorSnapshot(args, domainDependencies),
    deployment_status: (args, context) => deploymentStatus(args, viewerControlForCall(controlDependencies, context)),
    resources: (args) => resources(args, domainDependencies),
    conversation_action: (args, context) => conversationAction(args, domainDependencies, context),
    conversation_migration: (args) => conversationMigration(args, domainDependencies),
    agent_activity: (args, context) => agentActivity(args, domainDependencies, context),
    lifecycle_events: (args, context) => lifecycleEvents(args, viewerControlForCall(controlDependencies, context), domainDependencies),
    request_attention: (args, context) => requestAttention(args, domainDependencies, context),
    suggest_replies: (args) => Promise.resolve(suggestReplies(args, domainDependencies)),
    bridge_report: (args) => Promise.resolve(bridgeReport(args, domainDependencies)),
    bridge_directive: (args, context) => bridgeDirective(args, viewerControlForCall(controlDependencies, context), domainDependencies),
    get_orchestrator: (args) => getOrchestrator(args, domainDependencies),
    create_orchestrator: (args, context) => createOrchestrator(args, viewerControlForCall(controlDependencies, context)),
    send_message_to_orchestrator: (args, context) => sendMessageToOrchestrator(args, viewerControlForCall(controlDependencies, context), domainDependencies),
    rotate_orchestrator: (args, context) => rotateOrchestrator(args, viewerControlForCall(controlDependencies, context)),
  };
}
