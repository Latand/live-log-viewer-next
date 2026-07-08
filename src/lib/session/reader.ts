import fs from "node:fs";

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
