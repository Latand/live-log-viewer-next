import crypto from "node:crypto";

import { NextRequest, NextResponse } from "next/server";

import { CorruptCodexAccountsError, UnknownAccountError, setActiveCodexAccount } from "@/lib/accounts/codex";
import { createMigrationIntent, previewMigration } from "@/lib/accounts/migration/coordinator";
import { requestAccountMigrationTick } from "@/lib/accounts/migration/controllerSignal";
import { MigrationRevisionError } from "@/lib/agent/registry";
import { rejectCrossOrigin } from "@/lib/sameOrigin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const rejected = rejectCrossOrigin(req);
  if (rejected) return rejected;
  let body: { id?: unknown; mode?: unknown; scope?: unknown; requestId?: unknown; previewRevision?: unknown };
  try { body = await req.json() as typeof body; } catch { return NextResponse.json({ error: "invalid JSON" }, { status: 400 }); }
  if (typeof body.id !== "string") return NextResponse.json({ error: "id must be a string" }, { status: 400 });
  try {
    if (body.mode === "preview") return NextResponse.json(await previewMigration("codex", body.id));
    if (body.mode === "migrate") {
      if (!Number.isInteger(body.previewRevision) || (body.previewRevision as number) < 0) return NextResponse.json({ error: "previewRevision must be a non-negative integer" }, { status: 400 });
      if (body.scope !== undefined && body.scope !== "active" && body.scope !== "all") return NextResponse.json({ error: "scope must be active or all" }, { status: 400 });
      const requestId = typeof body.requestId === "string" ? body.requestId : crypto.randomUUID();
      if (!/^[\x20-\x7e]{1,128}$/.test(requestId)) return NextResponse.json({ error: "requestId must be printable and at most 128 characters" }, { status: 400 });
      const result = await createMigrationIntent("codex", body.id, "manual", requestId, body.previewRevision as number, body.scope ?? "active");
      let compatibilityPending = false;
      try { setActiveCodexAccount(body.id); } catch { compatibilityPending = true; }
      requestAccountMigrationTick();
      return NextResponse.json({ ...result, compatibilityPending }, { status: 202 });
    }
    return NextResponse.json({ error: "mode must be preview or migrate" }, { status: 400 });
  } catch (error) {
    if (error instanceof MigrationRevisionError) {
      return NextResponse.json({ error: "migration preview is stale", preview: await previewMigration("codex", body.id) }, { status: 409 });
    }
    const known = error instanceof UnknownAccountError || error instanceof CorruptCodexAccountsError;
    return NextResponse.json({ error: known ? error.message : "Codex account selection failed" }, { status: known ? 400 : 500 });
  }
}
