import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, expect, test } from "bun:test";
import { NextRequest } from "next/server";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-codex-app-server-route-test-"));
const OLD_STATE = process.env.LLV_STATE_DIR;
const OLD_HOME = process.env.LLV_CODEX_HOME;
process.env.LLV_STATE_DIR = path.join(SANDBOX, "state");
process.env.LLV_CODEX_HOME = path.join(SANDBOX, "legacy");

const { DELETE: remove, POST } = await import("./route");
const { createManagedCodexAccount } = await import("@/lib/accounts/codex");
const { CodexAppServerClient } = await import("@/lib/accounts/codexAppServer");
const { ManagedCodexRuntime, setManagedCodexRuntimeForTests } = await import("@/lib/accounts/codexRuntime");
const { agentRegistry } = await import("@/lib/agent/registry");

class FakeChild extends EventEmitter {
  readonly stdin = { write: (line: string) => { this.onWrite(JSON.parse(line) as Record<string, unknown>); return true; }, end: () => undefined };
  readonly stdout = { on: (_event: string, listener: (chunk: string) => void) => this.on("stdout", listener) };
  readonly stderr = { on: (_event: string, listener: (chunk: string) => void) => this.on("stderr", listener) };
  kills = 0;
  kill(): boolean { this.kills += 1; return true; }
  onWrite(message: Record<string, unknown>): void {
    const id = message.id as number;
    if (message.method === "initialize") this.respond(id, {});
    if (message.method === "account/login/start") this.respond(id, { type: "chatgptDeviceCode", loginId: "test-login", verificationUrl: "https://auth.openai.com/device", userCode: "ABCD-1234" });
    if (message.method === "account/login/cancel") this.respond(id, { status: "canceled" });
  }
  respond(id: number, result: unknown): void { this.emit("stdout", JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n"); }
}

afterAll(() => {
  setManagedCodexRuntimeForTests(null);
  if (OLD_STATE === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = OLD_STATE;
  if (OLD_HOME === undefined) delete process.env.LLV_CODEX_HOME;
  else process.env.LLV_CODEX_HOME = OLD_HOME;
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

test("existing managed accounts expose retry and cancel without tmux", async () => {
  const children: FakeChild[] = [];
  setManagedCodexRuntimeForTests(new ManagedCodexRuntime({
    startClient: async (home) => {
      const child = new FakeChild(); children.push(child);
      return CodexAppServerClient.start({ home, spawn: () => child as never });
    },
  }));
  const created = await POST(new NextRequest("http://127.0.0.1/api/accounts/codex", {
    method: "POST", headers: { host: "127.0.0.1", "content-type": "application/json" }, body: JSON.stringify({ label: "Retry me" }),
  }));
  const { account } = await created.json() as { account: { id: string } };
  const retried = await POST(new NextRequest("http://127.0.0.1/api/accounts/codex", {
    method: "POST", headers: { host: "127.0.0.1", "content-type": "application/json" }, body: JSON.stringify({ action: "retry", id: account.id }),
  }));
  expect(retried.status).toBe(200);
  const cancelled = await POST(new NextRequest("http://127.0.0.1/api/accounts/codex", {
    method: "POST", headers: { host: "127.0.0.1", "content-type": "application/json" }, body: JSON.stringify({ action: "cancel", id: account.id }),
  }));
  await expect(cancelled.json()).resolves.toEqual({ account: { id: account.id }, cancelled: true });
  expect(children.every((child) => child.kills > 0)).toBe(true);
});

test("managed account creation returns an app-server challenge without the tmux compatibility adapter", async () => {
  const children: FakeChild[] = [];
  setManagedCodexRuntimeForTests(new ManagedCodexRuntime({
    startClient: async (home) => {
      const child = new FakeChild();
      children.push(child);
      return CodexAppServerClient.start({ home, spawn: () => child as never });
    },
  }));
  const response = await POST(new NextRequest("http://127.0.0.1/api/accounts/codex", {
    method: "POST",
    headers: { host: "127.0.0.1", "content-type": "application/json" },
    body: JSON.stringify({ label: "Work" }),
  }));
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual(expect.objectContaining({
    account: expect.objectContaining({ id: "work", loginPending: true }),
    deviceAuth: { url: "https://auth.openai.com/device", code: "ABCD-1234" },
    target: "https://auth.openai.com/device",
  }));
  expect(children).toHaveLength(1);
  const source = fs.readFileSync(path.join(import.meta.dir, "route.ts"), "utf8");
  expect(source).not.toContain("@/lib/tmux");
  expect(source).not.toContain("spawnCommandWindow");
});

test("managed Codex removal requires force during device login and cancels the login child", async () => {
  const children: FakeChild[] = [];
  setManagedCodexRuntimeForTests(new ManagedCodexRuntime({
    startClient: async (home) => {
      const child = new FakeChild();
      children.push(child);
      return CodexAppServerClient.start({ home, spawn: () => child as never });
    },
  }));
  const created = await POST(new NextRequest("http://127.0.0.1/api/accounts/codex", {
    method: "POST", headers: { host: "127.0.0.1", "content-type": "application/json" }, body: JSON.stringify({ label: "Remove me" }),
  }));
  const { account } = await created.json() as { account: { id: string } };

  const blocked = await remove(new NextRequest("http://127.0.0.1/api/accounts/codex", {
    method: "DELETE", headers: { host: "127.0.0.1", "content-type": "application/json" }, body: JSON.stringify({ id: account.id }),
  }));
  expect(blocked.status).toBe(409);
  await expect(blocked.json()).resolves.toEqual(expect.objectContaining({ code: "account_removal_blocked", blockers: ["login_pending"] }));

  const forced = await remove(new NextRequest("http://127.0.0.1/api/accounts/codex", {
    method: "DELETE", headers: { host: "127.0.0.1", "content-type": "application/json" }, body: JSON.stringify({ id: account.id, force: true }),
  }));
  expect(forced.status).toBe(200);
  expect(children[0]?.kills).toBeGreaterThan(0);
});

test("managed Codex removal retires routing and migration intents targeting the account", async () => {
  const account = createManagedCodexAccount("Routed removal");
  const registry = agentRegistry();
  registry.setEngineRouting("codex", account.id);
  const intent = registry.commitMigrationIntent({
    engine: "codex",
    targetId: account.id,
    origin: "manual",
    requestId: "remove-routed-codex",
    expectedRevision: registry.engineRouting("codex").revision,
  });

  const response = await remove(new NextRequest("http://127.0.0.1/api/accounts/codex", {
    method: "DELETE", headers: { host: "127.0.0.1", "content-type": "application/json" }, body: JSON.stringify({ id: account.id }),
  }));

  expect(response.status).toBe(200);
  expect(registry.engineRouting("codex").activeAccountId).toBe("default");
  expect(registry.snapshot().migrationIntents[intent.id]?.state).toBe("stopped");
});

test("managed Codex removal reports pending cleanup when local data survives", async () => {
  const account = createManagedCodexAccount("Cleanup pending");
  const originalRm = fs.rmSync;
  fs.rmSync = ((target: fs.PathLike, options?: fs.RmDirOptions) => {
    if (path.resolve(String(target)) === path.resolve(account.home)) throw Object.assign(new Error("denied"), { code: "EACCES" });
    return originalRm(target, options);
  }) as typeof fs.rmSync;
  try {
    const response = await remove(new NextRequest("http://127.0.0.1/api/accounts/codex", {
      method: "DELETE", headers: { host: "127.0.0.1", "content-type": "application/json" }, body: JSON.stringify({ id: account.id }),
    }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ removed: { id: account.id }, cleanupPending: true });
  } finally {
    fs.rmSync = originalRm;
  }
});

test("managed Codex removal stays blocked while a live conversation depends on the account", async () => {
  const account = createManagedCodexAccount("Current history");
  const registry = agentRegistry();
  const conversation = registry.ensureConversation("codex", "/current-codex.jsonl", account.id);
  registry.holdDelivery(conversation.id, "still owed to this conversation");

  const response = await remove(new NextRequest("http://127.0.0.1/api/accounts/codex", {
    method: "DELETE", headers: { host: "127.0.0.1", "content-type": "application/json" }, body: JSON.stringify({ id: account.id, force: true }),
  }));

  expect(response.status).toBe(409);
  await expect(response.json()).resolves.toEqual(expect.objectContaining({ blockers: ["current_conversations"] }));
});

test("managed Codex removal proceeds over dead history and keeps its sessions readable (issue #643)", async () => {
  const account = createManagedCodexAccount("Dead history");
  const registry = agentRegistry();
  const session = path.join(account.sessionsDir, "2026", "07", "24", "rollout-2026-07-24T00-00-00-99999999-1234-1234-1234-123456789abc.jsonl");
  fs.mkdirSync(path.dirname(session), { recursive: true, mode: 0o700 });
  fs.writeFileSync(session, "{}\n", { mode: 0o600 });
  registry.ensureConversation("codex", session, account.id);

  const response = await remove(new NextRequest("http://127.0.0.1/api/accounts/codex", {
    method: "DELETE", headers: { host: "127.0.0.1", "content-type": "application/json" }, body: JSON.stringify({ id: account.id }),
  }));

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({ removed: { id: account.id }, cleanupPending: false });
  expect(fs.readFileSync(session, "utf8")).toBe("{}\n");
  expect(registry.conversationForPath(session)).not.toBeNull();
});

test("managed Codex removal restores routing when the underlying deletion fails after routing was retired", async () => {
  const account = createManagedCodexAccount("Unsafe home");
  const registry = agentRegistry();
  registry.setEngineRouting("codex", account.id);
  const before = registry.snapshot();
  // Simulates the home becoming unsafe in the window between the route's
  // initial listCodexAccounts() check and removeManagedCodexAccount's own
  // re-read: retireAccount is the last synchronous step before that re-read,
  // so corrupting the home here lands exactly in that window.
  const originalRetire = registry.retireAccount.bind(registry);
  registry.retireAccount = ((...args: Parameters<typeof originalRetire>) => {
    originalRetire(...args);
    fs.chmodSync(account.home, 0o755);
  }) as typeof registry.retireAccount;

  try {
    const response = await remove(new NextRequest("http://127.0.0.1/api/accounts/codex", {
      method: "DELETE", headers: { host: "127.0.0.1", "content-type": "application/json" }, body: JSON.stringify({ id: account.id }),
    }));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual(expect.objectContaining({ code: "accounts_locked" }));
    expect(registry.snapshot()).toEqual(before);
  } finally {
    registry.retireAccount = originalRetire;
  }
});

test("managed Codex removal reports a corrupt registry as locked", async () => {
  const file = path.join(process.env.LLV_STATE_DIR!, "codex-accounts.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{ corrupt");

  const response = await remove(new NextRequest("http://127.0.0.1/api/accounts/codex", {
    method: "DELETE", headers: { host: "127.0.0.1", "content-type": "application/json" }, body: JSON.stringify({ id: "missing" }),
  }));

  expect(response.status).toBe(409);
  await expect(response.json()).resolves.toEqual(expect.objectContaining({ code: "accounts_locked" }));
});
