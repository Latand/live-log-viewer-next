import {
  BRIDGE_LIVE_BATCH_INTERVAL_MS,
  type BridgeReportBatch,
  type BridgeReportV1,
} from "@/lib/bridge/types";
import { formatBridgeTrailer } from "@/lib/bridge/directive";

import {
  appendVoiceResponse,
  normalizeAcknowledgedVoiceDeliveryIds,
  type RuntimeVoiceDelivery,
} from "./voiceDelivery";

/**
 * Manager reports arriving in a live call (#691 §4).
 *
 * This adds no delivery machinery. The worker-response seam in `voiceDelivery.ts`
 * already solves the hard part — a completed response is queued, delivered into
 * the call once, acknowledged with a tombstone that survives reload, hangup and
 * journal compaction — and it solves it in code that has been in production
 * through several bug fixes. A second mechanism for bridge reports would be a
 * second set of those bugs.
 *
 * So a batch of reports is expressed *as* a worker delivery: a synthetic turn id
 * naming the batch, one response per report. The delivery id then falls out of the
 * existing derivation, which means every tombstone, ack and resume path already
 * written applies verbatim.
 *
 * The coalescing rule lives here because it is about the call, not the log: the
 * gateway is mid-conversation with a person, and interrupting them more than once
 * per window is a UX decision the durable log has no opinion about.
 */

const BRIDGE_TURN_PREFIX = "bridge:";

/** One synthetic turn per batch, named by the highest seq it carries. Two batches
    can never merge into one delivery, which `appendVoiceResponse` would do if they
    shared a turn id. */
export function bridgeDeliveryTurnId(throughSeq: number): string {
  return `${BRIDGE_TURN_PREFIX}${throughSeq}`;
}

export function bridgeReportResponseId(seq: number): string {
  return `report:${seq}`;
}

/** Whether a delivery turn came from the bridge rather than from a worker. The
    call-side flush loop treats both identically; this exists for diagnostics and
    for tests that assert the two families stay distinguishable. */
export function isBridgeDeliveryTurn(turnId: string): boolean {
  return turnId.startsWith(BRIDGE_TURN_PREFIX);
}

export interface BridgeDeliveryPlan {
  delivery: RuntimeVoiceDelivery;
  /** Cursor to acknowledge once the call has taken delivery — never before. */
  throughSeq: number;
}

/**
 * What the gateway says when a report arrives.
 *
 * The class is stated because the gateway has no work log to infer it from, and
 * a `failed` that reads like a `status` is how a blocker gets voiced as progress.
 * A confirmation request additionally carries the exact strings the gateway must
 * echo back — there is no other channel for them, and paraphrasing a SHA is how a
 * deploy authorizes the wrong commit.
 */
function reportText(report: BridgeReportV1): string {
  const body = report.body.trim();
  const head = `[${report.class}]${body ? ` ${body}` : ""}`;
  if (report.class !== "confirmation_request" || !report.confirmation) return head;
  const { sha, nonce, expiresAt } = report.confirmation;
  return [
    head,
    `Deploy authorization requested for commit ${sha} (expires ${expiresAt}).`,
    `If the user agrees, send the manager exactly this trailer: ${formatBridgeTrailer({ ref: report.seq, nonce, sha })}`,
  ].join("\n");
}

/**
 * Turn a drained batch into at most one delivery.
 *
 * Returns null — deliberately, not as an error — when there is nothing to say,
 * when the coalescing window has not elapsed, or when this exact batch was already
 * acknowledged. The last case is what makes a lost ack harmless: the report log
 * still shows the reports as unread until the cursor advances, so the batch is
 * re-planned, recognized by its tombstone, and dropped instead of re-spoken.
 */
export function planBridgeReportDelivery(options: {
  batch: BridgeReportBatch;
  now: Date;
  /** When the previous interjection batch reached this call, or null for none. */
  lastBatchAt: Date | null;
  acknowledgedDeliveryIds?: readonly string[] | null;
}): BridgeDeliveryPlan | null {
  const { reports } = options.batch;
  if (reports.length === 0) return null;
  if (options.lastBatchAt
    && options.now.getTime() - options.lastBatchAt.getTime() < BRIDGE_LIVE_BATCH_INTERVAL_MS) {
    return null;
  }

  const throughSeq = reports.reduce((highest, report) => Math.max(highest, report.seq), 0);
  const turnId = bridgeDeliveryTurnId(throughSeq);
  let deliveries: RuntimeVoiceDelivery[] = [];
  for (const report of reports) {
    deliveries = appendVoiceResponse(deliveries, turnId, {
      responseId: bridgeReportResponseId(report.seq),
      text: reportText(report),
    });
  }
  const delivery = deliveries[0];
  if (!delivery) return null;

  const acknowledged = normalizeAcknowledgedVoiceDeliveryIds(options.acknowledgedDeliveryIds);
  if (acknowledged.includes(delivery.deliveryId)) return null;

  /* `ready` is what the call-side flush loop waits for. A worker response becomes
     ready when its turn completes; a report has no turn to complete — the manager
     already finished the thought before appending it. */
  return { delivery: { ...delivery, ready: true }, throughSeq };
}
