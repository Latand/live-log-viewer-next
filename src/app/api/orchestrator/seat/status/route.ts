import { NextRequest, NextResponse } from "next/server";

import type { ApiError } from "@/lib/types";

import { readOrchestratorIncumbent, type OrchestratorIncumbentBody } from "./incumbent";

/* The orchestrator panel's incumbent read (PRD #976 slice B): who holds the
   seat, how worn they are, and whether the server recommends rotating.
   Everything with behavior lives in `./incumbent` — a route module may export
   only the documented route fields, so the composition sits where its tests can
   import it.

   Separate from `GET /api/orchestrator/seat` on purpose. That read decides
   whether the panel is a draft or a conversation, so it is polled fast and stays
   a directory lookup; this one parses the transcript and asks the liveness plane,
   which is a slower question the panel asks on its own slower cadence. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse<OrchestratorIncumbentBody | ApiError>> {
  const project = req.nextUrl.searchParams.get("project")?.trim() ?? "";
  if (!project) return NextResponse.json({ error: "project is required" }, { status: 400 });
  return NextResponse.json(await readOrchestratorIncumbent(project));
}
