import { NextRequest, NextResponse } from "next/server";

import { observeFiles, ObservationCancelledError } from "@/lib/scanner/observe";
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
    /* `NextRequest` extends the web `Request`, so it carries the runtime's own
       cancellation signal. Handing it down is what stops a corpus walk from
       outliving the client that asked for it (#845). */
    return NextResponse.json(
      await collectSnapshot(body, { observeFiles, resolveSiblings, signal: request.signal }),
      { headers },
    );
  } catch (error) {
    if (error instanceof SnapshotError) return NextResponse.json({ error: error.code, message: error.message, ...(error.sessions ? { sessions: error.sessions } : {}) }, { status: error.status, headers });
    /* A cancelled read is the client having gone, not the scanner being down; 499
       is never delivered anywhere, so the status only has to be honest in logs. */
    if (error instanceof ObservationCancelledError) {
      return NextResponse.json({ error: "REQUEST_CANCELLED", message: "the client went away" }, { status: 499, headers });
    }
    return NextResponse.json({ error: "SCANNER_UNAVAILABLE", message: "scanner unavailable" }, { status: 503, headers });
  }
}
