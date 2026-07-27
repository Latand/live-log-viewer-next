import { NextRequest, NextResponse } from "next/server";

import { adoptOrchestratorRecord, orchestratorRecordExists, readOrchestratorRecord, replaceOrchestratorIncumbent, type OrchestratorRecord } from "@/lib/orchestrator/store";
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

export async function POST(req: NextRequest): Promise<NextResponse<{ ok: true; record: OrchestratorRecord; adopted: boolean; replaced: boolean } | ApiError>> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;
  let body: { conversationId?: unknown; path?: unknown; replace?: unknown; engine?: unknown; model?: unknown };
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
  for (const field of ["engine", "model"] as const) {
    const value = body[field];
    if (value !== undefined && (typeof value !== "string" || !value.trim())) {
      return NextResponse.json({ error: `${field} must be a non-empty string` }, { status: 400 });
    }
  }

  /* #691 §3, AC23 — seating a new incumbent is a different act from adopting the
     first one, so the caller has to say which one it means. Adoption still refuses a
     second conversation while one is live (that refusal IS the single-instance
     guarantee); `replace` is the operator swapping the manager's model on purpose,
     and it deliberately touches nothing but this record — the bridge cursors
     reference the record by name and survive it untouched. */
  const candidate = {
    conversationId: body.conversationId.trim(),
    path: typeof body.path === "string" && body.path ? body.path : null,
    createdAt: new Date().toISOString(),
    ...(typeof body.engine === "string" ? { engine: body.engine.trim() } : {}),
    ...(typeof body.model === "string" ? { model: body.model.trim() } : {}),
  };
  if (body.replace === true) {
    const record = replaceOrchestratorIncumbent(candidate);
    return NextResponse.json({ ok: true, record, adopted: true, replaced: true });
  }
  const { record, adopted } = adoptOrchestratorRecord(candidate);
  return NextResponse.json({ ok: true, record, adopted, replaced: false });
}
