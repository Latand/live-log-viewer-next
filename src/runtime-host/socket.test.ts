import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import type { RuntimeSocketRequest, RuntimeSocketResponse } from "@/lib/runtime/contracts";

import type { RuntimeHost } from "./host";
import { serveRuntimeHost } from "./socket";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-runtime-socket-"));
const servers: net.Server[] = [];

afterAll(async () => {
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

interface HandledRequest {
  request: RuntimeSocketRequest;
  signal: AbortSignal | undefined;
}

function stubHost(
  respond: (request: RuntimeSocketRequest, options: { signal?: AbortSignal }) => Promise<RuntimeSocketResponse>,
  handled: HandledRequest[] = [],
): RuntimeHost {
  return {
    handle: async (request: RuntimeSocketRequest, options: { signal?: AbortSignal } = {}) => {
      handled.push({ request, signal: options.signal });
      return respond(request, options);
    },
  } as unknown as RuntimeHost;
}

function serve(host: RuntimeHost, socketErrors: Error[]): string {
  const socketPath = path.join(SANDBOX, `${crypto.randomUUID().slice(0, 8)}.sock`);
  const server = serveRuntimeHost(socketPath, host);
  server.on("connection", (socket) => socket.on("error", (error) => socketErrors.push(error)));
  servers.push(server);
  return socketPath;
}

function once(server: string, frame: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(server);
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += String(chunk);
      if (buffer.includes("\n")) {
        socket.destroy();
        resolve(buffer);
      }
    });
    socket.once("error", reject);
    socket.once("connect", () => socket.write(frame));
  });
}

test("a caller disconnect before completion aborts the request and discards the late write", async () => {
  let releaseResponse = () => {};
  const gate = new Promise<void>((resolve) => { releaseResponse = () => resolve(); });
  const handled: HandledRequest[] = [];
  const socketErrors: Error[] = [];
  const socketPath = serve(stubHost(async (request) => {
    await gate;
    return { id: request.id, ok: true, result: { late: true } };
  }, handled), socketErrors);

  const client = net.createConnection(socketPath);
  await new Promise<void>((resolve) => client.once("connect", () => resolve()));
  client.write(JSON.stringify({ id: "req-1", method: "snapshot" }) + "\n");
  while (handled.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));

  // The ordinary snapshot request must carry the connection's abort signal.
  expect(handled[0]!.signal).toBeDefined();
  expect(handled[0]!.signal!.aborted).toBe(false);

  client.destroy();
  await new Promise((resolve) => setTimeout(resolve, 25));
  expect(handled[0]!.signal!.aborted).toBe(true);

  // The host completes after the caller is gone: the settlement must be
  // discarded silently instead of writing to the finished stream.
  releaseResponse();
  await new Promise((resolve) => setTimeout(resolve, 25));
  expect(socketErrors).toEqual([]);
});

test("a healthy request settles exactly once with its response frame", async () => {
  const socketErrors: Error[] = [];
  const socketPath = serve(stubHost(async (request) => ({ id: request.id, ok: true, result: { fine: true } })), socketErrors);

  const raw = await once(socketPath, JSON.stringify({ id: "req-2", method: "snapshot" }) + "\n");
  expect(JSON.parse(raw.slice(0, raw.indexOf("\n")))).toEqual({ id: "req-2", ok: true, result: { fine: true } });
  expect(socketErrors).toEqual([]);
});

test("a rejected host promise settles the socket with an error frame instead of leaking", async () => {
  const socketErrors: Error[] = [];
  const socketPath = serve(stubHost(async () => {
    throw new Error("host exploded");
  }), socketErrors);

  const raw = await once(socketPath, JSON.stringify({ id: "req-3", method: "snapshot" }) + "\n");
  expect(JSON.parse(raw.slice(0, raw.indexOf("\n")))).toMatchObject({ id: "req-3", ok: false });
  expect(socketErrors).toEqual([]);
});

test("a timed-out socket destroyed by the server produces zero late writes", async () => {
  let releaseResponse = () => {};
  const gate = new Promise<void>((resolve) => { releaseResponse = () => resolve(); });
  const socketErrors: Error[] = [];
  const socketPath = path.join(SANDBOX, `${crypto.randomUUID().slice(0, 8)}.sock`);
  const server = serveRuntimeHost(socketPath, stubHost(async (request) => {
    await gate;
    return { id: request.id, ok: true, result: {} };
  }), { defaultTimeoutMs: 30 });
  server.on("connection", (socket) => socket.on("error", (error) => socketErrors.push(error)));
  servers.push(server);

  const client = net.createConnection(socketPath);
  client.on("error", () => undefined);
  await new Promise<void>((resolve) => client.once("connect", () => resolve()));
  client.write(JSON.stringify({ id: "req-4", method: "snapshot" }) + "\n");
  await new Promise((resolve) => setTimeout(resolve, 80));

  releaseResponse();
  await new Promise((resolve) => setTimeout(resolve, 25));
  expect(socketErrors).toEqual([]);
  client.destroy();
});
