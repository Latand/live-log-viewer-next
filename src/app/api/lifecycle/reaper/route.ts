import { NextRequest, NextResponse } from "next/server";

import { readReaperReport } from "@/lib/reaperRuntime";
import { rejectCrossOrigin } from "@/lib/sameOrigin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;
  const report = readReaperReport();
  if (!report) return NextResponse.json({ error: "reaper report is not available yet" }, { status: 503 });
  return NextResponse.json(report, { headers: { "Cache-Control": "no-store" } });
}
