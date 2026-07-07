import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { FileEntry } from "../types";

const processes: Array<{
  pid: number;
  engine: "claude" | "codex";
  argv: string[];
  cwd: string;
  tty: number;
}> = [];

mock.module("./process", () => ({
  agentProcesses: () => processes,
  argvEngine: (argv: string[]) => {
    const joined = argv.join(" ");
    if (joined.includes("claude")) return "claude";
    if (joined.includes("codex")) return "codex";
    return null;
  },
  isHelperArgv: () => false,
  pidAlive: (pid: number) => processes.some((proc) => proc.pid === pid),
  pidWritesPath: () => false,
  readArgv: (pid: number) => processes.find((proc) => proc.pid === pid)?.argv ?? [],
  readCwd: (pid: number) => processes.find((proc) => proc.pid === pid)?.cwd ?? null,
  writingHolders: () => new Map<string, number>(),
}));

const { assignTranscriptPids } = await import("./transcripts");

function entry(pathname: string, overrides: Partial<FileEntry> = {}): FileEntry {
  return {
    path: pathname,
    root: pathname.includes(".codex/sessions") ? "codex-sessions" : "claude-projects",
    name: pathname,
    project: "proj",
    title: "",
    engine: pathname.includes(".codex/sessions") ? "codex" : "claude",
    kind: "session",
    fmt: pathname.includes(".codex/sessions") ? "codex" : "claude",
    parent: null,
    mtime: 0,
    size: 1,
    activity: "recent",
    proc: null,
    pid: null,
    model: null,
    pendingQuestion: null,
    waitingInput: null,
    ...overrides,
  };
}

describe("assignTranscriptPids", () => {
  beforeEach(() => {
    processes.length = 0;
  });

  test("matches a Claude resume process to its transcript and leaves cwd sibling untouched", () => {
    const oldPath = "/home/user/.claude/projects/-repo/8bc24ea9-2956-4e74-a1b5-db839d5956b1.jsonl";
    const resumedId = "199e8e95-0e87-4b4f-84bf-f62b3c0993a3";
    const resumedPath = `/home/user/.claude/projects/-repo/${resumedId}.jsonl`;
    processes.push({
      pid: 1841611,
      engine: "claude",
      argv: ["/home/user/.bun/bin/claude", "--dangerously-skip-permissions", "--resume", resumedId],
      cwd: "/repo",
      tty: 1,
    });

    const oldEntry = entry(oldPath, { activity: "recent" });
    const resumedEntry = entry(resumedPath, { activity: "idle" });
    assignTranscriptPids([oldEntry, resumedEntry]);

    expect(oldEntry.pid).toBeNull();
    expect(oldEntry.proc).toBeNull();
    expect(resumedEntry.pid).toBe(1841611);
    expect(resumedEntry.proc).toBe("running");
    expect(resumedEntry.activity).toBe("idle");
  });

  test("matches a Codex resume process by the resume subcommand id", () => {
    const id = "019f3be9-8edf-7c53-bf70-1f2737957526";
    const pathname = `/home/user/.codex/sessions/2026/07/07/rollout-2026-07-07T12-29-50-${id}.jsonl`;
    processes.push({
      pid: 1876135,
      engine: "codex",
      argv: ["/home/user/.local/bin/codex", "resume", id],
      cwd: "/repo",
      tty: 1,
    });

    const file = entry(pathname, { activity: "idle" });
    assignTranscriptPids([file]);

    expect(file.pid).toBe(1876135);
    expect(file.proc).toBe("running");
    expect(file.activity).toBe("idle");
  });
});
