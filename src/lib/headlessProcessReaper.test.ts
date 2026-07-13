import { expect, test } from "bun:test";

import type { Flow } from "@/lib/flows/types";

import {
  headlessReaperThresholdMs,
  runHeadlessProcessReaper,
  selectHeadlessProcessCandidates,
  type ReaperProcess,
} from "./headlessProcessReaper";

const old = 3 * 60 * 60_000;
const flowArtifactsRoot = "/viewer-state/flows";

function viewerOutput(flowId: string, round: number): string {
  return `${flowArtifactsRoot}/${flowId}/round-${round}-last-message.md`;
}

function process(pid: number, ppid: number, argv: string[], ageMs = old, tty = 0): ReaperProcess {
  return { pid, ppid, argv, ageMs, identity: `${pid}:start`, tty, cwd: null };
}

function activeFlow(pid: number): Flow {
  return {
    id: `flow-${pid}`,
    template: "implement-review-loop",
    project: "project",
    cwd: "/repo",
    implementerPath: "/sessions/implementer.jsonl",
    roles: {
      implementer: { engine: "codex", model: null, effort: null },
      reviewer: { engine: "codex", model: null, effort: null },
    },
    baseRef: "abc",
    baseMode: "head",
    mode: "auto",
    reviewerMode: "headless",
    roundLimit: 5,
    state: "reviewing",
    stateDetail: null,
    rounds: [{
      n: 1,
      reviewerPath: null,
      reviewerPid: pid,
      reviewerIdentity: `${pid}:start`,
      findingsPath: null,
      triggeredBy: "marker",
      readyNote: null,
      verdict: null,
      findingsCount: null,
      startedAt: new Date().toISOString(),
      reviewedAt: null,
      relayedAt: null,
      error: null,
    }],
    createdAt: new Date().toISOString(),
    closedAt: null,
  };
}

function finishedFlow(pid: number): Flow {
  const flow = activeFlow(pid);
  flow.state = "fixing";
  flow.rounds[0]!.verdict = "REQUEST_CHANGES";
  flow.rounds[0]!.terminalAt = new Date().toISOString();
  return flow;
}

test("headless process reaper selects stale viewer exec groups and orphaned MCP roots", () => {
  const processes = [
    process(100, 1, ["codex", "exec", "--json", "--output-last-message", viewerOutput("flow-100", 1)]),
    process(101, 100, ["npm", "exec", "chrome-devtools-mcp"]),
    process(200, 1, ["codex", "exec", "--json", "--output-last-message", viewerOutput("flow-200", 1)]),
    process(201, 200, ["codex-telegram-mcp"]),
    process(300, 1, ["bash"], old, 1),
    process(301, 300, ["codex"]),
    process(302, 301, ["npm", "exec", "@playwright/mcp"]),
    process(400, 1, ["claude", "--print"]),
    process(401, 400, ["npm", "exec", "context7-mcp"]),
    process(500, 1, ["uv", "tool", "run", "codex-telegram-mcp"]),
    process(600, 1, ["npm", "exec", "context7-mcp"], 30_000),
    process(700, 1, ["codex", "exec", "Write a summary"]),
    process(710, 1, ["claude", "-p", "audit MCP servers"]),
    process(711, 1, ["codex", "exec", "investigate mcp startup"]),
    process(712, 1, ["codex", "-c", "mcp_servers={}", "app-server"]),
    process(750, 1, ["codex", "exec", "--json", "--output-last-message", "/home/user/manual-review.md"]),
    process(760, 1, ["codex", "exec", "--json", "--output-last-message", viewerOutput("untracked-flow", 1)]),
    process(800, 1, ["codex", "app-server"]),
    process(801, 800, ["npm", "exec", "chrome-devtools-mcp"]),
    process(850, 1, ["/opt/custom-structured-host", "app-server"]),
    process(851, 850, ["npm", "exec", "chrome-devtools-mcp"]),
  ];

  expect(selectHeadlessProcessCandidates({
    processes,
    flows: [finishedFlow(100), activeFlow(200)],
    hosts: [],
    panePids: [300],
    flowArtifactsRoot,
    thresholdMs: 2 * 60 * 60_000,
  })).toEqual([
    { pid: 100, identity: "100:start", kind: "codex-exec" },
    { pid: 500, identity: "500:start", kind: "orphan-mcp" },
  ]);
});

test("headless process reaper ignores MCP text in generic command arguments", () => {
  const processes = [
    process(810, 1, ["bash", "-c", "sleep 99999 # investigate mcp startup"]),
    process(811, 1, ["sleep", "99999", "--log", "/var/log/mcp-startup.log"]),
    process(812, 1, ["python", "/opt/audit/mcp/report.py"]),
    process(813, 1, ["node", "server.js", "--description", "MCP server audit"]),
  ];

  expect(selectHeadlessProcessCandidates({
    processes,
    flows: [],
    hosts: [],
    panePids: [],
    flowArtifactsRoot,
    thresholdMs: 2 * 60 * 60_000,
  })).toEqual([]);
});

test("headless process reaper selects the deployed uv run Telegram MCP root", () => {
  const processes = [
    process(820, 1, ["uv", "--directory", "/srv/codex-telegram-mcp", "run", "codex-telegram-mcp"]),
    process(821, 820, ["codex-telegram-mcp"]),
  ];

  expect(selectHeadlessProcessCandidates({
    processes,
    flows: [],
    hosts: [],
    panePids: [],
    flowArtifactsRoot,
    thresholdMs: 2 * 60 * 60_000,
  })).toEqual([{ pid: 820, identity: "820:start", kind: "orphan-mcp" }]);
});

test("headless reaper revalidates ownership and applies TERM then KILL to the stale group", async () => {
  const viewerExec = process(900, 1, ["codex", "exec", "--json", "--output-last-message", viewerOutput("flow-900", 1)]);
  const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  const timers: Array<() => void> = [];
  const report = await runHeadlessProcessReaper({
    hosts: [],
    flows: [finishedFlow(900)],
    thresholdMs: 2 * 60 * 60_000,
    flowArtifactsRoot,
    dependencies: {
      listProcesses: () => [viewerExec],
      ppidMap: () => new Map([[900, 1]]),
      processIdentity: () => "900:start",
      processAgeMs: () => old,
      loadFlows: () => [finishedFlow(900)],
      readHosts: async () => [],
      readPanePids: async () => [],
      signalProcess: (pid, signal) => { signals.push({ pid, signal }); },
      setTimeout: (callback) => {
        timers.push(callback);
        return { unref() {} } as unknown as ReturnType<typeof setTimeout>;
      },
    },
  });

  expect(report).toEqual({ candidates: 1, signaled: 1 });
  expect(signals).toEqual([{ pid: -900, signal: "SIGTERM" }]);
  timers[0]!();
  expect(signals).toEqual([
    { pid: -900, signal: "SIGTERM" },
    { pid: -900, signal: "SIGKILL" },
  ]);
});

test("stale review cleanup aborts when the leader identity changes before TERM", async () => {
  const viewerExec = process(940, 1, ["codex", "exec", "--json", "--output-last-message", viewerOutput("flow-940", 1)]);
  const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  let identityReads = 0;
  const report = await runHeadlessProcessReaper({
    hosts: [],
    flows: [finishedFlow(940)],
    thresholdMs: 2 * 60 * 60_000,
    flowArtifactsRoot,
    dependencies: {
      listProcesses: () => [viewerExec],
      ppidMap: () => new Map([[940, 1]]),
      processIdentity: () => {
        identityReads += 1;
        return identityReads <= 2 ? "940:start" : "940:replacement";
      },
      processAgeMs: () => old,
      loadFlows: () => [finishedFlow(940)],
      readHosts: async () => [],
      readPanePids: async () => [],
      signalProcess: (pid, signal) => { signals.push({ pid, signal }); },
    },
  });

  expect(report).toEqual({ candidates: 1, signaled: 0 });
  expect(signals).toEqual([]);
});

test("headless reaper protects an active flow launched through a custom Codex binary", async () => {
  const processes = [
    process(910, 1, ["/opt/viewer-reviewer", "exec", "--json", "--output-last-message", viewerOutput("flow-910", 1)]),
    process(911, 910, ["npm", "exec", "context7-mcp"]),
  ];
  const signals: number[] = [];
  const report = await runHeadlessProcessReaper({
    hosts: [],
    flows: [activeFlow(910)],
    thresholdMs: 2 * 60 * 60_000,
    flowArtifactsRoot,
    dependencies: {
      listProcesses: () => processes,
      ppidMap: () => new Map([[910, 1], [911, 910]]),
      processIdentity: (pid) => `${pid}:start`,
      processAgeMs: () => old,
      loadFlows: () => [activeFlow(910)],
      readHosts: async () => [],
      readPanePids: async () => [],
      signalProcess: (pid) => { signals.push(pid); },
    },
  });

  expect(report).toEqual({ candidates: 0, signaled: 0 });
  expect(signals).toEqual([]);
});

test("orphan cleanup aborts when the root identity changes before TERM", async () => {
  const orphan = process(920, 1, ["npm", "exec", "context7-mcp"]);
  const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  let identityReads = 0;
  const report = await runHeadlessProcessReaper({
    hosts: [],
    flows: [],
    thresholdMs: 2 * 60 * 60_000,
    flowArtifactsRoot,
    dependencies: {
      listProcesses: () => [orphan],
      ppidMap: () => new Map([[920, 1]]),
      processIdentity: () => {
        identityReads += 1;
        return identityReads <= 2 ? "920:start" : "920:replacement";
      },
      processAgeMs: () => old,
      loadFlows: () => [],
      readHosts: async () => [],
      readPanePids: async () => [],
      signalProcess: (pid, signal) => { signals.push({ pid, signal }); },
    },
  });

  expect(report).toEqual({ candidates: 1, signaled: 0 });
  expect(signals).toEqual([]);
});

test("orphan cleanup skips a descendant whose identity changes before TERM", async () => {
  const root = process(930, 1, ["npm", "exec", "context7-mcp"]);
  const child = process(931, 930, ["child-mcp"]);
  const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  const timers: Array<() => void> = [];
  const identityReads = new Map<number, number>();
  const report = await runHeadlessProcessReaper({
    hosts: [],
    flows: [],
    thresholdMs: 2 * 60 * 60_000,
    flowArtifactsRoot,
    dependencies: {
      listProcesses: () => [root, child],
      ppidMap: () => new Map([[930, 1], [931, 930]]),
      processIdentity: (pid) => {
        const reads = (identityReads.get(pid) ?? 0) + 1;
        identityReads.set(pid, reads);
        return pid === 931 && reads >= 3 ? "931:replacement" : `${pid}:start`;
      },
      processAgeMs: () => old,
      loadFlows: () => [],
      readHosts: async () => [],
      readPanePids: async () => [],
      signalProcess: (pid, signal) => { signals.push({ pid, signal }); },
      setTimeout: (callback) => {
        timers.push(callback);
        return { unref() {} } as unknown as ReturnType<typeof setTimeout>;
      },
    },
  });

  expect(report).toEqual({ candidates: 1, signaled: 1 });
  expect(signals).toEqual([{ pid: 930, signal: "SIGTERM" }]);
  timers[0]!();
  expect(signals).toEqual([
    { pid: 930, signal: "SIGTERM" },
    { pid: 930, signal: "SIGKILL" },
  ]);
});

test("orphan cleanup captures and kills an unrecognized descendant", async () => {
  const root = process(950, 1, ["npm", "exec", "chrome-devtools-mcp"]);
  const child = process(951, 950, ["node", "server.js"]);
  const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  const timers: Array<() => void> = [];
  const report = await runHeadlessProcessReaper({
    hosts: [],
    flows: [],
    thresholdMs: 2 * 60 * 60_000,
    flowArtifactsRoot,
    dependencies: {
      listProcesses: () => [root, child],
      ppidMap: () => new Map([[950, 1], [951, 950]]),
      processIdentity: (pid) => `${pid}:start`,
      processAgeMs: () => old,
      loadFlows: () => [],
      readHosts: async () => [],
      readPanePids: async () => [],
      signalProcess: (pid, signal) => { signals.push({ pid, signal }); },
      setTimeout: (callback) => {
        timers.push(callback);
        return { unref() {} } as unknown as ReturnType<typeof setTimeout>;
      },
    },
  });

  expect(report).toEqual({ candidates: 1, signaled: 1 });
  expect(signals).toEqual([
    { pid: 951, signal: "SIGTERM" },
    { pid: 950, signal: "SIGTERM" },
  ]);
  timers[0]!();
  expect(signals).toEqual([
    { pid: 951, signal: "SIGTERM" },
    { pid: 950, signal: "SIGTERM" },
    { pid: 951, signal: "SIGKILL" },
    { pid: 950, signal: "SIGKILL" },
  ]);
});

test("orphan cleanup aborts when its tree contains an active flow reviewer", async () => {
  const root = process(970, 1, ["npm", "exec", "chrome-devtools-mcp"]);
  const reviewer = process(971, 970, ["codex", "exec", "-"]);
  const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  const report = await runHeadlessProcessReaper({
    hosts: [],
    flows: [activeFlow(971)],
    thresholdMs: 2 * 60 * 60_000,
    flowArtifactsRoot,
    dependencies: {
      listProcesses: () => [root, reviewer],
      ppidMap: () => new Map([[970, 1], [971, 970]]),
      processIdentity: (pid) => `${pid}:start`,
      processAgeMs: () => old,
      loadFlows: () => [activeFlow(971)],
      readHosts: async () => [],
      readPanePids: async () => [],
      signalProcess: (pid, signal) => { signals.push({ pid, signal }); },
    },
  });

  expect(report).toEqual({ candidates: 1, signaled: 0 });
  expect(signals).toEqual([]);
});

test("orphan cleanup aborts when its tree contains a Claude owner", async () => {
  const root = process(980, 1, ["npm", "exec", "chrome-devtools-mcp"]);
  const claude = process(981, 980, ["claude", "--print", "continue"]);
  const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  const report = await runHeadlessProcessReaper({
    hosts: [],
    flows: [],
    thresholdMs: 2 * 60 * 60_000,
    flowArtifactsRoot,
    dependencies: {
      listProcesses: () => [root, claude],
      ppidMap: () => new Map([[980, 1], [981, 980]]),
      processIdentity: (pid) => `${pid}:start`,
      processAgeMs: () => old,
      loadFlows: () => [],
      readHosts: async () => [],
      readPanePids: async () => [],
      signalProcess: (pid, signal) => { signals.push({ pid, signal }); },
    },
  });

  expect(report).toEqual({ candidates: 1, signaled: 0 });
  expect(signals).toEqual([]);
});

test("orphan cleanup aborts when its root becomes a Claude owner before TERM", async () => {
  const root = process(985, 1, ["npm", "exec", "chrome-devtools-mcp"]);
  const claude = process(985, 1, ["claude", "--print", "continue"]);
  const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  let processScans = 0;
  const report = await runHeadlessProcessReaper({
    hosts: [],
    flows: [],
    thresholdMs: 2 * 60 * 60_000,
    flowArtifactsRoot,
    dependencies: {
      listProcesses: () => {
        processScans += 1;
        return processScans >= 3 ? [claude] : [root];
      },
      ppidMap: () => new Map([[985, 1]]),
      processIdentity: () => "985:start",
      processAgeMs: () => old,
      loadFlows: () => [],
      readHosts: async () => [],
      readPanePids: async () => [],
      signalProcess: (pid, signal) => { signals.push({ pid, signal }); },
    },
  });

  expect(report).toEqual({ candidates: 1, signaled: 0 });
  expect(signals).toEqual([]);
});

test("orphan cleanup protects a descendant that becomes a Claude owner before KILL", async () => {
  const root = process(990, 1, ["npm", "exec", "chrome-devtools-mcp"]);
  const child = process(991, 990, ["node", "server.js"]);
  const claude = process(991, 990, ["claude", "--print", "continue"]);
  const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  const timers: Array<() => void> = [];
  let processScans = 0;
  const report = await runHeadlessProcessReaper({
    hosts: [],
    flows: [],
    thresholdMs: 2 * 60 * 60_000,
    flowArtifactsRoot,
    dependencies: {
      listProcesses: () => {
        processScans += 1;
        return processScans >= 4 ? [root, claude] : [root, child];
      },
      ppidMap: () => new Map([[990, 1], [991, 990]]),
      processIdentity: (pid) => `${pid}:start`,
      processAgeMs: () => old,
      loadFlows: () => [],
      readHosts: async () => [],
      readPanePids: async () => [],
      signalProcess: (pid, signal) => { signals.push({ pid, signal }); },
      setTimeout: (callback) => {
        timers.push(callback);
        return { unref() {} } as unknown as ReturnType<typeof setTimeout>;
      },
    },
  });

  expect(report).toEqual({ candidates: 1, signaled: 1 });
  expect(signals).toEqual([
    { pid: 991, signal: "SIGTERM" },
    { pid: 990, signal: "SIGTERM" },
  ]);
  timers[0]!();
  expect(signals).toEqual([
    { pid: 991, signal: "SIGTERM" },
    { pid: 990, signal: "SIGTERM" },
    { pid: 990, signal: "SIGKILL" },
  ]);
});

test("orphan cleanup skips an unrecognized descendant whose identity changes before KILL", async () => {
  const root = process(960, 1, ["npm", "exec", "chrome-devtools-mcp"]);
  const child = process(961, 960, ["node", "server.js"]);
  const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  const timers: Array<() => void> = [];
  const identityReads = new Map<number, number>();
  const report = await runHeadlessProcessReaper({
    hosts: [],
    flows: [],
    thresholdMs: 2 * 60 * 60_000,
    flowArtifactsRoot,
    dependencies: {
      listProcesses: () => [root, child],
      ppidMap: () => new Map([[960, 1], [961, 960]]),
      processIdentity: (pid) => {
        const reads = (identityReads.get(pid) ?? 0) + 1;
        identityReads.set(pid, reads);
        return pid === 961 && reads >= 3 ? "961:replacement" : `${pid}:start`;
      },
      processAgeMs: () => old,
      loadFlows: () => [],
      readHosts: async () => [],
      readPanePids: async () => [],
      signalProcess: (pid, signal) => { signals.push({ pid, signal }); },
      setTimeout: (callback) => {
        timers.push(callback);
        return { unref() {} } as unknown as ReturnType<typeof setTimeout>;
      },
    },
  });

  expect(report).toEqual({ candidates: 1, signaled: 1 });
  expect(signals).toEqual([
    { pid: 961, signal: "SIGTERM" },
    { pid: 960, signal: "SIGTERM" },
  ]);
  timers[0]!();
  expect(signals).toEqual([
    { pid: 961, signal: "SIGTERM" },
    { pid: 960, signal: "SIGTERM" },
    { pid: 960, signal: "SIGKILL" },
  ]);
});

test("headless reaper threshold defaults to two hours and rejects unsafe overrides", () => {
  expect(headlessReaperThresholdMs({})).toBe(2 * 60 * 60_000);
  expect(headlessReaperThresholdMs({ LLV_HEADLESS_REAPER_THRESHOLD_MS: "10800000" })).toBe(3 * 60 * 60_000);
  expect(headlessReaperThresholdMs({ LLV_HEADLESS_REAPER_THRESHOLD_MS: "1000" })).toBe(2 * 60 * 60_000);
});
