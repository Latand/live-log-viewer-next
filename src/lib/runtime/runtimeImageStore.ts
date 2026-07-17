import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { Database as BunDatabase } from "bun:sqlite";

import { stateDir, statePath } from "@/lib/configDir";
import { procBackend } from "@/lib/proc";

import {
  normalizeStructuredImageMime,
  CODEX_STRUCTURED_IMAGE_REASON,
  STRUCTURED_IMAGE_MIMES,
  STRUCTURED_IMAGE_PROTOCOL_REASON,
  type RuntimeImageCapability,
  type StructuredImageMime,
  type StructuredImageRef,
} from "./structuredContent";

export const MAX_STRUCTURED_IMAGES = 16;
export const MAX_STRUCTURED_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_STRUCTURED_IMAGE_TOTAL_BYTES = 18 * 1024 * 1024;
export const MAX_STRUCTURED_IMAGE_ENCODED_BYTES = 24 * 1024 * 1024;
export const MAX_RUNTIME_IMAGE_STORE_BYTES = 256 * 1024 * 1024;

export interface RuntimeImageUpload {
  base64: string;
  mime: string;
}

export function runtimeImageCapability(engine: "claude" | "codex", protocolAdvertised: boolean): RuntimeImageCapability {
  const supported = protocolAdvertised;
  const reason = supported
    ? null
    : engine === "codex"
      ? CODEX_STRUCTURED_IMAGE_REASON
      : STRUCTURED_IMAGE_PROTOCOL_REASON;
  return {
    supported,
    reason,
    formats: [...STRUCTURED_IMAGE_MIMES],
    maxImages: MAX_STRUCTURED_IMAGES,
    maxRawBytesPerImage: MAX_STRUCTURED_IMAGE_BYTES,
    maxEncodedBytesPerRequest: MAX_STRUCTURED_IMAGE_ENCODED_BYTES,
  };
}

const MIME_EXT: Record<StructuredImageMime, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

const WRITER_LOCK_STALE_MS = 30_000;
const WRITER_LOCK_WAIT_MS = 5_000;
const ABANDONED_PARTIAL_MAX_AGE_MS = 60 * 60 * 1000;
const GC_GRACE_MS = 60 * 60 * 1000;
const LOCK_SLEEP = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(milliseconds: number): void {
  Atomics.wait(LOCK_SLEEP, 0, 0, milliseconds);
}

export function hasRuntimeImageSignature(data: Buffer, mime: StructuredImageMime): boolean {
  if (mime === "image/png") {
    return data.length >= 24
      && data.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
      && data.subarray(12, 16).toString("ascii") === "IHDR";
  }
  if (mime === "image/jpeg") {
    return data.length >= 4
      && data[0] === 0xff
      && data[1] === 0xd8
      && data[2] === 0xff
      && data.at(-2) === 0xff
      && data.at(-1) === 0xd9;
  }
  if (mime === "image/gif") {
    const header = data.subarray(0, 6).toString("ascii");
    return data.length >= 10 && (header === "GIF87a" || header === "GIF89a");
  }
  return data.length >= 12
    && data.subarray(0, 4).toString("ascii") === "RIFF"
    && data.subarray(8, 12).toString("ascii") === "WEBP";
}

function decodeBase64(value: string): Buffer {
  if (!value || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error("runtime image base64 is invalid");
  }
  const data = Buffer.from(value, "base64");
  if (data.length === 0 || data.toString("base64") !== value) throw new Error("runtime image base64 is invalid");
  return data;
}

function validateRuntimeImageUpload(upload: RuntimeImageUpload): { data: Buffer; mime: StructuredImageMime } {
  const mime = normalizeStructuredImageMime(upload.mime);
  if (!mime) throw new Error("runtime image MIME is unsupported");
  const data = decodeBase64(upload.base64);
  if (data.byteLength > MAX_STRUCTURED_IMAGE_BYTES) throw new Error("runtime image exceeds 10 MB");
  if (!hasRuntimeImageSignature(data, mime)) throw new Error("runtime image signature does not match MIME");
  return { data, mime };
}

/** The content-addressed refs `putMany` would publish for these uploads,
    computed without touching the store — the conflict preflight compares them
    against a durable reservation before any blob is written. */
export function runtimeImageRefsForUploads(uploads: readonly RuntimeImageUpload[]): StructuredImageRef[] {
  return uploads.map((upload) => {
    const { data, mime } = validateRuntimeImageUpload(upload);
    return { sha256: crypto.createHash("sha256").update(data).digest("hex"), mime, bytes: data.byteLength };
  });
}

function syncDirectory(directory: string): void {
  const fd = fs.openSync(directory, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

export interface RuntimeImageStoreOptions {
  maxBytes?: number;
  fault?: (stage: "write" | "fsync" | "link" | "directory-fsync") => void;
  now?: () => number;
  abandonedPartialMaxAgeMs?: number;
  gcGraceMs?: number;
  reachableDigests?: () => ReadonlySet<string>;
  afterRootOpen?: (operation: "read" | "write" | "maintenance") => void;
  writerLockStaleMs?: number;
  writerLockWaitMs?: number;
  /** Route file operations through the pinned `/proc/self/fd` handle. Defaults
      to runtime detection; tests force `false` to exercise the Darwin path. */
  procSelfFdPaths?: boolean;
}

const REF_DIGEST = /^[a-f0-9]{64}$/;
const BLOB_NAME = /^([a-f0-9]{64})\.(png|jpg|gif|webp)$/;

/** How long a terminally delivered reservation's refs stay reachable after
    delivery. Bounded retirement releases store quota after the grace period,
    which still covers the delivered-replay window. Active reservations retain
    every referenced blob. */
export const DELIVERED_REF_RETIREMENT_GRACE_MS = 24 * 60 * 60 * 1000;

/** The moment a delivered image reservation became terminal. Other records
    return null. */
function deliveredRecordTerminalAt(record: Record<string, unknown>): number | null {
  if (record.state !== "delivered" || !Array.isArray(record.runtimeImages)) return null;
  const at = typeof record.deliveredAt === "string"
    ? Date.parse(record.deliveredAt)
    : typeof record.createdAt === "string"
      ? Date.parse(record.createdAt)
      : Number.NaN;
  return Number.isFinite(at) ? at : null;
}

function collectDigests(value: unknown, digests: Set<string>, retireBefore: number): void {
  if (Array.isArray(value)) {
    for (const item of value) collectDigests(item, digests, retireBefore);
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if (typeof record.sha256 === "string" && REF_DIGEST.test(record.sha256)
    && typeof record.mime === "string" && normalizeStructuredImageMime(record.mime)
    && Number.isSafeInteger(record.bytes) && Number(record.bytes) > 0) {
    digests.add(record.sha256);
  }
  const terminalAt = deliveredRecordTerminalAt(record);
  for (const [key, nested] of Object.entries(record)) {
    /* Lifecycle-aware retirement: a delivered reservation past its grace no
       longer pins its image refs; every other field (and every non-terminal
       reservation) keeps its refs reachable for crash recovery and replay. */
    if (key === "runtimeImages" && terminalAt !== null && terminalAt <= retireBefore) continue;
    collectDigests(nested, digests, retireBefore);
  }
}

/** JSONL parse with the delivery-ledger tail contract: an invalid FINAL record
    of an unterminated file is an interrupted append and is skipped, while
    interior corruption is real damage and throws (disabling GC fail-closed). */
function readJsonlRecords(contents: string, source: string): unknown[] {
  const lines = contents.split("\n");
  const terminated = contents.endsWith("\n");
  const records: unknown[] = [];
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch (error) {
      if (index === lines.length - 1 && !terminated) break;
      throw new Error(`${source} contains malformed JSON`, { cause: error });
    }
  }
  return records;
}

function collectJsonFile(filename: string, digests: Set<string>, retireBefore: number): void {
  let contents: string;
  try { contents = fs.readFileSync(filename, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!contents.trim()) return;
  if (filename.endsWith(".jsonl") || filename.endsWith(".ndjson")) {
    for (const record of readJsonlRecords(contents, filename)) collectDigests(record, digests, retireBefore);
    return;
  }
  collectDigests(JSON.parse(contents), digests, retireBefore);
}

function collectJsonDirectory(directory: string, digests: Set<string>, retireBefore: number): void {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(directory, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isFile() || (!entry.name.endsWith(".json") && !entry.name.endsWith(".jsonl") && !entry.name.endsWith(".ndjson"))) continue;
    collectJsonFile(path.join(directory, entry.name), digests, retireBefore);
  }
}

/** Claude delivery ledgers are append-only queued/delivered pairs: a queued
    entry's refs stay reachable until its delivered marker ages past the
    retirement grace. Undelivered (crash-pending) entries never retire. */
function collectClaudeLedgerDigests(directory: string, digests: Set<string>, retireBefore: number): void {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(directory, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const filename = path.join(directory, entry.name);
    let contents: string;
    try { contents = fs.readFileSync(filename, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (!contents.trim()) continue;
    const queued = new Map<string, Set<string>>();
    const deliveredAt = new Map<string, number>();
    for (const record of readJsonlRecords(contents, filename)) {
      const row = record && typeof record === "object" && !Array.isArray(record) ? record as Record<string, unknown> : null;
      const queuedEntry = row?.kind === "queued" && row.entry && typeof row.entry === "object"
        ? (row.entry as Record<string, unknown>)
        : null;
      if (queuedEntry && typeof queuedEntry.id === "string") {
        const bucket = queued.get(queuedEntry.id) ?? new Set<string>();
        collectDigests(row, bucket, retireBefore);
        queued.set(queuedEntry.id, bucket);
        continue;
      }
      if (row?.kind === "delivered" && typeof row.entryId === "string") {
        const at = typeof row.deliveredAt === "string" ? Date.parse(row.deliveredAt) : Number.NaN;
        if (Number.isFinite(at)) deliveredAt.set(row.entryId, at);
        continue;
      }
      collectDigests(record, digests, retireBefore);
    }
    for (const [id, bucket] of queued) {
      const terminalAt = deliveredAt.get(id);
      if (terminalAt !== undefined && terminalAt <= retireBefore) continue;
      for (const digest of bucket) digests.add(digest);
    }
  }
}

function openReadonlyDatabase(filename: string): BunDatabase {
  const sqlite = process.getBuiltinModule?.("bun:sqlite") as typeof import("bun:sqlite") | undefined;
  if (!sqlite) throw new Error("runtime image reachability requires the Bun runtime");
  return new sqlite.Database(filename, { readonly: true, strict: true });
}

/** Receipt statuses meaning the payload terminally reached the agent: the
    request's images have been consumed and its refs may retire on the same
    bounded grace as delivered reservations. Pending statuses and retryable
    terminals (failed/rejected) keep pinning their refs. */
const TERMINAL_DELIVERED_RECEIPT_STATUSES = new Set(["delivered", "turn-started", "steered"]);

function journalOperationRetired(receiptJson: unknown, retireBefore: number): boolean {
  if (typeof receiptJson !== "string" || !receiptJson.trim()) return false;
  let receipt: unknown;
  try { receipt = JSON.parse(receiptJson); } catch { return false; }
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return false;
  const record = receipt as Record<string, unknown>;
  if (typeof record.status !== "string" || !TERMINAL_DELIVERED_RECEIPT_STATUSES.has(record.status)) return false;
  const at = typeof record.at === "string" ? Date.parse(record.at) : Number.NaN;
  return Number.isFinite(at) && at <= retireBefore;
}

type JournalOperationReachabilityRow = {
  operation_id: string;
  request_json: string;
  receipt_json: string;
};

function journalReceiptRecord(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function retiredJournalOperationIds(rows: readonly JournalOperationReachabilityRow[], retireBefore: number): Set<string> {
  const rowsById = new Map(rows.map((row) => [row.operation_id, row]));
  const receiptsById = new Map(rows.map((row) => [row.operation_id, journalReceiptRecord(row.receipt_json)]));
  const parentIds = new Set<string>();
  for (const receipt of receiptsById.values()) {
    if (typeof receipt?.retryOfOperationId === "string") parentIds.add(receipt.retryOfOperationId);
  }
  const groups = new Map<string, Set<string>>();
  for (const operationId of rowsById.keys()) {
    let root = operationId;
    const seen = new Set<string>();
    while (!seen.has(root)) {
      seen.add(root);
      const parent = receiptsById.get(root)?.retryOfOperationId;
      if (typeof parent !== "string") break;
      root = parent;
    }
    const members = groups.get(root) ?? new Set<string>();
    members.add(operationId);
    groups.set(root, members);
  }
  const retired = new Set<string>();
  for (const members of groups.values()) {
    const leaves = [...members].filter((operationId) => !parentIds.has(operationId));
    if (leaves.length === 0 || !leaves.every((operationId) =>
      journalOperationRetired(rowsById.get(operationId)?.receipt_json, retireBefore))) continue;
    for (const operationId of members) retired.add(operationId);
  }
  return retired;
}

function collectJournalDigests(filename: string, digests: Set<string>, retireBefore: number): void {
  if (!fs.existsSync(filename)) return;
  const db = openReadonlyDatabase(filename);
  try {
      const sources: Array<[string, string[]]> = [
        ["events", ["payload_json"]],
        ["projections", ["state_json"]],
        ["entities", ["state_json"]],
        ["outbox", ["payload_json"]],
        ["producer_receipts", ["event_json"]],
      ];
      const tables = new Set((db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name));
      if (tables.has("operations")) {
        const columns = new Set((db.query("PRAGMA table_info(operations)").all() as Array<{ name: string }>).map((column) => column.name));
        if (columns.has("operation_id")) {
          const rows = db.query("SELECT operation_id, request_json, receipt_json FROM operations").all() as JournalOperationReachabilityRow[];
          const retired = retiredJournalOperationIds(rows, retireBefore);
          for (const row of rows) {
            if (retired.has(row.operation_id)) continue;
            for (const raw of [row.request_json, row.receipt_json]) {
              if (raw.trim()) collectDigests(JSON.parse(raw), digests, retireBefore);
            }
          }
        } else {
          const rows = db.query("SELECT request_json, receipt_json FROM operations").all() as Array<Pick<JournalOperationReachabilityRow, "request_json" | "receipt_json">>;
          for (const row of rows) {
            if (journalOperationRetired(row.receipt_json, retireBefore)) continue;
            for (const raw of [row.request_json, row.receipt_json]) {
              if (raw.trim()) collectDigests(JSON.parse(raw), digests, retireBefore);
            }
          }
        }
      }
      for (const [table, columns] of sources) {
        if (!tables.has(table)) continue;
        const rows = db.query(`SELECT ${columns.join(", ")} FROM ${table}`).all() as Array<Record<string, unknown>>;
        for (const row of rows) {
          for (const column of columns) {
            const raw = row[column];
          if (typeof raw === "string" && raw.trim()) collectDigests(JSON.parse(raw), digests, retireBefore);
        }
      }
    }
  } finally {
    db.close();
  }
}

function collectRegistrySqliteDigests(filename: string, digests: Set<string>, retireBefore: number): void {
  if (!fs.existsSync(filename)) return;
  const db = openReadonlyDatabase(filename);
  try {
    const table = db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'registry_rows'").get();
    if (!table) return;
    const rows = db.query("SELECT value_json FROM registry_rows").all() as Array<{ value_json: string }>;
    for (const row of rows) collectDigests(JSON.parse(row.value_json), digests, retireBefore);
  } finally {
    db.close();
  }
}

export interface RuntimeImageReachabilityOptions {
  now?: number;
  retiredGraceMs?: number;
}

export function collectRuntimeImageReachableDigests(
  root = stateDir(),
  options: RuntimeImageReachabilityOptions = {},
): ReadonlySet<string> {
  const retireBefore = (options.now ?? Date.now()) - (options.retiredGraceMs ?? DELIVERED_REF_RETIREMENT_GRACE_MS);
  const digests = new Set<string>();
  collectJsonFile(path.join(root, "agent-registry.json"), digests, retireBefore);
  collectRegistrySqliteDigests(path.join(root, "agent-registry.sqlite"), digests, retireBefore);
  collectClaudeLedgerDigests(path.join(root, "claude-delivery-ledger"), digests, retireBefore);
  collectJsonDirectory(path.join(root, "structured-host-events"), digests, retireBefore);
  collectJournalDigests(path.join(root, "runtime-events.sqlite"), digests, retireBefore);
  return digests;
}

function configuredMaxBytes(): number {
  const raw = process.env.LLV_RUNTIME_IMAGE_STORE_MAX_BYTES?.trim();
  if (!raw) return MAX_RUNTIME_IMAGE_STORE_BYTES;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("runtime image storage quota is invalid");
  return value;
}

interface OpenRoot {
  fd: number;
  path: string;
  /** True when `path` routes through `/proc/self/fd` and is therefore pinned
      to the validated directory regardless of later renames of the root. */
  pinned: boolean;
}

interface WriterLockOwner {
  pid: number;
  /** Portable process start identity from the proc backend (`/proc` stat on
      Linux, libproc via Bun FFI on Darwin); null where the backend cannot
      produce one, in which case fencing degrades to pid liveness alone. */
  startIdentity: string | null;
  token: string;
}

function readOwnerFile(filename: string): WriterLockOwner | null {
  let value: unknown;
  try {
    const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try { value = JSON.parse(fs.readFileSync(fd, "utf8")); }
    finally { fs.closeSync(fd); }
  } catch (error) {
    if (["ENOENT", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "")) return null;
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const owner = value as Partial<WriterLockOwner>;
  if (!Number.isSafeInteger(owner.pid) || owner.pid! <= 0
    || (owner.startIdentity !== null && (typeof owner.startIdentity !== "string" || !owner.startIdentity))
    || typeof owner.token !== "string" || !owner.token) return null;
  return owner as WriterLockOwner;
}

function readWriterLockOwner(lock: string): WriterLockOwner | null {
  return readOwnerFile(path.join(lock, "owner.json"));
}

function writerLockOwnerIsAlive(owner: WriterLockOwner | null): boolean {
  if (owner === null) return false;
  if (!procBackend.pidAlive(owner.pid)) return false;
  return owner.startIdentity === null || procBackend.processIdentity(owner.pid) === owner.startIdentity;
}

function procSelfFdAvailable(): boolean {
  return fs.existsSync("/proc/self/fd");
}

export class RuntimeImageStore {
  private readonly maxBytes: number;
  private readonly fault: NonNullable<RuntimeImageStoreOptions["fault"]>;
  private readonly now: () => number;
  private readonly abandonedPartialMaxAgeMs: number;
  private readonly gcGraceMs: number;
  private readonly reachableDigests: () => ReadonlySet<string>;
  private readonly afterRootOpen: NonNullable<RuntimeImageStoreOptions["afterRootOpen"]>;
  private readonly writerLockStaleMs: number;
  private readonly writerLockWaitMs: number;
  private readonly procSelfFdPaths: boolean;

  constructor(
    private readonly root = statePath("runtime-images"),
    options: RuntimeImageStoreOptions = {},
  ) {
    this.maxBytes = options.maxBytes ?? configuredMaxBytes();
    this.fault = options.fault ?? (() => {});
    this.now = options.now ?? Date.now;
    this.abandonedPartialMaxAgeMs = options.abandonedPartialMaxAgeMs ?? ABANDONED_PARTIAL_MAX_AGE_MS;
    this.gcGraceMs = options.gcGraceMs ?? GC_GRACE_MS;
    this.reachableDigests = options.reachableDigests
      ?? (() => collectRuntimeImageReachableDigests(path.dirname(this.root), { now: this.now() }));
    this.afterRootOpen = options.afterRootOpen ?? (() => {});
    this.writerLockStaleMs = options.writerLockStaleMs ?? WRITER_LOCK_STALE_MS;
    this.writerLockWaitMs = options.writerLockWaitMs ?? WRITER_LOCK_WAIT_MS;
    this.procSelfFdPaths = options.procSelfFdPaths ?? procSelfFdAvailable();
    this.ensurePrivateRoot();
    this.withWriterLock("maintenance", (root) => this.removeAgedPartials(root));
  }

  putMany(uploads: readonly RuntimeImageUpload[]): StructuredImageRef[] {
    if (uploads.length > MAX_STRUCTURED_IMAGES) throw new Error("too many images");
    const encodedBytes = uploads.reduce((sum, upload) => sum + Buffer.byteLength(upload.base64), 0);
    if (encodedBytes > MAX_STRUCTURED_IMAGE_ENCODED_BYTES) throw new Error("runtime image request encoding is too large");
    const decoded = uploads.map((upload) => this.validateUpload(upload));
    const total = decoded.reduce((sum, item) => sum + item.data.byteLength, 0);
    if (total > MAX_STRUCTURED_IMAGE_TOTAL_BYTES) throw new Error("runtime image request is too large");
    return this.withWriterLock("write", (root) => {
      this.assertQuota(root, decoded);
      /* Batch rollback removes images newly published by this call after a
         later image fails. Existing deduplicated blobs remain in place. */
      const published: string[] = [];
      const refs: StructuredImageRef[] = [];
      try {
        for (const { data, mime } of decoded) {
          const { ref, created } = this.put(root, data, mime);
          if (created) published.push(path.join(root.path, path.basename(this.pathFor(ref))));
          refs.push(ref);
        }
      } catch (error) {
        for (const filename of published) fs.rmSync(filename, { force: true });
        if (published.length) syncDirectory(root.path);
        throw error;
      }
      return refs;
    });
  }

  read(ref: StructuredImageRef): Buffer {
    const root = this.openRoot("read");
    try { return this.readFromRoot(root, ref); }
    finally { fs.closeSync(root.fd); }
  }

  pathFor(ref: StructuredImageRef): string {
    const mime = normalizeStructuredImageMime(ref.mime);
    if (!mime || !/^[a-f0-9]{64}$/.test(ref.sha256) || !Number.isSafeInteger(ref.bytes) || ref.bytes <= 0) {
      throw new Error("runtime image ref is invalid");
    }
    return path.join(this.root, `${ref.sha256}.${MIME_EXT[mime]}`);
  }

  private validateUpload(upload: RuntimeImageUpload): { data: Buffer; mime: StructuredImageMime } {
    return validateRuntimeImageUpload(upload);
  }

  private assertQuota(root: OpenRoot, decoded: readonly { data: Buffer; mime: StructuredImageMime }[]): void {
    let current = this.storedBytes(root);
    const missingBytes = () => {
      const missing = new Map<string, number>();
      for (const { data, mime } of decoded) {
        const sha256 = crypto.createHash("sha256").update(data).digest("hex");
        const filename = path.join(root.path, `${sha256}.${MIME_EXT[mime]}`);
        if (!fs.existsSync(filename)) missing.set(filename, data.byteLength);
      }
      return [...missing.values()].reduce((sum, bytes) => sum + bytes, 0);
    };
    let incoming = missingBytes();
    if (current + incoming > this.maxBytes) {
      const protectedDigests = new Set(this.reachableDigests());
      for (const { data } of decoded) protectedDigests.add(crypto.createHash("sha256").update(data).digest("hex"));
      this.collectGarbage(root, protectedDigests);
      current = this.storedBytes(root);
      /* GC may remove an aged dedup candidate from this batch. Refresh the
         missing set before deciding whether the complete write fits. */
      incoming = missingBytes();
    }
    if (current + incoming > this.maxBytes) throw new Error("runtime image storage quota exceeded");
  }

  private withWriterLock<T>(operation: "write" | "maintenance", run: (root: OpenRoot) => T): T {
    this.ensurePrivateRoot();
    const root = this.openRoot(operation);
    const lock = path.join(root.path, ".writer-lock");
    const deadline = this.now() + this.writerLockWaitMs;
    const owner: WriterLockOwner = {
      pid: process.pid,
      startIdentity: procBackend.processIdentity(process.pid),
      token: crypto.randomUUID(),
    };
    let acquired = false;
    try {
      while (!acquired) {
        this.withWriterAcquisitionGate(root, deadline, () => {
          this.assertRootPinned(root);
          let created = false;
          try {
            fs.mkdirSync(lock, { mode: 0o700 });
            created = true;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          }
          if (created) {
            try {
              fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify(owner), { flag: "wx", mode: 0o600 });
              acquired = true;
              return;
            } catch (error) {
              /* A restored displaced lock can replace the directory created
                 by this process. The current owner remains authoritative. */
              if ((error as NodeJS.ErrnoException).code === "EEXIST") return;
              fs.rmSync(lock, { recursive: true, force: true });
              throw error;
            }
          }
          try {
            const stat = fs.lstatSync(lock);
            if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("runtime image writer lock is unsafe");
            if (this.now() - stat.mtimeMs > this.writerLockStaleMs && !writerLockOwnerIsAlive(readWriterLockOwner(lock))) {
              this.reclaimStaleWriterLock(root, lock, stat);
            }
          } catch (statError) {
            if ((statError as NodeJS.ErrnoException).code !== "ENOENT") throw statError;
          }
        });
        if (acquired) break;
        if (this.now() >= deadline) throw new Error("runtime image writer lock timed out");
        sleepSync(5);
      }
      /* Final ownership verification before the quota-critical section: only
         the process whose exact token sits in owner.json may enter. */
      if (readWriterLockOwner(lock)?.token !== owner.token) {
        throw new Error("runtime image writer lock was lost before entry");
      }
      return run(root);
    } finally {
      if (acquired && readWriterLockOwner(lock)?.token === owner.token) {
        fs.rmSync(lock, { recursive: true, force: true });
      }
      fs.closeSync(root.fd);
    }
  }

  private withWriterAcquisitionGate<T>(root: OpenRoot, deadline: number, run: () => T): T {
    const queue = path.join(root.path, ".writer-lock-gate.queue");
    const gate = path.join(root.path, ".writer-lock-gate");
    const owner: WriterLockOwner = {
      pid: process.pid,
      startIdentity: procBackend.processIdentity(process.pid),
      token: crypto.randomUUID(),
    };
    fs.mkdirSync(queue, { recursive: true, mode: 0o700 });
    const ticket = path.join(
      queue,
      `${String(this.now()).padStart(16, "0")}-${process.pid}-${crypto.randomUUID()}.json`,
    );
    fs.writeFileSync(ticket, JSON.stringify(owner), { flag: "wx", mode: 0o600 });
    let acquired = false;
    try {
      while (!acquired) {
        this.assertRootPinned(root);
        const liveTickets: string[] = [];
        for (const entry of fs.readdirSync(queue).filter((candidate) => candidate.endsWith(".json")).sort()) {
          const candidate = path.join(queue, entry);
          const candidateOwner = readOwnerFile(candidate);
          if (!candidateOwner || !writerLockOwnerIsAlive(candidateOwner)) {
            fs.rmSync(candidate, { force: true });
            continue;
          }
          liveTickets.push(candidate);
        }
        if (liveTickets[0] === ticket) {
          try {
            fs.mkdirSync(gate, { mode: 0o700 });
            fs.writeFileSync(path.join(gate, "owner.json"), JSON.stringify(owner), { flag: "wx", mode: 0o600 });
            acquired = true;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            if (!writerLockOwnerIsAlive(readWriterLockOwner(gate))) {
              fs.rmSync(gate, { recursive: true, force: true });
            }
          }
        }
        if (!acquired) {
          if (this.now() >= deadline) throw new Error("runtime image writer lock timed out");
          sleepSync(5);
        }
      }
      return run();
    } finally {
      if (acquired && readWriterLockOwner(gate)?.token === owner.token) {
        fs.rmSync(gate, { recursive: true, force: true });
      }
      fs.rmSync(ticket, { force: true });
    }
  }

  /** Stale writer-lock reclamation runs inside the cross-process acquisition
      gate. The inode comparison detects replacement between observation and
      rename, then restores the displaced owner's lock before releasing the
      gate to another contender. */
  private reclaimStaleWriterLock(root: OpenRoot, lock: string, observed: fs.Stats): void {
    const graveyard = path.join(root.path, `.writer-lock-reclaim.${crypto.randomUUID()}`);
    try {
      fs.renameSync(lock, graveyard);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    let stolen: fs.Stats;
    try {
      stolen = fs.lstatSync(graveyard);
    } catch {
      return;
    }
    if (stolen.ino === observed.ino && stolen.dev === observed.dev) {
      fs.rmSync(graveyard, { recursive: true, force: true });
      return;
    }
    try {
      fs.renameSync(graveyard, lock);
    } catch (error) {
      /* Restoration failure preserves a visible safety fault. */
      throw new Error("runtime image writer lock reclamation raced", { cause: error });
    }
  }

  private removeAgedPartials(root: OpenRoot): void {
    this.assertRootPinned(root);
    for (const entry of fs.readdirSync(root.path, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".partial")) continue;
      const filename = path.join(root.path, entry.name);
      const stat = fs.lstatSync(filename);
      if (stat.isFile() && !stat.isSymbolicLink() && this.now() - stat.mtimeMs >= this.abandonedPartialMaxAgeMs) {
        fs.rmSync(filename, { force: true });
      }
    }
  }

  private storedBytes(root: OpenRoot): number {
    this.assertRootPinned(root);
    let total = 0;
    for (const entry of fs.readdirSync(root.path, { withFileTypes: true })) {
      if (!entry.isFile() || !BLOB_NAME.test(entry.name)) continue;
      const stat = fs.lstatSync(path.join(root.path, entry.name));
      if (stat.isFile() && !stat.isSymbolicLink()) total += stat.size;
    }
    return total;
  }

  private collectGarbage(root: OpenRoot, reachable: ReadonlySet<string>): void {
    this.assertRootPinned(root);
    for (const entry of fs.readdirSync(root.path, { withFileTypes: true })) {
      const match = entry.isFile() ? BLOB_NAME.exec(entry.name) : null;
      if (!match || reachable.has(match[1]!)) continue;
      const filename = path.join(root.path, entry.name);
      const stat = fs.lstatSync(filename);
      if (!stat.isFile() || stat.isSymbolicLink() || this.now() - stat.mtimeMs < this.gcGraceMs) continue;
      fs.rmSync(filename, { force: true });
    }
    syncDirectory(root.path);
  }

  private ensurePrivateRoot(): void {
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(this.root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
      stat = fs.lstatSync(this.root);
    }
    const owner = process.geteuid?.();
    if (!stat.isDirectory() || stat.isSymbolicLink() || owner === undefined || stat.uid !== owner || (stat.mode & 0o777) !== 0o700) {
      throw new Error("runtime image root is unsafe");
    }
  }

  private openRoot(operation: "read" | "write" | "maintenance"): OpenRoot {
    let fd: number;
    try {
      fd = fs.openSync(this.root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    } catch (error) {
      throw new Error("runtime image root is unsafe", { cause: error });
    }
    try {
      const stat = fs.fstatSync(fd);
      const owner = process.geteuid?.();
      if (!stat.isDirectory() || owner === undefined || stat.uid !== owner || (stat.mode & 0o777) !== 0o700) {
        throw new Error("runtime image root is unsafe");
      }
      this.afterRootOpen(operation);
      let pathStat: fs.Stats;
      try { pathStat = fs.lstatSync(this.root); }
      catch (error) { throw new Error("runtime image root changed during operation", { cause: error }); }
      if (!pathStat.isDirectory() || pathStat.isSymbolicLink() || pathStat.dev !== stat.dev || pathStat.ino !== stat.ino) {
        throw new Error("runtime image root changed during operation");
      }
      /* Linux pins every subsequent operation to the validated directory via
         the fd itself. Darwin has no /proc, so operations go through the real
         path and re-validate the root's device/inode against the held fd
         (assertRootPinned) before each directory-relative step. */
      return this.procSelfFdPaths
        ? { fd, path: `/proc/self/fd/${fd}`, pinned: true }
        : { fd, path: this.root, pinned: false };
    } catch (error) {
      fs.closeSync(fd);
      throw error;
    }
  }

  /** Re-checks that the root path still names the directory the held fd was
      validated against. A no-op on the pinned `/proc/self/fd` path; on the
      portable (Darwin) path it fails closed when the root was swapped. */
  private assertRootPinned(root: OpenRoot): void {
    if (root.pinned) return;
    const fdStat = fs.fstatSync(root.fd);
    let pathStat: fs.Stats;
    try { pathStat = fs.lstatSync(this.root); }
    catch (error) { throw new Error("runtime image root changed during operation", { cause: error }); }
    if (!pathStat.isDirectory() || pathStat.isSymbolicLink() || pathStat.dev !== fdStat.dev || pathStat.ino !== fdStat.ino) {
      throw new Error("runtime image root changed during operation");
    }
  }

  private readFromRoot(root: OpenRoot, ref: StructuredImageRef): Buffer {
    this.assertRootPinned(root);
    const filename = path.join(root.path, path.basename(this.pathFor(ref)));
    let fd: number;
    try { fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") throw new Error(`runtime image ${ref.sha256.slice(0, 12)} is missing`);
      if (code === "ELOOP") throw new Error("runtime image ref is unsafe");
      throw error;
    }
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile()) throw new Error("runtime image ref is unsafe");
      const data = fs.readFileSync(fd);
      if (data.byteLength !== ref.bytes || crypto.createHash("sha256").update(data).digest("hex") !== ref.sha256) {
        throw new Error(`runtime image ${ref.sha256.slice(0, 12)} digest mismatch`);
      }
      if (!hasRuntimeImageSignature(data, ref.mime)) throw new Error(`runtime image ${ref.sha256.slice(0, 12)} signature mismatch`);
      return data;
    } finally {
      fs.closeSync(fd);
    }
  }

  private put(root: OpenRoot, data: Buffer, mime: StructuredImageMime): { ref: StructuredImageRef; created: boolean } {
    this.assertRootPinned(root);
    const sha256 = crypto.createHash("sha256").update(data).digest("hex");
    const ref = { sha256, mime, bytes: data.byteLength };
    const filename = path.join(root.path, path.basename(this.pathFor(ref)));
      if (fs.existsSync(filename)) {
        this.readFromRoot(root, ref);
        fs.chmodSync(filename, 0o600);
        const touchedAt = new Date(this.now());
        fs.utimesSync(filename, touchedAt, touchedAt);
        return { ref, created: false };
      }
    const temporary = path.join(root.path, `.${sha256}.${crypto.randomUUID()}.partial`);
    let published = false;
    try {
      const fd = fs.openSync(temporary, "wx", 0o600);
      try {
        this.fault("write");
        fs.writeFileSync(fd, data);
        this.fault("fsync");
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      this.fault("link");
      fs.linkSync(temporary, filename);
      published = true;
      fs.chmodSync(filename, 0o600);
      this.fault("directory-fsync");
      syncDirectory(root.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        this.readFromRoot(root, ref);
        return { ref, created: false };
      }
      if (published) {
        fs.rmSync(filename, { force: true });
        syncDirectory(root.path);
      }
      throw error;
    } finally {
      fs.rmSync(temporary, { force: true });
      syncDirectory(root.path);
    }
    return { ref, created: published };
  }
}

let defaultStore: RuntimeImageStore | null = null;

export function runtimeImageStore(): RuntimeImageStore {
  return defaultStore ??= new RuntimeImageStore();
}
