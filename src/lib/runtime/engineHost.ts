export interface QueueEntry {
  id: string;
  text: string;
  /** Optional caller fence. A mismatch is rejected before any engine write. */
  expectedTurnId?: string | null;
}

export type DeliveryReceipt =
  | { outcome: "steered"; turnId: string }
  | { outcome: "turn-started"; turnId: string }
  | { outcome: "queued-next-turn"; turnId: string }
  | { outcome: "rejected"; reason: "stale-turn" | "dead-host" };

export type RuntimeEvent =
  | { kind: "turn-started"; turnId: string; seq: number }
  | { kind: "delta"; turnId: string; text: string; seq: number }
  | { kind: "item"; turnId: string | null; item: unknown; phase: "started" | "completed"; seq: number }
  | { kind: "turn-ended"; turnId: string; status: "completed" | "interrupted" | "error"; seq: number }
  | { kind: "attention"; id: string; method: string; attention: unknown; seq: number }
  | { kind: "attention-resolved"; id: string; resolution: "answered" | "host-restarted" | "server-resolved"; seq: number }
  | { kind: "limits"; snapshot: unknown; seq: number }
  | { kind: "session-status"; status: "active" | "idle" | "unhosted" | "dead"; activeFlags?: string[]; seq: number };

export interface HostState {
  status: "active" | "attention" | "idle" | "unhosted" | "dead";
  sessionKey: string;
  endpoint: string;
  pid: number | null;
  processStartIdentity: string | null;
  eventCursor: number;
  protocolVersion: string | null;
  activeTurnRef: string | null;
  pendingAttention: string[];
  activeFlags: string[];
  account: { type: string | null; planType: string | null } | null;
}

export class RuntimeReplayGapError extends Error {
  constructor(readonly requestedAfterSeq: number, readonly firstAvailableSeq: number) {
    super(`runtime replay begins at sequence ${firstAvailableSeq}; requested after ${requestedAfterSeq}`);
    this.name = "RuntimeReplayGapError";
  }
}

/** Shared structured-host boundary from the issue 25 spike. */
export interface EngineHost {
  attach(afterSeq: number): AsyncIterable<RuntimeEvent>;
  send(entry: QueueEntry): Promise<DeliveryReceipt>;
  interrupt(turnRef: string): Promise<void>;
  answer(attentionRef: string, value: unknown): Promise<void>;
  health(): Promise<HostState>;
  release(): Promise<void>;
}

export class StructuredHostAdoptionCleanupError<Host extends EngineHost = EngineHost> extends Error {
  constructor(message: string, readonly host: Host, options?: ErrorOptions) {
    super(message, options);
    this.name = "StructuredHostAdoptionCleanupError";
  }
}
