import { NextRequest, NextResponse } from "next/server";

import { claimMonitorRun, releaseMonitorRun } from "@/lib/monitor/journalStore";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import type { ApiError } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type LockResponse =
  | { claimed: true; token: string }
  | { claimed: false; detail: string }
  | { released: boolean };

/**
 * Single-flight admission for the conversation monitor (#741).
 *
 * Two overlapping runs would classify the same window against the same board
 * and race to create the same cards. The claim is atomic in
 * {@link claimMonitorRun}; this route is the only way to ask for it, so the
 * monitor process never opens the lock file itself.
 *
 * The winner gets a token, and only that token can release: a run that lost
 * the lock — or a stale one whose lock was reclaimed — cannot free the lock its
 * successor is now holding.
 */
export async function POST(req: NextRequest): Promise<NextResponse<LockResponse | ApiError>> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;
  let body: { action?: unknown; token?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  try {
    if (body.action === "claim") return NextResponse.json(claimMonitorRun());
    if (body.action === "release") {
      if (typeof body.token !== "string" || !body.token) {
        return NextResponse.json({ error: "token is required to release the lock" }, { status: 400 });
      }
      return NextResponse.json({ released: releaseMonitorRun(body.token) });
    }
    return NextResponse.json({ error: "action must be claim or release" }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "monitor lock unavailable" }, { status: 500 });
  }
}
