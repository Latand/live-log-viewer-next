import { NextRequest, NextResponse } from "next/server";

import { createPipelineFromRequest, getPipelines } from "@/lib/pipelines/engine";
import type { CreatePipelineRequest, Pipeline, PipelineRepoPreflightErrorCode, PipelinesResponse } from "@/lib/pipelines/types";
import { requestPipelineTick } from "@/lib/pipelines/controllerSignal";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import type { ApiError } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type PipelineApiError = ApiError & {
  code?: PipelineRepoPreflightErrorCode;
  field?: "repoDir";
  path?: string;
};

export async function GET(): Promise<NextResponse<PipelinesResponse | ApiError>> {
  try {
    return NextResponse.json(getPipelines());
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "pipeline registry unreadable" }, { status: 500 });
  }
}
export async function POST(req: NextRequest): Promise<NextResponse<{ ok: true; pipeline: Pipeline } | PipelineApiError>> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;
  let body: CreatePipelineRequest;
  try {
    const raw = await req.json();
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return NextResponse.json({ error: "request body must be an object" }, { status: 400 });
    body = raw as CreatePipelineRequest;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  try {
    const result = await createPipelineFromRequest(body);
    if (!result.pipeline) return NextResponse.json({
      error: result.error ?? "could not create pipeline",
      ...(result.code ? { code: result.code, field: result.field, path: result.path } : {}),
    }, { status: result.status ?? 400 });
    if (result.pipeline.state !== "draft") requestPipelineTick();
    return NextResponse.json({ ok: true, pipeline: result.pipeline }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
