import { NextRequest, NextResponse } from "next/server";

import { describeDeployProof } from "@/lib/bridge/deployAuthorization";
import { RuntimeHostUnavailableError } from "@/lib/runtime/client";
import { DeploymentRuntimeUnavailableError, requestViewerDeployment } from "@/lib/runtime/deploymentRuntime";
import { runtimeEventsEnabled } from "@/lib/runtime/flags";
import { rejectCrossOrigin } from "@/lib/sameOrigin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * #691 §4 — one of several doors, and deliberately not the lock.
 *
 * Sealing endpoints one at a time was the wrong shape: the MCP binding, this route
 * and a raw runtime-host socket are three ways to ask for the same deploy, and each
 * gate closed only its own. The authoritative check now lives at HOST ADMISSION,
 * where every caller converges — so this route forwards the proof and refuses early
 * only to give a caller a useful answer without a round trip.
 *
 * `revision` is required here for the same reason it is there: a confirmation
 * authorizes one commit, and "deploy whatever the host picks" is not something the
 * operator can have agreed to.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const rejection = rejectCrossOrigin(request);
  if (rejection) return rejection;
  if (!runtimeEventsEnabled()) return NextResponse.json({ error: "runtime events are disabled" }, { status: 503 });
  let body: { revision?: unknown; idempotencyKey?: unknown; bridgeRef?: unknown; bridgeNonce?: unknown };
  try { body = await request.json() as typeof body; }
  catch { return NextResponse.json({ error: "invalid JSON" }, { status: 400 }); }
  if (typeof body.idempotencyKey !== "string") return NextResponse.json({ error: "idempotencyKey is required" }, { status: 400 });

  /* Shape only — nothing is spent here. Verifying without consuming would be a
     check the host repeats; consuming would spend the operator's yes before the one
     gate that matters ever sees it, and the real deploy would then be refused as
     already consumed. */
  const shape = describeDeployProof(body.revision, body);
  if (!shape.ok) {
    return NextResponse.json({ error: shape.error, reason: shape.reason }, { status: shape.status });
  }

  try {
    const receipt = await requestViewerDeployment({
      revision: shape.sha,
      idempotencyKey: body.idempotencyKey,
      bridgeProof: { ref: body.bridgeRef, nonce: body.bridgeNonce },
    });
    return NextResponse.json(receipt, { status: receipt.state === "busy" ? 409 : 202 });
  } catch (error) {
    if (error instanceof DeploymentRuntimeUnavailableError) {
      return NextResponse.json({ error: error.message }, { status: 503 });
    }
    const status = error instanceof RuntimeHostUnavailableError && error.code === "idempotency-conflict" ? 409 : 503;
    return NextResponse.json({ error: error instanceof Error ? error.message : "viewer deployment request failed" }, { status });
  }
}
