import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { NextRequest } from "next/server";

import { createSpawnAttempt, spawnRequestBody } from "@/components/draftSpawn";
import { agentRegistry, AgentRegistry } from "@/lib/agent/registry";
import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { codexSessionRoots, createManagedCodexAccount } from "@/lib/accounts/codex";
import { NoHealthyClaudeAccountError } from "@/lib/accounts/spawnHealth";
import { spawnParentSelector, spawnRequestDigest, spawnRequestDigests } from "@/lib/agent/spawnIdentity";
import { projectLaunchConversations } from "@/lib/agent/spawnProjection";
import { rotateOperatorSpawnCapability } from "@/lib/agent/operatorCapability";
import { spawnReplayStatus, spawnResponseForReceipt } from "@/lib/agent/spawnResponse";
import { resolveSpawnLineage, resolveSpawnLineageParent, resolveSpawnParent, SpawnParentError } from "@/lib/agent/spawnParent";
import { RuntimeHostUnavailableError, type RuntimeHostClient } from "@/lib/runtime/client";
import { recoverPendingStructuredSpawns, terminalizeStaleStructuredSpawns } from "@/lib/runtime/structuredSpawn";
import { StructuredRuntimeRequirementError } from "@/lib/proc/darwinIdentity";
import { executeOrchestratorSeatRequest, type SeatCommandDependencies } from "@/lib/orchestrator/seatCommand";
import { authenticatedAgentSpawnCaller, isAgentInitiatedSpawn, spawnLineageSelectorForCaller } from "./admission";
import { POST } from "./route";

const previousStateDir = process.env.LLV_STATE_DIR;
const routeSandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-spawn-route-tests-"));

beforeAll(() => {
  process.env.LLV_STATE_DIR = path.join(routeSandbox, "state");
});

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
    resolvePinnedSpawnAdmission: async () => ({
      kind: "admissible",
      basis: "current",
      stale: false,
      retryAt: null,
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

test("spawn admission rejects malformed MCP allowlists", async () => {
  const response = await POST.withDependencies(new NextRequest("http://127.0.0.1/api/spawn", {
    method: "POST",
    headers: { origin: "http://127.0.0.1", host: "127.0.0.1", "content-type": "application/json", "sec-fetch-site": "same-origin" },
    body: JSON.stringify({ title: "Test semantic spawn", engine: "codex", cwd: routeSandbox, prompt: "inspect", mcpServers: "viewer" }),
  }), structuredRouteDependencies(routeSandbox));

  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "mcpServers must be an array of non-empty server names" });
});

test("spawn admission rejects an explicit model outside the selected engine catalog", async () => {
  const response = await POST.withDependencies(new NextRequest("http://127.0.0.1/api/spawn", {
    method: "POST",
    headers: { origin: "http://127.0.0.1", host: "127.0.0.1", "content-type": "application/json", "sec-fetch-site": "same-origin" },
    body: JSON.stringify({ engine: "codex", model: "gpt-5.6-codex", cwd: routeSandbox, prompt: "inspect" }),
  }), structuredRouteDependencies(routeSandbox));

  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({
    error: "invalid codex model id \"gpt-5.6-codex\"; valid codex model ids: gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna",
  });
});

test("direct spawn records one durable operator gesture while MCP service spawn records none", async () => {
  const { internalServiceHeaders } = await import("@/lib/agent/operatorAuthority");
  const cwd = fs.mkdtempSync(path.join(routeSandbox, "operator-spawn-activity-"));
  const store = new AgentRegistry(path.join(cwd, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  const recorded = new Map<string, unknown>();
  const dependencies = {
    ...structuredRouteDependencies(cwd),
    registry: () => store,
    defer: () => {},
    recordOperatorActivity: (input: { idempotencyKey?: string }) => {
      recorded.set(input.idempotencyKey ?? "", input);
      return { key: "b".repeat(64), engine: "claude" as const, project: "project-fixture", atMs: 1 };
    },
  };
  const post = async (clientAttemptId: string | undefined, headers: Record<string, string> = {}) => POST.withDependencies(new NextRequest(
    "http://127.0.0.1/api/spawn",
    {
      method: "POST",
      headers: {
        host: "127.0.0.1",
        origin: "http://127.0.0.1",
        "sec-fetch-site": "same-origin",
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify({
        /* #916 landed on main while this lane was open: every new spawn now
           needs an explicit semantic title, and this fixture is about the
           gesture ledger, not title derivation. */
        title: "claude · audit the operator gesture ledger",
        engine: "claude",
        cwd,
        ["prompt"]: "inspect",
        ...(clientAttemptId ? { clientAttemptId } : {}),
      }),
    },
  ), dependencies);

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
  try {
    const idlessDirect = await post(undefined);
    const direct = await post("operator_spawn_gesture_20260815");
    const replay = await post("operator_spawn_gesture_20260815");
    const mcp = await post(undefined, internalServiceHeaders("mcp"));

    expect([idlessDirect.status, direct.status, replay.status, mcp.status]).toEqual([400, 202, 202, 202]);
    expect(await idlessDirect.json()).toEqual({ error: "clientAttemptId is required for direct operator spawn" });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      const envKey = ({ transport: "LLV_SPAWN_TRANSPORT", hosts: "LLV_STRUCTURED_HOSTS", events: "LLV_RUNTIME_EVENTS", socket: "LLV_RUNTIME_HOST_SOCKET", ui: "NEXT_PUBLIC_RUNTIME_UI" } as const)[key as keyof typeof previous];
      if (value === undefined) delete process.env[envKey];
      else process.env[envKey] = value;
    }
  }
  expect([...recorded.values()]).toEqual([expect.objectContaining({
    idempotencyKey: "spawn:operator_spawn_gesture_20260815",
    resolvedAttribution: expect.objectContaining({ engine: "claude" }),
  })]);
});

test("new semantic, empty, and image-only prompts require an explicit semantic title", async () => {
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489", "hex").toString("base64");
  const post = async (body: Record<string, unknown>) => POST.withDependencies(new NextRequest("http://127.0.0.1/api/spawn", {
    method: "POST",
    headers: { origin: "http://127.0.0.1", host: "127.0.0.1", "content-type": "application/json", "sec-fetch-site": "same-origin" },
    body: JSON.stringify({ title: undefined, engine: "claude", cwd: routeSandbox, ...body }),
  }), structuredRouteDependencies(routeSandbox));

  for (const body of [
    { prompt: "inspect the release" },
    { prompt: "" },
    { images: [{ base64: png, mime: "image/png" }] },
  ]) {
    const rejected = await post(body);
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toEqual({ error: "title is required for every new spawn" });
  }

  const punctuationOnly = await post({ title: "###", prompt: "inspect the release" });
  expect(punctuationOnly.status).toBe(400);
  expect(await punctuationOnly.json()).toEqual({ error: "title must be a semantic, non-placeholder string" });

  for (const title of [
    "Codex-session",
    "Claude/session",
    "Codex · session",
    "Claude: session",
    "Codex_session",
    "Claude_session",
    "Codex*session",
    "Claude#session",
    "Codex>session",
    "Claude~session",
  ]) {
    const placeholder = await post({ title, prompt: "inspect the release" });
    expect(placeholder.status).toBe(400);
    expect(await placeholder.json()).toEqual({ error: "title must be a semantic, non-placeholder string" });
  }
});

test("Viewer draft and per-project orchestrator seat pass public spawn admission", async () => {
  const cwd = fs.mkdtempSync(path.join(routeSandbox, "viewer-request-admission-"));
  const store = registry();
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
  try {
    const draftBody = spawnRequestBody(createSpawnAttempt("viewer_draft_admission_20260806", Date.now(), {
      title: "claude · inspect release readiness",
      engine: "claude",
      model: "sonnet",
      cwd,
      effort: "low",
      fast: null,
      accountId: "",
      ["prompt"]: "Inspect release readiness",
      images: [],
      src: "",
    }));
    const dependencies = { ...structuredRouteDependencies(cwd), registry: () => store };
    const admit = async (body: Record<string, unknown>) => {
      const response = await POST.withDependencies(new NextRequest("http://127.0.0.1/api/spawn", {
        method: "POST",
        headers: {
          origin: "http://127.0.0.1",
          host: "127.0.0.1",
          "content-type": "application/json",
          "sec-fetch-site": "same-origin",
        },
        body: JSON.stringify(body),
      }), dependencies);
      return { status: response.status, body: await response.json() as Record<string, unknown> };
    };
    expect((await admit(draftBody)).status).toBe(202);

    const seatDependencies: SeatCommandDependencies = {
      spawn: admit,
      deliver: async () => ({ ok: false, error: "unused" }),
      conversationTarget: () => null,
      projectTasks: () => [],
      summarizeHandoffs: async () => ({ kind: "fallback", reason: "unavailable" }),
      launchSettlement: () => ({ kind: "unknown" }),
      runtimeIdentity: () => ({ engine: null, model: null }),
      stampRegistryIdentity: () => {},
      now: () => "2026-08-25T00:00:00.000Z",
    };
    const orchestratorAttempt = "viewer_orchestrator_admission_20260825";
    const orchestrator = await executeOrchestratorSeatRequest({
      project: "viewer",
      mandate: "Inspect project delivery",
      clientRequestId: orchestratorAttempt,
      engine: "claude",
      model: "opus",
      effort: "low",
      cwd,
    }, seatDependencies);
    expect(orchestrator.status).toBe(202);
    expect(store.spawnReceiptForClientAttempt(orchestratorAttempt)?.launchProfile.title).toBe("orchestrator · Inspect project delivery");
  } finally {
    for (const [key, value] of Object.entries({
      LLV_SPAWN_TRANSPORT: previous.transport,
      LLV_STRUCTURED_HOSTS: previous.hosts,
      LLV_RUNTIME_EVENTS: previous.events,
      LLV_RUNTIME_HOST_SOCKET: previous.socket,
      NEXT_PUBLIC_RUNTIME_UI: previous.ui,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("an explicit spawn account is durably pinned while an omitted account uses the selected fallback", async () => {
  const cwd = fs.mkdtempSync(path.join(routeSandbox, "account-pin-"));
  const store = registry();
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
    const dependencies = {
      ...structuredRouteDependencies(cwd),
      registry: () => store,
      resolveHealthySpawnAccount: async (_engine: "claude" | "codex", requested?: string | null) => ({
        engine: "claude" as const,
        accountId: requested ?? "selected",
        kind: "managed" as const,
        home: path.join(cwd, requested ?? "selected"),
        transcriptRoot: path.join(cwd, "projects"),
        env: { NODE_ENV: "test" as const },
      }),
      defer: () => {},
    };
    const post = async (clientAttemptId: string, accountId?: string, title?: string) => await POST.withDependencies(new NextRequest("http://127.0.0.1/api/spawn", {
      method: "POST",
      headers: { origin: "http://127.0.0.1", host: "127.0.0.1", "content-type": "application/json", "sec-fetch-site": "same-origin" },
      body: JSON.stringify({ title: "Test semantic spawn", engine: "claude", model: "sonnet", cwd, prompt: "inspect", clientAttemptId, ...(accountId ? { accountId } : {}), ...(title ? { title } : {}) }),
    }), dependencies);

    const pinnedResponses = await Promise.all([
      post("account_pin_a_20260731", "pinned-a"),
      post("account_pin_b_20260731", "pinned-b"),
    ]);
    expect(pinnedResponses.map((response) => response.status)).toEqual([202, 202]);
    expect(store.spawnReceiptForClientAttempt("account_pin_a_20260731")).toMatchObject({
      accountId: "pinned-a",
      accountPin: true,
      launchProfile: expect.objectContaining({ title: "Test semantic spawn" }),
    });
    expect(store.spawnReceiptForClientAttempt("account_pin_b_20260731")).toMatchObject({
      accountId: "pinned-b",
      accountPin: true,
    });

    expect((await post("account_fallback_20260731", undefined, "Inspect account routing")).status).toBe(202);
    expect(store.spawnReceiptForClientAttempt("account_fallback_20260731")).toMatchObject({
      accountId: "selected",
      accountPin: false,
      launchProfile: expect.objectContaining({ title: "Inspect account routing" }),
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

test("derived, custom-title, and migrated generic receipts preserve pre-title replay", async () => {
  const cwd = fs.mkdtempSync(path.join(routeSandbox, "title-digest-replay-"));
  const store = registry();
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
  try {
    const post = async (activeStore: AgentRegistry, request: { clientAttemptId?: string; title?: string | null } = {}) => POST.withDependencies(new NextRequest("http://127.0.0.1/api/spawn", {
      method: "POST",
      headers: { origin: "http://127.0.0.1", host: "127.0.0.1", "content-type": "application/json", "sec-fetch-site": "same-origin" },
      body: JSON.stringify({
        engine: "claude",
        model: "sonnet",
        cwd,
        ["prompt"]: "inspect",
        clientAttemptId: request.clientAttemptId ?? "title_digest_replay_20260805",
        title: request.title === null ? undefined : request.title ?? "claude · inspect",
      }),
    }), {
      ...structuredRouteDependencies(cwd),
      registry: () => activeStore,
      defer: () => {},
    });

    const first = await post(store);
    const firstBody = await first.json();
    expect(first.status).toBe(202);
    const receipt = store.spawnReceiptForClientAttempt("title_digest_replay_20260805")!;
    const digests = spawnRequestDigests({
      engine: receipt.engine,
      cwd: receipt.cwd,
      model: receipt.launchProfile.model,
      effort: receipt.launchProfile.effort,
      fast: receipt.launchProfile.fast,
      accountId: receipt.accountId,
      role: null,
      title: receipt.launchProfile.title!,
      mcpServers: receipt.launchProfile.mcpServers,
      ...(receipt.launchProfile.plugins.length ? { plugins: receipt.launchProfile.plugins } : {}),
      parent: null,
      ["prompt"]: "inspect",
      images: [],
    });
    expect(receipt.launchProfile.title).toBe("claude · inspect");
    expect(receipt.requestDigest).toBe(digests.withoutTitle);
    const rollbackReplay = store.beginSpawnRequest({
      engine: receipt.engine,
      cwd: receipt.cwd,
      transport: receipt.transport,
      launchProfile: { permissionMode: receipt.launchProfile.permissionMode },
      clientAttemptId: receipt.clientAttemptId,
      requestDigest: digests.withoutTitle,
      accountPin: receipt.accountPin,
      explicitProject: receipt.explicitProject,
      supersedes: receipt.supersedes?.conversationId ?? null,
    });
    expect(rollbackReplay).toMatchObject({
      kind: "replay",
      receipt: { launchId: receipt.launchId },
    });

    const nullTitleAttemptId = "null_title_digest_replay_20260805";
    expect((await post(store, { clientAttemptId: nullTitleAttemptId })).status).toBe(202);
    const nullTitleReceipt = store.spawnReceiptForClientAttempt(nullTitleAttemptId)!;
    const nullTitlePath = path.join(cwd, "null-title-replay.jsonl");
    const nullTitleSessionId = crypto.randomUUID();
    const nullTitleSettlement = store.settleSpawn(nullTitleReceipt.launchId, {
      key: { engine: "claude", sessionId: nullTitleSessionId },
      artifactPath: nullTitlePath,
      cwd,
      accountId: nullTitleReceipt.accountId,
      launchProfile: nullTitleReceipt.launchProfile,
      status: "starting",
      host: null,
      claimEpoch: 0,
      claimOwner: null,
      pendingAction: "spawn",
    });
    if (nullTitleSettlement.kind === "conflict") throw new Error(nullTitleSettlement.code);
    const preTitle = store.snapshot();
    preTitle.receipts[nullTitleReceipt.launchId]!.launchProfile.title = null;
    preTitle.conversations[nullTitleReceipt.conversationId]!.generations.at(-1)!.launchProfile.title = null;
    const nullTitleEntry = Object.values(preTitle.entries)
      .find((entry) => entry.artifactPath === nullTitlePath);
    if (!nullTitleEntry?.launchProfile) throw new Error("settled null-title entry is missing");
    nullTitleEntry.launchProfile.title = null;
    fs.writeFileSync(store.filename, `${JSON.stringify(preTitle, null, 2)}\n`);

    const preTitleRestarted = new AgentRegistry(store.filename, undefined, undefined, { sqliteMode: "off" });
    expect((await post(preTitleRestarted, { clientAttemptId: nullTitleAttemptId, title: null })).status).toBe(200);
    expect(preTitleRestarted.spawnReceiptForClientAttempt(nullTitleAttemptId)?.launchProfile.title).toBe("claude · inspect");
    expect(preTitleRestarted.conversation(nullTitleReceipt.conversationId)?.generations.at(-1)?.launchProfile.title)
      .toBe("claude · inspect");
    expect(Object.values(preTitleRestarted.snapshot().entries)
      .find((entry) => entry.artifactPath === nullTitlePath)?.launchProfile?.title).toBe("claude · inspect");

    const customTitle = "Inspect issue #913 evidence";
    const customAttemptId = "custom_title_digest_replay_20260805";
    const customResponse = await post(store, { clientAttemptId: customAttemptId, title: customTitle });
    expect(customResponse.status).toBe(202);
    const customReceipt = store.spawnReceiptForClientAttempt(customAttemptId)!;
    expect(customReceipt.launchProfile.title).toBe(customTitle);
    const customDigests = spawnRequestDigests({
      engine: customReceipt.engine,
      cwd: customReceipt.cwd,
      model: customReceipt.launchProfile.model,
      effort: customReceipt.launchProfile.effort,
      fast: customReceipt.launchProfile.fast,
      accountId: customReceipt.accountId,
      role: null,
      title: customTitle,
      mcpServers: customReceipt.launchProfile.mcpServers,
      ...(customReceipt.launchProfile.plugins.length ? { plugins: customReceipt.launchProfile.plugins } : {}),
      parent: null,
      ["prompt"]: "inspect",
      images: [],
    });
    expect(customReceipt.requestDigest).toBe(customDigests.withoutTitle);
    expect(store.beginSpawnRequest({
      engine: customReceipt.engine,
      cwd: customReceipt.cwd,
      transport: customReceipt.transport,
      launchProfile: { permissionMode: customReceipt.launchProfile.permissionMode },
      clientAttemptId: customReceipt.clientAttemptId,
      requestDigest: customDigests.withoutTitle,
      accountPin: customReceipt.accountPin,
      explicitProject: customReceipt.explicitProject,
      supersedes: customReceipt.supersedes?.conversationId ?? null,
    })).toMatchObject({
      kind: "replay",
      receipt: { launchId: customReceipt.launchId },
    });
    const mismatchedTitle = await post(store, {
      clientAttemptId: customAttemptId,
      title: "Inspect unrelated evidence",
    });
    expect(mismatchedTitle.status).toBe(409);

    let accountResolutions = 0;
    let releaseAccounts = () => {};
    const accountBarrier = new Promise<void>((resolve) => { releaseAccounts = resolve; });
    const concurrentDependencies = {
      ...structuredRouteDependencies(cwd),
      registry: () => store,
      resolveHealthySpawnAccount: async () => {
        accountResolutions += 1;
        if (accountResolutions === 2) releaseAccounts();
        await accountBarrier;
        return {
          engine: "claude" as const,
          accountId: "claude-test",
          kind: "managed" as const,
          home: path.join(cwd, "account"),
          transcriptRoot: path.join(cwd, "projects"),
          env: { NODE_ENV: "test" as const },
        };
      },
      defer: () => {},
    } satisfies SpawnRouteTestDependencies;
    const concurrentAttemptId = "concurrent_title_digest_replay_20260805";
    const concurrentPost = (title: string) => POST.withDependencies(new NextRequest("http://127.0.0.1/api/spawn", {
      method: "POST",
      headers: { origin: "http://127.0.0.1", host: "127.0.0.1", "content-type": "application/json", "sec-fetch-site": "same-origin" },
      body: JSON.stringify({
        engine: "claude",
        model: "sonnet",
        cwd,
        ["prompt"]: "inspect",
        title,
        clientAttemptId: concurrentAttemptId,
      }),
    }), concurrentDependencies);
    const concurrentResponses = await Promise.all([
      concurrentPost("Inspect release branch"),
      concurrentPost("Inspect deployment branch"),
    ]);
    expect(concurrentResponses.map((response) => response.status).sort()).toEqual([202, 409]);

    const migratedFilename = `${crypto.randomUUID()}.jsonl`;
    const legacyPath = path.join(cwd, "legacy-projects", "-repo", migratedFilename);
    const sharedPath = path.join(cwd, "shared-projects", "-repo", migratedFilename);
    fs.mkdirSync(path.dirname(sharedPath), { recursive: true });
    fs.writeFileSync(sharedPath, "{}\n");
    const template = store.ensureConversation("claude", legacyPath, null);
    const legacy = store.snapshot();
    const reservedConversation = legacy.conversations[template.id]!;
    delete legacy.conversations[template.id];
    reservedConversation.id = receipt.conversationId;
    for (const generation of reservedConversation.generations) {
      generation.launchProfile.title = "Claude session";
    }
    legacy.conversations[receipt.conversationId] = reservedConversation;
    legacy.receipts[receipt.launchId]!.launchProfile.title = "Claude session";
    legacy.receipts[receipt.launchId]!.artifactPath = legacyPath;
    legacy.receipts[receipt.launchId]!.resumeSourcePath = legacyPath;
    fs.writeFileSync(store.filename, `${JSON.stringify(legacy, null, 2)}\n`);
    const restarted = new AgentRegistry(store.filename, undefined, undefined, { sqliteMode: "off" });
    expect(restarted.runIdentityWaveMigration({
      now: "2026-08-05T12:00:00.000Z",
      transcriptTitle: () => null,
      sharedPathForLegacy: (pathname) => pathname === legacyPath
        ? { sharedPath, identityEquivalent: true }
        : null,
      orchestratorSeats: [],
    })).toMatchObject({ retitled: 1, rekeyed: 1 });
    expect(restarted.spawnReceiptForClientAttempt("title_digest_replay_20260805")).toMatchObject({
      requestDigest: digests.withoutTitle,
      identityWaveTitleBackfill: true,
      launchProfile: expect.objectContaining({ title: "inspect" }),
    });
    const replay = await post(restarted, { title: null });

    expect(replay.status).toBe(202);
    expect(await replay.json()).toMatchObject({ launchId: firstBody.launchId, path: null });
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

test("an upgraded orchestrator retry accepts its pre-title receipt digest", async () => {
  const cwd = fs.mkdtempSync(path.join(routeSandbox, "orchestrator-title-digest-replay-"));
  const store = registry();
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
  try {
    const prompt = "Own the queued review work";
    const title = "orchestrator · Own the queued review work";
    const clientAttemptId = "orchestrator_title_replay_20260805";
    const post = async (activeStore: AgentRegistry) => POST.withDependencies(new NextRequest("http://127.0.0.1/api/spawn", {
      method: "POST",
      headers: {
        origin: "http://127.0.0.1",
        host: "127.0.0.1",
        "content-type": "application/json",
        "sec-fetch-site": "same-origin",
        "x-llv-spawn-capability": rotateOperatorSpawnCapability(),
      },
      body: JSON.stringify({
        engine: "claude",
        model: "sonnet",
        cwd,
        role: "orchestrator",
        project: "viewer",
        prompt,
        title,
        clientAttemptId,
      }),
    }), {
      ...structuredRouteDependencies(cwd),
      registry: () => activeStore,
      defer: () => {},
    });

    const first = await post(store);
    expect(first.status).toBe(202);
    const firstBody = await first.json();
    const receipt = store.spawnReceiptForClientAttempt(clientAttemptId)!;
    const digests = spawnRequestDigests({
      engine: receipt.engine,
      cwd: receipt.cwd,
      model: receipt.launchProfile.model,
      effort: receipt.launchProfile.effort,
      fast: receipt.launchProfile.fast,
      accountId: receipt.accountId,
      role: "orchestrator",
      title,
      mcpServers: receipt.launchProfile.mcpServers,
      ...(receipt.launchProfile.plugins.length ? { plugins: receipt.launchProfile.plugins } : {}),
      project: "viewer",
      parent: null,
      ["prompt"]: receipt.launchDisplay?.echo ?? prompt,
      images: [],
    });
    expect(receipt.requestDigest).toBe(digests.withoutTitle);
    const legacy = store.snapshot();
    fs.writeFileSync(store.filename, `${JSON.stringify(legacy, null, 2)}\n`);
    const restarted = new AgentRegistry(store.filename, undefined, undefined, { sqliteMode: "off" });

    const replay = await post(restarted);
    expect(replay.status).toBe(202);
    expect(await replay.json()).toMatchObject({
      launchId: firstBody.launchId,
      conversationId: firstBody.conversationId,
    });
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

test("a queued pinned account survives restart and launches exactly once on the pin after admission", async () => {
  const cwd = fs.mkdtempSync(path.join(routeSandbox, "account-pin-retry-"));
  const registryFile = path.join(cwd, "agent-registry.json");
  let store = new AgentRegistry(registryFile);
  const deferred: Array<() => Promise<void>> = [];
  const spawnedAccounts: string[] = [];
  let pinAdmissible = false;
  const retryAt = new Date(Date.now() + 60_000).toISOString();
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
  try {
    const account = (accountId: string) => ({
      engine: "claude" as const,
      accountId,
      kind: "managed" as const,
      home: path.join(cwd, accountId),
      transcriptRoot: path.join(cwd, accountId, "projects"),
      env: { NODE_ENV: "test" as const },
    });
    const dependencies = {
      ...structuredRouteDependencies(cwd),
      registry: () => store,
      resolveHealthySpawnAccount: async () => {
        throw new NoHealthyClaudeAccountError(["account-a"]);
      },
      resolveSpawnAccount: (_engine: "claude" | "codex", accountId: string | null) => account(accountId ?? "account-b"),
      resolvePinnedSpawnAdmission: async () => pinAdmissible
        ? {
            kind: "admissible" as const,
            basis: "current" as const,
            stale: false,
            retryAt: null,
          }
        : {
            kind: "retry-at" as const,
            reason: "hard-limit" as const,
            stale: false,
            retryAt,
          },
      defer: (work: () => Promise<void>) => { deferred.push(work); },
      spawnStructuredConversation: async (input: Parameters<SpawnRouteTestDependencies["spawnStructuredConversation"]>[0]) => {
        spawnedAccounts.push(input.account.accountId);
        const sessionId = crypto.randomUUID();
        const settled = input.registry.settleSpawn(input.receipt.launchId, {
          key: { engine: input.engine, sessionId },
          artifactPath: path.join(cwd, `${sessionId}.jsonl`),
          cwd,
          accountId: input.account.accountId,
          status: "starting",
          host: null,
          claimEpoch: 0,
          claimOwner: null,
          pendingAction: "spawn",
        });
        if (settled.kind !== "settled") throw new Error("expected queued settlement");
        return {
          ok: true as const,
          target: null,
          path: settled.entry.artifactPath,
          launchId: input.receipt.launchId,
          conversationId: settled.conversation.id,
          launched: true,
          retrySafe: false,
          initialMessage: "delivered" as const,
          state: "settled" as const,
        };
      },
    };
    const post = async () => await POST.withDependencies(new NextRequest("http://127.0.0.1/api/spawn", {
      method: "POST",
      headers: { origin: "http://127.0.0.1", host: "127.0.0.1", "content-type": "application/json", "sec-fetch-site": "same-origin" },
      body: JSON.stringify({
        title: "Continue queued account work",
        engine: "claude",
        model: "sonnet",
        cwd,
        ["prompt"]: "continue",
        accountId: "account-a",
        clientAttemptId: "account_pin_retry_20260823",
      }),
    }), dependencies);

    const response = await post();
    expect(response.status).toBe(202);
    const queued = await response.json();
    expect(queued).toMatchObject({ state: "starting", initialMessage: "queued" });
    expect(spawnedAccounts).toEqual([]);
    const receipt = store.spawnReceiptForClientAttempt("account_pin_retry_20260823")!;
    expect(receipt).toMatchObject({
      accountId: "account-a",
      accountPin: true,
      state: "starting",
      queuedPinnedSpawn: {
        version: 1,
        accountId: "account-a",
        retryAt,
        ["prompt"]: "continue",
      },
    });
    expect(receipt.launchProfile.title).toBe(`Pinned account quota is exhausted — queued until ${retryAt}`);
    expect(projectLaunchConversations([], store.snapshot(), Date.now()).cards[0]).toMatchObject({
      title: `Pinned account quota is exhausted — queued until ${retryAt}`,
      spawn: { accountId: "account-a", accountPin: true },
    });

    store = new AgentRegistry(registryFile);
    expect(store.spawnReceiptForClientAttempt("account_pin_retry_20260823")).toMatchObject({
      launchId: queued.launchId,
      conversationId: queued.conversationId,
      state: "starting",
      queuedPinnedSpawn: { retryAt, accountId: "account-a" },
    });
    expect(deferred).toHaveLength(0);
    expect(spawnedAccounts).toEqual([]);

    const recoveryClient = {
      effectBatch: async () => [],
      operationStatus: async () => null,
      snapshot: async () => ({ revision: 0, sessions: [] }),
      transitionOperation: async () => null,
    } as unknown as RuntimeHostClient;
    await recoverPendingStructuredSpawns(store, recoveryClient, {
      now: () => Date.parse(retryAt) - 1,
      resolveSpawnAccount: dependencies.resolveSpawnAccount,
      resolvePinnedSpawnAdmission: dependencies.resolvePinnedSpawnAdmission,
      spawnStructuredConversation: dependencies.spawnStructuredConversation,
    });
    expect(store.spawnReceiptForClientAttempt("account_pin_retry_20260823")).toMatchObject({
      state: "starting",
      admissionOwner: null,
      queuedPinnedSpawn: { retryAt },
    });
    expect(spawnedAccounts).toEqual([]);

    pinAdmissible = true;
    const recover = async () => await recoverPendingStructuredSpawns(store, recoveryClient, {
      now: () => Date.parse(retryAt) + 1,
      resolveSpawnAccount: dependencies.resolveSpawnAccount,
      resolvePinnedSpawnAdmission: dependencies.resolvePinnedSpawnAdmission,
      spawnStructuredConversation: dependencies.spawnStructuredConversation,
    });
    await Promise.all([recover(), recover()]);
    expect(spawnedAccounts).toEqual(["account-a"]);
    const settledReceipt = store.spawnReceiptForClientAttempt("account_pin_retry_20260823")!;
    const conversation = store.conversation(settledReceipt.conversationId)!;
    expect(conversation).toMatchObject({
      pinnedAccountId: "account-a",
      migration: null,
      generations: [expect.objectContaining({ accountId: "account-a" })],
    });
    expect(store.snapshot().entries[`claude:${settledReceipt.key!.sessionId}`]).toMatchObject({ accountId: "account-a" });

    store.setEngineRouting("claude", "account-c");
    expect(store.requestConversationMigrationToActiveAccount(conversation.id)).toMatchObject({
      pinnedAccountId: "account-a",
      migration: null,
      generations: [expect.objectContaining({ accountId: "account-a" })],
    });
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

test("queued pin recovery atomically refreshes a moved retry deadline and its card copy", async () => {
  const cwd = fs.mkdtempSync(path.join(routeSandbox, "account-pin-moved-retry-"));
  const registryFile = path.join(cwd, "agent-registry.json");
  const initialRetryAt = new Date(Date.now() + 60_000).toISOString();
  const movedRetryAt = new Date(Date.now() + 120_000).toISOString();
  const store = new AgentRegistry(registryFile);
  const begun = store.beginSpawnRequest({
    engine: "claude",
    cwd,
    transport: "structured",
    accountId: "account-a",
    accountPin: true,
    clientAttemptId: "account_pin_moved_retry_20260824",
    launchProfile: emptyLaunchProfile({ cwd, title: "Continue queued account work" }),
  });
  if (begun.kind !== "created") throw new Error("expected queued receipt creation");
  store.queuePinnedSpawn(begun.receipt.launchId, {
    version: 1,
    retryAt: initialRetryAt,
    accountId: "account-a",
    locale: "en",
    spec: {
      engine: "claude",
      command: "claude",
      cwd,
      windowName: "queued-pin",
      launchProfile: emptyLaunchProfile({ cwd, title: "Continue queued account work" }),
    },
    ["prompt"]: "continue",
    imageRefs: [],
    parentArtifactPath: null,
    pipelineSourceConversationId: null,
  }, `Pinned account quota is exhausted — queued until ${initialRetryAt}`);
  store.releaseStartingStructuredSpawn(begun.receipt.launchId, begun.receipt.admissionOwner!);

  const restarted = new AgentRegistry(registryFile);
  const recoveryClient = {
    effectBatch: async () => [],
    operationStatus: async () => null,
    snapshot: async () => ({ revision: 0, sessions: [] }),
    transitionOperation: async () => null,
  } as unknown as RuntimeHostClient;
  const tick = await terminalizeStaleStructuredSpawns(restarted, recoveryClient, {
    now: () => Date.parse(initialRetryAt) + 1,
    resolveSpawnAccount: () => ({
      engine: "claude",
      accountId: "account-a",
      kind: "managed",
      home: path.join(cwd, "account-a"),
      transcriptRoot: path.join(cwd, "account-a", "projects"),
      env: { NODE_ENV: "test" },
    }),
    resolvePinnedSpawnAdmission: async () => ({
      kind: "retry-at",
      reason: "hard-limit",
      stale: false,
      retryAt: movedRetryAt,
    }),
    spawnStructuredConversation: async () => {
      throw new Error("a moved retry deadline must remain queued");
    },
  });

  expect(tick).toEqual({ examined: 1, terminalized: [], recovered: [] });
  const refreshed = restarted.spawnReceiptForClientAttempt("account_pin_moved_retry_20260824")!;
  expect(refreshed).toMatchObject({
    state: "starting",
    admissionOwner: null,
    queuedPinnedSpawn: { retryAt: movedRetryAt, accountId: "account-a" },
  });
  expect(refreshed.launchProfile.title).toBe(`Pinned account quota is exhausted — queued until ${movedRetryAt}`);
  expect(projectLaunchConversations([], restarted.snapshot(), Date.parse(initialRetryAt) + 1).cards[0]?.title)
    .toBe(`Pinned account quota is exhausted — queued until ${movedRetryAt}`);
});

test("a queued payload write failure terminalizes without publishing a deadline-only card", async () => {
  const cwd = fs.mkdtempSync(path.join(routeSandbox, "account-pin-payload-failure-"));
  const store = new AgentRegistry(path.join(cwd, "agent-registry.json"));
  const retryAt = new Date(Date.now() + 60_000).toISOString();
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
  try {
    const account = {
      engine: "claude" as const,
      accountId: "account-a",
      kind: "managed" as const,
      home: path.join(cwd, "account-a"),
      transcriptRoot: path.join(cwd, "account-a", "projects"),
      env: { NODE_ENV: "test" as const },
    };
    const response = await POST.withDependencies(new NextRequest("http://127.0.0.1/api/spawn", {
      method: "POST",
      headers: { origin: "http://127.0.0.1", host: "127.0.0.1", "content-type": "application/json", "sec-fetch-site": "same-origin" },
      body: JSON.stringify({
        title: "Queue account payload",
        engine: "claude",
        model: "sonnet",
        cwd,
        ["prompt"]: "continue",
        accountId: "account-a",
        clientAttemptId: "account_pin_payload_failure_20260824",
      }),
    }), {
      ...structuredRouteDependencies(cwd),
      registry: () => store,
      resolveHealthySpawnAccount: async () => ({
        ...account,
        requestedAdmission: {
          kind: "retry-at" as const,
          reason: "hard-limit" as const,
          stale: false,
          retryAt,
        },
      }),
      resolveSpawnAccount: () => account,
      storeImages: () => { throw new Error("image store unavailable"); },
      defer: () => { throw new Error("a failed queue must not defer launch work"); },
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "image store unavailable" });
    expect(store.spawnReceiptForClientAttempt("account_pin_payload_failure_20260824")).toMatchObject({
      state: "failed",
      queuedPinnedSpawn: null,
      launchProfile: { title: "Queue account payload" },
    });
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

test("a retry-at tmux pin survives restart and actuates exactly once after its deadline", async () => {
  const cwd = fs.mkdtempSync(path.join(routeSandbox, "account-pin-tmux-retry-"));
  const registryFile = path.join(cwd, "agent-registry.json");
  let store = new AgentRegistry(registryFile);
  const retryAt = new Date(Date.now() + 60_000).toISOString();
  const previousTransport = process.env.LLV_SPAWN_TRANSPORT;
  process.env.LLV_SPAWN_TRANSPORT = "tmux";
  let tmuxStarts = 0;
  let pinAdmissible = false;
  try {
    const account = {
      engine: "claude" as const,
      accountId: "account-a",
      kind: "managed" as const,
      home: path.join(cwd, "account-a"),
      transcriptRoot: path.join(cwd, "account-a", "projects"),
      env: { NODE_ENV: "test" as const },
    };
    const response = await POST.withDependencies(new NextRequest("http://127.0.0.1/api/spawn", {
      method: "POST",
      headers: { origin: "http://127.0.0.1", host: "127.0.0.1", "content-type": "application/json", "sec-fetch-site": "same-origin" },
      body: JSON.stringify({
        title: "Continue queued tmux work",
        engine: "claude",
        model: "sonnet",
        cwd,
        ["prompt"]: "continue",
        accountId: "account-a",
        clientAttemptId: "account_pin_tmux_retry_20260823",
      }),
    }), {
      ...structuredRouteDependencies(cwd),
      registry: () => store,
      resolveHealthySpawnAccount: async () => ({
        ...account,
        requestedAdmission: {
          kind: "retry-at" as const,
          reason: "hard-limit" as const,
          stale: false,
          retryAt,
        },
      }),
      resolveSpawnAccount: () => account,
      resolvePinnedSpawnAdmission: async () => pinAdmissible
        ? { kind: "admissible" as const, basis: "current" as const, stale: false, retryAt: null }
        : { kind: "retry-at" as const, reason: "hard-limit" as const, stale: false, retryAt },
      spawnTmuxAgent: async () => {
        tmuxStarts += 1;
        throw new Error("tmux must stay gated");
      },
    });

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ state: "starting", initialMessage: "queued" });
    expect(tmuxStarts).toBe(0);
    expect(store.spawnReceiptForClientAttempt("account_pin_tmux_retry_20260823")).toMatchObject({
      accountId: "account-a",
      accountPin: true,
      transport: "tmux",
      state: "starting",
      queuedPinnedSpawn: { retryAt, accountId: "account-a", prompt: "continue" },
    });

    store = new AgentRegistry(registryFile);
    const recoveryClient = {
      effectBatch: async () => [],
      operationStatus: async () => null,
      snapshot: async () => ({ revision: 0, sessions: [] }),
      transitionOperation: async () => null,
    } as unknown as RuntimeHostClient;
    const recover = async (now: number) => await terminalizeStaleStructuredSpawns(store, recoveryClient, {
      now: () => now,
      resolveSpawnAccount: () => account,
      resolvePinnedSpawnAdmission: async () => pinAdmissible
        ? { kind: "admissible" as const, basis: "current" as const, stale: false, retryAt: null }
        : { kind: "retry-at" as const, reason: "hard-limit" as const, stale: false, retryAt },
      spawnTmuxAgent: async (_spec, payload, receipt) => {
        tmuxStarts += 1;
        expect(payload).toBe("continue");
        if (!receipt) throw new Error("queued recovery must reuse its durable receipt");
        const binding = {
          endpoint: "/test-tmux",
          server: { pid: 9, startIdentity: "9:server" },
          paneId: "%9",
          panePid: { pid: 99, startIdentity: "99:pane" },
          target: "agents:9.0",
        };
        const host = {
          kind: "tmux" as const,
          ...binding,
          windowName: "queued-pin",
          agent: { pid: 100, startIdentity: "100:agent" },
          argv: ["claude"],
        };
        store.bindSpawnPane(receipt.launchId, binding);
        store.markSpawnHostVerified(receipt.launchId, host);
        store.markSpawnPromptDelivered(receipt.launchId);
        return { paneId: binding.paneId, display: binding.target, panePid: binding.panePid.pid, host, receipt };
      },
    });

    await recover(Date.parse(retryAt) - 1);
    expect(tmuxStarts).toBe(0);
    pinAdmissible = true;
    await Promise.all([recover(Date.parse(retryAt) + 1), recover(Date.parse(retryAt) + 1)]);
    expect(tmuxStarts).toBe(1);
    expect(store.spawnReceiptForClientAttempt("account_pin_tmux_retry_20260823")).toMatchObject({
      accountId: "account-a",
      accountPin: true,
      transport: "tmux",
      state: "path-pending",
      queuedPinnedSpawn: null,
      admissionOwner: null,
    });
    await recover(Date.parse(retryAt) + 2);
    expect(tmuxStarts).toBe(1);
  } finally {
    if (previousTransport === undefined) delete process.env.LLV_SPAWN_TRANSPORT;
    else process.env.LLV_SPAWN_TRANSPORT = previousTransport;
  }
});

test("a pinned account without a retry deadline falls back and records the degraded pin on the card", async () => {
  const cwd = fs.mkdtempSync(path.join(routeSandbox, "account-pin-fallback-"));
  const store = registry();
  const deferred: Array<() => Promise<void>> = [];
  const spawnedAccounts: string[] = [];
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
  try {
    const dependencies = {
      ...structuredRouteDependencies(cwd),
      registry: () => store,
      resolveHealthySpawnAccount: async () => ({
        engine: "claude" as const,
        accountId: "account-b",
        kind: "managed" as const,
        home: path.join(cwd, "account-b"),
        transcriptRoot: path.join(cwd, "account-b", "projects"),
        env: { NODE_ENV: "test" as const },
        requestedAdmission: {
          kind: "unavailable" as const,
          reason: "auth-failed" as const,
          stale: false,
          retryAt: null,
        },
      }),
      defer: (work: () => Promise<void>) => { deferred.push(work); },
      spawnStructuredConversation: async (input: Parameters<SpawnRouteTestDependencies["spawnStructuredConversation"]>[0]) => {
        spawnedAccounts.push(input.account.accountId);
        const sessionId = crypto.randomUUID();
        const settled = input.registry.settleSpawn(input.receipt.launchId, {
          key: { engine: input.engine, sessionId },
          artifactPath: path.join(cwd, `${sessionId}.jsonl`),
          cwd,
          accountId: input.account.accountId,
          status: "starting",
          host: null,
          claimEpoch: 0,
          claimOwner: null,
          pendingAction: "spawn",
        });
        if (settled.kind !== "settled") throw new Error("expected fallback settlement");
        return {
          ok: true as const,
          target: null,
          path: settled.entry.artifactPath,
          launchId: input.receipt.launchId,
          conversationId: settled.conversation.id,
          launched: true,
          retrySafe: false,
          initialMessage: "delivered" as const,
          state: "settled" as const,
        };
      },
    };
    const response = await POST.withDependencies(new NextRequest("http://127.0.0.1/api/spawn", {
      method: "POST",
      headers: { origin: "http://127.0.0.1", host: "127.0.0.1", "content-type": "application/json", "sec-fetch-site": "same-origin", "accept-language": "uk-UA" },
      body: JSON.stringify({
        title: "Continue on available account",
        engine: "claude",
        model: "sonnet",
        cwd,
        ["prompt"]: "continue",
        accountId: "account-a",
        clientAttemptId: "account_pin_fallback_20260823",
      }),
    }), dependencies);

    expect(response.status).toBe(202);
    const receipt = store.spawnReceiptForClientAttempt("account_pin_fallback_20260823")!;
    expect(receipt).toMatchObject({ accountId: "account-a", accountPin: true, state: "starting" });
    expect(receipt.launchProfile.title).toBe("Запущено на іншому акаунті — pin недоступний");
    expect(projectLaunchConversations([], store.snapshot(), Date.now()).cards[0]).toMatchObject({
      title: "Запущено на іншому акаунті — pin недоступний",
      spawn: { accountId: "account-a", accountPin: true },
    });

    expect(deferred).toHaveLength(1);
    await deferred[0]!();
    expect(spawnedAccounts).toEqual(["account-b"]);
    const settledReceipt = store.spawnReceiptForClientAttempt("account_pin_fallback_20260823")!;
    const conversation = store.conversation(settledReceipt.conversationId)!;
    expect(conversation).toMatchObject({
      pinnedAccountId: "account-a",
      migration: null,
      generations: [expect.objectContaining({ accountId: "account-b" })],
    });
    expect(store.snapshot().entries[`claude:${settledReceipt.key!.sessionId}`]).toMatchObject({ accountId: "account-b" });
    store.setEngineRouting("claude", "account-c");
    expect(store.requestConversationMigrationToActiveAccount(conversation.id)).toMatchObject({
      pinnedAccountId: "account-a",
      migration: null,
      generations: [expect.objectContaining({ accountId: "account-b" })],
    });
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

test("a pinned spawn still refuses when no account is admissible", async () => {
  const cwd = fs.mkdtempSync(path.join(routeSandbox, "account-pin-none-"));
  const store = registry();
  const dependencies = {
    ...structuredRouteDependencies(cwd),
    registry: () => store,
    resolveHealthySpawnAccount: async () => {
      throw new NoHealthyClaudeAccountError(["account-a", "account-b"]);
    },
    resolvePinnedSpawnAdmission: async () => ({
      kind: "unavailable" as const,
      reason: "auth-failed" as const,
      stale: false,
      retryAt: null,
    }),
  };
  const response = await POST.withDependencies(new NextRequest("http://127.0.0.1/api/spawn", {
    method: "POST",
    headers: { origin: "http://127.0.0.1", host: "127.0.0.1", "content-type": "application/json", "sec-fetch-site": "same-origin" },
    body: JSON.stringify({
      title: "Continue pinned account work",
      engine: "claude",
      model: "sonnet",
      cwd,
      ["prompt"]: "continue",
      accountId: "account-a",
      clientAttemptId: "account_pin_none_20260823",
    }),
  }), dependencies);

  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    state: "failed",
    initialMessage: "failed",
    retrySafe: true,
    error: expect.stringContaining("No healthy Claude account is available"),
  });
  expect(store.spawnReceiptForClientAttempt("account_pin_none_20260823")).toMatchObject({
    accountId: "account-a",
    accountPin: true,
    state: "failed",
  });
});

test("a legacy resolver mismatch also degrades the pin to a durable fallback", async () => {
  const cwd = fs.mkdtempSync(path.join(routeSandbox, "unusable-account-pin-"));
  const store = registry();
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
  try {
    const dependencies = {
      ...structuredRouteDependencies(cwd),
      registry: () => store,
      resolveHealthySpawnAccount: async () => ({
        engine: "claude" as const,
        accountId: "selected-account",
        kind: "managed" as const,
        home: path.join(cwd, "selected-account"),
        transcriptRoot: path.join(cwd, "selected-account", "projects"),
        env: { NODE_ENV: "test" as const },
      }),
    };
    const capability = rotateOperatorSpawnCapability();
    const baseRequest = {
      engine: "claude",
      model: "sonnet",
      cwd,
      ["prompt"]: "inspect",
      accountId: "unusable-pin",
      clientAttemptId: "unusable_pin_20260731",
    };
    const post = async (overrides: Record<string, unknown> = {}) => await POST.withDependencies(new NextRequest("http://127.0.0.1/api/spawn", {
      method: "POST",
      headers: {
        origin: "http://127.0.0.1",
        host: "127.0.0.1",
        "content-type": "application/json",
        "sec-fetch-site": "same-origin",
        "x-llv-spawn-capability": capability,
      },
      body: JSON.stringify({ title: "Test semantic spawn",
        ...baseRequest,
        ...overrides,
      }),
    }), dependencies);

    const response = await post();
    const responseBody = await response.json();
    expect(response.status).toBe(202);
    expect(responseBody).toMatchObject({
      state: "starting",
      initialMessage: "pending",
      retrySafe: false,
    });
    const replay = await post();
    expect(replay.status).toBe(202);
    expect(await replay.json()).toMatchObject({ launchId: responseBody.launchId, state: "starting" });

    const parent = store.ensureConversation("claude", path.join(cwd, "parent.jsonl"), "parent-account");
    const conflicts = [
      { accountId: "other-unusable-pin" },
      { ["prompt"]: "inspect a different target" },
      { parentConversationId: parent.id },
      { role: "builder" },
      { allowSubagents: true },
    ];
    for (const changed of conflicts) {
      const conflict = await post(changed);
      expect(conflict.status).toBe(409);
      expect(await conflict.json()).toEqual({ error: "spawn attempt conflicts with its original request" });
    }

    const receipt = store.spawnReceiptForClientAttempt("unusable_pin_20260731");
    expect(receipt).toMatchObject({
      accountId: "unusable-pin",
      accountPin: true,
      requestDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      state: "starting",
      error: null,
      launchProfile: { title: "Launched on another account — pin unavailable" },
    });
    const card = projectLaunchConversations([], store.snapshot(), Date.now()).cards[0]?.spawn;
    expect(card).toMatchObject({
      accountId: "unusable-pin",
      accountPin: true,
      state: "starting",
      retrySafe: false,
      error: null,
    });
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

test("a failed pinned reviewer preserves canonical child and pipeline lineage", async () => {
  const cwd = fs.mkdtempSync(path.join(routeSandbox, "failed-pinned-lineage-"));
  const store = registry();
  const sourceSessionId = crypto.randomUUID();
  const sourceAccount = createManagedCodexAccount(`failed-pinned-lineage-${sourceSessionId}`);
  const sourcePath = path.join(sourceAccount.sessionsDir, `${sourceSessionId}.jsonl`);
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.writeFileSync(sourcePath, "{}\n");
  const source = store.ensureConversation("codex", sourcePath, "source-account");
  const reviewed = store.ensureConversation("codex", path.join(cwd, "reviewed.jsonl"), "reviewed-account");
  const predecessor = store.ensureConversation("codex", path.join(cwd, "predecessor.jsonl"), "predecessor-account");
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
  try {
    const dependencies = {
      ...structuredRouteDependencies(cwd),
      registry: () => store,
      resolveHealthySpawnAccount: async () => {
        throw new NoHealthyClaudeAccountError(["unavailable-account"]);
      },
      pipelineAttemptTargetForSource: () => ({
        pipelineId: "pipeline-failed-pin",
        stageId: "review",
        stageOrder: 2,
        role: "reviewer",
      }),
    } satisfies SpawnRouteTestDependencies;
    const body = {
      title: "Review account-pinned lineage",
      engine: "codex",
      model: "gpt-5.6-sol",
      cwd,
      ["prompt"]: "inspect account-pinned lineage",
      accountId: "unavailable-account",
      clientAttemptId: "failed_pinned_lineage_20260803",
      src: sourcePath,
      role: "reviewer",
      roleParams: { diffSource: "PR 842", lens: "correctness" },
      reviews: reviewed.id,
      project: "account-pinned-project",
      supersedes: predecessor.id,
      mcpServers: ["viewer"],
    };
    const post = () => POST.withDependencies(new NextRequest("http://127.0.0.1:8898/api/spawn", {
      method: "POST",
      headers: {
        origin: "http://127.0.0.1:8898",
        host: "127.0.0.1:8898",
        "sec-fetch-site": "same-origin",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }), dependencies);

    const first = await post();
    expect(first.status).toBe(200);
    const firstBody = await first.json() as { launchId: string };
    const replay = await post();
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ launchId: firstBody.launchId, state: "failed" });

    const receipt = store.spawnReceiptForClientAttempt(body.clientAttemptId)!;
    expect(receipt).toMatchObject({
      accountId: body.accountId,
      accountPin: true,
      state: "failed",
      parentConversationId: source.id,
      parentSource: "explicit",
      agentRole: "reviewer",
      delegationDepth: 0,
      explicitProject: body.project,
      supersedes: { conversationId: predecessor.id, reason: "recovery-spawn" },
      launchProfile: {
        parentConversationId: source.id,
        mcpServers: ["viewer"],
        plugins: [],
      },
    });
    expect(store.snapshot().lineageEdges[receipt.conversationId]).toMatchObject({
      parentConversationId: source.id,
      parentArtifactPath: sourcePath,
      kind: "review",
      role: "reviewer",
      reviewsConversationId: reviewed.id,
    });
    expect(store.snapshot().memberships[receipt.conversationId]).toEqual([
      expect.objectContaining({
        kind: "pipeline",
        containerId: "pipeline-failed-pin",
        role: "reviewer",
        stageId: "review",
        stageOrder: 2,
        parentConversationId: source.id,
        runtime: { engine: "codex", model: "gpt-5.6-sol", effort: "xhigh" },
      }),
    ]);
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

test("spawn admission grants MCP servers by session origin and refuses ungranted names", async () => {
  const cwd = fs.mkdtempSync(path.join(routeSandbox, "mcp-allowlist-"));
  const store = registry();
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
    const dependencies = { ...structuredRouteDependencies(cwd), registry: () => store };
    const capability = rotateOperatorSpawnCapability();
    const post = async (clientAttemptId: string, mcpServers?: unknown, role: string | null = "builder") => POST.withDependencies(new NextRequest("http://127.0.0.1/api/spawn", {
      method: "POST",
      headers: {
        origin: "http://127.0.0.1",
        host: "127.0.0.1",
        "content-type": "application/json",
        "x-llv-spawn-capability": capability,
        /* No role means the operator lane: a same-origin launch with no lineage
           parent and no preset is the operator-root session class. */
        ...(role ? {} : { "sec-fetch-site": "same-origin" }),
      },
      body: JSON.stringify({ title: "Test semantic spawn", engine: "claude", model: "sonnet", cwd, prompt: "inspect", ...(role ? { role } : {}), clientAttemptId, ...(mcpServers === undefined ? {} : { mcpServers }) }),
    }), dependencies);

    const defaultResponse = await post("mcp_default_20260723");
    expect({ status: defaultResponse.status, body: await defaultResponse.clone().json() }).toMatchObject({ status: 202 });
    /* An explicit opt-out is honoured on both lanes and still yields Viewer. */
    expect((await post("mcp_optout_20260723", [])).status).toBe(202);
    /* A name outside the grant bound is refused, not trimmed — from the
       operator lane as much as from a delegated one (issue #739). Tranche 1
       ships that bound empty of connectors, so this covers every configured
       server, `agent-browser` included. */
    for (const [attempt, role] of [["mcp_ungranted_delegated_20260727", "builder"], ["mcp_ungranted_root_20260727", null]] as const) {
      const ungranted = await post(attempt, ["agent-browser"], role);
      expect(ungranted.status).toBe(400);
      expect(await ungranted.json()).toMatchObject({ error: expect.stringContaining("agent-browser") });
      expect(store.spawnReceiptForClientAttempt(attempt)).toBeNull();
    }

    expect(store.spawnReceiptForClientAttempt("mcp_default_20260723")?.launchProfile.mcpServers).toEqual(["viewer"]);
    expect(store.spawnReceiptForClientAttempt("mcp_optout_20260723")?.launchProfile.mcpServers).toEqual(["viewer"]);
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

test("spawn admission grants Computer Use to an operator root Codex session only (#687)", async () => {
  const cwd = fs.mkdtempSync(path.join(routeSandbox, "plugin-grant-"));
  const store = registry();
  const previousTransport = process.env.LLV_SPAWN_TRANSPORT;
  const previousHosts = process.env.LLV_STRUCTURED_HOSTS;
  const previousEvents = process.env.LLV_RUNTIME_EVENTS;
  const previousSocket = process.env.LLV_RUNTIME_HOST_SOCKET;
  const previousUi = process.env.NEXT_PUBLIC_RUNTIME_UI;
  const previousBinary = process.env.LLV_CODEX_BINARY;
  process.env.LLV_SPAWN_TRANSPORT = "structured";
  process.env.LLV_STRUCTURED_HOSTS = "1";
  process.env.LLV_RUNTIME_EVENTS = "1";
  process.env.LLV_RUNTIME_HOST_SOCKET = path.join(cwd, "runtime.sock");
  process.env.NEXT_PUBLIC_RUNTIME_UI = "1";
  /* Codex MCP enumeration shells out to the real CLI; a stub keeps this test
     off the operator's Codex installation and its account state. */
  const codexStub = path.join(cwd, "codex-stub.sh");
  fs.writeFileSync(codexStub, "#!/bin/sh\nprintf '[]'\n", { mode: 0o700 });
  process.env.LLV_CODEX_BINARY = codexStub;
  try {
    const base = structuredRouteDependencies(cwd);
    const codexAccount = {
      engine: "codex" as const,
      accountId: "codex-test",
      kind: "managed" as const,
      home: path.join(cwd, "account"),
      transcriptRoot: path.join(cwd, "sessions"),
      env: { CODEX_HOME: path.join(cwd, "account"), NODE_ENV: "test" as const },
    };
    const dependencies = {
      ...base,
      registry: () => store,
      resolveHealthySpawnAccount: async () => codexAccount,
      resolveSpawnAccount: () => codexAccount,
    };
    const capability = rotateOperatorSpawnCapability();
    const post = async (clientAttemptId: string, extra: Record<string, unknown>) => POST.withDependencies(new NextRequest("http://127.0.0.1/api/spawn", {
      method: "POST",
      headers: {
        origin: "http://127.0.0.1",
        host: "127.0.0.1",
        "content-type": "application/json",
        "sec-fetch-site": "same-origin",
        "x-llv-spawn-capability": capability,
      },
      body: JSON.stringify({ title: "Test semantic spawn", engine: "codex", cwd, prompt: "inspect", clientAttemptId, ...extra }),
    }), dependencies);

    const rootResponse = await post("plugins_root_20260726", {});
    expect({ status: rootResponse.status, body: await rootResponse.clone().json() }).toMatchObject({ status: 202 });
    expect((await post("plugins_role_20260726", { role: "builder" })).status).toBe(202);
    expect((await post("plugins_optout_20260726", { plugins: [] })).status).toBe(202);

    /* Default-on for the operator's own root session… */
    expect(store.spawnReceiptForClientAttempt("plugins_root_20260726")?.launchProfile.plugins).toEqual(["computer-use"]);
    /* …off for a delegated helper, even from the operator's own lane… */
    expect(store.spawnReceiptForClientAttempt("plugins_role_20260726")?.launchProfile.plugins).toEqual([]);
    /* …and off when the operator opts this root session out. */
    expect(store.spawnReceiptForClientAttempt("plugins_optout_20260726")?.launchProfile.plugins).toEqual([]);

    const widened = await post("plugins_widened_20260726", { plugins: ["browser"] });
    expect(widened.status).toBe(400);
    expect(await widened.json()).toMatchObject({ error: expect.stringContaining("browser") });
    const everything = await post("plugins_star_20260726", { plugins: ["*"] });
    expect(everything.status).toBe(400);
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
    if (previousBinary === undefined) delete process.env.LLV_CODEX_BINARY;
    else process.env.LLV_CODEX_BINARY = previousBinary;
  }
});

test("a materialized structured child is offered for pipeline attempt adoption", async () => {
  const cwd = fs.mkdtempSync(path.join(routeSandbox, "pipeline-adoption-"));
  const store = registry();
  const sourceSessionId = crypto.randomUUID();
  const sourceAccount = createManagedCodexAccount(`pipeline-adoption-${sourceSessionId}`);
  const sourcePath = path.join(sourceAccount.sessionsDir, `${sourceSessionId}.jsonl`);
  const childPath = path.join(cwd, "child.jsonl");
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.writeFileSync(sourcePath, "{}\n");
  fs.writeFileSync(childPath, "{}\n");
  const source = store.ensureConversation("codex", sourcePath, null);
  const deferred: Array<() => Promise<void>> = [];
  const adoptions: unknown[] = [];
  let structuredLaunches = 0;
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
    const capability = rotateOperatorSpawnCapability();
    const dependencies = {
      ...structuredRouteDependencies(cwd),
      registry: () => store,
      defer: (work: () => Promise<void>) => { deferred.push(work); },
      pipelineAttemptTargetForSource: () => ({
        pipelineId: "pipeline-adoption",
        stageId: "build",
        stageOrder: 1,
        role: "builder",
      }),
      spawnStructuredConversation: async (input: Parameters<SpawnRouteTestDependencies["spawnStructuredConversation"]>[0]) => {
        structuredLaunches += 1;
        const settled = store.settleSpawn(input.receipt.launchId, {
          key: { engine: "claude", sessionId: crypto.randomUUID() },
          artifactPath: childPath,
          cwd,
          accountId: "claude-test",
          status: "starting",
          host: null,
          claimEpoch: 0,
          claimOwner: null,
          pendingAction: "spawn",
        });
        if (settled.kind !== "settled") throw new Error(settled.code);
        return {
          ok: true,
          target: null,
          path: childPath,
          effectivePermissionMode: input.spec.launchProfile?.permissionMode ?? "default",
          launchId: input.receipt.launchId,
          conversationId: input.receipt.conversationId,
          launched: true,
          retrySafe: false,
          initialMessage: "delivered" as const,
          state: "settled" as const,
        };
      },
      adoptPipelineAttemptFromSource: async (sourceConversationId: string, conversationRef: unknown) => {
        adoptions.push({ sourceConversationId, conversationRef });
        if (adoptions.length === 1) throw new Error("injected pipeline store write failure");
        return null;
      },
    } as SpawnRouteTestDependencies;
    const response = await POST.withDependencies(new NextRequest("http://127.0.0.1/api/spawn", {
      method: "POST",
      headers: { origin: "http://127.0.0.1", host: "127.0.0.1", "content-type": "application/json", "x-llv-spawn-capability": capability },
      body: JSON.stringify({ title: "Test semantic spawn", engine: "claude", model: "sonnet", cwd, prompt: "fallback", src: sourcePath, role: "builder", clientAttemptId: "pipeline_adoption_20260719" }),
    }), dependencies);

    expect({ status: response.status, body: await response.clone().json() }).toMatchObject({ status: 202 });
    await Promise.all(deferred.map((work) => work()));
    const receipt = Object.values(store.snapshot().receipts).find((candidate) => candidate.clientAttemptId === "pipeline_adoption_20260719")!;
    expect(store.snapshot().memberships[receipt.conversationId]).toEqual([
      expect.objectContaining({
        kind: "pipeline",
        containerId: "pipeline-adoption",
        stageId: "build",
        parentConversationId: source.id,
        round: null,
        runtime: {
          engine: "claude",
          model: "sonnet",
          effort: expect.any(String),
        },
      }),
    ]);
    expect(new AgentRegistry(store.filename).snapshot().memberships[receipt.conversationId]).toEqual([
      expect.objectContaining({
        runtime: {
          engine: "claude",
          model: "sonnet",
          effort: expect.any(String),
        },
      }),
    ]);

    const replay = await POST.withDependencies(new NextRequest("http://127.0.0.1/api/spawn", {
      method: "POST",
      headers: { origin: "http://127.0.0.1", host: "127.0.0.1", "content-type": "application/json", "x-llv-spawn-capability": capability },
      body: JSON.stringify({ title: "Test semantic spawn", engine: "claude", model: "sonnet", cwd, prompt: "fallback", src: sourcePath, role: "builder", clientAttemptId: "pipeline_adoption_20260719" }),
    }), dependencies);
    expect(replay.status).toBe(200);
    expect(structuredLaunches).toBe(1);
    expect(adoptions).toEqual([{
      sourceConversationId: source.id,
      conversationRef: expect.objectContaining({
        launchId: expect.any(String),
        conversationId: expect.stringMatching(/^conversation_/),
        agentPath: childPath,
        runtime: {
          engine: "claude",
          model: "sonnet",
          effort: expect.any(String),
        },
      }),
    }, {
      sourceConversationId: source.id,
      conversationRef: expect.objectContaining({
        launchId: expect.any(String),
        conversationId: expect.stringMatching(/^conversation_/),
        agentPath: childPath,
        runtime: {
          engine: "claude",
          model: "sonnet",
          effort: expect.any(String),
        },
      }),
    }]);
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

test("a fresh process resolves and refreshes a persisted Claude account before one structured launch", async () => {
  const sandbox = fs.mkdtempSync(path.join(routeSandbox, "production-resolver-reboot-"));
  const stateDir = path.join(sandbox, "state");
  const accountsRoot = path.join(sandbox, "accounts", "claude");
  const home = path.join(accountsRoot, "rebooted");
  const cwd = path.join(sandbox, "workspace");
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.chmodSync(accountsRoot, 0o700);
  fs.chmodSync(home, 0o700);
  fs.mkdirSync(path.join(home, "projects"), { mode: 0o700 });
  fs.mkdirSync(cwd, { mode: 0o700 });
  fs.writeFileSync(path.join(stateDir, "claude-accounts.json"), JSON.stringify({
    version: 1,
    active: "rebooted",
    accounts: [{ id: "rebooted", label: "Rebooted", kind: "managed", createdAt: 1 }],
  }), { mode: 0o600 });
  fs.writeFileSync(path.join(home, ".credentials.json"), JSON.stringify({
    claudeAiOauth: {
      "accessToken": "synthetic-expired-access",
      refreshToken: "synthetic-refresh",
      expiresAt: 1,
      scopes: ["user:inference"],
    },
  }), { mode: 0o600 });

  const routePath = path.join(import.meta.dir, "route.ts");
  const structuredSpawnPath = path.join(import.meta.dir, "../../../lib/runtime/structuredSpawn.ts");
  const runtimeClientPath = path.join(import.meta.dir, "../../../lib/runtime/client.ts");
  const source = `
    const { mock } = await import("bun:test");
    const deferred = [];
    let refreshRequests = 0;
    let usageRequests = 0;
    let structuredSpawns = 0;
    let launchedAccount = null;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url === "https://platform.claude.com/v1/oauth/token") {
        refreshRequests += 1;
        return Response.json({
          "access_token": "synthetic-current-access",
          refresh_token: "synthetic-rotated-refresh",
          expires_in: 3600,
          scope: "user:inference",
        });
      }
      if (url === "https://api.anthropic.com/api/oauth/usage") {
        usageRequests += 1;
        return Response.json({ five_hour: { utilization: 12, resets_at: "2026-07-17T12:00:00.000Z" } });
      }
      throw new Error("unexpected synthetic upstream request");
    };
    const nextServer = await import("next/server");
    mock.module("next/server", () => ({
      ...nextServer,
      after: (work) => { deferred.push(work); },
    }));
    const structured = await import(${JSON.stringify(structuredSpawnPath)});
    mock.module("@/lib/runtime/structuredSpawn", () => ({
      ...structured,
      spawnStructuredConversation: async (input) => {
        structuredSpawns += 1;
        launchedAccount = input.account.accountId;
        return {
          ok: true,
          target: null,
          path: null,
          effectivePermissionMode: input.spec.launchProfile?.permissionMode ?? "default",
          launchId: input.receipt.launchId,
          conversationId: input.receipt.conversationId,
          launched: true,
          retrySafe: false,
          state: "settled",
        };
      },
    }));
    const runtimeClient = await import(${JSON.stringify(runtimeClientPath)});
    mock.module("@/lib/runtime/client", () => ({ ...runtimeClient, runtimeHostClient: () => ({}) }));
    const { NextRequest } = await import("next/server");
    const { POST } = await import(${JSON.stringify(routePath)});
    const response = await POST(new NextRequest("http://127.0.0.1:8898/api/spawn", {
      method: "POST",
      headers: {
        host: "127.0.0.1:8898",
        origin: "http://127.0.0.1:8898",
        "sec-fetch-site": "same-origin",
        "content-type": "application/json",
      },
      body: JSON.stringify({ title: "Test semantic spawn", engine: "claude", cwd: ${JSON.stringify(cwd)}, ["prompt"]: "resume work", accountId: "rebooted", clientAttemptId: "fresh_process_spawn_20260825" }),
    }));
    await Promise.all(deferred.map((work) => work()));
    const body = await response.json();
    const credentials = JSON.parse(await Bun.file(${JSON.stringify(path.join(home, ".credentials.json"))}).text());
    process.stdout.write(JSON.stringify({
      status: response.status,
      body,
      refreshRequests,
      usageRequests,
      structuredSpawns,
      launchedAccount,
      "accessToken": credentials.claudeAiOauth.accessToken,
    }));
  `;
  const child = Bun.spawn({
    cmd: [process.execPath, "-e", source],
    cwd: process.cwd(),
    env: {
      ...process.env,
      LLV_STATE_DIR: stateDir,
      LLV_CLAUDE_HOME: path.join(sandbox, "legacy-claude"),
      LLV_SPAWN_TRANSPORT: "structured",
      LLV_STRUCTURED_HOSTS: "1",
      LLV_RUNTIME_EVENTS: "1",
      LLV_RUNTIME_HOST_SOCKET: path.join(sandbox, "runtime.sock"),
      NEXT_PUBLIC_RUNTIME_UI: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);

  expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
  expect(JSON.parse(stdout)).toEqual({
    status: 202,
    body: expect.objectContaining({
      launched: false,
      state: "starting",
      conversationId: expect.stringMatching(/^conversation_/),
    }),
    refreshRequests: 1,
    usageRequests: 1,
    structuredSpawns: 1,
    launchedAccount: "rebooted",
    "accessToken": "synthetic-current-access",
  });
}, 20_000);

test("fresh processes rescue one orphaned immediate structured admission exactly once", async () => {
  const sandbox = fs.mkdtempSync(path.join(routeSandbox, "orphaned-structured-admission-"));
  const stateDir = path.join(sandbox, "state");
  const cwd = path.join(sandbox, "workspace");
  const effectsPath = path.join(sandbox, "effects.jsonl");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(cwd);

  const routePath = path.join(import.meta.dir, "route.ts");
  const source = `
    const fs = await import("node:fs");
    const path = await import("node:path");
    const crypto = await import("node:crypto");
    const { NextRequest } = await import("next/server");
    const { agentRegistry } = await import("@/lib/agent/registry");
    const { POST } = await import(${JSON.stringify(routePath)});
    const phase = process.env.LLV_TEST_PHASE;
    const deferred = [];
    const client = {
      operationStatus: async () => null,
      snapshot: async () => ({ sessions: [] }),
    };
    const dependencies = {
      registry: agentRegistry,
      assertStructuredRuntime: () => {},
      resolveHealthySpawnAccount: async () => ({
        engine: "claude",
        accountId: "claude-test",
        kind: "managed",
        home: path.join(${JSON.stringify(sandbox)}, "account"),
        transcriptRoot: path.join(${JSON.stringify(sandbox)}, "projects"),
        env: { NODE_ENV: "test" },
      }),
      resolveSpawnAccount: () => ({
        engine: "claude",
        accountId: "claude-test",
        kind: "managed",
        home: path.join(${JSON.stringify(sandbox)}, "account"),
        transcriptRoot: path.join(${JSON.stringify(sandbox)}, "projects"),
        env: { NODE_ENV: "test" },
      }),
      runtimeHostClient: () => client,
      defer: (work) => { deferred.push(work); },
      storeImages: () => [],
      spawnStructuredConversation: async (input) => {
        fs.appendFileSync(${JSON.stringify(effectsPath)}, JSON.stringify({ effect: "worker", pid: process.pid }) + "\\n");
        const sessionId = crypto.randomUUID();
        const artifactPath = path.join(${JSON.stringify(sandbox)}, sessionId + ".jsonl");
        fs.writeFileSync(artifactPath, JSON.stringify({ type: "user", message: input.prompt }) + "\\n");
        fs.appendFileSync(${JSON.stringify(effectsPath)}, JSON.stringify({ effect: "first-prompt", pid: process.pid }) + "\\n");
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
        if (settled.kind !== "settled") throw new Error("structured rescue settlement conflicted");
        return {
          ok: true,
          target: null,
          path: artifactPath,
          launchId: input.receipt.launchId,
          conversationId: input.receipt.conversationId,
          launched: true,
          retrySafe: false,
          initialMessage: "delivered",
          state: "settled",
        };
      },
    };
    const response = await POST.withDependencies(new NextRequest("http://127.0.0.1:8898/api/spawn", {
      method: "POST",
      headers: {
        host: "127.0.0.1:8898",
        origin: "http://127.0.0.1:8898",
        "sec-fetch-site": "same-origin",
        "content-type": "application/json",
      },
      body: JSON.stringify({ title: "Test semantic spawn",
        engine: "claude",
        cwd: ${JSON.stringify(cwd)},
        "prompt": "repair the assigned task",
        clientAttemptId: "orphaned_admission_20260717_a1",
      }),
    }), dependencies);
    const body = await response.json();
    if (phase === "recover") await Promise.all(deferred.map((work) => work()));
    const receipt = agentRegistry().snapshot().receipts[body.launchId];
    process.stdout.write(JSON.stringify({
      status: response.status,
      body,
      deferred: deferred.length,
      receiptState: receipt?.state ?? null,
    }));
  `;
  const run = async (phase: "admit" | "recover") => {
    const child = Bun.spawn({
      cmd: [process.execPath, "-e", source],
      cwd: process.cwd(),
      env: {
        ...process.env,
        LLV_TEST_PHASE: phase,
        LLV_STATE_DIR: stateDir,
        LLV_AGENT_REGISTRY_SQLITE: "off",
        LLV_SPAWN_TRANSPORT: "structured",
        LLV_STRUCTURED_HOSTS: "1",
        LLV_RUNTIME_EVENTS: "1",
        LLV_RUNTIME_HOST_SOCKET: path.join(sandbox, "runtime.sock"),
        NEXT_PUBLIC_RUNTIME_UI: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exit, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
    return JSON.parse(stdout) as {
      status: number;
      body: { launchId: string; conversationId: string; state: string };
      deferred: number;
      receiptState: string | null;
    };
  };

  const admitted = await run("admit");
  expect(admitted).toMatchObject({ status: 202, deferred: 1, receiptState: "starting" });

  const recovered = await Promise.all([run("recover"), run("recover")]);
  const effects = fs.existsSync(effectsPath)
    ? fs.readFileSync(effectsPath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { effect: string })
    : [];
  const finalReceipt = new AgentRegistry(path.join(stateDir, "agent-registry.json"), undefined, undefined, { sqliteMode: "off" })
    .snapshot().receipts[admitted.body.launchId];

  expect(new Set(recovered.map((result) => result.body.launchId))).toEqual(new Set([admitted.body.launchId]));
  expect(new Set(recovered.map((result) => result.body.conversationId))).toEqual(new Set([admitted.body.conversationId]));
  expect(recovered.filter((result) => result.deferred === 1)).toHaveLength(1);
  expect(effects.map((effect) => effect.effect)).toEqual(["worker", "first-prompt"]);
  expect(finalReceipt).toMatchObject({
    launchId: admitted.body.launchId,
    conversationId: admitted.body.conversationId,
    state: "completed",
    completionMode: "route-completed",
  });
}, 20_000);

test("structured spawn runtime fence preserves durable state", async () => {
  const cwd = fs.mkdtempSync(path.join(routeSandbox, "structured-runtime-fence-"));
  const registryPath = path.join(cwd, "cold-agent-registry.json");
  const seeded = new AgentRegistry(registryPath, undefined, undefined, { sqliteMode: "off" });
  const conversation = seeded.ensureConversation("codex", path.join(cwd, "session.jsonl"), "codex-test");
  const snapshot = seeded.snapshot();
  for (let index = 0; index < 101; index += 1) {
    const id = `legacy-${String(index).padStart(3, "0")}`;
    snapshot.heldDeliveries[id] = {
      id,
      conversationId: conversation.id,
      text: `legacy body ${index}`,
      createdAt: `2026-07-16T00:00:${String(index % 60).padStart(2, "0")}.000Z`,
      clientMessageId: id,
      payloadKind: "text",
      artifactPaths: [],
      state: "delivered",
      generationId: conversation.generations.at(-1)!.id,
      attempts: 1,
      assignedAt: null,
      deliveredAt: `2026-07-16T00:00:${String(index % 60).padStart(2, "0")}.000Z`,
      error: null,
    } as unknown as (typeof snapshot.heldDeliveries)[string];
  }
  fs.writeFileSync(registryPath, JSON.stringify(snapshot));
  const registryBytes = fs.readFileSync(registryPath);
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
  let registryFactoryCalls = 0;
  let accountLookups = 0;
  let structuredSpawns = 0;
  const dependencies = {
    ...structuredRouteDependencies(cwd),
    registry: () => {
      registryFactoryCalls += 1;
      return new AgentRegistry(registryPath, undefined, undefined, { sqliteMode: "off" });
    },
    assertStructuredRuntime: () => {
      throw new StructuredRuntimeRequirementError("structured hosts on macOS require the Viewer server to run with Bun");
    },
    resolveHealthySpawnAccount: async () => {
      accountLookups += 1;
      throw new Error("account lookup crossed the runtime fence");
    },
    spawnStructuredConversation: async () => {
      structuredSpawns += 1;
      throw new Error("structured spawn crossed the runtime fence");
    },
  } satisfies SpawnRouteTestDependencies;

  try {
    const response = await POST.withDependencies(new NextRequest("http://127.0.0.1:8898/api/spawn", {
      method: "POST",
      headers: {
        host: "127.0.0.1:8898",
        origin: "http://127.0.0.1:8898",
        "sec-fetch-site": "same-origin",
        "content-type": "application/json",
      },
      body: JSON.stringify({ title: "Test semantic spawn", engine: "codex", cwd, prompt: "must stay fenced" }),
    }), dependencies);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "structured hosts on macOS require the Viewer server to run with Bun" });
    expect(registryFactoryCalls).toBe(0);
    expect(accountLookups).toBe(0);
    expect(structuredSpawns).toBe(0);
    expect(fs.readFileSync(registryPath)).toEqual(registryBytes);
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
      body: JSON.stringify({ title: "Test semantic spawn", engine: "claude", cwd, prompt: "inspect", images: candidate.images }),
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
      body: JSON.stringify({ title: "Test semantic spawn", engine: "claude", cwd, ["prompt"]: "inspect", images: [{ base64: png, mime: "image/png" }], clientAttemptId: "image_storage_failure_20260825" }),
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

test("an oversized structured spawn prompt returns 413 before receipts, blobs, or deferral", async () => {
  const cwd = fs.mkdtempSync(path.join(routeSandbox, "oversized-spawn-prompt-"));
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
  let stores = 0;
  let deferred = 0;
  const dependencies: SpawnRouteTestDependencies = {
    ...structuredRouteDependencies(cwd),
    defer: () => { deferred += 1; },
    storeImages: () => { stores += 1; return []; },
  };
  const beforeReceipts = Object.keys(agentRegistry().snapshot().receipts).sort();
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489", "hex").toString("base64");
  try {
    /* 10667 three-byte characters = 32001 UTF-8 bytes in 10667 UTF-16 units:
       a length-measured gate would have admitted this prompt. */
    const response = await POST.withDependencies(new NextRequest("http://127.0.0.1:8898/api/spawn", {
      method: "POST",
      headers: {
        host: "127.0.0.1:8898",
        origin: "http://127.0.0.1:8898",
        "sec-fetch-site": "same-origin",
        "content-type": "application/json",
      },
      body: JSON.stringify({ title: "Test semantic spawn",
        engine: "claude",
        cwd,
        "prompt": "€".repeat(10_667),
        clientAttemptId: `attempt_${crypto.randomUUID()}`,
        images: [{ base64: png, mime: "image/png" }],
      }),
    }), dependencies);

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: expect.stringContaining("32000-byte envelope") });
    expect(stores).toBe(0);
    expect(deferred).toBe(0);
    expect(Object.keys(agentRegistry().snapshot().receipts).sort()).toEqual(beforeReceipts);
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

test("an orphan replay whose image storage fails releases its admission lease for the retry", async () => {
  const cwd = fs.mkdtempSync(path.join(routeSandbox, "replay-storage-release-"));
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
  const store = agentRegistry();
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489", "hex").toString("base64");
  const attemptId = `attempt_${crypto.randomUUID()}`;
  const request = () => new NextRequest("http://127.0.0.1:8898/api/spawn", {
    method: "POST",
    headers: {
      host: "127.0.0.1:8898",
      origin: "http://127.0.0.1:8898",
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
    },
    body: JSON.stringify({ title: "Test semantic spawn",
      engine: "claude",
      cwd,
      "prompt": "own the retry",
      clientAttemptId: attemptId,
      images: [{ base64: png, mime: "image/png" }],
    }),
  });
  const deferred: Array<() => Promise<void>> = [];
  const dependencies = (storeImages: SpawnRouteTestDependencies["storeImages"]): SpawnRouteTestDependencies => ({
    ...structuredRouteDependencies(cwd),
    defer: (work) => { deferred.push(work); },
    storeImages,
  });
  try {
    const admitted = await POST.withDependencies(request(), dependencies((images) => structuredRouteDependencies(cwd).storeImages(images)));
    expect(admitted.status).toBe(202);
    const { launchId } = await admitted.json() as { launchId: string };
    expect(deferred).toHaveLength(1);

    /* The admitting process dies before its deferred launch ran: the durable
       receipt keeps starting with no live admission owner. */
    const orphanOwner = store.snapshot().receipts[launchId]!.admissionOwner!;
    expect(store.releaseStartingStructuredSpawn(launchId, orphanOwner)).toMatchObject({ released: true });

    /* The replay claims the orphan, then image storage fails before anything
       was deferred: the claimed lease must be handed back, not kept by this
       live process with no pending work. */
    const failed = await POST.withDependencies(request(), dependencies(() => {
      throw new Error("runtime image storage quota exceeded");
    }));
    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({ error: "runtime image storage quota exceeded" });
    expect(deferred).toHaveLength(1);
    expect(store.snapshot().receipts[launchId]).toMatchObject({ state: "starting", admissionOwner: null });

    /* The retry re-claims the released lease and defers the launch. */
    const retried = await POST.withDependencies(request(), dependencies((images) => structuredRouteDependencies(cwd).storeImages(images)));
    expect(retried.status).toBe(202);
    expect(await retried.json()).toMatchObject({ launchId, state: "starting" });
    expect(deferred).toHaveLength(2);
    expect(store.snapshot().receipts[launchId]!.admissionOwner).toMatchObject({ pid: process.pid });

    /* A concurrent replay during the retry's live claim cannot double-defer. */
    const concurrent = await POST.withDependencies(request(), dependencies((images) => structuredRouteDependencies(cwd).storeImages(images)));
    expect(concurrent.status).toBe(202);
    expect(deferred).toHaveLength(2);

    await Promise.all(deferred.map((work) => work()));
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
    body: JSON.stringify({ title: "Test semantic spawn", engine: "codex", cwd: "/repo", prompt: "help" }),
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
  const callerPath = "/sessions/caller-019f4906-3f67-0b72-9fbc-9ec3b5ad1325.jsonl";
  const begun = store.beginSpawnRequest({
    engine: "codex",
    cwd: "/repo",
    spawnCapabilityDigest: crypto.createHash("sha256").update(capability).digest("hex"),
    launchProfile: { title: "Bind agent capability source" },
  });
  if (begun.kind !== "created") throw new Error("expected create");
  const settled = store.settleSpawn(begun.receipt.launchId, {
    key: { engine: "codex", sessionId: "019f4906-3f67-0b72-9fbc-9ec3b5ad1325" },
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
    liveChildrenCap: 20,
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
    launchProfile: { title: "Preserve agent capability admission" },
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
      liveChildrenCap: 20,
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
    body: JSON.stringify({ title: "Test semantic spawn", engine: "codex", cwd: "/repo", prompt: "help" }),
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
    launchProfile: { title: "Refuse delegated sub-agent grant" },
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
    body: JSON.stringify({ title: "Test semantic spawn", src: callerPath, role: "orchestrator", prompt: "Delegate orchestration", allowSubagents: true }),
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
    body: JSON.stringify({ title: "Test semantic spawn", src: "/caller.jsonl", role: "orchestrator", prompt: "Delegate orchestration", allowSubagents: true }),
  }));

  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "working directory is required" });
});

test("operator and agent structured Claude role launches both retain bypass permissions", async () => {
  const cwd = fs.mkdtempSync(path.join(routeSandbox, "operator-permission-"));
  const store = agentRegistry();
  const callerSessionId = crypto.randomUUID();
  const callerAccount = createManagedCodexAccount(`route-caller-${callerSessionId}`);
  const callerPath = path.join(callerAccount.sessionsDir, `${callerSessionId}.jsonl`);
  fs.mkdirSync(path.dirname(callerPath), { recursive: true });
  fs.writeFileSync(callerPath, "{}\n");
  const caller = store.beginSpawnRequest({
    engine: "codex",
    cwd,
    accountId: "caller",
    launchProfile: { title: "Exercise Claude role permissions" },
  });
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
    body: JSON.stringify({ title: "Test semantic spawn", engine: "claude", model: "sonnet", cwd, prompt: "build", src: callerPath, role: "builder", clientAttemptId }),
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

    /* The agent capability lane resolves the same role request to the same
       permission contract, so reusing the operator attempt id is an idempotent
       replay instead of a permission-mode conflict. */
    const crossLaneReplay = await POST.withDependencies(request(agentCapability), structuredRouteDependencies(cwd));
    expect(crossLaneReplay.status).toBe(202);
    expect(await crossLaneReplay.json()).toMatchObject({ state: "starting", effectivePermissionMode: "bypassPermissions" });

    const agentAttemptId = `attempt_${crypto.randomUUID()}`;
    const agentLaunch = await POST.withDependencies(request(agentCapability, agentAttemptId), structuredRouteDependencies(cwd));
    expect(await agentLaunch.json()).toMatchObject({ effectivePermissionMode: "bypassPermissions" });
    const agentReplay = await POST.withDependencies(request(agentCapability, agentAttemptId), structuredRouteDependencies(cwd));
    expect(agentReplay.status).toBe(202);
    expect(await agentReplay.json()).toMatchObject({ state: "starting", effectivePermissionMode: "bypassPermissions" });
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
  const previousCodexBinary = process.env.LLV_CODEX_BINARY;
  const codexBinary = path.join(cwd, "codex-mcp-list");
  fs.writeFileSync(codexBinary, "#!/bin/sh\nprintf '[]'\n");
  fs.chmodSync(codexBinary, 0o755);
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
  process.env.LLV_CODEX_BINARY = codexBinary;
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
    body: JSON.stringify({ title: "Test semantic spawn",
      engine: "claude",
      cwd,
      "prompt": "repair release",
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
    expect(accountResolutions).toEqual(["healthy:account-a", "exact:account-a", "exact:account-a"]);
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
      request({ images: [{ mime: "image/png", base64: Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489", "hex").toString("base64") }] }),
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
    if (previousCodexBinary === undefined) delete process.env.LLV_CODEX_BINARY;
    else process.env.LLV_CODEX_BINARY = previousCodexBinary;
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
      body: JSON.stringify({ title: "Test semantic spawn", engine: "codex", cwd, prompt: "smoke" }),
    }));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "structured spawn is rolled back by LLV_STRUCTURED_HOSTS=0" });
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

test("unknown Codex models reject before image blob and receipt mutation", async () => {
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
      body: JSON.stringify({ title: "Test semantic spawn",
        engine: "codex",
        model: "gpt-5.3-codex-spark",
        cwd,
        "prompt": "inspect",
        images: [{ base64: png, mime: "image/png" }],
      }),
    }), dependencies);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "invalid codex model id \"gpt-5.3-codex-spark\"; valid codex model ids: gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna",
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
      body: JSON.stringify({ title: "Test semantic spawn",
        engine: "claude",
        cwd,
        "prompt": "Own issue #282",
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

test("spawn supersedes admission validates the predecessor and stages the settlement edge", async () => {
  const cwd = fs.mkdtempSync(path.join(routeSandbox, "supersedes-admission-"));
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
  const store = new AgentRegistry(path.join(cwd, "agent-registry.json"), undefined, undefined, { sqliteMode: "off" });
  const sessionId = "0af7a2b1-1111-0111-8111-111111111111";
  const predecessorPath = path.join(cwd, `${sessionId}.jsonl`);
  const predecessor = store.ensureConversation("claude", predecessorPath, "claude-test");
  const hostEntry = {
    key: { engine: "claude" as const, sessionId },
    artifactPath: predecessorPath,
    cwd,
    accountId: "claude-test",
    status: "live" as const,
    host: null,
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: null,
  };
  const dependencies = {
    ...structuredRouteDependencies(cwd),
    registry: () => store,
  } satisfies SpawnRouteTestDependencies;
  const post = (body: Record<string, unknown>) => POST.withDependencies(new NextRequest("http://127.0.0.1:8898/api/spawn", {
    method: "POST",
    headers: {
      host: "127.0.0.1:8898",
      origin: "http://127.0.0.1:8898",
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
    },
    body: JSON.stringify({ title: "Test semantic spawn", engine: "claude", cwd, prompt: "recover round", ...body }),
  }), dependencies);

  try {
    const unknown = await post({ supersedes: "conversation_missing" });
    expect(unknown.status).toBe(404);

    store.upsert(hostEntry);
    const conflicted = await post({ supersedes: predecessor.id });
    expect(conflicted.status).toBe(409);
    expect(await conflicted.json()).toMatchObject({ successorConversationId: predecessor.id });
    expect(store.conversation(predecessor.id)?.supersededBy).toBeNull();

    store.upsert({ ...hostEntry, status: "dead" });
    /* Transcript-path references resolve too — the orchestrator recovers by
       worktree transcript, not by conversation id. */
    const accepted = await post({ supersedes: predecessorPath, clientAttemptId: "supersede_admission_0001" });
    expect(accepted.status).toBe(202);
    const spawned = await accepted.json() as { launchId: string };
    expect(store.snapshot().receipts[spawned.launchId]?.supersedes).toMatchObject({
      conversationId: predecessor.id,
      reason: "recovery-spawn",
    });
    /* The durable edge waits for settlement — an unfinished spawn must not
       hide the predecessor. */
    expect(store.conversation(predecessor.id)?.supersededBy).toBeNull();
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
    body: JSON.stringify({ title: "Test semantic spawn",
      engine: "claude",
      cwd,
      "prompt": "Own issue #282",
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
      parent: null,
      launched: false,
      retrySafe: true,
      initialMessage: "failed",
      state: "failed",
      transport: "structured",
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

test("a concurrent HTTP replay withholds a staged transcript path (#1123)", async () => {
  const cwd = fs.mkdtempSync(path.join(routeSandbox, "staged-http-replay-"));
  const store = new AgentRegistry(path.join(cwd, "registry.json"), undefined, undefined, { sqliteMode: "off" });
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
    registry: () => store,
    defer: () => {},
  } satisfies SpawnRouteTestDependencies;
  const request = () => new NextRequest("http://127.0.0.1:8898/api/spawn", {
    method: "POST",
    headers: {
      host: "127.0.0.1:8898",
      origin: "http://127.0.0.1:8898",
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      title: "Inspect staged replay publication",
      engine: "claude",
      cwd,
      "prompt": "inspect",
      clientAttemptId: "staged_http_replay_20260830",
    }),
  });

  try {
    const admitted = await POST.withDependencies(request(), dependencies);
    expect(admitted.status).toBe(202);
    const receipt = store.spawnReceiptForClientAttempt("staged_http_replay_20260830");
    if (!receipt) throw new Error("spawn receipt was unavailable");
    const stagedPath = path.join(cwd, "provisional.jsonl");
    store.stageStructuredSpawn(receipt.launchId, {
      key: { engine: "claude", sessionId: "provisional-session" },
      artifactPath: stagedPath,
      cwd,
      accountId: receipt.accountId,
      launchProfile: receipt.launchProfile,
      status: "starting",
      host: null,
      structuredHost: null,
      claimEpoch: 0,
      claimOwner: null,
      pendingAction: "spawn",
    });

    const replay = await POST.withDependencies(request(), dependencies);
    expect(replay.status).toBe(202);
    expect(await replay.json()).toMatchObject({
      launchId: receipt.launchId,
      conversationId: receipt.conversationId,
      state: "path-pending",
      path: null,
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
    body: JSON.stringify({ title: "Test semantic spawn",
      engine: "claude",
      cwd,
      "prompt": "Own issue #282",
      clientAttemptId: "p0_282_runtime_route_replay_20260716_a1",
    }),
  });
  try {
    const admitted = await POST.withDependencies(request(), dependencies);
    const admittedBody = await admitted.json();
    await runDeferred(deferred);
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, `${JSON.stringify({ type: "user", message: { content: "Own issue #282" } })}\n`);

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
  const begun = store.beginSpawnRequest({
    engine: "codex",
    cwd: "/repo",
    accountId: "terra",
    clientAttemptId: "attempt_path_pending",
    requestDigest: "digest",
    launchProfile: { title: "Project path-pending spawn response" },
  });
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
  const begun = store.beginSpawnRequest({
    engine: "codex",
    cwd: "/repo",
    accountId: "terra",
    launchProfile: { title: "Replay completed structured conversation" },
  });
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
  const begun = store.beginSpawnRequest({
    engine: "claude",
    cwd: "/repo",
    accountId: "account-test",
    launchProfile: { title: "Report pane verification failure" },
  });
  if (begun.kind !== "created") throw new Error("expected a new receipt");
  store.bindSpawnPane(begun.receipt.launchId, { endpoint: "/tmp", server: { pid: 9, startIdentity: "9:a" }, paneId: "%9", panePid: { pid: 99, startIdentity: "99:a" }, target: "agents:9.0" });
  store.failSpawn(begun.receipt.launchId, "test spawn failure");

  expect(spawnResponseForReceipt(store.snapshot().receipts[begun.receipt.launchId]!)).toMatchObject({
    launched: false,
    state: "conflict",
    error: "test spawn failure",
  });
});

test("spawn route accepts an explicit stable parent conversation identity", () => {
  const store = registry();
  const parentPath = "/sessions/rollout-019f4906-3f67-0b72-9fbc-9ec3b5ad1326.jsonl";
  const parent = store.ensureConversation("codex", parentPath, "terra");

  expect(resolveSpawnParent({ parentConversationId: parent.id }, store)).toEqual({
    conversationId: parent.id,
    engine: "codex",
    artifactPath: parentPath,
    sessionKey: { engine: "codex", sessionId: "019f4906-3f67-0b72-9fbc-9ec3b5ad1326" },
  });
});

test("reviewer spawn requires one reviewed conversation and resolves its stable identity", () => {
  const store = registry();
  const implementerPath = "/sessions/rollout-019f4906-3f67-0b72-9fbc-9ec3b5ad1326.jsonl";
  const implementer = store.ensureConversation("codex", implementerPath, "terra");

  expect(() => resolveSpawnLineageParent({ role: "reviewer" }, store)).toThrow(SpawnParentError);
  expect(resolveSpawnLineageParent({ role: "reviewer", reviews: implementer.id }, store)).toEqual({
    conversationId: implementer.id,
    engine: "codex",
    artifactPath: implementerPath,
    sessionKey: { engine: "codex", sessionId: "019f4906-3f67-0b72-9fbc-9ec3b5ad1326" },
  });
  expect(() => resolveSpawnLineageParent({ role: "builder", reviews: implementer.id }, store)).toThrow(SpawnParentError);
});

test("reviewer lineage keeps the caller and reviewed implementer distinct", () => {
  const store = registry();
  const callerPath = "/sessions/caller-019f4906-3f67-0b72-9fbc-9ec3b5ad1325.jsonl";
  const implementerPath = "/sessions/implementer-019f4906-3f67-0b72-9fbc-9ec3b5ad1326.jsonl";
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
    launchProfile: { title: "Exercise operator child reservation" },
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
    title: "worker · implement",
    mcpServers: ["viewer"],
    parent: spawnParentSelector(body),
    "prompt": "implement",
    images: [],
  });
}

test("spawn replay keeps its identity after parent succession", () => {
  const store = registry();
  const firstParentPath = "/sessions/parent-019f4906-3f67-0b72-9fbc-9ec3b5ad1326.jsonl";
  const secondParentPath = "/sessions/parent-019f4906-3f67-0b72-9fbc-9ec3b5ad1327.jsonl";
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
    launchProfile: { title: "Replay spawn after parent succession" },
  });
  if (first.kind !== "created") throw new Error("expected create");
  const resumed = store.beginSpawnRequest({
    engine: "codex",
    cwd: "/repo",
    accountId: "terra",
    conversationId: parent.id,
    purpose: "resume-successor",
    launchProfile: { title: "Resume parent for succession replay" },
  });
  if (resumed.kind !== "created") throw new Error("expected resume receipt");
  expect(store.settleSpawn(resumed.receipt.launchId, {
    key: { engine: "codex", sessionId: "019f4906-3f67-0b72-9fbc-9ec3b5ad1327" },
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
  const sourcePath = "/sessions/source-019f4906-3f67-0b72-9fbc-9ec3b5ad1326.jsonl";
  const provisionalPath = "/sessions/provisional-019f4906-3f67-0b72-9fbc-9ec3b5ad1327.jsonl";
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
    launchProfile: { title: "Replay spawn after parent adoption" },
  });
  if (first.kind !== "created") throw new Error("expected create");
  const migration = store.beginSpawnRequest({
    engine: "codex",
    cwd: "/repo",
    accountId: "work",
    conversationId: canonical.id,
    purpose: "migration-successor",
    expectedArtifactPath: provisionalPath,
    launchProfile: { title: "Adopt canonical parent identity" },
  });
  if (migration.kind !== "created") throw new Error("expected migration receipt");
  expect(store.settleSpawn(migration.receipt.launchId, {
    key: { engine: "codex", sessionId: "019f4906-3f67-0b72-9fbc-9ec3b5ad1327" },
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

/* A rollback switch is reached for during an incident, so it must leave the
   deployment able to spawn. `NEXT_PUBLIC_RUNTIME_UI=0` used to leave the
   implicit choice on `structured` while still failing the capability gap, so
   every spawn — tmux included — came back 409. The request below carries a
   directory that does not exist: the cwd check sits *after* the transport
   decision and the gap, so a 400 naming the directory proves the route got
   past both, and the 409 gap proves it did not. */
test("the runtime-UI rollback leaves a default spawn on a transport that can still spawn", async () => {
  const cwd = fs.mkdtempSync(path.join(routeSandbox, "runtime-ui-rollback-"));
  const missing = path.join(cwd, "no-such-directory");
  const previous = {
    transport: process.env.LLV_SPAWN_TRANSPORT,
    hosts: process.env.LLV_STRUCTURED_HOSTS,
    events: process.env.LLV_RUNTIME_EVENTS,
    socket: process.env.LLV_RUNTIME_HOST_SOCKET,
    ui: process.env.NEXT_PUBLIC_RUNTIME_UI,
  };
  delete process.env.LLV_SPAWN_TRANSPORT;
  delete process.env.LLV_STRUCTURED_HOSTS;
  delete process.env.LLV_RUNTIME_EVENTS;
  process.env.LLV_RUNTIME_HOST_SOCKET = path.join(cwd, "runtime.sock");
  process.env.NEXT_PUBLIC_RUNTIME_UI = "0";
  try {
    const response = await POST(new NextRequest("http://127.0.0.1:8898/api/spawn", {
      method: "POST",
      headers: {
        host: "127.0.0.1:8898",
        origin: "http://127.0.0.1:8898",
        "sec-fetch-site": "same-origin",
        "content-type": "application/json",
      },
      body: JSON.stringify({ title: "Test semantic spawn", engine: "codex", cwd: missing, prompt: "smoke" }),
    }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: `directory does not exist: ${missing}` });
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

/* Socket configured, host unreachable — the default path now, since the
   transport is chosen from declared capability. The deferred launch is the only
   owner of the receipt's outcome: the host that would project the dead spawn is
   the one that is down, and the stale-spawn reaper reconciles through the same
   socket. Without a terminal state the operator sees an accepted 202 that never
   becomes a conversation. */
test("a structured launch that dies on an unreachable host terminalizes its receipt", async () => {
  const cwd = fs.mkdtempSync(path.join(routeSandbox, "structured-host-down-"));
  const previous = {
    transport: process.env.LLV_SPAWN_TRANSPORT,
    hosts: process.env.LLV_STRUCTURED_HOSTS,
    events: process.env.LLV_RUNTIME_EVENTS,
    socket: process.env.LLV_RUNTIME_HOST_SOCKET,
    ui: process.env.NEXT_PUBLIC_RUNTIME_UI,
  };
  delete process.env.LLV_SPAWN_TRANSPORT;
  process.env.LLV_STRUCTURED_HOSTS = "1";
  process.env.LLV_RUNTIME_EVENTS = "1";
  process.env.LLV_RUNTIME_HOST_SOCKET = path.join(cwd, "runtime.sock");
  process.env.NEXT_PUBLIC_RUNTIME_UI = "1";
  const store = new AgentRegistry(path.join(cwd, "agent-registry.json"), undefined, undefined, { sqliteMode: "off" });
  let deferred: (() => Promise<void>) | null = null;
  const dependencies = {
    ...structuredRouteDependencies(cwd),
    registry: () => store,
    defer: (work: () => Promise<void>) => { deferred = work; },
    spawnStructuredConversation: async () => {
      throw new RuntimeHostUnavailableError("runtime host is unavailable");
    },
  } as Parameters<typeof POST.withDependencies>[1];
  try {
    const response = await POST.withDependencies(new NextRequest("http://127.0.0.1:8898/api/spawn", {
      method: "POST",
      headers: {
        host: "127.0.0.1:8898",
        origin: "http://127.0.0.1:8898",
        "sec-fetch-site": "same-origin",
        "content-type": "application/json",
      },
      body: JSON.stringify({ title: "Test semantic spawn", engine: "claude", cwd, ["prompt"]: "spawn against a dead host", clientAttemptId: "dead_host_spawn_20260825" }),
    }), dependencies);

    expect(response.status).toBe(202);
    const accepted = await response.json() as { launchId: string };
    expect(store.readOnlySnapshot().receipts[accepted.launchId]?.state).toBe("starting");

    await runDeferred(deferred);

    const settled = store.readOnlySnapshot().receipts[accepted.launchId];
    expect(settled?.state).toBe("failed");
    expect(settled?.error).toContain("runtime host is unavailable");
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
