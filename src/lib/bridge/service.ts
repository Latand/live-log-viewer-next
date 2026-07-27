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
  openBridgeChannel,
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
 */
export function acknowledgeBridgeDelivery(throughSeq: number, now = new Date()): void {
  acknowledgeBridgeReports(throughSeq, now);
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
