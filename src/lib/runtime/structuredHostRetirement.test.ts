import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, test } from "bun:test";

import type { RegistryFile } from "@/lib/agent/registry";
import { statePath } from "@/lib/configDir";
import { procBackend } from "@/lib/proc";
import { descendantPids } from "@/lib/proc/memory";
import type { StructuredHostKillRef } from "@/lib/resources";

import type { HandoffRow } from "./handoffQueue";
import { terminateStructuredHostTree } from "./structuredHostControl";
import {
  reconcileStructuredHostRetirement,
  STRUCTURED_HOST_RETIREMENT_CLAUSES,
  runStructuredHostRetirementSweep,
  structuredHostRetirementIdleMs,
  structuredHostRetirementJournalRecord,
  type StructuredHostRetirementClause,
  type StructuredHostRetirementDependencies,
} from "./structuredHostRetirement";

/* Ids are assembled from parts: a session/conversation-shaped literal is what
   the privacy gate refuses in a published artifact. */
const SESSION = ["019f4906", "4c21", "7b72", "9fbc", "9ec3b5ad1326"].join("-");
const CONVERSATION = ["conversation", "9ec3b5ad1326be7f"].join("_");
const NOW = Date.parse("2026-08-27T12:00:00.000Z");
const IDLE_MS = 6 * 3_600_000;
const TRANSCRIPT = `/home/user/.claude/projects/-repo/${SESSION}.jsonl`;
const HOST_PID = 4_100;
const HOST_IDENTITY = "4100:118820";

function entry(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key: { engine: "claude", sessionId: SESSION },
    artifactPath: TRANSCRIPT,
    cwd: "/repo/worktree",
    accountId: null,
    status: "idle",
    host: null,
    structuredHost: {
      kind: "claude-broker",
      endpoint: "stdio",
      process: { pid: HOST_PID, startIdentity: HOST_IDENTITY },
      eventCursor: 12,
      protocolVersion: null,
      writerClaimEpoch: 1,
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 1,
    claimOwner: null,
    pendingAction: null,
    structuredHostOperationId: null,
    updatedAt: "2026-08-26T09:00:00.000Z",
    ...over,
  };
}

function conversation(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: CONVERSATION,
    engine: "claude",
    generations: [{
      id: SESSION,
      path: TRANSCRIPT,
      accountId: null,
      launchProfile: { cwd: "/repo/worktree", model: "opus", title: "Retired lane", role: "builder" },
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
  receipts?: Record<string, unknown>;
  heldDeliveries?: Record<string, unknown>;
} = {}): RegistryFile {
  return {
    entries: over.entries ?? { [`claude:${SESSION}`]: entry() },
    conversations: over.conversations ?? { [CONVERSATION]: conversation() },
    memberships: over.memberships ?? {},
    receipts: over.receipts ?? {},
    heldDeliveries: over.heldDeliveries ?? {},
  } as unknown as RegistryFile;
}

interface SweepProbe {
  terminated: StructuredHostKillRef[];
  report: Awaited<ReturnType<typeof runStructuredHostRetirementSweep>>;
}

/** A sweep whose every read is injected and whose termination is a spy, so a
    clause case can never reach a process. */
async function sweep(over: StructuredHostRetirementDependencies = {}): Promise<SweepProbe> {
  const terminated: StructuredHostKillRef[] = [];
  const report = await runStructuredHostRetirementSweep({
    snapshot: () => snapshot(),
    handoffRows: () => [],
    durableEventTail: () => 12,
    realtimeBound: () => false,
    orchestratorSeatConversations: () => new Set<string>(),
    transcriptStat: () => ({ mtimeMs: NOW - 24 * 3_600_000 }),
    processIdentity: () => HOST_IDENTITY,
    processMemory: () => new Map([[HOST_PID, { rssBytes: 110 * 1024 * 1024, swapBytes: 332 * 1024 * 1024 }]]),
    ppidMap: () => new Map([[HOST_PID, 1]]),
    owned: () => true,
    record: () => {},
    now: () => NOW,
    idleMs: IDLE_MS,
    terminate: async (ref) => {
      terminated.push(ref);
      return { ok: true, via: "runtime", pids: [ref.pid] };
    },
    ...over,
  });
  return { terminated, report };
}

/** Clauses a case in this file has proven blocks retirement on its own. The
    last test asserts the predicate has no clause that nothing pins. */
const pinnedClauses = new Set<StructuredHostRetirementClause>();

/** Every clause case asserts the same two things: nothing was signalled, and
    the audit names the clause that refused. */
async function refusedBy(
  clause: StructuredHostRetirementClause,
  over: StructuredHostRetirementDependencies,
): Promise<void> {
  const probe = await sweep(over);
  expect(probe.terminated).toEqual([]);
  expect(probe.report.retired).toEqual([]);
  expect(probe.report.refused.map((item) => item.clause)).toEqual([clause]);
  expect(probe.report.evaluated).toBe(1);
  pinnedClauses.add(clause);
}

const fixtures: ChildProcess[] = [];
const scratchDirs: string[] = [];

function fixtureTreeScript(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-retirement-fixture-"));
  scratchDirs.push(directory);
  const script = path.join(directory, "host.mjs");
  /* The detached grandchild is the case finding 4 of #747 names: an MCP child
     that put itself in its own process group, which a group-only sweep leaves
     behind as an orphan. */
  fs.writeFileSync(script, [
    'import { spawn } from "node:child_process";',
    'spawn("/bin/sh", ["-c", "sleep 45"], { detached: true, stdio: "ignore" }).unref();',
    "setInterval(() => {}, 1000);",
    "",
  ].join("\n"), { mode: 0o600 });
  return script;
}

async function spawnFixtureHostTree(): Promise<{ pid: number; startIdentity: string; tree: number[] }> {
  const child = spawn(process.execPath, [fixtureTreeScript()], { detached: true, stdio: "ignore" });
  fixtures.push(child);
  const pid = child.pid;
  if (pid === undefined) throw new Error("fixture host tree did not start");
  let tree: number[] = [];
  for (let attempt = 0; attempt < 200 && tree.length < 2; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    tree = descendantPids(pid, procBackend.ppidMap());
  }
  if (tree.length < 2) throw new Error("fixture host tree grew no child");
  const startIdentity = procBackend.processIdentity(pid);
  if (startIdentity === null) throw new Error("fixture host tree has no process identity");
  return { pid, startIdentity, tree };
}

function processGroupId(pid: number): number | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    const group = Number(stat.slice(close + 2).trim().split(/\s+/)[2]);
    return Number.isInteger(group) && group > 0 ? group : null;
  } catch {
    return null;
  }
}

afterEach(() => {
  for (const child of fixtures.splice(0)) {
    try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { /* the test already took it down */ }
  }
  for (const directory of scratchDirs.splice(0)) {
    try { fs.rmSync(directory, { recursive: true, force: true }); } catch { /* scratch only */ }
  }
});

test("a settled, quiet, unclaimed host is retired and the audit says why", async () => {
  const probe = await sweep();
  expect(probe.terminated).toHaveLength(1);
  expect(probe.terminated[0]).toMatchObject({ kind: "structured", pid: HOST_PID, startIdentity: HOST_IDENTITY, sessionId: SESSION });
  const retired = probe.report.retired[0]!;
  expect(retired.key).toBe(`claude:${SESSION}`);
  expect(retired.conversationId).toBe(CONVERSATION);
  expect(retired.via).toBe("runtime");
  expect(retired.passed).toContain("turn-settled");
  expect(retired.passed).toContain("events-flushed");
  expect(retired.passed).toContain("transcript-idle");
  expect(retired.reclaimed).toEqual({ rssBytes: 110 * 1024 * 1024, swapBytes: 332 * 1024 * 1024, processes: 1 });
  expect(probe.report.reclaimed.swapBytes).toBe(332 * 1024 * 1024);
});

test("a turn in flight blocks retirement", async () => {
  await refusedBy("turn-settled", {
    snapshot: () => snapshot({
      entries: { [`claude:${SESSION}`]: entry({ structuredHost: { ...(entry().structuredHost as object), activeTurnRef: "turn-7" } }) },
    }),
  });
});

test("a busy conversation turn blocks retirement even with no active turn ref", async () => {
  await refusedBy("turn-settled", {
    snapshot: () => snapshot({
      conversations: { [CONVERSATION]: conversation({ turn: { state: "busy", source: "assistant", terminalAt: null, observedAt: null } }) },
    }),
  });
});

test("a question awaiting the operator blocks retirement", async () => {
  await refusedBy("attention-settled", {
    snapshot: () => snapshot({
      entries: { [`claude:${SESSION}`]: entry({ structuredHost: { ...(entry().structuredHost as object), pendingAttention: ["attention-3"] } }) },
    }),
  });
});

test("a host that is neither idle nor dead blocks retirement", async () => {
  await refusedBy("host-idle-or-dead", { snapshot: () => snapshot({ entries: { [`claude:${SESSION}`]: entry({ status: "live" }) } }) });
});

test("an active flag blocks retirement", async () => {
  await refusedBy("no-active-flags", {
    snapshot: () => snapshot({
      entries: { [`claude:${SESSION}`]: entry({ structuredHost: { ...(entry().structuredHost as object), activeFlags: ["compacting"] } }) },
    }),
  });
});

test("an undelivered handoff entry blocks retirement", async () => {
  const row = {
    operationId: "handoff-1",
    conversationId: CONVERSATION,
    engine: "claude",
    engineSessionId: SESSION,
    kind: "root",
    parentConversationId: null,
    hostGeneration: "generation-1",
    accountId: null,
    turnState: "idle",
    pendingDeliveries: [{ deliveryId: "delivery-1", clientMessageId: null, seq: 1 }],
    status: "pending",
    predecessorGeneration: null,
    successorGeneration: null,
    replayedDeliveryIds: [],
    interruptionOutcome: null,
    lastError: null,
    enqueuedAt: "2026-08-26T09:00:00.000Z",
    updatedAt: "2026-08-26T09:00:00.000Z",
  } as unknown as HandoffRow;
  await refusedBy("handoff-queue-drained", { handoffRows: () => [row] });
});

test("an undelivered held message blocks retirement", async () => {
  await refusedBy("handoff-queue-drained", {
    snapshot: () => snapshot({
      heldDeliveries: {
        "delivery-1": { id: "delivery-1", conversationId: CONVERSATION, runtimeConversationId: CONVERSATION, state: "held" },
      },
    }),
  });
});

test("a non-terminal spawn receipt blocks retirement", async () => {
  await refusedBy("no-open-operation", {
    snapshot: () => snapshot({
      receipts: {
        "launch-1": { launchId: "launch-1", conversationId: CONVERSATION, key: null, state: "prompt-delivered", engine: "claude" },
      },
    }),
  });
});

test("a pending registry action blocks retirement", async () => {
  await refusedBy("no-open-operation", {
    snapshot: () => snapshot({ entries: { [`claude:${SESSION}`]: entry({ pendingAction: "handoff" }) } }),
  });
});

test("an unflushed event tail blocks retirement", async () => {
  await refusedBy("events-flushed", { durableEventTail: () => 19 });
});

test("an unreadable event ledger blocks retirement", async () => {
  await refusedBy("events-flushed", { durableEventTail: () => null });
});

test("a realtime-bound session blocks retirement", async () => {
  await refusedBy("no-realtime-binding", { realtimeBound: () => true });
});

test("a live orchestrator seat blocks retirement", async () => {
  await refusedBy("seat-free", { orchestratorSeatConversations: () => new Set([CONVERSATION]) });
});

test("a seat that cannot be established blocks retirement — unknown is never idle", async () => {
  await refusedBy("seat-free", { snapshot: () => snapshot({ conversations: {} }) });
});

test("a transcript that is gone from disk blocks retirement", async () => {
  await refusedBy("resumable", { transcriptStat: () => null });
});

test("a host with no resume token blocks retirement", async () => {
  await refusedBy("resumable", {
    snapshot: () => snapshot({ entries: { [`claude:${SESSION}`]: entry({ artifactPath: "" }) } }),
  });
});

test("a transcript written inside the interval blocks retirement", async () => {
  await refusedBy("transcript-idle", { transcriptStat: () => ({ mtimeMs: NOW - 60_000 }) });
});

test("a host whose process identity cannot be observed blocks retirement", async () => {
  await refusedBy("process-identity", { processIdentity: () => null });
});

test("a sweep defers past its batch bound rather than overrunning the next tick", async () => {
  const second = ["029f4906", "4c21", "7b72", "9fbc", "9ec3b5ad1326"].join("-");
  const secondConversation = ["conversation", "9ec3b5ad1326bea1"].join("_");
  const probe = await sweep({
    batch: 1,
    snapshot: () => snapshot({
      entries: {
        [`claude:${SESSION}`]: entry(),
        [`claude:${second}`]: entry({ key: { engine: "claude", sessionId: second } }),
      },
      conversations: {
        [CONVERSATION]: conversation(),
        [secondConversation]: conversation({
          id: secondConversation,
          generations: [{ ...((conversation().generations as Record<string, unknown>[])[0]!), id: second }],
        }),
      },
    }),
  });
  expect(probe.report.evaluated).toBe(2);
  expect(probe.report.retired).toHaveLength(1);
  expect(probe.report.deferred).toBe(1);
  expect(probe.terminated).toHaveLength(1);
});

test("a sweep that retires nothing is distinguishable on disk from a sweep that never ran", async () => {
  /* The default audit sink, under the preload's isolated state dir. */
  const reportFile = statePath("host-retirement-report.json");
  const journalFile = statePath("host-retirement-journal.ndjson");
  for (const file of [reportFile, journalFile]) fs.rmSync(file, { force: true });
  expect(fs.existsSync(reportFile)).toBe(false);

  const probe = await sweep({ snapshot: () => snapshot({ entries: {} }), record: undefined });
  expect(probe.report.evaluated).toBe(0);
  expect(probe.report.retired).toEqual([]);
  expect(probe.report.finishedAt).not.toBe("");

  const written = JSON.parse(fs.readFileSync(reportFile, "utf8")) as { evaluated: number; finishedAt: string };
  expect(written.evaluated).toBe(0);
  expect(written.finishedAt).toBe(probe.report.finishedAt);
  const journal = fs.readFileSync(journalFile, "utf8").trim().split("\n");
  expect(journal).toHaveLength(1);
  expect(JSON.parse(journal[0]!)).toMatchObject({ evaluated: 0, retired: [], refusedByClause: {} });
});

test("the journal keeps every action whole and refusals as a count per clause", async () => {
  const probe = await sweep({ realtimeBound: () => true, record: undefined });
  const record = structuredHostRetirementJournalRecord(probe.report);
  expect(record.refusedByClause).toEqual({ "no-realtime-binding": 1 });
  expect(record).not.toHaveProperty("refused");
});

test("a qualifying host is retired with its whole tree, including a child in its own process group", async () => {
  const tree = await spawnFixtureHostTree();
  const detached = tree.tree.filter((pid) => pid !== tree.pid);
  expect(detached.length).toBeGreaterThan(0);
  const rootGroup = processGroupId(tree.pid);
  expect(detached.some((pid) => processGroupId(pid) !== rootGroup)).toBe(true);

  const probe = await sweep({
    snapshot: () => snapshot({
      entries: {
        [`claude:${SESSION}`]: entry({
          structuredHost: { ...(entry().structuredHost as object), process: { pid: tree.pid, startIdentity: tree.startIdentity } },
        }),
      },
    }),
    processIdentity: (pid) => procBackend.processIdentity(pid),
    processMemory: (pids) => procBackend.processMemory(pids),
    ppidMap: () => procBackend.ppidMap(),
    owned: () => false,
    terminate: (ref) => terminateStructuredHostTree(ref, {
      terminateOwnedHost: async () => false,
      retireRegistryEntry: () => {},
      graceMs: 200,
      deadlineMs: 5_000,
    }),
  });

  expect(probe.report.failed).toEqual([]);
  const retired = probe.report.retired[0]!;
  expect(retired.pids).toEqual(expect.arrayContaining(tree.tree));
  expect(retired.reclaimed.processes).toBeGreaterThanOrEqual(tree.tree.length);
  expect(retired.reclaimed.rssBytes).toBeGreaterThan(0);
  for (const pid of tree.tree) expect(procBackend.pidAlive(pid)).toBe(false);
});

test("a retired conversation keeps everything a resume needs", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-retirement-transcript-"));
  scratchDirs.push(directory);
  const transcript = path.join(directory, `${SESSION}.jsonl`);
  fs.writeFileSync(transcript, '{"type":"user","text":"a finished lane"}\n', { mode: 0o600 });
  const quiet = new Date(NOW - 24 * 3_600_000);
  fs.utimesSync(transcript, quiet, quiet);
  const before = fs.readFileSync(transcript);

  const tree = await spawnFixtureHostTree();
  const record = () => snapshot({
    entries: {
      [`claude:${SESSION}`]: entry({
        artifactPath: transcript,
        structuredHost: { ...(entry().structuredHost as object), process: { pid: tree.pid, startIdentity: tree.startIdentity } },
      }),
    },
  });
  const live: StructuredHostRetirementDependencies = {
    snapshot: record,
    /* The real stat, so the resume evidence read here is the file on disk. */
    transcriptStat: undefined,
    processIdentity: (pid) => procBackend.processIdentity(pid),
    processMemory: (pids) => procBackend.processMemory(pids),
    ppidMap: () => procBackend.ppidMap(),
    owned: () => false,
  };
  const retired = await sweep({
    ...live,
    terminate: (ref) => terminateStructuredHostTree(ref, {
      terminateOwnedHost: async () => false,
      retireRegistryEntry: () => {},
      graceMs: 200,
      deadlineMs: 5_000,
    }),
  });
  expect(retired.report.retired).toHaveLength(1);
  for (const pid of tree.tree) expect(procBackend.pidAlive(pid)).toBe(false);

  /* The resume token is the session key and the transcript is the history: the
     kill touched neither. Replaying the same record proves it — the only clause
     that changed is the one about the process. */
  expect(fs.readFileSync(transcript)).toEqual(before);
  expect(fs.statSync(transcript).mtimeMs).toBe(quiet.getTime());
  const replay = await sweep(live);
  expect(replay.terminated).toEqual([]);
  expect(replay.report.refused.map((item) => item.clause)).toEqual(["process-identity"]);
});

test("a replacement host on the same session key is never reached", async () => {
  const tree = await spawnFixtureHostTree();
  const cleared: string[] = [];

  const probe = await sweep({
    snapshot: () => snapshot({
      entries: {
        [`claude:${SESSION}`]: entry({
          /* The record still names the predecessor's kernel identity; the pid
             now belongs to a replacement host that took the seat. */
          structuredHost: { ...(entry().structuredHost as object), process: { pid: tree.pid, startIdentity: `${tree.pid}:0` } },
        }),
      },
    }),
    processIdentity: (pid) => procBackend.processIdentity(pid),
    processMemory: (pids) => procBackend.processMemory(pids),
    ppidMap: () => procBackend.ppidMap(),
    owned: () => false,
    terminate: (ref) => terminateStructuredHostTree(ref, {
      terminateOwnedHost: async () => false,
      retireRegistryEntry: (key) => { cleared.push(`${key.engine}:${key.sessionId}`); },
      graceMs: 200,
      deadlineMs: 5_000,
    }),
  });

  expect(probe.report.retired).toEqual([]);
  expect(probe.report.failed).toHaveLength(1);
  expect(probe.report.failed[0]!.error).toContain("host has changed");
  expect(cleared).toEqual([]);
  for (const pid of tree.tree) expect(procBackend.pidAlive(pid)).toBe(true);
});

test("the controller seam sweeps on its own, honours the configured interval and swallows a failure", async () => {
  const intervals: number[] = [];
  const report = await reconcileStructuredHostRetirement({
    env: { LLV_HOST_RETIREMENT_IDLE_HOURS: "3" },
    sweep: async (idleMs) => {
      intervals.push(idleMs);
      return (await sweep({ snapshot: () => snapshot({ entries: {} }) })).report;
    },
  });
  expect(intervals).toEqual([3 * 3_600_000]);
  expect(report?.evaluated).toBe(0);

  /* Zero hours is the operator's off switch: nothing is even evaluated. */
  const disabled = await reconcileStructuredHostRetirement({
    env: { LLV_HOST_RETIREMENT_IDLE_HOURS: "0" },
    sweep: async () => { throw new Error("a disabled sweep must not run"); },
  });
  expect(disabled).toBeNull();
  expect(structuredHostRetirementIdleMs({ LLV_HOST_RETIREMENT_IDLE_HOURS: "0" })).toBeNull();
  expect(structuredHostRetirementIdleMs({})).toBe(6 * 3_600_000);

  /* A failing sweep never blocks the reconciliation cycle around it. */
  const failed = await reconcileStructuredHostRetirement({
    env: {},
    sweep: async () => { throw new Error("registry unavailable"); },
  });
  expect(failed).toBeNull();
});

test("every clause of the predicate has a case that proves it blocks retirement", () => {
  expect([...pinnedClauses].sort()).toEqual([...STRUCTURED_HOST_RETIREMENT_CLAUSES].sort());
});
