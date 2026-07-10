import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { stateDir, statePath } from "@/lib/configDir";

const ACCOUNT_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const DEFAULT_ID = "default";
const VERSION = 1;
const CAPABILITY_DIRS = ["skills", "commands", "agents"] as const;
const CAPABILITY_FILES = ["settings.json"] as const;
const PRIVATE_NAMES = new Set([".credentials.json", ".claude.json", "projects", "history.jsonl", "session-env", "shell-snapshots", "file-history", "todos", "cache", "debug", "backups", "paste-cache", "plugins", "mcp.json", "settings.local.json"]);
const MAX_CAPABILITY_FILES = 2_000;
const MAX_CAPABILITY_BYTES = 16 * 1024 * 1024;
const REGISTRY_LOCK_WAIT_MS = 5_000;
const REGISTRY_LOCK_STALE_MS = 30_000;

export type ClaudeAccount = {
  id: string;
  label: string;
  kind: "legacy" | "managed";
  home: string;
  projectsDir: string;
  authPresent: boolean;
  createdAt: number;
};

type StoredAccount = { id: string; label: string; kind: "managed"; createdAt: number };
type Registry = { version: number; active: string; accounts: StoredAccount[] };
type Loaded = { registry: Registry; corrupt: boolean };
let cached: { key: string; loaded: Loaded } | null = null;

export class UnknownClaudeAccountError extends Error { constructor(id: string) { super(`unknown Claude account: ${id}`); this.name = "UnknownClaudeAccountError"; } }
export class InvalidClaudeAccountLabelError extends Error { constructor() { super("account label must contain visible text and be at most 80 characters"); this.name = "InvalidClaudeAccountLabelError"; } }
export class CorruptClaudeAccountsError extends Error { constructor() { super("Claude account registry is corrupt; repair or remove it before changing accounts"); this.name = "CorruptClaudeAccountsError"; } }
export class UnsafeClaudeHomeError extends Error { constructor() { super("managed Claude home failed safety checks"); this.name = "UnsafeClaudeHomeError"; } }

export function legacyClaudeHome(): string { return path.resolve(process.env.LLV_CLAUDE_HOME || path.join(os.homedir(), ".claude")); }
export function claudeAccountsRoot(): string { return path.join(path.dirname(stateDir()), "accounts", "claude"); }
export function claudeRegistryPath(): string { return statePath("claude-accounts.json"); }
export function claudeCapabilitiesRoot(): string { return path.join(path.dirname(stateDir()), "shared", "claude"); }
function managedHome(id: string): string { return path.join(claudeAccountsRoot(), id); }
function defaults(): Registry { return { version: VERSION, active: DEFAULT_ID, accounts: [] }; }
function key(file: string): string { try { const s = fs.statSync(file); return `${s.mtimeMs}:${s.size}`; } catch { return "missing"; } }
function safeMode(mode: number, required: number): boolean { return (mode & 0o077) === 0 && (mode & 0o777) === required; }

/** Never trust an on-disk registry path: ids derive the only valid managed home. */
export function managedClaudeHomeIsSafe(id: string, requireExisting = false): boolean {
  if (!ACCOUNT_ID.test(id) || id === DEFAULT_ID) return false;
  const root = path.resolve(claudeAccountsRoot());
  const home = path.resolve(managedHome(id));
  if (path.dirname(home) !== root) return false;
  try {
    const rootStat = fs.lstatSync(root);
    const homeStat = fs.lstatSync(home);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || !homeStat.isDirectory() || homeStat.isSymbolicLink() || !safeMode(homeStat.mode, 0o700)) return false;
    return path.dirname(fs.realpathSync(home)) === fs.realpathSync(root);
  } catch { return !requireExisting; }
}

function validStored(value: unknown): value is StoredAccount {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<StoredAccount>;
  return typeof item.id === "string" && typeof item.label === "string" && item.kind === "managed" && typeof item.createdAt === "number" && managedClaudeHomeIsSafe(item.id);
}

function normalize(value: unknown): Loaded {
  if (!value || typeof value !== "object") return { registry: defaults(), corrupt: true };
  const raw = value as Partial<Registry>;
  if (raw.version !== VERSION || typeof raw.active !== "string" || !Array.isArray(raw.accounts)) return { registry: defaults(), corrupt: true };
  const seen = new Set<string>();
  let corrupt = false;
  const accounts: StoredAccount[] = [];
  for (const item of raw.accounts) {
    if (!validStored(item) || seen.has(item.id)) { corrupt = true; continue; }
    seen.add(item.id); accounts.push(item);
  }
  return { registry: { version: VERSION, active: raw.active, accounts }, corrupt };
}

function readRegistry(): Loaded {
  const file = claudeRegistryPath(); const storeKey = `${file}:${key(file)}`;
  if (cached?.key === storeKey) return cached.loaded;
  let loaded: Loaded;
  try { loaded = fs.existsSync(file) ? normalize(JSON.parse(fs.readFileSync(file, "utf8"))) : { registry: defaults(), corrupt: false }; }
  catch { loaded = { registry: defaults(), corrupt: true }; }
  cached = { key: storeKey, loaded }; return loaded;
}
function mutable(): Registry { const loaded = readRegistry(); if (loaded.corrupt) throw new CorruptClaudeAccountsError(); return loaded.registry; }
function sleep(ms: number): void { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function registryLockPath(): string { return `${claudeRegistryPath()}.lock`; }
function withRegistryLock<T>(operation: () => T): T {
  const lock = registryLockPath(); const started = Date.now(); fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
  for (;;) {
    try {
      const fd = fs.openSync(lock, "wx", 0o600);
      try { fs.writeFileSync(fd, `${process.pid}\n`, "utf8"); return operation(); }
      finally { fs.closeSync(fd); fs.rmSync(lock, { force: true }); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > REGISTRY_LOCK_STALE_MS) { fs.rmSync(lock, { force: true }); continue; } } catch { continue; }
      if (Date.now() - started >= REGISTRY_LOCK_WAIT_MS) throw new Error("Claude account registry is busy; retry shortly");
      sleep(10);
    }
  }
}
function write(registry: Registry): void {
  const file = claudeRegistryPath(); fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tmp, JSON.stringify(registry, null, 2) + "\n", { mode: 0o600 });
    const fd = fs.openSync(tmp, "r"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
    const directory = fs.openSync(path.dirname(file), "r"); try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    cached = null;
  }
  finally { fs.rmSync(tmp, { force: true }); }
}

export function managedClaudeCredentialIsSafe(home: string, required = false): boolean {
  const file = path.join(home, ".credentials.json");
  try { const s = fs.lstatSync(file); return s.isFile() && !s.isSymbolicLink() && s.uid === (process.getuid?.() ?? s.uid) && (s.mode & 0o077) === 0; } catch { return !required; }
}
function credentialIsSafe(home: string): boolean { return managedClaudeCredentialIsSafe(home, true); }
function account(stored: StoredAccount): ClaudeAccount { const home = managedHome(stored.id); return { ...stored, home, projectsDir: path.join(home, "projects"), authPresent: credentialIsSafe(home) }; }
function main(): ClaudeAccount { const home = legacyClaudeHome(); return { id: DEFAULT_ID, label: "Main", kind: "legacy", home, projectsDir: path.join(home, "projects"), authPresent: credentialIsSafe(home), createdAt: 0 }; }
export function listClaudeAccounts(): ClaudeAccount[] { return [main(), ...readRegistry().registry.accounts.map(account)]; }
export function activeClaudeAccountId(): string { const active = readRegistry().registry.active; return listClaudeAccounts().some((item) => item.id === active) ? active : DEFAULT_ID; }
export function claudeAccountsMutationLocked(): boolean { return readRegistry().corrupt; }
export function claudeAccountForSpawn(requested?: string | null): Pick<ClaudeAccount, "id" | "kind" | "home" | "projectsDir"> { const found = listClaudeAccounts().find((item) => item.id === (requested ?? activeClaudeAccountId())); if (!found) throw new UnknownClaudeAccountError(requested ?? ""); if (found.kind === "managed" && (!managedClaudeHomeIsSafe(found.id, true) || !managedClaudeCredentialIsSafe(found.home))) throw new UnsafeClaudeHomeError(); return { id: found.id, kind: found.kind, home: found.home, projectsDir: found.projectsDir }; }
export function setActiveClaudeAccount(id: string): void { withRegistryLock(() => { cached = null; const registry = mutable(); if (!listClaudeAccounts().some((item) => item.id === id)) throw new UnknownClaudeAccountError(id); write({ ...registry, active: id }); }); }
export function claudeProjectRoots(): string[] { return [...new Set(listClaudeAccounts().map((item) => item.projectsDir))]; }

export function claudeHomeOwningTranscript(pathname: string): string | null {
  let real: string; try { real = fs.realpathSync(pathname); } catch { return null; }
  for (const item of listClaudeAccounts()) {
    try { const root = fs.realpathSync(item.projectsDir); if (real.startsWith(root + path.sep)) return item.home; } catch { /* missing home */ }
  }
  return null;
}

function nextId(label: string, used: Set<string>): string {
  const base = label.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "account";
  for (let n = 0; ; n += 1) { const suffix = n ? `-${n}` : ""; const candidate = `${base.slice(0, 32 - suffix.length)}${suffix}`; if (ACCOUNT_ID.test(candidate) && candidate !== DEFAULT_ID && !used.has(candidate) && !fs.existsSync(managedHome(candidate))) return candidate; }
}

function copyCapability(source: string, destination: string, budget: { files: number; bytes: number }): void {
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) return;
  if (stat.isFile()) { if (++budget.files > MAX_CAPABILITY_FILES || (budget.bytes += stat.size) > MAX_CAPABILITY_BYTES) throw new Error("Claude capability snapshot exceeds safety limit"); fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 }); fs.copyFileSync(source, destination); fs.chmodSync(destination, 0o600); return; }
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) { if (PRIVATE_NAMES.has(entry.name)) continue; copyCapability(path.join(source, entry.name), path.join(destination, entry.name), budget); }
}

/** A viewer-owned, read-only capability snapshot avoids a managed home linking into legacy auth/runtime state. */
export function syncClaudeCapabilitySnapshot(): string {
  const root = claudeCapabilitiesRoot(); const tmp = `${root}.tmp-${process.pid}-${Date.now()}`; const budget = { files: 0, bytes: 0 };
  fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp, { recursive: true, mode: 0o700 });
  try {
    for (const name of [...CAPABILITY_DIRS, ...CAPABILITY_FILES]) { const source = path.join(legacyClaudeHome(), name); if (fs.existsSync(source)) copyCapability(source, path.join(tmp, name), budget); }
    fs.mkdirSync(path.dirname(root), { recursive: true, mode: 0o700 }); fs.chmodSync(path.dirname(root), 0o700); fs.rmSync(root, { recursive: true, force: true }); fs.renameSync(tmp, root); fs.chmodSync(root, 0o700); return root;
  } catch (error) { fs.rmSync(tmp, { recursive: true, force: true }); throw error; }
}

export function claudeSettingsPath(): string | null { const file = path.join(claudeCapabilitiesRoot(), "settings.json"); return fs.existsSync(file) ? file : null; }

export function createManagedClaudeAccount(label: string): ClaudeAccount {
  const clean = label.trim(); if (!clean || clean.length > 80 || /[\u0000-\u001f\u007f]/.test(clean)) throw new InvalidClaudeAccountLabelError();
  return withRegistryLock(() => {
    cached = null; const registry = mutable(); const id = nextId(clean, new Set(listClaudeAccounts().map((item) => item.id))); const home = managedHome(id); let made = false;
    try {
      fs.mkdirSync(path.dirname(home), { recursive: true, mode: 0o700 }); fs.chmodSync(path.dirname(home), 0o700); fs.mkdirSync(home, { mode: 0o700 }); fs.chmodSync(home, 0o700); made = true;
      const shared = syncClaudeCapabilitySnapshot();
      for (const name of CAPABILITY_DIRS) { const source = path.join(shared, name); if (fs.existsSync(source)) fs.symlinkSync(source, path.join(home, name)); }
      fs.mkdirSync(path.join(home, "projects"), { mode: 0o700 });
      const stored: StoredAccount = { id, label: clean, kind: "managed", createdAt: Date.now() }; write({ ...registry, accounts: [...registry.accounts, stored] }); return account(stored);
    } catch (error) { if (made) fs.rmSync(home, { recursive: true, force: true }); throw error; }
  });
}

export function removeManagedClaudeAccount(id: string): void {
  withRegistryLock(() => {
    cached = null; const registry = mutable(); const existing = registry.accounts.find((item) => item.id === id); if (!existing) throw new UnknownClaudeAccountError(id);
    const home = managedHome(id);
    const exists = fs.existsSync(home);
    if (exists && !managedClaudeHomeIsSafe(id, true)) throw new UnsafeClaudeHomeError();
    if (exists) fs.rmSync(home, { recursive: true, force: true });
    write({ ...registry, active: registry.active === id ? DEFAULT_ID : registry.active, accounts: registry.accounts.filter((item) => item.id !== id) });
  });
}

/** Removes failed-login homes that have no registry owner. Only safe direct children qualify. */
export function cleanupOrphanedClaudeHomes(): string[] {
  return withRegistryLock(() => {
    cached = null;
    const registry = mutable();
    const registered = new Set(registry.accounts.map((account) => account.id));
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(claudeAccountsRoot(), { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    const removed: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || registered.has(entry.name) || !managedClaudeHomeIsSafe(entry.name, true)) continue;
      fs.rmSync(managedHome(entry.name), { recursive: true, force: true });
      removed.push(entry.name);
    }
    return removed.sort();
  });
}

const SHADOWED_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_BASE_URL", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "GOOGLE_APPLICATION_CREDENTIALS", "VERTEXAI_PROJECT", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX"];
export function claudeManagedEnvironment(home: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv { const env: NodeJS.ProcessEnv = { ...base, CLAUDE_CONFIG_DIR: home }; for (const key of SHADOWED_ENV) delete env[key]; return env; }
export function isManagedClaudeHome(home: string): boolean { return listClaudeAccounts().some((item) => item.kind === "managed" && item.home === home && managedClaudeHomeIsSafe(item.id, true)); }
