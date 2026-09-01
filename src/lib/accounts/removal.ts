import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import { accountHasLiveSessions, liveAccountConversationIds, type AccountLivenessOptions, type ManagedAccountEngine } from "@/lib/agent/accountLiveness";
import { agentRegistry } from "@/lib/agent/registry";

export type { ManagedAccountEngine };
export type AccountRemovalBlocker = "live_sessions" | "current_conversations";

export interface AccountHistoryArtifact {
  path: string;
  ownership: "owned" | "unowned";
}

export interface AccountHistoryInventoryReport {
  home: string;
  artifacts: AccountHistoryArtifact[];
  error?: { path: string; message: string };
}

export interface AccountSidecarCleanupReport {
  removed: string[];
  unresolved: string[];
}

export interface AccountOrphanCleanupReport {
  removed: string[];
  unresolved: string[];
  history?: Record<string, AccountHistoryInventoryReport>;
}

export class AccountHistoryInventoryBlockedError extends Error {
  constructor(readonly report: AccountHistoryInventoryReport) {
    super("account history inventory blocked removal");
    this.name = "AccountHistoryInventoryBlockedError";
  }
}

export function accountHomeExistsForRemoval(home: string): boolean {
  const resolvedHome = path.resolve(home);
  try { fs.lstatSync(resolvedHome); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new AccountHistoryInventoryBlockedError({
      home: resolvedHome,
      artifacts: [],
      error: { path: ".", message: errorMessage(error) },
    });
  }
}

const HISTORY_ROOTS: Record<ManagedAccountEngine, ReadonlySet<string>> = {
  claude: new Set(["projects", "history.jsonl", "file-history", "session-env", "shell-snapshots", "todos"]),
  codex: new Set(["sessions", "archived_sessions", "history.jsonl", "shell_snapshots"]),
};
const SAFE_ACCOUNT_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;

function registryHistoryPaths(engine: ManagedAccountEngine, accountId: string): Set<string> {
  const paths = new Set<string>();
  for (const conversation of Object.values(agentRegistry().readOnlySnapshot().conversations)) {
    if (conversation.engine !== engine) continue;
    const ownedGenerations = conversation.generations.filter((generation) => generation.accountId === accountId);
    for (const generation of ownedGenerations) paths.add(path.resolve(generation.path));
    if (ownedGenerations.length === 0) continue;
    for (const pathname of [
      ...conversation.continuityPaths,
      ...conversation.abandonedContinuityPaths,
      ...conversation.providerForkPaths,
      ...(conversation.migration?.pendingContinuityPaths ?? []),
      ...(conversation.migration?.providerReceipt?.continuityPaths ?? []),
      ...(conversation.migration?.providerReceipt ? [conversation.migration.providerReceipt.path] : []),
    ]) paths.add(path.resolve(pathname));
  }
  return paths;
}

function isHistoryPath(engine: ManagedAccountEngine, relative: string): boolean {
  const topLevel = relative.split(path.sep)[0]!;
  return HISTORY_ROOTS[engine].has(topLevel) || path.basename(relative).endsWith(".jsonl");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "filesystem inventory failed";
}

function decodeMountInfoPath(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_match, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
}

function mountedPaths(): ReadonlySet<string> {
  if (process.platform !== "linux") return new Set();
  const mounts = new Set<string>();
  for (const line of fs.readFileSync("/proc/self/mountinfo", "utf8").split("\n")) {
    if (!line) continue;
    const mountPoint = line.split(" ")[4];
    if (!mountPoint) throw new Error("filesystem mount inventory is malformed");
    mounts.add(path.resolve(decodeMountInfoPath(mountPoint)));
  }
  return mounts;
}

/**
 * Inventories history below an already-validated managed home without crossing
 * a symlink or filesystem boundary. Every discovered artifact needs exact
 * durable path ownership from a generation assigned to the account.
 */
export function accountHistoryInventory(
  engine: ManagedAccountEngine,
  accountId: string,
  home: string,
): AccountHistoryInventoryReport {
  const resolvedHome = path.resolve(home);
  const artifacts: AccountHistoryArtifact[] = [];
  let failingPath = ".";
  try {
    const homeStat = fs.lstatSync(resolvedHome);
    if (!homeStat.isDirectory() || homeStat.isSymbolicLink()) throw new Error("managed account home is not a safe directory");
    const expectedUid = process.getuid?.() ?? homeStat.uid;
    if (homeStat.uid !== expectedUid || (homeStat.mode & 0o022) !== 0) throw new Error("managed account home has unsafe ownership or permissions");
    const mounts = mountedPaths();
    if (mounts.has(resolvedHome)) throw new Error("managed account home is an external mount");
    const ownedPaths = registryHistoryPaths(engine, accountId);
    const visit = (directory: string, relativeDirectory: string, insideHistoryRoot: boolean): void => {
      failingPath = relativeDirectory || ".";
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const pathname = path.join(directory, entry.name);
        const relative = relativeDirectory ? path.join(relativeDirectory, entry.name) : entry.name;
        failingPath = relative;
        const isHistory = insideHistoryRoot || isHistoryPath(engine, relative);
        const stat = fs.lstatSync(pathname);
        if (mounts.has(path.resolve(pathname))) throw new Error(`history inventory reached an external mount at ${relative}`);
        if (stat.dev !== homeStat.dev) throw new Error(`history inventory crossed a filesystem boundary at ${relative}`);
        if (stat.uid !== expectedUid || !stat.isSymbolicLink() && (stat.mode & 0o022) !== 0) {
          throw new Error(`history inventory found unsafe ownership or permissions at ${relative}`);
        }
        if (stat.isSymbolicLink()) {
          if (isHistory) artifacts.push({ path: relative, ownership: "unowned" });
          continue;
        }
        if (stat.isDirectory()) {
          visit(pathname, relative, isHistory);
          continue;
        }
        if (isHistory) {
          artifacts.push({ path: relative, ownership: stat.isFile() && ownedPaths.has(path.resolve(pathname)) ? "owned" : "unowned" });
        }
      }
    };
    visit(resolvedHome, "", false);
  } catch (error) {
    throw new AccountHistoryInventoryBlockedError({
      home: resolvedHome,
      artifacts,
      error: { path: failingPath, message: errorMessage(error) },
    });
  }
  const report = { home: resolvedHome, artifacts: artifacts.sort((left, right) => left.path.localeCompare(right.path)) };
  if (report.artifacts.some((artifact) => artifact.ownership === "unowned")) {
    throw new AccountHistoryInventoryBlockedError(report);
  }
  return report;
}

function blockedInventory(report: AccountHistoryInventoryReport, path: string, message: string): AccountHistoryInventoryBlockedError {
  return new AccountHistoryInventoryBlockedError({ ...report, error: { path, message } });
}

function validatedHomeRemovalContext(home: string): { root: string; stat: fs.Stats; uid: number; mounts: ReadonlySet<string> } {
  const root = path.resolve(home);
  const stat = fs.lstatSync(root);
  const uid = process.getuid?.() ?? stat.uid;
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o022) !== 0) {
    throw new Error("managed account home is not a safe directory");
  }
  const mounts = mountedPaths();
  if (mounts.has(root)) throw new Error("managed account home is an external mount");
  return { root, stat, uid, mounts };
}

type TreeRemovalResult = { complete: boolean; changed: boolean };

function entryPassesRemovalChecks(
  context: ReturnType<typeof validatedHomeRemovalContext>,
  stat: fs.Stats,
  absolutePath: string,
): boolean {
  return !context.mounts.has(path.resolve(absolutePath))
    && stat.dev === context.stat.dev
    && stat.uid === context.uid
    && (stat.isSymbolicLink() || (stat.mode & 0o022) === 0);
}

/**
 * Linux deletion is anchored to opened directory identities. Every child path
 * is resolved through `/proc/self/fd`, so replacing a validated directory with
 * a symlink cannot redirect traversal. Other platforms leave directory trees
 * pending instead of attempting an unfenced path walk.
 */
function removeNonHistoryTree(
  engine: ManagedAccountEngine,
  accountId: string,
  home: string,
  context: ReturnType<typeof validatedHomeRemovalContext>,
  directory: string,
  relativeDirectory: string,
  expectedDirectory: fs.Stats,
  retainedTopLevel: string | null,
): TreeRemovalResult {
  if (process.platform !== "linux") return { complete: false, changed: false };
  let descriptor: number;
  try {
    descriptor = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  } catch (error) {
    const current = accountHistoryInventory(engine, accountId, home);
    throw blockedInventory(current, relativeDirectory || ".", errorMessage(error));
  }
  try {
    const opened = fs.fstatSync(descriptor);
    const absoluteDirectory = relativeDirectory ? path.join(context.root, relativeDirectory) : context.root;
    if (opened.dev !== expectedDirectory.dev || opened.ino !== expectedDirectory.ino
      || !entryPassesRemovalChecks(context, opened, absoluteDirectory)) {
      const current = accountHistoryInventory(engine, accountId, home);
      throw blockedInventory(current, relativeDirectory || ".", "account-home directory identity changed during removal");
    }
    const anchor = `/proc/self/fd/${descriptor}`;
    let complete = true;
    let changed = false;
    for (const entry of fs.readdirSync(anchor, { withFileTypes: true })) {
      if (!relativeDirectory && retainedTopLevel === entry.name) continue;
      const pathname = path.join(anchor, entry.name);
      const relative = relativeDirectory ? path.join(relativeDirectory, entry.name) : entry.name;
      let stat: fs.Stats;
      try { stat = fs.lstatSync(pathname); }
      catch (error) {
        const current = accountHistoryInventory(engine, accountId, home);
        throw blockedInventory(current, relative, errorMessage(error));
      }
      if (!entryPassesRemovalChecks(context, stat, path.join(context.root, relative))) {
        const current = accountHistoryInventory(engine, accountId, home);
        throw blockedInventory(current, relative, "account-home entry failed removal safety checks");
      }
      if (stat.isSymbolicLink()) {
        if (isHistoryPath(engine, relative)) throw new AccountHistoryInventoryBlockedError(accountHistoryInventory(engine, accountId, home));
        try { fs.rmSync(pathname, { force: true }); changed = true; }
        catch { complete = false; }
        continue;
      }
      if (stat.isDirectory()) {
        const child = removeNonHistoryTree(engine, accountId, home, context, pathname, relative, stat, retainedTopLevel);
        if (!child.complete) complete = false;
        if (child.changed) changed = true;
        try { fs.rmdirSync(pathname); changed = true; }
        catch (error) {
          const current = accountHistoryInventory(engine, accountId, home);
          if (current.artifacts.some((artifact) => artifact.path === relative || artifact.path.startsWith(`${relative}${path.sep}`))) {
            throw blockedInventory(current, relative, "history appeared during account-home removal");
          }
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") complete = false;
        }
        continue;
      }
      if (isHistoryPath(engine, relative)) throw new AccountHistoryInventoryBlockedError(accountHistoryInventory(engine, accountId, home));
      try { fs.rmSync(pathname, { force: true }); changed = true; }
      catch { complete = false; }
    }
    return { complete, changed };
  } finally {
    fs.closeSync(descriptor);
  }
}

/** Deletes a history-free home without a recursive filesystem operation. */
export function removeHistoryFreeAccountHome(engine: ManagedAccountEngine, accountId: string, home: string): boolean {
  const initial = accountHistoryInventory(engine, accountId, home);
  if (initial.artifacts.length > 0) throw new AccountHistoryInventoryBlockedError(initial);
  if (process.platform !== "linux") return false;
  let context: ReturnType<typeof validatedHomeRemovalContext>;
  try { context = validatedHomeRemovalContext(home); }
  catch (error) { throw blockedInventory(initial, ".", errorMessage(error)); }
  const removal = removeNonHistoryTree(engine, accountId, home, context, context.root, "", context.stat, null);
  try { fs.rmdirSync(context.root); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      const current = accountHistoryInventory(engine, accountId, home);
      if (current.artifacts.length > 0) throw blockedInventory(current, ".", "history appeared during account-home removal");
      return false;
    }
  }
  try { return removal.complete && !accountHomeExistsForRemoval(context.root); }
  catch { return false; }
}

/** Scrubs credentials and runtime state while leaving one retained history tree untouched. */
export function scrubAccountHomeToRetainedHistory(
  engine: ManagedAccountEngine,
  accountId: string,
  home: string,
  retainedName: string,
): TreeRemovalResult {
  const initial = accountHistoryInventory(engine, accountId, home);
  let context: ReturnType<typeof validatedHomeRemovalContext>;
  try { context = validatedHomeRemovalContext(home); }
  catch (error) { throw blockedInventory(initial, ".", errorMessage(error)); }
  const removal = removeNonHistoryTree(engine, accountId, home, context, context.root, "", context.stat, retainedName);
  const current = accountHistoryInventory(engine, accountId, home);
  const before = initial.artifacts.map((artifact) => `${artifact.path}:${artifact.ownership}`).sort();
  const after = current.artifacts.map((artifact) => `${artifact.path}:${artifact.ownership}`).sort();
  if (before.length !== after.length || before.some((value, index) => value !== after[index])) {
    throw blockedInventory(current, retainedName, "history changed during account-home cleanup");
  }
  return removal;
}

export interface StagedAccountHomeCleanup {
  home: string;
  stagingHome: string;
  moved: string[];
  descriptor: number;
  stagingDescriptor: number;
  history: AccountHistoryInventoryReport;
}

function sameHistoryInventory(left: AccountHistoryInventoryReport, right: AccountHistoryInventoryReport): boolean {
  const leftArtifacts = left.artifacts.map((artifact) => `${artifact.path}:${artifact.ownership}`).sort();
  const rightArtifacts = right.artifacts.map((artifact) => `${artifact.path}:${artifact.ownership}`).sort();
  return leftArtifacts.length === rightArtifacts.length
    && leftArtifacts.every((value, index) => value === rightArtifacts[index]);
}

export function rollbackStagedAccountHome(cleanup: StagedAccountHomeCleanup): void {
  try {
    const anchor = `/proc/self/fd/${cleanup.descriptor}`;
    const stagingAnchor = `/proc/self/fd/${cleanup.stagingDescriptor}`;
    for (const name of fs.readdirSync(stagingAnchor).reverse()) {
      const source = path.join(stagingAnchor, name);
      try { fs.lstatSync(source); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; else throw error; }
      let destination = path.join(anchor, name);
      try {
        fs.lstatSync(destination);
        destination = path.join(anchor, `.${name}.recovered-${crypto.randomUUID()}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      fs.renameSync(source, destination);
    }
    fs.rmdirSync(cleanup.stagingHome);
  } finally {
    fs.closeSync(cleanup.descriptor);
    fs.closeSync(cleanup.stagingDescriptor);
  }
}

export function releaseStagedAccountHome(cleanup: StagedAccountHomeCleanup): void {
  fs.closeSync(cleanup.descriptor);
  fs.closeSync(cleanup.stagingDescriptor);
}

export function verifyStagedAccountHome(engine: ManagedAccountEngine, accountId: string, cleanup: StagedAccountHomeCleanup): void {
  let pathname: fs.Stats;
  let opened: fs.Stats;
  try {
    pathname = fs.lstatSync(cleanup.home);
    opened = fs.fstatSync(cleanup.descriptor);
  } catch (error) {
    throw blockedInventory(cleanup.history, ".", errorMessage(error));
  }
  if (pathname.dev !== opened.dev || pathname.ino !== opened.ino) {
    throw blockedInventory(cleanup.history, ".", "account-home identity changed during account-registry commit");
  }
  try {
    pathname = fs.lstatSync(cleanup.stagingHome);
    opened = fs.fstatSync(cleanup.stagingDescriptor);
  } catch (error) {
    throw blockedInventory(cleanup.history, ".", errorMessage(error));
  }
  if (pathname.dev !== opened.dev || pathname.ino !== opened.ino) {
    throw blockedInventory(cleanup.history, ".", "staging-home identity changed during account-registry commit");
  }
  const current = accountHistoryInventory(engine, accountId, cleanup.home);
  if (!sameHistoryInventory(cleanup.history, current)) {
    throw blockedInventory(current, ".", "history changed during account-registry commit");
  }
  const staged = accountHistoryInventory(engine, accountId, cleanup.stagingHome);
  if (staged.artifacts.length > 0) {
    throw blockedInventory(staged, ".", "history appeared in staged account data during account-registry commit");
  }
}

/**
 * Reversibly stages every non-retained top-level entry before the durable
 * account-registry commit. A safety refusal or commit failure can restore the
 * exact entries without reconstructing credentials or provider state.
 */
export function stageAccountHomeCleanup(
  engine: ManagedAccountEngine,
  accountId: string,
  home: string,
  retainedName: string | null,
): StagedAccountHomeCleanup {
  const initial = accountHistoryInventory(engine, accountId, home);
  let context: ReturnType<typeof validatedHomeRemovalContext>;
  let stagingHome: string;
  try {
    context = validatedHomeRemovalContext(home);
    stagingHome = path.join(path.dirname(context.root), `.${path.basename(context.root)}.removal-${process.pid}-${crypto.randomUUID()}`);
    fs.mkdirSync(stagingHome, { mode: 0o700 });
  } catch (error) {
    throw blockedInventory(initial, ".", errorMessage(error));
  }
  let cleanup: StagedAccountHomeCleanup | null = null;
  let descriptor: number | null = null;
  let stagingDescriptor: number | null = null;
  let keepDescriptor = false;
  try {
    if (process.platform !== "linux") throw new Error("stable account-home staging is unavailable on this platform");
    descriptor = fs.openSync(context.root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    stagingDescriptor = fs.openSync(stagingHome, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    const opened = fs.fstatSync(descriptor);
    if (opened.dev !== context.stat.dev || opened.ino !== context.stat.ino || !entryPassesRemovalChecks(context, opened, context.root)) {
      throw new Error("account-home identity changed before staging");
    }
    const openedStaging = fs.fstatSync(stagingDescriptor);
    const stagingPathStat = fs.lstatSync(stagingHome);
    if (openedStaging.dev !== stagingPathStat.dev || openedStaging.ino !== stagingPathStat.ino) throw new Error("staging-home identity changed before staging");
    cleanup = { home: context.root, stagingHome, moved: [], descriptor, stagingDescriptor, history: initial };
    const anchor = `/proc/self/fd/${descriptor}`;
    const stagingAnchor = `/proc/self/fd/${stagingDescriptor}`;
    for (const entry of fs.readdirSync(anchor, { withFileTypes: true })) {
      if (retainedName === entry.name) continue;
      fs.renameSync(path.join(anchor, entry.name), path.join(stagingAnchor, entry.name));
      cleanup.moved.push(entry.name);
    }
    const current = accountHistoryInventory(engine, accountId, context.root);
    if (!sameHistoryInventory(initial, current)) throw blockedInventory(current, retainedName ?? ".", "history changed while account-home cleanup was staged");
    keepDescriptor = true;
    return cleanup;
  } catch (error) {
    try {
      if (cleanup) {
        try { rollbackStagedAccountHome(cleanup); }
        finally { descriptor = null; stagingDescriptor = null; }
      }
      else fs.rmdirSync(stagingHome);
    }
    catch (rollbackError) {
      throw new Error("account-home staging rollback failed", { cause: rollbackError });
    }
    if (error instanceof AccountHistoryInventoryBlockedError) throw error;
    throw blockedInventory(initial, ".", errorMessage(error));
  } finally {
    if (!keepDescriptor && descriptor !== null) fs.closeSync(descriptor);
    if (!keepDescriptor && stagingDescriptor !== null) fs.closeSync(stagingDescriptor);
  }
}

/** Discards staged non-history only after the durable account record commits. */
export function discardStagedAccountHome(engine: ManagedAccountEngine, accountId: string, cleanup: StagedAccountHomeCleanup): boolean {
  let pathname: fs.Stats;
  let opened: fs.Stats;
  try { pathname = fs.lstatSync(cleanup.stagingHome); opened = fs.fstatSync(cleanup.stagingDescriptor); }
  catch (error) { throw blockedInventory(cleanup.history, ".", errorMessage(error)); }
  if (pathname.dev !== opened.dev || pathname.ino !== opened.ino) {
    throw blockedInventory(cleanup.history, ".", "staging-home identity changed before discard");
  }
  return removeHistoryFreeAccountHome(engine, accountId, cleanup.stagingHome);
}

function sidecarTreeIsSafe(
  pathname: string,
  absolutePath: string,
  rootStat: fs.Stats,
  expectedUid: number,
  mounts: ReadonlySet<string>,
): boolean {
  const stat = fs.lstatSync(pathname);
  if (mounts.has(path.resolve(absolutePath)) || stat.isSymbolicLink() || stat.dev !== rootStat.dev || stat.uid !== expectedUid || (stat.mode & 0o022) !== 0) return false;
  if (!stat.isDirectory()) return stat.isFile();
  if (process.platform !== "linux") return false;
  let descriptor: number;
  try { descriptor = fs.openSync(pathname, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW); }
  catch { return false; }
  try {
    const opened = fs.fstatSync(descriptor);
    if (opened.dev !== stat.dev || opened.ino !== stat.ino) return false;
    const anchor = `/proc/self/fd/${descriptor}`;
    for (const entry of fs.readdirSync(anchor, { withFileTypes: true })) {
      if (!sidecarTreeIsSafe(path.join(anchor, entry.name), path.join(absolutePath, entry.name), rootStat, expectedUid, mounts)) return false;
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return true;
}

/** Removes exact provider-owned siblings while refusing links and filesystem escapes. */
export function cleanupAccountProviderSidecars(
  accountRoot: string,
  accountId: string,
  suffixes: readonly string[],
): AccountSidecarCleanupReport {
  const removed: string[] = [];
  const unresolved: string[] = [];
  if (!SAFE_ACCOUNT_ID.test(accountId)) return { removed, unresolved: suffixes.map((suffix) => `${accountId}${suffix}`) };
  const root = path.resolve(accountRoot);
  let rootStat: fs.Stats;
  try {
    rootStat = fs.lstatSync(root);
    const expectedUid = process.getuid?.() ?? rootStat.uid;
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || rootStat.uid !== expectedUid || (rootStat.mode & 0o022) !== 0) throw new Error("unsafe account root");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { removed, unresolved };
    return { removed, unresolved: suffixes.map((suffix) => `${accountId}${suffix}`) };
  }
  const expectedUid = process.getuid?.() ?? rootStat.uid;
  let mounts: ReadonlySet<string>;
  try { mounts = mountedPaths(); }
  catch { return { removed, unresolved: suffixes.map((suffix) => `${accountId}${suffix}`) }; }
  if (process.platform !== "linux") {
    for (const suffix of suffixes) {
      const name = `${accountId}${suffix}`;
      try { fs.lstatSync(path.join(root, name)); unresolved.push(name); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") unresolved.push(name); }
    }
    return { removed, unresolved: unresolved.sort() };
  }
  let rootDescriptor: number;
  try {
    rootDescriptor = fs.openSync(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    const opened = fs.fstatSync(rootDescriptor);
    if (opened.dev !== rootStat.dev || opened.ino !== rootStat.ino) throw new Error("account root identity changed");
  } catch {
    return { removed, unresolved: suffixes.map((suffix) => `${accountId}${suffix}`) };
  }
  try {
    const anchor = `/proc/self/fd/${rootDescriptor}`;
    for (const suffix of suffixes) {
      const name = `${accountId}${suffix}`;
      const candidate = path.join(anchor, name);
      const absoluteCandidate = path.join(root, name);
      try {
        fs.lstatSync(candidate);
        if (!sidecarTreeIsSafe(candidate, absoluteCandidate, rootStat, expectedUid, mounts)) { unresolved.push(name); continue; }
        fs.rmSync(candidate, { recursive: true, force: false });
        try { fs.lstatSync(candidate); unresolved.push(name); }
        catch (postError) {
          if ((postError as NodeJS.ErrnoException).code === "ENOENT") removed.push(name);
          else unresolved.push(name);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          try { fs.lstatSync(candidate); unresolved.push(name); }
          catch (postError) { if ((postError as NodeJS.ErrnoException).code !== "ENOENT") unresolved.push(name); }
          continue;
        }
        unresolved.push(name);
      }
    }
  } finally {
    fs.closeSync(rootDescriptor);
  }
  return { removed: removed.sort(), unresolved: unresolved.sort() };
}

/** Registry-liveness half of account-removal safety. Genuinely live ownership
 *  blocks here (issue #643): a registered host whose
 *  process answers a probe, an in-flight launch receipt, an unsettled
 *  migration, or an undelivered held delivery. Terminal, unhosted history and
 *  `starting` entries/receipts whose process is provably gone are registry rot
 *  and are ignored by this helper. The removal and orphan-cleanup modules also
 *  run {@link accountHistoryInventory}; its filesystem blockers have no force
 *  bypass and every owned transcript remains in a retained archive. */
export function accountRemovalBlockers(
  engine: ManagedAccountEngine,
  accountId: string,
  options: AccountLivenessOptions = {},
): AccountRemovalBlocker[] {
  const snapshot = agentRegistry().readOnlySnapshot();
  return [
    ...(accountHasLiveSessions(snapshot, engine, accountId, options) ? ["live_sessions" as const] : []),
    ...(liveAccountConversationIds(snapshot, engine, accountId, options).length > 0 ? ["current_conversations" as const] : []),
  ];
}
