import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { stateDir, statePath } from "@/lib/configDir";
import { withoutWakatimeCredential } from "@/lib/wakatime/credential";
import { withAccountMutationLock } from "./accountMutation";
import { AccountHistoryInventoryBlockedError, accountHistoryInventory, accountHomeExistsForRemoval, accountRemovalBlockers, cleanupAccountProviderSidecars, discardStagedAccountHome, releaseStagedAccountHome, removeHistoryFreeAccountHome, rollbackStagedAccountHome, scrubAccountHomeToRetainedHistory, stageAccountHomeCleanup, verifyStagedAccountHome, type AccountHistoryInventoryReport, type AccountOrphanCleanupReport, type StagedAccountHomeCleanup } from "./removal";

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
/** A removed account whose transcript tree was retained (issue #643). */
type RetiredAccount = { id: string; label: string; retiredAt: number };
type Registry = { version: number; active: string; accounts: StoredAccount[]; retired: RetiredAccount[] };
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

/* Shared transcript store (issue #891, phase 1). Transcripts are viewer data,
   not credentials — the per-account layout was a side effect of per-account
   CLI config homes, never an isolation requirement. When an account home's
   `projects` is a symlink into this root, the account reports the canonical
   shared path: every consumer (scanner, spawn specs, migration provider)
   then addresses one store while the CLI keeps writing through its own
   $CLAUDE_CONFIG_DIR/projects. Homes not yet cut over keep their local dir,
   so the store can be adopted per account. */
export function sharedClaudeProjectsRoot(): string { return path.join(claudeCapabilitiesRoot(), "projects"); }

function projectsDirFor(home: string): string {
  const local = path.join(home, "projects");
  try {
    if (!fs.lstatSync(local).isSymbolicLink()) return local;
    const shared = sharedClaudeProjectsRoot();
    if (fs.realpathSync(local) === fs.realpathSync(shared)) return shared;
  } catch { /* unresolved link or missing dir: treat as not cut over */ }
  return local;
}
function managedHome(id: string): string { return path.join(claudeAccountsRoot(), id); }
function defaults(): Registry { return { version: VERSION, active: DEFAULT_ID, accounts: [], retired: [] }; }
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

function validRetired(value: unknown): value is RetiredAccount {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<RetiredAccount>;
  return typeof item.id === "string" && typeof item.label === "string" && typeof item.retiredAt === "number" && managedClaudeHomeIsSafe(item.id);
}

function normalize(value: unknown): Loaded {
  if (!value || typeof value !== "object") return { registry: defaults(), corrupt: true };
  const raw = value as Partial<Registry>;
  if (raw.version !== VERSION || typeof raw.active !== "string" || !Array.isArray(raw.accounts)) return { registry: defaults(), corrupt: true };
  /* `retired` post-dates version 1; a registry written before it is complete, not corrupt. */
  if (raw.retired !== undefined && !Array.isArray(raw.retired)) return { registry: defaults(), corrupt: true };
  const seen = new Set<string>();
  let corrupt = false;
  const accounts: StoredAccount[] = [];
  for (const item of raw.accounts) {
    if (!validStored(item) || seen.has(item.id)) { corrupt = true; continue; }
    seen.add(item.id); accounts.push(item);
  }
  const retired: RetiredAccount[] = [];
  for (const item of raw.retired ?? []) {
    if (!validRetired(item) || seen.has(item.id)) { corrupt = true; continue; }
    seen.add(item.id); retired.push(item);
  }
  return { registry: { version: VERSION, active: raw.active, accounts, retired }, corrupt };
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
  return withAccountMutationLock(() => {
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
  });
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
function account(stored: StoredAccount): ClaudeAccount { const home = managedHome(stored.id); return { ...stored, home, projectsDir: projectsDirFor(home), authPresent: credentialIsSafe(home) }; }
function main(): ClaudeAccount { const home = legacyClaudeHome(); return { id: DEFAULT_ID, label: "Main", kind: "legacy", home, projectsDir: projectsDirFor(home), authPresent: credentialIsSafe(home), createdAt: 0 }; }
export function listClaudeAccounts(): ClaudeAccount[] { return [main(), ...readRegistry().registry.accounts.map(account)]; }
export function activeClaudeAccountId(): string { const active = readRegistry().registry.active; return listClaudeAccounts().some((item) => item.id === active) ? active : DEFAULT_ID; }
export function claudeAccountsMutationLocked(): boolean { return readRegistry().corrupt; }
export function claudeAccountForSpawn(requested?: string | null): Pick<ClaudeAccount, "id" | "kind" | "home" | "projectsDir"> { const found = listClaudeAccounts().find((item) => item.id === (requested ?? activeClaudeAccountId())); if (!found) throw new UnknownClaudeAccountError(requested ?? ""); if (found.kind === "managed" && (!managedClaudeHomeIsSafe(found.id, true) || !managedClaudeCredentialIsSafe(found.home))) throw new UnsafeClaudeHomeError(); return { id: found.id, kind: found.kind, home: found.home, projectsDir: found.projectsDir }; }
export function setActiveClaudeAccount(id: string): void { withRegistryLock(() => { cached = null; const registry = mutable(); if (!listClaudeAccounts().some((item) => item.id === id)) throw new UnknownClaudeAccountError(id); write({ ...registry, active: id }); }); }
/** Transcript trees kept by removed accounts (issue #643). Their homes hold nothing else. */
export function retiredClaudeProjectRoots(): string[] { return readRegistry().registry.retired.map((item) => projectsDirFor(managedHome(item.id))); }
/** Every Claude transcript root the scanner reads: live accounts first, then retained archives. */
export function claudeProjectRoots(): string[] { return [...new Set([...listClaudeAccounts().map((item) => item.projectsDir), ...retiredClaudeProjectRoots()])]; }

/** Why a transcript names no owning Claude account, or which one it names. */
export type ClaudeTranscriptOwnership =
  | { kind: "owned"; accountId: string; home: string; source: "recorded" | "path" | "shared-store" }
  /** The path does not resolve — deleted, or a broken link. */
  | { kind: "unreadable" }
  /** It resolves outside every Claude transcript root the viewer knows. */
  | { kind: "foreign" };

/**
 * Which account owns a Claude transcript (issue #935).
 *
 * The shared transcript store (#891) removed the path-layout answer for every
 * transcript on a cut-over machine: each account's `projects` resolves to the
 * same root, so containment names no single owner and
 * {@link claudeHomeOwningTranscript} refuses rather than return whichever
 * account happens to list first. Refusing there left resume with no home at
 * all, and every Claude conversation on such a machine became unresumable.
 *
 * Ownership is resolved in this order:
 *  1. containment in a home that is NOT cut over to the shared store. There the
 *     layout is unambiguous AND load-bearing — `claude --resume <id>` reads the
 *     session out of that home's own projects dir, so the bytes decide;
 *  2. the account the registry recorded for this conversation. This is what
 *     answers inside the shared store, where every account reads the same
 *     transcripts and only the credentials differ;
 *  3. still inside the shared store with nothing recorded: the account new
 *     spawns route to, which is the same choice a fresh spawn would make.
 */
export function claudeTranscriptOwnership(pathname: string, recordedAccountId?: string | null): ClaudeTranscriptOwnership {
  let real: string; try { real = fs.realpathSync(pathname); } catch { return { kind: "unreadable" }; }
  const accounts = listClaudeAccounts();
  let shared: string | null = null;
  try { shared = fs.realpathSync(sharedClaudeProjectsRoot()); } catch { /* store not provisioned */ }
  for (const item of accounts) {
    try {
      const root = fs.realpathSync(item.projectsDir);
      /* A cut-over home shares its root with every other cut-over home, so
         containment there is evidence of nothing. Skip it and let recorded
         provenance answer below. */
      if (shared !== null && root === shared) continue;
      if (real.startsWith(root + path.sep)) return { kind: "owned", accountId: item.id, home: item.home, source: "path" };
    } catch { /* missing home */ }
  }
  const recorded = recordedAccountId ? accounts.find((item) => item.id === recordedAccountId) : undefined;
  if (recorded) return { kind: "owned", accountId: recorded.id, home: recorded.home, source: "recorded" };
  if (shared !== null && real.startsWith(shared + path.sep)) {
    const activeId = activeClaudeAccountId();
    const active = accounts.find((item) => item.id === activeId) ?? accounts[0];
    if (active) return { kind: "owned", accountId: active.id, home: active.home, source: "shared-store" };
  }
  return { kind: "foreign" };
}

/** Path-layout ownership only: the home whose transcript root physically
    contains this path. Null inside the shared store, where the layout names no
    owner — {@link claudeTranscriptOwnership} resolves that case. */
export function claudeHomeOwningTranscript(pathname: string): string | null {
  const ownership = claudeTranscriptOwnership(pathname);
  return ownership.kind === "owned" && ownership.source === "path" ? ownership.home : null;
}

/**
 * The shared-store equivalent of a transcript addressed through an account's
 * own `<home>/projects` (#1026). A Claude-engine agent knows its native
 * `~/.claude/projects/...` path — that is what the CLI writes and what its own
 * environment reports — while every viewer record addresses the one shared
 * store the home's `projects` symlink points into. The two name the same file,
 * so a caller that hands over the native path is answering correctly and only
 * needs the address translated.
 *
 * Returns the mirrored path only when that file actually exists: a home that is
 * not cut over to the shared store keeps its own transcripts, and inventing a
 * path there would trade a clear rejection for a phantom identity. Null when
 * the path is not under any account's native projects root, when it already is
 * the shared path, or when no mirrored file exists.
 */
export function mirroredClaudeTranscriptPath(pathname: string): string | null {
  const shared = sharedClaudeProjectsRoot();
  const resolved = path.resolve(pathname);
  if (resolved === shared || resolved.startsWith(shared + path.sep)) return null;
  for (const home of listClaudeAccounts().map((account) => account.home)) {
    const nativeRoot = path.join(home, "projects");
    if (!resolved.startsWith(nativeRoot + path.sep)) continue;
    const mirrored = path.join(shared, path.relative(nativeRoot, resolved));
    try {
      if (fs.statSync(mirrored).isFile()) return mirrored;
    } catch { /* nothing mirrored under the shared store */ }
    return null;
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
    cached = null; const registry = mutable(); const id = nextId(clean, new Set([...listClaudeAccounts().map((item) => item.id), ...registry.retired.map((item) => item.id)])); const home = managedHome(id); let made = false;
    try {
      fs.mkdirSync(path.dirname(home), { recursive: true, mode: 0o700 }); fs.chmodSync(path.dirname(home), 0o700); fs.mkdirSync(home, { mode: 0o700 }); fs.chmodSync(home, 0o700); made = true;
      const shared = syncClaudeCapabilitySnapshot();
      for (const name of CAPABILITY_DIRS) { const source = path.join(shared, name); if (fs.existsSync(source)) fs.symlinkSync(source, path.join(home, name)); }
      fs.mkdirSync(path.join(home, "projects"), { mode: 0o700 });
      const stored: StoredAccount = { id, label: clean, kind: "managed", createdAt: Date.now() }; write({ ...registry, accounts: [...registry.accounts, stored] }); return account(stored);
    } catch (error) {
      if (made) {
        try {
          if (!removeHistoryFreeAccountHome("claude", id, home)) console.warn("[claude accounts] failed-account home cleanup is incomplete");
        } catch (cleanupError) {
          console.warn("[claude accounts] preserving failed-account home after history cleanup refusal");
          if (cleanupError instanceof AccountHistoryInventoryBlockedError) throw cleanupError;
        }
      }
      throw error;
    }
  });
}

function historyFitsRetainedProjects(report: AccountHistoryInventoryReport): boolean {
  return report.artifacts.filter((artifact) => artifact.history).every((artifact) => artifact.path.startsWith(`projects${path.sep}`));
}

const CLAUDE_SIDECAR_SUFFIXES = [".lock"] as const;

function cleanupClaudeSidecars(id: string): boolean {
  return cleanupAccountProviderSidecars(claudeAccountsRoot(), id, CLAUDE_SIDECAR_SUFFIXES).unresolved.length > 0;
}

/**
 * Removes a managed account while preserving its history (issue #643).
 *
 * Transcript preservation mechanism: **retain in place**. The home keeps only
 * its `projects` tree and is recorded as a retired archive in the accounts
 * registry; every credential, runtime file, and capability link is deleted, so
 * the account can no longer authenticate, spawn, or be selected. Because the
 * transcripts never move, every absolute path stays valid — Viewer conversation
 * ids, continuity paths, registry entries, board grouping (which is derived
 * from the transcript's cwd) and `/api/log` path admission all keep working
 * untouched, with no registry rewrite and no window where a conversation points
 * at a path that no longer exists. `claudeProjectRoots()` keeps returning the
 * retired tree, so the scanner reads it exactly as before.
 */
export function removeManagedClaudeAccount(id: string): { cleanupPending: boolean } {
  return withRegistryLock(() => {
    cached = null; const registry = mutable(); const existing = registry.accounts.find((item) => item.id === id); if (!existing) throw new UnknownClaudeAccountError(id);
    const home = managedHome(id);
    const exists = accountHomeExistsForRemoval(home);
    if (exists && !managedClaudeHomeIsSafe(id, true)) throw new UnsafeClaudeHomeError();
    const history = exists ? accountHistoryInventory("claude", id, home) : null;
    if (history && !historyFitsRetainedProjects(history)) {
      throw new AccountHistoryInventoryBlockedError({ ...history, error: { path: ".", message: "history falls outside the retained projects archive" } });
    }
    const retain = history?.artifacts.some((artifact) => artifact.history) ?? false;
    const staged: StagedAccountHomeCleanup | null = exists
      ? stageAccountHomeCleanup("claude", id, home, retain ? "projects" : null)
      : null;
    const retired = registry.retired.filter((item) => item.id !== id);
    try {
      write({
        ...registry,
        active: registry.active === id ? DEFAULT_ID : registry.active,
        accounts: registry.accounts.filter((item) => item.id !== id),
        retired: [...retired, { id, label: existing.label, retiredAt: Date.now() }],
      });
    } catch (error) {
      if (staged) rollbackStagedAccountHome(staged);
      throw error;
    }
    let cleanupPending = false;
    if (staged) {
      try { verifyStagedAccountHome("claude", id, staged); }
      catch (error) {
        try { write(registry); }
        finally { rollbackStagedAccountHome(staged); }
        throw error;
      }
      let discarded = false;
      try { discarded = discardStagedAccountHome("claude", id, staged); }
      catch (error) {
        if (error instanceof AccountHistoryInventoryBlockedError) {
          try { write(registry); }
          finally { rollbackStagedAccountHome(staged); }
          throw error;
        }
        /* The staged tree remains recoverable. */
      }
      if (discarded) {
        releaseStagedAccountHome(staged);
        if (!retain) {
          try { fs.rmdirSync(home); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") cleanupPending = true; }
        }
      } else {
        cleanupPending = true;
        try {
          rollbackStagedAccountHome(staged);
        } catch { console.warn("[claude accounts] staged home cleanup requires manual recovery"); }
      }
    }
    if (!retain) {
      try { if (accountHomeExistsForRemoval(home)) cleanupPending = true; }
      catch { cleanupPending = true; }
    }
    return { cleanupPending: cleanupClaudeSidecars(id) || cleanupPending };
  });
}

/** Removes failed-login homes that have no registry owner. Only safe direct
 *  children qualify. Retired archives are never deleted — their transcripts are
 *  the point — but a strip left incomplete by an earlier removal is retried. */
export function cleanupOrphanedClaudeHomes(): AccountOrphanCleanupReport {
  return withRegistryLock(() => {
    cached = null;
    const registry = mutable();
    const registered = new Set(registry.accounts.map((account) => account.id));
    const retired = new Set(registry.retired.map((account) => account.id));
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(claudeAccountsRoot(), { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { removed: [], unresolved: [] }; throw error; }
    const removed: string[] = [];
    const unresolved: string[] = [];
    const historyReports: Record<string, AccountHistoryInventoryReport> = {};
    const cleanupSidecar = (accountId: string): void => {
      const sidecars = cleanupAccountProviderSidecars(claudeAccountsRoot(), accountId, CLAUDE_SIDECAR_SUFFIXES);
      for (const name of sidecars.removed) if (!removed.includes(name) && !unresolved.includes(name)) removed.push(name);
      for (const name of sidecars.unresolved) {
        const removedIndex = removed.indexOf(name);
        if (removedIndex >= 0) removed.splice(removedIndex, 1);
        if (!unresolved.includes(name)) unresolved.push(name);
      }
    };
    for (const entry of entries) {
      if (entry.name.endsWith(".lock")) {
        const accountId = entry.name.slice(0, -".lock".length);
        if (!ACCOUNT_ID.test(accountId) || accountId === DEFAULT_ID) { unresolved.push(entry.name); continue; }
        if (registered.has(accountId)) continue;
        if (accountRemovalBlockers("claude", accountId).length > 0) { unresolved.push(entry.name); continue; }
        cleanupSidecar(accountId);
        continue;
      }
      if (registered.has(entry.name)) continue;
      if (accountRemovalBlockers("claude", entry.name).length > 0) { unresolved.push(entry.name); continue; }
      if (!entry.isDirectory() || !managedClaudeHomeIsSafe(entry.name, true)) { unresolved.push(entry.name); continue; }
      let history: AccountHistoryInventoryReport;
      try { history = accountHistoryInventory("claude", entry.name, managedHome(entry.name)); }
      catch (error) {
        if (error instanceof AccountHistoryInventoryBlockedError) historyReports[entry.name] = error.report;
        unresolved.push(entry.name); continue;
      }
      if (retired.has(entry.name)) {
        if (!history.artifacts.some((artifact) => artifact.history)) {
          try {
            if (removeHistoryFreeAccountHome("claude", entry.name, managedHome(entry.name))) removed.push(entry.name);
            else unresolved.push(entry.name);
          } catch (error) {
            if (error instanceof AccountHistoryInventoryBlockedError) historyReports[entry.name] = error.report;
            unresolved.push(entry.name);
          }
          continue;
        }
        if (!historyFitsRetainedProjects(history)) { historyReports[entry.name] = history; unresolved.push(entry.name); continue; }
        try {
          const scrub = scrubAccountHomeToRetainedHistory("claude", entry.name, managedHome(entry.name), "projects");
          if (!scrub.complete) unresolved.push(entry.name);
          else if (scrub.changed) removed.push(entry.name);
        } catch (error) {
          if (error instanceof AccountHistoryInventoryBlockedError) historyReports[entry.name] = error.report;
          unresolved.push(entry.name);
        }
        continue;
      }
      if (history.artifacts.some((artifact) => artifact.history)) { historyReports[entry.name] = history; unresolved.push(entry.name); continue; }
      try {
        if (removeHistoryFreeAccountHome("claude", entry.name, managedHome(entry.name))) removed.push(entry.name);
        else unresolved.push(entry.name);
      }
      catch (error) {
        if (error instanceof AccountHistoryInventoryBlockedError) historyReports[entry.name] = error.report;
        unresolved.push(entry.name);
      }
    }
    for (const entry of fs.readdirSync(claudeAccountsRoot(), { withFileTypes: true })) {
      if (!entry.name.endsWith(".lock")) continue;
      const accountId = entry.name.slice(0, -".lock".length);
      if (!ACCOUNT_ID.test(accountId) || accountId === DEFAULT_ID) {
        if (!unresolved.includes(entry.name)) unresolved.push(entry.name);
        continue;
      }
      if (!registered.has(accountId) && accountRemovalBlockers("claude", accountId).length === 0) cleanupSidecar(accountId);
      else if (!registered.has(accountId) && !unresolved.includes(entry.name)) unresolved.push(entry.name);
    }
    return {
      removed: removed.sort(),
      unresolved: unresolved.sort(),
      ...(Object.keys(historyReports).length > 0 ? { history: historyReports } : {}),
    };
  });
}

const SHADOWED_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_BASE_URL", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "GOOGLE_APPLICATION_CREDENTIALS", "VERTEXAI_PROJECT", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX"];
export function claudeManagedEnvironment(home: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv { const env: NodeJS.ProcessEnv = { ...withoutWakatimeCredential(base), CLAUDE_CONFIG_DIR: home }; for (const key of SHADOWED_ENV) delete env[key]; return env; }
export function isManagedClaudeHome(home: string): boolean { return listClaudeAccounts().some((item) => item.kind === "managed" && item.home === home && managedClaudeHomeIsSafe(item.id, true)); }
