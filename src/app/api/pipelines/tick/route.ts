import { NextRequest, NextResponse } from "next/server";

import { tickPipelines } from "@/lib/pipelines/engine";
import { rejectCrossOrigin } from "@/lib/sameOrigin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type PipelineTick = typeof tickPipelines;

async function post(request: NextRequest, tick: PipelineTick): Promise<NextResponse> {
  const rejection = rejectCrossOrigin(request);
  if (rejection) return rejection;
  await tick([]);
  await tick([]);
  return NextResponse.json({ ok: true }, { status: 202 });
}

export const POST = Object.assign(
  (request: NextRequest) => post(request, tickPipelines),
  { withDependencies: (request: NextRequest, tick: PipelineTick) => post(request, tick) },
);
