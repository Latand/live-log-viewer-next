import { NextResponse } from "next/server";

import { readBurndown } from "@/lib/limits";
import type { BurndownPayload } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Burndown history for the quota chart: GET /api/limits/history */
export async function GET(): Promise<NextResponse<BurndownPayload>> {
  return NextResponse.json(await readBurndown());
}
