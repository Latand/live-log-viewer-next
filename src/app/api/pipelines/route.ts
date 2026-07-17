import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NextRequest, NextResponse } from "next/server";

import { createPipelineFromRequest, getPipelines } from "@/lib/pipelines/engine";
import type { CreatePipelineRequest, Pipeline, PipelinesResponse } from "@/lib/pipelines/types";
import { requestPipelineTick } from "@/lib/pipelines/controllerSignal";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import type { ApiError } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse<PipelinesResponse | ApiError>> {
  try {
    return NextResponse.json(getPipelines());
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "pipeline registry unreadable" }, { status: 500 });
  }
}
export async function POST(req: NextRequest): Promise<NextResponse<{ ok: true; pipeline: Pipeline } | ApiError>> {
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
  const rawDir = typeof body.repoDir === "string" ? body.repoDir.trim() : "";
  if (!rawDir) return NextResponse.json({ error: "repository directory is required" }, { status: 400 });
  const repoDir = path.resolve(rawDir === "~" || rawDir.startsWith("~/") ? path.join(os.homedir(), rawDir.slice(1)) : rawDir);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(repoDir);
  } catch {
    return NextResponse.json({ error: `directory does not exist: ${repoDir}` }, { status: 400 });
  }
  if (!stat.isDirectory()) return NextResponse.json({ error: `not a directory: ${repoDir}` }, { status: 400 });
  try {
    const result = await createPipelineFromRequest({ ...body, repoDir });
    if (!result.pipeline) return NextResponse.json({ error: result.error ?? "could not create pipeline" }, { status: result.status ?? 400 });
    if (result.pipeline.state !== "draft") requestPipelineTick();
    return NextResponse.json({ ok: true, pipeline: result.pipeline }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
