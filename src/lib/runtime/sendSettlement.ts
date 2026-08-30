import {
  agentRegistry,
  readOnlyConversationLookupFromSnapshot,
  type AgentRegistry,
  type DeliveryTerminalDisposition,
  type RegistryFile,
} from "@/lib/agent/registry";
import { sessionKeyId } from "@/lib/agent/sessionKey";
import type { HeldDelivery, ViewerConversationId } from "@/lib/accounts/migration/contracts";

import { runtimeHostClient, type RuntimeHostClient } from "./client";
import type { RuntimeReceiptStatus } from "./contracts";

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
 * Two things are needed, and this module owns both:
 *
 * - **Every accepted send settles.** {@link settleUnsettledSends} sweeps the
 *   reservations that have not reached a terminal state and ends each one as
 *   `delivered` or `failed`, from the delivery journal's own answer.
 * - **The settlement is queryable by operation id.** {@link resolveSendReceipt}
 *   answers what became of the id `send_message` returned — from the durable
 *   record, reconciled against the journal's CURRENT answer, never from what
 *   the send call guessed at the time.
 *
 * ── WHY THIS NEVER CALLS A DUPLICATE SAFE ─────────────────────────────────
 *
 * Declaring a send failed is only honest if the send can no longer happen, so
 * the settlement never merely relabels a reservation: it terminalizes the
 * OPERATION in the runtime journal first, and only writes `failed` on the
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
 * That fence proves non-execution only where the journal still shows the send
 * as unexecuted, and that is the ONLY thing this module will call safe to send
 * again. Everything else it settles is `unverified`: a send the executor took
 * may have reached the recipient, and so may a send whose journal record cannot
 * be found at all — an absent record is not a proof of absence. Being wrong in
 * that direction costs a caller one verification; being wrong in the other
 * direction delivers a deployment instruction twice. Nothing here retries
 * anything on its own — a resend is the caller's decision, made against a
 * receipt that states whether it is safe.
 */

/** The two failure reasons this module writes. The durable record also carries
    a structured disposition beside them, so the receipt never has to read prose
    to know whether a resend can duplicate. */
export const SEND_LOST_REASON =
  "accepted for delivery but never executed; the delivery journal has fenced it, so it cannot arrive and may be sent again";
export const SEND_UNVERIFIED_REASON =
  "delivery was started and never settled; whether it reached the recipient is unknown, so sending it again may deliver it twice";
/** No journal operation was ever found for this send — the legacy delivery path
    never creates one, and a record can also be pruned. Non-execution is
    unproven either way, so it settles like any other unverified send. */
export const SEND_UNRECORDED_REASON =
  "delivery was accepted and the delivery journal holds no record of it; whether it reached the recipient is unknown, so sending it again may deliver it twice";

/**
 * How long an accepted send may rest unsettled before it is settled.
 *
 * This is a settlement deadline, not a delivery timeout: nothing waits on it,
 * and widening it would only make a dropped send take longer to become an
 * answer. It is generous enough that an ordinary drain, host recovery or
 * reconnection finishes well inside it.
 */
const SEND_SETTLEMENT_WINDOW_MS = 10 * 60_000;

/**
 * The ceiling on the in-turn exemption below.
 *
 * A send queued behind the recipient's active turn is progressing, not lost, so
 * it is exempt from the window. A host wedged mid-turn would otherwise make
 * that exemption permanent and put `queued` right back where this issue found
 * it, so the exemption ends here.
 */
const SEND_SETTLEMENT_IN_TURN_CEILING_MS = 60 * 60_000;

/** How often the release that owns traffic sweeps. */
const SEND_SETTLEMENT_INTERVAL_MS = 60_000;

/** Settlements attempted per sweep. Each costs one journal round trip; the rest
    wait for the next tick rather than holding the event loop. */
const SETTLEMENT_BATCH_CEILING = 20;

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

/** An accepted send the delivery record has not settled. */
export interface UnsettledSend {
  operationId: string;
  deliveryId: string;
  conversationId: ViewerConversationId;
  clientMessageId: string | null;
  acceptedAt: string;
  unsettledForMs: number;
  /** Set while the recipient's own turn is what the send is waiting on. */
  awaitingTurn: boolean;
}

export interface SendSettlementOutcome {
  operationId: string;
  deliveryId: string;
  conversationId: ViewerConversationId;
  state: "delivered" | "failed";
  /** `lost` fenced an unexecuted send; `unverified` ended one whose fate the
      journal could not prove; `reconciled` copied a terminal journal answer the
      projection had missed. */
  disposition: "lost" | "unverified" | "reconciled";
  duplicateRisk: boolean;
}

export interface SendSettlementReport {
  /** Accepted sends past the settlement window this pass considered. */
  examined: number;
  settled: SendSettlementOutcome[];
  /** Sends left alone because the journal could not be asked or answered. */
  deferred: { operationId: string; reason: string }[];
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

/** The turn reference the recipient's current generation is publishing, or null
    when it publishes none — including when it has no live structured host at
    all, which is the case a lost send most often sits in. The lookup is built
    once per pass: it indexes every conversation, so building one per delivery
    would make a sweep quadratic in a registry that has thousands. */
function activeTurnOf(
  file: RegistryFile,
  lookup: ReturnType<typeof readOnlyConversationLookupFromSnapshot>,
  conversationId: ViewerConversationId,
): string | null {
  const conversation = lookup.conversation(conversationId);
  const generation = conversation?.generations.at(-1);
  if (!conversation || !generation) return null;
  const entry = file.entries[sessionKeyId({ engine: conversation.engine, sessionId: generation.id })];
  return entry?.structuredHost?.activeTurnRef ?? null;
}

/**
 * The accepted sends this snapshot has not settled, oldest first.
 *
 * `delivery-uncertain` is the state a reservation holds from the moment the
 * send path claims its attempt until a terminal transition projects an outcome
 * onto it, so it is exactly "accepted, not settled". `held` is excluded: a
 * parked delivery is waiting on an account migration by design, and settling it
 * here would fight the coordinator that owns it.
 */
export function unsettledSends(
  file: RegistryFile,
  options: { now?: number; windowMs?: number; inTurnCeilingMs?: number } = {},
): UnsettledSend[] {
  const now = options.now ?? Date.now();
  const windowMs = options.windowMs ?? SEND_SETTLEMENT_WINDOW_MS;
  const ceilingMs = options.inTurnCeilingMs ?? SEND_SETTLEMENT_IN_TURN_CEILING_MS;
  const unsettled: UnsettledSend[] = [];
  let lookup: ReturnType<typeof readOnlyConversationLookupFromSnapshot> | null = null;
  for (const delivery of Object.values(file.heldDeliveries)) {
    if (delivery.state !== "delivery-uncertain") continue;
    const acceptedAt = parseTime(acceptedAtOf(delivery));
    if (acceptedAt === null) continue;
    const unsettledForMs = now - acceptedAt;
    if (unsettledForMs < windowMs) continue;
    lookup ??= readOnlyConversationLookupFromSnapshot(file);
    const awaitingTurn = activeTurnOf(file, lookup, delivery.conversationId) !== null;
    if (awaitingTurn && unsettledForMs < ceilingMs) continue;
    unsettled.push({
      operationId: delivery.command.operationId,
      deliveryId: delivery.id,
      conversationId: delivery.conversationId,
      clientMessageId: delivery.clientMessageId,
      acceptedAt: acceptedAtOf(delivery),
      unsettledForMs,
      awaitingTurn,
    });
  }
  return unsettled.sort((left, right) => right.unsettledForMs - left.unsettledForMs);
}

function deliveryForOperation(file: RegistryFile, operationId: string): HeldDelivery | null {
  const owner = file.deliveryOperationOwners[operationId];
  const delivery = owner
    ? file.heldDeliveries[owner.deliveryId]
    : Object.values(file.heldDeliveries).find((candidate) => candidate.command.operationId === operationId);
  return delivery ?? null;
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
  const conversationId = (delivery?.conversationId ?? owner?.conversationId) ?? null;
  const clientMessageId = (delivery?.clientMessageId ?? owner?.clientMessageId) ?? null;
  const acceptedAt = delivery ? acceptedAtOf(delivery) : owner?.createdAt ?? null;
  /* The reservation wins when it is still present — it carries the reason and
     the delivery time — and the owner row answers once it has been compacted
     away. The two never disagree: the owner is synchronized from the
     reservation every time one settles. */
  const terminalState = delivery && (delivery.state === "delivered" || delivery.state === "failed")
    ? delivery.state
    : owner?.terminalState ?? null;
  if (terminalState === "delivered") {
    return {
      operationId,
      conversationId,
      clientMessageId,
      state: "delivered",
      reason: null,
      acceptedAt,
      settledAt: delivery?.deliveredAt ?? owner?.settledAt ?? null,
      duplicateRisk: false,
      resend: "not-needed",
      evidence: "delivery-record",
    };
  }
  if (terminalState === "failed") {
    const reason = delivery?.error ?? owner?.terminalReason ?? null;
    return {
      operationId,
      conversationId,
      clientMessageId,
      state: "failed",
      reason,
      acceptedAt,
      settledAt: owner?.settledAt ?? null,
      ...resendGuidance(owner?.terminalDisposition ?? null, reason),
      evidence: "delivery-record",
    };
  }
  return {
    operationId,
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
 * returns null; the caller decides what to do about it.
 *
 * The sweep and the controller's startup reconciliation both read the journal
 * for the same question, so they read it through this — one classifier, rather
 * than two that can drift into disagreeing about what a status proves.
 */
export function journalVerdict(status: RuntimeReceiptStatus | null): JournalVerdict | null {
  if (status === null) return null;
  if (DELIVERED_RECEIPT_STATUSES.has(status)) {
    return { state: "delivered", disposition: "delivered", reason: null };
  }
  if (status === "failed" || status === "rejected") {
    return { state: "failed", disposition: "lost", reason: SEND_LOST_REASON };
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
 * Settles one accepted send against the delivery journal.
 *
 * The journal is asked first and always wins: a send it already delivered is
 * reconciled rather than failed, which is what keeps a merely-missed projection
 * from being reported as a loss.
 */
async function settleOne(
  send: UnsettledSend,
  registry: AgentRegistry,
  client: RuntimeHostClient,
): Promise<SendSettlementOutcome> {
  /* The CURRENT attempt, not the one the reservation was born with. A retried
     operation leaves its ancestor terminal and carries on under a fresh id, so
     reading the ancestor would report a live attempt as a settled loss — and
     would then try to fence an operation that is already terminal. */
  const current = await client.operationStatus(send.operationId, { currentRetryLeaf: true });
  const status = current?.receipt.status ?? null;
  const settled = journalVerdict(status);
  const verdict = settled
    ? settled
    /* No journal record at all. The legacy delivery path never creates one, and
       a record can also be pruned — so this says the fate is unknown, never
       that the send is provably lost. Claiming the latter is what would let a
       caller resend an instruction the recipient already has. */
    : status === null || current === null
      ? { state: "failed" as const, disposition: "unverified" as const, reason: SEND_UNRECORDED_REASON }
      : await fenceOperation(client, current.operationId, status);
  registry.recordDeliveryOutcome(send.deliveryId, verdict.state, verdict.reason, verdict.disposition);
  return {
    operationId: send.operationId,
    deliveryId: send.deliveryId,
    conversationId: send.conversationId,
    state: verdict.state,
    disposition: settled ? "reconciled" : verdict.disposition === "lost" ? "lost" : "unverified",
    duplicateRisk: verdict.disposition === "unverified",
  };
}

/**
 * One settlement pass.
 *
 * A send whose journal answer cannot be read is DEFERRED, never settled: an
 * unreachable runtime host is a reason to know less, not a licence to declare a
 * message lost while it may still be sitting in a live outbox. Nothing depends
 * on this pass for terminality — the executor fences what it actuated, at the
 * moment it actuates it — so a deferral costs an answer's timeliness and never
 * its correctness.
 */
export async function settleUnsettledSends(ports: SendSettlementPorts = {}): Promise<SendSettlementReport> {
  const registry = ports.registry ?? agentRegistry();
  const client = ports.client === undefined ? runtimeHostClient() : ports.client;
  const now = ports.now ?? Date.now;
  const candidates = unsettledSends(registry.readOnlySnapshot(), {
    now: now(),
    ...(ports.windowMs !== undefined ? { windowMs: ports.windowMs } : {}),
    ...(ports.inTurnCeilingMs !== undefined ? { inTurnCeilingMs: ports.inTurnCeilingMs } : {}),
  });
  const report: SendSettlementReport = { examined: candidates.length, settled: [], deferred: [] };
  if (!client) {
    for (const send of candidates) report.deferred.push({ operationId: send.operationId, reason: "runtime host is unavailable" });
    return report;
  }
  for (const send of candidates.slice(0, SETTLEMENT_BATCH_CEILING)) {
    try {
      report.settled.push(await settleOne(send, registry, client));
    } catch (error) {
      report.deferred.push({
        operationId: send.operationId,
        reason: error instanceof Error ? error.message : "settlement failed",
      });
    }
  }
  return report;
}

/**
 * What became of one accepted send, reconciled before it is answered.
 *
 * The registry projection can lag the journal by a whole sweep — the queue
 * terminalizes the operation and the reservation learns about it later — and a
 * caller holding an operation id is asking what is true NOW. So a projection
 * that is still in flight is checked against the journal's current retry leaf,
 * and a terminal answer there settles the reservation on the spot rather than
 * reporting `in-flight` until some sweep gets to it.
 */
export async function resolveSendReceipt(
  operationId: string,
  ports: Pick<SendSettlementPorts, "registry" | "client"> = {},
): Promise<SendReceipt | null> {
  const registry = ports.registry ?? agentRegistry();
  const projected = sendReceiptFor(registry.readOnlySnapshot(), operationId);
  if (!projected || projected.state !== "in-flight") return projected;
  const client = ports.client === undefined ? runtimeHostClient() : ports.client;
  if (!client) return projected;
  const current = await client
    .operationStatus(operationId, { currentRetryLeaf: true })
    .catch(() => null);
  const verdict = journalVerdict(current?.receipt.status ?? null);
  if (!verdict) return projected;
  /* A reservation still in flight is settled from the journal's answer; one
     that is already gone leaves the journal's answer to speak for itself. A
     `held` reservation is the migration coordinator's, and is left alone. */
  const delivery = deliveryForOperation(registry.readOnlySnapshot(), operationId);
  if (delivery?.state === "delivery-uncertain") {
    registry.recordDeliveryOutcome(delivery.id, verdict.state, verdict.reason, verdict.disposition);
    const reconciled = sendReceiptFor(registry.readOnlySnapshot(), operationId);
    if (reconciled) return { ...reconciled, evidence: "delivery-journal" };
  }
  if (verdict.state === "delivered") {
    return { ...projected, state: "delivered", reason: null, duplicateRisk: false, resend: "not-needed", evidence: "delivery-journal" };
  }
  return {
    ...projected,
    state: "failed",
    reason: verdict.reason,
    ...resendGuidance(verdict.disposition, verdict.reason),
    evidence: "delivery-journal",
  };
}

const settlementHost = globalThis as typeof globalThis & {
  __llvSendSettlementTimer?: ReturnType<typeof setInterval>;
};

/**
 * Starts the sweep in the release that owns traffic.
 *
 * Idempotent per process, and unref'd so it never holds a Viewer open. The
 * sweep is what turns a send nobody ever executed into an answer without the
 * sender running a watchdog; `message_receipt` reads the same record it writes.
 */
export function startSendSettlement(): void {
  if (settlementHost.__llvSendSettlementTimer) return;
  const timer = setInterval(() => {
    void settleUnsettledSends().catch((error) => {
      console.error("[send settlement] sweep failed", error instanceof Error ? error.message : "unknown");
    });
  }, SEND_SETTLEMENT_INTERVAL_MS);
  timer.unref?.();
  settlementHost.__llvSendSettlementTimer = timer;
}
