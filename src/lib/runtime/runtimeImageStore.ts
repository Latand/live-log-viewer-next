import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { Database as BunDatabase } from "bun:sqlite";

import { stateDir, statePath } from "@/lib/configDir";

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
}

const REF_DIGEST = /^[a-f0-9]{64}$/;
const BLOB_NAME = /^([a-f0-9]{64})\.(png|jpg|gif|webp)$/;

function collectDigests(value: unknown, digests: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectDigests(item, digests);
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if (typeof record.sha256 === "string" && REF_DIGEST.test(record.sha256)
    && typeof record.mime === "string" && normalizeStructuredImageMime(record.mime)
    && Number.isSafeInteger(record.bytes) && Number(record.bytes) > 0) {
    digests.add(record.sha256);
  }
  for (const nested of Object.values(record)) collectDigests(nested, digests);
}

function collectJsonFile(filename: string, digests: Set<string>): void {
  let contents: string;
  try { contents = fs.readFileSync(filename, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!contents.trim()) return;
  if (filename.endsWith(".jsonl") || filename.endsWith(".ndjson")) {
    for (const line of contents.split("\n")) {
      if (line.trim()) collectDigests(JSON.parse(line), digests);
    }
    return;
  }
  collectDigests(JSON.parse(contents), digests);
}

function collectJsonDirectory(directory: string, digests: Set<string>): void {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(directory, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isFile() || (!entry.name.endsWith(".json") && !entry.name.endsWith(".jsonl") && !entry.name.endsWith(".ndjson"))) continue;
    collectJsonFile(path.join(directory, entry.name), digests);
  }
}

function openReadonlyDatabase(filename: string): BunDatabase {
  const sqlite = process.getBuiltinModule?.("bun:sqlite") as typeof import("bun:sqlite") | undefined;
  if (!sqlite) throw new Error("runtime image reachability requires the Bun runtime");
  return new sqlite.Database(filename, { readonly: true, strict: true });
}

function collectJournalDigests(filename: string, digests: Set<string>): void {
  if (!fs.existsSync(filename)) return;
  const db = openReadonlyDatabase(filename);
  try {
    const sources: Array<[string, string[]]> = [
      ["events", ["payload_json"]],
      ["projections", ["state_json"]],
      ["entities", ["state_json"]],
      ["outbox", ["payload_json"]],
      ["producer_receipts", ["event_json"]],
      ["operations", ["request_json", "receipt_json"]],
    ];
    const tables = new Set((db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name));
    for (const [table, columns] of sources) {
      if (!tables.has(table)) continue;
      const rows = db.query(`SELECT ${columns.join(", ")} FROM ${table}`).all() as Array<Record<string, unknown>>;
      for (const row of rows) {
        for (const column of columns) {
          const raw = row[column];
          if (typeof raw === "string" && raw.trim()) collectDigests(JSON.parse(raw), digests);
        }
      }
    }
  } finally {
    db.close();
  }
}

function collectRegistrySqliteDigests(filename: string, digests: Set<string>): void {
  if (!fs.existsSync(filename)) return;
  const db = openReadonlyDatabase(filename);
  try {
    const table = db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'registry_rows'").get();
    if (!table) return;
    const rows = db.query("SELECT value_json FROM registry_rows").all() as Array<{ value_json: string }>;
    for (const row of rows) collectDigests(JSON.parse(row.value_json), digests);
  } finally {
    db.close();
  }
}

export function collectRuntimeImageReachableDigests(root = stateDir()): ReadonlySet<string> {
  const digests = new Set<string>();
  collectJsonFile(path.join(root, "agent-registry.json"), digests);
  collectRegistrySqliteDigests(path.join(root, "agent-registry.sqlite"), digests);
  collectJsonDirectory(path.join(root, "claude-delivery-ledger"), digests);
  collectJsonDirectory(path.join(root, "structured-host-events"), digests);
  collectJournalDigests(path.join(root, "runtime-events.sqlite"), digests);
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
}

interface WriterLockOwner {
  pid: number;
  processStartTime: string;
  token: string;
}

function processStartTime(pid: number): string | null {
  let stat: string;
  try { stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const commandEnd = stat.lastIndexOf(") ");
  if (commandEnd < 0) throw new Error("process identity is malformed");
  return stat.slice(commandEnd + 2).trim().split(/\s+/)[19] ?? null;
}

function readWriterLockOwner(lock: string): WriterLockOwner | null {
  let value: unknown;
  try {
    const fd = fs.openSync(path.join(lock, "owner.json"), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
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
    || typeof owner.processStartTime !== "string" || !owner.processStartTime
    || typeof owner.token !== "string" || !owner.token) return null;
  return owner as WriterLockOwner;
}

function writerLockOwnerIsAlive(owner: WriterLockOwner | null): boolean {
  return owner !== null && processStartTime(owner.pid) === owner.processStartTime;
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

  constructor(
    private readonly root = statePath("runtime-images"),
    options: RuntimeImageStoreOptions = {},
  ) {
    this.maxBytes = options.maxBytes ?? configuredMaxBytes();
    this.fault = options.fault ?? (() => {});
    this.now = options.now ?? Date.now;
    this.abandonedPartialMaxAgeMs = options.abandonedPartialMaxAgeMs ?? ABANDONED_PARTIAL_MAX_AGE_MS;
    this.gcGraceMs = options.gcGraceMs ?? GC_GRACE_MS;
    this.reachableDigests = options.reachableDigests ?? (() => collectRuntimeImageReachableDigests(path.dirname(this.root)));
    this.afterRootOpen = options.afterRootOpen ?? (() => {});
    this.writerLockStaleMs = options.writerLockStaleMs ?? WRITER_LOCK_STALE_MS;
    this.writerLockWaitMs = options.writerLockWaitMs ?? WRITER_LOCK_WAIT_MS;
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
      return decoded.map(({ data, mime }) => this.put(root, data, mime));
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
    const mime = normalizeStructuredImageMime(upload.mime);
    if (!mime) throw new Error("runtime image MIME is unsupported");
    const data = decodeBase64(upload.base64);
    if (data.byteLength > MAX_STRUCTURED_IMAGE_BYTES) throw new Error("runtime image exceeds 10 MB");
    if (!hasRuntimeImageSignature(data, mime)) throw new Error("runtime image signature does not match MIME");
    return { data, mime };
  }

  private assertQuota(root: OpenRoot, decoded: readonly { data: Buffer; mime: StructuredImageMime }[]): void {
    let current = this.storedBytes(root);
    const missing = new Map<string, number>();
    for (const { data, mime } of decoded) {
      const sha256 = crypto.createHash("sha256").update(data).digest("hex");
      const filename = path.join(root.path, `${sha256}.${MIME_EXT[mime]}`);
      if (!fs.existsSync(filename)) missing.set(filename, data.byteLength);
    }
    const incoming = [...missing.values()].reduce((sum, bytes) => sum + bytes, 0);
    if (current + incoming > this.maxBytes) {
      this.collectGarbage(root, this.reachableDigests());
      current = this.storedBytes(root);
    }
    if (current + incoming > this.maxBytes) throw new Error("runtime image storage quota exceeded");
  }

  private withWriterLock<T>(operation: "write" | "maintenance", run: (root: OpenRoot) => T): T {
    const ownProcessStartTime = processStartTime(process.pid);
    if (!ownProcessStartTime) throw new Error("runtime image writer identity is unavailable");
    this.ensurePrivateRoot();
    const root = this.openRoot(operation);
    const lock = path.join(root.path, ".writer-lock");
    const deadline = this.now() + this.writerLockWaitMs;
    const owner: WriterLockOwner = {
      pid: process.pid,
      processStartTime: ownProcessStartTime,
      token: crypto.randomUUID(),
    };
    let acquired = false;
    try {
      while (true) {
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
            break;
          } catch (error) {
            fs.rmSync(lock, { recursive: true, force: true });
            throw error;
          }
        }
        try {
          const stat = fs.lstatSync(lock);
          if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("runtime image writer lock is unsafe");
          if (this.now() - stat.mtimeMs > this.writerLockStaleMs && !writerLockOwnerIsAlive(readWriterLockOwner(lock))) {
            fs.rmSync(lock, { recursive: true, force: true });
            continue;
          }
        } catch (statError) {
          if ((statError as NodeJS.ErrnoException).code !== "ENOENT") throw statError;
          continue;
        }
        if (this.now() >= deadline) throw new Error("runtime image writer lock timed out");
        sleepSync(5);
      }
      return run(root);
    } finally {
      if (acquired && readWriterLockOwner(lock)?.token === owner.token) {
        fs.rmSync(lock, { recursive: true, force: true });
      }
      fs.closeSync(root.fd);
    }
  }

  private removeAgedPartials(root: OpenRoot): void {
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
    let total = 0;
    for (const entry of fs.readdirSync(root.path, { withFileTypes: true })) {
      if (!entry.isFile() || !BLOB_NAME.test(entry.name)) continue;
      const stat = fs.lstatSync(path.join(root.path, entry.name));
      if (stat.isFile() && !stat.isSymbolicLink()) total += stat.size;
    }
    return total;
  }

  private collectGarbage(root: OpenRoot, reachable: ReadonlySet<string>): void {
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
      return { fd, path: `/proc/self/fd/${fd}` };
    } catch (error) {
      fs.closeSync(fd);
      throw error;
    }
  }

  private readFromRoot(root: OpenRoot, ref: StructuredImageRef): Buffer {
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

  private put(root: OpenRoot, data: Buffer, mime: StructuredImageMime): StructuredImageRef {
    const sha256 = crypto.createHash("sha256").update(data).digest("hex");
    const ref = { sha256, mime, bytes: data.byteLength };
    const filename = path.join(root.path, path.basename(this.pathFor(ref)));
    if (fs.existsSync(filename)) {
      this.readFromRoot(root, ref);
      fs.chmodSync(filename, 0o600);
      return ref;
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
      } else {
        if (published) {
          fs.rmSync(filename, { force: true });
          syncDirectory(root.path);
        }
        throw error;
      }
    } finally {
      fs.rmSync(temporary, { force: true });
      syncDirectory(root.path);
    }
    return ref;
  }
}

let defaultStore: RuntimeImageStore | null = null;

export function runtimeImageStore(): RuntimeImageStore {
  return defaultStore ??= new RuntimeImageStore();
}
