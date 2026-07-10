import { afterAll, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-codex-accounts-test-"));
const OLD_STATE = process.env.LLV_STATE_DIR;
const OLD_HOME = process.env.LLV_CODEX_HOME;

process.env.LLV_STATE_DIR = path.join(SANDBOX, "state");
process.env.LLV_CODEX_HOME = path.join(SANDBOX, "legacy-codex");

const { CorruptCodexAccountsError, LOGIN_STARTUP_GRACE_MS, activeCodexAccountId, cleanupOrphanedCodexHomes, codexAccountsRoot, codexLoginPaneStatus, createManagedCodexAccount, listCodexAccounts, removeManagedCodexAccount, setActiveCodexAccount } = await import("./codex");

beforeEach(() => {
  fs.rmSync(process.env.LLV_STATE_DIR!, { recursive: true, force: true });
  fs.rmSync(path.join(SANDBOX, "accounts"), { recursive: true, force: true });
});

afterAll(() => {
  if (OLD_STATE === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = OLD_STATE;
  if (OLD_HOME === undefined) delete process.env.LLV_CODEX_HOME;
  else process.env.LLV_CODEX_HOME = OLD_HOME;
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

test("a missing registry safely exposes the legacy account without reading credentials", () => {
  expect(activeCodexAccountId()).toBe("default");
  expect(listCodexAccounts()).toEqual([
    expect.objectContaining({
      id: "default",
      label: "Main",
      kind: "legacy",
      home: path.join(SANDBOX, "legacy-codex"),
      sessionsDir: path.join(SANDBOX, "legacy-codex", "sessions"),
      authPresent: false,
      loginPane: null,
      createdAt: 0,
    }),
  ]);
});

test("a managed overlay shares capabilities while identity and OAuth state stay private", () => {
  const account = createManagedCodexAccount("Work account");
  const shared = ["skills", "prompts", "config.toml", "AGENTS.md", "memories", "rules", path.join("plugins", "cache")];
  for (const relative of shared) {
    expect(fs.lstatSync(path.join(account.home, relative)).isSymbolicLink()).toBe(true);
  }
  for (const relative of ["auth.json", "sessions", "history.jsonl", path.join("plugins", "data"), "mcp-oauth"]) {
    expect(fs.existsSync(path.join(account.home, relative))).toBe(false);
  }
  expect(fs.statSync(account.home).mode & 0o777).toBe(0o700);
});

test("corrupt registry bytes survive rejected mutations", () => {
  const registry = path.join(process.env.LLV_STATE_DIR!, "codex-accounts.json");
  fs.mkdirSync(path.dirname(registry), { recursive: true });
  const corrupt = "{ broken registry remains intact";
  fs.writeFileSync(registry, corrupt);

  expect(() => createManagedCodexAccount("Alt")).toThrow(CorruptCodexAccountsError);
  expect(() => setActiveCodexAccount("default")).toThrow(CorruptCodexAccountsError);
  expect(fs.readFileSync(registry, "utf8")).toBe(corrupt);
  expect(listCodexAccounts().map((account) => account.id)).toEqual(["default"]);
});

test("a syntactically valid registry with an unsafe account is also read-only", () => {
  const registry = path.join(process.env.LLV_STATE_DIR!, "codex-accounts.json");
  fs.mkdirSync(path.dirname(registry), { recursive: true });
  const unsafe = JSON.stringify({ version: 1, active: "default", accounts: [{ id: "../escape", label: "Escape", kind: "managed", createdAt: 1 }] });
  fs.writeFileSync(registry, unsafe);

  expect(() => createManagedCodexAccount("Alt")).toThrow(CorruptCodexAccountsError);
  expect(() => setActiveCodexAccount("default")).toThrow(CorruptCodexAccountsError);
  expect(fs.readFileSync(registry, "utf8")).toBe(unsafe);
});

test("account creation preserves an occupied home and chooses a safe suffix", () => {
  const occupied = path.join(SANDBOX, "accounts", "codex", "work");
  const auth = path.join(occupied, "auth.json");
  const session = path.join(occupied, "sessions", "sentinel.jsonl");
  fs.mkdirSync(path.dirname(session), { recursive: true });
  fs.writeFileSync(auth, "credential sentinel");
  fs.writeFileSync(session, "session sentinel");

  const account = createManagedCodexAccount("Work");

  expect(account.id).toBe("work-1");
  expect(fs.readFileSync(auth, "utf8")).toBe("credential sentinel");
  expect(fs.readFileSync(session, "utf8")).toBe("session sentinel");
});

test("managed Codex account removal deletes its registry record and home, then cleans safe orphan homes", () => {
  const account = createManagedCodexAccount("Delete me");
  const orphan = path.join(codexAccountsRoot(), "probe-login");
  fs.mkdirSync(orphan, { recursive: true, mode: 0o700 });

  removeManagedCodexAccount(account.id);
  const cleaned = cleanupOrphanedCodexHomes();

  expect(listCodexAccounts().map((item) => item.id)).not.toContain(account.id);
  expect(fs.existsSync(account.home)).toBe(false);
  expect(cleaned).toEqual(["probe-login"]);
  expect(fs.existsSync(orphan)).toBe(false);
});

test("a home deletion failure keeps the Codex account registered and retryable", () => {
  const account = createManagedCodexAccount("Retry removal");
  const originalRm = fs.rmSync;
  fs.rmSync = ((target: fs.PathLike, options?: fs.RmDirOptions) => {
    if (String(target).includes(account.id)) throw Object.assign(new Error("denied"), { code: "EACCES" });
    return originalRm(target, options);
  }) as typeof fs.rmSync;
  try {
    expect(() => removeManagedCodexAccount(account.id)).toThrow("denied");
  } finally {
    fs.rmSync = originalRm;
  }

  expect(listCodexAccounts().map((item) => item.id)).toContain(account.id);
  expect(fs.existsSync(account.home)).toBe(true);
  expect(() => removeManagedCodexAccount(account.id)).not.toThrow();
});

test("orphan cleanup propagates a Codex accounts-root read failure", () => {
  const root = codexAccountsRoot();
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const originalRead = fs.readdirSync;
  fs.readdirSync = ((target: fs.PathLike, options?: unknown) => {
    if (path.resolve(String(target)) === path.resolve(root)) throw Object.assign(new Error("unreadable"), { code: "EACCES" });
    return originalRead(target, options as never);
  }) as typeof fs.readdirSync;
  try {
    expect(() => cleanupOrphanedCodexHomes()).toThrow("unreadable");
  } finally {
    fs.readdirSync = originalRead;
  }
});

test("concurrent Codex removal and creation preserve both mutations", async () => {
  const removed = createManagedCodexAccount("Remove child");
  const modulePath = path.join(import.meta.dir, "codex.ts");
  const registry = path.join(process.env.LLV_STATE_DIR!, "codex-accounts.json");
  const ready = path.join(SANDBOX, "remove-ready");
  const createReady = path.join(SANDBOX, "create-ready");
  const removedDone = path.join(SANDBOX, "remove-done");
  const common = `
    const fs = (await import("node:fs")).default;
    const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    const wait = (file) => { const until = Date.now() + 1000; while (!fs.existsSync(file) && Date.now() < until) sleep(5); };
    const originalRename = fs.renameSync;
  `;
  const remover = Bun.spawn({
    cmd: [process.execPath, "-e", `${common}
      fs.renameSync = (from, to) => { if (to === ${JSON.stringify(registry)}) { fs.writeFileSync(${JSON.stringify(ready)}, "1"); wait(${JSON.stringify(createReady)}); } originalRename(from, to); if (to === ${JSON.stringify(registry)}) fs.writeFileSync(${JSON.stringify(removedDone)}, "1"); };
      const m = await import(${JSON.stringify(modulePath)}); m.removeManagedCodexAccount(${JSON.stringify(removed.id)});
    `],
    env: { ...process.env, LLV_STATE_DIR: process.env.LLV_STATE_DIR!, LLV_CODEX_HOME: process.env.LLV_CODEX_HOME! },
    stdout: "ignore", stderr: "pipe",
  });
  const creator = Bun.spawn({
    cmd: [process.execPath, "-e", `${common}
      wait(${JSON.stringify(ready)});
      fs.renameSync = (from, to) => { if (to === ${JSON.stringify(registry)}) { fs.writeFileSync(${JSON.stringify(createReady)}, "1"); wait(${JSON.stringify(removedDone)}); } originalRename(from, to); };
      const m = await import(${JSON.stringify(modulePath)}); m.createManagedCodexAccount("Created child");
    `],
    env: { ...process.env, LLV_STATE_DIR: process.env.LLV_STATE_DIR!, LLV_CODEX_HOME: process.env.LLV_CODEX_HOME! },
    stdout: "ignore", stderr: "pipe",
  });

  expect(await remover.exited).toBe(0);
  expect(await creator.exited).toBe(0);
  expect(listCodexAccounts().map((item) => item.id)).toContain("created-child");
  expect(listCodexAccounts().map((item) => item.id)).not.toContain(removed.id);
});

test("a shell during login startup grace remains pending", () => {
  const startedAt = 1_000;
  expect(codexLoginPaneStatus(false, { paneId: "%4", windowName: "codex-login", startedAt }, { windowName: "codex-login", command: "zsh" }, startedAt + LOGIN_STARTUP_GRACE_MS - 1)).toEqual({ state: "pending", clear: false });
});

test("a shell after login startup grace becomes idle", () => {
  const startedAt = 1_000;
  expect(codexLoginPaneStatus(false, { paneId: "%4", windowName: "codex-login", startedAt }, { windowName: "codex-login", command: "zsh" }, startedAt + LOGIN_STARTUP_GRACE_MS)).toEqual({ state: "idle", clear: true });
});

test("a transient missing pane during startup grace stays pending", () => {
  const startedAt = 1_000;
  expect(codexLoginPaneStatus(false, { paneId: "%4", windowName: "codex-login", startedAt }, null, startedAt + LOGIN_STARTUP_GRACE_MS - 1)).toEqual({ state: "pending", clear: false });
});

test("a missing pane at the grace deadline becomes idle and clears", () => {
  const startedAt = 1_000;
  expect(codexLoginPaneStatus(false, { paneId: "%4", windowName: "codex-login", startedAt }, null, startedAt + LOGIN_STARTUP_GRACE_MS)).toEqual({ state: "idle", clear: true });
});

test("a missing pane past the grace deadline becomes idle and clears", () => {
  const startedAt = 1_000;
  expect(codexLoginPaneStatus(false, { paneId: "%4", windowName: "codex-login", startedAt }, null, startedAt + LOGIN_STARTUP_GRACE_MS + 60_000)).toEqual({ state: "idle", clear: true });
});

test("a pane whose window no longer matches is a different pane and clears immediately", () => {
  const startedAt = 1_000;
  expect(codexLoginPaneStatus(false, { paneId: "%4", windowName: "codex-login", startedAt }, { windowName: "other", command: "codex" }, startedAt + 1)).toEqual({ state: "idle", clear: true });
});

test("legacy pane records without a timestamp remain readable", () => {
  const registry = path.join(process.env.LLV_STATE_DIR!, "codex-accounts.json");
  fs.mkdirSync(path.dirname(registry), { recursive: true });
  fs.writeFileSync(registry, JSON.stringify({ version: 1, active: "work", accounts: [{ id: "work", label: "Work", kind: "managed", createdAt: 1, loginPane: { paneId: "%4", windowName: "codex-login" } }] }));

  expect(listCodexAccounts().find((account) => account.id === "work")?.loginPane).toEqual({ paneId: "%4", windowName: "codex-login", startedAt: 0 });
});
