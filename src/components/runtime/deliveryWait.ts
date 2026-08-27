/**
 * Delivery wait phases (issue #1213).
 *
 * A structured send is handed to the agent only at a turn boundary: the
 * delivery queue parks the journaled effect while the host is inside a turn and
 * only transitions the receipt to `delivering` once the host reports idle. The
 * composer used to render `pending`, `queued`, `delivering` and `uncertain` as
 * one indistinguishable spinner, so "arriving in a second", "arriving in twenty
 * minutes" and "never arriving" all looked the same — and the last of those had
 * no exit at all.
 *
 * Three phases, derived, never stored:
 * - `transmitting`   — an attempt is on the wire right now;
 * - `awaiting-turn`  — admitted and journaled, waiting for the agent's turn to
 *                      end; nothing is being transmitted;
 * - `awaiting-host`  — admitted and journaled, but nothing is hosting the
 *                      conversation: the message waits for a host to come back.
 *                      A deployment rollback terminates every structured host
 *                      at once, and every send in flight lands here;
 * - `uncertain`      — unconfirmed past {@link DELIVERY_UNCERTAIN_MS}. Terminal
 *                      for presentation: the composer stops claiming the
 *                      message is moving and hands the operator a control.
 *
 * A later terminal receipt always wins — a delivery that lands after the bound
 * settles through the ordinary resolved path and this model stops speaking.
 */

import type { TFunction } from "@/lib/i18n";

import { humanReceiptReasonKey, receiptIsTerminal, type ReceiptStatus } from "./runtimeModel";

export type DeliveryWaitPhase = "transmitting" | "awaiting-turn" | "awaiting-host" | "uncertain";

/**
 * How long a delivery may wait before the operator is treated as blocked on it
 * and it enters the attention queue.
 *
 * Calibrated against the operator's own evidence in #1213: four deliveries into
 * one busy host landed after 2 min, 12 s, 21 min and 4 min. A shorter threshold
 * would enqueue healthy deliveries; a longer one leaves the operator waiting on
 * a message nobody told them about.
 */
export const DELIVERY_WAIT_ATTENTION_MS = 5 * 60_000;

/**
 * How long a delivery may stay unconfirmed before the composer stops calling it
 * in flight. Set above the longest observed successful wait (21 min is the
 * outlier in #1213, and it arrived) so an honest late delivery is not written
 * off early — but bounded, because the state below this line is exactly the one
 * nothing else owns.
 */
export const DELIVERY_UNCERTAIN_MS = 20 * 60_000;

export interface DeliveryWait {
  phase: DeliveryWaitPhase;
  /** Milliseconds since the first attempt of this logical message. */
  waitedMs: number;
  /** Attempts made so far; never below one. */
  attempts: number;
}

export interface DeliveryWaitInput {
  status: ReceiptStatus;
  /** The receipt's own sanitized reason, when it carries one. Distinguishes a
      wait on a turn from a wait on a host that is gone. */
  reason?: string | null;
  /** ISO moment of the OLDEST attempt of this message — how long it waited. */
  firstAttemptAt: string;
  attempts: number;
  nowMs: number;
}

/**
 * The wait a still-unsettled delivery is in, or `null` when the receipt has
 * settled and the existing terminal rendering owns it.
 */
export function deliveryWaitFor(input: DeliveryWaitInput): DeliveryWait | null {
  if (receiptIsTerminal(input.status)) return null;
  const startedAt = Date.parse(input.firstAttemptAt);
  /* An unreadable or future stamp reports no wait rather than a negative or
     NaN one: the phase is still true, only the duration is unknown. */
  const waitedMs = Number.isFinite(startedAt) ? Math.max(0, input.nowMs - startedAt) : 0;
  const attempts = Number.isFinite(input.attempts) ? Math.max(1, Math.trunc(input.attempts)) : 1;
  if (waitedMs >= DELIVERY_UNCERTAIN_MS) return { phase: "uncertain", waitedMs, attempts };
  /* `queued` is the durable admission the delivery queue parks at the turn
     boundary; `uncertain` is an attempt whose outcome no receipt proved. Both
     mean the message is sitting still, not moving down a wire. */
  if (input.status !== "queued" && input.status !== "uncertain") {
    return { phase: "transmitting", waitedMs, attempts };
  }
  /* Reuses the receipt model's own reason mapping, so "the host is gone" has
     one authority instead of a second list that can drift from it. */
  const hostGone = humanReceiptReasonKey(input.reason) === "receipt.human.deadHost";
  return { phase: hostGone ? "awaiting-host" : "awaiting-turn", waitedMs, attempts };
}

/**
 * How long a delivery has waited, in the coarsest unit that still says
 * something: seconds under a minute, whole minutes under an hour, hours above.
 * Rounds up from zero so a fresh wait never reads "0s".
 */
export function formatWaited(t: TFunction, waitedMs: number): string {
  const seconds = Math.max(0, Math.round(waitedMs / 1000));
  if (seconds < 60) return t("runtime.receipt.waitedSec", { n: Math.max(1, seconds) });
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return t("runtime.receipt.waitedMin", { n: minutes });
  return t("runtime.receipt.waitedHour", { n: Math.round(minutes / 60) });
}

/**
 * The sentence a wait is rendered as, or `null` when the receipt's own status
 * text already tells the truth.
 *
 * `transmitting` returns null on purpose: an attempt on the wire is momentary,
 * its existing wording ("sending…", "delivering…") is exact, and a ticking
 * duration beside it would be noise. The two waits that CAN outlive an
 * operator's patience are the ones that name themselves and their age.
 */
export function deliveryWaitText(
  t: TFunction,
  wait: DeliveryWait,
  queuePosition?: number | null,
): string | null {
  const waited = formatWaited(t, wait.waitedMs);
  if (wait.phase === "uncertain") return t("runtime.receipt.unconfirmed", { waited });
  if (wait.phase === "awaiting-host") return t("runtime.receipt.awaitingHostFor", { waited });
  if (wait.phase !== "awaiting-turn") return null;
  return typeof queuePosition === "number"
    ? t("runtime.receipt.awaitingTurnPos", { position: queuePosition, waited })
    : t("runtime.receipt.awaitingTurnFor", { waited });
}

/** How often the composer re-reads the clock while a delivery is unsettled.
    Coarse on purpose: the labels are minute-grained, so a slower tick would
    still cross the uncertain bound late. */
export const DELIVERY_WAIT_TICK_MS = 15_000;
