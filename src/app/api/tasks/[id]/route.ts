import { NextRequest, NextResponse } from "next/server";

import { deleteTask, patchTask, type PatchTaskInput } from "@/lib/tasks/commands";
import { mutateTasks } from "@/lib/tasks/store";
import type { BoardTask } from "@/lib/tasks/types";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import type { ApiError } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type TaskRouteContext = {
  params: Promise<{ id: string }>;
};

export async function PATCH(
  req: NextRequest,
  ctx: TaskRouteContext,
): Promise<NextResponse<{ ok: true; task: BoardTask } | ApiError>> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;

  let body: PatchTaskInput;
  try {
    body = (await req.json()) as PatchTaskInput;
  } catch {
    return NextResponse.json({ error: "некоректний JSON" }, { status: 400 });
  }

  const { id } = await ctx.params;
  const result = mutateTasks((tasks) => {
    const outcome = patchTask(tasks, id, body);
    return { tasks: outcome.ok ? outcome.tasks : undefined, result: outcome };
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ ok: true, task: result.task });
}

export async function DELETE(_req: NextRequest, ctx: TaskRouteContext): Promise<NextResponse<{ ok: true } | ApiError>> {
  const rejection = rejectCrossOrigin(_req);
  if (rejection) return rejection;

  const { id } = await ctx.params;
  const result = mutateTasks((tasks) => {
    const outcome = deleteTask(tasks, id);
    return { tasks: outcome.ok ? outcome.tasks : undefined, result: outcome };
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ ok: true });
}
