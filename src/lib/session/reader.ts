import { createHash } from "node:crypto";
import fs from "node:fs";

import { yieldToRuntime } from "@/lib/cooperative";
import { globalCache } from "@/lib/scanner/caches";
import type { Engine } from "@/lib/types";

export type SessionRecordKind = "message" | "reasoning" | "tool_call" | "tool_result" | "trace";

export interface SessionRecord {
  kind: SessionRecordKind;
  role: "user" | "assistant" | "system" | "tool";
  ts: string | null;
  text: string;
  name?: string;
  phase?: string;
}

export interface SessionReadResult {
  path: string;
  engine: Extract<Engine, "claude" | "codex">;
  messages: SessionRecord[];
  reasoning: SessionRecord[];
  tools: SessionRecord[];
  traces: SessionRecord[];
}

function rec(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function arr(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function tsOf(obj: Record<string, unknown>): string | null {
  return str(obj.timestamp) || str(obj.ts) || null;
}

function readJsonl(pathname: string, maxBytes = 8 * 1024 * 1024): Record<string, unknown>[] {
  let data: string;
  try {
    const st = fs.statSync(pathname);
    const start = Math.max(0, st.size - maxBytes);
    const fd = fs.openSync(pathname, "r");
    try {
      const buf = Buffer.alloc(st.size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      data = buf.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
    if (start > 0) data = data.slice(data.indexOf("\n") + 1);
  } catch {
    return [];
  }
  const records: Record<string, unknown>[] = [];
  for (const line of data.split("\n")) {
    const text = line.trim();
    if (!text) continue;
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) records.push(parsed as Record<string, unknown>);
    } catch {
      /* skip malformed rows */
    }
  }
  return records;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  return arr(content)
    .map((part) => {
      if (part.type === "text" || part.type === "input_text" || part.type === "output_text") {
        return str(part.text);
      }
      if (part.type === "thinking") return str(part.thinking);
      if (part.type === "tool_use") return `${str(part.name)} ${JSON.stringify(rec(part.input))}`.trim();
      if (part.type === "tool_result") {
        const contentText = textFromContent(part.content);
        return contentText || str(part.tool_use_id);
      }
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function contentParts(content: unknown): Record<string, unknown>[] {
  return arr(content);
}

function hasToolResult(content: unknown): boolean {
  return contentParts(content).some((part) => part.type === "tool_result");
}

function isClaudeTaskNotification(record: Record<string, unknown>): boolean {
  const origin = record.origin;
  if (record.promptSource === "system" && rec(origin).kind === "task-notification") return true;
  if (origin === "task" || rec(origin).kind === "task") return true;
  const content = textFromContent(rec(record.message).content).trim();
  return /^<task-notification(?:\s[^>]*)?>[\s\S]*<\/task-notification>$/.test(content);
}

function push(out: SessionReadResult, item: SessionRecord): void {
  if (!item.text.trim()) return;
  if (item.kind === "message") out.messages.push(item);
  else if (item.kind === "reasoning") out.reasoning.push(item);
  else if (item.kind === "tool_call" || item.kind === "tool_result") out.tools.push(item);
  else out.traces.push(item);
}

function readClaude(pathname: string): SessionReadResult {
  const out: SessionReadResult = { path: pathname, engine: "claude", messages: [], reasoning: [], tools: [], traces: [] };
  for (const obj of readJsonl(pathname)) {
    const ts = tsOf(obj);
    if (obj.type === "user") {
      const content = rec(obj.message).content;
      if (isClaudeTaskNotification(obj)) {
        push(out, { kind: "trace", role: "system", ts, name: "task-notification", text: textFromContent(content) });
        continue;
      }
      if (hasToolResult(content)) {
        for (const part of contentParts(content)) {
          if (part.type === "tool_result") {
            push(out, { kind: "tool_result", role: "tool", ts, text: textFromContent(part.content) || str(part.tool_use_id) });
          }
        }
        continue;
      }
      push(out, { kind: "message", role: "user", ts, text: textFromContent(content) });
      continue;
    }
    if (obj.type === "assistant") {
      const content = arr(rec(obj.message).content);
      for (const part of content) {
        if (part.type === "text") {
          push(out, { kind: "message", role: "assistant", ts, text: str(part.text) });
        } else if (part.type === "thinking") {
          push(out, { kind: "reasoning", role: "assistant", ts, text: str(part.thinking) });
        } else if (part.type === "tool_use") {
          push(out, { kind: "tool_call", role: "assistant", ts, name: str(part.name), text: JSON.stringify(rec(part.input)) });
        } else if (part.type === "tool_result") {
          push(out, { kind: "tool_result", role: "tool", ts, text: textFromContent(part.content) || str(part.tool_use_id) });
        }
      }
      continue;
    }
    if (obj.type === "summary" || obj.type === "compact") {
      push(out, { kind: "trace", role: "system", ts, name: str(obj.type), text: textFromContent(obj.summary) || JSON.stringify(obj) });
    }
  }
  return out;
}

function codexMessageFromPayload(payload: Record<string, unknown>): { role: SessionRecord["role"]; text: string } | null {
  const type = str(payload.type);
  if (type === "user_message") return { role: "user", text: str(payload.message) };
  if (type === "agent_message") return { role: "assistant", text: str(payload.message) };
  if (type === "message") {
    const role = payload.role === "assistant" ? "assistant" : payload.role === "user" ? "user" : "system";
    return { role, text: textFromContent(payload.content) || str(payload.message) };
  }
  return null;
}

function readCodex(pathname: string): SessionReadResult {
  const out: SessionReadResult = { path: pathname, engine: "codex", messages: [], reasoning: [], tools: [], traces: [] };
  for (const obj of readJsonl(pathname)) {
    const ts = tsOf(obj);
    const payload = rec(obj.payload);
    const payloadType = str(payload.type);
    const message = codexMessageFromPayload(payload);
    if (message) {
      push(out, {
        kind: "message",
        role: message.role,
        ts,
        phase: str(payload.phase) || undefined,
        text: message.text,
      });
      continue;
    }
    if (payloadType === "reasoning" || payloadType === "reasoning_delta") {
      push(out, { kind: "reasoning", role: "assistant", ts, text: str(payload.text) || str(payload.message) });
      continue;
    }
    if (obj.type === "response_item") {
      const item = rec(payload.item) || payload;
      const itemType = str(item.type);
      if (itemType === "function_call" || itemType === "custom_tool_call") {
        push(out, { kind: "tool_call", role: "assistant", ts, name: str(item.name), text: str(item.arguments) || JSON.stringify(item) });
      } else if (itemType === "function_call_output" || itemType === "custom_tool_call_output") {
        push(out, { kind: "tool_result", role: "tool", ts, name: str(item.name), text: str(item.output) || JSON.stringify(item) });
      } else if (itemType) {
        push(out, { kind: "trace", role: "system", ts, name: itemType, text: JSON.stringify(item) });
      }
      continue;
    }
    if (payloadType) push(out, { kind: "trace", role: "system", ts, name: payloadType, text: JSON.stringify(payload) });
  }
  return out;
}

export function readSession(pathname: string, engine: Extract<Engine, "claude" | "codex">): SessionReadResult {
  return engine === "claude" ? readClaude(pathname) : readCodex(pathname);
}

const AUTHORSHIP_SCAN_CHUNK_BYTES = 64 * 1024;
const AUTHORSHIP_SCAN_MAX_RECORD_BYTES = 8 * 1024 * 1024;
const AUTHORSHIP_CHECKPOINT_HEAD_BYTES = 64 * 1024;

function recordHasUserMessage(record: Record<string, unknown>, engine: Extract<Engine, "claude" | "codex">): boolean {
  if (engine === "claude") {
    if (record.type !== "user" || isClaudeTaskNotification(record)) return false;
    const content = rec(record.message).content;
    return !hasToolResult(content) && Boolean(textFromContent(content).trim());
  }
  const message = codexMessageFromPayload(rec(record.payload));
  return message?.role === "user" && Boolean(message.text.trim());
}

/** Scans every JSONL record with bounded memory and stops at the first human
    message. Oversized individual records are skipped while later records
    remain observable. */
export interface AuthorshipScanResult {
  count: number;
  complete: boolean;
}

/** Shared hard byte allowance across one controller generation. Exhaustion
    returns `complete: false`; the persisted per-path checkpoint resumes the
    scan in a later cycle instead of restarting a multi-gigabyte pass. */
export interface AuthorshipScanBudget {
  remaining: number;
}

export interface AuthorshipScanOptions {
  /** Cooperative cancellation observed between 64 KiB chunks. */
  signal?: AbortSignal;
  /** Hard ceiling of bytes this call may read from the transcript. */
  maxBytes?: number;
  /** Shared cross-file allowance charged with every byte actually read. */
  budget?: AuthorshipScanBudget;
  /** Reuse and update the process-wide resumable checkpoint for this path. */
  resume?: boolean;
}

interface AuthorshipScanCheckpoint {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  /** Absolute offset of the next unread byte. */
  offset: number;
  /** Raw bytes of the unterminated line preceding `offset`. */
  carry: Buffer;
  skippingRecord: boolean;
  count: number;
  parseComplete: boolean;
  headBytes: number;
  headFingerprint: string;
  /** The scan reached EOF at `size`; only appended bytes remain unread. */
  done: boolean;
}

const authorshipCheckpoints = globalCache<AuthorshipScanCheckpoint>("authorship-scan-checkpoint-v1");

interface AuthorshipScannerState {
  count: number;
  carry: Buffer;
  skippingRecord: boolean;
  parseComplete: boolean;
}

/* Lines assemble at the byte level so a checkpoint can persist the exact
   scanner state (offset + unterminated-line bytes) without decoder state.
   Every complete line decodes independently — JSONL records never contain
   raw newlines, so per-line UTF-8 decoding matches streaming decoding. */
function createAuthorshipScanner(
  engine: Extract<Engine, "claude" | "codex">,
  limit: number,
  initial?: AuthorshipScannerState,
) {
  let count = initial?.count ?? 0;
  let complete = initial?.parseComplete ?? true;
  let skippingRecord = initial?.skippingRecord ?? false;
  let pending: Buffer[] = initial?.carry.length ? [Buffer.from(initial.carry)] : [];
  let pendingBytes = initial?.carry.length ?? 0;
  const consume = (line: Buffer): boolean => {
    const text = line.toString("utf8").trim();
    if (!text) return false;
    try {
      const parsed = JSON.parse(text) as unknown;
      return Boolean(parsed && typeof parsed === "object" && !Array.isArray(parsed)
        && recordHasUserMessage(parsed as Record<string, unknown>, engine));
    } catch {
      complete = false;
      return false;
    }
  };
  const resetLine = () => {
    pending = [];
    pendingBytes = 0;
    skippingRecord = false;
  };
  return {
    consume(chunk: Buffer): boolean {
      let cursor = 0;
      while (cursor <= chunk.length) {
        const newline = chunk.indexOf(0x0a, cursor);
        if (newline === -1) {
          const rest = chunk.length - cursor;
          if (!skippingRecord && rest > 0) {
            if (pendingBytes + rest > AUTHORSHIP_SCAN_MAX_RECORD_BYTES) {
              pending = [];
              pendingBytes = 0;
              skippingRecord = true;
              complete = false;
            } else {
              pending.push(Buffer.from(chunk.subarray(cursor)));
              pendingBytes += rest;
            }
          }
          return false;
        }
        if (!skippingRecord) {
          const segment = chunk.subarray(cursor, newline);
          if (pendingBytes + segment.length > AUTHORSHIP_SCAN_MAX_RECORD_BYTES) {
            complete = false;
          } else if (consume(pendingBytes ? Buffer.concat([...pending, segment]) : segment)) {
            count += 1;
            if (count >= limit) {
              resetLine();
              return true;
            }
          }
        }
        resetLine();
        cursor = newline + 1;
      }
      return false;
    },
    finish(): AuthorshipScanResult {
      if (!skippingRecord && pendingBytes > 0 && consume(Buffer.concat(pending))) count += 1;
      return { count, complete };
    },
    result(): AuthorshipScanResult {
      return { count, complete };
    },
    failed(): AuthorshipScanResult {
      return { count, complete: false };
    },
    state(): AuthorshipScannerState {
      return {
        count,
        carry: pendingBytes ? Buffer.concat(pending) : Buffer.alloc(0),
        skippingRecord,
        parseComplete: complete,
      };
    },
  };
}

export function scanUserAuthoredMessages(
  pathname: string,
  engine: Extract<Engine, "claude" | "codex">,
  limit = Number.MAX_SAFE_INTEGER,
): AuthorshipScanResult {
  let fd: number | null = null;
  const scanner = createAuthorshipScanner(engine, limit);
  try {
    fd = fs.openSync(pathname, "r");
    const chunk = Buffer.allocUnsafe(AUTHORSHIP_SCAN_CHUNK_BYTES);
    for (;;) {
      const bytes = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (bytes === 0) break;
      if (scanner.consume(chunk.subarray(0, bytes))) return scanner.result();
    }
    return scanner.finish();
  } catch {
    return scanner.failed();
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

function authorshipHeadFingerprint(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("base64url");
}

/** Bytes this pass may still read under the caller's combined ceilings. */
function authorshipAllowance(options: AuthorshipScanOptions, charged: number): number {
  const perCall = (options.maxBytes ?? Number.POSITIVE_INFINITY) - charged;
  const shared = options.budget === undefined ? Number.POSITIVE_INFINITY : options.budget.remaining;
  return Math.min(perCall, shared);
}

export async function scanUserAuthoredMessagesCooperatively(
  pathname: string,
  engine: Extract<Engine, "claude" | "codex">,
  limit = Number.MAX_SAFE_INTEGER,
  options: AuthorshipScanOptions = {},
): Promise<AuthorshipScanResult> {
  let file: Awaited<ReturnType<typeof fs.promises.open>> | null = null;
  let charged = 0;
  const charge = (bytes: number) => {
    charged += bytes;
    if (options.budget) options.budget.remaining -= bytes;
  };
  try {
    file = await fs.promises.open(pathname, "r");
    const stat = await file.stat();
    let checkpoint = options.resume ? authorshipCheckpoints.get(pathname) : undefined;
    if (checkpoint) {
      // Truncation, replacement, or a rewritten head resets the checkpoint:
      // the recorded offset no longer describes this file's content.
      let valid = checkpoint.dev === stat.dev && checkpoint.ino === stat.ino && stat.size >= checkpoint.offset;
      if (valid && checkpoint.headBytes > 0) {
        if (authorshipAllowance(options, charged) < checkpoint.headBytes) {
          return { count: checkpoint.count, complete: false };
        }
        const head = Buffer.allocUnsafe(checkpoint.headBytes);
        let filled = 0;
        while (filled < head.length) {
          const { bytesRead } = await file.read(head, filled, head.length - filled, filled);
          if (bytesRead === 0) break;
          filled += bytesRead;
        }
        charge(filled);
        valid = filled === head.length && authorshipHeadFingerprint(head) === checkpoint.headFingerprint;
      }
      if (!valid) {
        authorshipCheckpoints.delete(pathname);
        checkpoint = undefined;
      }
    }
    if (checkpoint && checkpoint.count >= limit) return { count: checkpoint.count, complete: checkpoint.parseComplete };
    if (checkpoint?.done && checkpoint.size === stat.size && checkpoint.mtimeMs === stat.mtimeMs) {
      return { count: checkpoint.count, complete: checkpoint.parseComplete };
    }

    const scanner = createAuthorshipScanner(engine, limit, checkpoint ?? undefined);
    let offset = checkpoint?.offset ?? 0;
    let headBytes = checkpoint?.headBytes ?? 0;
    let headFingerprint = checkpoint?.headFingerprint ?? "";
    const save = (done: boolean) => {
      if (!options.resume) return;
      const state = scanner.state();
      authorshipCheckpoints.set(pathname, {
        dev: stat.dev,
        ino: stat.ino,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        offset,
        carry: state.carry,
        skippingRecord: state.skippingRecord,
        count: state.count,
        parseComplete: state.parseComplete,
        headBytes,
        headFingerprint,
        done,
      });
    };
    const chunk = Buffer.allocUnsafe(AUTHORSHIP_SCAN_CHUNK_BYTES);
    let chunksSinceYield = 0;
    for (;;) {
      if (options.signal?.aborted) {
        save(false);
        return scanner.failed();
      }
      const allowance = authorshipAllowance(options, charged);
      if (allowance <= 0) {
        save(false);
        return scanner.failed();
      }
      const { bytesRead } = await file.read(chunk, 0, Math.min(chunk.length, allowance), offset);
      if (bytesRead === 0) break;
      charge(bytesRead);
      if (offset === 0 && headBytes === 0) {
        headBytes = Math.min(bytesRead, AUTHORSHIP_CHECKPOINT_HEAD_BYTES);
        headFingerprint = authorshipHeadFingerprint(chunk.subarray(0, headBytes));
      }
      offset += bytesRead;
      if (scanner.consume(chunk.subarray(0, bytesRead))) {
        save(false);
        return scanner.result();
      }
      chunksSinceYield += 1;
      if (chunksSinceYield >= 8) {
        chunksSinceYield = 0;
        await yieldToRuntime();
      }
    }
    const finished = scanner.finish();
    save(true);
    return finished;
  } catch {
    return { count: 0, complete: false };
  } finally {
    await file?.close().catch(() => undefined);
  }
}

export function countUserAuthoredMessages(
  pathname: string,
  engine: Extract<Engine, "claude" | "codex">,
  limit = Number.MAX_SAFE_INTEGER,
): number {
  return scanUserAuthoredMessages(pathname, engine, limit).count;
}

export function hasUserAuthoredMessage(pathname: string, engine: Extract<Engine, "claude" | "codex">): boolean {
  return countUserAuthoredMessages(pathname, engine, 1) > 0;
}
