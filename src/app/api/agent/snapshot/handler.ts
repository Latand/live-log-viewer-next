import { NextRequest, NextResponse } from "next/server";

import type { RegistryFile } from "@/lib/agent/registry";
import { deadlineSignal, isAbortError, type DeadlineScheduler } from "@/lib/deadline";
import type { completedFileScan } from "@/lib/scanner/scanCache";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { collectSnapshot } from "@/lib/view/collect";
import { SnapshotError } from "@/lib/view/snapshot";
import type { resolveSiblings } from "@/lib/view/siblings";
import { readBoundedJson, validateSnapshotRequest, ViewValidationError } from "@/lib/view/validation";

const headers = { "Cache-Control": "no-store" };

export interface SnapshotRouteDependencies {
  completedFileScan: typeof completedFileScan;
  resolveSiblings: typeof resolveSiblings;
  registrySnapshot: () => RegistryFile;
  snapshotDeadlineMs: number;
  scheduler: DeadlineScheduler;
}

export async function postSnapshot(
  request: NextRequest,
  dependencies: SnapshotRouteDependencies,
): Promise<NextResponse> {
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
    /* A route-handler Request carries a Web signal, though the server adapter
       does not guarantee that a downstream socket close transitions it. Own a
       server deadline as the second cancellation source so cold work is bounded
       even when the framework signal remains live. */
    const deadline = deadlineSignal(dependencies.snapshotDeadlineMs, {
      signal: request.signal,
      scheduler: dependencies.scheduler,
      reason: "snapshot deadline exceeded",
    });
    try {
      return NextResponse.json(
        await collectSnapshot(body, { ...dependencies, signal: deadline.signal }),
        { headers },
      );
    } finally {
      deadline.release();
    }
  } catch (error) {
    if (error instanceof SnapshotError) return NextResponse.json({ error: error.code, message: error.message, ...(error.sessions ? { sessions: error.sessions } : {}) }, { status: error.status, headers });
    if (isAbortError(error)) {
      return NextResponse.json({ error: "REQUEST_CANCELLED", message: "the snapshot request ended" }, { status: 499, headers });
    }
    return NextResponse.json({ error: "SCANNER_UNAVAILABLE", message: "scanner unavailable" }, { status: 503, headers });
  }
}
