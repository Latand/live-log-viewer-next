import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { FileEntry } from "../types";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-links-test-"));
const REAL_STATE = process.env.LLV_STATE_DIR;
process.env.LLV_STATE_DIR = SANDBOX;

let parentByPid = new Map<number, number | null>();
let livePids = new Set<number>();

mock.module("./process", () => ({
  agentProcesses: () => [],
  argvEngine: (argv: string[]) => {
    const head = argv.slice(0, 2).map((token) => path.basename(token));
    if (head.includes("claude") || head.includes("claude.exe")) return "claude";
    if (head.includes("codex") || head.includes("codex.exe")) return "codex";
    return null;
  },
  isHelperArgv: () => false,
  outputHolders: () => new Map(),
  pidHoldsPath: () => false,
  pidAlive: (pid: number) => livePids.has(pid),
  pidWritesPath: () => false,
  readArgv: () => [],
  readCmdlineText: () => "",
  readCwd: () => null,
  readEnvVar: () => null,
  readPpid: (pid: number) => parentByPid.get(pid) ?? null,
  writingHolders: () => new Map(),
}));

const { linkEntries } = await import("./links");
const { normalizeHandoffLineageStore } = await import("../handoffLineage");

afterAll(() => {
  if (REAL_STATE !== undefined) process.env.LLV_STATE_DIR = REAL_STATE;
  else delete process.env.LLV_STATE_DIR;
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

function entry(pathname: string, overrides: Partial<FileEntry> = {}): FileEntry {
  const root = pathname.includes(".codex") ? "codex-sessions" : "claude-projects";
  return {
    path: pathname,
    root,
    name: pathname,
    project: "proj",
    title: "",
    engine: root === "codex-sessions" ? "codex" : "claude",
    kind: "session",
    fmt: root === "codex-sessions" ? "codex" : "claude",
    parent: null,
    mtime: 1,
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

function writeJsonl(pathname: string, rows: unknown[]): void {
  fs.mkdirSync(path.dirname(pathname), { recursive: true });
  fs.writeFileSync(pathname, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
}

describe("linkEntries", () => {
  beforeEach(() => {
    parentByPid = new Map();
    livePids = new Set();
  });

  test("links a Codex rollout to its live Codex ancestor", async () => {
    const parent = entry("/home/user/.codex/sessions/parent.jsonl", { pid: 100 });
    const child = entry("/home/user/.codex/sessions/child.jsonl", { pid: 300 });
    livePids = new Set([100, 200, 300]);
    parentByPid = new Map([
      [300, 200],
      [200, 100],
      [100, null],
    ]);

    await linkEntries([parent, child]);

    expect(child.parent as string | null).toBe(parent.path);
  });

  test("reuses remembered Codex lineage after processes exit", async () => {
    const parent = entry("/home/user/.codex/sessions/remembered-parent.jsonl", { pid: 110 });
    const child = entry("/home/user/.codex/sessions/remembered-child.jsonl", { pid: 310 });
    livePids = new Set([110, 210, 310]);
    parentByPid = new Map([
      [310, 210],
      [210, 110],
      [110, null],
    ]);

    await linkEntries([parent, child]);
    child.parent = null;
    child.pid = null;
    parentByPid = new Map();
    livePids = new Set();

    await linkEntries([parent, child]);

    const rememberedParent: unknown = child.parent;
    expect(rememberedParent).toBe(parent.path);
  });

  test("keeps explicit handoff child links even before the child file exists", () => {
    const child = path.join(SANDBOX, "future-child.jsonl");
    const parent = path.join(SANDBOX, "parent.jsonl");
    const normalized = normalizeHandoffLineageStore({
      children: { [child]: parent },
      conversationChildren: { conversation_child: "conversation_parent" },
    }, () => false);

    expect(normalized.children.get(child)).toBe(parent);
    expect(normalized.conversationChildren.get("conversation_child")).toBe("conversation_parent");
  });

  test("links a native Codex spawn_agent child through parent_thread_id metadata", async () => {
    const parentId = "019f421e-02e1-73e0-9b77-bebde063f10a";
    const childId = "019f423a-d6e9-7903-b597-3e676b6ff3d4";
    const parentPath = path.join(SANDBOX, ".codex", "sessions", "parent", `rollout-parent-${parentId}.jsonl`);
    const childPath = path.join(SANDBOX, ".codex", "sessions", "child", `rollout-child-${childId}.jsonl`);
    writeJsonl(parentPath, [{ type: "session_meta", payload: { id: parentId, cwd: "/repo" } }]);
    writeJsonl(childPath, [
      {
        type: "session_meta",
        payload: {
          id: childId,
          parent_thread_id: parentId,
          cwd: "/repo",
          thread_source: "subagent",
          source: { subagent: { thread_spawn: { parent_thread_id: parentId, agent_nickname: "Kierkegaard" } } },
        },
      },
    ]);
    const parent = entry(parentPath, { size: fs.statSync(parentPath).size });
    const child = entry(childPath, { size: fs.statSync(childPath).size });

    await linkEntries([child, parent]);

    expect(child.parent as string | null).toBe(parent.path);
  });

  test("links a native Codex spawn_agent child through nested thread_spawn metadata", async () => {
    const parentId = "019f421e-02e1-73e0-9b77-bebde063f10b";
    const childId = "019f423a-d6e9-7903-b597-3e676b6ff3d5";
    const parentPath = path.join(SANDBOX, ".codex", "sessions", "parent-nested", `rollout-parent-${parentId}.jsonl`);
    const childPath = path.join(SANDBOX, ".codex", "sessions", "child-nested", `rollout-child-${childId}.jsonl`);
    writeJsonl(parentPath, [{ type: "session_meta", payload: { id: parentId, cwd: "/repo" } }]);
    writeJsonl(childPath, [
      {
        type: "session_meta",
        payload: {
          id: childId,
          cwd: "/repo",
          thread_source: "subagent",
          source: { subagent: { thread_spawn: { parent_thread_id: parentId, agent_nickname: "Kierkegaard" } } },
        },
      },
    ]);
    const parent = entry(parentPath, { size: fs.statSync(parentPath).size });
    const child = entry(childPath, { size: fs.statSync(childPath).size });

    await linkEntries([child, parent]);

    expect(child.parent as string | null).toBe(parent.path);
  });

  test("pure linking leaves scanner state files byte-identical", async () => {
    const stateFiles = ["codex-lineage.json", "handoff-lineage.json", "worktree-map.json"].map((name) => path.join(SANDBOX, name));
    const before = stateFiles.map((file) => fs.existsSync(file) ? fs.readFileSync(file) : null);
    const parent = entry("/home/user/.codex/sessions/pure-parent.jsonl", { pid: 700 });
    const child = entry("/home/user/.codex/sessions/pure-child.jsonl", { pid: 900 });
    parentByPid = new Map([[900, 800], [800, 700], [700, null]]);
    await linkEntries([parent, child], { persist: false });
    expect(child.parent).toBe(parent.path);
    expect(stateFiles.map((file) => fs.existsSync(file) ? fs.readFileSync(file) : null)).toEqual(before);
  });
});
