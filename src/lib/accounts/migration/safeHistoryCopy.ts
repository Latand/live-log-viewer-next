import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const DEFAULT_HISTORY_LIMIT = 512 * 1024 * 1024;

export type HistorySecurityCode =
  | "unsafe-root"
  | "unsafe-source"
  | "history-too-large"
  | "history-collision"
  | "history-integrity";

export class HistorySecurityError extends Error {
  constructor(readonly code: HistorySecurityCode) {
    super(code);
    this.name = "HistorySecurityError";
  }
}

function currentUid(): number | null {
  return process.getuid?.() ?? null;
}

function owned(stat: fs.Stats): boolean {
  const uid = currentUid();
  return uid === null || stat.uid === uid;
}

function safeDirectory(pathname: string): fs.Stats {
  let stat: fs.Stats;
  try { stat = fs.lstatSync(pathname); } catch { throw new HistorySecurityError("unsafe-root"); }
  if (!stat.isDirectory() || stat.isSymbolicLink() || !owned(stat) || (stat.mode & 0o077) !== 0) {
    throw new HistorySecurityError("unsafe-root");
  }
  return stat;
}

function contained(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + path.sep);
}

export interface ValidatedHistory {
  sourcePath: string;
  sourceRoot: string;
  size: number;
  device: number;
  inode: number;
  mtimeMs: number;
  ctimeMs: number;
}

/** Validates the registered transcript boundary and pins file identity. */
export function validateHistorySource(sourcePath: string, sourceRoot: string, maxBytes = DEFAULT_HISTORY_LIMIT): ValidatedHistory {
  safeDirectory(sourceRoot);
  const lexicalRoot = path.resolve(sourceRoot);
  const lexicalSource = path.resolve(sourcePath);
  if (!contained(lexicalRoot, lexicalSource) || lexicalRoot === lexicalSource) throw new HistorySecurityError("unsafe-source");
  const relative = path.relative(lexicalRoot, lexicalSource);
  let component = lexicalRoot;
  const segments = relative.split(path.sep);
  for (const segment of segments.slice(0, -1)) {
    component = path.join(component, segment);
    safeDirectory(component);
  }
  let rootReal: string;
  let sourceReal: string;
  try {
    rootReal = fs.realpathSync(sourceRoot);
    sourceReal = fs.realpathSync(sourcePath);
  } catch {
    throw new HistorySecurityError("unsafe-source");
  }
  if (!contained(rootReal, sourceReal)) throw new HistorySecurityError("unsafe-source");
  const listed = fs.lstatSync(sourcePath);
  if (!listed.isFile() || listed.isSymbolicLink() || listed.nlink !== 1 || !owned(listed) || (listed.mode & 0o077) !== 0) {
    throw new HistorySecurityError("unsafe-source");
  }
  if (listed.size > maxBytes) throw new HistorySecurityError("history-too-large");
  const fd = fs.openSync(sourcePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || !owned(opened) || opened.dev !== listed.dev || opened.ino !== listed.ino || opened.size !== listed.size) {
      throw new HistorySecurityError("unsafe-source");
    }
  } finally {
    fs.closeSync(fd);
  }
  return {
    sourcePath: sourceReal,
    sourceRoot: rootReal,
    size: listed.size,
    device: listed.dev,
    inode: listed.ino,
    mtimeMs: listed.mtimeMs,
    ctimeMs: listed.ctimeMs,
  };
}

function safeRelative(relativePath: string): string {
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.includes("\0")) throw new HistorySecurityError("unsafe-root");
  const normalized = path.normalize(relativePath);
  if (normalized === ".." || normalized.startsWith(".." + path.sep)) throw new HistorySecurityError("unsafe-root");
  return normalized;
}

function ensureDirectoryTree(root: string, relativeDirectory: string): string {
  safeDirectory(root);
  let current = fs.realpathSync(root);
  for (const segment of relativeDirectory.split(path.sep).filter((item) => item && item !== ".")) {
    if (segment === "." || segment === "..") throw new HistorySecurityError("unsafe-root");
    const next = path.join(current, segment);
    try { fs.mkdirSync(next, { mode: 0o700 }); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    safeDirectory(next);
    const real = fs.realpathSync(next);
    if (!contained(fs.realpathSync(root), real)) throw new HistorySecurityError("unsafe-root");
    current = real;
  }
  return current;
}

function sameIdentity(stat: fs.Stats, expected: ValidatedHistory): boolean {
  return stat.nlink === 1 && stat.dev === expected.device && stat.ino === expected.inode && stat.size === expected.size
    && stat.mtimeMs === expected.mtimeMs && stat.ctimeMs === expected.ctimeMs;
}

function hashFile(pathname: string, maxBytes: number, expected?: ValidatedHistory, privateFile = false): { hash: string; size: number } {
  let listed: fs.Stats;
  try { listed = fs.lstatSync(pathname); } catch { throw new HistorySecurityError(privateFile ? "history-collision" : "unsafe-source"); }
  if (!listed.isFile() || listed.isSymbolicLink() || listed.nlink !== 1 || !owned(listed) || (privateFile && (listed.mode & 0o077) !== 0)) {
    throw new HistorySecurityError(privateFile ? "history-collision" : "unsafe-source");
  }
  const fd = fs.openSync(pathname, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  const hash = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let total = 0;
  try {
    const opened = fs.fstatSync(fd);
    if (opened.dev !== listed.dev || opened.ino !== listed.ino || opened.size !== listed.size || (expected && !sameIdentity(opened, expected))) {
      throw new HistorySecurityError(privateFile ? "history-collision" : "history-integrity");
    }
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      total += read;
      if (total > maxBytes) throw new HistorySecurityError("history-too-large");
      hash.update(buffer.subarray(0, read));
    }
    const finished = fs.fstatSync(fd);
    if (finished.dev !== opened.dev || finished.ino !== opened.ino || finished.size !== opened.size
      || finished.mtimeMs !== opened.mtimeMs || finished.ctimeMs !== opened.ctimeMs || total !== opened.size) {
      throw new HistorySecurityError(privateFile ? "history-collision" : "history-integrity");
    }
  } finally { fs.closeSync(fd); }
  return { hash: hash.digest("hex"), size: total };
}

export function hashValidatedHistory(sourcePath: string, sourceRoot: string, maxBytes = DEFAULT_HISTORY_LIMIT): { hash: string; size: number } {
  const source = validateHistorySource(sourcePath, sourceRoot, maxBytes);
  return hashFile(source.sourcePath, maxBytes, source);
}

interface ReceiptFile { operationId: string; hash: string; size: number }

function readReceipt(pathname: string): ReceiptFile | null {
  try {
    const stat = fs.lstatSync(pathname);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !owned(stat) || (stat.mode & 0o077) !== 0 || stat.size > 4096) return null;
    const value = JSON.parse(fs.readFileSync(pathname, "utf8")) as Partial<ReceiptFile>;
    return typeof value.operationId === "string" && typeof value.hash === "string" && typeof value.size === "number"
      ? value as ReceiptFile
      : null;
  } catch { return null; }
}

export interface SafeHistoryCopyInput {
  sourcePath: string;
  sourceRoot: string;
  targetRoot: string;
  destinationRelative: string;
  operationId: string;
  maxBytes?: number;
}

export interface SafeHistoryCopyResult { path: string; hash: string; size: number; reused: boolean }

/** Streams one transcript into a registered target root with an operation/hash receipt. */
export function safeCopyHistory(input: SafeHistoryCopyInput): SafeHistoryCopyResult {
  const maxBytes = input.maxBytes ?? DEFAULT_HISTORY_LIMIT;
  const source = validateHistorySource(input.sourcePath, input.sourceRoot, maxBytes);
  const relative = safeRelative(input.destinationRelative);
  const parent = ensureDirectoryTree(input.targetRoot, path.dirname(relative));
  const destination = path.join(parent, path.basename(relative));
  const receiptPath = `${destination}.llv-receipt.json`;
  if (fs.existsSync(destination)) {
    const receipt = readReceipt(receiptPath);
    const existing = hashFile(destination, maxBytes, undefined, true);
    const original = hashFile(source.sourcePath, maxBytes, source);
    if (receipt?.operationId === input.operationId && receipt.hash === existing.hash && receipt.size === existing.size
      && original.hash === existing.hash && original.size === existing.size) {
      return { path: destination, ...existing, reused: true };
    }
    throw new HistorySecurityError("history-collision");
  }
  if (fs.existsSync(receiptPath)) throw new HistorySecurityError("history-collision");

  const temp = path.join(parent, `.${path.basename(destination)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  const sourceFd = fs.openSync(source.sourcePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  let targetFd: number | null = null;
  const digest = crypto.createHash("sha256");
  let total = 0;
  try {
    const opened = fs.fstatSync(sourceFd);
    if (opened.dev !== source.device || opened.ino !== source.inode || opened.size !== source.size) throw new HistorySecurityError("unsafe-source");
    targetFd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const read = fs.readSync(sourceFd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      total += read;
      if (total > maxBytes) throw new HistorySecurityError("history-too-large");
      digest.update(buffer.subarray(0, read));
      let written = 0;
      while (written < read) written += fs.writeSync(targetFd, buffer, written, read - written);
    }
    if (total !== source.size) throw new HistorySecurityError("history-integrity");
    const finished = fs.fstatSync(sourceFd);
    if (!sameIdentity(finished, source)) throw new HistorySecurityError("history-integrity");
    fs.fchmodSync(targetFd, 0o600);
    fs.fsyncSync(targetFd);
    fs.closeSync(targetFd);
    targetFd = null;
    const rootReal = fs.realpathSync(input.targetRoot);
    if (!contained(rootReal, fs.realpathSync(parent))) throw new HistorySecurityError("unsafe-root");
    try { fs.linkSync(temp, destination); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new HistorySecurityError("history-collision");
      throw error;
    }
    fs.rmSync(temp, { force: true });
    const hash = digest.digest("hex");
    const receiptTemp = `${receiptPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(receiptTemp, JSON.stringify({ operationId: input.operationId, hash, size: total }) + "\n", { mode: 0o600, flag: "wx" });
      fs.renameSync(receiptTemp, receiptPath);
    } finally { fs.rmSync(receiptTemp, { force: true }); }
    const dir = fs.openSync(parent, "r");
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    return { path: destination, hash, size: total, reused: false };
  } finally {
    fs.closeSync(sourceFd);
    if (targetFd !== null) fs.closeSync(targetFd);
    fs.rmSync(temp, { force: true });
  }
}

/** Public failures remain stable and exclude paths, CLI output, and secrets. */
export function sanitizeProviderError(error: unknown): { code: string; message: string } {
  if (error instanceof HistorySecurityError) {
    const messages: Record<HistorySecurityCode, string> = {
      "unsafe-root": "account history root failed safety checks",
      "unsafe-source": "source history failed safety checks",
      "history-too-large": "source history exceeds the migration size limit",
      "history-collision": "target history already contains a conflicting successor",
      "history-integrity": "successor history failed integrity verification",
    };
    return { code: error.code, message: messages[error.code] };
  }
  return { code: "provider-failed", message: "successor provider failed a recoverable preflight" };
}
