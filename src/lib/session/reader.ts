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

export interface NormalizedSessionLine {
  record: SessionRecord;
  /** Codex writes visible messages as adjacent event and response records.
      Page readers use this provenance to collapse those twins without changing
      readSession's long-standing output. */
  representation?: "event" | "response";
}

function rec(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
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

function codexEnvelopeTs(payload: Record<string, unknown>): string | null {
  const value = payload.started_at_ms ?? payload.completed_at_ms;
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
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

function normalizeClaudeLine(obj: Record<string, unknown>): NormalizedSessionLine[] {
  const records: NormalizedSessionLine[] = [];
  const add = (record: SessionRecord): void => { records.push({ record }); };
  const ts = tsOf(obj);
  if (obj.type === "user") {
    const content = rec(obj.message).content;
    if (isClaudeTaskNotification(obj)) {
      add({ kind: "trace", role: "system", ts, name: "task-notification", text: textFromContent(content) });
      return records;
    }
    if (hasToolResult(content)) {
      for (const part of contentParts(content)) {
        if (part.type === "tool_result") {
          add({ kind: "tool_result", role: "tool", ts, text: textFromContent(part.content) || str(part.tool_use_id) });
        }
      }
      return records;
    }
    add({ kind: "message", role: "user", ts, text: textFromContent(content) });
    return records;
  }
  if (obj.type === "assistant") {
    const content = arr(rec(obj.message).content);
    for (const part of content) {
      if (part.type === "text") {
        add({ kind: "message", role: "assistant", ts, text: str(part.text) });
      } else if (part.type === "thinking") {
        add({ kind: "reasoning", role: "assistant", ts, text: str(part.thinking) });
      } else if (part.type === "tool_use") {
        add({ kind: "tool_call", role: "assistant", ts, name: str(part.name), text: JSON.stringify(rec(part.input)) });
      } else if (part.type === "tool_result") {
        add({ kind: "tool_result", role: "tool", ts, text: textFromContent(part.content) || str(part.tool_use_id) });
      }
    }
    return records;
  }
  if (obj.type === "summary" || obj.type === "compact") {
    add({ kind: "trace", role: "system", ts, name: str(obj.type), text: textFromContent(obj.summary) || JSON.stringify(obj) });
  }
  return records;
}

function readClaude(pathname: string): SessionReadResult {
  const out: SessionReadResult = { path: pathname, engine: "claude", messages: [], reasoning: [], tools: [], traces: [] };
  for (const obj of readJsonl(pathname)) {
    for (const normalized of normalizeClaudeLine(obj)) push(out, normalized.record);
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

const CODEX_THREAD_ITEM_TYPES = new Set([
  "usermessage",
  "hookprompt",
  "agentmessage",
  "functioncalloutput",
  "plan",
  "reasoning",
  "commandexecution",
  "filechange",
  "mcptoolcall",
  "dynamictoolcall",
  "collabagenttoolcall",
  "subagentactivity",
  "websearch",
  "imageview",
  "sleep",
  "imagegeneration",
  "enteredreviewmode",
  "exitedreviewmode",
  "contextcompaction",
  "extension",
]);

function codexThreadItemKind(value: unknown): string {
  return str(value).replace(/[_-]/g, "").toLowerCase();
}

function stringList(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value.map((item) => typeof item === "string" ? item : str(rec(item).text)).filter((item) => item.trim()).join("\n");
}

function compactRecordText(value: unknown, max = 2_000): string {
  if (typeof value === "string") return value.replace(/\s+/g, " ").trim().slice(0, max);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map((item) => compactRecordText(item, max)).filter(Boolean).join("\n").slice(0, max);
  const record = rec(value);
  const content = textFromContent(record.content);
  if (content) return content.slice(0, max);
  const preferred = [record.summary, record.message, record.text, record.detail, record.query, record.path, record.result, record.status]
    .find((item) => typeof item === "string" && item.trim());
  if (typeof preferred === "string") return preferred.replace(/\s+/g, " ").trim().slice(0, max);
  return Object.keys(record).filter((key) => !["type", "id"].includes(key)).slice(0, 8).join(", ").slice(0, max);
}

function codexFileChangeText(changes: unknown): string {
  if (Array.isArray(changes)) {
    return changes.flatMap((value) => {
      const change = rec(value);
      const path = str(change.path);
      const kind = str(rec(change.kind).type) || str(change.type) || "change";
      return path ? [`${kind} ${path}`] : [];
    }).join("\n");
  }
  return Object.entries(rec(changes)).map(([path, value]) => `${str(rec(value).type) || "change"} ${path}`).join("\n");
}

function codexThreadItemRecord(item: Record<string, unknown>, ts: string | null): SessionRecord {
  const itemType = str(item.type) || "item";
  const kind = codexThreadItemKind(itemType);
  if (kind === "usermessage") return { kind: "message", role: "user", ts, text: textFromContent(item.content) };
  if (kind === "agentmessage") return { kind: "message", role: "assistant", ts, phase: str(item.phase) || undefined, text: textFromContent(item.content) || str(item.text) };
  if (kind === "reasoning") {
    return {
      kind: "reasoning",
      role: "assistant",
      ts,
      text: [stringList(item.summary), stringList(item.content), str(item.summary_text), str(item.raw_content), str(item.text)]
        .filter((value, index, values) => Boolean(value.trim()) && values.indexOf(value) === index)
        .join("\n"),
    };
  }
  if (kind === "filechange") return { kind: "tool_call", role: "assistant", ts, name: itemType, text: codexFileChangeText(item.changes) || "File change" };
  if (kind === "commandexecution") {
    const command = Array.isArray(item.command)
      ? item.command.filter((part): part is string => typeof part === "string").join(" ")
      : str(item.command);
    const output = [str(item.stdout), str(item.stderr), str(item.aggregatedOutput ?? item.aggregated_output)]
      .filter((value, index, values) => Boolean(value) && values.indexOf(value) === index)
      .join("\n");
    return { kind: "tool_call", role: "assistant", ts, name: itemType, text: [command, output, str(item.status)].filter(Boolean).join("\n").slice(0, 2_000) };
  }
  if (kind === "functioncalloutput") return { kind: "tool_result", role: "tool", ts, name: itemType, text: textFromContent(item.output) || compactRecordText(item.output) || str(item.name) };
  if (["mcptoolcall", "dynamictoolcall", "collabagenttoolcall", "websearch", "imageview", "imagegeneration"].includes(kind)) {
    const identity = [str(item.server), str(item.namespace), str(item.tool), str(item.query), str(item.path)].filter(Boolean).join(" · ");
    const result = textFromContent(rec(item.result).content) || textFromContent(item.contentItems) || compactRecordText(item.contentItems) || compactRecordText(item.result);
    return { kind: "tool_call", role: "assistant", ts, name: itemType, text: [identity, result, str(item.status)].filter(Boolean).join("\n") || itemType };
  }
  if (kind === "extension") {
    const identity = [str(item.kind), str(item.action), str(item.query)].filter(Boolean).join(" · ");
    return { kind: "tool_call", role: "assistant", ts, name: itemType, text: [identity, compactRecordText(item.results)].filter(Boolean).join("\n") || itemType };
  }
  if (kind === "hookprompt") {
    return { kind: "trace", role: "system", ts, name: itemType, text: arr(item.fragments).map((fragment) => str(fragment.text)).filter(Boolean).join("\n") || "Hook prompt" };
  }
  if (kind === "plan") return { kind: "trace", role: "system", ts, name: itemType, text: str(item.text) || "Plan updated" };
  if (kind === "subagentactivity") return { kind: "trace", role: "system", ts, name: itemType, text: str(item.kind) || "Sub-agent activity" };
  if (kind === "sleep") return { kind: "trace", role: "system", ts, name: itemType, text: item.durationMs === undefined ? "Sleep" : `Sleep ${String(item.durationMs)} ms` };
  if (kind === "enteredreviewmode" || kind === "exitedreviewmode") return { kind: "trace", role: "system", ts, name: itemType, text: str(item.review) || itemType };
  if (kind === "contextcompaction") return { kind: "trace", role: "system", ts, name: itemType, text: "Context compacted" };
  return { kind: "trace", role: "system", ts, name: itemType, text: compactRecordText(item) || itemType };
}

function normalizeCodexLine(obj: Record<string, unknown>): NormalizedSessionLine[] {
  const records: NormalizedSessionLine[] = [];
  const add = (record: SessionRecord, representation?: NormalizedSessionLine["representation"]): void => {
    records.push({ record, ...(representation ? { representation } : {}) });
  };
  const payload = rec(obj.payload);
  const ts = codexEnvelopeTs(payload) ?? tsOf(obj);
  const payloadType = str(payload.type);
  const nestedThreadItem = recordOrNull(payload.item);
  const lifecycle = codexThreadItemKind(payloadType);
  const nestedItemType = str(nestedThreadItem?.type);
  let threadItem: Record<string, unknown> | null = null;
  if (nestedThreadItem && nestedItemType && !nestedItemType.includes("_")
    && (obj.type === "response_item" || (obj.type === "event_msg" && ["itemstarted", "itemcompleted", "itemdelta"].includes(lifecycle)))) {
    threadItem = nestedThreadItem;
  } else if (obj.type === "response_item" && !payloadType.includes("_") && CODEX_THREAD_ITEM_TYPES.has(codexThreadItemKind(payloadType))) {
    threadItem = payload;
  }
  if (threadItem) {
    if (obj.type === "event_msg" && lifecycle !== "itemcompleted") return records;
    add(codexThreadItemRecord(threadItem, ts), obj.type === "response_item" ? "response" : "event");
    return records;
  }
  const message = codexMessageFromPayload(payload);
  if (message) {
    add({
      kind: "message",
      role: message.role,
      ts,
      phase: str(payload.phase) || undefined,
      text: message.text,
    }, obj.type === "event_msg" ? "event" : obj.type === "response_item" ? "response" : undefined);
    return records;
  }
  if (obj.type === "event_msg"
    && (payloadType === "agent_reasoning" || payloadType === "reasoning" || payloadType === "reasoning_delta")) {
    add({ kind: "reasoning", role: "assistant", ts, text: str(payload.text) || str(payload.message) });
    return records;
  }
  if (obj.type === "response_item") {
    const nestedItem = recordOrNull(payload.item);
    const item = nestedItem && str(nestedItem.type) ? nestedItem : payload;
    const itemType = str(item.type);
    if (itemType === "reasoning") {
      const summary = arr(item.summary).map((part) => str(part.text)).filter(Boolean).join("\n");
      add({ kind: "reasoning", role: "assistant", ts, text: summary || str(item.text) || str(item.message) });
    } else if (itemType === "function_call" || itemType === "custom_tool_call") {
      const name = str(item.name);
      add({
        kind: "tool_call",
        role: "assistant",
        ts,
        ...(name ? { name } : {}),
        text: str(item.arguments) || str(item.input) || JSON.stringify(item),
      });
    } else if (itemType === "function_call_output" || itemType === "custom_tool_call_output") {
      const name = str(item.name);
      add({
        kind: "tool_result",
        role: "tool",
        ts,
        ...(name ? { name } : {}),
        text: textFromContent(item.output) || JSON.stringify(item),
      });
    } else if (itemType) {
      add({ kind: "trace", role: "system", ts, name: itemType, text: JSON.stringify(item) });
    }
    return records;
  }
  /* token_count is a usage envelope emitted after nearly every step; it is
     accounting, not conversation content, so it never becomes a trace. */
  if (["command_execution_output_delta", "file_change_output_delta", "file_change_patch_updated"].includes(payloadType)) {
    add({ kind: "trace", role: "system", ts, name: payloadType, text: compactRecordText(payload.delta ?? payload.changes) || payloadType });
    return records;
  }
  if (payloadType && !["token_count", "thread_settings_applied", "task_started"].includes(payloadType)) {
    add({ kind: "trace", role: "system", ts, name: payloadType, text: JSON.stringify(payload) });
  }
  return records;
}

/** Normalize one parsed JSONL object without reading or knowing its path. */
export function normalizeSessionLine(
  engine: Extract<Engine, "claude" | "codex">,
  obj: Record<string, unknown>,
): NormalizedSessionLine[] {
  return engine === "claude" ? normalizeClaudeLine(obj) : normalizeCodexLine(obj);
}

function readCodex(pathname: string): SessionReadResult {
  const out: SessionReadResult = { path: pathname, engine: "codex", messages: [], reasoning: [], tools: [], traces: [] };
  for (const obj of readJsonl(pathname)) {
    for (const normalized of normalizeCodexLine(obj)) push(out, normalized.record);
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
  /** Fingerprint window immediately preceding offset, proving append continuity. */
  boundaryOffset: number;
  boundaryBytes: number;
  boundaryFingerprint: string;
  prefixSegments: Array<{ offset: number; length: number; fingerprint: string }>;
  validation: { size: number; mtimeMs: number; index: number } | null;
  validatedGrowth: { size: number; mtimeMs: number } | null;
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
      // Truncation, replacement, or an in-place rewrite resets the checkpoint:
      // the recorded offset no longer describes this file's content. A changed
      // size may be an append and remains safe after validating the scanned prefix.
      const growing = stat.size > checkpoint.size;
      const growthAlreadyValidated = checkpoint.validatedGrowth?.size === stat.size
        && checkpoint.validatedGrowth.mtimeMs === stat.mtimeMs;
      let valid = checkpoint.dev === stat.dev
        && checkpoint.ino === stat.ino
        && stat.size >= checkpoint.offset
        && stat.size >= checkpoint.size
        && (stat.size !== checkpoint.size || stat.mtimeMs === checkpoint.mtimeMs)
        && (!growing || growthAlreadyValidated || Boolean(checkpoint.prefixSegments?.length));
      if (valid && growing && !growthAlreadyValidated) {
        const sameValidation = checkpoint.validation?.size === stat.size && checkpoint.validation.mtimeMs === stat.mtimeMs;
        let index = sameValidation ? checkpoint.validation!.index : 0;
        const segments = checkpoint.prefixSegments ?? [];
        while (index < segments.length && valid) {
          const segment = segments[index]!;
          if (options.signal?.aborted || authorshipAllowance(options, charged) < segment.length) {
            checkpoint.validation = { size: stat.size, mtimeMs: stat.mtimeMs, index };
            return { count: checkpoint.count, complete: false };
          }
          const bytes = Buffer.allocUnsafe(segment.length);
          const { bytesRead } = await file.read(bytes, 0, bytes.length, segment.offset);
          charge(bytesRead);
          valid = bytesRead === bytes.length && authorshipHeadFingerprint(bytes) === segment.fingerprint;
          index += 1;
        }
        if (valid) {
          const validatedStat = await file.stat();
          valid = validatedStat.dev === stat.dev
            && validatedStat.ino === stat.ino
            && validatedStat.size === stat.size
            && validatedStat.mtimeMs === stat.mtimeMs;
          if (valid) {
            checkpoint.validation = null;
            checkpoint.validatedGrowth = { size: stat.size, mtimeMs: stat.mtimeMs };
          }
        }
      }
      if (valid && checkpoint.headBytes > 0) {
        if (options.signal?.aborted) {
          return { count: checkpoint.count, complete: false };
        }
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
      if (valid && checkpoint.boundaryBytes > 0 && checkpoint.boundaryOffset > 0) {
        if (options.signal?.aborted) {
          return { count: checkpoint.count, complete: false };
        }
        if (authorshipAllowance(options, charged) < checkpoint.boundaryBytes) {
          return { count: checkpoint.count, complete: false };
        }
        const boundary = Buffer.allocUnsafe(checkpoint.boundaryBytes);
        let filled = 0;
        while (filled < boundary.length) {
          const { bytesRead } = await file.read(boundary, filled, boundary.length - filled, checkpoint.boundaryOffset + filled);
          if (bytesRead === 0) break;
          filled += bytesRead;
        }
        charge(filled);
        valid = filled === boundary.length && authorshipHeadFingerprint(boundary) === checkpoint.boundaryFingerprint;
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
    let boundaryOffset = checkpoint?.boundaryOffset ?? 0;
    let boundaryBytes = checkpoint?.boundaryBytes ?? 0;
    let boundaryFingerprint = checkpoint?.boundaryFingerprint ?? "";
    const prefixSegments = checkpoint?.prefixSegments ?? [];
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
        boundaryOffset,
        boundaryBytes,
        boundaryFingerprint,
        prefixSegments,
        validation: null,
        validatedGrowth: null,
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
      boundaryBytes = Math.min(bytesRead, AUTHORSHIP_CHECKPOINT_HEAD_BYTES);
      boundaryOffset = offset + bytesRead - boundaryBytes;
      boundaryFingerprint = authorshipHeadFingerprint(chunk.subarray(bytesRead - boundaryBytes, bytesRead));
      prefixSegments.push({ offset, length: bytesRead, fingerprint: authorshipHeadFingerprint(chunk.subarray(0, bytesRead)) });
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
