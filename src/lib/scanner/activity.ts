import fs from "node:fs";

import type { Activity, RootKey } from "../types";
import { globalCache } from "./caches";
import { readHead } from "./head";
import { outputHolders } from "./process";
import { turnStateFromRecords as structuredTurnStateFromRecords } from "@/lib/accounts/migration/turnState";

const turnCache = globalCache<[number, string | null]>("turn");

/** Shared tail read+parse, keyed by path → [size, nbytes, records]. Within one
    /api/files scan the per-entry derivations (turn state, model, context, plan,
    effort, questions) all ask for the same (path, size) tail, so the first pays
    the 128 KB read and JSON parse and the rest reuse it. Replaced when the file
    grows. Unlike its siblings this cache holds whole parsed record arrays, so
    it is bounded: only actively-growing transcripts benefit from it anyway
    (idle files resolve through the small derived caches and never come back). */
const tailCache = globalCache<[number, number | null, number, Record<string, unknown>[]]>("tail");
const TAIL_CACHE_CAP = 64;
type CachedHeadRecords = {
  size: number;
  mtimeMs: number;
  nbytes: number;
  recordLimit: number;
  sourceBytes: number;
  records: Record<string, unknown>[];
};
const headCache = globalCache<CachedHeadRecords>("head-records-v2");
const HEAD_CACHE_CAP = 64;
const HEAD_CACHE_BYTE_CAP = 16 * 1024 * 1024;
export const HEAD_RECORD_BYTES = 4 * 1024 * 1024;
const HEAD_RECORD_LIMIT = 41;

/** Shared bounded head read for launch metadata that does not survive in the
    transcript tail. Large active JSONL files append frequently, so reading the
    complete file before selecting its first rows creates work proportional to
    conversation history on every poll. Model and effort projections share this
    size-keyed prefix instead. */
export interface HeadRecordsResult {
  records: Record<string, unknown>[];
  complete: boolean;
}

export function headRecordsResult(
  pathname: string,
  size: number,
  mtimeMs: number,
  nbytes = HEAD_RECORD_BYTES,
  recordLimit = HEAD_RECORD_LIMIT,
): HeadRecordsResult {
  const cached = headCache.get(pathname);
  if (cached && cached.size === size && cached.mtimeMs === mtimeMs && cached.nbytes === nbytes && cached.recordLimit === recordLimit) {
    return { records: cached.records.slice(), complete: true };
  }
  const head = readHead(pathname, size, mtimeMs, { maxBytes: nbytes, lineLimit: recordLimit });
  if (!head.complete || !head.value) return { records: [], complete: false };
  const { text: data, read, bytes } = head.value;

  let lines = data.split("\n");
  if (read < size && !data.endsWith("\n")) lines = lines.slice(0, -1);
  const records: Record<string, unknown>[] = [];
  for (const line of lines.slice(0, recordLimit)) {
    const text = line.trim();
    if (!text) continue;
    try {
      const value = JSON.parse(text);
      if (value && typeof value === "object" && !Array.isArray(value)) records.push(value);
    } catch {
      // A truncated or malformed row carries no usable launch metadata.
    }
  }
  headCache.delete(pathname);
  let cachedBytes = 0;
  for (const entry of headCache.values()) cachedBytes += entry.sourceBytes;
  while (headCache.size > 0 && (headCache.size >= HEAD_CACHE_CAP || cachedBytes + bytes.length > HEAD_CACHE_BYTE_CAP)) {
    const oldest = headCache.keys().next().value;
    if (oldest === undefined) break;
    cachedBytes -= headCache.get(oldest)?.sourceBytes ?? 0;
    headCache.delete(oldest);
  }
  headCache.set(pathname, { size, mtimeMs, nbytes, recordLimit, sourceBytes: bytes.length, records });
  return { records: records.slice(), complete: true };
}

export function headRecords(
  pathname: string,
  size: number,
  mtimeMs: number,
  nbytes = HEAD_RECORD_BYTES,
  recordLimit = HEAD_RECORD_LIMIT,
): Record<string, unknown>[] {
  return headRecordsResult(pathname, size, mtimeMs, nbytes, recordLimit).records;
}

export function tailRecords(pathname: string, size: number, nbytes = 131_072, mtimeMs: number | null = null) {
  const cached = tailCache.get(pathname);
  if (cached && cached[0] === size && cached[2] === nbytes && (mtimeMs === null || cached[1] === mtimeMs)) {
    return cached[3].slice();
  }
  const records = readTail(pathname, size, nbytes);
  if (tailCache.size >= TAIL_CACHE_CAP && !tailCache.has(pathname)) {
    const oldest = tailCache.keys().next().value;
    if (oldest !== undefined) tailCache.delete(oldest);
  }
  tailCache.set(pathname, [size, mtimeMs, nbytes, records]);
  /* Hand out a fresh copy every call: consumers reverse() the result in place,
     which must never reorder the shared cached array under the next consumer. */
  return records.slice();
}

function readTail(pathname: string, size: number, nbytes: number): Record<string, unknown>[] {
  let data: string;
  let seek = 0;
  try {
    const fd = fs.openSync(pathname, "r");
    try {
      seek = Math.max(0, size - nbytes);
      const buf = Buffer.alloc(Math.max(0, size - seek));
      fs.readSync(fd, buf, 0, buf.length, seek);
      data = buf.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return [];
  }
  let lines = data.split("\n");
  if (seek > 0 && lines.length) lines = lines.slice(1);
  const out: Record<string, unknown>[] = [];
  for (const line of lines) {
    const text = line.trim();
    if (!text) continue;
    try {
      const obj = JSON.parse(text);
      if (obj && typeof obj === "object" && !Array.isArray(obj)) out.push(obj);
    } catch {
      /* skip malformed tail rows */
    }
  }
  return out;
}

function jsonlTurnState(pathname: string, size: number, codex: boolean) {
  const state = structuredTurnStateFromRecords(tailRecords(pathname, size), codex).state;
  return state === "terminal" ? "done" : state === "busy" ? "busy" : null;
}

/** Compatibility projection retained for scanner callers. */
export function turnStateFromRecords(records: Record<string, unknown>[], codex: boolean): "done" | "busy" | null {
  const state = structuredTurnStateFromRecords(records, codex).state;
  return state === "terminal" ? "done" : state === "busy" ? "busy" : null;
}

/** Activity plus the machine-readable reason behind the judgement — surfaced
    in tooltips and the event log so a wrong idle/busy call is diagnosable
    instead of a mystery (the classic failure of pane-scraping orchestrators). */
export interface ActivityVerdict {
  state: Activity;
  reason: string;
}

export function activityVerdict(
  root: RootKey,
  pathname: string,
  mtime: number,
  size: number,
): ActivityVerdict {
  const age = Date.now() / 1000 - mtime;
  if (root === "claude-tasks" && pathname.endsWith(".output")) {
    if (outputHolders().has(pathname)) return { state: "live", reason: "output_held" };
    return { state: age < 900 ? "recent" : "idle", reason: "output_released" };
  }
  if (pathname.endsWith(".jsonl")) {
    const cached = turnCache.get(pathname);
    let state: string | null;
    if (cached?.[0] === size) state = cached[1];
    else {
      state = jsonlTurnState(pathname, size, root.startsWith("codex"));
      turnCache.set(pathname, [size, state]);
    }
    if (state === "busy") {
      return age < 180 ? { state: "live", reason: "jsonl_turn_open" } : { state: "stalled", reason: "jsonl_turn_stalled" };
    }
    if (state === "done") {
      return { state: age < 900 ? "recent" : "idle", reason: "jsonl_turn_completed" };
    }
  }
  if (age < 20) return { state: "live", reason: "mtime_fresh" };
  if (age < 900) return { state: "recent", reason: "mtime_recent" };
  return { state: "idle", reason: "mtime_old" };
}

export function activity(
  root: RootKey,
  pathname: string,
  mtime: number,
  size: number,
): Activity {
  return activityVerdict(root, pathname, mtime, size).state;
}
