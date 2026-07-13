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

test("headless reaper threshold defaults to two hours and rejects unsafe overrides", () => {
  expect(headlessReaperThresholdMs({})).toBe(2 * 60 * 60_000);
  expect(headlessReaperThresholdMs({ LLV_HEADLESS_REAPER_THRESHOLD_MS: "10800000" })).toBe(3 * 60 * 60_000);
  expect(headlessReaperThresholdMs({ LLV_HEADLESS_REAPER_THRESHOLD_MS: "1000" })).toBe(2 * 60 * 60_000);
});
