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

/* OpenClaw fixtures (#1207). Every id and level below is invented. */
describe("entryEffort for OpenClaw", () => {
  function openclawEntry(name: string, rows: unknown[]): FileEntry {
    const pathname = writeJsonl(name, rows);
    return entry(pathname, { root: "openclaw-sessions", engine: "openclaw", fmt: "openclaw" });
  }
  const thinkingLevel = (level: string, id: string) => ({
    type: "thinking_level_change",
    id,
    parentId: "oc-parent",
    timestamp: "2026-08-27T09:00:00.000Z",
    thinkingLevel: level,
  });

  test("reads the latest thinking_level_change", () => {
    expect(entryEffort(openclawEntry("openclaw-effort.jsonl", [
      { type: "session", version: 3, id: "oc-session-alpha", timestamp: "2026-08-27T08:59:00.000Z", cwd: SANDBOX },
      thinkingLevel("low", "oc-level-1"),
      thinkingLevel("high", "oc-level-2"),
    ]))).toBe("high");
  });

  test("accepts the two tiers only OpenClaw has", () => {
    expect(entryEffort(openclawEntry("openclaw-off.jsonl", [thinkingLevel("off", "oc-level-off")]))).toBe("off");
    expect(entryEffort(openclawEntry("openclaw-adaptive.jsonl", [thinkingLevel("adaptive", "oc-level-adaptive")])))
      .toBe("adaptive");
  });

  test("an unrecognised level reports no effort", () => {
    expect(entryEffort(openclawEntry("openclaw-unknown.jsonl", [thinkingLevel("turbo", "oc-level-unknown")])))
      .toBeNull();
  });
});

describe("entryEffort for Grok", () => {
  test("reads reasoning_effort from summary.json", () => {
    const dir = path.join(SANDBOX, "grok-session");
    fs.mkdirSync(dir, { recursive: true });
    const pathname = path.join(dir, "chat_history.jsonl");
    fs.writeFileSync(pathname, JSON.stringify({ type: "user", content: "hello" }) + "\n");
    fs.writeFileSync(path.join(dir, "summary.json"), JSON.stringify({ reasoning_effort: "high" }));
    expect(entryEffort(entry(pathname, { root: "grok-sessions", engine: "grok", fmt: "grok" }))).toBe("high");
  });
});
