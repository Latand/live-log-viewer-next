import crypto from "node:crypto";

import { agentRegistry } from "@/lib/agent/registry";
import { ensureOperatorSpawnCapability } from "@/lib/agent/operatorCapability";
import { VIEWER_SPAWN_CAPABILITY_HEADER } from "@/lib/agent/spawnPolicy";
import { applyConversationMigration } from "@/lib/accounts/migration/conversationCommand";
import { boardFor } from "@/lib/board/store";
import { applyConversationAction } from "@/lib/conversation/actions";
import { cancelRound, closeFlow, patchFlow } from "@/lib/flows/commands";
import { getFlowsWithPresets } from "@/lib/flows/engine";
import type { PatchFlowRequest } from "@/lib/flows/types";
import { createPipelineFromRequest, getPipelines, patchPipeline } from "@/lib/pipelines/engine";
import { latestOperationalPipelineAttempt } from "@/lib/pipelines/attemptSelection";
import { requestPipelineTick } from "@/lib/pipelines/controllerSignal";
import { projectTaskPipelineIds } from "@/lib/pipelines/taskBinding";
import type { CreatePipelineRequest, PatchPipelineRequest, PipelineAction } from "@/lib/pipelines/types";
import { listFiles } from "@/lib/scanner";
import { readResources } from "@/lib/resources";
import { runtimeHostClient, type RuntimeHostClient } from "@/lib/runtime/client";
import { runtimeEventsEnabled } from "@/lib/runtime/flags";
import { readSession } from "@/lib/session/reader";
import { applyAssignmentPatches, createTask, patchTask, type CreateTaskInput, type PatchTaskInput } from "@/lib/tasks/commands";
import { isoNow } from "@/lib/tasks/helpers";
import { loadTasks, mutateTasks, mutateTasksFile } from "@/lib/tasks/store";
import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";
import { collectSnapshot } from "@/lib/view/collect";
import { hardenedRedact } from "@/lib/view/compactText";
import { validateSnapshotRequest } from "@/lib/view/validation";

import type { McpToolArgs, McpToolBindings, McpToolPayload } from "./server";

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
  post(pathname: string, body: Record<string, unknown>, headers?: Record<string, string>): Promise<Record<string, unknown>>;
}

const VIEWER_CONTROL_URL = "http://127.0.0.1:8898";

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
  const result = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (result.error || (!response.ok && result.state !== "busy")) {
    throw new Error(text(result.error) || `Viewer control request failed with status ${response.status}`);
  }
  return result;
}

const productionViewerControlDependencies: ViewerControlDependencies = { post: postViewerControl };

type RegistrySnapshot = ReturnType<ReturnType<typeof agentRegistry>["readOnlySnapshot"]>;

export interface ViewerMcpDomainDependencies {
  listFiles(options?: Parameters<typeof listFiles>[0]): Promise<FileEntry[]>;
  registrySnapshot(): RegistrySnapshot;
  boardFor(project: string): ReturnType<typeof boardFor>;
  getFlowsWithPresets(): ReturnType<typeof getFlowsWithPresets>;
  patchFlow: typeof patchFlow;
  cancelRound: typeof cancelRound;
  closeFlow: typeof closeFlow;
  getPipelines: typeof getPipelines;
  loadTasks: typeof loadTasks;
  collectSnapshot: typeof collectSnapshot;
  runtimeEventsEnabled: typeof runtimeEventsEnabled;
  runtimeHostClient(): RuntimeHostClient | null;
  readResources: typeof readResources;
  applyConversationAction: typeof applyConversationAction;
  applyConversationMigration: typeof applyConversationMigration;
}

const productionDomainDependencies: ViewerMcpDomainDependencies = {
  listFiles,
  registrySnapshot: () => agentRegistry().readOnlySnapshot(),
  boardFor,
  getFlowsWithPresets,
  patchFlow,
  cancelRound,
  closeFlow,
  getPipelines,
  loadTasks,
  collectSnapshot,
  runtimeEventsEnabled,
  runtimeHostClient,
  readResources,
  applyConversationAction,
  applyConversationMigration,
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

async function sendMessage(args: McpToolArgs, control: ViewerControlDependencies): Promise<McpToolPayload> {
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
  const conversation = conversationId
    ? agentRegistry().conversation(conversationId as `conversation_${string}`)
    : agentRegistry().conversationForPath(transcriptPath);
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

async function pipelineAction(args: McpToolArgs): Promise<McpToolPayload> {
  const pipelineId = required(args, "pipelineId");
  const action = required(args, "action") as PipelineAction;
  const request = withoutKeys(args, ["pipelineId", "clientRequestId"]);
  const result = await patchPipeline(pipelineId, request as PatchPipelineRequest);
  if (!result.pipeline) throw new Error(result.error ?? "could not update pipeline");
  if (PIPELINE_CONTROLLER_ACTIONS.has(action)) requestPipelineTick();
  return { pipelineId, pipeline: result.pipeline };
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

async function listConversations(args: McpToolArgs): Promise<McpToolPayload> {
  const project = text(args.project);
  const query = text(args.query).toLocaleLowerCase();
  const limit = Math.max(1, Math.min(100, integer(args.limit, 50)));
  const files = await listFiles({ fresh: true, persist: false });
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
  dependencies: Pick<ViewerMcpDomainDependencies, "listFiles">,
): Promise<McpToolPayload> {
  const requestedId = text(args.conversationId);
  const requestedPath = text(args.transcriptPath) || text(args.path);
  if (!requestedId && !requestedPath) throw new Error("conversationId or transcriptPath is required");
  const conversation = requestedId
    ? agentRegistry().conversation(requestedId as `conversation_${string}`)
    : agentRegistry().conversationForPath(requestedPath);
  const transcriptPath = conversation?.generations.at(-1)?.path ?? requestedPath;
  const files = await dependencies.listFiles({ fresh: true, persist: false, pin: transcriptPath });
  const entry = files.find((candidate) => candidate.path === transcriptPath);
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

async function deployExactSha(args: McpToolArgs, control: ViewerControlDependencies): Promise<McpToolPayload> {
  if (args.confirm !== "deploy") throw new Error('confirm must equal "deploy"');
  const revision = required(args, "revision");
  if (!/^[0-9a-f]{40}$/i.test(revision)) throw new Error("revision must be a full 40-character commit SHA");
  const receipt = await control.post("/api/runtime/deployments", { revision, idempotencyKey: requestId(args) });
  return {
    deploymentId: receipt.deploymentId,
    revision: receipt.revision,
    replayed: receipt.state === "accepted" && receipt.replayed === true,
    state: receipt.state,
  };
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
  const conversations = (await dependencies.listFiles({ fresh: true, persist: false }))
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
  return redactPayload({ ...await dependencies.collectSnapshot(request) });
}

async function deploymentStatus(args: McpToolArgs, dependencies: ViewerMcpDomainDependencies): Promise<McpToolPayload> {
  if (!dependencies.runtimeEventsEnabled()) throw new Error("runtime events are disabled");
  const client = dependencies.runtimeHostClient();
  if (!client) throw new Error("runtime host socket is unavailable");
  const deploymentId = text(args.deploymentId);
  if (deploymentId) {
    const deployment = await client.readViewerDeployment(deploymentId);
    if (!deployment) throw new Error("viewer deployment was not found");
    return redactPayload({ deploymentId, deployment });
  }
  const operationId = text(args.operationId);
  if (operationId) {
    if (operationId.includes(":") || /\s/.test(operationId)) throw new Error("operationId is invalid");
    const operation = await client.operationStatus(operationId);
    if (!operation) throw new Error("operation not found");
    return redactPayload({ operationId, operation });
  }
  const limit = Math.max(1, Math.min(100, integer(args.limit, 25)));
  const deployments = (await client.snapshot()).deployments.slice(-limit);
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

export function viewerMcpBindings(
  linkTaskDependencies: LinkTaskToPipelineDependencies = productionLinkTaskDependencies,
  controlDependencies: ViewerControlDependencies = productionViewerControlDependencies,
  domainDependencies: ViewerMcpDomainDependencies = productionDomainDependencies,
): McpToolBindings {
  return {
    spawn_agent: (args) => spawnAgent(args, controlDependencies),
    send_message: (args) => sendMessage(args, controlDependencies),
    create_task: createBoardTask,
    update_task: updateBoardTask,
    create_pipeline: createPipeline,
    pipeline_action: pipelineAction,
    link_task_to_pipeline: (args) => linkTaskToPipeline(args, linkTaskDependencies),
    list_conversations: listConversations,
    get_conversation: (args) => getConversation(args, domainDependencies),
    deploy_exact_sha: (args) => deployExactSha(args, controlDependencies),
    get_pipeline: getPipeline,
    board_snapshot: (args) => boardSnapshot(args, domainDependencies),
    list_flows: (args) => Promise.resolve(listFlows(args, domainDependencies)),
    get_flow: (args) => Promise.resolve(getFlow(args, domainDependencies)),
    flow_action: (args) => flowAction(args, domainDependencies),
    list_pipelines: (args) => Promise.resolve(listPipelines(args, domainDependencies)),
    list_tasks: (args) => Promise.resolve(listTasks(args, domainDependencies)),
    get_task: (args) => Promise.resolve(getTask(args, domainDependencies)),
    operator_snapshot: (args) => operatorSnapshot(args, domainDependencies),
    deployment_status: (args) => deploymentStatus(args, domainDependencies),
    resources: (args) => resources(args, domainDependencies),
    conversation_action: (args) => conversationAction(args, domainDependencies),
    conversation_migration: (args) => conversationMigration(args, domainDependencies),
  };
}
