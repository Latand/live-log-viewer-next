import { NextRequest, NextResponse } from "next/server";

import { authenticatedAgentSpawnCaller, isAgentInitiatedSpawn } from "@/app/api/spawn/admission";
import { agentRegistry } from "@/lib/agent/registry";
import { conversationAgentRole, isSpawnDeniedRole, reviewerOriginSpawnGuidance, type SpawnRejectionCode } from "@/lib/agent/spawnAdmission";
import { VIEWER_SPAWN_CAPABILITY_HEADER } from "@/lib/agent/spawnPolicy";
import { createPipelineFromRequest, getPipelines } from "@/lib/pipelines/engine";
import type { CreatePipelineRequest, Pipeline, PipelineRepoPreflightErrorCode, PipelinesResponse } from "@/lib/pipelines/types";
import { requestPipelineTick } from "@/lib/pipelines/controllerSignal";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import type { ApiError } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type PipelineApiError = ApiError & {
  code?: PipelineRepoPreflightErrorCode | SpawnRejectionCode;
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

/** Reviewer isolation for pipeline creation (#393): a pipeline is a spawn
    container, so a reviewer/verifier caller may not create one. The
    authenticated capability lane and a declared reviewer `src` are both
    rejected; external callers without a capability keep the #341 contract.
    Registry admission independently rejects every stage launch of any
    reviewer-created container, so this route check is defense in depth. */
function pipelineOriginRejection(req: NextRequest, body: CreatePipelineRequest): NextResponse<PipelineApiError> | null {
  if (!isAgentInitiatedSpawn(req)) return null;
  const registry = agentRegistry();
  const capability = req.headers.get(VIEWER_SPAWN_CAPABILITY_HEADER)?.trim();
  if (capability) {
    const caller = authenticatedAgentSpawnCaller(req, body.src, registry);
    if ("error" in caller) return NextResponse.json({ error: caller.error }, { status: caller.status ?? 403 });
    if (caller.kind === "agent") {
      const role = conversationAgentRole(registry.snapshot(), caller.conversationId);
      if (isSpawnDeniedRole(role)) {
        return NextResponse.json({ error: reviewerOriginSpawnGuidance(role), code: "reviewer_origin_spawn" }, { status: 403 });
      }
      if (typeof body.src !== "string" || !body.src.trim()) {
        const derivedPath = registry.conversation(caller.conversationId)?.generations.at(-1)?.path ?? null;
        if (!derivedPath) {
          return NextResponse.json({ error: "pipeline creator lineage is required; pass src" }, { status: 400 });
        }
        body.src = derivedPath;
      }
    }
    return null;
  }
  const srcPath = typeof body.src === "string" && body.src.trim() ? body.src.trim() : null;
  const srcConversation = srcPath ? registry.conversationForPath(srcPath) : null;
  if (srcConversation) {
    const role = conversationAgentRole(registry.snapshot(), srcConversation.id);
    if (isSpawnDeniedRole(role)) {
      return NextResponse.json({ error: reviewerOriginSpawnGuidance(role), code: "reviewer_origin_spawn" }, { status: 403 });
    }
  }
  return null;
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
    const originRejection = pipelineOriginRejection(req, body);
    if (originRejection) return originRejection;
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
