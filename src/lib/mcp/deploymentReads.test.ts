import { afterEach, expect, test } from "bun:test";

import { RUNTIME_PLANE_ABSENT } from "@/lib/runtime/flags";

import { viewerMcpBindings, type ViewerControlDependencies } from "./bindings";
import { createMcpToolService, McpToolRefusal, MemoryMcpReceiptStore } from "./server";

const originalRuntimeEvents = process.env.LLV_RUNTIME_EVENTS;
const originalRuntimeSocket = process.env.LLV_RUNTIME_HOST_SOCKET;
const originalViewerControlUrl = process.env.LLV_VIEWER_CONTROL_URL;

afterEach(() => {
  if (originalRuntimeEvents === undefined) delete process.env.LLV_RUNTIME_EVENTS;
  else process.env.LLV_RUNTIME_EVENTS = originalRuntimeEvents;
  if (originalRuntimeSocket === undefined) delete process.env.LLV_RUNTIME_HOST_SOCKET;
  else process.env.LLV_RUNTIME_HOST_SOCKET = originalRuntimeSocket;
  if (originalViewerControlUrl === undefined) delete process.env.LLV_VIEWER_CONTROL_URL;
  else process.env.LLV_VIEWER_CONTROL_URL = originalViewerControlUrl;
});

test("deployment_status reads the live plane through Viewer HTTP when the MCP environment has no runtime variables", async () => {
  delete process.env.LLV_RUNTIME_EVENTS;
  delete process.env.LLV_RUNTIME_HOST_SOCKET;
  const gets: string[] = [];
  const deployment = {
    deploymentId: "deployment_live",
    phase: "succeeded",
    revision: "a".repeat(40),
  };
  const control: ViewerControlDependencies & {
    get(pathname: string): Promise<Record<string, unknown>>;
  } = {
    async get(pathname) {
      gets.push(pathname);
      return { count: 1, deployments: [deployment] };
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
  process.env.LLV_VIEWER_CONTROL_URL = server.url.origin;

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

test("deployment_status exposes the absent-plane code and keeps an unreachable plane distinct", async () => {
  let runtimeUnavailable = false;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      if (runtimeUnavailable) {
        return Response.json({ error: "runtime host is unavailable" }, { status: 503 });
      }
      return Response.json(
        { error: "runtime events are disabled", code: RUNTIME_PLANE_ABSENT },
        { status: 503 },
      );
    },
  });
  process.env.LLV_VIEWER_CONTROL_URL = server.url.origin;
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
