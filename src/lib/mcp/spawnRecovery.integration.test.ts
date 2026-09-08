import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "bun:test";
import { NextRequest } from "next/server";

import { POST as spawnAdmissionPost } from "@/app/api/spawn/validate/route";
import { executeSpawnAdmissionValidation } from "@/lib/agent/spawnAdmissionValidation";
import { AgentRegistry } from "@/lib/agent/registry";
import { readSpawnAdmissionFence } from "@/lib/agent/spawnAdmission";
import { VIEWER_SPAWN_CAPABILITY_HEADER } from "@/lib/agent/spawnPolicy";
import { executeSpawnRequest, type SpawnCommandDependencies } from "@/lib/agent/spawnCommand";
import type { RuntimeHostClient } from "@/lib/runtime/client";

import {
  productionDomainDependencies,
  viewerMcpBindings,
  viewerMcpRecoverableTools,
  type ViewerControlDependencies,
  type ViewerMcpDomainDependencies,
} from "./bindings";
import {
  createMcpToolService,
  McpDispatchVerdictError,
  MemoryMcpReceiptStore,
  SqliteMcpReceiptStore,
  type McpRecoveryReceiptStore,
  type McpRequestBinding,
  type McpToolCallContext,
} from "./server";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-spawn-recovery-integration-"));
const previousStateDir = process.env.LLV_STATE_DIR;
const previousHome = process.env.HOME;
const previousConfigHome = process.env.XDG_CONFIG_HOME;
const previousTransport = process.env.LLV_SPAWN_TRANSPORT;
const previousStructuredHosts = process.env.LLV_STRUCTURED_HOSTS;
const previousRuntimeEvents = process.env.LLV_RUNTIME_EVENTS;
const previousRuntimeSocket = process.env.LLV_RUNTIME_HOST_SOCKET;
const previousRuntimeUi = process.env.NEXT_PUBLIC_RUNTIME_UI;
const previousCodexBinary = process.env.LLV_CODEX_BINARY;
const codexBinary = path.join(sandbox, "codex-list");
fs.writeFileSync(codexBinary, "#!/bin/sh\nprintf '[]'\n", { mode: 0o700 });
process.env.LLV_STATE_DIR = path.join(sandbox, "state");
process.env.HOME = path.join(sandbox, "home");
process.env.XDG_CONFIG_HOME = path.join(sandbox, "config");
process.env.LLV_SPAWN_TRANSPORT = "structured";
process.env.LLV_STRUCTURED_HOSTS = "1";
process.env.LLV_RUNTIME_EVENTS = "1";
process.env.LLV_RUNTIME_HOST_SOCKET = path.join(sandbox, "runtime.sock");
process.env.NEXT_PUBLIC_RUNTIME_UI = "1";
process.env.LLV_CODEX_BINARY = codexBinary;

afterAll(() => {
  if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousStateDir;
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = previousConfigHome;
  if (previousTransport === undefined) delete process.env.LLV_SPAWN_TRANSPORT;
  else process.env.LLV_SPAWN_TRANSPORT = previousTransport;
  if (previousStructuredHosts === undefined) delete process.env.LLV_STRUCTURED_HOSTS;
  else process.env.LLV_STRUCTURED_HOSTS = previousStructuredHosts;
  if (previousRuntimeEvents === undefined) delete process.env.LLV_RUNTIME_EVENTS;
  else process.env.LLV_RUNTIME_EVENTS = previousRuntimeEvents;
  if (previousRuntimeSocket === undefined) delete process.env.LLV_RUNTIME_HOST_SOCKET;
  else process.env.LLV_RUNTIME_HOST_SOCKET = previousRuntimeSocket;
  if (previousRuntimeUi === undefined) delete process.env.NEXT_PUBLIC_RUNTIME_UI;
  else process.env.NEXT_PUBLIC_RUNTIME_UI = previousRuntimeUi;
  if (previousCodexBinary === undefined) delete process.env.LLV_CODEX_BINARY;
  else process.env.LLV_CODEX_BINARY = previousCodexBinary;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

function routeRequest(pathname: string, body: Record<string, unknown>, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`http://127.0.0.1:8898${pathname}`, {
    method: "POST",
    headers: {
      origin: "http://127.0.0.1:8898",
      host: "127.0.0.1:8898",
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function spawnDependencies(registry: AgentRegistry, cwd: string): SpawnCommandDependencies {
  const account = {
    engine: "codex" as const,
    accountId: "codex-test",
    kind: "managed" as const,
    home: path.join(cwd, "account"),
    transcriptRoot: path.join(cwd, "projects"),
    env: { NODE_ENV: "test" as const },
  };
  return {
    registry: () => registry,
    resolveHealthySpawnAccount: async () => account,
    resolveSpawnAccount: () => account,
    assertStructuredRuntime: () => {},
    runtimeHostClient: () => ({} as RuntimeHostClient),
    defer: () => {},
    storeImages: () => [],
    spawnStructuredConversation: async () => {
      throw new Error("the fenced spawn must not reach structured launch");
    },
  };
}

function domainDependencies(registry: AgentRegistry, validate = true): ViewerMcpDomainDependencies {
  return {
    registrySnapshot: () => registry.readOnlySnapshot(),
    readSpawnAdmissionFence,
    attentionAuthority: () => ({ kind: "root", conversationId: null, role: null }),
    ...(validate ? {
      validateSpawnAdmission: async (body: Record<string, unknown>, _context?: McpToolCallContext) => {
        const response = await executeSpawnAdmissionValidation(
          routeRequest("/api/spawn/validate", body),
          { registry: () => registry },
        );
        return await response.json() as Record<string, unknown>;
      },
    } : {}),
  } as unknown as ViewerMcpDomainDependencies;
}

function routeControl(dependencies: SpawnCommandDependencies, dispatches: { count: number }): ViewerControlDependencies {
  return {
    post: async () => { throw new Error("unexpected non-dispatch control call"); },
    dispatch: async (pathname, body, headers, context) => {
      if (pathname !== "/api/spawn") throw new Error(`unexpected control path: ${pathname}`);
      dispatches.count += 1;
      if (context?.dispatch) context.dispatch.attempted = true;
      const response = await executeSpawnRequest(routeRequest(pathname, body, headers), dependencies);
      const payload = await response.json() as Record<string, unknown>;
      if (!response.ok) {
        throw new McpDispatchVerdictError(String(payload.error ?? "spawn refused"), {
          status: response.status,
          ...(typeof payload.code === "string" ? { code: payload.code } : {}),
        });
      }
      return payload;
    },
  };
}

function service(
  registry: AgentRegistry,
  store: McpRecoveryReceiptStore,
  control: ViewerControlDependencies,
  domain: ViewerMcpDomainDependencies,
) {
  return createMcpToolService(
    viewerMcpBindings(undefined, control, domain),
    store,
    undefined,
    { recovery: viewerMcpRecoverableTools(domain) },
  );
}

function spawnArgs(clientRequestId: string, cwd: string): Record<string, unknown> {
  return {
    clientRequestId,
    role: "deployer",
    roleParams: { sha: "a".repeat(40), pr: "26" },
    cwd,
    ["prompt"]: "launch the dev deployer",
    title: "Rejected deployer integration",
  };
}

test("a real post-wire HTTP 400 is fenced once and an existing stranded claim recovers without redispatch", async () => {
  const cwd = path.join(sandbox, "launch-dir");
  fs.mkdirSync(cwd, { recursive: true });
  const registry = new AgentRegistry(path.join(sandbox, `registry-${crypto.randomUUID()}.json`), undefined, undefined, { sqliteMode: "off" });

  const liveDispatches = { count: 0 };
  const liveStore = new MemoryMcpReceiptStore();
  const live = service(registry, liveStore, routeControl(spawnDependencies(registry, cwd), liveDispatches), domainDependencies(registry));
  const liveArgs = spawnArgs("spawn_post_wire_live_1", cwd);
  const liveAnswer = await live.callTool("spawn_agent", liveArgs);
  expect(liveAnswer).toMatchObject({
    ok: false,
    code: "not_executed",
    details: {
      outcome: "not-executed",
      evidence: "spawn-admission-fence",
      nextAction: "new-request-permitted",
    },
  });
  expect(liveDispatches.count).toBe(1);
  expect(registry.readOnlySnapshot().receipts).toEqual({});
  const liveDownstreamKey = "mcp_spawn_" + crypto.createHash("sha256").update(String(liveArgs.clientRequestId)).digest("hex");
  expect(readSpawnAdmissionFence(liveDownstreamKey)).toMatchObject({ status: 400 });
  expect(await live.callTool("spawn_agent", liveArgs)).toMatchObject({ ok: false, code: "not_executed", replayed: true });
  expect(liveDispatches.count).toBe(1);

  const historicalDispatches = { count: 0 };
  const historicalStore = new SqliteMcpReceiptStore(path.join(sandbox, "historical-receipts.sqlite"));
  const oldControl: ViewerControlDependencies = {
    post: async () => { throw new Error("unexpected old control call"); },
    dispatch: async (_pathname, _body, _headers, context) => {
      historicalDispatches.count += 1;
      if (context?.dispatch) context.dispatch.attempted = true;
      throw new McpDispatchVerdictError("deployer requires confirm: deploy", { status: 400 });
    },
  };
  const historicalArgs = spawnArgs("spawn_post_wire_stranded_1", cwd);
  const oldService = service(registry, historicalStore, oldControl, domainDependencies(registry, false));
  const oldAnswer = await oldService.callTool("spawn_agent", historicalArgs);
  expect(oldAnswer).toMatchObject({ ok: false, code: "outcome_unknown", details: { outcome: "unknown" } });
  expect(historicalDispatches.count).toBe(1);
  const downstreamKey = "mcp_spawn_" + crypto.createHash("sha256").update(String(historicalArgs.clientRequestId)).digest("hex");
  const stranded = await historicalStore.lookup(`spawn_agent:${historicalArgs.clientRequestId}`);
  expect(stranded).toMatchObject({ stage: "dispatching", result: null });

  const recoveryDispatches = { count: 0 };
  const recovered = service(
    registry,
    historicalStore,
    {
      post: async () => { throw new Error("historical recovery must not dispatch"); },
      dispatch: async () => {
        recoveryDispatches.count += 1;
        throw new Error("historical recovery must not dispatch");
      },
    },
    domainDependencies(registry),
  );
  const recoveredAnswer = await recovered.callTool("spawn_agent", { ...historicalArgs, recoveryOnly: true });
  expect(recoveredAnswer).toMatchObject({
    ok: false,
    code: "not_executed",
    replayed: true,
    details: { outcome: "not-executed", evidence: "spawn-admission-fence" },
  });
  expect(recoveryDispatches.count).toBe(0);
  const closed = await historicalStore.lookup(`spawn_agent:${historicalArgs.clientRequestId}`);
  expect(closed).toMatchObject({ stage: "not-executed" });
  expect(closed?.digest).toBe(stranded?.digest);
  expect(closed?.binding).toEqual(stranded?.binding);
  expect(registry.readOnlySnapshot().receipts).toEqual({});
  expect(readSpawnAdmissionFence(downstreamKey)).toMatchObject({ status: 400 });
  historicalStore.close();
});

test("production recovery probes the exported validate route over HTTP with the dispatch capability", async () => {
  const cwd = path.join(sandbox, "http-probe-dir");
  fs.mkdirSync(cwd, { recursive: true });
  const registry = new AgentRegistry(path.join(sandbox, `registry-${crypto.randomUUID()}.json`), undefined, undefined, { sqliteMode: "off" });
  const requests: { pathname: string; capability: string | null }[] = [];
  const viewer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      requests.push({
        pathname: new URL(request.url).pathname,
        capability: request.headers.get(VIEWER_SPAWN_CAPABILITY_HEADER),
      });
      return spawnAdmissionPost.withDependencies(
        new NextRequest(request),
        { registry: () => registry },
      );
    },
  });
  const previousControlUrl = process.env.LLV_VIEWER_CONTROL_URL;
  process.env.LLV_VIEWER_CONTROL_URL = viewer.url.origin;
  try {
    const args = spawnArgs("spawn_post_wire_http_1", cwd);
    const tools = viewerMcpRecoverableTools({
      ...productionDomainDependencies,
      registrySnapshot: () => registry.readOnlySnapshot(),
      attentionAuthority: () => ({ kind: "root", conversationId: null, role: null }),
      recoveryPredecessors: () => [],
    });
    const bindingInput = await tools.spawn_agent!.bind(args);
    const binding: McpRequestBinding = {
      ...bindingInput,
      version: 1,
      toolName: "spawn_agent",
      clientRequestId: String(args.clientRequestId),
      owner: { pid: process.pid, startIdentity: null },
      claimedAt: new Date().toISOString(),
    };
    const recovered = await tools.spawn_agent!.recover(binding, { legacy: false, args });
    expect(recovered).toMatchObject({ outcome: "not-executed", evidence: "spawn-admission-fence" });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ pathname: "/api/spawn/validate", capability: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) });
    expect(readSpawnAdmissionFence(binding.downstreamKey)).toMatchObject({ status: 400 });
  } finally {
    viewer.stop(true);
    if (previousControlUrl === undefined) delete process.env.LLV_VIEWER_CONTROL_URL;
    else process.env.LLV_VIEWER_CONTROL_URL = previousControlUrl;
  }
});
