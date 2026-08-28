import { afterAll, beforeEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-claude-login-identity-test-"));
const OLD_STATE = process.env.LLV_STATE_DIR; const OLD_HOME = process.env.LLV_CLAUDE_HOME;
process.env.LLV_STATE_DIR = path.join(SANDBOX, "state"); process.env.LLV_CLAUDE_HOME = path.join(SANDBOX, "legacy");
const { createManagedClaudeAccount } = await import("./claude");
const { ClaudeLoginSupervisor, isExpectedClaudeLoginArgv, processIdentityPorts } = await import("./claudeLogin");
type ClaudeLoginPorts = import("./claudeLogin").ClaudeLoginPorts;
type LoginChild = import("./claudeLogin").LoginChild;
type ProcessIdentityReaders = import("./claudeLogin").ProcessIdentityReaders;

const LOGIN_PID = 4242;
/* What the macOS kernel reports for a login the supervisor just spawned: the
   Homebrew `claude` is a shell wrapper, so argv[0] is the interpreter. */
const LOGIN_ARGV = ["/bin/sh", "/opt/homebrew/bin/claude", "auth", "login", "--claudeai"];
const LOGIN_TOKEN = `${LOGIN_PID}:1721234567:012345`;

class FakeChild extends EventEmitter {
  pid = LOGIN_PID;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  writes: string[] = [];
  handleSignals: string[] = [];
  stdin = { write: (text: string) => { this.writes.push(text); return true; }, end: () => undefined };
  kill(signal?: string) { this.handleSignals.push(signal ?? "SIGTERM"); return true; }
}

let child: FakeChild; let signals: string[];

/** Every port except the identity trio, which each test supplies. */
function ports(): Omit<ClaudeLoginPorts, "pidStartToken" | "isExpectedClaude" | "waitForExit"> {
  return {
    spawn: () => child as never,
    kill: (_pid, signal) => { signals.push(signal); },
    status: async () => ({ loggedIn: true, method: "oauth", email: "person@example.com", plan: "max" }),
    now: () => 1_000,
    setTimeout: (fn, ms) => { if (ms <= 2_000) fn(); return {} as NodeJS.Timeout; },
    clearTimeout: () => undefined,
  };
}

/** A macOS host as the fence sees it: pid → kernel start token and argv. */
function darwinKernel(table: Map<number, { token: string | null; argv: string[] | null }>): ProcessIdentityReaders {
  return {
    startToken: (pid) => table.get(pid)?.token ?? null,
    argv: (pid) => table.get(pid)?.argv ?? null,
  };
}

function loginTable(): Map<number, { token: string | null; argv: string[] | null }> {
  return new Map([[LOGIN_PID, { token: LOGIN_TOKEN, argv: LOGIN_ARGV }]]);
}

beforeEach(() => {
  fs.rmSync(process.env.LLV_STATE_DIR!, { recursive: true, force: true });
  child = new FakeChild();
  signals = [];
});

afterAll(() => {
  if (OLD_STATE === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = OLD_STATE;
  if (OLD_HOME === undefined) delete process.env.LLV_CLAUDE_HOME; else process.env.LLV_CLAUDE_HOME = OLD_HOME;
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

test("every macOS argv shape reaches the same command matcher the Linux command line uses", () => {
  expect(isExpectedClaudeLoginArgv(["/opt/homebrew/bin/claude", "auth", "login", "--claudeai"])).toBe(true);
  expect(isExpectedClaudeLoginArgv(["/opt/homebrew/bin/node", "/opt/claude/cli.js", "auth", "login", "--claudeai"])).toBe(true);
  expect(isExpectedClaudeLoginArgv(LOGIN_ARGV)).toBe(true);
  expect(isExpectedClaudeLoginArgv(["/opt/homebrew/bin/claude", "auth", "status", "--json"])).toBe(false);
  expect(isExpectedClaudeLoginArgv(["/bin/sh", "-c", "claude auth login --claudeai"])).toBe(false);
  expect(isExpectedClaudeLoginArgv(["/usr/bin/vim", "notes.txt"])).toBe(false);
  expect(isExpectedClaudeLoginArgv([])).toBe(false);
});

test("on macOS the kernel readers fence a real login child in, where /proc rejected it (issue #1256)", () => {
  const account = createManagedClaudeAccount("Darwin adopted");
  const identity = processIdentityPorts("darwin", darwinKernel(loginTable()));
  const supervisor = new ClaudeLoginSupervisor({ ...ports(), ...identity });

  const operation = supervisor.start(account.id);

  expect(operation).toEqual(expect.objectContaining({ phase: "awaiting_browser" }));
  expect(identity.pidStartToken(LOGIN_PID)).toBe(LOGIN_TOKEN);
  expect(child.handleSignals).toEqual([]);
});

test("on macOS a pid running something else is refused and never signalled by number", () => {
  const account = createManagedClaudeAccount("Darwin recycled pid");
  const recycled = new Map([[LOGIN_PID, { token: LOGIN_TOKEN, argv: ["/usr/bin/vim", "notes.txt"] }]]);
  const supervisor = new ClaudeLoginSupervisor({ ...ports(), ...processIdentityPorts("darwin", darwinKernel(recycled)) });

  const operation = supervisor.start(account.id);

  expect(operation).toEqual(expect.objectContaining({ phase: "failed", result: expect.objectContaining({ code: "launch_unfenced" }) }));
  expect(child.writes).toEqual([]);
  // The stranger's pid is killed through the child handle only: signalling it
  // by number is exactly what the fence exists to prevent.
  expect(child.handleSignals).toEqual(["SIGKILL"]);
  expect(signals).toEqual([]);
});

test("on macOS a pid the kernel does not attribute to this login is refused", () => {
  const account = createManagedClaudeAccount("Darwin unattributed");
  // proc_pidinfo answered for a different pid, or the process was already gone.
  const unknown = new Map([[LOGIN_PID, { token: null, argv: LOGIN_ARGV }]]);
  const supervisor = new ClaudeLoginSupervisor({ ...ports(), ...processIdentityPorts("darwin", darwinKernel(unknown)) });

  const operation = supervisor.start(account.id);

  expect(operation).toEqual(expect.objectContaining({ phase: "failed", result: expect.objectContaining({ code: "launch_unfenced" }) }));
  expect(signals).toEqual([]);
});

test("on macOS a login pid recycled after adoption is never signalled", async () => {
  const account = createManagedClaudeAccount("Darwin recycled after adoption");
  const table = loginTable();
  const supervisor = new ClaudeLoginSupervisor({ ...ports(), ...processIdentityPorts("darwin", darwinKernel(table)) });
  const operation = supervisor.start(account.id);
  expect(operation).toEqual(expect.objectContaining({ phase: "awaiting_browser" }));

  // The login exited and the kernel handed its number to an unrelated process:
  // same pid, different start token, different command.
  table.set(LOGIN_PID, { token: `${LOGIN_PID}:1721299999:000001`, argv: ["/usr/bin/vim", "notes.txt"] });
  const canceled = await supervisor.cancel(operation.operationId);

  expect(canceled).toEqual(expect.objectContaining({ phase: "canceled" }));
  expect(signals).toEqual([]);
});

test("on macOS a child read before its exec completes is adopted once the login appears", () => {
  const account = createManagedClaudeAccount("Darwin pre-exec");
  // posix_spawn returned the pid while it was still a fork of this process:
  // the first reads answer with the viewer's own argv, then the exec lands.
  const viewerArgv = ["/opt/homebrew/bin/bun", "server.js"];
  let reads = 0;
  const supervisor = new ClaudeLoginSupervisor({ ...ports(), ...processIdentityPorts("darwin", {
    startToken: (pid) => (pid === LOGIN_PID ? LOGIN_TOKEN : null),
    argv: (pid) => (pid !== LOGIN_PID ? viewerArgv : (reads++ < 3 ? viewerArgv : LOGIN_ARGV)),
  }) });

  const operation = supervisor.start(account.id);

  expect(operation).toEqual(expect.objectContaining({ phase: "awaiting_browser" }));
  expect(reads).toBeGreaterThan(3);
});

test("on macOS a pid whose command never becomes the login is refused when the window closes", () => {
  const account = createManagedClaudeAccount("Darwin never execs");
  const viewerArgv = ["/opt/homebrew/bin/bun", "server.js"];
  const supervisor = new ClaudeLoginSupervisor({ ...ports(), ...processIdentityPorts("darwin", {
    startToken: (pid) => (pid === LOGIN_PID ? LOGIN_TOKEN : null),
    argv: () => viewerArgv,
  }) });

  const operation = supervisor.start(account.id);

  expect(operation).toEqual(expect.objectContaining({ phase: "failed", result: expect.objectContaining({ code: "launch_unfenced" }) }));
  expect(signals).toEqual([]);
});

test("on macOS a live pid with an unreadable command is refused, and a dead one immediately", () => {
  const unreadable = processIdentityPorts("darwin", { startToken: () => LOGIN_TOKEN, argv: () => null });
  const gone = processIdentityPorts("darwin", { startToken: () => null, argv: () => null });

  const startedAt = Date.now();
  expect(gone.isExpectedClaude(LOGIN_PID)).toBe(false);
  const goneTook = Date.now() - startedAt;
  expect(unreadable.isExpectedClaude(LOGIN_PID)).toBe(false);

  // A pid the kernel no longer knows is decided at once; only a live process
  // whose command has not appeared yet is worth waiting for.
  expect(goneTook).toBeLessThan(50);
});

test.skipIf(process.platform === "darwin")("the darwin branch reads the kernel and never falls back to /proc", () => {
  const identity = processIdentityPorts("darwin");

  // This host has a live pid and a /proc to read it from; the darwin readers
  // must still answer "unidentified" rather than borrowing the Linux source.
  expect(identity.pidStartToken(process.pid)).toBeNull();
  expect(identity.isExpectedClaude(process.pid)).toBe(false);
});

test.skipIf(process.platform !== "linux")("the Linux branch keeps reading /proc exactly as before", () => {
  const identity = processIdentityPorts("linux");
  const stat = fs.readFileSync(`/proc/${process.pid}/stat`, "utf8").split(" ")[21];

  expect(identity.pidStartToken(process.pid)).toBe(stat!);
  expect(identity.isExpectedClaude(process.pid)).toBe(false);
  expect(identity.pidStartToken(2 ** 31 - 1)).toBeNull();
});

test.skipIf(process.platform !== "darwin")("on macOS a real spawned login clears the real fence and a foreign pid does not", async () => {
  const account = createManagedClaudeAccount("Darwin real login");
  const directory = fs.mkdtempSync(path.join(SANDBOX, "shim-"));
  const shim = path.join(directory, "claude");
  // A wrapper script, like every macOS `claude` install: reads stdin forever,
  // so the fence sees a live child exactly as the real login would be.
  fs.writeFileSync(shim, "#!/bin/sh\nwhile read -r _line; do :; done\n", { mode: 0o755 });
  const identity = processIdentityPorts();
  const spawned: Array<{ pid?: number; kill(signal?: NodeJS.Signals): boolean }> = [];
  const supervisor = new ClaudeLoginSupervisor({
    ...ports(),
    ...identity,
    kill: (pid, signal) => { signals.push(signal); try { process.kill(-pid, signal); } catch { /* already gone */ } },
    spawn: (_command, args, options) => {
      const real = spawn(shim, args, options);
      spawned.push(real);
      return real as unknown as LoginChild;
    },
  });

  const operation = supervisor.start(account.id);
  const pid = spawned[0]?.pid ?? 0;
  try {
    expect(operation).toEqual(expect.objectContaining({ phase: "awaiting_browser" }));
    expect(pid).toBeGreaterThan(0);
    const token = identity.pidStartToken(pid) ?? "";
    expect(token).toMatch(new RegExp(`^${pid}:\\d+:\\d{6}$`));
    expect(identity.isExpectedClaude(pid)).toBe(true);
    // Still a fence: this test process is alive and is not that login.
    expect(identity.isExpectedClaude(process.pid)).toBe(false);
    expect(identity.pidStartToken(process.pid)).not.toBe(token);

    const canceled = await supervisor.cancel(operation.operationId);
    expect(canceled).toEqual(expect.objectContaining({ phase: "canceled" }));
    expect(signals).toContain("SIGTERM");
    await identity.waitForExit(pid, token);
    expect(identity.isExpectedClaude(pid)).toBe(false);
  } finally {
    for (const real of spawned) { try { real.kill("SIGKILL"); } catch { /* already gone */ } }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
