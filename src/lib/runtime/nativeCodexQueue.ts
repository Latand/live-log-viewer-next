import { z } from "zod";

// Handwritten boundary schemas from Codex 0.154.0's generated v2 queue schemas.
// Keep optional fields optional and preserve extra fields and attachment bytes.
const id = z.string().min(1);
const detail = z.enum(["auto", "low", "high", "original"]).nullable().optional();
const inputSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string(), text_elements: z.array(z.object({
    byteRange: z.object({ start: z.number().int().nonnegative(), end: z.number().int().nonnegative() }).passthrough(),
    placeholder: z.string().nullable().optional(),
  }).passthrough()).optional() }).passthrough(),
  z.object({ type: z.literal("image"), url: z.string(), detail }).passthrough(),
  z.object({ type: z.literal("localImage"), path: z.string(), detail }).passthrough(),
  z.object({ type: z.literal("audio"), url: z.string() }).passthrough(),
  z.object({ type: z.literal("localAudio"), path: z.string() }).passthrough(),
  z.object({ type: z.literal("skill"), name: z.string(), path: z.string() }).passthrough(),
  z.object({ type: z.literal("mention"), name: z.string(), path: z.string() }).passthrough(),
]);
const submissionSchema = z.object({ id, clientUserMessageId: id, input: z.array(inputSchema) }).passthrough();
const listSchema = z.object({
  data: z.array(submissionSchema),
  // Native emits explicit null on the last page. Missing completion evidence
  // must not clear a previously populated cache, even though the schema permits omission.
  nextCursor: id.nullable(),
}).passthrough();
const submissionResponse = z.object({ queuedSubmission: submissionSchema }).passthrough();
const startResponse = z.object({ turn: z.object({
  id, status: z.enum(["completed", "interrupted", "failed", "inProgress"]), items: z.array(z.unknown()),
}).passthrough() }).passthrough();

export type NativeQueueInput = z.infer<typeof inputSchema>;
export type NativeQueuedSubmission = z.infer<typeof submissionSchema>;
export type NativeQueueAcknowledgement<T> = { outcome: "acknowledged"; result: T };
export type NativeQueueSnapshot = {
  threadId: string;
  /** null means no complete read has succeeded; [] is a complete empty observation. */
  items: NativeQueuedSubmission[] | null;
  stale: boolean;
};

export interface NativeQueueRpcPort {
  /**
   * Existing host-style RPC: correlate replies to request IDs on one connection,
   * unwrap result, and reject errors. Never retry a mutation. Honor timeoutMs
   * and discard late responses. Map genuine JSON-RPC error envelopes to
   * NativeQueueProtocolRefusal; unclassified exceptions remain uncertain.
   */
  rpc(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown>;
}

/** Construct only for an authoritative error envelope correlated by the port. */
export class NativeQueueProtocolRefusal extends Error {
  readonly outcome = "refused";
  constructor(readonly code: number, message: string) {
    super(message);
    this.name = "NativeQueueProtocolRefusal";
  }
}

/** Local disposal prevented this mutation from ever reaching the RPC port. */
export class NativeQueueNotSubmittedError extends Error {
  readonly outcome = "not-submitted";
  constructor(readonly method: string, readonly threadId: string) {
    super("Native queue mutation was not submitted: adapter is disposed");
    this.name = "NativeQueueNotSubmittedError";
  }
}

/** The caller retains its durable operation and payload; this grants no retry. */
export class NativeQueueUncertainError extends Error {
  readonly outcome = "uncertain";
  constructor(readonly method: string, readonly threadId: string, readonly cause: unknown) {
    super("Native queue mutation outcome is uncertain");
    this.name = "NativeQueueUncertainError";
  }
}

type Limits = { pageSize: number; maxPages: number; maxItems: number; maxBytes: number; maxRefreshPasses: number; timeoutMs: number };

/**
 * One thread on one RPC connection. Replace the adapter on host/account change.
 * No scheduler, persistence, automatic mutation retry, or delivery settlement.
 */
export class NativeCodexQueue {
  private readonly limits: Limits;
  private items: NativeQueuedSubmission[] | null = null;
  private stale = true;
  private revision = 0;
  private disposed = false;
  private mutations = 0;
  private refreshPromise: Promise<NativeQueueSnapshot> | null = null;
  // Keep an unresolved wire read fenced even if our own deadline expired.
  private wireRead: Promise<unknown> | null = null;

  constructor(private readonly port: NativeQueueRpcPort, readonly threadId: string, limits: Partial<Limits> = {}) {
    id.parse(threadId);
    this.limits = { pageSize: 100, maxPages: 20, maxItems: 2000, maxBytes: 64 * 1024 * 1024, maxRefreshPasses: 2, timeoutMs: 10_000, ...limits };
    for (const value of Object.values(this.limits)) {
      if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) throw new Error("Invalid native queue bound");
    }
  }

  read(): NativeQueueSnapshot {
    return { threadId: this.threadId, items: structuredClone(this.items), stale: this.stale };
  }

  invalidate(): void {
    this.revision++;
    this.stale = true;
  }

  /** The integrating host forwards notifications; this does no unsolicited I/O. */
  handleNotification(method: string, params: unknown): boolean {
    if (this.disposed || method !== "thread/queue/changed" || !params || typeof params !== "object"
      || !("threadId" in params) || params.threadId !== this.threadId) return false;
    this.invalidate();
    return true;
  }

  refresh(): Promise<NativeQueueSnapshot> {
    if (this.disposed) return Promise.reject(new Error("Native queue adapter is disposed"));
    if (this.refreshPromise) return this.refreshPromise;
    this.stale = true;
    // Defer work so even a synchronous notification from the port sees the latch.
    this.refreshPromise = Promise.resolve().then(() => this.readAllPages()).finally(() => { this.refreshPromise = null; });
    return this.refreshPromise;
  }

  private async readAllPages(): Promise<NativeQueueSnapshot> {
    const deadline = Date.now() + this.limits.timeoutMs;
    for (let pass = 0; pass < this.limits.maxRefreshPasses; pass++) {
      this.assertOpen();
      if (this.mutations) throw new Error("Native queue mutation is still pending");
      const revision = this.revision;
      const data: NativeQueuedSubmission[] = [];
      let bytes = 0;
      const seenIds = new Set<string>();
      const seenCursors = new Set<string>();
      const previous = new Map(this.items?.map((item) => [item.id, item.clientUserMessageId]));
      let cursor: string | null = null;
      for (let page = 0; page < this.limits.maxPages; page++) {
        if (this.wireRead) throw new Error("Previous native queue read has not settled");
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error("Native queue refresh deadline exceeded");
        const wire = Promise.resolve().then(() => {
          this.assertOpen();
          return this.port.rpc("thread/queue/list", { threadId: this.threadId, cursor, limit: this.limits.pageSize }, remaining);
        });
        this.wireRead = wire;
        const clear = () => { if (this.wireRead === wire) this.wireRead = null; };
        void wire.then(clear, clear);
        const response = listSchema.parse(await this.withDeadline(wire, remaining));
        bytes += Buffer.byteLength(JSON.stringify(response));
        if (bytes > this.limits.maxBytes) throw new Error("Native queue byte bound exceeded");
        this.assertOpen();
        this.checkThread(response);
        if (data.length + response.data.length > this.limits.maxItems) throw new Error("Native queue item bound exceeded");
        for (const item of response.data) {
          this.checkThread(item);
          if (seenIds.has(item.id)) throw new Error("Duplicate native submission identity");
          if (previous.has(item.id) && previous.get(item.id) !== item.clientUserMessageId) throw new Error("Native submission identity changed");
          seenIds.add(item.id);
          data.push(item);
        }
        cursor = response.nextCursor;
        if (cursor === null) {
          if (Date.now() >= deadline) throw new Error("Native queue refresh deadline exceeded");
          if (this.mutations) throw new Error("Native queue mutation is still pending");
          if (revision !== this.revision) break;
          this.items = structuredClone(data);
          this.stale = false;
          return this.read();
        }
        if (seenCursors.has(cursor)) throw new Error("Native queue cursor repeated");
        seenCursors.add(cursor);
        if (page + 1 === this.limits.maxPages) throw new Error("Native queue page bound exceeded");
      }
    }
    throw new Error("Native queue changed during every bounded refresh pass");
  }

  async add(clientUserMessageId: string, input: NativeQueueInput[]) {
    id.parse(clientUserMessageId);
    return this.mutate("add", { clientUserMessageId, input: z.array(inputSchema).parse(input) }, (value) => {
      const result = submissionResponse.parse(value);
      this.checkThread(result.queuedSubmission);
      if (result.queuedSubmission.clientUserMessageId !== clientUserMessageId) throw new Error("Native client message identity mismatch");
      return result;
    });
  }

  /** Pass the prior server AND client identity. Updating preserves the client ID. */
  async update(identity: Pick<NativeQueuedSubmission, "id" | "clientUserMessageId">, input: NativeQueueInput[]) {
    const queuedSubmissionId = id.parse(identity.id);
    const clientUserMessageId = id.parse(identity.clientUserMessageId);
    return this.mutate("update", { queuedSubmissionId, input: z.array(inputSchema).parse(input) }, (value) => {
      const result = submissionResponse.parse(value);
      this.checkThread(result.queuedSubmission);
      if (result.queuedSubmission.id !== queuedSubmissionId || result.queuedSubmission.clientUserMessageId !== clientUserMessageId) {
        throw new Error("Native submission identity mismatch");
      }
      return result;
    });
  }

  async delete(queuedSubmissionId: string) {
    return this.mutate("delete", { queuedSubmissionId: id.parse(queuedSubmissionId) },
      (value) => z.object({ deleted: z.boolean() }).passthrough().parse(value));
  }

  async reorder(queuedSubmissionIds: string[]) {
    const ids = z.array(id).parse(queuedSubmissionIds);
    if (new Set(ids).size !== ids.length) throw new Error("Duplicate native submission identity");
    return this.mutate("reorder", { queuedSubmissionIds: ids }, (value) => z.object({}).strict().parse(value));
  }

  async start(queuedSubmissionId?: string | null) {
    return this.mutate("start", queuedSubmissionId === undefined ? {} : { queuedSubmissionId: id.nullable().parse(queuedSubmissionId) },
      (value) => {
        const result = startResponse.parse(value);
        this.checkThread(result.turn);
        return result;
      });
  }

  private async mutate<T>(action: string, params: Record<string, unknown>, parse: (value: unknown) => T): Promise<NativeQueueAcknowledgement<T>> {
    const method = `thread/queue/${action}`;
    if (this.disposed) throw new NativeQueueNotSubmittedError(method, this.threadId);
    let transportInvoked = false;
    this.mutations++;
    this.invalidate();
    const wire = Promise.resolve().then(() => {
      if (this.disposed) throw new NativeQueueNotSubmittedError(method, this.threadId);
      transportInvoked = true;
      return this.port.rpc(method, { ...params, threadId: this.threadId }, this.limits.timeoutMs);
    });
    // A caller deadline does not end the wire operation. Fence reads until the
    // port settles it, and invalidate again even when its acknowledgement is late.
    const settled = () => { this.mutations--; this.invalidate(); };
    void wire.then(settled, settled);
    try {
      const value = await this.withDeadline(wire, this.limits.timeoutMs);
      this.checkThread(value);
      return { outcome: "acknowledged", result: parse(value) };
    } catch (cause) {
      if (!transportInvoked && cause instanceof NativeQueueNotSubmittedError) throw cause;
      if (cause instanceof NativeQueueProtocolRefusal) throw cause;
      throw new NativeQueueUncertainError(method, this.threadId, cause);
    }
  }

  private checkThread(value: unknown): void {
    // Queue replies have no thread field in v2. Correlation belongs to the port;
    // reject a contradictory field if a transport/protocol extension supplies one.
    if (value && typeof value === "object" && "threadId" in value && value.threadId !== this.threadId) {
      throw new Error("Native queue thread identity mismatch");
    }
  }

  private withDeadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Native queue RPC deadline exceeded")), timeoutMs);
      promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
    });
  }

  private assertOpen(): void {
    if (this.disposed) throw new Error("Native queue adapter is disposed");
  }

  dispose(): void {
    this.disposed = true;
    this.invalidate();
  }
}
