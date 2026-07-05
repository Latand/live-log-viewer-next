import { NextRequest, NextResponse } from "next/server";

import { patchFlow } from "@/lib/flows/commands";
import type { Flow, PatchFlowRequest } from "@/lib/flows/types";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import type { ApiError } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type FlowRouteContext = {
  params: Promise<{ id: string }>;
};

export async function PATCH(
  req: NextRequest,
  ctx: FlowRouteContext,
): Promise<NextResponse<{ ok: true; flow: Flow } | ApiError>> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;

  let body: PatchFlowRequest;
  try {
    body = (await req.json()) as PatchFlowRequest;
  } catch {
    return NextResponse.json({ error: "некоректний JSON" }, { status: 400 });
  }
  const { id } = await ctx.params;
  const result = patchFlow(id, body);
  if (!result.flow) return NextResponse.json({ error: result.error ?? "не вдалося змінити флоу" }, { status: result.status ?? 400 });
  return NextResponse.json({ ok: true, flow: result.flow });
}
