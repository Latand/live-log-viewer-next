import { NextResponse } from "next/server";

import { runtimeHostClient } from "@/lib/runtime/client";
import { runtimeEventsEnabled } from "@/lib/runtime/flags";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type OperationRouteContext = {
  params: Promise<{ operationId: string }>;
};

export async function GET(_request: Request, context: OperationRouteContext): Promise<NextResponse> {
  if (!runtimeEventsEnabled()) return NextResponse.json({ error: "runtime events are disabled" }, { status: 503 });
  const { operationId } = await context.params;
  if (!operationId || operationId.includes(":") || /\s/.test(operationId)) return NextResponse.json({ error: "operationId is invalid" }, { status: 400 });
  const client = runtimeHostClient();
  if (!client) return NextResponse.json({ error: "runtime host socket is unavailable" }, { status: 503 });
  try {
    const result = await client.operationStatus(operationId);
    return result ? NextResponse.json({ operationId: result.operationId, receipt: result.receipt }) : NextResponse.json({ error: "operation not found" }, { status: 404 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "runtime host is unavailable" }, { status: 503 });
  }
}
