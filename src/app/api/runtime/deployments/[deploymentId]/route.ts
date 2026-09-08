import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { NextRequest, NextResponse } from "next/server";

import { runtimeHostClient } from "@/lib/runtime/client";
import { runtimeEventsRolledBack, RUNTIME_PLANE_ABSENT } from "@/lib/runtime/flags";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type DeploymentRouteContext = { params: Promise<{ deploymentId: string }> };

export async function GET(_request: Request, context: DeploymentRouteContext): Promise<NextResponse> {
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
  const { deploymentId } = await context.params;
  try {
    const status = await client.readViewerDeployment(deploymentId);
    return status ? NextResponse.json(status) : NextResponse.json({ error: "viewer deployment was not found" }, { status: 404 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "runtime host is unavailable" }, { status: 503 });
  }
}

/** Explicit cancellation requests rollback through the owning coordinator;
 * it never directly changes the target, leases or candidate processes. */
export async function DELETE(request: NextRequest, context: DeploymentRouteContext): Promise<NextResponse> {
  const rejection = rejectCrossOrigin(request);
  if (rejection) return rejection;
  if (runtimeEventsRolledBack()) return NextResponse.json({ error: "runtime events are disabled", code: RUNTIME_PLANE_ABSENT }, { status: 503 });
  const client = runtimeHostClient();
  if (!client) return NextResponse.json({ error: "runtime host socket is unavailable", code: RUNTIME_PLANE_ABSENT }, { status: 503 });
  const { deploymentId } = await context.params;
  try {
    if (!client.cancelViewerDeployment) throw new Error("deployment cancellation is unavailable");
    const status = await client.cancelViewerDeployment(deploymentId);
    return status ? NextResponse.json(status) : NextResponse.json({ error: "viewer deployment was not found" }, { status: 404 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "runtime host is unavailable" }, { status: 503 });
  }
}
