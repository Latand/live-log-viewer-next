import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { statePath } from "@/lib/configDir";
import { procBackend } from "@/lib/proc";

const LOCK_ATTEMPTS = 2_000;
const LOCK_WAIT_MS = 5;
const LOCK_STALE_MS = 30_000;
const REVISION_VERSION = 1;

type LockOwner = { pid: number; startIdentity: string | null; token: string };
type TransactionContext = { active: boolean; revision: number };
const transactionContext = new AsyncLocalStorage<TransactionContext>();

function sleep(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function ownerIsStale(filename: string): boolean {
  try {
    const owner = JSON.parse(fs.readFileSync(filename, "utf8")) as Partial<LockOwner>;
    if (typeof owner.pid === "number" && Number.isInteger(owner.pid) && owner.pid > 0) {
      if (!procBackend.pidAlive(owner.pid)) return true;
      if (typeof owner.startIdentity !== "string") return false;
      const currentIdentity = procBackend.processIdentity(owner.pid);
      return currentIdentity !== null && currentIdentity !== owner.startIdentity;
    }
    return Date.now() - fs.statSync(filename).mtimeMs > LOCK_STALE_MS;
  } catch {
    try { return Date.now() - fs.statSync(filename).mtimeMs > LOCK_STALE_MS; }
    catch { return false; }
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

function writeRevision(expected: number): void {
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

function acquire(): { context: TransactionContext; release(): void } {
  const lock = statePath("account-selection.lock");
  const queue = `${lock}.queue`;
  fs.mkdirSync(queue, { recursive: true, mode: 0o700 });
  const owner: LockOwner = { pid: process.pid, startIdentity: procBackend.processIdentity(process.pid), token: crypto.randomUUID() };
  const ticket = path.join(queue, `${String(Date.now()).padStart(16, "0")}-${process.pid}-${crypto.randomUUID()}.json`);
  fs.writeFileSync(ticket, JSON.stringify(owner), { encoding: "utf8", flag: "wx", mode: 0o600 });
  try {
    for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
      const liveTickets: string[] = [];
      for (const entry of fs.readdirSync(queue).filter((candidate) => candidate.endsWith(".json")).sort()) {
        const candidate = path.join(queue, entry);
        if (ownerIsStale(candidate)) {
          fs.rmSync(candidate, { force: true });
          continue;
        }
        if (fs.existsSync(candidate)) liveTickets.push(candidate);
      }
      if (liveTickets[0] !== ticket) {
        sleep(LOCK_WAIT_MS);
        continue;
      }
      let descriptor: number;
      try {
        descriptor = fs.openSync(lock, "wx", 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (ownerIsStale(lock)) fs.rmSync(lock, { force: true });
        sleep(LOCK_WAIT_MS);
        continue;
      }
      try {
        fs.writeFileSync(descriptor, JSON.stringify(owner), "utf8");
        fs.fsyncSync(descriptor);
      } catch (error) {
        fs.closeSync(descriptor);
        fs.rmSync(lock, { force: true });
        throw error;
      }
      const context = { active: true, revision: readRevision() };
      return {
        context,
        release() {
          context.active = false;
          fs.closeSync(descriptor);
          removeIfOwned(lock, owner.token);
          removeIfOwned(ticket, owner.token);
        },
      };
    }
    throw new Error("account mutation is busy; retry shortly");
  } catch (error) {
    removeIfOwned(ticket, owner.token);
    throw error;
  }
}

export function withAccountMutationLock<T>(operation: () => T): T {
  const inherited = transactionContext.getStore();
  if (inherited?.active) return operation();
  const transaction = acquire();
  try {
    const result = transactionContext.run(transaction.context, operation);
    writeRevision(transaction.context.revision);
    return result;
  } finally {
    transaction.release();
  }
}

export async function withAccountMutationLockAsync<T>(operation: () => Promise<T>): Promise<T> {
  const inherited = transactionContext.getStore();
  if (inherited?.active) return operation();
  const transaction = acquire();
  try {
    const result = await transactionContext.run(transaction.context, operation);
    writeRevision(transaction.context.revision);
    return result;
  } finally {
    transaction.release();
  }
}

export function accountMutationRevision(): number {
  return readRevision();
}
