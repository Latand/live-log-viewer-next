import {
  planBridgeReportDelivery,
  type BridgeDeliveryPlan,
} from "@/lib/runtime/bridgeDelivery";
import { rootIdentity as readRootIdentity } from "@/lib/root/store";

import { consumeBridgeConfirmation, type BridgeConfirmationOutcome } from "./confirmation";
import type { BridgeTrailer } from "./directive";
import {
  acknowledgeBridgeReports,
  appendBridgeReports,
  drainBridgeReports,
  issueBridgeAckToken,
  openBridgeChannel,
  redeemBridgeAckToken,
} from "./store";
import type { BridgeReportInput, BridgeReportV1 } from "./types";

/**
 * The bridge's production orchestration (#691 §4).
 *
 * `store.ts` says what a durable report log is; `bridgeDelivery.ts` says how a batch
 * becomes something a call can speak. Neither says *in what order a running system
 * does those things*, and until something did, every failure mode below was handled
 * only where nothing called it.
 *
 * This is that order, in one place, so the API route, the MCP binding and any later
 * shell all take the same path rather than each re-deriving it slightly differently:
 *
 *   append (manager)  ->  drain from the durable cursor  ->  plan against the
 *   tombstones  ->  hand over  ->  acknowledge  ->  heal when the ack was lost.
 *
 * Opening the channel is folded into the read, deliberately. A first report on a
 * fresh install must be deliverable without anyone having remembered to initialize
 * anything, and "the bridge silently does nothing until someone calls open()" is the
 * exact shape of the bug this layer exists to remove.
 */

export interface BridgeDeliveryRequest {
  /** The root's durable identity. Injected so tests need no lineage file. */
  rootIdentity?: () => string;
  now: Date;
  /** When the previous interjection batch reached this call, or null for none. */
  lastBatchAt: Date | null;
  acknowledgedDeliveryIds?: readonly string[] | null;
}

/**
 * Append one manager report. The single production entry point for
 * manager → gateway traffic, so bounding and redaction cannot be bypassed by a
 * caller that reaches for the store directly.
 */
export function recordManagerReport(input: BridgeReportInput): BridgeReportV1 | null {
  const { appended } = appendBridgeReports([input]);
  return appended[0] ?? null;
}

/**
 * What the live call should say next, if anything.
 *
 * Read-only with respect to the cursor: this never advances anything. A batch lost
 * between here and the call has to arrive again rather than vanish, so the cursor
 * moves in {@link acknowledgeBridgeDelivery} and only after delivery is real.
 */
export function pendingBridgeDelivery(request: BridgeDeliveryRequest): BridgeDeliveryPlan {
  const identity = (request.rootIdentity ?? readRootIdentity)();
  openBridgeChannel(identity, request.now);
  return planBridgeReportDelivery({
    batch: drainBridgeReports({ now: request.now }),
    now: request.now,
    lastBatchAt: request.lastBatchAt,
    acknowledgedDeliveryIds: request.acknowledgedDeliveryIds,
  });
}

/**
 * Advance the durable cursor to what the call actually took.
 *
 * Called for `deliver` after the batch reaches the call, and for
 * `already-acknowledged` immediately — the second case is the healing path, and
 * skipping it is what leaves later reports queued behind something already spoken.
 *
 * Internal: the HTTP surface goes through {@link redeemBridgeAcknowledgement}, which
 * takes the token the batch was handed out with rather than a caller-named sequence.
 */
export function acknowledgeBridgeDelivery(throughSeq: number, now = new Date()): void {
  acknowledgeBridgeReports(throughSeq, now);
}

/** Settle the outstanding batch by the token issued with it. */
export function redeemBridgeAcknowledgement(token: string, now = new Date()): { ok: boolean; throughSeq: number } {
  return redeemBridgeAckToken(token, now);
}

/**
 * Mint the token that settles the batch just handed out.
 *
 * Issued at handout rather than derived from the batch, so possession of the token
 * is evidence of having RECEIVED that batch — which is what an acknowledgement is
 * supposed to attest.
 */
export function issueBridgeAcknowledgementToken(throughSeq: number, now = new Date()): string {
  return issueBridgeAckToken(throughSeq, now);
}

/**
 * What the gateway's next turn must open with when no call is live (§4).
 *
 * The design forbids pushing when there is no call to interject into, so the
 * pending reports wait — and would wait forever if nothing drained them. A turn is
 * the moment the gateway is about to think, so it is the moment its inbox becomes
 * relevant: the batch is prepended to that turn's own input.
 *
 * Deliberately part of the turn's input rather than a separate injected item (U3
 * settled that), and bounded by the same drain caps as the live path — a quiet
 * night arrives as one batch, oldest first, not as a night's worth of messages.
 */
export function bridgeTurnStartPrelude(
  request: Omit<BridgeDeliveryRequest, "lastBatchAt" | "acknowledgedDeliveryIds"> = { now: new Date() },
): { text: string; throughSeq: number } | null {
  const identity = (request.rootIdentity ?? readRootIdentity)();
  openBridgeChannel(identity, request.now);
  const batch = drainBridgeReports({ now: request.now });
  if (batch.reports.length === 0) return null;

  const lines = batch.reports.map((report) => `- [${report.class}] ${report.body}`);
  if (batch.remaining > 0) lines.push(`- (${batch.remaining} more waiting; they arrive next turn.)`);
  return {
    text: [
      "While you were away the manager reported:",
      ...lines,
      "",
      "Mention what matters in your own words. Do not read this list aloud.",
    ].join("\n"),
    throughSeq: batch.throughSeq,
  };
}

/**
 * Verify and consume the authorization the gateway relayed, immediately before a
 * deploy runs (§4, §7.7).
 *
 * The trailer's three fields are checked together and consumed atomically, so a
 * replay, an expiry, a wrong nonce and a wrong SHA all decline — and a decline
 * leaves the confirmation unconsumed, because refusing an answer must not destroy
 * the operator's ability to give the right one.
 */
export function authorizeBridgeDeploy(
  trailer: Pick<BridgeTrailer, "ref"> & { nonce?: string; sha?: string },
  now = new Date(),
): BridgeConfirmationOutcome {
  if (!trailer.nonce || !trailer.sha) return { ok: false, reason: "no_confirmation" };
  return consumeBridgeConfirmation(trailer.ref, { sha: trailer.sha, nonce: trailer.nonce }, now);
}
