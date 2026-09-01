import { afterEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { RUNTIME_PLANE_ABSENT } from "@/lib/runtime/flags";

import { viewerMcpBindings, type ViewerControlDependencies } from "./bindings";
import { createMcpToolService, McpToolRefusal, MemoryMcpReceiptStore } from "./server";

const originalRuntimeEvents = process.env.LLV_RUNTIME_EVENTS;
const originalRuntimeSocket = process.env.LLV_RUNTIME_HOST_SOCKET;
const originalRuntimeJournal = process.env.LLV_RUNTIME_JOURNAL;
const originalViewerControlUrl = process.env.LLV_VIEWER_CONTROL_URL;
const originalViewerDeployTarget = process.env.LLV_VIEWER_DEPLOY_TARGET;
const originalViewerPort = process.env.LLV_VIEWER_PORT;
const originalStateDirectory = process.env.LLV_STATE_DIR;
const originalConfigHome = process.env.XDG_CONFIG_HOME;
const originalHome = process.env.HOME;
const sandboxes: string[] = [];
const netServers: net.Server[] = [];
const netSockets = new Set<net.Socket>();

afterEach(async () => {
  for (const socket of netSockets) socket.destroy();
  netSockets.clear();
  await Promise.all(netServers.splice(0).map((server) => new Promise<void>((resolve) => {
    if (!server.listening) return resolve();
    server.close(() => resolve());
  })));
  for (const sandbox of sandboxes.splice(0)) fs.rmSync(sandbox, { recursive: true, force: true });
  if (originalRuntimeEvents === undefined) delete process.env.LLV_RUNTIME_EVENTS;
  else process.env.LLV_RUNTIME_EVENTS = originalRuntimeEvents;
  if (originalRuntimeSocket === undefined) delete process.env.LLV_RUNTIME_HOST_SOCKET;
  else process.env.LLV_RUNTIME_HOST_SOCKET = originalRuntimeSocket;
  if (originalRuntimeJournal === undefined) delete process.env.LLV_RUNTIME_JOURNAL;
  else process.env.LLV_RUNTIME_JOURNAL = originalRuntimeJournal;
  if (originalViewerControlUrl === undefined) delete process.env.LLV_VIEWER_CONTROL_URL;
  else process.env.LLV_VIEWER_CONTROL_URL = originalViewerControlUrl;
  if (originalViewerDeployTarget === undefined) delete process.env.LLV_VIEWER_DEPLOY_TARGET;
  else process.env.LLV_VIEWER_DEPLOY_TARGET = originalViewerDeployTarget;
  if (originalViewerPort === undefined) delete process.env.LLV_VIEWER_PORT;
  else process.env.LLV_VIEWER_PORT = originalViewerPort;
  if (originalStateDirectory === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = originalStateDirectory;
  if (originalConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalConfigHome;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
});

function installViewerControlFixture(origin: string): void {
  const endpoint = new URL(origin);
  if (endpoint.port === "8898") throw new Error("a Viewer control fixture cannot use the production port");
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-viewer-control-fixture-"));
  const stateDirectory = path.join(sandbox, "state");
  const configHome = path.join(sandbox, "config");
  const target = path.join(stateDirectory, "viewer-release.json");
  fs.mkdirSync(stateDirectory, { recursive: true });
  fs.mkdirSync(configHome, { recursive: true });
  fs.writeFileSync(target, JSON.stringify({
    revision: "f".repeat(40),
    image: "viewer:fixture",
    container: "viewer-fixture",
    endpoint: origin,
  }));
  sandboxes.push(sandbox);
  process.env.HOME = sandbox;
  process.env.XDG_CONFIG_HOME = configHome;
  process.env.LLV_STATE_DIR = stateDirectory;
  process.env.LLV_VIEWER_DEPLOY_TARGET = target;
  process.env.LLV_VIEWER_CONTROL_URL = origin;
  process.env.LLV_VIEWER_PORT = endpoint.port;
}

function deployment(deploymentId: string, revision = "a".repeat(40)) {
  return {
    deploymentId,
    phase: "succeeded",
    revision,
  };
}

function installLedger(
  rows: Array<{ id: string; value?: unknown; raw?: string; updatedAt?: number }>,
): string {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-deployment-ledger-"));
  sandboxes.push(sandbox);
  const filename = path.join(sandbox, "runtime-events.sqlite");
  const db = new Database(filename);
  db.exec(`
    CREATE TABLE entities (
      kind TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL,
      state_json TEXT NOT NULL, checkpoint_seq INTEGER NOT NULL,
      PRIMARY KEY(kind, id)
    );
    CREATE TABLE viewer_deployments (
      deployment_id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE,
      request_hash TEXT NOT NULL, status_json TEXT NOT NULL,
      active INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
  `);
  const entityInsert = db.query(
    "INSERT INTO entities(kind, id, revision, state_json, checkpoint_seq) VALUES (?, ?, 1, ?, 1)",
  );
  const legacyInsert = db.query(
    "INSERT INTO viewer_deployments(deployment_id, idempotency_key, request_hash, status_json, active, updated_at) VALUES (?, ?, ?, ?, 0, ?)",
  );
  for (const [index, row] of rows.entries()) {
    const raw = row.raw ?? JSON.stringify(row.value);
    entityInsert.run("deployment", row.id, raw);
    legacyInsert.run(row.id, `key-${index}`, `hash-${index}`, raw, row.updatedAt ?? index);
  }
  db.close();
  process.env.LLV_RUNTIME_JOURNAL = filename;
  return filename;
}

async function listenTcp(onSocket: (socket: net.Socket) => void): Promise<{ origin: string; server: net.Server }> {
  const server = net.createServer((socket) => {
    netSockets.add(socket);
    socket.on("close", () => netSockets.delete(socket));
    onSocket(socket);
  });
  netServers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test TCP server did not bind");
  return { origin: `http://127.0.0.1:${address.port}`, server };
}

async function serveRuntimeSnapshot(deployments: unknown[]): Promise<string[]> {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-deployment-runtime-"));
  sandboxes.push(sandbox);
  const socketPath = path.join(sandbox, "runtime.sock");
  const methods: string[] = [];
  const server = net.createServer((socket) => {
    netSockets.add(socket);
    socket.on("close", () => netSockets.delete(socket));
    let frame = "";
    socket.on("data", (chunk) => {
      frame += String(chunk);
      const newline = frame.indexOf("\n");
      if (newline < 0) return;
      const request = JSON.parse(frame.slice(0, newline)) as { id: string; method: string };
      methods.push(request.method);
      socket.end(`${JSON.stringify({ id: request.id, ok: true, result: { deployments } })}\n`);
    });
  });
  netServers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  process.env.LLV_RUNTIME_HOST_SOCKET = socketPath;
  delete process.env.LLV_RUNTIME_EVENTS;
  return methods;
}

test("deployment_status reads the live plane through Viewer HTTP when the MCP environment has no runtime variables", async () => {
  delete process.env.LLV_RUNTIME_EVENTS;
  delete process.env.LLV_RUNTIME_HOST_SOCKET;
  const gets: string[] = [];
  const deployment = {
    deploymentId: "deployment_live",
    phase: "succeeded",
    revision: "a".repeat(40),
  };
  const runtimeHostRequests = { samples: 8, p95Ms: 2750, maxMs: 3001, timeouts: 2, windowSize: 256 };
  const control: ViewerControlDependencies & {
    get(pathname: string): Promise<Record<string, unknown>>;
  } = {
    async get(pathname) {
      gets.push(pathname);
      return { count: 1, deployments: [deployment], runtimeHostRequests };
    },
    async post() {
      throw new Error("unexpected control write");
    },
  };
  let inProcessRuntimeReads = 0;
  const bindings = viewerMcpBindings(undefined, control, {
    runtimeEventsEnabled: () => {
      inProcessRuntimeReads += 1;
      return false;
    },
    runtimeHostClient: () => {
      inProcessRuntimeReads += 1;
      return null;
    },
  } as never);

  expect(await bindings.deployment_status({ clientRequestId: "deployment-list-live" })).toEqual({
    count: 1,
    deployments: [deployment],
    runtimeHostRequests,
  });
  expect(gets).toEqual(["/api/runtime/deployments?limit=25"]);
  expect(inProcessRuntimeReads).toBe(0);
});

test("the production Viewer control adapter reads a live plane with no runtime variables in the MCP process", async () => {
  delete process.env.LLV_RUNTIME_EVENTS;
  delete process.env.LLV_RUNTIME_HOST_SOCKET;
  const deployment = {
    deploymentId: "deployment_http_live",
    phase: "succeeded",
    revision: "c".repeat(40),
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      expect(url.pathname).toBe("/api/runtime/deployments");
      expect(url.searchParams.get("limit")).toBe("25");
      return Response.json({ count: 1, deployments: [deployment] });
    },
  });
  installViewerControlFixture(server.url.origin);

  try {
    expect(await viewerMcpBindings().deployment_status({
      clientRequestId: "deployment-production-http",
    })).toEqual({
      count: 1,
      deployments: [deployment],
    });
  } finally {
    server.stop(true);
  }
});

test("a control-URL-only fixture can send only to itself and never to the production port", async () => {
  delete process.env.LLV_VIEWER_DEPLOY_TARGET;
  delete process.env.LLV_VIEWER_PORT;
  delete process.env.LLV_STATE_DIR;
  delete process.env.XDG_CONFIG_HOME;
  const deployment = {
    deploymentId: "deployment_control_url_only",
    phase: "succeeded",
    revision: "b".repeat(40),
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => Response.json({ count: 1, deployments: [deployment] }),
  });
  if (server.port === 8898) {
    server.stop(true);
    throw new Error("the control-URL-only fixture selected the production port");
  }
  process.env.LLV_VIEWER_CONTROL_URL = server.url.origin;
  const ambientRelease = JSON.stringify({
    revision: "c".repeat(40),
    image: "viewer:ambient-fixture",
    container: "viewer-ambient-fixture",
    endpoint: "http://127.0.0.1:19007",
  });
  const readFile = spyOn(fs, "readFileSync").mockImplementation(
    (() => ambientRelease) as unknown as typeof fs.readFileSync,
  );
  const requests: string[] = [];
  const fetchRequest = globalThis.fetch.bind(globalThis);
  const guardedFetch = async (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.port === "8898") throw new Error("a fixture request attempted to reach the production port");
    requests.push(url.href);
    return fetchRequest(input, init);
  };
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(guardedFetch as typeof fetch);

  try {
    expect(await viewerMcpBindings().deployment_status({
      clientRequestId: "deployment-control-url-only",
    })).toEqual({ count: 1, deployments: [deployment] });
    expect(readFile).not.toHaveBeenCalled();
    expect(requests).toEqual([
      `${server.url.origin}/api/runtime/deployments?limit=25`,
    ]);
  } finally {
    fetchSpy.mockRestore();
    readFile.mockRestore();
    server.stop(true);
  }
});

test("the production Viewer control adapter returns a failed deployment domain object and preserves 404", async () => {
  const deployment = {
    deploymentId: "deployment_http_failed",
    phase: "failed",
    revision: "d".repeat(40),
    error: "candidate health check failed",
  };
  let missing = false;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      expect(new URL(request.url).pathname).toBe("/api/runtime/deployments/deployment_http_failed");
      return missing
        ? Response.json({ error: "viewer deployment was not found" }, { status: 404 })
        : Response.json(deployment);
    },
  });
  installViewerControlFixture(server.url.origin);
  const bindings = viewerMcpBindings();

  try {
    expect(await bindings.deployment_status({
      clientRequestId: "deployment-production-failed",
      deploymentId: "deployment_http_failed",
    })).toEqual({
      deploymentId: "deployment_http_failed",
      deployment,
    });

    missing = true;
    await expect(bindings.deployment_status({
      clientRequestId: "deployment-production-missing",
      deploymentId: "deployment_http_failed",
    })).rejects.toMatchObject({
      message: "viewer deployment was not found",
      details: {
        error: "viewer deployment was not found",
        status: 404,
      },
    });
  } finally {
    server.stop(true);
  }
});

test("deployment_status exposes the absent-plane code and keeps an unreachable plane distinct", async () => {
  let runtimeUnavailable = false;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      if (runtimeUnavailable) {
        return Response.json({
          error: "runtime host is unavailable",
          runtimeHostRequests: { samples: 8, p95Ms: 2750, maxMs: 3001, timeouts: 2, windowSize: 256 },
        }, { status: 503 });
      }
      return Response.json(
        { error: "runtime events are disabled", code: RUNTIME_PLANE_ABSENT },
        { status: 503 },
      );
    },
  });
  installViewerControlFixture(server.url.origin);
  const absentService = createMcpToolService(viewerMcpBindings(), new MemoryMcpReceiptStore());

  const absent = await absentService.callTool("deployment_status", {
    clientRequestId: "deployment-plane-absent",
  });
  expect(absent).toMatchObject({
    ok: false,
    error: "runtime events are disabled",
    details: {
      error: "runtime events are disabled",
      code: RUNTIME_PLANE_ABSENT,
      status: 503,
    },
  });

  runtimeUnavailable = true;
  const unreachableService = createMcpToolService(viewerMcpBindings(), new MemoryMcpReceiptStore());
  const unreachable = await unreachableService.callTool("deployment_status", {
    clientRequestId: "deployment-plane-unreachable",
  });
  expect(unreachable).toMatchObject({
    ok: false,
    error: "runtime host is unavailable",
    details: {
      error: "runtime host is unavailable",
      status: 503,
      runtimeHostRequests: { samples: 8, p95Ms: 2750, maxMs: 3001, timeouts: 2, windowSize: 256 },
    },
  });
  expect(unreachable).not.toHaveProperty("details.code");
  server.stop(true);
});

test("deployment_status preserves the deploymentId lookup and presentation through Viewer HTTP", async () => {
  const gets: string[] = [];
  const deployment = {
    deploymentId: "deployment_608",
    phase: "succeeded",
    revision: "b".repeat(40),
  };
  const control = {
    async get(pathname: string) {
      gets.push(pathname);
      return deployment;
    },
    async post() {
      throw new Error("unexpected control write");
    },
  };
  const bindings = viewerMcpBindings(undefined, control, {
    runtimeEventsEnabled: () => false,
    runtimeHostClient: () => null,
  } as never);

  expect(await bindings.deployment_status({
    clientRequestId: "deployment-by-id",
    deploymentId: "deployment_608",
  })).toEqual({
    deploymentId: "deployment_608",
    deployment,
  });
  expect(gets).toEqual(["/api/runtime/deployments/deployment_608"]);
});

test("deployment_status preserves the operationId lookup and presentation through Viewer HTTP", async () => {
  const gets: string[] = [];
  const receipt = {
    operationId: "operation_608",
    status: "delivered",
    revision: 4,
  };
  const control = {
    async get(pathname: string) {
      gets.push(pathname);
      return { operationId: "operation_608", receipt };
    },
    async post() {
      throw new Error("unexpected control write");
    },
  };
  const bindings = viewerMcpBindings(undefined, control, {
    runtimeEventsEnabled: () => false,
    runtimeHostClient: () => null,
  } as never);

  expect(await bindings.deployment_status({
    clientRequestId: "deployment-by-operation",
    operationId: "operation_608",
  })).toEqual({
    operationId: "operation_608",
    operation: {
      operationId: "operation_608",
      receipt,
      replayed: false,
    },
  });
  expect(gets).toEqual(["/api/runtime/operations/operation_608"]);
});

test("lifecycle_events surfaces an absent deployment plane instead of silently projecting an empty ledger", async () => {
  const projected: unknown[] = [];
  const control = {
    async get() {
      throw new McpToolRefusal("runtime events are disabled", {
        error: "runtime events are disabled",
        code: RUNTIME_PLANE_ABSENT,
        status: 503,
      });
    },
    async post() {
      throw new Error("unexpected control write");
    },
  };
  const bindings = viewerMcpBindings(undefined, control, {
    registrySnapshot: () => ({ heldDeliveries: {} }),
    getPipelines: () => ({ pipelines: [] }),
    refreshLifecycleJournal: (input: unknown) => {
      projected.push(input);
      return { appended: 0, skipped: 0, throttled: false };
    },
    queryLifecycleEvents: () => ({ count: 0, events: [], cursor: 0, remaining: 0 }),
    runtimeEventsEnabled: () => false,
    runtimeHostClient: () => null,
  } as never);

  const result = await bindings.lifecycle_events({ clientRequestId: "deployment-projection-absent" });

  expect(result).toMatchObject({
    deploymentsError: "runtime events are disabled",
    deploymentsErrorCode: RUNTIME_PLANE_ABSENT,
  });
  expect(projected).toEqual([{
    pipelines: [],
    deliveries: [],
    deployments: [],
  }]);
});

test("lifecycle_events distinguishes an unreachable deployment plane from an honestly empty ledger", async () => {
  const projectionInputs: unknown[] = [];
  let read: "unreachable" | "empty" = "unreachable";
  const control = {
    async get() {
      if (read === "unreachable") throw new Error("Viewer control is unreachable");
      return { count: 0, deployments: [] };
    },
    async post() {
      throw new Error("unexpected control write");
    },
  };
  const bindings = viewerMcpBindings(undefined, control, {
    registrySnapshot: () => ({ heldDeliveries: {} }),
    getPipelines: () => ({ pipelines: [] }),
    refreshLifecycleJournal: (input: unknown) => {
      projectionInputs.push(input);
      return { appended: 0, skipped: 0, throttled: false };
    },
    queryLifecycleEvents: () => ({ count: 0, events: [], cursor: 0, remaining: 0 }),
  } as never);

  const unreachable = await bindings.lifecycle_events({ clientRequestId: "deployment-projection-unreachable" });
  expect(unreachable).toMatchObject({ deploymentsError: "Viewer control is unreachable" });
  expect(unreachable).not.toHaveProperty("deploymentsErrorCode");

  read = "empty";
  const empty = await bindings.lifecycle_events({ clientRequestId: "deployment-projection-empty" });
  expect(empty).not.toHaveProperty("deploymentsError");
  expect(empty).not.toHaveProperty("deploymentsErrorCode");
  expect(projectionInputs).toEqual([
    { pipelines: [], deliveries: [], deployments: [] },
    { pipelines: [], deliveries: [], deployments: [] },
  ]);
});

/**
 * Issue #790: blue/green promotes the web surface before the successor runtime
 * host takes over, so the deployment health gate probes a CANDIDATE's MCP while
 * the PREVIOUS revision still answers on the control port. A read that moved onto
 * a route introduced in the same revision meets a Viewer that has never served it
 * and gets 405. Treating that as fatal made the gate unpassable for the very
 * change that added the route — one real deploy failed exactly this way, with
 * `calls.deploymentStatus: false` and every other check green.
 */
test("a control surface that does not serve the route yet falls back instead of failing the probe", async () => {
  const ledgerDeployment = deployment("deployment_legacy");
  installLedger([{ id: ledgerDeployment.deploymentId, value: ledgerDeployment }]);
  let sawGet = false;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      sawGet = true;
      expect(new URL(request.url).pathname).toBe("/api/runtime/deployments");
      /* What the previous revision answers: the route exists for POST only. */
      return new Response("Method Not Allowed", { status: 405 });
    },
  });
  installViewerControlFixture(server.url.origin);

  try {
    expect(await viewerMcpBindings().deployment_status({
      clientRequestId: "deployment-legacy-surface",
      limit: 1,
    })).toEqual({
      count: 1,
      deployments: [ledgerDeployment],
    });
    expect(sawGet).toBe(true);
  } finally {
    server.stop(true);
  }
});

test("a 404 keeps its domain meaning and is never mistaken for an unserved route", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => Response.json({ error: "viewer deployment was not found" }, { status: 404 }),
  });
  installViewerControlFixture(server.url.origin);

  try {
    await expect(viewerMcpBindings().deployment_status({
      clientRequestId: "deployment-404-domain",
      deploymentId: "deployment_absent",
    })).rejects.toThrow(/not found/);
  } finally {
    server.stop(true);
  }
});

/**
 * Issue #790, the actual root cause. A revision that does not serve the route
 * answers 405 with a body of literal `null`, which is valid JSON — so the
 * `.catch` guarding the parse never fires and `result.error` threw a TypeError
 * before the status could be classified. The failure therefore never became a
 * refusal carrying 405, and no status-based fallback could ever match it. Two
 * real deploys failed this way with `calls.deploymentStatus: false` as the only
 * evidence.
 */
test("a null response body is classified by status instead of crashing the read", async () => {
  const ledgerDeployment = deployment("deployment_null_body");
  installLedger([{ id: ledgerDeployment.deploymentId, value: ledgerDeployment }]);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("null", { status: 405, headers: { "content-type": "application/json" } }),
  });
  installViewerControlFixture(server.url.origin);

  try {
    expect(await viewerMcpBindings().deployment_status({
      clientRequestId: "deployment-null-body",
      limit: 1,
    })).toEqual({
      count: 1,
      deployments: [ledgerDeployment],
    });
  } finally {
    server.stop(true);
  }
});

test("ledger fallback matches control ordering and tail limits even when legacy update order opposes ids", async () => {
  const deployments = [
    deployment("deployment_a"),
    deployment("deployment_b"),
    deployment("deployment_c"),
  ];
  installLedger([
    { id: deployments[0]!.deploymentId, value: deployments[0], updatedAt: 300 },
    { id: deployments[1]!.deploymentId, value: deployments[1], updatedAt: 100 },
    { id: deployments[2]!.deploymentId, value: deployments[2], updatedAt: 200 },
  ]);
  const control: ViewerControlDependencies = {
    async get() {
      throw new McpToolRefusal("Method Not Allowed", { error: "Method Not Allowed", status: 405 });
    },
    async post() {
      throw new Error("unexpected control write");
    },
  };

  expect(await viewerMcpBindings(undefined, control).deployment_status({
    clientRequestId: "deployment-ledger-order",
    limit: 2,
  })).toEqual({
    count: 2,
    deployments: deployments.slice(-2),
  });
});

test("an unreadable ledger terminates fallback with explicit evidence and zero runtime-socket calls", async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-deployment-missing-ledger-"));
  sandboxes.push(sandbox);
  process.env.LLV_RUNTIME_JOURNAL = path.join(sandbox, "missing.sqlite");
  const runtimeMethods = await serveRuntimeSnapshot([deployment("deployment_socket")]);
  const control: ViewerControlDependencies = {
    async get() {
      throw new Error("Viewer control is unreachable");
    },
    async post() {
      throw new Error("unexpected control write");
    },
  };

  await expect(viewerMcpBindings(undefined, control).deployment_status({
    clientRequestId: "deployment-unreadable-ledger",
  })).rejects.toThrow("deployment ledger is unreadable");
  expect(runtimeMethods).toEqual([]);
});

test("a malformed ledger entity stays distinct from a genuine absent deployment", async () => {
  installLedger([{ id: "deployment_malformed", raw: "{" }]);
  const control: ViewerControlDependencies = {
    async get() {
      throw new McpToolRefusal("Method Not Allowed", { error: "Method Not Allowed", status: 405 });
    },
    async post() {
      throw new Error("unexpected control write");
    },
  };
  const bindings = viewerMcpBindings(undefined, control);

  await expect(bindings.deployment_status({
    clientRequestId: "deployment-malformed-ledger",
    deploymentId: "deployment_malformed",
  })).rejects.toThrow("deployment ledger is unreadable");
  await expect(bindings.deployment_status({
    clientRequestId: "deployment-genuine-miss",
    deploymentId: "deployment_absent",
  })).rejects.toThrow("viewer deployment was not found");
});

test("malformed successful control bodies never become successful undefined deployment data", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      return new URL(request.url).searchParams.get("invalid-json") === "1"
        ? new Response("{", { status: 200, headers: { "content-type": "application/json" } })
        : Response.json({});
    },
  });
  installViewerControlFixture(server.url.origin);

  try {
    await expect(viewerMcpBindings().deployment_status({
      clientRequestId: "deployment-malformed-success-list",
    })).rejects.toThrow("malformed deployment list");
    await expect(viewerMcpBindings().deployment_status({
      clientRequestId: "deployment-malformed-success-item",
      deploymentId: "deployment_missing_shape",
    })).rejects.toThrow("malformed deployment");
  } finally {
    server.stop(true);
  }
});

test("a timed-out 2xx body is surfaced instead of becoming an empty success", async () => {
  const { origin } = await listenTcp((socket) => {
    socket.once("data", () => {
      socket.write([
        "HTTP/1.1 200 OK",
        "Content-Type: application/json",
        "Content-Length: 128",
        "Connection: keep-alive",
        "",
        "{\"count\":1,",
      ].join("\r\n"));
    });
  });
  installViewerControlFixture(origin);

  await expect(viewerMcpBindings().deployment_status({
    clientRequestId: "deployment-timed-out-success-body",
  })).rejects.toThrow("unreadable response");
}, 10_000);

/**
 * Issue #790, the post-promotion deadlock. After promotion the new web surface
 * serves the deployments route, and its handler asks the runtime host for a
 * snapshot — while that same host is synchronously awaiting `verify-promoted`.
 * A real deploy sat there for the full 90-second budget with no events and was
 * rolled back. The read is bounded now and answers from the durable ledger the
 * host writes, so it never waits on the writer.
 */
test("a control surface that never answers falls back instead of hanging the probe", async () => {
  const ledgerDeployment = deployment("deployment_deadlock_ledger");
  installLedger([{ id: ledgerDeployment.deploymentId, value: ledgerDeployment }]);
  const runtimeMethods = await serveRuntimeSnapshot([deployment("deployment_socket_bypass")]);
  const { origin } = await listenTcp(() => {
    /* Keep the accepted connection open without sending headers. */
  });
  installViewerControlFixture(origin);

  const started = Date.now();
  expect(await viewerMcpBindings().deployment_status({
    clientRequestId: "deployment-hanging-control",
    limit: 1,
  })).toEqual({
    count: 1,
    deployments: [ledgerDeployment],
  });
  expect(Date.now() - started).toBeGreaterThanOrEqual(4_500);
  expect(Date.now() - started).toBeLessThan(8_000);
  expect(runtimeMethods).toEqual([]);
}, 9_000);
