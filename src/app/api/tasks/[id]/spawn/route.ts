import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NextRequest, NextResponse } from "next/server";

import { freshSpecFor, type AgentEngine } from "@/lib/agent/cli";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { applyAssignmentPatches, type AssignmentPatch } from "@/lib/tasks/commands";
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
  if (!raw) return { error: "потрібна робоча директорія", status: 400 };
  const cwd = path.resolve(raw === "~" || raw.startsWith("~/") ? path.join(os.homedir(), raw.slice(1)) : raw);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(cwd);
  } catch {
    return { error: `директорії не існує: ${cwd}`, status: 400 };
  }
  if (!stat.isDirectory()) return { error: `не директорія: ${cwd}`, status: 400 };
  return { cwd };
}

export async function POST(req: NextRequest, ctx: TaskRouteContext): Promise<NextResponse<SpawnResponse | ApiError>> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;

  let body: { engine?: unknown; cwd?: unknown };
  try {
    body = (await req.json()) as { engine?: unknown; cwd?: unknown };
  } catch {
    return NextResponse.json({ error: "некоректний JSON" }, { status: 400 });
  }

  const engine = body.engine === "claude" || body.engine === "codex" ? (body.engine as AgentEngine) : null;
  if (!engine) return NextResponse.json({ error: "engine має бути claude або codex" }, { status: 400 });
  const cwdResult = cwdFromBody(body.cwd);
  if (!cwdResult.cwd) return NextResponse.json({ error: cwdResult.error ?? "некоректна робоча директорія" }, { status: cwdResult.status ?? 400 });

  const { id } = await ctx.params;
  const task = loadTasks().find((item) => item.id === id);
  if (!task) return NextResponse.json({ error: "задачу не знайдено" }, { status: 404 });

  try {
    const spec = freshSpecFor(engine, cwdResult.cwd);
    const pane = await spawnAgentWithPrompt(spec, task.text);
    const at = isoNow();
    let patch: AssignmentPatch;
    if (spec.transcript) {
      patch = { path: spec.transcript, panePid: pane.panePid ?? null, state: "delivered", error: null, at };
    } else if (pane.panePid) {
      patch = { path: null, panePid: pane.panePid, state: "spawning", error: null, at };
    } else {
      patch = { path: null, panePid: null, state: "failed", error: "tmux не повернув pid пейна", at };
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
