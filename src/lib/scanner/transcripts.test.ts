import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { FileEntry } from "../types";

const processes: Array<{
  pid: number;
  engine: "claude" | "codex";
  argv: string[];
  cwd: string;
  tty: number;
}> = [];

// Path → holder pid, populated per test to simulate a process keeping a
// transcript's rollout open for writing.
let holderMap = new Map<string, number>();

mock.module("./process", () => ({
  agentProcesses: () => processes,
  argvEngine: (argv: string[]) => {
    const joined = argv.join(" ");
    if (joined.includes("claude")) return "claude";
    if (joined.includes("codex")) return "codex";
    return null;
  },
  isHelperArgv: () => false,
  outputHolders: () => new Map(),
  pidAlive: (pid: number) => processes.some((proc) => proc.pid === pid),
  pidHoldsPath: () => false,
  pidWritesPath: () => false,
  readArgv: (pid: number) => processes.find((proc) => proc.pid === pid)?.argv ?? [],
  readCmdlineText: () => "",
  readCwd: (pid: number) => processes.find((proc) => proc.pid === pid)?.cwd ?? null,
  readEnvVar: () => null,
  readPpid: () => null,
  writingHolders: (paths: Iterable<string>) => {
    const out = new Map<string, number>();
    for (const pathname of paths) {
      const pid = holderMap.get(pathname);
      if (pid !== undefined) out.set(pathname, pid);
    }
    return out;
  },
}));

const { assignTranscriptPids, claudeSubagentOwnerPath, transcriptProcessOwnsEntry } = await import("./transcripts");

test("a Claude subagent resolves to the top-level session that owns its writer", () => {
  const root = "/home/u/.claude/projects";
  expect(claudeSubagentOwnerPath(
    "/home/u/.claude/projects/project/session-1/subagents/agent-child.jsonl",
    root,
  )).toBe("/home/u/.claude/projects/project/session-1.jsonl");
  expect(claudeSubagentOwnerPath("/home/u/.claude/projects/project/session-1.jsonl", root)).toBeNull();
});

test("destructive checks recognize an idle Claude session through uncapped cwd ownership", () => {
  const pathname = "/home/user/.claude/projects/-repo/idle-session.jsonl";
  const file = entry(pathname, { activity: "idle" });
  const proc = { pid: 4401, engine: "claude" as const, argv: ["claude"], cwd: "/repo", tty: 1 };
  processes.push(proc);

  expect(transcriptProcessOwnsEntry(file, proc, "claude:-repo")).toBe(true);
});

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
    holderMap = new Map<string, number>();
  });

  test("never assigns one writing-holder pid to two transcripts", () => {
    // A single codex process keeps both its resumed-from original and the fresh
    // rollout open for writing. Attributing that pid to both transcripts would
    // route two conversations into the one pane the pid lives in.
    const pid = 3409423;
    const freshPath = "/home/user/.codex/sessions/2026/07/08/rollout-fresh-a6f79fdb.jsonl";
    const oldPath = "/home/user/.codex/sessions/2026/07/07/rollout-old-b1c2d3e4.jsonl";
    processes.push({
      pid,
      engine: "codex",
      argv: ["/home/user/.local/bin/codex", "resume"],
      cwd: "/repo",
      tty: 1,
    });
    holderMap.set(freshPath, pid);
    holderMap.set(oldPath, pid);

    // Fresh entry first (scanner delivers entries mtime-desc).
    const fresh = entry(freshPath, { mtime: 200 });
    const old = entry(oldPath, { mtime: 100 });
    assignTranscriptPids([fresh, old]);

    expect(fresh.pid).toBe(pid);
    expect(fresh.proc).toBe("running");
    expect(old.pid).toBeNull();
    expect(old.proc).toBeNull();
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
