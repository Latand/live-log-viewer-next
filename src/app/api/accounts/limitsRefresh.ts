import { NextRequest, NextResponse } from "next/server";

import { accountProjection } from "@/lib/accounts/accountProjection";
import { refreshAccountLimits, type LiveLimitsDeps } from "@/lib/accounts/liveLimits";
import type { MigrationEngine } from "@/lib/accounts/migration/contracts";
import { rejectCrossOrigin } from "@/lib/sameOrigin";

/**
 * `POST /api/accounts/{engine}/limits` `{ id }` (issue #1418): re-read one
 * account's live limits now. The response carries the same per-account block
 * `GET /api/accounts` sends, so the card merges it in place: `limits.checkedAt`
 * is the moment of this read and the windows are what the provider answered.
 */
export async function handleLimitsRefresh(engine: MigrationEngine, req: NextRequest, deps: LiveLimitsDeps = {}): Promise<NextResponse> {
  const rejected = rejectCrossOrigin(req);
  if (rejected) return rejected;
  let body: { id?: unknown };
  try { body = await req.json() as { id?: unknown }; } catch { return NextResponse.json({ error: "invalid JSON", code: "invalid_json" }, { status: 400 }); }
  if (typeof body.id !== "string" || !body.id.trim()) return NextResponse.json({ error: "id must be a string", code: "invalid_request" }, { status: 400 });
  const result = await refreshAccountLimits(engine, body.id, deps);
  if (result.kind === "unknown_account") return NextResponse.json({ error: `${engine} account is unavailable`, code: "unknown_account" }, { status: 404 });
  if (result.kind === "probe_failed") {
    return NextResponse.json({ error: "live limits read failed", code: "probe_failed", detail: result.detail }, { status: 502 });
  }
  const now = deps.now ?? Date.now();
  return NextResponse.json({
    account: { id: result.account.id, ...accountProjection(result.observation, result.account.authPresent, now) },
  });
}
