import {
  BRIDGE_LIVE_BATCH_INTERVAL_MS,
  bridgeReportOriginLabel,
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

const ACKNOWLEDGED_REPORT_SEQ = /"report:(\d+)"/g;

/**
 * The highest report seq any tombstone says was already spoken.
 *
 * Per-report rather than per-batch, and that distinction is load-bearing. A
 * delivery id names the *set* of reports it carried, so when the cursor write is
 * lost and the manager appends one more report, the next drain produces a batch
 * with a different id — one the tombstones do not recognize. Matching on the id
 * alone would then re-speak everything in it, which is the failure a tombstone
 * exists to prevent. Reading the seqs back out of the ids answers the question
 * that actually matters: what has this user already heard.
 */
export function bridgeAcknowledgedSeqCeiling(
  acknowledgedDeliveryIds: readonly string[] | null | undefined,
): number {
  let ceiling = 0;
  for (const id of normalizeAcknowledgedVoiceDeliveryIds(acknowledgedDeliveryIds)) {
    for (const match of id.matchAll(ACKNOWLEDGED_REPORT_SEQ)) {
      const seq = Number.parseInt(match[1]!, 10);
      if (Number.isInteger(seq) && seq > ceiling) ceiling = seq;
    }
  }
  return ceiling;
}

export type BridgeDeliveryPlan =
  /** Speak this batch, then acknowledge `throughSeq` — never before. */
  | { kind: "deliver"; delivery: RuntimeVoiceDelivery; throughSeq: number }
  /**
   * The user already heard this batch, but the cursor never moved: the ack landed
   * in the call and the durable write did not.
   *
   * This case has to be distinguishable from "nothing to do", because the two want
   * opposite actions. Reporting silence here wedges the channel permanently — the
   * drain hands back the same batch, the tombstone suppresses it, and every later
   * report queues behind something already spoken. The caller must heal the cursor
   * to `throughSeq` and drain again.
   */
  | { kind: "already-acknowledged"; throughSeq: number }
  /** Inside the coalescing window; try again after it elapses. */
  | { kind: "hold" }
  /** Nothing pending. */
  | { kind: "idle" };

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
  /* Origin-framed on the way out (HIGH 3, #758 review): a non-manager row is
     spoken as its own agent's report, never in the manager's voice. The label
     comes from the server-authenticated origin field, not from body text the
     caller owns. */
  const label = bridgeReportOriginLabel(report.origin);
  const head = `[${report.class}]${label ? ` (from ${label} — NOT the manager)` : ""}${body ? ` ${body}` : ""}`;
  if (report.class !== "confirmation_request" || !report.confirmation) return head;
  /* #795: a deploy is authorized ONLY by the user's own initiative. A legacy
     manager-minted request never becomes a question, a menu, or any prompt at
     the user — and the revision is machine evidence inside the trailer, never
     something the user hears or repeats. */
  const { sha, nonce, expiresAt } = report.confirmation;
  return [
    head,
    `Deploy authorization attached (expires ${expiresAt}).`,
    "Do NOT ask the user for confirmation or approval — deploys happen on the user's own initiative only. Never read the commit hash aloud.",
    `If the user already asked for this deploy, send the manager exactly this trailer now, without asking anything (machine string — not for the user's ears): ${formatBridgeTrailer({ ref: report.seq, nonce, sha })}`,
    "Otherwise you may mention in passing that a release is ready, and move on.",
  ].join("\n");
}

/**
 * Turn a drained batch into at most one delivery, or say why not.
 *
 * Every outcome is named rather than collapsed into null, because the caller owes
 * each one a different action — and the one that used to be indistinguishable
 * (`already-acknowledged` vs `idle`) is the one that could wedge the channel.
 */
export function planBridgeReportDelivery(options: {
  batch: BridgeReportBatch;
  now: Date;
  /** When the previous interjection batch reached this call, or null for none. */
  lastBatchAt: Date | null;
  acknowledgedDeliveryIds?: readonly string[] | null;
}): BridgeDeliveryPlan {
  const { reports } = options.batch;
  if (reports.length === 0) return { kind: "idle" };
  if (options.lastBatchAt
    && options.now.getTime() - options.lastBatchAt.getTime() < BRIDGE_LIVE_BATCH_INTERVAL_MS) {
    return { kind: "hold" };
  }

  /* Anything at or below the ceiling has already been spoken, whatever batch it
     arrives in now. Dropping those before building the delivery is what stops a
     lost cursor write from replaying them to the user. */
  const ceiling = bridgeAcknowledgedSeqCeiling(options.acknowledgedDeliveryIds);
  const fresh = reports.filter((report) => report.seq > ceiling);
  if (fresh.length === 0) {
    return {
      kind: "already-acknowledged",
      throughSeq: reports.reduce((highest, report) => Math.max(highest, report.seq), ceiling),
    };
  }

  const throughSeq = fresh.reduce((highest, report) => Math.max(highest, report.seq), 0);
  const turnId = bridgeDeliveryTurnId(throughSeq);
  let deliveries: RuntimeVoiceDelivery[] = [];
  for (const report of fresh) {
    deliveries = appendVoiceResponse(deliveries, turnId, {
      responseId: bridgeReportResponseId(report.seq),
      text: reportText(report),
    });
  }
  const delivery = deliveries[0];
  if (!delivery) return { kind: "idle" };

  const acknowledged = normalizeAcknowledgedVoiceDeliveryIds(options.acknowledgedDeliveryIds);
  if (acknowledged.includes(delivery.deliveryId)) return { kind: "already-acknowledged", throughSeq };

  /* `ready` is what the call-side flush loop waits for. A worker response becomes
     ready when its turn completes; a report has no turn to complete — the manager
     already finished the thought before appending it. */
  return { kind: "deliver", delivery: { ...delivery, ready: true }, throughSeq };
}
