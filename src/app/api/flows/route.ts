import { NextRequest, NextResponse } from "next/server";

import { getFlowsWithPresets } from "@/lib/flows/engine";
import type { FlowsResponse } from "@/lib/flows/types";
import type { ApiError } from "@/lib/types";

import { postFlow } from "./createHandler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse<FlowsResponse>> {
  return NextResponse.json(getFlowsWithPresets());
}

export async function POST(req: NextRequest): Promise<NextResponse<{ ok: true; flow: FlowsResponse["flows"][number] } | ApiError>> {
  return postFlow(req);
}
