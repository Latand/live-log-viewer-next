import { createHash } from "node:crypto";
import fs from "node:fs";

import { hardenedRedact } from "@/lib/view/compactText";

import {
  normalizeSessionLine,
  type NormalizedSessionLine,
  type SessionRecord,
  type SessionRecordKind,
} from "./reader";

const CHUNK_BYTES = 256 * 1024;
const MAX_SCAN_BYTES = 16 * 1024 * 1024;
const MAX_LINE_BYTES = 16 * 1024 * 1024;
const MAX_RECENT_MESSAGES = 8;

type SessionEngine = "claude" | "codex";
type CursorRepresentation = "e" | "r";

interface CursorRecentMessage {
  h: string;
  t: number | null;
  e: CursorRepresentation;
}

export interface MessagesPageCursor {
  o: number;
  p: number;
  r: CursorRecentMessage[];
}

interface EncodedMessagesCursor extends MessagesPageCursor {
  v: 1;
  s: string;
}

export interface MessagesPageSource {
  descriptor: number;
  size: number;
  engine: SessionEngine;
}

export interface MessagesPageQuery {
  kinds: ReadonlySet<SessionRecordKind>;
  roles: ReadonlySet<SessionRecord["role"]>;
  since?: string;
  limit: number;
  maxChars: number;
  cursor?: MessagesPageCursor | null;
}

export interface ConversationMessage extends SessionRecord {
  seq: number;
  part?: number;
  truncated?: true;
}

export interface MessagesPage {
  records: ConversationMessage[];
  cursor: MessagesPageCursor | null;
  hasMore: boolean;
  lastRecordAt: string | null;
  scanned: { bytes: number; lines: number; capped: boolean };
}

export class InvalidMessagesCursorError extends Error {
  constructor() {
    super("conversation messages cursor is invalid for this transcript and filter scope");
    this.name = "InvalidMessagesCursorError";
  }
}

export class StaleMessagesCursorError extends Error {
  constructor() {
    super("conversation messages cursor points beyond the current transcript");
    this.name = "StaleMessagesCursorError";
  }
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function timestampMillis(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizedMessageHash(record: SessionRecord): string {
  return createHash("sha256")
    .update(record.role)
    .update("\0")
    .update(record.text.trim().replace(/\s+/gu, " "))
    .digest("hex")
    .slice(0, 16);
}

function representationCode(value: NormalizedSessionLine["representation"]): CursorRepresentation | null {
  return value === "event" ? "e" : value === "response" ? "r" : null;
}

function cursorRecent(value: unknown): CursorRecentMessage[] | null {
  if (!Array.isArray(value) || value.length > MAX_RECENT_MESSAGES) return null;
  const recent: CursorRecentMessage[] = [];
  for (const candidate of value) {
    const row = objectRecord(candidate);
    if (!row
      || typeof row.h !== "string"
      || !/^[0-9a-f]{16}$/u.test(row.h)
      || (row.t !== null && (typeof row.t !== "number" || !Number.isFinite(row.t)))
      || (row.e !== "e" && row.e !== "r")) return null;
    recent.push({ h: row.h, t: row.t as number | null, e: row.e });
  }
  return recent;
}

export function messagesCursorScope(
  transcriptPath: string,
  kinds: ReadonlySet<SessionRecordKind>,
  roles: ReadonlySet<SessionRecord["role"]>,
  since?: string,
): string {
  return createHash("sha256")
    .update(JSON.stringify([
      transcriptPath,
      [...kinds].sort(),
      [...roles].sort(),
      since ?? "",
    ]))
    .digest("hex")
    .slice(0, 16);
}

export function encodeMessagesCursor(cursor: MessagesPageCursor, scope: string): string {
  const payload: EncodedMessagesCursor = { v: 1, ...cursor, s: scope };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeMessagesCursor(token: string, scope: string): MessagesPageCursor {
  if (!token || token.length > 8_192) throw new InvalidMessagesCursorError();
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
  } catch {
    throw new InvalidMessagesCursorError();
  }
  const row = objectRecord(value);
  const recent = cursorRecent(row?.r);
  if (!row
    || row.v !== 1
    || row.s !== scope
    || !Number.isSafeInteger(row.o)
    || (row.o as number) < 0
    || !Number.isSafeInteger(row.p)
    || (row.p as number) < 0
    || recent === null) throw new InvalidMessagesCursorError();
  return { o: row.o as number, p: row.p as number, r: recent };
}

function parsedLine(line: Buffer, engine: SessionEngine): NormalizedSessionLine[] {
  let value: unknown;
  try {
    value = JSON.parse(line.toString("utf8"));
  } catch {
    return [];
  }
  const row = objectRecord(value);
  return row ? normalizeSessionLine(engine, row) : [];
}

function newestRecordTimestamp(
  source: MessagesPageSource,
  charge: (bytes: number) => void,
): { value: string | null; lines: number } {
  const start = Math.max(0, source.size - CHUNK_BYTES);
  const buffer = Buffer.allocUnsafe(source.size - start);
  const read = fs.readSync(source.descriptor, buffer, 0, buffer.length, start);
  charge(read);
  const data = buffer.subarray(0, read);
  const firstNewline = start === 0 ? -1 : data.indexOf(0x0a);
  if (start > 0 && firstNewline < 0) return { value: null, lines: 0 };
  const firstComplete = firstNewline + 1;
  let lineEnd = data.length;
  let lines = 0;
  while (lineEnd > firstComplete) {
    if (data[lineEnd - 1] === 0x0a) lineEnd -= 1;
    const newline = data.lastIndexOf(0x0a, lineEnd - 1);
    const lineStart = Math.max(firstComplete, newline + 1);
    const line = data.subarray(lineStart, lineEnd);
    if (line.length) {
      lines += 1;
      const normalized = parsedLine(line, source.engine);
      const timestamp = normalized.find((candidate) => candidate.record.ts)?.record.ts;
      if (timestamp) return { value: timestamp, lines };
    }
    lineEnd = lineStart;
  }
  return { value: null, lines };
}

function boundedRecord(
  normalized: NormalizedSessionLine,
  seq: number,
  part: number,
  parts: number,
  maxChars: number,
): ConversationMessage {
  const redacted = hardenedRedact(normalized.record.text);
  const truncated = redacted.length > maxChars;
  return {
    seq,
    ...(parts > 1 ? { part } : {}),
    kind: normalized.record.kind,
    role: normalized.record.role,
    ts: normalized.record.ts,
    text: truncated ? redacted.slice(0, maxChars) : redacted,
    ...(truncated ? { truncated: true as const } : {}),
    ...(normalized.record.name ? { name: normalized.record.name } : {}),
    ...(normalized.record.phase ? { phase: normalized.record.phase } : {}),
  };
}

/**
 * Read one newest-first page from a descriptor that the caller has already
 * pinned and root-validated. The reader walks fixed tail windows and stops at
 * the page or scan ceiling; total work is independent of total file size.
 */
export function readMessagesPage(source: MessagesPageSource, query: MessagesPageQuery): MessagesPage {
  const limit = Math.max(1, Math.min(200, Math.floor(query.limit) || 20));
  const maxChars = Math.max(1, Math.min(16_000, Math.floor(query.maxChars) || 4_000));
  const since = query.since ? Date.parse(query.since) : null;
  const cursor = query.cursor ?? null;
  if (cursor && cursor.o > source.size) throw new StaleMessagesCursorError();

  const records: ConversationMessage[] = [];
  const recent = cursor ? [...cursor.r] : [];
  let bytes = 0;
  let lines = 0;
  let capped = false;
  let hasMore = false;
  let next: MessagesPageCursor | null = null;
  const charge = (count: number): void => { bytes += count; };
  const latest = newestRecordTimestamp(source, charge);
  lines += latest.lines;

  const isTwin = (candidate: NormalizedSessionLine): boolean => {
    const representation = representationCode(candidate.representation);
    if (candidate.record.kind !== "message" || !representation) return false;
    const hash = normalizedMessageHash(candidate.record);
    const timestamp = timestampMillis(candidate.record.ts);
    const twin = recent.some((prior) => prior.h === hash
      && prior.e !== representation
      && (timestamp !== null && prior.t !== null ? Math.abs(prior.t - timestamp) <= 2_000 : true));
    recent.unshift({ h: hash, t: timestamp, e: representation });
    if (recent.length > MAX_RECENT_MESSAGES) recent.pop();
    return twin;
  };

  const consumeLine = (line: Buffer, offset: number, partLimit: number): "continue" | "full" | "since" => {
    lines += 1;
    const normalized = parsedLine(line, source.engine).filter((candidate) => candidate.record.text.trim());
    for (let part = Math.min(partLimit, normalized.length) - 1; part >= 0; part -= 1) {
      const candidate = normalized[part]!;
      const timestamp = timestampMillis(candidate.record.ts);
      if (since !== null && timestamp !== null && timestamp < since) {
        hasMore = false;
        next = null;
        return "since";
      }
      if (records.length >= limit) {
        hasMore = true;
        next = { o: offset, p: part + 1, r: [...recent] };
        return "full";
      }
      if (isTwin(candidate)) continue;
      if (!query.kinds.has(candidate.record.kind) || !query.roles.has(candidate.record.role)) continue;
      records.push(boundedRecord(candidate, offset, part, normalized.length, maxChars));
    }
    if (records.length >= limit) {
      hasMore = offset > 0;
      next = hasMore ? { o: offset, p: 0, r: [...recent] } : null;
      return "full";
    }
    return "continue";
  };

  let end = cursor?.o ?? source.size;
  if (cursor && cursor.p > 0) {
    let probe = Buffer.alloc(0);
    while (probe.indexOf(0x0a) === -1
      && cursor.o + probe.length < source.size
      && probe.length < MAX_LINE_BYTES) {
      const length = Math.min(CHUNK_BYTES, source.size - cursor.o - probe.length);
      const chunk = Buffer.allocUnsafe(length);
      const read = fs.readSync(source.descriptor, chunk, 0, length, cursor.o + probe.length);
      charge(read);
      if (read === 0) break;
      probe = Buffer.concat([probe, chunk.subarray(0, read)]);
    }
    const newline = probe.indexOf(0x0a);
    const outcome = consumeLine(probe.subarray(0, newline < 0 ? probe.length : newline), cursor.o, cursor.p);
    if (outcome !== "continue") {
      return { records, cursor: next, hasMore, lastRecordAt: latest.value, scanned: { bytes, lines, capped } };
    }
  }

  let carry = Buffer.alloc(0);
  let stopped = false;
  while (end > 0 && !stopped) {
    if (bytes >= MAX_SCAN_BYTES) {
      capped = true;
      hasMore = true;
      const resumeEnd = Math.min(source.size, end + carry.length + (carry.length ? 1 : 0));
      next = { o: resumeEnd, p: 0, r: [...recent] };
      break;
    }
    const allowance = Math.max(1, MAX_SCAN_BYTES - bytes);
    const start = Math.max(0, end - Math.min(CHUNK_BYTES, allowance));
    const buffer = Buffer.allocUnsafe(end - start);
    const read = fs.readSync(source.descriptor, buffer, 0, buffer.length, start);
    charge(read);
    if (read === 0) break;
    const window = carry.length
      ? Buffer.concat([buffer.subarray(0, read), carry])
      : buffer.subarray(0, read);
    const firstNewline = start === 0 ? -1 : window.indexOf(0x0a);
    if (start > 0 && firstNewline < 0) {
      carry = window.length > MAX_LINE_BYTES ? Buffer.alloc(0) : Buffer.from(window);
      end = start;
      continue;
    }
    const lineBase = firstNewline < 0 ? 0 : firstNewline + 1;
    const nextCarry = firstNewline < 0 ? Buffer.alloc(0) : Buffer.from(window.subarray(0, firstNewline));
    let lineEnd = window.length;
    while (lineEnd > lineBase) {
      if (window[lineEnd - 1] === 0x0a) lineEnd -= 1;
      const newline = window.lastIndexOf(0x0a, lineEnd - 1);
      const lineStart = Math.max(lineBase, newline + 1);
      const line = window.subarray(lineStart, lineEnd);
      if (line.length) {
        const outcome = consumeLine(line, start + lineStart, Number.POSITIVE_INFINITY);
        if (outcome !== "continue") {
          stopped = true;
          break;
        }
      }
      lineEnd = lineStart;
    }
    carry = nextCarry;
    end = start;
  }

  if (!stopped && end === 0 && !capped) {
    hasMore = false;
    next = null;
  }
  return {
    records,
    cursor: next,
    hasMore,
    lastRecordAt: latest.value,
    scanned: { bytes, lines, capped },
  };
}
