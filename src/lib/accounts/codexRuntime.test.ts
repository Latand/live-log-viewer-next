import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, expect, test } from "bun:test";

import type { CodexAccount } from "./codex";
import type { CodexAppServerClient as CodexAppServerClientType } from "./codexAppServer";

const RUNTIME_SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-codex-runtime-suite-"));
const PREVIOUS_STATE = process.env.LLV_STATE_DIR;
process.env.LLV_STATE_DIR = path.join(RUNTIME_SANDBOX, "state");

const { CodexAppServerClient } = await import("./codexAppServer");
const { ManagedCodexRuntime } = await import("./codexRuntime");
const { withAccountMutationLockAsync } = await import("./accountMutation");

afterAll(() => {
  if (PREVIOUS_STATE === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = PREVIOUS_STATE;
  fs.rmSync(RUNTIME_SANDBOX, { recursive: true, force: true });
});

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

test("Codex provider probes wait behind account deletion mutations", async () => {
  const children: FakeChild[] = [];
  const runtime = new ManagedCodexRuntime({
    startClient: async (home) => {
      const child = new FakeChild();
      child.authenticated = true;
      children.push(child);
      return CodexAppServerClient.start({ home, spawn: () => child as never });
    },
  });
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const acquired = new Promise<void>((resolve) => { entered = resolve; });
  const holder = withAccountMutationLockAsync(async () => { entered(); await held; });
  await acquired;

  const probe = runtime.readRateLimits(account("fenced", "/accounts/fenced"));
  await Bun.sleep(10);
  expect(children).toHaveLength(0);
  release();
  await holder;
  await expect(probe).resolves.toMatchObject({ primary: { usedPercent: 7 } });
  expect(children).toHaveLength(1);
});

test("provider probes re-resolve a waiting account after deletion wins the fence", async () => {
  const stateFile = path.join(process.env.LLV_STATE_DIR!, "codex-accounts.json");
  const home = path.join(path.dirname(process.env.LLV_STATE_DIR!), "accounts", "codex", "stale");
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.chmodSync(home, 0o700);
  const activeRegistry = { version: 1, active: "default", accounts: [{ id: "stale", label: "Stale", kind: "managed", createdAt: 1, loginPane: null }], retired: [] };
  const retiredRegistry = { version: 1, active: "default", accounts: [], retired: [{ id: "stale", label: "Stale", retiredAt: 2 }] };
  fs.mkdirSync(path.dirname(stateFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(stateFile, JSON.stringify(activeRegistry), { mode: 0o600 });
  let starts = 0;
  const runtime = new ManagedCodexRuntime({ startClient: async () => { starts += 1; throw new Error("must stay fenced"); } });
  const stale = account("stale", home);
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const acquired = new Promise<void>((resolve) => { entered = resolve; });
  const holder = withAccountMutationLockAsync(async () => {
    entered();
    await held;
    fs.writeFileSync(stateFile, JSON.stringify(retiredRegistry), { mode: 0o600 });
  });
  await acquired;

  const quota = runtime.probeQuota(stale).then(() => null, (error: unknown) => error);
  await Bun.sleep(10);
  expect(starts).toBe(0);
  release();
  await holder;
  expect(await quota).toBeInstanceOf(Error);
  await expect(runtime.loginSnapshot(stale)).rejects.toThrow("unknown Codex account: stale");
  expect(starts).toBe(0);
  fs.rmSync(stateFile, { force: true });
  fs.rmSync(path.join(path.dirname(process.env.LLV_STATE_DIR!), "accounts"), { recursive: true, force: true });
});

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

test("lock contention defers Codex completion persistence and still closes the client", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-runtime-contention-"));
  const previousState = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = path.join(dir, "state");
  const stateFile = path.join(dir, "attempts.json");
  const child = new FakeChild();
  try {
    const runtime = new ManagedCodexRuntime({
      stateFile,
      startClient: async (home) => CodexAppServerClient.start({ home, spawn: () => child as never }),
      now: () => 123,
    });
    const work = account("contended", path.join(dir, "account"));
    const login = await runtime.startLogin(work);
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const holder = withAccountMutationLockAsync(async () => {
      entered();
      await new Promise<void>((resolve) => { release = resolve; });
    });
    await ready;

    child.completed(login.loginId);
    const killsAfterCompletion = child.kills;
    release();
    await holder;

    expect(killsAfterCompletion).toBe(1);
    let persisted = "";
    for (let attempt = 0; attempt < 20; attempt += 1) {
      persisted = fs.readFileSync(stateFile, "utf8");
      if (persisted.includes('"state": "completed"')) break;
      await Bun.sleep(10);
    }
    expect(persisted).toContain('"state": "completed"');
  } finally {
    if (previousState === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previousState;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Codex completion write failures log with backoff and eventually persist", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-runtime-retry-"));
  const stateFile = path.join(dir, "attempts.json");
  const child = new FakeChild();
  const runtime = new ManagedCodexRuntime({
    stateFile,
    startClient: async (home) => CodexAppServerClient.start({ home, spawn: () => child as never }),
    now: () => 123,
  });
  const work = account("retry-write", path.join(dir, "account"));
  const login = await runtime.startLogin(work);
  const originalRename = fs.renameSync.bind(fs);
  const originalError = console.error;
  const messages: string[] = [];
  let failures = 0;
  fs.renameSync = ((source: fs.PathLike, target: fs.PathLike) => {
    if (target === stateFile && failures < 2) {
      failures += 1;
      throw new Error("state file unavailable");
    }
    return originalRename(source, target);
  }) as typeof fs.renameSync;
  console.error = (message?: unknown) => { messages.push(String(message)); };
  try {
    child.completed(login.loginId);
    await Bun.sleep(25);
  } finally {
    fs.renameSync = originalRename;
    console.error = originalError;
  }

  expect(messages).toEqual([expect.stringContaining("Codex login outcome persistence failed")]);
  for (let attempt = 0; attempt < 30 && !fs.readFileSync(stateFile, "utf8").includes('"state": "completed"'); attempt += 1) await Bun.sleep(10);
  expect(fs.readFileSync(stateFile, "utf8")).toContain('"state": "completed"');
  fs.rmSync(dir, { recursive: true, force: true });
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
  let release!: (client: CodexAppServerClientType) => void;
  const starting = new Promise<CodexAppServerClientType>((resolve) => { release = resolve; });
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
  let resolveStart: ((client: CodexAppServerClientType) => void) | null = null;
  let starts = 0;
  const child = new FakeChild();
  const runtime = new ManagedCodexRuntime({
    startClient: async () => {
      starts += 1;
      return new Promise<CodexAppServerClientType>((resolve) => { resolveStart = resolve; });
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

test("batched Codex login projection reads durable state once", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-runtime-batch-"));
  const stateFile = path.join(dir, "attempts.json");
  fs.writeFileSync(stateFile, JSON.stringify({ version: 1, attempts: {} }));
  const originalRead = fs.readFileSync.bind(fs);
  let reads = 0;
  const runtime = new ManagedCodexRuntime({ stateFile });
  fs.readFileSync = ((file: fs.PathOrFileDescriptor, ...args: unknown[]) => {
    if (file === stateFile) reads += 1;
    return originalRead(file, ...(args as [never]));
  }) as typeof fs.readFileSync;
  try {
    const snapshots = runtime.peekLogins([
      account("one", path.join(dir, "one")),
      account("two", path.join(dir, "two")),
    ]);
    expect([...snapshots.keys()]).toEqual(["one", "two"]);
    expect(reads).toBe(1);
  } finally {
    fs.readFileSync = originalRead;
    fs.rmSync(dir, { recursive: true, force: true });
  }
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

/* Issue #1373: the redemption sequence on one app-server client. The child is
   scripted per read so the window and the credit count move across the calls. */
class RedeemChild extends FakeChild {
  reads = 0;
  consumeOutcome: string = "reset";
  available: number | null = 1;
  override onWrite(message: Record<string, unknown>): void {
    if (message.method === "account/rateLimits/read") {
      this.methods.push(message.method);
      this.reads += 1;
      const redeemed = this.reads > 1 && this.consumeOutcome === "reset";
      this.respond(message.id as number, {
        rateLimits: { primary: { usedPercent: redeemed ? 0 : 100, windowDurationMins: 10_080, resetsAt: redeemed ? 1_788_900_000 : 1_788_768_514 }, secondary: null, planType: "pro" },
        ...(this.available === null ? {} : { rateLimitResetCredits: { availableCount: redeemed ? this.available - 1 : this.available, credits: null } }),
      });
      return;
    }
    if (message.method === "account/rateLimitResetCredit/consume") {
      this.methods.push(message.method);
      this.respond(message.id as number, { outcome: this.consumeOutcome });
      return;
    }
    super.onWrite(message);
  }
}

test("a quota probe carries the reset-credit summary beside the limits (#1373)", async () => {
  const child = new RedeemChild();
  child.authenticated = true;
  const runtime = new ManagedCodexRuntime({ startClient: async (home) => CodexAppServerClient.start({ home, spawn: () => child as never }) });
  const probe = await runtime.probeQuota(account("credited", "/accounts/credited"));
  expect(probe.resetCredits).toEqual({ availableCount: 1, credits: null });
  expect(probe.rateLimits.primary).toMatchObject({ usedPercent: 100 });
  expect(child.methods).not.toContain("account/rateLimitResetCredit/consume");
});

test("redeeming a reset credit reads, consumes once with the caller's key, and re-reads on one client (#1373)", async () => {
  const children: RedeemChild[] = [];
  const runtime = new ManagedCodexRuntime({ startClient: async (home) => {
    const child = new RedeemChild();
    child.authenticated = true;
    children.push(child);
    return CodexAppServerClient.start({ home, spawn: () => child as never });
  } });
  const redemption = await runtime.redeemResetCredit(account("credited", "/accounts/credited"), "attempt-one");
  expect(redemption.outcome).toBe("reset");
  expect(redemption.refusedLocally).toBeFalse();
  expect(redemption.before.rateLimits.primary).toMatchObject({ usedPercent: 100, resetsAt: 1_788_768_514 });
  expect(redemption.after.rateLimits.primary).toMatchObject({ usedPercent: 0, resetsAt: 1_788_900_000 });
  expect(redemption.after.resetCredits).toEqual({ availableCount: 0, credits: null });
  expect(children).toHaveLength(1);
  expect(children[0]!.methods).toEqual([
    "initialize", "initialized",
    "account/read", "account/rateLimits/read",
    "account/rateLimitResetCredit/consume",
    "account/read", "account/rateLimits/read",
  ]);
});

test("a pre-read that shows no credit refuses locally and sends no consume (#1373)", async () => {
  const child = new RedeemChild();
  child.authenticated = true;
  child.available = 0;
  const runtime = new ManagedCodexRuntime({ startClient: async (home) => CodexAppServerClient.start({ home, spawn: () => child as never }) });
  const redemption = await runtime.redeemResetCredit(account("spent", "/accounts/spent"), "attempt-two");
  expect(redemption).toMatchObject({ outcome: "noCredit", refusedLocally: true });
  expect(redemption.after).toBe(redemption.before);
  expect(child.methods).not.toContain("account/rateLimitResetCredit/consume");
});

test("an unknown credit count is not a refusal: the backend answers, and its answer is kept (#1373)", async () => {
  const child = new RedeemChild();
  child.authenticated = true;
  child.available = null;
  child.consumeOutcome = "noCredit";
  const runtime = new ManagedCodexRuntime({ startClient: async (home) => CodexAppServerClient.start({ home, spawn: () => child as never }) });
  const redemption = await runtime.redeemResetCredit(account("unknown-count", "/accounts/unknown-count"), "attempt-three");
  expect(redemption).toMatchObject({ outcome: "noCredit", refusedLocally: false });
  expect(child.methods.filter((method) => method === "account/rateLimitResetCredit/consume")).toHaveLength(1);
});
