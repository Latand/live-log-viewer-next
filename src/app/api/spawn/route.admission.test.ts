import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "bun:test";
import { NextRequest } from "next/server";

import type { RuntimeHostClient } from "@/lib/runtime/client";
import type { ViewerConversationId } from "@/lib/accounts/migration/contracts";
import { beginLegacySpawnFixture } from "@/lib/agent/registryTestFixtures";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-spawn-admission-route-"));
const codexBinary = path.join(sandbox, "codex-fixture");
fs.writeFileSync(codexBinary, "#!/bin/sh\nprintf '[]'\n", { mode: 0o700 });
const STRUCTURED_ENV = {
  LLV_STATE_DIR: path.join(sandbox, "state"),
  LLV_SPAWN_TRANSPORT: "structured",
  LLV_STRUCTURED_HOSTS: "1",
  LLV_RUNTIME_EVENTS: "1",
  LLV_RUNTIME_HOST_SOCKET: path.join(sandbox, "runtime.sock"),
  NEXT_PUBLIC_RUNTIME_UI: "1",
  LLV_CODEX_BINARY: codexBinary,
} as const;
const previousEnv = Object.fromEntries(Object.keys(STRUCTURED_ENV).map((key) => [key, process.env[key]]));
Object.assign(process.env, STRUCTURED_ENV);

const { agentRegistry } = await import("@/lib/agent/registry");
const { rotateOperatorSpawnCapability } = await import("@/lib/agent/operatorCapability");
const { POST } = await import("./route");

afterAll(() => {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(sandbox, { recursive: true, force: true });
});

type SpawnRouteTestDependencies = NonNullable<Parameters<typeof POST.withDependencies>[1]>;

function dependencies(cwd: string): SpawnRouteTestDependencies {
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
    storeImages: () => [],
    spawnStructuredConversation: async (input) => ({
      ok: true,
      target: null,
      path: null,
      launchId: input.receipt.launchId,
      conversationId: input.receipt.conversationId,
      launched: true,
      retrySafe: false,
      initialMessage: "delivered",
      state: "settled",
    }),
  };
}

function settleCaller(store: ReturnType<typeof agentRegistry>, launchId: string): { conversationId: ViewerConversationId; path: string } {
  const sessionId = crypto.randomUUID();
  const artifactPath = `/sessions/caller-${sessionId}.jsonl`;
  const settled = store.settleSpawn(launchId, {
    key: { engine: "codex", sessionId },
    artifactPath,
    cwd: "/repo",
    accountId: "terra",
    status: "live",
    host: null,
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: null,
  });
  if (settled.kind !== "settled") throw new Error(`settlement conflict: ${settled.code}`);
  return { conversationId: settled.conversation.id, path: artifactPath };
}

function seedCaller(role: string | null, origin?: { kind: "agent"; conversationId: ViewerConversationId }): { capability: string; conversationId: ViewerConversationId; path: string } {
  const store = agentRegistry();
  const capability = crypto.randomBytes(32).toString("base64url");
  const reviews = role === "reviewer"
    ? store.ensureConversation("codex", `/sessions/reviewed-${crypto.randomUUID()}.jsonl`, "terra").id
    : null;
  const begun = beginLegacySpawnFixture(store, {
    engine: "codex",
    cwd: "/repo",
    role,
    reviewsConversationId: reviews,
    parentConversationId: reviews,
    origin: origin ?? { kind: "operator" },
    spawnCapabilityDigest: crypto.createHash("sha256").update(capability).digest("hex"),
  });
  if (begun.kind !== "created") throw new Error("expected create");
  const settled = settleCaller(store, begun.receipt.launchId);
  return { capability, ...settled };
}

function agentRequest(capability: string, body: Record<string, unknown>): NextRequest {
  return new NextRequest("http://127.0.0.1:8898/api/spawn", {
    method: "POST",
    headers: {
      host: "127.0.0.1:8898",
      "content-type": "application/json",
      "x-llv-spawn-capability": capability,
    },
    body: JSON.stringify({ title: "Exercise spawn route admission", mcpServers: [], ...body }),
  });
}

test("an authenticated reviewer caller receives a typed 403 with a durable terminal receipt and zero child artifacts", async () => {
  const cwd = fs.mkdtempSync(path.join(sandbox, "reviewer-caller-"));
  const caller = seedCaller("reviewer");
  const response = await POST.withDependencies(agentRequest(caller.capability, {
    cwd,
    ["prompt"]: "spawn a helper",
    src: caller.path,
    role: "builder",
  }), dependencies(cwd));

  expect(response.status).toBe(403);
  const body = await response.json() as { error: string; code: string; launchId: string; conversationId: string; rejection: { code: string; origin: { role: string } } };
  expect(body.code).toBe("reviewer_origin_spawn");
  expect(body.error).toContain("in-session");
  expect(body.rejection.origin).toMatchObject({ role: "reviewer", conversationId: caller.conversationId });

  const snapshot = agentRegistry().snapshot();
  expect(snapshot.receipts[body.launchId]).toMatchObject({ state: "failed", rejection: { code: "reviewer_origin_spawn" } });
  expect(snapshot.conversations[body.conversationId]).toBeUndefined();
  expect(snapshot.lineageEdges[body.conversationId]).toBeUndefined();
  expect(snapshot.memberships[body.conversationId]).toBeUndefined();
});

test("a verifier caller is rejected identically", async () => {
  const cwd = fs.mkdtempSync(path.join(sandbox, "verifier-caller-"));
  const caller = seedCaller("verifier");
  const response = await POST.withDependencies(agentRequest(caller.capability, {
    cwd,
    ["prompt"]: "spawn a helper",
    src: caller.path,
    role: "builder",
  }), dependencies(cwd));

  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ code: "reviewer_origin_spawn" });
});

test("a caller at the depth ceiling receives a typed nesting 403 before any child transcript", async () => {
  const cwd = fs.mkdtempSync(path.join(sandbox, "depth-caller-"));
  const rootCaller = seedCaller("orchestrator");
  const depth1 = seedCaller("builder", { kind: "agent", conversationId: rootCaller.conversationId });
  const depth2 = seedCaller("builder", { kind: "agent", conversationId: depth1.conversationId });

  const allowedResponse = await POST.withDependencies(agentRequest(depth1.capability, {
    cwd,
    ["prompt"]: "one more helper",
    src: depth1.path,
    role: "builder",
  }), dependencies(cwd));
  expect(allowedResponse.status).toBe(202);

  const response = await POST.withDependencies(agentRequest(depth2.capability, {
    cwd,
    ["prompt"]: "too deep",
    src: depth2.path,
    role: "builder",
  }), dependencies(cwd));

  expect(response.status).toBe(403);
  const body = await response.json() as { code: string; rejection: { childDepth: number; maxDepth: number } };
  expect(body.code).toBe("nesting_depth_exceeded");
  expect(body.rejection).toMatchObject({ childDepth: 3, maxDepth: 2 });
});

test("reviewer and verifier launches cannot enable subagents on any lane", async () => {
  const operator = rotateOperatorSpawnCapability();
  const operatorResponse = await POST(agentRequest(operator, {
    cwd: "/repo",
    ["prompt"]: "review",
    src: "/caller.jsonl",
    role: "reviewer",
    roleParams: { diffSource: "PR #1" },
    reviews: "/implementer.jsonl",
    allowSubagents: true,
  }));
  expect(operatorResponse.status).toBe(400);
  expect(await operatorResponse.json()).toEqual({ error: expect.stringContaining("cannot enable subagents") });

  const browserResponse = await POST(new NextRequest("http://127.0.0.1:8898/api/spawn", {
    method: "POST",
    headers: {
      host: "127.0.0.1:8898",
      origin: "http://127.0.0.1:8898",
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
    },
    body: JSON.stringify({ cwd: "/repo", prompt: "verify", role: "verifier", roleParams: { claims: "the fix holds" }, allowSubagents: true }),
  }));
  expect(browserResponse.status).toBe(400);
  expect(await browserResponse.json()).toEqual({ error: expect.stringContaining("cannot enable subagents") });
});

test("a non-reviewer agent caller keeps spawning normally", async () => {
  const cwd = fs.mkdtempSync(path.join(sandbox, "builder-caller-"));
  const caller = seedCaller("builder");
  const response = await POST.withDependencies(agentRequest(caller.capability, {
    cwd,
    ["prompt"]: "delegate",
    src: caller.path,
    role: "builder",
  }), dependencies(cwd));

  expect(response.status).toBe(202);
  const body = await response.json() as { launchId: string };
  expect(agentRegistry().snapshot().receipts[body.launchId]).toMatchObject({
    agentRole: "builder",
    delegationDepth: 1,
    rejection: null,
  });
});

test("an agent capability caller without src spawns with an inferred durable parent (#341)", async () => {
  const cwd = fs.mkdtempSync(path.join(sandbox, "inferred-parent-"));
  const caller = seedCaller("builder");
  const response = await POST.withDependencies(agentRequest(caller.capability, {
    cwd,
    ["prompt"]: "delegate without src",
    role: "builder",
    clientAttemptId: "inferred_parent_20260719_a1",
  }), dependencies(cwd));

  expect(response.status).toBe(202);
  const body = await response.json() as { launchId: string; conversationId: string; parent: unknown };
  expect(body.parent).toEqual({ conversationId: caller.conversationId, source: "inferred-caller" });

  const snapshot = agentRegistry().snapshot();
  expect(snapshot.receipts[body.launchId]).toMatchObject({
    parentConversationId: caller.conversationId,
    parentSource: "inferred-caller",
  });
  expect(snapshot.lineageEdges[body.conversationId]).toMatchObject({
    childConversationId: body.conversationId,
    parentConversationId: caller.conversationId,
    evidence: { launchId: body.launchId, parentSource: "inferred-caller" },
  });

  /* A replay of the same gesture folds onto the same receipt with the same
     inferred parent — the digest keys on the resolved parent selector. */
  const replay = await POST.withDependencies(agentRequest(caller.capability, {
    cwd,
    ["prompt"]: "delegate without src",
    role: "builder",
    clientAttemptId: "inferred_parent_20260719_a1",
  }), dependencies(cwd));
  expect([200, 202]).toContain(replay.status);
  expect(await replay.json()).toMatchObject({
    launchId: body.launchId,
    parent: { conversationId: caller.conversationId, source: "inferred-caller" },
  });
});

test("an explicit src is recorded explicit and a mismatched src stays rejected (#341)", async () => {
  const cwd = fs.mkdtempSync(path.join(sandbox, "explicit-parent-"));
  const caller = seedCaller("builder");
  const explicit = await POST.withDependencies(agentRequest(caller.capability, {
    cwd,
    ["prompt"]: "delegate with src",
    src: caller.path,
    role: "builder",
  }), dependencies(cwd));
  expect(explicit.status).toBe(202);
  expect(await explicit.json()).toMatchObject({
    parent: { conversationId: caller.conversationId, source: "explicit" },
  });

  const other = seedCaller("builder");
  const mismatched = await POST.withDependencies(agentRequest(caller.capability, {
    cwd,
    ["prompt"]: "spoofed parent",
    src: other.path,
    role: "builder",
  }), dependencies(cwd));
  expect(mismatched.status).toBe(403);
  expect(await mismatched.json()).toEqual({ error: "src must identify the authenticated caller conversation" });
});

test("an operator capability caller without src proceeds as a silent root (#341)", async () => {
  const cwd = fs.mkdtempSync(path.join(sandbox, "operator-root-"));
  const operator = rotateOperatorSpawnCapability();
  const response = await POST.withDependencies(agentRequest(operator, {
    cwd,
    ["prompt"]: "pipeline launch without src",
    role: "builder",
  }), dependencies(cwd));

  expect(response.status).toBe(202);
  const body = await response.json() as { launchId: string; conversationId: string; parent: unknown };
  expect(body.parent).toBeNull();

  const snapshot = agentRegistry().snapshot();
  expect(snapshot.receipts[body.launchId]).toMatchObject({
    parentConversationId: null,
    parentSource: null,
  });
  expect(snapshot.lineageEdges[body.conversationId]).toBeUndefined();
});
