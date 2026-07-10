import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import type { RuntimeSocketRequest } from "@/lib/runtime/contracts";

import { RuntimeHost } from "./host";

const MAX_FRAME_BYTES = 512 * 1024;

/** Newline-framed local protocol. It intentionally binds a Unix path only. */
export function serveRuntimeHost(socketPath: string, host: RuntimeHost): net.Server {
  fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  try { fs.unlinkSync(socketPath); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const server = net.createServer((socket) => {
    socket.setTimeout(30_000, () => socket.destroy());
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += String(chunk);
      if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES) return socket.destroy();
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const frame = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      try {
        const request = JSON.parse(frame) as RuntimeSocketRequest;
        if (!request.id || !request.method) throw new Error("runtime request is malformed");
        void host.handle(request).then((response) => socket.end(JSON.stringify(response) + "\n"));
      } catch {
        socket.end(JSON.stringify({ id: "unknown", ok: false, error: "runtime request is malformed" }) + "\n");
      }
    });
  });
  server.maxConnections = 64;
  server.once("listening", () => fs.chmodSync(socketPath, 0o600));
  server.listen(socketPath);
  return server;
}
