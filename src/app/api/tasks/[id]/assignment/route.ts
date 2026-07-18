import { NextRequest, NextResponse } from "next/server";

import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { applyAssignmentPatches, assignmentRefFromBody, removeAssignment, type AssignmentPatch } from "@/lib/tasks/commands";
import { isoNow } from "@/lib/tasks/helpers";
import { mutateTasks } from "@/lib/tasks/store";
import type { BoardTask } from "@/lib/tasks/types";
import type { ApiError } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type TaskRouteContext = {
  params: Promise<{ id: string }>;
};

function pathFromBody(body: unknown): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const path = (body as { path?: unknown }).path;
  return typeof path === "string" && path.trim().length > 0 ? path.trim() : null;
}

/**
 * Records a handoff link: the task text was routed into this agent's composer,
 * nothing was delivered. The assignment is a removable marker of where the
 * task went — never a claim that the agent received or ran it.
 */
export async function POST(req: NextRequest, ctx: TaskRouteContext): Promise<NextResponse<{ ok: true; task: BoardTask } | ApiError>> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const path = pathFromBody(body);
  if (!path) return NextResponse.json({ error: "path is required" }, { status: 400 });

  const { id } = await ctx.params;
  const at = isoNow();
  const patch: AssignmentPatch = { path, panePid: null, state: "handoff", error: null, at };
  const result = mutateTasks((tasks) => {
    const outcome = applyAssignmentPatches(tasks, id, [patch], at);
    return { tasks: outcome.ok ? outcome.tasks : undefined, result: outcome };
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ ok: true, task: result.task });
}

/** Detaches one assignment from the task — the undo for a wrong handoff. */
export async function DELETE(req: NextRequest, ctx: TaskRouteContext): Promise<NextResponse<{ ok: true; task: BoardTask } | ApiError>> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const ref = assignmentRefFromBody(body);
  if (!ref) return NextResponse.json({ error: "launchId, path, conversationId or panePid is required" }, { status: 400 });

  const { id } = await ctx.params;
  const result = mutateTasks((tasks) => {
    const outcome = removeAssignment(tasks, id, ref);
    return { tasks: outcome.ok ? outcome.tasks : undefined, result: outcome };
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ ok: true, task: result.task });
}
