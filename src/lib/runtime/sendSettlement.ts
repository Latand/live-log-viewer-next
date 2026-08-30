import {
  agentRegistry,
  readOnlyConversationLookupFromSnapshot,
  type AgentRegistry,
  type RegistryFile,
} from "@/lib/agent/registry";
import { sessionKeyId } from "@/lib/agent/sessionKey";
import type { HeldDelivery, ViewerConversationId } from "@/lib/accounts/migration/contracts";
import { appendLifecycleEvents } from "@/lib/lifecycle/journal";
import { projectDeliveryEvents } from "@/lib/lifecycle/projector";

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
 * Three things are needed, and this module owns all three:
 *
 * - **Every accepted send settles.** {@link settleUnsettledSends} sweeps the
 *   reservations that have not reached a terminal state and ends each one as
 *   `delivered` or `failed`, from the delivery journal's own answer.
 * - **The settlement is queryable by operation id.** {@link sendReceiptFor} is
 *   a pure read over the registry's durable delivery index, so a caller holding
 *   the id `send_message` returned learns what became of it — from the record,
 *   never from what the send call guessed at the time.
 * - **A loss surfaces without a watchdog.** A settled-as-failed reservation is
 *   rendered as a failed send on the recipient's card, and the settlement
 *   journals its `delivery_expired` event as it declares the loss rather than
 *   leaving it for whoever next polls — so it is in the lifecycle digest, which
 *   orchestrators already read, before anyone asks. No new surface, and nothing
 *   for the sender to watch.
 *
 * ── WHY THIS CANNOT DELIVER THE SAME INSTRUCTION TWICE ────────────────────
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
 * That fence exists only for a send the journal still shows as unexecuted. A
 * send the executor already took (`delivering`) may have reached the recipient,
 * and nothing here can prove it did not, so it is terminalized as `uncertain`
 * and its receipt says so: the caller is told the fate is unknown and that
 * re-sending it may duplicate. This module never retries anything on its own —
 * a resend is the caller's decision, made against a receipt that states whether
 * it is safe.
 */

/** The two failure reasons this module writes, and the only two the receipt
    reads back. `sendReceiptFor` derives duplicate risk from them, so they are a
    contract between the sweep and the query rather than log prose. */
export const SEND_LOST_REASON =
  "accepted for delivery but never executed; the delivery journal has fenced it, so it cannot arrive and may be sent again";
export const SEND_UNVERIFIED_REASON =
  "delivery was started and never settled; whether it reached the recipient is unknown, so sending it again may deliver it twice";

/**
 * How long an accepted send may rest unsettled before it is declared lost.
 *
 * This is a settlement deadline, not a delivery timeout: nothing waits on it,
 * and widening it would only make a lost send take longer to become an answer.
 * It is generous enough that an ordinary drain, host recovery or reconnection
 * finishes well inside it.
 */
export const SEND_SETTLEMENT_WINDOW_MS = 10 * 60_000;

/**
 * The ceiling on the in-turn exemption below.
 *
 * A send queued behind the recipient's active turn is progressing, not lost, so
 * it is exempt from the window. A host wedged mid-turn would otherwise make
 * that exemption permanent and put `queued` right back where this issue found
 * it, so the exemption ends here.
 */
export const SEND_SETTLEMENT_IN_TURN_CEILING_MS = 60 * 60_000;

/** How often the release that owns traffic sweeps. */
export const SEND_SETTLEMENT_INTERVAL_MS = 60_000;

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
  /** The record this answer was read from, never the send call's own guess. */
  evidence: "delivery-journal";
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
  /** `lost` fenced an unexecuted send; `unverified` terminalized a started one;
      `reconciled` copied a terminal journal answer the projection had missed. */
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
  batchCeiling?: number;
  /** Where the declared loss is journaled. Swapped only by tests that assert
      the event without writing a shared lifecycle file. */
  journalLifecycle?: (deliveries: readonly HeldDelivery[]) => void;
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

/**
 * What became of one operation id, from the durable delivery record.
 *
 * The answer is read from `deliveryOperationOwners` first, which is the index
 * that survives reservation compaction, and falls back to the reservation
 * itself for records that predate an owner row. A caller that asks about an id
 * nothing ever admitted gets `null` rather than an invented in-flight answer.
 */
export function sendReceiptFor(file: RegistryFile, operationId: string): SendReceipt | null {
  const owner = file.deliveryOperationOwners[operationId];
  const delivery = owner
    ? file.heldDeliveries[owner.deliveryId]
    : Object.values(file.heldDeliveries).find((candidate) => candidate.command.operationId === operationId);
  if (!owner && !delivery) return null;
  const conversationId = (delivery?.conversationId ?? owner?.conversationId) ?? null;
  const clientMessageId = (delivery?.clientMessageId ?? owner?.clientMessageId) ?? null;
  const acceptedAt = delivery ? acceptedAtOf(delivery) : owner?.createdAt ?? null;
  /* The reservation wins when it is still present — it carries the reason and
     the settlement time — and the owner row answers once it has been compacted
     away. The two never disagree: the owner's terminal state is synchronized
     from the reservation every time one settles. */
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
      settledAt: delivery?.deliveredAt ?? null,
      duplicateRisk: false,
      resend: "not-needed",
      evidence: "delivery-journal",
    };
  }
  if (terminalState === "failed") {
    const reason = delivery?.error ?? null;
    const duplicateRisk = reason === SEND_UNVERIFIED_REASON;
    return {
      operationId,
      conversationId,
      clientMessageId,
      state: "failed",
      reason,
      acceptedAt,
      settledAt: null,
      duplicateRisk,
      resend: duplicateRisk ? "verify-first" : "safe",
      evidence: "delivery-journal",
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
    evidence: "delivery-journal",
  };
}

/** The same read against the live registry. */
export function sendReceipt(operationId: string, registry: AgentRegistry = agentRegistry()): SendReceipt | null {
  return sendReceiptFor(registry.readOnlySnapshot(), operationId);
}

/**
 * Terminalizes the journal operation, and answers whether the send can still
 * reach the recipient afterwards.
 *
 * An unexecuted send is failed outright: that clears its outbox row in the same
 * transaction and makes the later `delivering` transition illegal, so the send
 * is fenced. A started one is terminalized as `uncertain`, which fences it just
 * as firmly against a SECOND execution but says nothing about the first — which
 * is the truth, and is what the receipt then reports.
 */
async function fenceOperation(
  client: RuntimeHostClient,
  operationId: string,
  status: RuntimeReceiptStatus,
): Promise<{ disposition: "lost" | "unverified"; duplicateRisk: boolean }> {
  if (OPEN_RECEIPT_STATUSES.has(status)) {
    await client.transitionOperation(operationId, "failed", { reason: SEND_LOST_REASON });
    return { disposition: "lost", duplicateRisk: false };
  }
  /* `uncertain` is a newer transition than the rest of this channel; a runtime
     host from before it rejects the word. The operation must still stop being
     open either way, so the fallback keeps the fence and the receipt keeps the
     unverified reason it is read back by. */
  try {
    await client.transitionOperation(operationId, "uncertain", { reason: SEND_UNVERIFIED_REASON });
  } catch {
    await client.transitionOperation(operationId, "failed", { reason: SEND_UNVERIFIED_REASON });
  }
  return { disposition: "unverified", duplicateRisk: true };
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
  const operationId = current?.operationId ?? send.operationId;
  const status = current?.receipt.status ?? null;
  if (status !== null && DELIVERED_RECEIPT_STATUSES.has(status)) {
    registry.recordDeliveryOutcome(send.deliveryId, "delivered");
    return {
      operationId: send.operationId,
      deliveryId: send.deliveryId,
      conversationId: send.conversationId,
      state: "delivered",
      disposition: "reconciled",
      duplicateRisk: false,
    };
  }
  if (status === "failed" || status === "rejected") {
    registry.recordDeliveryOutcome(send.deliveryId, "failed", SEND_LOST_REASON);
    return {
      operationId: send.operationId,
      deliveryId: send.deliveryId,
      conversationId: send.conversationId,
      state: "failed",
      disposition: "reconciled",
      duplicateRisk: false,
    };
  }
  if (status === "uncertain") {
    registry.recordDeliveryOutcome(send.deliveryId, "failed", SEND_UNVERIFIED_REASON);
    return {
      operationId: send.operationId,
      deliveryId: send.deliveryId,
      conversationId: send.conversationId,
      state: "failed",
      disposition: "reconciled",
      duplicateRisk: true,
    };
  }
  /* No journal record at all means the send never reached admission, so nothing
     can execute it and there is nothing to fence — the same terminal answer as
     a fenced one, reached without a transition. */
  const fenced = status === null
    ? { disposition: "lost" as const, duplicateRisk: false }
    : await fenceOperation(client, operationId, status);
  registry.recordDeliveryOutcome(
    send.deliveryId,
    "failed",
    fenced.duplicateRisk ? SEND_UNVERIFIED_REASON : SEND_LOST_REASON,
  );
  return {
    operationId: send.operationId,
    deliveryId: send.deliveryId,
    conversationId: send.conversationId,
    state: "failed",
    disposition: fenced.disposition,
    duplicateRisk: fenced.duplicateRisk,
  };
}

/**
 * Journals the loss the moment it is declared.
 *
 * `delivery_expired` is the event a failed reservation already projects; what
 * changes here is WHEN, and that is the whole difference between a loss the
 * lifecycle digest carries and one that waits for a poll that may never come.
 * A journal that cannot be written must not undo a settlement that already
 * happened, so this reports and moves on.
 */
function journalSettledLosses(
  registry: AgentRegistry,
  deliveryIds: readonly string[],
  journal: (deliveries: readonly HeldDelivery[]) => void,
): void {
  if (deliveryIds.length === 0) return;
  const snapshot = registry.readOnlySnapshot();
  const settled = deliveryIds
    .map((id) => snapshot.heldDeliveries[id])
    .filter((delivery): delivery is HeldDelivery => delivery?.state === "failed");
  if (settled.length === 0) return;
  try {
    journal(settled);
  } catch (error) {
    console.error("[send settlement] journaling a settled loss failed", error instanceof Error ? error.message : "unknown");
  }
}

/**
 * One settlement pass.
 *
 * A send whose journal answer cannot be read is DEFERRED, never settled: an
 * unreachable runtime host is a reason to know less, not a licence to declare a
 * message lost while it may still be sitting in a live outbox.
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
  for (const send of candidates.slice(0, ports.batchCeiling ?? SETTLEMENT_BATCH_CEILING)) {
    try {
      report.settled.push(await settleOne(send, registry, client));
    } catch (error) {
      report.deferred.push({
        operationId: send.operationId,
        reason: error instanceof Error ? error.message : "settlement failed",
      });
    }
  }
  journalSettledLosses(
    registry,
    report.settled.filter((outcome) => outcome.state === "failed").map((outcome) => outcome.deliveryId),
    ports.journalLifecycle
      ?? ((deliveries) => { appendLifecycleEvents(projectDeliveryEvents([...deliveries])); }),
  );
  return report;
}

const settlementHost = globalThis as typeof globalThis & {
  __llvSendSettlementTimer?: ReturnType<typeof setInterval>;
};

/**
 * Starts the sweep in the release that owns traffic.
 *
 * Idempotent per process, and unref'd so it never holds a Viewer open. The
 * sweep is what makes terminality a property of the system rather than of
 * whoever happens to ask; `message_receipt` reads the same record it writes.
 */
export function startSendSettlement(ports: {
  scheduleInterval?: (callback: () => void, delayMs: number) => ReturnType<typeof setInterval>;
  sweep?: () => Promise<unknown>;
  intervalMs?: number;
} = {}): void {
  if (settlementHost.__llvSendSettlementTimer) return;
  const schedule = ports.scheduleInterval ?? ((callback, delayMs) => setInterval(callback, delayMs));
  const sweep = ports.sweep ?? (() => settleUnsettledSends());
  const timer = schedule(() => {
    void sweep().catch((error) => {
      console.error("[send settlement] sweep failed", error instanceof Error ? error.message : "unknown");
    });
  }, ports.intervalMs ?? SEND_SETTLEMENT_INTERVAL_MS);
  timer.unref?.();
  settlementHost.__llvSendSettlementTimer = timer;
}

/** Test seam: the timer is process-global, so a suite must be able to start
    from an unstarted one without reaching into module internals. */
export function stopSendSettlement(): void {
  const timer = settlementHost.__llvSendSettlementTimer;
  if (timer) clearInterval(timer);
  settlementHost.__llvSendSettlementTimer = undefined;
}
