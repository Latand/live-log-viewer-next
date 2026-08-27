/**
 * Delivery wait phases (issue #1213).
 *
 * A structured send is handed to the agent only at a turn boundary: the
 * delivery queue parks the journaled effect while the host is inside a turn and
 * only transitions the receipt to `delivering` once the host reports idle. The
 * composer used to render `pending`, `queued`, `delivering` and `uncertain` as
 * one indistinguishable spinner, so "arriving in a second", "arriving in twenty
 * minutes" and "never arriving" all looked the same.
 *
 * The phases, derived, never stored:
 * - `transmitting`          — the request path is still working on an attempt;
 * - `handing-over`          — the queue reached a turn boundary and is putting
 *                             the message in front of the agent RIGHT NOW;
 * - `awaiting-turn`         — admitted and journaled, waiting for the agent's
 *                             turn to end; nothing is being transmitted. Said
 *                             ONLY on the host's own evidence that a turn is
 *                             running;
 * - `awaiting-host`         — admitted and journaled, but nothing is hosting the
 *                             conversation: the message waits for a host to come
 *                             back. A deployment rollback terminates every
 *                             structured host at once, and every send in flight
 *                             lands here;
 * - `awaiting-handover`     — admitted and journaled, and the composer cannot
 *                             say what it is waiting on. The honest answer when
 *                             no host axis reached this surface: naming a turn
 *                             here would assert something nobody established;
 * - `unconfirmed-admission` — the composer's own local row for a send whose
 *                             admission was never confirmed, so the message may
 *                             or may not have been accepted;
 * - `uncertain`             — a PARKED attempt still unconfirmed past
 *                             {@link DELIVERY_UNCERTAIN_MS}. Terminal for
 *                             presentation: the composer stops claiming the
 *                             message is moving and says it did not arrive.
 *
 * A later terminal receipt always wins — a delivery that lands after the bound
 * settles through the ordinary resolved path and this model stops speaking.
 */

import type { TFunction } from "@/lib/i18n";

import { deliveryResolved } from "./deliveryState";
import { receiptIsTerminal, type HostAxis, type ReceiptStatus, type TurnAxis } from "./runtimeModel";

export type DeliveryWaitPhase =
  | "transmitting"
  | "handing-over"
  | "awaiting-turn"
  | "awaiting-host"
  | "awaiting-handover"
  | "unconfirmed-admission"
  | "uncertain";

/**
 * What a parked message is waiting on, as far as anything here can establish.
 *
 * Survives into `uncertain`, which is the only place the operator is told WHY a
 * message never arrived — and a turn that never ended, a window that never came
 * back, and a wait nobody can explain are three different facts to act on.
 */
export type DeliveryWaitCause = "turn" | "host" | "unknown";

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
  /** Milliseconds since this message was admitted. */
  waitedMs: number;
  /** Attempts made so far; never below one. */
  attempts: number;
  cause: DeliveryWaitCause;
}

export interface DeliveryWaitInput {
  status: ReceiptStatus;
  /** The conversation's own host axis, when the composer knows it. This is the
      authority for "the window is gone"; absent for a surface with no
      structured session behind it. */
  host?: HostAxis | null;
  /** The conversation's own turn axis, when the composer knows it. A turn
      boundary is claimed only on this evidence. */
  turn?: TurnAxis | null;
  /** ISO moment this message was ADMITTED — the one stamp that does not move.
      A receipt's `at` is rewritten by every transition, and the queue routinely
      bounces a parked send `delivering`→`queued`, so reading `at` restarts the
      wait and the bound below is never crossed. */
  admittedAt: string;
  attempts: number;
  nowMs: number;
}

/**
 * Statuses in which the message is parked: journaled, waiting, and with nothing
 * on the wire. These are the ones that reach the uncertain terminal.
 *
 * `delivering`/`applying` are deliberately absent. The delivery queue writes
 * `delivering` BEFORE it calls `host.send`, so a message in that window is
 * genuinely being put in front of the agent, and the queue always writes an
 * outcome for it. That row names its own age past the bound instead.
 */
function parked(status: ReceiptStatus): boolean {
  return status === "pending" || status === "queued";
}

/**
 * The wait a still-unsettled delivery is in, or `null` when the receipt has
 * settled and the existing terminal rendering owns it.
 */
export function deliveryWaitFor(input: DeliveryWaitInput): DeliveryWait | null {
  /* Terminal OR resolved: `turn-started`/`steered` are not terminal receipts,
     but they prove the message is inside the agent's turn — there is no wait
     left to describe. */
  if (receiptIsTerminal(input.status) || deliveryResolved(input.status)) return null;
  const startedAt = Date.parse(input.admittedAt);
  /* An unreadable or future stamp reports no wait rather than a negative or
     NaN one: the phase is still true, only the duration is unknown. */
  const waitedMs = Number.isFinite(startedAt) ? Math.max(0, input.nowMs - startedAt) : 0;
  const attempts = Number.isFinite(input.attempts) ? Math.max(1, Math.trunc(input.attempts)) : 1;
  const cause = waitCause(input);
  const wait = (phase: DeliveryWaitPhase): DeliveryWait => ({ phase, waitedMs, attempts, cause });
  /* The composer's local row for a send it could not confirm was admitted.
     Calling it "waiting for a turn" would assert an admission that is exactly
     what could not be confirmed. */
  if (input.status === "uncertain") return wait("unconfirmed-admission");
  if (!parked(input.status)) return wait("handing-over");
  if (waitedMs >= DELIVERY_UNCERTAIN_MS) return wait("uncertain");
  /* `queued` is the durable admission the delivery queue parks at the turn
     boundary: the message is sitting still, not moving down a wire. */
  if (input.status !== "queued") return wait("transmitting");
  if (cause === "host") return wait("awaiting-host");
  return wait(cause === "turn" ? "awaiting-turn" : "awaiting-handover");
}

/**
 * What the message is waiting on, from the conversation's own axes.
 *
 * The receipt's `reason` is deliberately not consulted: the journal keeps a
 * same-status transition as a no-op, so a message already `queued` when its
 * host died keeps whatever reason it had, and the queue's own dead-host branch
 * writes a raw engine error. When the axes cannot answer, the wait says so
 * instead of inventing a turn.
 */
function waitCause(input: DeliveryWaitInput): DeliveryWaitCause {
  if (!input.host) return "unknown";
  if (input.host === "dead" || input.host === "unhosted") return "host";
  return input.turn === "running" || input.turn === "interrupt_requested" ? "turn" : "unknown";
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
 * its existing wording ("sending…") is exact, and a ticking duration beside it
 * would be noise. `handing-over` is momentary for the same reason — until it is
 * not, and a hand-over still running past the bound names itself rather than
 * spinning silently.
 */
export function deliveryWaitText(
  t: TFunction,
  wait: DeliveryWait,
  queuePosition?: number | null,
): string | null {
  const waited = formatWaited(t, wait.waitedMs);
  if (wait.phase === "uncertain") return t("runtime.receipt.unconfirmed", { waited });
  if (wait.phase === "unconfirmed-admission") return t("runtime.receipt.admissionUnconfirmed", { waited });
  if (wait.phase === "awaiting-host") return t("runtime.receipt.awaitingHostFor", { waited });
  if (wait.phase === "awaiting-handover") return t("runtime.receipt.awaitingHandoverFor", { waited });
  if (wait.phase === "handing-over") {
    return wait.waitedMs >= DELIVERY_UNCERTAIN_MS ? t("runtime.receipt.handingOverFor", { waited }) : null;
  }
  if (wait.phase !== "awaiting-turn") return null;
  return typeof queuePosition === "number"
    ? t("runtime.receipt.awaitingTurnPos", { position: queuePosition, waited })
    : t("runtime.receipt.awaitingTurnFor", { waited });
}

/**
 * Why a message that never arrived never arrived — the sentence under the
 * terminal row. The cause survives from the wait it came out of: a turn that
 * never ended and a host that never came back are different facts, and the
 * operator decides differently on each. Each one ends by telling them the only
 * thing that will move the message now: sending it again themselves.
 */
export function deliveryUncertainWhy(t: TFunction, wait: DeliveryWait): string {
  if (wait.cause === "host") return t("runtime.receipt.unconfirmedWhyHost");
  if (wait.cause === "turn") return t("runtime.receipt.unconfirmedWhy");
  return t("runtime.receipt.unconfirmedWhyUnknown");
}

/** How often the composer re-reads the clock while a delivery is unsettled.
    Coarse on purpose: the labels are minute-grained, so a slower tick would
    still cross the uncertain bound late. */
export const DELIVERY_WAIT_TICK_MS = 15_000;
