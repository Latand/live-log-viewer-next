import net from "node:net";

import type { RuntimeEventInput, RuntimeOperationCommand, RuntimeOperationResult, RuntimeReplay, RuntimeSnapshot, RuntimeSocketRequest, RuntimeSocketResponse } from "./contracts";
import { runtimeHostSocket } from "./flags";

const MAX_RESPONSE_FRAME_BYTES = 8 * 1024 * 1024;

export class RuntimeHostUnavailableError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
  }
}

export interface RuntimeHostClient {
  snapshot(): Promise<RuntimeSnapshot>;
  events(after: number): Promise<RuntimeReplay>;
  waitEvents(after: number, timeoutMs?: number, signal?: AbortSignal): Promise<RuntimeReplay>;
  append(event: RuntimeEventInput): Promise<unknown>;
  operation(event: RuntimeEventInput): Promise<unknown>;
  command(command: RuntimeOperationCommand): Promise<RuntimeOperationResult>;
  operationStatus(operationId: string): Promise<RuntimeOperationResult | null>;
}

export class UnixRuntimeHostClient implements RuntimeHostClient {
  constructor(private readonly socketPath: string, private readonly timeoutMs = 3_000) {}

  snapshot(): Promise<RuntimeSnapshot> { return this.call("snapshot") as Promise<RuntimeSnapshot>; }
  events(after: number): Promise<RuntimeReplay> { return this.call("events", { after }) as Promise<RuntimeReplay>; }
  waitEvents(after: number, timeoutMs = 15_000, signal?: AbortSignal): Promise<RuntimeReplay> { return this.call("wait", { after, timeoutMs }, timeoutMs + 1_000, signal) as Promise<RuntimeReplay>; }
  append(event: RuntimeEventInput): Promise<unknown> { return this.call("append", { event }); }
  operation(event: RuntimeEventInput): Promise<unknown> { return this.call("operation", { event }); }
  command(command: RuntimeOperationCommand): Promise<RuntimeOperationResult> { return this.call("command", { command }) as Promise<RuntimeOperationResult>; }
  operationStatus(operationId: string): Promise<RuntimeOperationResult | null> { return this.call("operation-status", { operationId }) as Promise<RuntimeOperationResult | null>; }

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
