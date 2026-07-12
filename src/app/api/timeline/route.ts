import { NextRequest, NextResponse } from "next/server";

import { listFiles } from "@/lib/scanner";
import { overlaySessionTitles } from "@/lib/session/titleProjection";
import { projectTimeline } from "@/lib/timeline";
import type { ActionEvent, ApiError } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Recent project actions for the timeline map: GET /api/timeline?project=…&limit=… */
export async function GET(
  req: NextRequest,
): Promise<NextResponse<{ events: ActionEvent[] } | ApiError>> {
  const project = req.nextUrl.searchParams.get("project") ?? "";
  if (!project) return NextResponse.json({ error: "project required" }, { status: 400 });
  let limit = Number(req.nextUrl.searchParams.get("limit") ?? "240");
  if (!Number.isFinite(limit) || limit <= 0) limit = 240;
  const files = await listFiles();
  overlaySessionTitles(files);
  return NextResponse.json({ events: projectTimeline(files, project, Math.min(limit, 600)) });
}
