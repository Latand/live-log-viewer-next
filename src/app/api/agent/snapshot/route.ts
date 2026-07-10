import { NextRequest, NextResponse } from "next/server";

import { observeFiles } from "@/lib/scanner/observe";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { collectSnapshot } from "@/lib/view/collect";
import { SnapshotError } from "@/lib/view/snapshot";
import { resolveSiblings } from "@/lib/view/siblings";
import { readBoundedJson, validateSnapshotRequest, ViewValidationError } from "@/lib/view/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };

export async function POST(request: NextRequest): Promise<NextResponse> {
  const rejection = rejectCrossOrigin(request);
  if (rejection) { rejection.headers.set("Cache-Control", "no-store"); return rejection; }
  let body: ReturnType<typeof validateSnapshotRequest>;
  try {
    body = validateSnapshotRequest(await readBoundedJson(request));
  } catch (error) {
    if (error instanceof ViewValidationError) return NextResponse.json({ error: error.code, message: error.message }, { status: error.status, headers });
    return NextResponse.json({ error: "INVALID_REQUEST", message: "invalid request" }, { status: 400, headers });
  }
  try {
    return NextResponse.json(await collectSnapshot(body, { observeFiles, resolveSiblings }), { headers });
  } catch (error) {
    if (error instanceof SnapshotError) return NextResponse.json({ error: error.code, message: error.message, ...(error.sessions ? { sessions: error.sessions } : {}) }, { status: error.status, headers });
    return NextResponse.json({ error: "SCANNER_UNAVAILABLE", message: "scanner unavailable" }, { status: 503, headers });
  }
}
