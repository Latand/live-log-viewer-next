import { afterAll, beforeEach, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NextRequest } from "next/server";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-accounts-route-test-"));
const OLD_STATE = process.env.LLV_STATE_DIR;
const OLD_HOME = process.env.LLV_CODEX_HOME;
const OLD_CLAUDE_HOME = process.env.LLV_CLAUDE_HOME;
process.env.LLV_STATE_DIR = path.join(SANDBOX, "state");
process.env.LLV_CODEX_HOME = path.join(SANDBOX, "legacy");
process.env.LLV_CLAUDE_HOME = path.join(SANDBOX, "legacy-claude");

const { GET } = await import("./route");
const { POST } = await import("./codex/active/route");
const { POST: setClaudeActive } = await import("./claude/active/route");
const { POST: createClaude } = await import("./claude/route");
const { updateMigrationAction } = await import("../account-migrations/[intentId]/action");
const { activeClaudeAccountId, createManagedClaudeAccount, setActiveClaudeAccount } = await import("@/lib/accounts/claude");
const { activeCodexAccountId, createManagedCodexAccount, listCodexAccounts, setActiveCodexAccount, setCodexAccountLoginPane } = await import("@/lib/accounts/codex");
const { selectAccount } = await import("@/lib/accounts/manager");
const { CodexAppServerClient } = await import("@/lib/accounts/codexAppServer");
const { ManagedCodexRuntime, setManagedCodexRuntimeForTests } = await import("@/lib/accounts/codexRuntime");
const { setClaudeLoginSupervisorForTests } = await import("@/lib/accounts/claudeLogin");
const { AgentRegistry, agentRegistry } = await import("@/lib/agent/registry");
const { emptyLaunchProfile } = await import("@/lib/accounts/migration/contracts");

class FakeChild extends EventEmitter {
  authenticated = false;
  readonly stdin = { write: (line: string) => { this.handle(JSON.parse(line) as Record<string, unknown>); return true; }, end: () => undefined };
  readonly stdout = { on: (_event: string, listener: (chunk: string) => void) => this.on("stdout", listener) };
  readonly stderr = { on: (_event: string, listener: (chunk: string) => void) => this.on("stderr", listener) };
  kill(): boolean { return true; }
  handle(message: Record<string, unknown>): void {
    if (typeof message.id !== "number") return;
    if (message.method === "initialize") this.respond(message.id, {});
    if (message.method === "account/read") this.respond(message.id, this.authenticated ? { account: { type: "chatgpt" }, requiresOpenaiAuth: false } : { account: null, requiresOpenaiAuth: true });
  }
  respond(id: number, result: unknown): void { this.emit("stdout", JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n"); }
}

function installRuntime(authenticated: boolean): void {
  setManagedCodexRuntimeForTests(new ManagedCodexRuntime({ startClient: async (home) => {
    const child = new FakeChild();
    child.authenticated = authenticated;
    return CodexAppServerClient.start({ home, spawn: () => child as never });
  } }));
}

beforeEach(() => {
  fs.rmSync(process.env.LLV_STATE_DIR!, { recursive: true, force: true });
  installRuntime(false);
});
afterAll(() => {
  setClaudeLoginSupervisorForTests(null);
  setManagedCodexRuntimeForTests(null);
  if (OLD_STATE === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = OLD_STATE;
  if (OLD_HOME === undefined) delete process.env.LLV_CODEX_HOME;
  else process.env.LLV_CODEX_HOME = OLD_HOME;
  if (OLD_CLAUDE_HOME === undefined) delete process.env.LLV_CLAUDE_HOME;
  else process.env.LLV_CLAUDE_HOME = OLD_CLAUDE_HOME;
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

function request(id: unknown, headers: HeadersInit = { host: "127.0.0.1" }): NextRequest {
  return new NextRequest("http://127.0.0.1/api/accounts/codex/active", { method: "POST", headers, body: JSON.stringify({ id }) });
}

function activeRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest("http://127.0.0.1/api/accounts/codex/active", {
    method: "POST",
    headers: { host: "127.0.0.1", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function authenticateCodex(account: { home: string }): void {
  fs.writeFileSync(path.join(account.home, "auth.json"), "{}", { mode: 0o600 });
}

function authenticateClaude(account: { home: string }): void {
  fs.writeFileSync(path.join(account.home, ".credentials.json"), "{}", { mode: 0o600 });
}

function claudeActiveRequest(id: string): NextRequest {
  return new NextRequest("http://127.0.0.1/api/accounts/claude/active", {
    method: "POST",
    headers: { host: "127.0.0.1", "content-type": "application/json" },
    body: JSON.stringify({ id }),
  });
}

test("accounts GET is secret-free and leaves login reconciliation to the controller", async () => {
  const account = createManagedCodexAccount("Work");
  setCodexAccountLoginPane(account.id, { paneId: "%does-not-exist", windowName: "codex-login", startedAt: 0 });

  const response = await GET();
  const body = await response.json() as { codex: { accounts: { id: string; loginPending: boolean; loginState: string; deviceAuth: unknown }[] } };

  expect(JSON.stringify(body)).not.toContain("token");
  expect(body.codex.accounts.find((item) => item.id === account.id)?.loginPending).toBe(true);
  expect(body.codex.accounts.find((item) => item.id === account.id)).toEqual(expect.objectContaining({ loginState: "pending", deviceAuth: null }));
  expect(listCodexAccounts().find((item) => item.id === account.id)?.loginPane).not.toBeNull();
});

test("retrying failed migrations requests one immediate reconciliation cycle", async () => {
  const registry = new AgentRegistry(path.join(SANDBOX, "retry-action-registry.json"));
  const conversation = registry.ensureConversation("codex", "/retry-now.jsonl", "source");
  const intent = registry.commitMigrationIntent({
    engine: "codex",
    targetId: "target",
    origin: "manual",
    requestId: "retry-now",
    expectedRevision: registry.engineRouting("codex").revision,
    scope: "all",
  });
  const migration = registry.conversation(conversation.id)!.migration!;
  registry.transitionConversationMigration(conversation.id, migration.revision, [migration.phase], {
    phase: "failed-recoverable",
    error: "retry",
    errorCode: "provider-failed",
  });
  let ticks = 0;
  const requestTick = () => { ticks += 1; };
  const response = await updateMigrationAction(new NextRequest(`http://127.0.0.1/api/account-migrations/${intent.id}`, {
    method: "POST",
    headers: { host: "127.0.0.1", "content-type": "application/json" },
    body: JSON.stringify({ action: "retry-failed", expectedRevision: intent.revision }),
  }), { params: Promise.resolve({ intentId: intent.id }) }, registry, requestTick);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ retried: 1 });
  expect(ticks).toBe(1);

  const stale = await updateMigrationAction(new NextRequest(`http://127.0.0.1/api/account-migrations/${intent.id}`, {
    method: "POST",
    headers: { host: "127.0.0.1", "content-type": "application/json" },
    body: JSON.stringify({ action: "retry-failed", expectedRevision: intent.revision + 1 }),
  }), { params: Promise.resolve({ intentId: intent.id }) }, registry, requestTick);
  expect(stale.status).toBe(409);
  expect(ticks).toBe(1);
});

test("managed authentication projects only a durable live controller observation", async () => {
  const account = createManagedCodexAccount("Done");
  fs.writeFileSync(path.join(account.home, "auth.json"), "credential sentinel");
  setCodexAccountLoginPane(account.id, { paneId: "%does-not-matter", windowName: "codex-login", startedAt: 0 });

  const response = await GET();
  const body = await response.json() as { codex: { accounts: { id: string; loginState: string; deviceAuth: unknown }[] } };
  expect(body.codex.accounts.find((item) => item.id === account.id)).toEqual(expect.objectContaining({ loginState: "pending", deviceAuth: null }));
  const observedAt = new Date().toISOString();
  agentRegistry().recordQuotaEvaluation({
    engine: "codex",
    observations: [{
      engine: "codex",
      accountId: account.id,
      authenticated: true,
      authCheckedAt: observedAt,
      limits: { session: { usedPercent: 20, resetsAt: null }, weekly: null, plan: "pro", capturedAt: Math.floor(Date.now() / 1000) },
      provenance: { source: "live", reason: null, staleSince: null },
      observedAt,
      bootId: "route-test",
    }],
    signature: null,
    bootId: "route-test",
    now: observedAt,
    minimumGapMs: 60_000,
  });
  const valid = await GET();
  const validBody = await valid.json() as { codex: { accounts: { id: string; loginState: string; deviceAuth: unknown }[] } };

  expect(validBody.codex.accounts.find((item) => item.id === account.id)).toEqual(expect.objectContaining({ loginState: "authenticated", deviceAuth: null }));
  expect(listCodexAccounts().find((item) => item.id === account.id)?.loginPane).not.toBeNull();
});

test("future quota and auth observations remain ineligible", async () => {
  const account = createManagedCodexAccount("Future");
  setCodexAccountLoginPane(account.id, { paneId: "%future", windowName: "codex-login", startedAt: 0 });
  const observedAt = new Date(Date.now() + 60_000).toISOString();
  agentRegistry().recordQuotaEvaluation({
    engine: "codex",
    observations: [{
      engine: "codex",
      accountId: account.id,
      authenticated: true,
      authCheckedAt: observedAt,
      limits: { session: { usedPercent: 1, resetsAt: null }, weekly: null, plan: "pro", capturedAt: Math.floor(Date.now() / 1000) },
      provenance: { source: "live", reason: null, staleSince: null },
      observedAt,
      bootId: "future-route-test",
    }],
    signature: null,
    bootId: "future-route-test",
    now: observedAt,
    minimumGapMs: 60_000,
  });

  const body = await (await GET()).json() as { codex: { accounts: { id: string; loginState: string; effective: unknown }[] } };
  expect(body.codex.accounts.find((item) => item.id === account.id)).toEqual(expect.objectContaining({
    loginState: "pending",
    effective: null,
  }));
});

test("GET stays readable for a partially corrupt registry and leaves its bytes untouched", async () => {
  const registry = path.join(process.env.LLV_STATE_DIR!, "codex-accounts.json");
  fs.mkdirSync(path.dirname(registry), { recursive: true });
  // One retained valid account carrying a stale (dead-pane) login, plus one rejected
  // record that flips the store to mutation-locked. The GET must not attempt the
  // best-effort clear, so it neither 500s nor rewrites the file.
  const mixed = JSON.stringify({
    version: 1,
    active: "default",
    accounts: [
      { id: "work", label: "Work", kind: "managed", createdAt: 1, loginPane: { paneId: "%dead", windowName: "codex-login", startedAt: 0 } },
      { id: "../escape", label: "Escape", kind: "managed", createdAt: 2 },
    ],
  });
  fs.writeFileSync(registry, mixed);

  const response = await GET();
  expect(response.status).toBe(200);
  const body = await response.json() as { codex: { active: string; accounts: { id: string }[] } };
  expect(body.codex.active).toBe("default");
  expect(body.codex.accounts.map((item) => item.id).sort()).toEqual(["default", "work"]);
  expect(fs.readFileSync(registry, "utf8")).toBe(mixed);
});

test("active mutation rejects cross-origin, unknown, and corrupt catalogs", async () => {
  expect((await POST(request("default", { host: "evil.example", origin: "https://evil.example" }))).status).toBe(403);
  const routingBefore = agentRegistry().snapshot().engineRouting.codex;
  expect((await POST(request("missing"))).status).toBe(400);
  expect(agentRegistry().snapshot().engineRouting.codex).toEqual(routingBefore);

  const registry = path.join(process.env.LLV_STATE_DIR!, "codex-accounts.json");
  fs.mkdirSync(path.dirname(registry), { recursive: true });
  fs.writeFileSync(registry, "{ corrupt");
  const response = await POST(request("default"));
  expect(response.status).toBe(400);
  expect(fs.readFileSync(registry, "utf8")).toBe("{ corrupt");
});

test("Codex selection changes routing while preserving every conversation record", async () => {
  const target = createManagedCodexAccount("Routing target");
  authenticateCodex(target);
  agentRegistry().reconcileConversations([{
    engine: "codex",
    path: "/root.jsonl",
    accountId: "default",
    launchProfile: emptyLaunchProfile({ role: "root", title: "Root" }),
    turn: { state: "idle", source: "empty", terminalAt: null },
    observedAt: "2026-07-10T12:00:00.000Z",
  }]);
  const before = agentRegistry().snapshot();
  const response = await POST(activeRequest({ id: target.id, mode: "select" }));
  const after = agentRegistry().snapshot();

  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ active: target.id, account: { id: target.id, active: true } });
  expect(after.engineRouting.codex.activeAccountId).toBe(target.id);
  expect(after.conversations).toEqual(before.conversations);
  expect(after.migrationIntents).toEqual(before.migrationIntents);
  expect(after.heldDeliveries).toEqual(before.heldDeliveries);
  setActiveCodexAccount("default");
  agentRegistry().setEngineRouting("codex", "default");
});

test("Claude selection also updates only routing and the account catalog", async () => {
  const target = createManagedClaudeAccount("Routing target");
  authenticateClaude(target);
  const before = agentRegistry().snapshot();
  const response = await setClaudeActive(activeRequest({ id: target.id, mode: "select" }));
  const after = agentRegistry().snapshot();

  expect(response.status).toBe(200);
  expect(after.engineRouting.claude.activeAccountId).toBe(target.id);
  expect(after.conversations).toEqual(before.conversations);
  expect(after.migrationIntents).toEqual(before.migrationIntents);
  setActiveClaudeAccount("default");
  agentRegistry().setEngineRouting("claude", "default");
});

test("active routes reject transcript migration modes", async () => {
  const codex = createManagedCodexAccount("Codex target");
  const claude = createManagedClaudeAccount("Claude target");
  const before = agentRegistry().snapshot();

  expect((await POST(activeRequest({ id: codex.id, mode: "migrate", previewRevision: 0 }))).status).toBe(400);
  expect((await setClaudeActive(activeRequest({ id: claude.id, mode: "preview" }))).status).toBe(400);
  expect(agentRegistry().snapshot()).toEqual(before);
});

test("active routes reject signed-out accounts before changing either routing store", async () => {
  const codex = createManagedCodexAccount("Signed-out Codex");
  const claude = createManagedClaudeAccount("Signed-out Claude");
  const before = agentRegistry().snapshot();

  const codexResponse = await POST(activeRequest({ id: codex.id, mode: "select" }));
  const claudeResponse = await setClaudeActive(activeRequest({ id: claude.id, mode: "select" }));

  expect(codexResponse.status).toBe(409);
  expect(await codexResponse.json()).toMatchObject({ code: "authentication_required" });
  expect(claudeResponse.status).toBe(409);
  expect(await claudeResponse.json()).toMatchObject({ code: "authentication_required" });
  expect(activeCodexAccountId()).toBe("default");
  expect(activeClaudeAccountId()).toBe("default");
  expect(agentRegistry().snapshot()).toEqual(before);
});

test("active routes reject authenticated accounts while login is in progress", async () => {
  const codex = createManagedCodexAccount("Logging-in Codex");
  const claude = createManagedClaudeAccount("Logging-in Claude");
  authenticateCodex(codex);
  authenticateClaude(claude);
  setCodexAccountLoginPane(codex.id, { paneId: "%login", windowName: "codex-login", startedAt: Date.now() });
  setClaudeLoginSupervisorForTests({
    forAccount: (accountId: string) => accountId === claude.id ? {
      operationId: "claude-login-pending",
      phase: "verifying",
      loginUrl: null,
      acceptsCode: false,
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
      result: null,
    } : null,
  } as never);
  const before = agentRegistry().snapshot();

  try {
    const codexResponse = await POST(activeRequest({ id: codex.id, mode: "select" }));
    const claudeResponse = await setClaudeActive(activeRequest({ id: claude.id, mode: "select" }));

    expect(codexResponse.status).toBe(409);
    expect(await codexResponse.json()).toMatchObject({ code: "login_pending" });
    expect(claudeResponse.status).toBe(409);
    expect(await claudeResponse.json()).toMatchObject({ code: "login_pending" });
    expect(activeCodexAccountId()).toBe("default");
    expect(activeClaudeAccountId()).toBe("default");
    expect(agentRegistry().snapshot()).toEqual(before);
  } finally {
    setCodexAccountLoginPane(codex.id, null);
    setClaudeLoginSupervisorForTests(null);
  }
});

test("a routing-store write failure restores both active-account values", () => {
  const target = createManagedCodexAccount("Rollback target");
  authenticateCodex(target);
  let currentRoutingId: string | null = "default";
  let failTargetWrite = true;
  const routing = {
    engineRouting() { return { activeAccountId: currentRoutingId, revision: 0 }; },
    setEngineRouting(_engine: "claude" | "codex", accountId: string) {
      currentRoutingId = accountId;
      if (accountId === target.id && failTargetWrite) {
        failTargetWrite = false;
        throw new Error("injected routing write failure");
      }
      return 1;
    },
  };

  expect(() => selectAccount("codex", target.id, routing)).toThrow("injected routing write failure");
  expect(activeCodexAccountId()).toBe("default");
  expect(currentRoutingId).toBe("default");
});

test("GET retains the latest completed intent with recoverable failures for bulk retry", async () => {
  const target = createManagedCodexAccount("Recovery target");
  for (const existing of Object.values(agentRegistry().snapshot().migrationIntents)) {
    if (existing.state === "draining") agentRegistry().setMigrationIntentState(existing.id, "stopped");
  }
  agentRegistry().reconcileConversations([{
    engine: "codex",
    path: "/recoverable.jsonl",
    accountId: "default",
    launchProfile: emptyLaunchProfile(),
    turn: { state: "idle", source: "empty", terminalAt: null },
    observedAt: "2026-07-10T12:00:00.000Z",
  }]);
  const conversation = agentRegistry().conversationForPath("/recoverable.jsonl")!;
  const intent = agentRegistry().commitMigrationIntent({ engine: "codex", targetId: target.id, origin: "manual", requestId: "recoverable-projection", expectedRevision: agentRegistry().engineRouting("codex").revision });
  const revision = agentRegistry().conversation(conversation.id)!.migration!.revision;
  agentRegistry().transitionConversationMigration(conversation.id, revision, ["requested"], { phase: "failed-recoverable", error: "retry later", errorCode: "provider-failed" });
  agentRegistry().setMigrationIntentState(intent.id, "complete");

  const body = await (await GET()).json() as { codex: { migration: { intentId: string; state: string; counts: { failed: number; total: number } } | null } };

  expect(body.codex.migration).toEqual(expect.objectContaining({
    intentId: intent.id,
    state: "complete",
    counts: expect.objectContaining({ failed: 1 }),
  }));

  agentRegistry().retryConversationMigration(conversation.id, revision);
  agentRegistry().transitionConversationMigration(conversation.id, revision, ["requested"], { phase: "preparing" });
  agentRegistry().transitionConversationMigration(conversation.id, revision, ["preparing"], { phase: "successor-starting" });
  agentRegistry().transitionConversationMigration(conversation.id, revision, ["successor-starting"], {
    phase: "verifying",
    providerReceipt: {
      operationId: agentRegistry().conversation(conversation.id)!.migration!.operationId,
      nativeId: "recovered-successor",
      path: "/recovered-successor.jsonl",
      continuityPaths: [],
      historyHash: "recovered",
      host: { kind: "codex-app-server", identity: "recovered", epoch: 1, verifiedAt: "2026-07-10T12:01:00.000Z" },
    },
  });
  agentRegistry().commitSuccessor(conversation.id, {
    id: "recovered-successor",
    path: "/recovered-successor.jsonl",
    accountId: target.id,
    launchProfile: emptyLaunchProfile(),
    historyHash: "recovered",
    host: { kind: "codex-app-server", identity: "recovered", epoch: 1, verifiedAt: "2026-07-10T12:01:00.000Z" },
  }, revision);
  agentRegistry().setMigrationIntentState(intent.id, "complete");

  const afterRetry = await (await GET()).json() as { codex: { migration: unknown } };
  expect(afterRetry.codex.migration).toBeNull();
});

test("Claude DTOs remain secret-free and creation rejects cross-origin before any state change", async () => {
  const response = await GET();
  const body = await response.json() as { claude: { active: string; accounts: unknown[] } };
  expect(body.claude.active).toBe("default");
  expect(JSON.stringify(body)).not.toContain("credentials");
  const req = new NextRequest("http://127.0.0.1/api/accounts/claude", { method: "POST", headers: { host: "evil.example", origin: "https://evil.example" }, body: JSON.stringify({ label: "Work" }) });
  expect((await createClaude(req)).status).toBe(403);
  expect(fs.existsSync(path.join(process.env.LLV_STATE_DIR!, "claude-accounts.json"))).toBe(false);
});
