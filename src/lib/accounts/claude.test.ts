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
const { AccountHistoryInventoryBlockedError } = await import("./removal");
const { agentRegistry } = await import("@/lib/agent/registry");
const { beginLegacySpawnFixture } = await import("@/lib/agent/registryTestFixtures");

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
  expect(cleaned).toEqual({ removed: ["probe-login"], unresolved: [] });
  expect(fs.existsSync(orphan)).toBe(false);
});

test("durable account retirement rejects every later spawn admission", () => {
  const account = mod.createManagedClaudeAccount("Retired admission");
  mod.removeManagedClaudeAccount(account.id);

  expect(() => beginLegacySpawnFixture(agentRegistry(), {
    engine: "claude",
    cwd: "/repo",
    accountId: account.id,
  })).toThrow("claude account is retired");
});

test("a fully-owned home deletes cleanly while retaining its transcripts and removing provider sidecars", () => {
  const account = mod.createManagedClaudeAccount("Retire me");
  const transcript = path.join(account.projectsDir, "-repo", "12345678-1234-1234-1234-123456789abc.jsonl");
  fs.mkdirSync(path.dirname(transcript), { recursive: true, mode: 0o700 });
  fs.writeFileSync(transcript, "{\"cwd\":\"/repo\"}\n", { mode: 0o600 });
  agentRegistry().ensureConversation("claude", transcript, account.id);
  fs.writeFileSync(path.join(account.home, ".credentials.json"), "{}", { mode: 0o600 });
  fs.writeFileSync(path.join(account.home, ".claude.json"), "{}", { mode: 0o600 });
  const sidecar = `${account.home}.lock`;
  fs.mkdirSync(sidecar, { mode: 0o700 });

  const removal = mod.removeManagedClaudeAccount(account.id);

  expect(removal).toEqual({ cleanupPending: false });
  expect(mod.listClaudeAccounts().map((item) => item.id)).not.toContain(account.id);
  // The transcript stays at the exact path the registry and the board already know.
  expect(fs.readFileSync(transcript, "utf8")).toBe("{\"cwd\":\"/repo\"}\n");
  expect(mod.claudeProjectRoots()).toContain(account.projectsDir);
  expect(fs.readdirSync(account.home)).toEqual(["projects"]);
  expect(mod.claudeHomeOwningTranscript(transcript)).toBeNull();
  expect(fs.existsSync(sidecar)).toBe(false);
  // A retired archive is not an orphan, and its id is never reissued.
  expect(mod.cleanupOrphanedClaudeHomes()).toEqual({ removed: [], unresolved: [] });
  expect(fs.existsSync(transcript)).toBe(true);
  expect(mod.createManagedClaudeAccount("Retire me").id).not.toBe(account.id);
});

test("Claude per-session debug logs block account deletion and name the exact history path", () => {
  const account = mod.createManagedClaudeAccount("Debug history");
  const relative = path.join("debug", "12345678-90ab-cdef-1234-567890abcdef.txt");
  const artifact = path.join(account.home, relative);
  fs.mkdirSync(path.dirname(artifact), { recursive: true, mode: 0o700 });
  fs.writeFileSync(artifact, "session activity\n", { mode: 0o600 });

  let caught: unknown;
  try { mod.removeManagedClaudeAccount(account.id); }
  catch (error) { caught = error; }

  expect(caught).toBeInstanceOf(AccountHistoryInventoryBlockedError);
  expect((caught as InstanceType<typeof AccountHistoryInventoryBlockedError>).report.artifacts).toContainEqual({
    path: relative,
    classification: "history",
    history: true,
  });
  expect(fs.readFileSync(artifact, "utf8")).toBe("session activity\n");
  expect(fs.existsSync(account.home)).toBe(true);
  expect(mod.listClaudeAccounts().map((candidate) => candidate.id)).toContain(account.id);
});

for (const [label, relative, contents] of [
  ["paste cache", path.join("paste-cache", "12345678-90ab-cdef-1234-567890abcdef.txt"), "pasted user text\n"],
  ["config backup", path.join("backups", ".claude.json.backup.1234567890"), "{\"projects\":{\"/repo\":{}}}\n"],
] as const) {
  test(`Claude ${label} artifacts block account deletion as history`, () => {
    const account = mod.createManagedClaudeAccount(`History ${label}`);
    const artifact = path.join(account.home, relative);
    fs.mkdirSync(path.dirname(artifact), { recursive: true, mode: 0o700 });
    fs.writeFileSync(artifact, contents, { mode: 0o600 });

    let caught: unknown;
    try { mod.removeManagedClaudeAccount(account.id); }
    catch (error) { caught = error; }

    expect(caught).toBeInstanceOf(AccountHistoryInventoryBlockedError);
    expect((caught as InstanceType<typeof AccountHistoryInventoryBlockedError>).report.artifacts).toContainEqual({
      path: relative,
      classification: "history",
      history: true,
    });
    expect(fs.readFileSync(artifact, "utf8")).toBe(contents);
    expect(fs.existsSync(account.home)).toBe(true);
    expect(mod.listClaudeAccounts().map((candidate) => candidate.id)).toContain(account.id);
  });
}

test("Claude persistent plugin data blocks account deletion as unknown", () => {
  const account = mod.createManagedClaudeAccount("Plugin data");
  const relative = path.join("plugins", "data", "example-plugin", "session-notes.txt");
  const artifact = path.join(account.home, relative);
  fs.mkdirSync(path.dirname(artifact), { recursive: true, mode: 0o700 });
  fs.writeFileSync(artifact, "plugin-owned session notes\n", { mode: 0o600 });

  let caught: unknown;
  try { mod.removeManagedClaudeAccount(account.id); }
  catch (error) { caught = error; }

  expect(caught).toBeInstanceOf(AccountHistoryInventoryBlockedError);
  expect((caught as InstanceType<typeof AccountHistoryInventoryBlockedError>).report.artifacts).toContainEqual({
    path: relative,
    classification: "unknown",
    history: false,
  });
  expect(fs.readFileSync(artifact, "utf8")).toBe("plugin-owned session notes\n");
  expect(fs.existsSync(account.home)).toBe(true);
  expect(mod.listClaudeAccounts().map((candidate) => candidate.id)).toContain(account.id);
});

test("sidecar cleanup does not follow a symlink outside the accounts root", () => {
  const account = mod.createManagedClaudeAccount("Linked sidecar");
  const sidecar = `${account.home}.lock`;
  const outside = path.join(SANDBOX, "outside-sidecar-target");
  const marker = path.join(outside, "keep.txt");
  fs.mkdirSync(sidecar, { mode: 0o700 });
  fs.mkdirSync(outside, { mode: 0o700 });
  fs.writeFileSync(marker, "keep", { mode: 0o600 });
  fs.symlinkSync(outside, path.join(sidecar, "external"));

  const removal = mod.removeManagedClaudeAccount(account.id);

  expect(removal).toEqual({ cleanupPending: true });
  expect(fs.readFileSync(marker, "utf8")).toBe("keep");
  expect(fs.lstatSync(path.join(sidecar, "external")).isSymbolicLink()).toBe(true);
});

test("a provider sidecar recreated during cleanup leaves cleanup pending", () => {
  const account = mod.createManagedClaudeAccount("Recreated sidecar");
  const sidecar = `${account.home}.lock`;
  fs.mkdirSync(sidecar, { mode: 0o700 });
  const originalRm = fs.rmSync;
  fs.rmSync = ((target: fs.PathLike, options?: fs.RmDirOptions) => {
    const result = originalRm(target, options);
    if (path.basename(String(target)) === path.basename(sidecar)) fs.mkdirSync(sidecar, { mode: 0o700 });
    return result;
  }) as typeof fs.rmSync;

  let removal: { cleanupPending: boolean } | undefined;
  try { removal = mod.removeManagedClaudeAccount(account.id); }
  finally { fs.rmSync = originalRm; }

  expect(removal).toEqual({ cleanupPending: true });
  expect(fs.existsSync(sidecar)).toBe(true);
});

test("history created during home cleanup blocks logical deletion and survives", () => {
  const account = mod.createManagedClaudeAccount("Concurrent history");
  const transcript = path.join(account.home, "history.jsonl");
  const credentials = path.join(account.home, ".credentials.json");
  fs.writeFileSync(credentials, "{}", { mode: 0o600 });
  const originalRename = fs.renameSync;
  let injected = false;
  fs.renameSync = ((source: fs.PathLike, destination: fs.PathLike) => {
    const result = originalRename(source, destination);
    if (!injected && String(source).startsWith("/proc/self/fd/") && path.basename(String(source)) === "projects") {
      injected = true;
      fs.writeFileSync(transcript, "{}\n", { mode: 0o600 });
    }
    return result;
  }) as typeof fs.renameSync;

  try {
    expect(() => mod.removeManagedClaudeAccount(account.id)).toThrow("account history inventory blocked removal");
  } finally {
    fs.renameSync = originalRename;
  }

  expect(fs.readFileSync(transcript, "utf8")).toBe("{}\n");
  expect(fs.readFileSync(credentials, "utf8")).toBe("{}");
  expect(mod.listClaudeAccounts().map((candidate) => candidate.id)).toContain(account.id);
});

test("a directory swapped to an outside symlink cannot redirect home cleanup", () => {
  const account = mod.createManagedClaudeAccount("Raced directory");
  const cache = path.join(account.home, "cache");
  const outside = path.join(SANDBOX, "outside-raced-directory");
  const marker = path.join(outside, "keep.txt");
  fs.mkdirSync(cache, { mode: 0o700 });
  fs.writeFileSync(path.join(cache, "local.txt"), "local", { mode: 0o600 });
  fs.mkdirSync(outside, { mode: 0o700 });
  fs.writeFileSync(marker, "keep", { mode: 0o600 });
  const originalOpen = fs.openSync;
  let swapped = false;
  fs.openSync = ((target: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
    if (!swapped && String(target).startsWith("/proc/self/fd/") && path.basename(String(target)) === "cache") {
      swapped = true;
      const racedDirectory = fs.realpathSync(String(target));
      fs.renameSync(racedDirectory, `${racedDirectory}-saved`);
      fs.symlinkSync(outside, racedDirectory);
    }
    return originalOpen(target, flags, mode);
  }) as typeof fs.openSync;

  try {
    expect(() => mod.removeManagedClaudeAccount(account.id)).toThrow("account history inventory blocked removal");
  } finally {
    fs.openSync = originalOpen;
  }

  expect(fs.readFileSync(marker, "utf8")).toBe("keep");
  expect(mod.listClaudeAccounts().map((candidate) => candidate.id)).toContain(account.id);
});

test("an account-registry write failure leaves the registered home untouched", () => {
  const account = mod.createManagedClaudeAccount("Registry failure");
  const originalRename = fs.renameSync;
  fs.renameSync = ((source: fs.PathLike, destination: fs.PathLike) => {
    if (path.resolve(String(destination)) === path.resolve(mod.claudeRegistryPath())) throw Object.assign(new Error("registry write denied"), { code: "EACCES" });
    return originalRename(source, destination);
  }) as typeof fs.renameSync;

  try { expect(() => mod.removeManagedClaudeAccount(account.id)).toThrow("registry write denied"); }
  finally { fs.renameSync = originalRename; }

  expect(fs.existsSync(account.home)).toBe(true);
  expect(mod.listClaudeAccounts().map((candidate) => candidate.id)).toContain(account.id);
});

test("registry rollback stays anchored when the home path becomes an outside symlink", () => {
  const account = mod.createManagedClaudeAccount("Anchored rollback");
  const movedHome = `${account.home}-moved`;
  const outside = path.join(SANDBOX, "outside-rollback-target");
  const marker = path.join(outside, "keep.txt");
  fs.mkdirSync(outside, { mode: 0o700 });
  fs.writeFileSync(marker, "keep", { mode: 0o600 });
  const originalRename = fs.renameSync;
  fs.renameSync = ((source: fs.PathLike, destination: fs.PathLike) => {
    if (path.resolve(String(destination)) === path.resolve(mod.claudeRegistryPath())) {
      originalRename(account.home, movedHome);
      fs.symlinkSync(outside, account.home);
      throw Object.assign(new Error("registry write denied"), { code: "EACCES" });
    }
    return originalRename(source, destination);
  }) as typeof fs.renameSync;

  try { expect(() => mod.removeManagedClaudeAccount(account.id)).toThrow("registry write denied"); }
  finally { fs.renameSync = originalRename; }

  expect(fs.readFileSync(marker, "utf8")).toBe("keep");
  expect(fs.existsSync(path.join(movedHome, "projects"))).toBe(true);
});

test("history added to the retained tree during registry commit rolls deletion back", () => {
  const account = mod.createManagedClaudeAccount("Retained commit race");
  const owned = path.join(account.projectsDir, "-repo", "owned.jsonl");
  const late = path.join(account.projectsDir, "-repo", "late-unowned.jsonl");
  const credentials = path.join(account.home, ".credentials.json");
  fs.mkdirSync(path.dirname(owned), { recursive: true, mode: 0o700 });
  fs.writeFileSync(owned, "{}\n", { mode: 0o600 });
  fs.writeFileSync(credentials, "{}", { mode: 0o600 });
  agentRegistry().ensureConversation("claude", owned, account.id);
  const originalRename = fs.renameSync;
  let injected = false;
  fs.renameSync = ((source: fs.PathLike, destination: fs.PathLike) => {
    const result = originalRename(source, destination);
    if (!injected && path.resolve(String(destination)) === path.resolve(mod.claudeRegistryPath())) {
      injected = true;
      fs.writeFileSync(late, "{}\n", { mode: 0o600 });
    }
    return result;
  }) as typeof fs.renameSync;

  try { expect(() => mod.removeManagedClaudeAccount(account.id)).toThrow("account history inventory blocked removal"); }
  finally { fs.renameSync = originalRename; }

  expect(fs.readFileSync(late, "utf8")).toBe("{}\n");
  expect(fs.readFileSync(credentials, "utf8")).toBe("{}");
  expect(mod.listClaudeAccounts().map((candidate) => candidate.id)).toContain(account.id);
});

test("history added to staged data during registry commit rolls deletion back", () => {
  const account = mod.createManagedClaudeAccount("Staged commit race");
  const originalRename = fs.renameSync;
  let stagedProjects: string | null = null;
  let late: string | null = null;
  let injected = false;
  fs.renameSync = ((source: fs.PathLike, destination: fs.PathLike) => {
    const result = originalRename(source, destination);
    if (String(source).startsWith("/proc/self/fd/") && path.basename(String(source)) === "projects") stagedProjects = String(destination);
    if (!injected && stagedProjects && path.resolve(String(destination)) === path.resolve(mod.claudeRegistryPath())) {
      injected = true;
      late = path.join(stagedProjects, "-repo", "late-unowned.jsonl");
      fs.mkdirSync(path.dirname(late), { recursive: true, mode: 0o700 });
      fs.writeFileSync(late, "{}\n", { mode: 0o600 });
    }
    return result;
  }) as typeof fs.renameSync;

  try { expect(() => mod.removeManagedClaudeAccount(account.id)).toThrow("account history inventory blocked removal"); }
  finally { fs.renameSync = originalRename; }

  expect(late).not.toBeNull();
  expect(fs.readFileSync(path.join(account.projectsDir, "-repo", "late-unowned.jsonl"), "utf8")).toBe("{}\n");
  expect(mod.listClaudeAccounts().map((candidate) => candidate.id)).toContain(account.id);
});

test("home replacement during registry commit is refused by held inode identity", () => {
  const account = mod.createManagedClaudeAccount("Replaced home");
  const movedHome = `${account.home}-original`;
  const originalRename = fs.renameSync;
  let replaced = false;
  fs.renameSync = ((source: fs.PathLike, destination: fs.PathLike) => {
    const result = originalRename(source, destination);
    if (!replaced && path.resolve(String(destination)) === path.resolve(mod.claudeRegistryPath())) {
      replaced = true;
      originalRename(account.home, movedHome);
      fs.mkdirSync(account.home, { mode: 0o700 });
    }
    return result;
  }) as typeof fs.renameSync;

  try { expect(() => mod.removeManagedClaudeAccount(account.id)).toThrow("account history inventory blocked removal"); }
  finally { fs.renameSync = originalRename; }

  expect(fs.existsSync(path.join(movedHome, "projects"))).toBe(true);
});

test("staging replacement during registry commit is refused by held inode identity", () => {
  const account = mod.createManagedClaudeAccount("Replaced staging");
  const credentials = path.join(account.home, ".credentials.json");
  fs.writeFileSync(credentials, "{}", { mode: 0o600 });
  const originalRename = fs.renameSync;
  let movedStaging: string | null = null;
  let replaced = false;
  fs.renameSync = ((source: fs.PathLike, destination: fs.PathLike) => {
    const result = originalRename(source, destination);
    if (!replaced && path.resolve(String(destination)) === path.resolve(mod.claudeRegistryPath())) {
      const staging = fs.readdirSync(mod.claudeAccountsRoot())
        .map((name) => path.join(mod.claudeAccountsRoot(), name))
        .find((candidate) => path.basename(candidate).startsWith(`.${account.id}.removal-`));
      if (!staging) throw new Error("expected staging home");
      replaced = true;
      movedStaging = `${staging}-original`;
      originalRename(staging, movedStaging);
      fs.mkdirSync(staging, { mode: 0o700 });
    }
    return result;
  }) as typeof fs.renameSync;

  try { expect(() => mod.removeManagedClaudeAccount(account.id)).toThrow("account history inventory blocked removal"); }
  finally { fs.renameSync = originalRename; }

  expect(movedStaging).not.toBeNull();
  expect(fs.readFileSync(credentials, "utf8")).toBe("{}");
  expect(mod.listClaudeAccounts().map((candidate) => candidate.id)).toContain(account.id);
});

test("history appearing immediately before staged discard restores the account and report", () => {
  const account = mod.createManagedClaudeAccount("Discard history race");
  const credentials = path.join(account.home, ".credentials.json");
  fs.writeFileSync(credentials, "{}", { mode: 0o600 });
  const originalRename = fs.renameSync;
  const originalLstat = fs.lstatSync;
  let stagingHome: string | null = null;
  let stagingReads = 0;
  fs.renameSync = ((source: fs.PathLike, destination: fs.PathLike) => {
    const result = originalRename(source, destination);
    if (path.resolve(String(destination)) === path.resolve(mod.claudeRegistryPath())) {
      stagingHome = fs.readdirSync(mod.claudeAccountsRoot())
        .map((name) => path.join(mod.claudeAccountsRoot(), name))
        .find((candidate) => path.basename(candidate).startsWith(`.${account.id}.removal-`)) ?? null;
    }
    return result;
  }) as typeof fs.renameSync;
  fs.lstatSync = ((target: fs.PathLike, options?: unknown) => {
    if (stagingHome && path.resolve(String(target)) === path.resolve(stagingHome)) {
      stagingReads += 1;
      if (stagingReads === 3) fs.writeFileSync(path.join(stagingHome, "history.jsonl"), "{}\n", { mode: 0o600 });
    }
    return originalLstat(target, options as never);
  }) as typeof fs.lstatSync;

  try { expect(() => mod.removeManagedClaudeAccount(account.id)).toThrow("account history inventory blocked removal"); }
  finally { fs.renameSync = originalRename; fs.lstatSync = originalLstat; }

  expect(fs.readFileSync(credentials, "utf8")).toBe("{}");
  expect(fs.readFileSync(path.join(account.home, "history.jsonl"), "utf8")).toBe("{}\n");
  expect(mod.listClaudeAccounts().map((candidate) => candidate.id)).toContain(account.id);
});

test("an unreadable home presence check blocks logical deletion", () => {
  const account = mod.createManagedClaudeAccount("Unreadable presence");
  const originalLstat = fs.lstatSync;
  fs.lstatSync = ((target: fs.PathLike, options?: unknown) => {
    if (path.resolve(String(target)) === path.resolve(account.home)) throw Object.assign(new Error("presence unreadable"), { code: "EACCES" });
    return originalLstat(target, options as never);
  }) as typeof fs.lstatSync;

  try { expect(() => mod.removeManagedClaudeAccount(account.id)).toThrow("account history inventory blocked removal"); }
  finally { fs.lstatSync = originalLstat; }

  expect(fs.existsSync(account.home)).toBe(true);
  expect(mod.listClaudeAccounts().map((candidate) => candidate.id)).toContain(account.id);
});

test("a sidecar appearing after root enumeration is still cleaned", () => {
  const account = mod.createManagedClaudeAccount("Late sidecar");
  const sidecar = `${account.home}.lock`;
  const root = mod.claudeAccountsRoot();
  const originalRead = fs.readdirSync;
  let injected = false;
  fs.readdirSync = ((target: fs.PathLike, options?: unknown) => {
    const entries = originalRead(target, options as never);
    if (!injected && path.resolve(String(target)) === path.resolve(root)) {
      injected = true;
      fs.mkdirSync(sidecar, { mode: 0o700 });
    }
    return entries;
  }) as typeof fs.readdirSync;

  let removal: { cleanupPending: boolean } | undefined;
  try { removal = mod.removeManagedClaudeAccount(account.id); }
  finally { fs.readdirSync = originalRead; }

  expect(removal).toEqual({ cleanupPending: false });
  expect(fs.existsSync(sidecar)).toBe(false);
});

test("orphan cleanup finishes a retired home whose strip was interrupted (issue #643)", () => {
  const account = mod.createManagedClaudeAccount("Interrupted strip");
  const transcript = path.join(account.projectsDir, "-repo", "abcdef12-1234-1234-1234-123456789abc.jsonl");
  fs.mkdirSync(path.dirname(transcript), { recursive: true, mode: 0o700 });
  fs.writeFileSync(transcript, "{}", { mode: 0o600 });
  agentRegistry().ensureConversation("claude", transcript, account.id);
  const credentials = path.join(account.home, ".credentials.json");
  fs.writeFileSync(credentials, "{}", { mode: 0o600 });
  const originalRm = fs.rmSync;
  fs.rmSync = ((target: fs.PathLike, options?: fs.RmDirOptions) => {
    if (path.basename(String(target)) === ".credentials.json") throw Object.assign(new Error("denied"), { code: "EACCES" });
    return originalRm(target, options);
  }) as typeof fs.rmSync;
  let removal: { cleanupPending: boolean } | undefined;
  try { removal = mod.removeManagedClaudeAccount(account.id); } finally { fs.rmSync = originalRm; }

  expect(removal).toEqual({ cleanupPending: true });
  expect(fs.existsSync(credentials)).toBe(true);
  expect(mod.cleanupOrphanedClaudeHomes()).toEqual({ removed: [account.id], unresolved: [] });
  expect(fs.existsSync(credentials)).toBe(false);
  expect(fs.existsSync(transcript)).toBe(true);
});

test("a home deletion failure leaves a removable Claude orphan after logical removal", () => {
  const account = mod.createManagedClaudeAccount("Retry removal");
  const originalRmdir = fs.rmdirSync;
  fs.rmdirSync = ((target: fs.PathLike) => {
    if (path.resolve(String(target)) === path.resolve(account.home)) throw Object.assign(new Error("denied"), { code: "EACCES" });
    return originalRmdir(target);
  }) as typeof fs.rmdirSync;
  let removal: { cleanupPending: boolean } | undefined;
  try {
    removal = mod.removeManagedClaudeAccount(account.id);
  } finally {
    fs.rmdirSync = originalRmdir;
  }

  expect(removal).toEqual({ cleanupPending: true });
  expect(mod.listClaudeAccounts().map((item) => item.id)).not.toContain(account.id);
  expect(fs.existsSync(account.home)).toBe(true);
  expect(mod.cleanupOrphanedClaudeHomes().removed).toContain(account.id);
  expect(fs.existsSync(account.home)).toBe(false);
});

test("orphan cleanup reports unsafe Claude children for manual recovery", () => {
  const unsafe = path.join(mod.claudeAccountsRoot(), "unsafe-orphan");
  const link = path.join(mod.claudeAccountsRoot(), "linked-orphan");
  fs.mkdirSync(unsafe, { recursive: true, mode: 0o777 });
  fs.chmodSync(unsafe, 0o777);
  fs.symlinkSync(unsafe, link);

  const result = mod.cleanupOrphanedClaudeHomes();

  expect(result.unresolved).toEqual(expect.arrayContaining(["unsafe-orphan", "linked-orphan"]));
  expect(fs.existsSync(unsafe)).toBe(true);
  expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
});

test("orphan cleanup preserves a safe-looking home with unowned history", () => {
  const orphan = path.join(mod.claudeAccountsRoot(), "history-orphan");
  const transcript = path.join(orphan, "projects", "-repo", "unowned.jsonl");
  fs.mkdirSync(path.dirname(transcript), { recursive: true, mode: 0o700 });
  fs.chmodSync(orphan, 0o700);
  fs.writeFileSync(transcript, "{}\n", { mode: 0o600 });

  const result = mod.cleanupOrphanedClaudeHomes();

  expect(result).toMatchObject({
    removed: [],
    unresolved: ["history-orphan"],
    history: {
      "history-orphan": {
        home: orphan,
        artifacts: expect.arrayContaining([{
          path: path.relative(orphan, transcript),
          classification: "history",
          history: true,
        }]),
      },
    },
  });
  expect(fs.readFileSync(transcript, "utf8")).toBe("{}\n");
});

test("orphan cleanup preserves a home owned by an in-flight spawn", () => {
  const orphan = path.join(mod.claudeAccountsRoot(), "live-orphan");
  fs.mkdirSync(orphan, { recursive: true, mode: 0o700 });
  beginLegacySpawnFixture(agentRegistry(), { engine: "claude", cwd: "/repo", accountId: "live-orphan" });

  const result = mod.cleanupOrphanedClaudeHomes();

  expect(result.unresolved).toContain("live-orphan");
  expect(fs.existsSync(orphan)).toBe(true);
});

test("orphan cleanup removes exact stale sidecars and preserves registered account locks", () => {
  const registered = mod.createManagedClaudeAccount("Registered lock");
  const registeredSidecar = `${registered.home}.lock`;
  const staleSidecar = path.join(mod.claudeAccountsRoot(), "stale-account.lock");
  fs.mkdirSync(registeredSidecar, { mode: 0o700 });
  fs.mkdirSync(staleSidecar, { mode: 0o700 });

  const result = mod.cleanupOrphanedClaudeHomes();

  expect(result).toEqual({ removed: ["stale-account.lock"], unresolved: [] });
  expect(fs.existsSync(staleSidecar)).toBe(false);
  expect(fs.existsSync(registeredSidecar)).toBe(true);
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
  const mutationPath = path.join(import.meta.dir, "accountMutation.ts");
  const run = (source: string) => Bun.spawn({
    cmd: [process.execPath, "-e", source],
    env: { ...process.env, LLV_STATE_DIR: process.env.LLV_STATE_DIR!, LLV_CLAUDE_HOME: process.env.LLV_CLAUDE_HOME! },
    stdout: "ignore",
    stderr: "pipe",
  });
  const create = (label: string) => run(`
    const m = await import(${JSON.stringify(modulePath)});
    const { withAccountMutationLockAsync } = await import(${JSON.stringify(mutationPath)});
    await withAccountMutationLockAsync(async () => m.createManagedClaudeAccount(${JSON.stringify(label)}));
  `);
  const [first, second] = [create("Child A"), create("Child B")];
  expect(await first.exited).toBe(0); expect(await second.exited).toBe(0);
  const ids = mod.listClaudeAccounts().map((item) => item.id);
  expect(ids).toEqual(expect.arrayContaining(["child-a", "child-b"]));
  const select = (id: string) => run(`
    const m = await import(${JSON.stringify(modulePath)});
    const { withAccountMutationLockAsync } = await import(${JSON.stringify(mutationPath)});
    await withAccountMutationLockAsync(async () => m.setActiveClaudeAccount(${JSON.stringify(id)}));
  `);
  const [left, right] = [select("child-a"), select("child-b")];
  expect(await left.exited).toBe(0); expect(await right.exited).toBe(0);
  expect(["child-a", "child-b"]).toContain(mod.activeClaudeAccountId());
});

test("a home whose projects symlinks into the shared store reports the canonical root", () => {
  const shared = mod.sharedClaudeProjectsRoot();
  fs.mkdirSync(shared, { recursive: true, mode: 0o700 });
  const home = process.env.LLV_CLAUDE_HOME!;
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.symlinkSync(shared, path.join(home, "projects"));
  try {
    const main = mod.listClaudeAccounts()[0]!;
    expect(main.projectsDir).toBe(shared);
    // Inside the shared store the path names no owner: ownership is the
    // registry's job (phase 0), so containment refuses to guess.
    const project = path.join(shared, "-repo");
    fs.mkdirSync(project, { recursive: true, mode: 0o700 });
    const transcript = path.join(project, "session.jsonl");
    fs.writeFileSync(transcript, "{}\n", { mode: 0o600 });
    expect(mod.claudeHomeOwningTranscript(transcript)).toBeNull();
  } finally {
    fs.rmSync(path.join(SANDBOX, "shared"), { recursive: true, force: true });
  }
});

test("a home with a real projects directory keeps its local root", () => {
  const home = process.env.LLV_CLAUDE_HOME!;
  const local = path.join(home, "projects");
  fs.mkdirSync(local, { recursive: true, mode: 0o700 });
  expect(mod.listClaudeAccounts()[0]!.projectsDir).toBe(local);
  const project = path.join(local, "-repo");
  fs.mkdirSync(project, { recursive: true, mode: 0o700 });
  const transcript = path.join(project, "session.jsonl");
  fs.writeFileSync(transcript, "{}\n", { mode: 0o600 });
  expect(mod.claudeHomeOwningTranscript(transcript)).toBe(home);
});

/* #1026 — a Claude-engine agent hands over the native `<home>/projects/...`
   path its own CLI writes, while every viewer record addresses the shared
   store. Translating is safe exactly when the mirrored file is really there. */
test("a native projects path maps to its shared-store mirror only when that file exists", () => {
  const shared = mod.sharedClaudeProjectsRoot();
  const home = process.env.LLV_CLAUDE_HOME!;
  const project = "-home-agent-repo";
  fs.mkdirSync(path.join(home, "projects", project), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(shared, project), { recursive: true, mode: 0o700 });
  const mirrored = path.join(shared, project, "session.jsonl");
  fs.writeFileSync(mirrored, "{}\n", { mode: 0o600 });

  expect(mod.mirroredClaudeTranscriptPath(path.join(home, "projects", project, "session.jsonl"))).toBe(mirrored);
  /* Nothing mirrored: a rejection the caller can act on beats a phantom path. */
  expect(mod.mirroredClaudeTranscriptPath(path.join(home, "projects", project, "stranger.jsonl"))).toBeNull();
  /* Already canonical, and paths outside every account's projects root. */
  expect(mod.mirroredClaudeTranscriptPath(mirrored)).toBeNull();
  expect(mod.mirroredClaudeTranscriptPath(path.join(home, "elsewhere", "session.jsonl"))).toBeNull();
  expect(mod.mirroredClaudeTranscriptPath("/codex/sessions/session.jsonl")).toBeNull();
});
