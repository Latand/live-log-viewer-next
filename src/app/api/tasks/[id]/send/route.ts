import { NextRequest, NextResponse } from "next/server";

import { deliverConversationMessage, type DeliveryOutcome } from "@/lib/delivery";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { listFiles } from "@/lib/scanner";
import { attachmentPath } from "@/lib/tasks/attachments";
import { applyAssignmentPatches } from "@/lib/tasks/commands";
import { isoNow, taskDeliveryText } from "@/lib/tasks/helpers";
import { assembleSendResults, type TaskSendTargetOutcome } from "@/lib/tasks/send";
import { loadTasks, mutateTasks } from "@/lib/tasks/store";
import type { BoardTask } from "@/lib/tasks/types";
import type { ApiError } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type TaskRouteContext = {
  params: Promise<{ id: string }>;
};

interface SendResponse {
  ok: true;
  task: BoardTask;
  results: TaskSendTargetOutcome[];
  delivered: number;
  failed: number;
}

function pathsFromBody(body: unknown): string[] | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const paths = (body as { paths?: unknown }).paths;
  if (!Array.isArray(paths)) return null;
  const normalized = paths.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
  return normalized.length === paths.length && normalized.length > 0 ? [...new Set(normalized)] : null;
}

export async function POST(req: NextRequest, ctx: TaskRouteContext): Promise<NextResponse<SendResponse | ApiError>> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const paths = pathsFromBody(body);
  if (!paths) return NextResponse.json({ error: "paths with conversations are required" }, { status: 400 });

  const { id } = await ctx.params;
  const task = loadTasks().find((item) => item.id === id);
  if (!task) return NextResponse.json({ error: "task not found" }, { status: 404 });

  const files = await listFiles();
  const byPath = new Map(files.map((file) => [file.path, file]));
  /* Durable attachment paths ride in the delivery text (the buildImagePayload
     convention: one path per line after the text). The bytes are task-owned
     from creation, so a failed delivery can never orphan or erase them — the
     old post-send base64 hop that silently dropped image-only tasks is gone. */
  const attachmentPaths = (task.attachments ?? []).map((att) => attachmentPath(att));
  const text = [taskDeliveryText(task.id, task.text), ...attachmentPaths].join("\n");
  const outcomes: DeliveryOutcome[] = [];
  for (const targetPath of paths) {
    const entry = byPath.get(targetPath);
    outcomes.push(await deliverConversationMessage({ pid: entry?.pid ?? null, path: targetPath, text, images: [] }));
  }

  const at = isoNow();
  const assembled = assembleSendResults(task, paths, outcomes, at);
  /* The deliveries above already happened; the serialized read-modify-write
     folds their outcome into the freshest snapshot (DELETE mid-send wins:
     the task is gone from that snapshot and nothing is resurrected). */
  const result = mutateTasks((tasks) => {
    const outcome = applyAssignmentPatches(tasks, id, assembled.patches, at);
    return { tasks: outcome.ok ? outcome.tasks : undefined, result: outcome };
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({
    ok: true,
    task: result.task,
    results: assembled.results,
    delivered: assembled.delivered,
    failed: assembled.failed,
  });
}
