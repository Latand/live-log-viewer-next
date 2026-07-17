import { createHash } from "node:crypto";
import fs from "node:fs";

import { globalCache } from "./caches";

export const HEAD_READ_CHUNK_BYTES = 128 * 1024;

type CachedHead = {
  size: number;
  mtimeMs: number;
  bytes: Buffer;
  eof: boolean;
};

export interface HeadReadResult {
  value: { bytes: Buffer; text: string; read: number } | null;
  complete: boolean;
}

interface HeadReadOptions {
  maxBytes?: number;
  lineLimit?: number;
}

const headCache = globalCache<CachedHead>("scanner-head-v1");
const HEAD_CACHE_CAP = 2_048;
const HEAD_CACHE_BYTE_CAP = 32 * 1024 * 1024;

export function headFingerprint(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("base64url");
}

function newlineCount(bytes: Uint8Array): number {
  let count = 0;
  for (const byte of bytes) {
    if (byte === 0x0a) count += 1;
  }
  return count;
}

function result(bytes: Buffer, complete: boolean): HeadReadResult {
  const owned = Buffer.from(bytes);
  return {
    value: { bytes: owned, text: owned.toString("utf8"), read: owned.length },
    complete,
  };
}

function storeHead(pathname: string, value: CachedHead): void {
  headCache.delete(pathname);
  let cachedBytes = 0;
  for (const entry of headCache.values()) cachedBytes += entry.bytes.length;
  while (headCache.size > 0 && (headCache.size >= HEAD_CACHE_CAP || cachedBytes + value.bytes.length > HEAD_CACHE_BYTE_CAP)) {
    const oldest = headCache.keys().next().value;
    if (oldest === undefined) break;
    cachedBytes -= headCache.get(oldest)?.bytes.length ?? 0;
    headCache.delete(oldest);
  }
  headCache.set(pathname, value);
}

/**
 * Read a shared transcript prefix with bounded syscalls. The cache stores raw
 * bytes so callers decode only after UTF-8 sequences spanning chunks join.
 * A larger consumer extends the prefix acquired by an earlier scanner phase.
 */
export function readHead(
  pathname: string,
  size: number,
  mtimeMs: number,
  options: HeadReadOptions = {},
): HeadReadResult {
  const maxBytes = Math.max(0, options.maxBytes ?? HEAD_READ_CHUNK_BYTES);
  const target = Math.min(Math.max(0, size), maxBytes);
  const lineLimit = Math.max(0, options.lineLimit ?? 0);
  const cached = headCache.get(pathname);
  const sameIdentity = cached?.size === size && cached.mtimeMs === mtimeMs;
  const base = sameIdentity ? cached.bytes : Buffer.alloc(0);
  let lines = lineLimit > 0 ? newlineCount(base) : 0;
  if (base.length >= target || (cached?.eof && sameIdentity) || (lineLimit > 0 && lines >= lineLimit)) {
    return result(base.subarray(0, target), true);
  }

  const chunks: Buffer[] = base.length > 0 ? [base] : [];
  let offset = base.length;
  let complete = false;
  let fd: number | null = null;
  try {
    fd = fs.openSync(pathname, "r");
    while (offset < target) {
      const requested = Math.min(HEAD_READ_CHUNK_BYTES, target - offset);
      const chunk = Buffer.allocUnsafe(requested);
      let filled = 0;
      let reachedEof = false;
      while (filled < requested) {
        const read = fs.readSync(fd, chunk, filled, requested - filled, offset + filled);
        if (read === 0) {
          reachedEof = true;
          break;
        }
        if (lineLimit > 0) lines += newlineCount(chunk.subarray(filled, filled + read));
        filled += read;
        if (lineLimit > 0 && lines >= lineLimit) break;
      }
      if (filled > 0) {
        chunks.push(filled === chunk.length ? chunk : Buffer.from(chunk.subarray(0, filled)));
        offset += filled;
      }
      if (lineLimit > 0 && lines >= lineLimit) {
        complete = true;
        break;
      }
      if (reachedEof) break;
    }
    complete ||= offset >= target;
  } catch {
    return { value: null, complete: false };
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }

  const bytes = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, offset);
  if (!complete) return result(bytes, false);
  storeHead(pathname, { size, mtimeMs, bytes, eof: offset >= size });
  return result(bytes, true);
}
