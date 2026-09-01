import { RuntimeIdempotencyConflictError, type RuntimeEvent, type RuntimeEventInput, type RuntimeOperationCommand, type RuntimeReceiptStatus, type RuntimeSocketRequest, type RuntimeSocketResponse } from "@/lib/runtime/contracts";
import { structuredHostsEnabled } from "@/lib/runtime/flags";
import { consumeRuntimeEvent, type RuntimeConsumerPorts } from "@/lib/runtime/consumers";

import { RuntimeJournal } from "./journal";
import type { ViewerDeploymentCoordinator } from "./deployment";
import type { McpHealthProbeAdmissions } from "./mcpHealthProbeAdmission";
import { PreserializedJson } from "./preserializedJson";
import type { RuntimeHostReadyEvidence } from "./runtimeHostStartup";

export { RuntimeHostFence } from "./runtimeHostFence";

export class RuntimeHost {
  private consumerQueue: Promise<void> = Promise.resolve();
  private readonly consumerFailures = new Map<string, number>();

  constructor(
    readonly journal: RuntimeJournal,
    private readonly consumers?: RuntimeConsumerPorts,
    private readonly deployments?: ViewerDeploymentCoordinator,
    private readonly structuredHosts = structuredHostsEnabled(),
    private readonly signalFlowPipelineProgress?: () => void,
    private readonly mcpHealthProbeAdmissions?: McpHealthProbeAdmissions,
    private readonly runtimeHostHealth?: () => RuntimeHostReadyEvidence,
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
      if (request.method === "runtime-host-health") {
        if (!this.runtimeHostHealth) throw new Error("runtime-host startup evidence is unavailable");
        result = this.runtimeHostHealth();
      } else if (request.method === "snapshot") result = new PreserializedJson(this.journal.snapshotJson());
      else if (request.method === "events") result = this.journal.replay(Number(request.params?.after ?? 0));
      else if (request.method === "wait") result = await this.journal.waitForEvents(
        Number(request.params?.after ?? 0),
        Number(request.params?.timeoutMs ?? 15_000),
        options.signal,
      );
      else if (request.method === "append" || request.method === "operation") {
        const event = request.params?.event as RuntimeEventInput;
        const publishedBefore = this.journal.publishedSeq();
        const appended = this.journal.append(event);
        const newlyPublished = appended.seq > publishedBefore;
        if (newlyPublished && appended.kind === "turn-ended") {
          try { this.signalFlowPipelineProgress?.(); }
          catch { console.error("[flow pipeline controller] committed terminal wake failed"); }
        }
        try { await this.consumeExclusive(appended); }
        catch { console.error("[runtime consumer] committed event will retry asynchronously"); }
        result = request.method === "operation" && event.operationId
          ? { operationId: event.operationId, state: "accepted", seq: appended.seq, revision: appended.revision }
          : appended;
      } else if (request.method === "command") {
        result = this.journal.executeOperation(request.params?.command as RuntimeOperationCommand);
        setImmediate(() => { void this.recoverConsumersBestEffort(); });
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
          && status !== "applying"
          && status !== "delivered"
          && status !== "applied"
          && status !== "interrupted"
          && status !== "answered"
          && status !== "failed"
          /* #862: a compaction whose evidence never arrived is terminal and
             unverified, which is a different fact from a failed control. */
          && status !== "uncertain") {
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
          ref: typeof request.params?.ref === "string" ? request.params.ref : undefined,
          idempotencyKey: String(request.params?.idempotencyKey ?? ""),
        });
      } else if (request.method === "viewer-deployment-read") {
        if (!this.deployments) throw new Error("viewer deployments are disabled");
        result = this.deployments.readViewerDeployment(String(request.params?.deploymentId ?? ""));
      } else if (request.method === "mcp-health-probe-admission") {
        result = this.mcpHealthProbeAdmissions?.consume(request.params?.capability) ?? false;
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
