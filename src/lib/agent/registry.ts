import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { statePath } from "@/lib/configDir";

import type { AgentEngine } from "./cli";
import { sessionKeyId, type SessionKey } from "./sessionKey";
import type { ResumePaneRecord } from "@/lib/resumePanesFile";

export type AgentHostStatus = "starting" | "live" | "idle" | "handoff" | "unhosted" | "dead";

export interface ProcessIdentity {
  pid: number;
  startIdentity: string | null;
}

export interface TmuxHostEvidence {
  kind: "tmux";
  endpoint: string;
  server: ProcessIdentity;
  paneId: string;
  panePid: ProcessIdentity;
  windowName: string;
  agent: ProcessIdentity;
  argv: string[];
}

export interface AgentRegistryEntry {
  key: SessionKey;
  artifactPath: string;
  cwd: string;
  accountId: string | null;
  status: AgentHostStatus;
  host: TmuxHostEvidence | null;
  claimEpoch: number;
  claimOwner: string | null;
  pendingAction: "spawn" | "resume" | "handoff" | null;
  updatedAt: string;
}

export interface SpawnReceipt {
  launchId: string;
  engine: AgentEngine;
  cwd: string;
  createdAt: string;
  state: "starting" | "completed" | "failed";
  artifactPath: string | null;
  error: string | null;
}

interface RegistryFile {
  version: 1;
  entries: Record<string, AgentRegistryEntry>;
  receipts: Record<string, SpawnReceipt>;
  importedResumePanes: boolean;
  /** Compatibility evidence only. It never authorizes a pane until the live
      resolver proves server, process, engine, and transcript ownership. */
  legacyResumePanes: Record<string, ResumePaneRecord>;
}

const EMPTY: RegistryFile = { version: 1, entries: {}, receipts: {}, importedResumePanes: false, legacyResumePanes: {} };

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function now(): string {
  return new Date().toISOString();
}

function readFile(filename: string): RegistryFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(filename, "utf8")) as Partial<RegistryFile>;
    if (parsed.version !== 1 || !parsed.entries || !parsed.receipts) return clone(EMPTY);
    return {
      version: 1,
      entries: parsed.entries,
      receipts: parsed.receipts,
      importedResumePanes: parsed.importedResumePanes === true,
      legacyResumePanes: parsed.legacyResumePanes && typeof parsed.legacyResumePanes === "object" ? parsed.legacyResumePanes : {},
    };
  } catch {
    return clone(EMPTY);
  }
}

function writeAtomic(filename: string, value: RegistryFile): void {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temp = `${filename}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const payload = JSON.stringify(value, null, 2) + "\n";
  let fd: number | null = null;
  try {
    fd = fs.openSync(temp, "w", 0o600);
    fs.writeFileSync(fd, payload, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(temp, filename);
    const dir = fs.openSync(path.dirname(filename), "r");
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  } finally {
    if (fd !== null) fs.closeSync(fd);
    try { fs.unlinkSync(temp); } catch { /* rename completed */ }
  }
}

/** Durable source for identity and handoff evidence. The lock directory is
    intentionally separate from in-memory promises, so a Viewer replacement
    cannot leave an imaginary owner behind. */
export class AgentRegistry {
  constructor(readonly filename = statePath("agent-registry.json")) {}

  private mutate<T>(fn: (file: RegistryFile) => T): T {
    const lock = `${this.filename}.write-lock`;
    fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
    let acquired = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        fs.mkdirSync(lock, 0o700);
        acquired = true;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
    }
    if (!acquired) throw new Error("agent registry is busy");
    try {
      const file = readFile(this.filename);
      const result = fn(file);
      writeAtomic(this.filename, file);
      return result;
    } finally {
      fs.rmSync(lock, { recursive: true, force: true });
    }
  }

  snapshot(): RegistryFile { return readFile(this.filename); }

  beginSpawn(engine: AgentEngine, cwd: string): SpawnReceipt {
    return this.mutate((file) => {
      const receipt: SpawnReceipt = { launchId: crypto.randomUUID(), engine, cwd, createdAt: now(), state: "starting", artifactPath: null, error: null };
      file.receipts[receipt.launchId] = receipt;
      return clone(receipt);
    });
  }

  completeSpawn(launchId: string, entry: Omit<AgentRegistryEntry, "updatedAt">): AgentRegistryEntry {
    return this.mutate((file) => {
      const receipt = file.receipts[launchId];
      if (!receipt || receipt.state !== "starting") throw new Error("unknown or completed spawn receipt");
      const full = { ...entry, updatedAt: now() };
      file.entries[sessionKeyId(entry.key)] = full;
      receipt.state = "completed";
      receipt.artifactPath = entry.artifactPath;
      return clone(full);
    });
  }

  failSpawn(launchId: string, error: string): void {
    this.mutate((file) => {
      const receipt = file.receipts[launchId];
      if (receipt && receipt.state === "starting") {
        receipt.state = "failed";
        receipt.error = error;
      }
    });
  }

  upsert(entry: Omit<AgentRegistryEntry, "updatedAt">): AgentRegistryEntry {
    return this.mutate((file) => {
      const full = { ...entry, updatedAt: now() };
      file.entries[sessionKeyId(entry.key)] = full;
      return clone(full);
    });
  }

  markUnhosted(key: SessionKey): void {
    this.mutate((file) => {
      const entry = file.entries[sessionKeyId(key)];
      if (!entry) return;
      entry.host = null;
      entry.status = "unhosted";
      entry.updatedAt = now();
    });
  }

  claim(key: SessionKey, owner: string): AgentRegistryEntry {
    return this.mutate((file) => {
      const entry = file.entries[sessionKeyId(key)];
      if (!entry) throw new Error("agent registry entry is missing");
      if (entry.claimOwner && entry.claimOwner !== owner) throw new Error("agent session is claimed by another operation");
      entry.claimOwner = owner;
      entry.claimEpoch += 1;
      entry.updatedAt = now();
      return clone(entry);
    });
  }

  releaseClaim(key: SessionKey, owner: string): void {
    this.mutate((file) => {
      const entry = file.entries[sessionKeyId(key)];
      if (entry?.claimOwner === owner) {
        entry.claimOwner = null;
        entry.updatedAt = now();
      }
    });
  }

  /** Cross-process operation lock. Stale owners include their process start
      identity and may be recovered by an explicit caller after verification. */
  async withOperationLock<T>(key: SessionKey, owner: ProcessIdentity, fn: () => Promise<T>): Promise<T> {
    const lock = `${this.filename}.locks/${encodeURIComponent(sessionKeyId(key))}`;
    fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
    try {
      fs.mkdirSync(lock, 0o700);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("agent operation is already in progress");
      throw error;
    }
    try {
      fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify(owner), { mode: 0o600 });
      return await fn();
    } finally {
      fs.rmSync(lock, { recursive: true, force: true });
    }
  }

  importResumePanes(records: Map<string, ResumePaneRecord>): void {
    this.mutate((file) => {
      if (file.importedResumePanes) return;
      file.legacyResumePanes = Object.fromEntries(records);
      file.importedResumePanes = true;
    });
  }
}

let registry: AgentRegistry | null = null;
export function agentRegistry(): AgentRegistry {
  registry ??= new AgentRegistry();
  return registry;
}
