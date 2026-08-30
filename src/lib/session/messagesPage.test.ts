import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  decodeMessagesCursor,
  encodeMessagesCursor,
  messagesCursorScope,
  readMessagesPage,
  type MessagesPage,
  type MessagesPageCursor,
  type MessagesPageQuery,
} from "./messagesPage";
import type { SessionRecord, SessionRecordKind } from "./reader";

const scratch: string[] = [];
const ALL_KINDS = new Set<SessionRecordKind>(["message", "reasoning", "tool_call", "tool_result", "trace"]);
const ALL_ROLES = new Set<SessionRecord["role"]>(["user", "assistant", "system", "tool"]);

afterEach(() => {
  for (const directory of scratch.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function fixture(lines: unknown[], name = "session.jsonl"): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-messages-page-"));
  scratch.push(directory);
  const pathname = path.join(directory, name);
  fs.writeFileSync(pathname, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  return pathname;
}

function page(
  pathname: string,
  engine: "claude" | "codex",
  query: Partial<MessagesPageQuery> = {},
): MessagesPage {
  const descriptor = fs.openSync(pathname, "r");
  try {
    return readMessagesPage({ descriptor, size: fs.fstatSync(descriptor).size, engine }, {
      kinds: query.kinds ?? ALL_KINDS,
      roles: query.roles ?? ALL_ROLES,
      limit: query.limit ?? 200,
      maxChars: query.maxChars ?? 4_000,
      ...(query.since ? { since: query.since } : {}),
      ...(query.cursor ? { cursor: query.cursor } : {}),
    });
  } finally {
    fs.closeSync(descriptor);
  }
}

const times = [
  "2026-08-30T10:00:00.000Z",
  "2026-08-30T10:01:00.000Z",
  "2026-08-30T10:02:00.000Z",
  "2026-08-30T10:03:00.000Z",
] as const;

test("Claude and Codex produce the same normalized record shapes without envelope or hook noise", () => {
  const claude = fixture([
    { type: "attachment", attachment: { type: "async_hook_response", hookEvent: "PreToolUse", content: "hook noise" }, timestamp: times[0] },
    { type: "user", timestamp: times[0], message: { content: [{ type: "text", text: "question" }] } },
    { type: "assistant", timestamp: times[1], message: { content: [
      { type: "text", text: "answer" },
      { type: "thinking", thinking: "reasoning" },
      { type: "tool_use", name: "shell", input: { command: "status" } },
    ], usage: { input_tokens: 50 } } },
    { type: "user", timestamp: times[2], message: { content: [{ type: "tool_result", content: "result" }] } },
    { type: "compact", timestamp: times[3], summary: "trace" },
    { type: "system", timestamp: times[3], subtype: "stop_hook_summary", hookInfos: [{ command: "hook" }] },
  ], "claude.jsonl");
  const codex = fixture([
    { type: "session_meta", timestamp: times[0], payload: { id: "synthetic-session" } },
    { type: "response_item", timestamp: times[0], payload: { type: "message", role: "user", content: [{ type: "input_text", text: "question" }] } },
    { type: "event_msg", timestamp: times[0], payload: { type: "user_message", message: "question" } },
    { type: "response_item", timestamp: times[1], payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] } },
    { type: "event_msg", timestamp: times[1], payload: { type: "agent_message", message: "answer" } },
    { type: "event_msg", timestamp: times[1], payload: { type: "agent_reasoning", text: "reasoning" } },
    { type: "response_item", timestamp: times[1], payload: { type: "function_call", name: "shell", arguments: "{\"command\":\"status\"}" } },
    { type: "response_item", timestamp: times[2], payload: { type: "function_call_output", output: "result" } },
    { type: "event_msg", timestamp: times[3], payload: { type: "context_compacted", message: "trace" } },
    { type: "turn_context", timestamp: times[3], payload: { usage: { input_tokens: 50 } } },
  ], "codex.jsonl");

  const claudeRecords = page(claude, "claude").records;
  const codexRecords = page(codex, "codex").records;
  expect(claudeRecords.map((record) => record.kind).sort()).toEqual(codexRecords.map((record) => record.kind).sort());
  expect(claudeRecords.map((record) => record.role).sort()).toEqual(codexRecords.map((record) => record.role).sort());
  expect(claudeRecords.map((record) => Object.keys(record).filter((key) => key !== "part").sort()))
    .toEqual(codexRecords.map((record) => Object.keys(record).filter((key) => key !== "part").sort()));
  expect(JSON.stringify(claudeRecords)).not.toContain("hook noise");
  expect(JSON.stringify(codexRecords)).not.toContain("synthetic-session");
  expect(codexRecords.filter((record) => record.kind === "message")).toHaveLength(2);
});

test("filters apply before paging and since is an inclusive lower bound", () => {
  const pathname = fixture([
    { type: "user", timestamp: times[0], message: { content: "old user" } },
    { type: "assistant", timestamp: times[1], message: { content: [{ type: "thinking", thinking: "thought" }] } },
    { type: "assistant", timestamp: times[2], message: { content: [{ type: "text", text: "new assistant" }] } },
  ]);

  expect(page(pathname, "claude", {
    kinds: new Set(["message"]),
    roles: new Set(["assistant"]),
    since: times[1],
  }).records.map((record) => record.text)).toEqual(["new assistant"]);
  const empty = page(pathname, "claude", {
    kinds: new Set(["tool_call"]),
    roles: ALL_ROLES,
  });
  expect(empty.records).toEqual([]);
  expect(empty.hasMore).toBe(false);
  expect(empty.cursor).toBeNull();
});

test("cursor pages walk every record newest-first without repeats or gaps", () => {
  const pathname = fixture(Array.from({ length: 23 }, (_value, index) => ({
    type: index % 2 === 0 ? "user" : "assistant",
    timestamp: new Date(Date.parse(times[0]) + index * 1_000).toISOString(),
    message: { content: index % 2 === 0 ? `message-${index}` : [{ type: "text", text: `message-${index}` }] },
  })));
  const kinds = new Set<SessionRecordKind>(["message"]);
  const walked: string[] = [];
  let cursor: MessagesPageCursor | null = null;
  for (;;) {
    const current = page(pathname, "claude", { kinds, roles: ALL_ROLES, limit: 7, cursor });
    walked.push(...current.records.map((record) => record.text));
    if (!current.hasMore) break;
    expect(current.cursor).not.toBeNull();
    cursor = current.cursor;
  }
  expect(walked).toEqual(Array.from({ length: 23 }, (_value, index) => `message-${22 - index}`));
  expect(new Set(walked).size).toBe(walked.length);
});

test("Codex message twins collapse when their representations straddle a page boundary", () => {
  const pathname = fixture([
    { type: "event_msg", timestamp: times[0], payload: { type: "agent_message", message: "older" } },
    { type: "response_item", timestamp: times[0], payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "older" }] } },
    { type: "response_item", timestamp: times[1], payload: { type: "message", role: "user", content: [{ type: "input_text", text: "newer" }] } },
    { type: "event_msg", timestamp: times[1], payload: { type: "user_message", message: "newer" } },
  ], "codex-twins.jsonl");
  const walked: string[] = [];
  let cursor: MessagesPageCursor | null = null;
  for (;;) {
    const current = page(pathname, "codex", {
      kinds: new Set(["message"]),
      roles: ALL_ROLES,
      limit: 1,
      cursor,
    });
    walked.push(...current.records.map((record) => record.text));
    if (!current.hasMore) break;
    cursor = current.cursor;
  }
  expect(walked).toEqual(["newer", "older"]);
});

test("multiple records from one line resume at the exact part", () => {
  const pathname = fixture([{
    type: "assistant",
    timestamp: times[0],
    message: { content: [
      { type: "text", text: "first" },
      { type: "thinking", thinking: "second" },
      { type: "tool_use", name: "shell", input: { command: "third" } },
    ] },
  }]);
  const first = page(pathname, "claude", { limit: 1 });
  const second = page(pathname, "claude", { limit: 1, cursor: first.cursor });
  const third = page(pathname, "claude", { limit: 1, cursor: second.cursor });
  expect([...first.records, ...second.records, ...third.records].map((record) => record.text))
    .toEqual(["{\"command\":\"third\"}", "second", "first"]);
  expect(third.hasMore).toBe(false);
});

test("limit and text bounds clamp while full-text redaction runs before truncation", () => {
  const sensitive = `${["api", "key"].join("_")}=fixture-value`;
  const pathname = fixture(Array.from({ length: 250 }, (_value, index) => ({
    type: "assistant",
    timestamp: times[0],
    message: { content: [{ type: "text", text: `${index}:${sensitive} ${"tail ".repeat(20)}` }] },
  })));
  const result = page(pathname, "claude", { limit: 999, maxChars: 40 });
  expect(result.records).toHaveLength(200);
  expect(result.records.every((record) => record.text.length <= 40)).toBe(true);
  expect(result.records.every((record) => record.truncated === true)).toBe(true);
  expect(JSON.stringify(result.records)).not.toContain("fixture-value");
  expect(JSON.stringify(result.records)).toContain("[redacted]");
});

test("cursor tokens are opaque and scoped to transcript plus filters", () => {
  const kinds = new Set<SessionRecordKind>(["message"]);
  const scope = messagesCursorScope("fixture/session.jsonl", kinds, ALL_ROLES);
  const cursor = { o: 42, p: 1, r: [] };
  const token = encodeMessagesCursor(cursor, scope);
  expect(decodeMessagesCursor(token, scope)).toEqual(cursor);
  expect(() => decodeMessagesCursor(token, messagesCursorScope("fixture/other.jsonl", kinds, ALL_ROLES)))
    .toThrow("cursor is invalid");
});
