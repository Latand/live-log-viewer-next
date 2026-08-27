import { NextRequest, NextResponse } from "next/server";

import { runtimeHostClient } from "@/lib/runtime/client";
import { runtimeEventsRolledBack, RUNTIME_PLANE_ABSENT } from "@/lib/runtime/flags";
import { handleRuntimeAbandon, handleRuntimeRetry } from "@/lib/runtime/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type OperationRouteContext = {
  params: Promise<{ operationId: string }>;
};

export async function GET(_request: Request, context: OperationRouteContext): Promise<NextResponse> {
  if (runtimeEventsRolledBack()) {
    return NextResponse.json(
      { error: "runtime events are disabled", code: RUNTIME_PLANE_ABSENT },
      { status: 503 },
    );
  }
  const { operationId } = await context.params;
  if (!operationId || operationId.includes(":") || /\s/.test(operationId)) return NextResponse.json({ error: "operationId is invalid" }, { status: 400 });
  const client = runtimeHostClient();
  if (!client) {
    return NextResponse.json(
      { error: "runtime host socket is unavailable", code: RUNTIME_PLANE_ABSENT },
      { status: 503 },
    );
  }
  try {
    const result = await client.operationStatus(operationId);
    return result ? NextResponse.json({ operationId: result.operationId, receipt: result.receipt }) : NextResponse.json({ error: "operation not found" }, { status: 404 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "runtime host is unavailable" }, { status: 503 });
  }
}

export async function POST(request: NextRequest, context: OperationRouteContext): Promise<NextResponse> {
  const { operationId } = await context.params;
  return handleRuntimeRetry(request, operationId);
}

/**
 * Discard an unconfirmed delivery (issue #1213): the operator's exit from a
 * message that never reached the agent. Terminalizes the operation and retires
 * its durable send effect, so nothing can hand the message over afterwards.
 */
export async function DELETE(request: NextRequest, context: OperationRouteContext): Promise<NextResponse> {
  const { operationId } = await context.params;
  return handleRuntimeAbandon(request, operationId);
}
