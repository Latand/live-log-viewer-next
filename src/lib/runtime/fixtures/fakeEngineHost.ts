import type { DeliveryReceipt, EngineHost, HostState, QueueEntry, RuntimeEvent } from "../engineHost";

export interface FakeDeliveryLedger {
  receipts: Map<string, DeliveryReceipt>;
  writes: QueueEntry[];
}

export function createFakeDeliveryLedger(): FakeDeliveryLedger {
  return { receipts: new Map(), writes: [] };
}

export class FakeEngineHost implements EngineHost {
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

  async interrupt(): Promise<void> {}
  async answer(): Promise<void> {}
  async health(): Promise<HostState> { return { ...this.state }; }
  async release(): Promise<void> {}
}
