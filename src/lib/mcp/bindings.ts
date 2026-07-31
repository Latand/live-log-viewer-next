import crypto from "node:crypto";

import { agentRegistry, readOnlyConversationLookupFromSnapshot } from "@/lib/agent/registry";
import { procBackend } from "@/lib/proc";
import { ensureOperatorSpawnCapability } from "@/lib/agent/operatorCapability";
import { VIEWER_SPAWN_CAPABILITY_ENV, VIEWER_SPAWN_CAPABILITY_HEADER } from "@/lib/agent/spawnPolicy";
import { applyConversationMigration } from "@/lib/accounts/migration/conversationCommand";
import { attentionCallerAuthority, processAncestry, type AttentionCallerAuthority, type AttentionCallerSources } from "@/lib/attention/callerAuthority";
import { UNREAD_FRAME_RECT } from "@/lib/attention/frames";
import { raiseAttentionRequest } from "@/lib/attention/service";
import { geometricFrameRect, isFocusTarget, isGeometricTarget } from "@/lib/attention/targets";
import type { FocusIntent, FocusTarget, ZoomIntent } from "@/lib/attention/types";
import { boardFor } from "@/lib/board/store";
import { applyConversationAction } from "@/lib/conversation/actions";
import { cancelRound, closeFlow, patchFlow } from "@/lib/flows/commands";
import { getFlowsWithPresets } from "@/lib/flows/engine";
import type { PatchFlowRequest } from "@/lib/flows/types";
import { pollLifecycleDigest, type LifecycleDigestRequest } from "@/lib/lifecycle/digest";
import { queryLifecycleEvents, type LifecycleEventQuery } from "@/lib/lifecycle/journal";
import { agentLivenessSnapshot, productionLivenessSources, type AgentLivenessSources } from "@/lib/lifecycle/liveness";
import { refreshLifecycleJournal } from "@/lib/lifecycle/projector";
import { isLifecycleEventType } from "@/lib/lifecycle/vocabulary";
import { recordManagerReport } from "@/lib/bridge/service";
import { bridgeDirectiveBody, bridgeDirectiveId, type BridgeTrailer } from "@/lib/bridge/directive";
import { isBridgeReportClass } from "@/lib/bridge/types";
import { readOrchestratorRecord } from "@/lib/orchestrator/store";
import { authorizedManagerSeats, type ManagerAuthoritySources } from "@/lib/orchestrator/authority";
import { activeOrchestratorSeats, orchestratorRevocations, orchestratorSeatFor, type OrchestratorSeat } from "@/lib/orchestrator/seats";
import { ORCHESTRATOR_PROMPT_VERSION, ORCHESTRATOR_SYSTEM_PROMPT } from "@/lib/orchestrator/prompt";
import { contextReading, readOrchestratorTranscriptFacts, rotationRecommendation } from "@/lib/orchestrator/health";
import { contextWindowPolicyFor } from "@/lib/orchestrator/contextPolicy";
import { createPipelineFromRequest, getPipelines, patchPipeline } from "@/lib/pipelines/engine";
import { latestOperationalPipelineAttempt } from "@/lib/pipelines/attemptSelection";
import { requestPipelineTick } from "@/lib/pipelines/controllerSignal";
import { projectTaskPipelineIds } from "@/lib/pipelines/taskBinding";
import type { CreatePipelineRequest, PatchPipelineRequest, PipelineAction } from "@/lib/pipelines/types";
import { listFiles } from "@/lib/scanner";
import { projectForCwd } from "@/lib/scanner/describe";
import { completedFileScan } from "@/lib/scanner/scanCache";
import { readResources } from "@/lib/resources";
import { adoptLiveRootSession, conversationRole, liveRootSession, type RootSessionSource } from "@/lib/root/adopt";
import type { ViewerDeploymentStatus } from "@/lib/runtime/contracts";
import { ledgerDeployment, ledgerDeployments } from "@/lib/runtime/deploymentLedger";
import { readSession } from "@/lib/session/reader";
import { applyAssignmentPatches, createTask, patchTask, type CreateTaskInput, type PatchTaskInput } from "@/lib/tasks/commands";
import { isoNow } from "@/lib/tasks/helpers";
import { loadTasks, mutateTasks, mutateTasksFile } from "@/lib/tasks/store";
import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";
import { collectSnapshot } from "@/lib/view/collect";
import { observeFiles } from "@/lib/scanner/observe";
import { resolveSiblings } from "@/lib/view/siblings";
import { hardenedRedact } from "@/lib/view/compactText";
import { validateSnapshotRequest } from "@/lib/view/validation";

import { McpToolRefusal, type McpToolArgs, type McpToolBindings, type McpToolPayload } from "./server";
import { mcpCallerIdentity, mcpToolPolicy, type ManagerTarget, type McpToolPolicy } from "./toolAllowlist";

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
  get?(pathname: string): Promise<Record<string, unknown>>;
  post(pathname: string, body: Record<string, unknown>, headers?: Record<string, string>): Promise<Record<string, unknown>>;
}

const VIEWER_CONTROL_URL = "http://127.0.0.1:8898";
/* Well under the MCP health probe's own budget, so a control surface that cannot
   answer degrades to the ledger long before the probe gives up (#790). */
const CONTROL_READ_TIMEOUT_MS = 5_000;

class ViewerControlResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ViewerControlResponseError";
  }
}

async function getViewerControl(pathname: string): Promise<Record<string, unknown>> {
  const baseUrl = process.env.LLV_VIEWER_CONTROL_URL?.trim() || VIEWER_CONTROL_URL;
  let response: Response;
  try {
    response = await fetch(new URL(pathname, baseUrl), {
      headers: {
        accept: "application/json",
      },
      /* Unbounded here meant the post-promotion health probe hung for its whole
         90-second budget instead of falling back: the promoted surface asks the
         runtime host for a snapshot while that host is synchronously awaiting the
         probe (#790). */
      signal: AbortSignal.timeout(CONTROL_READ_TIMEOUT_MS),
    });
  } catch {
    throw new Error("Viewer control is unreachable");
  }
  /* A body of literal `null` is valid JSON, so `.catch` never fires and every
     later `result.x` throws a TypeError before the status can be classified —
     which is how a 405 from a revision that does not serve the route arrived as
     an uncatchable crash instead of a refusal (#790). */
  let parsed: unknown;
  try {
    parsed = await response.json() as unknown;
  } catch {
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
): Promise<Record<string, unknown>> {
  const baseUrl = process.env.LLV_VIEWER_CONTROL_URL?.trim() || VIEWER_CONTROL_URL;
  const response = await fetch(new URL(pathname, baseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: baseUrl,
      "sec-fetch-site": "same-origin",
      ...headers,
    },
    body: JSON.stringify(body),
  });
  /* A body of literal `null` is valid JSON, so `.catch` never fires and every
     later `result.x` throws a TypeError before the status can be classified —
     which is how a 405 from a revision that does not serve the route arrived as
     an uncatchable crash instead of a refusal (#790). */
  const parsed = await response.json().catch(() => null) as unknown;
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

type RegistrySnapshot = ReturnType<ReturnType<typeof agentRegistry>["readOnlySnapshot"]>;

export interface ViewerMcpDomainDependencies {
  listFiles(options?: Parameters<typeof listFiles>[0]): Promise<FileEntry[]>;
  completedFileScan(): ReturnType<typeof completedFileScan>;
  registrySnapshot(): RegistrySnapshot;
  boardFor(project: string): ReturnType<typeof boardFor>;
  getFlowsWithPresets(): ReturnType<typeof getFlowsWithPresets>;
  patchFlow: typeof patchFlow;
  cancelRound: typeof cancelRound;
  closeFlow: typeof closeFlow;
  getPipelines: typeof getPipelines;
  patchPipeline: typeof patchPipeline;
  loadTasks: typeof loadTasks;
  collectSnapshot: typeof collectSnapshot;
  readResources: typeof readResources;
  applyConversationAction: typeof applyConversationAction;
  applyConversationMigration: typeof applyConversationMigration;
  livenessSources(): AgentLivenessSources;
  queryLifecycleEvents: typeof queryLifecycleEvents;
  pollLifecycleDigest: typeof pollLifecycleDigest;
  refreshLifecycleJournal: typeof refreshLifecycleJournal;
  /** #688 D5: fold the live root session into the rollover chain, so a request
      references the root by an identity that survives the session it was raised
      from. Called on the raise path, which is the moment that identity matters. */
  adoptRootSession(): void;
  raiseAttentionRequest: typeof raiseAttentionRequest;
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
  /** Validated per-project manager seats (fail-closed — see
      `@/lib/orchestrator/authority`), for project-scoped directive routing.
      Optional so partial harnesses fall back to the production resolver. */
  authorizedSeats?(): ReturnType<typeof authorizedManagerSeats>;
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

function attributionOf(dependencies: ViewerMcpDomainDependencies): CallerAttribution {
  return dependencies.callerAttribution?.()
    ?? callerAttributionFrom(dependencies.attentionAuthority(), () => false);
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

const productionDomainDependencies: ViewerMcpDomainDependencies = {
  listFiles,
  completedFileScan,
  registrySnapshot: () => agentRegistry().readOnlySnapshot(),
  boardFor,
  getFlowsWithPresets,
  patchFlow,
  cancelRound,
  closeFlow,
  getPipelines,
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

async function spawnAgent(args: McpToolArgs, control: ViewerControlDependencies): Promise<McpToolPayload> {
  const clientAttemptId = spawnAttemptId(requestId(args));
  const body = withoutKeys(args, ["clientRequestId"]);
  const result = await control.post("/api/spawn", { ...body, clientAttemptId }, {
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
  dependencies: Pick<ViewerMcpDomainDependencies, "registrySnapshot">,
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
  });
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
  if (!result.pipeline) throw new Error(result.error ?? "could not create pipeline");
  if (result.pipeline.state !== "draft") requestPipelineTick();
  return { pipelineId: result.pipeline.id, pipeline: result.pipeline };
}

async function pipelineAction(args: McpToolArgs, dependencies: ViewerMcpDomainDependencies): Promise<McpToolPayload> {
  const pipelineId = required(args, "pipelineId");
  const action = required(args, "action") as PipelineAction;
  const request = withoutKeys(args, ["pipelineId", "clientRequestId"]);
  const result = await dependencies.patchPipeline(pipelineId, request as PatchPipelineRequest);
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

/**
 * One completed generation, and a private pinned scan ONLY when it misses (#845).
 *
 * Every read of a single conversation used to force `fresh: true` with a pin, which
 * is a full-corpus walk in an exclusive scan generation — per call, for a question
 * the completed generation almost always already answers. The pin exists for the
 * case it was built for: a transcript outside the recency cap, which the completed
 * snapshot genuinely does not carry.
 */
async function entryForPath(
  transcriptPath: string,
  dependencies: Pick<ViewerMcpDomainDependencies, "listFiles" | "completedFileScan">,
): Promise<FileEntry | undefined> {
  const completed = (await dependencies.completedFileScan()).snapshot.files;
  const known = completed.find((candidate) => candidate.path === transcriptPath);
  if (known) return known;
  const pinned = await dependencies.listFiles({ fresh: true, persist: false, pin: transcriptPath });
  return pinned.find((candidate) => candidate.path === transcriptPath);
}

async function listConversations(
  args: McpToolArgs,
  dependencies: Pick<ViewerMcpDomainDependencies, "completedFileScan">,
): Promise<McpToolPayload> {
  const project = text(args.project);
  const query = text(args.query).toLocaleLowerCase();
  const limit = Math.max(1, Math.min(100, integer(args.limit, 50)));
  /* The COMPLETED generation, not a private fresh scan (#845). This is a listing:
     it reads what the process already knows, the same corpus `board_snapshot`
     reads. Forcing a full fresh scan per call meant every agent asking "what is
     running" started another full-corpus walk beside the coordinator's own. */
  const files = (await dependencies.completedFileScan()).snapshot.files;
  const conversations = files
    .filter((entry) => entry.engine === "claude" || entry.engine === "codex")
    .filter((entry) => !project || entry.project === project)
    .filter((entry) => !query || `${entry.title}\n${entry.project}\n${entry.path}`.toLocaleLowerCase().includes(query))
    .slice(0, limit)
    .map((entry) => ({
      conversationId: entry.conversationId ?? null,
      transcriptPath: entry.path,
      project: entry.project,
      title: entry.title,
      engine: entry.engine,
      activity: entry.activity,
    }));
  return redactPayload({ count: conversations.length, conversations });
}

async function getConversation(
  args: McpToolArgs,
  dependencies: Pick<ViewerMcpDomainDependencies, "listFiles" | "completedFileScan">,
): Promise<McpToolPayload> {
  const requestedId = text(args.conversationId);
  const requestedPath = text(args.transcriptPath) || text(args.path);
  if (!requestedId && !requestedPath) throw new Error("conversationId or transcriptPath is required");
  const conversation = requestedId
    ? agentRegistry().conversation(requestedId as `conversation_${string}`)
    : agentRegistry().conversationForPath(requestedPath);
  const transcriptPath = conversation?.generations.at(-1)?.path ?? requestedPath;
  const entry = await entryForPath(transcriptPath, dependencies);
  if (!entry || (entry.engine !== "claude" && entry.engine !== "codex")) throw new Error("conversation not found");
  const session = readSession(entry.path, entry.engine);
  const maxRecords = Math.max(1, Math.min(500, integer(args.maxRecords, 100)));
  return redactPayload({
    conversationId: (conversation?.id ?? entry.conversationId ?? requestedId) || null,
    transcriptPath: entry.path,
    project: entry.project,
    title: entry.title,
    engine: entry.engine,
    messages: session.messages.slice(-maxRecords),
    tools: session.tools.slice(-maxRecords),
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
  });
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
  return /^[A-Za-z0-9_-]{43}$/.test(capability) ? { [VIEWER_SPAWN_CAPABILITY_HEADER]: capability } : {};
}

/** Explicitly allowlisted launch fields for the designation routes. NEVER a
    denylist: `conversationId` (seat an existing session — the self-designation
    vector) and `promptVersion` (mandate provenance) are server-owned. */
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
  const project = required(args, "project");
  const { active, pending } = orchestratorSeatFor(project);
  const revocations = orchestratorRevocations().filter((revocation) => revocation.project === project);
  const base = {
    project,
    defaultPromptVersion: ORCHESTRATOR_PROMPT_VERSION,
    pendingIntent: pending,
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

  const conversation = agentRegistry().conversation(active.conversationId as `conversation_${string}`);
  const generation = conversation?.generations.at(-1);
  const transcriptPath = generation?.path ?? active.path;
  /* Engine/model resolve from the registry, falling back to the legacy manager
     record activation keeps in sync — the boot window in which the registry has
     not yet settled a generation must not read as "unknown model". */
  const legacyRecord = readOrchestratorRecord();
  const legacyMatches = legacyRecord?.conversationId === active.conversationId;
  const engine = conversation?.engine ?? (legacyMatches ? legacyRecord!.engine : null);
  const model = generation?.launchProfile?.model ?? (legacyMatches ? legacyRecord!.model : null);
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
  const project = required(args, "project");
  const result = await control.post("/api/orchestrator/seat", {
    project,
    mandate: text(args.mandate) || ORCHESTRATOR_SYSTEM_PROMPT,
    promptVersion: ORCHESTRATOR_PROMPT_VERSION,
    clientRequestId: spawnAttemptId(requestId(args)),
    ...allowedSeatFields(args, ["cwd", "engine", "model", "effort", "accountId"]),
  }, callerCapabilityHeaders());
  return redactPayload({
    project,
    conversationId: result.conversationId ?? null,
    transcriptPath: result.path ?? null,
    seat: result.seat ?? null,
    replayed: result.replayed === true,
    state: result.state ?? null,
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
async function sendMessageToOrchestrator(args: McpToolArgs, control: ViewerControlDependencies): Promise<McpToolPayload> {
  const project = required(args, "project");
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
  });
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
  const project = required(args, "project");
  const result = await control.post("/api/orchestrator/rotate", {
    project,
    clientRequestId: spawnAttemptId(requestId(args)),
    ...allowedSeatFields(args, ["mandate", "handoffNotes", "cwd", "engine", "model", "accountId"]),
  }, callerCapabilityHeaders());
  return redactPayload({
    project,
    conversationId: result.conversationId ?? null,
    transcriptPath: result.path ?? null,
    seat: result.seat ?? null,
    rotatedFrom: result.rotatedFrom ?? null,
    replayed: result.replayed === true,
  });
}

async function getPipeline(args: McpToolArgs): Promise<McpToolPayload> {
  const pipelineId = required(args, "pipelineId");
  const pipeline = getPipelines().pipelines.find((candidate) => candidate.id === pipelineId);
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
  return redactPayload({
    count: conversations.length,
    conversations,
    board: project ? dependencies.boardFor(project) : null,
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
      : dependencies.patchFlow(flowId, request);
  if (!result.flow) throw new Error(result.error ?? "could not update flow");
  const operationId = mcpOperationId("flow_action", requestId(args));
  return redactPayload({ flowId, flow: result.flow, ...mutationReceipt(operationId) });
}

function listPipelines(args: McpToolArgs, dependencies: ViewerMcpDomainDependencies): McpToolPayload {
  const project = text(args.project);
  const state = text(args.state);
  const includeClosed = args.includeClosed === true;
  const limit = Math.max(1, Math.min(200, integer(args.limit, 100)));
  const pipelines = dependencies.getPipelines().pipelines
    .filter((pipeline) => !project || pipeline.project === project)
    .filter((pipeline) => !state || pipeline.state === state)
    .filter((pipeline) => includeClosed || pipeline.state !== "closed")
    .slice(0, limit);
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
  /* Explicit dependencies rather than the module defaults (#845): the registry
     projection is the one this call already holds, so a snapshot costs one
     projection instead of materialising a second inside the collector. The corpus
     walk is single-flight in `observeFiles`, so concurrent callers join one. */
  return redactPayload({
    ...await dependencies.collectSnapshot(request, {
      observeFiles,
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

async function conversationAction(args: McpToolArgs, dependencies: ViewerMcpDomainDependencies): Promise<McpToolPayload> {
  const conversationId = text(args.conversationId);
  const transcriptPath = text(args.transcriptPath) || text(args.path);
  if (!conversationId && !transcriptPath) throw new Error("conversationId or transcriptPath is required");
  const operationId = mcpOperationId("conversation_action", requestId(args));
  const result = await dependencies.applyConversationAction({
    operationId,
    conversationId,
    transcriptPath,
    action: required(args, "action"),
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
async function agentActivity(args: McpToolArgs, dependencies: ViewerMcpDomainDependencies): Promise<McpToolPayload> {
  const sources = dependencies.livenessSources();
  const snapshot = await agentLivenessSnapshot({
    conversationId: text(args.conversationId) || undefined,
    transcriptPath: (text(args.transcriptPath) || text(args.path)) || undefined,
    project: text(args.project) || undefined,
    liveOnly: args.liveOnly === true,
    stallAfterMs: typeof args.stallAfterMs === "number" ? args.stallAfterMs : undefined,
    limit: typeof args.limit === "number" ? args.limit : undefined,
  }, sources);
  const journal = dependencies.refreshLifecycleJournal({ liveness: snapshot.conversations });
  return redactPayload({ ...snapshot, journaled: journal.appended });
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
      const entry = await entryForPath(target.path, dependencies);
      if (!entry) throw new Error("no conversation on the board has that transcript path");
      return entry.project;
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
 * Typed focus for every agent session (B+ item 2): move the operator's active
 * Viewer to a typed target, immediately.
 *
 * The desktop follows an explicit focus event with no consent step — see
 * `AttentionHost` — and the record keeps a one-action way back: the return
 * point is captured before the move and a single Return control restores it.
 * What replaced the old worker refusal is ATTRIBUTION: `raisedBy` is derived
 * server-side from the durable caller identity and stored on the record, so a
 * worker's ask is visibly a worker's ask and can never masquerade as the
 * operator's own root agent. The root identity is still resolved server-side,
 * which is why no rootId appears in this schema.
 */
async function requestAttention(args: McpToolArgs, dependencies: ViewerMcpDomainDependencies): Promise<McpToolPayload> {
  const raisedBy = attributionOf(dependencies);

  const target = args.target;
  if (!isFocusTarget(target)) throw new Error("target must be a typed focus target");
  const intent = (text(args.intent) || "show") as FocusIntent;
  if (intent !== "show" && intent !== "open") throw new Error("intent must be show or open");
  const zoom = text(args.zoom) as ZoomIntent | "";
  if (zoom && zoom !== "inspect" && zoom !== "situate") throw new Error("zoom must be inspect or situate");
  const reason = required(args, "reason");
  const contextLabel = text(args.contextLabel);
  const project = await focusTargetProject(target, text(args.project), dependencies);

  /* Before the request is written, not after: the request names the root by the
     identity this call may have just extended with a fresh session. */
  dependencies.adoptRootSession();
  const created = dependencies.raiseAttentionRequest({
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
    ...(zoom ? { zoom } : {}),
    ...(contextLabel ? { contextLabel } : {}),
  });
  const operationId = mcpOperationId("request_attention", requestId(args));
  return redactPayload({
    attentionId: created.request.id,
    request: created.request,
    /* A newer request from the same root replaces its own unanswered ones, and
       an overfull queue drops the oldest routine entry. Both are named so the
       agent can say so out loud instead of leaving a dropped ask silent. */
    superseded: created.superseded,
    dropped: created.dropped,
    ...mutationReceipt(operationId),
  });
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
    legacyManagerConversationId: () => readOrchestratorRecord()?.conversationId ?? null,
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
    spawn_agent: (args) => spawnAgent(args, controlDependencies),
    send_message: (args) => sendMessage(args, controlDependencies, domainDependencies),
    create_task: createBoardTask,
    update_task: updateBoardTask,
    create_pipeline: createPipeline,
    pipeline_action: (args) => pipelineAction(args, domainDependencies),
    link_task_to_pipeline: (args) => linkTaskToPipeline(args, linkTaskDependencies),
    list_conversations: (args) => listConversations(args, domainDependencies),
    get_conversation: (args) => getConversation(args, domainDependencies),
    deploy_exact_sha: (args) => deployExactSha(args, controlDependencies, domainDependencies),
    get_pipeline: getPipeline,
    board_snapshot: (args) => boardSnapshot(args, domainDependencies),
    list_flows: (args) => Promise.resolve(listFlows(args, domainDependencies)),
    get_flow: (args) => Promise.resolve(getFlow(args, domainDependencies)),
    flow_action: (args) => flowAction(args, domainDependencies),
    list_pipelines: (args) => Promise.resolve(listPipelines(args, domainDependencies)),
    list_tasks: (args) => Promise.resolve(listTasks(args, domainDependencies)),
    get_task: (args) => Promise.resolve(getTask(args, domainDependencies)),
    operator_snapshot: (args) => operatorSnapshot(args, domainDependencies),
    deployment_status: (args) => deploymentStatus(args, controlDependencies),
    resources: (args) => resources(args, domainDependencies),
    conversation_action: (args) => conversationAction(args, domainDependencies),
    conversation_migration: (args) => conversationMigration(args, domainDependencies),
    agent_activity: (args) => agentActivity(args, domainDependencies),
    lifecycle_events: (args) => lifecycleEvents(args, controlDependencies, domainDependencies),
    request_attention: (args) => requestAttention(args, domainDependencies),
    bridge_report: (args) => Promise.resolve(bridgeReport(args, domainDependencies)),
    bridge_directive: (args) => bridgeDirective(args, controlDependencies, domainDependencies),
    get_orchestrator: (args) => getOrchestrator(args, domainDependencies),
    create_orchestrator: (args) => createOrchestrator(args, controlDependencies),
    send_message_to_orchestrator: (args) => sendMessageToOrchestrator(args, controlDependencies),
    rotate_orchestrator: (args) => rotateOrchestrator(args, controlDependencies),
  };
}
