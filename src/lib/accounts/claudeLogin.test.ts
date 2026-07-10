import { afterAll, beforeEach, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-claude-login-test-"));
const OLD_STATE = process.env.LLV_STATE_DIR; const OLD_HOME = process.env.LLV_CLAUDE_HOME;
process.env.LLV_STATE_DIR = path.join(SANDBOX, "state"); process.env.LLV_CLAUDE_HOME = path.join(SANDBOX, "legacy");
const { createManagedClaudeAccount } = await import("./claude");
const { ClaudeLoginSupervisor, claudeStatusEnvironment, cleanClaudeLoginOutput, loginUrlFromOutput } = await import("./claudeLogin");
type ClaudeLoginPorts = import("./claudeLogin").ClaudeLoginPorts;

class FakeChild extends EventEmitter { pid = 4242; stdout = new EventEmitter(); stderr = new EventEmitter(); writes: string[] = []; stdin = { write: (text: string) => { this.writes.push(text); return true; }, end: () => undefined }; }
let child: FakeChild; let signals: string[];
function ports(): ClaudeLoginPorts { return { spawn: () => child as never, kill: (_pid, signal) => { signals.push(signal); }, pidStartToken: () => "start-1", isExpectedClaude: () => true, status: async () => ({ loggedIn: true, method: "oauth", email: "a@example.test", plan: "max" }), now: () => 1_000, setTimeout: (fn, ms) => { if (ms <= 2_000) fn(); return {} as NodeJS.Timeout; }, clearTimeout: () => undefined }; }
beforeEach(() => { fs.rmSync(process.env.LLV_STATE_DIR!, { recursive: true, force: true }); child = new FakeChild(); signals = []; });
afterAll(() => { if (OLD_STATE === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = OLD_STATE; if (OLD_HOME === undefined) delete process.env.LLV_CLAUDE_HOME; else process.env.LLV_CLAUDE_HOME = OLD_HOME; fs.rmSync(SANDBOX, { recursive: true, force: true }); });

test("parser handles ANSI and chunks while only allowlisted URLs survive", () => {
  expect(cleanClaudeLoginOutput("\u001b[31mhello\u001b[0m")).toBe("hello");
  expect(loginUrlFromOutput("https://evil.test/x https://claude.ai/login?a=1")).toBe("https://claude.ai/login?a=1");
});

test("fake supervised login accepts one bounded code, contains it, and cancels without tmux", async () => {
  const account = createManagedClaudeAccount("Work");
  const supervisor = new ClaudeLoginSupervisor(ports(), () => true);
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

test("restart reconciliation rejects PID reuse and preserves only an interrupted safe DTO", () => {
  const file = path.join(process.env.LLV_STATE_DIR!, "claude-auth-operations.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify([{ operationId: "00000000-0000-4000-8000-000000000001", accountId: "work", phase: "awaiting_browser", pid: 4242, startToken: "old-start", generation: 3, startedAt: new Date(0).toISOString(), deadlineAt: new Date(1).toISOString() }]));
  const supervisor = new ClaudeLoginSupervisor({ ...ports(), pidStartToken: () => "new-process" }, () => true);
  expect(signals).toEqual([]);
  expect(supervisor.get("00000000-0000-4000-8000-000000000001")).toEqual(expect.objectContaining({ phase: "interrupted", loginUrl: null, acceptsCode: false }));
});

test("a login spawn error stays terminal and an existing account can retry", () => {
  const account = createManagedClaudeAccount("Retry");
  let failSpawn = true;
  const failing = new ClaudeLoginSupervisor({ ...ports(), spawn: () => { if (failSpawn) throw new Error("spawn failed"); return child as never; } }, () => true);
  const failed = failing.start(account.id);
  expect(failed.phase).toBe("failed");
  expect(failing.forAccount(account.id)).toEqual(expect.objectContaining({ phase: "failed" }));
  failSpawn = false;
  expect(failing.start(account.id).phase).toBe("awaiting_browser");
});

test("restart sends TERM then grace-period KILL for a resistant Claude child", () => {
  const account = createManagedClaudeAccount("Restart");
  const file = path.join(process.env.LLV_STATE_DIR!, "claude-auth-operations.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify([{ operationId: "00000000-0000-4000-8000-000000000002", accountId: account.id, phase: "awaiting_browser", pid: 4242, startToken: "start-1", generation: 3, startedAt: new Date(0).toISOString(), deadlineAt: new Date(1).toISOString() }]));
  const supervisor = new ClaudeLoginSupervisor(ports(), () => true);
  expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  expect(supervisor.get("00000000-0000-4000-8000-000000000002")).toEqual(expect.objectContaining({ phase: "interrupted" }));
});

test("a successful login requires a safe credential file and survives restart as authenticated", async () => {
  const account = createManagedClaudeAccount("Completed");
  const supervisor = new ClaudeLoginSupervisor(ports(), () => true);
  const operation = supervisor.start(account.id);
  child.emit("close", 0, null);
  await Promise.resolve(); await Promise.resolve();
  expect(supervisor.get(operation.operationId)).toEqual(expect.objectContaining({ phase: "failed" }));

  const credentials = path.join(account.home, ".credentials.json");
  fs.writeFileSync(credentials, "{}", { mode: 0o600 });
  const file = path.join(process.env.LLV_STATE_DIR!, "claude-auth-operations.json");
  fs.writeFileSync(file, JSON.stringify([{ operationId: "00000000-0000-4000-8000-000000000003", accountId: account.id, phase: "verifying", pid: 4242, startToken: "start-1", generation: 9, startedAt: new Date(0).toISOString(), deadlineAt: new Date(1).toISOString() }]));
  const restarted = new ClaudeLoginSupervisor(ports(), () => true);
  expect(restarted.get("00000000-0000-4000-8000-000000000003")).toEqual(expect.objectContaining({ phase: "authenticated" }));
});

test("timeout records its terminal outcome after killing a TERM-resistant child", async () => {
  const account = createManagedClaudeAccount("Timeout");
  const supervisor = new ClaudeLoginSupervisor({ ...ports(), setTimeout: (fn) => { fn(); return {} as NodeJS.Timeout; } }, () => true);
  const operation = supervisor.start(account.id);
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
  expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  expect(supervisor.get(operation.operationId)).toEqual(expect.objectContaining({ phase: "timed_out" }));
});

test("legacy Main status keeps the normal process environment", () => {
  expect(claudeStatusEnvironment(process.env.LLV_CLAUDE_HOME!)).toBe(process.env);
});

test("a reservation blocks a second account creation before filesystem mutation", () => {
  const supervisor = new ClaudeLoginSupervisor(ports(), () => true);
  const reservation = supervisor.reserve();
  expect(() => supervisor.reserve()).toThrow("already running");
  supervisor.abandon(reservation.operationId);
  expect(supervisor.forAccount("missing")).toBeNull();
});
