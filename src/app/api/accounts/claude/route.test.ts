import { afterAll, beforeEach, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NextRequest } from "next/server";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-claude-login-route-test-"));
const oldState = process.env.LLV_STATE_DIR;
const oldHome = process.env.LLV_CLAUDE_HOME;
process.env.LLV_STATE_DIR = path.join(sandbox, "state");
process.env.LLV_CLAUDE_HOME = path.join(sandbox, "legacy");

const { ClaudeLoginSupervisor, setClaudeLoginSupervisorForTests } = await import("@/lib/accounts/claudeLogin");
const { claudeRegistryPath, createManagedClaudeAccount } = await import("@/lib/accounts/claude");
const { agentRegistry } = await import("@/lib/agent/registry");
const { DELETE: remove, POST } = await import("./route");
const { DELETE } = await import("./login/[operationId]/route");
const { POST: submitInput } = await import("./login/[operationId]/input/route");

class FakeChild extends EventEmitter {
  pid = 4312;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = { write: () => true, end: () => undefined };
}

let child: FakeChild;

beforeEach(() => {
  fs.rmSync(process.env.LLV_STATE_DIR!, { recursive: true, force: true });
  fs.rmSync(path.join(sandbox, "accounts"), { recursive: true, force: true });
  child = new FakeChild();
  setClaudeLoginSupervisorForTests(new ClaudeLoginSupervisor({
    spawn: () => child as never,
    kill: () => undefined,
    pidStartToken: () => "start-4312",
    isExpectedClaude: () => true,
    waitForExit: async () => undefined,
    status: async () => ({ loggedIn: false, method: null, email: null, plan: null }),
    now: () => 1_000,
    setTimeout: (callback, ms) => { if (ms <= 2_000) callback(); return {} as NodeJS.Timeout; },
    clearTimeout: () => undefined,
  }));
});

afterAll(() => {
  setClaudeLoginSupervisorForTests(null);
  if (oldState === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = oldState;
  if (oldHome === undefined) delete process.env.LLV_CLAUDE_HOME;
  else process.env.LLV_CLAUDE_HOME = oldHome;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

test("POST starts Claude login in a clean environment with the shared operation shape", async () => {
  const response = await POST(new NextRequest("http://127.0.0.1/api/accounts/claude", {
    method: "POST",
    headers: { host: "127.0.0.1", "content-type": "application/json" },
    body: JSON.stringify({ label: "Clean account" }),
  }));

  expect(response.status).toBe(202);
  await expect(response.json()).resolves.toEqual(expect.objectContaining({
    account: expect.objectContaining({ id: "clean-account", kind: "managed" }),
    login: expect.objectContaining({ phase: "awaiting_browser", result: null }),
    target: "claude-auth-login",
  }));
});

test("one login is admitted at a time, then cancel and retry create a fresh operation", async () => {
  const create = () => POST(new NextRequest("http://127.0.0.1/api/accounts/claude", {
    method: "POST",
    headers: { host: "127.0.0.1", "content-type": "application/json" },
    body: JSON.stringify({ label: "Retry account" }),
  }));
  const first = await create();
  const firstBody = await first.json() as { account: { id: string }; login: { operationId: string } };

  const busy = await create();
  expect(busy.status).toBe(409);
  await expect(busy.json()).resolves.toEqual({ error: "A Claude login operation is already running", code: "login_busy" });

  const canceled = await DELETE(new NextRequest(`http://127.0.0.1/api/accounts/claude/login/${firstBody.login.operationId}`, {
    method: "DELETE", headers: { host: "127.0.0.1" },
  }), { params: Promise.resolve({ operationId: firstBody.login.operationId }) });
  expect(canceled.status).toBe(200);
  const retry = await POST(new NextRequest("http://127.0.0.1/api/accounts/claude", {
    method: "POST",
    headers: { host: "127.0.0.1", "content-type": "application/json" },
    body: JSON.stringify({ action: "retry", id: firstBody.account.id }),
  }));
  const retryBody = await retry.json() as { login: { operationId: string }; target: string };

  expect(retry.status).toBe(202);
  expect(retryBody.target).toBe("claude-auth-login");
  expect(retryBody.login.operationId).not.toBe(firstBody.login.operationId);
});

test("the authorization code is accepted through stdin and never appears in the response", async () => {
  const created = await POST(new NextRequest("http://127.0.0.1/api/accounts/claude", {
    method: "POST",
    headers: { host: "127.0.0.1", "content-type": "application/json" },
    body: JSON.stringify({ label: "Protocol account" }),
  }));
  const body = await created.json() as { login: { operationId: string } };
  child.stdout.emit("data", "Open https://claude.ai/authorize?state=browser-state");
  const code = "authorizationCode#state";

  const submitted = await submitInput(new NextRequest(`http://127.0.0.1/api/accounts/claude/login/${body.login.operationId}/input`, {
    method: "POST",
    headers: { host: "127.0.0.1", "content-type": "application/json" },
    body: JSON.stringify({ code }),
  }), { params: Promise.resolve({ operationId: body.login.operationId }) });
  const submittedBody = await submitted.json();

  expect(submitted.status).toBe(200);
  expect(submittedBody).toEqual({ login: expect.objectContaining({ phase: "verifying", acceptsCode: false }) });
  expect(JSON.stringify(submittedBody)).not.toContain(code);
});

test("managed Claude removal requires force during login and cancels the operation before removing credentials", async () => {
  const created = await POST(new NextRequest("http://127.0.0.1/api/accounts/claude", {
    method: "POST",
    headers: { host: "127.0.0.1", "content-type": "application/json" },
    body: JSON.stringify({ label: "Remove me" }),
  }));
  const { account } = await created.json() as { account: { id: string } };

  const blocked = await remove(new NextRequest("http://127.0.0.1/api/accounts/claude", {
    method: "DELETE",
    headers: { host: "127.0.0.1", "content-type": "application/json" },
    body: JSON.stringify({ id: account.id }),
  }));
  expect(blocked.status).toBe(409);
  await expect(blocked.json()).resolves.toEqual(expect.objectContaining({ code: "account_removal_blocked", blockers: ["login_pending"] }));

  const forced = await remove(new NextRequest("http://127.0.0.1/api/accounts/claude", {
    method: "DELETE",
    headers: { host: "127.0.0.1", "content-type": "application/json" },
    body: JSON.stringify({ id: account.id, force: true }),
  }));
  expect(forced.status).toBe(200);
  await expect(forced.json()).resolves.toEqual({ removed: { id: account.id } });
});

test("managed Claude removal retires routing and migration intents targeting the account", async () => {
  const account = createManagedClaudeAccount("Routed removal");
  const registry = agentRegistry();
  registry.setEngineRouting("claude", account.id);
  const intent = registry.commitMigrationIntent({
    engine: "claude",
    targetId: account.id,
    origin: "manual",
    requestId: "remove-routed-claude",
    expectedRevision: registry.engineRouting("claude").revision,
  });

  const response = await remove(new NextRequest("http://127.0.0.1/api/accounts/claude", {
    method: "DELETE", headers: { host: "127.0.0.1", "content-type": "application/json" }, body: JSON.stringify({ id: account.id }),
  }));

  expect(response.status).toBe(200);
  expect(registry.engineRouting("claude").activeAccountId).toBe("default");
  expect(registry.snapshot().migrationIntents[intent.id]?.state).toBe("stopped");
});

test("managed Claude removal restores routing when the underlying deletion fails after routing was retired", async () => {
  const account = createManagedClaudeAccount("Unsafe home");
  const registry = agentRegistry();
  registry.setEngineRouting("claude", account.id);
  // Simulates the home becoming unsafe in the window between the route's
  // initial listClaudeAccounts() check and removeManagedClaudeAccount's own
  // re-read: retireAccount is the last synchronous step before that re-read,
  // so corrupting the home here lands exactly in that window.
  const originalRetire = registry.retireAccount.bind(registry);
  registry.retireAccount = ((...args: Parameters<typeof originalRetire>) => {
    originalRetire(...args);
    fs.chmodSync(account.home, 0o755);
  }) as typeof registry.retireAccount;

  try {
    const response = await remove(new NextRequest("http://127.0.0.1/api/accounts/claude", {
      method: "DELETE", headers: { host: "127.0.0.1", "content-type": "application/json" }, body: JSON.stringify({ id: account.id }),
    }));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual(expect.objectContaining({ code: "accounts_locked" }));
    expect(registry.engineRouting("claude").activeAccountId).toBe(account.id);
  } finally {
    registry.retireAccount = originalRetire;
  }
});

test("managed Claude removal reports a corrupt registry as locked", async () => {
  const file = claudeRegistryPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{ corrupt");

  const response = await remove(new NextRequest("http://127.0.0.1/api/accounts/claude", {
    method: "DELETE", headers: { host: "127.0.0.1", "content-type": "application/json" }, body: JSON.stringify({ id: "missing" }),
  }));

  expect(response.status).toBe(409);
  await expect(response.json()).resolves.toEqual(expect.objectContaining({ code: "accounts_locked" }));
});
