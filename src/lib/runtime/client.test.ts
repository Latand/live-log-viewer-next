import { afterAll, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import {
  resetRuntimeHostRequestHealthForTests,
  RuntimeHostUnavailableError,
  runtimeHostRequestHealth,
  UnixRuntimeHostClient,
} from "./client";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-runtime-client-"));
const servers: net.Server[] = [];
const connections: net.Socket[] = [];

afterAll(async () => {
  for (const socket of connections) socket.destroy();
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

function serve(onRequest: (frame: string, socket: net.Socket) => void): string {
  const socketPath = path.join(SANDBOX, `${crypto.randomUUID().slice(0, 8)}.sock`);
  const server = net.createServer((socket) => {
    connections.push(socket);
    socket.on("error", () => undefined);
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += String(chunk);
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      onRequest(buffer.slice(0, newline), socket);
    });
  });
  server.listen(socketPath);
  servers.push(server);
  return socketPath;
}

test("snapshot forwards its abort signal and settles exactly once on external abort", async () => {
  const socketPath = serve(() => {
    /* never respond — the abort must settle the request */
  });
  const client = new UnixRuntimeHostClient(socketPath, 60_000, 60_000, 60_000);
  const abort = new AbortController();
  const request = client.snapshot(abort.signal);
  const outcome = request.then(() => "resolved", (error) => error);
  abort.abort();
  const settled = await outcome;
  expect(settled).toBeInstanceOf(RuntimeHostUnavailableError);
  expect((settled as Error).message).toBe("runtime host request cancelled");
});

test("a timeout, a late response, and a socket teardown settle the call exactly once", async () => {
  let respond: ((frame: string, socket: net.Socket) => void) | null = null;
  const socketPath = serve((frame, socket) => { respond?.(frame, socket); });
  const client = new UnixRuntimeHostClient(socketPath, 40, 40, 40);
  let requestSocket: net.Socket | null = null;
  let requestFrame = "";
  respond = (frame, socket) => {
    requestFrame = frame;
    requestSocket = socket;
  };
  const settlements: unknown[] = [];
  await client.snapshot().then(
    (value) => settlements.push({ value }),
    (error) => settlements.push({ error }),
  );
  expect(settlements).toHaveLength(1);
  expect((settlements[0] as { error: Error }).error.message).toBe("runtime host request timed out");

  // A response arriving after the timeout destroyed the client socket must not
  // produce a second settlement or an unhandled error.
  const request = JSON.parse(requestFrame) as { id: string };
  requestSocket!.write(JSON.stringify({ id: request.id, ok: true, result: {} }) + "\n");
  await new Promise((resolve) => setTimeout(resolve, 25));
  expect(settlements).toHaveLength(1);
});

test("a timeout log identifies the runtime request method and elapsed time", async () => {
  resetRuntimeHostRequestHealthForTests();
  const socketPath = serve(() => {
    /* never respond — the request must reach its timeout */
  });
  const client = new UnixRuntimeHostClient(socketPath, 20, 20, 20);
  const logged = spyOn(console, "error").mockImplementation(() => undefined);
  try {
    await expect(client.events(0)).rejects.toThrow("runtime host request timed out");
    expect(logged).toHaveBeenCalledTimes(1);
    expect(String(logged.mock.calls[0]?.[0])).toMatch(
      /^\[runtime host\] request timed out method=events elapsedMs=\d+$/,
    );
    expect(runtimeHostRequestHealth()).toEqual({
      samples: 1,
      p95Ms: expect.any(Number),
      maxMs: expect.any(Number),
      timeouts: 1,
      windowSize: 256,
    });
    expect(runtimeHostRequestHealth().p95Ms).toBe(runtimeHostRequestHealth().maxMs);
  } finally {
    logged.mockRestore();
  }
});

test("a socket error settles the call exactly once with a transport failure", async () => {
  const client = new UnixRuntimeHostClient(path.join(SANDBOX, "absent.sock"), 200, 200, 200);
  const settlements: unknown[] = [];
  await client.events(0).then(
    (value) => settlements.push({ value }),
    (error) => settlements.push({ error }),
  );
  await new Promise((resolve) => setTimeout(resolve, 25));
  expect(settlements).toHaveLength(1);
  expect((settlements[0] as { error: Error }).error.message).toBe("runtime host is unavailable");
});

test("a healthy response resolves once and ignores the pending timeout", async () => {
  const socketPath = serve((frame, socket) => {
    const request = JSON.parse(frame) as { id: string };
    socket.end(JSON.stringify({ id: request.id, ok: true, result: { revision: 7 } }) + "\n");
  });
  const client = new UnixRuntimeHostClient(socketPath, 5_000, 5_000, 5_000);
  expect(await client.snapshot() as unknown).toEqual({ revision: 7 });
});

test("request latency health excludes the intentional wait long poll", async () => {
  resetRuntimeHostRequestHealthForTests();
  const socketPath = serve((frame, socket) => {
    const request = JSON.parse(frame) as { id: string };
    socket.end(JSON.stringify({
      id: request.id,
      ok: true,
      result: { reset: false, floorSeq: 0, events: [] },
    }) + "\n");
  });
  const client = new UnixRuntimeHostClient(socketPath, 5_000, 5_000, 5_000);

  await client.waitEvents(0, 10);

  expect(runtimeHostRequestHealth().samples).toBe(0);
});

test("request latency health reports the nearest-rank p95 of the recent window", async () => {
  resetRuntimeHostRequestHealthForTests();
  const socketPath = serve((frame, socket) => {
    const request = JSON.parse(frame) as { id: string };
    socket.end(JSON.stringify({ id: request.id, ok: true, result: { reset: false, floorSeq: 0, events: [] } }) + "\n");
  });
  const client = new UnixRuntimeHostClient(socketPath, 5_000, 5_000, 5_000);
  const durations = Array.from({ length: 20 }, (_, index) => index + 1);
  let reading = 0;
  const clock = spyOn(performance, "now").mockImplementation(() => {
    const requestIndex = Math.floor(reading / 2);
    const elapsed = reading % 2 === 0 ? 0 : durations[requestIndex] ?? durations.at(-1)!;
    reading += 1;
    return requestIndex * 100 + elapsed;
  });
  try {
    for (let index = 0; index < durations.length; index += 1) await client.events(0);
  } finally {
    clock.mockRestore();
  }

  expect(reading).toBe(40);
  expect(runtimeHostRequestHealth()).toEqual({
    samples: 20,
    p95Ms: 19,
    maxMs: 20,
    timeouts: 0,
    windowSize: 256,
  });
});

test("snapshot accepts an upgrade-sized frame from the previous runtime host", async () => {
  const padding = "x".repeat(9 * 1024 * 1024);
  const socketPath = serve((frame, socket) => {
    const request = JSON.parse(frame) as { id: string };
    socket.end(JSON.stringify({ id: request.id, ok: true, result: { padding } }) + "\n");
  });
  const client = new UnixRuntimeHostClient(socketPath, 5_000, 5_000, 5_000);

  const snapshot = await client.snapshot() as unknown as { padding: string };

  expect(snapshot.padding.length).toBe(padding.length);
});
