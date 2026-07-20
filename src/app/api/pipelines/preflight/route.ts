import { NextRequest, NextResponse } from "next/server";

import {
  pipelineRepoPreflightError,
  pipelineRepoPreflightStatus,
  preflightPipelineRepo,
} from "@/lib/pipelines/preflight";
import type { PipelineRepoPreflight } from "@/lib/pipelines/types";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import type { ApiError } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type PreflightSuccess = Extract<PipelineRepoPreflight, { ok: true }>;
type PreflightFailure = ApiError & {
  code: Extract<PipelineRepoPreflight, { ok: false }>["code"];
  field: "repoDir";
  path: string;
  /** The underlying transient reason for a probe_failed (#353 AC3 fidelity). */
  detail?: string;
};

type Dependencies = { preflight: typeof preflightPipelineRepo };

async function postPreflight(
  req: NextRequest,
  dependencies: Dependencies = { preflight: preflightPipelineRepo },
): Promise<NextResponse<PreflightSuccess | PreflightFailure>> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection as NextResponse<PreflightFailure>;
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON", code: "missing", field: "repoDir", path: "" }, { status: 400 });
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return NextResponse.json({ error: "request body must be an object", code: "missing", field: "repoDir", path: "" }, { status: 400 });
  }
  const repoDir = typeof (raw as { repoDir?: unknown }).repoDir === "string"
    ? (raw as { repoDir: string }).repoDir.trim()
    : "";
  if (!repoDir) {
    return NextResponse.json({ error: "repository directory is required", code: "missing", field: "repoDir", path: "" }, { status: 400 });
  }

  // The picker's validation warms the short-TTL success cache so the follow-up
  // creation request reuses this probe instead of re-running git (#353 AC2).
  const result = dependencies.preflight(repoDir, undefined, { cache: true });
  if (result.ok) return NextResponse.json(result);
  return NextResponse.json(
    {
      error: pipelineRepoPreflightError(result),
      code: result.code,
      field: "repoDir",
      path: result.path,
      ...(result.detail ? { detail: result.detail } : {}),
    },
    { status: pipelineRepoPreflightStatus(result.code) },
  );
}

export const POST = Object.assign(
  (req: NextRequest) => postPreflight(req),
  { withDependencies: postPreflight },
);
