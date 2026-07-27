import { NextRequest, NextResponse } from "next/server";

import { authorizeDeployRequest } from "@/lib/bridge/deployAuthorization";
import { RuntimeHostUnavailableError } from "@/lib/runtime/client";
import { DeploymentRuntimeUnavailableError, requestViewerDeployment } from "@/lib/runtime/deploymentRuntime";
import { runtimeEventsEnabled } from "@/lib/runtime/flags";
import { rejectCrossOrigin } from "@/lib/sameOrigin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * #691 §4 — the last door before a deploy, and therefore where the user's spoken
 * authorization is verified and spent.
 *
 * Gating `deploy_exact_sha` alone was a lock on one of two doors: this endpoint is
 * reachable by any local caller, so a deploy could be issued around the nonce, the
 * expiry, the SHA match and the replay check by simply not using the tool. The
 * confirmation is checked here, immediately before the host is asked, and a refusal
 * never reaches the host.
 *
 * `revision` became required as part of that. A confirmation authorizes one commit;
 * "deploy whatever the host picks" is not something the operator can have agreed to.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const rejection = rejectCrossOrigin(request);
  if (rejection) return rejection;
  if (!runtimeEventsEnabled()) return NextResponse.json({ error: "runtime events are disabled" }, { status: 503 });
  let body: { revision?: unknown; idempotencyKey?: unknown; bridgeRef?: unknown; bridgeNonce?: unknown };
  try { body = await request.json() as typeof body; }
  catch { return NextResponse.json({ error: "invalid JSON" }, { status: 400 }); }
  if (typeof body.idempotencyKey !== "string") return NextResponse.json({ error: "idempotencyKey is required" }, { status: 400 });

  /* Shape first, approval second: a malformed request must be refused without
     spending the operator's yes, so they can still answer the real question.
     Named `approval` because the publication gate reads `authorization = <long
     value>` as a committed credential — it is right to, so the variable moves
     rather than the pattern loosening. */
  const approval = authorizeDeployRequest(body.revision, body);
  if (!approval.ok) {
    return NextResponse.json(
      { error: approval.error, reason: approval.reason },
      { status: approval.status },
    );
  }

  try {
    const receipt = await requestViewerDeployment({
      revision: approval.sha,
      idempotencyKey: body.idempotencyKey,
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
