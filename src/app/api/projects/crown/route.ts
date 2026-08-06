import { NextRequest, NextResponse } from "next/server";

import { canonicalProject } from "@/lib/projects/aliases";
import { projectCurationSnapshot, setProjectCrown } from "@/lib/projects/curation";
import { rejectCrossOrigin } from "@/lib/sameOrigin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };

export async function POST(request: NextRequest): Promise<NextResponse> {
  const rejection = rejectCrossOrigin(request);
  if (rejection) { rejection.headers.set("Cache-Control", "no-store"); return rejection; }
  let payload: unknown = null;
  try {
    payload = await request.json();
  } catch {
    // fall through to the shape check
  }
  const record = payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : null;
  const project = typeof record?.project === "string" ? record.project.trim() : "";
  const crowned = record?.crowned;
  if (!project || project.length > 256 || typeof crowned !== "boolean") {
    return NextResponse.json({ error: "INVALID_REQUEST", message: "project and crowned are required" }, { status: 400, headers });
  }
  /* Store under the canonical identity so every client resolves the same row. */
  if (!setProjectCrown(canonicalProject(project), crowned)) {
    return NextResponse.json({ error: "INTERNAL_ERROR", message: "could not persist the crown state" }, { status: 500, headers });
  }
  return NextResponse.json({ ok: true, crownedProjects: projectCurationSnapshot().crowned }, { headers });
}
