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
  /** Delivery ids acknowledged by the successor after idempotent delivery. */
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
  /** Unacknowledged deliveries the successor must replay in durable order. */
  replay: HandoffDelivery[];
  reason?: ClaimReason;
}

export interface HandoffQueueStoreState {
  rows: HandoffRow[];
  history: HandoffRow[];
  drainingGenerations: string[];
}

/** Durable substrate for the queue. Implementations must persist atomically. */
export interface HandoffQueueStore {
  load(): HandoffRow[];
  save(rows: readonly HandoffRow[]): void;
  loadHistory?(): HandoffRow[];
  saveHistory?(rows: readonly HandoffRow[]): void;
  loadDrainingGenerations?(): string[];
  saveDrainingGenerations?(generations: readonly string[]): void;
  /** Runs one read-modify-write cycle while holding the store's durable lock. */
  transaction?<T>(mutation: (state: HandoffQueueStoreState) => T): T;
}

export class InMemoryHandoffQueueStore implements HandoffQueueStore {
  private rows: HandoffRow[] = [];
  private history: HandoffRow[] = [];
  private drainingGenerations: string[] = [];

  load(): HandoffRow[] {
    return this.rows.map((row) => structuredClone(row));
  }

  save(rows: readonly HandoffRow[]): void {
    this.rows = rows.map((row) => structuredClone(row));
  }

  loadHistory(): HandoffRow[] {
    return this.history.map((row) => structuredClone(row));
  }

  saveHistory(rows: readonly HandoffRow[]): void {
    this.history = rows.map((row) => structuredClone(row));
  }

  loadDrainingGenerations(): string[] {
    return [...this.drainingGenerations];
  }

  saveDrainingGenerations(generations: readonly string[]): void {
    this.drainingGenerations = [...new Set(generations)];
  }

  transaction<T>(mutation: (state: HandoffQueueStoreState) => T): T {
    const state = {
      rows: this.load(),
      history: this.loadHistory(),
      drainingGenerations: this.loadDrainingGenerations(),
    };
    const result = mutation(state);
    this.save(state.rows);
    this.saveHistory(state.history);
    this.saveDrainingGenerations(state.drainingGenerations);
    return result;
  }
}

function orderedDeliveries(deliveries: readonly HandoffDelivery[]): HandoffDelivery[] {
  return [...deliveries].sort((left, right) => left.seq - right.seq);
}

function replacementDeliveries(previous: HandoffRow, incoming: readonly HandoffDelivery[]): HandoffDelivery[] {
  const acknowledgedIds = new Set(previous.replayedDeliveryIds);
  const pendingIncoming = orderedDeliveries(incoming)
    .filter((delivery) => !acknowledgedIds.has(delivery.deliveryId));
  const incomingIds = new Set(pendingIncoming.map((delivery) => delivery.deliveryId));
  const unacknowledged = orderedDeliveries(previous.pendingDeliveries)
    .filter((delivery) => !acknowledgedIds.has(delivery.deliveryId))
    .filter((delivery) => !incomingIds.has(delivery.deliveryId));
  return [...unacknowledged, ...pendingIncoming]
    .map((delivery, index) => ({ ...delivery, seq: index + 1 }));
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
  constructor(
    private readonly store: HandoffQueueStore,
    private readonly clock: () => string = () => new Date().toISOString(),
  ) {}

  private loadState(): HandoffQueueStoreState {
    return {
      rows: this.store.load(),
      history: this.store.loadHistory?.() ?? [],
      drainingGenerations: this.store.loadDrainingGenerations?.() ?? [],
    };
  }

  private mutate<T>(mutation: (rowsById: Map<string, HandoffRow>, state: HandoffQueueStoreState) => T): T {
    const apply = (state: HandoffQueueStoreState) => {
      const rowsById = new Map(state.rows.map((row) => [row.operationId, row]));
      const result = mutation(rowsById, state);
      state.rows.splice(0, state.rows.length, ...rowsById.values());
      return result;
    };
    if (this.store.transaction) return this.store.transaction(apply);
    const state = this.loadState();
    const result = apply(state);
    this.store.save(state.rows);
    this.store.saveHistory?.(state.history);
    this.store.saveDrainingGenerations?.(state.drainingGenerations);
    return result;
  }

  rows(): HandoffRow[] {
    return this.store.load().map((row) => structuredClone(row));
  }

  /** Completed operation rows retained outside the one-row active lease set. */
  history(): HandoffRow[] {
    return (this.store.loadHistory?.() ?? []).map((row) => structuredClone(row));
  }

  row(operationId: string): HandoffRow | null {
    const state = this.loadState();
    const row = [...state.rows, ...state.history]
      .find((candidate) => candidate.operationId === operationId);
    return row ? structuredClone(row) : null;
  }

  /**
   * Protocol step 1: persist active conversations before promotion. Idempotent
   * by operation id — a repeated pre-promotion snapshot never resets an
   * already-draining or already-claimed row, and never fans out a second card.
   */
  enqueue(inputs: readonly HandoffRowInput[]): void {
    const now = this.clock();
    this.mutate((rowsById, state) => {
      for (const input of inputs) {
        if (rowsById.has(input.operationId)
          || state.history.some((row) => row.operationId === input.operationId)) continue;
        const active = [...rowsById.values()]
          .find((row) => row.conversationId === input.conversationId);
        if (active) {
          if (active.status === "pending" || active.status === "draining") continue;
          rowsById.delete(active.operationId);
          state.history.push(structuredClone(active));
        }
        rowsById.set(input.operationId, {
          ...input,
          pendingDeliveries: active
            ? replacementDeliveries(active, input.pendingDeliveries)
            : orderedDeliveries(input.pendingDeliveries),
          status: "pending",
          predecessorGeneration: null,
          successorGeneration: null,
          replayedDeliveryIds: [],
          interruptionOutcome: null,
          lastError: null,
          enqueuedAt: now,
          updatedAt: now,
        });
      }
    });
  }

  /**
   * Protocol step 3: put the outgoing generation into draining. Existing rows
   * keep their turns and delivery acknowledgements; the generation stops
   * admitting new hosts, but new UI messages are still enqueued durably.
   */
  beginDrain(generation: string): void {
    const now = this.clock();
    this.mutate((rowsById, state) => {
      if (!state.drainingGenerations.includes(generation)) state.drainingGenerations.push(generation);
      for (const row of rowsById.values()) {
        if (row.hostGeneration !== generation) continue;
        /* Rows this generation owns re-enter draining on every promotion: freshly
           enqueued `pending` rows and rows this generation `claimed` from a prior
           handoff. Terminal and failed rows stay at their retirement boundary. */
        if (row.status !== "pending" && row.status !== "claimed") continue;
        row.status = "draining";
        row.updatedAt = now;
      }
    });
  }

  /** A draining generation rejects new host admissions (protocol step 3). */
  isAdmittingNewHosts(generation: string): boolean {
    return !this.loadState().drainingGenerations.includes(generation);
  }

  /**
   * Protocol step 3: enqueue a new UI message into the durable queue. Accepted
   * while draining so the composer never drops a message during the handoff.
   */
  admitMessage(operationId: string, delivery: HandoffDelivery): boolean {
    return this.mutate((rowsById) => {
      const row = rowsById.get(operationId);
      if (!row || row.status === "terminal") return false;
      if (row.pendingDeliveries.some((existing) => existing.deliveryId === delivery.deliveryId)) return true;
      row.pendingDeliveries = orderedDeliveries([...row.pendingDeliveries, delivery]);
      row.updatedAt = this.clock();
      return true;
    });
  }

  /** Persist the outgoing host's latest turn boundary under its lease fence. */
  refreshTurnState(operationId: string, generation: string, turnState: HandoffTurnState): boolean {
    return this.mutate((rowsById) => {
      const row = rowsById.get(operationId);
      if (!row
        || row.hostGeneration !== generation
        || (row.status !== "pending" && row.status !== "draining")) return false;
      if (row.turnState === "terminal" && turnState !== "terminal") return false;
      row.turnState = turnState;
      row.updatedAt = this.clock();
      return true;
    });
  }

  /**
   * Protocol steps 4 & 5: transfer one conversation lease to the incoming
   * generation behind a compare-and-swap generation fence. The successor claims
   * the same conversation/session identity, replays queued messages in order,
   * and records a terminal predecessor -> successor link. A busy turn at the
   * drain deadline records an interruption outcome and resumes from the durable
   * transcript. Re-claiming with the same successor generation preserves its
   * lease and offers every delivery still awaiting acknowledgement.
   */
  claim(operationId: string, fence: ClaimFence): ClaimResult {
    return this.mutate((rowsById) => {
      const row = rowsById.get(operationId);
      if (!row) return { ok: false, row: null, replay: [], reason: "not-found" };

      const replay = orderedDeliveries(row.pendingDeliveries)
        .filter((delivery) => !row.replayedDeliveryIds.includes(delivery.deliveryId));

      // Idempotent re-claim: the successor already owns this identity.
      if (row.successorGeneration === fence.toGeneration
        && (row.status === "claimed" || row.status === "terminal")) {
        return { ok: true, row: structuredClone(row), replay };
      }

      if (row.hostGeneration !== fence.fromGeneration) {
        return { ok: false, row: structuredClone(row), replay: [], reason: "generation-fence" };
      }

      row.predecessorGeneration = fence.fromGeneration;
      row.successorGeneration = fence.toGeneration;
      row.hostGeneration = fence.toGeneration;
      row.status = terminalStatusFor(row.turnState);
      row.interruptionOutcome = outcomeFor(row.turnState);
      row.updatedAt = this.clock();
      return { ok: true, row: structuredClone(row), replay };
    });
  }

  /**
   * Records confirmed idempotent delivery under the successor ownership fence.
   * A caller may acknowledge one delivery at a time, allowing a restart to
   * resume at the first delivery whose confirmation was never persisted.
   */
  acknowledgeReplay(operationId: string, successorGeneration: string, deliveryIds: readonly string[]): boolean {
    return this.mutate((rowsById) => {
      const row = rowsById.get(operationId);
      if (!row
        || row.successorGeneration !== successorGeneration
        || (row.status !== "claimed" && row.status !== "terminal")) return false;
      const knownIds = new Set(row.pendingDeliveries.map((delivery) => delivery.deliveryId));
      if (deliveryIds.some((deliveryId) => !knownIds.has(deliveryId))) return false;
      row.replayedDeliveryIds = [...new Set([...row.replayedDeliveryIds, ...deliveryIds])];
      row.updatedAt = this.clock();
      return true;
    });
  }

  /**
   * Protocol step 6 rollback: a failed candidate releases every row it claimed
   * back to its predecessor generation. The outgoing generation stays available
   * to serve or be reclaimed by a fresh candidate, and reverted deliveries are
   * queued again so nothing is silently lost.
   */
  failCandidate(toGeneration: string): void {
    const now = this.clock();
    this.mutate((rowsById, state) => {
      const drainingGenerations = new Set(state.drainingGenerations);
      for (const row of rowsById.values()) {
        if (row.successorGeneration !== toGeneration) continue;
        const predecessor = row.predecessorGeneration;
        row.hostGeneration = predecessor ?? row.hostGeneration;
        row.status = predecessor && drainingGenerations.has(predecessor) ? "draining" : "pending";
        row.predecessorGeneration = null;
        row.successorGeneration = null;
        row.replayedDeliveryIds = [];
        row.interruptionOutcome = null;
        row.updatedAt = now;
      }
    });
  }

  /**
   * Record an explicit retryable handoff failure (protocol step 6): the row is
   * a terminal boundary for retiring the outgoing container even though it never
   * transferred. Rollback keeps the outgoing generation available.
   */
  markRetryableFailure(operationId: string, error: string): void {
    this.mutate((rowsById) => {
      const row = rowsById.get(operationId);
      if (!row) return;
      row.status = "failed";
      row.lastError = error;
      row.updatedAt = this.clock();
    });
  }

  /**
   * Protocol step 6: the outgoing container may retire only once every row it
   * owned has reached `claimed`, `terminal`, or an explicit retryable `failed`.
   * A row still `pending` or `draining` on the outgoing generation blocks it.
   */
  retirable(outgoingGeneration: string): boolean {
    for (const row of this.store.load()) {
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
      launchProfile?: { parentConversationId?: string | null };
    }>;
  }>;
  entries: Record<string, {
    structuredHost?: { kind: string } | null;
    accountId: string | null;
  }>;
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
  const lineageChildren = new Set<string>();
  for (const edge of Object.values(snapshot.lineageEdges)) {
    lineageChildren.add(edge.childConversationId);
    if (edge.source === "engine-native") engineNativeParents.set(edge.childConversationId, edge.parentConversationId);
  }
  for (const conversation of Object.values(snapshot.conversations)) {
    if (lineageChildren.has(conversation.id)) continue;
    const parentConversationId = conversation.generations.at(-1)?.launchProfile?.parentConversationId;
    if (parentConversationId) engineNativeParents.set(conversation.id, parentConversationId);
  }

  const hostedOwner = (conversationId: string) => {
    const seen = new Set<string>();
    let currentId: string | undefined = conversationId;
    while (currentId && !seen.has(currentId)) {
      seen.add(currentId);
      const current = snapshot.conversations[currentId];
      const generation = current?.generations.at(-1);
      if (current && generation) {
        const entry = snapshot.entries[sessionEntryKey(current.engine, generation.id)];
        if (entry?.structuredHost) return { generation, entry };
      }
      currentId = engineNativeParents.get(currentId);
    }
    return null;
  };

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
    const parentConversationId = engineNativeParents.get(conversation.id) ?? null;
    const owner = hostedOwner(conversation.id);
    if (!owner) continue;
    const hostGeneration = generationFence(owner.generation.host, owner.generation.id);
    rows.push({
      operationId: `handoff_${conversation.id}_${hostGeneration}`,
      conversationId: conversation.id,
      engine: conversation.engine,
      engineSessionId: generation.id,
      kind: parentConversationId ? "engine-native-child" : "root",
      parentConversationId,
      hostGeneration,
      accountId: generation.accountId ?? owner.entry.accountId ?? null,
      turnState: conversation.turn.state,
      pendingDeliveries: deliveriesByConversation.get(conversation.id) ?? [],
    });
  }
  return rows;
}
