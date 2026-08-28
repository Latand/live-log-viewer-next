import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, expect, test } from "bun:test";

import type { RegistryFile } from "@/lib/agent/registry";
import { claudeTranscriptPath } from "@/lib/agent/transcript";
import { statePath } from "@/lib/configDir";
import { procBackend } from "@/lib/proc";
import { descendantPids } from "@/lib/proc/memory";
import type { StructuredHostKillRef } from "@/lib/resources";

import { ClaudeStreamBrokerHost, type ClaudeDeliveryLedger } from "./claudeStreamBrokerHost";
import { determined, undetermined } from "./determinable";
import { normalizeQueueEntry } from "./engineHost";
import { FileRuntimeEventStore } from "./eventStore";
import type { HandoffRow } from "./handoffQueue";
import { NATIVE_MULTI_AGENT_DENY_FLAG } from "./hostActivityFlags";
import { STRUCTURED_IMAGE_CAPABILITY } from "./structuredContent";
import { terminateStructuredHostTree } from "./structuredHostControl";
import {
  reconcileStructuredHostRetirement,
  STRUCTURED_HOST_RETIREMENT_CLAUSES,
  runStructuredHostRetirementSweep,
  structuredHostRetirementGraceMs,
  startStructuredHostRetirement,
  stopStructuredHostRetirement,
  STRUCTURED_HOST_RETIREMENT_INTERVAL_MS,
  structuredHostRetirementBatch,
  structuredHostRetirementIdleMs,
  structuredHostRetirementJournalRecord,
  structuredHostRetirementVerdict,
  type StructuredHostRetirementClause,
  type StructuredHostRetirementDependencies,
  type StructuredHostRetirementSubject,
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
      /* What every live Claude host actually carries: a permanent capability
         advertisement, plus the denied-tool set when it launched without
         native multi-agent tools. A predicate that reads these as activity
         refuses every Claude host forever — the population #747 is about. */
      activeFlags: [STRUCTURED_IMAGE_CAPABILITY, NATIVE_MULTI_AGENT_DENY_FLAG],
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
    /* This process holds no structured hosts, so the real reader stands the
       sweep down. Every clause case injects the answer the process that DOES
       hold them would give; the stand-down itself has its own case below. */
    publicationState: () => "ready",
    snapshot: () => snapshot(),
    handoffRows: () => determined([]),
    durableEventTail: () => determined(12),
    realtimeBound: () => determined(false),
    orchestratorSeatConversations: () => determined(new Set<string>()),
    revokedSeatConversations: () => determined(new Set<string>()),
    transcriptStat: () => determined({ mtimeMs: NOW - 24 * 3_600_000 }),
    processIdentity: () => determined(HOST_IDENTITY),
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

/** N qualifying candidates, so a batch bound can be observed deferring. Ids are
    assembled from parts for the same reason the single fixture's are. */
function manyCandidates(count: number): { entries: Record<string, unknown>; conversations: Record<string, unknown> } {
  const entries: Record<string, unknown> = {};
  const conversations: Record<string, unknown> = {};
  for (let index = 0; index < count; index += 1) {
    const session = [`${index}19f4906`, "4c21", "7b72", "9fbc", "9ec3b5ad1326"].join("-");
    const conversationId = ["conversation", `9ec3b5ad1326be${index}f`].join("_");
    entries[`claude:${session}`] = entry({ key: { engine: "claude", sessionId: session } });
    conversations[conversationId] = conversation({
      id: conversationId,
      generations: [{ ...((conversation().generations as Record<string, unknown>[])[0]!), id: session }],
    });
  }
  return { entries, conversations };
}

/** Clauses a case in this file has proven blocks retirement on its own. The
    last test asserts the predicate has no clause that nothing pins. */
const pinnedClauses = new Set<StructuredHostRetirementClause>();

/** Every clause case asserts the same three things: nothing was signalled, the
    audit names the clause that refused, and it says whether the clause refused
    on an established fact or on one it could not determine. */
async function refusedBy(
  clause: StructuredHostRetirementClause,
  over: StructuredHostRetirementDependencies,
  kind: "established" | "undetermined" = "established",
): Promise<void> {
  const probe = await sweep(over);
  expect(probe.terminated).toEqual([]);
  expect(probe.report.retired).toEqual([]);
  expect(probe.report.refused.map((item) => item.clause)).toEqual([clause]);
  expect(probe.report.refused[0]!.undetermined).toBe(kind === "undetermined" ? true : undefined);
  expect(probe.report.evaluated).toBe(1);
  pinnedClauses.add(clause);
}

/** The real `/proc` read in the shape every reader now speaks: an identity the
    kernel will not give is undetermined, never a substitutable null. */
function observedIdentity(pid: number) {
  const identity = procBackend.processIdentity(pid);
  return identity === null ? undetermined(`no kernel identity can be observed for pid ${pid}`) : determined(identity);
}

/* Every pid a fixture tree put on this machine, torn down one by one. NOT by
   process group: the grandchild calls setsid, which is the whole point of the
   fixture, so `kill(-pid)` leaves it running past the end of the suite — the
   orphan leak this feature exists to avoid, reproduced by its own tests. */
const fixturePids: number[] = [];
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
  const child: ChildProcess = spawn(process.execPath, [fixtureTreeScript()], { detached: true, stdio: "ignore" });
  child.unref();
  const pid = child.pid;
  if (pid === undefined) throw new Error("fixture host tree did not start");
  fixturePids.push(pid);
  let tree: number[] = [];
  for (let attempt = 0; attempt < 200 && tree.length < 2; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    tree = descendantPids(pid, procBackend.ppidMap());
  }
  if (tree.length < 2) throw new Error("fixture host tree grew no child");
  fixturePids.push(...tree);
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
  for (const pid of fixturePids.splice(0)) {
    try { process.kill(pid, "SIGKILL"); } catch { /* the test already took it down */ }
  }
  for (const directory of scratchDirs.splice(0)) {
    try { fs.rmSync(directory, { recursive: true, force: true }); } catch { /* scratch only */ }
  }
});

test("a settled, quiet, unclaimed host is retired and the audit says why", async () => {
  const probe = await sweep();
  /* The fixture carries the flags a real Claude host carries, so this also
     proves a capability advertisement is not read as activity. */
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

test("an active flag blocks retirement, and a capability advertisement never does", async () => {
  /* The activity flag arrives alongside the advertisements every Claude host
     already carries, so the refusal has to come from the one that means the
     host is doing something. */
  await refusedBy("no-active-flags", {
    snapshot: () => snapshot({
      entries: {
        [`claude:${SESSION}`]: entry({
          structuredHost: {
            ...(entry().structuredHost as object),
            activeFlags: [STRUCTURED_IMAGE_CAPABILITY, NATIVE_MULTI_AGENT_DENY_FLAG, "compacting"],
          },
        }),
      },
    }),
  });

  /* An advertisement a later release adds is unknown to the classifier, so it
     counts as activity until it is named — unknown is never idle. */
  const probe = await sweep({
    snapshot: () => snapshot({
      entries: {
        [`claude:${SESSION}`]: entry({
          structuredHost: { ...(entry().structuredHost as object), activeFlags: ["some-future-capability-v9"] },
        }),
      },
    }),
  });
  expect(probe.terminated).toEqual([]);
  expect(probe.report.refused[0]).toMatchObject({ clause: "no-active-flags" });
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
  await refusedBy("handoff-queue-drained", { handoffRows: () => determined([row]) });

  /* A terminal row whose delivery was replayed owes nothing, and neither does
     a claimed row that never carried one — a claim leaves an idle-turn row
     `claimed` until the next hand-over, so a status test would refuse the
     whole hosted population the moment the queue had a writer. */
  const settled = await sweep({
    handoffRows: () => determined([
      { ...row, status: "claimed", pendingDeliveries: [] } as unknown as HandoffRow,
      { ...row, status: "terminal", replayedDeliveryIds: ["delivery-1"] } as unknown as HandoffRow,
    ]),
  });
  expect(settled.report.refused).toEqual([]);
  expect(settled.terminated).toHaveLength(1);
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
  await refusedBy("events-flushed", { durableEventTail: () => determined(19) });
});

test("an unreadable event ledger blocks retirement", async () => {
  await refusedBy("events-flushed", { durableEventTail: () => undetermined("the ledger tail could not be read") }, "undetermined");
});

test("a realtime-bound session blocks retirement", async () => {
  await refusedBy("no-realtime-binding", { realtimeBound: () => determined(true) });
});

test("a realtime binding that cannot be established blocks retirement", async () => {
  /* The ledgers are process-scoped: a process that does not hold the host
     answers nothing, not "no call". Null is that answer, and it refuses. */
  await refusedBy("no-realtime-binding", { realtimeBound: () => undetermined("this process holds no host") }, "undetermined");
});

test("a live orchestrator seat blocks retirement", async () => {
  await refusedBy("seat-free", { orchestratorSeatConversations: () => determined(new Set([CONVERSATION])) });
});

test("a seat that cannot be established blocks retirement — unknown is never idle", async () => {
  await refusedBy("seat-free", { snapshot: () => snapshot({ conversations: {} }) }, "undetermined");
});

test("a seat store that cannot be read blocks retirement — unknown is never idle", async () => {
  /* The reader the authority path uses answers an unreadable file as an empty
     one, because authority fails closed on an absent seat. Retirement asks the
     same question with the opposite consequence, so its source can still say
     "unknown" — and unknown refuses instead of clearing a live orchestrator. */
  await refusedBy("seat-free", { orchestratorSeatConversations: () => undetermined("the seat store could not be read") }, "undetermined");
});

test("an orchestrator membership establishes a seat even when the seat store cannot be read", async () => {
  await refusedBy("seat-free", {
    orchestratorSeatConversations: () => undetermined("the seat store could not be read"),
    snapshot: () => snapshot({ memberships: { [CONVERSATION]: [{ kind: "orchestrator", project: "repo-a" }] } }),
  });
});

/* ------------------------------------------------------------------------- *
 * The revoked-seat rule (#1245).
 *
 * The measured failure: rotation revokes authority and nothing else, so the
 * predecessor kept its host and — because it had scheduled its own monitor —
 * kept writing its transcript every few minutes. `seat-free` read its
 * epoch-stamped membership row as a live seat, and `transcript-idle` read its
 * self-inflicted recency as work. Two clauses, one missing distinction, and a
 * rotated-away orchestrator that could still act on a project it no longer
 * held. Both halves are pinned here, and so is everything the rule must NOT
 * loosen.
 * ------------------------------------------------------------------------- */

/** The seat store after a rotation: the predecessor still carries the
    membership row rotation leaves behind, and the durable revocation is what
    says the seat it names has ended. */
const rotatedAway: StructuredHostRetirementDependencies = {
  snapshot: () => snapshot({ memberships: { [CONVERSATION]: [{ kind: "orchestrator", project: "repo-a" }] } }),
  orchestratorSeatConversations: () => determined(new Set<string>()),
  revokedSeatConversations: () => determined(new Set([CONVERSATION])),
};

test("a revoked seat is retired however recently it wrote — the self-tick stops protecting it", async () => {
  /* Written 90 seconds ago against a six-hour threshold: under the old rule
     this host cleared `transcript-idle`'s floor at every sweep forever, which
     is exactly what a 25-minute self-scheduled cron produced in production. */
  const probe = await sweep({ ...rotatedAway, transcriptStat: () => determined({ mtimeMs: NOW - 90_000 }) });
  expect(probe.terminated).toHaveLength(1);
  const retired = probe.report.retired[0]!;
  expect(retired.conversationId).toBe(CONVERSATION);
  expect(retired.passed).toContain("seat-free");
  expect(retired.passed).toContain("transcript-idle");
  /* The audit says WHY a host two minutes old qualified, so a retirement
     seconds after a rotation reads as the rotation finishing rather than as
     the idle threshold having been quietly ignored. */
  expect(retired.seatRevoked).toBe(true);
});

test("a retirement under the ordinary threshold never claims the revoked-seat rule", async () => {
  const probe = await sweep();
  expect(probe.report.retired[0]!.seatRevoked).toBeUndefined();
});

test("the revoked-seat rule removes a seat's protection and never a turn's", async () => {
  /* The one thing the waiver must not become: a licence to kill a predecessor
     mid-turn. Every clause that protects work in flight still has to pass. */
  await refusedBy("turn-settled", {
    ...rotatedAway,
    snapshot: () => snapshot({
      memberships: { [CONVERSATION]: [{ kind: "orchestrator", project: "repo-a" }] },
      conversations: { [CONVERSATION]: conversation({ turn: { state: "busy", source: "assistant", terminalAt: null, observedAt: null } }) },
    }),
    transcriptStat: () => determined({ mtimeMs: NOW - 90_000 }),
  });
  await refusedBy("attention-settled", {
    ...rotatedAway,
    snapshot: () => snapshot({
      memberships: { [CONVERSATION]: [{ kind: "orchestrator", project: "repo-a" }] },
      entries: { [`claude:${SESSION}`]: entry({ structuredHost: { ...(entry().structuredHost as object), pendingAttention: ["attention-3"] } }) },
    }),
    transcriptStat: () => determined({ mtimeMs: NOW - 90_000 }),
  });
});

test("a re-designated seat is live again — a revocation below its epoch decides nothing", async () => {
  /* The ABA guard, from the retirement side: the seat store answers with the
     conversations whose NEWEST revocation still stands at or above every epoch
     a seat names them at, so a re-designation at a newer epoch simply is not in
     that set, and this host reads live exactly as it should. */
  await refusedBy("seat-free", {
    snapshot: () => snapshot({ memberships: { [CONVERSATION]: [{ kind: "orchestrator", project: "repo-a" }] } }),
    revokedSeatConversations: () => determined(new Set<string>()),
  });
});

test("an unreadable revocation record blocks a seat host — unknown is never revoked", async () => {
  await refusedBy("seat-free", {
    snapshot: () => snapshot({ memberships: { [CONVERSATION]: [{ kind: "orchestrator", project: "repo-a" }] } }),
    revokedSeatConversations: () => undetermined("the orchestrator revocation record could not be established"),
  }, "undetermined");
});

test("an unreadable revocation record costs an ordinary host nothing", async () => {
  /* Nothing can revoke a seat this host never held, so the read that failed
     could not have decided anything about it. Asking it anyway would have
     turned one unreadable file into a machine that retires no host at all. */
  const probe = await sweep({ revokedSeatConversations: () => undetermined("the orchestrator revocation record could not be established") });
  expect(probe.report.retired).toHaveLength(1);
});

test("a revoked seat is handed to the kill fence as a seat nobody holds", async () => {
  const probe = await sweep({ ...rotatedAway, transcriptStat: () => determined({ mtimeMs: NOW - 90_000 }) });
  expect(probe.terminated[0]!.seat).toBe(false);
});

test("a transcript that is gone from disk blocks retirement", async () => {
  await refusedBy("resumable", { transcriptStat: () => determined(null) });
});

test("a host with no resume token blocks retirement", async () => {
  await refusedBy("resumable", {
    snapshot: () => snapshot({ entries: { [`claude:${SESSION}`]: entry({ artifactPath: "" }) } }),
  });
});

test("a transcript written inside the interval blocks retirement", async () => {
  await refusedBy("transcript-idle", { transcriptStat: () => determined({ mtimeMs: NOW - 60_000 }) });
});

test("a host whose process identity cannot be observed blocks retirement", async () => {
  await refusedBy("process-identity", { processIdentity: () => undetermined("the kernel would not say") }, "undetermined");
});

test("a host whose record stored no kernel identity blocks retirement", async () => {
  /* The hosts write a null here precisely when they concluded their own pid
     was recycled or unverifiable. Standing today's observation in for it would
     compare an observation against itself and disable the fence entirely, on
     a record that already said the pid cannot be trusted. */
  await refusedBy("process-identity", {
    snapshot: () => snapshot({
      entries: {
        [`claude:${SESSION}`]: entry({
          structuredHost: { ...(entry().structuredHost as object), process: { pid: HOST_PID, startIdentity: null } },
        }),
      },
    }),
  }, "undetermined");
});

test("a pid that no longer carries the recorded identity blocks retirement", async () => {
  await refusedBy("process-identity", { processIdentity: () => determined(`${HOST_PID}:999999`) });
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
  const probe = await sweep({ realtimeBound: () => determined(true), record: undefined });
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
    processIdentity: observedIdentity,
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
    processIdentity: observedIdentity,
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
    processIdentity: observedIdentity,
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

  /* The predicate itself refuses, so the termination is never even reached. */
  expect(probe.report.retired).toEqual([]);
  expect(probe.report.failed).toEqual([]);
  expect(probe.terminated).toEqual([]);
  expect(probe.report.refused).toHaveLength(1);
  expect(probe.report.refused[0]!.clause).toBe("process-identity");
  expect(cleared).toEqual([]);
  for (const pid of tree.tree) expect(procBackend.pidAlive(pid)).toBe(true);
});

test("an identity that changes after the predicate passed is refused at the signal", async () => {
  /* The other half of the same fence: the predicate can only speak for the
     instant it read, so the kill re-checks the kernel identity itself. Here the
     record is honest and the sweep qualifies the host — and the tree still
     survives, because the pid stopped being that host in between. */
  const tree = await spawnFixtureHostTree();
  const cleared: string[] = [];

  const probe = await sweep({
    snapshot: () => snapshot({
      entries: {
        [`claude:${SESSION}`]: entry({
          structuredHost: { ...(entry().structuredHost as object), process: { pid: tree.pid, startIdentity: tree.startIdentity } },
        }),
      },
    }),
    processIdentity: observedIdentity,
    processMemory: (pids) => procBackend.processMemory(pids),
    ppidMap: () => procBackend.ppidMap(),
    owned: () => false,
    terminate: (ref) => terminateStructuredHostTree(ref, {
      /* The kernel handed this pid to something else between the predicate
         and the signal. */
      processIdentity: () => `${tree.pid}:0`,
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

test("a host that stops qualifying between evaluation and its turn is not killed", async () => {
  /* A batch ahead of a candidate may spend a grace ladder each, so its clauses
     can be a minute old by the time the signal would go out. The re-check is
     what keeps a turn that started in that window from being killed mid-flight.
     The first read is the planning pass; every read after it is the re-check. */
  let reads = 0;
  const probe = await sweep({
    snapshot: () => {
      reads += 1;
      return reads === 1
        ? snapshot()
        : snapshot({
            conversations: {
              [CONVERSATION]: conversation({ turn: { state: "busy", source: "user", terminalAt: null, observedAt: null } }),
            },
          });
    },
  });

  expect(reads).toBeGreaterThan(1);
  expect(probe.terminated).toEqual([]);
  expect(probe.report.retired).toEqual([]);
  expect(probe.report.refused).toEqual([
    expect.objectContaining({ clause: "turn-settled", changed: true }),
  ]);
});

test("a registry row that vanishes before its turn is reported, not signalled", async () => {
  let reads = 0;
  const probe = await sweep({
    snapshot: () => {
      reads += 1;
      return reads === 1 ? snapshot() : snapshot({ entries: {} });
    },
  });
  expect(probe.terminated).toEqual([]);
  expect(probe.report.refused).toEqual([
    expect.objectContaining({ clause: "process-identity", changed: true }),
  ]);
});

test("a process that does not hold the structured hosts sweeps nothing at all", async () => {
  /* Ownership, a live voice binding and a hosted realtime thread are all
     process-scoped state of the process that bound the delivery queue. Asked
     anywhere else they answer nothing, so two clauses would go vacuous and the
     graceful shutdown would be unreachable. The sweep refuses to evaluate a
     single host from there — and still leaves a record that it stood down. */
  for (const state of ["unbound", "rebinding"] as const) {
    const probe = await sweep({ publicationState: () => state, terminate: async () => { throw new Error("must not signal"); } });
    expect(probe.report.standDown).toBe(state);
    expect(probe.report.evaluated).toBe(0);
    expect(probe.report.retired).toEqual([]);
    expect(probe.report.refused).toEqual([]);
    expect(probe.terminated).toEqual([]);
    expect(probe.report.finishedAt).not.toBe("");
  }
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

test("an unset and a blank grace are the same statement, and neither is zero", async () => {
  /* `Number("")` is 0, which would mean "escalate to SIGKILL on the first pass"
     and lose the graceful window entirely — the idle parser already treats
     blank as unset, and these two must not disagree. */
  expect(structuredHostRetirementGraceMs({})).toBe(5_000);
  expect(structuredHostRetirementGraceMs({ LLV_HOST_RETIREMENT_GRACE_MS: "" })).toBe(5_000);
  expect(structuredHostRetirementGraceMs({ LLV_HOST_RETIREMENT_GRACE_MS: "   " })).toBe(5_000);
  expect(structuredHostRetirementGraceMs({ LLV_HOST_RETIREMENT_GRACE_MS: "not a number" })).toBe(5_000);
  expect(structuredHostRetirementGraceMs({ LLV_HOST_RETIREMENT_GRACE_MS: "1200" })).toBe(1_200);
  /* An explicit zero is still the operator's word. */
  expect(structuredHostRetirementGraceMs({ LLV_HOST_RETIREMENT_GRACE_MS: "0" })).toBe(0);
  expect(structuredHostRetirementGraceMs({ LLV_HOST_RETIREMENT_GRACE_MS: "999999" })).toBe(60_000);
  expect(structuredHostRetirementIdleMs({ LLV_HOST_RETIREMENT_IDLE_HOURS: "" })).toBe(6 * 3_600_000);
});

test("the sweep runs on its own timer, once per process", async () => {
  const scheduled: { delayMs: number; callback: () => void }[] = [];
  const sweeps: number[] = [];
  const start = () => startStructuredHostRetirement({
    scheduleInterval: (callback, delayMs) => {
      scheduled.push({ callback, delayMs });
      return { unref: () => {} } as unknown as ReturnType<typeof setInterval>;
    },
    sweep: async () => { sweeps.push(1); },
  });
  try {
    start();
    start();
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]!.delayMs).toBe(STRUCTURED_HOST_RETIREMENT_INTERVAL_MS);
    scheduled[0]!.callback();
    await Promise.resolve();
    expect(sweeps).toHaveLength(1);
  } finally {
    stopStructuredHostRetirement();
  }
});

/** A subject every clause of the predicate passes, built as a literal so the
    property test below can take one field at a time away from it. */
function qualifiedSubject(): StructuredHostRetirementSubject {
  return {
    key: { engine: "claude", sessionId: SESSION },
    keyId: `claude:${SESSION}`,
    conversationId: CONVERSATION,
    title: "Retired lane",
    role: "builder",
    stage: null,
    cwd: "/repo/worktree",
    transcriptPath: TRANSCRIPT,
    process: { pid: HOST_PID, startIdentity: HOST_IDENTITY },
    status: "idle",
    activeTurnRef: null,
    turnBusy: determined(false),
    pendingAttention: [],
    activeFlags: [STRUCTURED_IMAGE_CAPABILITY, NATIVE_MULTI_AGENT_DENY_FLAG],
    pendingAction: null,
    structuredHostOperationId: null,
    undeliveredHandoffEntries: determined(0),
    openOperations: 0,
    eventCursor: 12,
    durableEventTail: determined(12),
    realtimeBound: determined(false),
    seat: determined("none"),
    transcriptFile: determined({ mtimeMs: NOW - 24 * 3_600_000 }),
    observedStartIdentity: determined(HOST_IDENTITY),
  };
}

function isDeterminable(value: unknown): boolean {
  return typeof value === "object" && value !== null && "determined" in value;
}

test("no input the predicate reads can be undetermined and still retire", () => {
  /* The rule this whole shape exists for, asserted structurally rather than
     case by case: take the subject apart, and for EVERY field that can say
     "unknown", the verdict must refuse and say which clause could not be
     determined. Three rounds each found a different clause that had invented
     its own fallback; a clause added later with a new undeterminable input
     fails here unless it fails closed too. */
  const options = { now: NOW, idleMs: IDLE_MS };
  expect(structuredHostRetirementVerdict(qualifiedSubject(), options).retire).toBe(true);

  const fields = Object.entries(qualifiedSubject())
    .filter(([, value]) => isDeterminable(value))
    .map(([field]) => field);
  /* Everything a reader off the machine answers: seat, turn, queue, ledger,
     realtime, transcript, kernel identity. */
  expect(fields.length).toBe(7);

  for (const field of fields) {
    const subject = { ...qualifiedSubject(), [field]: undetermined(`${field} could not be read`) };
    const verdict = structuredHostRetirementVerdict(subject as StructuredHostRetirementSubject, options);
    expect(verdict.retire).toBe(false);
    if (verdict.retire) throw new Error("unreachable");
    expect(verdict.undetermined).toBe(true);
    expect(STRUCTURED_HOST_RETIREMENT_CLAUSES).toContain(verdict.clause);
    /* The reason is the failing reader's own words, so the audit line names
       the read rather than the clause alone. */
    expect(verdict.reason).toBe(`${field} could not be read`);
  }
});

test("an undetermined input refuses at its clause and the sweep names it", async () => {
  const undeterminable: [StructuredHostRetirementClause, StructuredHostRetirementDependencies][] = [
    ["seat-free", { orchestratorSeatConversations: () => undetermined("the seat store could not be established") }],
    ["turn-settled", {
      snapshot: () => snapshot({
        conversations: {
          [CONVERSATION]: conversation({ turn: { state: "unknown", source: "assistant", terminalAt: null, observedAt: null } }),
        },
      }),
    }],
    ["handoff-queue-drained", { handoffRows: () => undetermined("the handoff queue could not be read") }],
    ["events-flushed", { durableEventTail: () => undetermined("the runtime event ledger could not be opened (EACCES)") }],
    ["no-realtime-binding", { realtimeBound: () => undetermined("this process holds no structured host") }],
    ["resumable", { transcriptStat: () => undetermined("the transcript could not be read (EACCES)") }],
    ["process-identity", { processIdentity: () => undetermined("no kernel identity can be observed for pid 4100") }],
  ];

  for (const [clause, over] of undeterminable) {
    const probe = await sweep({ ...over, record: undefined });
    expect(probe.terminated).toEqual([]);
    expect(probe.report.retired).toEqual([]);
    expect(probe.report.refused).toHaveLength(1);
    const refusal = probe.report.refused[0]!;
    expect(refusal.clause).toBe(clause);
    expect(refusal.undetermined).toBe(true);
    /* The journal counts the two apart, because a refusal is the predicate
       working and an undetermined clause is a reader that stopped answering. */
    const record = structuredHostRetirementJournalRecord(probe.report);
    expect(record.undeterminedByClause).toEqual({ [clause]: 1 });
    expect(record.refusedByClause).toEqual({ [clause]: 1 });
    pinnedClauses.add(clause);
  }

  /* An established refusal is not counted as an undetermined one. */
  const established = await sweep({ realtimeBound: () => determined(true), record: undefined });
  expect(structuredHostRetirementJournalRecord(established.report).undeterminedByClause).toEqual({});
});

test("an unreadable handoff queue is not a drained one", async () => {
  /* The sweep's own default reader used to answer an unreadable queue with an
     empty list, which reads as "this key owes nothing" — the exact shape that
     kept recurring. It says so instead, and the clause refuses. */
  await refusedBy(
    "handoff-queue-drained",
    { handoffRows: () => undetermined("the handoff queue could not be read: EACCES") },
    "undetermined",
  );
});

test("the per-sweep batch is sized against the grace the sweep runs with", async () => {
  /* The bound only means anything against the ladder it will actually wait
     out: grace plus the 10 s deadline margin, per host. At the 60 s maximum an
     eight-host batch is ~9 minutes of ladders against a 5-minute tick. */
  const marginMs = 10_000;
  expect(structuredHostRetirementBatch(5_000)).toBe(8);
  expect(structuredHostRetirementBatch(60_000)).toBe(2);
  for (const graceMs of [0, 1_000, 5_000, 20_000, 60_000]) {
    const worstCaseMs = structuredHostRetirementBatch(graceMs) * (graceMs + marginMs);
    expect(worstCaseMs).toBeLessThanOrEqual(STRUCTURED_HOST_RETIREMENT_INTERVAL_MS);
  }
  /* Past any grace the parser admits, one host per sweep is still attempted:
     leaking hosts forever to protect a schedule is the worse failure. */
  expect(structuredHostRetirementBatch(10 * 60_000)).toBe(1);

  /* And the sweep uses it rather than a constant of its own. */
  const probe = await sweep({ graceMs: 60_000, snapshot: () => snapshot(manyCandidates(3)) });
  expect(probe.report.evaluated).toBe(3);
  expect(probe.report.retired).toHaveLength(2);
  expect(probe.report.deferred).toBe(1);
});

/** A child that stands in for the resumed engine. Its pid belongs to nothing on
    this machine, and every signal the host sends is captured by an injected
    `signalProcess`, so no real process or group is ever reached. */
class ResumedEngineChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 5151;
  private closed = false;

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.close(signal);
    return true;
  }

  close(signal: NodeJS.Signals): void {
    if (this.closed) return;
    this.closed = true;
    queueMicrotask(() => this.emit("close", 0, signal));
  }
}

test("a retired conversation still opens and resumes from its transcript", async () => {
  /* #747 asks for this as an assertion rather than an assumption: retire a
     host for real, then OPEN the conversation's transcript and RESUME the
     session from it, through the same adoption path production uses. */
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "llv-retirement-resume-"));
  scratchDirs.push(home);
  const projects = path.join(home, "projects");
  const cwd = path.join(home, "repo");
  fs.mkdirSync(cwd, { recursive: true });
  const transcript = claudeTranscriptPath(cwd, SESSION, projects);
  fs.mkdirSync(path.dirname(transcript), { recursive: true, mode: 0o700 });

  const asked = "finish the lane and report";
  const messageId = ["7b1f", "4c21", "9ec3b5ad1326"].join("-");
  const askedAt = new Date(NOW - 25 * 3_600_000).toISOString();
  fs.writeFileSync(transcript, `${JSON.stringify({
    type: "user",
    uuid: messageId,
    timestamp: askedAt,
    message: { role: "user", content: [{ type: "text", text: asked }] },
  })}\n`, { mode: 0o600 });
  const quiet = new Date(NOW - 24 * 3_600_000);
  fs.utimesSync(transcript, quiet, quiet);
  const before = fs.readFileSync(transcript);

  const tree = await spawnFixtureHostTree();
  const retired = await sweep({
    snapshot: () => snapshot({
      entries: {
        [`claude:${SESSION}`]: entry({
          artifactPath: transcript,
          cwd,
          structuredHost: { ...(entry().structuredHost as object), process: { pid: tree.pid, startIdentity: tree.startIdentity } },
        }),
      },
    }),
    /* The real stat, so the transcript this resume reads is the file on disk. */
    transcriptStat: undefined,
    processIdentity: observedIdentity,
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
  expect(retired.report.retired).toHaveLength(1);
  for (const pid of tree.tree) expect(procBackend.pidAlive(pid)).toBe(false);

  /* Opened: the transcript is byte-identical and still parses into the
     conversation the retired host was serving. */
  expect(fs.readFileSync(transcript)).toEqual(before);
  const opened = fs.readFileSync(transcript, "utf8").trim().split("\n")
    .map((line) => JSON.parse(line) as { message?: { content?: { text?: string }[] } });
  expect(opened.at(-1)?.message?.content?.[0]?.text).toBe(asked);

  /* Resumed: the same session key, adopted through the production path. The
     ledger carries a message the retired host never got a receipt for, and the
     surviving transcript is the only thing that can settle it. */
  const confirmed: { entryId: string; engineMessageId: string | null }[] = [];
  const ledger: ClaudeDeliveryLedger = {
    load: () => [{
      entry: normalizeQueueEntry({ id: "delivery-1", text: asked }),
      disposition: "turn-started",
      delivered: false,
      queuedAt: new Date(NOW - 26 * 3_600_000).toISOString(),
    }],
    recordQueued: () => {},
    confirmDelivered: (_session, entryId, engineMessageId) => { confirmed.push({ entryId, engineMessageId }); },
  };
  const child = new ResumedEngineChild();
  const signalled: [number, NodeJS.Signals][] = [];
  const argv: string[] = [];
  const resumed = await ClaudeStreamBrokerHost.adopt(SESSION, {
    cwd,
    claudeProjectsDir: projects,
    eventStore: new FileRuntimeEventStore(path.join(home, "events")),
    deliveryLedger: ledger,
    shutdownGraceMs: 50,
    readAuthStatus: () => ({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" }),
    processIdentity: () => null,
    signalProcess: (pid, signal) => {
      /* Recorded, never sent: the fixture pid owns nothing here. */
      signalled.push([pid, signal]);
      child.close(signal);
    },
    spawnProcess: (_command, args) => {
      argv.push(...args);
      return child as unknown as ChildProcessWithoutNullStreams;
    },
  });
  try {
    const resumeIndex = argv.indexOf("--resume");
    expect(argv.slice(resumeIndex, resumeIndex + 2)).toEqual(["--resume", SESSION]);
    /* A resume, not a fresh session that happens to carry the same id. */
    expect(argv).not.toContain("--session-id");
    expect(confirmed).toEqual([{ entryId: "delivery-1", engineMessageId: messageId }]);
    expect((await resumed.health()).status).toBe("idle");
  } finally {
    await resumed.release();
  }
  expect(signalled.every(([pid]) => pid === child.pid || pid === -child.pid)).toBe(true);
});

test("every clause of the predicate has a case that proves it blocks retirement", () => {
  expect([...pinnedClauses].sort()).toEqual([...STRUCTURED_HOST_RETIREMENT_CLAUSES].sort());
});
