import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { serveViewerDeploymentProxy } from "./deploymentProxy";

async function listen(server: net.Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind a TCP port");
  return address.port;
}

async function close(server: net.Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function request(port: number): Promise<string> {
  const { stdout } = await promisify(execFile)("curl", [
    "--http1.1",
    "--include",
    "--max-time", "3",
    "--silent",
    "--show-error",
    `http://127.0.0.1:${port}/`,
  ]);
  return stdout;
}

test("deployment proxy forwards an immediate request through a real TCP connection", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "llv-deployment-proxy-"));
  const targetFile = path.join(directory, "viewer-release.json");
  const upstream = net.createServer((socket) => {
    let request = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      request += chunk;
      if (!request.includes("\r\n\r\n")) return;
      socket.end("HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: 7\r\n\r\nproxied");
    });
  });
  const upstreamPort = await listen(upstream);
  await fs.writeFile(targetFile, JSON.stringify({
    revision: "abc123",
    image: "viewer:test",
    container: "viewer-test",
    endpoint: `http://127.0.0.1:${upstreamPort}`,
  }));

  const proxy = serveViewerDeploymentProxy(targetFile, 0);
  await once(proxy, "listening");
  const proxyAddress = proxy.address();
  if (!proxyAddress || typeof proxyAddress === "string") throw new Error("proxy did not bind a TCP port");

  try {
    const response = await request(proxyAddress.port);
    expect(response).toContain("HTTP/1.1 200 OK");
    expect(response).toEndWith("proxied");
  } finally {
    await close(proxy);
    await close(upstream);
    await fs.rm(directory, { recursive: true, force: true });
  }
});
