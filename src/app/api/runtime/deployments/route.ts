import { NextRequest, NextResponse } from "next/server";

import { RuntimeHostUnavailableError, runtimeHostClient } from "@/lib/runtime/client";
import { DeploymentRuntimeUnavailableError, requestViewerDeployment } from "@/lib/runtime/deploymentRuntime";
import { runtimeEventsRolledBack, RUNTIME_PLANE_ABSENT } from "@/lib/runtime/flags";
import { rejectCrossOrigin } from "@/lib/sameOrigin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_LIST_LIMIT = 25;
const MAX_LIST_LIMIT = 100;

function deploymentListLimit(request: NextRequest): number | null {
  const rawLimit = request.nextUrl.searchParams.get("limit");
  if (rawLimit === null) return null;
  const parsedLimit = rawLimit && /^\d+$/.test(rawLimit)
    ? Number(rawLimit)
    : DEFAULT_LIST_LIMIT;
  return Math.max(1, Math.min(MAX_LIST_LIMIT, parsedLimit));
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (runtimeEventsRolledBack()) {
    return NextResponse.json(
      { error: "runtime events are disabled", code: RUNTIME_PLANE_ABSENT },
      { status: 503 },
    );
  }
  const client = runtimeHostClient();
  if (!client) {
    return NextResponse.json(
      { error: "runtime host socket is unavailable", code: RUNTIME_PLANE_ABSENT },
      { status: 503 },
    );
  }
  const limit = deploymentListLimit(request);
  try {
    const ledger = (await client.snapshot()).deployments;
    const deployments = limit === null ? ledger : ledger.slice(-limit);
    return NextResponse.json({ count: deployments.length, deployments });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "runtime host is unavailable" },
      { status: 503 },
    );
  }
}

/**
 * #795 — the deploy door for HTTP callers, at parity with the MCP binding and
 * the raw runtime-host socket: the same request shape (an exact revision and an
 * idempotency key), the same admission, the same serialized coordinator.
 *
 * The deploy DECISION belongs to the designated agent and is enforced where
 * that agent acts — the deploy binding derives authority from the
 * server-attributed designated-seat identity. No confirmation proof exists
 * anywhere anymore, so nothing here forwards or verifies one.
 *
 * `revision` is required as a full commit SHA: an exact-SHA deployment ships
 * one immutable commit, and "deploy whatever the host picks" is not a request.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const rejection = rejectCrossOrigin(request);
  if (rejection) return rejection;
  if (runtimeEventsRolledBack()) {
    return NextResponse.json(
      { error: "runtime events are disabled", code: RUNTIME_PLANE_ABSENT },
      { status: 503 },
    );
  }
  let body: { revision?: unknown; idempotencyKey?: unknown };
  try { body = await request.json() as typeof body; }
  catch { return NextResponse.json({ error: "invalid JSON" }, { status: 400 }); }
  if (typeof body.idempotencyKey !== "string") return NextResponse.json({ error: "idempotencyKey is required" }, { status: 400 });
  if (typeof body.revision !== "string" || !/^[0-9a-f]{40}$/i.test(body.revision)) {
    return NextResponse.json(
      { error: "revision must be a full 40-character commit SHA", reason: "revision_invalid" },
      { status: 400 },
    );
  }

  try {
    const receipt = await requestViewerDeployment({
      revision: body.revision.toLowerCase(),
      idempotencyKey: body.idempotencyKey,
    });
    return NextResponse.json(receipt, { status: receipt.state === "busy" ? 409 : 202 });
  } catch (error) {
    if (error instanceof DeploymentRuntimeUnavailableError) {
      return NextResponse.json(
        { error: error.message, code: RUNTIME_PLANE_ABSENT },
        { status: 503 },
      );
    }
    const status = error instanceof RuntimeHostUnavailableError && error.code === "idempotency-conflict" ? 409 : 503;
    return NextResponse.json({ error: error instanceof Error ? error.message : "viewer deployment request failed" }, { status });
  }
}
