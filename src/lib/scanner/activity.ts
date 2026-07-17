import fs from "node:fs";

import type { TurnState } from "@/lib/accounts/migration/contracts";
import type { Activity, RootKey } from "../types";
import { globalCache } from "./caches";
import { readHead } from "./head";
import { outputHolders } from "./process";
import { turnStateFromRecords as structuredTurnStateFromRecords } from "@/lib/accounts/migration/turnState";

type CachedTurnEvidence = {
  size: number;
  mtimeMs: number;
  codex: boolean;
  authoritative: boolean;
  turn: TurnState;
  composerReleased: boolean;
};

globalCache<unknown>("turn").clear();
const turnEvidenceCache = globalCache<CachedTurnEvidence>("turn-evidence-v1");
const TURN_EVIDENCE_CACHE_CAP = 4_096;

/** Shared tail read+parse, keyed by path and file identity. Within one
    /api/files scan the per-entry derivations (turn state, model, context, plan,
    effort, questions) all ask for the same tail, so the first pays
    the 128 KB read and JSON parse and the rest reuse it. Replaced when the file
    grows. Unlike its siblings this cache holds whole parsed record arrays, so
    it is bounded: only actively-growing transcripts benefit from it anyway
    (idle files resolve through the small derived caches and never come back). */
type CachedTailRecords = {
  size: number;
  mtimeMs: number;
  nbytes: number;
  records: Record<string, unknown>[];
};
const tailCache = globalCache<CachedTailRecords>("tail-v2");
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

export interface TailRecordsResult {
  records: Record<string, unknown>[];
  complete: boolean;
}

function storeTurnEvidence(pathname: string, evidence: CachedTurnEvidence): void {
  const key = `${evidence.authoritative ? "authoritative" : "activity"}:${pathname}`;
  turnEvidenceCache.delete(key);
  while (turnEvidenceCache.size >= TURN_EVIDENCE_CACHE_CAP) {
    const oldest = turnEvidenceCache.keys().next().value;
    if (oldest === undefined) break;
    turnEvidenceCache.delete(oldest);
  }
  turnEvidenceCache.set(key, evidence);
}

export interface TranscriptTurnResult {
  turn: TurnState;
  complete: boolean;
  composerReleased: boolean;
}

/** Complete, identity-bound turn evidence shared by scanner and migration
    consumers. The compact cache retains production-sized inventories without
    retaining every parsed tail record. */
export function transcriptTurnResult(
  pathname: string,
  size: number,
  mtimeMs: number,
  codex: boolean,
  authoritative = true,
): TranscriptTurnResult {
  const key = `${authoritative ? "authoritative" : "activity"}:${pathname}`;
  const cached = turnEvidenceCache.get(key);
  if (cached && cached.size === size && cached.mtimeMs === mtimeMs && cached.codex === codex) {
    storeTurnEvidence(pathname, cached);
    return { turn: { ...cached.turn }, complete: true, composerReleased: cached.composerReleased };
  }
  const tail = tailRecordsResult(pathname, size, mtimeMs);
  const turn = structuredTurnStateFromRecords(tail.records, codex, authoritative);
  if (tail.complete) {
    storeTurnEvidence(pathname, { size, mtimeMs, codex, authoritative, turn, composerReleased: false });
    const companionAuthoritative = !authoritative;
    const companionKey = `${companionAuthoritative ? "authoritative" : "activity"}:${pathname}`;
    const cachedCompanion = turnEvidenceCache.get(companionKey);
    const companionComposerReleased = cachedCompanion?.size === size
      && cachedCompanion.mtimeMs === mtimeMs
      && cachedCompanion.codex === codex
      && cachedCompanion.composerReleased;
    const companionTurn = structuredTurnStateFromRecords(tail.records, codex, companionAuthoritative);
    storeTurnEvidence(pathname, {
      size,
      mtimeMs,
      codex,
      authoritative: companionAuthoritative,
      turn: companionTurn,
      composerReleased: companionComposerReleased,
    });
  }
  return { turn, complete: tail.complete, composerReleased: false };
}

export function primeTranscriptTurnEvidence(
  pathname: string,
  size: number,
  mtimeMs: number,
  codex: boolean,
  turn: TurnState,
  options: { authoritative?: boolean; composerReleased?: boolean } = {},
): void {
  const authoritative = options.authoritative ?? true;
  const composerReleased = options.composerReleased ?? false;
  storeTurnEvidence(pathname, { size, mtimeMs, codex, authoritative, turn: { ...turn }, composerReleased });
}

export function recordTranscriptComposerRelease(
  pathname: string,
  size: number,
  mtimeMs: number,
  codex: boolean,
): void {
  const key = `authoritative:${pathname}`;
  const cached = turnEvidenceCache.get(key);
  if (!cached || cached.size !== size || cached.mtimeMs !== mtimeMs || cached.codex !== codex) return;
  storeTurnEvidence(pathname, { ...cached, composerReleased: true });
}

export function tailRecordsResult(pathname: string, size: number, mtimeMs: number, nbytes = 131_072): TailRecordsResult {
  const cached = tailCache.get(pathname);
  if (cached && cached.size === size && cached.mtimeMs === mtimeMs && cached.nbytes === nbytes) {
    return { records: cached.records.slice(), complete: true };
  }
  const result = readTail(pathname, size, nbytes);
  if (!result.complete) return result;
  if (tailCache.size >= TAIL_CACHE_CAP && !tailCache.has(pathname)) {
    const oldest = tailCache.keys().next().value;
    if (oldest !== undefined) tailCache.delete(oldest);
  }
  tailCache.set(pathname, { size, mtimeMs, nbytes, records: result.records });
  /* Hand out a fresh copy every call: consumers reverse() the result in place,
     which must never reorder the shared cached array under the next consumer. */
  return { records: result.records.slice(), complete: true };
}

export function tailRecords(pathname: string, size: number, mtimeMs: number, nbytes = 131_072): Record<string, unknown>[] {
  return tailRecordsResult(pathname, size, mtimeMs, nbytes).records;
}

function readTail(pathname: string, size: number, nbytes: number): TailRecordsResult {
  let seek = 0;
  let data = "";
  let complete = false;
  try {
    const fd = fs.openSync(pathname, "r");
    try {
      seek = Math.max(0, size - nbytes);
      const buf = Buffer.alloc(Math.max(0, size - seek));
      let read = 0;
      while (read < buf.length) {
        const chunk = fs.readSync(fd, buf, read, buf.length - read, seek + read);
        if (chunk === 0) break;
        read += chunk;
      }
      complete = read === buf.length;
      data = buf.toString("utf8", 0, read);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { records: [], complete: false };
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
  return { records: out, complete };
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
  complete: boolean;
}

export function activityVerdict(
  root: RootKey,
  pathname: string,
  mtime: number,
  size: number,
): ActivityVerdict {
  const age = Date.now() / 1000 - mtime;
  if (root === "claude-tasks" && pathname.endsWith(".output")) {
    if (outputHolders().has(pathname)) return { state: "live", reason: "output_held", complete: true };
    return { state: age < 900 ? "recent" : "idle", reason: "output_released", complete: true };
  }
  let complete = true;
  if (pathname.endsWith(".jsonl")) {
    const mtimeMs = mtime * 1000;
    const turn = transcriptTurnResult(pathname, size, mtimeMs, root.startsWith("codex"), false);
    const state = turn.turn.state === "terminal" ? "done" : turn.turn.state === "busy" ? "busy" : null;
    complete = turn.complete;
    if (state === "busy") {
      return age < 180
        ? { state: "live", reason: "jsonl_turn_open", complete }
        : { state: "stalled", reason: "jsonl_turn_stalled", complete };
    }
    if (state === "done") {
      return { state: age < 900 ? "recent" : "idle", reason: "jsonl_turn_completed", complete };
    }
  }
  if (age < 20) return { state: "live", reason: "mtime_fresh", complete };
  if (age < 900) return { state: "recent", reason: "mtime_recent", complete };
  return { state: "idle", reason: "mtime_old", complete };
}

export function activity(
  root: RootKey,
  pathname: string,
  mtime: number,
  size: number,
): Activity {
  return activityVerdict(root, pathname, mtime, size).state;
}
