import fs from "node:fs";
import net from "node:net";

import type { ViewerReleaseIdentity } from "@/lib/runtime/contracts";

function readTarget(filename: string): ViewerReleaseIdentity | null {
  try {
    const value = JSON.parse(fs.readFileSync(filename, "utf8")) as Partial<ViewerReleaseIdentity>;
    if (typeof value.endpoint !== "string") return null;
    const endpoint = new URL(value.endpoint);
    if (endpoint.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]", "::1"].includes(endpoint.hostname) || !endpoint.port) return null;
    if (typeof value.image !== "string" || typeof value.container !== "string" || typeof value.revision !== "string") return null;
    return value as ViewerReleaseIdentity;
  } catch {
    return null;
  }
}

/** Each accepted connection reads one atomically replaced release target. */
export function serveViewerDeploymentProxy(targetFile: string, port = 8898, host = "127.0.0.1"): net.Server {
  const server = net.createServer({ pauseOnConnect: true }, (downstream) => {
    /* #1254: this listener is the stable endpoint, so a connection failure
       here must never reach the process. Bun 1.3.3 dropped a failed socket
       write; 1.4.0 reports it by destroying the socket with the EPIPE, and an
       unhandled `error` event is an uncaught exception. The handler is
       attached before the first byte is written — including the 503 answers
       below, which used to write to a raw connection with no handler at all —
       and it stays attached, because a socket can fail more than once. */
    let upstream: net.Socket | null = null;
    downstream.on("error", () => {
      downstream.destroy();
      upstream?.destroy();
    });
    const target = readTarget(targetFile);
    if (!target) {
      downstream.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    const endpoint = new URL(target.endpoint);
    if (Number(endpoint.port) === port) {
      downstream.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    upstream = net.createConnection({ host: endpoint.hostname, port: Number(endpoint.port) });
    upstream.on("error", () => {
      upstream?.destroy();
      downstream.destroy();
    });
    downstream.pipe(upstream);
    upstream.pipe(downstream);
    downstream.resume();
    downstream.once("close", () => upstream?.destroy());
  });
  server.listen(port, host);
  return server;
}
