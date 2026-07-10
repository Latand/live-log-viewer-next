import crypto from "node:crypto";

import { NextRequest, NextResponse } from "next/server";

import { CorruptClaudeAccountsError, UnknownClaudeAccountError, setActiveClaudeAccount } from "@/lib/accounts/claude";
import { createMigrationIntent, previewMigration } from "@/lib/accounts/migration/coordinator";
import { MigrationRevisionError } from "@/lib/agent/registry";
import { rejectCrossOrigin } from "@/lib/sameOrigin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const rejected = rejectCrossOrigin(req); if (rejected) return rejected;
  let body: { id?: unknown; mode?: unknown; requestId?: unknown; previewRevision?: unknown }; try { body = await req.json() as typeof body; } catch { return NextResponse.json({ error: "invalid JSON" }, { status: 400 }); }
  if (typeof body.id !== "string") return NextResponse.json({ error: "id must be a string" }, { status: 400 });
  try {
    if (body.mode === "preview") return NextResponse.json(await previewMigration("claude", body.id));
    if (body.mode === "migrate") {
      if (!Number.isInteger(body.previewRevision) || (body.previewRevision as number) < 0) return NextResponse.json({ error: "previewRevision must be a non-negative integer" }, { status: 400 });
      const requestId = typeof body.requestId === "string" ? body.requestId : crypto.randomUUID();
      if (!/^[\x20-\x7e]{1,128}$/.test(requestId)) return NextResponse.json({ error: "requestId must be printable and at most 128 characters" }, { status: 400 });
      const result = await createMigrationIntent("claude", body.id, "manual", requestId, body.previewRevision as number);
      let compatibilityPending = false;
      try { setActiveClaudeAccount(body.id); } catch { compatibilityPending = true; }
      return NextResponse.json({ ...result, compatibilityPending }, { status: 202 });
    }
    return NextResponse.json({ error: "mode must be preview or migrate" }, { status: 400 });
  }
  catch (error) {
    if (error instanceof MigrationRevisionError) {
      return NextResponse.json({ error: "migration preview is stale", preview: await previewMigration("claude", body.id) }, { status: 409 });
    }
    const known = error instanceof UnknownClaudeAccountError || error instanceof CorruptClaudeAccountsError;
    return NextResponse.json({ error: known ? error.message : "Claude account selection failed" }, { status: known ? 400 : 500 });
  }
}
