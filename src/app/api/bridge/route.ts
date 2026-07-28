import { NextRequest, NextResponse } from "next/server";

import {
  bridgeTurnStartPrelude,
  issueBridgeAcknowledgementToken,
  pendingBridgeDelivery,
  redeemBridgeAcknowledgement,
} from "@/lib/bridge/service";
import { requireOperatorAuthority } from "@/lib/agent/operatorAuthority";
import { authenticateBridgeGateway } from "@/lib/bridge/gatewayAuthority";
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
 *
 * AUTHENTICATED, because the payload is not merely private — it carries the
 * single-use nonces that authorize deploys. An unauthenticated loopback reader could
 * harvest one and then approve a deploy in the operator's name, which defeats the
 * confirmation design entirely. The caller proves it is the live gateway surface by
 * presenting the realtime session id the backend minted for the root's call; nobody
 * else holds it.
 *
 * And an acknowledgement names the batch it received, by the token issued with it —
 * never a sequence of the caller's choosing, which would let a caller retire every
 * blocker and question in the log without ever reading one.
 */

/** Whatever the operator's browser is willing to say it already played. Bounded so
    a hostile or confused client cannot make the server walk an unbounded list. */
const MAX_ACKNOWLEDGED_IDS = 256;

export async function GET(request: NextRequest): Promise<NextResponse> {
  const parameters = request.nextUrl.searchParams;
  /* The LIVE path: the drain carries deploy nonces, so reading it needs the same
     proof writing into the call does. */
  const gateway = authenticateBridgeGateway(parameters.get("realtimeSessionId"));
  if (!gateway.ok) return NextResponse.json({ error: gateway.error }, { status: 403, headers });

  /* The no-call path (§4). A turn is about to open with no live call to interject
     into, so its inbox becomes part of that turn's own input. Same cursor, same
     caps, same "read moves nothing" rule as the live drain. */
  if (parameters.get("mode") === "turn-start") {
    /* The NO-CALL path, so a live session id is exactly what does not exist here —
       requiring one defeated the branch it was added to protect. The operator's own
       composer is opening a turn, so the operator credential is the right proof. */
    const operator = requireOperatorAuthority(request);
    if (!operator.ok) return NextResponse.json({ error: operator.error }, { status: operator.status, headers });
    try {
      const prelude = bridgeTurnStartPrelude({ now: new Date() });
      return NextResponse.json({
        ok: true,
        prelude: prelude
          ? { text: prelude.text, ackToken: issueBridgeAcknowledgementToken(prelude.throughSeq) }
          : null,
      }, { headers });
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
    /* The seq never leaves; the token does. A caller settles the batch it was given
       and cannot name another. */
    if (plan.kind === "idle" || plan.kind === "hold") {
      return NextResponse.json({ ok: true, plan }, { headers });
    }
    const ackToken = issueBridgeAcknowledgementToken(plan.throughSeq);
    return NextResponse.json({
      ok: true,
      plan: plan.kind === "deliver"
        ? { kind: "deliver", delivery: plan.delivery, ackToken }
        : { kind: "already-acknowledged", ackToken },
    }, { headers });
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const rejection = rejectCrossOrigin(request);
  if (rejection) return rejection;
  let body: { ackToken?: unknown; realtimeSessionId?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400, headers });
  }
  /* Either proof settles a batch: the live peer that received it, or the operator
     whose turn carried it. Both are the gateway surface; neither is an agent. */
  const gateway = authenticateBridgeGateway(
    typeof body.realtimeSessionId === "string" ? body.realtimeSessionId : null,
  );
  if (!gateway.ok && !requireOperatorAuthority(request).ok) {
    return NextResponse.json({ error: gateway.error }, { status: 403, headers });
  }

  /* The batch, by the token it was handed out with. A caller cannot name a sequence:
     acknowledging reports it never received is how the whole inbox goes quiet. */
  if (typeof body.ackToken !== "string" || !body.ackToken.trim()) {
    return NextResponse.json({ error: "ackToken from the delivered batch is required" }, { status: 400, headers });
  }
  try {
    const settled = redeemBridgeAcknowledgement(body.ackToken.trim());
    if (!settled.ok) {
      return NextResponse.json({ error: "ackToken does not match the outstanding batch" }, { status: 409, headers });
    }
    return NextResponse.json({ ok: true, throughSeq: settled.throughSeq }, { headers });
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
