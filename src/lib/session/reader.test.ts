import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { readSession, scanUserAuthoredMessages } from "./reader";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-session-reader-"));

afterAll(() => {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

function writeJsonl(name: string, rows: unknown[]): string {
  const pathname = path.join(SANDBOX, name);
  fs.writeFileSync(pathname, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
  return pathname;
}

describe("readSession", () => {
  test("splits Claude text, thinking and tools", () => {
    const pathname = writeJsonl("claude.jsonl", [
      { type: "user", timestamp: "t1", message: { content: "Create a task" } },
      {
        type: "assistant",
        timestamp: "t2",
        message: {
          content: [
            { type: "thinking", thinking: "Need a file" },
            { type: "tool_use", name: "Read", input: { file_path: "a.ts" } },
            { type: "text", text: "I will edit it." },
          ],
        },
      },
    ]);
    const result = readSession(pathname, "claude");
    expect(result.messages.map((item) => item.text)).toEqual(["Create a task", "I will edit it."]);
    expect(result.reasoning[0]?.text).toBe("Need a file");
    expect(result.tools[0]?.name).toBe("Read");
  });

  test("keeps Claude tool_result user records out of visible user messages", () => {
    const pathname = writeJsonl("claude-tool-result.jsonl", [
      { type: "user", timestamp: "t1", message: { content: "Create a task" } },
      {
        type: "user",
        timestamp: "t2",
        message: {
          content: [{ type: "tool_result", tool_use_id: "tool-1", content: "implement this from command output" }],
        },
      },
    ]);
    const result = readSession(pathname, "claude");
    expect(result.messages.map((item) => item.text)).toEqual(["Create a task"]);
    expect(result.tools.map((item) => item.text)).toEqual(["implement this from command output"]);
  });

  test("reads Codex event messages separately from traces", () => {
    const pathname = writeJsonl("codex.jsonl", [
      { type: "event_msg", timestamp: "t1", payload: { type: "user_message", message: "Fix the tests" } },
      { type: "event_msg", timestamp: "t2", payload: { type: "agent_message", message: "Fixed.", phase: "final_answer" } },
      { type: "event_msg", timestamp: "t3", payload: { type: "turn_complete" } },
    ]);
    const result = readSession(pathname, "codex");
    expect(result.messages.map((item) => item.text)).toEqual(["Fix the tests", "Fixed."]);
    expect(result.traces[0]?.name).toBe("turn_complete");
  });
});

test("authorship scan reports malformed and oversized records as incomplete", () => {
  const malformed = writeJsonl("malformed-authorship.jsonl", [{ type: "event_msg", payload: { type: "agent_message", message: "ok" } }]);
  fs.appendFileSync(malformed, "{broken\n");
  expect(scanUserAuthoredMessages(malformed, "codex", 1)).toEqual({ count: 0, complete: false });

  const oversized = path.join(SANDBOX, "oversized-authorship.jsonl");
  fs.writeFileSync(oversized, JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "x".repeat(8 * 1024 * 1024 + 1) } }) + "\n");
  expect(scanUserAuthoredMessages(oversized, "codex", 1)).toEqual({ count: 0, complete: false });
});

test("Claude task notifications stay outside human authorship", () => {
  const pathname = writeJsonl("claude-task-notification-authorship.jsonl", [
    {
      type: "user",
      promptSource: "system",
      origin: { kind: "task-notification" },
      message: { content: "Automated task completed" },
    },
    {
      type: "user",
      origin: "task",
      message: { content: "Legacy automated task completed" },
    },
    {
      type: "user",
      message: { content: "<task-notification>\nWrapper automated task completed\n</task-notification>" },
    },
    {
      type: "user",
      promptSource: "future-source",
      origin: { kind: "unknown" },
      message: { content: "Conservatively treated as human" },
    },
  ]);

  expect(scanUserAuthoredMessages(pathname, "claude", 4)).toEqual({ count: 1, complete: true });
});
