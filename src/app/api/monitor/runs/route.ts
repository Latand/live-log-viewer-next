import { NextRequest, NextResponse } from "next/server";

import { appendRunRecord, readRunRecords, sanitizeRunRecord } from "@/lib/monitor/journalStore";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import type { MonitorRunRecord } from "@/lib/monitor/types";
import type { ApiError } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 200;

/**
 * The conversation monitor's audit journal (#741).
 *
 * The monitor runs as its own process on a schedule, and every other fact it
 * reads or writes goes through this API; its audit trail does too, so nothing
 * outside the viewer opens a state file. The viewer owns the format, the
 * retention and the validation.
 */
export async function GET(req: NextRequest): Promise<NextResponse<{ runs: MonitorRunRecord[] } | ApiError>> {
  const raw = req.nextUrl.searchParams.get("limit");
  const parsed = raw && /^\d+$/.test(raw) ? Number(raw) : DEFAULT_LIMIT;
  const limit = Math.min(Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_LIMIT, MAX_LIMIT);
  try {
    return NextResponse.json({ runs: readRunRecords(limit) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "monitor journal unreadable" }, { status: 500 });
  }
}

export async function POST(req: NextRequest): Promise<NextResponse<{ ok: true; record: MonitorRunRecord } | ApiError>> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;
  let body: { record?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  /* Sanitizing here, not in the caller, is what keeps the journal's privacy
     promise structural: only the audit fields survive, so a record carrying
     transcript text or a path in an extra property loses it at the door. */
  const record = sanitizeRunRecord(body.record);
  if (!record) return NextResponse.json({ error: "record is not a monitor run record" }, { status: 400 });
  try {
    appendRunRecord(record);
    return NextResponse.json({ ok: true, record });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "monitor journal unwritable" }, { status: 500 });
  }
}
