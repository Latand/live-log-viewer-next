/**
 * Blue-green handoff queue (issue #253).
 *
 * A durable state machine that carries active structured conversations and
 * engine-native child threads across an exact-SHA Viewer promotion without
 * losing conversation/session identity, ordered delivery, or task lineage.
 *
 * The incident that motivates this module: a promotion passed candidate and
 * post-promotion health but stranded an engine-native child conversation in
 * `stalled` with "structured host ownership is unavailable" because its former
 * runtime generation vanished and no successor generation owned the child
 * thread. This queue is the load-bearing primitive of the deployment protocol
 * in the pinned contract — every conversation (root and child alike) is
 * persisted before promotion and transferred to the successor generation
 * behind a compare-and-swap generation fence, so ownership is never dropped.
 *
 * The state machine is a pure reducer over an injected {@link HandoffQueueStore}
 * so it can be exercised in-memory by tests and backed by durable SQLite in
 * production. It does not itself replace containers or drive deploy/rollback —
 * that remains a Deployer-owned action — it only records and transfers durable
 * ownership so those actions stay crash- and restart-safe.
 */

export type HandoffKind = "root" | "engine-native-child";

export type HandoffStatus = "pending" | "draining" | "claimed" | "terminal" | "failed";

export type HandoffTurnState = "busy" | "idle" | "terminal" | "unknown";

export type HandoffInterruptionOutcome = "completed" | "interrupted";

/** One ordered pending delivery for a conversation. `seq` is the durable order. */
export interface HandoffDelivery {
  deliveryId: string;
  clientMessageId: string | null;
  seq: number;
}

/** The pre-promotion projection of one conversation's durable ownership. */
export interface HandoffRowInput {
  /** Idempotent handoff operation id; primary key. */
  operationId: string;
  /** Conversation identity, preserved across the handoff. */
  conversationId: string;
  engine: "claude" | "codex";
  /** Engine session identity (native generation id). */
  engineSessionId: string;
  kind: HandoffKind;
  /** Parent conversation for an engine-native child; null for a root. */
  parentConversationId: string | null;
  /** Outgoing host generation that currently owns this conversation. */
  hostGeneration: string;
  /** Account ownership, preserved across the handoff. */
  accountId: string | null;
  turnState: HandoffTurnState;
  /** Ordered pending deliveries awaiting the successor generation. */
  pendingDeliveries: HandoffDelivery[];
}

export interface HandoffRow extends HandoffRowInput {
  status: HandoffStatus;
  /** Generation that owned the row before the current successor claimed it. */
  predecessorGeneration: string | null;
  /** Generation that claimed the row; the terminal predecessor -> successor link. */
  successorGeneration: string | null;
  /** Delivery ids already replayed to a successor; guards restart replay. */
  replayedDeliveryIds: string[];
  interruptionOutcome: HandoffInterruptionOutcome | null;
  lastError: string | null;
  enqueuedAt: string;
  updatedAt: string;
}

export interface ClaimFence {
  fromGeneration: string;
  toGeneration: string;
}

export type ClaimReason = "not-found" | "generation-fence";

export interface ClaimResult {
  ok: boolean;
  row: HandoffRow | null;
  /** Deliveries the successor must replay, in durable order. Empty on an
      idempotent re-claim so a crash retry never duplicates turns. */
  replay: HandoffDelivery[];
  reason?: ClaimReason;
}

/** Durable substrate for the queue. Implementations must persist atomically. */
export interface HandoffQueueStore {
  load(): HandoffRow[];
  save(rows: readonly HandoffRow[]): void;
}

export class InMemoryHandoffQueueStore implements HandoffQueueStore {
  private rows: HandoffRow[] = [];

  load(): HandoffRow[] {
    return this.rows.map((row) => structuredClone(row));
  }

  save(rows: readonly HandoffRow[]): void {
    this.rows = rows.map((row) => structuredClone(row));
  }
}

function orderedDeliveries(deliveries: readonly HandoffDelivery[]): HandoffDelivery[] {
  return [...deliveries].sort((left, right) => left.seq - right.seq);
}

function terminalStatusFor(turnState: HandoffTurnState): HandoffStatus {
  return turnState === "terminal" ? "terminal" : "claimed";
}

function outcomeFor(turnState: HandoffTurnState): HandoffInterruptionOutcome | null {
  if (turnState === "terminal") return "completed";
  if (turnState === "busy") return "interrupted";
  return null;
}

export class HandoffQueue {
  private readonly rowsById = new Map<string, HandoffRow>();
  private readonly drainingGenerations = new Set<string>();

  constructor(
    private readonly store: HandoffQueueStore,
    private readonly clock: () => string = () => new Date().toISOString(),
  ) {
    for (const row of store.load()) {
      this.rowsById.set(row.operationId, row);
      if (row.status === "draining") this.drainingGenerations.add(row.hostGeneration);
    }
  }

  private flush(): void {
    this.store.save([...this.rowsById.values()]);
  }

  rows(): HandoffRow[] {
    return [...this.rowsById.values()].map((row) => structuredClone(row));
  }

  row(operationId: string): HandoffRow | null {
    const row = this.rowsById.get(operationId);
    return row ? structuredClone(row) : null;
  }

  /**
   * Protocol step 1: persist active conversations before promotion. Idempotent
   * by operation id — a repeated pre-promotion snapshot never resets an
   * already-draining or already-claimed row, and never fans out a second card.
   */
  enqueue(inputs: readonly HandoffRowInput[]): void {
    const now = this.clock();
    let changed = false;
    for (const input of inputs) {
      if (this.rowsById.has(input.operationId)) continue;
      this.rowsById.set(input.operationId, {
        ...input,
        pendingDeliveries: orderedDeliveries(input.pendingDeliveries),
        status: "pending",
        predecessorGeneration: null,
        successorGeneration: null,
        replayedDeliveryIds: [],
        interruptionOutcome: null,
        lastError: null,
        enqueuedAt: now,
        updatedAt: now,
      });
      changed = true;
    }
    if (changed) this.flush();
  }

  /**
   * Protocol step 3: put the outgoing generation into draining. Existing rows
   * keep their turns and delivery acknowledgements; the generation stops
   * admitting new hosts, but new UI messages are still enqueued durably.
   */
  beginDrain(generation: string): void {
    this.drainingGenerations.add(generation);
    const now = this.clock();
    let changed = false;
    for (const row of this.rowsById.values()) {
      if (row.hostGeneration !== generation) continue;
      /* Rows this generation owns re-enter draining on every promotion: freshly
         enqueued `pending` rows and rows this generation `claimed` from a prior
         handoff. A row it does not own (`terminal`, `failed`, or owned by
         another generation) is left alone so it never blocks retirement. */
      if (row.status !== "pending" && row.status !== "claimed") continue;
      row.status = "draining";
      row.updatedAt = now;
      changed = true;
    }
    if (changed) this.flush();
  }

  /** A draining generation rejects new host admissions (protocol step 3). */
  isAdmittingNewHosts(generation: string): boolean {
    return !this.drainingGenerations.has(generation);
  }

  /**
   * Protocol step 3: enqueue a new UI message into the durable queue. Accepted
   * while draining so the composer never drops a message during the handoff.
   */
  admitMessage(operationId: string, delivery: HandoffDelivery): boolean {
    const row = this.rowsById.get(operationId);
    if (!row || row.status === "terminal") return false;
    if (row.pendingDeliveries.some((existing) => existing.deliveryId === delivery.deliveryId)) return true;
    row.pendingDeliveries = orderedDeliveries([...row.pendingDeliveries, delivery]);
    row.updatedAt = this.clock();
    this.flush();
    return true;
  }

  /**
   * Protocol steps 4 & 5: transfer one conversation lease to the incoming
   * generation behind a compare-and-swap generation fence. The successor claims
   * the same conversation/session identity, replays queued messages in order,
   * and records a terminal predecessor -> successor link. A busy turn at the
   * drain deadline records an interruption outcome and resumes from the durable
   * transcript. Re-claiming with the same successor generation (crash retry or
   * restart) is idempotent: it returns success with no replay so no turn or card
   * is ever duplicated.
   */
  claim(operationId: string, fence: ClaimFence): ClaimResult {
    const row = this.rowsById.get(operationId);
    if (!row) return { ok: false, row: null, replay: [], reason: "not-found" };

    // Idempotent re-claim: the successor already owns this identity.
    if (row.successorGeneration === fence.toGeneration
      && (row.status === "claimed" || row.status === "terminal")) {
      return { ok: true, row: structuredClone(row), replay: [] };
    }

    if (row.hostGeneration !== fence.fromGeneration) {
      return { ok: false, row: structuredClone(row), replay: [], reason: "generation-fence" };
    }

    const replay = orderedDeliveries(row.pendingDeliveries)
      .filter((delivery) => !row.replayedDeliveryIds.includes(delivery.deliveryId));
    row.predecessorGeneration = fence.fromGeneration;
    row.successorGeneration = fence.toGeneration;
    row.hostGeneration = fence.toGeneration;
    row.status = terminalStatusFor(row.turnState);
    row.interruptionOutcome = outcomeFor(row.turnState);
    row.replayedDeliveryIds = [...row.replayedDeliveryIds, ...replay.map((delivery) => delivery.deliveryId)];
    row.updatedAt = this.clock();
    this.flush();
    return { ok: true, row: structuredClone(row), replay };
  }

  /**
   * Protocol step 6 rollback: a failed candidate releases every row it claimed
   * back to its predecessor generation. The outgoing generation stays available
   * to serve or be reclaimed by a fresh candidate, and reverted deliveries are
   * queued again so nothing is silently lost.
   */
  failCandidate(toGeneration: string): void {
    const now = this.clock();
    let changed = false;
    for (const row of this.rowsById.values()) {
      if (row.successorGeneration !== toGeneration) continue;
      const predecessor = row.predecessorGeneration;
      row.hostGeneration = predecessor ?? row.hostGeneration;
      row.status = predecessor && this.drainingGenerations.has(predecessor) ? "draining" : "pending";
      row.predecessorGeneration = null;
      row.successorGeneration = null;
      row.replayedDeliveryIds = [];
      row.interruptionOutcome = null;
      row.updatedAt = now;
      changed = true;
    }
    if (changed) this.flush();
  }

  /**
   * Record an explicit retryable handoff failure (protocol step 6): the row is
   * a terminal boundary for retiring the outgoing container even though it never
   * transferred. Rollback keeps the outgoing generation available.
   */
  markRetryableFailure(operationId: string, error: string): void {
    const row = this.rowsById.get(operationId);
    if (!row) return;
    row.status = "failed";
    row.lastError = error;
    row.updatedAt = this.clock();
    this.flush();
  }

  /**
   * Protocol step 6: the outgoing container may retire only once every row it
   * owned has reached `claimed`, `terminal`, or an explicit retryable `failed`.
   * A row still `pending` or `draining` on the outgoing generation blocks it.
   */
  retirable(outgoingGeneration: string): boolean {
    for (const row of this.rowsById.values()) {
      if (row.hostGeneration !== outgoingGeneration) continue;
      if (row.status === "pending" || row.status === "draining") return false;
    }
    return true;
  }
}

/** Minimal projection of the agent registry snapshot the collector reads. */
export interface HandoffCandidateSnapshot {
  conversations: Record<string, {
    id: string;
    engine: "claude" | "codex";
    supersededBy: unknown | null;
    turn: { state: HandoffTurnState };
    generations: Array<{
      id: string;
      accountId: string | null;
      host: { identity: string; epoch: number } | null;
    }>;
  }>;
  entries: Record<string, { structuredHost: { kind: string } | null; accountId: string | null }>;
  lineageEdges: Record<string, {
    childConversationId: string;
    parentConversationId: string;
    source: "viewer-spawn" | "engine-native";
  }>;
  heldDeliveries: Record<string, { conversationId: string; state: string; createdAt: string }>;
}

const HANDOFF_DELIVERY_STATES = new Set(["held", "assigned", "delivery-uncertain"]);

function sessionEntryKey(engine: "claude" | "codex", sessionId: string): string {
  return `${engine}:${sessionId}`;
}

function generationFence(host: { identity: string; epoch: number } | null, sessionId: string): string {
  return host ? `${host.identity}:${host.epoch}` : `session:${sessionId}`;
}

/**
 * Project the durable pre-promotion handoff rows from an agent registry
 * snapshot. Every active structured conversation and engine-native child thread
 * is captured; terminal and superseded conversations are skipped. The operation
 * id is deterministic in (conversation, generation) so re-collecting the same
 * snapshot is idempotent.
 */
export function collectHandoffCandidates(snapshot: HandoffCandidateSnapshot): HandoffRowInput[] {
  const engineNativeParents = new Map<string, string>();
  for (const edge of Object.values(snapshot.lineageEdges)) {
    if (edge.source === "engine-native") engineNativeParents.set(edge.childConversationId, edge.parentConversationId);
  }

  const deliveriesByConversation = new Map<string, HandoffDelivery[]>();
  const orderedHeld = Object.entries(snapshot.heldDeliveries)
    .filter(([, held]) => HANDOFF_DELIVERY_STATES.has(held.state))
    .sort(([leftId, left], [rightId, right]) =>
      left.createdAt === right.createdAt ? leftId.localeCompare(rightId) : left.createdAt.localeCompare(right.createdAt));
  for (const [deliveryId, held] of orderedHeld) {
    const list = deliveriesByConversation.get(held.conversationId) ?? [];
    list.push({ deliveryId, clientMessageId: null, seq: list.length + 1 });
    deliveriesByConversation.set(held.conversationId, list);
  }

  const rows: HandoffRowInput[] = [];
  for (const conversation of Object.values(snapshot.conversations)) {
    if (conversation.supersededBy) continue;
    if (conversation.turn.state === "terminal") continue;
    const generation = conversation.generations.at(-1);
    if (!generation) continue;
    const entry = snapshot.entries[sessionEntryKey(conversation.engine, generation.id)];
    if (!entry?.structuredHost) continue;

    const parentConversationId = engineNativeParents.get(conversation.id) ?? null;
    const hostGeneration = generationFence(generation.host, generation.id);
    rows.push({
      operationId: `handoff_${conversation.id}_${hostGeneration}`,
      conversationId: conversation.id,
      engine: conversation.engine,
      engineSessionId: generation.id,
      kind: parentConversationId ? "engine-native-child" : "root",
      parentConversationId,
      hostGeneration,
      accountId: generation.accountId ?? entry.accountId ?? null,
      turnState: conversation.turn.state,
      pendingDeliveries: deliveriesByConversation.get(conversation.id) ?? [],
    });
  }
  return rows;
}
