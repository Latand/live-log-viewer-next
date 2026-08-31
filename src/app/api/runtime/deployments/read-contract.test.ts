import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { NextRequest } from "next/server";

import { resetRuntimeHostRequestHealthForTests } from "@/lib/runtime/client";
import { RUNTIME_PLANE_ABSENT } from "@/lib/runtime/flags";

import { GET as GET_DEPLOYMENT } from "./[deploymentId]/route";
import { GET } from "./route";
import { GET as GET_OPERATION } from "../operations/[operationId]/route";

const originalRuntimeEvents = process.env.LLV_RUNTIME_EVENTS;
const originalRuntimeSocket = process.env.LLV_RUNTIME_HOST_SOCKET;
const sandboxes: string[] = [];
const servers: net.Server[] = [];

function runtimeHostRequestHealth() {
  return {
    samples: 1,
    p95Ms: expect.any(Number),
    maxMs: expect.any(Number),
    timeouts: 0,
    windowSize: 256,
  };
}

beforeEach(() => {
  resetRuntimeHostRequestHealthForTests();
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  for (const sandbox of sandboxes.splice(0)) fs.rmSync(sandbox, { recursive: true, force: true });
  if (originalRuntimeEvents === undefined) delete process.env.LLV_RUNTIME_EVENTS;
  else process.env.LLV_RUNTIME_EVENTS = originalRuntimeEvents;
  if (originalRuntimeSocket === undefined) delete process.env.LLV_RUNTIME_HOST_SOCKET;
  else process.env.LLV_RUNTIME_HOST_SOCKET = originalRuntimeSocket;
});

async function serveRuntime(
  result: unknown | ((request: { id: string; method: string; params?: Record<string, unknown> }) => unknown),
): Promise<string[]> {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-deployment-read-route-"));
  sandboxes.push(sandbox);
  const socketPath = path.join(sandbox, "runtime.sock");
  const methods: string[] = [];
  const server = net.createServer((socket) => {
    let frame = "";
    socket.on("data", (chunk) => {
      frame += String(chunk);
      const newline = frame.indexOf("\n");
      if (newline < 0) return;
      const request = JSON.parse(frame.slice(0, newline)) as {
        id: string;
        method: string;
        params?: Record<string, unknown>;
      };
      methods.push(request.method);
      const response = typeof result === "function" ? result(request) : result;
      socket.end(`${JSON.stringify({ id: request.id, ok: true, result: response })}\n`);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  process.env.LLV_RUNTIME_HOST_SOCKET = socketPath;
  delete process.env.LLV_RUNTIME_EVENTS;
  return methods;
}

test("GET /api/runtime/deployments returns an empty live ledger with runtime-host latency health", async () => {
  const methods = await serveRuntime({ deployments: [] });

  const response = await GET(new NextRequest("http://127.0.0.1/api/runtime/deployments"));

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    count: 0,
    deployments: [],
    runtimeHostRequests: runtimeHostRequestHealth(),
  });
  expect(methods).toEqual(["snapshot"]);
});

test("GET /api/runtime/deployments preserves limit ordering for a working host", async () => {
  const deployments = ["one", "two", "three"].map((suffix) => ({
    deploymentId: `deployment_${suffix}`,
    phase: "succeeded",
    revision: "a".repeat(40),
  }));
  await serveRuntime({ deployments });

  const response = await GET(new NextRequest("http://127.0.0.1/api/runtime/deployments?limit=2"));

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    count: 2,
    deployments: deployments.slice(-2),
    runtimeHostRequests: runtimeHostRequestHealth(),
  });
});

test("GET /api/runtime/deployments leaves an omitted limit unbounded for the journal projection", async () => {
  const deployments = Array.from({ length: 30 }, (_, index) => ({
    deploymentId: `deployment_${index + 1}`,
    phase: "succeeded",
    revision: "f".repeat(40),
  }));
  await serveRuntime({ deployments });

  const response = await GET(new NextRequest("http://127.0.0.1/api/runtime/deployments"));

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    count: deployments.length,
    deployments,
    runtimeHostRequests: runtimeHostRequestHealth(),
  });
});

test("the deployment and operation item routes preserve their existing lookup presentations", async () => {
  const deployment = {
    deploymentId: "deployment_608",
    phase: "succeeded",
    revision: "b".repeat(40),
  };
  const operation = {
    operationId: "operation_608",
    receipt: { operationId: "operation_608", status: "delivered", revision: 4 },
    replayed: false,
  };
  const methods = await serveRuntime((request: {
    id: string;
    method: string;
    params?: Record<string, unknown>;
  }) => {
    if (request.method === "viewer-deployment-read") {
      expect(request.params).toEqual({ deploymentId: "deployment_608" });
      return deployment;
    }
    if (request.method === "operation-status") {
      expect(request.params).toEqual({ operationId: "operation_608" });
      return operation;
    }
    throw new Error(`unexpected runtime method: ${request.method}`);
  });

  const deploymentResponse = await GET_DEPLOYMENT(
    new Request("http://127.0.0.1/api/runtime/deployments/deployment_608"),
    { params: Promise.resolve({ deploymentId: "deployment_608" }) },
  );
  expect(deploymentResponse.status).toBe(200);
  expect(await deploymentResponse.json()).toEqual(deployment);

  const operationResponse = await GET_OPERATION(
    new Request("http://127.0.0.1/api/runtime/operations/operation_608"),
    { params: Promise.resolve({ operationId: "operation_608" }) },
  );
  expect(operationResponse.status).toBe(200);
  expect(await operationResponse.json()).toEqual({
    operationId: "operation_608",
    receipt: operation.receipt,
  });
  expect(methods).toEqual(["viewer-deployment-read", "operation-status"]);
});

test("runtime read routes reserve the disabled message for an explicit rollback", async () => {
  delete process.env.LLV_RUNTIME_HOST_SOCKET;
  delete process.env.LLV_RUNTIME_EVENTS;
  const absentResponses = await Promise.all([
    GET(new NextRequest("http://127.0.0.1/api/runtime/deployments")),
    GET_DEPLOYMENT(
      new Request("http://127.0.0.1/api/runtime/deployments/deployment_608"),
      { params: Promise.resolve({ deploymentId: "deployment_608" }) },
    ),
    GET_OPERATION(
      new Request("http://127.0.0.1/api/runtime/operations/operation_608"),
      { params: Promise.resolve({ operationId: "operation_608" }) },
    ),
  ]);
  for (const response of absentResponses) {
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "runtime host socket is unavailable",
      code: RUNTIME_PLANE_ABSENT,
    });
  }

  process.env.LLV_RUNTIME_EVENTS = "0";
  const rolledBackResponses = await Promise.all([
    GET(new NextRequest("http://127.0.0.1/api/runtime/deployments")),
    GET_DEPLOYMENT(
      new Request("http://127.0.0.1/api/runtime/deployments/deployment_608"),
      { params: Promise.resolve({ deploymentId: "deployment_608" }) },
    ),
    GET_OPERATION(
      new Request("http://127.0.0.1/api/runtime/operations/operation_608"),
      { params: Promise.resolve({ operationId: "operation_608" }) },
    ),
  ]);
  for (const response of rolledBackResponses) {
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "runtime events are disabled",
      code: RUNTIME_PLANE_ABSENT,
    });
  }
});

test("runtime read routes keep a configured but unreachable plane distinct from an absent plane", async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-deployment-unreachable-"));
  sandboxes.push(sandbox);
  process.env.LLV_RUNTIME_HOST_SOCKET = path.join(sandbox, "missing-runtime.sock");
  delete process.env.LLV_RUNTIME_EVENTS;

  const responses = await Promise.all([
    GET(new NextRequest("http://127.0.0.1/api/runtime/deployments")),
    GET_DEPLOYMENT(
      new Request("http://127.0.0.1/api/runtime/deployments/deployment_608"),
      { params: Promise.resolve({ deploymentId: "deployment_608" }) },
    ),
    GET_OPERATION(
      new Request("http://127.0.0.1/api/runtime/operations/operation_608"),
      { params: Promise.resolve({ operationId: "operation_608" }) },
    ),
  ]);

  for (const response of responses) {
    expect(response.status).toBe(503);
    const body = await response.json() as Record<string, unknown>;
    expect(body.error).toBe("runtime host is unavailable");
    expect(body).not.toHaveProperty("code");
  }
});
