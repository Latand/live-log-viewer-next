import fs from "node:fs";

import { NextRequest, NextResponse } from "next/server";

import { attachmentPath, sweepAttachments } from "@/lib/tasks/attachments";
import { createTask, type CreateTaskInput, type CreateTaskResult } from "@/lib/tasks/commands";
import { mutateTasksFile } from "@/lib/tasks/store";
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
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const result = mutateTasksFile<CreateTaskResult>((state) => {
    const outcome = createTask(state.tasks, body, state.recentCreates, {
      /* An attachment ref only becomes task-owned once its bytes are actually
         in the store — a stale/forged ref is rejected loudly, never dangling. */
      attachmentExists: (att) => fs.existsSync(attachmentPath(att)),
    });
    /* Persist only a fresh create; a validation failure or a replay (which left
       the list and receipts untouched) skips the rewrite. */
    const persist = outcome.ok && !outcome.replay ? { tasks: outcome.tasks, recentCreates: outcome.recentCreates } : undefined;
    return { state: persist, result: outcome };
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  /* Best-effort GC of stale, unreferenced staged uploads — never touches a file
     any task still references, so this create's own attachments are safe. */
  if (!result.replay) sweepAttachments(result.tasks, Date.now());
  return NextResponse.json({ ok: true, task: result.task });
}
