import { NextRequest, NextResponse } from "next/server";

import type { RegistryFile, SnapshotSpawnProjection, SnapshotTitleConversationProjection } from "@/lib/agent/registry";
import { deadlineSignal, isAbortError, type DeadlineScheduler } from "@/lib/deadline";
import type { completedFileScan } from "@/lib/scanner/scanCache";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { collectSnapshot, type SnapshotPhaseObserver, type SnapshotPhaseTiming } from "@/lib/view/collect";
import { SnapshotError } from "@/lib/view/snapshot";
import type { resolveSiblings } from "@/lib/view/siblings";
import { readBoundedJson, validateSnapshotRequest, ViewValidationError } from "@/lib/view/validation";

const headers = { "Cache-Control": "no-store" };

export interface SnapshotRouteDependencies {
  completedFileScan: typeof completedFileScan;
  resolveSiblings: typeof resolveSiblings;
  registrySnapshot?: () => RegistryFile;
  snapshotSpawns?: (launchIds: readonly string[]) => SnapshotSpawnProjection;
  snapshotTitleConversations?: (conversationIds: readonly string[]) => SnapshotTitleConversationProjection;
  overlaySnapshotSessionTitles?: typeof import("@/lib/session/titleProjection")["overlaySnapshotSessionTitles"];
  observePhase?: SnapshotPhaseObserver;
  snapshotDeadlineMs: number;
  scheduler: DeadlineScheduler;
}

type RoutePhaseTiming = SnapshotPhaseTiming | {
  name: "encode";
  durationMs: number;
  cardinality: Readonly<Record<string, number>>;
};

function serverTiming(phases: readonly RoutePhaseTiming[]): string {
  return phases.map((phase) => {
    const description = Object.entries(phase.cardinality)
      .map(([key, value]) => `${key}=${value}`)
      .join(" ");
    return `snapshot-${phase.name};dur=${phase.durationMs.toFixed(1)}${description ? `;desc="${description}"` : ""}`;
  }).join(", ");
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
      const phases: RoutePhaseTiming[] = [];
      const payload = await collectSnapshot(body, {
        ...dependencies,
        signal: deadline.signal,
        observePhase: (timing) => {
          phases.push(timing);
          dependencies.observePhase?.(timing);
        },
      });
      const encodeStartedAt = performance.now();
      const response = NextResponse.json(payload, { headers });
      phases.push({
        name: "encode",
        durationMs: performance.now() - encodeStartedAt,
        cardinality: { conversations: payload.conversations.length, stubs: payload.stubs.length },
      });
      response.headers.set("Server-Timing", serverTiming(phases));
      return response;
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
