import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NextRequest, NextResponse } from "next/server";

import { accountManager } from "@/lib/accounts/manager";
import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import type { AccountContext } from "@/lib/accounts/contracts";
import { freshSpecFor, type AgentEngine } from "@/lib/agent/cli";
import { reasoningFromBody } from "@/lib/agent/efforts";
import { modelFromBody } from "@/lib/agent/models";
import { agentRegistry, type AgentRegistry, type SpawnReceipt } from "@/lib/agent/registry";
import { sessionKeyFromTranscript } from "@/lib/agent/sessionKey";
import { spawnResponseForReceipt, type SpawnResponse as AgentSpawnResponse } from "@/lib/agent/spawnResponse";
import { resolveSpawnedTranscriptPath } from "@/lib/agent/spawnedTranscript";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { projectInfoFromCwd } from "@/lib/scanner/describe";
import { attachmentPath } from "@/lib/tasks/attachments";
import { applyAssignmentPatches, pinnedAccountId, type AssignmentPatch, type TaskCommandResult } from "@/lib/tasks/commands";
import { isoNow } from "@/lib/tasks/helpers";
import { loadTasks, mutateTasks } from "@/lib/tasks/store";
import type { BoardTask, TaskAssignment } from "@/lib/tasks/types";
import { spawnAgentWithPrompt, type SpawnedPane } from "@/lib/tmux";
import type { ApiError } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type TaskRouteContext = {
  params: Promise<{ id: string }>;
};

interface TaskSpawnResponse {
  ok: true;
  task: BoardTask;
  target: string | null;
  path: string | null;
  panePid: number | null;
  launchId: string;
  conversationId: string;
  initialMessage: AgentSpawnResponse["initialMessage"];
  state: AgentSpawnResponse["state"];
  retrySafe: boolean;
  assignment: TaskAssignment["state"];
  error?: string;
}

interface TaskSpawnDependencies {
  registry(): AgentRegistry;
  loadTasks: typeof loadTasks;
  mutateTasks: typeof mutateTasks;
  resolveSpawnAccount(engine: AgentEngine, accountId: string | null): AccountContext;
  spawnAgentWithPrompt: typeof spawnAgentWithPrompt;
  resolveSpawnedTranscriptPath: typeof resolveSpawnedTranscriptPath;
}

const productionDependencies: TaskSpawnDependencies = {
  registry: agentRegistry,
  loadTasks,
  mutateTasks,
  resolveSpawnAccount: (engine, accountId) => accountManager.resolveSpawn(engine, accountId),
  spawnAgentWithPrompt,
  resolveSpawnedTranscriptPath,
};

function cwdFromBody(value: unknown): { cwd?: string; error?: string; status?: number } {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return { error: "working directory is required", status: 400 };
  const cwd = path.resolve(raw === "~" || raw.startsWith("~/") ? path.join(os.homedir(), raw.slice(1)) : raw);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(cwd);
  } catch {
    return { error: `directory does not exist: ${cwd}`, status: 400 };
  }
  if (!stat.isDirectory()) return { error: `not a directory: ${cwd}`, status: 400 };
  return { cwd };
}

function stableTaskAttemptId(task: BoardTask, shape: Record<string, unknown>): string {
  const digest = crypto.createHash("sha256").update(JSON.stringify({ taskId: task.id, text: task.text, shape })).digest("hex");
  return `task_${digest.slice(0, 48)}`;
}

function nextTaskAttemptId(registry: AgentRegistry, task: BoardTask, shape: Record<string, unknown>): string {
  const base = stableTaskAttemptId(task, shape);
  for (let generation = 1; ; generation += 1) {
    const candidate = generation === 1 ? base : `${base}_${generation}`;
    const receipt = registry.spawnReceiptForClientAttempt(candidate);
    if (!receipt || receipt.state !== "failed") return candidate;
  }
}

function taskRequestDigest(task: BoardTask, shape: Record<string, unknown>): string {
  return crypto.createHash("sha256").update(JSON.stringify({ taskId: task.id, text: task.text, shape })).digest("hex");
}

function assignmentPatch(receipt: SpawnReceipt, at: string, accountId: string, engine: AgentEngine): AssignmentPatch {
  const failed = receipt.state === "failed" || receipt.state === "conflicted";
  let state: TaskAssignment["state"] = "spawning";
  if (failed) state = "failed";
  else if (receipt.state === "completed" && receipt.artifactPath) state = "delivered";
  return {
    launchId: receipt.launchId,
    clientAttemptId: receipt.clientAttemptId,
    conversationId: receipt.conversationId,
    path: receipt.artifactPath,
    panePid: receipt.pane?.panePid.pid ?? null,
    state,
    error: failed ? receipt.error ?? "agent did not start" : null,
    at,
    accountId,
    engine,
  };
}

function taskInitialMessage(receipt: SpawnReceipt): AgentSpawnResponse["initialMessage"] {
  if (receipt.state === "failed" || receipt.state === "conflicted") return "failed";
  if (receipt.state === "completed" || receipt.state === "prompt-delivered" || receipt.state === "path-pending") {
    return "delivered";
  }
  return "pending";
}

function persistAssignment(
  dependencies: TaskSpawnDependencies,
  taskId: string,
  patch: AssignmentPatch,
  at: string,
): TaskCommandResult {
  return dependencies.mutateTasks((tasks) => {
    const outcome = applyAssignmentPatches(tasks, taskId, [patch], at);
    return { tasks: outcome.ok ? outcome.tasks : undefined, result: outcome };
  });
}

function taskSpawnResponse(
  receipt: SpawnReceipt,
  task: BoardTask,
  patch: AssignmentPatch,
  options: { error?: string } = {},
): TaskSpawnResponse {
  const spawn = spawnResponseForReceipt(receipt, receipt.artifactPath, {
    initialMessage: taskInitialMessage(receipt),
  });
  return {
    ok: true,
    task,
    target: receipt.pane?.display ?? receipt.target ?? null,
    path: receipt.artifactPath,
    panePid: receipt.pane?.panePid.pid ?? null,
    launchId: receipt.launchId,
    conversationId: receipt.conversationId,
    initialMessage: spawn.initialMessage,
    state: spawn.state,
    retrySafe: spawn.retrySafe,
    assignment: patch.state,
    ...(options.error ? { error: options.error } : {}),
  };
}

async function postTaskSpawn(
  req: NextRequest,
  ctx: TaskRouteContext,
  dependencies: TaskSpawnDependencies = productionDependencies,
): Promise<NextResponse<TaskSpawnResponse | ApiError>> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;

  let body: { engine?: unknown; model?: unknown; cwd?: unknown; effort?: unknown; fast?: unknown; clientAttemptId?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const engine = body.engine === "claude" || body.engine === "codex" ? (body.engine as AgentEngine) : null;
  if (!engine) return NextResponse.json({ error: "engine must be claude or codex" }, { status: 400 });
  if (body.clientAttemptId !== undefined
    && (typeof body.clientAttemptId !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(body.clientAttemptId))) {
    return NextResponse.json({ error: "clientAttemptId must be 8-128 URL-safe characters" }, { status: 400 });
  }

  const reasoning = reasoningFromBody(engine, body);
  if (reasoning.error) return NextResponse.json({ error: reasoning.error }, { status: 400 });
  const selectedModel = modelFromBody(body);
  if (selectedModel.error) return NextResponse.json({ error: selectedModel.error }, { status: 400 });
  const cwdResult = cwdFromBody(body.cwd);
  if (!cwdResult.cwd) return NextResponse.json({ error: cwdResult.error ?? "invalid working directory" }, { status: cwdResult.status ?? 400 });

  const { id } = await ctx.params;
  const task = dependencies.loadTasks().find((item) => item.id === id);
  if (!task) return NextResponse.json({ error: "task not found" }, { status: 404 });

  const registry = dependencies.registry();
  const previous = pinnedAccountId(task.assignments, engine);
  let account: AccountContext;
  try {
    account = dependencies.resolveSpawnAccount(engine, previous);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
  const shape = {
    engine,
    cwd: cwdResult.cwd,
    model: selectedModel.model,
    effort: reasoning.effort,
    fast: reasoning.fast,
    accountId: account.accountId,
  };
  const clientAttemptId = typeof body.clientAttemptId === "string"
    ? body.clientAttemptId
    : nextTaskAttemptId(registry, task, shape);
  const specBase = freshSpecFor(engine, cwdResult.cwd, {
    model: selectedModel.model,
    effort: reasoning.effort,
    fast: reasoning.fast,
    codexHome: engine === "codex" ? account.home : null,
    claudeConfigDir: engine === "claude" ? account.home : null,
    claudeProjectsDir: engine === "claude" ? account.transcriptRoot : null,
  });
  const project = projectInfoFromCwd(cwdResult.cwd)?.project ?? task.project;
  const spec = {
    ...specBase,
    launchProfile: emptyLaunchProfile({
      ...(specBase.launchProfile ?? {}),
      cwd: cwdResult.cwd,
      project,
      title: task.text.split("\n")[0]?.trim() || null,
    }),
  };
  const begun = registry.beginSpawnRequest({
    engine,
    cwd: cwdResult.cwd,
    transport: "tmux",
    accountId: account.accountId,
    launchProfile: spec.launchProfile,
    clientAttemptId,
    requestDigest: taskRequestDigest(task, shape),
  });
  if (begun.kind === "conflict") {
    return NextResponse.json({ error: "task spawn attempt conflicts with its original request" }, { status: 409 });
  }

  if (begun.kind === "replay") {
    const at = isoNow();
    const patch = assignmentPatch(begun.receipt, at, account.accountId, engine);
    try {
      const result = persistAssignment(dependencies, id, patch, at);
      if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
      const response = taskSpawnResponse(begun.receipt, result.task, patch);
      const status = patch.state === "spawning" ? 202 : 200;
      return NextResponse.json(response, { status });
    } catch (error) {
      return NextResponse.json(taskSpawnResponse(begun.receipt, task, { ...patch, state: "spawning" }, {
        error: error instanceof Error ? error.message : "task assignment write failed",
      }), { status: 202 });
    }
  }

  const admittedAt = isoNow();
  const admittedPatch = assignmentPatch(begun.receipt, admittedAt, account.accountId, engine);
  let admittedTask = task;
  try {
    const admitted = persistAssignment(dependencies, id, admittedPatch, admittedAt);
    if (!admitted.ok) {
      registry.failSpawn(begun.receipt.launchId, admitted.error);
      return NextResponse.json({ error: admitted.error }, { status: admitted.status });
    }
    admittedTask = admitted.task;
  } catch (error) {
    registry.failSpawn(begun.receipt.launchId, "task admission could not be persisted");
    const failed = registry.snapshot().receipts[begun.receipt.launchId] ?? begun.receipt;
    return NextResponse.json(taskSpawnResponse(failed, task, { ...admittedPatch, state: "failed" }, {
      error: error instanceof Error ? error.message : "task admission could not be persisted",
    }), { status: 500 });
  }

  const attachmentPaths = (task.attachments ?? []).map((attachment) => attachmentPath(attachment));
  const prompt = [task.text, ...attachmentPaths].join("\n");
  const startedAtMs = Date.now();
  try {
    const pane: SpawnedPane = await dependencies.spawnAgentWithPrompt(spec, prompt, begun.receipt);
    const transcript = await dependencies.resolveSpawnedTranscriptPath({
      engine,
      knownTranscript: spec.transcript ?? null,
      panePid: pane.panePid ?? null,
      cwd: cwdResult.cwd,
      startedAtMs,
      codexSessionsDir: engine === "codex" ? account.transcriptRoot : null,
    });
    const key = transcript ? sessionKeyFromTranscript(engine, transcript) : null;
    if (transcript && key) {
      const settled = registry.settleSpawn(begun.receipt.launchId, {
        key,
        artifactPath: transcript,
        cwd: cwdResult.cwd,
        accountId: account.accountId,
        launchProfile: spec.launchProfile,
        status: "starting",
        host: pane.host ?? null,
        claimEpoch: 0,
        claimOwner: null,
        pendingAction: "spawn",
      });
      if (settled.kind === "conflict") throw new Error(settled.code);
    } else {
      registry.markSpawnPathPending(begun.receipt.launchId);
    }
  } catch (error) {
    const observed = registry.snapshot().receipts[begun.receipt.launchId] ?? begun.receipt;
    if (observed.pane) {
      if (observed.state === "prompt-delivered" || observed.state === "host-verified") {
        registry.markSpawnPathPending(observed.launchId);
      }
      const pending = registry.snapshot().receipts[observed.launchId] ?? observed;
      const at = isoNow();
      const patch = assignmentPatch(pending, at, account.accountId, engine);
      let taskAfterRecovery = admittedTask;
      try {
        const persisted = persistAssignment(dependencies, id, patch, at);
        if (persisted.ok) taskAfterRecovery = persisted.task;
      } catch {
        /* The replay path will fold this same launch identity into the task. */
      }
      return NextResponse.json(taskSpawnResponse(pending, taskAfterRecovery, { ...patch, state: "spawning" }, {
        error: error instanceof Error ? error.message : "task spawn attribution is pending",
      }), { status: 202 });
    }
    registry.failSpawn(begun.receipt.launchId, error instanceof Error ? error.message : "task spawn failed");
    const failed = registry.snapshot().receipts[begun.receipt.launchId] ?? observed;
    const at = isoNow();
    const patch = assignmentPatch(failed, at, account.accountId, engine);
    try {
      const persisted = persistAssignment(dependencies, id, patch, at);
      if (persisted.ok) admittedTask = persisted.task;
    } catch {
      /* The failed receipt remains queryable by clientAttemptId. */
    }
    return NextResponse.json(taskSpawnResponse(failed, admittedTask, patch, {
      error: failed.error ?? "task spawn failed",
    }), { status: 500 });
  }

  const completed = registry.snapshot().receipts[begun.receipt.launchId] ?? begun.receipt;
  const completedAt = isoNow();
  const completedPatch = assignmentPatch(completed, completedAt, account.accountId, engine);
  try {
    const result = persistAssignment(dependencies, id, completedPatch, completedAt);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(taskSpawnResponse(completed, result.task, completedPatch));
  } catch (error) {
    return NextResponse.json(taskSpawnResponse(completed, admittedTask, { ...completedPatch, state: "spawning" }, {
      error: error instanceof Error ? error.message : "task assignment write failed after launch",
    }), { status: 202 });
  }
}

export const POST = Object.assign(
  async (req: NextRequest, ctx: TaskRouteContext): Promise<NextResponse<TaskSpawnResponse | ApiError>> => await postTaskSpawn(req, ctx),
  { withDependencies: postTaskSpawn },
);
