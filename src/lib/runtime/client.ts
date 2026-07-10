import net from "node:net";

import type { RuntimeEventInput, RuntimeReplay, RuntimeSnapshot, RuntimeSocketRequest, RuntimeSocketResponse } from "./contracts";
import { runtimeHostSocket } from "./flags";

const MAX_FRAME_BYTES = 512 * 1024;

export class RuntimeHostUnavailableError extends Error {}

export interface RuntimeHostClient {
  snapshot(): Promise<RuntimeSnapshot>;
  events(after: number): Promise<RuntimeReplay>;
  append(event: RuntimeEventInput): Promise<unknown>;
  operation(event: RuntimeEventInput): Promise<unknown>;
}

export class UnixRuntimeHostClient implements RuntimeHostClient {
  constructor(private readonly socketPath: string, private readonly timeoutMs = 3_000) {}

  snapshot(): Promise<RuntimeSnapshot> { return this.call("snapshot") as Promise<RuntimeSnapshot>; }
  events(after: number): Promise<RuntimeReplay> { return this.call("events", { after }) as Promise<RuntimeReplay>; }
  append(event: RuntimeEventInput): Promise<unknown> { return this.call("append", { event }); }
  operation(event: RuntimeEventInput): Promise<unknown> { return this.call("operation", { event }); }

  private call(method: RuntimeSocketRequest["method"], params?: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const request: RuntimeSocketRequest = { id: crypto.randomUUID(), method, ...(params ? { params } : {}) };
      const socket = net.createConnection(this.socketPath);
      let frame = "";
      const timer = setTimeout(() => finish(new RuntimeHostUnavailableError("runtime host request timed out")), this.timeoutMs);
      const finish = (error?: Error, result?: unknown) => {
        clearTimeout(timer);
        socket.destroy();
        if (error) reject(error);
        else resolve(result);
      };
      socket.once("error", () => finish(new RuntimeHostUnavailableError("runtime host is unavailable")));
      socket.on("data", (chunk: Buffer | string) => {
        frame += String(chunk);
        if (Buffer.byteLength(frame) > MAX_FRAME_BYTES) return finish(new RuntimeHostUnavailableError("runtime host response exceeds limit"));
        const newline = frame.indexOf("\n");
        if (newline < 0) return;
        try {
          const response = JSON.parse(frame.slice(0, newline)) as RuntimeSocketResponse;
          if (response.id !== request.id) return finish(new RuntimeHostUnavailableError("runtime host response id mismatch"));
          finish(response.ok ? undefined : new RuntimeHostUnavailableError(response.error ?? "runtime host rejected request"), response.result);
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
