import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "bun:test";
import { NextRequest } from "next/server";

import { agentRegistry, AgentRegistry } from "@/lib/agent/registry";
import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { codexSessionRoots, createManagedCodexAccount } from "@/lib/accounts/codex";
import { spawnParentSelector, spawnRequestDigest } from "@/lib/agent/spawnIdentity";
import { rotateOperatorSpawnCapability } from "@/lib/agent/operatorCapability";
import { spawnReplayStatus, spawnResponseForReceipt } from "@/lib/agent/spawnResponse";
import { resolveSpawnLineage, resolveSpawnLineageParent, resolveSpawnParent, SpawnParentError } from "@/lib/agent/spawnParent";
import type { RuntimeHostClient } from "@/lib/runtime/client";
import { StructuredRuntimeRequirementError } from "@/lib/proc/darwinIdentity";
import { authenticatedAgentSpawnCaller, isAgentInitiatedSpawn, spawnLineageSelectorForCaller } from "./admission";
import { POST } from "./route";

const previousStateDir = process.env.LLV_STATE_DIR;
const routeSandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-spawn-route-tests-"));
process.env.LLV_STATE_DIR = path.join(routeSandbox, "state");

afterAll(() => {
  if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousStateDir;
  fs.rmSync(routeSandbox, { recursive: true, force: true });
});

function registry(): AgentRegistry {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-spawn-route-"));
  return new AgentRegistry(path.join(dir, "agent-registry.json"));
}

type SpawnRouteTestDependencies = NonNullable<Parameters<typeof POST.withDependencies>[1]>;

function structuredRouteDependencies(cwd: string): SpawnRouteTestDependencies {
  return {
    registry: agentRegistry,
    assertStructuredRuntime: () => {},
    resolveHealthySpawnAccount: async () => ({
      engine: "claude",
      accountId: "claude-test",
      kind: "managed",
      home: path.join(cwd, "account"),
      transcriptRoot: path.join(cwd, "projects"),
      env: { NODE_ENV: "test" },
    }),
    resolveSpawnAccount: (_engine, accountId) => ({
      engine: "claude",
      accountId: accountId ?? "claude-test",
      kind: "managed",
      home: path.join(cwd, "account"),
      transcriptRoot: path.join(cwd, "projects"),
      env: { NODE_ENV: "test" },
    }),
    runtimeHostClient: () => ({} as RuntimeHostClient),
    defer: (work) => { void work(); },
    storeImages: (images) => images.map((image) => ({
      sha256: crypto.createHash("sha256").update(Buffer.from(image.base64, "base64")).digest("hex"),
      mime: image.mime as "image/png",
      bytes: Buffer.from(image.base64, "base64").byteLength,
    })),
    spawnStructuredConversation: async (input) => ({
      ok: true,
      target: null,
      path: null,
      effectivePermissionMode: input.spec.launchProfile?.permissionMode ?? "default",
      launchId: input.receipt.launchId,
      conversationId: input.receipt.conversationId,
      launched: true,
      retrySafe: false,
      initialMessage: "delivered",
      state: "settled",
    }),
  };
}

test("spawn rejects malformed, oversized, and mismatched images before durable mutation", async () => {
  const cwd = fs.mkdtempSync(path.join(routeSandbox, "image-admission-"));
  const store = agentRegistry();
  const imageRoot = path.join(process.env.LLV_STATE_DIR!, "runtime-images");
  const beforeReceipts = Object.keys(store.snapshot().receipts).sort();
  const beforeBlobs = fs.existsSync(imageRoot) ? fs.readdirSync(imageRoot).sort() : [];
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489", "hex").toString("base64");
  const cases = [
    { images: [{ base64: "a===", mime: "image/png" }], status: 400 },
    { images: Array.from({ length: 17 }, () => ({ base64: png, mime: "image/png" })), status: 413 },
    { images: [{ base64: png, mime: "image/svg+xml" }], status: 415 },
    { images: [{ base64: Buffer.from("plain").toString("base64"), mime: "image/png" }], status: 415 },
  ];

  for (const candidate of cases) {
    const response = await POST.withDependencies(new NextRequest("http://127.0.0.1:8898/api/spawn", {
      method: "POST",
      headers: {
        host: "127.0.0.1:8898",
        origin: "http://127.0.0.1:8898",
        "sec-fetch-site": "same-origin",
        "content-type": "application/json",
      },
      body: JSON.stringify({ engine: "claude", cwd, prompt: "inspect", images: candidate.images }),
    }), structuredRouteDependencies(cwd));
    expect(response.status).toBe(candidate.status);
    expect(Object.keys(store.snapshot().receipts).sort()).toEqual(beforeReceipts);
    expect(fs.existsSync(imageRoot) ? fs.readdirSync(imageRoot).sort() : []).toEqual(beforeBlobs);
  }
});

test("structured spawn maps operational image storage failures to 503", async () => {
  const cwd = fs.mkdtempSync(path.join(routeSandbox, "image-storage-failure-"));
  const previousTransport = process.env.LLV_SPAWN_TRANSPORT;
  const previousHosts = process.env.LLV_STRUCTURED_HOSTS;
  const previousEvents = process.env.LLV_RUNTIME_EVENTS;
  const previousSocket = process.env.LLV_RUNTIME_HOST_SOCKET;
  const previousUi = process.env.NEXT_PUBLIC_RUNTIME_UI;
  process.env.LLV_SPAWN_TRANSPORT = "structured";
  process.env.LLV_STRUCTURED_HOSTS = "1";
  process.env.LLV_RUNTIME_EVENTS = "1";
  process.env.LLV_RUNTIME_HOST_SOCKET = path.join(cwd, "runtime.sock");
  process.env.NEXT_PUBLIC_RUNTIME_UI = "1";
  const dependencies = {
    ...structuredRouteDependencies(cwd),
    storeImages: () => { throw new Error("runtime image storage quota exceeded"); },
  };
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489", "hex").toString("base64");
  try {
    const response = await POST.withDependencies(new NextRequest("http://127.0.0.1:8898/api/spawn", {
      method: "POST",
      headers: {
        host: "127.0.0.1:8898",
        origin: "http://127.0.0.1:8898",
        "sec-fetch-site": "same-origin",
        "content-type": "application/json",
      },
      body: JSON.stringify({ engine: "claude", cwd, prompt: "inspect", images: [{ base64: png, mime: "image/png" }] }),
    }), dependencies);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "runtime image storage quota exceeded" });
  } finally {
    if (previousTransport === undefined) delete process.env.LLV_SPAWN_TRANSPORT;
    else process.env.LLV_SPAWN_TRANSPORT = previousTransport;
    if (previousHosts === undefined) delete process.env.LLV_STRUCTURED_HOSTS;
    else process.env.LLV_STRUCTURED_HOSTS = previousHosts;
    if (previousEvents === undefined) delete process.env.LLV_RUNTIME_EVENTS;
    else process.env.LLV_RUNTIME_EVENTS = previousEvents;
    if (previousSocket === undefined) delete process.env.LLV_RUNTIME_HOST_SOCKET;
    else process.env.LLV_RUNTIME_HOST_SOCKET = previousSocket;
    if (previousUi === undefined) delete process.env.NEXT_PUBLIC_RUNTIME_UI;
    else process.env.NEXT_PUBLIC_RUNTIME_UI = previousUi;
  }
});

test("agent-initiated spawn without lineage returns a teaching 400", async () => {
  const response = await POST(new NextRequest("http://127.0.0.1:8898/api/spawn", {
    method: "POST",
    headers: { host: "127.0.0.1:8898", "content-type": "application/json" },
    body: JSON.stringify({ engine: "codex", cwd: "/repo", prompt: "help" }),
  }));

  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({
    error: expect.stringContaining("POST http://127.0.0.1:8898/api/spawn"),
  });
});

test("same-origin browser requests use the Viewer spawn surface", () => {
  const request = new NextRequest("http://127.0.0.1:8898/api/spawn", {
    headers: { host: "127.0.0.1:8898", origin: "http://127.0.0.1:8898", "sec-fetch-site": "same-origin" },
  });

  expect(isAgentInitiatedSpawn(request)).toBe(false);
  expect(isAgentInitiatedSpawn(new NextRequest("http://127.0.0.1:8898/api/spawn"))).toBe(true);
});

test("agent capability binds src to the caller conversation", () => {
  const store = registry();
  const capability = "C".repeat(43);
  const callerPath = "/sessions/caller-019f4906-3f67-7b72-9fbc-9ec3b5ad1325.jsonl";
  const begun = store.beginSpawnRequest({
    engine: "codex",
    cwd: "/repo",
    spawnCapabilityDigest: crypto.createHash("sha256").update(capability).digest("hex"),
  });
  if (begun.kind !== "created") throw new Error("expected create");
  const settled = store.settleSpawn(begun.receipt.launchId, {
    key: { engine: "codex", sessionId: "019f4906-3f67-7b72-9fbc-9ec3b5ad1325" },
    artifactPath: callerPath,
    cwd: "/repo",
    accountId: "terra",
    status: "live",
    host: null,
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: null,
  });
  expect(settled.kind).toBe("settled");
  const request = new NextRequest("http://127.0.0.1:8898/api/spawn", {
    headers: { "x-llv-spawn-capability": capability },
  });

  expect(authenticatedAgentSpawnCaller(request, callerPath, store)).toEqual({
    kind: "agent",
    conversationId: begun.receipt.conversationId,
    liveChildrenCap: 3,
  });

  const other = store.ensureConversation("codex", "/sessions/other.jsonl", "terra");
  expect(authenticatedAgentSpawnCaller(request, other.generations[0]!.path, store)).toEqual({
    error: "src must identify the authenticated caller conversation",
  });
});

test("operator capability skips conversation binding and rotation rejects the previous token", () => {
  const store = registry();
  const first = rotateOperatorSpawnCapability();
  const request = (capability: string) => new NextRequest("http://127.0.0.1:8898/api/spawn", {
    headers: { "x-llv-spawn-capability": capability },
  });

  expect(authenticatedAgentSpawnCaller(request(first), "/outside/viewer.jsonl", store)).toEqual({
    kind: "operator",
    conversationId: null,
    liveChildrenCap: undefined,
  });

  const rotated = rotateOperatorSpawnCapability();
  expect(authenticatedAgentSpawnCaller(request(first), "/outside/viewer.jsonl", store)).toEqual({
    error: expect.stringContaining("x-llv-spawn-capability"),
  });
  expect(authenticatedAgentSpawnCaller(request(rotated), "/outside/viewer.jsonl", store)).toMatchObject({
    kind: "operator",
  });
});

test("operator capability file failures preserve agent admission and reject unknown credentials", () => {
  const store = registry();
  const capability = "A".repeat(43);
  const callerPath = `/sessions/caller-${crypto.randomUUID()}.jsonl`;
  const begun = store.beginSpawnRequest({
    engine: "codex",
    cwd: "/repo",
    spawnCapabilityDigest: crypto.createHash("sha256").update(capability).digest("hex"),
  });
  if (begun.kind !== "created") throw new Error("expected create");
  store.settleSpawn(begun.receipt.launchId, {
    key: { engine: "codex", sessionId: crypto.randomUUID() },
    artifactPath: callerPath,
    cwd: "/repo",
    accountId: "terra",
    status: "live",
    host: null,
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: null,
  });
  const blockedState = path.join(routeSandbox, "blocked-state");
  fs.writeFileSync(blockedState, "blocked\n");
  const currentState = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = blockedState;
  try {
    const request = (candidate: string) => new NextRequest("http://127.0.0.1:8898/api/spawn", {
      headers: { "x-llv-spawn-capability": candidate },
    });
    expect(authenticatedAgentSpawnCaller(request(capability), callerPath, store)).toEqual({
      kind: "agent",
      conversationId: begun.receipt.conversationId,
      liveChildrenCap: 3,
    });
    expect(authenticatedAgentSpawnCaller(request("C".repeat(43)), "/caller.jsonl", store)).toEqual({
      error: expect.stringContaining("capability read failed"),
      status: 503,
    });
  } finally {
    process.env.LLV_STATE_DIR = currentState;
  }
});

test("operator-authenticated non-browser calls still require lineage", async () => {
  const capability = rotateOperatorSpawnCapability();
  const response = await POST(new NextRequest("http://127.0.0.1:8898/api/spawn", {
    method: "POST",
    headers: {
      host: "127.0.0.1:8898",
      "content-type": "application/json",
      "x-llv-spawn-capability": capability,
    },
    body: JSON.stringify({ engine: "codex", cwd: "/repo", prompt: "help" }),
  }));

  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: expect.stringContaining("src") });
});

test("agent callers cannot grant themselves native sub-agent permission", async () => {
  const store = agentRegistry();
  const capability = crypto.randomBytes(32).toString("base64url");
  const callerPath = `/sessions/caller-${crypto.randomUUID()}.jsonl`;
  const begun = store.beginSpawnRequest({
    engine: "codex",
    cwd: "/repo",
    spawnCapabilityDigest: crypto.createHash("sha256").update(capability).digest("hex"),
  });
  if (begun.kind !== "created") throw new Error("expected create");
  store.settleSpawn(begun.receipt.launchId, {
    key: { engine: "codex", sessionId: crypto.randomUUID() },
    artifactPath: callerPath,
    cwd: "/repo",
    accountId: "terra",
    status: "live",
    host: null,
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: null,
  });
  const response = await POST(new NextRequest("http://127.0.0.1:8898/api/spawn", {
    method: "POST",
    headers: {
      host: "127.0.0.1:8898",
      "content-type": "application/json",
      "x-llv-spawn-capability": capability,
    },
    body: JSON.stringify({ src: callerPath, role: "orchestrator", allowSubagents: true }),
  }));

  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ error: "allowSubagents requires an authenticated Viewer operator spawn" });
});

test("operator callers may grant native sub-agent permission", async () => {
  const capability = rotateOperatorSpawnCapability();
  const response = await POST(new NextRequest("http://127.0.0.1:8898/api/spawn", {
    method: "POST",
    headers: {
      host: "127.0.0.1:8898",
      "content-type": "application/json",
      "x-llv-spawn-capability": capability,
    },
    body: JSON.stringify({ src: "/caller.jsonl", role: "orchestrator", allowSubagents: true }),
  }));

  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "working directory is required" });
});

test("operator structured Claude retries retain bypass and agent reuse conflicts", async () => {
  const cwd = fs.mkdtempSync(path.join(routeSandbox, "operator-permission-"));
  const store = agentRegistry();
  const callerSessionId = crypto.randomUUID();
  const callerAccount = createManagedCodexAccount(`route-caller-${callerSessionId}`);
  const callerPath = path.join(callerAccount.sessionsDir, `${callerSessionId}.jsonl`);
  fs.mkdirSync(path.dirname(callerPath), { recursive: true });
  fs.writeFileSync(callerPath, "{}\n");
  const caller = store.beginSpawnRequest({ engine: "codex", cwd, accountId: "caller" });
  if (caller.kind !== "created") throw new Error("expected caller reservation");
  const settledCaller = store.settleSpawn(caller.receipt.launchId, {
    key: { engine: "codex", sessionId: callerSessionId },
    artifactPath: callerPath,
    cwd,
    accountId: "caller",
    status: "idle",
    host: null,
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: null,
  });
  if (settledCaller.kind !== "settled") throw new Error(`caller settlement failed: ${settledCaller.code}`);
  expect(store.conversationForPath(callerPath)?.id).toBe(caller.receipt.conversationId);
  const agentCapability = store.rotateSpawnCapabilityForReceipt(caller.receipt.launchId);
  const operatorCapability = rotateOperatorSpawnCapability();
  const attemptId = `attempt_${crypto.randomUUID()}`;
  const request = (capability: string, clientAttemptId = attemptId) => new NextRequest("http://127.0.0.1:8898/api/spawn", {
    method: "POST",
    headers: { host: "127.0.0.1:8898", "content-type": "application/json", "x-llv-spawn-capability": capability },
    body: JSON.stringify({ engine: "claude", model: "claude-sonnet-4-6", cwd, prompt: "build", src: callerPath, role: "builder", clientAttemptId }),
  });
  const previousTransport = process.env.LLV_SPAWN_TRANSPORT;
  const previousHosts = process.env.LLV_STRUCTURED_HOSTS;
  const previousEvents = process.env.LLV_RUNTIME_EVENTS;
  const previousSocket = process.env.LLV_RUNTIME_HOST_SOCKET;
  const previousUi = process.env.NEXT_PUBLIC_RUNTIME_UI;
  process.env.LLV_SPAWN_TRANSPORT = "structured";
  process.env.LLV_STRUCTURED_HOSTS = "1";
  process.env.LLV_RUNTIME_EVENTS = "1";
  process.env.LLV_RUNTIME_HOST_SOCKET = path.join(cwd, "runtime.sock");
  process.env.NEXT_PUBLIC_RUNTIME_UI = "1";
  try {
    const launched = await POST.withDependencies(request(operatorCapability), structuredRouteDependencies(cwd));
    expect(await launched.json()).toMatchObject({ effectivePermissionMode: "bypassPermissions" });

    const replay = await POST.withDependencies(request(operatorCapability), structuredRouteDependencies(cwd));
    expect(replay.status).toBe(202);
    expect(await replay.json()).toMatchObject({ state: "starting", effectivePermissionMode: "bypassPermissions" });

    const conflict = await POST.withDependencies(request(agentCapability), structuredRouteDependencies(cwd));
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: "spawn attempt conflicts with its original request" });

    const agentAttemptId = `attempt_${crypto.randomUUID()}`;
    const agentLaunch = await POST.withDependencies(request(agentCapability, agentAttemptId), structuredRouteDependencies(cwd));
    expect(await agentLaunch.json()).toMatchObject({ effectivePermissionMode: "default" });
    const agentReplay = await POST.withDependencies(request(agentCapability, agentAttemptId), structuredRouteDependencies(cwd));
    expect(agentReplay.status).toBe(202);
    expect(await agentReplay.json()).toMatchObject({ state: "starting", effectivePermissionMode: "default" });
  } finally {
    if (previousTransport === undefined) delete process.env.LLV_SPAWN_TRANSPORT;
    else process.env.LLV_SPAWN_TRANSPORT = previousTransport;
    if (previousHosts === undefined) delete process.env.LLV_STRUCTURED_HOSTS;
    else process.env.LLV_STRUCTURED_HOSTS = previousHosts;
    if (previousEvents === undefined) delete process.env.LLV_RUNTIME_EVENTS;
    else process.env.LLV_RUNTIME_EVENTS = previousEvents;
    if (previousSocket === undefined) delete process.env.LLV_RUNTIME_HOST_SOCKET;
    else process.env.LLV_RUNTIME_HOST_SOCKET = previousSocket;
    if (previousUi === undefined) delete process.env.NEXT_PUBLIC_RUNTIME_UI;
    else process.env.NEXT_PUBLIC_RUNTIME_UI = previousUi;
  }
});

test("structured replay keeps its admitted account after routing changes", async () => {
  const cwd = fs.mkdtempSync(path.join(routeSandbox, "account-rotation-replay-"));
  const store = registry();
  const deferred: Array<() => Promise<void>> = [];
  const effects: string[] = [];
  const accountResolutions: string[] = [];
  let routedAccountId = "account-a";
  const account = (accountId: string) => ({
    engine: "claude" as const,
    accountId,
    kind: "managed" as const,
    home: path.join(cwd, accountId),
    transcriptRoot: path.join(cwd, accountId, "projects"),
    env: { NODE_ENV: "test" },
  });
  const runtimeClient = {
    operationStatus: async () => null,
    snapshot: async () => ({ sessions: [] }),
  } as unknown as RuntimeHostClient;
  const dependencies = {
    ...structuredRouteDependencies(cwd),
    registry: () => store,
    resolveHealthySpawnAccount: async () => {
      accountResolutions.push(`healthy:${routedAccountId}`);
      return account(routedAccountId);
    },
    resolveSpawnAccount: (_engine: "claude" | "codex", accountId: string | null) => {
      accountResolutions.push(`exact:${accountId ?? "null"}`);
      return account(accountId ?? routedAccountId);
    },
    runtimeHostClient: () => runtimeClient,
    defer: (work: () => Promise<void>) => { deferred.push(work); },
    spawnStructuredConversation: async (input: Parameters<SpawnRouteTestDependencies["spawnStructuredConversation"]>[0]) => {
      effects.push(`worker:${input.account.accountId}`);
      const sessionId = crypto.randomUUID();
      const artifactPath = path.join(cwd, `${sessionId}.jsonl`);
      fs.writeFileSync(artifactPath, JSON.stringify({ type: "user", message: input.prompt }) + "\n");
      effects.push(`first-prompt:${input.prompt}`);
      const settled = input.registry.settleSpawn(input.receipt.launchId, {
        key: { engine: input.engine, sessionId },
        artifactPath,
        cwd: input.spec.cwd,
        accountId: input.account.accountId,
        launchProfile: input.spec.launchProfile,
        status: "starting",
        host: null,
        claimEpoch: 0,
        claimOwner: null,
        pendingAction: null,
      });
      if (settled.kind !== "settled") throw new Error("account replay settlement conflicted");
      return {
        ok: true as const,
        target: null,
        path: artifactPath,
        launchId: input.receipt.launchId,
        conversationId: input.receipt.conversationId,
        launched: true,
        retrySafe: false,
        initialMessage: "delivered" as const,
        state: "settled" as const,
      };
    },
  } as SpawnRouteTestDependencies;
  const previousTransport = process.env.LLV_SPAWN_TRANSPORT;
  const previousHosts = process.env.LLV_STRUCTURED_HOSTS;
  const previousEvents = process.env.LLV_RUNTIME_EVENTS;
  const previousSocket = process.env.LLV_RUNTIME_HOST_SOCKET;
  const previousUi = process.env.NEXT_PUBLIC_RUNTIME_UI;
  process.env.LLV_SPAWN_TRANSPORT = "structured";
  process.env.LLV_STRUCTURED_HOSTS = "1";
  process.env.LLV_RUNTIME_EVENTS = "1";
  process.env.LLV_RUNTIME_HOST_SOCKET = path.join(cwd, "runtime.sock");
  process.env.NEXT_PUBLIC_RUNTIME_UI = "1";
  const alternateCwd = fs.mkdtempSync(path.join(routeSandbox, "account-rotation-conflict-"));
  const alternateParent = store.ensureConversation("claude", path.join(cwd, "alternate-parent.jsonl"), "account-a");
  const request = (overrides: Record<string, unknown> = {}) => new NextRequest("http://127.0.0.1:8898/api/spawn", {
    method: "POST",
    headers: {
      host: "127.0.0.1:8898",
      origin: "http://127.0.0.1:8898",
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      engine: "claude",
      cwd,
      prompt: "repair release",
      clientAttemptId: "account_rotation_replay_20260717_a1",
      ...overrides,
    }),
  });
  try {
    const admitted = await POST.withDependencies(request(), dependencies);
    const admittedBody = await admitted.json();
    expect(admitted.status).toBe(202);
    expect(store.spawnReceiptForClientAttempt("account_rotation_replay_20260717_a1")).toMatchObject({
      launchId: admittedBody.launchId,
      accountId: "account-a",
    });
    routedAccountId = "account-b";

    const replay = await POST.withDependencies(request(), dependencies);
    expect(accountResolutions).toEqual(["healthy:account-a", "exact:account-a"]);
    expect(replay.status).toBe(202);
    expect(await replay.json()).toMatchObject({
      launchId: admittedBody.launchId,
      conversationId: admittedBody.conversationId,
      state: "starting",
    });

    const changedRequests = [
      request({ prompt: "changed release scope" }),
      request({ model: "opus" }),
      request({ effort: "high" }),
      request({ cwd: alternateCwd }),
      request({ engine: "codex" }),
      request({ parentConversationId: alternateParent.id }),
      request({ accountId: "account-b" }),
      request({ images: [{ mime: "image/png", base64: "eA==" }] }),
    ];
    for (const changedRequest of changedRequests) {
      const conflict = await POST.withDependencies(changedRequest, dependencies);
      expect(conflict.status).toBe(409);
    }

    expect(deferred).toHaveLength(1);
    await Promise.all(deferred.map((work) => work()));
    expect(effects).toEqual(["worker:account-a", "first-prompt:repair release"]);
    expect(store.snapshot().receipts[admittedBody.launchId]).toMatchObject({
      accountId: "account-a",
      state: "completed",
    });
  } finally {
    if (previousTransport === undefined) delete process.env.LLV_SPAWN_TRANSPORT;
    else process.env.LLV_SPAWN_TRANSPORT = previousTransport;
    if (previousHosts === undefined) delete process.env.LLV_STRUCTURED_HOSTS;
    else process.env.LLV_STRUCTURED_HOSTS = previousHosts;
    if (previousEvents === undefined) delete process.env.LLV_RUNTIME_EVENTS;
    else process.env.LLV_RUNTIME_EVENTS = previousEvents;
    if (previousSocket === undefined) delete process.env.LLV_RUNTIME_HOST_SOCKET;
    else process.env.LLV_RUNTIME_HOST_SOCKET = previousSocket;
    if (previousUi === undefined) delete process.env.NEXT_PUBLIC_RUNTIME_UI;
    else process.env.NEXT_PUBLIC_RUNTIME_UI = previousUi;
  }
});

test("structured spawn flag reaches the pane-less capability gate", async () => {
  const cwd = fs.mkdtempSync(path.join(routeSandbox, "structured-smoke-"));
  const previousTransport = process.env.LLV_SPAWN_TRANSPORT;
  const previousHosts = process.env.LLV_STRUCTURED_HOSTS;
  process.env.LLV_SPAWN_TRANSPORT = "structured";
  process.env.LLV_STRUCTURED_HOSTS = "0";
  try {
    const response = await POST(new NextRequest("http://127.0.0.1:8898/api/spawn", {
      method: "POST",
      headers: {
        host: "127.0.0.1:8898",
        origin: "http://127.0.0.1:8898",
        "sec-fetch-site": "same-origin",
        "content-type": "application/json",
      },
      body: JSON.stringify({ engine: "codex", cwd, prompt: "smoke" }),
    }));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "structured spawn requires LLV_STRUCTURED_HOSTS=1" });
  } finally {
    if (previousTransport === undefined) delete process.env.LLV_SPAWN_TRANSPORT;
    else process.env.LLV_SPAWN_TRANSPORT = previousTransport;
    if (previousHosts === undefined) delete process.env.LLV_STRUCTURED_HOSTS;
    else process.env.LLV_STRUCTURED_HOSTS = previousHosts;
  }
});

async function runDeferred(work: (() => Promise<void>) | null): Promise<void> {
  if (work) await work();
}

test("text-only Codex models reject images before blob and receipt mutation", async () => {
  const cwd = fs.mkdtempSync(path.join(routeSandbox, "codex-text-only-image-"));
  const previous = {
    transport: process.env.LLV_SPAWN_TRANSPORT,
    hosts: process.env.LLV_STRUCTURED_HOSTS,
    events: process.env.LLV_RUNTIME_EVENTS,
    socket: process.env.LLV_RUNTIME_HOST_SOCKET,
    ui: process.env.NEXT_PUBLIC_RUNTIME_UI,
  };
  process.env.LLV_SPAWN_TRANSPORT = "structured";
  process.env.LLV_STRUCTURED_HOSTS = "1";
  process.env.LLV_RUNTIME_EVENTS = "1";
  process.env.LLV_RUNTIME_HOST_SOCKET = path.join(cwd, "runtime.sock");
  process.env.NEXT_PUBLIC_RUNTIME_UI = "1";
  let storageCalled = false;
  const dependencies = {
    ...structuredRouteDependencies(cwd),
    storeImages: () => {
      storageCalled = true;
      return [];
    },
  };
  const beforeReceipts = Object.keys(agentRegistry().snapshot().receipts).sort();
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489", "hex").toString("base64");
  try {
    const response = await POST.withDependencies(new NextRequest("http://127.0.0.1:8898/api/spawn", {
      method: "POST",
      headers: {
        host: "127.0.0.1:8898",
        origin: "http://127.0.0.1:8898",
        "sec-fetch-site": "same-origin",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        engine: "codex",
        model: "gpt-5.3-codex-spark",
        cwd,
        prompt: "inspect",
        images: [{ base64: png, mime: "image/png" }],
      }),
    }), dependencies);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "The selected Codex model does not advertise image input through app-server.",
    });
    expect(storageCalled).toBeFalse();
    expect(Object.keys(agentRegistry().snapshot().receipts).sort()).toEqual(beforeReceipts);
  } finally {
    if (previous.transport === undefined) delete process.env.LLV_SPAWN_TRANSPORT;
    else process.env.LLV_SPAWN_TRANSPORT = previous.transport;
    if (previous.hosts === undefined) delete process.env.LLV_STRUCTURED_HOSTS;
    else process.env.LLV_STRUCTURED_HOSTS = previous.hosts;
    if (previous.events === undefined) delete process.env.LLV_RUNTIME_EVENTS;
    else process.env.LLV_RUNTIME_EVENTS = previous.events;
    if (previous.socket === undefined) delete process.env.LLV_RUNTIME_HOST_SOCKET;
    else process.env.LLV_RUNTIME_HOST_SOCKET = previous.socket;
    if (previous.ui === undefined) delete process.env.NEXT_PUBLIC_RUNTIME_UI;
    else process.env.NEXT_PUBLIC_RUNTIME_UI = previous.ui;
  }
});

test("admitted structured spawn returns its reserved card identity while host binding is delayed", async () => {
  const cwd = fs.mkdtempSync(path.join(routeSandbox, "p0-282-delayed-binding-"));
  const previousTransport = process.env.LLV_SPAWN_TRANSPORT;
  const previousHosts = process.env.LLV_STRUCTURED_HOSTS;
  const previousEvents = process.env.LLV_RUNTIME_EVENTS;
  const previousSocket = process.env.LLV_RUNTIME_HOST_SOCKET;
  const previousUi = process.env.NEXT_PUBLIC_RUNTIME_UI;
  process.env.LLV_SPAWN_TRANSPORT = "structured";
  process.env.LLV_STRUCTURED_HOSTS = "1";
  process.env.LLV_RUNTIME_EVENTS = "1";
  process.env.LLV_RUNTIME_HOST_SOCKET = path.join(cwd, "runtime.sock");
  process.env.NEXT_PUBLIC_RUNTIME_UI = "1";
  let deferred: (() => Promise<void>) | null = null;
  let releaseBinding!: () => void;
  const binding = new Promise<void>((resolve) => { releaseBinding = resolve; });
  let launchStarted = false;
  let publishedArtifacts = 0;
  const dependencies = {
    ...structuredRouteDependencies(cwd),
    defer: (work: () => Promise<void>) => { deferred = work; },
    publishFilesRevision: async () => {
      publishedArtifacts += 1;
    },
    spawnStructuredConversation: async (input: Parameters<NonNullable<Parameters<typeof POST.withDependencies>[1]>["spawnStructuredConversation"]>[0]) => {
      launchStarted = true;
      await binding;
      const artifactPath = path.join(cwd, "delayed.jsonl");
      fs.writeFileSync(artifactPath, JSON.stringify({ type: "user", message: input.prompt }) + "\n");
      return {
        ok: true as const,
        target: null,
        path: artifactPath,
        launchId: input.receipt.launchId,
        conversationId: input.receipt.conversationId,
        launched: true,
        retrySafe: false,
        initialMessage: "delivered" as const,
        state: "settled" as const,
      };
    },
  } as Parameters<typeof POST.withDependencies>[1];
  try {
    const responsePromise = POST.withDependencies(new NextRequest("http://127.0.0.1:8898/api/spawn", {
      method: "POST",
      headers: {
        host: "127.0.0.1:8898",
        origin: "http://127.0.0.1:8898",
        "sec-fetch-site": "same-origin",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        engine: "claude",
        cwd,
        prompt: "Own issue #282",
        clientAttemptId: "p0_282_spawn_visibility_20260716_a1",
      }),
    }), dependencies);
    const response = await Promise.race([
      responsePromise,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 25)),
    ]);

    releaseBinding();
    if (!response) await responsePromise;

    expect(response).not.toBeNull();
    expect(response?.status).toBe(202);
    expect(await response?.json()).toMatchObject({
      ok: true,
      state: "starting",
      launched: false,
      retrySafe: false,
      launchId: expect.any(String),
      conversationId: expect.stringMatching(/^conversation_/),
      initialMessage: "pending",
    });
    expect(launchStarted).toBeFalse();
    expect(deferred).not.toBeNull();
    await runDeferred(deferred);
    expect(launchStarted).toBeTrue();
    expect(publishedArtifacts).toBe(1);
  } finally {
    releaseBinding();
    if (previousTransport === undefined) delete process.env.LLV_SPAWN_TRANSPORT;
    else process.env.LLV_SPAWN_TRANSPORT = previousTransport;
    if (previousHosts === undefined) delete process.env.LLV_STRUCTURED_HOSTS;
    else process.env.LLV_STRUCTURED_HOSTS = previousHosts;
    if (previousEvents === undefined) delete process.env.LLV_RUNTIME_EVENTS;
    else process.env.LLV_RUNTIME_EVENTS = previousEvents;
    if (previousSocket === undefined) delete process.env.LLV_RUNTIME_HOST_SOCKET;
    else process.env.LLV_RUNTIME_HOST_SOCKET = previousSocket;
    if (previousUi === undefined) delete process.env.NEXT_PUBLIC_RUNTIME_UI;
    else process.env.NEXT_PUBLIC_RUNTIME_UI = previousUi;
  }
});

test("a terminal structured replay returns its reserved identity and retry-safe message outcome", async () => {
  const cwd = fs.mkdtempSync(path.join(routeSandbox, "p0-282-terminal-replay-"));
  const previousTransport = process.env.LLV_SPAWN_TRANSPORT;
  const previousHosts = process.env.LLV_STRUCTURED_HOSTS;
  const previousEvents = process.env.LLV_RUNTIME_EVENTS;
  const previousSocket = process.env.LLV_RUNTIME_HOST_SOCKET;
  const previousUi = process.env.NEXT_PUBLIC_RUNTIME_UI;
  process.env.LLV_SPAWN_TRANSPORT = "structured";
  process.env.LLV_STRUCTURED_HOSTS = "1";
  process.env.LLV_RUNTIME_EVENTS = "1";
  process.env.LLV_RUNTIME_HOST_SOCKET = path.join(cwd, "runtime.sock");
  process.env.NEXT_PUBLIC_RUNTIME_UI = "1";
  let deferred: (() => Promise<void>) | null = null;
  const dependencies = {
    ...structuredRouteDependencies(cwd),
    defer: (work: () => Promise<void>) => { deferred = work; },
    spawnStructuredConversation: async (input: Parameters<NonNullable<Parameters<typeof POST.withDependencies>[1]>["spawnStructuredConversation"]>[0]) => {
      input.registry.failStructuredSpawn(input.receipt.launchId, "structured host ownership is unavailable");
      throw new Error("structured host ownership is unavailable");
    },
  } as Parameters<typeof POST.withDependencies>[1];
  const request = () => new NextRequest("http://127.0.0.1:8898/api/spawn", {
    method: "POST",
    headers: {
      host: "127.0.0.1:8898",
      origin: "http://127.0.0.1:8898",
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      engine: "claude",
      cwd,
      prompt: "Own issue #282",
      clientAttemptId: "p0_282_terminal_replay_20260716_a1",
    }),
  });
  try {
    const admitted = await POST.withDependencies(request(), dependencies);
    const admittedBody = await admitted.json();
    await runDeferred(deferred);

    const replay = await POST.withDependencies(request(), dependencies);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({
      ok: true,
      target: null,
      path: null,
      effectivePermissionMode: "bypassPermissions",
      launchId: admittedBody.launchId,
      conversationId: admittedBody.conversationId,
      launched: false,
      retrySafe: true,
      initialMessage: "failed",
      state: "failed",
      error: "structured host ownership is unavailable",
    });
  } finally {
    if (previousTransport === undefined) delete process.env.LLV_SPAWN_TRANSPORT;
    else process.env.LLV_SPAWN_TRANSPORT = previousTransport;
    if (previousHosts === undefined) delete process.env.LLV_STRUCTURED_HOSTS;
    else process.env.LLV_STRUCTURED_HOSTS = previousHosts;
    if (previousEvents === undefined) delete process.env.LLV_RUNTIME_EVENTS;
    else process.env.LLV_RUNTIME_EVENTS = previousEvents;
    if (previousSocket === undefined) delete process.env.LLV_RUNTIME_HOST_SOCKET;
    else process.env.LLV_RUNTIME_HOST_SOCKET = previousSocket;
    if (previousUi === undefined) delete process.env.NEXT_PUBLIC_RUNTIME_UI;
    else process.env.NEXT_PUBLIC_RUNTIME_UI = previousUi;
  }
});

test("a clientAttemptId replay recovers the reserved card from runtime evidence", async () => {
  const cwd = fs.mkdtempSync(path.join(routeSandbox, "p0-282-runtime-replay-"));
  const previousTransport = process.env.LLV_SPAWN_TRANSPORT;
  const previousHosts = process.env.LLV_STRUCTURED_HOSTS;
  const previousEvents = process.env.LLV_RUNTIME_EVENTS;
  const previousSocket = process.env.LLV_RUNTIME_HOST_SOCKET;
  const previousUi = process.env.NEXT_PUBLIC_RUNTIME_UI;
  process.env.LLV_SPAWN_TRANSPORT = "structured";
  process.env.LLV_STRUCTURED_HOSTS = "1";
  process.env.LLV_RUNTIME_EVENTS = "1";
  process.env.LLV_RUNTIME_HOST_SOCKET = path.join(cwd, "runtime.sock");
  process.env.NEXT_PUBLIC_RUNTIME_UI = "1";
  const sessionId = crypto.randomUUID();
  const artifactPath = path.join(cwd, `${sessionId}.jsonl`);
  let deferred: (() => Promise<void>) | null = null;
  let admittedReceipt: Parameters<NonNullable<Parameters<typeof POST.withDependencies>[1]>["spawnStructuredConversation"]>[0]["receipt"] | null = null;
  const runtimeClient = {
    operationStatus: async (operationId: string) => admittedReceipt && operationId === `spawn_message_${admittedReceipt.launchId}` ? {
      receipt: {
        operationId,
        idempotencyKey: `spawn_${admittedReceipt.launchId}`,
        conversationId: admittedReceipt.conversationId,
        kind: "send" as const,
        status: "delivered" as const,
        at: new Date().toISOString(),
        revision: 2,
      },
      replayed: true,
    } : null,
    snapshot: async () => ({
      sessions: admittedReceipt ? [{
        conversationId: admittedReceipt.conversationId,
        sessionKey: { engine: "claude" as const, sessionId },
        hostKind: "claude-broker" as const,
        host: "hosted" as const,
        turn: "running" as const,
        provenance: "structured" as const,
        revision: 2,
        attentionIds: [],
        recentReceipts: [],
        accountId: "claude-test",
        parentConversationId: null,
        flowId: null,
        workflowId: null,
        cwd,
        artifactPath,
        capabilities: { steer: false, structuredAttention: true },
        activeTurnId: "turn-initial",
      }] : [],
    }),
  } as unknown as RuntimeHostClient;
  const dependencies = {
    ...structuredRouteDependencies(cwd),
    runtimeHostClient: () => runtimeClient,
    defer: (work: () => Promise<void>) => { deferred = work; },
    spawnStructuredConversation: async (input: Parameters<NonNullable<Parameters<typeof POST.withDependencies>[1]>["spawnStructuredConversation"]>[0]) => {
      admittedReceipt = input.receipt;
      input.registry.failStructuredSpawn(input.receipt.launchId, "host binding timed out");
      throw new Error("host binding timed out");
    },
  } as Parameters<typeof POST.withDependencies>[1];
  const request = () => new NextRequest("http://127.0.0.1:8898/api/spawn", {
    method: "POST",
    headers: {
      host: "127.0.0.1:8898",
      origin: "http://127.0.0.1:8898",
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      engine: "claude",
      cwd,
      prompt: "Own issue #282",
      clientAttemptId: "p0_282_runtime_route_replay_20260716_a1",
    }),
  });
  try {
    const admitted = await POST.withDependencies(request(), dependencies);
    const admittedBody = await admitted.json();
    await runDeferred(deferred);

    const replay = await POST.withDependencies(request(), dependencies);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      launchId: admittedBody.launchId,
      conversationId: admittedBody.conversationId,
      path: artifactPath,
      state: "settled",
      launched: true,
      retrySafe: false,
      initialMessage: "delivered",
    });
  } finally {
    if (previousTransport === undefined) delete process.env.LLV_SPAWN_TRANSPORT;
    else process.env.LLV_SPAWN_TRANSPORT = previousTransport;
    if (previousHosts === undefined) delete process.env.LLV_STRUCTURED_HOSTS;
    else process.env.LLV_STRUCTURED_HOSTS = previousHosts;
    if (previousEvents === undefined) delete process.env.LLV_RUNTIME_EVENTS;
    else process.env.LLV_RUNTIME_EVENTS = previousEvents;
    if (previousSocket === undefined) delete process.env.LLV_RUNTIME_HOST_SOCKET;
    else process.env.LLV_RUNTIME_HOST_SOCKET = previousSocket;
    if (previousUi === undefined) delete process.env.NEXT_PUBLIC_RUNTIME_UI;
    else process.env.NEXT_PUBLIC_RUNTIME_UI = previousUi;
  }
});

test("spawn route projects a launched path-pending receipt as a truthful success", () => {
  const store = registry();
  const begun = store.beginSpawnRequest({ engine: "codex", cwd: "/repo", accountId: "terra", clientAttemptId: "attempt_path_pending", requestDigest: "digest" });
  if (begun.kind !== "created") throw new Error("expected a new receipt");
  store.bindSpawnPane(begun.receipt.launchId, { endpoint: "/tmp", server: { pid: 9, startIdentity: "9:a" }, paneId: "%9", panePid: { pid: 99, startIdentity: "99:a" }, target: "agents:9.0" });
  expect(spawnResponseForReceipt(store.snapshot().receipts[begun.receipt.launchId]!)).toMatchObject({ launched: false, target: "%9" });
  store.markSpawnHostVerified(begun.receipt.launchId, {
    kind: "tmux", endpoint: "/tmp", server: { pid: 9, startIdentity: "9:a" }, paneId: "%9",
    panePid: { pid: 99, startIdentity: "99:a" }, windowName: "codex-new",
    agent: { pid: 100, startIdentity: "100:a" }, argv: ["codex"],
  });
  store.markSpawnPromptDelivered(begun.receipt.launchId);
  const pending = store.markSpawnPathPending(begun.receipt.launchId);

  expect(spawnResponseForReceipt(pending, null)).toMatchObject({
    ok: true,
    launched: true,
    retrySafe: false,
    state: "path-pending",
    path: null,
    target: "%9",
    launchId: begun.receipt.launchId,
    conversationId: begun.receipt.conversationId,
  });
});

test("a completed pane-less receipt replays as a launched structured conversation", () => {
  const store = registry();
  const pathname = `/sessions/${crypto.randomUUID()}.jsonl`;
  const begun = store.beginSpawnRequest({ engine: "codex", cwd: "/repo", accountId: "terra" });
  if (begun.kind !== "created") throw new Error("expected a new receipt");
  const settled = store.settleSpawn(begun.receipt.launchId, {
    key: { engine: "codex", sessionId: crypto.randomUUID() },
    artifactPath: pathname,
    cwd: "/repo",
    accountId: "terra",
    status: "idle",
    host: null,
    structuredHost: {
      kind: "codex-app-server",
      endpoint: "stdio:hosted",
      process: { pid: 10, startIdentity: "10:one" },
      eventCursor: 1,
      protocolVersion: "test",
      writerClaimEpoch: 1,
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 1,
    claimOwner: "structured-host:test",
    pendingAction: "spawn",
  });
  if (settled.kind !== "settled") throw new Error("expected a settled receipt");

  expect(spawnResponseForReceipt(settled.receipt, pathname, { structured: true })).toMatchObject({
    launched: true,
    target: null,
    path: pathname,
    state: "settled",
  });
});

test("a staged pane-less receipt replays with accepted status", () => {
  const response = {
    ok: true as const,
    target: null,
    path: "/sessions/pending.jsonl",
    launchId: "launch-pending",
    conversationId: "conversation_pending",
    launched: false,
    retrySafe: false,
    initialMessage: "queued" as const,
    state: "path-pending" as const,
  };

  expect(spawnReplayStatus(response, true)).toBe(202);
  expect(spawnReplayStatus(response, false)).toBe(200);
});

test("a pane-bound launch verification failure returns launched false with its teaching error", () => {
  const store = registry();
  const begun = store.beginSpawnRequest({ engine: "claude", cwd: "/repo", accountId: "botfatherdev-2" });
  if (begun.kind !== "created") throw new Error("expected a new receipt");
  store.bindSpawnPane(begun.receipt.launchId, { endpoint: "/tmp", server: { pid: 9, startIdentity: "9:a" }, paneId: "%9", panePid: { pid: 99, startIdentity: "99:a" }, target: "agents:9.0" });
  store.failSpawn(begun.receipt.launchId, "Claude account botfatherdev-2 needs re-login. Open Accounts, sign in, and retry.");

  expect(spawnResponseForReceipt(store.snapshot().receipts[begun.receipt.launchId]!)).toMatchObject({
    launched: false,
    state: "conflict",
    error: "Claude account botfatherdev-2 needs re-login. Open Accounts, sign in, and retry.",
  });
});

test("spawn route accepts an explicit stable parent conversation identity", () => {
  const store = registry();
  const parentPath = "/sessions/rollout-019f4906-3f67-7b72-9fbc-9ec3b5ad1326.jsonl";
  const parent = store.ensureConversation("codex", parentPath, "terra");

  expect(resolveSpawnParent({ parentConversationId: parent.id }, store)).toEqual({
    conversationId: parent.id,
    engine: "codex",
    artifactPath: parentPath,
    sessionKey: { engine: "codex", sessionId: "019f4906-3f67-7b72-9fbc-9ec3b5ad1326" },
  });
});

test("reviewer spawn requires one reviewed conversation and resolves its stable identity", () => {
  const store = registry();
  const implementerPath = "/sessions/rollout-019f4906-3f67-7b72-9fbc-9ec3b5ad1326.jsonl";
  const implementer = store.ensureConversation("codex", implementerPath, "terra");

  expect(() => resolveSpawnLineageParent({ role: "reviewer" }, store)).toThrow(SpawnParentError);
  expect(resolveSpawnLineageParent({ role: "reviewer", reviews: implementer.id }, store)).toEqual({
    conversationId: implementer.id,
    engine: "codex",
    artifactPath: implementerPath,
    sessionKey: { engine: "codex", sessionId: "019f4906-3f67-7b72-9fbc-9ec3b5ad1326" },
  });
  expect(() => resolveSpawnLineageParent({ role: "builder", reviews: implementer.id }, store)).toThrow(SpawnParentError);
});

test("reviewer lineage keeps the caller and reviewed implementer distinct", () => {
  const store = registry();
  const callerPath = "/sessions/caller-019f4906-3f67-7b72-9fbc-9ec3b5ad1325.jsonl";
  const implementerPath = "/sessions/implementer-019f4906-3f67-7b72-9fbc-9ec3b5ad1326.jsonl";
  const caller = store.ensureConversation("codex", callerPath, "terra");
  const implementer = store.ensureConversation("codex", implementerPath, "terra");

  const lineage = resolveSpawnLineage({ role: "reviewer", parentConversationId: caller.id, reviews: implementer.id }, store);

  expect(lineage.parent?.conversationId).toBe(caller.id);
  expect(lineage.reviewed?.conversationId).toBe(implementer.id);
});

test("operator lineage accepts src and keeps reviewer edges distinct", () => {
  const store = registry();
  const previousCodexHome = process.env.LLV_CODEX_HOME;
  const codexHome = path.join(routeSandbox, `codex-${crypto.randomUUID()}`);
  process.env.LLV_CODEX_HOME = codexHome;
  const sessions = codexSessionRoots()[0]!;
  const callerPath = path.join(sessions, "2026", "07", "14", `caller-${crypto.randomUUID()}.jsonl`);
  const implementerPath = path.join(sessions, "2026", "07", "14", `implementer-${crypto.randomUUID()}.jsonl`);
  fs.mkdirSync(path.dirname(callerPath), { recursive: true });
  fs.writeFileSync(callerPath, "{}\n");
  fs.writeFileSync(implementerPath, "{}\n");
  try {
    const operator = { kind: "operator", conversationId: null, liveChildrenCap: undefined } as const;
    const override = store.ensureConversation("codex", "/sessions/override.jsonl", "terra");
    const builder = resolveSpawnLineage(spawnLineageSelectorForCaller(operator, {
      src: callerPath,
      parent: implementerPath,
      role: "builder",
    }), store);
    const reviewer = resolveSpawnLineage(spawnLineageSelectorForCaller(operator, {
      src: callerPath,
      parentConversationId: override.id,
      role: "reviewer",
      reviews: implementerPath,
    }), store);

    expect(builder.parent?.artifactPath).toBe(callerPath);
    expect(reviewer.parent?.artifactPath).toBe(callerPath);
    expect(reviewer.reviewed?.artifactPath).toBe(implementerPath);
    expect(reviewer.parent?.conversationId).not.toBe(reviewer.reviewed?.conversationId);
    const browserBody = { src: callerPath, parentConversationId: override.id, role: "builder" };
    expect(spawnLineageSelectorForCaller(null, browserBody)).toBe(browserBody);
  } finally {
    if (previousCodexHome === undefined) delete process.env.LLV_CODEX_HOME;
    else process.env.LLV_CODEX_HOME = previousCodexHome;
  }
});

test("operator caller can reserve more than the ordinary live-child cap", () => {
  const store = registry();
  const parent = store.ensureConversation("codex", "/sessions/operator-parent.jsonl", "terra");
  const operator = { kind: "operator", conversationId: null, liveChildrenCap: undefined } as const;
  const reservations = Array.from({ length: 4 }, () => store.beginSpawnRequest({
    engine: "codex",
    cwd: "/repo",
    parentConversationId: parent.id,
    role: "builder",
    liveChildrenCap: operator.liveChildrenCap,
  }));

  expect(reservations.every((reservation) => reservation.kind === "created")).toBe(true);
  expect(Object.values(store.snapshot().lineageEdges).filter((edge) => edge.parentConversationId === parent.id)).toHaveLength(4);
});

function digestForParent(body: { parentConversationId: string }): string {
  return spawnRequestDigest({
    engine: "codex",
    cwd: "/repo",
    model: "gpt-test",
    effort: "high",
    fast: false,
    accountId: "terra",
    role: "worker",
    parent: spawnParentSelector(body),
    prompt: "implement",
    images: [],
  });
}

test("spawn replay keeps its identity after parent succession", () => {
  const store = registry();
  const firstParentPath = "/sessions/parent-019f4906-3f67-7b72-9fbc-9ec3b5ad1326.jsonl";
  const secondParentPath = "/sessions/parent-019f4906-3f67-7b72-9fbc-9ec3b5ad1327.jsonl";
  const parent = store.ensureConversation("codex", firstParentPath, "terra");
  const body = { parentConversationId: parent.id };
  const firstEvidence = resolveSpawnParent(body, store)!;
  const digest = digestForParent(body);
  const first = store.beginSpawnRequest({
    engine: "codex",
    cwd: "/repo",
    accountId: "terra",
    clientAttemptId: "attempt_parent_succession",
    requestDigest: digest,
    parentConversationId: firstEvidence.conversationId,
    parentSessionKey: firstEvidence.sessionKey,
    parentArtifactPath: firstEvidence.artifactPath,
  });
  if (first.kind !== "created") throw new Error("expected create");
  const resumed = store.beginSpawnRequest({
    engine: "codex",
    cwd: "/repo",
    accountId: "terra",
    conversationId: parent.id,
    purpose: "resume-successor",
  });
  if (resumed.kind !== "created") throw new Error("expected resume receipt");
  expect(store.settleSpawn(resumed.receipt.launchId, {
    key: { engine: "codex", sessionId: "019f4906-3f67-7b72-9fbc-9ec3b5ad1327" },
    artifactPath: secondParentPath,
    cwd: "/repo",
    accountId: "terra",
    status: "unhosted",
    host: null,
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: null,
  })).toMatchObject({ kind: "settled" });
  const secondEvidence = resolveSpawnParent(body, store)!;

  expect(secondEvidence.artifactPath).toBe(secondParentPath);
  expect(store.beginSpawnRequest({
    engine: "codex",
    cwd: "/repo",
    accountId: "terra",
    clientAttemptId: "attempt_parent_succession",
    requestDigest: digestForParent(body),
    parentConversationId: secondEvidence.conversationId,
    parentSessionKey: secondEvidence.sessionKey,
    parentArtifactPath: secondEvidence.artifactPath,
  })).toMatchObject({ kind: "replay", receipt: { launchId: first.receipt.launchId } });
  expect(store.snapshot().lineageEdges[first.receipt.conversationId]).toMatchObject({
    parentArtifactPath: firstParentPath,
    parentSessionKey: firstEvidence.sessionKey,
  });
});

test("spawn replay keeps its identity after parent alias adoption", () => {
  const store = registry();
  const sourcePath = "/sessions/source-019f4906-3f67-7b72-9fbc-9ec3b5ad1326.jsonl";
  const provisionalPath = "/sessions/provisional-019f4906-3f67-7b72-9fbc-9ec3b5ad1327.jsonl";
  const canonical = store.ensureConversation("codex", sourcePath, "terra");
  store.reconcileConversations([{
    engine: "codex",
    path: provisionalPath,
    accountId: "work",
    launchProfile: emptyLaunchProfile({ cwd: "/repo" }),
    turn: { state: "idle", source: "empty", terminalAt: null },
    observedAt: "2026-07-12T12:00:00.000Z",
  }]);
  const provisional = store.conversationForPath(provisionalPath)!;
  const body = { parentConversationId: provisional.id };
  const firstEvidence = resolveSpawnParent(body, store)!;
  const digest = digestForParent(body);
  const first = store.beginSpawnRequest({
    engine: "codex",
    cwd: "/repo",
    accountId: "terra",
    clientAttemptId: "attempt_parent_alias",
    requestDigest: digest,
    parentConversationId: firstEvidence.conversationId,
    parentSessionKey: firstEvidence.sessionKey,
    parentArtifactPath: firstEvidence.artifactPath,
  });
  if (first.kind !== "created") throw new Error("expected create");
  const migration = store.beginSpawnRequest({
    engine: "codex",
    cwd: "/repo",
    accountId: "work",
    conversationId: canonical.id,
    purpose: "migration-successor",
    expectedArtifactPath: provisionalPath,
  });
  if (migration.kind !== "created") throw new Error("expected migration receipt");
  expect(store.settleSpawn(migration.receipt.launchId, {
    key: { engine: "codex", sessionId: "019f4906-3f67-7b72-9fbc-9ec3b5ad1327" },
    artifactPath: provisionalPath,
    cwd: "/repo",
    accountId: "work",
    status: "unhosted",
    host: null,
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: null,
  })).toMatchObject({ kind: "settled" });
  const secondEvidence = resolveSpawnParent(body, store)!;

  expect(secondEvidence.conversationId).toBe(canonical.id);
  expect(store.beginSpawnRequest({
    engine: "codex",
    cwd: "/repo",
    accountId: "terra",
    clientAttemptId: "attempt_parent_alias",
    requestDigest: digestForParent(body),
    parentConversationId: secondEvidence.conversationId,
    parentSessionKey: secondEvidence.sessionKey,
    parentArtifactPath: secondEvidence.artifactPath,
  })).toMatchObject({ kind: "replay", receipt: { launchId: first.receipt.launchId } });
});
