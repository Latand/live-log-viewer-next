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

  test("reads modern Codex response-item text and stops authorship scanning at the first user record", () => {
    const pathname = path.join(SANDBOX, "codex-modern-input-text.jsonl");
    const firstRows = [
      { type: "session_meta", payload: { id: "session-modern" } },
      {
        type: "response_item",
        timestamp: "t1",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Fix the production queue" }],
        },
      },
    ];
    fs.writeFileSync(pathname, firstRows.map((row) => JSON.stringify(row)).join("\n") + "\n");
    fs.appendFileSync(pathname, JSON.stringify({
      type: "response_item",
      timestamp: "t2",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "x".repeat(1024 * 1024) }],
      },
    }) + "\n");

    const originalOpen = fs.openSync;
    const originalRead = fs.readSync;
    let targetFd: number | null = null;
    let bytesRead = 0;
    fs.openSync = ((...args: Parameters<typeof fs.openSync>) => {
      const fd = originalOpen(...args);
      if (String(args[0]) === pathname) targetFd = fd;
      return fd;
    }) as typeof fs.openSync;
    fs.readSync = ((...args: Parameters<typeof fs.readSync>) => {
      const read = originalRead(...args);
      if (args[0] === targetFd) bytesRead += read;
      return read;
    }) as typeof fs.readSync;
    try {
      expect(scanUserAuthoredMessages(pathname, "codex", 1)).toEqual({ count: 1, complete: true });
    } finally {
      fs.openSync = originalOpen;
      fs.readSync = originalRead;
    }

    expect(bytesRead).toBeLessThanOrEqual(64 * 1024);
    expect(readSession(pathname, "codex").messages.map((item) => item.text)).toEqual([
      "Fix the production queue",
      "x".repeat(1024 * 1024),
    ]);
  });

  test("preserves current direct and nested Codex tool calls, output content, and commentary chronology", () => {
    const pathname = path.join(import.meta.dir, "fixtures", "codex-response-items-issue-626.jsonl");
    const result = readSession(pathname, "codex");

    expect(result.messages.map(({ role, phase, text }) => ({ role, phase, text }))).toEqual([
      {
        role: "assistant",
        phase: "commentary",
        text: "First commentary survives the tool transition.",
      },
      {
        role: "assistant",
        phase: "commentary",
        text: "Second commentary follows the tool output.",
      },
    ]);
    expect(result.tools.map(({ kind, name, text }) => ({ kind, name, text }))).toEqual([
      {
        kind: "tool_call",
        name: "exec",
        text: "await tools.exec_command({cmd:\"printf issue-626\"});",
      },
      {
        kind: "tool_result",
        name: undefined,
        text: "Script completed\nTOOL_OUTPUT_626\nauthorization: Bearer issue626_fixture_token",
      },
      {
        kind: "tool_call",
        name: "update_plan",
        text: "{\"plan\":[{\"step\":\"Capture chronology\",\"status\":\"completed\"}]}",
      },
      {
        kind: "tool_result",
        name: undefined,
        text: "Plan updated",
      },
      {
        kind: "tool_call",
        name: "nested_probe",
        text: "{\"path\":\"/workspace/redacted\"}",
      },
      {
        kind: "tool_result",
        name: undefined,
        text: "Nested output preserved",
      },
    ]);
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
