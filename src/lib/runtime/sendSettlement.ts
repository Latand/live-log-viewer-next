import {
  agentRegistry,
  readOnlyConversationLookupFromSnapshot,
  type AgentRegistry,
  type DeliveryOperationOwner,
  type DeliveryTerminalDisposition,
  type RegistryFile,
} from "@/lib/agent/registry";
import { sessionKeyId } from "@/lib/agent/sessionKey";
import type { HeldDelivery, ViewerConversationId } from "@/lib/accounts/migration/contracts";

import { runtimeHostClient, type RuntimeHostClient } from "./client";
import {
  RUNTIME_DELIVERY_DISCARDED_REASON,
  type RuntimeOperationReceipt,
  type RuntimeReceiptStatus,
} from "./contracts";
import { readEvidence, readEvidenceSync, unreadableEvidence, type Evidence } from "./evidence";

/**
 * Settlement of accepted sends (#1131).
 *
 * `send_message` answers `queued` the moment the runtime host admits the
 * operation, and until now that could be the LAST thing anyone ever said about
 * it. A delivery that the drain never executed — because the host it was
 * addressed to went away, or because the effect was simply never picked up —
 * rested at `queued` forever: the reservation stayed `delivery-uncertain`, the
 * receipt stayed non-terminal, and nothing anywhere turned that into an answer.
 * A production deployer holding a paused cutover sat idle for forty minutes on
 * exactly this, and the only thing that noticed was the sender's own suspicion.
 *
 * Two rules govern the fix, and the second matters more than the first:
 *
 * - **`queued` is never a final answer.** {@link resolveSendReceipt} answers
 *   what became of the id `send_message` returned, and past the settlement
 *   deadline it ENDS the send rather than reporting acceptance a second time.
 * - **An uncertain send stays uncertain.** Once actuation has started the state
 *   is absorbing: never reclassified as unexecuted, never advertised as safely
 *   resendable. Delivering a deployment instruction twice is a worse incident
 *   than the silence this issue is about.
 *
 * ── ONE MECHANISM, DRIVEN BY THE CALLER ───────────────────────────────────
 *
 * There is no sweep and no timer here, on purpose. A background reconciler
 * settles a send only while the process that owns it is healthy, which is
 * exactly when the send was least likely to be lost — a fix for "this can hang
 * forever" that hangs whenever the runtime does has moved the problem rather
 * than solved it. So the settlement runs where the question is asked: a caller
 * holding an operation id asks what became of it, and an accepted send past its
 * deadline is settled by that read, from whatever evidence exists, including
 * none.
 *
 * The deadline itself is durable — the reservation's own acceptance time — so
 * it survives every restart on both sides and needs nothing to be running.
 *
 * ── WHY THIS NEVER CALLS A DUPLICATE SAFE ─────────────────────────────────
 *
 * Declaring a send failed is only honest if the send can no longer happen, so
 * the settlement never merely relabels a reservation: where the journal can be
 * reached it terminalizes the OPERATION first, and only writes `failed` on the
 * reservation once that succeeded. Two properties of the journal make that a
 * real fence rather than a hopeful one:
 *
 * - terminalizing an operation marks its outbox row completed inside the same
 *   `BEGIN IMMEDIATE` transaction, so the effect is gone from every later
 *   effect batch; and
 * - the delivery queue must move an effect to `delivering` BEFORE it calls
 *   `host.send`, and the journal refuses that transition out of a terminal
 *   state — so an executor that had already batched the effect is stopped at
 *   the transition rather than at the send.
 *
 * Where the journal CANNOT be reached, the settled record is itself the fence:
 * {@link sendIsSettled} is read by the delivery queue before it actuates a
 * message effect, so a send this module ended during an outage is not delivered
 * late when the runtime comes back. An answer a caller already has must stay
 * true afterwards.
 *
 * That fence proves non-execution only where the journal still shows the send
 * as unexecuted, and that is the ONLY thing this module will call safe to send
 * again. Everything else it settles is `unverified`: a send the executor took
 * may have reached the recipient, and so may a send whose journal record cannot
 * be found or cannot be read at all — an absent record is not a proof of
 * absence. Being wrong in that direction costs a caller one verification; being
 * wrong in the other direction delivers a deployment instruction twice. Nothing
 * here retries anything on its own — a resend is the caller's decision, made
 * against a receipt that states whether it is safe.
 */

/** The failure reasons this module writes. The durable record also carries a
    structured disposition beside them, so the receipt never has to read prose
    to know whether a resend can duplicate. */
export const SEND_LOST_REASON =
  "accepted for delivery but never executed; the delivery journal has fenced it, so it cannot arrive and may be sent again";
export const SEND_UNVERIFIED_REASON =
  "delivery was started and never settled; whether it reached the recipient is unknown, so sending it again may deliver it twice";
/** Operator-authored terminal state. The journal and registry both retain this
    token so a partial cross-store write converges back to the visible discard. */
export const SEND_DISCARDED_REASON = RUNTIME_DELIVERY_DISCARDED_REASON;
/** No journal operation was ever found for this send — the legacy delivery path
    never creates one, and a record can also be pruned. Non-execution is
    unproven either way, so it settles like any other unverified send. */
export const SEND_UNRECORDED_REASON =
  "delivery was accepted and the delivery journal holds no record of it; whether it reached the recipient is unknown, so sending it again may deliver it twice";
/** The runtime host could not give this send a terminal answer — it could not
    be asked at all, or it could be asked and would not accept the fence. The
    send is ended anyway, which is the whole point of a deadline that does not
    depend on anything being healthy, and ended as unverified, because a host
    that cannot answer is a reason to know less and never a proof that nothing
    executed. The durable record is the fence in this case, and the delivery
    queue reads it before it actuates anything. */
export const SEND_UNSETTLEABLE_REASON =
  "delivery was accepted and the runtime host could not give it a terminal answer; it is fenced from being delivered later, but whether it already reached the recipient is unknown";

/**
 * How long an accepted send may rest unsettled before a receipt query ends it.
 *
 * This is a settlement deadline, not a delivery timeout: nothing waits on it,
 * nothing fires when it passes, and widening it would only make a dropped send
 * take longer to become an answer. It is generous enough that an ordinary
 * drain, host recovery or reconnection finishes well inside it.
 */
const SEND_SETTLEMENT_WINDOW_MS = 10 * 60_000;

/**
 * The ceiling on the in-turn exemption below.
 *
 * A send queued behind the recipient's active turn is progressing, not lost, so
 * it is exempt from the window — ending it would cancel a message that is about
 * to be delivered, which is the ordinary shape of talking to a busy agent. A
 * host wedged mid-turn would otherwise make that exemption permanent and put
 * `queued` right back where this issue found it, so the exemption ends here.
 */
const SEND_SETTLEMENT_IN_TURN_CEILING_MS = 60 * 60_000;

/** Receipt statuses that mean the recipient has the message. */
const DELIVERED_RECEIPT_STATUSES: ReadonlySet<RuntimeReceiptStatus> = new Set<RuntimeReceiptStatus>([
  "delivered",
  "turn-started",
  "steered",
]);

/** Receipt statuses the journal will still act on. */
const OPEN_RECEIPT_STATUSES: ReadonlySet<RuntimeReceiptStatus> = new Set<RuntimeReceiptStatus>([
  "pending",
  "queued",
]);

export type SendReceiptState = "delivered" | "failed" | "in-flight";

/** What a caller may do with a settled send without risking a second delivery. */
export type SendResendGuidance =
  /** It arrived. Sending it again would be a second instruction, not a retry. */
  | "not-needed"
  /** It provably never executed and is fenced; the same instruction may be sent again. */
  | "safe"
  /** Its fate is unknown; verify the recipient before sending it again. */
  | "verify-first";

export interface SendReceipt {
  operationId: string;
  /** What was accepted under this id. Read from the durable record, so it
      survives the journal that admitted it. */
  kind: "send" | "steer";
  conversationId: string | null;
  /** The idempotency key the send was admitted under, when the record kept it. */
  clientMessageId: string | null;
  state: SendReceiptState;
  /** Why it failed, or what it is still waiting on. */
  reason: string | null;
  acceptedAt: string | null;
  settledAt: string | null;
  /** True when re-sending this instruction could deliver it a second time. */
  duplicateRisk: boolean;
  resend: SendResendGuidance | null;
  /** Where THIS answer came from: `delivery-journal` when the runtime journal
      was asked and answered during the query, `delivery-record` when the
      durable reservation and its owner row were the whole evidence. */
  evidence: "delivery-journal" | "delivery-record";
}

export interface SendSettlementPorts {
  registry?: AgentRegistry;
  client?: RuntimeHostClient | null;
  now?: () => number;
  windowMs?: number;
  inTurnCeilingMs?: number;
}

function parseTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** The moment the send was accepted for delivery. */
function acceptedAtOf(delivery: HeldDelivery): string {
  return delivery.assignedAt ?? delivery.createdAt;
}

function deliveryForOperation(file: RegistryFile, operationId: string): HeldDelivery | null {
  const owner = file.deliveryOperationOwners[operationId];
  const delivery = owner
    ? file.heldDeliveries[owner.deliveryId]
    : Object.values(file.heldDeliveries).find((candidate) => candidate.command.operationId === operationId);
  return delivery ?? null;
}

/**
 * The row a RETRY attempt owns, when this id names one (#1131).
 *
 * A retry is admitted as a fresh operation under a new id, and that id is what
 * the caller is handed. It shares the send's reservation, but not the
 * reservation's answer: the reservation is still terminal from the attempt this
 * one replaces, and reporting that verdict for an attempt that is queued right
 * now would be the dead attempt's answer given for a live one. So an attempt
 * row carries its own acceptance time and its own settlement, and everything
 * below reads it in place of the reservation wherever the two differ.
 */
function retryAttemptOwner(file: RegistryFile, operationId: string): DeliveryOperationOwner | null {
  const owner = file.deliveryOperationOwners[operationId];
  return owner?.retryOfOperationId ? owner : null;
}

/**
 * What a caller may do next, from the durable disposition rather than prose.
 *
 * `safe` requires the record to POSITIVELY say the send was fenced before
 * anything could execute it. A record that says nothing — one written before
 * the disposition existed, one settled by a path that proved nothing — is not a
 * fenced send, so it is answered as unverified. That is the whole difference
 * between "we know this never ran" and "we never found out".
 */
function resendGuidance(
  disposition: DeliveryTerminalDisposition | null,
  reason: string | null,
): { duplicateRisk: boolean; resend: SendResendGuidance } {
  const fenced = disposition === "lost" || (disposition === null && reason === SEND_LOST_REASON);
  return fenced
    ? { duplicateRisk: false, resend: "safe" }
    : { duplicateRisk: true, resend: "verify-first" };
}

/**
 * What became of one operation id, from the durable delivery record.
 *
 * The answer reads `deliveryOperationOwners` for the settlement — that index
 * survives reservation compaction, so a compacted unverified failure cannot
 * come back as a safe one — and the reservation for what only it still holds. A
 * caller that asks about an id nothing ever admitted gets `null` rather than an
 * invented in-flight answer.
 */
export function sendReceiptFor(file: RegistryFile, operationId: string): SendReceipt | null {
  const owner = file.deliveryOperationOwners[operationId];
  const delivery = deliveryForOperation(file, operationId);
  if (!owner && !delivery) return null;
  const attempt = retryAttemptOwner(file, operationId);
  const conversationId = (delivery?.conversationId ?? owner?.conversationId) ?? null;
  const clientMessageId = (delivery?.clientMessageId ?? owner?.clientMessageId) ?? null;
  const kind = (delivery?.command ?? owner?.command)?.kind ?? "send";
  const acceptedAt = attempt ? attempt.createdAt : delivery ? acceptedAtOf(delivery) : owner?.createdAt ?? null;
  /* The reservation wins when it is still present — it carries the reason and
     the delivery time — and the owner row answers once it has been compacted
     away. The two never disagree: the owner is synchronized from the
     reservation every time one settles. A retry ATTEMPT is the exception, and
     the only one: it shares the reservation with the attempt it replaces, so
     the reservation's terminal answer belongs to that earlier attempt and this
     row keeps its own. */
  const terminalState = attempt
    ? attempt.terminalState
    : delivery && (delivery.state === "delivered" || delivery.state === "failed")
      ? delivery.state
      : owner?.terminalState ?? null;
  if (terminalState === "delivered") {
    return {
      operationId,
      kind,
      conversationId,
      clientMessageId,
      state: "delivered",
      reason: null,
      acceptedAt,
      settledAt: attempt ? attempt.settledAt : delivery?.deliveredAt ?? owner?.settledAt ?? null,
      duplicateRisk: false,
      resend: "not-needed",
      evidence: "delivery-record",
    };
  }
  if (terminalState === "failed") {
    const reason = attempt ? attempt.terminalReason : delivery?.error ?? owner?.terminalReason ?? null;
    return {
      operationId,
      kind,
      conversationId,
      clientMessageId,
      state: "failed",
      reason,
      acceptedAt,
      settledAt: owner?.settledAt ?? null,
      ...resendGuidance((attempt ?? owner)?.terminalDisposition ?? null, reason),
      evidence: "delivery-record",
    };
  }
  return {
    operationId,
    kind,
    conversationId,
    clientMessageId,
    state: "in-flight",
    reason: delivery?.state === "held"
      ? "held behind an account migration"
      : "accepted for delivery and not settled yet",
    acceptedAt,
    settledAt: null,
    duplicateRisk: false,
    resend: null,
    evidence: "delivery-record",
  };
}

/**
 * The settlement's answer in the shape a runtime receipt reader expects.
 *
 * The operation API answers `{ operationId, receipt }`, and during an outage
 * the journal that would have supplied the receipt is exactly what cannot be
 * reached — which used to make an accepted send unqueryable for the length of
 * the outage. Everything here comes off the durable record, so the endpoint can
 * answer from it alone; the journal's own receipt is preferred wherever it can
 * still be read, because it carries more than the record ever holds.
 */
export function runtimeReceiptForSend(receipt: SendReceipt): RuntimeOperationReceipt {
  return {
    operationId: receipt.operationId,
    idempotencyKey: receipt.clientMessageId ?? "",
    conversationId: receipt.conversationId ?? "",
    kind: receipt.kind,
    status: receipt.state === "in-flight" ? "queued" : receipt.state,
    reason: receipt.reason,
    at: receipt.settledAt ?? receipt.acceptedAt ?? new Date(0).toISOString(),
    ...(receipt.acceptedAt ? { admittedAt: receipt.acceptedAt } : {}),
    ...(receipt.resend ? { resend: receipt.resend } : {}),
    revision: 1,
  };
}

/**
 * Whether the durable delivery record has already ended this send.
 *
 * The delivery queue asks this before it actuates a message effect. A send that
 * a receipt query settled while the runtime host was unreachable has an answer
 * out in the world already; delivering it once the socket comes back would make
 * that answer a lie and put the instruction in front of the recipient long
 * after the sender was told it had not arrived.
 */
export function sendIsSettled(file: RegistryFile, operationId: string): boolean {
  return sendReceiptFor(file, operationId)?.state === "failed";
}

/** A terminal answer the journal has already reached, and what it proves. */
export interface JournalVerdict {
  state: "delivered" | "failed";
  disposition: DeliveryTerminalDisposition;
  reason: string | null;
}

/**
 * The journal's own answer, read as a settlement.
 *
 * `failed` and `rejected` are written on a message effect only where the send
 * never reached the engine, and `uncertain` wherever it may have — the delivery
 * queue keeps that distinction exact, which is what lets a fenced send be
 * called safe without guessing. An open or missing status is not a verdict and
 * returns null; the caller decides what to do about it. A failed receipt whose
 * reason records the operator's Discard keeps that visible terminal reason.
 *
 * The receipt query and the controller's startup reconciliation both read the
 * journal for the same question, so they read it through this — one classifier,
 * rather than two that can drift into disagreeing about what a status proves.
 */
export function journalVerdict(
  status: RuntimeReceiptStatus | null,
  reason: string | null | undefined = null,
): JournalVerdict | null {
  if (status === null) return null;
  if (DELIVERED_RECEIPT_STATUSES.has(status)) {
    return { state: "delivered", disposition: "delivered", reason: null };
  }
  if (status === "failed" || status === "rejected") {
    return {
      state: "failed",
      disposition: "lost",
      reason: reason === SEND_DISCARDED_REASON ? SEND_DISCARDED_REASON : SEND_LOST_REASON,
    };
  }
  if (status === "uncertain") {
    return { state: "failed", disposition: "unverified", reason: SEND_UNVERIFIED_REASON };
  }
  return null;
}

/**
 * Terminalizes an operation the journal still shows as unexecuted.
 *
 * Failing it outright clears its outbox row in the same transaction and makes
 * the later `delivering` transition illegal, so the send is fenced — and this
 * is the one path that can prove non-execution, which is why it is the one that
 * may report `lost`.
 */
async function fenceOperation(
  client: RuntimeHostClient,
  operationId: string,
  status: RuntimeReceiptStatus,
): Promise<JournalVerdict> {
  if (!OPEN_RECEIPT_STATUSES.has(status)) {
    /* Not open, not terminal: a send in `delivering` or `applying` is already
       in an executor's hands. It cannot be proved undelivered, so it is
       terminalized as `uncertain` — which fences it just as firmly against a
       SECOND execution while saying nothing about the first. A runtime host
       from before that transition rejects the word; the operation must stop
       being open either way, so the fallback keeps the fence and the record
       keeps the unverified disposition it is read back by. */
    try {
      await client.transitionOperation(operationId, "uncertain", { reason: SEND_UNVERIFIED_REASON });
    } catch {
      await client.transitionOperation(operationId, "failed", { reason: SEND_UNVERIFIED_REASON });
    }
    return { state: "failed", disposition: "unverified", reason: SEND_UNVERIFIED_REASON };
  }
  await client.transitionOperation(operationId, "failed", { reason: SEND_LOST_REASON });
  return { state: "failed", disposition: "lost", reason: SEND_LOST_REASON };
}

/**
 * The turn reference the recipient's current generation is publishing, or null
 * when it publishes none — including when it has no live structured host at
 * all, which is the case a lost send most often sits in.
 */
function awaitingRecipientTurn(
  registry: AgentRegistry,
  file: RegistryFile,
  conversationId: ViewerConversationId,
): boolean {
  const conversation = registry.conversation(conversationId);
  const generation = conversation?.generations.at(-1);
  if (!conversation || !generation) return false;
  const entry = file.entries[sessionKeyId({ engine: conversation.engine, sessionId: generation.id })];
  return Boolean(entry?.structuredHost?.activeTurnRef);
}

/**
 * The reservation states an accepted send can rest in, and that this read may
 * therefore end.
 *
 * `delivery-uncertain` is what a reservation holds from the moment the send
 * path claims its attempt until a terminal transition projects an outcome onto
 * it. `assigned` is what a send admitted while the runtime host was
 * UNREACHABLE holds: no journal operation exists for it, so nothing in the
 * journal can ever settle it, and it waits for a drain that only happens once
 * the runtime is healthy again. Leaving that one out is how the original bug
 * survived inside its own fix — an accepted send whose only terminal path
 * required the very health it did not have (#1131).
 *
 * `held` is excluded, and stays excluded: a parked delivery is waiting on an
 * account migration by design, its owner is the migration coordinator, and
 * ending it here would drop work that is still going somewhere.
 */
const SETTLEABLE_DELIVERY_STATES: ReadonlySet<HeldDelivery["state"]> = new Set<HeldDelivery["state"]>([
  "delivery-uncertain",
  "assigned",
]);

/** What the deadline is measured against: an unsettled reservation, or a retry
    attempt's own row, which ages from its OWN admission. */
interface SettlementSubject {
  conversationId: ViewerConversationId;
  acceptedAt: string;
  settleable: boolean;
}

function settlementSubject(
  attempt: DeliveryOperationOwner | null,
  delivery: HeldDelivery | null,
): SettlementSubject | null {
  if (attempt) {
    return {
      conversationId: attempt.conversationId,
      acceptedAt: attempt.createdAt,
      settleable: attempt.terminalState === null,
    };
  }
  if (!delivery) return null;
  return {
    conversationId: delivery.conversationId,
    acceptedAt: acceptedAtOf(delivery),
    settleable: SETTLEABLE_DELIVERY_STATES.has(delivery.state),
  };
}

/**
 * Whether an accepted send has rested long enough that this read must end it.
 */
function pastSettlementDeadline(
  registry: AgentRegistry,
  file: RegistryFile,
  subject: SettlementSubject,
  ports: SendSettlementPorts,
): boolean {
  if (!subject.settleable) return false;
  const acceptedAt = parseTime(subject.acceptedAt);
  /* An acceptance time that cannot be parsed can never age, and a send nothing
     can ever end is the silence this issue is about. */
  if (acceptedAt === null) return true;
  const restedMs = (ports.now ?? Date.now)() - acceptedAt;
  if (restedMs < (ports.windowMs ?? SEND_SETTLEMENT_WINDOW_MS)) return false;
  if (restedMs >= (ports.inTurnCeilingMs ?? SEND_SETTLEMENT_IN_TURN_CEILING_MS)) return true;
  return !awaitingRecipientTurn(registry, file, subject.conversationId);
}

/**
 * What became of one accepted send, settled if it is past its deadline.
 *
 * The registry projection can lag the journal by a whole drain — the queue
 * terminalizes the operation and the reservation learns about it later — and a
 * caller holding an operation id is asking what is true NOW. So an answer that
 * is still in flight is checked against the journal's current retry leaf, and a
 * terminal answer there settles the reservation on the spot.
 *
 * Past the deadline this read is also what ENDS the send, from whatever
 * evidence it could gather: an unexecuted operation is fenced and reported
 * lost, an actuated one is terminalized unverified, and a journal that cannot
 * be reached at all still yields a terminal — unverified — answer, because
 * `queued` may not be the last word during an outage of any length. The
 * delivery queue reads the record this writes before it actuates anything, so
 * the answer stays true when the runtime returns.
 */
export async function resolveSendReceipt(
  operationId: string,
  ports: SendSettlementPorts = {},
): Promise<SendReceipt | null> {
  const registry = ports.registry ?? agentRegistry();
  const projected = sendReceiptFor(registry.readOnlySnapshot(), operationId);
  if (!projected || projected.state !== "in-flight") return projected;
  const client = ports.client === undefined ? runtimeHostClient() : ports.client;
  /* The journal read, keeping whether it happened at all. A socket that is not
     there is the runtime host being unreachable, which is the same answer as a
     read that threw: nothing was asked, so nothing was learned. */
  const journal = client
    ? await readEvidence(
      () => client.operationStatus(operationId, { currentRetryLeaf: true }),
      "runtime host is unavailable",
    )
    : unreadableEvidence("runtime host socket is unavailable");
  const receipt = journal.readable ? journal.value?.receipt ?? null : null;
  const status = receipt?.status ?? null;
  const verdict = journalVerdict(status, receipt?.reason);
  if (verdict) return settleProjection(registry, operationId, projected, verdict);

  const file = registry.readOnlySnapshot();
  const subject = settlementSubject(retryAttemptOwner(file, operationId), deliveryForOperation(file, operationId));
  if (!subject || !pastSettlementDeadline(registry, file, subject, ports)) return projected;
  /* Past the deadline, and the journal has no terminal answer of its own. What
     the settlement may CLAIM depends on what it could see. */
  const unsettleable: JournalVerdict = {
    state: "failed",
    disposition: "unverified",
    reason: SEND_UNSETTLEABLE_REASON,
  };
  if (!journal.readable || !client) {
    /* Nothing was asked and nothing answered: the durable record is the whole
       evidence, and the receipt says so rather than crediting a journal this
       query never reached. */
    return settleProjection(registry, operationId, projected, unsettleable, "delivery-record");
  }
  if (journal.value === null || status === null) {
    return settleProjection(registry, operationId, projected, {
      state: "failed",
      disposition: "unverified",
      reason: SEND_UNRECORDED_REASON,
    });
  }
  /* The one path that can prove non-execution: the journal still holds the
     operation, so terminalizing it now is what makes "never executed" true
     rather than merely hoped for. A fence the journal will not accept — a
     socket that died between the read and the write, a database that has gone
     read-only — proves nothing, so it may not report the send lost; it may not
     leave the send in flight either, because a host whose reads work and whose
     writes do not would make `queued` permanent exactly as an outage would. So
     it ends the same way an outage does, on the durable record the delivery
     queue reads before it actuates anything. */
  const journalOperationId = journal.value.operationId;
  const fenced = await readEvidence(
    () => fenceOperation(client, journalOperationId, status),
    "the delivery journal would not accept the fence",
  );
  return settleProjection(
    registry,
    operationId,
    projected,
    fenced.readable ? fenced.value : unsettleable,
    fenced.readable ? "delivery-journal" : "delivery-record",
  );
}

/**
 * Writes one verdict onto the durable record and answers from it.
 *
 * A reservation still in flight is settled; one that is already gone leaves the
 * journal's answer to speak for itself. A `held` reservation is the migration
 * coordinator's, and is left alone.
 */
function settleProjection(
  registry: AgentRegistry,
  operationId: string,
  projected: SendReceipt,
  verdict: JournalVerdict,
  evidence: SendReceipt["evidence"] = "delivery-journal",
): SendReceipt {
  const file = registry.readOnlySnapshot();
  /* A retry attempt settles on its OWN row. Its reservation belongs to the
     attempt it replaces and is already terminal from it, so writing this
     verdict there would overwrite what that earlier attempt proved with what
     this one did. */
  if (retryAttemptOwner(file, operationId)) {
    registry.settleDeliveryRetryAttempt(operationId, verdict.state, verdict.reason, verdict.disposition);
    const reconciled = sendReceiptFor(registry.readOnlySnapshot(), operationId);
    if (reconciled) return { ...reconciled, evidence };
  }
  const delivery = deliveryForOperation(file, operationId);
  if (delivery && SETTLEABLE_DELIVERY_STATES.has(delivery.state)) {
    registry.recordDeliveryOutcome(delivery.id, verdict.state, verdict.reason, verdict.disposition);
    const reconciled = sendReceiptFor(registry.readOnlySnapshot(), operationId);
    if (reconciled) return { ...reconciled, evidence };
  }
  if (verdict.state === "delivered") {
    return { ...projected, state: "delivered", reason: null, duplicateRisk: false, resend: "not-needed", evidence };
  }
  return {
    ...projected,
    state: "failed",
    reason: verdict.reason,
    ...resendGuidance(verdict.disposition, verdict.reason),
    evidence,
  };
}

/**
 * ── ORIGINAL-KEY LOOKUP (#1490) ───────────────────────────────────────────
 *
 * What the durable delivery records say about a send known only by the
 * identity its caller bound BEFORE dispatch: the canonical recipient and the
 * exact client message key handed to the send route. This is the read-only
 * primitive the MCP recovery path and the seat monitor's harvest (#1465) share:
 * it accepts a binding somebody else established, answers from the registry's
 * own records, and can neither enqueue, retry, withdraw nor spawn.
 *
 * The answer is closed. `found` names exactly one operation; `absent` means
 * the records hold nothing under that key — an observation, never proof that
 * nothing executed; `ambiguous` means more than one operation claims the key,
 * which discloses none of them.
 */
export interface OriginalSendBinding {
  /** Canonical conversation id (alias-resolved), or a transcript path when the
      send was addressed by path and no conversation was registered for it. */
  conversationId: string;
  /** The exact `clientMessageId` the send route was handed. */
  clientMessageId: string;
}

export type OriginalSendLookup =
  | { kind: "found"; operationId: string; deliveryId: string | null; receipt: SendReceipt; reservationState: HeldDelivery["state"] | null }
  | { kind: "absent" }
  | { kind: "ambiguous"; operationIds: string[] };

export function lookupOriginalSend(file: RegistryFile, binding: OriginalSendBinding): OriginalSendLookup {
  const lookup = readOnlyConversationLookupFromSnapshot(file);
  const canonical = (id: string): string => lookup.conversation(id as ViewerConversationId)?.id ?? id;
  const byConversation = binding.conversationId.startsWith("conversation_");
  const target = byConversation ? canonical(binding.conversationId) : null;
  const matches = (conversationId: string): boolean => !byConversation || canonical(conversationId) === target;
  const operations = new Map<string, string | null>();
  for (const delivery of Object.values(file.heldDeliveries)) {
    if (delivery.clientMessageId !== binding.clientMessageId || !matches(delivery.conversationId)) continue;
    operations.set(delivery.command.operationId, delivery.id);
  }
  for (const [operationId, owner] of Object.entries(file.deliveryOperationOwners)) {
    if (owner.clientMessageId !== binding.clientMessageId || owner.retryOfOperationId || !matches(owner.conversationId)) continue;
    if (!operations.has(operationId)) operations.set(operationId, owner.deliveryId);
  }
  if (operations.size === 0) return { kind: "absent" };
  if (operations.size > 1) return { kind: "ambiguous", operationIds: [...operations.keys()].sort() };
  const [[operationId, deliveryId]] = [...operations.entries()];
  const receipt = sendReceiptFor(file, operationId);
  if (!receipt) return { kind: "absent" };
  const reservation = deliveryId ? file.heldDeliveries[deliveryId] : undefined;
  return { kind: "found", operationId, deliveryId: reservation ? deliveryId : null, receipt, reservationState: reservation?.state ?? null };
}

export type OriginalSendEvidence =
  | { kind: "found"; operationId: string; deliveryId: string | null; receipt: SendReceipt; reservationState: HeldDelivery["state"] | null; current: Evidence<SendReceipt | null> }
  | { kind: "absent" }
  | { kind: "ambiguous"; operationIds: string[] }
  | { kind: "unreadable"; reason: string };

/**
 * The lookup above, then the CURRENT answer for the one operation it found —
 * the same settlement read `message_receipt` performs, which may reconnect to
 * the runtime journal. A journal or registry that cannot be read keeps the
 * identity the durable record established and marks the current answer
 * unreadable; it never turns into an absence.
 */
export async function resolveOriginalSend(
  binding: OriginalSendBinding,
  ports: SendSettlementPorts = {},
): Promise<OriginalSendEvidence> {
  const registry = ports.registry ?? agentRegistry();
  const snapshot = readEvidenceSync(() => registry.readOnlySnapshot(), "the delivery record could not be read");
  if (!snapshot.readable) return { kind: "unreadable", reason: snapshot.reason };
  const found = lookupOriginalSend(snapshot.value, binding);
  if (found.kind !== "found") return found;
  const current = await readEvidence(() => resolveSendReceipt(found.operationId, ports), "the current delivery answer could not be read");
  return { ...found, current };
}
