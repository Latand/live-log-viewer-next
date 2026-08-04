import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { statePath } from "@/lib/configDir";
import { procBackend } from "@/lib/proc";

const ASYNC_LOCK_ATTEMPTS = 2_000;
const LOCK_WAIT_MS = 5;
const LOCK_STALE_MS = 30_000;
/* No waiter legitimately queues for this long (the async path gives up after
   ~ASYNC_LOCK_ATTEMPTS * LOCK_WAIT_MS), so a ticket this old is leaked no
   matter what its pid looks like. Bounds the queue even when pid reuse makes
   a dead owner look alive. */
const TICKET_MAX_AGE_MS = 600_000;
const HEARTBEAT_MS = 10_000;
const REVISION_VERSION = 1;

type LockOwner = { pid: number; startIdentity: string | null; ns: string | null; token: string };
type TransactionContext = { active: boolean; revision: number };
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
  constructor(message = "account mutation is busy; retry shortly") {
    super(message);
    this.name = "AccountMutationBusyError";
  }
}

function releaseLocal(): void {
  const next = localWaiters.shift();
  if (next) next();
  else runtime.localHeld = false;
}

function acquireLocalSync(): () => void {
  if (runtime.localHeld) throw new AccountMutationBusyError("account mutation is busy in this process; retry shortly");
  runtime.localHeld = true;
  return releaseLocal;
}

async function acquireLocalAsync(): Promise<() => void> {
  if (runtime.localHeld) await new Promise<void>((resolve) => localWaiters.push(resolve));
  else runtime.localHeld = true;
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

function readRevision(): number {
  try {
    const value = JSON.parse(fs.readFileSync(statePath("account-mutation-revision.json"), "utf8")) as { version?: unknown; revision?: unknown };
    return value.version === REVISION_VERSION && Number.isSafeInteger(value.revision) && (value.revision as number) >= 0
      ? value.revision as number
      : 0;
  } catch {
    return 0;
  }
}

function advanceRevision(expected: number): void {
  const filename = statePath("account-mutation-revision.json");
  const current = readRevision();
  if (current !== expected) throw new Error("account mutation revision fence changed while locked");
  const temporary = `${filename}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(temporary, JSON.stringify({ version: REVISION_VERSION, revision: expected + 1 }) + "\n", { mode: 0o600 });
    const descriptor = fs.openSync(temporary, "r");
    try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
    fs.renameSync(temporary, filename);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function createPendingLock(): PendingLock {
  const lock = statePath("account-selection.lock");
  const queue = `${lock}.queue`;
  fs.mkdirSync(queue, { recursive: true, mode: 0o700 });
  const owner: LockOwner = { pid: process.pid, startIdentity: procBackend.processIdentity(process.pid), ns: ownNamespace, token: crypto.randomUUID() };
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
    fs.writeFileSync(descriptor, JSON.stringify(pending.owner), "utf8");
    fs.fsyncSync(descriptor);
  } catch (error) {
    fs.closeSync(descriptor);
    fs.rmSync(pending.lock, { force: true });
    throw error;
  }
  const context = { active: true, revision: readRevision() };
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

function acquire(): AcquiredLock {
  const release = acquireLocalSync();
  let pending: PendingLock | null = null;
  try {
    pending = createPendingLock();
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

async function acquireAsync(): Promise<AcquiredLock> {
  const release = await acquireLocalAsync();
  let pending: PendingLock | null = null;
  try {
    pending = createPendingLock();
    let heartbeatAt = Date.now();
    for (let attempt = 0; attempt < ASYNC_LOCK_ATTEMPTS; attempt += 1) {
      const acquired = tryAcquireFile(pending);
      if (acquired) return attachLocalRelease(acquired, release);
      if (Date.now() - heartbeatAt >= HEARTBEAT_MS) {
        heartbeatAt = Date.now();
        refreshTicket(pending);
      }
      await delay(LOCK_WAIT_MS);
    }
    throw new Error("account mutation is busy; retry shortly");
  } catch (error) {
    if (pending) removeIfOwned(pending.ticket, pending.owner.token);
    release();
    throw error;
  }
}

function admitTransaction(context: TransactionContext): void {
  // Revision admission completes before any durable business write can commit.
  advanceRevision(context.revision);
  context.revision += 1;
}

export function withAccountMutationLock<T>(operation: () => T): T {
  const inherited = transactionContext.getStore();
  if (inherited?.active) return operation();
  const transaction = acquire();
  try {
    admitTransaction(transaction.context);
    return transactionContext.run(transaction.context, operation);
  } finally {
    transaction.release();
  }
}

export async function withAccountMutationLockAsync<T>(operation: () => Promise<T>): Promise<T> {
  const inherited = transactionContext.getStore();
  if (inherited?.active) return operation();
  const transaction = await acquireAsync();
  try {
    admitTransaction(transaction.context);
    return await transactionContext.run(transaction.context, operation);
  } finally {
    transaction.release();
  }
}

/** Exposes durable transaction admission progress to interprocess tests. */
export function accountMutationRevisionForTests(): number {
  return readRevision();
}
