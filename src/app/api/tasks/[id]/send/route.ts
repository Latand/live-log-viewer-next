import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";

import { deliverConversationMessage, type DeliveryOutcome } from "@/lib/delivery";
import { directOperatorActivityAuthority } from "@/lib/agent/operatorAuthority";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { listFiles } from "@/lib/scanner";
import { attachmentPath } from "@/lib/tasks/attachments";
import { applyAssignmentPatches } from "@/lib/tasks/commands";
import { isoNow, taskDeliveryText } from "@/lib/tasks/helpers";
import { assembleSendResults, type TaskSendTargetOutcome } from "@/lib/tasks/send";
import { loadTasks, mutateTasks } from "@/lib/tasks/store";
import type { BoardTask } from "@/lib/tasks/types";
import type { ApiError } from "@/lib/types";
import {
  recordDirectOperatorWakatimeActivity,
  settleDirectOperatorWakatimeCompatibility,
} from "@/lib/wakatime/operatorActivity";

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

interface TaskSendDependencies {
  loadTasks: typeof loadTasks;
  listFiles: typeof listFiles;
  deliverConversationMessage: typeof deliverConversationMessage;
  mutateTasks: typeof mutateTasks;
  recordOperatorActivity: typeof recordDirectOperatorWakatimeActivity;
  settleOperatorCompatibility: typeof settleDirectOperatorWakatimeCompatibility;
}

const productionDependencies: TaskSendDependencies = {
  loadTasks,
  listFiles,
  deliverConversationMessage,
  mutateTasks,
  recordOperatorActivity: recordDirectOperatorWakatimeActivity,
  settleOperatorCompatibility: settleDirectOperatorWakatimeCompatibility,
};

async function postTaskSend(
  req: NextRequest,
  ctx: TaskRouteContext,
  dependencies: TaskSendDependencies = productionDependencies,
): Promise<NextResponse<SendResponse | ApiError>> {
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
  const task = dependencies.loadTasks().find((item) => item.id === id);
  if (!task) return NextResponse.json({ error: "task not found" }, { status: 404 });

  const files = await dependencies.listFiles();
  const byPath = new Map(files.map((file) => [file.path, file]));
  const targetEntries = paths.flatMap((targetPath) => {
    const target = byPath.get(targetPath);
    return target && (target.engine === "claude" || target.engine === "codex") ? [target] : [];
  }).sort((left, right) => left.path.localeCompare(right.path));
  const clientRequestId = body && typeof body === "object" && !Array.isArray(body)
    && typeof (body as { clientRequestId?: unknown }).clientRequestId === "string"
    ? (body as { clientRequestId: string }).clientRequestId.trim().slice(0, 128)
    : "";
  if (clientRequestId && !/^[A-Za-z0-9_-]{8,128}$/.test(clientRequestId)) {
    return NextResponse.json({ error: "clientRequestId must be 8-128 URL-safe characters" }, { status: 400 });
  }
  let compatibilityActionKey: string | undefined;
  if (targetEntries[0] && directOperatorActivityAuthority(req).ok) {
    const compatibilityFingerprint = crypto.createHash("sha256")
      .update(JSON.stringify({ taskId: task.id, paths: [...paths].sort() }))
      .digest("hex");
    try {
      const action = dependencies.recordOperatorActivity({
        ...(clientRequestId
          ? { idempotencyKey: `task-send:${clientRequestId}` }
          : { compatibilityFingerprint }),
        resolvedAttribution: {
          engine: targetEntries[0].engine === "claude" ? "claude" : "codex",
          project: task.project,
        },
      });
      if (!clientRequestId) compatibilityActionKey = action?.key;
    } catch {
      return NextResponse.json({ error: "direct operator activity could not be recorded" }, { status: 503 });
    }
  }
  /* Durable attachment paths ride in the delivery text (the buildImagePayload
     convention: one path per line after the text). The bytes are task-owned
     from creation, so a failed delivery can never orphan or erase them — the
     old post-send base64 hop that silently dropped image-only tasks is gone. */
  const attachmentPaths = (task.attachments ?? []).map((att) => attachmentPath(att));
  const text = [taskDeliveryText(task.id, task.text), ...attachmentPaths].join("\n");
  const outcomes: DeliveryOutcome[] = [];
  for (const targetPath of paths) {
    const entry = byPath.get(targetPath);
    outcomes.push(await dependencies.deliverConversationMessage({ pid: entry?.pid ?? null, path: targetPath, text, images: [] }));
  }

  const at = isoNow();
  const assembled = assembleSendResults(task, paths, outcomes, at);
  /* The deliveries above already happened; the serialized read-modify-write
     folds their outcome into the freshest snapshot (DELETE mid-send wins:
     the task is gone from that snapshot and nothing is resurrected). */
  const result = dependencies.mutateTasks((tasks) => {
    const outcome = applyAssignmentPatches(tasks, id, assembled.patches, at);
    return { tasks: outcome.ok ? outcome.tasks : undefined, result: outcome };
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  if (compatibilityActionKey) {
    try {
      dependencies.settleOperatorCompatibility(compatibilityActionKey);
    } catch {
      return NextResponse.json({ error: "direct operator activity could not be settled" }, { status: 503 });
    }
  }
  return NextResponse.json({
    ok: true,
    task: result.task,
    results: assembled.results,
    delivered: assembled.delivered,
    failed: assembled.failed,
  });
}

export const POST = Object.assign(
  async (req: NextRequest, ctx: TaskRouteContext): Promise<NextResponse<SendResponse | ApiError>> => postTaskSend(req, ctx),
  { withDependencies: postTaskSend },
);
