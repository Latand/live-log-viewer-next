import { NextResponse } from "next/server";

import { runtimeHostClient } from "@/lib/runtime/client";
import { runtimeEventsEnabled } from "@/lib/runtime/flags";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type DeploymentRouteContext = { params: Promise<{ deploymentId: string }> };

export async function GET(_request: Request, context: DeploymentRouteContext): Promise<NextResponse> {
  if (!runtimeEventsEnabled()) return NextResponse.json({ error: "runtime events are disabled" }, { status: 503 });
  const client = runtimeHostClient();
  if (!client) return NextResponse.json({ error: "runtime host socket is unavailable" }, { status: 503 });
  const { deploymentId } = await context.params;
  try {
    const status = await client.readViewerDeployment(deploymentId);
    return status ? NextResponse.json(status) : NextResponse.json({ error: "viewer deployment was not found" }, { status: 404 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "runtime host is unavailable" }, { status: 503 });
  }
}
