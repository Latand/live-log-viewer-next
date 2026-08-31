import { NextRequest, NextResponse } from "next/server";

import { isCanonicalBranchRef } from "@/lib/runtime/canonicalRevision";
import { RuntimeHostUnavailableError, runtimeHostClient, runtimeHostRequestHealth } from "@/lib/runtime/client";
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
    return NextResponse.json({
      count: deployments.length,
      deployments,
      runtimeHostRequests: runtimeHostRequestHealth(),
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "runtime host is unavailable",
        runtimeHostRequests: runtimeHostRequestHealth(),
      },
      { status: 503 },
    );
  }
}

/**
 * #795 — the deploy door for HTTP callers, at parity with the MCP binding and
 * the raw runtime-host socket: the same request shape (a deploy target and an
 * idempotency key), the same admission, the same serialized coordinator.
 *
 * The deploy DECISION belongs to the designated agent and is enforced where
 * that agent acts — the deploy binding derives authority from the
 * server-attributed designated-seat identity. No confirmation proof exists
 * anywhere anymore, so nothing here forwards or verifies one.
 *
 * A request names its target one of two ways. `revision` is a full commit SHA:
 * an exact-SHA deployment ships one immutable commit, and "deploy whatever the
 * host picks" is not a request. `ref` names a branch of the canonical
 * repository (#1033) and the host resolves it to a commit machine-to-machine,
 * so no caller has to carry a SHA through its own notes — the mangled tail in
 * #1032 deployed a revision that never existed for six hours. Either way the
 * ledger records the exact resolved SHA.
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
  let body: { revision?: unknown; ref?: unknown; idempotencyKey?: unknown };
  try { body = await request.json() as typeof body; }
  catch { return NextResponse.json({ error: "invalid JSON" }, { status: 400 }); }
  if (typeof body.idempotencyKey !== "string") return NextResponse.json({ error: "idempotencyKey is required" }, { status: 400 });
  if (body.ref !== undefined && body.revision !== undefined) {
    return NextResponse.json(
      { error: "a deployment names either revision or ref, not both", reason: "target_ambiguous" },
      { status: 400 },
    );
  }
  let target: { revision: string } | { ref: string };
  if (body.ref !== undefined) {
    if (typeof body.ref !== "string" || !isCanonicalBranchRef(body.ref)) {
      return NextResponse.json(
        { error: "ref must name a canonical repository branch as refs/heads/<branch>", reason: "ref_invalid" },
        { status: 400 },
      );
    }
    target = { ref: body.ref };
  } else {
    if (typeof body.revision !== "string" || !/^[0-9a-f]{40}$/i.test(body.revision)) {
      return NextResponse.json(
        { error: "revision must be a full 40-character commit SHA", reason: "revision_invalid" },
        { status: 400 },
      );
    }
    target = { revision: body.revision.toLowerCase() };
  }

  try {
    const receipt = await requestViewerDeployment({ ...target, idempotencyKey: body.idempotencyKey });
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
