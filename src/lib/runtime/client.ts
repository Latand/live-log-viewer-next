import net from "node:net";

import type { RuntimeEventInput, RuntimeOperationCommand, RuntimeOperationResult, RuntimePendingEffect, RuntimeReceiptStatus, RuntimeReplay, RuntimeRetryOptions, RuntimeSnapshot, RuntimeSocketRequest, RuntimeSocketResponse, ViewerDeploymentReceipt, ViewerDeploymentRequest, ViewerDeploymentStatus } from "./contracts";
import { runtimeHostSocket } from "./flags";

const MAX_RESPONSE_FRAME_BYTES = 8 * 1024 * 1024;
export const RUNTIME_SNAPSHOT_REQUEST_TIMEOUT_MS = 10_000;
export const VIEWER_DEPLOYMENT_REQUEST_TIMEOUT_MS = 120_000;

export class RuntimeHostUnavailableError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
  }
}

const TRANSPORT_FAILURE_MESSAGES = new Set([
  "runtime host request timed out",
  "runtime host is unavailable",
  "runtime host response exceeds limit",
  "runtime host returned invalid JSON",
  "runtime host response id mismatch",
]);

/** True only for socket-level failures the client itself produced, where the
    request may or may not have reached the journal. Idempotent commands are
    safe to replay against these; deterministic server rejections are not. */
export function isRuntimeHostTransportFailure(error: unknown): boolean {
  return error instanceof RuntimeHostUnavailableError
    && error.code === undefined
    && TRANSPORT_FAILURE_MESSAGES.has(error.message);
}

export interface RuntimeHostClient {
  snapshot(): Promise<RuntimeSnapshot>;
  events(after: number): Promise<RuntimeReplay>;
  waitEvents(after: number, timeoutMs?: number, signal?: AbortSignal): Promise<RuntimeReplay>;
  append(event: RuntimeEventInput): Promise<unknown>;
  operation(event: RuntimeEventInput): Promise<unknown>;
  command(command: RuntimeOperationCommand): Promise<RuntimeOperationResult>;
  operationStatus(operationId: string, options?: { currentRetryLeaf?: boolean }): Promise<RuntimeOperationResult | null>;
  retryOperation(operationId: string, nextIdempotencyKey?: string, options?: RuntimeRetryOptions): Promise<RuntimeOperationResult>;
  producerCursor(producerKind: string, eventKeyPrefix: string): Promise<number>;
  effectBatch(kinds?: readonly string[], afterEventSeq?: number): Promise<RuntimePendingEffect[]>;
  transitionOperation(
    operationId: string,
    status: Exclude<RuntimeReceiptStatus, "pending">,
    details?: { turnId?: string | null; queuePosition?: number | null; reason?: string | null },
  ): Promise<RuntimeOperationResult>;
  requestViewerDeployment(request: ViewerDeploymentRequest): Promise<ViewerDeploymentReceipt>;
  readViewerDeployment(deploymentId: string): Promise<ViewerDeploymentStatus | null>;
}

export class UnixRuntimeHostClient implements RuntimeHostClient {
  constructor(
    private readonly socketPath: string,
    private readonly timeoutMs = 3_000,
    private readonly deploymentTimeoutMs = VIEWER_DEPLOYMENT_REQUEST_TIMEOUT_MS,
    private readonly snapshotTimeoutMs = RUNTIME_SNAPSHOT_REQUEST_TIMEOUT_MS,
  ) {}

  snapshot(): Promise<RuntimeSnapshot> { return this.call("snapshot", undefined, this.snapshotTimeoutMs) as Promise<RuntimeSnapshot>; }
  events(after: number): Promise<RuntimeReplay> { return this.call("events", { after }) as Promise<RuntimeReplay>; }
  waitEvents(after: number, timeoutMs = 15_000, signal?: AbortSignal): Promise<RuntimeReplay> { return this.call("wait", { after, timeoutMs }, timeoutMs + 1_000, signal) as Promise<RuntimeReplay>; }
  append(event: RuntimeEventInput): Promise<unknown> { return this.call("append", { event }); }
  operation(event: RuntimeEventInput): Promise<unknown> { return this.call("operation", { event }); }
  command(command: RuntimeOperationCommand): Promise<RuntimeOperationResult> { return this.call("command", { command }) as Promise<RuntimeOperationResult>; }
  operationStatus(operationId: string, options: { currentRetryLeaf?: boolean } = {}): Promise<RuntimeOperationResult | null> {
    return this.call("operation-status", {
      operationId,
      ...(options.currentRetryLeaf ? { currentRetryLeaf: true } : {}),
    }) as Promise<RuntimeOperationResult | null>;
  }
  retryOperation(operationId: string, nextIdempotencyKey?: string, options: RuntimeRetryOptions = {}): Promise<RuntimeOperationResult> {
    return this.call("operation-retry", {
      operationId,
      ...(nextIdempotencyKey !== undefined ? { nextIdempotencyKey } : {}),
      ...(options.requireHostedConversationId !== undefined
        ? { requireHostedConversationId: options.requireHostedConversationId }
        : {}),
    }) as Promise<RuntimeOperationResult>;
  }
  producerCursor(producerKind: string, eventKeyPrefix: string): Promise<number> { return this.call("producer-cursor", { producerKind, eventKeyPrefix }) as Promise<number>; }
  effectBatch(kinds?: readonly string[], afterEventSeq = 0): Promise<RuntimePendingEffect[]> {
    const params = {
      ...(kinds ? { kinds: [...kinds] } : {}),
      ...(afterEventSeq !== 0 ? { afterEventSeq } : {}),
    };
    return this.call("effect-batch", Object.keys(params).length > 0 ? params : undefined) as Promise<RuntimePendingEffect[]>;
  }
  transitionOperation(
    operationId: string,
    status: Exclude<RuntimeReceiptStatus, "pending">,
    details?: { turnId?: string | null; queuePosition?: number | null; reason?: string | null },
  ): Promise<RuntimeOperationResult> {
    return this.call("operation-transition", { operationId, status, ...(details ? { details } : {}) }) as Promise<RuntimeOperationResult>;
  }
  requestViewerDeployment(request: ViewerDeploymentRequest): Promise<ViewerDeploymentReceipt> { return this.call("viewer-deployment-request", request as unknown as Record<string, unknown>, this.deploymentTimeoutMs) as Promise<ViewerDeploymentReceipt>; }
  readViewerDeployment(deploymentId: string): Promise<ViewerDeploymentStatus | null> { return this.call("viewer-deployment-read", { deploymentId }) as Promise<ViewerDeploymentStatus | null>; }

  private call(method: RuntimeSocketRequest["method"], params?: Record<string, unknown>, timeoutMs = this.timeoutMs, signal?: AbortSignal): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const request: RuntimeSocketRequest = { id: crypto.randomUUID(), method, ...(params ? { params } : {}) };
      const socket = net.createConnection(this.socketPath);
      let frame = "";
      let settled = false;
      const timer = setTimeout(() => finish(new RuntimeHostUnavailableError("runtime host request timed out")), timeoutMs);
      const finish = (error?: Error, result?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        socket.destroy();
        if (error) reject(error);
        else resolve(result);
      };
      const onAbort = () => finish(new RuntimeHostUnavailableError("runtime host request cancelled"));
      if (signal?.aborted) return onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
      socket.once("error", () => finish(new RuntimeHostUnavailableError("runtime host is unavailable")));
      socket.on("data", (chunk: Buffer | string) => {
        frame += String(chunk);
        if (Buffer.byteLength(frame) > MAX_RESPONSE_FRAME_BYTES) return finish(new RuntimeHostUnavailableError("runtime host response exceeds limit"));
        const newline = frame.indexOf("\n");
        if (newline < 0) return;
        try {
          const response = JSON.parse(frame.slice(0, newline)) as RuntimeSocketResponse;
          if (response.id !== request.id) return finish(new RuntimeHostUnavailableError("runtime host response id mismatch"));
          finish(response.ok ? undefined : new RuntimeHostUnavailableError(response.error ?? "runtime host rejected request", response.code), response.result);
        } catch {
          finish(new RuntimeHostUnavailableError("runtime host returned invalid JSON"));
        }
      });
      socket.once("connect", () => socket.write(JSON.stringify(request) + "\n"));
    });
  }
}

export function runtimeHostClient(env: NodeJS.ProcessEnv = process.env): RuntimeHostClient | null {
  const socket = runtimeHostSocket(env);
  return socket ? new UnixRuntimeHostClient(socket) : null;
}
