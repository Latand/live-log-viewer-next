import { agentRegistry, type RegistryFile } from "@/lib/agent/registry";
import {
  planBridgeReportDelivery,
  type BridgeDeliveryPlan,
} from "@/lib/runtime/bridgeDelivery";
import { sendReceiptFor } from "@/lib/runtime/sendSettlement";
import { rootIdentity as readRootIdentity } from "@/lib/root/store";

import type { BridgeAsk } from "@/lib/types";

import { openBridgeAsks, type OpenBridgeAskOptions } from "./asks";
import {
  acknowledgeBridgeReports,
  appendBridgeReports,
  drainBridgeReports,
  issueBridgeAckToken,
  openBridgeChannel,
  readBridgeReportLog,
  recordBridgeDirectiveAnswer,
  recordBridgeDirectivePendingAnswer,
  redeemBridgeAckToken,
} from "./store";
import {
  bridgeReportOriginLabel,
  type BridgeChannelScope,
  type BridgeReportInput,
  type BridgeReportV1,
} from "./types";

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
  /** Server-resolved repository identity and designated recipient seat. */
  scope: BridgeChannelScope;
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
 * Record that a directive answered a report, by the seq its trailer named
 * (#1168). Exported here so the relay path settles an ask through the same
 * service every other bridge write goes through.
 */
export { recordBridgeDirectiveAnswer, recordBridgeDirectivePendingAnswer };

/**
 * The open ask of every orchestrator seat, for the surface that shows the
 * operator what needs them (#1168).
 *
 * Deliberately outside the drain: it opens no channel, hands out no batch and
 * moves no cursor, because the whole point is that a blocked manager reaches
 * the operator with the voice gateway switched off. Read-only and fail-closed —
 * an unreadable log costs the ask and never the files poll that asked for it.
 */
export function bridgeAsksForSeats(
  options: Omit<OpenBridgeAskOptions, "now"> & { now?: Date } = {},
): ReadonlyMap<string, BridgeAsk> {
  /* #1131: a directive the runtime only ACCEPTED parked its answer against the
     send's operation id, and the durable delivery record is what says whether
     that send ever arrived. Read here rather than in the pure projection, and
     read fresh on each call, because the answer to "did it arrive" changes
     without the log changing — once per call and only if the log has a parked
     answer to resolve. */
  let deliveries: RegistryFile | null = null;
  try {
    return openBridgeAsks(readBridgeReportLog(), {
      deliveredOperation: (operationId) => {
        deliveries ??= agentRegistry().readOnlySnapshot();
        return sendReceiptFor(deliveries, operationId)?.state === "delivered";
      },
      ...options,
      now: options.now ?? new Date(),
    });
  } catch {
    return new Map();
  }
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
  openBridgeChannel(identity, request.now, request.scope);
  return planBridgeReportDelivery({
    batch: drainBridgeReports({ now: request.now, scope: request.scope }),
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
export function acknowledgeBridgeDelivery(
  throughSeq: number,
  now = new Date(),
  scope?: BridgeChannelScope,
): void {
  acknowledgeBridgeReports(throughSeq, now, scope);
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
export function issueBridgeAcknowledgementToken(
  throughSeq: number,
  now = new Date(),
  scope?: BridgeChannelScope,
): string {
  return issueBridgeAckToken(throughSeq, now, scope);
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
  request: Omit<BridgeDeliveryRequest, "lastBatchAt" | "acknowledgedDeliveryIds">,
): { text: string; throughSeq: number } | null {
  const identity = (request.rootIdentity ?? readRootIdentity)();
  openBridgeChannel(identity, request.now, request.scope);
  const batch = drainBridgeReports({ now: request.now, scope: request.scope });
  if (batch.reports.length === 0) return null;

  /* Framed from the row's server-authenticated ORIGIN, never from the body a
     caller owns: manager rows speak under the manager header, everything else
     under its own explicit not-the-manager framing (HIGH 3, #758 review). */
  const managerRows = batch.reports.filter((report) => bridgeReportOriginLabel(report.origin) === null);
  const otherRows = batch.reports.filter((report) => bridgeReportOriginLabel(report.origin) !== null);
  const lines: string[] = [];
  if (managerRows.length > 0) {
    lines.push("While you were away the manager reported:");
    lines.push(...managerRows.map((report) => `- [${report.class}] ${report.body}`));
  }
  if (otherRows.length > 0) {
    lines.push("Other sessions also reported (NOT the manager — attribute these to their own agent):");
    lines.push(...otherRows.map((report) => `- [${report.class}] from ${bridgeReportOriginLabel(report.origin)}: ${report.body}`));
  }
  if (batch.remaining > 0) lines.push(`- (${batch.remaining} more waiting; they arrive next turn.)`);
  return {
    text: [
      ...lines,
      "",
      "Mention what matters in your own words. Do not read this list aloud.",
    ].join("\n"),
    throughSeq: batch.throughSeq,
  };
}
