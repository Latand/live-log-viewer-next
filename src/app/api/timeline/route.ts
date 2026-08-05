import { NextRequest, NextResponse } from "next/server";

import { completedFileScan } from "@/lib/scanner/scanCache";
import { overlaySessionTitles } from "@/lib/session/titleProjection";
import { projectTimeline } from "@/lib/timeline";
import type { ActionEvent, ApiError } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Recent project actions for the timeline map: GET /api/timeline?project=…&limit=…
 *
 * Serves from the latest completed scan generation. A fresh `listFiles()` here
 * re-derived the whole corpus (thousands of head/tail reads through 64-entry
 * caches) per poll and held the project view on skeletons for minutes; the
 * timeline only needs path/mtime/size/fmt/title for one project's fresh files,
 * which the cached snapshot already carries. Background revalidation keeps the
 * generation current. */
export async function GET(
  req: NextRequest,
): Promise<NextResponse<{ events: ActionEvent[] } | ApiError>> {
  const project = req.nextUrl.searchParams.get("project") ?? "";
  if (!project) return NextResponse.json({ error: "project required" }, { status: 400 });
  let limit = Number(req.nextUrl.searchParams.get("limit") ?? "240");
  if (!Number.isFinite(limit) || limit <= 0) limit = 240;
  const completed = await completedFileScan();
  /* Shallow copies: the overlay stamps titles in place while the completed
     scan's records are shared with every other consumer of the cache. */
  const files = completed.snapshot.files.map((entry) => ({ ...entry }));
  overlaySessionTitles(files);
  return NextResponse.json({ events: projectTimeline(files, project, Math.min(limit, 600)) });
}
