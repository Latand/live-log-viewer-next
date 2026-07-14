import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";

import { Database } from "bun:sqlite";

import {
  RUNTIME_SCHEMA_VERSION,
  assertRuntimeEvent,
  normalizeRuntimeEventInput,
  parseRuntimeScope,
  runtimeScopeKey,
  type RuntimeAttention,
  type RuntimeEdge,
  type RuntimeEffect,
  type RuntimeEvent,
  type RuntimeEventInput,
  RuntimeIdempotencyConflictError,
  newOperationId,
  type NormalizedRuntimeEventInput,
  type RuntimeOperationCommand,
  type RuntimeOperationReceipt,
  type RuntimeOperationResult,
  type RuntimeReceiptStatus,
  type RuntimeReplay,
  type RuntimeSession,
  type RuntimeSnapshot,
  type ViewerDeploymentOwner,
  type ViewerDeploymentReceipt,
  type ViewerDeploymentStatus,
} from "@/lib/runtime/contracts";

export class RuntimeJournalFault extends Error {}

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

function baseSession(id: string, payload: Record<string, unknown>, revision: number): RuntimeSession {
  const key = record(payload.sessionKey);
  const capabilities = record(payload.capabilities);
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
    },
    activeTurnId: typeof payload.activeTurnId === "string" ? payload.activeTurnId : null,
    drift: payload.drift && typeof payload.drift === "object" ? payload.drift as RuntimeSession["drift"] : null,
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

  constructor(filename: string, options: RuntimeJournalOptions = {}) {
    this.db = new Database(filename, { create: true, strict: true });
    this.maxEvents = options.maxEvents ?? 20_000;
    this.now = options.now ?? (() => Date.now());
    this.structuredHosts = options.structuredHosts ?? process.env.LLV_STRUCTURED_HOSTS === "1";
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
        state_json TEXT NOT NULL, checkpoint_seq INTEGER NOT NULL,
        PRIMARY KEY(kind, id)
      );
      CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload_json TEXT NOT NULL, event_seq INTEGER NOT NULL, state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS producer_receipts (producer_kind TEXT NOT NULL, producer_key TEXT NOT NULL, event_json TEXT NOT NULL, PRIMARY KEY(producer_kind, producer_key));
      CREATE TABLE IF NOT EXISTS operations (
        operation_id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE,
        request_hash TEXT NOT NULL, request_json TEXT NOT NULL,
        receipt_json TEXT NOT NULL, event_seq INTEGER NOT NULL
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
    this.migrateLegacyEvents();
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
    this.assertHealthy();
    this.assertOperation(command);
    const operationId = command.operationId?.trim() || newOperationId();
    const requestValue = { ...command } as Record<string, unknown>;
    delete requestValue.operationId;
    if (command.kind === "answer") requestValue.resolution = { sha256: createHash("sha256").update(stableJson(command.resolution)).digest("hex") };
    const requestJson = stableJson(requestValue);
    const requestHash = createHash("sha256").update(requestJson).digest("hex");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db.query<{ operation_id: string; request_hash: string; receipt_json: string }, [string]>("SELECT operation_id, request_hash, receipt_json FROM operations WHERE idempotency_key = ?").get(command.idempotencyKey);
      if (existing) {
        if (existing.request_hash !== requestHash) throw new RuntimeIdempotencyConflictError("idempotency key already belongs to another request");
        const result = { operationId: existing.operation_id, receipt: JSON.parse(existing.receipt_json) as RuntimeOperationReceipt, replayed: true };
        this.db.exec("COMMIT");
        return result;
      }
      const operationOwner = this.db.query<{ idempotency_key: string }, [string]>("SELECT idempotency_key FROM operations WHERE operation_id = ?").get(operationId);
      if (operationOwner) throw new RuntimeIdempotencyConflictError("operationId already belongs to another request");
      const receipt = this.operationReceipt(command, operationId);
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
        producer: { kind: "viewer-command", eventKey: `operation:${command.idempotencyKey}`, hostEpoch: Number(this.meta("host_epoch")) },
        payload: receipt as unknown as Record<string, unknown>,
        ...(effect ? { effect } : {}),
      }));
      const committedReceipt: RuntimeOperationReceipt = { ...receipt, revision: event.revision };
      this.upsertEntity("operation", operationId, event.revision, committedReceipt, event.seq);
      this.appendOperationConsequences(command, committedReceipt, operationId);
      this.db.query("INSERT INTO operations(operation_id, idempotency_key, request_hash, request_json, receipt_json, event_seq) VALUES (?, ?, ?, ?, ?, ?)")
        .run(operationId, command.idempotencyKey, requestHash, requestJson, stableJson(committedReceipt), event.seq);
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
  ): RuntimeOperationResult {
    this.assertHealthy();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.query<{ request_json: string; receipt_json: string }, [string]>("SELECT request_json, receipt_json FROM operations WHERE operation_id = ?").get(operationId);
      if (!row) throw new Error("runtime operation is unknown");
      const previous = JSON.parse(row.receipt_json) as RuntimeOperationReceipt;
      if (previous.status === status) {
        this.db.exec("COMMIT");
        return { operationId, receipt: previous, replayed: true };
      }
      const queueing = status === "queued"
        && (previous.status === "delivering" || (this.structuredHosts && previous.status === "pending"));
      const beginning = (previous.status === "pending" || previous.status === "queued") && status === "delivering";
      const completing = (previous.status === "pending" || previous.status === "queued" || previous.status === "delivering")
        && status !== "delivering" && status !== "queued";
      if (!queueing && !beginning && !completing) throw new Error("runtime operation transition is invalid");
      const command = JSON.parse(row.request_json) as RuntimeOperationCommand;
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
      this.db.exec("COMMIT");
      this.compactIfNeeded();
      this.notifyWaiters();
      return { operationId, receipt: committed, replayed: false };
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* transaction already closed */ }
      throw error;
    }
  }

  retryOperation(operationId: string): RuntimeOperationResult {
    this.assertHealthy();
    if (!this.structuredHosts) throw new Error("structured hosts are disabled");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.query<{ request_json: string; receipt_json: string }, [string]>(
        "SELECT request_json, receipt_json FROM operations WHERE operation_id = ?",
      ).get(operationId);
      if (!row) throw new Error("runtime operation is unknown");
      const previous = JSON.parse(row.receipt_json) as RuntimeOperationReceipt;
      const command = JSON.parse(row.request_json) as RuntimeOperationCommand;
      if (previous.status !== "failed") throw new Error("only failed runtime operations can retry");
      if (command.kind !== "send" && command.kind !== "steer") throw new Error("runtime operation does not support retry");
      const next: RuntimeOperationReceipt = {
        ...previous,
        status: "queued",
        turnId: previous.turnId ?? null,
        queuePosition: this.queuedSendCount(command.conversationId) + 1,
        reason: null,
        at: new Date(this.now()).toISOString(),
        revision: previous.revision + 1,
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
    this.db.exec("BEGIN");
    try {
      const snapshot: RuntimeSnapshot = {
        schemaVersion: RUNTIME_SCHEMA_VERSION,
        snapshotSeq: Number(this.meta("published_seq")),
        retentionFloorSeq: Number(this.meta("anchor_seq")),
        serverTime: new Date(this.now()).toISOString(),
        runtime: { hostEpoch: Number(this.meta("host_epoch")), health: this.meta("health") },
        filesRevision: Number(this.meta("files_revision")),
        sessions: this.entityValues<RuntimeSession>("session"),
        attentions: this.entityValues<RuntimeAttention>("attention"),
        recentOperations: this.recentEntityValues<RuntimeOperationReceipt>("operation", 100),
        edges: this.entityValues<RuntimeEdge>("edge"),
        flows: this.scopedValues<RuntimeSnapshot["flows"][number]["value"]>("flow"),
        workflows: this.scopedValues<RuntimeSnapshot["workflows"][number]["value"]>("workflow"),
        tasks: this.scopedValues<RuntimeSnapshot["tasks"][number]["value"]>("task"),
        deployments: this.entityValues<ViewerDeploymentStatus>("deployment"),
      };
      this.db.exec("COMMIT");
      return snapshot;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* transaction already closed */ }
      throw error;
    }
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
      const event = toEvent(row);
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
    this.assertHealthy();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const epoch = Number(this.meta("host_epoch")) + 1;
      this.metaSet("host_epoch", String(epoch));
      this.metaSet("health", "ready");
      this.db.exec("COMMIT");
      return epoch;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* transaction already closed */ }
      throw error;
    }
  }

  waitForEvents(after: number, timeoutMs = 15_000): Promise<RuntimeReplay> {
    const immediate = this.replay(after);
    if (immediate.reset || immediate.events.length > 0) return Promise.resolve(immediate);
    const timeout = Math.min(Math.max(timeoutMs, 10), 30_000);
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.waiters.delete(finish);
        resolve(this.replay(after));
      };
      this.waiters.add(finish);
      const timer = setTimeout(finish, timeout);
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

  effectBatch(limit = 100, kinds?: readonly string[], afterEventSeq = 0): Array<RuntimeEffect & { eventSeq: number }> {
    if (kinds?.length === 0) return [];
    if (!Number.isSafeInteger(afterEventSeq) || afterEventSeq < 0) throw new Error("runtime effect cursor is invalid");
    const kindFilter = kinds ? ` AND kind IN (${kinds.map(() => "?").join(", ")})` : "";
    const rows = this.db.query<{ id: string; kind: string; payload_json: string; event_seq: number }, Array<string | number>>(
      `SELECT id, kind, payload_json, event_seq FROM outbox WHERE state = 'pending'${kindFilter} AND event_seq > ? ORDER BY event_seq LIMIT ?`,
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
      this.db.query("DELETE FROM entities WHERE kind = 'operation' AND checkpoint_seq <= ?").run(anchor.seq);
      this.metaSet("anchor_seq", String(anchor.seq));
      this.metaSet("anchor_hash", anchor.hash);
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* transaction already closed */ }
      throw error;
    }
  }

  close(): void { this.db.close(); }

  private appendInTransaction(input: NormalizedRuntimeEventInput): RuntimeEvent {
    const producerKey = input.producer.eventKey ?? null;
    if (producerKey) {
      const duplicate = this.db.query<{ event_json: string }, [string, string]>("SELECT event_json FROM producer_receipts WHERE producer_kind = ? AND producer_key = ?").get(input.producer.kind, producerKey);
      if (duplicate) return JSON.parse(duplicate.event_json) as RuntimeEvent;
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
    if (producerKey) this.db.query("INSERT INTO producer_receipts(producer_kind, producer_key, event_json) VALUES (?, ?, ?)").run(input.producer.kind, producerKey, stableJson(toEvent(event)));
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
      if (!command.text.trim()) throw new Error("message text is required");
      if (command.images !== undefined && (!Array.isArray(command.images) || command.images.length > 16 || command.images.some((image) => typeof image !== "string"))) throw new Error("message images are invalid");
    }
    if (command.kind === "answer" && !command.attentionId.trim()) throw new Error("attentionId is required");
    if (command.kind === "spawn" && (!command.cwd.trim() || !command.prompt.trim())) throw new Error("spawn cwd and prompt are required");
  }

  private operationReceipt(command: RuntimeOperationCommand, operationId: string): RuntimeOperationReceipt {
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
    } else {
      status = "queued";
    }
    const revision = Number(this.db.query<{ revision: number }, [string]>("SELECT revision FROM scope_revisions WHERE scope = ?").get(`operation:${operationId}`)?.revision ?? 0) + 1;
    return {
      operationId,
      idempotencyKey: command.idempotencyKey,
      conversationId: command.conversationId,
      kind: command.kind,
      status,
      turnId,
      queuePosition,
      reason,
      text: command.kind === "send" || command.kind === "steer" ? command.text.slice(0, 240) : null,
      at: new Date(this.now()).toISOString(),
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
    if (command.kind === "spawn") {
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
          parentConversationId: command.parentConversationId ?? null,
          cwd: command.cwd,
          artifactPath: null,
          capabilities: { steer: command.engine === "codex", structuredAttention: true },
          activeTurnId: null,
        },
      }));
      if (command.parentConversationId) {
        const edgeId = `edge-${operationId}`;
        this.appendInTransaction(normalizeRuntimeEventInput({
          scope: { type: "edge", id: edgeId },
          kind: "edge.created",
          operationId,
          producer: { ...producer, eventKey: `operation:${operationId}:edge` },
          payload: {
            id: edgeId,
            kind: "viewer_spawn",
            parentConversationId: command.parentConversationId,
            childConversationId: command.conversationId,
            createdByOperationId: operationId,
            createdAt: new Date(this.now()).toISOString(),
          },
        }));
      }
    }
  }

  private appendCompletionConsequences(command: RuntimeOperationCommand, receipt: RuntimeOperationReceipt, operationId: string): void {
    const producer = { kind: "runtime-effect", hostEpoch: Number(this.meta("host_epoch")) };
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
      const next: RuntimeSession = {
        ...previous,
        revision: event.revision,
        turn: event.kind === "turn-started" ? "running" : "idle",
        activeTurnId: event.kind === "turn-started" && typeof payload.turnId === "string" ? payload.turnId : null,
      };
      this.upsertEntity("session", scope.id, event.revision, next, event.seq);
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
      const id = typeof payload.attentionId === "string" ? payload.attentionId : scope.id;
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
          const recentReceipts = [receipt, ...session.recentReceipts.filter((item) => item.operationId !== operationId)].slice(0, 8);
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

  private recentEntityValues<T>(kind: string, limit: number): T[] {
    return this.db.query<{ state_json: string }, [string, number]>("SELECT state_json FROM entities WHERE kind = ? ORDER BY checkpoint_seq DESC LIMIT ?")
      .all(kind, limit)
      .map((row) => JSON.parse(row.state_json) as T);
  }

  private scopedValues<T>(kind: string): Array<{ revision: number; value: T }> {
    return this.db.query<EntityRow, [string]>("SELECT kind, id, revision, state_json, checkpoint_seq FROM entities WHERE kind = ? ORDER BY id").all(kind).map((row) => ({ revision: row.revision, value: JSON.parse(row.state_json) as T }));
  }

  private upsertEntity(kind: string, id: string, revision: number, value: unknown, seq: number): void {
    this.db.query("INSERT INTO entities(kind, id, revision, state_json, checkpoint_seq) VALUES (?, ?, ?, ?, ?) ON CONFLICT(kind, id) DO UPDATE SET revision=excluded.revision, state_json=excluded.state_json, checkpoint_seq=excluded.checkpoint_seq").run(kind, id, revision, stableJson(value), seq);
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
    const secret = record(value) as Partial<EncryptedSecret>;
    if (secret.__runtimeEncrypted !== 1 || typeof secret.iv !== "string" || typeof secret.tag !== "string" || typeof secret.ciphertext !== "string") {
      throw new RuntimeJournalFault("runtime operation secret is invalid");
    }
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.secretKey, Buffer.from(secret.iv, "base64"));
      decipher.setAuthTag(Buffer.from(secret.tag, "base64"));
      const plaintext = Buffer.concat([decipher.update(Buffer.from(secret.ciphertext, "base64")), decipher.final()]).toString("utf8");
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
      const check = this.db.query<{ quick_check: string }, []>("PRAGMA quick_check").get();
      if (check?.quick_check !== "ok") throw new RuntimeJournalFault("runtime journal SQLite check failed");
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
