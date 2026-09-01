import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";

import { structuredHostsEnabled } from "@/lib/runtime/flags";
import { Database } from "bun:sqlite";

import {
  RUNTIME_SCHEMA_VERSION,
  RUNTIME_DELIVERY_DISCARDED_REASON,
  assertRuntimeEvent,
  normalizeRuntimeEventInput,
  parseRuntimeScope,
  runtimePresentationReceipt,
  runtimeScopeKey,
  type RuntimeAttention,
  type RuntimeDeliveryAction,
  type RuntimeDeliveryActionClaim,
  type RuntimeEdge,
  type RuntimeEffect,
  type RuntimeEvent,
  type RuntimeEventInput,
  RuntimeIdempotencyConflictError,
  newOperationId,
  runtimeCompactCapability,
  type NormalizedRuntimeEventInput,
  type RuntimeOperationCommand,
  type RuntimeOperationReceipt,
  type RuntimeOperationResult,
  type RuntimeReceiptStatus,
  type RuntimeReplay,
  type RuntimeRetryOptions,
  type RuntimeSession,
  type RuntimeSnapshot,
  type RuntimeTransitionOptions,
  type ViewerDeploymentOwner,
  type ViewerDeploymentReceipt,
  type ViewerDeploymentStatus,
} from "@/lib/runtime/contracts";
import {
  acknowledgeVoiceDelivery,
  appendReadyVoiceDelivery,
  appendVoiceResponse,
  completeVoiceTurn,
  normalizeAcknowledgedVoiceDeliveryIds,
  normalizeVoiceDeliveries,
  rememberAcknowledgedVoiceDelivery,
} from "@/lib/runtime/voiceDelivery";
import {
  appendRuntimeLiveTurnDelta,
  normalizeRuntimeLiveTurn,
  projectRuntimeLiveTurnItem,
} from "@/lib/runtime/liveTurn";
import { parseStructuredImageRefs, structuredContent } from "@/lib/runtime/structuredContent";
import { runtimeImageCapability } from "@/lib/runtime/runtimeImageStore";

export class RuntimeJournalFault extends Error {}

export const RUNTIME_SNAPSHOT_INACTIVE_SESSION_LIMIT = 128;
export const RUNTIME_SNAPSHOT_TERMINAL_DEPLOYMENT_LIMIT = 50;
export const RUNTIME_SNAPSHOT_STALE_EDGE_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
/** A spawn or kill may wait through a short host succession. After one
    continuous hour with no runtime host and no current live registry
    conversation, the maintenance sweep terminalizes the orphaned work so
    every effect drain remains proportional to work that can still run. */
export const RUNTIME_PENDING_EFFECT_STALE_MS = 60 * 60 * 1_000;

export type RuntimeRegistryConversationRetentionState = "current" | "dead" | "superseded";

type EventRow = {
  seq: number;
  event_id: string;
  scope: string;
  revision: number;
  kind: string;
  payload_json: string;
  created_at: number;
  occurred_at: string;
  recorded_at: string;
  producer_kind: string;
  producer_account_id: string | null;
  producer_key: string | null;
  producer_host_epoch: number | null;
  operation_id: string | null;
  causation_id: string | null;
  correlation_id: string | null;
  prev_hash: string;
  hash: string;
};
type HashableEventRow = Omit<EventRow, "prev_hash" | "hash">;

type EntityRow = {
  kind: string;
  id: string;
  revision: number;
  state_json: string;
  checkpoint_seq: number;
};

type EncryptedSecret = {
  __runtimeEncrypted: 1;
  iv: string;
  tag: string;
  ciphertext: string;
};

type EngineProducerCursor = { prefix: string; sequence: number };

function engineProducerCursor(producerKind: string, producerKey: string): EngineProducerCursor | null {
  if (producerKind !== "codex-app-server" && producerKind !== "claude-broker") return null;
  const expected = producerKind === "codex-app-server" ? "engine-host:codex:" : "engine-host:claude:";
  if (!producerKey.startsWith(expected)) return null;
  const separator = producerKey.lastIndexOf(":");
  if (separator < expected.length) return null;
  const sequence = Number(producerKey.slice(separator + 1));
  if (!Number.isSafeInteger(sequence) || sequence < 0) return null;
  return { prefix: producerKey.slice(0, separator + 1), sequence };
}

function loadSecretKey(filename: string): Buffer {
  if (filename === ":memory:") return randomBytes(32);
  const keyFile = `${filename}.key`;
  try {
    const stat = fs.statSync(keyFile);
    if ((stat.mode & 0o077) !== 0) throw new RuntimeJournalFault("runtime journal key permissions are unsafe");
    const key = fs.readFileSync(keyFile);
    if (key.length !== 32) throw new RuntimeJournalFault("runtime journal key is invalid");
    return key;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const key = randomBytes(32);
    const fd = fs.openSync(keyFile, "wx", 0o600);
    try {
      fs.writeFileSync(fd, key);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return key;
  }
}

function stableJson(value: unknown): string {
  if (value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function terminalRetryOperationId(operationId: string): string {
  return `retry_${createHash("sha256").update(operationId).digest("hex")}`;
}

function retryRequestHash(command: RuntimeOperationCommand): string {
  const value = { ...command } as Record<string, unknown>;
  delete value.idempotencyKey;
  delete value.operationId;
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function recordHash(previous: string, row: HashableEventRow | EventRow): string {
  const envelope = { ...row } as Record<string, unknown>;
  delete envelope.prev_hash;
  delete envelope.hash;
  return createHash("sha256").update(`${previous}\n${stableJson(envelope)}`).digest("hex");
}

function toEvent(row: EventRow): RuntimeEvent {
  return {
    schemaVersion: RUNTIME_SCHEMA_VERSION,
    seq: row.seq,
    eventId: row.event_id,
    scope: parseRuntimeScope(row.scope as `${RuntimeEvent["scope"]["type"]}:${string}`),
    revision: row.revision,
    kind: row.kind,
    occurredAt: row.occurred_at,
    recordedAt: row.recorded_at,
    producer: {
      kind: row.producer_kind,
      ...(row.producer_account_id !== null ? { accountId: row.producer_account_id } : {}),
      ...(row.producer_key !== null ? { eventKey: row.producer_key } : {}),
      ...(row.producer_host_epoch !== null ? { hostEpoch: row.producer_host_epoch } : {}),
    },
    causationId: row.causation_id,
    correlationId: row.correlation_id,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function receipts(value: unknown): RuntimeOperationReceipt[] {
  return Array.isArray(value) ? value.filter((item): item is RuntimeOperationReceipt => Boolean(item) && typeof item === "object") : [];
}

/**
 * Receipts are append-only audit records.  The session projection is a
 * presentation index, so a replacement hides every ancestor in its retry
 * chain.  Keep this derivation here so snapshots and live projection use the
 * same rule. Durable operation rows and events remain unchanged.
 */
function visibleReceipts(value: RuntimeOperationReceipt[]): RuntimeOperationReceipt[] {
  const byOperationId = new Map(value.map((receipt) => [receipt.operationId, receipt]));
  const superseded = new Set<string>();
  for (const receipt of value) {
    const seen = new Set<string>();
    let ancestor = receipt.retryOfOperationId ?? null;
    while (ancestor && !seen.has(ancestor)) {
      seen.add(ancestor);
      superseded.add(ancestor);
      ancestor = byOperationId.get(ancestor)?.retryOfOperationId ?? null;
    }
  }
  return value.filter((receipt) => !superseded.has(receipt.operationId));
}

function baseSession(id: string, payload: Record<string, unknown>, revision: number): RuntimeSession {
  const key = record(payload.sessionKey);
  const capabilities = record(payload.capabilities);
  const liveTurn = normalizeRuntimeLiveTurn(payload.liveTurn);
  return {
    conversationId: typeof payload.conversationId === "string" ? payload.conversationId : id,
    sessionKey: {
      engine: key.engine === "claude" ? "claude" : "codex",
      sessionId: typeof key.sessionId === "string" ? key.sessionId : id,
    },
    hostKind: payload.hostKind === "codex-app-server" || payload.hostKind === "claude-broker" || payload.hostKind === "tmux-legacy" ? payload.hostKind : "unhosted",
    host: payload.host === "registering" || payload.host === "hosted" || payload.host === "recovering" || payload.host === "conflict" || payload.host === "dead" ? payload.host : "unhosted",
    turn: payload.turn === "idle" || payload.turn === "running" || payload.turn === "interrupt_requested" ? payload.turn : "unknown",
    provenance: payload.provenance === "derived" || payload.provenance === "replayed" ? payload.provenance : "structured",
    revision,
    attentionIds: strings(payload.attentionIds),
    recentReceipts: receipts(payload.recentReceipts),
    accountId: typeof payload.accountId === "string" ? payload.accountId : null,
    parentConversationId: typeof payload.parentConversationId === "string" ? payload.parentConversationId : null,
    flowId: typeof payload.flowId === "string" ? payload.flowId : null,
    workflowId: typeof payload.workflowId === "string" ? payload.workflowId : null,
    cwd: typeof payload.cwd === "string" ? payload.cwd : null,
    artifactPath: typeof payload.artifactPath === "string" ? payload.artifactPath : null,
    capabilities: {
      steer: capabilities.steer === true,
      structuredAttention: capabilities.structuredAttention === true,
      imageInput: capabilities.imageInput && typeof capabilities.imageInput === "object"
        ? capabilities.imageInput as RuntimeSession["capabilities"]["imageInput"]
        : runtimeImageCapability(key.engine === "claude" ? "claude" : "codex", false),
    },
    activeTurnId: typeof payload.activeTurnId === "string" ? payload.activeTurnId : null,
    pendingReconfigure: payload.pendingReconfigure && typeof payload.pendingReconfigure === "object"
      ? payload.pendingReconfigure as RuntimeSession["pendingReconfigure"]
      : null,
    drift: payload.drift && typeof payload.drift === "object" ? payload.drift as RuntimeSession["drift"] : null,
    ...(liveTurn ? { liveTurn } : {}),
    ...(Array.isArray(payload.voiceDeliveries)
      ? { voiceDeliveries: normalizeVoiceDeliveries(payload.voiceDeliveries) }
      : {}),
    ...(Array.isArray(payload.acknowledgedVoiceDeliveryIds)
      ? {
        acknowledgedVoiceDeliveryIds: normalizeAcknowledgedVoiceDeliveryIds(
          payload.acknowledgedVoiceDeliveryIds,
        ),
      }
      : {}),
  };
}

export interface RuntimeJournalOptions {
  maxEvents?: number;
  now?: () => number;
  structuredHosts?: boolean;
}

export class RuntimeJournal {
  private readonly db: Database;
  private readonly maxEvents: number;
  private readonly now: () => number;
  private readonly structuredHosts: boolean;
  private readonly secretKey: Buffer;
  private readonly waiters = new Set<() => void>();
  private fault: string | null = null;
  private snapshotCache: { changes: number; expiresAt: number | null; json: string } | null = null;
  private receiptSweepCursor = 0;

  constructor(filename: string, options: RuntimeJournalOptions = {}) {
    this.db = new Database(filename, { create: true, strict: true });
    this.maxEvents = options.maxEvents ?? 20_000;
    this.now = options.now ?? (() => Date.now());
    this.structuredHosts = options.structuredHosts ?? structuredHostsEnabled();
    this.secretKey = loadSecretKey(filename);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA auto_vacuum = INCREMENTAL;");
    if (filename !== ":memory:") {
      for (const candidate of [filename, `${filename}-wal`, `${filename}-shm`]) {
        if (fs.existsSync(candidate)) fs.chmodSync(candidate, 0o600);
      }
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS journal_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY, event_id TEXT NOT NULL, scope TEXT NOT NULL, revision INTEGER NOT NULL,
        kind TEXT NOT NULL, payload_json TEXT NOT NULL, created_at INTEGER NOT NULL,
        occurred_at TEXT NOT NULL, recorded_at TEXT NOT NULL, producer_kind TEXT NOT NULL,
        producer_account_id TEXT, producer_key TEXT, producer_host_epoch INTEGER,
        operation_id TEXT, causation_id TEXT, correlation_id TEXT,
        prev_hash TEXT NOT NULL, hash TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS scope_revisions (scope TEXT PRIMARY KEY, revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS projections (scope TEXT PRIMARY KEY, revision INTEGER NOT NULL, state_json TEXT NOT NULL, checkpoint_seq INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS entities (
        kind TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL,
        state_json TEXT NOT NULL, checkpoint_seq INTEGER NOT NULL, updated_at INTEGER,
        PRIMARY KEY(kind, id)
      );
      CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload_json TEXT NOT NULL, event_seq INTEGER NOT NULL, state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS producer_receipts (producer_kind TEXT NOT NULL, producer_key TEXT NOT NULL, event_json TEXT NOT NULL, PRIMARY KEY(producer_kind, producer_key));
      CREATE TABLE IF NOT EXISTS operations (
        operation_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL, request_json TEXT NOT NULL,
        receipt_json TEXT NOT NULL, event_seq INTEGER NOT NULL, orphaned_since INTEGER,
        UNIQUE(conversation_id, idempotency_key)
      );
      CREATE TABLE IF NOT EXISTS delivery_operation_actions (
        operation_id TEXT PRIMARY KEY,
        winner TEXT NOT NULL CHECK(winner IN ('discard', 'retry')),
        claimed_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS consumer_checkpoints (
        event_id TEXT NOT NULL, consumer TEXT NOT NULL, completed_at INTEGER NOT NULL,
        PRIMARY KEY(event_id, consumer)
      );
      CREATE TABLE IF NOT EXISTS viewer_deployments (
        deployment_id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE,
        request_hash TEXT NOT NULL, status_json TEXT NOT NULL,
        active INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS viewer_deployments_one_active
        ON viewer_deployments(active) WHERE active = 1;
    `);
    this.migrateOperationIdempotencyScope();
    this.migrateOperationOrphanedSince();
    this.migrateLegacyEvents();
    this.migrateEntityUpdatedAt();
    for (const row of this.db.query<EventRow, []>("SELECT * FROM events WHERE producer_key IS NOT NULL").all()) {
      this.db.query("INSERT INTO producer_receipts(producer_kind, producer_key, event_json) VALUES (?, ?, ?) ON CONFLICT(producer_kind, producer_key) DO NOTHING")
        .run(row.producer_kind, row.producer_key, stableJson(toEvent(row)));
    }
    this.db.exec("DROP INDEX IF EXISTS events_producer_key; CREATE UNIQUE INDEX IF NOT EXISTS events_event_id ON events(event_id); CREATE UNIQUE INDEX IF NOT EXISTS events_scope_revision ON events(scope, revision); CREATE UNIQUE INDEX IF NOT EXISTS events_producer_key ON events(producer_kind, producer_key) WHERE producer_key IS NOT NULL;");
    this.metaSetDefault("schema_version", String(RUNTIME_SCHEMA_VERSION));
    this.metaSetDefault("seq", "0");
    this.metaSetDefault("published_seq", this.metaOr("seq", "0"));
    this.metaSetDefault("hash", "0".repeat(64));
    this.metaSetDefault("anchor_seq", "0");
    this.metaSetDefault("anchor_hash", "0".repeat(64));
    this.metaSetDefault("host_epoch", "1");
    this.metaSetDefault("health", "ready");
    this.metaSetDefault("files_revision", "0");
    this.verify();
  }

  append(rawInput: RuntimeEventInput): RuntimeEvent {
    assertRuntimeEvent(rawInput);
    const input = normalizeRuntimeEventInput(rawInput);
    this.assertHealthy();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const previousPublished = Number(this.meta("published_seq"));
      const event = this.appendInTransaction(input);
      this.db.exec("COMMIT");
      this.compactIfNeeded();
      if (event.seq > previousPublished) this.notifyWaiters();
      return event;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* transaction already closed */ }
      throw error;
    }
  }

  executeOperation(command: RuntimeOperationCommand): RuntimeOperationResult {
    return this.executeOperationWithLineage(command);
  }

  private executeOperationWithLineage(
    command: RuntimeOperationCommand,
    retryOfOperationId?: string,
    beforeAdmission?: () => void,
  ): RuntimeOperationResult {
    this.assertHealthy();
    command = this.normalizeOperation(command);
    this.assertOperation(command);
    const operationId = command.operationId?.trim() || newOperationId();
    const requestValue = { ...command } as Record<string, unknown>;
    delete requestValue.operationId;
    /* #1117: authorship is server-derived metadata (caller attribution can
       lawfully differ between a call and its replay), so it must never turn a
       legitimate idempotent replay into a request-hash conflict. */
    delete requestValue.origin;
    if (command.kind === "answer") requestValue.resolution = { sha256: createHash("sha256").update(stableJson(command.resolution)).digest("hex") };
    const requestJson = stableJson(requestValue);
    const requestHash = createHash("sha256").update(requestJson).digest("hex");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db.query<{ operation_id: string; request_hash: string; receipt_json: string }, [string, string]>("SELECT operation_id, request_hash, receipt_json FROM operations WHERE conversation_id = ? AND idempotency_key = ?").get(command.conversationId, command.idempotencyKey);
      if (existing) {
        if (existing.request_hash !== requestHash) throw new RuntimeIdempotencyConflictError("idempotency key already belongs to another request");
        const result = { operationId: existing.operation_id, receipt: JSON.parse(existing.receipt_json) as RuntimeOperationReceipt, replayed: true };
        this.db.exec("COMMIT");
        return result;
      }
      const operationOwner = this.db.query<{ idempotency_key: string }, [string]>("SELECT idempotency_key FROM operations WHERE operation_id = ?").get(operationId);
      if (operationOwner) throw new RuntimeIdempotencyConflictError("operationId already belongs to another request");
      beforeAdmission?.();
      const retryParent = retryOfOperationId
        ? this.db.query<{ receipt_json: string }, [string]>(
            "SELECT receipt_json FROM operations WHERE operation_id = ?",
          ).get(retryOfOperationId)
        : null;
      const parentReceipt = retryParent
        ? JSON.parse(retryParent.receipt_json) as RuntimeOperationReceipt
        : null;
      const receipt = this.operationReceipt(command, operationId, retryOfOperationId, parentReceipt);
      const effectPayload = command.kind === "answer"
        ? { ...command, operationId, resolution: this.encryptSecret(command.resolution) }
        : {
            ...command,
            operationId,
            ...(this.structuredHosts
              && (command.kind === "send" || command.kind === "steer")
              && typeof receipt.turnId === "string"
              ? { turnId: receipt.turnId }
              : {}),
          };
      const effect = receipt.status === "pending" || receipt.status === "queued"
        ? { id: `effect:${operationId}`, kind: `runtime.${command.kind}`, payload: effectPayload }
        : undefined;
      const event = this.appendInTransaction(normalizeRuntimeEventInput({
        scope: { type: "operation", id: operationId },
        kind: "receipt",
        operationId,
        producer: { kind: "viewer-command", eventKey: `operation:${command.conversationId}:${command.idempotencyKey}`, hostEpoch: Number(this.meta("host_epoch")) },
        payload: receipt as unknown as Record<string, unknown>,
        ...(effect ? { effect } : {}),
      }));
      const committedReceipt: RuntimeOperationReceipt = { ...receipt, revision: event.revision };
      this.upsertEntity("operation", operationId, event.revision, committedReceipt, event.seq);
      this.appendOperationConsequences(command, committedReceipt, operationId);
      this.db.query("INSERT INTO operations(operation_id, conversation_id, idempotency_key, request_hash, request_json, receipt_json, event_seq) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(operationId, command.conversationId, command.idempotencyKey, requestHash, requestJson, stableJson(committedReceipt), event.seq);
      this.db.exec("COMMIT");
      this.compactIfNeeded();
      this.notifyWaiters();
      return { operationId, receipt: committedReceipt, replayed: false };
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* transaction already closed */ }
      throw error;
    }
  }

  operationResult(operationId: string): RuntimeOperationResult | null {
    this.assertHealthy();
    const row = this.db.query<{ operation_id: string; receipt_json: string }, [string]>("SELECT operation_id, receipt_json FROM operations WHERE operation_id = ?").get(operationId);
    return row ? { operationId: row.operation_id, receipt: JSON.parse(row.receipt_json) as RuntimeOperationReceipt, replayed: false } : null;
  }

  /** The journal owns operation identity, so this is the single durable
      arbitration point shared by HTTP actions and low-level journal retries.
      A repeated winner is an idempotent replay; the opposite action reads the
      recorded winner and must stop before touching the registry or outbox. */
  claimDeliveryAction(operationId: string, action: RuntimeDeliveryAction): RuntimeDeliveryActionClaim {
    this.assertHealthy();
    if (!this.structuredHosts) throw new Error("structured hosts are disabled");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.query<{ request_json: string; receipt_json: string }, [string]>(
        "SELECT request_json, receipt_json FROM operations WHERE operation_id = ?",
      ).get(operationId);
      if (!row) throw new Error("runtime operation is unknown");
      const command = JSON.parse(row.request_json) as RuntimeOperationCommand;
      const receipt = JSON.parse(row.receipt_json) as RuntimeOperationReceipt;
      if (command.kind !== "send" && command.kind !== "steer") {
        throw new Error(`runtime operation does not support ${action}`);
      }
      const recorded = this.recordedDeliveryActionInTransaction(operationId, receipt);
      if (recorded) {
        this.db.exec("COMMIT");
        return recorded;
      }
      const actionStatuses: readonly RuntimeReceiptStatus[] = action === "retry"
        ? ["pending", "queued", "failed", "uncertain", "rejected"]
        : ["pending", "queued", "failed", "uncertain"];
      if (!actionStatuses.includes(receipt.status)) {
        throw new Error(`runtime delivery cannot ${action} after its outcome is resolved`);
      }
      const claimed = this.acquireDeliveryActionInTransaction(operationId, action, receipt);
      this.db.exec("COMMIT");
      return claimed;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* transaction already closed */ }
      throw error;
    }
  }

  private recordedDeliveryActionInTransaction(
    operationId: string,
    receipt: RuntimeOperationReceipt,
  ): RuntimeDeliveryActionClaim | null {
    const row = this.db.query<{ winner: RuntimeDeliveryAction }, [string]>(
      "SELECT winner FROM delivery_operation_actions WHERE operation_id = ?",
    ).get(operationId);
    if (row) return { operationId, winner: row.winner, replayed: true };
    /* Existing databases can already contain the absorbing discarded receipt
       from the earlier fix. Materialize its winner lazily so the new fence is
       durable before any low-level retry is answered. */
    if (receipt.status === "failed" && receipt.reason === RUNTIME_DELIVERY_DISCARDED_REASON) {
      this.db.query(
        "INSERT INTO delivery_operation_actions(operation_id, winner, claimed_at) VALUES (?, 'discard', ?)",
      ).run(operationId, this.now());
      return { operationId, winner: "discard", replayed: true };
    }
    return null;
  }

  private acquireDeliveryActionInTransaction(
    operationId: string,
    action: RuntimeDeliveryAction,
    receipt: RuntimeOperationReceipt,
  ): RuntimeDeliveryActionClaim {
    const recorded = this.recordedDeliveryActionInTransaction(operationId, receipt);
    if (recorded) return recorded;
    this.db.query(
      "INSERT INTO delivery_operation_actions(operation_id, winner, claimed_at) VALUES (?, ?, ?)",
    ).run(operationId, action, this.now());
    return { operationId, winner: action, replayed: false };
  }

  private deliveryActionConflict(
    winner: RuntimeDeliveryAction,
    attempted: RuntimeDeliveryAction,
  ): Error {
    const legacyDetail = winner === "discard" && attempted === "retry"
      ? "; discarded runtime operations cannot retry"
      : "";
    return new Error(`runtime delivery ${winner} already won; ${attempted} refused${legacyDetail}`);
  }

  currentRetryResult(operationId: string): RuntimeOperationResult | null {
    this.assertHealthy();
    const rows = this.db.query<{ operation_id: string; receipt_json: string }, []>(
      "SELECT operation_id, receipt_json FROM operations ORDER BY event_seq",
    ).all();
    const byOperationId = new Map<string, RuntimeOperationReceipt>();
    const byParent = new Map<string, string>();
    for (const row of rows) {
      const receipt = JSON.parse(row.receipt_json) as RuntimeOperationReceipt;
      byOperationId.set(row.operation_id, receipt);
      if (receipt.retryOfOperationId) byParent.set(receipt.retryOfOperationId, row.operation_id);
    }
    let currentOperationId = operationId;
    let receipt = byOperationId.get(currentOperationId);
    if (!receipt) return null;
    const seen = new Set<string>();
    while (!seen.has(currentOperationId)) {
      seen.add(currentOperationId);
      const child = byParent.get(currentOperationId);
      if (!child) break;
      currentOperationId = child;
      receipt = byOperationId.get(child)!;
    }
    return { operationId: currentOperationId, receipt, replayed: currentOperationId !== operationId };
  }

  completeOperation(
    operationId: string,
    status: Exclude<RuntimeReceiptStatus, "pending" | "delivering">,
    details: Partial<Pick<RuntimeOperationReceipt, "turnId" | "queuePosition" | "reason">> = {},
  ): RuntimeOperationResult {
    return this.transitionOperation(operationId, status, details);
  }

  transitionOperation(
    operationId: string,
    status: Exclude<RuntimeReceiptStatus, "pending">,
    details: Partial<Pick<RuntimeOperationReceipt, "turnId" | "queuePosition" | "reason">> = {},
    options: RuntimeTransitionOptions = {},
  ): RuntimeOperationResult {
    this.assertHealthy();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.query<{ request_json: string; receipt_json: string }, [string]>("SELECT request_json, receipt_json FROM operations WHERE operation_id = ?").get(operationId);
      if (!row) throw new Error("runtime operation is unknown");
      const previous = JSON.parse(row.receipt_json) as RuntimeOperationReceipt;
      const command = JSON.parse(row.request_json) as RuntimeOperationCommand;
      const discarding = (command.kind === "send" || command.kind === "steer")
        && status === "failed"
        && details.reason === RUNTIME_DELIVERY_DISCARDED_REASON;
      if (discarding) {
        const recorded = this.recordedDeliveryActionInTransaction(operationId, previous);
        if (recorded?.winner === "retry") throw this.deliveryActionConflict("retry", "discard");
        if (options.fromStatuses && !options.fromStatuses.includes(previous.status)) {
          throw new Error("runtime operation moved before its transition");
        }
        const discardable = previous.status === "pending"
          || previous.status === "queued"
          || previous.status === "failed"
          || previous.status === "uncertain";
        if (!discardable) throw new Error("runtime delivery cannot discard after its outcome is resolved");
        this.acquireDeliveryActionInTransaction(operationId, "discard", previous);
        if (previous.status === "failed" && previous.reason === RUNTIME_DELIVERY_DISCARDED_REASON) {
          this.db.exec("COMMIT");
          return { operationId, receipt: previous, replayed: true };
        }
      } else {
        if (options.fromStatuses && !options.fromStatuses.includes(previous.status)) {
          throw new Error("runtime operation moved before its transition");
        }
        if (previous.status === status) {
          this.db.exec("COMMIT");
          return { operationId, receipt: previous, replayed: true };
        }
      }
      const queueing = status === "queued"
        && (previous.status === "delivering" || previous.status === "applying"
          || (this.structuredHosts && previous.status === "pending"));
      const beginning = (previous.status === "pending" || previous.status === "queued")
        && (status === "delivering" || (command.kind === "reconfigure" && status === "applying"));
      const completing = discarding || ((previous.status === "pending" || previous.status === "queued"
        || previous.status === "delivering" || previous.status === "applying")
        && status !== "delivering" && status !== "applying" && status !== "queued");
      if (!queueing && !beginning && !completing) throw new Error("runtime operation transition is invalid");
      if ((status === "applying" || status === "applied") && command.kind !== "reconfigure") {
        throw new Error("runtime operation transition is invalid");
      }
      const killBoundary = completing && command.kind === "kill" && status === "delivered"
        ? this.db.query<{ event_seq: number }, [string]>("SELECT event_seq FROM outbox WHERE id = ?")
          .get(`effect:${operationId}`)
        : null;
      if (completing && command.kind === "kill" && status === "delivered" && !killBoundary) {
        throw new Error("runtime kill effect is missing");
      }
      if (beginning && (command.kind === "send" || command.kind === "steer") && details.turnId !== undefined) {
        const effect = this.db.query<{ payload_json: string }, [string]>("SELECT payload_json FROM outbox WHERE id = ?")
          .get(`effect:${operationId}`);
        if (!effect) throw new Error("runtime operation effect is missing");
        const payload = JSON.parse(effect.payload_json) as Record<string, unknown>;
        if (payload.turnId !== undefined && payload.turnId !== details.turnId) {
          throw new Error("runtime operation turn fence conflicts with its durable effect");
        }
        if (payload.turnId === undefined) {
          this.db.query("UPDATE outbox SET payload_json = ? WHERE id = ?")
            .run(stableJson({ ...payload, turnId: details.turnId }), `effect:${operationId}`);
        }
      }
      const next: RuntimeOperationReceipt = {
        ...previous,
        ...details,
        status,
        reason: details.reason !== undefined ? details.reason : status === "queued" ? previous.reason : null,
        at: new Date(this.now()).toISOString(),
        revision: previous.revision + 1,
        ...(previous.presentationRevision !== undefined
          ? { presentationRevision: previous.presentationRevision + 1 }
          : {}),
      };
      const event = this.appendInTransaction(normalizeRuntimeEventInput({
        scope: { type: "operation", id: operationId },
        kind: "receipt",
        operationId,
        producer: { kind: "runtime-effect", eventKey: `operation:${operationId}:receipt:${previous.revision + 1}:${status}`, hostEpoch: Number(this.meta("host_epoch")) },
        payload: next as unknown as Record<string, unknown>,
      }));
      const committed = { ...next, revision: event.revision };
      this.upsertEntity("operation", operationId, event.revision, committed, event.seq);
      if (completing) this.appendCompletionConsequences(command, committed, operationId);
      this.db.query("UPDATE operations SET receipt_json = ?, event_seq = ? WHERE operation_id = ?").run(stableJson(committed), event.seq, operationId);
      if (completing) this.db.query("UPDATE outbox SET state = 'completed', payload_json = '{}' WHERE id = ?").run(`effect:${operationId}`);
      if (killBoundary) {
        this.db.query(`
          INSERT INTO outbox(id, kind, payload_json, event_seq, state)
          VALUES (?, 'runtime.kill-boundary', ?, ?, 'retained')
          ON CONFLICT(id) DO UPDATE SET
            kind = excluded.kind,
            payload_json = excluded.payload_json,
            event_seq = excluded.event_seq,
            state = excluded.state
          WHERE excluded.event_seq > outbox.event_seq
        `).run(
          `kill-boundary:${command.conversationId}`,
          stableJson({
            operationId,
            conversationId: command.conversationId,
            admissionEventSeq: killBoundary.event_seq,
          }),
          killBoundary.event_seq,
        );
      }
      this.db.exec("COMMIT");
      this.compactIfNeeded();
      this.notifyWaiters();
      return { operationId, receipt: committed, replayed: false };
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* transaction already closed */ }
      throw error;
    }
  }

  retryOperation(
    operationId: string,
    nextIdempotencyKey?: string,
    options: RuntimeRetryOptions = {},
  ): RuntimeOperationResult {
    this.assertHealthy();
    if (!this.structuredHosts) throw new Error("structured hosts are disabled");
    if (nextIdempotencyKey !== undefined) {
      const row = this.db.query<{ request_json: string; receipt_json: string }, [string]>(
        "SELECT request_json, receipt_json FROM operations WHERE operation_id = ?",
      ).get(operationId);
      if (!row) throw new Error("runtime operation is unknown");
      const previous = JSON.parse(row.receipt_json) as RuntimeOperationReceipt;
      if (previous.status === "failed" && previous.reason === RUNTIME_DELIVERY_DISCARDED_REASON) {
        const recorded = this.claimDeliveryAction(operationId, "retry");
        throw this.deliveryActionConflict(recorded.winner, "retry");
      }
      const command = JSON.parse(row.request_json) as RuntimeOperationCommand;
      if (previous.status !== "failed" && previous.status !== "rejected") {
        throw new Error("only terminal failed runtime operations can start a new attempt");
      }
      if (command.kind !== "send" && command.kind !== "steer") {
        throw new Error("runtime operation does not support retry");
      }
      if (!nextIdempotencyKey || nextIdempotencyKey === command.idempotencyKey) {
        throw new Error("a fresh idempotency key is required for a new attempt");
      }
      const replacementOperationId = terminalRetryOperationId(operationId);
      const replacement = this.db.query<{ request_json: string; receipt_json: string }, [string]>(
        "SELECT request_json, receipt_json FROM operations WHERE operation_id = ?",
      ).get(replacementOperationId);
      if (replacement) {
        const replacementCommand = JSON.parse(replacement.request_json) as RuntimeOperationCommand;
        if (retryRequestHash(replacementCommand) !== retryRequestHash(command)) {
          throw new RuntimeIdempotencyConflictError("terminal retry operation already belongs to another request");
        }
        const recorded = this.claimDeliveryAction(operationId, "retry");
        if (recorded.winner !== "retry") throw this.deliveryActionConflict(recorded.winner, "retry");
        return {
          operationId: replacementOperationId,
          receipt: JSON.parse(replacement.receipt_json) as RuntimeOperationReceipt,
          replayed: true,
        };
      }
      return this.executeOperationWithLineage({
        ...command,
        operationId: replacementOperationId,
        idempotencyKey: nextIdempotencyKey,
      }, operationId, () => {
        const current = this.db.query<{ request_json: string; receipt_json: string }, [string]>(
          "SELECT request_json, receipt_json FROM operations WHERE operation_id = ?",
        ).get(operationId);
        if (!current) throw new Error("runtime operation is unknown");
        const currentReceipt = JSON.parse(current.receipt_json) as RuntimeOperationReceipt;
        const currentCommand = JSON.parse(current.request_json) as RuntimeOperationCommand;
        if (currentReceipt.status !== "failed" && currentReceipt.status !== "rejected") {
          throw new Error("only terminal failed runtime operations can start a new attempt");
        }
        if (currentCommand.kind !== "send" && currentCommand.kind !== "steer") {
          throw new Error("runtime operation does not support retry");
        }
        if (options.requireHostedConversationId !== undefined) {
          if (currentCommand.conversationId !== options.requireHostedConversationId) {
            throw new Error("structured recovery ownership changed before retry admission");
          }
          const session = this.entity<RuntimeSession>("session", options.requireHostedConversationId);
          if (!session
            || session.host !== "hosted"
            || (session.hostKind !== "codex-app-server" && session.hostKind !== "claude-broker")) {
            throw new Error("structured recovery ownership changed before retry admission");
          }
        }
        const claimed = this.acquireDeliveryActionInTransaction(operationId, "retry", currentReceipt);
        if (claimed.winner !== "retry") throw this.deliveryActionConflict(claimed.winner, "retry");
      });
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.query<{ request_json: string; receipt_json: string }, [string]>(
        "SELECT request_json, receipt_json FROM operations WHERE operation_id = ?",
      ).get(operationId);
      if (!row) throw new Error("runtime operation is unknown");
      const previous = JSON.parse(row.receipt_json) as RuntimeOperationReceipt;
      const command = JSON.parse(row.request_json) as RuntimeOperationCommand;
      if (command.kind !== "send" && command.kind !== "steer") throw new Error("runtime operation does not support retry");
      const recorded = this.recordedDeliveryActionInTransaction(operationId, previous);
      if (recorded?.winner === "discard") throw this.deliveryActionConflict("discard", "retry");
      /* An explicit unknown-fate retry keeps the SAME operation and effect id
         (#1226). Replaying the HTTP action after its response was lost finds
         the already re-armed row and returns it without another transition. */
      if (previous.status !== "pending"
        && previous.status !== "queued"
        && previous.status !== "failed"
        && previous.status !== "uncertain") {
        throw new Error("only failed or uncertain runtime operations can retry in place");
      }
      const claimed = recorded ?? this.acquireDeliveryActionInTransaction(operationId, "retry", previous);
      if (claimed.winner !== "retry") throw this.deliveryActionConflict(claimed.winner, "retry");
      if (previous.status === "pending" || previous.status === "queued") {
        this.db.exec("COMMIT");
        return { operationId, receipt: previous, replayed: true };
      }
      const next: RuntimeOperationReceipt = {
        ...previous,
        status: "queued",
        turnId: previous.turnId ?? null,
        queuePosition: this.queuedSendCount(command.conversationId) + 1,
        reason: null,
        at: new Date(this.now()).toISOString(),
        revision: previous.revision + 1,
        ...(previous.presentationRevision !== undefined
          ? { presentationRevision: previous.presentationRevision + 1 }
          : {}),
      };
      const event = this.appendInTransaction(normalizeRuntimeEventInput({
        scope: { type: "operation", id: operationId },
        kind: "receipt",
        operationId,
        producer: { kind: "viewer-command", eventKey: `operation:${operationId}:receipt:${next.revision}:queued`, hostEpoch: Number(this.meta("host_epoch")) },
        payload: next as unknown as Record<string, unknown>,
      }));
      const committed = { ...next, revision: event.revision };
      this.upsertEntity("operation", operationId, event.revision, committed, event.seq);
      this.db.query("UPDATE operations SET receipt_json = ?, event_seq = ? WHERE operation_id = ?")
        .run(stableJson(committed), event.seq, operationId);
      this.db.query(`
        INSERT INTO outbox(id, kind, payload_json, event_seq, state)
        VALUES (?, ?, ?, ?, 'pending')
        ON CONFLICT(id) DO UPDATE SET
          kind = excluded.kind,
          payload_json = excluded.payload_json,
          event_seq = excluded.event_seq,
          state = 'pending'
      `).run(
        `effect:${operationId}`,
        `runtime.${command.kind}`,
        stableJson({
          ...command,
          operationId,
          ...(typeof previous.turnId === "string" || previous.turnId === null
            ? { turnId: previous.turnId }
            : {}),
        }),
        event.seq,
      );
      this.db.exec("COMMIT");
      this.compactIfNeeded();
      this.notifyWaiters();
      return { operationId, receipt: committed, replayed: false };
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* transaction already closed */ }
      throw error;
    }
  }

  snapshot(): RuntimeSnapshot {
    return this.snapshotAt(this.now());
  }

  private snapshotAt(now: number): RuntimeSnapshot {
    this.db.exec("BEGIN");
    try {
      const snapshot: RuntimeSnapshot = {
        schemaVersion: RUNTIME_SCHEMA_VERSION,
        snapshotSeq: Number(this.meta("published_seq")),
        retentionFloorSeq: Number(this.meta("anchor_seq")),
        serverTime: new Date(now).toISOString(),
        runtime: { hostEpoch: Number(this.meta("host_epoch")), health: this.meta("health") },
        filesRevision: Number(this.meta("files_revision")),
        sessions: this.snapshotSessionValues().map((session) => ({
          ...session,
          // Only a running turn has live text to resume. Re-normalizing here
          // also caps legacy rows to the 64 KiB UTF-8 tail; omittedChars is the
          // explicit marker that lets consumers disclose the clipped prefix.
          liveTurn: session.turn === "running"
            ? normalizeRuntimeLiveTurn(session.liveTurn)
            : null,
          recentReceipts: visibleReceipts(session.recentReceipts).map(runtimePresentationReceipt),
        })),
        attentions: this.entityValues<RuntimeAttention>("attention"),
        recentOperations: visibleReceipts(
          this.recentEntityValues<RuntimeOperationReceipt>("operation", 100),
        ).map(runtimePresentationReceipt),
        edges: this.snapshotEdgeValues(now),
        flows: this.scopedValues<RuntimeSnapshot["flows"][number]["value"]>("flow"),
        workflows: this.scopedValues<RuntimeSnapshot["workflows"][number]["value"]>("workflow"),
        tasks: this.scopedValues<RuntimeSnapshot["tasks"][number]["value"]>("task"),
        deployments: this.snapshotDeploymentValues(),
      };
      this.db.exec("COMMIT");
      return snapshot;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* transaction already closed */ }
      throw error;
    }
  }

  /** Serialized snapshot, rebuilt when the database changes or the next
      retained terminal edge reaches its age boundary. Concurrent snapshot
      consumers otherwise stack full O(state) rebuilds on the event loop until
      every socket request exceeds the client's timeout and the retry storm
      keeps the host saturated (the 2026-08-04 spawn freeze). total_changes()
      counts every row this connection has written, so no mutation path needs
      to remember to invalidate. The time expiry covers the only projection
      whose visibility changes without a write. serverTime inside the cached
      frame dates from the last rebuild; no consumer reads it. */
  snapshotJson(): string {
    const changes = this.totalChanges();
    const now = this.now();
    if (this.snapshotCache?.changes === changes
      && (this.snapshotCache.expiresAt === null || now < this.snapshotCache.expiresAt)) {
      return this.snapshotCache.json;
    }
    const json = JSON.stringify(this.snapshotAt(now));
    this.snapshotCache = { changes, expiresAt: this.snapshotEdgeExpiry(now), json };
    return json;
  }

  private totalChanges(): number {
    return Number(this.db.query<{ changes: number }, []>("SELECT total_changes() AS changes").get()?.changes ?? 0);
  }

  replay(after: number, limit = 128): RuntimeReplay {
    this.assertHealthy();
    const floorSeq = Number(this.meta("anchor_seq"));
    const publishedSeq = Number(this.meta("published_seq"));
    if (!Number.isInteger(after) || after < 0 || after < floorSeq || after > publishedSeq) return { reset: true, floorSeq, events: [] };
    const rows = this.db.query<EventRow, [number, number, number]>("SELECT * FROM events WHERE seq > ? AND seq <= ? ORDER BY seq LIMIT ?")
      .all(after, publishedSeq, Math.min(Math.max(limit, 1), 128));
    const events: RuntimeEvent[] = [];
    let bytes = 2;
    for (const row of rows) {
      const durableEvent = toEvent(row);
      const receipt = durableEvent.kind === "receipt"
        ? runtimePresentationReceipt(durableEvent.payload as unknown as RuntimeOperationReceipt)
        : null;
      const event = receipt ? {
        ...durableEvent,
        scope: { type: "operation" as const, id: receipt.operationId },
        revision: receipt.revision,
        payload: receipt as unknown as Record<string, unknown>,
      } : durableEvent;
      const size = Buffer.byteLength(JSON.stringify(event)) + (events.length ? 1 : 0);
      if (events.length && bytes + size > 240 * 1024) break;
      events.push(event);
      bytes += size;
    }
    return { reset: false, floorSeq, events };
  }

  publishedSeq(): number {
    this.assertHealthy();
    return Number(this.meta("published_seq"));
  }

  sessionState(conversationId: string): RuntimeSession | null {
    return this.entity<RuntimeSession>("session", conversationId);
  }

  admitViewerDeployment(
    input: { idempotencyKey: string; requestedRevision: string; revision: string },
    owner: ViewerDeploymentOwner,
  ): ViewerDeploymentReceipt {
    this.assertHealthy();
    const requestHash = createHash("sha256").update(stableJson({ requestedRevision: input.requestedRevision, revision: input.revision })).digest("hex");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db.query<{ deployment_id: string; request_hash: string; status_json: string }, [string]>(
        "SELECT deployment_id, request_hash, status_json FROM viewer_deployments WHERE idempotency_key = ?",
      ).get(input.idempotencyKey);
      if (existing) {
        if (existing.request_hash !== requestHash) throw new RuntimeIdempotencyConflictError("idempotency key already belongs to another deployment");
        const status = JSON.parse(existing.status_json) as ViewerDeploymentStatus;
        this.db.exec("COMMIT");
        return { state: "accepted", deploymentId: status.deploymentId, revision: status.revision, replayed: true };
      }
      const active = this.db.query<{ status_json: string }, []>("SELECT status_json FROM viewer_deployments WHERE active = 1").get();
      if (active) {
        const status = JSON.parse(active.status_json) as ViewerDeploymentStatus;
        this.db.exec("COMMIT");
        return { state: "busy", deploymentId: status.deploymentId, revision: status.revision };
      }
      const now = this.now();
      const deploymentId = `deploy_${randomUUID()}`;
      const status: ViewerDeploymentStatus = {
        deploymentId,
        idempotencyKey: input.idempotencyKey,
        requestedRevision: input.requestedRevision,
        revision: input.revision,
        phase: "admitted",
        terminal: false,
        candidate: null,
        previous: null,
        mcpRuntime: { candidate: null, previous: null, publications: [], health: [] },
        health: [],
        error: null,
        owner,
        createdAt: new Date(now).toISOString(),
        updatedAt: new Date(now).toISOString(),
        revisionNumber: 1,
      };
      this.db.query("INSERT INTO viewer_deployments(deployment_id, idempotency_key, request_hash, status_json, active, updated_at) VALUES (?, ?, ?, ?, 1, ?)")
        .run(deploymentId, input.idempotencyKey, requestHash, stableJson(status), now);
      this.appendInTransaction(normalizeRuntimeEventInput({
        scope: { type: "deployment", id: deploymentId },
        kind: "deployment.state",
        producer: { kind: "runtime-host", eventKey: `deployment:${deploymentId}:1` },
        payload: status as unknown as Record<string, unknown>,
      }));
      this.db.exec("COMMIT");
      this.notifyWaiters();
      return { state: "accepted", deploymentId, revision: input.revision, replayed: false };
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* transaction already closed */ }
      throw error;
    }
  }

  viewerDeployment(deploymentId: string): ViewerDeploymentStatus | null {
    const row = this.db.query<{ status_json: string }, [string]>("SELECT status_json FROM viewer_deployments WHERE deployment_id = ?").get(deploymentId);
    return row ? JSON.parse(row.status_json) as ViewerDeploymentStatus : null;
  }

  viewerDeploymentByIdempotencyKey(idempotencyKey: string): ViewerDeploymentStatus | null {
    const row = this.db.query<{ status_json: string }, [string]>("SELECT status_json FROM viewer_deployments WHERE idempotency_key = ?").get(idempotencyKey);
    return row ? JSON.parse(row.status_json) as ViewerDeploymentStatus : null;
  }

  latestViewerDeploymentForRevision(revision: string): ViewerDeploymentStatus | null {
    const rows = this.db.query<{ status_json: string }, []>(
      "SELECT status_json FROM viewer_deployments ORDER BY updated_at DESC",
    ).all();
    for (const row of rows) {
      const status = JSON.parse(row.status_json) as ViewerDeploymentStatus;
      if (status.revision === revision) return status;
    }
    return null;
  }

  activeViewerDeployment(): ViewerDeploymentStatus | null {
    const row = this.db.query<{ status_json: string }, []>("SELECT status_json FROM viewer_deployments WHERE active = 1").get();
    return row ? JSON.parse(row.status_json) as ViewerDeploymentStatus : null;
  }

  updateViewerDeployment(
    deploymentId: string,
    update: Partial<Omit<ViewerDeploymentStatus, "deploymentId" | "idempotencyKey" | "requestedRevision" | "revision" | "createdAt" | "revisionNumber">>,
  ): ViewerDeploymentStatus {
    this.assertHealthy();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.viewerDeployment(deploymentId);
      if (!current) throw new Error("viewer deployment is missing");
      const now = this.now();
      const next: ViewerDeploymentStatus = {
        ...current,
        ...update,
        deploymentId: current.deploymentId,
        idempotencyKey: current.idempotencyKey,
        requestedRevision: current.requestedRevision,
        revision: current.revision,
        createdAt: current.createdAt,
        updatedAt: new Date(now).toISOString(),
        revisionNumber: current.revisionNumber + 1,
      };
      this.db.query("UPDATE viewer_deployments SET status_json = ?, active = ?, updated_at = ? WHERE deployment_id = ?")
        .run(stableJson(next), next.terminal ? 0 : 1, now, deploymentId);
      this.appendInTransaction(normalizeRuntimeEventInput({
        scope: { type: "deployment", id: deploymentId },
        kind: "deployment.state",
        producer: { kind: "runtime-host", eventKey: `deployment:${deploymentId}:${next.revisionNumber}` },
        payload: next as unknown as Record<string, unknown>,
      }));
      this.db.exec("COMMIT");
      this.notifyWaiters();
      return next;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* transaction already closed */ }
      throw error;
    }
  }

  isWritable(): boolean {
    return this.fault === null;
  }

  consumerCompleted(eventId: string, consumer: string): boolean {
    this.assertHealthy();
    return Boolean(this.db.query<{ present: number }, [string, string]>("SELECT 1 AS present FROM consumer_checkpoints WHERE event_id = ? AND consumer = ?").get(eventId, consumer));
  }

  markConsumerCompleted(eventId: string, consumer: string): void {
    this.assertHealthy();
    this.db.query("INSERT INTO consumer_checkpoints(event_id, consumer, completed_at) VALUES (?, ?, ?) ON CONFLICT(event_id, consumer) DO NOTHING").run(eventId, consumer, this.now());
  }

  unconsumedEvents(consumer: string, limit = 128): RuntimeEvent[] {
    this.assertHealthy();
    return this.db.query<EventRow, [string, number]>(`
      SELECT events.* FROM events
      WHERE NOT EXISTS (
        SELECT 1 FROM consumer_checkpoints
        WHERE consumer_checkpoints.event_id = events.event_id
          AND consumer_checkpoints.consumer = ?
      )
      ORDER BY events.seq
      LIMIT ?
    `).all(consumer, Math.min(Math.max(limit, 1), 128)).map(toEvent);
  }

  claimHostEpoch(): number {
    const epoch = this.claimHostEpochInTransaction();
    /* Outside the epoch transaction on purpose: the sweep opens transactions of
       its own, and a claimed epoch must never be undone by a failure to settle
       an old receipt. */
    this.terminalizeUnverifiedCompactions();
    return epoch;
  }

  private claimHostEpochInTransaction(): number {
    this.assertHealthy();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const epoch = Number(this.meta("host_epoch")) + 1;
      this.metaSet("host_epoch", String(epoch));
      this.metaSet("health", "ready");
      /* A fresh spawn placeholder (identity still the conversation id, no
         transcript ever published) cannot outlive the host epoch that admitted
         it: materialization always re-projects hosted state from the launcher.
         Rows still registering at a new epoch are orphans of interrupted or
         failed launches — production #367 kept them registering/unknown across
         restarts while health claimed ready. Resume admissions keep their
         prior identity and settle through Viewer startup recovery. */
      for (const session of this.entityValues<RuntimeSession>("session")) {
        if (session.host !== "registering") continue;
        if (session.artifactPath !== null || session.sessionKey.sessionId !== session.conversationId) continue;
        this.appendInTransaction(normalizeRuntimeEventInput({
          scope: { type: "session", id: session.conversationId },
          kind: "session-status",
          producer: {
            kind: "runtime-host",
            hostEpoch: epoch,
            eventKey: `host-epoch:${epoch}:registering-reconciled:${session.conversationId}`,
          },
          payload: {
            conversationId: session.conversationId,
            host: "dead",
            turn: "idle",
            activeTurnId: null,
            attentionIds: [],
          },
        }));
      }
      this.db.exec("COMMIT");
      this.notifyWaiters();
      return epoch;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* transaction already closed */ }
      throw error;
    }
  }

  /**
   * #862: the executor writes `delivering` before it writes
   * `thread/compact/start`, so a compact operation still in that state at a new
   * host epoch is one whose engine outcome this process cannot verify. Replaying
   * it could compact the thread twice, so it terminalizes visibly instead. A
   * compact still `pending` was never issued and replays normally; a terminal
   * one already has a completed outbox row and is never reissued.
   */
  private terminalizeUnverifiedCompactions(): void {
    /* Prefiltered in SQL: an epoch claim is on the startup path, and every row
       this sweep can act on names both tokens in its stored receipt. The JSON
       parse below still decides — LIKE only keeps the scan off rows that cannot
       possibly match. */
    const rows = this.db.query<{ operation_id: string; receipt_json: string }, []>(
      `SELECT operation_id, receipt_json FROM operations
       WHERE receipt_json LIKE '%"kind":"compact"%' AND receipt_json LIKE '%"status":"delivering"%'
       ORDER BY event_seq`,
    ).all();
    for (const row of rows) {
      /* Per row: the epoch is already claimed, so one unreadable receipt or one
         refused transition must not fail runtime-host startup and leave the
         claim behind. A row that cannot be settled here stays `delivering` and
         is swept again at the next epoch. */
      try {
        const receipt = JSON.parse(row.receipt_json) as RuntimeOperationReceipt;
        if (receipt.kind !== "compact" || receipt.status !== "delivering") continue;
        this.transitionOperation(row.operation_id, "uncertain", {
          reason: "compaction was in flight during a runtime-host restart; its outcome is unverified",
        });
      } catch {
        console.error(`[runtime journal] compaction ${row.operation_id} could not be settled at this epoch`);
      }
    }
  }

  waitForEvents(after: number, timeoutMs = 15_000, signal?: AbortSignal): Promise<RuntimeReplay> {
    const immediate = this.replay(after);
    if (immediate.reset || immediate.events.length > 0) return Promise.resolve(immediate);
    const timeout = Math.min(Math.max(timeoutMs, 10), 30_000);
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const cleanup = () => {
        if (timer !== null) clearTimeout(timer);
        this.waiters.delete(finish);
        signal?.removeEventListener("abort", abort);
      };
      const finish = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(this.replay(after));
      };
      const abort = () => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error("runtime wait aborted"));
      };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) {
        abort();
        return;
      }
      this.waiters.add(finish);
      timer = setTimeout(finish, timeout);
    });
  }

  producerCursor(producerKind: string, eventKeyPrefix: string): number {
    if (!producerKind || !eventKeyPrefix) throw new Error("runtime producer cursor is invalid");
    const rows = this.db.query<{ producer_key: string }, [string, string, string]>(
      "SELECT producer_key FROM producer_receipts WHERE producer_kind = ? AND producer_key >= ? AND producer_key < ?",
    ).all(producerKind, eventKeyPrefix, `${eventKeyPrefix}\uffff`);
    let cursor = 0;
    for (const row of rows) {
      if (!row.producer_key.startsWith(eventKeyPrefix)) continue;
      const sequence = Number(row.producer_key.slice(eventKeyPrefix.length));
      if (Number.isSafeInteger(sequence) && sequence > cursor) cursor = sequence;
    }
    return cursor;
  }

  /** Settle only old spawn/kill work whose two liveness authorities agree it
      has no owner: the journal has no hosted/recovering session and the durable
      agent registry is absent, marks the host dead, or marks the conversation
      superseded. Pending sends and interrupts retain their existing unknown-
      fate rules. */
  settleStalePendingEffects(
    registryConversations: ReadonlyMap<string, RuntimeRegistryConversationRetentionState>,
    horizonMs = RUNTIME_PENDING_EFFECT_STALE_MS,
  ): { scanned: number; settled: number } {
    this.assertHealthy();
    const horizon = Math.max(1, horizonMs);
    const rows = this.db.query<{
      operation_id: string;
      conversation_id: string;
      receipt_json: string;
      orphaned_since: number | null;
    }, []>(`
      SELECT operations.operation_id, operations.conversation_id, operations.receipt_json,
        operations.orphaned_since
      FROM operations
      JOIN outbox ON outbox.id = 'effect:' || operations.operation_id
      WHERE outbox.state = 'pending'
        AND outbox.kind IN ('runtime.spawn', 'runtime.kill')
        AND json_extract(operations.receipt_json, '$.status') IN ('pending', 'queued')
      ORDER BY operations.event_seq
    `).all();
    let settled = 0;
    const sampledAt = this.now();
    for (const row of rows) {
      try {
        const receipt = JSON.parse(row.receipt_json) as RuntimeOperationReceipt;
        const session = this.entity<RuntimeSession>("session", row.conversation_id);
        const registryState = registryConversations.get(row.conversation_id);
        if (session?.host === "hosted" || session?.host === "recovering" || registryState === "current") {
          if (row.orphaned_since !== null) {
            this.db.query("UPDATE operations SET orphaned_since = NULL WHERE operation_id = ?")
              .run(row.operation_id);
          }
          continue;
        }
        if (row.orphaned_since === null) {
          this.db.query("UPDATE operations SET orphaned_since = ? WHERE operation_id = ?")
            .run(sampledAt, row.operation_id);
          continue;
        }
        if (sampledAt - row.orphaned_since < horizon) continue;
        const ageMinutes = Math.ceil(horizon / 60_000);
        let reason = `stale: ${receipt.kind} target has no runtime host and no agent registry record after ${ageMinutes} minutes`;
        if (registryState === "superseded") {
          reason = `stale: ${receipt.kind} target has no runtime host and its registry conversation is superseded after ${ageMinutes} minutes`;
        } else if (registryState === "dead") {
          reason = `stale: ${receipt.kind} target has no runtime host and its registry host is dead after ${ageMinutes} minutes`;
        }
        this.transitionOperation(row.operation_id, "failed", { reason });
        settled += 1;
      } catch (error) {
        console.error(`[runtime journal] stale effect ${row.operation_id} could not be settled: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return { scanned: rows.length, settled };
  }

  effectBatch(limit = 100, kinds?: readonly string[], afterEventSeq = 0): Array<RuntimeEffect & { eventSeq: number }> {
    if (kinds?.length === 0) return [];
    if (!Number.isSafeInteger(afterEventSeq) || afterEventSeq < 0) throw new Error("runtime effect cursor is invalid");
    const stateFilter = kinds?.includes("runtime.kill-boundary")
      ? "(state = 'pending' OR (state = 'retained' AND kind = 'runtime.kill-boundary'))"
      : "state = 'pending'";
    const kindFilter = kinds ? ` AND kind IN (${kinds.map(() => "?").join(", ")})` : "";
    const rows = this.db.query<{ id: string; kind: string; payload_json: string; event_seq: number }, Array<string | number>>(
      `SELECT id, kind, payload_json, event_seq
       FROM outbox
       WHERE ${stateFilter}${kindFilter}
         AND event_seq > ?
         AND (
           id NOT LIKE 'effect:%'
           OR NOT EXISTS (
             SELECT 1
             FROM operations
             WHERE operations.operation_id = substr(outbox.id, 8)
               AND json_extract(operations.receipt_json, '$.status') NOT IN ('pending', 'queued', 'delivering', 'applying')
           )
         )
       ORDER BY event_seq
       LIMIT ?`,
    ).all(...(kinds ?? []), afterEventSeq, limit);
    return rows.map((row) => {
      const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
      if (row.kind === "runtime.answer") payload.resolution = this.decryptSecret(payload.resolution);
      return { id: row.id, kind: row.kind, payload, eventSeq: row.event_seq };
    });
  }

  compact(maxEvents = this.maxEvents): void {
    this.assertHealthy();
    const count = Number(this.db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM events").get()?.count ?? 0);
    if (count <= maxEvents) return;
    const remove = count - maxEvents;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const anchor = this.db.query<{ seq: number; hash: string }, [number]>("SELECT seq, hash FROM events ORDER BY seq LIMIT 1 OFFSET ?").get(remove - 1);
      if (!anchor) throw new RuntimeJournalFault("journal compaction anchor is missing");
      this.db.query("DELETE FROM events WHERE seq <= ?").run(anchor.seq);
      this.db.exec("DELETE FROM consumer_checkpoints WHERE NOT EXISTS (SELECT 1 FROM events WHERE events.event_id = consumer_checkpoints.event_id)");
      this.db.query("DELETE FROM outbox WHERE state = 'completed' AND event_seq <= ?").run(anchor.seq);
      this.db.query("DELETE FROM operations WHERE event_seq <= ? AND operation_id NOT IN (SELECT substr(id, 8) FROM outbox WHERE state = 'pending' AND id LIKE 'effect:%')").run(anchor.seq);
      this.db.exec("DELETE FROM delivery_operation_actions WHERE operation_id NOT IN (SELECT operation_id FROM operations)");
      this.db.query("DELETE FROM entities WHERE kind = 'operation' AND checkpoint_seq <= ?").run(anchor.seq);
      this.metaSet("anchor_seq", String(anchor.seq));
      this.metaSet("anchor_hash", anchor.hash);
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* transaction already closed */ }
      throw error;
    }
  }

  /** Bounded producer-receipt retention pass; the timer in main.ts owns the
      cadence. compact() bounds every other table but never touched
      producer_receipts, which grew to 1.5M rows / 1.66 GB in production —
      85% of the journal file. Two rules, applied to at most `budget` rows per
      call so a pass never stalls the socket loop:
      - engine-cursor receipts (`engine-host:…:<seq>`) keep only the highest
        sequence per session prefix — the same invariant the append path
        enforces, extended to prefixes that stopped appending before that
        dedupe shipped;
      - other receipts expire once their event falls below the compaction
        anchor, matching the retention of the operations table. A duplicate
        eventKey older than the events window re-appends instead of deduping,
        the trade compact() already made for operations.
      The cursor is in-memory: a restart rescans from rowid 0, and the pass is
      idempotent. */
  maintainProducerReceipts(budget = 4_096): { scanned: number; deleted: number; cycled: boolean } {
    this.assertHealthy();
    const limit = Math.max(1, budget);
    const anchorSeq = Number(this.meta("anchor_seq"));
    const rows = this.db.query<{ rowid: number; producer_kind: string; producer_key: string; event_seq: number | null }, [number, number]>(
      "SELECT rowid, producer_kind, producer_key, CAST(json_extract(event_json, '$.seq') AS INTEGER) AS event_seq FROM producer_receipts WHERE rowid > ? ORDER BY rowid LIMIT ?",
    ).all(this.receiptSweepCursor, limit);
    const cycled = rows.length < limit;
    this.receiptSweepCursor = cycled ? 0 : rows[rows.length - 1]!.rowid;
    const latestByPrefix = new Map<string, string>();
    const stale: number[] = [];
    for (const row of rows) {
      const cursor = engineProducerCursor(row.producer_kind, row.producer_key);
      if (cursor) {
        const group = `${row.producer_kind} ${cursor.prefix}`;
        let latestKey = latestByPrefix.get(group);
        if (latestKey === undefined) {
          latestKey = this.db.query<{ producer_key: string }, [string, string, string, string]>(
            "SELECT producer_key FROM producer_receipts WHERE producer_kind = ? AND producer_key >= ? AND producer_key < ? ORDER BY CAST(substr(producer_key, length(?) + 1) AS INTEGER) DESC LIMIT 1",
          ).get(row.producer_kind, cursor.prefix, `${cursor.prefix}\uffff`, cursor.prefix)?.producer_key ?? row.producer_key;
          latestByPrefix.set(group, latestKey);
        }
        if (row.producer_key !== latestKey) stale.push(row.rowid);
      } else if (row.event_seq !== null && row.event_seq <= anchorSeq) {
        stale.push(row.rowid);
      }
    }
    if (stale.length > 0) {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        for (let start = 0; start < stale.length; start += 500) {
          const batch = stale.slice(start, start + 500);
          this.db.query(`DELETE FROM producer_receipts WHERE rowid IN (${batch.map(() => "?").join(", ")})`).run(...batch);
        }
        this.db.exec("COMMIT");
      } catch (error) {
        try { this.db.exec("ROLLBACK"); } catch { /* transaction already closed */ }
        throw error;
      }
      // Reclaims pages only where the file was born with auto_vacuum set
      // (fresh databases); on older files the freed pages are still reused.
      this.db.exec("PRAGMA incremental_vacuum(2048)");
    }
    return { scanned: rows.length, deleted: stale.length, cycled };
  }

  close(): void { this.db.close(); }

  private appendInTransaction(input: NormalizedRuntimeEventInput): RuntimeEvent {
    const producerKey = input.producer.eventKey ?? null;
    const engineCursor = producerKey ? engineProducerCursor(input.producer.kind, producerKey) : null;
    if (producerKey) {
      if (engineCursor) {
        const latest = this.db.query<{ producer_key: string; event_json: string }, [string, string, string, string]>(
          "SELECT producer_key, event_json FROM producer_receipts WHERE producer_kind = ? AND producer_key >= ? AND producer_key < ? ORDER BY CAST(substr(producer_key, length(?) + 1) AS INTEGER) DESC LIMIT 1",
        ).get(input.producer.kind, engineCursor.prefix, `${engineCursor.prefix}\uffff`, engineCursor.prefix);
        if (latest) {
          const latestCursor = engineProducerCursor(input.producer.kind, latest.producer_key);
          if (latestCursor && latestCursor.sequence >= engineCursor.sequence) {
            this.db.query(
              "DELETE FROM producer_receipts WHERE producer_kind = ? AND producer_key >= ? AND producer_key < ? AND producer_key <> ?",
            ).run(input.producer.kind, engineCursor.prefix, `${engineCursor.prefix}\uffff`, latest.producer_key);
            return JSON.parse(latest.event_json) as RuntimeEvent;
          }
        }
      } else {
        const duplicate = this.db.query<{ event_json: string }, [string, string]>("SELECT event_json FROM producer_receipts WHERE producer_kind = ? AND producer_key = ?").get(input.producer.kind, producerKey);
        if (duplicate) return JSON.parse(duplicate.event_json) as RuntimeEvent;
      }
    }
    const now = this.now();
    const seq = Number(this.meta("seq")) + 1;
    const scope = runtimeScopeKey(input.scope);
    const revision = Number(this.db.query<{ revision: number }, [string]>("SELECT revision FROM scope_revisions WHERE scope = ?").get(scope)?.revision ?? 0) + 1;
    const payloadJson = stableJson(input.payload);
    const previous = this.meta("hash");
    const eventId = `evt_${randomUUID()}`;
    const occurredAt = input.occurredAt ?? new Date(now).toISOString();
    const recordedAt = new Date(now).toISOString();
    const unsigned: HashableEventRow = {
      seq,
      event_id: eventId,
      scope,
      revision,
      kind: input.kind,
      payload_json: payloadJson,
      created_at: now,
      occurred_at: occurredAt,
      recorded_at: recordedAt,
      producer_kind: input.producer.kind,
      producer_account_id: input.producer.accountId ?? null,
      producer_key: producerKey,
      producer_host_epoch: input.producer.hostEpoch ?? null,
      operation_id: input.operationId ?? null,
      causation_id: input.causationId ?? input.operationId ?? null,
      correlation_id: input.correlationId ?? null,
    };
    const hash = recordHash(previous, unsigned);
    const event: EventRow = {
      ...unsigned,
      prev_hash: previous,
      hash,
    };
    this.db.query(`
      INSERT INTO events(
        seq, event_id, scope, revision, kind, payload_json, created_at,
        occurred_at, recorded_at, producer_kind, producer_account_id, producer_key,
        producer_host_epoch, operation_id, causation_id, correlation_id, prev_hash, hash
      ) VALUES (
        $seq, $event_id, $scope, $revision, $kind, $payload_json, $created_at,
        $occurred_at, $recorded_at, $producer_kind, $producer_account_id, $producer_key,
        $producer_host_epoch, $operation_id, $causation_id, $correlation_id, $prev_hash, $hash
      )
    `).run(event);
    this.db.query("INSERT INTO scope_revisions(scope, revision) VALUES (?, ?) ON CONFLICT(scope) DO UPDATE SET revision=excluded.revision").run(scope, revision);
    if (producerKey) {
      this.db.query("INSERT INTO producer_receipts(producer_kind, producer_key, event_json) VALUES (?, ?, ?)").run(input.producer.kind, producerKey, stableJson(toEvent(event)));
      if (engineCursor) {
        this.db.query(
          "DELETE FROM producer_receipts WHERE producer_kind = ? AND producer_key >= ? AND producer_key < ? AND producer_key <> ?",
        ).run(input.producer.kind, engineCursor.prefix, `${engineCursor.prefix}\uffff`, producerKey);
      }
    }
    const projection = stableJson({ revision, lastKind: input.kind, payload: input.payload });
    this.db.query("INSERT INTO projections(scope, revision, state_json, checkpoint_seq) VALUES (?, ?, ?, ?) ON CONFLICT(scope) DO UPDATE SET revision=excluded.revision, state_json=excluded.state_json, checkpoint_seq=excluded.checkpoint_seq").run(scope, revision, projection, seq);
    this.project(event, input.payload);
    if (input.effect) this.insertEffect(input.effect, seq);
    this.metaSet("seq", String(seq));
    this.metaSet("published_seq", String(seq));
    this.metaSet("hash", hash);
    return toEvent(event);
  }

  private assertOperation(command: RuntimeOperationCommand): void {
    if (!command.conversationId || command.conversationId.includes(":") || /\s/.test(command.conversationId)) throw new Error("conversationId is invalid");
    if (!command.idempotencyKey || command.idempotencyKey.length > 200) throw new Error("idempotencyKey is invalid");
    if (command.operationId !== undefined && (!command.operationId.trim() || command.operationId.includes(":") || /\s/.test(command.operationId))) throw new Error("operationId is invalid");
    if (Buffer.byteLength(JSON.stringify(command)) > 256 * 1024) throw new Error("runtime operation exceeds 256 KiB");
    if (command.kind === "send" || command.kind === "steer") {
      if (!command.text.trim() && !command.images?.length) throw new Error("message content is required");
      if (!command.contentDigest) throw new Error("message content digest is required");
    }
    if (command.kind === "answer" && !command.attentionId.trim()) throw new Error("attentionId is required");
    if ((command.kind === "kill" || command.kind === "compact" || (command.kind === "reconfigure" && command.sessionKey))
      && ((!command.sessionKey || (command.sessionKey.engine !== "codex" && command.sessionKey.engine !== "claude"))
        || !command.sessionKey.sessionId?.trim())) {
      throw new Error(`${command.kind} sessionKey is invalid`);
    }
    if (command.kind === "spawn"
      && (typeof command.cwd !== "string" || !command.cwd.trim() || typeof command.prompt !== "string")) {
      throw new Error("spawn cwd and prompt are required");
    }
  }

  private normalizeOperation(command: RuntimeOperationCommand): RuntimeOperationCommand {
    if (command.kind !== "send" && command.kind !== "steer" && command.kind !== "spawn") return command;
    const rawImages = command.images ?? [];
    const images = parseStructuredImageRefs(rawImages, 16);
    if (!images) throw new Error("message images are invalid");
    const text = command.kind === "spawn" ? command.prompt : command.text;
    if (!text.trim() && images.length === 0) {
      if (command.kind === "spawn") {
        const rest = { ...command };
        delete rest.images;
        delete rest.contentDigest;
        return { ...rest, prompt: "" };
      }
      throw new Error("message content is required");
    }
    const normalized = structuredContent(text, images);
    if (command.contentDigest && command.contentDigest !== normalized.contentDigest) {
      throw new Error("message content digest mismatch");
    }
    if (command.kind === "spawn") {
      const rest = { ...command };
      delete rest.images;
      delete rest.contentDigest;
      return {
        ...rest,
        "prompt": normalized.content.text,
        ...(images.length ? { images } : {}),
        contentDigest: normalized.contentDigest,
      };
    }
    const rest = { ...command };
    delete rest.images;
    delete rest.contentDigest;
    return {
      ...rest,
      text: normalized.content.text,
      ...(images.length ? { images } : {}),
      contentDigest: normalized.contentDigest,
    };
  }

  private operationReceipt(
    command: RuntimeOperationCommand,
    operationId: string,
    retryOfOperationId?: string,
    retryParent: RuntimeOperationReceipt | null = null,
  ): RuntimeOperationReceipt {
    const session = this.entity<RuntimeSession>("session", command.conversationId);
    let status: RuntimeReceiptStatus;
    let reason: string | null = null;
    let turnId = "turnId" in command && typeof command.turnId === "string" ? command.turnId : session?.activeTurnId ?? null;
    let queuePosition: number | null = null;
    if (this.structuredHosts
      && command.kind === "send"
      && (session?.hostKind === "codex-app-server" || session?.hostKind === "claude-broker")) {
      if (!session || session.host !== "hosted") {
        status = "rejected";
        reason = session?.host === "dead" || session?.host === "unhosted" ? "dead-host" : "no-claim";
      } else if (command.turnId && command.turnId !== session.activeTurnId) {
        status = "rejected";
        reason = "stale-turn";
      } else {
        status = "queued";
        queuePosition = this.queuedSendCount(command.conversationId) + 1;
        turnId = null;
      }
    } else if (command.kind === "send" || command.kind === "steer") {
      if (!session || session.host !== "hosted") {
        status = "rejected";
        reason = session?.host === "dead" || session?.host === "unhosted" ? "dead-host" : "no-claim";
      } else if (command.turnId && command.turnId !== session.activeTurnId) {
        status = "rejected";
        reason = "stale-turn";
      } else if ((command.kind === "steer" || command.policy !== "queue") && session.turn === "running" && session.capabilities.steer) {
        status = "pending";
        turnId = session.activeTurnId;
      } else if (command.kind === "steer") {
        status = "rejected";
        reason = "stale-turn";
      } else if (session.turn === "running") {
        status = "queued";
        queuePosition = 1;
      } else if (session.turn === "idle") {
        status = "pending";
        turnId = null;
      } else {
        status = "rejected";
        reason = "stale-turn";
      }
    } else if (command.kind === "interrupt") {
      if (!session || session.host !== "hosted") {
        status = "rejected";
        reason = session?.host === "dead" || session?.host === "unhosted" ? "dead-host" : "no-claim";
      } else if (command.turnId && command.turnId !== session.activeTurnId) {
        status = "rejected";
        reason = "stale-turn";
      } else if (session.turn !== "running" && session.turn !== "interrupt_requested") {
        status = "interrupted";
        turnId = command.turnId ?? null;
      } else {
        status = "pending";
        turnId = session.activeTurnId;
      }
    } else if (command.kind === "compact") {
      /* #862: admission is the race-safe fence. It is evaluated inside the
         BEGIN IMMEDIATE that admits the operation, so the durable turn axis it
         reads cannot move underneath it — a compaction is only ever admitted
         against a hosted, idle generation on an engine that has the control. */
      turnId = null;
      const capability = runtimeCompactCapability(command.sessionKey.engine);
      if (!session || session.host !== "hosted") {
        status = "rejected";
        reason = session?.host === "dead" || session?.host === "unhosted" ? "dead-host" : "no-claim";
      } else if (!capability.supported
        || (session.hostKind !== "codex-app-server" && session.hostKind !== "claude-broker")) {
        /* #1214: claude-broker admits compaction too — its host types
           `/compact` into the conversation, the only mechanism the stream-json
           transport offers. A host kind with neither path is still refused
           here rather than left to the delivery queue. */
        status = "rejected";
        reason = "unsupported-capability";
      } else if (session.sessionKey.engine !== command.sessionKey.engine
        || session.sessionKey.sessionId !== command.sessionKey.sessionId) {
        status = "rejected";
        reason = "stale-generation";
      } else if (session.turn === "running" || session.turn === "interrupt_requested" || session.activeTurnId) {
        status = "rejected";
        reason = "busy-turn";
      } else {
        status = "pending";
      }
    } else if (command.kind === "answer") {
      const attention = this.entity<RuntimeAttention>("attention", command.attentionId);
      if (!attention || attention.conversationId !== command.conversationId) {
        status = "rejected";
        reason = "attention-missing";
      } else if (attention.state !== "open") {
        status = attention.state === "resolving" ? "rejected" : "answered";
        reason = attention.state === "resolving" ? "attention-resolving" : null;
        turnId = attention.turnId ?? turnId;
      } else if (!session || session.host !== "hosted") {
        status = "rejected";
        reason = session?.host === "dead" || session?.host === "unhosted" ? "dead-host" : "no-claim";
      } else {
        status = "pending";
        turnId = attention.turnId ?? turnId;
      }
    } else if (command.kind === "kill") {
      status = "queued";
      turnId = null;
    } else {
      status = "queued";
    }
    const revision = Number(this.db.query<{ revision: number }, [string]>("SELECT revision FROM scope_revisions WHERE scope = ?").get(`operation:${operationId}`)?.revision ?? 0) + 1;
    const admittedAt = new Date(this.now()).toISOString();
    return {
      operationId,
      ...(retryOfOperationId ? { retryOfOperationId } : {}),
      ...(retryParent ? {
        presentationOperationId: retryParent.presentationOperationId ?? retryParent.operationId,
        presentationRevision: (retryParent.presentationRevision ?? retryParent.revision) + 1,
      } : {}),
      idempotencyKey: command.idempotencyKey,
      conversationId: command.conversationId,
      kind: command.kind,
      status,
      turnId,
      queuePosition,
      reason,
      text: command.kind === "send" || command.kind === "steer" ? command.text.slice(0, 240) : null,
      ...(command.kind === "send" || command.kind === "steer" ? { imageCount: command.images?.length ?? 0 } : {}),
      ...((command.kind === "send" || command.kind === "steer") && command.runtime ? { runtime: command.runtime } : {}),
      at: admittedAt,
      /* Immutable admission stamp (issue #1213). Every transition rewrites
         `at`, so only this can say how long the operator has been waiting on a
         message the queue keeps parking. A retry mints a NEW operation and
         therefore a new stamp: the operator restarted the wait deliberately. */
      admittedAt,
      revision,
    };
  }

  private queuedSendCount(conversationId: string): number {
    return this.db.query<{ receipt_json: string }, []>("SELECT receipt_json FROM operations ORDER BY event_seq").all()
      .map((row) => JSON.parse(row.receipt_json) as RuntimeOperationReceipt)
      .filter((receipt) => receipt.conversationId === conversationId
        && receipt.kind === "send"
        && (receipt.status === "pending" || receipt.status === "queued" || receipt.status === "delivering"))
      .length;
  }

  private appendOperationConsequences(command: RuntimeOperationCommand, receipt: RuntimeOperationReceipt, operationId: string): void {
    if (receipt.status === "rejected" || receipt.status === "failed" || receipt.status === "uncertain") return;
    const producer = { kind: "runtime-host", hostEpoch: Number(this.meta("host_epoch")) };
    if (command.kind === "answer" && receipt.status === "pending") {
      const attention = this.entity<RuntimeAttention>("attention", command.attentionId);
      if (!attention) return;
      this.appendInTransaction(normalizeRuntimeEventInput({
        scope: { type: "session", id: command.conversationId },
        kind: "attention",
        operationId,
        producer: { ...producer, eventKey: `operation:${operationId}:attention-resolving` },
        payload: { ...attention, state: "resolving" },
      }));
      return;
    }
    if (command.kind === "interrupt") {
      this.appendInTransaction(normalizeRuntimeEventInput({
        scope: { type: "session", id: command.conversationId },
        kind: "session-status",
        operationId,
        producer: { ...producer, eventKey: `operation:${operationId}:interrupt-requested` },
        payload: { conversationId: command.conversationId, turn: "interrupt_requested", activeTurnId: receipt.turnId ?? null },
      }));
      return;
    }
    if (command.kind === "reconfigure") {
      this.appendInTransaction(normalizeRuntimeEventInput({
        scope: { type: "session", id: command.conversationId },
        kind: "session-status",
        operationId,
        producer: { ...producer, eventKey: `operation:${operationId}:reconfigure-queued` },
        payload: {
          conversationId: command.conversationId,
          pendingReconfigure: {
            operationId,
            model: command.model,
            effort: command.effort,
            fast: command.fast,
            ...(command.accountId ? { accountId: command.accountId } : {}),
          },
        },
      }));
      return;
    }
    if (command.kind === "spawn") {
      const requestedParentConversationId = command.parentConversationId && command.parentConversationId !== command.conversationId
        ? command.parentConversationId
        : null;
      const parentConversationId = requestedParentConversationId
        ?? this.entity<RuntimeSession>("session", command.conversationId)?.parentConversationId
        ?? null;
      this.appendInTransaction(normalizeRuntimeEventInput({
        scope: { type: "session", id: command.conversationId },
        kind: "session-status",
        operationId,
        producer: { ...producer, eventKey: `operation:${operationId}:session-placeholder` },
        payload: {
          conversationId: command.conversationId,
          sessionKey: { engine: command.engine, sessionId: command.sessionId ?? command.conversationId },
          hostKind: command.engine === "codex" ? "codex-app-server" : "claude-broker",
          host: "registering",
          turn: "unknown",
          provenance: "structured",
          accountId: command.accountId ?? null,
          parentConversationId,
          cwd: command.cwd,
          artifactPath: null,
          capabilities: {
            steer: command.engine === "codex",
            structuredAttention: true,
            imageInput: runtimeImageCapability(command.engine, false),
          },
          activeTurnId: null,
        },
      }));
      const duplicateLineage = parentConversationId && this.entityValues<RuntimeEdge>("edge").some((edge) =>
        edge.parentConversationId === parentConversationId && edge.childConversationId === command.conversationId);
      if (parentConversationId && !duplicateLineage) {
        const edgeId = `edge-${operationId}`;
        this.appendInTransaction(normalizeRuntimeEventInput({
          scope: { type: "edge", id: edgeId },
          kind: "edge.created",
          operationId,
          producer: { ...producer, eventKey: `operation:${operationId}:edge` },
          payload: {
            id: edgeId,
            kind: "viewer_spawn",
            parentConversationId,
            childConversationId: command.conversationId,
            createdByOperationId: operationId,
            createdAt: new Date(this.now()).toISOString(),
          },
        }));
      }
    }
  }

  private failKilledGenerationReconfigures(
    kill: Extract<RuntimeOperationCommand, { kind: "kill" }>,
  ): void {
    const pending = this.db.query<{
      operation_id: string;
      request_json: string;
      receipt_json: string;
    }, []>(`
      SELECT operations.operation_id, operations.request_json, operations.receipt_json
      FROM operations
      JOIN outbox ON outbox.id = 'effect:' || operations.operation_id
      WHERE outbox.state = 'pending' AND outbox.kind = 'runtime.reconfigure'
      ORDER BY operations.event_seq
    `).all();
    for (const row of pending) {
      const command = JSON.parse(row.request_json) as RuntimeOperationCommand;
      if (command.kind !== "reconfigure" || command.conversationId !== kill.conversationId) continue;
      if (command.sessionKey
        && (command.sessionKey.engine !== kill.sessionKey.engine
          || command.sessionKey.sessionId !== kill.sessionKey.sessionId)) continue;
      const previous = JSON.parse(row.receipt_json) as RuntimeOperationReceipt;
      const next: RuntimeOperationReceipt = {
        ...previous,
        status: "failed",
        reason: "conversation-killed",
        at: new Date(this.now()).toISOString(),
        revision: previous.revision + 1,
        ...(previous.presentationRevision !== undefined
          ? { presentationRevision: previous.presentationRevision + 1 }
          : {}),
      };
      const event = this.appendInTransaction(normalizeRuntimeEventInput({
        scope: { type: "operation", id: row.operation_id },
        kind: "receipt",
        operationId: row.operation_id,
        producer: {
          kind: "runtime-effect",
          eventKey: `operation:${row.operation_id}:receipt:${previous.revision + 1}:failed`,
          hostEpoch: Number(this.meta("host_epoch")),
        },
        payload: next as unknown as Record<string, unknown>,
      }));
      const committed = { ...next, revision: event.revision };
      this.upsertEntity("operation", row.operation_id, event.revision, committed, event.seq);
      this.appendCompletionConsequences(command, committed, row.operation_id);
      this.db.query("UPDATE operations SET receipt_json = ?, event_seq = ? WHERE operation_id = ?")
        .run(stableJson(committed), event.seq, row.operation_id);
      this.db.query("UPDATE outbox SET state = 'completed', payload_json = '{}' WHERE id = ?")
        .run(`effect:${row.operation_id}`);
    }
  }

  private appendCompletionConsequences(command: RuntimeOperationCommand, receipt: RuntimeOperationReceipt, operationId: string): void {
    const producer = { kind: "runtime-effect", hostEpoch: Number(this.meta("host_epoch")) };
    if (command.kind === "reconfigure" && (receipt.status === "applied" || receipt.status === "failed")) {
      const session = this.entity<RuntimeSession>("session", command.conversationId);
      if (session?.pendingReconfigure?.operationId === operationId) {
        this.appendInTransaction(normalizeRuntimeEventInput({
          scope: { type: "session", id: command.conversationId },
          kind: "session-status",
          operationId,
          producer: { ...producer, eventKey: `operation:${operationId}:reconfigure-${receipt.status}` },
          payload: { conversationId: command.conversationId, pendingReconfigure: null },
        }));
      }
      return;
    }
    if (command.kind === "spawn"
      && !command.sessionId
      && (receipt.status === "failed" || receipt.status === "rejected" || receipt.status === "uncertain")) {
      /* A fresh spawn placeholder session only ever leaves "registering"
         through the launcher's own hosted projection. When the launch fails
         first, the terminal receipt is the durable truth and must retire the
         placeholder in the same transaction — production #367 left failed
         launches parked as registering/unknown across runtime-host restarts.
         Resume admissions (sessionId present) keep their prior writer's
         projection and settle through the Viewer recovery ladder instead. */
      const session = this.entity<RuntimeSession>("session", command.conversationId);
      if (session && session.host === "registering") {
        this.appendInTransaction(normalizeRuntimeEventInput({
          scope: { type: "session", id: command.conversationId },
          kind: "session-status",
          operationId,
          producer: { ...producer, eventKey: `operation:${operationId}:spawn-${receipt.status}-session-dead` },
          payload: {
            conversationId: command.conversationId,
            host: "dead",
            turn: "idle",
            activeTurnId: null,
            attentionIds: [],
          },
        }));
      }
      return;
    }
    if (command.kind === "kill" && receipt.status === "delivered") {
      this.failKilledGenerationReconfigures(command);
      /* The delivered kill receipt asserts the OS processes are gone. Viewer
         projections ride best-effort publish chains, so the journal converges
         host/turn itself — production #367 kept killed conversations at
         hosted/running after their child PIDs disappeared. A kill aimed at a
         predecessor generation must not touch a live successor's projection,
         so the session must still belong to the killed generation. */
      const session = this.entity<RuntimeSession>("session", command.conversationId);
      const killedGeneration = session
        && session.sessionKey.engine === command.sessionKey.engine
        && session.sessionKey.sessionId === command.sessionKey.sessionId;
      if (session && killedGeneration
        && (session.host !== "dead" || session.turn !== "idle" || session.activeTurnId !== null)) {
        this.appendInTransaction(normalizeRuntimeEventInput({
          scope: { type: "session", id: command.conversationId },
          kind: "session-status",
          operationId,
          producer: { ...producer, eventKey: `operation:${operationId}:kill-delivered-session-dead` },
          payload: {
            conversationId: command.conversationId,
            host: "dead",
            turn: "idle",
            activeTurnId: null,
            attentionIds: [],
          },
        }));
      }
      return;
    }
    if (command.kind === "answer" && receipt.status === "answered") {
      this.appendInTransaction(normalizeRuntimeEventInput({
        scope: { type: "session", id: command.conversationId },
        kind: "attention-resolved",
        operationId,
        producer: { ...producer, eventKey: `operation:${operationId}:attention-resolved` },
        payload: { attentionId: command.attentionId, conversationId: command.conversationId, state: "resolved" },
      }));
      return;
    }
    if ((command.kind === "send" || command.kind === "steer") && receipt.status === "turn-started") {
      this.appendInTransaction(normalizeRuntimeEventInput({
        scope: { type: "session", id: command.conversationId },
        kind: "turn-started",
        operationId,
        producer: { ...producer, eventKey: `operation:${operationId}:native-turn-started` },
        payload: { conversationId: command.conversationId, turnId: receipt.turnId ?? null },
      }));
    }
  }

  private project(event: EventRow, payload: Record<string, unknown>): void {
    const scope = parseRuntimeScope(event.scope as `${RuntimeEvent["scope"]["type"]}:${string}`);
    if (event.kind === "session-status") {
      const previous = this.entity<RuntimeSession>("session", scope.id);
      const merged = baseSession(scope.id, { ...(previous ?? {}), ...payload }, event.revision);
      merged.attentionIds = strings(payload.attentionIds ?? previous?.attentionIds);
      merged.recentReceipts = receipts(previous?.recentReceipts);
      this.upsertEntity("session", scope.id, event.revision, merged, event.seq);
      return;
    }
    if (event.kind === "turn-started" || event.kind === "turn-ended") {
      const previous = this.entity<RuntimeSession>("session", scope.id) ?? baseSession(scope.id, {}, 0);
      const turnId = typeof payload.turnId === "string" ? payload.turnId : null;
      const next: RuntimeSession = {
        ...previous,
        revision: event.revision,
        turn: event.kind === "turn-started" ? "running" : "idle",
        activeTurnId: event.kind === "turn-started" && turnId ? turnId : null,
        liveTurn: previous.liveTurn,
        ...(previous.voiceDeliveries
          ? {
            voiceDeliveries: event.kind === "turn-ended" && turnId
              ? completeVoiceTurn(
                previous.voiceDeliveries,
                turnId,
                typeof payload.outcome === "string" ? payload.outcome : "",
                previous.acknowledgedVoiceDeliveryIds,
              )
              : previous.voiceDeliveries,
          }
          : {}),
      };
      this.upsertEntity("session", scope.id, event.revision, next, event.seq);
      return;
    }
    if (event.kind === "delta") {
      const previous = this.entity<RuntimeSession>("session", scope.id) ?? baseSession(scope.id, {}, 0);
      const turnId = typeof payload.turnId === "string"
        ? payload.turnId
        : previous.activeTurnId ?? "unknown";
      const fragment = typeof payload.text === "string" ? payload.text : "";
      this.upsertEntity("session", scope.id, event.revision, {
        ...previous,
        revision: event.revision,
        liveTurn: appendRuntimeLiveTurnDelta(previous.liveTurn, turnId, fragment, event.recorded_at),
      }, event.seq);
      return;
    }
    if (event.kind === "item") {
      const previous = this.entity<RuntimeSession>("session", scope.id) ?? baseSession(scope.id, {}, 0);
      const turnId = typeof payload.turnId === "string"
        ? payload.turnId
        : previous.activeTurnId ?? "unknown";
      /* Both lifecycle phases reach the live turn (issue #1100): a `started`
         tool item is a running tool row, `completed` settles prose and tools. */
      const liveTurn = payload.phase === "completed" || payload.phase === "started"
        ? projectRuntimeLiveTurnItem(previous.liveTurn, turnId, payload.item, payload.phase, event.recorded_at)
        : previous.liveTurn;
      const response = record(payload.voiceResponse);
      const voiceDeliveries = payload.phase === "completed"
        && typeof response.responseId === "string"
        && typeof response.text === "string"
        ? appendVoiceResponse(previous.voiceDeliveries, turnId, {
          responseId: response.responseId,
          text: response.text,
        })
        : previous.voiceDeliveries;
      this.upsertEntity("session", scope.id, event.revision, {
        ...previous,
        revision: event.revision,
        liveTurn,
        ...(voiceDeliveries ? { voiceDeliveries } : {}),
      }, event.seq);
      return;
    }
    if (event.kind === "voice-chunk") {
      const previous = this.entity<RuntimeSession>("session", scope.id) ?? baseSession(scope.id, {}, 0);
      const delivery = normalizeVoiceDeliveries([payload.voiceDelivery])[0];
      this.upsertEntity("session", scope.id, event.revision, {
        ...previous,
        revision: event.revision,
        voiceDeliveries: delivery
          ? appendReadyVoiceDelivery(previous.voiceDeliveries, delivery)
          : previous.voiceDeliveries,
      }, event.seq);
      return;
    }
    if (event.kind === "voice-delivery-acknowledged") {
      const previous = this.entity<RuntimeSession>("session", scope.id) ?? baseSession(scope.id, {}, 0);
      const deliveryId = typeof payload.deliveryId === "string" ? payload.deliveryId : "";
      this.upsertEntity("session", scope.id, event.revision, {
        ...previous,
        revision: event.revision,
        voiceDeliveries: acknowledgeVoiceDelivery(
          previous.voiceDeliveries,
          deliveryId,
        ),
        acknowledgedVoiceDeliveryIds: rememberAcknowledgedVoiceDelivery(
          previous.acknowledgedVoiceDeliveryIds,
          deliveryId,
        ),
      }, event.seq);
      return;
    }
    if (event.kind === "voice-delivery-progress") {
      const previous = this.entity<RuntimeSession>("session", scope.id) ?? baseSession(scope.id, {}, 0);
      this.upsertEntity("session", scope.id, event.revision, {
        ...previous,
        revision: event.revision,
      }, event.seq);
      return;
    }
    if (event.kind === "attention") {
      const id = typeof payload.id === "string" ? payload.id : typeof payload.requestId === "string" ? payload.requestId : `attention-${event.seq}`;
      const conversationId = typeof payload.conversationId === "string" ? payload.conversationId : scope.id;
      const kind = payload.kind === "approval" || payload.kind === "permission" || payload.kind === "waiting_heuristic" ? payload.kind : "question";
      const attention: RuntimeAttention = {
        id,
        conversationId,
        kind,
        state: payload.state === "resolving" || payload.state === "resolved" || payload.state === "expired-confirmed" || payload.state === "cancelled" || payload.state === "resolution-unknown" ? payload.state : "open",
        unowned: payload.unowned === true,
        createdAt: typeof payload.createdAt === "string" ? payload.createdAt : event.recorded_at,
        request: record(payload.request),
        ...(typeof payload.autoResolutionMs === "number" || payload.autoResolutionMs === null ? { autoResolutionMs: payload.autoResolutionMs } : {}),
        ...(typeof payload.turnId === "string" || payload.turnId === null ? { turnId: payload.turnId } : {}),
      };
      this.upsertEntity("attention", id, event.revision, attention, event.seq);
      const previous = this.entity<RuntimeSession>("session", conversationId) ?? baseSession(conversationId, {}, 0);
      const attentionIds = previous.attentionIds.includes(id) ? previous.attentionIds : [...previous.attentionIds, id];
      this.upsertEntity("session", conversationId, event.revision, { ...previous, revision: event.revision, attentionIds }, event.seq);
      return;
    }
    if (event.kind === "attention-resolved") {
      /* Engine-host projections historically carried the attention id only as
         `id` (#765); without this fallback those resolutions matched no
         entity and the attention stayed open in every later snapshot. */
      const id = typeof payload.attentionId === "string" ? payload.attentionId
        : typeof payload.id === "string" ? payload.id
        : scope.id;
      const attention = this.entity<RuntimeAttention>("attention", id);
      if (attention) {
        const state = payload.state === "expired-confirmed" || payload.state === "cancelled" || payload.state === "resolution-unknown" ? payload.state : "resolved";
        this.upsertEntity("attention", id, event.revision, { ...attention, state, unowned: false }, event.seq);
        const session = this.entity<RuntimeSession>("session", attention.conversationId);
        if (session) this.upsertEntity("session", attention.conversationId, event.revision, { ...session, revision: event.revision, attentionIds: session.attentionIds.filter((item) => item !== id) }, event.seq);
      }
      return;
    }
    if (event.kind === "receipt") {
      const operationId = typeof payload.operationId === "string" ? payload.operationId : scope.id;
      const receipt = { ...payload, operationId, revision: event.revision } as unknown as RuntimeOperationReceipt;
      this.upsertEntity("operation", operationId, event.revision, receipt, event.seq);
      if (typeof receipt.conversationId === "string") {
        const session = this.entity<RuntimeSession>("session", receipt.conversationId);
        if (session) {
          const recentReceipts = visibleReceipts([
            receipt,
            ...session.recentReceipts.filter((item) => item.operationId !== operationId),
          ]).slice(0, 8);
          this.upsertEntity("session", receipt.conversationId, session.revision, { ...session, recentReceipts }, event.seq);
        }
      }
      return;
    }
    if (event.kind === "edge.created") {
      const id = typeof payload.id === "string" ? payload.id : scope.id;
      const edge: RuntimeEdge = {
        id,
        kind: typeof payload.kind === "string" ? payload.kind : typeof payload.edge === "string" ? payload.edge : "viewer_spawn",
        parentConversationId: typeof payload.parentConversationId === "string" ? payload.parentConversationId : "",
        childConversationId: typeof payload.childConversationId === "string" ? payload.childConversationId : "",
        createdByOperationId: typeof payload.createdByOperationId === "string" ? payload.createdByOperationId : typeof payload.operationId === "string" ? payload.operationId : null,
        revision: event.revision,
        createdAt: typeof payload.createdAt === "string" ? payload.createdAt : event.recorded_at,
      };
      this.upsertEntity("edge", id, event.revision, edge, event.seq);
      return;
    }
    if (event.kind === "flow.state" || event.kind === "workflow.state" || event.kind === "task.state") {
      const kind = event.kind.split(".")[0]!;
      const value = record(payload.value ?? payload);
      const id = typeof value.id === "string" ? value.id : scope.id;
      this.upsertEntity(kind, id, event.revision, { ...value, id }, event.seq);
      return;
    }
    if (event.kind === "files.revision") {
      const revision = payload.filesRevision;
      const current = Number(this.meta("files_revision"));
      if (typeof revision === "number" && Number.isInteger(revision) && revision > current) this.metaSet("files_revision", String(revision));
      return;
    }
    if (event.kind === "reconcile.drift") {
      const conversationId = typeof payload.conversationId === "string" ? payload.conversationId : scope.id;
      const session = this.entity<RuntimeSession>("session", conversationId);
      if (session) this.upsertEntity("session", conversationId, event.revision, { ...session, revision: event.revision, drift: payload as unknown as RuntimeSession["drift"] }, event.seq);
      return;
    }
    if (event.kind === "deployment.state") {
      const status = payload as unknown as ViewerDeploymentStatus;
      this.upsertEntity("deployment", scope.id, event.revision, status, event.seq);
    }
  }

  private entity<T>(kind: string, id: string): T | null {
    const row = this.db.query<{ state_json: string }, [string, string]>("SELECT state_json FROM entities WHERE kind = ? AND id = ?").get(kind, id);
    return row ? JSON.parse(row.state_json) as T : null;
  }

  private entityValues<T>(kind: string): T[] {
    return this.db.query<{ state_json: string }, [string]>("SELECT state_json FROM entities WHERE kind = ? ORDER BY id").all(kind).map((row) => JSON.parse(row.state_json) as T);
  }

  private snapshotSessionValues(): RuntimeSession[] {
    const active = this.db.query<{ state_json: string }, [string, string, string]>(`
      SELECT state_json
      FROM entities
      WHERE kind = ?
        AND (
          json_extract(state_json, '$.host') IS NULL
          OR json_extract(state_json, '$.host') NOT IN (?, ?)
        )
      ORDER BY id
    `).all("session", "dead", "unhosted");
    const inactive = this.db.query<{ state_json: string }, [string, string, string, number]>(`
      SELECT state_json
      FROM entities
      WHERE kind = ?
        AND json_extract(state_json, '$.host') IN (?, ?)
      ORDER BY checkpoint_seq DESC, id DESC
      LIMIT ?
    `).all("session", "dead", "unhosted", RUNTIME_SNAPSHOT_INACTIVE_SESSION_LIMIT);
    return [...active, ...inactive]
      .map((row) => JSON.parse(row.state_json) as RuntimeSession)
      .sort((left, right) => left.conversationId.localeCompare(right.conversationId));
  }

  private snapshotEdgeValues(now: number): RuntimeEdge[] {
    const terminalSessions = new Map(this.db.query<{
      id: string;
      last_changed_at: number | null;
    }, [string, string, string]>(`
      SELECT session.id, session.updated_at AS last_changed_at
      FROM entities AS session
      WHERE session.kind = ?
        AND json_extract(session.state_json, '$.host') IN (?, ?)
    `).all("session", "dead", "unhosted").map((row) => [row.id, row.last_changed_at]));

    return this.entityValues<RuntimeEdge>("edge").filter((edge) => {
      if (!terminalSessions.has(edge.childConversationId)) return true;
      const lastChangedAt = terminalSessions.get(edge.childConversationId);
      return lastChangedAt === null
        || lastChangedAt === undefined
        || now <= lastChangedAt + RUNTIME_SNAPSHOT_STALE_EDGE_RETENTION_MS;
    });
  }

  private snapshotEdgeExpiry(now: number): number | null {
    return this.db.query<{ expires_at: number | null }, [number, string, string, number, number]>(`
      SELECT MIN(session.updated_at + ? + 1) AS expires_at
      FROM entities AS edge
      JOIN entities AS session
        ON session.kind = 'session'
        AND session.id = json_extract(edge.state_json, '$.childConversationId')
      WHERE edge.kind = 'edge'
        AND json_extract(session.state_json, '$.host') IN (?, ?)
        AND session.updated_at + ? >= ?
    `).get(
      RUNTIME_SNAPSHOT_STALE_EDGE_RETENTION_MS,
      "dead",
      "unhosted",
      RUNTIME_SNAPSHOT_STALE_EDGE_RETENTION_MS,
      now,
    )?.expires_at ?? null;
  }

  private snapshotDeploymentValues(): ViewerDeploymentStatus[] {
    const nonTerminal = this.db.query<{ state_json: string }, [string]>(`
      SELECT state_json
      FROM entities
      WHERE kind = ?
        AND COALESCE(json_extract(state_json, '$.terminal'), 0) != 1
    `).all("deployment");
    const terminal = this.db.query<{ state_json: string }, [string, number]>(`
      SELECT state_json
      FROM entities
      WHERE kind = ?
        AND json_extract(state_json, '$.terminal') = 1
      ORDER BY checkpoint_seq DESC, id DESC
      LIMIT ?
    `).all("deployment", RUNTIME_SNAPSHOT_TERMINAL_DEPLOYMENT_LIMIT);
    return [...nonTerminal, ...terminal]
      .map((row) => JSON.parse(row.state_json) as ViewerDeploymentStatus)
      .sort((left, right) => left.deploymentId.localeCompare(right.deploymentId));
  }

  private recentEntityValues<T>(kind: string, limit: number): T[] {
    return this.db.query<{ state_json: string }, [string, number]>("SELECT state_json FROM entities WHERE kind = ? ORDER BY checkpoint_seq DESC LIMIT ?")
      .all(kind, limit)
      .map((row) => JSON.parse(row.state_json) as T);
  }

  private scopedValues<T>(kind: string): Array<{ revision: number; value: T }> {
    return this.db.query<EntityRow, [string]>("SELECT kind, id, revision, state_json, checkpoint_seq FROM entities WHERE kind = ? ORDER BY id").all(kind).map((row) => ({ revision: row.revision, value: JSON.parse(row.state_json) as T }));
  }

  private upsertEntity(kind: string, id: string, revision: number, value: unknown, seq: number): void {
    this.db.query(`
      INSERT INTO entities(kind, id, revision, state_json, checkpoint_seq, updated_at)
      VALUES (?, ?, ?, ?, ?, (SELECT created_at FROM events WHERE seq = ?))
      ON CONFLICT(kind, id) DO UPDATE SET
        revision = excluded.revision,
        state_json = excluded.state_json,
        checkpoint_seq = excluded.checkpoint_seq,
        updated_at = excluded.updated_at
    `).run(kind, id, revision, stableJson(value), seq, seq);
  }

  private insertEffect(effect: RuntimeEffect, seq: number): void {
    if (!effect.id || !effect.kind) throw new Error("runtime effect is invalid");
    this.db.query("INSERT INTO outbox(id, kind, payload_json, event_seq, state) VALUES (?, ?, ?, ?, 'pending') ON CONFLICT(id) DO NOTHING").run(effect.id, effect.kind, stableJson(effect.payload), seq);
  }

  private encryptSecret(value: unknown): EncryptedSecret {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.secretKey, iv);
    const ciphertext = Buffer.concat([cipher.update(stableJson(value), "utf8"), cipher.final()]);
    return {
      __runtimeEncrypted: 1,
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    };
  }

  private decryptSecret(value: unknown): unknown {
    const encrypted = record(value) as Partial<EncryptedSecret>;
    if (encrypted.__runtimeEncrypted !== 1 || typeof encrypted.iv !== "string" || typeof encrypted.tag !== "string" || typeof encrypted.ciphertext !== "string") {
      throw new RuntimeJournalFault("runtime operation secret is invalid");
    }
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.secretKey, Buffer.from(encrypted.iv, "base64"));
      decipher.setAuthTag(Buffer.from(encrypted.tag, "base64"));
      const plaintext = Buffer.concat([decipher.update(Buffer.from(encrypted.ciphertext, "base64")), decipher.final()]).toString("utf8");
      return JSON.parse(plaintext) as unknown;
    } catch {
      throw new RuntimeJournalFault("runtime operation secret cannot be decrypted");
    }
  }

  private compactIfNeeded(): void { this.compact(this.maxEvents); }

  private notifyWaiters(): void {
    for (const waiter of [...this.waiters]) waiter();
  }

  private verify(): void {
    try {
      for (const table of ["journal_meta", "events", "scope_revisions", "projections", "entities", "outbox", "operations", "delivery_operation_actions", "consumer_checkpoints", "viewer_deployments"]) {
        const check = this.db.query<{ quick_check: string }, []>(`PRAGMA quick_check(${table})`).get();
        if (check?.quick_check !== "ok") throw new RuntimeJournalFault(`runtime journal SQLite check failed: ${table}`);
      }
      let previous = this.meta("anchor_hash");
      let expected = Number(this.meta("anchor_seq")) + 1;
      for (const row of this.db.query<EventRow, []>("SELECT * FROM events ORDER BY seq").all()) {
        if (row.seq !== expected || row.prev_hash !== previous || row.hash !== recordHash(previous, row)) throw new RuntimeJournalFault("runtime journal hash chain is corrupt");
        previous = row.hash;
        expected += 1;
      }
      if (previous !== this.meta("hash") || Number(this.meta("seq")) !== expected - 1) throw new RuntimeJournalFault("runtime journal tail is corrupt");
    } catch (error) {
      this.fault = error instanceof Error ? error.message : "runtime journal verification failed";
      this.metaSet("health", "read_only_fault");
    }
  }

  private assertHealthy(): void {
    if (this.fault) throw new RuntimeJournalFault(`runtime journal is read-only: ${this.fault}`);
  }

  private migrateOperationIdempotencyScope(): void {
    const columns = new Set(this.db.query<{ name: string }, []>("PRAGMA table_info(operations)").all().map((row) => row.name));
    const legacyTableExists = () => Boolean(this.db.query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'operations_global_idempotency'",
    ).get());
    if (columns.has("conversation_id") && !legacyTableExists()) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (!columns.has("conversation_id")) {
        this.db.exec("ALTER TABLE operations RENAME TO operations_global_idempotency");
      }
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS operations (
          operation_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
          request_hash TEXT NOT NULL, request_json TEXT NOT NULL,
          receipt_json TEXT NOT NULL, event_seq INTEGER NOT NULL, orphaned_since INTEGER,
          UNIQUE(conversation_id, idempotency_key)
        );
      `);
      if (legacyTableExists()) {
        this.db.exec(`
          INSERT OR IGNORE INTO operations(operation_id, conversation_id, idempotency_key, request_hash, request_json, receipt_json, event_seq)
          SELECT operation_id,
            COALESCE(json_extract(request_json, '$.conversationId'), json_extract(receipt_json, '$.conversationId'), ''),
            idempotency_key, request_hash, request_json, receipt_json, event_seq
          FROM operations_global_idempotency;
        `);
        const conflict = this.db.query<{ operation_id: string }, []>(`
          SELECT legacy.operation_id
          FROM operations_global_idempotency AS legacy
          LEFT JOIN operations AS scoped
            ON scoped.operation_id = legacy.operation_id
            AND scoped.conversation_id = COALESCE(
              json_extract(legacy.request_json, '$.conversationId'),
              json_extract(legacy.receipt_json, '$.conversationId'),
              ''
            )
            AND scoped.idempotency_key = legacy.idempotency_key
            AND scoped.request_hash = legacy.request_hash
            AND scoped.request_json = legacy.request_json
            AND scoped.receipt_json = legacy.receipt_json
            AND scoped.event_seq = legacy.event_seq
          WHERE scoped.operation_id IS NULL
          LIMIT 1
        `).get();
        if (conflict) throw new Error(`legacy runtime operation conflicts with scoped migration: ${conflict.operation_id}`);
        this.db.exec("DROP TABLE operations_global_idempotency");
      }
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* transaction already closed */ }
      throw error;
    }
  }

  private migrateOperationOrphanedSince(): void {
    const columns = new Set(this.db.query<{ name: string }, []>("PRAGMA table_info(operations)").all().map((row) => row.name));
    if (!columns.has("orphaned_since")) this.db.exec("ALTER TABLE operations ADD COLUMN orphaned_since INTEGER");
  }

  private migrateLegacyEvents(): void {
    const columns = new Set(this.db.query<{ name: string }, []>("PRAGMA table_info(events)").all().map((row) => row.name));
    const additions: Array<[string, string]> = [
      ["event_id", "TEXT"], ["occurred_at", "TEXT"], ["recorded_at", "TEXT"], ["producer_kind", "TEXT"],
      ["producer_account_id", "TEXT"], ["producer_host_epoch", "INTEGER"], ["causation_id", "TEXT"], ["correlation_id", "TEXT"],
    ];
    for (const [name, type] of additions) {
      if (!columns.has(name)) this.db.exec(`ALTER TABLE events ADD COLUMN ${name} ${type}`);
    }
    this.db.exec(`
      UPDATE events SET event_id = 'evt_legacy_' || seq WHERE event_id IS NULL;
      UPDATE events SET occurred_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at / 1000.0, 'unixepoch') WHERE occurred_at IS NULL;
      UPDATE events SET recorded_at = occurred_at WHERE recorded_at IS NULL;
      UPDATE events SET producer_kind = 'viewer-compat' WHERE producer_kind IS NULL;
      UPDATE events SET causation_id = operation_id WHERE causation_id IS NULL AND operation_id IS NOT NULL;
    `);
  }

  private migrateEntityUpdatedAt(): void {
    const columns = new Set(this.db.query<{ name: string }, []>("PRAGMA table_info(entities)").all().map((row) => row.name));
    if (!columns.has("updated_at")) this.db.exec("ALTER TABLE entities ADD COLUMN updated_at INTEGER");
    this.db.query(`
      UPDATE entities
      SET updated_at = COALESCE(
        (SELECT created_at FROM events WHERE events.seq = entities.checkpoint_seq),
        ?
      )
      WHERE updated_at IS NULL
    `).run(this.now());
  }

  private meta(key: string): string {
    const row = this.db.query<{ value: string }, [string]>("SELECT value FROM journal_meta WHERE key = ?").get(key);
    if (!row) throw new RuntimeJournalFault(`runtime journal metadata is missing: ${key}`);
    return row.value;
  }

  private metaOr(key: string, fallback: string): string {
    return this.db.query<{ value: string }, [string]>("SELECT value FROM journal_meta WHERE key = ?").get(key)?.value ?? fallback;
  }

  private metaSetDefault(key: string, value: string): void { this.db.query("INSERT INTO journal_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING").run(key, value); }
  private metaSet(key: string, value: string): void { this.db.query("INSERT INTO journal_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value); }
}
