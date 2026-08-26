import { spawn, type ChildProcess } from "node:child_process";

import { afterEach, expect, test } from "bun:test";

import type { RegistryFile } from "@/lib/agent/registry";
import type { SessionKey } from "@/lib/agent/sessionKey";
import { procBackend } from "@/lib/proc";
import type { StructuredHostKillRef } from "@/lib/resources";

import { readStructuredHostRecords, structuredHostKillRefusal, terminateStructuredHostTree } from "./structuredHostControl";

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

function spawnFixtureTree(): { pid: number; startIdentity: string } {
  const child = spawn("/bin/sh", ["-c", "sleep 30 & wait"], { detached: true, stdio: "ignore" });
  fixtures.push(child);
  const pid = child.pid;
  if (pid === undefined) throw new Error("fixture tree did not start");
  const startIdentity = procBackend.processIdentity(pid);
  if (startIdentity === null) throw new Error("fixture tree has no process identity");
  return { pid, startIdentity };
}

function ref(over: Partial<StructuredHostKillRef> & Pick<StructuredHostKillRef, "pid">): StructuredHostKillRef {
  return {
    kind: "structured",
    startIdentity: "0:unmatched",
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

test("an owned host ends through the runtime, bound to the process it authorized", async () => {
  const tree = spawnFixtureTree();
  const retired: SessionKey[] = [];
  const terminated: Array<{ key: SessionKey; expected: { pid: number; startIdentity: string | null } }> = [];

  const outcome = await terminateStructuredHostTree(
    ref({ pid: tree.pid, startIdentity: tree.startIdentity, sessionId: CLAUDE_SESSION, owned: true }),
    {
      terminateOwnedHost: async (key, expected) => { terminated.push({ key, expected }); return true; },
      retireRegistryEntry: (key) => { retired.push(key); },
    },
  );

  expect(outcome).toMatchObject({ ok: true, via: "runtime" });
  expect(terminated).toEqual([{
    key: { engine: "claude", sessionId: CLAUDE_SESSION },
    expected: { pid: tree.pid, startIdentity: tree.startIdentity },
  }]);
  /* The runtime retired the row inside its own lifecycle; retiring it a
     second time here would be a second authority over one record. */
  expect(retired).toEqual([]);
  expect(procBackend.pidAlive(tree.pid)).toBeFalse();
});

test("a replacement host holding the seat is left to the runtime, and the row is retired on the killed pid", async () => {
  const tree = spawnFixtureTree();
  const retired: Array<{ key: SessionKey; expected: { pid: number; startIdentity: string | null } }> = [];

  const outcome = await terminateStructuredHostTree(
    ref({ pid: tree.pid, startIdentity: tree.startIdentity, sessionId: CLAUDE_SESSION, owned: true }),
    {
      /* A successor claimed this session key since the snapshot: the runtime
         refuses to end a host that is not the one the caller authorized, so
         only the stale tree is taken down, by group. */
      terminateOwnedHost: async () => false,
      retireRegistryEntry: (key, expected) => { retired.push({ key, expected }); },
    },
  );

  expect(outcome).toMatchObject({ ok: true, via: "process-group" });
  expect(retired).toEqual([{
    key: { engine: "claude", sessionId: CLAUDE_SESSION },
    expected: { pid: tree.pid, startIdentity: tree.startIdentity },
  }]);
  expect(procBackend.pidAlive(tree.pid)).toBeFalse();
});

test("every process in the tree is signalled exactly once per pass", async () => {
  const alive = new Set([5_000, 5_001, 5_002]);
  const signalled: number[] = [];
  const group = new Map([[5_000, 5_000], [5_001, 5_000], [5_002, 5_002]]);

  const outcome = await terminateStructuredHostTree(
    ref({ pid: 5_000, startIdentity: "5000:start" }),
    {
      processIdentity: (pid) => (alive.has(pid) ? `${pid}:start` : null),
      pidAlive: (pid) => alive.has(pid),
      ppidMap: () => new Map([[5_001, 5_000], [5_002, 5_001]]),
      processGroupId: (pid) => group.get(pid) ?? null,
      protectedPids: () => new Set(),
      signal: (pid) => {
        signalled.push(pid);
        /* A group signal reaches every member; an individual one reaches its
           target. Both are honoured here, so nothing survives the pass. */
        if (pid < 0) for (const [member, leader] of group) { if (leader === -pid) alive.delete(member); }
        else alive.delete(pid);
      },
      terminateOwnedHost: async () => false,
    },
  );

  expect(outcome).toMatchObject({ ok: true, via: "process-group", pids: [5_000, 5_001, 5_002] });
  /* The group covers 5000 and 5001; only the descendant that left the group
     is named on its own, and nothing is signalled twice. */
  expect(signalled).toEqual([-5_000, 5_002]);
});

test("a host that already exited retires its row without signalling anything", async () => {
  const retired: SessionKey[] = [];
  const signalled: number[] = [];

  const outcome = await terminateStructuredHostTree(
    ref({ pid: 424_242, startIdentity: "424242:start", sessionId: CLAUDE_SESSION, owned: false }),
    {
      processIdentity: () => null,
      pidAlive: () => false,
      signal: (pid) => { signalled.push(pid); },
      retireRegistryEntry: (key) => { retired.push(key); },
      terminateOwnedHost: async () => false,
    },
  );

  expect(outcome).toEqual({ ok: true, via: "already-exited", pids: [] });
  expect(signalled).toEqual([]);
  expect(retired).toEqual([{ engine: "claude", sessionId: CLAUDE_SESSION }]);
});

test("a refused signal is a failure, not a success, and the registry row stays", async () => {
  const retired: SessionKey[] = [];

  const outcome = await terminateStructuredHostTree(
    ref({ pid: 6_000, startIdentity: "6000:start", sessionId: CLAUDE_SESSION }),
    {
      processIdentity: (pid) => `${pid}:start`,
      pidAlive: () => true,
      ppidMap: () => new Map(),
      processGroupId: () => 6_000,
      protectedPids: () => new Set(),
      signal: () => { throw Object.assign(new Error("operation not permitted"), { code: "EPERM" }); },
      retireRegistryEntry: (key) => { retired.push(key); },
      terminateOwnedHost: async () => false,
      graceMs: 0,
      deadlineMs: 0,
      sleep: async () => {},
    },
  );

  expect(outcome).toMatchObject({ ok: false, status: 500, remaining: [6_000] });
  expect((outcome as { error: string }).error).toContain("EPERM");
  /* The host is still running, so the row that describes it must survive. */
  expect(retired).toEqual([]);
});

test("a process that outlives the whole ladder is reported, not called killed", async () => {
  const retired: SessionKey[] = [];

  const outcome = await terminateStructuredHostTree(
    ref({ pid: 7_000, startIdentity: "7000:start", sessionId: CLAUDE_SESSION }),
    {
      processIdentity: (pid) => `${pid}:start`,
      /* The signals land and change nothing — a stopped or unkillable tree. */
      pidAlive: () => true,
      ppidMap: () => new Map([[7_001, 7_000]]),
      processGroupId: () => 7_000,
      protectedPids: () => new Set(),
      signal: () => {},
      retireRegistryEntry: (key) => { retired.push(key); },
      terminateOwnedHost: async () => false,
      graceMs: 0,
      deadlineMs: 0,
      sleep: async () => {},
    },
  );

  expect(outcome).toMatchObject({ ok: false, status: 500, remaining: [7_000, 7_001] });
  expect(retired).toEqual([]);
});

test("a pid outside the viewer's own chain is required before any signal", async () => {
  const outcome = await terminateStructuredHostTree(ref({ pid: 4_242, startIdentity: "4242:start" }), {
    protectedPids: () => new Set([4_242]),
    signal: () => { throw new Error("a protected pid must never be signalled"); },
  });

  expect(outcome).toMatchObject({ ok: false, status: 403 });
});

test("a ref with no observed identity grants no authority at all", async () => {
  const outcome = await terminateStructuredHostTree(
    { ...ref({ pid: 4_242 }), startIdentity: null as unknown as string },
    { signal: () => { throw new Error("an unverifiable pid must never be signalled"); } },
  );

  expect(outcome).toMatchObject({ ok: false, status: 409 });
});

/* The rail polls every 30 s, so everything a bulk gesture promises has to be
   re-read here, one step before the signal. These drive that gate with a
   snapshot the ref does not agree with — the state that changed in between. */
function gateSnapshot(over: { turn?: string; seat?: boolean } = {}): RegistryFile {
  return snapshot({
    entries: { [`claude:${CLAUDE_SESSION}`]: entry({}) },
    conversations: {
      [LANE_CONVERSATION]: conversation({
        turn: { state: over.turn ?? "idle", source: "assistant", terminalAt: null, observedAt: null },
      }),
    },
    memberships: over.seat
      ? {
        [LANE_CONVERSATION]: [{
          conversationId: LANE_CONVERSATION, kind: "orchestrator", containerId: "orchestrator-1", role: "orchestrator",
          slot: "seat", stageId: null, stageOrder: null, round: null, parentConversationId: null, runtime: null,
          createdAt: "2026-08-26T08:00:00.000Z",
        }],
      }
      : {},
  });
}

const NOW_MS = Date.parse("2026-08-26T12:00:00.000Z");
const quiet = ref({
  pid: 4_100,
  startIdentity: "4100:start",
  sessionId: CLAUDE_SESSION,
  lastActiveAt: new Date(NOW_MS - 6 * 3_600_000).toISOString(),
});

test("kill idle refuses a host that started a turn since the list was taken", () => {
  const refusal = structuredHostKillRefusal(quiet, { kind: "idle", hours: 2 }, false, {
    snapshot: () => gateSnapshot({ turn: "busy" }),
    transcriptMtimeMs: () => NOW_MS - 6 * 3_600_000,
    now: () => NOW_MS,
  });

  expect(refusal).toMatchObject({ status: 409, error: expect.stringContaining("mid-turn") });
});

test("kill idle refuses a host whose transcript moved since the list was taken", () => {
  const dependencies = { snapshot: () => gateSnapshot(), now: () => NOW_MS };

  expect(structuredHostKillRefusal(quiet, { kind: "idle", hours: 2 }, false, {
    ...dependencies,
    transcriptMtimeMs: () => NOW_MS - 60_000,
  })).toMatchObject({ status: 409, error: expect.stringContaining("active") });

  expect(structuredHostKillRefusal(quiet, { kind: "idle", hours: 2 }, false, {
    ...dependencies,
    transcriptMtimeMs: () => NOW_MS - 6 * 3_600_000,
  })).toBeNull();
});

test("a seat taken since the list was taken survives both bulk kills until ticked", () => {
  const dependencies = {
    snapshot: () => gateSnapshot({ seat: true }),
    transcriptMtimeMs: () => NOW_MS - 6 * 3_600_000,
    now: () => NOW_MS,
  };
  /* The ref the snapshot handed out says this is an ordinary lane host. */
  expect(quiet.seat).toBeFalse();

  for (const intent of [{ kind: "idle" as const, hours: 2 }, { kind: "all" as const }]) {
    expect(structuredHostKillRefusal(quiet, intent, false, dependencies))
      .toMatchObject({ status: 409, error: expect.stringContaining("orchestrator seat") });
    expect(structuredHostKillRefusal(quiet, intent, true, dependencies)).toBeNull();
  }
});

test("kill all takes a live host, and a row kill takes a mid-turn one", () => {
  const dependencies = {
    snapshot: () => gateSnapshot({ turn: "busy" }),
    transcriptMtimeMs: () => NOW_MS,
    now: () => NOW_MS,
  };

  expect(structuredHostKillRefusal(quiet, { kind: "all" }, false, dependencies)).toBeNull();
  expect(structuredHostKillRefusal(quiet, { kind: "row" }, true, dependencies)).toBeNull();
});

test("a host no registry record covers has no idle age to prove", () => {
  const orphan = ref({ pid: 4_100, startIdentity: "4100:start", lastActiveAt: new Date(NOW_MS - 6 * 3_600_000).toISOString() });
  const dependencies = { snapshot: () => gateSnapshot(), now: () => NOW_MS };

  expect(structuredHostKillRefusal(orphan, { kind: "idle", hours: 2 }, false, dependencies))
    .toMatchObject({ status: 409, error: expect.stringContaining("own row") });
  /* Its own row still kills it — that is the whole point of listing it. */
  expect(structuredHostKillRefusal(orphan, { kind: "row" }, true, dependencies)).toBeNull();
});
