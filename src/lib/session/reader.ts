import fs from "node:fs";
import { StringDecoder } from "node:string_decoder";

import { yieldToRuntime } from "@/lib/cooperative";
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
      if (part.type === "text") return str(part.text);
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
const AUTHORSHIP_SCAN_MAX_RECORD_CHARS = 8 * 1024 * 1024;

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

function createAuthorshipScanner(engine: Extract<Engine, "claude" | "codex">, limit: number) {
  let count = 0;
  let complete = true;
  let pending = "";
  let skippingRecord = false;
  const decoder = new StringDecoder("utf8");
  const consume = (line: string): boolean => {
    const text = line.trim();
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
  const consumeDecoded = (decoded: string): boolean => {
    let cursor = 0;
    while (cursor < decoded.length) {
      const newline = decoded.indexOf("\n", cursor);
      const end = newline === -1 ? decoded.length : newline;
      if (!skippingRecord) {
        pending += decoded.slice(cursor, end);
        if (pending.length > AUTHORSHIP_SCAN_MAX_RECORD_CHARS) {
          pending = "";
          skippingRecord = true;
          complete = false;
        }
      }
      if (newline === -1) return false;
      if (!skippingRecord && consume(pending)) {
        count += 1;
        if (count >= limit) return true;
      }
      pending = "";
      skippingRecord = false;
      cursor = newline + 1;
    }
    return false;
  };
  return {
    consume(chunk: Uint8Array): boolean {
      return consumeDecoded(decoder.write(chunk));
    },
    finish(): AuthorshipScanResult {
      const tail = decoder.end();
      if (tail && consumeDecoded(tail)) return { count, complete };
      if (!skippingRecord && Boolean(pending) && consume(pending)) count += 1;
      return { count, complete };
    },
    result(): AuthorshipScanResult {
      return { count, complete };
    },
    failed(): AuthorshipScanResult {
      return { count, complete: false };
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

export async function scanUserAuthoredMessagesCooperatively(
  pathname: string,
  engine: Extract<Engine, "claude" | "codex">,
  limit = Number.MAX_SAFE_INTEGER,
): Promise<AuthorshipScanResult> {
  const scanner = createAuthorshipScanner(engine, limit);
  let file: Awaited<ReturnType<typeof fs.promises.open>> | null = null;
  try {
    file = await fs.promises.open(pathname, "r");
    const chunk = Buffer.allocUnsafe(AUTHORSHIP_SCAN_CHUNK_BYTES);
    let chunksSinceYield = 0;
    for (;;) {
      const { bytesRead } = await file.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      if (scanner.consume(chunk.subarray(0, bytesRead))) return scanner.result();
      chunksSinceYield += 1;
      if (chunksSinceYield >= 8) {
        chunksSinceYield = 0;
        await yieldToRuntime();
      }
    }
    return scanner.finish();
  } catch {
    return scanner.failed();
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
