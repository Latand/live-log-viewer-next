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
  const server = net.createServer((downstream) => {
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
    const upstream = net.createConnection({ host: endpoint.hostname, port: Number(endpoint.port) });
    upstream.once("connect", () => {
      downstream.pipe(upstream);
      upstream.pipe(downstream);
    });
    upstream.once("error", () => downstream.destroy());
    downstream.once("error", () => upstream.destroy());
    downstream.once("close", () => upstream.destroy());
  });
  server.listen(port, host);
  return server;
}
