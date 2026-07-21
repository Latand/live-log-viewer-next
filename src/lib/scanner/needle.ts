import fs from "node:fs";

import { globalCache } from "./caches";

interface NeedleEntry {
  hits: Record<string, boolean>;
  scanned: Record<string, number>;
  sizes: Record<string, number>;
}

const needleCache = globalCache<NeedleEntry>("needle");
const tailNeedleCache = globalCache<{ size: number; mtimeMs: number; hit: boolean }>("needle-tail-v1");
type TailUuidIndex = {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  uuids: Set<string>;
  complete: boolean;
  boundary: Buffer;
};
const tailUuidIndexCache = globalCache<TailUuidIndex>("needle-tail-uuid-v1");

const INITIAL_TAIL_BYTES = 128 * 1024;
const MAX_TAIL_BYTES = 1024 * 1024;
const UUID_NEEDLE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUIDS_IN_TEXT = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

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
 * Index every UUID in a transcript tail with one positional read per observed
 * file generation. Compaction lineage probes ask the same growing transcript
 * about many different UUIDs; sharing this index prevents one 1 MiB read for
 * every successor. Proven predecessor links are persisted by the caller, so a
 * changed generation can discard its old UUID set and keep memory bounded.
 */
function addUuids(uuids: Set<string>, bytes: Buffer): void {
  for (const uuid of bytes.toString("utf8").match(UUIDS_IN_TEXT) ?? []) uuids.add(uuid.toLowerCase());
}

function fileTailHasUuid(needle: string, pathname: string, stat: fs.Stats): boolean {
  const normalizedNeedle = needle.toLowerCase();
  const cached = tailUuidIndexCache.get(pathname);
  if (cached?.dev === stat.dev && cached.ino === stat.ino && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
    if (cached.uuids.has(normalizedNeedle)) return true;
    if (cached.complete) return false;

    const totalLength = Math.min(stat.size, MAX_TAIL_BYTES);
    const prefixLength = totalLength - Math.min(stat.size, INITIAL_TAIL_BYTES);
    let fd: number | null = null;
    try {
      fd = fs.openSync(pathname, "r");
      const prefix = readWindow(fd, stat.size - totalLength, prefixLength);
      addUuids(cached.uuids, Buffer.concat([prefix.bytes, cached.boundary]));
      if (prefix.complete) {
        cached.complete = true;
        cached.boundary = Buffer.alloc(0);
      }
      return cached.uuids.has(normalizedNeedle);
    } catch {
      return false;
    } finally {
      if (fd !== null) fs.closeSync(fd);
    }
  }

  const uuids = new Set<string>();

  const initialLength = Math.min(stat.size, INITIAL_TAIL_BYTES);
  let fd: number | null = null;
  try {
    fd = fs.openSync(pathname, "r");
    const initial = readWindow(fd, stat.size - initialLength, initialLength);
    addUuids(uuids, initial.bytes);
    const totalLength = Math.min(stat.size, MAX_TAIL_BYTES);
    const prefixLength = totalLength - initialLength;
    const entry: TailUuidIndex = {
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      uuids,
      complete: initial.complete && prefixLength === 0,
      boundary: Buffer.from(initial.bytes.subarray(0, Math.min(initial.bytes.length, 35))),
    };
    tailUuidIndexCache.set(pathname, entry);
    if (uuids.has(normalizedNeedle) || entry.complete) return uuids.has(normalizedNeedle);

    const prefix = readWindow(fd, stat.size - totalLength, prefixLength);
    addUuids(uuids, Buffer.concat([prefix.bytes, entry.boundary]));
    if (initial.complete && prefix.complete) {
      entry.complete = true;
      entry.boundary = Buffer.alloc(0);
    }
    return uuids.has(normalizedNeedle);
  } catch {
    return false;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

/**
 * Search the immutable end of an append-only transcript through two bounded
 * windows. Compaction markers reference the predecessor's tail UUID, so the
 * first 128 KiB tail covers the common case and the preceding bytes extend
 * the same observation to a 1 MiB ceiling.
 */
export function fileTailHasNeedle(needle: string, pathname: string): boolean {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(pathname);
  } catch {
    return false;
  }
  if (UUID_NEEDLE.test(needle)) return fileTailHasUuid(needle, pathname, stat);

  const cacheKey = `${needle}\u0000${pathname}`;
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

/** Shared hard byte allowance for one scan generation. Exhaustion leaves the
    observation unresolved; the per-file scanned offsets resume the search in a
    later generation instead of restarting it. */
export interface NeedleScanBudget {
  remaining: number;
}

/** A single candidate may consume at most this much of a generation budget in
    one pass, so one multi-gigabyte transcript cannot starve its siblings. */
const NEEDLE_CANDIDATE_PASS_BYTES = 1024 * 1024;

/**
 * Incremental per-file needle scan: remembers how many bytes of each file were
 * already searched and only scans the appended suffix on later calls. A hit is
 * cached per (needle, file) pair, so different candidate files of the same
 * needle can be checked independently. A budget bounds the fresh bytes one
 * call may read; an exhausted budget returns false ("not proven yet") and the
 * recorded offset makes the next generation continue where this one stopped.
 */
export function fileHasNeedle(needle: string, pathname: string, budget?: NeedleScanBudget): boolean {
  let ent = needleCache.get(needle);
  if (!ent || !ent.hits || !ent.sizes) {
    ent = { hits: ent?.hits ?? {}, scanned: ent?.scanned ?? {}, sizes: ent?.sizes ?? {} };
    needleCache.set(needle, ent);
  }
  const nb = Buffer.from(needle);
  const pad = Math.max(0, nb.length - 1);
  let size: number;
  try {
    size = fs.statSync(pathname).size;
  } catch {
    return false;
  }
  let done = ent.scanned[pathname] ?? 0;
  const observedSize = ent.sizes[pathname];
  // Any shrink identifies a replacement generation, including one whose new
  // end remains above the incremental checkpoint.
  if (observedSize !== undefined && size < observedSize) {
    done = 0;
    delete ent.hits[pathname];
  }
  ent.sizes[pathname] = size;
  if (ent.hits[pathname]) return true;
  if (size <= done) return false;
  const allowance = budget === undefined
    ? Number.POSITIVE_INFINITY
    : Math.min(Math.max(0, budget.remaining), NEEDLE_CANDIDATE_PASS_BYTES);
  if (allowance <= 0) return false;
  try {
    const fd = fs.openSync(pathname, "r");
    try {
      const start = Math.max(0, done - pad);
      let pos = start;
      let carry = Buffer.alloc(0);
      let hit = false;
      let consumed = 0;
      while (pos < size && consumed < allowance) {
        const len = Math.min(1 << 20, Math.ceil(allowance - consumed), size - pos);
        const chunk = Buffer.alloc(len);
        const read = fs.readSync(fd, chunk, 0, len, pos);
        if (!read) break;
        consumed += read;
        const hay = Buffer.concat([carry, chunk.subarray(0, read)]);
        if (hay.includes(nb)) {
          hit = true;
          break;
        }
        carry = pad ? chunk.subarray(Math.max(0, read - pad), read) : Buffer.alloc(0);
        pos += read;
      }
      if (budget !== undefined && Number.isFinite(consumed)) budget.remaining -= consumed;
      ent.scanned[pathname] = hit || pos >= size ? size : pos;
      if (hit) ent.hits[pathname] = true;
      return hit;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

export function findNeedle(needle: string, paths: (string | null | undefined)[], budget?: NeedleScanBudget): string | null {
  for (const pathname of paths) {
    if (pathname && fileHasNeedle(needle, pathname, budget)) return pathname;
  }
  return null;
}
