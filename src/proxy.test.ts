import { afterEach, expect, test } from "bun:test";
import http from "node:http";
import { networkInterfaces } from "node:os";
import { NextRequest } from "next/server";

import { proxy } from "./proxy";

const originalToken = process.env.LLV_TOKEN;
afterEach(() => {
  if (originalToken === undefined) delete process.env.LLV_TOKEN;
  else process.env.LLV_TOKEN = originalToken;
});

function remote(authorization: string): NextRequest {
  return new NextRequest("http://viewer.example/api/agent/snapshot", { headers: { host: "viewer.example", "x-forwarded-for": "203.0.113.10", authorization } });
}

function nonLoopbackIpv4Address(): string {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) return address.address;
    }
  }
  throw new Error("the auth exposure regression needs a non-loopback IPv4 interface");
}

async function requestThroughProxy(hostname: string): Promise<{ peerAddress: string; status: number }> {
  let peerAddress = "";
  const server = http.createServer(async (incoming, outgoing) => {
    peerAddress = incoming.socket.remoteAddress ?? "";
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) {
      if (Array.isArray(value)) {
        for (const entry of value) headers.append(name, entry);
      } else if (value !== undefined) {
        headers.set(name, value);
      }
    }
    const response = proxy(new NextRequest(`http://localhost${incoming.url ?? "/"}`, { headers }));
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "0.0.0.0", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("auth exposure regression server did not bind a TCP port");
  }

  try {
    const status = await new Promise<number>((resolve, reject) => {
      const request = http.get({
        hostname,
        port: address.port,
        path: "/api/agent/snapshot",
        headers: {
          host: "localhost",
          "x-forwarded-for": "127.0.0.1",
        },
      }, (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode ?? 0));
      });
      request.once("error", reject);
    });
    return { peerAddress, status };
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test("a configured access token protects loopback and non-loopback peers despite loopback request headers", async () => {
  process.env.LLV_TOKEN = "viewer-token";

  const remoteRequest = await requestThroughProxy(nonLoopbackIpv4Address());
  expect(remoteRequest.peerAddress).not.toMatch(/^(?:127\.|::1$|::ffff:127\.)/);
  expect(remoteRequest.status).toBe(403);

  const localRequest = await requestThroughProxy("127.0.0.1");
  expect(localRequest.peerAddress).toMatch(/^(?:127\.|::1$|::ffff:127\.)/);
  expect(localRequest.status).toBe(403);
});

test("remote agent access accepts the exact Bearer LLV_TOKEN", () => {
  process.env.LLV_TOKEN = "viewer-token";
  expect(proxy(remote("Bearer viewer-token")).headers.get("x-middleware-next")).toBe("1");
  expect(proxy(remote("Bearer wrong-token")).status).toBe(403);
});

test("remote access accepts the existing llv_auth cookie", () => {
  process.env.LLV_TOKEN = "viewer-token";
  const request = new NextRequest("http://viewer.example/api/agent/snapshot", {
    headers: { host: "viewer.example", "x-forwarded-for": "203.0.113.10", cookie: "llv_auth=viewer-token" },
  });

  expect(proxy(request).headers.get("x-middleware-next")).toBe("1");
});
