import net from "node:net";

import type { RuntimeEventInput, RuntimeOperationCommand, RuntimeOperationResult, RuntimePendingEffect, RuntimeReceiptStatus, RuntimeReplay, RuntimeRetryOptions, RuntimeSnapshot, RuntimeSocketRequest, RuntimeSocketResponse, ViewerDeploymentReceipt, ViewerDeploymentRequest, ViewerDeploymentStatus } from "./contracts";
import { runtimeHostSocket } from "./flags";

// The snapshot frame carries every hosted session, and a hosted session keeps
// its liveTurn text until its host dies — idle hosts never retire (#747), so
// the frame grows with every finished turn. On 2026-08-24 it crossed 16 MiB
// (551 sessions, 357 with liveTurn) and every viewer→runtime call failed as
// "unavailable": no spawn, kill, or archive could run and the deploy probe
// failed (#1145). The bound stays a last-resort guard against a runaway host;
// the durable fix is a bounded snapshot on the journal side.
const MAX_RESPONSE_FRAME_BYTES = 64 * 1024 * 1024;
export const RUNTIME_SNAPSHOT_REQUEST_TIMEOUT_MS = 10_000;
export const VIEWER_DEPLOYMENT_REQUEST_TIMEOUT_MS = 120_000;
const RUNTIME_HOST_REQUEST_SAMPLE_LIMIT = 256;

export interface RuntimeHostRequestHealth {
  samples: number;
  p95Ms: number;
  maxMs: number;
  timeouts: number;
  windowSize: number;
}

type RuntimeHostRequestSample = { elapsedMs: number; timeout: boolean };
const runtimeHostRequestSamples: RuntimeHostRequestSample[] = [];

function recordRuntimeHostRequest(
  method: RuntimeSocketRequest["method"],
  elapsedMs: number,
  timeout: boolean,
): void {
  /* `wait` deliberately holds a long poll for up to 30 seconds. Including its
     normal residence time would make this pressure signal permanently slow. */
  if (method === "wait") return;
  runtimeHostRequestSamples.push({ elapsedMs: Math.max(0, Math.round(elapsedMs)), timeout });
  if (runtimeHostRequestSamples.length > RUNTIME_HOST_REQUEST_SAMPLE_LIMIT) {
    runtimeHostRequestSamples.splice(0, runtimeHostRequestSamples.length - RUNTIME_HOST_REQUEST_SAMPLE_LIMIT);
  }
}

/** Numeric-only, process-local latency evidence for the most recent Viewer to
    runtime-host socket calls. Request parameters and response data never enter
    this window. */
export function runtimeHostRequestHealth(): RuntimeHostRequestHealth {
  const elapsed = runtimeHostRequestSamples.map((sample) => sample.elapsedMs).toSorted((left, right) => left - right);
  return {
    samples: elapsed.length,
    p95Ms: elapsed.length ? elapsed[Math.max(0, Math.ceil(elapsed.length * 0.95) - 1)]! : 0,
    maxMs: elapsed.at(-1) ?? 0,
    timeouts: runtimeHostRequestSamples.filter((sample) => sample.timeout).length,
    windowSize: RUNTIME_HOST_REQUEST_SAMPLE_LIMIT,
  };
}

/** Tests only: isolates route and percentile assertions from earlier calls in
    the same Bun process. */
export function resetRuntimeHostRequestHealthForTests(): void {
  runtimeHostRequestSamples.length = 0;
}

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
  snapshot(signal?: AbortSignal): Promise<RuntimeSnapshot>;
  events(after: number, signal?: AbortSignal): Promise<RuntimeReplay>;
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
  admitMcpHealthProbe?(capability: string): Promise<boolean>;
}

export class UnixRuntimeHostClient implements RuntimeHostClient {
  constructor(
    private readonly socketPath: string,
    private readonly timeoutMs = 3_000,
    private readonly deploymentTimeoutMs = VIEWER_DEPLOYMENT_REQUEST_TIMEOUT_MS,
    private readonly snapshotTimeoutMs = RUNTIME_SNAPSHOT_REQUEST_TIMEOUT_MS,
  ) {}

  snapshot(signal?: AbortSignal): Promise<RuntimeSnapshot> { return this.call("snapshot", undefined, this.snapshotTimeoutMs, signal) as Promise<RuntimeSnapshot>; }
  events(after: number, signal?: AbortSignal): Promise<RuntimeReplay> { return this.call("events", { after }, this.timeoutMs, signal) as Promise<RuntimeReplay>; }
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
  admitMcpHealthProbe(capability: string): Promise<boolean> { return this.call("mcp-health-probe-admission", { capability }) as Promise<boolean>; }

  private call(method: RuntimeSocketRequest["method"], params?: Record<string, unknown>, timeoutMs = this.timeoutMs, signal?: AbortSignal): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const request: RuntimeSocketRequest = { id: crypto.randomUUID(), method, ...(params ? { params } : {}) };
      const socket = net.createConnection(this.socketPath);
      const startedAt = performance.now();
      let frame = "";
      let settled = false;
      const timer = setTimeout(() => {
        const elapsedMs = performance.now() - startedAt;
        console.error(`[runtime host] request timed out method=${method} elapsedMs=${Math.max(0, Math.round(elapsedMs))}`);
        finish(new RuntimeHostUnavailableError("runtime host request timed out"), undefined, true, elapsedMs);
      }, timeoutMs);
      const finish = (error?: Error, result?: unknown, timeout = false, elapsedMs = performance.now() - startedAt) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        socket.destroy();
        recordRuntimeHostRequest(method, elapsedMs, timeout);
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
