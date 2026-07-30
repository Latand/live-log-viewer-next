import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { statePath } from "@/lib/configDir";
import { PIPELINE_ACTIONS } from "@/lib/pipelines/types";
import { procBackend } from "@/lib/proc";
import {
  MAX_SCOPE_PATHS, MAX_SNAPSHOT_CHARS_PER_CONVERSATION, MAX_SNAPSHOT_LAST_MESSAGES, VIEW_RESOLUTIONS, VIEW_SCOPE_KINDS,
} from "@/lib/view/types";

import type { McpToolPolicy } from "./toolAllowlist";

export const MCP_SERVER_NAME = "viewer";

export const MCP_TOOL_NAMES = [
  "spawn_agent",
  "send_message",
  "create_task",
  "update_task",
  "create_pipeline",
  "pipeline_action",
  "link_task_to_pipeline",
  "list_conversations",
  "get_conversation",
  "deploy_exact_sha",
  "get_pipeline",
  "board_snapshot",
  "list_flows",
  "get_flow",
  "flow_action",
  "list_pipelines",
  "conversation_action",
  "operator_snapshot",
  "list_tasks",
  "get_task",
  "deployment_status",
  "resources",
  "conversation_migration",
  "agent_activity",
  "lifecycle_events",
  "request_attention",
  "bridge_report",
  "bridge_directive",
  "get_orchestrator",
  "create_orchestrator",
  "send_message_to_orchestrator",
  "rotate_orchestrator",
] as const;

export type McpToolName = typeof MCP_TOOL_NAMES[number];
type ReceiptRetention = "bounded" | "durable";

const MUTATING_MCP_TOOL_NAMES = new Set<McpToolName>([
  "spawn_agent",
  "send_message",
  "create_task",
  "update_task",
  "create_pipeline",
  "pipeline_action",
  "link_task_to_pipeline",
  "deploy_exact_sha",
  "flow_action",
  "conversation_action",
  "conversation_migration",
  /* Digest polls advance a durable relay cursor, so their receipts must
     survive the MCP process: a replayed clientRequestId has to return the same
     relay rather than skip past events the caller never saw. */
  "lifecycle_events",
  /* Reads liveness, but appends the stalls and exits it finds to the same
     durable journal — for exactly the reason `lifecycle_events` is here, so it
     is classified the same way rather than looking read-only by name. */
  "agent_activity",
  "request_attention",
  /* Appends to the durable bridge log, so a replayed clientRequestId must return
     the original receipt rather than append the report a second time. */
  "bridge_report",
  /* Delivers an instruction to the manager. Its own derived id is what makes a
     retry idempotent, and the receipt must outlive the MCP process for that. */
  "bridge_directive",
  /* Designation, delivery and rotation are durable side effects: a replayed
     clientRequestId must return the original receipt, never designate, spawn
     or deliver a second time. get_orchestrator is a read and stays bounded. */
  "create_orchestrator",
  "send_message_to_orchestrator",
  "rotate_orchestrator",
]);

export type McpToolArgs = Record<string, unknown> & { clientRequestId?: unknown };
export type McpToolPayload = Record<string, unknown>;
export type McpToolBinding = (args: McpToolArgs) => Promise<McpToolPayload>;
export type McpToolBindings = Record<McpToolName, McpToolBinding>;

export type McpToolSuccess = McpToolPayload & {
  ok: true;
  toolName: McpToolName;
  clientRequestId: string;
  replayed: boolean;
};

export type McpToolFailure = {
  ok: false;
  toolName: string;
  clientRequestId: string | null;
  replayed: boolean;
  error: string;
  code: string;
  retryable: boolean;
  /** Structured evidence a binding attached to its refusal, so an agent gets the
      same payload an HTTP caller does instead of only the prose message. */
  details?: McpToolPayload;
};

/** Thrown by a binding that refuses with machine-readable evidence. */
export class McpToolRefusal extends Error {
  constructor(message: string, readonly details: McpToolPayload) {
    super(message);
    this.name = "McpToolRefusal";
  }
}

export type McpToolResult = McpToolSuccess | McpToolFailure;

type Receipt = {
  digest: string;
  result?: McpToolResult;
};

export type ReceiptClaim =
  | { kind: "fresh" }
  | { kind: "pending" }
  | { kind: "replay"; result: McpToolResult }
  | { kind: "conflict" };

export interface McpReceiptStore {
  claim(key: string, digest: string, retention: ReceiptRetention): ReceiptClaim | Promise<ReceiptClaim>;
  complete(key: string, digest: string, result: McpToolResult, retention: ReceiptRetention): void | Promise<void>;
}

export class MemoryMcpReceiptStore implements McpReceiptStore {
  private readonly receipts = new Map<string, Receipt>();

  claim(key: string, digest: string): ReceiptClaim {
    const receipt = this.receipts.get(key);
    if (!receipt) {
      this.receipts.set(key, { digest });
      return { kind: "fresh" };
    }
    if (receipt.digest !== digest) return { kind: "conflict" };
    return receipt.result ? { kind: "replay", result: receipt.result } : { kind: "pending" };
  }

  complete(key: string, digest: string, result: McpToolResult): void {
    const receipt = this.receipts.get(key);
    if (!receipt || receipt.digest !== digest) throw new Error("MCP receipt ownership changed");
    this.receipts.set(key, { digest, result });
  }
}

type ReceiptFile = {
  version: 2;
  readReceipts: Record<string, Receipt>;
  mutationReceipts: Record<string, Receipt>;
};

const FILE_RECEIPT_CAP = 500;
const LOCK_WAIT_MS = 5_000;
const LOCK_STALE_MS = 30_000;
type ReceiptLockOwner = { pid: number; startIdentity: string | null; token: string };
type ReceiptLockIdentity = { dev: number; ino: number };
type ReceiptLockObservation = {
  identity: ReceiptLockIdentity;
  mtimeMs: number;
  owner: ReceiptLockOwner | null;
  token: string | null;
};
type ReceiptRecoveryOwner = ReceiptLockOwner & {
  version: 1;
  epoch: number;
  targetDev: number;
  targetIno: number;
  targetToken: string | null;
};
type ReceiptRecoveryClaim = {
  owner: ReceiptRecoveryOwner;
  ownerPath: string;
};
type ReceiptRecoveryOwnerEntry = {
  owner: ReceiptRecoveryOwner;
  ownerPath: string;
};
type ReceiptRecoveryOwnerScan =
  | { kind: "owners"; entries: ReceiptRecoveryOwnerEntry[] }
  | { kind: "retry" };
type ReceiptRecoveryAttempt = "removed" | "blocked" | "retry";
type ReceiptRecoveryNamespaceState = "clear" | "blocked" | "retry";
type PendingRecoveryOwner = {
  pid: number;
  startIdentityTag: string | null;
};

// Append-only epochs provide one retirement owner without replacing a live
// claim. A successor publishes the next epoch only after the current owner dies.
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function receiptKeyParts(key: string): { toolName: McpToolName; requestId: string } | null {
  const separator = key.indexOf(":");
  if (separator <= 0) return null;
  const toolName = key.slice(0, separator);
  const requestId = key.slice(separator + 1);
  if (!(MCP_TOOL_NAMES as readonly string[]).includes(toolName) || !requestId.trim()) return null;
  return { toolName: toolName as McpToolName, requestId };
}

function validReceiptResult(value: unknown, toolName: McpToolName, requestId: string): value is McpToolResult {
  if (!isRecord(value)
    || value.toolName !== toolName
    || value.clientRequestId !== requestId
    || typeof value.replayed !== "boolean") return false;
  if (value.ok === true) return true;
  return value.ok === false
    && typeof value.error === "string"
    && typeof value.code === "string"
    && typeof value.retryable === "boolean";
}

function validateReceiptRecord(
  value: unknown,
  retention?: ReceiptRetention,
): Record<string, Receipt> {
  if (!isRecord(value)) throw new Error("invalid MCP receipt file: receipt collection must be an object");
  const receipts: Record<string, Receipt> = {};
  for (const [key, candidate] of Object.entries(value)) {
    const parts = receiptKeyParts(key);
    if (!parts) throw new Error(`invalid MCP receipt file: invalid receipt key ${JSON.stringify(key)}`);
    if (!isRecord(candidate)
      || !hasExactKeys(candidate, "result" in candidate ? ["digest", "result"] : ["digest"])
      || typeof candidate.digest !== "string"
      || !/^[0-9a-f]{64}$/i.test(candidate.digest)
      || ("result" in candidate && !validReceiptResult(candidate.result, parts.toolName, parts.requestId))) {
      throw new Error(`invalid MCP receipt file: invalid receipt ${JSON.stringify(key)}`);
    }
    const actualRetention: ReceiptRetention = MUTATING_MCP_TOOL_NAMES.has(parts.toolName) ? "durable" : "bounded";
    if (retention && actualRetention !== retention) {
      throw new Error(`invalid MCP receipt file: receipt ${JSON.stringify(key)} is in the wrong collection`);
    }
    receipts[key] = candidate as Receipt;
  }
  return receipts;
}

function readLockMetadata(lockPath: string): { owner: ReceiptLockOwner | null; token: string | null } {
  try {
    const value = JSON.parse(fs.readFileSync(lockPath, "utf8")) as Partial<ReceiptLockOwner>;
    const token = typeof value.token === "string" && value.token ? value.token : null;
    if (!Number.isInteger(value.pid) || (value.pid ?? 0) <= 0
      || !(value.startIdentity === null || typeof value.startIdentity === "string")
      || token === null) return { owner: null, token };
    return { owner: value as ReceiptLockOwner, token };
  } catch {
    return { owner: null, token: null };
  }
}

function sameLock(lockPath: string, identity: ReceiptLockIdentity): boolean {
  try {
    const current = fs.statSync(lockPath);
    return current.dev === identity.dev && current.ino === identity.ino;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function observeLock(lockPath: string): ReceiptLockObservation | null {
  try {
    const before = fs.statSync(lockPath);
    const metadata = readLockMetadata(lockPath);
    const after = fs.statSync(lockPath);
    if (before.dev !== after.dev || before.ino !== after.ino) return null;
    return {
      identity: { dev: after.dev, ino: after.ino },
      mtimeMs: after.mtimeMs,
      ...metadata,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function processOwnerAlive(owner: ReceiptLockOwner): boolean {
  if (!procBackend.pidAlive(owner.pid)) return false;
  if (owner.startIdentity === null) return true;
  const currentIdentity = procBackend.processIdentity(owner.pid);
  return currentIdentity === null || currentIdentity === owner.startIdentity;
}

function staleLock(observation: ReceiptLockObservation): boolean {
  if (observation.owner) return !processOwnerAlive(observation.owner);
  return Date.now() - observation.mtimeMs > LOCK_STALE_MS;
}

function recoveryOwnerPrefix(recoveryPath: string): string {
  return `${recoveryPath}.recovery-owner-`;
}

function waitForRetry(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function recoveryIdentityTag(identity: string | null): string {
  return identity === null
    ? "unknown"
    : crypto.createHash("sha256").update(identity).digest("hex").slice(0, 32);
}

function recoveryTargetTag(token: string | null): string {
  return token === null
    ? "unknown"
    : crypto.createHash("sha256").update(token).digest("hex").slice(0, 32);
}

function readRecoveryOwner(ownerPath: string): ReceiptRecoveryOwner {
  const value = JSON.parse(fs.readFileSync(ownerPath, "utf8")) as unknown;
  if (!isRecord(value)
    || value.version !== 1
    || !Number.isSafeInteger(value.epoch)
    || (value.epoch as number) < 0
    || !Number.isSafeInteger(value.pid)
    || (value.pid as number) <= 0
    || !(value.startIdentity === null || typeof value.startIdentity === "string")
    || typeof value.token !== "string"
    || !value.token
    || !Number.isSafeInteger(value.targetDev)
    || !Number.isSafeInteger(value.targetIno)
    || !(value.targetToken === null || typeof value.targetToken === "string")) {
    throw new Error("invalid MCP receipt recovery owner");
  }
  return value as ReceiptRecoveryOwner;
}

function recoveryOwners(
  recoveryPath: string,
  observation: ReceiptLockObservation,
  deadline: number,
): ReceiptRecoveryOwnerScan {
  if (Date.now() >= deadline) return { kind: "retry" };
  const directory = path.dirname(recoveryPath);
  const prefix = path.basename(recoveryOwnerPrefix(recoveryPath));
  let names: string[];
  try {
    names = fs.readdirSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    try {
      fs.mkdirSync(directory, { recursive: true });
    } catch (mkdirError) {
      if ((mkdirError as NodeJS.ErrnoException).code !== "ENOENT") throw mkdirError;
    }
    return { kind: "retry" };
  }
  const entries: ReceiptRecoveryOwnerEntry[] = [];
  for (const entry of names) {
    if (!entry.startsWith(prefix)) continue;
    const epochText = entry.slice(prefix.length);
    if (!/^(?:0|[1-9][0-9]*)$/.test(epochText)) continue;
    const ownerPath = path.join(directory, entry);
    let owner: ReceiptRecoveryOwner;
    try {
      owner = readRecoveryOwner(ownerPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "retry" };
      throw error;
    }
    if (owner.epoch !== Number(epochText)
      || owner.targetDev !== observation.identity.dev
      || owner.targetIno !== observation.identity.ino
      || owner.targetToken !== observation.token) {
      throw new Error("invalid MCP receipt recovery owner target");
    }
    entries.push({ owner, ownerPath });
  }
  entries.sort((left, right) => left.owner.epoch - right.owner.epoch);
  return { kind: "owners", entries };
}

async function recoveryOwnersUntil(
  recoveryPath: string,
  observation: ReceiptLockObservation,
  deadline: number,
): Promise<ReceiptRecoveryOwnerEntry[] | null> {
  while (Date.now() < deadline) {
    const scan = recoveryOwners(recoveryPath, observation, deadline);
    if (scan.kind === "owners") return scan.entries;
    await waitForRetry(Math.min(10, Math.max(1, deadline - Date.now())));
  }
  return null;
}

function publishRecoveryOwner(
  recoveryPath: string,
  owner: ReceiptRecoveryOwner,
): string | null {
  const ownerPath = `${recoveryOwnerPrefix(recoveryPath)}${owner.epoch}`;
  const temporary = `${ownerPath}.pending-v1-${owner.pid}-${recoveryIdentityTag(owner.startIdentity)}-${recoveryTargetTag(owner.targetToken)}-${owner.token}`;
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, JSON.stringify(owner));
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    try {
      fs.linkSync(temporary, ownerPath);
      return ownerPath;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return null;
      throw error;
    }
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
    try {
      fs.unlinkSync(temporary);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

async function claimRecoveryOwnership(
  recoveryPath: string,
  observation: ReceiptLockObservation,
  deadline: number,
): Promise<ReceiptRecoveryClaim | "blocked" | "retry"> {
  const token = crypto.randomUUID();
  const owners = await recoveryOwnersUntil(recoveryPath, observation, deadline);
  if (!owners) return "retry";
  const current = owners.at(-1)?.owner;
  if (current && processOwnerAlive(current)) return "blocked";
  const owner: ReceiptRecoveryOwner = {
    version: 1,
    epoch: (current?.epoch ?? -1) + 1,
    pid: process.pid,
    startIdentity: procBackend.processIdentity(process.pid),
    token,
    targetDev: observation.identity.dev,
    targetIno: observation.identity.ino,
    targetToken: observation.token,
  };
  const ownerPath = publishRecoveryOwner(recoveryPath, owner);
  return ownerPath ? { owner, ownerPath } : "retry";
}

async function recoveryClaimCurrent(
  recoveryPath: string,
  observation: ReceiptLockObservation,
  claim: ReceiptRecoveryClaim,
  deadline: number,
): Promise<boolean> {
  const owners = await recoveryOwnersUntil(recoveryPath, observation, deadline);
  if (!owners) return false;
  const current = owners.at(-1);
  return current?.owner.token === claim.owner.token && current.ownerPath === claim.ownerPath;
}

function pendingRecoveryOwner(entry: string, prefix: string): PendingRecoveryOwner | null {
  if (!entry.startsWith(prefix)) return null;
  const suffix = entry.slice(prefix.length);
  const current = /^(?:0|[1-9][0-9]*)\.pending-v1-([1-9][0-9]*)-(unknown|[0-9a-f]{32})-(?:unknown|[0-9a-f]{32})-[0-9a-f-]{36}$/i.exec(suffix);
  if (current) {
    const pid = Number(current[1]);
    if (!Number.isSafeInteger(pid)) return null;
    return {
      pid,
      startIdentityTag: current[2] === "unknown" ? null : current[2]!.toLowerCase(),
    };
  }
  const legacy = /^(?:0|[1-9][0-9]*)\.pending-([1-9][0-9]*)-[0-9a-f-]{36}$/i.exec(suffix);
  if (!legacy) return null;
  const pid = Number(legacy[1]);
  return Number.isSafeInteger(pid) ? { pid, startIdentityTag: null } : null;
}

function pendingRecoveryOwnerAlive(owner: PendingRecoveryOwner): boolean {
  if (!procBackend.pidAlive(owner.pid)) return false;
  if (owner.startIdentityTag === null) return true;
  const currentIdentity = procBackend.processIdentity(owner.pid);
  return currentIdentity === null || recoveryIdentityTag(currentIdentity) === owner.startIdentityTag;
}

function removeDeadRecoveryOwnerAliases(
  recoveryPath: string,
): void {
  const directory = path.dirname(recoveryPath);
  const prefix = path.basename(recoveryOwnerPrefix(recoveryPath));
  let entries: string[];
  try {
    entries = fs.readdirSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const owner = pendingRecoveryOwner(entry, prefix);
    if (!owner || pendingRecoveryOwnerAlive(owner)) continue;
    const ownerPath = path.join(directory, entry);
    try {
      fs.unlinkSync(ownerPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function recoveryPathsForLock(lockPath: string): string[] {
  const directory = path.dirname(lockPath);
  const prefix = `${path.basename(lockPath)}.`;
  const marker = ".recovering";
  let entries: string[];
  try {
    entries = fs.readdirSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const paths = new Set<string>();
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue;
    const markerIndex = entry.indexOf(marker, prefix.length);
    if (markerIndex < 0) continue;
    const suffix = entry.slice(markerIndex + marker.length);
    if (suffix && !suffix.startsWith(".recovery-owner-")) continue;
    paths.add(path.join(directory, entry.slice(0, markerIndex + marker.length)));
  }
  return [...paths];
}

function abandonedRecoveryObservation(recoveryPath: string): ReceiptLockObservation | null {
  const linked = observeLock(recoveryPath);
  if (linked) return linked;
  const directory = path.dirname(recoveryPath);
  const prefix = path.basename(recoveryOwnerPrefix(recoveryPath));
  let current: ReceiptRecoveryOwner | null = null;
  let entries: string[];
  try {
    entries = fs.readdirSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue;
    const epochText = entry.slice(prefix.length);
    if (!/^(?:0|[1-9][0-9]*)$/.test(epochText)) continue;
    let owner: ReceiptRecoveryOwner;
    try {
      owner = readRecoveryOwner(path.join(directory, entry));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    if (owner.epoch !== Number(epochText)) throw new Error("invalid MCP receipt recovery owner epoch");
    if (current && (current.targetDev !== owner.targetDev
      || current.targetIno !== owner.targetIno
      || current.targetToken !== owner.targetToken)) {
      throw new Error("invalid MCP receipt recovery owner lineage");
    }
    if (!current || owner.epoch > current.epoch) current = owner;
  }
  if (!current) return null;
  return {
    identity: { dev: current.targetDev, ino: current.targetIno },
    mtimeMs: 0,
    owner: null,
    token: current.targetToken,
  };
}

function lockReferencesObservation(lockPath: string, observation: ReceiptLockObservation): boolean {
  return sameLock(lockPath, observation.identity)
    && readLockMetadata(lockPath).token === observation.token;
}

async function cleanupAbandonedRecoveryArtifacts(
  lockPath: string,
  deadline: number,
): Promise<ReceiptRecoveryNamespaceState> {
  for (const recoveryPath of recoveryPathsForLock(lockPath)) {
    removeDeadRecoveryOwnerAliases(recoveryPath);
    const observation = abandonedRecoveryObservation(recoveryPath);
    if (!observation) {
      if (recoveryPathsForLock(lockPath).includes(recoveryPath)) return "retry";
      continue;
    }
    if (lockReferencesObservation(lockPath, observation)) continue;
    const claim = await claimRecoveryOwnership(recoveryPath, observation, deadline);
    if (claim === "blocked" || claim === "retry") return claim;
    let cleaned = false;
    try {
      if (!await recoveryClaimCurrent(recoveryPath, observation, claim, deadline)
        || lockReferencesObservation(lockPath, observation)) return "retry";
      if (sameLock(recoveryPath, observation.identity)
        && readLockMetadata(recoveryPath).token === observation.token) {
        try {
          fs.unlinkSync(recoveryPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    } finally {
      cleaned = await releaseRecoveryOwnership(recoveryPath, observation, claim, deadline);
    }
    if (!cleaned) return "retry";
  }
  return "clear";
}

async function releaseRecoveryOwnership(
  recoveryPath: string,
  observation: ReceiptLockObservation,
  claim: ReceiptRecoveryClaim,
  deadline: number,
): Promise<boolean> {
  if (!await recoveryClaimCurrent(recoveryPath, observation, claim, deadline)) return false;
  const owners = await recoveryOwnersUntil(recoveryPath, observation, deadline);
  if (!owners) return false;
  for (const { ownerPath } of owners.reverse()) {
    try {
      fs.unlinkSync(ownerPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  removeDeadRecoveryOwnerAliases(recoveryPath);
  return true;
}

async function removeObservedLock(
  lockPath: string,
  observation: ReceiptLockObservation,
  deadline: number,
): Promise<ReceiptRecoveryAttempt> {
  const recoveryPath = `${lockPath}.${observation.identity.dev}-${observation.identity.ino}.recovering`;
  const claim = await claimRecoveryOwnership(recoveryPath, observation, deadline);
  if (claim === "blocked" || claim === "retry") return claim;
  try {
    fs.linkSync(lockPath, recoveryPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return await releaseRecoveryOwnership(recoveryPath, observation, claim, deadline)
        ? "blocked"
        : "retry";
    }
    if (code !== "EEXIST") {
      await releaseRecoveryOwnership(recoveryPath, observation, claim, deadline);
      throw error;
    }
  }
  let outcome: ReceiptRecoveryAttempt = "blocked";
  try {
    const recoveryMetadata = readLockMetadata(recoveryPath);
    if (await recoveryClaimCurrent(recoveryPath, observation, claim, deadline)
      && sameLock(recoveryPath, observation.identity)
      && recoveryMetadata.token === observation.token
      && sameLock(lockPath, observation.identity)
      && readLockMetadata(lockPath).token === observation.token) {
      try {
        fs.unlinkSync(lockPath);
        outcome = "removed";
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  } finally {
    if (sameLock(recoveryPath, observation.identity)
      && readLockMetadata(recoveryPath).token === observation.token) {
      try {
        fs.unlinkSync(recoveryPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    if (!await releaseRecoveryOwnership(recoveryPath, observation, claim, deadline)) {
      outcome = "retry";
    }
  }
  return outcome;
}

async function waitForLockRetry(deadline: number): Promise<void> {
  if (Date.now() >= deadline) throw new Error("MCP receipt store is busy");
  await waitForRetry(Math.min(10, Math.max(1, deadline - Date.now())));
}

async function withFileLock<T>(filePath: string, operation: () => T): Promise<T> {
  const lockPath = `${filePath}.lock`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  const owner: ReceiptLockOwner = {
    pid: process.pid,
    startIdentity: procBackend.processIdentity(process.pid),
    token: crypto.randomUUID(),
  };
  while (true) {
    const namespaceState = await cleanupAbandonedRecoveryArtifacts(lockPath, deadline);
    if (namespaceState !== "clear") {
      await waitForLockRetry(deadline);
      continue;
    }
    try {
      const fd = fs.openSync(lockPath, "wx", 0o600);
      let observation: ReceiptLockObservation | null = null;
      try {
        fs.writeFileSync(fd, JSON.stringify(owner));
        fs.fsyncSync(fd);
        const stat = fs.fstatSync(fd);
        observation = {
          identity: { dev: stat.dev, ino: stat.ino },
          mtimeMs: stat.mtimeMs,
          owner,
          token: owner.token,
        };
        return operation();
      } finally {
        fs.closeSync(fd);
        if (observation) {
          const retirementDeadline = Date.now() + LOCK_WAIT_MS;
          const retired = await removeObservedLock(lockPath, observation, retirementDeadline);
          if (retired === "retry"
            || (retired !== "removed"
              && sameLock(lockPath, observation.identity)
              && readLockMetadata(lockPath).token === observation.token)) {
            throw new Error("MCP receipt lock retirement timed out");
          }
        }
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
      } else if (code !== "EEXIST") {
        throw error;
      }
      const observation = observeLock(lockPath);
      if (observation && staleLock(observation)
        && await removeObservedLock(lockPath, observation, deadline) === "removed") continue;
      await waitForLockRetry(deadline);
    }
  }
}

function readReceiptFile(filePath: string): ReceiptFile {
  let serialized: string;
  try {
    serialized = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 2, readReceipts: {}, mutationReceipts: {} };
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch (error) {
    throw new Error("invalid MCP receipt file: invalid JSON", { cause: error });
  }
  if (!isRecord(parsed) || !Number.isInteger(parsed.version)) {
    throw new Error("invalid MCP receipt file: root must contain an integer version");
  }
  if (parsed.version === 2) {
    if (!hasExactKeys(parsed, ["mutationReceipts", "readReceipts", "version"])) {
      throw new Error("invalid MCP receipt file: invalid v2 members");
    }
    const readReceipts = validateReceiptRecord(parsed.readReceipts, "bounded");
    const mutationReceipts = validateReceiptRecord(parsed.mutationReceipts, "durable");
    if (Object.keys(readReceipts).some((key) => key in mutationReceipts)) {
      throw new Error("invalid MCP receipt file: duplicate receipt key");
    }
    return { version: 2, readReceipts, mutationReceipts };
  }
  if (parsed.version === 1) {
    if (!hasExactKeys(parsed, ["receipts", "version"])) {
      throw new Error("invalid MCP receipt file: invalid v1 members");
    }
    const receipts = validateReceiptRecord(parsed.receipts);
    const readReceipts: Record<string, Receipt> = {};
    const mutationReceipts: Record<string, Receipt> = {};
    for (const [key, receipt] of Object.entries(receipts)) {
      const parts = receiptKeyParts(key)!;
      const target = MUTATING_MCP_TOOL_NAMES.has(parts.toolName) ? mutationReceipts : readReceipts;
      target[key] = receipt;
    }
    return { version: 2, readReceipts, mutationReceipts };
  }
  throw new Error(`unsupported MCP receipt file version: ${String(parsed.version)}`);
}

function writeReceiptFile(filePath: string, state: ReceiptFile): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(temporary, JSON.stringify(state, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, filePath);
}

export class FileMcpReceiptStore implements McpReceiptStore {
  constructor(private readonly filePath: string) {}

  async claim(key: string, digest: string, retention: ReceiptRetention): Promise<ReceiptClaim> {
    return withFileLock(this.filePath, () => {
      const state = readReceiptFile(this.filePath);
      const receipt = state.mutationReceipts[key] ?? state.readReceipts[key];
      if (receipt) {
        if (receipt.digest !== digest) return { kind: "conflict" };
        return receipt.result ? { kind: "replay", result: receipt.result } : { kind: "pending" };
      }
      const target = retention === "durable" ? state.mutationReceipts : state.readReceipts;
      target[key] = { digest };
      const keys = Object.keys(state.readReceipts);
      for (const expired of keys.slice(0, Math.max(0, keys.length - FILE_RECEIPT_CAP))) delete state.readReceipts[expired];
      writeReceiptFile(this.filePath, state);
      return { kind: "fresh" };
    });
  }

  async complete(key: string, digest: string, result: McpToolResult, retention: ReceiptRetention): Promise<void> {
    await withFileLock(this.filePath, () => {
      const state = readReceiptFile(this.filePath);
      const receipt = state.mutationReceipts[key] ?? state.readReceipts[key];
      if (!receipt || receipt.digest !== digest) throw new Error("MCP receipt ownership changed");
      if (retention === "durable") {
        delete state.readReceipts[key];
        state.mutationReceipts[key] = { digest, result };
      } else if (state.mutationReceipts[key]) {
        state.mutationReceipts[key] = { digest, result };
      } else {
        state.readReceipts[key] = { digest, result };
      }
      writeReceiptFile(this.filePath, state);
    });
  }
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => [key, stable(child)]));
}

function requestDigest(toolName: McpToolName, args: McpToolArgs): string {
  return crypto.createHash("sha256").update(JSON.stringify(stable({ toolName, args }))).digest("hex");
}

function clientRequestId(args: McpToolArgs): string | null {
  return typeof args.clientRequestId === "string" && args.clientRequestId.trim() ? args.clientRequestId.trim() : null;
}

function failure(
  toolName: string,
  requestId: string | null,
  code: string,
  error: string,
  retryable: boolean,
  replayed = false,
  details?: McpToolPayload,
): McpToolFailure {
  return { ok: false, toolName, clientRequestId: requestId, replayed, error, code, retryable, ...(details ? { details } : {}) };
}

export interface McpToolService {
  callTool(toolName: string, args: McpToolArgs): Promise<McpToolResult>;
}

export function createMcpToolService(
  bindings: McpToolBindings,
  receipts: McpReceiptStore,
  /** #691 §6: the per-identity fence. Absent means "no fence", which is what every
      existing caller of this factory means and gets. */
  policy?: McpToolPolicy,
): McpToolService {
  const inFlight = new Map<string, { digest: string; result: Promise<McpToolResult> }>();
  return {
    async callTool(toolName, args) {
      if (!(MCP_TOOL_NAMES as readonly string[]).includes(toolName)) {
        return failure(toolName, clientRequestId(args), "unknown_tool", `Unknown viewer tool: ${toolName}`, false);
      }
      const typedTool = toolName as McpToolName;
      const retention: ReceiptRetention = MUTATING_MCP_TOOL_NAMES.has(typedTool) ? "durable" : "bounded";
      const requestId = clientRequestId(args);
      if (!requestId) return failure(toolName, null, "invalid_request", "clientRequestId is required", false);

      /* Refused before the receipt is claimed, on purpose. A refusal is a
         property of who is calling, not of the operation, so it must not burn the
         clientRequestId — the same call becomes legitimate the moment the operator
         grants the tool, and a spent receipt would answer it with a stale no. */
      const verdict = policy?.permit(typedTool, args);
      if (verdict && !verdict.allowed) {
        return failure(typedTool, requestId, verdict.code, verdict.error, false);
      }

      const digest = requestDigest(typedTool, args);
      const key = `${typedTool}:${requestId}`;
      const active = inFlight.get(key);
      if (active) {
        if (active.digest !== digest) {
          return failure(toolName, requestId, "idempotency_conflict", "clientRequestId was already used with different arguments", false, true);
        }
        return { ...await active.result, replayed: true };
      }
      const result = (async (): Promise<McpToolResult> => {
        const claim = await receipts.claim(key, digest, retention);
        if (claim.kind === "conflict") {
          return failure(toolName, requestId, "idempotency_conflict", "clientRequestId was already used with different arguments", false, true);
        }
        if (claim.kind === "pending") {
          return failure(toolName, requestId, "call_interrupted", "The previous MCP process ended before this call completed", true, true);
        }
        if (claim.kind === "replay") return { ...claim.result, replayed: true };
        let settled: McpToolResult;
        try {
          const payload = await bindings[typedTool](args);
          settled = { ...payload, ok: true, toolName: typedTool, clientRequestId: requestId, replayed: false };
        } catch (error) {
          settled = failure(
            typedTool,
            requestId,
            "tool_failed",
            error instanceof Error ? error.message : String(error),
            true,
            false,
            error instanceof McpToolRefusal ? error.details : undefined,
          );
        }
        await receipts.complete(key, digest, settled, retention);
        return settled;
      })();
      inFlight.set(key, { digest, result });
      try {
        return await result;
      } finally {
        if (inFlight.get(key)?.result === result) inFlight.delete(key);
      }
    },
  };
}

const TOOL_DESCRIPTIONS: Record<McpToolName, string> = {
  spawn_agent: "Create a Viewer-managed agent conversation and return its durable conversation and launch ids.",
  send_message: "Deliver a message to a Viewer conversation through its registered runtime host.",
  create_task: "Create a durable board task.",
  update_task: "Update a durable board task.",
  create_pipeline: "Create a Viewer pipeline through the pipeline engine.",
  pipeline_action: "Apply a supported action to an existing pipeline.",
  link_task_to_pipeline: "Attach a board task to a conversation owned by a pipeline.",
  list_conversations: "List scanned Viewer conversations with durable ids and transcript paths.",
  get_conversation: "Read a conversation summary and its recent messages and tools.",
  deploy_exact_sha: "Deploy one full commit SHA. Requires confirm=deploy AND the bridge confirmation the user authorized (bridgeRef + bridgeNonce from the gateway's trailer); one confirmation authorizes one SHA once.",
  get_pipeline: "Read one pipeline by durable id.",
  board_snapshot: "Read a bounded, redacted snapshot of the Viewer board and durable placement.",
  list_flows: "List durable implement-review flows.",
  get_flow: "Read one implement-review flow by durable id.",
  flow_action: "Apply a supported action to an implement-review flow.",
  list_pipelines: "List durable pipelines.",
  conversation_action: "Interrupt, kill, resume, compact, or answer a dialog for a Viewer conversation.",
  operator_snapshot: "Read the bounded, secret-redacted Viewer state currently visible to the operator.",
  list_tasks: "List durable board tasks.",
  get_task: "Read one durable board task.",
  deployment_status: "Read Viewer deployment or runtime operation status, or list recent deployments.",
  resources: "Read system and Viewer-owned agent resource usage.",
  conversation_migration: "Reseat, retry, or roll back a conversation account migration.",
  agent_activity: "Read agent liveness: last transcript record, turn state, whether the host is alive or gone, and how long a stalled conversation has been silent.",
  lifecycle_events: "Query the durable lifecycle event journal by lineage and cursor, or poll a bounded relay digest of what changed since the last one.",
  request_attention: "Move the operator's active Viewer to a typed target immediately — no confirmation prompt. The request is durably attributed to the calling session, and the operator keeps a one-action Return control that restores exactly where they were.",
  bridge_report: "Append one bounded report to the durable bridge log for the voice gateway to relay. Callable from any session; the origin is labeled server-side, a non-orchestrator report is visibly attributed to its own session, and only the designated orchestrator may carry a confirmation_request.",
  bridge_directive: "Relay the user's intent to the designated manager. The recipient and the delivery id are derived server-side, so a retry of the same root turn is one instruction, never two.",
  get_orchestrator: "Read a project's designated orchestrator: designation, health and activity, model and prompt version, transcript size, message/tool/compaction counts, context usage against its model's configured window (clearly labelled when estimated), predecessor lineage, and a bounded rotation recommendation — STRONGLY_RECOMMEND_ROTATION once usage reaches the configured threshold. Words only: it never rotates, creates, or interrupts anything itself.",
  create_orchestrator: "Create a project's orchestrator: atomically spawn it, designate it as the project's selected orchestrator, and deliver the approved versioned mandate (editable). Idempotent by clientRequestId.",
  send_message_to_orchestrator: "Deliver a message to the project's selected orchestrator, resolved server-side. A dead selected conversation is resumed; with none designated, one is created first and then delivered to. Idempotent by clientRequestId.",
  rotate_orchestrator: "Explicitly hand a project's orchestrator seat to a fresh successor: bounded handoff (predecessor transcript reference, open tasks, optional notes), atomic designation switch, manager-authority-only revocation of the predecessor, bidirectional lineage. Never triggered automatically.",
};

const clientRequestIdSchema = z.string().min(1).describe("Stable idempotency key for this logical call.");
const entityIdSchema = z.string().min(1);

export const TOOL_INPUT_SCHEMAS: Record<McpToolName, z.ZodObject> = {
  spawn_agent: z.object({
    clientRequestId: clientRequestIdSchema,
    cwd: z.string().min(1).describe("Existing working directory for the new agent."),
    "prompt": z.string().describe("First instruction sent to the agent."),
    engine: z.enum(["claude", "codex"]).optional(),
    model: z.string().optional(),
    effort: z.string().optional(),
    role: z.string().optional(),
    roleParams: z.record(z.string(), z.unknown()).optional(),
    reviews: z.string().optional(),
    parentConversationId: z.string().optional(),
    project: z.string().optional(),
    allowSubagents: z.boolean().optional(),
    mcpServers: z.array(z.string().regex(/^[^\s\u0000-\u001f\u007f]{1,128}$/u))
      .optional()
      .describe("Per-spawn MCP server allowlist, resolved server-side. Only servers the Viewer may grant are accepted; any other name is refused outright, never silently trimmed. Viewer is always included. The grant is then decided by the new session's origin — a delegated launch, which every role-preset spawn is, receives the Viewer baseline whatever it lists here — so this can narrow the surface, never widen it."),
    images: z.array(z.unknown()).optional(),
  }).passthrough(),
  send_message: z.object({
    clientRequestId: clientRequestIdSchema,
    conversationId: z.string().optional(),
    transcriptPath: z.string().optional(),
    text: z.string().min(1),
  }).passthrough(),
  create_task: z.object({
    clientRequestId: clientRequestIdSchema,
    project: z.string().min(1),
    text: z.string().min(1),
    placement: z.enum(["pinned", "unplaced"]).optional(),
    dueAt: z.string().optional(),
    dueTz: z.string().optional(),
    attachments: z.array(z.unknown()).optional(),
  }).passthrough(),
  update_task: z.object({
    clientRequestId: clientRequestIdSchema,
    taskId: entityIdSchema,
    text: z.string().optional(),
    status: z.enum(["inbox", "assigned", "blocked", "done"]).optional(),
    placement: z.enum(["pinned", "unplaced"]).optional(),
    dueAt: z.string().nullable().optional(),
    dueTz: z.string().nullable().optional(),
  }).passthrough(),
  create_pipeline: z.object({
    clientRequestId: clientRequestIdSchema,
    task: z.string().min(1),
    spec: z.string().optional(),
    repoDir: z.string().min(1),
    baseBranch: z.string().optional(),
    baseRef: z.string().optional(),
    stages: z.array(z.record(z.string(), z.unknown())),
    src: z.string().optional(),
    autoStart: z.boolean().optional(),
  }).passthrough(),
  pipeline_action: z.object({
    clientRequestId: clientRequestIdSchema,
    pipelineId: entityIdSchema,
    /* #774: was `z.string().min(1)` while the route admitted a fixed set. */
    action: z.enum(PIPELINE_ACTIONS),
  }).passthrough(),
  link_task_to_pipeline: z.object({
    clientRequestId: clientRequestIdSchema,
    taskId: entityIdSchema,
    pipelineId: entityIdSchema,
  }).passthrough(),
  list_conversations: z.object({
    clientRequestId: clientRequestIdSchema,
    project: z.string().optional(),
    query: z.string().optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }).passthrough(),
  get_conversation: z.object({
    clientRequestId: clientRequestIdSchema,
    conversationId: z.string().optional(),
    transcriptPath: z.string().optional(),
    maxRecords: z.number().int().min(1).max(500).optional(),
  }).passthrough(),
  deploy_exact_sha: z.object({
    clientRequestId: clientRequestIdSchema,
    revision: z.string().regex(/^[0-9a-f]{40}$/i),
    confirm: z.literal("deploy"),
    /* #691 §4: the user's spoken yes, relayed by the gateway. Required — a deploy
       issued without one has bypassed the only gate between a spoken yes and
       production. */
    bridgeRef: z.number().int().positive().describe("seq of the confirmation_request report the user answered."),
    bridgeNonce: z.string().min(1).describe("Single-use nonce from that report's trailer. Verified against SHA and expiry, then spent."),
  }).passthrough(),
  get_pipeline: z.object({
    clientRequestId: clientRequestIdSchema,
    pipelineId: entityIdSchema,
  }).passthrough(),
  board_snapshot: z.object({
    clientRequestId: clientRequestIdSchema,
    project: z.string().optional(),
    activity: z.enum(["live", "stalled", "recent", "idle"]).optional(),
    liveOnly: z.boolean().optional(),
    limit: z.number().int().min(1).max(200).optional(),
  }).passthrough(),
  list_flows: z.object({
    clientRequestId: clientRequestIdSchema,
    project: z.string().optional(),
    state: z.string().optional(),
    includeClosed: z.boolean().optional(),
    limit: z.number().int().min(1).max(200).optional(),
  }).passthrough(),
  get_flow: z.object({
    clientRequestId: clientRequestIdSchema,
    flowId: entityIdSchema,
  }).passthrough(),
  flow_action: z.object({
    clientRequestId: clientRequestIdSchema,
    flowId: entityIdSchema,
    action: z.enum(["pause", "resume", "set-mode", "advance", "retry-round", "cancel-round", "set-round-limit", "extend", "another-round", "set-roles", "close"]),
    mode: z.enum(["auto", "manual"]).optional(),
    rounds: z.number().int().min(0).max(50).optional(),
    note: z.string().optional(),
    roles: z.record(z.string(), z.unknown()).optional(),
  }).passthrough(),
  list_pipelines: z.object({
    clientRequestId: clientRequestIdSchema,
    project: z.string().optional(),
    state: z.string().optional(),
    includeClosed: z.boolean().optional(),
    limit: z.number().int().min(1).max(200).optional(),
  }).passthrough(),
  conversation_action: z.object({
    clientRequestId: clientRequestIdSchema,
    conversationId: z.string().optional(),
    transcriptPath: z.string().optional(),
    action: z.enum(["interrupt", "kill", "resume", "compact", "dialog-key"]),
    key: z.enum(["1", "2", "3", "4", "5", "6", "7", "8", "9", "Tab", "Enter", "Escape"]).optional(),
    label: z.string().optional(),
    question: z.string().optional(),
  }).passthrough(),
  /* #774: these nested objects were `z.record(z.string(), z.unknown())`, so the
     published schema said "any object" while `validateSnapshotRequest` admitted
     an exact key set — 119 calls in ten days were rejected for a guessed key the
     caller had no way to look up. `.strict()` keeps an unknown key a loud
     rejection; plain `z.object` would silently strip it, which trades a wrong
     answer for a wasted round trip. */
  operator_snapshot: z.object({
    clientRequestId: clientRequestIdSchema,
    schemaVersion: z.literal(1).optional(),
    view: z.object({
      id: z.string().optional(),
      deviceId: z.string().optional(),
      resolution: z.enum(VIEW_RESOLUTIONS).optional(),
    }).strict().optional(),
    scope: z.object({
      kind: z.enum(VIEW_SCOPE_KINDS),
      paths: z.array(z.string()).max(MAX_SCOPE_PATHS).optional().describe("Required for kind=paths, rejected otherwise."),
    }).strict().optional(),
    text: z.object({
      include: z.boolean().optional(),
      lastMessages: z.number().int().min(1).max(MAX_SNAPSHOT_LAST_MESSAGES).optional(),
      maxCharsPerConversation: z.number().int().min(1).max(MAX_SNAPSHOT_CHARS_PER_CONVERSATION).optional(),
    }).strict().optional(),
    caller: z.object({
      pid: z.number().int().min(1).optional(),
      transcriptPath: z.string().optional(),
    }).strict().optional(),
  }).passthrough(),
  list_tasks: z.object({
    clientRequestId: clientRequestIdSchema,
    project: z.string().optional(),
    status: z.enum(["inbox", "assigned", "blocked", "done"]).optional(),
    placement: z.enum(["pinned", "unplaced"]).optional(),
    limit: z.number().int().min(1).max(200).optional(),
  }).passthrough(),
  get_task: z.object({
    clientRequestId: clientRequestIdSchema,
    taskId: entityIdSchema,
  }).passthrough(),
  deployment_status: z.object({
    clientRequestId: clientRequestIdSchema,
    deploymentId: z.string().min(1).optional(),
    operationId: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }).passthrough(),
  resources: z.object({
    clientRequestId: clientRequestIdSchema,
    fresh: z.boolean().optional(),
  }).passthrough(),
  conversation_migration: z.object({
    clientRequestId: clientRequestIdSchema,
    conversationId: z.string().min(1),
    action: z.enum(["reseat", "retry", "rollback"]),
    expectedRevision: z.number().int().min(0).optional(),
    transcriptPath: z.string().optional(),
  }).passthrough(),
  agent_activity: z.object({
    clientRequestId: clientRequestIdSchema,
    conversationId: z.string().optional(),
    transcriptPath: z.string().optional(),
    project: z.string().optional(),
    liveOnly: z.boolean().optional(),
    stallAfterMs: z.number().int().min(1_000).max(6 * 60 * 60_000).optional()
      .describe("Silence under a live host that counts as a stall. A dead host over an open turn is always stalled."),
    limit: z.number().int().min(1).max(200).optional(),
  }).passthrough(),
  lifecycle_events: z.object({
    clientRequestId: clientRequestIdSchema,
    mode: z.enum(["query", "digest"]).optional().describe('"query" reads the journal; "digest" polls the bounded relay.'),
    project: z.string().optional(),
    pipelineId: z.string().optional(),
    conversationId: z.string().optional(),
    stageId: z.string().optional(),
    type: z.string().optional(),
    afterSeq: z.number().int().min(0).optional().describe("Exclusive journal cursor for mode=query."),
    limit: z.number().int().min(1).max(200).optional(),
    subscriberId: z.string().optional().describe("Durable digest cursor owner; required for mode=digest."),
    maxItems: z.number().int().min(1).max(25).optional(),
    acknowledge: z.boolean().optional().describe("false polls the digest without advancing the cursor."),
  }).passthrough(),
  request_attention: z.object({
    clientRequestId: clientRequestIdSchema,
    target: z.record(z.string(), z.unknown()).describe("Typed focus target: conversation | pipeline | stage | flowRound | task | draft | region | point."),
    reason: z.string().min(1).describe("One operator-safe sentence saying why it is worth looking at. Never the target's contents."),
    intent: z.enum(["show", "open"]).optional().describe("show frames and highlights; open also opens the target's own surface. Default show."),
    zoom: z.enum(["inspect", "situate"]).optional(),
    contextLabel: z.string().optional().describe("Named in the spoken sentence but never navigated to."),
    project: z.string().optional().describe("Required only for a target the server cannot attribute on its own (a board draft)."),
  }).passthrough(),
  bridge_report: z.object({
    clientRequestId: clientRequestIdSchema,
    key: z.string().min(1).describe("Stable identity of this report. The same key always yields one log entry, so a retry after a host death is a no-op."),
    class: z.enum(["status", "completed", "failed", "blocked", "review_verdict", "question", "confirmation_request"]),
    body: z.string().min(1).describe("Short prose for the gateway to relay. Bounded to 2 KB and secret-redacted at write. Never transcript payloads or raw tool output."),
    correlatesDirective: z.string().optional().describe("clientRequestId of the directive this answers."),
    confirmation: z.object({
      sha: z.string().regex(/^[0-9a-f]{40}$/).describe("Full lowercase 40-hex commit SHA this authorization is for."),
      expiresMinutes: z.number().int().positive().max(60).optional(),
    }).optional().describe("confirmation_request only, designated orchestrator only: mints the single-use nonce the gateway must echo back before a deploy."),
  }).passthrough(),
  bridge_directive: z.object({
    clientRequestId: clientRequestIdSchema,
    rootTurnId: z.string().regex(/^[A-Za-z0-9_.:-]+$/).describe("The realtime turn this instruction came from. The delivery id derives from it, so a retry must reuse the same value."),
    utterance: z.number().int().min(0).describe("Index of this instruction within that turn, from 0."),
    instruction: z.string().min(1).describe("What the user asked for, in plain words. No board state, no tool output."),
    project: z.string().optional().describe("Route to THIS project's designated orchestrator (validated seat). Absent: routes to the orchestrator of the calling voice session's own canonical project."),
    ref: z.number().int().positive().optional().describe("seq of the report this answers, when it answers one."),
    nonce: z.string().optional().describe("With sha: the deploy authorization the user just gave aloud."),
    sha: z.string().regex(/^[0-9a-f]{40}$/).optional(),
  }).passthrough(),
  get_orchestrator: z.object({
    clientRequestId: clientRequestIdSchema,
    project: z.string().min(1).describe("Project key whose designated orchestrator to report on."),
  }).passthrough(),
  create_orchestrator: z.object({
    clientRequestId: clientRequestIdSchema,
    project: z.string().min(1).describe("Project key this orchestrator will own."),
    mandate: z.string().optional().describe("Edited mandate text; defaults to the approved versioned orchestrator prompt."),
    cwd: z.string().optional().describe("Working directory; defaults to the Viewer's own checkout."),
    engine: z.enum(["claude", "codex"]).optional(),
    model: z.string().optional(),
    effort: z.string().optional(),
    accountId: z.string().optional(),
  }).passthrough(),
  send_message_to_orchestrator: z.object({
    clientRequestId: clientRequestIdSchema,
    project: z.string().min(1).describe("Project whose selected orchestrator receives the message."),
    text: z.string().min(1).describe("The message. The recipient is resolved server-side; a dead session is resumed, a missing one created first."),
  }).passthrough(),
  rotate_orchestrator: z.object({
    clientRequestId: clientRequestIdSchema,
    project: z.string().min(1).describe("Project whose orchestrator seat rotates to a fresh successor."),
    mandate: z.string().optional().describe("Successor mandate; defaults to the incumbent's current mandate."),
    handoffNotes: z.string().optional().describe("Bounded free-text handoff notes appended for the successor."),
    cwd: z.string().optional(),
    engine: z.enum(["claude", "codex"]).optional(),
    model: z.string().optional(),
    accountId: z.string().optional(),
  }).passthrough(),
};

export function createViewerMcpServer(service: McpToolService): McpServer {
  const server = new McpServer({ name: MCP_SERVER_NAME, version: "1.0.0" }, {
    instructions: "Use clientRequestId on every call. Reuse it only when replaying the same logical operation. deploy_exact_sha requires confirm=deploy.",
  });
  for (const toolName of MCP_TOOL_NAMES) {
    server.registerTool(toolName, {
      description: TOOL_DESCRIPTIONS[toolName],
      inputSchema: TOOL_INPUT_SCHEMAS[toolName],
    }, async (args) => {
      const result = await service.callTool(toolName, args as McpToolArgs);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
        structuredContent: result,
        ...(result.ok ? {} : { isError: true }),
      };
    });
  }
  return server;
}

export async function startViewerMcpServer(): Promise<void> {
  const { admittedMcpHealthProbe, MCP_HEALTH_PROBE_CAPABILITY_ENV } = await import("./healthProbeAdmission");
  const { viewerMcpBindings, viewerMcpToolPolicy } = await import("./bindings");
  const healthProbeCapability = process.env[MCP_HEALTH_PROBE_CAPABILITY_ENV];
  delete process.env[MCP_HEALTH_PROBE_CAPABILITY_ENV];
  const hostHealthProbe = await admittedMcpHealthProbe(healthProbeCapability);
  const service = createMcpToolService(
    viewerMcpBindings(),
    new FileMcpReceiptStore(statePath("mcp-receipts.json")),
    viewerMcpToolPolicy(undefined, hostHealthProbe),
  );
  const server = createViewerMcpServer(service);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
