import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NextRequest, NextResponse } from "next/server";

import { accountManager } from "@/lib/accounts/manager";
import { freshSpecFor, type AgentEngine } from "@/lib/agent/cli";
import { reasoningFromBody } from "@/lib/agent/efforts";
import { modelFromBody } from "@/lib/agent/models";
import { resolveSpawnedTranscriptPath } from "@/lib/agent/spawnedTranscript";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { applyAssignmentPatches, pinnedAccountId, type AssignmentPatch } from "@/lib/tasks/commands";
import { isoNow } from "@/lib/tasks/helpers";
import { loadTasks, mutateTasks } from "@/lib/tasks/store";
import type { BoardTask } from "@/lib/tasks/types";
import { spawnAgentWithPrompt } from "@/lib/tmux";
import type { ApiError } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type TaskRouteContext = {
  params: Promise<{ id: string }>;
};

interface SpawnResponse {
  ok: true;
  task: BoardTask;
  target: string;
  path: string | null;
  panePid: number | null;
}

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

export async function POST(req: NextRequest, ctx: TaskRouteContext): Promise<NextResponse<SpawnResponse | ApiError>> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;

  let body: { engine?: unknown; model?: unknown; cwd?: unknown; effort?: unknown; fast?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const engine = body.engine === "claude" || body.engine === "codex" ? (body.engine as AgentEngine) : null;
  if (!engine) return NextResponse.json({ error: "engine must be claude or codex" }, { status: 400 });

  const reasoning = reasoningFromBody(engine, body);
  if (reasoning.error) return NextResponse.json({ error: reasoning.error }, { status: 400 });
  const selectedModel = modelFromBody(body);
  if (selectedModel.error) return NextResponse.json({ error: selectedModel.error }, { status: 400 });
  const cwdResult = cwdFromBody(body.cwd);
  if (!cwdResult.cwd) return NextResponse.json({ error: cwdResult.error ?? "invalid working directory" }, { status: cwdResult.status ?? 400 });

  const { id } = await ctx.params;
  const task = loadTasks().find((item) => item.id === id);
  if (!task) return NextResponse.json({ error: "task not found" }, { status: 404 });

  try {
    const previous = pinnedAccountId(task.assignments, engine);
    const account = accountManager.resolveSpawn(engine, previous);
    const spec = freshSpecFor(engine, cwdResult.cwd, { model: selectedModel.model, effort: reasoning.effort, fast: reasoning.fast, codexHome: engine === "codex" ? account.home : null, claudeConfigDir: engine === "claude" ? account.home : null, claudeProjectsDir: engine === "claude" ? account.transcriptRoot : null });
    const startedAtMs = Date.now();
    const pane = await spawnAgentWithPrompt(spec, task.text);
    const transcript = await resolveSpawnedTranscriptPath({
      engine,
      knownTranscript: spec.transcript ?? null,
      panePid: pane.panePid ?? null,
      cwd: cwdResult.cwd,
      startedAtMs,
      codexSessionsDir: engine === "codex" ? account.transcriptRoot : null,
    });
    const at = isoNow();
    let patch: AssignmentPatch;
    if (transcript) {
      patch = { path: transcript, panePid: pane.panePid ?? null, state: "delivered", error: null, at, accountId: account.accountId, engine };
    } else if (pane.panePid) {
      patch = { path: null, panePid: pane.panePid, state: "spawning", error: null, at, accountId: account.accountId, engine };
    } else {
      patch = { path: null, panePid: null, state: "failed", error: "tmux did not return the pane pid", at, accountId: account.accountId, engine };
    }
    const result = mutateTasks((tasks) => {
      const outcome = applyAssignmentPatches(tasks, id, [patch], at);
      return { tasks: outcome.ok ? outcome.tasks : undefined, result: outcome };
    });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({
      ok: true,
      task: result.task,
      target: pane.display,
      path: patch.path,
      panePid: patch.panePid,
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
