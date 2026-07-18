import fs from "node:fs";

import { globalCache } from "./caches";

interface NeedleEntry {
  hits: Record<string, boolean>;
  scanned: Record<string, number>;
}

const needleCache = globalCache<NeedleEntry>("needle");
const tailNeedleCache = globalCache<{ size: number; mtimeMs: number; hit: boolean }>("needle-tail-v1");

const INITIAL_TAIL_BYTES = 128 * 1024;
const MAX_TAIL_BYTES = 1024 * 1024;

function readWindow(fd: number, start: number, length: number): { bytes: Buffer; complete: boolean } {
  const bytes = Buffer.allocUnsafe(length);
  let filled = 0;
  while (filled < length) {
    const read = fs.readSync(fd, bytes, filled, length - filled, start + filled);
    if (read === 0) break;
    filled += read;
  }
  return {
    bytes: filled === bytes.length ? bytes : Buffer.from(bytes.subarray(0, filled)),
    complete: filled === length,
  };
}

/**
 * Search the immutable end of an append-only transcript through two bounded
 * windows. Compaction markers reference the predecessor's tail UUID, so the
 * first 128 KiB tail covers the common case and the preceding bytes extend
 * the same observation to a 1 MiB ceiling.
 */
export function fileTailHasNeedle(needle: string, pathname: string): boolean {
  const cacheKey = `${needle}\u0000${pathname}`;
  let stat: fs.Stats;
  try {
    stat = fs.statSync(pathname);
  } catch {
    return false;
  }
  const cached = tailNeedleCache.get(cacheKey);
  if (cached?.hit) return true;
  if (cached?.size === stat.size && cached.mtimeMs === stat.mtimeMs) return false;

  const bytes = Buffer.from(needle);
  const initialLength = Math.min(stat.size, INITIAL_TAIL_BYTES);
  let fd: number | null = null;
  try {
    fd = fs.openSync(pathname, "r");
    const initial = readWindow(fd, stat.size - initialLength, initialLength);
    if (initial.bytes.includes(bytes)) {
      tailNeedleCache.set(cacheKey, { size: stat.size, mtimeMs: stat.mtimeMs, hit: true });
      return true;
    }

    let complete = initial.complete;
    let hit = false;
    const totalLength = Math.min(stat.size, MAX_TAIL_BYTES);
    const prefixLength = totalLength - initialLength;
    if (prefixLength > 0) {
      const prefix = readWindow(fd, stat.size - totalLength, prefixLength);
      complete &&= prefix.complete;
      hit = Buffer.concat([prefix.bytes, initial.bytes]).includes(bytes);
    }
    if (hit || complete) {
      tailNeedleCache.set(cacheKey, { size: stat.size, mtimeMs: stat.mtimeMs, hit });
    }
    return hit;
  } catch {
    return false;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

/**
 * Incremental per-file needle scan: remembers how many bytes of each file were
 * already searched and only scans the appended suffix on later calls. A hit is
 * cached per (needle, file) pair, so different candidate files of the same
 * needle can be checked independently.
 */
export function fileHasNeedle(needle: string, pathname: string): boolean {
  let ent = needleCache.get(needle);
  if (!ent || !ent.hits) {
    ent = { hits: {}, scanned: ent?.scanned ?? {} };
    needleCache.set(needle, ent);
  }
  if (ent.hits[pathname]) return true;
  const nb = Buffer.from(needle);
  const pad = Math.max(0, nb.length - 1);
  let size: number;
  try {
    size = fs.statSync(pathname).size;
  } catch {
    return false;
  }
  const done = ent.scanned[pathname] ?? 0;
  if (size <= done) return false;
  try {
    const fd = fs.openSync(pathname, "r");
    try {
      const start = Math.max(0, done - pad);
      let pos = start;
      let carry = Buffer.alloc(0);
      let hit = false;
      while (pos < size) {
        const len = Math.min(1 << 20, size - pos);
        const chunk = Buffer.alloc(len);
        const read = fs.readSync(fd, chunk, 0, len, pos);
        if (!read) break;
        const hay = Buffer.concat([carry, chunk.subarray(0, read)]);
        if (hay.includes(nb)) {
          hit = true;
          break;
        }
        carry = pad ? chunk.subarray(Math.max(0, read - pad), read) : Buffer.alloc(0);
        pos += read;
      }
      ent.scanned[pathname] = size;
      if (hit) ent.hits[pathname] = true;
      return hit;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

export function findNeedle(needle: string, paths: (string | null | undefined)[]): string | null {
  for (const pathname of paths) {
    if (pathname && fileHasNeedle(needle, pathname)) return pathname;
  }
  return null;
}
