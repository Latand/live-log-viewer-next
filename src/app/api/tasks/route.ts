import { NextRequest, NextResponse } from "next/server";

import { createTask, type CreateTaskInput } from "@/lib/tasks/commands";
import { mutateTasks } from "@/lib/tasks/store";
import type { BoardTask } from "@/lib/tasks/types";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import type { ApiError } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse<{ ok: true; task: BoardTask } | ApiError>> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;

  let body: CreateTaskInput;
  try {
    body = (await req.json()) as CreateTaskInput;
  } catch {
    return NextResponse.json({ error: "некоректний JSON" }, { status: 400 });
  }

  const result = mutateTasks((tasks) => {
    const outcome = createTask(tasks, body);
    return { tasks: outcome.ok ? outcome.tasks : undefined, result: outcome };
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ ok: true, task: result.task });
}
