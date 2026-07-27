import { NextRequest, NextResponse } from "next/server";

import {
  acknowledgeBridgeDelivery,
  bridgeTurnStartPrelude,
  pendingBridgeDelivery,
} from "@/lib/bridge/service";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { FileTransactionBusyError } from "@/lib/state/fileTransaction";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const headers = { "Cache-Control": "no-store" };

/**
 * The gateway's report drain (#691 §4).
 *
 * The design calls this a host-side seam with no tool, and that is the point: the
 * voice root does not *ask* for its inbox, the surface hosting its call pulls what
 * the manager left and hands it to the live session. So this is an ordinary
 * same-origin route the card polls while a call is up, not part of the agent's
 * minimal toolset.
 *
 * Two verbs, in the only order that is safe: GET says what is pending without
 * moving anything, POST records what actually arrived. A drain that advanced the
 * cursor by itself would lose any batch that died between the response and the
 * call.
 */

/** Whatever the operator's browser is willing to say it already played. Bounded so
    a hostile or confused client cannot make the server walk an unbounded list. */
const MAX_ACKNOWLEDGED_IDS = 256;

export async function GET(request: NextRequest): Promise<NextResponse> {
  const parameters = request.nextUrl.searchParams;

  /* The no-call path (§4). A turn is about to open with no live call to interject
     into, so its inbox becomes part of that turn's own input. Same cursor, same
     caps, same "read moves nothing" rule as the live drain. */
  if (parameters.get("mode") === "turn-start") {
    try {
      return NextResponse.json({ ok: true, prelude: bridgeTurnStartPrelude({ now: new Date() }) }, { headers });
    } catch (error) {
      return failure(error);
    }
  }

  const acknowledgedDeliveryIds = parameters.getAll("acked").slice(-MAX_ACKNOWLEDGED_IDS);
  const lastBatchAtRaw = parameters.get("lastBatchAt");
  const lastBatchAt = lastBatchAtRaw && Number.isFinite(Date.parse(lastBatchAtRaw))
    ? new Date(lastBatchAtRaw)
    : null;

  try {
    const plan = pendingBridgeDelivery({ now: new Date(), lastBatchAt, acknowledgedDeliveryIds });
    return NextResponse.json({ ok: true, plan }, { headers });
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const rejection = rejectCrossOrigin(request);
  if (rejection) return rejection;
  let body: { throughSeq?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400, headers });
  }
  if (!Number.isInteger(body.throughSeq) || (body.throughSeq as number) < 1) {
    return NextResponse.json({ error: "throughSeq must be a positive integer" }, { status: 400, headers });
  }
  try {
    acknowledgeBridgeDelivery(body.throughSeq as number);
    return NextResponse.json({ ok: true }, { headers });
  } catch (error) {
    return failure(error);
  }
}

/** Contention is retryable and says so, matching the attention record's shape —
    a busy state file is a "come back", never a lost report. */
function failure(error: unknown): NextResponse {
  if (error instanceof FileTransactionBusyError) {
    return NextResponse.json(
      { error: "BRIDGE_STATE_BUSY", message: error.message, retryable: true },
      { status: 503, headers },
    );
  }
  return NextResponse.json(
    { error: "BRIDGE_UNAVAILABLE", message: error instanceof Error ? error.message : String(error) },
    { status: 500, headers },
  );
}
