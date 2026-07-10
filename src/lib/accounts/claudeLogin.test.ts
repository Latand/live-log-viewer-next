import { afterAll, beforeEach, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-claude-login-test-"));
const OLD_STATE = process.env.LLV_STATE_DIR; const OLD_HOME = process.env.LLV_CLAUDE_HOME;
process.env.LLV_STATE_DIR = path.join(SANDBOX, "state"); process.env.LLV_CLAUDE_HOME = path.join(SANDBOX, "legacy");
const { createManagedClaudeAccount } = await import("./claude");
const { ClaudeLoginSupervisor, claudeStatusEnvironment, cleanClaudeLoginOutput, isExpectedClaudeLoginCommand, loginUrlFromOutput } = await import("./claudeLogin");
type ClaudeLoginPorts = import("./claudeLogin").ClaudeLoginPorts;

class FakeChild extends EventEmitter { pid = 4242; stdout = new EventEmitter(); stderr = new EventEmitter(); writes: string[] = []; stdin = { write: (text: string) => { this.writes.push(text); return true; }, end: () => undefined }; }
let child: FakeChild; let signals: string[];
function ports(): ClaudeLoginPorts { return { spawn: () => child as never, kill: (_pid, signal) => { signals.push(signal); }, pidStartToken: () => "start-1", isExpectedClaude: () => true, status: async () => ({ loggedIn: true, method: "oauth", email: "a@example.test", plan: "max" }), now: () => 1_000, setTimeout: (fn, ms) => { if (ms <= 2_000) fn(); return {} as NodeJS.Timeout; }, clearTimeout: () => undefined }; }
beforeEach(() => { fs.rmSync(process.env.LLV_STATE_DIR!, { recursive: true, force: true }); child = new FakeChild(); signals = []; });
afterAll(() => { if (OLD_STATE === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = OLD_STATE; if (OLD_HOME === undefined) delete process.env.LLV_CLAUDE_HOME; else process.env.LLV_CLAUDE_HOME = OLD_HOME; fs.rmSync(SANDBOX, { recursive: true, force: true }); });

test("parser handles ANSI and chunks while only allowlisted URLs survive", () => {
  expect(cleanClaudeLoginOutput("\u001b[31mhello\u001b[0m")).toBe("hello");
  expect(loginUrlFromOutput("https://evil.test/x https://claude.ai/login?a=1")).toBe("https://claude.ai/login?a=1");
  expect(isExpectedClaudeLoginCommand("/usr/local/bin/claude\0auth\0login\0--claudeai\0")).toBe(true);
  expect(isExpectedClaudeLoginCommand("/usr/bin/node\0/opt/claude/cli.js\0auth\0login\0--claudeai\0")).toBe(true);
  expect(isExpectedClaudeLoginCommand("/usr/local/bin/claude\0auth\0status\0--json\0")).toBe(false);
  expect(isExpectedClaudeLoginCommand("/usr/local/bin/claude\0auth\0login\0--claudeai\0--extra\0")).toBe(false);
});

test("a clean environment starts the Claude CLI login protocol without activation flags", () => {
  const account = createManagedClaudeAccount("Clean environment");
  const calls: Array<{ command: string; args: string[] }> = [];
  const supervisor = new ClaudeLoginSupervisor({
    ...ports(),
    spawn: (command, args) => {
      calls.push({ command, args });
      return child as never;
    },
  });

  const operation = supervisor.start(account.id);

  expect(operation).toEqual(expect.objectContaining({ phase: "awaiting_browser" }));
  expect(calls).toEqual([{ command: expect.any(String), args: ["auth", "login", "--claudeai"] }]);
});

test("an unfenced child is rejected before it can accept a login code", () => {
  const account = createManagedClaudeAccount("Unfenced");
  const supervisor = new ClaudeLoginSupervisor({ ...ports(), pidStartToken: () => null });

  const operation = supervisor.start(account.id);

  expect(operation).toEqual(expect.objectContaining({ phase: "failed", result: expect.objectContaining({ code: "launch_unfenced" }) }));
  expect(child.writes).toEqual([]);
});

test("fake supervised login accepts one bounded code, contains it, and cancels without tmux", async () => {
  const account = createManagedClaudeAccount("Work");
  const supervisor = new ClaudeLoginSupervisor(ports());
  const operation = supervisor.start(account.id);
  child.stdout.emit("data", Buffer.from("open \u001b[32mhttps://claude.ai/oauth\u001b[0m"));
  expect(supervisor.get(operation.operationId)).toEqual(expect.objectContaining({ phase: "awaiting_code", loginUrl: "https://claude.ai/oauth", acceptsCode: true }));
  await supervisor.input(operation.operationId, "one-time-code");
  expect(child.writes).toEqual(["one-time-code\n"]);
  await expect(supervisor.input(operation.operationId, "again")).rejects.toThrow("already submitted");
  const cancelled = await supervisor.cancel(operation.operationId);
  expect(cancelled.phase).toBe("canceled"); expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  expect(JSON.stringify(cancelled)).not.toContain("one-time-code");
});

test("the browser, code, verification, and canceling phases are durable and stdout-only", async () => {
  const account = createManagedClaudeAccount("Phases");
  const saved: string[][] = [];
  const callbacks: Array<() => void> = [];
  const supervisor = new ClaudeLoginSupervisor({
    ...ports(),
    setTimeout: (callback) => { callbacks.push(callback); return {} as NodeJS.Timeout; },
  }, {
    load: () => [],
    save: (rows) => { saved.push(rows.map((row) => row.phase)); },
  });
  const operation = supervisor.start(account.id);

  expect(supervisor.get(operation.operationId)?.phase).toBe("awaiting_browser");
  child.stderr.emit("data", "https://claude.ai/from-stderr");
  expect(supervisor.get(operation.operationId)?.phase).toBe("awaiting_browser");
  child.stdout.emit("data", "Open https://claude.ai/authorize?state=public-state");
  expect(supervisor.get(operation.operationId)?.phase).toBe("awaiting_code");
  await supervisor.input(operation.operationId, "authorizationCode#state");
  expect(supervisor.get(operation.operationId)?.phase).toBe("verifying");

  const canceling = supervisor.cancel(operation.operationId);
  expect(supervisor.get(operation.operationId)?.phase).toBe("canceling");
  callbacks.at(-1)?.();
  await Promise.resolve();
  callbacks.at(-1)?.();
  const canceled = await canceling;

  expect(canceled.result).toEqual({ status: "canceled", code: "canceled", message: "Claude login was canceled" });
  expect(saved.flat()).toEqual(expect.arrayContaining(["starting", "awaiting_browser", "awaiting_code", "verifying", "canceling"]));
  expect(JSON.stringify(saved)).not.toContain("authorizationCode");
});

test("input is admitted only after the browser prompt and persists verification before stdin", async () => {
  const account = createManagedClaudeAccount("Ordered input");
  const saved: string[][] = [];
  const supervisor = new ClaudeLoginSupervisor(ports(), { load: () => [], save: (rows) => { saved.push(rows.map((row) => row.phase)); } });
  const operation = supervisor.start(account.id);

  await expect(supervisor.input(operation.operationId, "authorizationCode#state")).rejects.toThrow("not ready");
  child.stdout.emit("data", "Open https://claude.ai/authorize?state=browser-state");
  await supervisor.input(operation.operationId, "authorizationCode#state");

  expect(saved.at(-1)).toEqual(["verifying"]);
  expect(child.writes).toEqual(["authorizationCode#state\n"]);
});

test("restart reconciliation rejects PID reuse and preserves only an interrupted safe DTO", () => {
  const file = path.join(process.env.LLV_STATE_DIR!, "claude-auth-operations.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify([{ operationId: "00000000-0000-4000-8000-000000000001", accountId: "work", phase: "awaiting_browser", pid: 4242, startToken: "old-start", generation: 3, startedAt: new Date(0).toISOString(), deadlineAt: new Date(1).toISOString() }]));
  const supervisor = new ClaudeLoginSupervisor({ ...ports(), pidStartToken: () => "new-process" });
  expect(signals).toEqual([]);
  expect(supervisor.get("00000000-0000-4000-8000-000000000001")).toEqual(expect.objectContaining({ phase: "interrupted", loginUrl: null, acceptsCode: false }));
});

test("malformed persisted operations are discarded so recovery cannot block a fresh login", () => {
  const file = path.join(process.env.LLV_STATE_DIR!, "claude-auth-operations.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify([{ operationId: "bad-phase", accountId: "work", phase: "unknown", pid: null, startToken: null, generation: 2, startedAt: "not-a-date", deadlineAt: "not-a-date" }]));

  const supervisor = new ClaudeLoginSupervisor(ports());

  expect(supervisor.get("bad-phase")).toBeNull();
  expect(() => supervisor.reserve()).not.toThrow();
});

test("a login spawn error stays terminal and an existing account can retry", () => {
  const account = createManagedClaudeAccount("Retry");
  let failSpawn = true;
  const failing = new ClaudeLoginSupervisor({ ...ports(), spawn: () => { if (failSpawn) throw new Error("spawn failed"); return child as never; } });
  const failed = failing.start(account.id);
  expect(failed.phase).toBe("failed");
  expect(failing.forAccount(account.id)).toEqual(expect.objectContaining({ phase: "failed" }));
  failSpawn = false;
  expect(failing.start(account.id).phase).toBe("awaiting_browser");
});

test("terminal login results expose stable sanitized failure details", () => {
  const account = createManagedClaudeAccount("Sanitized");
  const supervisor = new ClaudeLoginSupervisor({
    ...ports(),
    spawn: () => { throw new Error("/private/home/token=secret https://claude.ai/authorizationCode#state"); },
  });

  const failed = supervisor.start(account.id);

  expect(failed).toEqual(expect.objectContaining({
    phase: "failed",
    result: { status: "failure", code: "start_failed", message: "Claude login could not start" },
  }));
  expect(JSON.stringify(failed)).not.toContain("secret");
  expect(JSON.stringify(failed)).not.toContain("/private/home");
});

test("cancel fences PID identity and Claude command before every signal", async () => {
  const account = createManagedClaudeAccount("Fenced");
  const supervisor = new ClaudeLoginSupervisor({
    ...ports(),
    pidStartToken: () => "reused-pid",
    isExpectedClaude: () => false,
  });
  const operation = supervisor.start(account.id);

  await supervisor.cancel(operation.operationId);

  expect(signals).toEqual([]);
});

test("persistence rollback removes a failed spawned operation and fences child cleanup", () => {
  const account = createManagedClaudeAccount("Rollback");
  const persisted: unknown[][] = [];
  const supervisor = new ClaudeLoginSupervisor(ports(), {
    load: () => [],
    save: (rows) => {
      if (rows.some((row) => row.phase === "awaiting_browser")) throw new Error("disk full");
      persisted.push(rows);
    },
  });

  const failed = supervisor.start(account.id);

  expect(failed).toEqual(expect.objectContaining({ phase: "failed", result: expect.objectContaining({ code: "persistence_failed" }) }));
  expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  expect(() => supervisor.reserve()).not.toThrow();
  expect(JSON.stringify(persisted)).not.toContain(account.home);
});

test("stdout persistence failures become a fenced terminal result without throwing from the stream", () => {
  const account = createManagedClaudeAccount("Stream failure");
  const supervisor = new ClaudeLoginSupervisor(ports(), {
    load: () => [],
    save: (rows) => { if (rows.some((row) => row.phase === "awaiting_code")) throw new Error("disk full"); },
  });
  const operation = supervisor.start(account.id);

  expect(() => child.stdout.emit("data", "Open https://claude.ai/authorize?state=browser-state")).not.toThrow();
  expect(supervisor.get(operation.operationId)).toEqual(expect.objectContaining({ phase: "failed", result: expect.objectContaining({ code: "persistence_failed" }) }));
  expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
});

test("a stdin write failure terminates the fenced child and late stdout cannot revive the operation", async () => {
  const account = createManagedClaudeAccount("Write failure");
  const supervisor = new ClaudeLoginSupervisor(ports());
  const operation = supervisor.start(account.id);
  child.stdout.emit("data", "Open https://claude.ai/authorize?state=browser-state");
  child.stdin.write = () => { throw new Error("broken pipe"); };

  const failed = await supervisor.input(operation.operationId, "authorizationCode#state");
  child.stdout.emit("data", "Open https://claude.ai/another");

  expect(failed).toEqual(expect.objectContaining({ phase: "failed", result: expect.objectContaining({ code: "input_failed" }) }));
  expect(supervisor.get(operation.operationId)).toEqual(expect.objectContaining({ phase: "failed" }));
  expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
});

test("a delayed auth status cannot overwrite a completed cancellation", async () => {
  const account = createManagedClaudeAccount("Reconciliation race");
  fs.writeFileSync(path.join(account.home, ".credentials.json"), "{}", { mode: 0o600 });
  let resolveStatus!: (value: { loggedIn: boolean; method: string | null; email: string | null; plan: string | null }) => void;
  const supervisor = new ClaudeLoginSupervisor({
    ...ports(),
    status: () => new Promise((resolve) => { resolveStatus = resolve; }),
  });
  const operation = supervisor.start(account.id);
  child.emit("close", 0, null);
  await Promise.resolve();

  const canceled = await supervisor.cancel(operation.operationId);
  resolveStatus({ loggedIn: true, method: "oauth", email: "a@example.test", plan: "max" });
  await Promise.resolve();

  expect(canceled.phase).toBe("canceled");
  expect(supervisor.get(operation.operationId)).toEqual(expect.objectContaining({ phase: "canceled" }));
});

test("a deadline that fires during cancellation cannot overwrite the canceled result", async () => {
  const account = createManagedClaudeAccount("Cancel deadline race");
  const callbacks: Array<() => void> = [];
  const supervisor = new ClaudeLoginSupervisor({
    ...ports(),
    setTimeout: (callback) => { callbacks.push(callback); return {} as NodeJS.Timeout; },
  });
  const operation = supervisor.start(account.id);
  const deadline = callbacks[0]!;

  const canceling = supervisor.cancel(operation.operationId);
  deadline();
  callbacks.at(-1)?.();
  await Promise.resolve();
  callbacks.at(-1)?.();
  const canceled = await canceling;

  expect(canceled.phase).toBe("canceled");
  expect(supervisor.get(operation.operationId)).toEqual(expect.objectContaining({ phase: "canceled" }));
});

test("a child exit after cancellation begins cannot restart verification", async () => {
  const account = createManagedClaudeAccount("Cancel exit race");
  const callbacks: Array<() => void> = [];
  const supervisor = new ClaudeLoginSupervisor({
    ...ports(),
    setTimeout: (callback) => { callbacks.push(callback); return {} as NodeJS.Timeout; },
  });
  const operation = supervisor.start(account.id);

  const canceling = supervisor.cancel(operation.operationId);
  child.emit("close", 0, null);
  callbacks.at(-1)?.();
  await Promise.resolve();
  callbacks.at(-1)?.();
  const canceled = await canceling;

  expect(canceled.phase).toBe("canceled");
  expect(supervisor.get(operation.operationId)).toEqual(expect.objectContaining({ phase: "canceled" }));
});

test("restart sends TERM then grace-period KILL for a resistant Claude child", () => {
  const account = createManagedClaudeAccount("Restart");
  const file = path.join(process.env.LLV_STATE_DIR!, "claude-auth-operations.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify([{ operationId: "00000000-0000-4000-8000-000000000002", accountId: account.id, phase: "awaiting_browser", pid: 4242, startToken: "start-1", generation: 3, startedAt: new Date(0).toISOString(), deadlineAt: new Date(1).toISOString() }]));
  const supervisor = new ClaudeLoginSupervisor(ports());
  expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  expect(supervisor.get("00000000-0000-4000-8000-000000000002")).toEqual(expect.objectContaining({ phase: "interrupted" }));
});

test("a retry after recovery supersedes the recovered operation", () => {
  const account = createManagedClaudeAccount("Recovered retry");
  const file = path.join(process.env.LLV_STATE_DIR!, "claude-auth-operations.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify([{ operationId: "00000000-0000-4000-8000-000000000009", accountId: account.id, phase: "awaiting_browser", pid: 4242, startToken: "old-start", generation: 9, startedAt: new Date(0).toISOString(), deadlineAt: new Date(1).toISOString() }]));
  const restarted = new ClaudeLoginSupervisor(ports());

  const retry = restarted.start(account.id);

  expect(retry.phase).toBe("awaiting_browser");
  expect(restarted.forAccount(account.id)).toEqual(expect.objectContaining({ operationId: retry.operationId, phase: "awaiting_browser" }));
});

test("a successful login requires a safe credential file and survives restart as authenticated", async () => {
  const account = createManagedClaudeAccount("Completed");
  const supervisor = new ClaudeLoginSupervisor(ports());
  const operation = supervisor.start(account.id);
  child.emit("close", 0, null);
  await Promise.resolve(); await Promise.resolve();
  expect(supervisor.get(operation.operationId)).toEqual(expect.objectContaining({ phase: "failed" }));

  const credentials = path.join(account.home, ".credentials.json");
  fs.writeFileSync(credentials, "{}", { mode: 0o600 });
  const file = path.join(process.env.LLV_STATE_DIR!, "claude-auth-operations.json");
  fs.writeFileSync(file, JSON.stringify([{ operationId: "00000000-0000-4000-8000-000000000003", accountId: account.id, phase: "verifying", pid: 4242, startToken: "start-1", generation: 9, startedAt: new Date(0).toISOString(), deadlineAt: new Date(1).toISOString() }]));
  const restarted = new ClaudeLoginSupervisor(ports());
  expect(restarted.get("00000000-0000-4000-8000-000000000003")).toEqual(expect.objectContaining({ phase: "authenticated" }));
});

test("timeout records its terminal outcome after killing a TERM-resistant child", async () => {
  const account = createManagedClaudeAccount("Timeout");
  const supervisor = new ClaudeLoginSupervisor({ ...ports(), setTimeout: (fn) => { fn(); return {} as NodeJS.Timeout; } });
  const operation = supervisor.start(account.id);
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
  expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  expect(supervisor.get(operation.operationId)).toEqual(expect.objectContaining({ phase: "timed_out" }));
});

test("legacy Main status keeps the normal process environment", () => {
  expect(claudeStatusEnvironment(process.env.LLV_CLAUDE_HOME!)).toBe(process.env);
});

test("a reservation blocks a second account creation before filesystem mutation", () => {
  const supervisor = new ClaudeLoginSupervisor(ports());
  const reservation = supervisor.reserve();
  expect(() => supervisor.reserve()).toThrow("already running");
  supervisor.abandon(reservation.operationId);
  expect(supervisor.forAccount("missing")).toBeNull();
});
