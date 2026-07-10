import { afterAll, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-claude-accounts-test-"));
const OLD_STATE = process.env.LLV_STATE_DIR;
const OLD_HOME = process.env.LLV_CLAUDE_HOME;
process.env.LLV_STATE_DIR = path.join(SANDBOX, "state");
process.env.LLV_CLAUDE_HOME = path.join(SANDBOX, "legacy-claude");

const mod = await import("./claude");

beforeEach(() => {
  fs.rmSync(process.env.LLV_STATE_DIR!, { recursive: true, force: true });
  fs.rmSync(process.env.LLV_CLAUDE_HOME!, { recursive: true, force: true });
  fs.rmSync(path.join(SANDBOX, "accounts"), { recursive: true, force: true });
});
afterAll(() => {
  if (OLD_STATE === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = OLD_STATE;
  if (OLD_HOME === undefined) delete process.env.LLV_CLAUDE_HOME; else process.env.LLV_CLAUDE_HOME = OLD_HOME;
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

test("legacy Claude is Main and account creation never rewrites legacy credentials", () => {
  const credentials = path.join(process.env.LLV_CLAUDE_HOME!, ".credentials.json");
  fs.mkdirSync(path.dirname(credentials), { recursive: true, mode: 0o700 });
  fs.writeFileSync(credentials, "legacy-secret", { mode: 0o600 });
  const before = fs.readFileSync(credentials, "utf8");
  const account = mod.createManagedClaudeAccount("Work");
  expect(mod.listClaudeAccounts()[0]).toEqual(expect.objectContaining({ id: "default", label: "Main", kind: "legacy" }));
  expect(account.projectsDir).toBe(path.join(account.home, "projects"));
  expect(fs.readFileSync(credentials, "utf8")).toBe(before);
  expect(fs.statSync(account.home).mode & 0o777).toBe(0o700);
});

test("managed homes are distinct, snapshot-only, contained, and scrub inherited credentials", () => {
  const skills = path.join(process.env.LLV_CLAUDE_HOME!, "skills", "safe.md");
  fs.mkdirSync(path.dirname(skills), { recursive: true }); fs.writeFileSync(skills, "safe");
  const a = mod.createManagedClaudeAccount("A"); const b = mod.createManagedClaudeAccount("B");
  expect(a.home).not.toBe(b.home);
  expect(fs.lstatSync(path.join(a.home, "skills")).isSymbolicLink()).toBe(true);
  expect(fs.realpathSync(path.join(a.home, "skills"))).toContain(path.join("shared", "claude"));
  const env = mod.claudeManagedEnvironment(a.home, { NODE_ENV: "test", ANTHROPIC_API_KEY: "secret", CLAUDE_CODE_OAUTH_TOKEN: "secret", SAFE: "yes" });
  expect(env).toEqual(expect.objectContaining({ CLAUDE_CONFIG_DIR: a.home, SAFE: "yes" }));
  expect(env.ANTHROPIC_API_KEY).toBeUndefined(); expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  const transcript = path.join(a.projectsDir, "-repo", "12345678-1234-1234-1234-123456789abc.jsonl");
  fs.mkdirSync(path.dirname(transcript), { recursive: true }); fs.writeFileSync(transcript, "{}");
  expect(mod.claudeHomeOwningTranscript(transcript)).toBe(a.home);
});

test("unsafe modes and corrupt registries reject sensitive mutation while read mode stays Main", () => {
  const account = mod.createManagedClaudeAccount("Unsafe");
  fs.chmodSync(account.home, 0o755);
  expect(() => mod.claudeAccountForSpawn(account.id)).toThrow();
  fs.rmSync(process.env.LLV_STATE_DIR!, { recursive: true, force: true });
  const registry = mod.claudeRegistryPath(); fs.mkdirSync(path.dirname(registry), { recursive: true }); fs.writeFileSync(registry, "{ corrupt registry");
  expect(mod.listClaudeAccounts().map((item) => item.id)).toEqual(["default"]);
  expect(() => mod.createManagedClaudeAccount("Other")).toThrow(mod.CorruptClaudeAccountsError);
  expect(fs.readFileSync(registry, "utf8")).toBe("{ corrupt registry");
});

test("managed credentials reject symlinks and broad modes before an agent can spawn", () => {
  const account = mod.createManagedClaudeAccount("Credential safety");
  const credentials = path.join(account.home, ".credentials.json");
  fs.writeFileSync(credentials, "{}", { mode: 0o600 });
  expect(mod.managedClaudeCredentialIsSafe(account.home, true)).toBe(true);
  fs.chmodSync(credentials, 0o644);
  expect(mod.managedClaudeCredentialIsSafe(account.home, true)).toBe(false);
  expect(() => mod.claudeAccountForSpawn(account.id)).toThrow(mod.UnsafeClaudeHomeError);
  fs.rmSync(credentials); fs.symlinkSync(path.join(process.env.LLV_CLAUDE_HOME!, "missing"), credentials);
  expect(mod.managedClaudeCredentialIsSafe(account.home, true)).toBe(false);
});

test("managed account removal deletes its registry record and home, while orphan cleanup only removes safe managed children", () => {
  const account = mod.createManagedClaudeAccount("Delete me");
  const orphan = path.join(mod.claudeAccountsRoot(), "probe-login");
  fs.mkdirSync(orphan, { recursive: true, mode: 0o700 });

  mod.removeManagedClaudeAccount(account.id);
  const cleaned = mod.cleanupOrphanedClaudeHomes();

  expect(mod.listClaudeAccounts().map((item) => item.id)).not.toContain(account.id);
  expect(fs.existsSync(account.home)).toBe(false);
  expect(cleaned).toEqual(["probe-login"]);
  expect(fs.existsSync(orphan)).toBe(false);
});

test("a home deletion failure keeps the Claude account registered and retryable", () => {
  const account = mod.createManagedClaudeAccount("Retry removal");
  const originalRm = fs.rmSync;
  fs.rmSync = ((target: fs.PathLike, options?: fs.RmDirOptions) => {
    if (String(target).includes(account.id)) throw Object.assign(new Error("denied"), { code: "EACCES" });
    return originalRm(target, options);
  }) as typeof fs.rmSync;
  try {
    expect(() => mod.removeManagedClaudeAccount(account.id)).toThrow("denied");
  } finally {
    fs.rmSync = originalRm;
  }

  expect(mod.listClaudeAccounts().map((item) => item.id)).toContain(account.id);
  expect(fs.existsSync(account.home)).toBe(true);
  expect(() => mod.removeManagedClaudeAccount(account.id)).not.toThrow();
});

test("orphan cleanup propagates a Claude accounts-root read failure", () => {
  const root = mod.claudeAccountsRoot();
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const originalRead = fs.readdirSync;
  fs.readdirSync = ((target: fs.PathLike, options?: unknown) => {
    if (path.resolve(String(target)) === path.resolve(root)) throw Object.assign(new Error("unreadable"), { code: "EACCES" });
    return originalRead(target, options as never);
  }) as typeof fs.readdirSync;
  try {
    expect(() => mod.cleanupOrphanedClaudeHomes()).toThrow("unreadable");
  } finally {
    fs.readdirSync = originalRead;
  }
});

test("an interrupted registry replacement leaves the prior atomic registry readable", () => {
  const account = mod.createManagedClaudeAccount("Atomic");
  const registry = mod.claudeRegistryPath();
  fs.writeFileSync(`${registry}.${process.pid}.tmp`, "{ interrupted");
  expect(mod.listClaudeAccounts().map((item) => item.id)).toContain(account.id);
  mod.setActiveClaudeAccount(account.id);
  expect(mod.activeClaudeAccountId()).toBe(account.id);
});

test("concurrent child processes create and select accounts without losing registry updates", async () => {
  const modulePath = path.join(import.meta.dir, "claude.ts");
  const run = (source: string) => Bun.spawn({
    cmd: [process.execPath, "-e", source],
    env: { ...process.env, LLV_STATE_DIR: process.env.LLV_STATE_DIR!, LLV_CLAUDE_HOME: process.env.LLV_CLAUDE_HOME! },
    stdout: "ignore",
    stderr: "pipe",
  });
  const create = (label: string) => run(`const m = await import(${JSON.stringify(modulePath)}); m.createManagedClaudeAccount(${JSON.stringify(label)});`);
  const [first, second] = [create("Child A"), create("Child B")];
  expect(await first.exited).toBe(0); expect(await second.exited).toBe(0);
  const ids = mod.listClaudeAccounts().map((item) => item.id);
  expect(ids).toEqual(expect.arrayContaining(["child-a", "child-b"]));
  const select = (id: string) => run(`const m = await import(${JSON.stringify(modulePath)}); m.setActiveClaudeAccount(${JSON.stringify(id)});`);
  const [left, right] = [select("child-a"), select("child-b")];
  expect(await left.exited).toBe(0); expect(await right.exited).toBe(0);
  expect(["child-a", "child-b"]).toContain(mod.activeClaudeAccountId());
});
