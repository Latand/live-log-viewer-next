import { NextRequest, NextResponse } from "next/server";

import { runtimeHostClient } from "@/lib/runtime/client";
import { runtimeEventsRolledBack, RUNTIME_PLANE_ABSENT } from "@/lib/runtime/flags";
import { handleRuntimeRetry } from "@/lib/runtime/http";
import { resolveSendReceipt, runtimeReceiptForSend } from "@/lib/runtime/sendSettlement";

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
  /* #1131: one settlement reader, whichever surface asks. This route used to
     report the journal's raw state and nothing else, so an accepted send could
     answer `queued` for as long as the outage lasted and answer 503 once the
     socket was gone — the same "acceptance is the last word" this issue was
     opened for, on the API `message_receipt` shares. Settling FIRST also keeps
     the two answers from contradicting each other: past the deadline the fence
     is written before the journal is read back. */
  const send = await resolveSendReceipt(operationId).catch(() => null);
  const client = runtimeHostClient();
  /* An absent plane and an unreachable one stay distinct answers: only the
     first carries the code, and reporting a dead socket as a rolled-back plane
     is what makes an outage look like a configuration. */
  let unreachable: string | null = null;
  if (client) {
    try {
      const result = await client.operationStatus(operationId);
      if (result) {
        return NextResponse.json({
          operationId: result.operationId,
          receipt: result.receipt,
          ...(send ? { send } : {}),
        });
      }
    } catch (error) {
      unreachable = error instanceof Error ? error.message : "runtime host is unavailable";
    }
  }
  /* The journal could not answer. The durable delivery record still can, and
     for an accepted send that is the whole point of settling it there. */
  if (send) return NextResponse.json({ operationId, receipt: runtimeReceiptForSend(send), send });
  if (unreachable) return NextResponse.json({ error: unreachable }, { status: 503 });
  if (!client) {
    return NextResponse.json(
      { error: "runtime host socket is unavailable", code: RUNTIME_PLANE_ABSENT },
      { status: 503 },
    );
  }
  return NextResponse.json({ error: "operation not found" }, { status: 404 });
}

export async function POST(request: NextRequest, context: OperationRouteContext): Promise<NextResponse> {
  const { operationId } = await context.params;
  return handleRuntimeRetry(request, operationId);
}
