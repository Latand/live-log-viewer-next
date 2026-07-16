import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import type { RuntimeSocketRequest } from "@/lib/runtime/contracts";

import { RuntimeHost } from "./host";

const MAX_FRAME_BYTES = 512 * 1024;
const DEFAULT_SOCKET_TIMEOUT_MS = 31_000;
const DEPLOYMENT_SOCKET_TIMEOUT_MS = 125_000;

export interface RuntimeHostSocketOptions {
  defaultTimeoutMs?: number;
  deploymentTimeoutMs?: number;
}

/** Newline-framed local protocol. It intentionally binds a Unix path only. */
export function serveRuntimeHost(socketPath: string, host: RuntimeHost, options: RuntimeHostSocketOptions = {}): net.Server {
  const defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_SOCKET_TIMEOUT_MS;
  const deploymentTimeoutMs = options.deploymentTimeoutMs ?? DEPLOYMENT_SOCKET_TIMEOUT_MS;
  fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  try { fs.unlinkSync(socketPath); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const server = net.createServer((socket) => {
    socket.setTimeout(defaultTimeoutMs, () => socket.destroy());
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += String(chunk);
      if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES) return socket.destroy();
      // The client opens one connection per request, so one frame owns the
      // socket and any bytes after its delimiter are intentionally ignored.
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const frame = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      try {
        const request = JSON.parse(frame) as RuntimeSocketRequest;
        if (!request.id || !request.method) throw new Error("runtime request is malformed");
        if (request.method === "viewer-deployment-request") socket.setTimeout(deploymentTimeoutMs);
        void host.handle(request).then((response) => socket.end(JSON.stringify(response) + "\n"));
      } catch {
        socket.end(JSON.stringify({ id: "unknown", ok: false, error: "runtime request is malformed" }) + "\n");
      }
    });
  });
  // Every browser tab holds one long-poll wait socket. A hard server-wide cap
  // lets those passive waits consume all admission slots, starving snapshot,
  // send, kill, and deployment commands. Frame and idle deadlines keep each
  // local 0600 socket bounded while the OS backlog admits command traffic.
  server.once("listening", () => fs.chmodSync(socketPath, 0o600));
  server.listen(socketPath);
  return server;
}
