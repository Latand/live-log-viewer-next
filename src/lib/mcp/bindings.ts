import crypto from "node:crypto";

import { agentRegistry } from "@/lib/agent/registry";
import { ensureOperatorSpawnCapability } from "@/lib/agent/operatorCapability";
import { VIEWER_SPAWN_CAPABILITY_HEADER } from "@/lib/agent/spawnPolicy";
import { createPipelineFromRequest, getPipelines, patchPipeline } from "@/lib/pipelines/engine";
import { latestOperationalPipelineAttempt } from "@/lib/pipelines/attemptSelection";
import { requestPipelineTick } from "@/lib/pipelines/controllerSignal";
import type { CreatePipelineRequest, PatchPipelineRequest, PipelineAction } from "@/lib/pipelines/types";
import { listFiles } from "@/lib/scanner";
import { readSession } from "@/lib/session/reader";
import { applyAssignmentPatches, createTask, patchTask, type CreateTaskInput, type PatchTaskInput } from "@/lib/tasks/commands";
import { isoNow } from "@/lib/tasks/helpers";
import { mutateTasks, mutateTasksFile } from "@/lib/tasks/store";
import type { BoardTask } from "@/lib/tasks/types";

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
  const message = required(args, "text");
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
  return { count: conversations.length, conversations };
}

async function getConversation(args: McpToolArgs): Promise<McpToolPayload> {
  const requestedId = text(args.conversationId);
  const requestedPath = text(args.transcriptPath) || text(args.path);
  if (!requestedId && !requestedPath) throw new Error("conversationId or transcriptPath is required");
  const conversation = requestedId
    ? agentRegistry().conversation(requestedId as `conversation_${string}`)
    : agentRegistry().conversationForPath(requestedPath);
  const transcriptPath = conversation?.generations.at(-1)?.path ?? requestedPath;
  const files = await listFiles({ fresh: true, persist: false, pin: transcriptPath });
  const entry = files.find((candidate) => candidate.path === transcriptPath);
  if (!entry || (entry.engine !== "claude" && entry.engine !== "codex")) throw new Error("conversation not found");
  const session = readSession(entry.path, entry.engine);
  const maxRecords = Math.max(1, Math.min(500, integer(args.maxRecords, 100)));
  return {
    conversationId: (conversation?.id ?? entry.conversationId ?? requestedId) || null,
    transcriptPath: entry.path,
    project: entry.project,
    title: entry.title,
    engine: entry.engine,
    messages: session.messages.slice(-maxRecords),
    tools: session.tools.slice(-maxRecords),
  };
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
  return { pipelineId, pipeline };
}

export function viewerMcpBindings(
  linkTaskDependencies: LinkTaskToPipelineDependencies = productionLinkTaskDependencies,
  controlDependencies: ViewerControlDependencies = productionViewerControlDependencies,
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
    get_conversation: getConversation,
    deploy_exact_sha: (args) => deployExactSha(args, controlDependencies),
    get_pipeline: getPipeline,
  };
}
