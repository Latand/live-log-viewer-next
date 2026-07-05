import { NextRequest, NextResponse } from "next/server";

import { createFlowFromRequest } from "@/lib/flows/commands";
import { getFlowsWithPresets } from "@/lib/flows/engine";
import type { CreateFlowRequest, FlowsResponse } from "@/lib/flows/types";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { listFiles } from "@/lib/scanner";
import type { ApiError } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse<FlowsResponse>> {
  return NextResponse.json(getFlowsWithPresets());
}

export async function POST(req: NextRequest): Promise<NextResponse<{ ok: true; flow: FlowsResponse["flows"][number] } | ApiError>> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;

  let body: CreateFlowRequest;
  try {
    body = (await req.json()) as CreateFlowRequest;
  } catch {
    return NextResponse.json({ error: "некоректний JSON" }, { status: 400 });
  }
  if (typeof body.implementerPath !== "string" || !body.implementerPath) {
    return NextResponse.json({ error: "потрібен implementerPath" }, { status: 400 });
  }

  try {
    const result = await createFlowFromRequest(body, await listFiles());
    if (!result.flow) return NextResponse.json({ error: result.error ?? "не вдалося створити флоу" }, { status: result.status ?? 400 });
    return NextResponse.json({ ok: true, flow: result.flow });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
