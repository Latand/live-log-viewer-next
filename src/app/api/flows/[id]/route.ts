import { NextRequest, NextResponse } from "next/server";

import { cancelRound, closeFlow, patchFlow } from "@/lib/flows/commands";
import { requestFlowTick } from "@/lib/flows/controllerSignal";
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
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const { id } = await ctx.params;
  const result =
    body.action === "cancel-round" ? await cancelRound(id) : body.action === "close" ? await closeFlow(id) : patchFlow(id, body);
  if (!result.flow) return NextResponse.json({ error: result.error ?? "could not update flow" }, { status: result.status ?? 400 });
  if (body.action !== "cancel-round" && body.action !== "close" && body.action !== "pause") requestFlowTick(id);
  return NextResponse.json({ ok: true, flow: result.flow });
}
