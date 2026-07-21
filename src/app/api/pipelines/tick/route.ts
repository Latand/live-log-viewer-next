import { NextRequest, NextResponse } from "next/server";

import { flowPipelineController } from "@/lib/pipelines/controller";
import { rejectCrossOrigin } from "@/lib/sameOrigin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type PipelineTick = () => Promise<void>;

async function post(request: NextRequest, tick: PipelineTick): Promise<NextResponse> {
  const rejection = rejectCrossOrigin(request);
  if (rejection) return rejection;
  await tick();
  return NextResponse.json({ ok: true }, { status: 202 });
}

export const POST = Object.assign(
  (request: NextRequest) => post(request, () => flowPipelineController().tick("remote-signal")),
  { withDependencies: (request: NextRequest, tick: PipelineTick) => post(request, tick) },
);
