import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import type { RuntimeSocketRequest, RuntimeSocketResponse } from "@/lib/runtime/contracts";

import { RuntimeHost } from "./host";

const MAX_FRAME_BYTES = 512 * 1024;
const DEFAULT_SOCKET_TIMEOUT_MS = 31_000;
const DEPLOYMENT_SOCKET_TIMEOUT_MS = 125_000;
const DEFAULT_MAX_CONNECTIONS = 256;
const DEFAULT_MAX_WAIT_CONNECTIONS = 192;

export interface RuntimeHostSocketOptions {
  defaultTimeoutMs?: number;
  deploymentTimeoutMs?: number;
  maxConnections?: number;
  maxWaitConnections?: number;
}

/** Newline-framed local protocol. It intentionally binds a Unix path only. */
export function serveRuntimeHost(socketPath: string, host: RuntimeHost, options: RuntimeHostSocketOptions = {}): net.Server {
  const defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_SOCKET_TIMEOUT_MS;
  const deploymentTimeoutMs = options.deploymentTimeoutMs ?? DEPLOYMENT_SOCKET_TIMEOUT_MS;
  const maxConnections = options.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
  const maxWaitConnections = options.maxWaitConnections ?? DEFAULT_MAX_WAIT_CONNECTIONS;
  if (!Number.isSafeInteger(maxConnections) || maxConnections < 2) {
    throw new Error("runtime socket maxConnections must be an integer of at least 2");
  }
  if (!Number.isSafeInteger(maxWaitConnections) || maxWaitConnections < 1 || maxWaitConnections >= maxConnections) {
    throw new Error("runtime socket maxWaitConnections must reserve at least one command connection");
  }
  fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  try { fs.unlinkSync(socketPath); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  let activeWaitConnections = 0;
  const server = net.createServer((socket) => {
    const abort = new AbortController();
    socket.once("close", () => abort.abort());
    socket.setTimeout(defaultTimeoutMs, () => socket.destroy());
    let buffer = "";
    let handled = false;
    let settled = false;
    /* One-shot terminal settlement: the connection owns exactly one response
       frame, and a host completing after the caller disconnected (client
       timeout destroyed its socket, or the server idle timeout fired) must be
       discarded silently instead of writing to the finished stream — the
       production ERR_STREAM_ALREADY_FINISHED path. */
    const settle = (response: RuntimeSocketResponse) => {
      if (settled) return;
      settled = true;
      if (socket.destroyed || socket.writableEnded || !socket.writable) return;
      socket.end(JSON.stringify(response) + "\n");
    };
    socket.on("data", (chunk) => {
      if (handled) return;
      buffer += String(chunk);
      if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES) return socket.destroy();
      // The client opens one connection per request, so one frame owns the
      // socket and any bytes after its delimiter are intentionally ignored.
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      handled = true;
      const frame = buffer.slice(0, newline);
      try {
        const request = JSON.parse(frame) as RuntimeSocketRequest;
        if (!request.id || !request.method) throw new Error("runtime request is malformed");
        if (request.method === "viewer-deployment-request") socket.setTimeout(deploymentTimeoutMs);
        const failure = (): RuntimeSocketResponse => ({ id: request.id, ok: false, error: "runtime request failed" });
        if (request.method === "wait") {
          if (activeWaitConnections >= maxWaitConnections) {
            settle({ id: request.id, ok: false, error: "runtime wait capacity exceeded" });
            return;
          }
          activeWaitConnections += 1;
          void host.handle(request, { signal: abort.signal })
            .then(settle, () => settle(failure()))
            .finally(() => { activeWaitConnections -= 1; });
          return;
        }
        /* Every request carries the connection signal, so a disconnected
           caller stops read-only work early; mutating journal operations
           ignore the signal and still complete idempotently. */
        void host.handle(request, { signal: abort.signal }).then(settle, () => settle(failure()));
      } catch {
        settle({ id: "unknown", ok: false, error: "runtime request is malformed" });
      }
    });
  });
  // Browser long polls receive their own ceiling below the server-wide cap.
  // The remaining slots keep snapshot, control, and deployment traffic
  // admissible while total file descriptors and journal waiters stay bounded.
  server.maxConnections = maxConnections;
  server.once("listening", () => fs.chmodSync(socketPath, 0o600));
  server.listen(socketPath);
  return server;
}
