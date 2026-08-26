import { spawn, type ChildProcess } from "node:child_process";

import { afterEach, expect, test } from "bun:test";

import type { RegistryFile } from "@/lib/agent/registry";
import type { SessionKey } from "@/lib/agent/sessionKey";
import { procBackend } from "@/lib/proc";
import type { StructuredHostKillRef } from "@/lib/resources";

import { readStructuredHostRecords, terminateStructuredHostTree } from "./structuredHostControl";

const CLAUDE_SESSION = ["019f4906", "3f67", "7b72", "9fbc", "9ec3b5ad1326"].join("-");
const CODEX_SESSION = ["029f4906", "3f67", "7b72", "9fbc", "9ec3b5ad1326"].join("-");
const PANE_SESSION = ["039f4906", "3f67", "7b72", "9fbc", "9ec3b5ad1326"].join("-");
const LANE_CONVERSATION = ["conversation", "9ec3b5ad1326be7f"].join("_");
const SEAT_CONVERSATION = ["conversation", "9ec3b5ad1326bea1"].join("_");

function entry(over: Record<string, unknown>): Record<string, unknown> {
  return {
    key: { engine: "claude", sessionId: CLAUDE_SESSION },
    artifactPath: `/home/user/.claude/projects/-repo/${CLAUDE_SESSION}.jsonl`,
    cwd: "/repo/worktree",
    accountId: null,
    status: "live",
    host: null,
    structuredHost: { kind: "claude-broker", endpoint: "stdio", process: { pid: 4_100, startIdentity: "4100:start" }, eventCursor: 3, protocolVersion: null, writerClaimEpoch: 1, activeTurnRef: null, pendingAttention: [], activeFlags: [] },
    claimEpoch: 1,
    claimOwner: null,
    pendingAction: null,
    updatedAt: "2026-08-26T09:00:00.000Z",
    ...over,
  };
}

function conversation(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: LANE_CONVERSATION,
    engine: "claude",
    generations: [{
      id: CLAUDE_SESSION,
      path: `/home/user/.claude/projects/-repo/${CLAUDE_SESSION}.jsonl`,
      accountId: null,
      launchProfile: { cwd: "/repo/worktree", model: "opus", effort: "xhigh", fast: null, permissionMode: null, readOnly: null, allowSubagents: false, mcpServers: [], plugins: [], title: "Structured lane", project: null, parentConversationId: null, role: "worker", goal: null, plan: null },
      historyHash: null,
      host: null,
      createdAt: "2026-08-26T08:00:00.000Z",
      archivedAt: null,
    }],
    agentRole: "builder",
    turn: { state: "idle", source: "assistant", terminalAt: null, observedAt: null },
    createdAt: "2026-08-26T08:00:00.000Z",
    updatedAt: "2026-08-26T09:00:00.000Z",
    ...over,
  };
}

function snapshot(over: {
  entries?: Record<string, unknown>;
  conversations?: Record<string, unknown>;
  memberships?: Record<string, unknown>;
} = {}): RegistryFile {
  return {
    entries: over.entries ?? {},
    conversations: over.conversations ?? {},
    memberships: over.memberships ?? {},
  } as unknown as RegistryFile;
}

const fixtures: ChildProcess[] = [];

function spawnFixtureTree(): { pid: number; startIdentity: string | null } {
  const child = spawn("/bin/sh", ["-c", "sleep 30 & wait"], { detached: true, stdio: "ignore" });
  fixtures.push(child);
  const pid = child.pid;
  if (pid === undefined) throw new Error("fixture tree did not start");
  return { pid, startIdentity: procBackend.processIdentity(pid) };
}

function ref(over: Partial<StructuredHostKillRef> & Pick<StructuredHostKillRef, "pid">): StructuredHostKillRef {
  return {
    startIdentity: null,
    engine: "claude",
    sessionId: null,
    conversationId: null,
    seat: false,
    turnBusy: false,
    owned: false,
    lastActiveAt: null,
    ...over,
  };
}

afterEach(() => {
  for (const child of fixtures.splice(0)) {
    try {
      if (child.pid) process.kill(-child.pid, "SIGKILL");
    } catch {
      /* the test under it already took the tree down */
    }
  }
});

test("the inventory carries role, model, stage and ownership for every structured host", () => {
  const records = readStructuredHostRecords({
    snapshot: () => snapshot({
      entries: {
        [`claude:${CLAUDE_SESSION}`]: entry({}),
        [`codex:${CODEX_SESSION}`]: entry({
          key: { engine: "codex", sessionId: CODEX_SESSION },
          artifactPath: `/home/user/.codex/sessions/rollout-${CODEX_SESSION}.jsonl`,
          cwd: "/repo/seat",
          structuredHost: { kind: "codex-app-server", endpoint: "stdio", process: { pid: 5_000, startIdentity: "5000:start" }, eventCursor: 1, protocolVersion: null, writerClaimEpoch: 1, activeTurnRef: "turn-1", pendingAttention: [], activeFlags: [] },
          updatedAt: "2026-08-26T08:30:00.000Z",
        }),
      },
      conversations: {
        [LANE_CONVERSATION]: conversation({}),
        [SEAT_CONVERSATION]: conversation({
          id: SEAT_CONVERSATION,
          engine: "codex",
          agentRole: "orchestrator",
          turn: { state: "busy", source: "assistant", terminalAt: null, observedAt: null },
          generations: [{
            id: CODEX_SESSION,
            path: `/home/user/.codex/sessions/rollout-${CODEX_SESSION}.jsonl`,
            accountId: null,
            launchProfile: { cwd: "/repo/seat", model: "gpt-5.6", effort: null, fast: null, permissionMode: null, readOnly: null, allowSubagents: true, mcpServers: [], plugins: [], title: "Seat", project: null, parentConversationId: null, role: "root", goal: null, plan: null },
            historyHash: null,
            host: null,
            createdAt: "2026-08-26T08:00:00.000Z",
            archivedAt: null,
          }],
        }),
      },
      memberships: {
        [LANE_CONVERSATION]: [{ conversationId: LANE_CONVERSATION, kind: "pipeline", containerId: "pipeline-1", role: "builder", slot: "stage-1", stageId: "implement", stageOrder: 1, round: null, parentConversationId: null, runtime: null, createdAt: "2026-08-26T08:00:00.000Z" }],
        [SEAT_CONVERSATION]: [{ conversationId: SEAT_CONVERSATION, kind: "orchestrator", containerId: "orchestrator-1", role: "orchestrator", slot: "seat", stageId: null, stageOrder: null, round: null, parentConversationId: null, runtime: null, createdAt: "2026-08-26T08:00:00.000Z" }],
      },
    }),
    owned: (key: SessionKey) => key.engine === "claude",
  });

  expect(records).toEqual([
    {
      id: `claude:${CLAUDE_SESSION}`,
      engine: "claude",
      sessionId: CLAUDE_SESSION,
      pid: 4_100,
      startIdentity: "4100:start",
      cwd: "/repo/worktree",
      path: `/home/user/.claude/projects/-repo/${CLAUDE_SESSION}.jsonl`,
      conversationId: LANE_CONVERSATION,
      title: "Structured lane",
      role: "builder",
      model: "opus",
      stage: "implement",
      seat: false,
      turnBusy: false,
      owned: true,
    },
    {
      id: `codex:${CODEX_SESSION}`,
      engine: "codex",
      sessionId: CODEX_SESSION,
      pid: 5_000,
      startIdentity: "5000:start",
      cwd: "/repo/seat",
      path: `/home/user/.codex/sessions/rollout-${CODEX_SESSION}.jsonl`,
      conversationId: SEAT_CONVERSATION,
      title: "Seat",
      role: "orchestrator",
      model: "gpt-5.6",
      stage: null,
      seat: true,
      turnBusy: true,
      owned: false,
    },
  ]);
});

test("entries without a host process, and pane-hosted ones, stay out of the inventory", () => {
  const records = readStructuredHostRecords({
    snapshot: () => snapshot({
      entries: {
        "claude:unhosted": entry({ key: { engine: "claude", sessionId: "unhosted" }, structuredHost: null }),
        [`claude:${PANE_SESSION}`]: entry({
          key: { engine: "claude", sessionId: PANE_SESSION },
          host: { kind: "tmux", endpoint: "socket", server: { pid: 900, startIdentity: null }, paneId: "%1", panePid: { pid: 100, startIdentity: null }, windowName: "agent", agent: { pid: 200, startIdentity: null }, argv: [] },
        }),
      },
    }),
    owned: () => true,
  });

  expect(records).toEqual([]);
});

test("an owned host ends through the runtime and its registry row is retired", async () => {
  const tree = spawnFixtureTree();
  const retired: SessionKey[] = [];
  const terminated: SessionKey[] = [];

  const outcome = await terminateStructuredHostTree(
    ref({ pid: tree.pid, startIdentity: tree.startIdentity, sessionId: CLAUDE_SESSION, owned: true }),
    {
      terminateOwnedHost: async (key) => { terminated.push(key); return true; },
      retireRegistryEntry: (key) => { retired.push(key); },
    },
  );

  expect(outcome).toMatchObject({ ok: true, via: "runtime", remaining: [] });
  expect(terminated).toEqual([{ engine: "claude", sessionId: CLAUDE_SESSION }]);
  expect(retired).toEqual([{ engine: "claude", sessionId: CLAUDE_SESSION }]);
  expect(procBackend.pidAlive(tree.pid)).toBeFalse();
});

test("a released host the runtime no longer holds is still taken down by process group", async () => {
  const tree = spawnFixtureTree();
  const retired: SessionKey[] = [];

  const outcome = await terminateStructuredHostTree(
    ref({ pid: tree.pid, startIdentity: tree.startIdentity, sessionId: CLAUDE_SESSION, owned: true }),
    {
      /* The controller released this host: the seat resolves to nothing, which
         is the "structured runtime host is unavailable" case. */
      terminateOwnedHost: async () => false,
      retireRegistryEntry: (key) => { retired.push(key); },
    },
  );

  expect(outcome).toMatchObject({ ok: true, via: "process-group", remaining: [] });
  expect(retired).toEqual([{ engine: "claude", sessionId: CLAUDE_SESSION }]);
  expect(procBackend.pidAlive(tree.pid)).toBeFalse();
});

test("a host that already exited retires its row without signalling anything", async () => {
  const retired: SessionKey[] = [];
  const signalled: number[] = [];

  const outcome = await terminateStructuredHostTree(
    ref({ pid: 424_242, sessionId: CLAUDE_SESSION, owned: false }),
    {
      processIdentity: () => null,
      pidAlive: () => false,
      signal: (pid) => { signalled.push(pid); },
      retireRegistryEntry: (key) => { retired.push(key); },
      terminateOwnedHost: async () => false,
    },
  );

  expect(outcome).toEqual({ ok: true, via: "already-exited", pids: [], remaining: [] });
  expect(signalled).toEqual([]);
  expect(retired).toEqual([{ engine: "claude", sessionId: CLAUDE_SESSION }]);
});

test("a pid outside the viewer's own chain is required before any signal", async () => {
  const outcome = await terminateStructuredHostTree(ref({ pid: 4_242 }), {
    protectedPids: () => new Set([4_242]),
    signal: () => { throw new Error("a protected pid must never be signalled"); },
  });

  expect(outcome).toMatchObject({ ok: false, status: 403 });
});
