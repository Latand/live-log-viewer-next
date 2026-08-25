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

const { AgentRegistry } = await import("../agent/registry");
const { durableHandoffLineageFromSnapshot, linkEntries } = await import("./links");
const { nativeCodexParentThreadId } = await import("./codexNative");
const { normalizeHandoffLineageStore, rememberHandoffChild } = await import("../handoffLineage");

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

function settleSpawn(
  registry: InstanceType<typeof AgentRegistry>,
  launchId: string,
  artifactPath: string,
  sessionId: string,
): void {
  const receipt = registry.snapshot().receipts[launchId]!;
  const settled = registry.settleSpawn(launchId, {
    key: { engine: "claude", sessionId },
    artifactPath,
    cwd: SANDBOX,
    accountId: "work",
    launchProfile: receipt.launchProfile,
    status: "unhosted",
    host: null,
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: null,
  });
  if (settled.kind !== "settled") throw new Error("expected settled spawn");
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

  test("suppresses a persisted handoff flag for a historical container-born stage", async () => {
    const registry = new AgentRegistry(path.join(SANDBOX, "container-stage-registry.json"), undefined, undefined, { sqliteMode: "off" });
    const parentPath = path.join(SANDBOX, "container-stage-parent.jsonl");
    const childPath = path.join(SANDBOX, "container-stage-child.jsonl");
    const parentConversation = registry.ensureConversation("claude", parentPath, "work");
    const begun = registry.beginSpawnRequest({
      engine: "claude",
      cwd: SANDBOX,
      transport: "structured",
      accountId: "work",
      parentConversationId: parentConversation.id,
      role: "builder",
      memberships: [{
        kind: "pipeline",
        containerId: "pipeline-fixture",
        role: "builder",
        slot: "build:1",
        stageId: "build",
        stageOrder: 0,
        round: 1,
        parentConversationId: parentConversation.id,
      }],
    });
    if (begun.kind !== "created") throw new Error("expected created spawn");
    settleSpawn(registry, begun.receipt.launchId, childPath, "container-stage-session");
    rememberHandoffChild(childPath, parentPath);
    const parent = entry(parentPath);
    const child = entry(childPath, { handoff: true });

    await linkEntries([parent, child], {
      persist: false,
      durableHandoffLineage: durableHandoffLineageFromSnapshot(registry.snapshot()),
    });

    expect(child.parent).toBe(parentPath);
    expect(child.handoff).toBeUndefined();
  });

  test("builds the conversation lookup once for all durable provenance queries", () => {
    const registry = new AgentRegistry(path.join(SANDBOX, "provenance-lookup-registry.json"), undefined, undefined, { sqliteMode: "off" });
    const parentPath = path.join(SANDBOX, "provenance-lookup-parent.jsonl");
    const childPath = path.join(SANDBOX, "provenance-lookup-child.jsonl");
    const parentConversation = registry.ensureConversation("claude", parentPath, "work");
    const begun = registry.beginSpawnRequest({
      engine: "claude",
      cwd: SANDBOX,
      transport: "structured",
      accountId: "work",
      parentConversationId: parentConversation.id,
      role: "builder",
      memberships: [{
        kind: "pipeline",
        containerId: "pipeline-lookup-fixture",
        role: "builder",
        slot: "build:1",
        stageId: "build",
        stageOrder: 0,
        round: 1,
        parentConversationId: parentConversation.id,
      }],
    });
    if (begun.kind !== "created") throw new Error("expected created spawn");
    settleSpawn(registry, begun.receipt.launchId, childPath, "provenance-lookup-session");
    const snapshot = registry.snapshot();
    const conversations = snapshot.conversations;
    let lookupBuilds = 0;
    snapshot.conversations = new Proxy(conversations, {
      ownKeys(target) {
        lookupBuilds += 1;
        return Reflect.ownKeys(target);
      },
    });

    const lineage = durableHandoffLineageFromSnapshot(snapshot);
    expect(lineage.provenanceForChild(childPath)).toBe("container-spawn");
    expect(lineage.provenanceForChild(parentPath)).toBeNull();
    expect(lineage.provenanceForChild(childPath)).toBe("container-spawn");
    expect(lookupBuilds).toBe(1);
  });

  test("preserves an operator handoff that later gains flow membership", async () => {
    const registry = new AgentRegistry(path.join(SANDBOX, "enrolled-handoff-registry.json"), undefined, undefined, { sqliteMode: "off" });
    const parentPath = path.join(SANDBOX, "enrolled-handoff-parent.jsonl");
    const childPath = path.join(SANDBOX, "enrolled-handoff-child.jsonl");
    const parentConversation = registry.ensureConversation("claude", parentPath, "work");
    const begun = registry.beginSpawnRequest({
      engine: "claude",
      cwd: SANDBOX,
      transport: "structured",
      accountId: "work",
      parentConversationId: parentConversation.id,
      parentSource: "explicit",
      role: "builder",
      origin: { kind: "operator" },
    });
    if (begun.kind !== "created") throw new Error("expected created spawn");
    settleSpawn(registry, begun.receipt.launchId, childPath, "enrolled-handoff-session");
    registry.rememberMembership(begun.receipt.conversationId, {
      kind: "flow",
      containerId: "flow-fixture",
      role: "implementer",
      slot: "implementer",
      stageId: null,
      stageOrder: 0,
      round: null,
      parentConversationId: null,
    });
    rememberHandoffChild(childPath, parentPath);
    const parent = entry(parentPath);
    const child = entry(childPath);

    await linkEntries([parent, child], {
      persist: false,
      durableHandoffLineage: durableHandoffLineageFromSnapshot(registry.snapshot()),
    });

    expect(child.parent).toBe(parentPath);
    expect(child.handoff).toBe(true);
  });

  test("links a native Codex spawn_agent child through parent_thread_id metadata", async () => {
    const parentId = "019f421e-02e1-\x373e0-9b77-bebde063f10a";
    const childId = "019f423a-d6e9-\x37903-b597-3e676b6ff3d4";
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

  test("a provider fork is not linked as a subagent of the thread it copied", async () => {
    const sourceId = "019f9557-02e1-\x373e0-9b77-bebde063f20a";
    const forkId = "019f9c11-d6e9-\x37903-b597-3e676b6ff20b";
    const sourcePath = path.join(SANDBOX, ".codex", "sessions", "fork-source", `rollout-${sourceId}.jsonl`);
    const forkPath = path.join(SANDBOX, ".codex", "sessions", "fork", `rollout-${forkId}.jsonl`);
    writeJsonl(sourcePath, [{ type: "session_meta", payload: { id: sourceId, cwd: "/repo" } }]);
    /* A fork replays its ancestor's header as row two, so a lineage reader that
       kept scanning would invent a parent edge for it. */
    writeJsonl(forkPath, [
      { type: "session_meta", payload: { id: forkId, forked_from_id: sourceId, cwd: "/repo" } },
      { type: "session_meta", payload: { id: sourceId, cwd: "/repo" } },
    ]);
    const source = entry(sourcePath, { size: fs.statSync(sourcePath).size });
    const fork = entry(forkPath, { size: fs.statSync(forkPath).size });

    await linkEntries([fork, source]);

    expect(fork.parent as string | null).toBeNull();
    expect(nativeCodexParentThreadId(forkPath, fs.statSync(forkPath).size, fs.statSync(forkPath).mtimeMs)).toBeNull();
  });

  test("a larger native Codex transcript rewrite refreshes its parent identity", () => {
    const firstParentId = "019f421e-02e1-\x373e0-9b77-bebde063f10c";
    const secondParentId = "019f421e-02e1-\x373e0-9b77-bebde063f10d";
    const childPath = path.join(SANDBOX, ".codex", "sessions", "rewrite", "rollout-child-rewrite.jsonl");
    writeJsonl(childPath, [{ type: "session_meta", payload: { parent_thread_id: firstParentId } }]);
    const first = fs.statSync(childPath);
    expect(nativeCodexParentThreadId(childPath, first.size, first.mtimeMs)).toBe(firstParentId);

    writeJsonl(childPath, [{
      type: "session_meta",
      payload: { parent_thread_id: secondParentId, metadata: "expanded rewrite" },
    }]);
    const rewrittenMtime = first.mtimeMs + 2_000;
    fs.utimesSync(childPath, rewrittenMtime / 1000, rewrittenMtime / 1000);
    const rewritten = fs.statSync(childPath);

    expect(rewritten.size).toBeGreaterThan(first.size);
    expect(nativeCodexParentThreadId(childPath, rewritten.size, rewritten.mtimeMs)).toBe(secondParentId);
  });

  test("links a native Codex spawn_agent child through nested thread_spawn metadata", async () => {
    const parentId = "019f421e-02e1-\x373e0-9b77-bebde063f10b";
    const childId = "019f423a-d6e9-\x37903-b597-3e676b6ff3d5";
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
