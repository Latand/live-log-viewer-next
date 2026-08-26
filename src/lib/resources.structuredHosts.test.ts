import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";

import { procBackend } from "@/lib/proc";
import { structuredHostStamp, type AgentProcess } from "@/lib/scanner/process";
import type { FileEntry, ResourceSession } from "@/lib/types";

import {
  allowedStructuredHostTarget,
  buildResourceSnapshot,
  consumeKillTarget,
  lastResourceTargetRefs,
  noteSessionTargets,
  resetResourcesForTests,
  type ResourceSnapshotDependencies,
  type StructuredHostRecord,
} from "./resources";

const CLAUDE_SESSION = ["019f4906", "3f67", "7b72", "9fbc", "9ec3b5ad1326"].join("-");
const CODEX_SESSION = ["029f4906", "3f67", "7b72", "9fbc", "9ec3b5ad1326"].join("-");
const CLAUDE_PATH = `/home/user/.claude/projects/-repo/${CLAUDE_SESSION}.jsonl`;
const CODEX_PATH = `/home/user/.codex/sessions/2026/08/26/rollout-2026-08-26-${CODEX_SESSION}.jsonl`;
const CONVERSATION = ["conversation", "9ec3b5ad1326be7f"].join("_");
const MTIME = 1_700;
const LAST_ACTIVE_AT = new Date(MTIME * 1_000).toISOString();

const CLAUDE_BROKER_ARGV = [
  "claude", "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
];
const CODEX_HOST_ARGV = ["codex", "app-server", "--enable", "realtime_conversation"];

function file(over: Partial<FileEntry> & Pick<FileEntry, "path">): FileEntry {
  return {
    root: "claude-projects",
    name: over.path,
    project: "live-log-viewer-next",
    title: "Structured lane",
    engine: "claude",
    kind: "session",
    fmt: "claude",
    parent: null,
    mtime: MTIME,
    size: 1,
    activity: "idle",
    proc: "running",
    pid: null,
    model: null,
    pendingQuestion: null,
    waitingInput: null,
    ...over,
  } as FileEntry;
}

function record(over: Partial<StructuredHostRecord> = {}): StructuredHostRecord {
  return {
    id: `claude:${CLAUDE_SESSION}`,
    engine: "claude",
    sessionId: CLAUDE_SESSION,
    pid: 4_100,
    startIdentity: "4100:start",
    cwd: "/repo/worktree",
    path: CLAUDE_PATH,
    conversationId: CONVERSATION,
    title: "Structured lane",
    role: "builder",
    model: "opus",
    stage: "implement",
    seat: false,
    turnBusy: false,
    owned: true,
    ...over,
  };
}

function agent(over: Partial<AgentProcess> & Pick<AgentProcess, "pid">): AgentProcess {
  return { engine: "claude", argv: CLAUDE_BROKER_ARGV, cwd: "/repo/worktree", tty: 0, ...over };
}

function memory(pids: number[]): Map<number, { rssBytes: number; swapBytes: number }> {
  return new Map(pids.map((pid) => [pid, { rssBytes: 1, swapBytes: 0 }]));
}

function dependencies(over: Partial<ResourceSnapshotDependencies> = {}): ResourceSnapshotDependencies {
  return {
    readFiles: async () => [],
    readHosts: async () => ({ hosts: [], observation: "available", conflicts: [], canonicalFor: () => null }),
    proc: {
      systemMemory: () => null,
      ppidMap: () => new Map(),
      processMemory: () => new Map(),
    },
    captureAttachReferences: () => new Map(),
    readStructuredHosts: async () => [],
    listAgentProcesses: () => [],
    directoryExists: () => true,
    processIdentity: (pid) => `${pid}:start`,
    /* Scan-discovered hosts have to prove the viewer spawned them; these
       fixtures stand in for processes carrying this viewer's own stamp. */
    hostStamp: () => structuredHostStamp(),
    ...over,
  };
}

beforeEach(() => {
  resetResourcesForTests();
});

test("a registry-recorded structured host becomes a row with its whole process tree", async () => {
  const payload = await buildResourceSnapshot(true, dependencies({
    readFiles: async () => [file({ path: CLAUDE_PATH, activity: "recent" })],
    readStructuredHosts: async () => [record()],
    proc: {
      systemMemory: () => ({ ramTotal: 1_000, ramAvailable: 750, swapTotal: 0, swapUsed: 0 }),
      /* the shell/nsenter wrapper, the CLI under it, and one MCP child */
      ppidMap: () => new Map([[4_200, 4_100], [4_300, 4_200]]),
      processMemory: () => new Map([
        [4_100, { rssBytes: 5, swapBytes: 1 }],
        [4_200, { rssBytes: 500, swapBytes: 0 }],
        [4_300, { rssBytes: 95, swapBytes: 4 }],
      ]),
    },
  }));

  expect(payload.sessions).toEqual([{
    target: `structured:claude:${CLAUDE_SESSION}`,
    panePid: 4_100,
    kind: "structured",
    path: CLAUDE_PATH,
    engine: "claude",
    title: "Structured lane",
    project: "live-log-viewer-next",
    activity: "recent",
    lastActiveAt: LAST_ACTIVE_AT,
    cwd: "/repo/worktree",
    rssBytes: 600,
    swapBytes: 5,
    procCount: 3,
    model: "opus",
    role: "builder",
    conversationId: CONVERSATION,
    stage: "implement",
    ownership: "owned",
    seat: false,
    turnBusy: false,
  } satisfies ResourceSession]);
});

test("ownership separates a held host from a released one and from a vanished worktree", async () => {
  const payload = await buildResourceSnapshot(true, dependencies({
    readStructuredHosts: async () => [
      record({ id: "claude:held", sessionId: "held", pid: 10, startIdentity: null, path: null, owned: true }),
      record({ id: "claude:let-go", sessionId: "let-go", pid: 11, startIdentity: null, path: null, owned: false }),
      record({ id: "claude:gone", sessionId: "gone", pid: 12, startIdentity: null, path: null, owned: true, cwd: "/repo/deleted" }),
    ],
    proc: {
      systemMemory: () => null,
      ppidMap: () => new Map(),
      processMemory: () => memory([10, 11, 12]),
    },
    directoryExists: (directory) => directory !== "/repo/deleted",
  }));

  expect(payload.sessions.map((session) => [session.target, session.ownership])).toEqual([
    ["structured:claude:held", "owned"],
    ["structured:claude:let-go", "released"],
    ["structured:claude:gone", "orphaned"],
  ]);
  /* None of these records ever captured a start identity. The rows still get
     one — the identity observed with the pid now — because a null would hand
     the kill fence a pid the kernel may recycle under it. */
  expect(lastResourceTargetRefs().map(({ ref }) => (ref as { startIdentity: string }).startIdentity))
    .toEqual(["10:start", "11:start", "12:start"]);
});

test("a host process no record covers is listed as orphaned so it can be reclaimed", async () => {
  const payload = await buildResourceSnapshot(true, dependencies({
    readStructuredHosts: async () => [record()],
    listAgentProcesses: () => [
      agent({ pid: 4_100 }),
      agent({ pid: 7_000, engine: "codex", argv: CODEX_HOST_ARGV, cwd: "/repo/other" }),
    ],
    proc: {
      systemMemory: () => null,
      ppidMap: () => new Map(),
      processMemory: () => new Map([[4_100, { rssBytes: 10, swapBytes: 0 }], [7_000, { rssBytes: 20, swapBytes: 0 }]]),
    },
  }));

  expect(payload.sessions.map((session) => [session.target, session.engine, session.ownership])).toEqual([
    ["structured:pid:7000", "codex", "orphaned"],
    [`structured:claude:${CLAUDE_SESSION}`, "claude", "owned"],
  ]);
  const orphan = payload.sessions.find((session) => session.target === "structured:pid:7000");
  expect(orphan?.conversationId).toBeNull();
  expect(orphan?.cwd).toBe("/repo/other");
});

test("the operator's own CLIs and account-migration successors never enter the list", async () => {
  const payload = await buildResourceSnapshot(true, dependencies({
    listAgentProcesses: () => [
      agent({ pid: 8_001, argv: ["claude"] }),
      agent({ pid: 8_002, engine: "codex", argv: ["codex", "resume", "--last"] }),
      agent({ pid: 8_003, argv: [...CLAUDE_BROKER_ARGV, "--resume", CLAUDE_PATH, "--fork-session"] }),
    ],
    proc: {
      systemMemory: () => null,
      ppidMap: () => new Map(),
      processMemory: () => memory([8_001, 8_002, 8_003]),
    },
  }));

  expect(payload.sessions).toEqual([]);
  expect(lastResourceTargetRefs()).toEqual([]);
});

test("a process wearing the same command line without this viewer's stamp is nobody's to kill", async () => {
  const payload = await buildResourceSnapshot(true, dependencies({
    /* Byte-for-byte the argv a host runs — another agent harness, a desktop
       client, a second viewer installation. Only the environment tells them
       apart, and only this viewer's own stamp gets in. */
    listAgentProcesses: () => [
      agent({ pid: 9_001, engine: "codex", argv: CODEX_HOST_ARGV }),
      agent({ pid: 9_002, argv: CLAUDE_BROKER_ARGV }),
      agent({ pid: 9_003, argv: CLAUDE_BROKER_ARGV }),
    ],
    proc: {
      systemMemory: () => null,
      ppidMap: () => new Map(),
      processMemory: () => memory([9_001, 9_002, 9_003]),
    },
    hostStamp: (pid) => (pid === 9_003 ? structuredHostStamp() : pid === 9_002 ? "/some/other/viewer/state" : null),
  }));

  expect(payload.sessions.map((session) => session.target)).toEqual(["structured:pid:9003"]);
});

test("a record whose process exited or was recycled is dropped", async () => {
  const payload = await buildResourceSnapshot(true, dependencies({
    readStructuredHosts: async () => [
      record({ id: "claude:exited", sessionId: "exited", pid: 900, startIdentity: "900:start" }),
      record({ id: "claude:recycled", sessionId: "recycled", pid: 901, startIdentity: "901:start" }),
    ],
    proc: {
      systemMemory: () => null,
      ppidMap: () => new Map(),
      processMemory: () => memory([901]),
    },
    /* 900 exited; 901 is a different process wearing the recycled pid. */
    processIdentity: (pid) => (pid === 901 ? "901:other" : null),
  }));

  expect(payload.sessions).toEqual([]);
});

test("the kill allowlist holds exactly the listed hosts and a consumed target cannot return", async () => {
  await buildResourceSnapshot(true, dependencies({
    readFiles: async () => [file({ path: CODEX_PATH, engine: "codex", activity: "live" })],
    readStructuredHosts: async () => [
      record(),
      record({
        id: "codex:seat", engine: "codex", sessionId: "seat", pid: 5_000, startIdentity: "5000:start",
        path: CODEX_PATH, seat: true, turnBusy: true,
      }),
    ],
    proc: {
      systemMemory: () => null,
      ppidMap: () => new Map(),
      processMemory: () => new Map([[4_100, { rssBytes: 2, swapBytes: 0 }], [5_000, { rssBytes: 1, swapBytes: 0 }]]),
    },
  }));
  noteSessionTargets(lastResourceTargetRefs());

  expect(lastResourceTargetRefs().map(({ target }) => target).sort()).toEqual([
    `structured:claude:${CLAUDE_SESSION}`,
    "structured:codex:seat",
  ]);
  expect(allowedStructuredHostTarget("structured:codex:seat")).toEqual({
    kind: "structured",
    pid: 5_000,
    startIdentity: "5000:start",
    engine: "codex",
    sessionId: "seat",
    conversationId: CONVERSATION,
    seat: true,
    turnBusy: true,
    owned: true,
    lastActiveAt: LAST_ACTIVE_AT,
  });
  expect(allowedStructuredHostTarget("structured:codex:not-listed")).toBeNull();

  consumeKillTarget("structured:codex:seat");
  expect(allowedStructuredHostTarget("structured:codex:seat")).toBeNull();
});

/* The collector runs in a contained worker process. This exercises the whole
   handoff for real: a host record in, an observation with the structured row
   and its kill authority out, against a process tree spawned here. */
const workerFixtures: ChildProcess[] = [];
const workerHome = mkdtempSync(path.join(os.tmpdir(), "llv-structured-host-worker-"));

afterEach(() => {
  for (const child of workerFixtures.splice(0)) {
    try {
      if (child.pid) process.kill(-child.pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
});

afterAll(() => {
  rmSync(workerHome, { recursive: true, force: true });
});

test("the collector worker turns a host record into a listed row with kill authority", async () => {
  const child = spawn("/bin/sh", ["-c", "sleep 30 & wait"], { detached: true, stdio: "ignore" });
  workerFixtures.push(child);
  const pid = child.pid;
  if (pid === undefined) throw new Error("fixture tree did not start");
  const startIdentity = procBackend.processIdentity(pid);
  const request = JSON.stringify({
    type: "collect",
    fresh: false,
    files: [],
    hosts: [{
      id: "claude:worker-host",
      engine: "claude",
      sessionId: "worker-host",
      pid,
      startIdentity,
      cwd: workerHome,
      path: null,
      conversationId: null,
      title: "Worker host",
      role: "builder",
      model: "opus",
      stage: "implement",
      seat: false,
      turnBusy: false,
      owned: false,
    }],
  }) + "\n";

  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: workerHome,
    LLV_STATE_DIR: path.join(workerHome, "state"),
    TMPDIR: path.join(workerHome, "tmp"),
    LLV_AGENT_REGISTRY_SQLITE: "off",
  };
  delete env.XDG_CONFIG_HOME;
  delete env.LLV_RESOURCE_COLLECTOR_IN_PROCESS;
  const worker = Bun.spawn([process.execPath, path.join(process.cwd(), "src/lib/resourceCollector.worker.ts")], {
    cwd: process.cwd(),
    env,
    stdin: new Blob([request]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exit, stdout] = await Promise.all([worker.exited, new Response(worker.stdout).text()]);
  expect(exit).toBe(0);

  const observation = JSON.parse(stdout) as {
    type: string;
    payload: { sessions: Array<Record<string, unknown>> };
    targets: Array<{ target: string; ref: Record<string, unknown> }>;
  };
  expect(observation.type).toBe("observation");
  const row = observation.payload.sessions.find((session) => session.target === "structured:claude:worker-host");
  expect(row).toMatchObject({
    kind: "structured",
    panePid: pid,
    engine: "claude",
    title: "Worker host",
    role: "builder",
    stage: "implement",
    model: "opus",
    ownership: "released",
    seat: false,
    turnBusy: false,
  });
  expect(row?.rssBytes as number).toBeGreaterThan(0);
  expect(row?.procCount as number).toBeGreaterThanOrEqual(2);
  expect(observation.targets.find((target) => target.target === "structured:claude:worker-host")?.ref).toMatchObject({
    kind: "structured",
    pid,
    startIdentity,
    engine: "claude",
    sessionId: "worker-host",
    owned: false,
  });
});
