import { spawn, type ChildProcess } from "node:child_process";

import { afterEach, expect, test } from "bun:test";

import type { ProcessIdentity, RegistryFile } from "@/lib/agent/registry";
import type { SessionKey } from "@/lib/agent/sessionKey";
import { procBackend } from "@/lib/proc";
import { systemBootEpoch } from "@/lib/processIdentity";
import type { StructuredHostKillRef } from "@/lib/resources";

import {
  readStructuredHostRecords,
  structuredHostKillRefFromRegistry,
  structuredHostKillRefusal,
  terminateStructuredHostTree,
} from "./structuredHostControl";

const CLAUDE_SESSION = ["019f4906", "3f67", "7b72", "9fbc", "9ec3b5ad1326"].join("-");
const CODEX_SESSION = ["029f4906", "3f67", "7b72", "9fbc", "9ec3b5ad1326"].join("-");
const PANE_SESSION = ["039f4906", "3f67", "7b72", "9fbc", "9ec3b5ad1326"].join("-");
const LANE_CONVERSATION = ["conversation", "9ec3b5ad1326be7f"].join("_");
const SEAT_CONVERSATION = ["conversation", "9ec3b5ad1326bea1"].join("_");
const BOOT_EPOCH = systemBootEpoch();

function entry(over: Record<string, unknown>): Record<string, unknown> {
  return {
    key: { engine: "claude", sessionId: CLAUDE_SESSION },
    artifactPath: `/home/user/.claude/projects/-repo/${CLAUDE_SESSION}.jsonl`,
    cwd: "/repo/worktree",
    accountId: null,
    status: "live",
    host: null,
    structuredHost: { kind: "claude-broker", endpoint: "stdio", process: { pid: 4_100, startIdentity: "4100:start", bootEpoch: BOOT_EPOCH }, eventCursor: 3, protocolVersion: null, writerClaimEpoch: 1, activeTurnRef: null, pendingAttention: [], activeFlags: [] },
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

function spawnPersistentWrapperTree(): { pid: number; startIdentity: string } {
  const child = spawn("/bin/sh", ["-c", "trap '' TERM; sleep 30 & wait; while :; do sleep 30; done"], {
    detached: true,
    stdio: "ignore",
  });
  fixtures.push(child);
  const pid = child.pid;
  if (pid === undefined) throw new Error("fixture wrapper did not start");
  const startIdentity = procBackend.processIdentity(pid);
  if (startIdentity === null) throw new Error("fixture wrapper has no process identity");
  return { pid, startIdentity };
}

function ref(over: Partial<StructuredHostKillRef> & Pick<StructuredHostKillRef, "pid">): StructuredHostKillRef {
  return {
    kind: "structured",
    startIdentity: "0:unmatched",
    bootEpoch: BOOT_EPOCH,
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
          structuredHost: { kind: "codex-app-server", endpoint: "stdio", process: { pid: 5_000, startIdentity: "5000:start", bootEpoch: BOOT_EPOCH }, eventCursor: 1, protocolVersion: null, writerClaimEpoch: 1, activeTurnRef: "turn-1", pendingAttention: [], activeFlags: [] },
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
      bootEpoch: BOOT_EPOCH,
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
      bootEpoch: BOOT_EPOCH,
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
  const terminated: Array<{ key: SessionKey; expected: ProcessIdentity }> = [];

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
    expected: { pid: tree.pid, startIdentity: tree.startIdentity, bootEpoch: BOOT_EPOCH },
  }]);
  /* The runtime retired the row inside its own lifecycle; retiring it a
     second time here would be a second authority over one record. */
  expect(retired).toEqual([]);
  expect(procBackend.pidAlive(tree.pid)).toBeFalse();
});

test("a runtime-confirmed exit receives no fallback group signal", async () => {
  let alive = true;
  const signals: number[] = [];
  const outcome = await terminateStructuredHostTree(
    ref({ pid: 5_500, startIdentity: "5500:start", sessionId: CLAUDE_SESSION, owned: true }),
    {
      processIdentity: () => alive ? "5500:start" : null,
      pidAlive: () => alive,
      ppidMap: () => new Map(),
      processGroupId: () => 5_500,
      protectedPids: () => new Set(),
      terminateOwnedHost: async () => {
        alive = false;
        return true;
      },
      signal: (pid) => { signals.push(pid); },
    },
  );

  expect(outcome).toMatchObject({ ok: true, via: "runtime" });
  expect(signals).toEqual([]);
});

test("a disowned structured session with a live recorded process falls back to its process group (#1324)", async () => {
  const tree = spawnFixtureTree();
  const retired: Array<{ key: SessionKey; expected: ProcessIdentity }> = [];

  const outcome = await terminateStructuredHostTree(
    ref({ pid: tree.pid, startIdentity: tree.startIdentity, sessionId: CLAUDE_SESSION, owned: true }),
    {
      /* No current runtime host matches the recorded process. */
      terminateOwnedHost: async () => false,
      retireRegistryEntry: (key, expected) => { retired.push({ key, expected }); },
    },
  );

  expect(outcome).toMatchObject({ ok: true, via: "process-group" });
  expect(retired).toEqual([{
    key: { engine: "claude", sessionId: CLAUDE_SESSION },
    expected: { pid: tree.pid, startIdentity: tree.startIdentity, bootEpoch: BOOT_EPOCH },
  }]);
  expect(procBackend.pidAlive(tree.pid)).toBeFalse();
});

test("the root identity is rechecked after the runtime handoff and before any signal", async () => {
  const tree = spawnFixtureTree();
  let rebound = false;
  const signals: number[] = [];

  const outcome = await terminateStructuredHostTree(
    ref({ pid: tree.pid, startIdentity: tree.startIdentity, sessionId: CLAUDE_SESSION, owned: true }),
    {
      processIdentity: (pid) => pid === tree.pid && rebound
        ? `${tree.startIdentity}:replacement`
        : procBackend.processIdentity(pid),
      terminateOwnedHost: async () => {
        rebound = true;
        throw new Error("runtime release saw a replacement process");
      },
      signal: (pid) => { signals.push(pid); },
      graceMs: 0,
      deadlineMs: 0,
    },
  );

  expect(outcome).toMatchObject({
    ok: false,
    status: 409,
    stale: true,
    error: expect.stringContaining("identity changed before signalling"),
  });
  expect(signals).toEqual([]);
  expect(procBackend.pidAlive(tree.pid)).toBeTrue();
});

test("a matching pid and start token from another boot receives no signal", async () => {
  const signals: number[] = [];
  const outcome = await terminateStructuredHostTree(
    ref({ pid: 4_242, startIdentity: "4242:start", bootEpoch: "boot-earlier" }),
    {
      processIdentity: () => "4242:start",
      bootEpoch: () => "boot-current",
      pidAlive: () => true,
      ppidMap: () => new Map(),
      processGroupId: () => 4_242,
      protectedPids: () => new Set(),
      terminateOwnedHost: async () => false,
      signal: (pid) => { signals.push(pid); },
      deadlineMs: 0,
    },
  );

  expect(outcome).toMatchObject({
    ok: false,
    status: 409,
    stale: true,
    error: "host has changed — refresh the resource list",
  });
  expect(signals).toEqual([]);
});

test("a kill without a recorded boot epoch is refused with the reason", async () => {
  const signals: number[] = [];
  const outcome = await terminateStructuredHostTree(
    ref({ pid: 4_242, startIdentity: "4242:start", bootEpoch: null }),
    {
      processIdentity: () => "4242:start",
      bootEpoch: () => "boot-current",
      pidAlive: () => true,
      protectedPids: () => new Set(),
      signal: (pid) => { signals.push(pid); },
    },
  );

  expect(outcome).toMatchObject({
    ok: false,
    status: 409,
    error: "host boot epoch is unknown — refresh the resource list",
  });
  expect(signals).toEqual([]);
});

test("a descendant identity change refuses the group signal", async () => {
  const tree = spawnFixtureTree();
  let childPid: number | null = null;
  for (let attempt = 0; attempt < 100 && childPid === null; attempt += 1) {
    childPid = [...procBackend.ppidMap()].find(([, parent]) => parent === tree.pid)?.[0] ?? null;
    if (childPid === null) await Bun.sleep(10);
  }
  if (childPid === null) throw new Error("fixture child did not start");
  let rebound = false;
  const signals: number[] = [];

  const outcome = await terminateStructuredHostTree(
    ref({ pid: tree.pid, startIdentity: tree.startIdentity, sessionId: CLAUDE_SESSION, owned: true }),
    {
      processIdentity: (pid) => pid === childPid && rebound
        ? `${procBackend.processIdentity(pid)}:replacement`
        : procBackend.processIdentity(pid),
      terminateOwnedHost: async () => {
        rebound = true;
        return false;
      },
      signal: (pid) => { signals.push(pid); },
      graceMs: 0,
      deadlineMs: 0,
    },
  );

  expect(outcome).toMatchObject({
    ok: false,
    status: 409,
    error: expect.stringContaining(`process ${childPid} identity changed before signalling`),
  });
  expect(signals).toEqual([]);
  expect(procBackend.pidAlive(tree.pid)).toBeTrue();
});

test("every process in the tree is signalled exactly once per pass", async () => {
  const alive = new Set([5_000, 5_001, 5_002, 5_003]);
  const signalled: number[] = [];
  const group = new Map([[5_000, 5_000], [5_001, 5_000], [5_002, 5_002], [5_003, 5_000]]);

  const outcome = await terminateStructuredHostTree(
    ref({ pid: 5_000, startIdentity: "5000:start" }),
    {
      processIdentity: (pid) => (alive.has(pid) ? `${pid}:start` : null),
      pidAlive: (pid) => alive.has(pid),
      /* 5003 already reparented but remains in the detached process group. */
      ppidMap: () => new Map([[5_001, 5_000], [5_002, 5_001], [5_003, 1]]),
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

  expect(outcome).toMatchObject({ ok: true, via: "process-group", pids: [5_000, 5_001, 5_002, 5_003] });
  /* The group covers 5000, 5001 and the reparented 5003. Only the descendant
     that left the group is named on its own, and nothing is signalled twice. */
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

test("a refused signal reports each survivor with the identity it carried (#1501)", async () => {
  const outcome = await terminateStructuredHostTree(
    ref({ pid: 6_100, startIdentity: "6100:start", sessionId: CLAUDE_SESSION }),
    {
      processIdentity: (pid) => `${pid}:start`,
      pidAlive: () => true,
      ppidMap: () => new Map([[6_101, 6_100]]),
      processGroupId: () => 6_100,
      protectedPids: () => new Set(),
      signal: () => { throw Object.assign(new Error("operation not permitted"), { code: "EPERM" }); },
      retireRegistryEntry: () => {},
      terminateOwnedHost: async () => false,
      graceMs: 0,
      deadlineMs: 0,
      sleep: async () => {},
    },
  );

  expect(outcome).toMatchObject({
    ok: false,
    status: 500,
    remaining: [6_100, 6_101],
    survivors: [
      { pid: 6_100, startIdentity: "6100:start", bootEpoch: BOOT_EPOCH },
      { pid: 6_101, startIdentity: "6101:start", bootEpoch: BOOT_EPOCH },
    ],
  });
});

test("the caller's authority is asked after the runtime boundary and before each signal, and a refusal there sends nothing (#1501)", async () => {
  const asked: string[] = [];
  const signalled: Array<[number, string]> = [];
  let alive = true;
  let runtimeAwaited = false;
  const run = (refuseAt: number | null) => (runtimeAwaited = false, terminateStructuredHostTree(
    ref({ pid: 6_200, startIdentity: "6200:start", sessionId: CLAUDE_SESSION }),
    {
      processIdentity: (pid) => `${pid}:start`,
      pidAlive: () => alive,
      ppidMap: () => new Map(),
      processGroupId: () => 6_200,
      protectedPids: () => new Set(),
      signal: (pid, signal) => { signalled.push([pid, signal]); },
      retireRegistryEntry: () => {},
      terminateOwnedHost: async () => { runtimeAwaited = true; return false; },
      authorize: () => {
        asked.push(runtimeAwaited ? `after-runtime:${signalled.length}` : "before-runtime");
        return asked.length === refuseAt ? { status: 409, error: "a seat was taken while the kill awaited the runtime" } : null;
      },
      graceMs: 0,
      deadlineMs: 1_000,
      sleep: async () => {},
    },
  ));

  /* Refused on the check that follows the runtime await: no signal at all. */
  const refusedAfterRuntime = await run(2);
  expect(refusedAfterRuntime).toMatchObject({ ok: false, status: 409, error: "a seat was taken while the kill awaited the runtime", remaining: [6_200] });
  expect(signalled).toEqual([]);
  expect(asked).toEqual(["before-runtime", "after-runtime:0"]);

  /* Refused on the check before the escalation: TERM went out once, KILL never. */
  asked.length = 0;
  const refusedBeforeKill = await run(4);
  expect(refusedBeforeKill).toMatchObject({ ok: false, status: 409 });
  expect(signalled).toEqual([[-6_200, "SIGTERM"]]);
  expect(asked).toEqual(["before-runtime", "after-runtime:0", "after-runtime:0", "after-runtime:1"]);

  /* Never refused: the ladder completes once the process is gone. */
  asked.length = 0;
  signalled.length = 0;
  alive = false;
  const completed = await run(null);
  expect(completed).toMatchObject({ ok: true, via: "already-exited" });
  expect(signalled).toEqual([]);
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

test("a surviving wrapper is returned as a survivor", async () => {
  const wrapper = spawnPersistentWrapperTree();
  let childPid: number | null = null;
  for (let attempt = 0; attempt < 100 && childPid === null; attempt += 1) {
    childPid = [...procBackend.ppidMap()].find(([, parent]) => parent === wrapper.pid)?.[0] ?? null;
    if (childPid === null) await Bun.sleep(10);
  }
  expect(childPid).not.toBeNull();

  const outcome = await terminateStructuredHostTree(
    ref({ pid: wrapper.pid, startIdentity: wrapper.startIdentity }),
    {
      processGroupId: () => null,
      signal: (pid, signal) => {
        if (pid !== wrapper.pid) process.kill(pid, signal);
      },
      terminateOwnedHost: async () => false,
      graceMs: 0,
      deadlineMs: 60,
    },
  );

  expect(outcome).toMatchObject({
    ok: false,
    status: 500,
    remaining: expect.arrayContaining([wrapper.pid]),
    error: expect.stringContaining("outlived the kill"),
  });
  expect(procBackend.pidAlive(wrapper.pid)).toBeTrue();
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

test("kill idle refuses a host whose current turn state is unknown", () => {
  const refusal = structuredHostKillRefusal(quiet, { kind: "idle", hours: 2 }, false, {
    snapshot: () => gateSnapshot({ turn: "unknown" }),
    transcriptMtimeMs: () => NOW_MS - 6 * 3_600_000,
    now: () => NOW_MS,
  });

  expect(refusal).toMatchObject({ status: 409, error: expect.stringContaining("turn state is unknown") });
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

test("a session key rebound to another process grants no bulk-kill state", () => {
  const replacement = gateSnapshot();
  replacement.entries[`claude:${CLAUDE_SESSION}`]!.structuredHost!.process = {
    pid: 9_900,
    startIdentity: "9900:replacement",
  };
  const dependencies = {
    snapshot: () => replacement,
    transcriptMtimeMs: () => NOW_MS - 6 * 3_600_000,
    now: () => NOW_MS,
  };

  expect(structuredHostKillRefusal(quiet, { kind: "all" }, false, dependencies))
    .toMatchObject({ status: 409, error: expect.stringContaining("seat status is unknown") });
  expect(structuredHostKillRefusal(quiet, { kind: "row" }, true, dependencies)).toBeNull();
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

/* #1501: a caller with no channel to the runtime host builds its kill ref
   from the registry row alone. These drive that builder with rows that lack
   or contradict the facts it needs; none of them may yield a ref. */
const LANE_KEY: SessionKey = { engine: "claude", sessionId: CLAUDE_SESSION };
const OWN_IDENTITY = { pid: process.pid, startIdentity: procBackend.processIdentity(process.pid), bootEpoch: BOOT_EPOCH };

function laneSnapshot(entryOver: Record<string, unknown> = {}, over: Parameters<typeof snapshot>[0] = {}): RegistryFile {
  return snapshot({
    entries: { [`claude:${CLAUDE_SESSION}`]: entry({ claimOwner: `structured-host:${JSON.stringify(OWN_IDENTITY)}`, ...entryOver }) },
    conversations: { [LANE_CONVERSATION]: conversation({}) },
    ...over,
  });
}

test("a complete row yields a ref bound to its conversation, with the owner generation's status (#1501)", () => {
  const built = structuredHostKillRefFromRegistry(LANE_KEY, { snapshot: () => laneSnapshot(), owned: () => false });

  expect(built).toMatchObject({
    ok: true,
    ref: {
      kind: "structured",
      pid: 4_100,
      startIdentity: "4100:start",
      bootEpoch: BOOT_EPOCH,
      engine: "claude",
      sessionId: CLAUDE_SESSION,
      conversationId: LANE_CONVERSATION,
      seat: false,
      turnBusy: false,
      owned: false,
    },
    owner: { identity: { pid: process.pid }, status: "alive" },
  });
});

test("a seat membership rides the ref so the kill gate can refuse it (#1501)", () => {
  const built = structuredHostKillRefFromRegistry(LANE_KEY, {
    snapshot: () => laneSnapshot({}, {
      memberships: { [LANE_CONVERSATION]: [{ conversationId: LANE_CONVERSATION, kind: "orchestrator", containerId: "seat", role: "orchestrator", slot: "seat", stageId: null, stageOrder: null, round: null, parentConversationId: null, createdAt: "2026-08-26T08:00:00.000Z" }] },
    }),
    owned: () => false,
  });

  expect(built).toMatchObject({ ok: true, ref: { seat: true } });
  expect(structuredHostKillRefusal((built as { ref: StructuredHostKillRef }).ref, { kind: "row" }, false, { snapshot: () => laneSnapshot() }))
    .toMatchObject({ status: 409 });
});

test("a row without a start identity or boot epoch is refused by name, and a dead owner generation is reported (#1501)", () => {
  const deadOwner = `structured-host:${JSON.stringify({ pid: 2_147_483_000, startIdentity: "gone:start", bootEpoch: BOOT_EPOCH })}`;
  const noStart = structuredHostKillRefFromRegistry(LANE_KEY, {
    snapshot: () => laneSnapshot({
      claimOwner: deadOwner,
      structuredHost: { kind: "claude-broker", endpoint: "stdio", process: { pid: 4_100, startIdentity: null, bootEpoch: BOOT_EPOCH }, eventCursor: 3, protocolVersion: null, writerClaimEpoch: 1, activeTurnRef: null, pendingAttention: [], activeFlags: [] },
    }),
  });
  expect(noStart).toMatchObject({ ok: false, owner: { status: "dead" } });
  expect((noStart as { error: string }).error).toContain("identity is unknown");
  expect((noStart as { error: string }).error).toContain("4100");

  const noEpoch = structuredHostKillRefFromRegistry(LANE_KEY, {
    snapshot: () => laneSnapshot({
      structuredHost: { kind: "claude-broker", endpoint: "stdio", process: { pid: 4_100, startIdentity: "4100:start" }, eventCursor: 3, protocolVersion: null, writerClaimEpoch: 1, activeTurnRef: null, pendingAttention: [], activeFlags: [] },
    }),
  });
  expect(noEpoch).toMatchObject({ ok: false });
  expect((noEpoch as { error: string }).error).toContain("boot epoch is unknown");
});

test("a row that is not the current generation of any conversation, or has no host or no row, yields nothing (#1501)", () => {
  const superseded = structuredHostKillRefFromRegistry(LANE_KEY, {
    snapshot: () => laneSnapshot({}, {
      conversations: { [LANE_CONVERSATION]: conversation({ generations: [
        ...(conversation({}) as { generations: unknown[] }).generations,
        { id: CODEX_SESSION, path: "/home/user/.claude/projects/-repo/next.jsonl", accountId: null, launchProfile: {}, historyHash: null, host: null, createdAt: "2026-08-26T09:00:00.000Z", archivedAt: null },
      ] }) },
    }),
  });
  expect(superseded).toMatchObject({ ok: false });
  expect((superseded as { error: string }).error).toContain("not the current generation");

  const hostless = structuredHostKillRefFromRegistry(LANE_KEY, { snapshot: () => laneSnapshot({ structuredHost: null, claimOwner: "not-a-structured-claim" }) });
  expect(hostless).toMatchObject({ ok: false, owner: { identity: null, status: "unrecorded" } });

  const missing = structuredHostKillRefFromRegistry(LANE_KEY, { snapshot: () => snapshot() });
  expect(missing).toMatchObject({ ok: false });
  expect((missing as { error: string }).error).toContain("no row");
});


test("identity loss after TERM retains other captured survivors and sends no further signal (#1501)", async () => {
  let changed = false;
  const signalled: Array<[number, NodeJS.Signals]> = [];
  const outcome = await terminateStructuredHostTree(ref({ pid: 8200, startIdentity: "8200:start", sessionId: CLAUDE_SESSION }), {
    processIdentity: (pid) => changed && pid === 8200 ? "8200:replacement" : `${pid}:start`,
    pidAlive: () => true,
    ppidMap: () => new Map([[8201, 8200]]),
    processGroupId: () => null,
    protectedPids: () => new Set(),
    terminateOwnedHost: async () => false,
    signal: (pid, value) => { signalled.push([pid, value]); changed = true; },
    retireRegistryEntry: () => { throw new Error("must not retire a partial tree"); },
  });
  expect(signalled).toEqual([[8200, "SIGTERM"]]);
  expect(outcome).toMatchObject({
    ok: false, status: 409, terminationStarted: true,
    survivors: [{ pid: 8201, startIdentity: "8201:start" }],
  });
});
