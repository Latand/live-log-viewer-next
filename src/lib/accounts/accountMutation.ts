import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { statePath } from "@/lib/configDir";
import { procBackend } from "@/lib/proc";

import { readClaudeCredentials } from "./claudeCredentials";

import { accountsCollectionRevision } from "./accountsStore";

export const ACCOUNT_MUTATION_WAIT_MS = 10_000;
export const ACCOUNT_MUTATION_ADMISSION_WAIT_MS = 2_000;
const LOCK_WAIT_MS = 5;
const LOCK_STALE_MS = 30_000;
/* No waiter legitimately queues for this long (the async path gives up after
   ~ACCOUNT_MUTATION_WAIT_MS), so a ticket this old is leaked no
   matter what its pid looks like. Bounds the queue even when pid reuse makes
   a dead owner look alive. */
const TICKET_MAX_AGE_MS = 600_000;
const HEARTBEAT_MS = 10_000;

type LockOwner = { pid: number; startIdentity: string | null; ns: string | null; token: string; holder?: string; acquiredAt?: number };
type TransactionContext = { active: boolean };
type PendingLock = { lock: string; queue: string; owner: LockOwner; ticket: string };
type AcquiredLock = { context: TransactionContext; release(): void };

/* The bundler may duplicate this module across route chunks. Every copy must
   share one transaction context and one local-held flag, or a nested acquire
   in a second copy observes its own process as a foreign lock holder and
   fails instantly with a busy error. */
type MutationRuntime = {
  transactionContext: AsyncLocalStorage<TransactionContext>;
  localWaiters: Array<() => void>;
  localHeld: boolean;
  localHolder?: string;
};
const runtime: MutationRuntime = ((globalThis as unknown as { __llvAccountMutationRuntime?: MutationRuntime }).__llvAccountMutationRuntime ??= {
  transactionContext: new AsyncLocalStorage<TransactionContext>(),
  localWaiters: [],
  localHeld: false,
});
const transactionContext = runtime.transactionContext;
const localWaiters = runtime.localWaiters;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class AccountMutationBusyError extends Error {
  constructor(message?: string, readonly owner: LockHolder = readLockHolder()) {
    super(message ?? busyMessage(owner));
    this.name = "AccountMutationBusyError";
  }
}

export interface AccountMutationOptions {
  holder?: string;
  waitMs?: number;
  /** Request admission name; enables one structured diagnostic on refusal. */
  caller?: string;
}

interface LockHolder {
  operation: string;
  pid: number | null;
  ageMs: number | null;
}

function safeOperation(value: string): string {
  return value.replace(/[^a-zA-Z0-9 .:_-]/g, "").slice(0, 100);
}

function readLockHolder(): LockHolder {
  let fd: number | undefined;
  try {
    fd = fs.openSync(statePath("account-selection.lock"), "r");
    const buffer = Buffer.alloc(2_048);
    const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const owner = JSON.parse(buffer.toString("utf8", 0, bytes)) as Partial<LockOwner>;
    const since = typeof owner.acquiredAt === "number" ? owner.acquiredAt : fs.fstatSync(fd).mtimeMs;
    return {
      operation: typeof owner.holder === "string" ? safeOperation(owner.holder) : "account mutation",
      pid: typeof owner.pid === "number" && Number.isSafeInteger(owner.pid) ? owner.pid : null,
      ageMs: Math.max(0, Math.round(Date.now() - since)),
    };
  } catch {
    return { operation: runtime.localHolder ?? "account mutation queue", pid: runtime.localHeld ? process.pid : null, ageMs: null };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function busyMessage(owner: LockHolder): string {
  return `account mutation is busy; held by ${owner.operation} (pid ${owner.pid ?? "unknown"}, age ${owner.ageMs ?? "unknown"} ms); retry shortly`;
}

function logRefusal(error: unknown, options: AccountMutationOptions, started: number): void {
  if (!(error instanceof AccountMutationBusyError) || !options.caller) return;
  console.warn(JSON.stringify({
    event: "account-mutation-refused",
    caller: safeOperation(options.caller),
    waitMs: Math.round(performance.now() - started),
    holder: error.owner.operation,
    holderPid: error.owner.pid,
    lockAgeMs: error.owner.ageMs,
  }));
}

function holderName(options: AccountMutationOptions): string {
  if (options.holder) return safeOperation(options.holder);
  // Existing synchronous writers get a useful operation name too. Never
  // persist a stack or a caller's filesystem path in the shared owner record.
  const frames = new Error().stack?.split("\n").slice(3) ?? [];
  const frame = frames.find((line) => !line.includes("accountMutation."));
  return frame?.match(/at ([A-Za-z0-9_.$]+)/)?.[1] ?? "account mutation";
}

function releaseLocal(): void {
  const next = localWaiters.shift();
  if (next) next();
  else { runtime.localHeld = false; runtime.localHolder = undefined; }
}

function acquireLocalSync(holder: string): () => void {
  if (runtime.localHeld) throw new AccountMutationBusyError();
  runtime.localHeld = true;
  runtime.localHolder = holder;
  return releaseLocal;
}

async function acquireLocalAsync(deadline: number, holder: string): Promise<() => void> {
  if (runtime.localHeld) {
    await new Promise<void>((resolve, reject) => {
      const wake = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => {
        const index = localWaiters.indexOf(wake);
        if (index >= 0) localWaiters.splice(index, 1);
        reject(new AccountMutationBusyError());
      }, Math.max(0, deadline - performance.now()));
      localWaiters.push(wake);
    });
  } else runtime.localHeld = true;
  runtime.localHolder = holder;
  return releaseLocal;
}

/* The state directory is shared across pid namespaces: the viewer container,
   the runtime-host container, and host-side workers all queue here. A pid is
   only meaningful inside the namespace that wrote it — the containerized Next
   server is pid 12 in every container instance, and host pid 12 is a kernel
   thread with the same start tick, so a dead container's ticket matches a
   live process everywhere and is never reaped, while a live host worker's
   pid does not exist inside the container and its ticket is reaped while it
   still waits. Tickets therefore record the writer's pid-namespace identity;
   pid liveness is trusted only within the same namespace, and everything
   else falls back to heartbeat freshness. */
function selfPidNamespace(): string | null {
  try {
    return fs.readlinkSync("/proc/self/ns/pid");
  } catch {
    return null;
  }
}
const ownNamespace = selfPidNamespace();

function olderThan(filename: string, ageMs: number): boolean {
  try { return Date.now() - fs.statSync(filename).mtimeMs > ageMs; }
  catch { return false; }
}

function ownerIsStale(filename: string, maxAgeMs: number | null = null): boolean {
  if (maxAgeMs !== null && olderThan(filename, maxAgeMs)) return true;
  try {
    const owner = JSON.parse(fs.readFileSync(filename, "utf8")) as Partial<LockOwner>;
    if (typeof owner.pid === "number" && Number.isInteger(owner.pid) && owner.pid > 0) {
      const ownerNamespace = typeof owner.ns === "string" ? owner.ns : null;
      if (ownerNamespace !== ownNamespace) return olderThan(filename, LOCK_STALE_MS);
      if (!procBackend.pidAlive(owner.pid)) return true;
      if (typeof owner.startIdentity !== "string") return false;
      const currentIdentity = procBackend.processIdentity(owner.pid);
      return currentIdentity !== null && currentIdentity !== owner.startIdentity;
    }
    return olderThan(filename, LOCK_STALE_MS);
  } catch {
    return olderThan(filename, LOCK_STALE_MS);
  }
}

function removeIfOwned(filename: string, token: string): void {
  try {
    const owner = JSON.parse(fs.readFileSync(filename, "utf8")) as { token?: unknown };
    if (owner.token === token) fs.rmSync(filename, { force: true });
  } catch { /* ownership already moved */ }
}

function createPendingLock(holder: string): PendingLock {
  const lock = statePath("account-selection.lock");
  const queue = `${lock}.queue`;
  fs.mkdirSync(queue, { recursive: true, mode: 0o700 });
  const owner: LockOwner = { pid: process.pid, startIdentity: procBackend.processIdentity(process.pid), ns: ownNamespace, token: crypto.randomUUID(), holder };
  const ticket = path.join(queue, `${String(Date.now()).padStart(16, "0")}-${process.pid}-${crypto.randomUUID()}.json`);
  fs.writeFileSync(ticket, JSON.stringify(owner), { encoding: "utf8", flag: "wx", mode: 0o600 });
  return { lock, queue, owner, ticket };
}

/* Keeps a waiting ticket or the held lock visibly fresh for peers in other
   pid namespaces, which judge it by mtime alone. */
function touchOwnerFile(filename: string): boolean {
  const now = new Date();
  try {
    fs.utimesSync(filename, now, now);
    return true;
  } catch {
    return false;
  }
}

/* A cross-namespace peer may have reaped a ticket in the window before its
   first heartbeat. The ticket filename is unique to this waiter, so rewriting
   it is safe and restores the original queue position. The lock file gets no
   such rewrite — a reaped lock may already belong to someone else. */
function refreshTicket(pending: PendingLock): void {
  if (touchOwnerFile(pending.ticket)) return;
  try { fs.writeFileSync(pending.ticket, JSON.stringify(pending.owner), { encoding: "utf8", mode: 0o600 }); }
  catch { /* queue directory gone; a later acquisition attempt recreates it */ }
}

function tryAcquireFile(pending: PendingLock): AcquiredLock | null {
  const liveTickets: string[] = [];
  for (const entry of fs.readdirSync(pending.queue).filter((candidate) => candidate.endsWith(".json")).sort()) {
    const candidate = path.join(pending.queue, entry);
    if (candidate !== pending.ticket && ownerIsStale(candidate, TICKET_MAX_AGE_MS)) {
      fs.rmSync(candidate, { force: true });
      continue;
    }
    if (fs.existsSync(candidate)) liveTickets.push(candidate);
  }
  if (liveTickets[0] !== pending.ticket) return null;
  let descriptor: number;
  try {
    descriptor = fs.openSync(pending.lock, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (ownerIsStale(pending.lock)) fs.rmSync(pending.lock, { force: true });
    return null;
  }
  try {
    fs.writeFileSync(descriptor, JSON.stringify({ ...pending.owner, acquiredAt: Date.now() }), "utf8");
    fs.fsyncSync(descriptor);
  } catch (error) {
    fs.closeSync(descriptor);
    fs.rmSync(pending.lock, { force: true });
    throw error;
  }
  const context = { active: true };
  const heartbeat = setInterval(() => touchOwnerFile(pending.lock), HEARTBEAT_MS);
  heartbeat.unref?.();
  return {
    context,
    release() {
      clearInterval(heartbeat);
      context.active = false;
      fs.closeSync(descriptor);
      removeIfOwned(pending.lock, pending.owner.token);
      removeIfOwned(pending.ticket, pending.owner.token);
    },
  };
}

function attachLocalRelease(acquired: AcquiredLock, release: () => void): AcquiredLock {
  return {
    context: acquired.context,
    release() {
      try { acquired.release(); }
      finally { release(); }
    },
  };
}

function acquire(holder: string): AcquiredLock {
  const release = acquireLocalSync(holder);
  let pending: PendingLock | null = null;
  try {
    pending = createPendingLock(holder);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const acquired = tryAcquireFile(pending);
      if (acquired) return attachLocalRelease(acquired, release);
    }
    throw new AccountMutationBusyError();
  } catch (error) {
    if (pending) removeIfOwned(pending.ticket, pending.owner.token);
    release();
    throw error;
  }
}

async function acquireAsync(holder: string, waitMs: number): Promise<AcquiredLock> {
  const deadline = performance.now() + waitMs;
  const release = await acquireLocalAsync(deadline, holder);
  let pending: PendingLock | null = null;
  try {
    pending = createPendingLock(holder);
    let heartbeatAt = Date.now();
    for (;;) {
      const acquired = tryAcquireFile(pending);
      if (acquired) return attachLocalRelease(acquired, release);
      if (Date.now() - heartbeatAt >= HEARTBEAT_MS) {
        heartbeatAt = Date.now();
        refreshTicket(pending);
      }
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw new AccountMutationBusyError();
      await delay(Math.min(LOCK_WAIT_MS, remaining));
    }
  } catch (error) {
    if (pending) removeIfOwned(pending.ticket, pending.owner.token);
    release();
    throw error;
  }
}

/*
 * Transaction admission no longer writes a fence of its own (#1870, slice 7).
 * `account-mutation-revision.json` used to be advanced here, durably, before
 * the business write — two files, and a crash between them left a fence that
 * had moved without the write it admitted. Every account store is now one
 * collection of `state.sqlite`, and its revision IS the mutation revision: a
 * write takes the collection lease, commits under BEGIN IMMEDIATE and advances
 * the revision in that same transaction. A second writer that somehow reached
 * a durable write without this lock is refused by the lease rather than
 * detected after the fact, and a mutation that changes nothing advances
 * nothing, which is what an aligned compatibility sync always wanted to say.
 */
export function withAccountMutationLock<T>(operation: () => T, options: AccountMutationOptions = {}): T {
  const inherited = transactionContext.getStore();
  if (inherited?.active) return operation();
  const started = performance.now();
  let transaction: AcquiredLock;
  try { transaction = acquire(holderName(options)); }
  catch (error) { logRefusal(error, options, started); throw error; }
  try {
    return transactionContext.run(transaction.context, operation);
  } finally {
    transaction.release();
  }
}

export async function withAccountMutationLockAsync<T>(operation: () => T | Promise<T>, options: AccountMutationOptions = {}): Promise<T> {
  const inherited = transactionContext.getStore();
  if (inherited?.active) return operation();
  const started = performance.now();
  let transaction: AcquiredLock;
  try { transaction = await acquireAsync(holderName(options), options.waitMs ?? (options.caller ? ACCOUNT_MUTATION_ADMISSION_WAIT_MS : ACCOUNT_MUTATION_WAIT_MS)); }
  catch (error) { logRefusal(error, options, started); throw error; }
  try {
    return await transactionContext.run(transaction.context, operation);
  } finally {
    transaction.release();
  }
}

/** Durable account mutation progress, for interprocess tests: the `accounts`
    collection revision, which every account write advances with itself. */
export function accountMutationRevisionForTests(): number {
  return accountsCollectionRevision();
}

/** File identity catches reauthentication that does not change the catalog.
    Only metadata is retained; credential contents never enter the registry. */
export function accountProbeIdentity(account: { home: string }): string {
  const files = ["auth.json", ".credentials.json", ".provider-token"].map((name) => {
    try {
      const stat = fs.statSync(path.join(account.home, name), { bigint: true });
      return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String);
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? null : "unreadable";
    }
  });
  return JSON.stringify([account, files]);
}

/** Call outside a mutation lease: macOS may need a Keychain subprocess.
    The digest stays request-local and is never persisted or logged. */
export function claudeProbeCredentialIdentity(home: string, read = readClaudeCredentials): string | null {
  const credential = read(home);
  if (credential.state === "unknown" || credential.state === "unsafe") return null;
  return crypto.createHash("sha256").update(JSON.stringify(credential)).digest("hex");
}

/** Catalog readers can perform startup recovery or query Keychain. Run them
    before the lease, then admit only the revision/credential identity read.
    A concurrent catalog write gets a fresh read outside the lease. */
export async function accountProbeSnapshot<T extends { home: string }>(
  read: () => T,
  options: AccountMutationOptions,
): Promise<{ account: T; identity: string; revision: number }> {
  const deadline = performance.now() + (options.waitMs ?? (options.caller ? ACCOUNT_MUTATION_ADMISSION_WAIT_MS : ACCOUNT_MUTATION_WAIT_MS));
  const remaining = () => ({ ...options, waitMs: Math.max(0, deadline - performance.now()) });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const revision = accountsCollectionRevision();
    let account: T;
    try { account = read(); }
    catch (error) {
      if (!(error instanceof AccountMutationBusyError)) throw error;
      // Startup recovery in a catalog reader can itself require admission.
      // Let its holder finish, then retry the reader outside our lease.
      await withAccountMutationLockAsync(() => undefined, remaining());
      continue;
    }
    const identity = accountProbeIdentity(account);
    const snapshot = await withAccountMutationLockAsync(() => {
      if (revision !== accountsCollectionRevision() || identity !== accountProbeIdentity(account)) return null;
      return { account, identity, revision };
    }, remaining());
    if (snapshot) return snapshot;
  }
  throw new Error("account metadata changed repeatedly during probe admission; retry shortly");
}
