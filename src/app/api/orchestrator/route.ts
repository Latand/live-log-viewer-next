import { NextRequest, NextResponse } from "next/server";

import { requireOperatorAuthority } from "@/lib/agent/operatorAuthority";
import { adoptOrchestratorRecord, orchestratorRecordExists, readOrchestratorRecord, replaceOrchestratorIncumbent, type OrchestratorRecord } from "@/lib/orchestrator/store";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import type { ApiError } from "@/lib/types";

/* A route module may export ONLY the documented route fields — the HTTP method
   handlers and the segment config below. Next.js validates that list at build
   time, so a helper, a type or a test seam exported from here fails
   `next build` even though `tsc --noEmit` accepts it. */
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
    /* `process.cwd()` is only right when the server runs from the checkout. A
       containerized deployment's cwd is container-internal (the stage's `/app`),
       and a manager spawned there lands in a bogus path-encoded project
       (`-app`) with a fallback working directory. Deployments that do not run
       from the checkout must pin the manager's home explicitly. */
    defaultCwd: process.env.LLV_ORCHESTRATOR_CWD?.trim() || process.cwd(),
  });
}

export async function POST(req: NextRequest): Promise<NextResponse<{ ok: true; record: OrchestratorRecord; adopted: boolean; replaced: boolean } | ApiError>> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;

  /* #691 round 5 — DESIGNATION IS OPERATOR-ONLY, and it has to be, because every
     other gate in the bridge keys off "is this the designated manager": a worker
     able to appoint itself would inherit manager-only `bridge_report` and the rest
     in one move. Checked before the body is read and before anything is retired, so
     a refusal leaves both the record and the live incumbent exactly as they were —
     a refusal that killed the incumbent first would be its own denial of service. */
  const operator = requireOperatorAuthority(req);
  if (!operator.ok) {
    return NextResponse.json({ error: operator.error }, { status: operator.status });
  }
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
    /* AXIS SEPARATION (two-axis contract; HIGH 4 of the #758 review): a
       replacement is a DESIGNATION act and nothing more. The predecessor's
       host, session, card and ordinary Viewer access are untouched — the era
       in which this route killed the outgoing manager is over. Split-brain is
       prevented where authority is decided, per call: the record now names the
       successor, so the predecessor's next manager-voice or confirmation-mint
       attempt is refused by the durable designation checks, and the epoch
       guard in the seat store keeps a revoked identity from returning. */
    const record = replaceOrchestratorIncumbent(candidate);
    return NextResponse.json({ ok: true, record, adopted: true, replaced: true });
  }
  const { record, adopted } = adoptOrchestratorRecord(candidate);
  return NextResponse.json({ ok: true, record, adopted, replaced: false });
}
