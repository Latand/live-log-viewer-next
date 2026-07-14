import { NextRequest, NextResponse } from "next/server";

import { adoptOrchestratorRecord, orchestratorRecordExists, readOrchestratorRecord, type OrchestratorRecord } from "@/lib/orchestrator/store";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import type { ApiError } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface OrchestratorStatus {
  record: OrchestratorRecord | null;
  /** Whether the recorded transcript is still on disk; false invites a respawn. */
  exists: boolean;
  /** Where a fresh orchestrator spawns: the viewer's own checkout, so the
      llv-conveyor skill and the repo context are in reach. */
  defaultCwd: string;
}

export async function GET(): Promise<NextResponse<OrchestratorStatus>> {
  const record = readOrchestratorRecord();
  return NextResponse.json({
    record,
    exists: record !== null && orchestratorRecordExists(record),
    defaultCwd: process.cwd(),
  });
}

export async function POST(req: NextRequest): Promise<NextResponse<{ ok: true; record: OrchestratorRecord; adopted: boolean } | ApiError>> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;
  let body: { conversationId?: unknown; path?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (typeof body.conversationId !== "string" || !body.conversationId.trim()) {
    return NextResponse.json({ error: "conversationId is required" }, { status: 400 });
  }
  if (body.path !== undefined && body.path !== null && typeof body.path !== "string") {
    return NextResponse.json({ error: "path must be a string or null" }, { status: 400 });
  }
  const { record, adopted } = adoptOrchestratorRecord({
    conversationId: body.conversationId.trim(),
    path: typeof body.path === "string" && body.path ? body.path : null,
    createdAt: new Date().toISOString(),
  });
  return NextResponse.json({ ok: true, record, adopted });
}
