import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { Database as BunDatabase } from "bun:sqlite";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { FOCUS_TARGET_SHAPES } from "@/lib/attention/targets";
import { statePath } from "@/lib/configDir";
import { DeadlineExceededError, deadlineSignal } from "@/lib/deadline";
import { DEFAULT_STALL_AFTER_MS } from "@/lib/lifecycle/liveness";
import { PIPELINE_LIST_DEFAULT_LIMIT, PIPELINE_LIST_MAX_LIMIT } from "@/lib/pipelines/listProjection";
import {
  DEFAULT_FAIL_EDGE_ROUNDS,
  MAX_FAIL_EDGE_ROUNDS,
  MAX_PIPELINE_STAGES,
  MAX_STAGE_PROMPT_LENGTH,
  MIN_STARTED_PIPELINE_STAGES,
} from "@/lib/pipelines/limits";
import { PIPELINE_ACTIONS, PIPELINE_DISALLOWED_ROLE_IDS } from "@/lib/pipelines/types";
import { procBackend } from "@/lib/proc";
import { ROLE_IDS, type RoleId } from "@/lib/roles/types";
import { SELECTED_TAIL_MAX_LINES } from "@/lib/selection/resolve";
import {
  MAX_REPLY_LABEL_CHARS, MAX_REPLY_SUGGESTIONS, MAX_REPLY_TEXT_BYTES, MIN_REPLY_SUGGESTIONS,
} from "@/lib/suggestions/types";
import {
  MAX_SCOPE_PATHS, MAX_SNAPSHOT_CHARS_PER_CONVERSATION, MAX_SNAPSHOT_LAST_MESSAGES, MAX_SNAPSHOT_STRING_LENGTH,
  MIN_SNAPSHOT_STRING_LENGTH, VIEW_RESOLUTIONS, VIEW_SCOPE_KINDS,
} from "@/lib/view/types";

import type { McpToolPolicy } from "./toolAllowlist";

export const MCP_SERVER_NAME = "viewer";

export const MCP_TOOL_NAMES = [
  "spawn_agent",
  "send_message",
  "message_receipt",
  "create_task",
  "update_task",
  "create_pipeline",
  "pipeline_action",
  "link_task_to_pipeline",
  "list_conversations",
  "search_transcripts",
  "get_conversation",
  "conversation_deliverability",
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
  "suggest_replies",
  "bridge_report",
  "bridge_directive",
  "get_orchestrator",
  "create_orchestrator",
  "send_message_to_orchestrator",
  "rotate_orchestrator",
  "seat_tick_settings",
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
  /* Writes the conversation's current reply-draft set, which the operator's
     composer reads. The record outlives this process, so a replayed
     clientRequestId must answer from the receipt rather than re-offer drafts
     under a question the operator has since answered. */
  "suggest_replies",
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
  /* Writes a project's durable tick settings when it carries a change (#1275).
     A pure read of the same tool changes nothing, but the receipt has to
     outlive this process either way: a replayed clientRequestId must answer
     with what the first call recorded. */
  "seat_tick_settings",
]);

/**
 * Calls whose binding is idempotent over its own durable state, so a claim the
 * previous process never settled is RECONCILED by re-running the binding
 * rather than answered `call_interrupted` forever (#873 review, finding 3).
 *
 * `request_attention` qualifies because the operation's identity is written on
 * the attention record itself before anything can navigate: the re-run adopts
 * that record — one record, one navigation — waits out the same handoff, and
 * finally settles the durable receipt, so the retry that used to be a
 * permanent dead end becomes the deterministic answer to what actually
 * happened. The digest check above still refuses a same-id call with
 * different arguments.
 *
 * Archive and unarchive qualify at the action level: board hidden placement is
 * content-idempotent, so a retry after the board write converges without
 * another revision. Other conversation actions still require live runtime
 * ownership and remain outside interrupted recovery.
 */
const INTERRUPTED_RECOVERABLE_TOOLS: ReadonlySet<McpToolName> = new Set<McpToolName>([
  "request_attention",
  /* Deliberately NOT here: `suggest_replies`. Its write is idempotent over the
     record, but the record is retired by something outside the call — the
     operator's own answer — so re-running an interrupted write would put the
     drafts back under a question they have already answered. A disposable
     draft is exactly the thing not worth resurrecting: the interrupted call
     answers `call_interrupted`, and the seat offers a fresh set if it still
     wants one. */
]);

function interruptedCallIsRecoverable(toolName: McpToolName, args: McpToolArgs): boolean {
  if (INTERRUPTED_RECOVERABLE_TOOLS.has(toolName)) return true;
  if (toolName !== "conversation_action") return false;
  return args.action === "archive" || args.action === "unarchive";
}

export type McpToolArgs = Record<string, unknown> & { clientRequestId?: unknown };
export type McpToolPayload = Record<string, unknown>;
export interface McpToolCallContext {
  signal?: AbortSignal;
  deadlineAt?: number;
}
export type McpToolBinding = (args: McpToolArgs, context?: McpToolCallContext) => Promise<McpToolPayload>;
export type McpToolBindings = Record<McpToolName, McpToolBinding>;

export interface McpBoundedNumericArg {
  path: readonly string[];
  min: number;
  max: number;
  fallback: number;
  role?: RoleId;
}

/**
 * Agent-facing numeric bounds whose nearest-valid interpretation is harmless.
 *
 * Deliberately absent: flow_action.rounds (operator mutation),
 * operator_snapshot.caller.pid (process identity),
 * conversation_migration.expectedRevision (concurrency identity), and
 * bridge_directive.utterance/ref (durable delivery identity). Those values keep
 * exact validation at the protocol boundary.
 */
export const MCP_BOUNDED_NUMERIC_ARGS: Partial<Record<McpToolName, readonly McpBoundedNumericArg[]>> = {
  spawn_agent: [
    { path: ["roleParams", "maxWorkers"], min: 1, max: 20, fallback: 3, role: "orchestrator" },
    { path: ["roleParams", "parallelN"], min: 1, max: 8, fallback: 1, role: "reviewer" },
  ],
  list_conversations: [
    { path: ["limit"], min: 1, max: 100, fallback: 50 },
  ],
  search_transcripts: [
    { path: ["limit"], min: 1, max: 100, fallback: 20 },
  ],
  get_conversation: [
    { path: ["maxRecords"], min: 1, max: 500, fallback: 100 },
    { path: ["tailLines"], min: 1, max: SELECTED_TAIL_MAX_LINES, fallback: 1 },
  ],
  board_snapshot: [
    { path: ["limit"], min: 1, max: 200, fallback: 100 },
  ],
  list_flows: [
    { path: ["limit"], min: 1, max: 200, fallback: 100 },
  ],
  list_pipelines: [
    { path: ["limit"], min: 1, max: PIPELINE_LIST_MAX_LIMIT, fallback: PIPELINE_LIST_DEFAULT_LIMIT },
  ],
  operator_snapshot: [
    { path: ["text", "lastMessages"], min: 1, max: MAX_SNAPSHOT_LAST_MESSAGES, fallback: 6 },
    { path: ["text", "maxCharsPerConversation"], min: 1, max: MAX_SNAPSHOT_CHARS_PER_CONVERSATION, fallback: 3_000 },
  ],
  list_tasks: [
    { path: ["limit"], min: 1, max: 200, fallback: 100 },
  ],
  deployment_status: [
    { path: ["limit"], min: 1, max: 100, fallback: 25 },
  ],
  agent_activity: [
    { path: ["stallAfterMs"], min: 1_000, max: 6 * 60 * 60_000, fallback: DEFAULT_STALL_AFTER_MS },
    { path: ["limit"], min: 1, max: 200, fallback: 100 },
  ],
  lifecycle_events: [
    { path: ["afterSeq"], min: 0, max: Number.MAX_SAFE_INTEGER, fallback: 0 },
    { path: ["limit"], min: 1, max: 200, fallback: 50 },
    { path: ["maxItems"], min: 1, max: 25, fallback: 10 },
  ],
};

function compareDecimalIntegerToBound(value: string, bound: number): number {
  const unsigned = value.replace(/^[+-]/, "").replace(/^0+/, "") || "0";
  const negative = value.startsWith("-") && unsigned !== "0";
  const boundNegative = bound < 0;
  if (negative !== boundNegative) return negative ? -1 : 1;
  const boundUnsigned = String(Math.abs(bound));
  const magnitude = unsigned.length === boundUnsigned.length
    ? unsigned === boundUnsigned ? 0 : unsigned < boundUnsigned ? -1 : 1
    : unsigned.length < boundUnsigned.length ? -1 : 1;
  return negative ? -magnitude : magnitude;
}

function boundedNumericValue(value: unknown, spec: McpBoundedNumericArg): number {
  if (typeof value === "number" && Number.isInteger(value)) {
    return Math.max(spec.min, Math.min(spec.max, value));
  }
  if (typeof value === "string" && /^[+-]?\d+$/.test(value.trim())) {
    const integer = value.trim();
    if (compareDecimalIntegerToBound(integer, spec.min) < 0) return spec.min;
    if (compareDecimalIntegerToBound(integer, spec.max) > 0) return spec.max;
    return Number(integer);
  }
  if (typeof value === "string"
    && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())) {
    const numeric = Number(value.trim());
    if (numeric === Number.POSITIVE_INFINITY) return spec.max;
    if (numeric === Number.NEGATIVE_INFINITY) return spec.min;
    if (Number.isInteger(numeric)) return Math.max(spec.min, Math.min(spec.max, numeric));
  }
  return Math.max(spec.min, Math.min(spec.max, spec.fallback));
}

function valueAtPath(args: McpToolArgs, pathParts: readonly string[]): unknown {
  let value: unknown = args;
  for (const part of pathParts) {
    if (!isRecord(value)) return undefined;
    value = value[part];
  }
  return value;
}

function setValueAtPath(args: McpToolArgs, pathParts: readonly string[], value: number): void {
  let target: Record<string, unknown> = args;
  for (const part of pathParts.slice(0, -1)) {
    const nested = isRecord(target[part]) ? { ...target[part] } : {};
    target[part] = nested;
    target = nested;
  }
  target[pathParts.at(-1)!] = value;
}

export function normalizeBoundedMcpNumerics(
  toolName: McpToolName,
  args: McpToolArgs,
): { args: McpToolArgs; clamped?: Record<string, number> } {
  const specs = MCP_BOUNDED_NUMERIC_ARGS[toolName];
  if (!specs?.length) return { args };
  const normalized = { ...args };
  const clamped: Record<string, number> = {};
  for (const spec of specs) {
    if (spec.role !== undefined && args.role !== spec.role) continue;
    const input = valueAtPath(args, spec.path);
    if (input === undefined) continue;
    const applied = boundedNumericValue(input, spec);
    setValueAtPath(normalized, spec.path, applied);
    if (typeof input !== "number" || !Object.is(input, applied)) {
      clamped[spec.path.join(".")] = applied;
    }
  }
  return Object.keys(clamped).length ? { args: normalized, clamped } : { args: normalized };
}

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
  | { kind: "pending"; unfinishedAgeMs?: number }
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
const SQLITE_READ_RECEIPT_BYTE_CAP = 8 * 1024 * 1024;
const SQLITE_BOUNDED_PENDING_TTL_MS = 60_000;
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

type StoredSqliteReceipt = {
  digest: string;
  result_json: string | null;
  claimed_at: number;
};

export interface SqliteMcpReceiptStoreOptions {
  legacyFilePath?: string;
  readReceiptCountCap?: number;
  readReceiptByteCap?: number;
  boundedPendingTtlMs?: number;
  now?: () => number;
}

/**
 * Keyed durable receipts for the production MCP server.
 *
 * One row carries one idempotency claim. Reads therefore touch one indexed row;
 * durable mutations survive restarts without sharing a retention budget with
 * large read responses. The legacy JSON import is validated by the same parser
 * as the legacy adapter and committed atomically with its import marker.
 */
export class SqliteMcpReceiptStore implements McpReceiptStore {
  private readonly db: BunDatabase;
  private readonly readReceiptCountCap: number;
  private readonly readReceiptByteCap: number;
  private readonly boundedPendingTtlMs: number;
  private readonly now: () => number;

  constructor(readonly filename: string, options: SqliteMcpReceiptStoreOptions = {}) {
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    const sqlite = process.getBuiltinModule?.("bun:sqlite") as typeof import("bun:sqlite") | undefined;
    if (!sqlite) throw new Error("SQLite MCP receipts require the Bun runtime");
    this.db = new sqlite.Database(filename, { create: true, strict: true });
    this.readReceiptCountCap = Math.max(1, Math.floor(options.readReceiptCountCap ?? FILE_RECEIPT_CAP));
    this.readReceiptByteCap = Math.max(1, Math.floor(options.readReceiptByteCap ?? SQLITE_READ_RECEIPT_BYTE_CAP));
    this.boundedPendingTtlMs = Math.max(1, Math.floor(options.boundedPendingTtlMs ?? SQLITE_BOUNDED_PENDING_TTL_MS));
    this.now = options.now ?? Date.now;
    this.db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA auto_vacuum = INCREMENTAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mcp_receipt_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mcp_receipts (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        receipt_key TEXT NOT NULL UNIQUE,
        digest TEXT NOT NULL,
        retention TEXT NOT NULL CHECK(retention IN ('bounded', 'durable')),
        result_json TEXT,
        storage_bytes INTEGER NOT NULL,
        claimed_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS mcp_receipts_retention_sequence
      ON mcp_receipts(retention, sequence);
    `);
    this.importLegacyFile(options.legacyFilePath);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.pruneBoundedReceipts(this.now());
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* transaction already closed */ }
      throw error;
    }
    this.secureFiles();
  }

  claim(key: string, digest: string, retention: ReceiptRetention): ReceiptClaim {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const now = this.now();
      this.pruneBoundedReceipts(now);
      const receipt = this.db.query<StoredSqliteReceipt, [string]>(`
        SELECT digest, result_json, claimed_at
        FROM mcp_receipts
        WHERE receipt_key = ?
      `).get(key);
      if (receipt) {
        this.db.exec("COMMIT");
        if (receipt.digest !== digest) return { kind: "conflict" };
        if (receipt.result_json === null) {
          return { kind: "pending", unfinishedAgeMs: Math.max(0, now - receipt.claimed_at) };
        }
        return { kind: "replay", result: this.parseResult(key, receipt.result_json) };
      }
      const storageBytes = this.storageBytes(key, digest, null);
      this.db.query<unknown, [string, string, ReceiptRetention, number, number]>(`
        INSERT INTO mcp_receipts(receipt_key, digest, retention, result_json, storage_bytes, claimed_at)
        VALUES (?, ?, ?, NULL, ?, ?)
      `).run(key, digest, retention, storageBytes, now);
      this.pruneBoundedReceipts(now);
      this.db.exec("COMMIT");
      return { kind: "fresh" };
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* transaction already closed */ }
      throw error;
    }
  }

  complete(key: string, digest: string, result: McpToolResult, retention: ReceiptRetention): void {
    const resultJson = JSON.stringify(result);
    const storageBytes = this.storageBytes(key, digest, resultJson);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const receipt = this.db.query<Pick<StoredSqliteReceipt, "digest"> & { retention: ReceiptRetention }, [string]>(`
        SELECT digest, retention
        FROM mcp_receipts
        WHERE receipt_key = ?
      `).get(key);
      if (!receipt || receipt.digest !== digest) throw new Error("MCP receipt ownership changed");
      const effectiveRetention = receipt.retention === "durable" ? "durable" : retention;
      this.db.query<unknown, [ReceiptRetention, string, number, string]>(`
        UPDATE mcp_receipts
        SET retention = ?, result_json = ?, storage_bytes = ?
        WHERE receipt_key = ?
      `).run(effectiveRetention, resultJson, storageBytes, key);
      this.pruneBoundedReceipts(this.now());
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* transaction already closed */ }
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  private importLegacyFile(legacyFilePath: string | undefined): void {
    if (!legacyFilePath || this.meta("legacy_import_v2") === "complete") return;
    let state: ReceiptFile;
    try {
      state = readReceiptFile(legacyFilePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (!fs.existsSync(legacyFilePath)) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const insert = this.db.query<unknown, [string, string, ReceiptRetention, string | null, number, number]>(`
        INSERT OR IGNORE INTO mcp_receipts(
          receipt_key, digest, retention, result_json, storage_bytes, claimed_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `);
      let claimedAt = this.now() - Object.keys(state.readReceipts).length - Object.keys(state.mutationReceipts).length;
      const importCollection = (receipts: Record<string, Receipt>, retention: ReceiptRetention) => {
        for (const [key, receipt] of Object.entries(receipts)) {
          const resultJson = receipt.result === undefined ? null : JSON.stringify(receipt.result);
          insert.run(key, receipt.digest, retention, resultJson, this.storageBytes(key, receipt.digest, resultJson), claimedAt);
          claimedAt += 1;
        }
      };
      importCollection(state.mutationReceipts, "durable");
      importCollection(state.readReceipts, "bounded");
      this.pruneBoundedReceipts(this.now());
      this.db.query<unknown, [string, string]>(`
        INSERT INTO mcp_receipt_meta(key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run("legacy_import_v2", "complete");
      this.db.exec("COMMIT");
      /* The legacy payload can be much larger than the retained read budget.
         Compact once after its one-time import so deleted response pages never
         become the new long-lived database baseline. */
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE); VACUUM;");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* transaction already closed */ }
      throw error;
    }
  }

  private pruneBoundedReceipts(now: number): void {
    /* Bounded reads have a lease longer than the SDK's 30-second call budget.
       A crash cannot strand their claims forever; after the lease, a restart or
       any later receipt transaction removes them before completed replay rows
       are considered for count/byte retention. Durable mutation claims never
       enter this expiry path. */
    this.db.query<unknown, [number]>(`
      DELETE FROM mcp_receipts
      WHERE retention = 'bounded'
        AND result_json IS NULL
        AND claimed_at <= ?
    `).run(now - this.boundedPendingTtlMs);
    this.db.query<unknown, [number]>(`
      DELETE FROM mcp_receipts
      WHERE sequence IN (
        SELECT sequence
        FROM mcp_receipts
        WHERE retention = 'bounded' AND result_json IS NOT NULL
        ORDER BY sequence ASC
        LIMIT MAX(0, (
          SELECT COUNT(*) - ? FROM mcp_receipts WHERE retention = 'bounded'
        ))
      )
    `).run(this.readReceiptCountCap);
    const aggregate = this.db.query<{ storage_bytes: number }, []>(`
      SELECT COALESCE(SUM(storage_bytes), 0) AS storage_bytes
      FROM mcp_receipts
      WHERE retention = 'bounded'
    `).get()?.storage_bytes ?? 0;
    let excessBytes = aggregate - this.readReceiptByteCap;
    if (excessBytes <= 0) return;
    const completed = this.db.query<{ sequence: number; storage_bytes: number }, []>(`
      SELECT sequence, storage_bytes
      FROM mcp_receipts
      WHERE retention = 'bounded' AND result_json IS NOT NULL
      ORDER BY sequence ASC
    `).all();
    const expired: number[] = [];
    for (const receipt of completed) {
      if (excessBytes <= 0) break;
      expired.push(receipt.sequence);
      excessBytes -= receipt.storage_bytes;
    }
    const remove = this.db.query<unknown, [number]>("DELETE FROM mcp_receipts WHERE sequence = ?");
    for (const sequence of expired) remove.run(sequence);
  }

  private parseResult(key: string, serialized: string): McpToolResult {
    let parsed: unknown;
    try {
      parsed = JSON.parse(serialized);
    } catch (error) {
      throw new Error("invalid MCP receipt database result JSON", { cause: error });
    }
    const parts = receiptKeyParts(key);
    if (!parts || !validReceiptResult(parsed, parts.toolName, parts.requestId)) {
      throw new Error("invalid MCP receipt database result");
    }
    return parsed;
  }

  private storageBytes(key: string, digest: string, resultJson: string | null): number {
    return Buffer.byteLength(key) + Buffer.byteLength(digest) + (resultJson === null ? 0 : Buffer.byteLength(resultJson));
  }

  private meta(key: string): string | null {
    return this.db.query<{ value: string }, [string]>("SELECT value FROM mcp_receipt_meta WHERE key = ?").get(key)?.value ?? null;
  }

  private secureFiles(): void {
    for (const target of [this.filename, `${this.filename}-wal`, `${this.filename}-shm`]) {
      try {
        fs.chmodSync(target, 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
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
  callTool(toolName: string, args: McpToolArgs, context?: McpToolCallContext): Promise<McpToolResult>;
}

type McpTimingOutcome = "success" | "failure" | "replay" | "conflict" | "pending" | "deadline" | "cancelled";
type McpTimingPhase = "claim" | "binding" | "completion" | "serialization" | "serviceTotal" | "replay";

interface McpToolTimingSample {
  toolName: McpToolName;
  outcome: McpTimingOutcome;
  phases: Partial<Record<McpTimingPhase, number>>;
  resultSizeBytes?: number;
  deadlineBudgetMs?: number;
  unfinishedAgeMs?: number;
}

export interface McpAggregateMeasure {
  samples: number;
  total: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

export interface McpToolTimingSummary {
  toolName: McpToolName;
  calls: number;
  outcomes: Record<McpTimingOutcome, number>;
  phases: Record<McpTimingPhase, McpAggregateMeasure>;
  resultSizeBytes: McpAggregateMeasure;
  deadline: {
    callsWithDeadline: number;
    exceeded: number;
    budgetMs: McpAggregateMeasure;
  };
  cancellation: { cancelled: number };
  unfinishedAgeMs: McpAggregateMeasure;
}

const TIMING_SAMPLE_CAP = 2_048;

class AggregateMeasure {
  private readonly recent: number[] = [];
  private count = 0;
  private total = 0;
  private maximum = 0;

  add(value: number | undefined): void {
    if (value === undefined || !Number.isFinite(value) || value < 0) return;
    this.count += 1;
    this.total += value;
    this.maximum = Math.max(this.maximum, value);
    if (this.recent.length < TIMING_SAMPLE_CAP) this.recent.push(value);
    else this.recent[(this.count - 1) % TIMING_SAMPLE_CAP] = value;
  }

  snapshot(): McpAggregateMeasure {
    const values = this.recent.toSorted((left, right) => left - right);
    const percentile = (quantile: number) => values.length
      ? values[Math.max(0, Math.ceil(values.length * quantile) - 1)]!
      : 0;
    return {
      samples: this.count,
      total: this.total,
      p50: percentile(0.5),
      p95: percentile(0.95),
      p99: percentile(0.99),
      max: this.maximum,
    };
  }
}

type MutableToolTiming = {
  calls: number;
  outcomes: Record<McpTimingOutcome, number>;
  phases: Record<McpTimingPhase, AggregateMeasure>;
  resultSizeBytes: AggregateMeasure;
  deadlineBudgetMs: AggregateMeasure;
  unfinishedAgeMs: AggregateMeasure;
};

const MCP_TIMING_OUTCOMES: McpTimingOutcome[] = [
  "success", "failure", "replay", "conflict", "pending", "deadline", "cancelled",
];
const MCP_TIMING_PHASES: McpTimingPhase[] = [
  "claim", "binding", "completion", "serialization", "serviceTotal", "replay",
];

function mutableToolTiming(): MutableToolTiming {
  return {
    calls: 0,
    outcomes: Object.fromEntries(MCP_TIMING_OUTCOMES.map((outcome) => [outcome, 0])) as Record<McpTimingOutcome, number>,
    phases: Object.fromEntries(MCP_TIMING_PHASES.map((phase) => [phase, new AggregateMeasure()])) as Record<McpTimingPhase, AggregateMeasure>,
    resultSizeBytes: new AggregateMeasure(),
    deadlineBudgetMs: new AggregateMeasure(),
    unfinishedAgeMs: new AggregateMeasure(),
  };
}

/** Numeric-only per-tool aggregates. No request or response values enter this module. */
export class McpToolTimingAggregate {
  private readonly tools = new Map<McpToolName, MutableToolTiming>(
    MCP_TOOL_NAMES.map((toolName) => [toolName, mutableToolTiming()]),
  );

  observe(sample: McpToolTimingSample): void {
    const timing = this.tools.get(sample.toolName)!;
    timing.calls += 1;
    timing.outcomes[sample.outcome] += 1;
    for (const phase of MCP_TIMING_PHASES) timing.phases[phase].add(sample.phases[phase]);
    timing.resultSizeBytes.add(sample.resultSizeBytes);
    timing.deadlineBudgetMs.add(sample.deadlineBudgetMs);
    timing.unfinishedAgeMs.add(sample.unfinishedAgeMs);
  }

  snapshot(): McpToolTimingSummary[] {
    return MCP_TOOL_NAMES.map((toolName) => {
      const timing = this.tools.get(toolName)!;
      return {
        toolName,
        calls: timing.calls,
        outcomes: { ...timing.outcomes },
        phases: Object.fromEntries(MCP_TIMING_PHASES.map((phase) => [phase, timing.phases[phase].snapshot()])) as Record<McpTimingPhase, McpAggregateMeasure>,
        resultSizeBytes: timing.resultSizeBytes.snapshot(),
        deadline: {
          callsWithDeadline: timing.deadlineBudgetMs.snapshot().samples,
          exceeded: timing.outcomes.deadline,
          budgetMs: timing.deadlineBudgetMs.snapshot(),
        },
        cancellation: { cancelled: timing.outcomes.cancelled },
        unfinishedAgeMs: timing.unfinishedAgeMs.snapshot(),
      };
    });
  }
}

const productionMcpToolTimings = new McpToolTimingAggregate();

export function mcpToolTimingSnapshot(): McpToolTimingSummary[] {
  return productionMcpToolTimings.snapshot();
}

export interface McpToolServiceOptions {
  timings?: McpToolTimingAggregate;
}

export function createMcpToolService(
  bindings: McpToolBindings,
  receipts: McpReceiptStore,
  /** #691 §6: the per-identity fence. Absent means "no fence", which is what every
      existing caller of this factory means and gets. */
  policy?: McpToolPolicy,
  options: McpToolServiceOptions = {},
): McpToolService {
  const inFlight = new Map<string, { digest: string; result: Promise<McpToolResult> }>();
  return {
    async callTool(toolName, args, context = {}) {
      if (!(MCP_TOOL_NAMES as readonly string[]).includes(toolName)) {
        return failure(toolName, clientRequestId(args), "unknown_tool", `Unknown viewer tool: ${toolName}`, false);
      }
      const typedTool = toolName as McpToolName;
      const normalized = normalizeBoundedMcpNumerics(typedTool, args);
      const effectiveArgs = normalized.args;
      const callStartedAt = performance.now();
      const phaseDurations: Partial<Record<McpTimingPhase, number>> = {};
      const deadlineBudgetMs = context.deadlineAt === undefined
        ? undefined
        : Math.max(0, context.deadlineAt - Date.now());
      const finish = (result: McpToolResult, outcome: McpTimingOutcome, unfinishedAgeMs?: number): McpToolResult => {
        const serializationStartedAt = performance.now();
        let resultSizeBytes: number | undefined;
        try {
          resultSizeBytes = Buffer.byteLength(JSON.stringify(result));
        } catch { /* timing must never change a tool outcome */ }
        phaseDurations.serialization = performance.now() - serializationStartedAt;
        phaseDurations.serviceTotal = serializationStartedAt - callStartedAt;
        options.timings?.observe({
          toolName: typedTool,
          outcome,
          phases: phaseDurations,
          resultSizeBytes,
          deadlineBudgetMs,
          unfinishedAgeMs,
        });
        return result;
      };
      const retention: ReceiptRetention = MUTATING_MCP_TOOL_NAMES.has(typedTool) ? "durable" : "bounded";
      const requestId = clientRequestId(effectiveArgs);
      if (!requestId) return finish(failure(toolName, null, "invalid_request", "clientRequestId is required", false), "failure");

      /* Refused before the receipt is claimed, on purpose. A refusal is a
         property of who is calling, not of the operation, so it must not burn the
         clientRequestId — the same call becomes legitimate the moment the operator
         grants the tool, and a spent receipt would answer it with a stale no. */
      const verdict = policy?.permit(typedTool, effectiveArgs);
      if (verdict && !verdict.allowed) {
        return finish(failure(typedTool, requestId, verdict.code, verdict.error, false), "failure");
      }

      const digest = requestDigest(typedTool, effectiveArgs);
      const key = `${typedTool}:${requestId}`;
      const active = inFlight.get(key);
      if (active) {
        if (active.digest !== digest) {
          return finish(failure(toolName, requestId, "idempotency_conflict", "clientRequestId was already used with different arguments", false, true), "conflict");
        }
        const replayStartedAt = performance.now();
        const replayed = { ...await active.result, replayed: true };
        phaseDurations.replay = performance.now() - replayStartedAt;
        return finish(replayed, "replay");
      }
      let outcome: McpTimingOutcome = "failure";
      let unfinishedAgeMs: number | undefined;
      const result = (async (): Promise<McpToolResult> => {
        const claimStartedAt = performance.now();
        const claim = await receipts.claim(key, digest, retention);
        phaseDurations.claim = performance.now() - claimStartedAt;
        if (claim.kind === "conflict") {
          outcome = "conflict";
          return failure(toolName, requestId, "idempotency_conflict", "clientRequestId was already used with different arguments", false, true);
        }
        if (claim.kind === "pending" && !interruptedCallIsRecoverable(typedTool, effectiveArgs)) {
          outcome = "pending";
          unfinishedAgeMs = claim.unfinishedAgeMs;
          return failure(toolName, requestId, "call_interrupted", "The previous MCP process ended before this call completed", true, true);
        }
        if (claim.kind === "replay") {
          const replayStartedAt = performance.now();
          const replayed = { ...claim.result, replayed: true };
          phaseDurations.replay = performance.now() - replayStartedAt;
          outcome = "replay";
          return replayed;
        }
        let settled: McpToolResult;
        const bindingStartedAt = performance.now();
        try {
          const payload = await bindings[typedTool](effectiveArgs, context);
          settled = {
            ...payload,
            ...(normalized.clamped ? { clamped: normalized.clamped } : {}),
            ok: true,
            toolName: typedTool,
            clientRequestId: requestId,
            replayed: false,
          };
          outcome = "success";
        } catch (error) {
          const reason = context.signal?.aborted ? context.signal.reason : error;
          outcome = reason instanceof DeadlineExceededError
            ? "deadline"
            : context.signal?.aborted
              ? "cancelled"
              : "failure";
          settled = failure(
            typedTool,
            requestId,
            "tool_failed",
            error instanceof Error ? error.message : String(error),
            true,
            false,
            error instanceof McpToolRefusal ? error.details : undefined,
          );
        } finally {
          phaseDurations.binding = performance.now() - bindingStartedAt;
        }
        /* #863: a caller that has already given up gets no receipt row. The
           completion write serializes the whole result and persists it, which on
           a large read is exactly the cost the deadline existed to stop — and it
           would burn the clientRequestId on an answer nobody received, so the
           obvious retry would replay a stale timeout forever. The claim is left
           unsettled instead, which is what "the previous call did not finish"
           already means: a retry gets `call_interrupted`, retryable, and the
           bounded lease sweeps the row so the id comes back.

           Bounded reads only. `pruneBoundedReceipts` deletes an unsettled claim
           exclusively for `retention = 'bounded'` — durable mutation claims never
           enter that expiry path by design — so skipping the write for a
           mutating tool would strand a permanent `result_json IS NULL` row and
           make its clientRequestId answer `call_interrupted` forever. A mutation
           that was abandoned still settles, as it did before.

           Every outcome that produced a real answer still writes, so idempotent
           replay of a completed call is untouched. */
        if (retention === "bounded" && (outcome === "deadline" || outcome === "cancelled")) return settled;
        const completionStartedAt = performance.now();
        await receipts.complete(key, digest, settled, retention);
        phaseDurations.completion = performance.now() - completionStartedAt;
        return settled;
      })();
      inFlight.set(key, { digest, result });
      try {
        return finish(await result, outcome, unfinishedAgeMs);
      } finally {
        if (inFlight.get(key)?.result === result) inFlight.delete(key);
      }
    },
  };
}

const TOOL_DESCRIPTIONS: Record<McpToolName, string> = {
  spawn_agent: "Create a Viewer-managed agent conversation and return its durable conversation and launch ids.",
  send_message: [
    "Deliver a message to a Viewer conversation through its registered runtime host.",
    "A reclaimed conversation host is resumed after the instruction is durably reserved, and the delivery queue keeps that single operation through publication.",
    "The answer reports acceptance. `outcome` is `held`, `queued` or `delivering` until the delivery record settles, and `settled` says whether arrival is established. Hold `operationId` and ask `message_receipt` what became of it — never treat an unsettled outcome as terminal, and never re-send an unsettled operation, because a send whose fate is unknown can be delivered twice.",
  ].join(" "),
  message_receipt: [
    "Answer what became of one accepted send, by the `operationId` `send_message` returned.",
    "`state` is `delivered`, `failed` or `in-flight`, read from the durable delivery record and reconciled against the delivery journal's current answer rather than from what the send call reported at the time. Asking is also what ENDS an accepted send that was dropped: `in-flight` means it is still progressing — the recipient may be mid-turn — and asking again later reaches `delivered` or `failed`.",
    "`resend` says what is safe to do next: `not-needed` (it arrived), `safe` (the record proves it never executed and it is fenced, so the same instruction may be sent again), or `verify-first` (`duplicateRisk` is true — delivery began, or nothing proves it did not, so check the recipient before sending again).",
    "A resend is a NEW `send_message` under a NEW `clientRequestId`: the settled operation is fenced, so repeating the original `clientRequestId` replays that settled answer instead of delivering anything.",
  ].join(" "),
  create_task: "Create a durable board task.",
  update_task: "Update a durable board task.",
  create_pipeline: [
    "Create a Viewer pipeline through the pipeline engine: a stage graph of agent conversations run in one worktree.",
    "Stages are a graph, not a list: each stage names its pass successor with `next` (a stage id, or null to end the chain), and a run stage may name a fail successor with `onFail`. `next` defaults to null, so a plan whose stages never set it is a set of disconnected stages, not a chain.",
    "A review-loop stage reviews the session of the run stage that reaches it, so it must be pass-reachable from a run stage through `next` edges — array order alone reaches nothing. review-loop stages are always read-only, may not define `onFail`, and take their engine/model/effort from their role (the registry reviewer preset runs on Codex) unless the stage overrides them.",
    "Runtime overrides (engine, model, effort, access) belong on the stage; `role` carries only `roleId` and its `params`.",
    "autoStart:false creates a draft the operator starts from the board; a draft that pins `baseBranch` must also pass `baseRef` (a draft is not provisioned, so the caller resolves the SHA).",
    "`src` is the creator's transcript path: a native ~/.claude/projects path is normalized to the shared Claude transcript store when the mirrored file exists there.",
    "An invalid call is answered once with every violated constraint, each naming its field and expected shape.",
  ].join(" "),
  pipeline_action: "Apply a supported action to an existing pipeline.",
  link_task_to_pipeline: "Attach a board task to a conversation owned by a pipeline.",
  list_conversations: "List scanned Viewer conversations with durable ids and transcript paths.",
  search_transcripts: "Search indexed user and assistant message bodies across every scanned transcript store. Returns match snippets with speaker, timestamp, transcript path and byte offset; project is optional, and empty pages include corpus statistics. Queries never read transcript files.",
  get_conversation: "Read a conversation summary and its recent messages and tools. With tailLines, conversationId or selectedContext uses the bounded identity path, while transcriptPath uses the validated pinned reader; both return a bounded raw tail without a corpus scan.",
  conversation_deliverability: "Read whether one conversation currently has a deliverable host from the durable registry record. An accepted resume stays synchronizing until the current generation records a claimed process; reclaimed, synchronizing, superseded, and unknown are distinct conditions.",
  deploy_exact_sha: "Deploy one full commit SHA. The designated orchestrator decides when to deploy and calls this directly; authority is the server-attributed designated seat, and nobody asks the operator for a confirmation, a phrase, or a SHA. Idempotent by clientRequestId; deployments serialize at the runtime host.",
  get_pipeline: "Read one pipeline by durable id.",
  board_snapshot: "Read a bounded, redacted snapshot of the Viewer board, durable placement, and the selected project's hidden conversation count.",
  list_flows: "List durable implement-review flows.",
  get_flow: "Read one implement-review flow by durable id.",
  flow_action: "Apply a supported action to an implement-review flow.",
  list_pipelines: "List durable pipelines as bounded board cards: id, task, project, branch/worktree, state and stateDetail, cursor stage, task links, and a per-stage summary (role, engine, attempt count, latest attempt's state and verdict). Deliberately carries no bodies — the spec, stage prompts, role scaffolds and every attempt's input/output transcript are read with get_pipeline, which still returns the whole record. hasSpec tells you a spec exists; long free text is truncated.",
  conversation_action: "Control or archive Viewer conversations. interrupt, kill, resume, compact, and dialog-key accept one conversation by id, transcript path, or selected-card reference. archive and unarchive also accept up to 100 targets; they update the existing board hidden placement without requiring a live host or readable transcript. Each archive or unarchive target expands to every registered generation path while preserving an exact transcriptPath and a spawn:<launchId> placeholder. Each per-target outcome lists the paths actually written by this call; already-archived means the full expanded set was already hidden. Archive execution requires the operator root or a designated orchestrator seat and retains conversation_action's existing cross-project reach.",
  operator_snapshot: "Read the bounded, secret-redacted Viewer state currently visible to the operator.",
  list_tasks: "List durable board tasks.",
  get_task: "Read one durable board task.",
  deployment_status: "Read Viewer deployment or runtime operation status, or list recent deployments.",
  resources: "Read system and Viewer-owned agent resource usage.",
  conversation_migration: "Reseat, retry, or roll back a conversation account migration.",
  agent_activity: "Read agent liveness: last transcript record, turn state, host state, provider-throttle retry time, and confirmed stalls.",
  lifecycle_events: "Query the durable lifecycle event journal by lineage and cursor, or poll a bounded relay digest of what changed since the last one.",
  request_attention: [
    "Move the operator's one active Viewer to a typed target immediately and verify the arrival — no confirmation prompt, no pending offer. Execution is gated on server-derived authority: only the operator's root/gateway session or the target project's designated orchestrator seat may direct it; workers and unidentified callers are refused (ATTENTION_NOT_PERMITTED) with nothing recorded. The latest-interaction active view is chosen deterministically (down to the one executing browser tab); success is returned only after that view's camera/focus actually landed, and a missing view, lost target, or timeout is an explicit bounded failure. Durably attributed to the calling session, idempotent by clientRequestId across restarts, and the operator keeps a one-action Return control that restores exactly where they were.",
    `Targets are typed and discriminated by \`kind\`, one shape per kind: ${FOCUS_TARGET_SHAPES.map((shape) => `${shape.kind} — ${shape.example}`).join("; ")}.`,
    "A conversation target takes either its durable conversationId (resolved server-side to that conversation's current transcript, and the form to prefer because it survives resume and migration) or that transcript's path.",
    "A draft target also needs the top-level project argument; region and point accept intent \"show\" only. A rejected target names the kind it read and the fields that kind expects.",
  ].join(" "),
  suggest_replies: [
    "Offer the operator ready-made replies to your own message: 1\u20136 short drafts that render as pills under your latest turn in the dock and the board's conversation pane. Tapping one drops its text into their composer for editing \u2014 the Viewer never sends it, and nothing here decides anything.",
    "Call it after every message that asks the operator something or proposes a course of action, with 2\u20134 short, distinct drafts written in the operator's own language. The set REPLACES whatever you offered last for that conversation, and the operator's next message clears it.",
    "Authority is the same as request_attention's, and for the same reason \u2014 this writes into the surface they are answering in: the operator's own session or a designated orchestrator seat. A worker or unidentified caller is refused (SUGGEST_REPLIES_NOT_PERMITTED) with nothing recorded.",
    "The drafts always land under your OWN message: conversationId defaults to your conversation, and naming any other one is refused. To offer drafts elsewhere, ask that conversation's own session to offer them.",
  ].join(" "),
  bridge_report: "Append one bounded report to the durable bridge log for the voice gateway to relay. Callable from any session; the origin is labeled server-side and a non-orchestrator report is visibly attributed to its own session.",
  bridge_directive: "Relay the user's intent to the designated manager. The recipient and the delivery id are derived server-side, so a retry of the same root turn is one instruction, never two.",
  get_orchestrator: "Read a project's designated orchestrator: designation, health and activity, model and prompt version, transcript size, message/tool/compaction counts, context usage against its model's configured window (clearly labelled when estimated), predecessor lineage, and a bounded rotation recommendation — STRONGLY_RECOMMEND_ROTATION once usage reaches the configured threshold. Words only: it never rotates, creates, or interrupts anything itself.",
  create_orchestrator: "Create a project's orchestrator or adopt one eligible registered conversation: designate it as the project's selected orchestrator and deliver the approved versioned mandate (editable). Idempotent by clientRequestId.",
  send_message_to_orchestrator: "Deliver a message to the project's selected orchestrator, resolved server-side. A dead selected conversation is resumed; with none designated, one is created first and then delivered to. Idempotent by clientRequestId. Like send_message, the answer reports acceptance rather than arrival: ask message_receipt what became of the operationId.",
  seat_tick_settings: [
    "Read — and change — one project's seat tick: whether the Viewer wakes that project's seat at all, how often, and what your own monitor prompt tells the wake to look at.",
    "Called with no change fields it is a read. `project` defaults to your own, and naming another project's is allowed rather than refused; the answer says which of the two you did, and the record, the board card and the tick's journal all carry who changed whose tick.",
    "`enabled: false` stops every wake for that project until someone turns it back on — indefinitely, if that is the decision. `wakeIntervalMinutes` sets how often a wake may be sent (null restores the default hour); the tick cannot wake more often than it checks, so a value under the check interval simply means every check. `untilMinutes` is an optional expiry after which the setting lapses back to the default — omit it and the setting stands until it is changed.",
    "A `reason` in your own words is required whenever the settings leave the default, and it is what the board card shows: a tick that has gone quiet with nothing saying why cannot be told apart from a tick that broke. Restoring the default needs no reason.",
    "`monitorPrompt` is your own additional prompt for this project's monitor, in your own words: it is appended to every later scheduler-fired wake beside the reasons and items the tick derives, never replacing them or the contract. Send a new `monitorPrompt` to replace it and `monitorPrompt: null` to clear it, and read the record back rather than trusting the echo. It is bounded and redacted before it is stored, like the reason. It changes what a wake says and never whether or when one is sent, so a prompt on its own needs no reason and leaves the project on the default tick — and `untilMinutes` expires the on/off and cadence setting, not the prompt.",
    "A project nobody has configured runs on the defaults, which are exactly the behaviour the tick has always had.",
  ].join(" "),
  rotate_orchestrator: "Explicitly hand a project's orchestrator seat to a fresh successor: bounded handoff (predecessor transcript reference, open tasks, optional notes), atomic designation switch, manager-authority-only revocation of the predecessor, bidirectional lineage. Never triggered automatically.",
};

const clientRequestIdSchema = z.string().min(1).describe("Stable idempotency key for this logical call.");
/* #844 §7: the selected-card reference an operator turn carried, in either of
   the two forms a caller actually holds — the `ctx=` token copied off the
   structured-user marker, or that token already decoded. The object stays open
   because the reference is versioned and validated by its own parser; a schema
   that pinned today's fields would reject tomorrow's evidence at the door. */
const selectedContextSchema = z.union([z.string().min(1), z.record(z.string(), z.unknown())]).optional()
  .describe("Selected-card reference from the operator's turn (the `ctx=` marker token, or the decoded object). Resolves the conversation through a bounded identity lookup — no operator_snapshot needed.");
const conversationArchiveTargetSchema = z.object({
  conversationId: z.string().min(1).optional()
    .describe("Durable Viewer conversation id. Archive and unarchive actions expand it to every registered generation path."),
  transcriptPath: z.string().min(1).optional()
    .describe("Exact board transcript path, including a spawn:<launchId> placeholder. Archive and unarchive actions preserve it and add every generation of the resolved conversation."),
}).strict().refine((target) => Boolean(target.conversationId || target.transcriptPath), {
  message: "conversationId or transcriptPath is required",
});
/* #1202: one reply draft. `label` is what the pill says, `text` is what lands
   in the composer, and the object is closed because a third field would be a
   caller inventing semantics the renderer does not have. */
const replyDraftSchema = z.object({
  label: z.string().min(1).max(MAX_REPLY_LABEL_CHARS)
    .describe("What the pill says \u2014 a few words the operator reads at a glance."),
  text: z.string().min(1)
    .describe(`The draft itself, in the operator's language. Lands in their composer, editable, never sent by the Viewer. At most ${MAX_REPLY_TEXT_BYTES} bytes.`),
}).strict();
const entityIdSchema = z.string().min(1);
const snapshotStringSchema = z.string()
  .min(MIN_SNAPSHOT_STRING_LENGTH)
  .max(MAX_SNAPSHOT_STRING_LENGTH);
const snapshotPathsSchema = z.array(snapshotStringSchema)
  .max(MAX_SCOPE_PATHS)
  .refine((paths) => new Set(paths).size === paths.length, {
    message: "scope.paths must contain unique paths",
  });
const snapshotScopeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.enum(VIEW_SCOPE_KINDS).exclude(["paths"]),
  }).strict(),
  z.object({
    kind: z.literal("paths"),
    paths: snapshotPathsSchema,
  }).strict(),
]);

/* #1026: the stage contract, published rather than discovered. A caller that
   composed stages from `array of objects` alone learned id, kind, role shape,
   the runtime-override seam and the `next` edges through seven sequential
   rejections. Everything the engine's normalizer accepts is declared here; the
   object stays open (`passthrough`) and the semantic rules — id uniqueness,
   edge targets, review-loop reachability, role parameter values — stay with the
   engine, which now answers with all of them at once. */
const pipelineStageSchema = z.object({
  /* Bounds here stay exactly as wide as the engine's: it trims before it
     checks, so a padded id it accepts must not be refused at the door. */
  id: z.string().regex(/^\s*[A-Za-z0-9_-]{1,64}\s*$/u)
    .describe("Stage id, unique within the pipeline: 1–64 characters of A–Z a–z 0–9 _ - (surrounding whitespace is trimmed). Referenced by next and onFail."),
  kind: z.enum(["run", "review-loop"])
    .describe("run: an agent conversation that does the work. review-loop: a read-only review of the run stage whose next chain reaches it."),
  "prompt": z.string().min(1)
    .describe(`Instruction for this stage's agent, appended to its role scaffold. Up to ${MAX_STAGE_PROMPT_LENGTH} characters once trimmed.`),
  next: z.string().nullable().optional()
    .describe("Pass successor: the id of the stage this one hands to when it passes, or null to end the chain. DEFAULTS TO null — without it nothing follows this stage, and a review-loop nothing points at is rejected as unreachable."),
  onFail: z.object({
    to: z.string().describe("Stage id this stage returns to on a fail verdict."),
    maxRounds: z.number().int().min(1).max(MAX_FAIL_EDGE_ROUNDS).optional()
      .describe(`Rounds this fail loop may run before the pipeline parks (default ${DEFAULT_FAIL_EDGE_ROUNDS}).`),
  }).nullable().optional()
    .describe("Fail successor for a run stage. A review-loop stage may not define one — it recovers through its own review flow."),
  role: z.object({
    roleId: z.enum(ROLE_IDS)
      .describe(`Role preset from the shared registry; it supplies the stage's prompt scaffold and its default engine/model/effort. ${PIPELINE_DISALLOWED_ROLE_IDS.join(", ")} is refused inside a pipeline (it needs an interactive deploy confirmation).`),
    params: z.record(z.string(), z.union([z.string(), z.number()])).optional()
      .describe("Values for the role's declared parameters, substituted into its scaffold. Only the role's own keys, validated against the registry."),
  }).strict().optional()
    .describe("Role reference ONLY. Runtime overrides do not go here — put engine/model/effort/access on the stage itself."),
  engine: z.enum(["claude", "codex"]).optional()
    .describe("Stage-level engine override; defaults to the role's registry engine."),
  model: z.string().nullable().optional()
    .describe("Stage-level model override, or null to inherit the role default. Must be a model the stage engine supports."),
  effort: z.string().nullable().optional()
    .describe("Stage-level effort override, or null to inherit the role default. Must be an effort the stage engine supports."),
  access: z.enum(["read-only", "read-write"]).optional()
    .describe("Stage-level access override. A review-loop stage is always read-only."),
}).passthrough();

/* #1016: the typed target contract, published rather than guessed. `target` was
   declared as a free-form record with a prose list of kind names, so the
   discriminator and every per-kind field lived only in `FocusTarget` — five
   plausible guesses in a row were rejected with one undifferentiated sentence.
   Each branch here is exactly as wide as `isFocusTarget`, and each stays open
   (`passthrough`) so the binding, not the protocol boundary, answers a
   mis-shaped target with the sentence that names the way through. The
   conversation branch is the one that carries two accepted forms, so both its
   fields are optional here and the binding requires one of them. */
const focusTargetSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("conversation"),
    conversationId: z.string().min(1).optional()
      .describe('Durable "conversation_…" id, resolved server-side to that conversation\'s current transcript. The form to prefer: it survives resume and migration, which a path does not.'),
    path: z.string().min(1).optional()
      .describe("Transcript .jsonl path of the conversation. Accepted alongside conversationId; supply at least one."),
  }).passthrough().describe("A conversation card, named by durable id or by transcript path."),
  z.object({
    kind: z.literal("pipeline"),
    pipelineId: z.string().min(1).describe("Pipeline id; the request frames that pipeline's group on the board."),
  }).passthrough(),
  z.object({
    kind: z.literal("stage"),
    pipelineId: z.string().min(1).describe("Pipeline the stage belongs to."),
    stageId: z.string().min(1).describe("Stage id within that pipeline. Resolves to the stage slot before it materializes and to the running agent's conversation afterwards."),
  }).passthrough(),
  z.object({
    kind: z.literal("flowRound"),
    flowId: z.string().min(1).describe("Review flow id; the request frames that flow's deck."),
    round: z.number().int().min(0).describe("Round number within the flow, from 0."),
  }).passthrough(),
  z.object({
    kind: z.literal("task"),
    taskId: z.string().min(1).describe("Board task id."),
  }).passthrough(),
  z.object({
    kind: z.literal("draft"),
    draftId: z.string().min(1).describe("Board draft id. A draft exists only on the operator's canvas, so this target also needs the top-level project argument."),
  }).passthrough(),
  z.object({
    kind: z.literal("region"),
    project: z.string().min(1).describe("Project whose board the rect is in."),
    rect: z.object({
      x: z.number(), y: z.number(),
      w: z.number().min(0), h: z.number().min(0),
    }).passthrough().describe("World-space box, in the board's own geometry."),
  }).passthrough().describe("A board area. Geometric targets accept intent \"show\" only."),
  z.object({
    kind: z.literal("point"),
    project: z.string().min(1).describe("Project whose board the point is in."),
    x: z.number(), y: z.number(),
    zoom: z.number().gt(0).optional().describe("Optional explicit zoom; otherwise the point frames a card's worth of context around itself."),
  }).passthrough().describe("A board coordinate. Geometric targets accept intent \"show\" only."),
]).describe(
  `Typed focus target, discriminated by "kind": ${FOCUS_TARGET_SHAPES.map((shape) => `${shape.kind} — ${shape.example}`).join("; ")}.`,
);

function boundedNumericInput(toolName: McpToolName, fieldPath: string): z.ZodType {
  const spec = MCP_BOUNDED_NUMERIC_ARGS[toolName]?.find((candidate) => candidate.path.join(".") === fieldPath);
  if (!spec) throw new Error(`missing bounded numeric MCP specification for ${toolName}.${fieldPath}`);
  return z.json().optional().describe(
    `Integer ${spec.min}..${spec.max}. Numeric strings are coerced, out-of-range values clamp to the nearest bound, and other values use ${spec.fallback}.`,
  );
}

export const TOOL_INPUT_SCHEMAS: Record<McpToolName, z.ZodObject> = {
  spawn_agent: z.object({
    clientRequestId: clientRequestIdSchema,
    cwd: z.string().min(1).describe("Existing working directory for the new agent."),
    "prompt": z.string().describe("First instruction sent to the agent."),
    title: z.string().min(1).describe("Semantic conversation title required for every new spawn."),
    engine: z.enum(["claude", "codex"]).optional(),
    model: z.string().optional(),
    effort: z.string().optional(),
    role: z.enum(ROLE_IDS).optional(),
    roleParams: z.record(z.string(), z.unknown()).optional()
      .describe("Role-specific parameters. Bounded integers accept numeric strings, clamp to their declared role bounds, and report the applied value in clamped."),
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
  message_receipt: z.object({
    clientRequestId: clientRequestIdSchema,
    operationId: z.string().min(1).describe("The operationId a send_message call returned."),
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
    task: z.string().min(1).describe("Board title for the pipeline."),
    spec: z.string().optional().describe("Acceptance criteria shared by every stage."),
    repoDir: z.string().min(1).describe("Absolute path of the existing git repository the pipeline worktree is cut from."),
    baseBranch: z.string().optional().describe("Branch the worktree is based on. A draft that pins this must also pass baseRef."),
    baseRef: z.string().optional().describe("Commit the pipeline is pinned to. Required when a draft (autoStart:false) pins baseBranch — resolve the SHA yourself."),
    stages: z.array(pipelineStageSchema).describe(
      `Stage graph, 0–${MAX_PIPELINE_STAGES} stages (a started pipeline needs at least ${MIN_STARTED_PIPELINE_STAGES}). Stages run in the order the next edges chain them, not array order; every review-loop must be pass-reachable from a run stage.`,
    ),
    src: z.string().optional().describe("Creator transcript path (.jsonl) under the shared Claude transcript store or a Codex sessions root; a native ~/.claude/projects path is normalized to its shared-store mirror when that file exists."),
    autoStart: z.boolean().optional().describe("false creates a draft for the operator to start from the board."),
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
    limit: boundedNumericInput("list_conversations", "limit"),
  }).passthrough(),
  search_transcripts: z.object({
    clientRequestId: clientRequestIdSchema,
    query: z.string().trim().min(1).describe("Terms to match in indexed user and assistant message bodies."),
    project: z.string().trim().min(1).optional().describe("Canonical project key. Omit to search every indexed project."),
    cursor: z.string().min(1).optional().describe("Opaque cursor returned by the preceding page for this query and project."),
    limit: boundedNumericInput("search_transcripts", "limit"),
  }).passthrough(),
  get_conversation: z.object({
    clientRequestId: clientRequestIdSchema,
    conversationId: z.string().optional(),
    transcriptPath: z.string().optional(),
    maxRecords: boundedNumericInput("get_conversation", "maxRecords"),
    selectedContext: selectedContextSchema,
    tailLines: boundedNumericInput("get_conversation", "tailLines")
      .describe("Read this many trailing transcript lines instead of the scanned summary. Use conversationId or selectedContext for the bounded identity path, or transcriptPath for the validated pinned reader; all alternatives keep answering while corpus scans are degraded."),
  }).passthrough(),
  conversation_deliverability: z.object({
    clientRequestId: clientRequestIdSchema,
    conversationId: z.string().min(1).optional(),
    transcriptPath: z.string().min(1).optional(),
  }).passthrough(),
  deploy_exact_sha: z.object({
    clientRequestId: clientRequestIdSchema,
    /* #795: authority is the caller's server-attributed designated-seat
       identity; the arguments carry only WHAT ships, never a proof. */
    revision: z.string().regex(/^[0-9a-f]{40}$/i).describe("Full 40-hex commit SHA to deploy. Resolve it yourself (e.g. remote main); never a branch name."),
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
    limit: boundedNumericInput("board_snapshot", "limit"),
  }).passthrough(),
  list_flows: z.object({
    clientRequestId: clientRequestIdSchema,
    project: z.string().optional(),
    state: z.string().optional(),
    includeClosed: z.boolean().optional(),
    limit: boundedNumericInput("list_flows", "limit"),
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
    limit: boundedNumericInput("list_pipelines", "limit"),
  }).passthrough(),
  conversation_action: z.object({
    clientRequestId: clientRequestIdSchema,
    conversationId: z.string().optional()
      .describe("Durable Viewer conversation id. Archive and unarchive actions expand it to every registered generation path."),
    transcriptPath: z.string().optional()
      .describe("Exact transcript or spawn:<launchId> board path. Archive and unarchive actions preserve it and add every generation of the resolved conversation."),
    selectedContext: selectedContextSchema,
    targets: z.array(conversationArchiveTargetSchema).min(1).max(100).optional()
      .describe("Archive/unarchive list form. Cannot be combined with the single-target fields."),
    action: z.enum(["interrupt", "kill", "resume", "compact", "dialog-key", "archive", "unarchive"]),
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
      id: snapshotStringSchema.optional(),
      deviceId: snapshotStringSchema.optional(),
      resolution: z.enum(VIEW_RESOLUTIONS).optional(),
    }).strict().optional(),
    scope: snapshotScopeSchema.optional(),
    text: z.object({
      include: z.boolean().optional(),
      lastMessages: boundedNumericInput("operator_snapshot", "text.lastMessages"),
      maxCharsPerConversation: boundedNumericInput("operator_snapshot", "text.maxCharsPerConversation"),
    }).strict().optional(),
    caller: z.object({
      pid: z.number().int().min(1).optional(),
      transcriptPath: snapshotStringSchema.optional(),
    }).strict().optional(),
  }).strict(),
  list_tasks: z.object({
    clientRequestId: clientRequestIdSchema,
    project: z.string().optional(),
    status: z.enum(["inbox", "assigned", "blocked", "done"]).optional(),
    placement: z.enum(["pinned", "unplaced"]).optional(),
    limit: boundedNumericInput("list_tasks", "limit"),
  }).passthrough(),
  get_task: z.object({
    clientRequestId: clientRequestIdSchema,
    taskId: entityIdSchema,
  }).passthrough(),
  deployment_status: z.object({
    clientRequestId: clientRequestIdSchema,
    deploymentId: z.string().min(1).optional(),
    operationId: z.string().min(1).optional(),
    limit: boundedNumericInput("deployment_status", "limit"),
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
    stallAfterMs: boundedNumericInput("agent_activity", "stallAfterMs")
      .describe("Silence under a live host that counts as a stall. A dead host over an open turn is always stalled."),
    limit: boundedNumericInput("agent_activity", "limit"),
  }).passthrough(),
  lifecycle_events: z.object({
    clientRequestId: clientRequestIdSchema,
    mode: z.enum(["query", "digest"]).optional().describe('"query" reads the journal; "digest" polls the bounded relay.'),
    project: z.string().optional(),
    pipelineId: z.string().optional(),
    conversationId: z.string().optional(),
    stageId: z.string().optional(),
    type: z.string().optional(),
    afterSeq: boundedNumericInput("lifecycle_events", "afterSeq").describe("Exclusive journal cursor for mode=query. Values clamp at zero and invalid values default to zero."),
    limit: boundedNumericInput("lifecycle_events", "limit"),
    subscriberId: z.string().optional().describe("Durable digest cursor owner; required for mode=digest."),
    maxItems: boundedNumericInput("lifecycle_events", "maxItems"),
    acknowledge: z.boolean().optional().describe("false polls the digest without advancing the cursor."),
  }).passthrough(),
  request_attention: z.object({
    clientRequestId: clientRequestIdSchema,
    target: focusTargetSchema,
    reason: z.string().min(1).describe("One operator-safe sentence saying why it is worth looking at. Never the target's contents."),
    intent: z.enum(["show", "open"]).optional().describe("show frames and highlights; open also opens the target's own surface. Default show."),
    zoom: z.enum(["inspect", "situate"]).optional(),
    contextLabel: z.string().optional().describe("Named in the spoken sentence but never navigated to."),
    project: z.string().optional().describe("Required only for a target the server cannot attribute on its own (a board draft)."),
  }).passthrough(),
  suggest_replies: z.object({
    clientRequestId: clientRequestIdSchema,
    conversationId: z.string().min(1).optional()
      .describe("Durable conversation whose composer these drafts belong under. Defaults to the calling conversation, and must BE it \u2014 another conversation is refused."),
    replies: z.array(replyDraftSchema).min(MIN_REPLY_SUGGESTIONS).max(MAX_REPLY_SUGGESTIONS)
      .describe(`${MIN_REPLY_SUGGESTIONS}\u2013${MAX_REPLY_SUGGESTIONS} drafts, ordered as the operator should read them. Two to four distinct ones is the usual shape.`),
  }).passthrough(),
  bridge_report: z.object({
    clientRequestId: clientRequestIdSchema,
    key: z.string().min(1).describe("Stable identity of this report. The same key always yields one log entry, so a retry after a host death is a no-op."),
    class: z.enum(["status", "completed", "failed", "blocked", "review_verdict", "question"]),
    body: z.string().min(1).describe("Short prose for the gateway to relay. Bounded to 2 KB and secret-redacted at write. Never transcript payloads or raw tool output."),
    correlatesDirective: z.string().optional().describe("clientRequestId of the directive this answers."),
  }).passthrough(),
  bridge_directive: z.object({
    clientRequestId: clientRequestIdSchema,
    rootTurnId: z.string().regex(/^[A-Za-z0-9_.:-]+$/).describe("The realtime turn this instruction came from. The delivery id derives from it, so a retry must reuse the same value."),
    utterance: z.number().int().min(0).describe("Index of this instruction within that turn, from 0."),
    instruction: z.string().min(1).describe("What the user asked for, in plain words. No board state, no tool output."),
    project: z.string().optional().describe("Route to THIS project's designated orchestrator (validated seat). Absent: routes to the orchestrator of the calling voice session's own canonical project."),
    ref: z.number().int().positive().optional().describe("seq of the report this answers, when it answers one."),
  }).passthrough(),
  get_orchestrator: z.object({
    clientRequestId: clientRequestIdSchema,
    project: z.string().min(1).describe("Project key whose designated orchestrator to report on."),
  }).passthrough(),
  create_orchestrator: z.object({
    clientRequestId: clientRequestIdSchema,
    project: z.string().min(1).describe("Project key this orchestrator will own."),
    conversationId: z.string().regex(/^conversation_/).optional().describe("Existing registered conversation to adopt. The Viewer validates its project, cwd, transcript, lifecycle, and operator authority before seating it."),
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
    effort: z.string().optional().describe("Reasoning effort for the successor; round-trips into its spawn like create_orchestrator's."),
    accountId: z.string().optional(),
  }).passthrough(),
  seat_tick_settings: z.object({
    clientRequestId: clientRequestIdSchema,
    project: z.string().trim().min(1).optional()
      .describe("Project whose tick to read or change. Defaults to your own; another project's is allowed and is recorded as such."),
    enabled: z.boolean().optional()
      .describe("false stops every wake for that project until it is turned back on. There is no expiry unless untilMinutes gives one."),
    wakeIntervalMinutes: z.number().positive().nullable().optional()
      .describe("Minutes between wakes for that project; null restores the default hour."),
    untilMinutes: z.number().positive().nullable().optional()
      .describe("Optional expiry, in minutes from now, after which the on/off and cadence setting lapses back to the default. It does not expire the prompt. Omit for a setting that stands until it is changed."),
    reason: z.string().trim().min(1).nullable().optional()
      .describe("Why, in your own words. Required whenever the settings leave the default; it is what the board card shows."),
    monitorPrompt: z.string().trim().min(1).nullable().optional()
      .describe("Your own additional prompt for this project's monitor: what every later scheduler-fired wake should look at, appended to the reasons and items the tick derives. Send a new one to replace it, null to clear it. Bounded and redacted before it is stored. It never changes whether or when a wake is sent, and needs no reason."),
  }).passthrough(),
};

export function createViewerMcpServer(service: McpToolService): McpServer {
  const server = new McpServer({ name: MCP_SERVER_NAME, version: "1.0.0" }, {
    instructions: "Use clientRequestId on every call. Reuse it only when replaying the same logical operation.",
  });
  for (const toolName of MCP_TOOL_NAMES) {
    server.registerTool(toolName, {
      description: TOOL_DESCRIPTIONS[toolName],
      inputSchema: TOOL_INPUT_SCHEMAS[toolName],
    }, async (args, extra) => {
      const timeoutMs = 30_000;
      const deadline = deadlineSignal(timeoutMs, {
        signal: extra.signal,
        reason: "MCP tool deadline exceeded",
      });
      try {
        const result = await service.callTool(toolName, args as McpToolArgs, {
          signal: deadline.signal,
          deadlineAt: Date.now() + timeoutMs,
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
          structuredContent: result,
          ...(result.ok ? {} : { isError: true }),
        };
      } finally {
        deadline.release();
      }
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
    new SqliteMcpReceiptStore(statePath("mcp-receipts.sqlite"), {
      legacyFilePath: statePath("mcp-receipts.json"),
    }),
    viewerMcpToolPolicy(undefined, hostHealthProbe),
    { timings: productionMcpToolTimings },
  );
  const server = createViewerMcpServer(service);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
