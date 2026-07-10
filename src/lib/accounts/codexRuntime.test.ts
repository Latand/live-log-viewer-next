import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, test } from "bun:test";

import type { CodexAccount } from "./codex";
import { CodexAppServerClient } from "./codexAppServer";
import { ManagedCodexRuntime } from "./codexRuntime";

class FakeChild extends EventEmitter {
  readonly stdin = { write: (line: string) => { this.onWrite(JSON.parse(line) as Record<string, unknown>); return true; }, end: () => undefined };
  readonly stdout = { on: (_event: string, listener: (chunk: string) => void) => this.on("stdout", listener) };
  readonly stderr = { on: (_event: string, listener: (chunk: string) => void) => this.on("stderr", listener) };
  readonly methods: string[] = [];
  kills = 0;
  authenticated = false;
  requiresOpenaiAuth = false;
  readFailure = false;
  onWrite(message: Record<string, unknown>): void {
    if (typeof message.method === "string") this.methods.push(message.method);
    if (message.method === "initialize") this.respond(message.id as number, {});
    if (message.method === "account/login/start") this.respond(message.id as number, { type: "chatgptDeviceCode", loginId: "login-" + this.methods.length, verificationUrl: "https://auth.openai.com/device", userCode: "ABCD-1234" });
    if (message.method === "account/login/cancel") this.respond(message.id as number, { status: "canceled" });
    if (message.method === "account/read") {
      if (this.readFailure) this.emit("stdout", JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { message: "offline" } }) + "\n");
      else this.respond(message.id as number, this.authenticated ? { account: { type: "chatgpt" }, requiresOpenaiAuth: this.requiresOpenaiAuth } : { account: null, requiresOpenaiAuth: true });
    }
    if (message.method === "account/rateLimits/read") this.respond(message.id as number, { rateLimits: { primary: { usedPercent: 7, resetsAt: 99 }, secondary: { usedPercent: 31, resetsAt: 199 }, planType: "pro" } });
  }
  respond(id: number, result: unknown): void { this.emit("stdout", JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n"); }
  completed(loginId: string | null, success = true): void { this.emit("stdout", JSON.stringify({ jsonrpc: "2.0", method: "account/login/completed", params: { loginId, success } }) + "\n"); }
  exit(): void { this.emit("close", 1, null); }
  kill(): boolean { this.kills += 1; return true; }
}

function account(id: string, home: string): CodexAccount {
  return { id, label: id, kind: "managed", home, sessionsDir: home + "/sessions", authPresent: false, loginPane: null, createdAt: 0 };
}

test("managed login keeps one per-home child until completion and returns only challenge metadata", async () => {
  const children: FakeChild[] = [];
  const runtime = new ManagedCodexRuntime({
    startClient: async (home) => {
      const child = new FakeChild();
      children.push(child);
      return CodexAppServerClient.start({ home, spawn: () => child as never });
    },
    now: () => 123,
  });
  const work = account("work", "/accounts/work");
  const attempt = await runtime.startLogin(work);
  expect(attempt).toEqual({ accountId: "work", loginId: "login-3", verificationUrl: "https://auth.openai.com/device", userCode: "ABCD-1234", startedAt: 123 });
  await expect(runtime.loginSnapshot(work)).resolves.toEqual({ state: "pending", attemptState: "pending", deviceAuth: { url: "https://auth.openai.com/device", code: "ABCD-1234" } });
  children[0]!.completed("login-3");
  await expect(runtime.loginSnapshot(work)).resolves.toEqual({ state: "completed", attemptState: "completed", deviceAuth: null });
  expect(children[0]!.kills).toBe(1);
});

test("cancellation and independent homes never share a managed app-server child", async () => {
  const homes: string[] = [];
  const children: FakeChild[] = [];
  const runtime = new ManagedCodexRuntime({
    startClient: async (home) => {
      homes.push(home);
      const child = new FakeChild();
      children.push(child);
      return CodexAppServerClient.start({ home, spawn: () => child as never });
    },
  });
  const first = account("first", "/accounts/first");
  const second = account("second", "/accounts/second");
  await runtime.startLogin(first);
  await runtime.startLogin(second);
  await expect(runtime.cancelLogin("first")).resolves.toBe(true);
  expect(homes).toEqual(["/accounts/first", "/accounts/second"]);
  expect(children[0]!.methods).toContain("account/login/cancel");
  expect(children[0]!.kills).toBe(1);
  expect(children[1]!.kills).toBe(0);
});

test("cancellation waits for an in-flight client startup to be reaped", async () => {
  let release!: (client: CodexAppServerClient) => void;
  const starting = new Promise<CodexAppServerClient>((resolve) => { release = resolve; });
  const child = new FakeChild();
  const runtime = new ManagedCodexRuntime({ startClient: () => starting });
  const work = account("starting", "/accounts/starting");
  const launch = runtime.startLogin(work).catch(() => null);
  let cancelled = false;
  const cancel = runtime.cancelLogin(work.id).then((value) => { cancelled = value; });

  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(cancelled).toBe(false);
  release(await CodexAppServerClient.start({ home: work.home, spawn: () => child as never }));
  await cancel;
  await launch;
  expect(cancelled).toBe(true);
  expect(child.kills).toBeGreaterThan(0);
});

test("child death, false completion, and account-read failure become recoverable states", async () => {
  const stateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "llv-runtime-state-")), "attempts.json");
  const children: FakeChild[] = [];
  let nextReadFails = false;
  const runtime = new ManagedCodexRuntime({
    stateFile,
    startClient: async (home) => {
      const child = new FakeChild();
      child.readFailure = nextReadFails;
      nextReadFails = false;
      children.push(child);
      return CodexAppServerClient.start({ home, spawn: () => child as never });
    },
  });
  const work = account("work", "/accounts/work");
  await runtime.startLogin(work);
  children[0]!.exit();
  await expect(runtime.loginSnapshot(work)).resolves.toEqual({ state: "failed", attemptState: "failed", deviceAuth: null });

  await runtime.retryLogin(work);
  children[2]!.completed("login-3", false);
  await expect(runtime.loginSnapshot(work)).resolves.toEqual({ state: "failed", attemptState: "failed", deviceAuth: null });

  await runtime.retryLogin(work);
  children[4]!.completed("login-3");
  // The completion closes its child. The replacement account/read failure must
  // remain explicitly recoverable instead of claiming file-based auth.
  nextReadFails = true;
  await expect(runtime.loginSnapshot(work)).resolves.toEqual({ state: "stale", attemptState: "stale", deviceAuth: null });
});

test("restart reconstruction marks a pending child stale and retry owns a fresh generation", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-runtime-restart-"));
  const stateFile = path.join(dir, "attempts.json");
  const firstChildren: FakeChild[] = [];
  const work = account("work", path.join(dir, "home"));
  const first = new ManagedCodexRuntime({ stateFile, startClient: async (home) => {
    const child = new FakeChild(); firstChildren.push(child);
    return CodexAppServerClient.start({ home, spawn: () => child as never });
  } });
  await first.startLogin(work);
  const secondChildren: FakeChild[] = [];
  const second = new ManagedCodexRuntime({ stateFile, startClient: async (home) => {
    const child = new FakeChild(); secondChildren.push(child);
    return CodexAppServerClient.start({ home, spawn: () => child as never });
  } });
  await expect(second.loginSnapshot(work)).resolves.toEqual({ state: "stale", attemptState: "stale", deviceAuth: null });
  await expect(second.retryLogin(work)).resolves.toEqual(expect.objectContaining({ accountId: "work" }));
  expect(secondChildren).toHaveLength(2);
});

test("concurrent starts reserve one canonical-home supervisor before awaiting startup", async () => {
  let resolveStart: ((client: CodexAppServerClient) => void) | null = null;
  let starts = 0;
  const child = new FakeChild();
  const runtime = new ManagedCodexRuntime({
    startClient: async () => {
      starts += 1;
      return new Promise<CodexAppServerClient>((resolve) => { resolveStart = resolve; });
    },
  });
  const work = account("work", "/accounts/work");
  const one = runtime.startLogin(work);
  const two = runtime.startLogin(work);
  expect(starts).toBe(1);
  resolveStart!(await CodexAppServerClient.start({ home: work.home, spawn: () => child as never }));
  const [first, second] = await Promise.all([one, two]);
  expect(first).toEqual(second);
  expect(starts).toBe(1);
});

test("account/read owns authentication independently from auth.json diagnostics", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-runtime-auth-"));
  const work = account("work", dir);
  fs.writeFileSync(path.join(dir, "auth.json"), "invalid credentials");
  const unavailable = new ManagedCodexRuntime({ startClient: async (home) => {
    const child = new FakeChild();
    return CodexAppServerClient.start({ home, spawn: () => child as never });
  } });
  await expect(unavailable.loginSnapshot(work)).resolves.toEqual({ state: "idle", attemptState: null, deviceAuth: null });
  const valid = new ManagedCodexRuntime({ startClient: async (home) => {
    const child = new FakeChild(); child.authenticated = true;
    return CodexAppServerClient.start({ home, spawn: () => child as never });
  } });
  const missingFile = { ...work, authPresent: false };
  await expect(valid.loginSnapshot(missingFile)).resolves.toEqual({ state: "authenticated", attemptState: "completed", deviceAuth: null });
});

test("legacy Main and managed homes use the read-only account-plus-limits probe", async () => {
  const children: FakeChild[] = [];
  const runtime = new ManagedCodexRuntime({ startClient: async (home) => {
    const child = new FakeChild();
    child.authenticated = true;
    child.requiresOpenaiAuth = true;
    children.push(child);
    return CodexAppServerClient.start({ home, spawn: () => child as never });
  } });
  const main: CodexAccount = { id: "default", label: "Main", kind: "legacy", home: "/accounts/main", sessionsDir: "/accounts/main/sessions", authPresent: true, loginPane: null, createdAt: 0 };
  const managed = account("managed", "/accounts/managed");

  await expect(runtime.probeQuota(main)).resolves.toMatchObject({ authenticated: true, rateLimits: { primary: { usedPercent: 7 } } });
  await expect(runtime.probeQuota(managed)).resolves.toMatchObject({ authenticated: true, rateLimits: { secondary: { usedPercent: 31 } } });

  for (const child of children) {
    expect(child.methods).toEqual(["initialize", "initialized", "account/read", "account/rateLimits/read"]);
    expect(child.methods).not.toContain("account/rateLimitResetCredit/consume");
    expect(child.methods).not.toContain("account/login/start");
    expect(child.methods).not.toContain("account/login/cancel");
  }
});
