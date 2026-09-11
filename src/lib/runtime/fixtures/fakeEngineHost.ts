import type {
  DeliveryReceipt,
  EngineHost,
  HostState,
  QueueEntry,
  RuntimeEvent,
  RuntimeInjectOutcome,
  RuntimeInjectRequest,
} from "../engineHost";

export interface FakeDeliveryLedger {
  receipts: Map<string, DeliveryReceipt>;
  writes: QueueEntry[];
  /** #1560: injections, kept apart from `writes` on purpose. A test asserting
      that an injection did not become a message needs the two to be
      distinguishable at the adapter boundary. */
  injections: RuntimeInjectRequest[];
}

export function createFakeDeliveryLedger(): FakeDeliveryLedger {
  return { receipts: new Map(), writes: [], injections: [] };
}

export class FakeEngineHost implements EngineHost {
  readonly supportsSteer = true;
  constructor(
    readonly ledger: FakeDeliveryLedger = createFakeDeliveryLedger(),
    private readonly state: HostState = {
      status: "idle",
      sessionKey: "fake-session",
      endpoint: "fake:structured-host",
      pid: 1,
      processStartIdentity: "fake:1",
      eventCursor: 0,
      protocolVersion: "fake-v1",
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
      account: null,
    },
  ) {}

  async *attach(): AsyncIterableIterator<RuntimeEvent> {}

  async send(entry: QueueEntry): Promise<DeliveryReceipt> {
    const prior = this.ledger.receipts.get(entry.id);
    if (prior) return prior;
    const receipt: DeliveryReceipt = { outcome: "turn-started", turnId: `turn:${entry.id}` };
    this.ledger.writes.push({ ...entry });
    this.ledger.receipts.set(entry.id, receipt);
    return receipt;
  }

  /** #1560. Records the request and reports the placement the state implies,
      so a caller can assert the whole chain reached the engine boundary. */
  async inject(request: RuntimeInjectRequest): Promise<RuntimeInjectOutcome> {
    this.ledger.injections.push({ ...request });
    return {
      placement: this.state.activeTurnRef ? "pending-input" : "history",
      turnId: this.state.activeTurnRef,
      observe: async () => true,
    };
  }

  async interrupt(): Promise<void> {}
  async answer(): Promise<void> {}
  async health(): Promise<HostState> { return { ...this.state }; }
  async release(): Promise<void> {}
}
