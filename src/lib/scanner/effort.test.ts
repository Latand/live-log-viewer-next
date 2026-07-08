import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { FileEntry } from "../types";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-effort-test-"));
let argvByPid = new Map<number, string[]>();

mock.module("./process", () => ({
  agentProcesses: () => [],
  argvEngine: () => null,
  isHelperArgv: () => false,
  outputHolders: () => new Map(),
  pidAlive: () => false,
  pidHoldsPath: () => false,
  pidWritesPath: () => false,
  readArgv: (pid: number) => argvByPid.get(pid) ?? [],
  readCmdlineText: () => "",
  readCwd: () => null,
  readEnvVar: () => null,
  readPpid: () => null,
  writingHolders: () => new Map(),
}));

const { entryEffort } = await import("./effort");

afterAll(() => {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

beforeEach(() => {
  argvByPid = new Map();
});

function entry(pathname: string, overrides: Partial<FileEntry> = {}): FileEntry {
  return {
    path: pathname,
    root: pathname.includes(".codex") ? "codex-sessions" : "claude-projects",
    name: path.basename(pathname),
    project: "proj",
    title: "agent",
    engine: pathname.includes(".codex") ? "codex" : "claude",
    kind: "session",
    fmt: pathname.includes(".codex") ? "codex" : "claude",
    parent: null,
    mtime: 1,
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
  fs.mkdirSync(path.dirname(pathname), { recursive: true });
  fs.writeFileSync(pathname, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  return pathname;
}

describe("entryEffort", () => {
  test("reads Claude thinking blocks from JSONL when argv has no explicit effort", () => {
    const pathname = writeJsonl("claude-thinking.jsonl", [
      {
        type: "assistant",
        message: {
          content: [
            { type: "thinking", thinking: "", signature: "sig" },
            { type: "text", text: "done" },
          ],
        },
      },
    ]);

    expect(entryEffort(entry(pathname))).toBe("high");
  });

  test("keeps explicit Claude argv effort ahead of JSONL thinking fallback", () => {
    const pathname = writeJsonl("claude-argv.jsonl", [
      {
        type: "assistant",
        message: { content: [{ type: "thinking", thinking: "", signature: "sig" }] },
      },
    ]);
    argvByPid.set(42, ["claude", "--effort", "max"]);

    expect(entryEffort(entry(pathname, { pid: 42 }))).toBe("max");
  });
});
