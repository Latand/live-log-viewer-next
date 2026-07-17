import { NextRequest, NextResponse } from "next/server";

import { requestPipelineTick } from "@/lib/pipelines/controllerSignal";
import { patchPipeline } from "@/lib/pipelines/engine";
import type { PatchPipelineRequest, Pipeline, PipelineAction } from "@/lib/pipelines/types";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import type { ApiError } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ACTIONS = new Set<PipelineAction>([
  "start", "update-draft", "add-stage", "remove-stage", "reorder-stage",
  "pause", "resume", "retry-stage", "skip-stage", "override-stage", "delete", "close",
]);

const CONTROLLER_ACTIONS = new Set<PipelineAction>(["start", "resume", "retry-stage", "skip-stage"]);

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse<{ ok: true; pipeline: Pipeline } | ApiError>> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;
  let body: PatchPipelineRequest;
  try {
    const raw = await req.json();
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return NextResponse.json({ error: "request body must be an object" }, { status: 400 });
    body = raw as PatchPipelineRequest;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (!ACTIONS.has(body.action)) return NextResponse.json({ error: "unknown pipeline action" }, { status: 400 });
  const { id } = await ctx.params;
  try {
    const result = await patchPipeline(id, body);
    if (!result.pipeline) return NextResponse.json({ error: result.error ?? "could not update pipeline" }, { status: result.status ?? 400 });
    if (CONTROLLER_ACTIONS.has(body.action)) requestPipelineTick();
    return NextResponse.json({ ok: true, pipeline: result.pipeline });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "could not update pipeline" }, { status: 500 });
  }
}

export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse<{ ok: true; pipeline: Pipeline } | ApiError>> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;
  const { id } = await ctx.params;
  try {
    const result = await patchPipeline(id, { action: "delete" });
    if (!result.pipeline) return NextResponse.json({ error: result.error ?? "could not delete pipeline" }, { status: result.status ?? 400 });
    return NextResponse.json({ ok: true, pipeline: result.pipeline });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "could not delete pipeline" }, { status: 500 });
  }
}
