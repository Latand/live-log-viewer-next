import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { FileEntry } from "@/lib/types";

process.env.LLV_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "llv-task-inbox-test-"));
const { collectTaskCandidates, taskTextFromPrompt } = await import("./inboxScanner");

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-task-inbox-files-"));

afterAll(() => {
  fs.rmSync(process.env.LLV_STATE_DIR!, { recursive: true, force: true });
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

function file(pathname: string, overrides: Partial<FileEntry> = {}): FileEntry {
  return {
    path: pathname,
    root: "claude-projects",
    name: path.basename(pathname),
    project: "proj",
    title: "Claude Session",
    engine: "claude",
    kind: "session",
    fmt: "claude",
    parent: null,
    mtime: Date.now() / 1000,
    size: fs.statSync(pathname).size,
    activity: "idle",
    proc: null,
    pid: null,
    model: null,
    pendingQuestion: null,
    waitingInput: null,
    ...overrides,
  };
}

function writeJsonl(name: string, rows: unknown[]): string {
  const pathname = path.join(SANDBOX, name);
  fs.writeFileSync(pathname, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
  return pathname;
}

describe("task inbox scanner", () => {
  test("extracts task text from a spoken prompt after injected context", () => {
    const text = taskTextFromPrompt(
      "# AGENTS.md instructions\nnoise\n</INSTRUCTIONS><environment_context>x</environment_context>\n\nЯ бы хотел, чтобы ты э-э-э создал автоматизацию для Agent Log Viewer.",
    );
    expect(text).toContain("Создать автоматизацию");
    expect(text).not.toContain("AGENTS.md");
    expect(text).not.toContain("\n");
    expect(text!.length).toBeLessThanOrEqual(96);
  });

  test("collects task-like user messages and skips service prompts", () => {
    const pathname = writeJsonl("claude.jsonl", [
      {
        type: "user",
        timestamp: "2026-07-08T10:00:00.000Z",
        message: { content: [{ type: "text", text: "<system-reminder>keep going</system-reminder>" }] },
      },
      {
        type: "user",
        timestamp: "2026-07-08T10:01:00.000Z",
        message: { content: [{ type: "text", text: "Please implement hourly task capture in the viewer." }] },
      },
      {
        type: "assistant",
        timestamp: "2026-07-08T10:02:00.000Z",
        message: { content: [{ type: "text", text: "Done." }] },
      },
    ]);
    const candidates = collectTaskCandidates([file(pathname)], 0, new Set());
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.text).toContain("Implement hourly task capture");
    expect(candidates[0]?.source.engine).toBe("claude");

    const skipped = collectTaskCandidates([file(pathname)], 0, new Set([candidates[0]!.source.fingerprint]));
    expect(skipped).toHaveLength(0);
  });

  test("does not create tasks from Claude tool results stored as user records", () => {
    const pathname = writeJsonl("claude-tool-results.jsonl", [
      {
        type: "user",
        timestamp: "2026-07-08T10:00:00.000Z",
        message: {
          content: [{ type: "tool_result", tool_use_id: "tool-1", content: "Please implement these seven issues from command output" }],
        },
      },
    ]);
    expect(collectTaskCandidates([file(pathname)], 0, new Set())).toEqual([]);
  });
});
