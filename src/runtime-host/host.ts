import fs from "node:fs";
import path from "node:path";

import { RuntimeIdempotencyConflictError, type RuntimeEvent, type RuntimeEventInput, type RuntimeOperationCommand, type RuntimeReceiptStatus, type RuntimeSocketRequest, type RuntimeSocketResponse } from "@/lib/runtime/contracts";
import { consumeRuntimeEvent, type RuntimeConsumerPorts } from "@/lib/runtime/consumers";
import { procBackend } from "@/lib/proc";

import { RuntimeJournal } from "./journal";
import type { ViewerDeploymentCoordinator } from "./deployment";

export class RuntimeHostFence {
  private held = false;
  constructor(
    private readonly filename: string,
    private readonly ownerAlive: (owner: { pid: number; startIdentity: string | null }) => boolean = (owner) =>
      procBackend.pidAlive(owner.pid) && (owner.startIdentity === null || procBackend.processIdentity(owner.pid) === owner.startIdentity),
  ) {}
  acquire(): void {
    fs.mkdirSync(path.dirname(this.filename), { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        fs.writeFileSync(this.filename, JSON.stringify({ pid: process.pid, startIdentity: procBackend.processIdentity(process.pid) }), { flag: "wx", mode: 0o600 });
        this.held = true;
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        let stale = false;
        try {
          const owner = JSON.parse(fs.readFileSync(this.filename, "utf8")) as { pid: number; startIdentity?: string | null };
          stale = Number.isInteger(owner.pid) && owner.pid > 0 && !this.ownerAlive({ pid: owner.pid, startIdentity: owner.startIdentity ?? null });
        } catch {
          stale = false;
        }
        if (!stale) throw new Error("runtime host singleton fence is held");
        fs.rmSync(this.filename, { force: true });
      }
    }
    throw new Error("runtime host singleton fence is held");
  }
  release(): void { if (this.held) fs.rmSync(this.filename, { force: true }); this.held = false; }
}

export class RuntimeHost {
  private consumerQueue: Promise<void> = Promise.resolve();
  private readonly consumerFailures = new Map<string, number>();

  constructor(
    readonly journal: RuntimeJournal,
    private readonly consumers?: RuntimeConsumerPorts,
    private readonly deployments?: ViewerDeploymentCoordinator,
    private readonly structuredHosts = process.env.LLV_STRUCTURED_HOSTS === "1",
  ) {}

  async recoverConsumers(): Promise<number> {
    if (!this.consumers) return 0;
    return this.runConsumerExclusive(async () => {
      let recovered = 0;
      while (true) {
        const events = this.journal.unconsumedEvents("orchestration");
        if (events.length === 0) return recovered;
        for (const event of events) {
          await this.consume(event);
          recovered += 1;
        }
      }
    });
  }

  private runConsumerExclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.consumerQueue.then(work);
    this.consumerQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  private consumeExclusive(event: RuntimeEvent): Promise<void> {
    if (!this.consumers) return Promise.resolve();
    return this.runConsumerExclusive(() => this.consume(event));
  }

  private async consume(event: RuntimeEvent): Promise<void> {
    if (!this.consumers || this.journal.consumerCompleted(event.eventId, "orchestration")) return;
    const session = event.scope.type === "session" ? this.journal.sessionState(event.scope.id) : null;
    const consumerEvent = session?.flowId && event.kind === "turn-ended" && typeof event.payload.flowId !== "string"
      ? { ...event, payload: { ...event.payload, flowId: session.flowId } }
      : event;
    try {
      for (const projection of await consumeRuntimeEvent(consumerEvent, this.consumers)) {
        await this.consume(this.journal.append(projection));
      }
      this.consumerFailures.delete(event.eventId);
      this.journal.markConsumerCompleted(event.eventId, "orchestration");
    } catch (error) {
      const failures = (this.consumerFailures.get(event.eventId) ?? 0) + 1;
      this.consumerFailures.set(event.eventId, failures);
      if (failures >= 3) {
        console.error(`[runtime consumer] quarantined event ${event.eventId} after ${failures} failures`);
        this.journal.markConsumerCompleted(event.eventId, "orchestration");
        this.consumerFailures.delete(event.eventId);
      }
      throw error;
    }
  }

  private async recoverConsumersBestEffort(): Promise<void> {
    try { await this.recoverConsumers(); }
    catch { console.error("[runtime consumer] recovery deferred after a consumer failure"); }
  }

  async handle(request: RuntimeSocketRequest, options: { signal?: AbortSignal } = {}): Promise<RuntimeSocketResponse> {
    try {
      let result: unknown;
      if (request.method === "snapshot") result = this.journal.snapshot();
      else if (request.method === "events") result = this.journal.replay(Number(request.params?.after ?? 0));
      else if (request.method === "wait") result = await this.journal.waitForEvents(
        Number(request.params?.after ?? 0),
        Number(request.params?.timeoutMs ?? 15_000),
        options.signal,
      );
      else if (request.method === "append" || request.method === "operation") {
        const event = request.params?.event as RuntimeEventInput;
        const appended = this.journal.append(event);
        try { await this.consumeExclusive(appended); }
        catch { console.error("[runtime consumer] committed event will retry asynchronously"); }
        result = request.method === "operation" && event.operationId
          ? { operationId: event.operationId, state: "accepted", seq: appended.seq, revision: appended.revision }
          : appended;
      } else if (request.method === "command") {
        result = this.journal.executeOperation(request.params?.command as RuntimeOperationCommand);
        await this.recoverConsumersBestEffort();
      } else if (request.method === "operation-status") {
        const currentRetryLeaf = request.params?.currentRetryLeaf;
        if (currentRetryLeaf !== undefined && typeof currentRetryLeaf !== "boolean") {
          throw new Error("operation retry leaf option is invalid");
        }
        result = currentRetryLeaf
          ? this.journal.currentRetryResult(String(request.params?.operationId ?? ""))
          : this.journal.operationResult(String(request.params?.operationId ?? ""));
      } else if (request.method === "operation-retry") {
        if (!this.structuredHosts) throw new Error("structured hosts are disabled");
        const nextIdempotencyKey = request.params?.nextIdempotencyKey;
        if (nextIdempotencyKey !== undefined && typeof nextIdempotencyKey !== "string") {
          throw new Error("retry idempotency key is invalid");
        }
        const requireHostedConversationId = request.params?.requireHostedConversationId;
        if (requireHostedConversationId !== undefined
          && (typeof requireHostedConversationId !== "string" || !requireHostedConversationId.trim())) {
          throw new Error("retry hosted conversation is invalid");
        }
        result = this.journal.retryOperation(
          String(request.params?.operationId ?? ""),
          nextIdempotencyKey,
          typeof requireHostedConversationId === "string" ? { requireHostedConversationId } : {},
        );
      } else if (request.method === "effect-batch") {
        if (!this.structuredHosts) throw new Error("structured hosts are disabled");
        const kinds = request.params?.kinds;
        if (kinds !== undefined && (!Array.isArray(kinds) || kinds.some((kind) => typeof kind !== "string"))) {
          throw new Error("runtime effect kinds are invalid");
        }
        const afterEventSeq = request.params?.afterEventSeq ?? 0;
        if (typeof afterEventSeq !== "number" || !Number.isSafeInteger(afterEventSeq) || afterEventSeq < 0) {
          throw new Error("runtime effect cursor is invalid");
        }
        result = this.journal.effectBatch(100, kinds as string[] | undefined, afterEventSeq);
      } else if (request.method === "producer-cursor") {
        const producerKind = request.params?.producerKind;
        const eventKeyPrefix = request.params?.eventKeyPrefix;
        if (typeof producerKind !== "string" || !producerKind || producerKind.length > 128
          || typeof eventKeyPrefix !== "string" || !eventKeyPrefix || eventKeyPrefix.length > 512) {
          throw new Error("runtime producer cursor is invalid");
        }
        result = this.journal.producerCursor(producerKind, eventKeyPrefix);
      } else if (request.method === "operation-transition") {
        if (!this.structuredHosts) throw new Error("structured hosts are disabled");
        const status = request.params?.status;
        if (status !== "queued"
          && status !== "delivering"
          && status !== "delivered"
          && status !== "interrupted"
          && status !== "answered"
          && status !== "failed") {
          throw new Error("runtime operation transition status is invalid");
        }
        const details = request.params?.details;
        result = this.journal.transitionOperation(
          String(request.params?.operationId ?? ""),
          status as Exclude<RuntimeReceiptStatus, "pending">,
          details && typeof details === "object" ? details as { turnId?: string | null; queuePosition?: number | null; reason?: string | null } : {},
        );
      } else if (request.method === "viewer-deployment-request") {
        if (!this.deployments) throw new Error("viewer deployments are disabled");
        result = await this.deployments.requestViewerDeployment({
          revision: typeof request.params?.revision === "string" ? request.params.revision : undefined,
          idempotencyKey: String(request.params?.idempotencyKey ?? ""),
        });
      } else if (request.method === "viewer-deployment-read") {
        if (!this.deployments) throw new Error("viewer deployments are disabled");
        result = this.deployments.readViewerDeployment(String(request.params?.deploymentId ?? ""));
      } else throw new Error("runtime request method is unsupported");
      return { id: request.id, ok: true, result };
    } catch (error) {
      return {
        id: request.id,
        ok: false,
        error: error instanceof Error ? error.message : "runtime request failed",
        ...(error instanceof RuntimeIdempotencyConflictError ? { code: error.code } : {}),
      };
    }
  }
}
