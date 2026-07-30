import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { FileEntry } from "../types";
import { pendingQuestionFor } from "./questions";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-questions-test-"));
afterAll(() => fs.rmSync(SANDBOX, { recursive: true, force: true }));

function entry(records: unknown[]): FileEntry {
  const pathname = path.join(SANDBOX, `${crypto.randomUUID()}.jsonl`);
  fs.writeFileSync(pathname, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
  const stat = fs.statSync(pathname);
  return {
    path: pathname,
    root: "claude-projects",
    name: path.basename(pathname),
    project: "project",
    title: "session",
    engine: "claude",
    kind: "session",
    fmt: "claude",
    parent: null,
    mtime: stat.mtimeMs / 1000,
    size: stat.size,
    activity: "live",
    proc: "running",
    pid: 42,
    model: null,
    pendingQuestion: null,
    waitingInput: null,
  };
}

function questionRecord(id = "question-1") {
  return {
    type: "assistant",
    timestamp: "2026-07-30T10:00:00.000Z",
    message: {
      role: "assistant",
      content: [{
        type: "tool_use",
        id,
        name: "AskUserQuestion",
        input: {
          questions: [{
            header: "Scope",
            question: "Which scope?",
            options: [{ label: "Focused", description: "Use the focused scope." }],
          }],
        },
      }],
    },
  };
}

function planRecord(id = "plan-1") {
  return {
    type: "assistant",
    timestamp: "2026-07-30T10:00:00.000Z",
    message: {
      role: "assistant",
      content: [{
        type: "tool_use",
        id,
        name: "ExitPlanMode",
        input: { plan: "Implement the focused change." },
      }],
    },
  };
}

describe("pendingQuestionFor", () => {
  test("retires a question after a later genuine user message", () => {
    expect(pendingQuestionFor(entry([
      questionRecord(),
      {
        type: "user",
        timestamp: "2026-07-30T10:00:01.000Z",
        message: { role: "user", content: "Continue with the focused scope." },
      },
    ]))).toBeNull();
  });

  test("keeps an unanswered question pending through later assistant and tool events", () => {
    const pending = pendingQuestionFor(entry([
      questionRecord(),
      {
        type: "assistant",
        timestamp: "2026-07-30T10:00:01.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "Checking context." }] },
      },
      {
        type: "assistant",
        timestamp: "2026-07-30T10:00:02.000Z",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "read-1", name: "Read", input: { file_path: "src/example.ts" } }],
        },
      },
    ]));

    expect(pending?.toolUseId).toBe("question-1");
  });

  test("does not treat an injected interruption sentinel as human input", () => {
    const pending = pendingQuestionFor(entry([
      questionRecord(),
      {
        type: "user",
        timestamp: "2026-07-30T10:00:01.000Z",
        message: { role: "user", content: "[Request interrupted by user for tool use]" },
      },
    ]));

    expect(pending?.toolUseId).toBe("question-1");
  });

  test("keeps the existing tool-result answer path retired", () => {
    expect(pendingQuestionFor(entry([
      questionRecord(),
      {
        type: "user",
        timestamp: "2026-07-30T10:00:01.000Z",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "question-1", content: "Focused" }],
        },
      },
    ]))).toBeNull();
  });

  test("retires an interrupted question after a later user directive", () => {
    expect(pendingQuestionFor(entry([
      questionRecord(),
      {
        type: "user",
        timestamp: "2026-07-30T10:00:01.000Z",
        message: { role: "user", content: "[Request interrupted by user for tool use]" },
      },
      {
        type: "user",
        timestamp: "2026-07-30T10:00:02.000Z",
        message: { role: "user", content: [{ type: "text", text: "Proceed without the optional step." }] },
      },
    ]))).toBeNull();
  });

  test("retires an ExitPlanMode interaction after a later genuine user message", () => {
    expect(pendingQuestionFor(entry([
      planRecord(),
      {
        type: "user",
        timestamp: "2026-07-30T10:00:01.000Z",
        message: { role: "user", content: "Implement it." },
      },
    ]))).toBeNull();
  });

  test("recognizes human input following an injected system reminder", () => {
    expect(pendingQuestionFor(entry([
      questionRecord(),
      {
        type: "user",
        timestamp: "2026-07-30T10:00:01.000Z",
        promptSource: "typed",
        origin: { kind: "human" },
        message: {
          role: "user",
          content: "<system-reminder>Queued while the agent was working.</system-reminder>\n\nProceed.",
        },
      },
    ]))).toBeNull();
  });

  test("invalidates a cached pending question when later user input changes the file identity", () => {
    const original = entry([questionRecord()]);
    expect(pendingQuestionFor(original)?.toolUseId).toBe("question-1");

    fs.appendFileSync(original.path, JSON.stringify({
      type: "user",
      timestamp: "2026-07-30T10:00:01.000Z",
      message: { role: "user", content: "Proceed." },
    }) + "\n");
    const stat = fs.statSync(original.path);

    expect(pendingQuestionFor({
      ...original,
      size: stat.size,
      mtime: stat.mtimeMs / 1000,
    })).toBeNull();
  });

  test.each([
    ["isMeta user", { type: "user", isMeta: true, message: { role: "user", content: "Injected context." } }],
    ["sidechain user", { type: "user", isSidechain: true, message: { role: "user", content: [{ type: "text", text: "Subagent input." }] } }],
    ["last-prompt", { type: "last-prompt", lastPrompt: "Bookkeeping." }],
    ["ai-title", { type: "ai-title", aiTitle: "Bookkeeping." }],
    ["mode", { type: "mode", mode: "default" }],
    ["queue-operation", { type: "queue-operation", operation: "enqueue", content: "Bookkeeping." }],
    ["system reminder", { type: "user", message: { role: "user", content: "<system-reminder>Injected context.</system-reminder>" } }],
    ["unrelated tool result", {
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "read-1", content: "Done" }],
      },
    }],
  ] as const)("keeps the question pending after a metadata-only %s record", (_label, follower) => {
    expect(pendingQuestionFor(entry([questionRecord(), follower]))?.toolUseId).toBe("question-1");
  });
});
