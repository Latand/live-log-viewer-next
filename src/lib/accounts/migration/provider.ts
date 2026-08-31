import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { accountManager } from "@/lib/accounts/manager";
import type { AccountContext, AccountManager } from "@/lib/accounts/contracts";
import { CodexAppServerClient, CodexAppServerError } from "@/lib/accounts/codexAppServer";
import { sharedClaudeProjectsRoot } from "@/lib/accounts/claude";
import { realClaudeLoginPorts } from "@/lib/accounts/claudeLogin";
import { claudeSuccessorSpecFor } from "@/lib/agent/cli";
import { agentRegistry, type AgentRegistry, type SpawnReceipt, type TmuxHostEvidence } from "@/lib/agent/registry";
import { sessionKey, sessionKeyId } from "@/lib/agent/sessionKey";
import { statePath } from "@/lib/configDir";
import { procBackend } from "@/lib/proc";
import { ClaudeStreamBrokerHost } from "@/lib/runtime/claudeStreamBrokerHost";
import { CodexAppServerHost } from "@/lib/runtime/codexAppServerHost";
import { StructuredHostAdoptionCleanupError } from "@/lib/runtime/engineHost";
import { hasStructuredDeliveryHost, publishStructuredDeliveryHost, releaseStructuredDeliveryHost, requireStructuredDeliveryControllerPublication } from "@/lib/runtime/structuredDeliveryController";
import { bindClaudeHostPersistence, bindCodexHostPersistence, structuredHostsEnabled } from "@/lib/runtime/registry";
import { materializeStructuredHostAccess, structuredHostAccessPolicy } from "@/lib/runtime/structuredSpawn";
import { cleanupTmuxHostIfMatches, forgetResumePaneIfMatches, spawnAgentWithPrompt, verifyTmuxHostEvidence, type TmuxHostCleanupResult } from "@/lib/tmux";

import { launchProfileCodexSandbox, launchProfileEngineReadOnly, type LaunchProfile, type ProviderReceipt, type SuccessorProviderPort } from "./contracts";
import { hashValidatedHistory, HistorySecurityError, MigrationTargetUnavailableError, safeCopyHistory, validateHistorySource } from "./safeHistoryCopy";

interface StructuredHostPublicationInput {
  receipt: ProviderReceipt;
  target: AccountContext;
  profile: LaunchProfile;
  registry: AgentRegistry;
  ownsOperation?: () => Promise<boolean>;
}

export interface ProviderDependencies {
  accounts: Pick<AccountManager, "resolveSpawn" | "resolveTranscriptOwner">;
  startCodex(home: string): Promise<CodexAppServerClient>;
  claudeStatus(home: string): Promise<{ loggedIn: boolean }>;
  spawnClaude(spec: ReturnType<typeof claudeSuccessorSpecFor>, receipt: SpawnReceipt): Promise<{ paneId: string; panePid?: number; host?: TmuxHostEvidence }>;
  verifyClaudeHost?(host: TmuxHostEvidence): Promise<boolean>;
  cancelClaude?(host: TmuxHostEvidence): Promise<boolean | TmuxHostCleanupResult>;
  registry?: AgentRegistry;
  claudeJournalRoot?: string;
  afterClaudeSpawned?(): void;
  afterClaudeReceiptCreated?(): void;
  journalRoot?: string;
  afterCodexForkCreated?(): void;
  afterCodexForkReturned?(): void;
  afterCodexCopyPublished?(): void;
  scanCodexForkArtifacts?(root: string, sourceNativeId: string, createdAtMs: number): CodexForkArtifact[];
  publishCodexHost?(input: StructuredHostPublicationInput): Promise<() => Promise<void>>;
  publishClaudeHost?(input: StructuredHostPublicationInput): Promise<() => Promise<void>>;
  now(): string;
}

export class SuccessorPendingError extends Error {
  constructor() {
    super("successor launch receipt is awaiting host settlement");
    this.name = "SuccessorPendingError";
  }
}

export class CodexForkOutcomeUnknownError extends Error {
  constructor(message = "Codex provider fork outcome is unknown") {
    super(message);
    this.name = "CodexForkOutcomeUnknownError";
  }
}

const defaultDependencies: ProviderDependencies = {
  accounts: accountManager,
  startCodex: (home) => CodexAppServerClient.start({ home }),
  claudeStatus: (home) => realClaudeLoginPorts.status(home),
  spawnClaude: (spec, receipt) => spawnAgentWithPrompt(spec, "", receipt),
  verifyClaudeHost: (host) => verifyTmuxHostEvidence(host),
  cancelClaude: (host) => cleanupTmuxHostIfMatches(host),
  now: () => new Date().toISOString(),
};

function cleanupConfirmed(result: boolean | TmuxHostCleanupResult | undefined): boolean {
  return result === true || result === "cancelled" || result === "absent";
}

function candidateUuid(operationId: string): string {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(operationId)) return operationId;
  const bytes = Buffer.from(crypto.createHash("sha256").update(operationId).digest().subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function assertRegisteredRoots(source: AccountContext | null, target: AccountContext, sourcePath: string): AccountContext {
  if (!source || source.engine !== target.engine) throw new Error("source account ownership is unavailable");
  validateHistorySource(sourcePath, source.transcriptRoot);
  return source;
}

function findCodexRollout(root: string, nativeId: string): string {
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  let visited = 0;
  while (stack.length) {
    const current = stack.pop()!;
    if (current.depth > 6) continue;
    for (const entry of fs.readdirSync(current.dir, { withFileTypes: true })) {
      if (++visited > 20_000) throw new Error("forked Codex history was not found within the scan bound");
      const candidate = path.join(current.dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) stack.push({ dir: candidate, depth: current.depth + 1 });
      else if (entry.isFile() && entry.name.endsWith(`${nativeId}.jsonl`)) return candidate;
    }
  }
  throw new Error("forked Codex history was not found");
}

interface CodexSessionMeta {
  id: string;
  forkedFromId: string | null;
}

interface CodexForkArtifact {
  id: string;
  path: string;
}

/** File identity of the source transcript at the moment a fork copied it. A
    rollout is append-only, so a later size or mtime means the source has gained
    turns the fork does not carry. */
interface CodexSourceIdentity {
  size: number;
  mtimeMs: number;
}

interface CodexProviderOperationJournal {
  version: 1;
  operationId: string;
  /** The conversation this operation moves. Journals written before issue #708
      have none, and are then invisible to cross-operation fork recovery. */
  conversationId: string | null;
  sourceNativeId: string;
  sourceRoot: string;
  targetRoot: string;
  createdAtMs: number;
  /** Earliest uncertain fork request that still needs recovery scanning. Unlike
      `forkRequestedAtMs`, this survives an explicit operator retry so a late
      artifact from any earlier attempt is adopted or retained as continuity. */
  forkRecoveryFloorMs: number | null;
  forkRequestedAtMs: number | null;
  fork: CodexForkArtifact | null;
  /** The source identity `fork` was taken from, observed just before the fork
      was requested. `null` means no attempt ever observed it — journals written
      before this field existed, and forks found only by disk scan — and an
      unobserved source cannot be proven stale, so those are reused as before. */
  forkSource: CodexSourceIdentity | null;
  /** Forks this operation stopped using: an earlier attempt's fork the source
      has since advanced past, and the losers of the newest-wins ambiguity rule.
      Nothing here is ever removed from disk; the list is what keeps them named
      as the conversation's continuity on every replay. */
  supersededForks: CodexForkArtifact[];
}

const CODEX_META_SCAN_BYTES = 256 * 1024;
/** Directory-entry bound on a fork-recovery scan. A cross-operation scan walks
    an account's whole session tree, so it is bounded the same way the rollout
    lookup is; running short returns the candidates found rather than throwing,
    because a partial recovery still beats forking again. */
const CODEX_FORK_SCAN_LIMIT = 20_000;
const CODEX_OPERATION_LOCK_ATTEMPTS = 24_000;
const CODEX_OPERATION_LOCK_WAIT_MS = 5;
const CODEX_OPERATION_LOCK_STALE_MS = 30_000;

interface CodexOperationLockOwner {
  pid: number;
  startIdentity: string | null;
  token: string;
}

function providerLockOwnerIsStale(filename: string): boolean {
  try {
    const owner = JSON.parse(fs.readFileSync(filename, "utf8")) as Partial<CodexOperationLockOwner>;
    if (!Number.isInteger(owner.pid) || !owner.pid || owner.pid < 1) {
      return Date.now() - fs.statSync(filename).mtimeMs > CODEX_OPERATION_LOCK_STALE_MS;
    }
    if (!procBackend.pidAlive(owner.pid)) return true;
    if (typeof owner.startIdentity === "string") {
      const currentIdentity = procBackend.processIdentity(owner.pid);
      return currentIdentity !== null && currentIdentity !== owner.startIdentity;
    }
    return Date.now() - fs.statSync(filename).mtimeMs > CODEX_OPERATION_LOCK_STALE_MS;
  } catch {
    try { return Date.now() - fs.statSync(filename).mtimeMs > CODEX_OPERATION_LOCK_STALE_MS; } catch { return false; }
  }
}

function removeProviderLockIfOwned(filename: string, token: string): void {
  try {
    const owner = JSON.parse(fs.readFileSync(filename, "utf8")) as Partial<CodexOperationLockOwner>;
    if (owner.token === token) fs.rmSync(filename, { force: true });
  } catch { /* another owner already recovered the lease */ }
}

function ensureDurableDirectory(directory: string): void {
  const missing: string[] = [];
  let current = path.resolve(directory);
  while (!fs.existsSync(current)) {
    missing.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const pathname of missing.reverse()) {
    try { fs.mkdirSync(pathname, { mode: 0o700 }); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const descriptor = fs.openSync(path.dirname(pathname), "r");
    try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
    const created = fs.openSync(pathname, "r");
    try { fs.fsyncSync(created); } finally { fs.closeSync(created); }
  }
}

function assertProviderLockOwned(filename: string, token: string): void {
  try {
    const owner = JSON.parse(fs.readFileSync(filename, "utf8")) as Partial<CodexOperationLockOwner>;
    if (owner.token === token) return;
  } catch { /* handled by the fenced error below */ }
  throw new Error("Codex provider operation lease was lost");
}

async function publishCodexSuccessorHost(input: StructuredHostPublicationInput): Promise<() => Promise<void>> {
  if (input.ownsOperation && !await input.ownsOperation()) return async () => {};
  if (!structuredHostsEnabled()) return async () => {};
  const key = sessionKey("codex", input.receipt.nativeId);
  if (!key) throw new Error("successor Codex thread identity is invalid");
  if (hasStructuredDeliveryHost(key)) return async () => { await releaseStructuredDeliveryHost(key); };

  const existing = input.registry.readOnlySnapshot().entries[sessionKeyId(key)];
  const entry = input.registry.upsert({
    ...(existing ?? {
      key,
      status: "unhosted" as const,
      host: null,
      claimEpoch: 0,
      claimOwner: null,
      pendingAction: null,
    }),
    key,
    artifactPath: input.receipt.path,
    cwd: input.profile.cwd,
    accountId: input.target.accountId,
    launchProfile: input.profile,
    structuredHostOperationId: input.receipt.operationId,
  });
  if (!entry.structuredHost) {
    input.registry.setStructuredHost(key, {
      kind: "codex-app-server",
      endpoint: "stdio:pending",
      process: null,
      eventCursor: 0,
      protocolVersion: null,
      writerClaimEpoch: entry.claimEpoch,
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
    }, "unhosted");
  }
  const owner = { pid: process.pid, startIdentity: procBackend.processIdentity(process.pid) };
  const claimed = input.registry.claimStructuredHost(key, owner, { allowUnhosted: true });
  if (!claimed?.claimOwner) throw new Error("successor Codex structured host claim is unavailable");

  const approvalPolicy = input.profile.permissionMode
    && ["never", "on-request", "untrusted"].includes(input.profile.permissionMode)
    ? input.profile.permissionMode
    : undefined;
  let host: CodexAppServerHost | null = null;
  let stopPersistence = () => {};
  let unregister = async () => {};
  const access = materializeStructuredHostAccess(
    structuredHostAccessPolicy(input.profile),
    input.target.env,
    null,
  );
  try {
    host = await CodexAppServerHost.adopt(input.receipt.nativeId, {
      cwd: input.profile.cwd,
      codexHome: input.target.home,
      fileAuthCredentials: input.target.kind === "managed",
      model: input.profile.model ?? undefined,
      effort: input.profile.effort ?? undefined,
      ...access.codex,
      ...access.host,
      approvalPolicy,
      initialEventCursor: claimed.structuredHost?.eventCursor,
      env: access.env,
    });
    stopPersistence = await bindCodexHostPersistence(
      input.registry,
      key,
      host,
      claimed.claimOwner,
      claimed.claimEpoch,
    );
    unregister = await publishStructuredDeliveryHost({ key, host }, input.ownsOperation);
  } catch (error) {
    if (!host && error instanceof StructuredHostAdoptionCleanupError
      && error.host instanceof CodexAppServerHost) {
      host = error.host;
      stopPersistence = await bindCodexHostPersistence(
        input.registry,
        key,
        host,
        claimed.claimOwner,
        claimed.claimEpoch,
        "dead",
      );
      await host.release();
      stopPersistence();
      throw error;
    }
    await unregister();
    if (host) await host.release();
    else access.cleanup();
    stopPersistence();
    input.registry.releaseStructuredHostClaim(key, claimed.claimOwner, claimed.claimEpoch);
    throw error;
  }
  const publishedHost = host;
  return async () => {
    await unregister();
    await publishedHost.release();
    stopPersistence();
  };
}

async function publishClaudeSuccessorHost(
  input: StructuredHostPublicationInput & {
    cancelClaude: NonNullable<ProviderDependencies["cancelClaude"]>;
  },
): Promise<() => Promise<void>> {
  if (input.ownsOperation && !await input.ownsOperation()) return async () => {};
  if (!structuredHostsEnabled()) return async () => {};
  const key = sessionKey("claude", input.receipt.nativeId);
  if (!key) throw new Error("successor Claude session identity is invalid");
  if (hasStructuredDeliveryHost(key)) return async () => { await releaseStructuredDeliveryHost(key); };
  requireStructuredDeliveryControllerPublication();

  const existing = input.registry.readOnlySnapshot().entries[sessionKeyId(key)];
  const entry = input.registry.upsert({
    ...(existing ?? {
      key,
      status: "unhosted" as const,
      host: null,
      claimEpoch: 0,
      claimOwner: null,
      pendingAction: null,
    }),
    key,
    artifactPath: input.receipt.path,
    cwd: input.profile.cwd,
    accountId: input.target.accountId,
    launchProfile: input.profile,
    structuredHostOperationId: input.receipt.operationId,
  });
  if (!entry.structuredHost) {
    input.registry.setStructuredHost(key, {
      kind: "claude-broker",
      endpoint: "stdio:pending",
      process: null,
      eventCursor: 0,
      protocolVersion: null,
      writerClaimEpoch: entry.claimEpoch,
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
    }, "unhosted");
  }
  const owner = { pid: process.pid, startIdentity: procBackend.processIdentity(process.pid) };
  const claimed = input.registry.claimStructuredHost(key, owner, { allowUnhosted: true });
  if (!claimed?.claimOwner) throw new Error("successor Claude structured host claim is unavailable");

  let host: ClaudeStreamBrokerHost | null = null;
  let stopPersistence = () => {};
  let unregister = async () => {};
  let access: ReturnType<typeof materializeStructuredHostAccess> | null = null;
  try {
    const tmuxHost = claudeTmuxHostFromReceipt(input.receipt);
    const cancelled = await input.cancelClaude(tmuxHost);
    if (!cleanupConfirmed(cancelled)) throw new Error("successor Claude host transition is still pending");
    await forgetResumePaneIfMatches(input.receipt.path, tmuxHost);
    access = materializeStructuredHostAccess(
      structuredHostAccessPolicy(input.profile),
      input.target.env,
      null,
    );
    host = await ClaudeStreamBrokerHost.adopt(input.receipt.nativeId, {
      cwd: input.profile.cwd,
      claudeConfigDir: input.target.kind === "managed" ? input.target.home : undefined,
      claudeProjectsDir: input.target.transcriptRoot,
      env: access.env,
      model: input.profile.model ?? undefined,
      effort: input.profile.effort ?? undefined,
      readOnly: launchProfileEngineReadOnly(input.profile),
      restricted: input.profile.sandbox === "restricted",
      permissionMode: input.profile.permissionMode ?? undefined,
      initialEventCursor: claimed.structuredHost?.eventCursor,
      ...access.host,
    });
    stopPersistence = await bindClaudeHostPersistence(
      input.registry,
      key,
      host,
      claimed.claimOwner,
      claimed.claimEpoch,
    );
    unregister = await publishStructuredDeliveryHost({ key, host }, input.ownsOperation);
  } catch (error) {
    if (!host && error instanceof StructuredHostAdoptionCleanupError
      && error.host instanceof ClaudeStreamBrokerHost) {
      host = error.host;
      stopPersistence = await bindClaudeHostPersistence(
        input.registry,
        key,
        host,
        claimed.claimOwner,
        claimed.claimEpoch,
        "dead",
      );
      await host.release();
      stopPersistence();
      throw error;
    }
    await unregister();
    if (host) await host.release();
    else access?.cleanup();
    stopPersistence();
    input.registry.releaseStructuredHostClaim(key, claimed.claimOwner, claimed.claimEpoch);
    throw error;
  }
  const publishedHost = host;
  return async () => {
    await unregister();
    await publishedHost.release();
    stopPersistence();
  };
}

async function waitForProviderLock(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, CODEX_OPERATION_LOCK_WAIT_MS));
}

async function withCodexOperationLease<T>(
  journalRoot: string,
  operationId: string,
  operation: (assertOwned: () => void) => Promise<T>,
): Promise<T> {
  const operationPath = operationJournalPath(journalRoot, operationId);
  const lockPath = `${operationPath}.lock`;
  const queuePath = `${operationPath}.locks`;
  ensureDurableDirectory(journalRoot);
  ensureDurableDirectory(queuePath);
  const owner: CodexOperationLockOwner = {
    pid: process.pid,
    startIdentity: procBackend.processIdentity(process.pid),
    token: crypto.randomUUID(),
  };
  const ticketPath = path.join(
    queuePath,
    `${String(Date.now()).padStart(16, "0")}-${process.pid}-${owner.token}.json`,
  );
  fs.writeFileSync(ticketPath, JSON.stringify(owner), { encoding: "utf8", flag: "wx", mode: 0o600 });
  try {
    for (let attempt = 0; attempt < CODEX_OPERATION_LOCK_ATTEMPTS; attempt += 1) {
      try { fs.utimesSync(ticketPath, new Date(), new Date()); } catch { /* ownership is checked below */ }
      const liveTickets: string[] = [];
      for (const entry of fs.readdirSync(queuePath).filter((candidate) => candidate.endsWith(".json")).sort()) {
        const candidate = path.join(queuePath, entry);
        if (providerLockOwnerIsStale(candidate)) {
          fs.rmSync(candidate, { force: true });
          continue;
        }
        if (fs.existsSync(candidate)) liveTickets.push(candidate);
      }
      if (liveTickets[0] !== ticketPath) {
        await waitForProviderLock();
        continue;
      }
      let descriptor: number;
      try {
        descriptor = fs.openSync(lockPath, "wx", 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (providerLockOwnerIsStale(lockPath)) fs.rmSync(lockPath, { force: true });
        await waitForProviderLock();
        continue;
      }
      fs.writeFileSync(descriptor, JSON.stringify(owner), "utf8");
      fs.fsyncSync(descriptor);
      const renewal = setInterval(() => {
        try {
          const timestamp = new Date();
          fs.utimesSync(lockPath, timestamp, timestamp);
          fs.utimesSync(ticketPath, timestamp, timestamp);
        } catch { /* the final ownership check fences replacement owners */ }
      }, CODEX_OPERATION_LOCK_STALE_MS / 3);
      renewal.unref();
      try {
        return await operation(() => assertProviderLockOwned(lockPath, owner.token));
      } finally {
        clearInterval(renewal);
        fs.closeSync(descriptor);
        removeProviderLockIfOwned(lockPath, owner.token);
      }
    }
    throw new Error("Codex provider operation is busy");
  } finally {
    removeProviderLockIfOwned(ticketPath, owner.token);
  }
}

function readCodexSessionMeta(pathname: string): CodexSessionMeta | null {
  let descriptor: number | null = null;
  try {
    const listed = fs.lstatSync(pathname);
    if (!listed.isFile() || listed.isSymbolicLink()) return null;
    descriptor = fs.openSync(pathname, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const buffer = Buffer.alloc(Math.min(CODEX_META_SCAN_BYTES, Math.max(1, listed.size)));
    const bytes = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
    for (const line of buffer.subarray(0, bytes).toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line) as { type?: unknown; payload?: unknown };
        if (record.type !== "session_meta" || !record.payload || typeof record.payload !== "object" || Array.isArray(record.payload)) continue;
        const payload = record.payload as { id?: unknown; forked_from_id?: unknown };
        if (typeof payload.id !== "string" || !payload.id) return null;
        return {
          id: payload.id,
          forkedFromId: typeof payload.forked_from_id === "string" && payload.forked_from_id ? payload.forked_from_id : null,
        };
      } catch { /* continue through bounded metadata rows */ }
    }
    return null;
  } catch {
    return null;
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

/** Exported for the bound test: the production limit needs 20k files to reach. */
export function codexForkArtifacts(
  root: string,
  sourceNativeId: string,
  createdAtMs: number,
  limit: number = CODEX_FORK_SCAN_LIMIT,
): CodexForkArtifact[] {
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  const artifacts: CodexForkArtifact[] = [];
  let considered = 0;
  while (stack.length) {
    const current = stack.pop()!;
    if (current.depth > 6) continue;
    for (const entry of fs.readdirSync(current.dir, { withFileTypes: true })) {
      const candidate = path.join(current.dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        stack.push({ dir: candidate, depth: current.depth + 1 });
        continue;
      }
      /* Only transcript candidates draw on the budget. Receipts, lock files and
         whatever else shares the session tree can never be a fork, so letting
         them consume it would truncate the scan short of a fork that exists. */
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      if (++considered > limit) {
        /* Running short is silent to the caller — it just sees fewer candidates
           and forks again, writing another full copy of the transcript. Say so
           once per scan, so that copy is explainable from the logs. */
        console.warn("[account-migration] Codex fork recovery scan hit its bound", {
          root,
          limit,
          found: artifacts.length,
        });
        return artifacts;
      }
      if (fs.statSync(candidate).mtimeMs < createdAtMs) continue;
      const metadata = readCodexSessionMeta(candidate);
      if (metadata?.forkedFromId === sourceNativeId) artifacts.push({ id: metadata.id, path: fs.realpathSync(candidate) });
    }
  }
  return artifacts;
}

function codexSourceIdentity(pathname: string): CodexSourceIdentity | null {
  try {
    const listed = fs.statSync(pathname);
    return listed.isFile() ? { size: listed.size, mtimeMs: listed.mtimeMs } : null;
  } catch { return null; }
}

/**
 * Has the source moved on from what this fork copied? (#708 follow-up)
 *
 * A fork is a point-in-time snapshot, and a `failed-recoverable` migration stays
 * parked while `deliveryFence` keeps letting the operator talk to the source. So
 * between the first attempt's fork and the retry that adopts it, the source can
 * gain turns the fork has never seen — and seating the successor on it would
 * drop exactly those turns.
 *
 * An unobserved source (`recorded === null`) or an unreadable one cannot be
 * proven stale, and re-forking on a guess would copy the whole history again for
 * nothing, so those keep reusing the fork.
 */
function codexForkIsStale(current: CodexSourceIdentity | null, recorded: CodexSourceIdentity | null): boolean {
  if (!current) return false;
  if (!recorded) return true;
  return current.size !== recorded.size || current.mtimeMs !== recorded.mtimeMs;
}

function mergeForkRecords(...groups: readonly (readonly CodexForkArtifact[])[]): CodexForkArtifact[] {
  const merged = new Map<string, CodexForkArtifact>();
  for (const group of groups) {
    for (const artifact of group) if (!merged.has(artifact.id)) merged.set(artifact.id, artifact);
  }
  return [...merged.values()];
}

function operationJournalPath(root: string, operationId: string): string {
  return path.join(root, `${crypto.createHash("sha256").update(operationId).digest("hex")}.json`);
}

function writeCodexOperationJournal(root: string, journal: CodexProviderOperationJournal): void {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const filename = operationJournalPath(root, journal.operationId);
  const temp = `${filename}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(journal, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    const descriptor = fs.openSync(temp, "r");
    try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
    fs.renameSync(temp, filename);
    const directory = fs.openSync(root, "r");
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

function normalizeCodexOperationJournal(value: unknown): CodexProviderOperationJournal | null {
  const journal = value as Partial<CodexProviderOperationJournal> | null;
  if (!journal || typeof journal !== "object" || journal.version !== 1
    || typeof journal.operationId !== "string" || typeof journal.sourceNativeId !== "string"
    || typeof journal.sourceRoot !== "string" || typeof journal.targetRoot !== "string"
    || typeof journal.createdAtMs !== "number" || !Number.isFinite(journal.createdAtMs)) return null;
  return {
    version: 1,
    operationId: journal.operationId,
    conversationId: typeof journal.conversationId === "string" && journal.conversationId ? journal.conversationId : null,
    sourceNativeId: journal.sourceNativeId,
    sourceRoot: journal.sourceRoot,
    targetRoot: journal.targetRoot,
    createdAtMs: journal.createdAtMs,
    forkRecoveryFloorMs: typeof journal.forkRecoveryFloorMs === "number" && Number.isFinite(journal.forkRecoveryFloorMs)
      ? journal.forkRecoveryFloorMs
      : (typeof journal.forkRequestedAtMs === "number" && Number.isFinite(journal.forkRequestedAtMs)
        ? journal.forkRequestedAtMs
        : null),
    forkRequestedAtMs: typeof journal.forkRequestedAtMs === "number" && Number.isFinite(journal.forkRequestedAtMs)
      ? journal.forkRequestedAtMs
      : null,
    fork: journal.fork && typeof journal.fork.id === "string" && typeof journal.fork.path === "string"
      ? { id: journal.fork.id, path: journal.fork.path }
      : null,
    forkSource: journal.forkSource
      && typeof journal.forkSource.size === "number" && Number.isFinite(journal.forkSource.size)
      && typeof journal.forkSource.mtimeMs === "number" && Number.isFinite(journal.forkSource.mtimeMs)
      ? { size: journal.forkSource.size, mtimeMs: journal.forkSource.mtimeMs }
      : null,
    supersededForks: Array.isArray(journal.supersededForks)
      ? journal.supersededForks.flatMap((artifact) => (
        artifact && typeof artifact === "object"
          && typeof (artifact as CodexForkArtifact).id === "string"
          && typeof (artifact as CodexForkArtifact).path === "string"
          ? [{ id: (artifact as CodexForkArtifact).id, path: (artifact as CodexForkArtifact).path }]
          : []
      ))
      : [],
  };
}

function prepareCodexOperationJournal(
  root: string,
  operationId: string,
  conversationId: string,
  sourceNativeId: string,
  sourceRoot: string,
  targetRoot: string,
): { journal: CodexProviderOperationJournal; fresh: boolean } {
  const filename = operationJournalPath(root, operationId);
  try {
    const stored = normalizeCodexOperationJournal(JSON.parse(fs.readFileSync(filename, "utf8")));
    if (!stored || stored.operationId !== operationId || stored.sourceNativeId !== sourceNativeId
      || stored.sourceRoot !== sourceRoot || stored.targetRoot !== targetRoot) {
      throw new Error("Codex provider operation journal does not match");
    }
    return { journal: { ...stored, conversationId: stored.conversationId ?? conversationId }, fresh: false };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const journal: CodexProviderOperationJournal = {
    version: 1,
    operationId,
    conversationId,
    sourceNativeId,
    sourceRoot,
    targetRoot,
    createdAtMs: Date.now(),
    forkRecoveryFloorMs: null,
    forkRequestedAtMs: null,
    fork: null,
    forkSource: null,
    supersededForks: [],
  };
  writeCodexOperationJournal(root, journal);
  return { journal, fresh: true };
}

/**
 * Journals of earlier attempts to move the same conversation from the same
 * source thread to the same target account.
 *
 * The logical operation is keyed on `(sourceNativeId, sourceRoot, targetRoot)`,
 * which every journal ever written already carries. `conversationId` only
 * narrows the match when BOTH sides name one: journals written before #708 have
 * no `conversationId` at all, and those are exactly the attempts whose forks are
 * already sitting on the operator's disk. Requiring it would make this guard
 * blindest where it is needed most, so a missing id matches and is backfilled in
 * place — additively, and best-effort, since recovery must not depend on it.
 */
function siblingCodexOperationJournals(root: string, journal: CodexProviderOperationJournal): CodexProviderOperationJournal[] {
  let names: string[];
  try { names = fs.readdirSync(root); } catch { return []; }
  const siblings: CodexProviderOperationJournal[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    let stored: CodexProviderOperationJournal | null = null;
    try { stored = normalizeCodexOperationJournal(JSON.parse(fs.readFileSync(path.join(root, name), "utf8"))); }
    catch { continue; }
    if (!stored || stored.operationId === journal.operationId) continue;
    if (stored.sourceNativeId !== journal.sourceNativeId || stored.sourceRoot !== journal.sourceRoot
      || stored.targetRoot !== journal.targetRoot) continue;
    if (stored.conversationId && journal.conversationId && stored.conversationId !== journal.conversationId) continue;
    if (!stored.conversationId && journal.conversationId && path.join(root, name) === operationJournalPath(root, stored.operationId)) {
      const backfilled = { ...stored, conversationId: journal.conversationId };
      try { writeCodexOperationJournal(root, backfilled); stored = backfilled; }
      catch { /* the match already stands; naming it durably is a courtesy */ }
    }
    siblings.push(stored);
  }
  return siblings;
}

function forkArtifactMtimeMs(pathname: string): number {
  try { return fs.statSync(pathname).mtimeMs; } catch { return 0; }
}

/** The single ambiguity rule (#708): several forks of one source mean earlier
    attempts made several, so the newest becomes this operation's fork and the
    rest are handed back to be recorded as the conversation's history. Both
    recovery paths sort identically so a retry always lands on the same fork. */
function newestForkFirst(artifacts: readonly CodexForkArtifact[]): CodexForkArtifact[] {
  return [...artifacts].sort((left, right) =>
    forkArtifactMtimeMs(right.path) - forkArtifactMtimeMs(left.path) || right.path.localeCompare(left.path));
}

/**
 * Recover the fork an earlier attempt at this same move already created.
 *
 * Journal-scoped recovery only sees the operation that wrote the journal, so
 * before issue #708 a retry that arrived under a new operation identity always
 * looked like a first attempt and forked again — one full copy of the personal
 * transcript per failure. The logical operation is the conversation, its source
 * thread and its target account, and every attempt at it left a journal saying
 * so, which is what bounds the disk scan and what makes this recovery keyed on
 * something stabler than the operation id.
 *
 * Several candidates mean earlier attempts made several. The newest becomes
 * this operation's fork and the rest are returned to be recorded as the
 * conversation's history — none of them is ever removed.
 */
function recoverPriorOperationFork(
  journalRoot: string,
  journal: CodexProviderOperationJournal,
  scan: NonNullable<ProviderDependencies["scanCodexForkArtifacts"]> = codexForkArtifacts,
): {
  fork: CodexForkArtifact | null;
  forkSource: CodexSourceIdentity | null;
  superseded: CodexForkArtifact[];
  operationIds: string[];
} {
  const siblings = siblingCodexOperationJournals(journalRoot, journal);
  if (siblings.length === 0) return { fork: null, forkSource: null, superseded: [], operationIds: [] };
  const floor = Math.min(...siblings.map((sibling) => sibling.forkRequestedAtMs ?? sibling.createdAtMs));
  const candidates = new Map<string, CodexForkArtifact>();
  /* The source identity each sibling observed before it requested its fork. Only
     a fork some journal actually claims carries one; a fork found by disk scan
     alone has no attempt vouching for when it was taken. */
  const observedSource = new Map<string, CodexSourceIdentity>();
  for (const sibling of siblings) {
    if (!sibling.fork) continue;
    candidates.set(sibling.fork.id, sibling.fork);
    if (sibling.forkSource) observedSource.set(sibling.fork.id, sibling.forkSource);
  }
  for (const artifact of scan(journal.sourceRoot, journal.sourceNativeId, floor)) candidates.set(artifact.id, artifact);
  /* A fork this operation already handed back must not come round again as the
     one it adopts — otherwise a crash between setting it aside and re-forking
     would let the next attempt pick the same stale snapshot straight back up.
     It stays recorded as continuity through the journal either way. */
  for (const artifact of journal.supersededForks) candidates.delete(artifact.id);
  const validated = newestForkFirst([...candidates.values()].flatMap((artifact) => {
    try { return [validatedCodexFork(artifact, journal.sourceNativeId, journal.sourceRoot)]; }
    catch { return []; }
  }));
  const adopted = validated[0] ?? null;
  return {
    fork: adopted,
    forkSource: adopted ? observedSource.get(adopted.id) ?? null : null,
    superseded: validated.slice(1),
    operationIds: siblings.map((sibling) => sibling.operationId),
  };
}

function validatedCodexFork(artifact: CodexForkArtifact, sourceNativeId: string, sourceRoot: string): CodexForkArtifact {
  const validated = validateHistorySource(artifact.path, sourceRoot);
  const metadata = readCodexSessionMeta(validated.sourcePath);
  if (!path.basename(validated.sourcePath).endsWith(`${artifact.id}.jsonl`)
    || metadata?.id !== artifact.id || metadata.forkedFromId !== sourceNativeId) {
    throw new HistorySecurityError("unsafe-source");
  }
  return { id: artifact.id, path: validated.sourcePath };
}

/**
 * Recover the fork this operation's own journal says it requested.
 *
 * Two candidates inside one operation's window used to be an impasse, but the
 * operation identity now survives a retry, so that impasse re-threw on every
 * attempt and parked the migration for good. It is the same situation the
 * cross-operation path already handles, and it gets the same answer: adopt the
 * newest, hand the rest back as history, remove nothing.
 */
function recoverCodexFork(
  journal: CodexProviderOperationJournal,
  scan: NonNullable<ProviderDependencies["scanCodexForkArtifacts"]> = codexForkArtifacts,
): { fork: CodexForkArtifact | null; forkSource: CodexSourceIdentity | null; superseded: CodexForkArtifact[] } {
  if (journal.fork) {
    return {
      fork: validatedCodexFork(journal.fork, journal.sourceNativeId, journal.sourceRoot),
      forkSource: journal.forkSource,
      superseded: [],
    };
  }
  const recoveryFloor = journal.forkRecoveryFloorMs ?? journal.forkRequestedAtMs;
  if (recoveryFloor === null) return { fork: null, forkSource: null, superseded: [] };
  const setAside = new Set(journal.supersededForks.map((artifact) => artifact.id));
  const candidates = newestForkFirst(scan(journal.sourceRoot, journal.sourceNativeId, recoveryFloor)
    .filter((candidate) => !setAside.has(candidate.id))
    .flatMap((candidate) => {
      try { return [validatedCodexFork(candidate, journal.sourceNativeId, journal.sourceRoot)]; }
      catch { return []; }
    }));
  /* This operation requested the fork itself, so the identity it recorded before
     asking describes whichever artifact that request produced. */
  return { fork: candidates[0] ?? null, forkSource: journal.forkSource, superseded: candidates.slice(1) };
}

export type CodexForkRetryAuthorization = "not-needed" | "recovery-ready" | "reauthorized";

/**
 * Converts an explicit operator retry into one new fork attempt when recovery
 * found no artifact for the prior unknown outcome. Automatic controller ticks
 * never call this seam, so an app-server timeout cannot become a fork loop.
 *
 * The recovery floor remains anchored to the first uncertain request. A late
 * artifact visible before the operation adopts a fork is therefore recovered;
 * ambiguity keeps the newest and records every other validated candidate as
 * continuity.
 */
export async function authorizeCodexForkRetry(
  operationId: string,
  conversationId: string,
  journalRoot = statePath("migration-provider-operations"),
  scan: NonNullable<ProviderDependencies["scanCodexForkArtifacts"]> = codexForkArtifacts,
): Promise<CodexForkRetryAuthorization> {
  const filename = operationJournalPath(journalRoot, operationId);
  let initial: CodexProviderOperationJournal | null;
  try {
    initial = normalizeCodexOperationJournal(JSON.parse(fs.readFileSync(filename, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "not-needed";
    throw error;
  }
  if (!initial || initial.operationId !== operationId
    || (initial.conversationId && initial.conversationId !== conversationId)) {
    throw new Error("Codex provider operation journal does not match");
  }
  return withCodexOperationLease(journalRoot, `move:${initial.sourceNativeId}`, async (assertLeaseOwned) => {
    const journal = normalizeCodexOperationJournal(JSON.parse(fs.readFileSync(filename, "utf8")));
    if (!journal || journal.operationId !== operationId
      || (journal.conversationId && journal.conversationId !== conversationId)) {
      throw new Error("Codex provider operation journal does not match");
    }
    if (journal.fork || journal.forkRequestedAtMs === null) return "not-needed";
    const recovered = recoverCodexFork(journal, scan);
    if (recovered.fork) return "recovery-ready";
    journal.forkRequestedAtMs = null;
    assertLeaseOwned();
    writeCodexOperationJournal(journalRoot, journal);
    return "reauthorized";
  });
}

/* The shared Claude transcript store (issue #891, phase 1) is the one
   transcript root that legitimately lives outside every account home; a
   cut-over account reports its canonical path directly. */
function isSharedClaudeTranscriptRoot(transcriptRoot: string): boolean {
  try { return fs.realpathSync(transcriptRoot) === fs.realpathSync(sharedClaudeProjectsRoot()); }
  catch { return false; }
}

function ensureTargetRoot(account: AccountContext): void {
  const home = fs.lstatSync(account.home);
  if (!home.isDirectory() || home.isSymbolicLink() || (process.getuid && home.uid !== process.getuid()) || (home.mode & 0o022) !== 0) {
    throw new MigrationTargetUnavailableError("unsafe-home", "target account home failed safety checks");
  }
  if (path.dirname(path.resolve(account.transcriptRoot)) !== path.resolve(account.home)
    && !(account.engine === "claude" && isSharedClaudeTranscriptRoot(account.transcriptRoot))) {
    throw new Error("target transcript root is outside its account home");
  }
  try { fs.mkdirSync(account.transcriptRoot, { mode: 0o700 }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const root = fs.lstatSync(account.transcriptRoot);
  if (!root.isDirectory() || root.isSymbolicLink() || (process.getuid && root.uid !== process.getuid()) || (root.mode & 0o022) !== 0) {
    throw new Error("target transcript root failed safety checks");
  }
}

function claudePaneFromHost(receipt: ProviderReceipt): { paneId: string; panePid: number } {
  if (receipt.host.kind !== "claude-stream") throw new Error("successor Claude host identity is invalid");
  const matched = /^(%[0-9]+):([1-9][0-9]*)$/.exec(receipt.host.identity);
  if (!matched) throw new Error("successor Claude host identity is invalid");
  return { paneId: matched[1]!, panePid: Number(matched[2]) };
}

function claudeTmuxHostFromReceipt(receipt: ProviderReceipt): TmuxHostEvidence {
  const expected = claudePaneFromHost(receipt);
  const host = receipt.host.tmuxHost;
  if (!host || host.kind !== "tmux" || host.paneId !== expected.paneId || host.panePid.pid !== expected.panePid) {
    throw new Error("successor Claude host identity is invalid");
  }
  return host;
}

function assertClaudeTranscript(receipt: ProviderReceipt, target: AccountContext): void {
  if (!receipt.path.startsWith(target.transcriptRoot + path.sep)) throw new Error("target Claude history is outside its registered root");
  if (path.basename(receipt.path, ".jsonl") !== receipt.nativeId) throw new Error("target Claude transcript identity does not match");
  if (!fs.existsSync(receipt.path)) throw new Error("target Claude successor transcript is not durable");
  const history = hashValidatedHistory(receipt.path, target.transcriptRoot);
  if (history.size === 0) throw new Error("target Claude successor transcript is not durable");
  const records = fs.readFileSync(receipt.path, "utf8").split("\n");
  const matchesSession = records.some((line) => {
    try {
      const value = JSON.parse(line) as { sessionId?: unknown; session_id?: unknown };
      return value.sessionId === receipt.nativeId || value.session_id === receipt.nativeId;
    } catch { return false; }
  });
  if (!matchesSession) throw new Error("target Claude transcript session identity does not match");
}

function ownsCompletedClaudeBrokerTransition(
  registry: AgentRegistry,
  receipt: ProviderReceipt,
  target: AccountContext,
): boolean {
  const key = sessionKey("claude", receipt.nativeId);
  if (!key) return false;
  const entry = registry.readOnlySnapshot().entries[sessionKeyId(key)];
  return entry?.structuredHostOperationId === receipt.operationId
    && entry.artifactPath === receipt.path
    && entry.accountId === target.accountId
    && entry.structuredHost?.kind === "claude-broker"
    && entry.structuredHost.endpoint !== "stdio:pending"
    && entry.structuredHost.protocolVersion !== null;
}

export class RegisteredSuccessorProvider implements SuccessorProviderPort {
  private readonly publishedHosts = new Map<string, {
    nativeId: string;
    path: string;
    cleanup: () => Promise<void>;
  }>();
  private readonly publishingHosts = new Map<string, Promise<void>>();

  constructor(private readonly dependencies: ProviderDependencies = defaultDependencies) {}

  async create(input: Parameters<SuccessorProviderPort["create"]>[0]): Promise<ProviderReceipt> {
    const target = this.dependencies.accounts.resolveSpawn(input.engine, input.targetAccountId);
    const source = assertRegisteredRoots(this.dependencies.accounts.resolveTranscriptOwner(input.engine, input.source.path), target, input.source.path);
    ensureTargetRoot(target);
    return input.engine === "codex"
      ? this.createCodex(input.operationId, input.conversationId, input.source.id, input.source.path, input.source.launchProfile, source, target, input.recordContinuityPath)
      : this.createClaude(input.operationId, input.conversationId, input.source.path, input.source.launchProfile, source, target, input.recordContinuityPath);
  }

  async verify(receipt: ProviderReceipt, input: { engine: "claude" | "codex"; targetAccountId: string; launchProfile: LaunchProfile }): Promise<void> {
    const target = this.dependencies.accounts.resolveSpawn(input.engine, input.targetAccountId);
    ensureTargetRoot(target);
    if (input.engine === "claude") {
      const status = await this.dependencies.claudeStatus(target.home);
      if (!status.loggedIn) throw new MigrationTargetUnavailableError("not-authenticated", "target Claude account is not authenticated");
      assertClaudeTranscript(receipt, target);
      const host = claudeTmuxHostFromReceipt(receipt);
      const registry = this.dependencies.registry ?? agentRegistry();
      const tmuxLive = host.windowName === "claude-migration-successor"
        && await this.dependencies.verifyClaudeHost?.(host);
      if (!tmuxLive && !ownsCompletedClaudeBrokerTransition(registry, receipt, target)) {
        throw new Error("target Claude successor host is not live and canonical");
      }
      return;
    }
    const client = await this.dependencies.startCodex(target.home);
    try {
      const account = await client.readAccount();
      // Authenticated ChatGPT responses carry requiresOpenaiAuth=true because
      // the field describes the active provider's credential requirement.
      if (!account.account) throw new MigrationTargetUnavailableError("not-authenticated", "target Codex account is not authenticated");
      const thread = await client.readThread(receipt.nativeId);
      if (thread.id !== receipt.nativeId) throw new Error("target Codex thread identity does not match");
    } finally { client.close(); }
  }

  async publishHost(
    receipt: ProviderReceipt,
    input: Parameters<NonNullable<SuccessorProviderPort["publishHost"]>>[1],
  ): Promise<void> {
    if (input.ownsOperation && !await input.ownsOperation()) return;
    const injectedPublisher = input.engine === "codex"
      ? this.dependencies.publishCodexHost
      : this.dependencies.publishClaudeHost;
    if (!injectedPublisher && !structuredHostsEnabled()) return;
    const existing = this.publishedHosts.get(receipt.operationId);
    if (existing) {
      if (existing.nativeId !== receipt.nativeId || existing.path !== receipt.path) {
        throw new Error("successor host publication conflicts");
      }
      return;
    }
    const pending = this.publishingHosts.get(receipt.operationId);
    if (pending) {
      await pending;
      const published = this.publishedHosts.get(receipt.operationId);
      if (!published || published.nativeId !== receipt.nativeId || published.path !== receipt.path) {
        throw new Error("successor host publication conflicts");
      }
      return;
    }
    const publication = (async () => {
      const target = this.dependencies.accounts.resolveSpawn(input.engine, input.targetAccountId);
      const publicationInput = {
        receipt,
        target,
        profile: input.launchProfile,
        registry: this.dependencies.registry ?? agentRegistry(),
        ownsOperation: input.ownsOperation,
      };
      let cleanup: () => Promise<void>;
      if (input.engine === "codex") {
        cleanup = await (injectedPublisher ?? publishCodexSuccessorHost)(publicationInput);
      } else if (injectedPublisher) {
        cleanup = await injectedPublisher(publicationInput);
      } else {
        cleanup = await publishClaudeSuccessorHost({
          ...publicationInput,
          cancelClaude: this.dependencies.cancelClaude ?? defaultDependencies.cancelClaude!,
        });
      }
      if (input.ownsOperation && !await input.ownsOperation()) {
        await cleanup();
        return;
      }
      this.publishedHosts.set(receipt.operationId, {
        nativeId: receipt.nativeId,
        path: receipt.path,
        cleanup,
      });
    })();
    this.publishingHosts.set(receipt.operationId, publication);
    try {
      await publication;
    } finally {
      if (this.publishingHosts.get(receipt.operationId) === publication) {
        this.publishingHosts.delete(receipt.operationId);
      }
    }
  }

  async cleanup(receipt: ProviderReceipt): Promise<void> {
    const published = this.publishedHosts.get(receipt.operationId);
    if (published && published.nativeId === receipt.nativeId && published.path === receipt.path) {
      await published.cleanup();
      this.publishedHosts.delete(receipt.operationId);
      return;
    }
    const key = receipt.host.kind === "codex-app-server"
      ? sessionKey("codex", receipt.nativeId)
      : receipt.host.kind === "claude-stream"
        ? sessionKey("claude", receipt.nativeId)
        : null;
    if (key && await releaseStructuredDeliveryHost(key)) return;
    if (receipt.host.kind === "codex-app-server") return;
    if (receipt.host.kind !== "claude-stream") return;
    const host = claudeTmuxHostFromReceipt(receipt);
    const cancelled = await this.dependencies.cancelClaude?.(host);
    if (!cleanupConfirmed(cancelled)) throw new Error("successor Claude host cleanup is still pending");
    await forgetResumePaneIfMatches(receipt.path, host);
  }

  private async createClaude(
    operationId: string,
    conversationId: Parameters<SuccessorProviderPort["create"]>[0]["conversationId"],
    sourcePath: string,
    profile: LaunchProfile,
    source: AccountContext,
    target: AccountContext,
    recordContinuityPath: (pathname: string) => void,
  ): Promise<ProviderReceipt> {
    const journalRoot = this.dependencies.claudeJournalRoot ?? statePath("migration-provider-claude-operations");
    return withCodexOperationLease(journalRoot, operationId, (assertLeaseOwned) => this.createClaudeLocked(
      operationId,
      conversationId,
      sourcePath,
      profile,
      source,
      target,
      recordContinuityPath,
      assertLeaseOwned,
    ));
  }

  private async createClaudeLocked(
    operationId: string,
    conversationId: Parameters<SuccessorProviderPort["create"]>[0]["conversationId"],
    sourcePath: string,
    profile: LaunchProfile,
    source: AccountContext,
    target: AccountContext,
    recordContinuityPath: (pathname: string) => void,
    assertLeaseOwned: () => void,
  ): Promise<ProviderReceipt> {
    const status = await this.dependencies.claudeStatus(target.home);
    if (!status.loggedIn) throw new MigrationTargetUnavailableError("not-authenticated", "target Claude account is not authenticated");
    const history = hashValidatedHistory(sourcePath, source.transcriptRoot);
    const nativeId = candidateUuid(operationId);
    const spec = claudeSuccessorSpecFor({ sourcePath, candidateId: nativeId, targetHome: target.home, targetProjectsDir: target.transcriptRoot, profile });
    const successorPath = spec.transcript ?? path.join(target.transcriptRoot, `${nativeId}.jsonl`);
    const registry = this.dependencies.registry ?? agentRegistry();
    const recordContinuityOrCancel = async (launchId: string, host: TmuxHostEvidence): Promise<void> => {
      try {
        recordContinuityPath(successorPath);
      } catch (error) {
        registry.preserveSpawnArtifactOwnership(launchId, "migration continuity persistence failed");
        try {
          const cleanup = await this.dependencies.cancelClaude?.(host);
          if (cleanupConfirmed(cleanup)) await forgetResumePaneIfMatches(successorPath, host);
        } catch { /* durable artifact ownership remains available to inventory recovery */ }
        throw error;
      }
    };
    const requestDigest = crypto.createHash("sha256").update(JSON.stringify({ operationId, conversationId, target: target.accountId, nativeId })).digest("hex");
    const begun = registry.beginSpawnRequest({
      engine: "claude",
      cwd: profile.cwd,
      launchProfile: profile,
      clientAttemptId: `migration-successor:${operationId}`,
      requestDigest,
      accountId: target.accountId,
      conversationId,
      purpose: "migration-successor",
      origin: { kind: "successor" },
      expectedArtifactPath: successorPath,
    });
    if (begun.kind === "conflict") throw new Error("successor Claude operation receipt conflicts");
    const spawnReceipt = begun.receipt;
    if (begun.kind === "replay") {
      if (spawnReceipt.state === "failed" || spawnReceipt.state === "conflicted") {
        throw new Error("successor Claude operation receipt is terminal");
      }
      const host = spawnReceipt.verifiedHost;
      if (host) {
        if (!await this.dependencies.verifyClaudeHost?.(host)) {
          throw new Error("successor Claude operation has no recoverable live host");
        }
        await recordContinuityOrCancel(spawnReceipt.launchId, host);
        return {
          operationId,
          nativeId,
          path: successorPath,
          continuityPaths: [successorPath],
          historyHash: history.hash,
          host: { kind: "claude-stream", identity: `${host.paneId}:${host.panePid.pid}`, epoch: 1, verifiedAt: this.dependencies.now(), tmuxHost: host },
        };
      }
      if (spawnReceipt.state !== "starting" || spawnReceipt.pane || fs.existsSync(successorPath)) throw new SuccessorPendingError();
    } else {
      this.dependencies.afterClaudeReceiptCreated?.();
    }
    assertLeaseOwned();
    let pane: Awaited<ReturnType<ProviderDependencies["spawnClaude"]>>;
    try {
      pane = await this.dependencies.spawnClaude(spec, spawnReceipt);
    } catch (error) {
      registry.failSpawn(spawnReceipt.launchId, error instanceof Error ? error.message : String(error));
      throw error;
    }
    if (!pane.host || pane.panePid === undefined || pane.host.paneId !== pane.paneId || pane.host.panePid.pid !== pane.panePid) {
      registry.failSpawn(spawnReceipt.launchId, "successor Claude host evidence is unavailable");
      throw new Error("successor Claude host evidence is unavailable");
    }
    const fenceReceipt = async (receipt: SpawnReceipt): Promise<void> => {
      if (receipt.state !== "failed" && receipt.state !== "conflicted") return;
      try { await this.dependencies.cancelClaude?.(pane.host!); } catch { /* terminal receipt fencing keeps cleanup best effort */ }
      throw new Error("successor Claude operation receipt became terminal");
    };
    const bound = registry.bindSpawnPane(spawnReceipt.launchId, {
      endpoint: pane.host.endpoint,
      server: pane.host.server,
      paneId: pane.host.paneId,
      panePid: pane.host.panePid,
      target: pane.host.paneId,
    });
    await fenceReceipt(bound);
    const verified = registry.markSpawnHostVerified(spawnReceipt.launchId, pane.host);
    await fenceReceipt(verified);
    const delivered = registry.markSpawnPromptDelivered(spawnReceipt.launchId);
    await fenceReceipt(delivered);
    await recordContinuityOrCancel(spawnReceipt.launchId, pane.host);
    assertLeaseOwned();
    this.dependencies.afterClaudeSpawned?.();
    return {
      operationId,
      nativeId,
      path: successorPath,
      continuityPaths: [successorPath],
      historyHash: history.hash,
      host: { kind: "claude-stream", identity: `${pane.paneId}:${pane.panePid}`, epoch: 1, verifiedAt: this.dependencies.now(), tmuxHost: pane.host },
    };
  }

  private async createCodex(
    operationId: string,
    conversationId: string,
    sourceNativeId: string,
    sourcePath: string,
    profile: LaunchProfile,
    source: AccountContext,
    target: AccountContext,
    recordContinuityPath: (pathname: string) => void,
  ): Promise<ProviderReceipt> {
    const journalRoot = this.dependencies.journalRoot ?? statePath("migration-provider-operations");
    return withCodexOperationLease(journalRoot, `move:${sourceNativeId}`, (assertLeaseOwned) => this.createCodexLocked(
      operationId,
      conversationId,
      sourceNativeId,
      sourcePath,
      profile,
      source,
      target,
      recordContinuityPath,
      journalRoot,
      assertLeaseOwned,
    ));
  }

  private async createCodexLocked(
    operationId: string,
    conversationId: string,
    sourceNativeId: string,
    sourcePath: string,
    profile: LaunchProfile,
    source: AccountContext,
    target: AccountContext,
    recordContinuityPath: (pathname: string) => void,
    journalRoot: string,
    assertLeaseOwned: () => void,
  ): Promise<ProviderReceipt> {
    const prepared = prepareCodexOperationJournal(
      journalRoot,
      operationId,
      conversationId,
      sourceNativeId,
      fs.realpathSync(source.transcriptRoot),
      fs.realpathSync(target.transcriptRoot),
    );
    const journal = prepared.journal;
    /* Before requesting a fork of our own, adopt whatever an earlier attempt at
       this same move already produced (#708) — whether it was this operation
       retrying or an operation that has since been replaced. Nothing is deleted:
       the forks this operation does not take over are recorded as the
       conversation's history. */
    let priorOperationIds: string[] = [];
    let fork: CodexForkArtifact | null = null;
    let forkSource: CodexSourceIdentity | null = null;
    let recoveredSuperseded: CodexForkArtifact[] = [];
    if (!prepared.fresh) {
      const recovered = recoverCodexFork(journal, this.dependencies.scanCodexForkArtifacts);
      fork = recovered.fork;
      forkSource = recovered.forkSource;
      recoveredSuperseded = recovered.superseded;
    }
    if (!fork && journal.forkRequestedAtMs === null) {
      const prior = recoverPriorOperationFork(journalRoot, journal, this.dependencies.scanCodexForkArtifacts);
      fork = prior.fork;
      forkSource = prior.forkSource;
      recoveredSuperseded = prior.superseded;
      if (fork) priorOperationIds = prior.operationIds;
    }
    /* A fork is a snapshot, and the source keeps advancing while a
       `failed-recoverable` migration is parked (#708 follow-up). Adopting a fork
       the source has since moved past would seat the successor on an older
       point in time and silently drop every turn added since. Re-fork instead —
       and hand the stale fork back as continuity, because it is history the
       operator may still want and nothing here ever deletes an artifact. */
    let refork = false;
    if (fork && codexForkIsStale(codexSourceIdentity(sourcePath), forkSource)) {
      journal.supersededForks = mergeForkRecords(journal.supersededForks, [fork], recoveredSuperseded);
      journal.fork = null;
      journal.forkSource = null;
      journal.forkRequestedAtMs = null;
      assertLeaseOwned();
      writeCodexOperationJournal(journalRoot, journal);
      fork = null;
      forkSource = null;
      recoveredSuperseded = [];
      priorOperationIds = [];
      refork = true;
    }
    if (fork && (!journal.fork || recoveredSuperseded.length > 0)) {
      journal.fork = fork;
      journal.forkSource = forkSource;
      journal.supersededForks = mergeForkRecords(journal.supersededForks, recoveredSuperseded);
      assertLeaseOwned();
      writeCodexOperationJournal(journalRoot, journal);
    }
    if (!fork && !refork && !prepared.fresh && journal.forkRequestedAtMs !== null) throw new CodexForkOutcomeUnknownError();
    if (!fork) {
      const sourceClient = await this.dependencies.startCodex(source.home);
      let created: Awaited<ReturnType<CodexAppServerClient["forkThread"]>>;
      try {
        const account = await sourceClient.readAccount();
        if (!account.account) throw new Error("source Codex account is not authenticated");
        journal.forkRequestedAtMs = Date.now();
        journal.forkRecoveryFloorMs ??= journal.forkRequestedAtMs;
        /* Observed before the request, so it names the state the fork copies.
           Reading it afterwards would count a turn that landed in between as
           already forked, which is the loss this whole check exists to stop. */
        journal.forkSource = codexSourceIdentity(sourcePath);
        assertLeaseOwned();
        writeCodexOperationJournal(journalRoot, journal);
        try {
          created = await sourceClient.forkThread(sourceNativeId);
        } catch (error) {
          const uncertain = error instanceof CodexAppServerError && error.outcome === "unknown";
          if (uncertain) throw new CodexForkOutcomeUnknownError(error.message);
          journal.forkRequestedAtMs = null;
          journal.forkSource = null;
          assertLeaseOwned();
          writeCodexOperationJournal(journalRoot, journal);
          throw error;
        }
        this.dependencies.afterCodexForkReturned?.();
      } finally { sourceClient.close(); }
      const reportedSourceFork = created.path ?? findCodexRollout(source.transcriptRoot, created.id);
      fork = validatedCodexFork({ id: created.id, path: reportedSourceFork }, sourceNativeId, source.transcriptRoot);
      journal.fork = fork;
      assertLeaseOwned();
      writeCodexOperationJournal(journalRoot, journal);
      this.dependencies.afterCodexForkCreated?.();
    }
    const adopted = fork;
    /* Every fork this operation set aside stays named as the conversation's
       continuity, replay after replay. One the operator has since removed by
       hand simply stops validating and drops out; nothing here removes it. */
    const supersededForks = mergeForkRecords(journal.supersededForks, recoveredSuperseded)
      .filter((artifact) => artifact.id !== adopted.id)
      .flatMap((artifact) => {
        try { return [validatedCodexFork(artifact, sourceNativeId, source.transcriptRoot)]; }
        catch { return []; }
      });
    const sourceFork = adopted.path;
    recordContinuityPath(sourceFork);
    for (const superseded of supersededForks) recordContinuityPath(superseded.path);
    const relative = path.relative(source.transcriptRoot, sourceFork);
    assertLeaseOwned();
    const copied = safeCopyHistory({
      sourcePath: sourceFork,
      sourceRoot: source.transcriptRoot,
      targetRoot: target.transcriptRoot,
      destinationRelative: relative,
      operationId,
      priorOperationIds,
      afterDestinationPublished: this.dependencies.afterCodexCopyPublished,
    });
    recordContinuityPath(copied.path);
    const targetClient = await this.dependencies.startCodex(target.home);
    try {
      const account = await targetClient.readAccount();
      if (!account.account) throw new MigrationTargetUnavailableError("not-authenticated", "target Codex account is not authenticated");
      assertLeaseOwned();
      const approvalPolicy = profile.permissionMode && ["never", "on-request", "untrusted"].includes(profile.permissionMode)
        ? profile.permissionMode
        : null;
      const resumed = await targetClient.resumeThread(fork.id, {
        path: copied.path,
        cwd: profile.cwd,
        model: profile.model,
        effort: profile.effort,
        fast: profile.fast,
        approvalPolicy,
        sandbox: launchProfileCodexSandbox(profile),
      });
      if (resumed.id !== fork.id) throw new Error("target Codex resume returned another thread");
      if (profile.title) await targetClient.setThreadName(fork.id, profile.title);
      if (profile.goal?.objective) await targetClient.setThreadGoal(fork.id, profile.goal.objective, profile.goal.status);
      const verified = await targetClient.readThread(fork.id);
      if (verified.id !== fork.id) throw new Error("target Codex history verification failed");
    } finally { targetClient.close(); }
    return {
      operationId,
      nativeId: fork.id,
      path: copied.path,
      continuityPaths: [sourceFork, copied.path],
      historyHash: copied.hash,
      host: { kind: "codex-app-server", identity: fork.id, epoch: 1, verifiedAt: this.dependencies.now() },
    };
  }
}
