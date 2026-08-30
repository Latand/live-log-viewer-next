#!/usr/bin/env bun
/**
 * Design-stage measurement for `conversation_messages` (#1311): how much a
 * newest-first, kind-filtered page costs when served (a) from the
 * transcript-search SQLite index and (b) from a reverse tail-window reader
 * over the JSONL, on the fixtures `conversation-messages-fixture.ts` writes.
 *
 *   LLV_STATE_DIR=<scratch> bun scripts/conversation-messages-bench.ts <fixtureDir>
 *
 * Refuses to run without LLV_STATE_DIR so the index build can never touch the
 * operator's live `transcript-search.sqlite`. The reverse reader here is a
 * prototype of the algorithm the design document specifies; the product
 * implementation lives under src/lib/session/ and reuses reader.ts's
 * normalizers; the reduced ones below exist only for the measurement.
 */
import fs from "node:fs";
import path from "node:path";

import { readSession, type SessionRecord } from "@/lib/session/reader";
import { indexTranscriptSources } from "@/lib/search/transcriptSearch";
import { statePath } from "@/lib/configDir";

const fixtureDir = process.argv[2];
if (!fixtureDir || !process.env.LLV_STATE_DIR) {
  console.error("usage: LLV_STATE_DIR=<scratch> bun scripts/conversation-messages-bench.ts <fixtureDir>");
  process.exit(2);
}
const MIB = 1024 * 1024;
const CHUNK_BYTES = 256 * 1024;
const MAX_SCAN_BYTES = 16 * MIB;
const MAX_LINE_BYTES = 16 * MIB;

type Engine = "claude" | "codex";
type Kind = SessionRecord["kind"];
type Role = SessionRecord["role"];
interface Query { limit: number; kinds: Set<Kind>; roles: Set<Role>; since?: number }
interface PageRecord extends SessionRecord { seq: number; part?: number; representation?: "event" | "response" }
interface RecentMessage { key: string; ts: number | null; representation: string }
interface Cursor { offset: number; part: number; recent: RecentMessage[] }
interface Page { records: PageRecord[]; cursor: Cursor | null; hasMore: boolean; bytesRead: number; linesParsed: number; scanCapped: boolean }

function rec(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function str(value: unknown): string { return typeof value === "string" ? value : ""; }
function parts(content: unknown): Record<string, unknown>[] {
  return Array.isArray(content) ? content.filter((p): p is Record<string, unknown> => Boolean(p) && typeof p === "object") : [];
}
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  return parts(content).map((p) => (p.type === "text" || p.type === "input_text" || p.type === "output_text") ? str(p.text) : "").filter(Boolean).join("\n");
}

/* Reduced per-line normalizers; the product version is reader.ts's own,
   extracted so readSession and the page reader share one mapping. */
function normalizeClaude(obj: Record<string, unknown>): Omit<PageRecord, "seq">[] {
  const ts = str(obj.timestamp) || null;
  if (obj.type === "user") {
    const content = rec(obj.message).content;
    const results = parts(content).filter((p) => p.type === "tool_result");
    if (results.length) return results.map((p) => ({ kind: "tool_result", role: "tool", ts, text: textOf(p.content) || str(p.tool_use_id) }));
    return [{ kind: "message", role: "user", ts, text: textOf(content) }];
  }
  if (obj.type === "assistant") {
    return parts(rec(obj.message).content).flatMap((p): Omit<PageRecord, "seq">[] => {
      if (p.type === "text") return [{ kind: "message", role: "assistant", ts, text: str(p.text) }];
      if (p.type === "thinking") return [{ kind: "reasoning", role: "assistant", ts, text: str(p.thinking) }];
      if (p.type === "tool_use") return [{ kind: "tool_call", role: "assistant", ts, name: str(p.name), text: JSON.stringify(rec(p.input)) }];
      return [];
    });
  }
  if (obj.type === "summary" || obj.type === "compact") return [{ kind: "trace", role: "system", ts, name: str(obj.type), text: JSON.stringify(obj) }];
  return [];
}
function normalizeCodex(obj: Record<string, unknown>): Omit<PageRecord, "seq">[] {
  const ts = str(obj.timestamp) || null;
  const payload = rec(obj.payload);
  const type = str(payload.type);
  if (obj.type === "event_msg") {
    if (type === "user_message") return [{ kind: "message", role: "user", ts, text: str(payload.message), representation: "event" }];
    if (type === "agent_message") return [{ kind: "message", role: "assistant", ts, text: str(payload.message), representation: "event" }];
    if (type === "agent_reasoning") return [{ kind: "reasoning", role: "assistant", ts, text: str(payload.text) }];
    return type ? [{ kind: "trace", role: "system", ts, name: type, text: JSON.stringify(payload) }] : [];
  }
  if (obj.type === "response_item") {
    if (type === "message") {
      const role: Role = payload.role === "assistant" ? "assistant" : payload.role === "user" ? "user" : "system";
      return [{ kind: "message", role, ts, text: textOf(payload.content), representation: "response" }];
    }
    if (type === "reasoning") {
      const text = parts(payload.summary).map((p) => str(p.text)).filter(Boolean).join("\n") || str(payload.text);
      return text ? [{ kind: "reasoning", role: "assistant", ts, text }] : [];
    }
    if (type === "function_call" || type === "custom_tool_call") return [{ kind: "tool_call", role: "assistant", ts, name: str(payload.name), text: str(payload.arguments) || str(payload.input) }];
    if (type === "function_call_output" || type === "custom_tool_call_output") return [{ kind: "tool_result", role: "tool", ts, name: str(payload.name) || undefined, text: textOf(payload.output) }];
    return type ? [{ kind: "trace", role: "system", ts, name: type, text: JSON.stringify(payload) }] : [];
  }
  return type ? [{ kind: "trace", role: "system", ts, name: type, text: JSON.stringify(payload) }] : [];
}

/**
 * Reverse tail-window reader: walks the file backwards in fixed chunks, parses
 * whole lines newest-first, applies the filter, and stops when the page is
 * full or the per-call scan ceiling is reached. Cost = bytes between the
 * cursor and the oldest record on the page, never the file.
 */
function readPageBackwards(fd: number, size: number, engine: Engine, query: Query, cursor: Cursor | null): Page {
  const normalize = engine === "claude" ? normalizeClaude : normalizeCodex;
  const out: PageRecord[] = [];
  let bytesRead = 0;
  let linesParsed = 0;
  let next: Cursor | null = null;
  let hasMore = false;
  let scanCapped = false;
  /* Codex writes every user/assistant message twice (event_msg + response_item
     with the same timestamp); the twin is collapsed the way the search index
     collapses it. The window rides on the cursor so a twin split across a page
     boundary is still collapsed. */
  const recentMessages: RecentMessage[] = cursor?.recent ? [...cursor.recent] : [];

  const seen = (candidate: Omit<PageRecord, "seq">): boolean => {
    if (candidate.kind !== "message" || !candidate.representation) return false;
    const key = `${candidate.role}\0${candidate.text.trim().replace(/\s+/gu, " ")}`;
    const ts = candidate.ts ? Date.parse(candidate.ts) : null;
    const twin = recentMessages.find((m) => m.key === key && m.representation !== candidate.representation
      && (ts !== null && m.ts !== null ? Math.abs(m.ts - ts) <= 2_000 : true));
    recentMessages.unshift({ key, ts, representation: candidate.representation });
    if (recentMessages.length > 8) recentMessages.pop();
    return Boolean(twin);
  };
  /** Emits one line's records newest-part-first; returns false when the page filled. */
  const consumeLine = (line: Buffer, offset: number, partLimit: number): boolean => {
    let parsed: unknown;
    linesParsed += 1;
    try { parsed = JSON.parse(line.toString("utf8")); } catch { return true; }
    const records = normalize(rec(parsed)).filter((r) => r.text.trim());
    for (let part = Math.min(partLimit, records.length) - 1; part >= 0; part -= 1) {
      const candidate = records[part]!;
      if (query.since !== undefined && candidate.ts && Date.parse(candidate.ts) < query.since) { hasMore = false; return false; }
      if (out.length >= query.limit) { hasMore = true; next = { offset, part: part + 1, recent: [...recentMessages] }; return false; }
      if (seen(candidate)) continue;
      if (!query.kinds.has(candidate.kind) || !query.roles.has(candidate.role)) continue;
      const { representation: _r, ...record } = candidate;
      out.push({ seq: offset, ...(records.length > 1 ? { part } : {}), ...record });
    }
    return true;
  };

  /* A cursor mid-line: replay that one line's earlier parts first. */
  let end = cursor ? cursor.offset : size;
  if (cursor && cursor.part > 0) {
    let probe = Buffer.alloc(0);
    while (probe.indexOf(0x0a) === -1 && cursor.offset + probe.length < size && probe.length < MAX_LINE_BYTES) {
      const chunk = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, size - cursor.offset - probe.length));
      const n = fs.readSync(fd, chunk, 0, chunk.length, cursor.offset + probe.length);
      bytesRead += n;
      probe = Buffer.concat([probe, chunk.subarray(0, n)]);
    }
    const nl = probe.indexOf(0x0a);
    if (!consumeLine(probe.subarray(0, nl === -1 ? probe.length : nl), cursor.offset, cursor.part)) {
      return { records: out, cursor: next, hasMore, bytesRead, linesParsed, scanCapped };
    }
  }

  let carry = Buffer.alloc(0);
  let done = false;
  while (end > 0 && !done) {
    if (bytesRead >= MAX_SCAN_BYTES) { scanCapped = true; hasMore = true; next = { offset: end, part: 0, recent: [...recentMessages] }; break; }
    const start = Math.max(0, end - CHUNK_BYTES);
    const buffer = Buffer.allocUnsafe(end - start);
    const n = fs.readSync(fd, buffer, 0, buffer.length, start);
    bytesRead += n;
    /* Absolute offset of window[i] is start + i: the carry is the head of the
       previous window, which began exactly at start + n. */
    const window = carry.length ? Buffer.concat([buffer.subarray(0, n), carry]) : buffer.subarray(0, n);
    const firstNewline = start === 0 ? -1 : window.indexOf(0x0a);
    if (start > 0 && firstNewline === -1) {
      carry = window.length > MAX_LINE_BYTES ? Buffer.alloc(0) : Buffer.from(window);
      end = start;
      continue;
    }
    const lineBase = firstNewline === -1 ? 0 : firstNewline + 1;
    const nextCarry = firstNewline === -1 ? Buffer.alloc(0) : Buffer.from(window.subarray(0, firstNewline));
    /* Walk the complete lines in this window from the last to the first. */
    let lineEnd = window.length;
    while (lineEnd > lineBase) {
      if (window[lineEnd - 1] === 0x0a) lineEnd -= 1;
      const prev = window.lastIndexOf(0x0a, lineEnd - 1);
      const lineStart = Math.max(lineBase, prev + 1);
      const line = window.subarray(lineStart, lineEnd);
      if (line.length && !consumeLine(line, start + lineStart, Number.POSITIVE_INFINITY)) { done = true; break; }
      lineEnd = lineStart;
    }
    carry = nextCarry;
    end = start;
  }
  if (!done && end === 0 && !scanCapped) hasMore = false;
  return { records: out, cursor: next, hasMore, bytesRead, linesParsed, scanCapped };
}

function median(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}
function timed<T>(runs: number, fn: () => T): { ms: number; last: T } {
  const samples: number[] = [];
  let last!: T;
  for (let i = 0; i < runs; i += 1) {
    const started = performance.now();
    last = fn();
    samples.push(performance.now() - started);
  }
  return { ms: Number(median(samples).toFixed(2)), last };
}

function sqlite(): typeof import("bun:sqlite").Database {
  return (process.getBuiltinModule("bun:sqlite") as typeof import("bun:sqlite")).Database;
}

/** (a) with hydration: the page comes from the index rows, the text from a pread at each recorded byte offset. */
function hydrateLine(fd: number, size: number, offset: number): { bytes: number } {
  let read = 0;
  for (;;) {
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, size - offset - read));
    const n = fs.readSync(fd, chunk, 0, chunk.length, offset + read);
    read += n;
    if (n === 0 || chunk.subarray(0, n).indexOf(0x0a) !== -1) return { bytes: read };
  }
}

async function bench(engine: Engine, pathname: string) {
  const size = fs.statSync(pathname).size;
  const fd = fs.openSync(pathname, "r");
  const result: Record<string, unknown> = { engine, path: path.basename(pathname), bytes: size };

  const baseline = timed(3, () => readSession(pathname, engine));
  result.baseline_readSession_8MiB_tail = { ms: baseline.ms, messages: baseline.last.messages.length, tools: baseline.last.tools.length };

  const firstBuild = performance.now();
  const indexed = await indexTranscriptSources([{ path: pathname, project: "fixture", engine, size, mtimeMs: fs.statSync(pathname).mtimeMs }], { complete: false });
  const firstBuildMs = performance.now() - firstBuild;
  /* An append changes size+mtime, and the writer drops and re-reads the whole
     file: this is what every index-served page pays once per transcript change. */
  const rebuild = performance.now();
  await indexTranscriptSources([{ path: pathname, project: "fixture", engine, size, mtimeMs: fs.statSync(pathname).mtimeMs + 1 }], { complete: false });
  result.index_build_full_reparse = { firstMs: Number(firstBuildMs.toFixed(0)), afterAppendMs: Number((performance.now() - rebuild).toFixed(0)), messagesIndexed: indexed.messagesIndexed, failures: indexed.failures.length };

  const db = new (sqlite())(statePath("transcript-search.sqlite"), { readonly: true, strict: true });
  const pageQuery = db.query<{ message_index: number; speaker: string; timestamp: number | null; byte_offset: number; body: string }, [string, number, number]>(
    "SELECT message_index, speaker, timestamp, byte_offset, body FROM transcript_messages WHERE transcript_path = ? ORDER BY message_index DESC LIMIT ? OFFSET ?",
  );
  const indexFirst = timed(20, () => pageQuery.all(pathname, 20, 0));
  const indexTenth = timed(20, () => pageQuery.all(pathname, 20, 180));
  result.index_page_bodies_from_index = { first: { ms: indexFirst.ms, rows: indexFirst.last.length, transcriptBytesRead: 0 }, tenth: { ms: indexTenth.ms, rows: indexTenth.last.length, transcriptBytesRead: 0 } };
  const hydrated = timed(20, () => {
    const rows = pageQuery.all(pathname, 20, 0);
    let bytes = 0;
    for (const row of rows) bytes += hydrateLine(fd, size, row.byte_offset).bytes;
    return bytes;
  });
  const hydratedTenth = timed(20, () => {
    const rows = pageQuery.all(pathname, 20, 180);
    let bytes = 0;
    for (const row of rows) bytes += hydrateLine(fd, size, row.byte_offset).bytes;
    return bytes;
  });
  result.index_page_hydrated_from_offsets = { first: { ms: hydrated.ms, transcriptBytesRead: hydrated.last }, tenth: { ms: hydratedTenth.ms, transcriptBytesRead: hydratedTenth.last } };
  db.close();

  const all = new Set<Role>(["user", "assistant", "system", "tool"]);
  const messages: Query = { limit: 20, kinds: new Set(["message"]), roles: all };
  const first = timed(20, () => readPageBackwards(fd, size, engine, messages, null));
  const tenthCursor = (() => {
    let cursor: Cursor | null = null;
    for (let page = 0; page < 9; page += 1) cursor = readPageBackwards(fd, size, engine, messages, cursor).cursor;
    return cursor;
  })();
  const tenth = timed(20, () => readPageBackwards(fd, size, engine, messages, tenthCursor));
  const userOnly = timed(20, () => readPageBackwards(fd, size, engine, { ...messages, roles: new Set(["user"]) }, null));
  const tools = timed(20, () => readPageBackwards(fd, size, engine, { limit: 20, kinds: new Set(["tool_call", "tool_result"]), roles: all }, null));
  const wide = timed(20, () => readPageBackwards(fd, size, engine, { limit: 200, kinds: new Set(["message", "reasoning", "tool_call", "tool_result", "trace"]), roles: all }, null));
  const nothing = timed(3, () => readPageBackwards(fd, size, engine, { ...messages, roles: new Set(["system"]) }, null));
  const summarize = (t: { ms: number; last: Page }) => ({ ms: t.ms, records: t.last.records.length, bytesRead: t.last.bytesRead, linesParsed: t.last.linesParsed, hasMore: t.last.hasMore, ...(t.last.scanCapped ? { scanCapped: true } : {}) });
  result.reverse_reader = {
    first_page_messages: summarize(first),
    tenth_page_messages: summarize(tenth),
    first_page_user_messages: summarize(userOnly),
    first_page_tool_records: summarize(tools),
    first_page_200_all_kinds: summarize(wide),
    nothing_matches_capped: summarize(nothing),
  };

  /* Cursor discipline: walk every page and check that the union is exactly the
     full newest-first sequence with no repeats or gaps. */
  const walked: number[] = [];
  let cursor: Cursor | null = null;
  let pages = 0;
  for (;;) {
    const page = readPageBackwards(fd, size, engine, messages, cursor);
    pages += 1;
    for (const record of page.records) walked.push(record.seq * 8 + (record.part ?? 0));
    if (!page.hasMore || !page.cursor) break;
    cursor = page.cursor;
  }
  const unique = new Set(walked).size;
  const descending = walked.every((value, index) => index === 0 || value < walked[index - 1]!);
  result.cursor_walk = { pages, records: walked.length, unique, descending, matchesIndexCount: unique === indexed.messagesIndexed };
  fs.closeSync(fd);
  return result;
}

const files = (["codex", "claude"] as const).flatMap((engine) => {
  const dir = path.join(fixtureDir, engine);
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.endsWith(".jsonl")).map((name) => [engine, path.join(dir, name)] as const) : [];
});
const results = [];
for (const [engine, pathname] of files) results.push(await bench(engine, pathname));
console.log(JSON.stringify(results, null, 2));
