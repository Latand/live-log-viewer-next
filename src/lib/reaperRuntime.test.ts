import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { AgentRegistry, type TmuxHostEvidence } from "@/lib/agent/registry";
import type { TranscriptHost, TranscriptHostSnapshot } from "@/lib/agent/transcriptHost";
import { mutateBoard, setBoardFileForTests } from "@/lib/board/store";
import type { Flow } from "@/lib/flows/types";
import type { FileEntry } from "@/lib/types";

import { killHeadlessReviewerIfMatches, readReaperReport, refreshMergedFlowIds, runReaperCycle } from "./reaperRuntime";

const originalStateDir = process.env.LLV_STATE_DIR;
const originalEnabled = process.env.LLV_REAPER_ENABLED;

afterEach(() => {
  setBoardFileForTests(null);
  if (originalStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = originalStateDir;
  if (originalEnabled === undefined) delete process.env.LLV_REAPER_ENABLED;
  else process.env.LLV_REAPER_ENABLED = originalEnabled;
});

test("runtime cycle persists an API report in dry-run mode by default", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-reaper-runtime-"));
  process.env.LLV_STATE_DIR = directory;
  delete process.env.LLV_REAPER_ENABLED;
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));

  try {
    const report = await runReaperCycle({ registry, hosts: [], files: [], now: Date.parse("2026-07-12T12:00:00.000Z") });

    expect(report).toMatchObject({ mode: "dry-run", configFlag: "LLV_REAPER_ENABLED", eligibleCount: 0, agents: [] });
    expect(readReaperReport()).toEqual(report);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("runtime cycle enters active mode only for the exact opt-in flag", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-reaper-active-"));
  process.env.LLV_STATE_DIR = directory;
  process.env.LLV_REAPER_ENABLED = "true";
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));

  try {
    expect((await runReaperCycle({ registry, hosts: [], files: [] })).mode).toBe("dry-run");
    process.env.LLV_REAPER_ENABLED = "1";
    expect((await runReaperCycle({ registry, hosts: [], files: [] })).mode).toBe("active");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function runtimeHost(pathname: string): TranscriptHost {
  return {
    tmuxServerPid: 900,
    paneId: "%41",
    panePid: 1041,
    agentPid: 2041,
    display: "agents:41.0",
    windowName: "worker-41",
    engine: "codex",
    cwd: "/repo",
    agentArgv: ["codex", "resume", pathname],
    agentIdentity: "2041:one",
    launchId: null,
    claimedPaths: [pathname],
    primaryPath: pathname,
  };
}

function runtimeEvidence(host: TranscriptHost, suffix = "original"): TmuxHostEvidence {
  return {
    kind: "tmux",
    endpoint: "/tmp/llv-test-tmux.sock",
    server: { pid: host.tmuxServerPid, startIdentity: `${host.tmuxServerPid}:${suffix}` },
    paneId: host.paneId,
    panePid: { pid: host.panePid, startIdentity: `${host.panePid}:${suffix}` },
    windowName: host.windowName ?? "",
    agent: { pid: host.agentPid, startIdentity: host.agentIdentity },
    argv: host.agentArgv,
  };
}

function runtimeFile(pathname: string, mtime: number): FileEntry {
  return {
    path: pathname,
    root: "codex-sessions",
    name: path.basename(pathname),
    project: "repo",
    title: "worker",
    engine: "codex",
    kind: "conversation",
    fmt: "codex",
    parent: null,
    mtime,
    size: 1,
    activity: "idle",
    proc: "running",
    pid: null,
    model: null,
    pendingQuestion: null,
    waitingInput: null,
  } as FileEntry;
}

test("an external one-message session keeps the user-authored exemption", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-reaper-external-user-"));
  const pathname = path.join(directory, "rollout-019f4906-3f67-7b72-9fbc-9ec3b5ad1341.jsonl");
  const now = Date.parse("2026-07-12T12:00:00.000Z");
  fs.writeFileSync(pathname, JSON.stringify({
    type: "event_msg",
    timestamp: new Date(now - 2 * 60 * 60_000).toISOString(),
    payload: { type: "user_message", message: "Investigate this session" },
  }) + "\n");
  process.env.LLV_STATE_DIR = directory;
  delete process.env.LLV_REAPER_ENABLED;
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
  const profile = emptyLaunchProfile({ cwd: "/repo", role: "worker", title: "soak probe" });
  registry.reconcileConversations([{
    engine: "codex",
    path: pathname,
    accountId: "default",
    launchProfile: profile,
    turn: { state: "idle", source: "assistant", terminalAt: new Date(now - 2 * 60 * 60_000).toISOString() },
    observedAt: new Date(now - 2 * 60 * 60_000).toISOString(),
  }]);

  try {
    const report = await runReaperCycle({
      registry,
      hosts: [runtimeHost(pathname)],
      files: [runtimeFile(pathname, now / 1000 - 2 * 60 * 60)],
      now,
    });

    expect(report.agents[0]).toMatchObject({ class: null, eligible: false });
    expect(report.agents[0]?.protectedReasons).toContain("user-authored-message");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a completed Viewer worker spawn discounts its single launch prompt", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-reaper-viewer-worker-"));
  const sessionId = "019f4906-3f67-7b72-9fbc-9ec3b5ad1343";
  const pathname = path.join(directory, `rollout-${sessionId}.jsonl`);
  const now = Date.parse("2026-07-12T12:00:00.000Z");
  fs.writeFileSync(pathname, JSON.stringify({
    type: "event_msg",
    timestamp: new Date(now - 2 * 60 * 60_000).toISOString(),
    payload: { type: "user_message", message: "Run the assigned worker task" },
  }) + "\n");
  process.env.LLV_STATE_DIR = directory;
  delete process.env.LLV_REAPER_ENABLED;
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
  const profile = emptyLaunchProfile({ cwd: "/repo", role: "worker", title: "soak probe" });
  const receipt = registry.beginSpawn("codex", "/repo", profile);
  registry.completeSpawn(receipt.launchId, {
    key: { engine: "codex", sessionId },
    artifactPath: pathname,
    cwd: "/repo",
    accountId: "default",
    launchProfile: profile,
    status: "idle",
    host: null,
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: null,
  });
  registry.reconcileConversations([{
    engine: "codex",
    path: pathname,
    accountId: "default",
    launchProfile: profile,
    turn: { state: "idle", source: "assistant", terminalAt: new Date(now - 2 * 60 * 60_000).toISOString() },
    observedAt: new Date(now - 2 * 60 * 60_000).toISOString(),
  }]);

  try {
    const report = await runReaperCycle({
      registry,
      hosts: [runtimeHost(pathname)],
      files: [runtimeFile(pathname, now / 1000 - 2 * 60 * 60)],
      now,
    });

    expect(report.agents[0]).toMatchObject({ class: "probe", eligible: true, protectedReasons: [] });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a dashboard-reconciled root remains eligible while an explicit standalone placement is protected", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-reaper-board-placement-"));
  const reconciledSessionId = "019f4906-3f67-7b72-9fbc-9ec3b5ad1360";
  const explicitSessionId = "019f4906-3f67-7b72-9fbc-9ec3b5ad1361";
  const reconciledPath = path.join(directory, `rollout-${reconciledSessionId}.jsonl`);
  const explicitPath = path.join(directory, `rollout-${explicitSessionId}.jsonl`);
  const boardFile = path.join(directory, "board.json");
  const now = Date.parse("2026-07-12T12:00:00.000Z");
  for (const pathname of [reconciledPath, explicitPath]) {
    fs.writeFileSync(pathname, JSON.stringify({
      type: "event_msg",
      timestamp: new Date(now - 2 * 60 * 60_000).toISOString(),
      payload: { type: "user_message", message: "launch prompt" },
    }) + "\n");
  }
  process.env.LLV_STATE_DIR = directory;
  delete process.env.LLV_REAPER_ENABLED;
  setBoardFileForTests(boardFile);
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
  const profile = emptyLaunchProfile({ cwd: "/repo", role: "worker", title: "probe" });
  for (const [sessionId, pathname] of [[reconciledSessionId, reconciledPath], [explicitSessionId, explicitPath]]) {
    const receipt = registry.beginSpawn("codex", "/repo", profile);
    registry.completeSpawn(receipt.launchId, {
      key: { engine: "codex", sessionId }, artifactPath: pathname, cwd: "/repo", accountId: "default",
      launchProfile: profile, status: "idle", host: null, claimEpoch: 0, claimOwner: null, pendingAction: null,
    });
    registry.reconcileConversations([{
      engine: "codex", path: pathname, accountId: "default", launchProfile: profile,
      turn: { state: "idle", source: "assistant", terminalAt: new Date(now - 2 * 60 * 60_000).toISOString() },
      observedAt: new Date(now - 2 * 60 * 60_000).toISOString(),
    }]);
  }
  expect(mutateBoard("repo", 0, [{ kind: "reconcile-roots", roots: [reconciledPath], removeManual: [] }], boardFile).ok).toBe(true);
  expect(mutateBoard("repo", 1, [{ kind: "restore", path: explicitPath, placement: "manual" }], boardFile).ok).toBe(true);
  const reconciledFile = runtimeFile(reconciledPath, now / 1000 - 2 * 60 * 60);
  const explicitFile = runtimeFile(explicitPath, now / 1000 - 2 * 60 * 60);

  try {
    const report = await runReaperCycle({
      registry,
      hosts: [runtimeHost(reconciledPath), { ...runtimeHost(explicitPath), paneId: "%42", panePid: 1042, agentPid: 2042 }],
      files: [reconciledFile, explicitFile],
      now,
    });

    expect(report.agents[0]).toMatchObject({ class: "probe", eligible: true, protectedReasons: [] });
    expect(report.agents[1]).toMatchObject({ class: "probe", eligible: false });
    expect(report.agents[1]?.protectedReasons).toContain("manual-board-placement");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a running manual root from a legacy persisted board remains protected", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-reaper-legacy-board-placement-"));
  const sessionId = "019f4906-3f67-7b72-9fbc-9ec3b5ad1362";
  const pathname = path.join(directory, `rollout-${sessionId}.jsonl`);
  const boardFile = path.join(directory, "board.json");
  const now = Date.parse("2026-07-12T12:00:00.000Z");
  fs.writeFileSync(pathname, JSON.stringify({
    type: "event_msg",
    timestamp: new Date(now - 2 * 60 * 60_000).toISOString(),
    payload: { type: "user_message", message: "launch prompt" },
  }) + "\n");
  fs.writeFileSync(boardFile, JSON.stringify({
    projects: {
      repo: {
        schemaVersion: 1,
        revision: 7,
        updatedAt: new Date(now - 3 * 60 * 60_000).toISOString(),
        pathAliases: {},
        prefs: { manual: [pathname], hidden: [], expanded: [], viewMode: null, taskPanelOpen: false },
      },
    },
  }));
  process.env.LLV_STATE_DIR = directory;
  delete process.env.LLV_REAPER_ENABLED;
  setBoardFileForTests(boardFile);
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
  const profile = emptyLaunchProfile({ cwd: "/repo", role: "worker", title: "probe" });
  const receipt = registry.beginSpawn("codex", "/repo", profile);
  registry.completeSpawn(receipt.launchId, {
    key: { engine: "codex", sessionId }, artifactPath: pathname, cwd: "/repo", accountId: "default",
    launchProfile: profile, status: "idle", host: null, claimEpoch: 0, claimOwner: null, pendingAction: null,
  });
  registry.reconcileConversations([{
    engine: "codex", path: pathname, accountId: "default", launchProfile: profile,
    turn: { state: "idle", source: "assistant", terminalAt: new Date(now - 2 * 60 * 60_000).toISOString() },
    observedAt: new Date(now - 2 * 60 * 60_000).toISOString(),
  }]);

  try {
    const report = await runReaperCycle({
      registry,
      hosts: [runtimeHost(pathname)],
      files: [runtimeFile(pathname, now / 1000 - 2 * 60 * 60)],
      now,
    });

    expect(report.agents[0]).toMatchObject({ class: "probe", eligible: false });
    expect(report.agents[0]?.protectedReasons).toContain("manual-board-placement");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a malformed transcript protects an otherwise eligible Viewer probe", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-reaper-malformed-authorship-"));
  const sessionId = "019f4906-3f67-7b72-9fbc-9ec3b5ad1346";
  const pathname = path.join(directory, `rollout-${sessionId}.jsonl`);
  const now = Date.parse("2026-07-12T12:00:00.000Z");
  fs.writeFileSync(pathname, "{broken\n");
  process.env.LLV_STATE_DIR = directory;
  delete process.env.LLV_REAPER_ENABLED;
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
  const profile = emptyLaunchProfile({ cwd: "/repo", role: "worker", title: "probe" });
  const receipt = registry.beginSpawn("codex", "/repo", profile);
  registry.completeSpawn(receipt.launchId, {
    key: { engine: "codex", sessionId },
    artifactPath: pathname,
    cwd: "/repo",
    accountId: "default",
    launchProfile: profile,
    status: "idle",
    host: null,
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: null,
  });
  registry.reconcileConversations([{
    engine: "codex",
    path: pathname,
    accountId: "default",
    launchProfile: profile,
    turn: { state: "idle", source: "assistant", terminalAt: new Date(now - 2 * 60 * 60_000).toISOString() },
    observedAt: new Date(now - 2 * 60 * 60_000).toISOString(),
  }]);

  try {
    const report = await runReaperCycle({
      registry,
      hosts: [runtimeHost(pathname)],
      files: [runtimeFile(pathname, now / 1000 - 2 * 60 * 60)],
      now,
    });

    expect(report.agents[0]).toMatchObject({ class: "probe", eligible: false });
    expect(report.agents[0]?.protectedReasons).toContain("authorship-unverified");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("an unknown missing transcript reaches the dead-transcript TTL in production input", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-reaper-missing-policy-"));
  const sessionId = "019f4906-3f67-7b72-9fbc-9ec3b5ad1353";
  const pathname = path.join(directory, `missing-${sessionId}.jsonl`);
  const now = Date.parse("2026-07-12T12:00:00.000Z");
  process.env.LLV_STATE_DIR = directory;
  delete process.env.LLV_REAPER_ENABLED;
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
  const profile = emptyLaunchProfile({ cwd: "/repo", role: "worker" });
  const receipt = registry.beginSpawn("codex", "/repo", profile);
  registry.completeSpawn(receipt.launchId, {
    key: { engine: "codex", sessionId }, artifactPath: pathname, cwd: "/repo", accountId: "default",
    launchProfile: profile, status: "idle", host: null, claimEpoch: 0, claimOwner: null, pendingAction: null,
  });
  registry.reconcileConversations([{
    engine: "codex", path: pathname, accountId: "default", launchProfile: profile,
    turn: { state: "idle", source: "empty", terminalAt: null }, observedAt: new Date(now - 2 * 60 * 60_000).toISOString(),
  }]);
  const host = runtimeHost(pathname);
  fs.writeFileSync(path.join(directory, "reaper-state.json"), JSON.stringify({
    version: 1,
    firstObservedAt: { "%41:2041:2041:one": new Date(now - 31 * 60_000).toISOString() },
    userAuthoredPaths: {},
  }));
  try {
    const report = await runReaperCycle({ registry, hosts: [host], files: [], now });
    expect(report.agents[0]).toMatchObject({ class: "dead-transcript", eligible: true, protectedReasons: [] });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("authorship at the beginning of a transcript survives a tail larger than the session reader window", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-reaper-early-user-"));
  const pathname = path.join(directory, "rollout-019f4906-3f67-7b72-9fbc-9ec3b5ad1344.jsonl");
  const now = Date.parse("2026-07-12T12:00:00.000Z");
  const user = JSON.stringify({
    type: "event_msg",
    timestamp: new Date(now - 2 * 60 * 60_000).toISOString(),
    payload: { type: "user_message", message: "Keep this human session" },
  }) + "\n";
  const assistant = JSON.stringify({
    type: "event_msg",
    timestamp: new Date(now - 60 * 60_000).toISOString(),
    payload: { type: "agent_message", message: "x".repeat(8 * 1024 * 1024 + 1024) },
  }) + "\n";
  fs.writeFileSync(pathname, user + assistant);
  process.env.LLV_STATE_DIR = directory;
  delete process.env.LLV_REAPER_ENABLED;
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
  const profile = emptyLaunchProfile({ cwd: "/repo", role: "worker", title: "soak probe" });
  registry.reconcileConversations([{
    engine: "codex",
    path: pathname,
    accountId: "default",
    launchProfile: profile,
    turn: { state: "idle", source: "assistant", terminalAt: new Date(now - 60 * 60_000).toISOString() },
    observedAt: new Date(now - 60 * 60_000).toISOString(),
  }]);

  try {
    const report = await runReaperCycle({
      registry,
      hosts: [runtimeHost(pathname)],
      files: [runtimeFile(pathname, now / 1000 - 2 * 60 * 60)],
      now,
    });

    expect(report.agents[0]).toMatchObject({ class: null, eligible: false });
    expect(report.agents[0]?.protectedReasons).toContain("user-authored-message");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function headlessFlow(now: number): Flow {
  return {
    id: "flow-headless",
    template: "implement-review-loop",
    project: "repo",
    cwd: "/repo",
    implementerPath: "/implementer.jsonl",
    roles: {
      implementer: { engine: "codex", model: null, effort: null },
      reviewer: { engine: "codex", model: null, effort: null },
    },
    baseRef: "base",
    baseMode: "merge-base",
    mode: "auto",
    reviewerMode: "headless",
    roundLimit: 1,
    state: "closed",
    stateDetail: null,
    rounds: [{
      n: 1,
      reviewerPath: "/reviewer.jsonl",
      reviewerPid: 4041,
      reviewerIdentity: "4041:one",
      reviewerPane: null,
      findingsPath: "/findings",
      triggeredBy: "marker",
      readyNote: null,
      verdict: "APPROVE",
      findingsCount: 0,
      startedAt: new Date(now - 20 * 60_000).toISOString(),
      spawnStartedAt: new Date(now - 20 * 60_000).toISOString(),
      reviewedAt: new Date(now - 6 * 60_000).toISOString(),
      relayedAt: new Date(now - 5 * 60_000).toISOString(),
      error: null,
    }],
    createdAt: new Date(now - 30 * 60_000).toISOString(),
    closedAt: new Date(now - 5 * 60_000).toISOString(),
  };
}

test("a detached headless reviewer is observed and reaped by verified process identity", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-reaper-headless-"));
  const now = Date.parse("2026-07-12T12:00:00.000Z");
  process.env.LLV_STATE_DIR = directory;
  process.env.LLV_REAPER_ENABLED = "1";
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
  let kills = 0;

  try {
    const report = await runReaperCycle({
      registry,
      hosts: [],
      files: [],
      now,
      actuation: {
        loadFlows: () => [headlessFlow(now)],
        pidAlive: (pid) => pid === 4041,
        processIdentity: (pid) => pid === 4041 ? "4041:one" : null,
        killProcess: async (process) => {
          expect(process).toEqual({ pid: 4041, identity: "4041:one" });
          kills += 1;
          return true;
        },
        now: () => now,
      },
    });

    expect(report.agents[0]).toMatchObject({
      targetKind: "process",
      paneId: null,
      agentPid: 4041,
      processIdentity: "4041:one",
      class: "headless-reviewer",
      eligible: true,
      action: "reaped",
    });
    expect(kills).toBe(1);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("headless reviewer termination rejects pid reuse and verifies process exit", async () => {
  let alive = true;
  let identity = "5051:reused";
  let signals = 0;
  const deps = {
    pidAlive: () => alive,
    processIdentity: () => identity,
    signal: () => { signals += 1; alive = false; },
    sleep: async () => {},
    maxVerifyAttempts: 2,
  };

  expect(await killHeadlessReviewerIfMatches({ pid: 5051, identity: "5051:original" }, deps)).toBe(false);
  expect(signals).toBe(0);
  identity = "5051:original";
  expect(await killHeadlessReviewerIfMatches({ pid: 5051, identity: "5051:original" }, deps)).toBe(true);
  expect(signals).toBe(1);
});

test("persisted GitHub merge evidence survives a deleted checkout and allows flow cleanup", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-reaper-merged-flow-"));
  const pathname = path.join(directory, "rollout-019f4906-3f67-7b72-9fbc-9ec3b5ad1345.jsonl");
  const now = Date.parse("2026-07-12T12:00:00.000Z");
  fs.writeFileSync(pathname, "");
  process.env.LLV_STATE_DIR = directory;
  delete process.env.LLV_REAPER_ENABLED;
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
  const profile = emptyLaunchProfile({ cwd: "/deleted/worktree", role: "worker" });
  registry.reconcileConversations([{
    engine: "codex",
    path: pathname,
    accountId: "default",
    launchProfile: profile,
    turn: { state: "idle", source: "assistant", terminalAt: new Date(now - 2 * 60 * 60_000).toISOString() },
    observedAt: new Date(now - 2 * 60 * 60_000).toISOString(),
  }]);
  const flow = {
    ...headlessFlow(now),
    id: "flow-merged",
    cwd: "/deleted/worktree",
    implementerPath: pathname,
    reviewerMode: "pane",
    rounds: [],
    closedAt: new Date(now - 31 * 60_000).toISOString(),
    mergeEvidence: {
      repository: "Latand/live-log-viewer-next",
      headRef: "agent/issue-31-reaper",
      headSha: "a".repeat(40),
      prNumber: 125,
      mergedAt: new Date(now - 10 * 60_000).toISOString(),
      checkedAt: new Date(now - 10 * 60_000).toISOString(),
      source: "github-pr",
    },
  } as Flow;

  try {
    const report = await runReaperCycle({
      registry,
      hosts: [runtimeHost(pathname)],
      files: [runtimeFile(pathname, now / 1000 - 2 * 60 * 60)],
      now,
      actuation: { loadFlows: () => [flow], now: () => now },
    });

    expect(report.agents[0]).toMatchObject({ class: "flow-worker", eligible: true, protectedReasons: [] });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a squash-merged GitHub PR becomes durable evidence before checkout deletion", async () => {
  const now = Date.parse("2026-07-12T12:00:00.000Z");
  const flow = {
    ...headlessFlow(now),
    id: "flow-squash",
    rounds: [{ ...headlessFlow(now).rounds[0]!, reviewHeadSha: "b".repeat(40) }],
    mergeEvidence: {
      repository: "Latand/live-log-viewer-next",
      headRef: "feature/squashed",
      headSha: "b".repeat(40),
      prNumber: null,
      mergedAt: null,
      checkedAt: null,
      source: null,
    },
  } satisfies Flow;
  let probes = 0;
  let saves = 0;
  const mergedAt = new Date(now - 60_000).toISOString();

  expect(await refreshMergedFlowIds([flow], {
    now: () => now,
    resolveMergeIdentity: () => null,
    probePullRequest: () => { probes += 1; return { number: 321, mergedAt, headRefOid: "b".repeat(40) }; },
    localBranchMerged: () => false,
    saveFlows: () => { saves += 1; },
  })).toEqual(new Set([flow.id]));
  expect(flow.mergeEvidence).toMatchObject({ prNumber: 321, mergedAt, source: "github-pr" });
  expect(probes).toBe(1);
  expect(saves).toBe(1);

  flow.cwd = "/deleted/worktree";
  expect(await refreshMergedFlowIds([flow], {
    now: () => now + 60 * 60_000,
    resolveMergeIdentity: () => null,
    probePullRequest: () => { throw new Error("durable evidence should avoid a refresh"); },
    localBranchMerged: () => false,
    saveFlows: () => { saves += 1; },
  })).toEqual(new Set([flow.id]));
  expect(saves).toBe(1);
});

test("a changed checkout SHA clears prior positive merge evidence", async () => {
  const now = Date.parse("2026-07-12T12:00:00.000Z");
  const oldSha = "a".repeat(40);
  const newSha = "b".repeat(40);
  const flow = {
    ...headlessFlow(now),
    id: "flow-new-head",
    rounds: [{ ...headlessFlow(now).rounds[0]!, reviewHeadSha: oldSha }],
    mergeEvidence: {
      repository: "Latand/live-log-viewer-next",
      headRef: "feature/reused",
      headSha: oldSha,
      prNumber: 100,
      mergedAt: new Date(now - 60_000).toISOString(),
      checkedAt: new Date(now - 60_000).toISOString(),
      source: "github-pr",
    },
  } satisfies Flow;

  expect(await refreshMergedFlowIds([flow], {
    now: () => now,
    resolveMergeIdentity: () => ({ repository: "Latand/live-log-viewer-next", headRef: "feature/reused", headSha: newSha }),
    probePullRequest: () => null,
    localBranchMerged: () => false,
    saveFlows: () => {},
  })).toEqual(new Set());
  expect(flow.mergeEvidence).toMatchObject({
    headSha: oldSha,
    mergedAt: null,
    source: null,
  });
});

test("a numbered PR merge with a different head SHA cannot authorize cleanup", async () => {
  const now = Date.parse("2026-07-12T12:00:00.000Z");
  const flow = {
    ...headlessFlow(now),
    id: "flow-pr-head-mismatch",
    rounds: [{ ...headlessFlow(now).rounds[0]!, reviewHeadSha: "c".repeat(40) }],
    mergeEvidence: {
      repository: "Latand/live-log-viewer-next",
      headRef: "feature/mismatch",
      headSha: "c".repeat(40),
      prNumber: 400,
      mergedAt: null,
      checkedAt: null,
      source: null,
    },
  } satisfies Flow;

  expect(await refreshMergedFlowIds([flow], {
    now: () => now,
    resolveMergeIdentity: () => null,
    probePullRequest: () => ({ number: 400, mergedAt: new Date(now - 60_000).toISOString(), headRefOid: "d".repeat(40) }),
    localBranchMerged: () => false,
    saveFlows: () => {},
  })).toEqual(new Set());
  expect(flow.mergeEvidence?.mergedAt).toBeNull();
});

test("approved uncommitted work cannot inherit merge status from its base HEAD", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-reaper-dirty-flow-"));
  const now = Date.parse("2026-07-12T12:00:00.000Z");
  try {
    expect(spawnSync("git", ["init", "-b", "main"], { cwd: directory }).status).toBe(0);
    expect(spawnSync("git", ["config", "user.email", "reaper@example.test"], { cwd: directory }).status).toBe(0);
    expect(spawnSync("git", ["config", "user.name", "Reaper Test"], { cwd: directory }).status).toBe(0);
    fs.writeFileSync(path.join(directory, "tracked.txt"), "base\n");
    expect(spawnSync("git", ["add", "tracked.txt"], { cwd: directory }).status).toBe(0);
    expect(spawnSync("git", ["commit", "-m", "base"], { cwd: directory }).status).toBe(0);
    const headSha = spawnSync("git", ["rev-parse", "HEAD"], { cwd: directory, encoding: "utf8" }).stdout.trim();
    fs.writeFileSync(path.join(directory, "tracked.txt"), "approved but uncommitted\n");
    const flow = {
      ...headlessFlow(now),
      id: "flow-dirty-approved",
      cwd: directory,
      baseRef: headSha,
      state: "approved",
      rounds: [{ ...headlessFlow(now).rounds[0]!, verdict: "APPROVE", reviewHeadSha: null }],
      mergeEvidence: {
        repository: null,
        headRef: "main",
        headSha,
        prNumber: null,
        mergedAt: null,
        checkedAt: null,
        source: null,
      },
    } satisfies Flow;

    expect(await refreshMergedFlowIds([flow], {
      now: () => now,
      resolveMergeIdentity: () => null,
      probePullRequest: async () => null,
      saveFlows: () => {},
    })).toEqual(new Set());
    expect(flow.mergeEvidence?.mergedAt).toBeNull();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a clean detached checkout cannot retain stale merge authorization", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-reaper-detached-head-"));
  const now = Date.parse("2026-07-12T12:00:00.000Z");
  try {
    expect(spawnSync("git", ["init", "-b", "main"], { cwd: directory }).status).toBe(0);
    expect(spawnSync("git", ["config", "user.email", "reaper@example.test"], { cwd: directory }).status).toBe(0);
    expect(spawnSync("git", ["config", "user.name", "Reaper Test"], { cwd: directory }).status).toBe(0);
    fs.writeFileSync(path.join(directory, "tracked.txt"), "reviewed\n");
    expect(spawnSync("git", ["add", "tracked.txt"], { cwd: directory }).status).toBe(0);
    expect(spawnSync("git", ["commit", "-m", "reviewed"], { cwd: directory }).status).toBe(0);
    const reviewedSha = spawnSync("git", ["rev-parse", "HEAD"], { cwd: directory, encoding: "utf8" }).stdout.trim();
    fs.writeFileSync(path.join(directory, "tracked.txt"), "replacement\n");
    expect(spawnSync("git", ["commit", "-am", "replacement"], { cwd: directory }).status).toBe(0);
    expect(spawnSync("git", ["checkout", "--detach", "HEAD"], { cwd: directory }).status).toBe(0);
    const flow = {
      ...headlessFlow(now),
      id: "flow-detached-head",
      cwd: directory,
      rounds: [{ ...headlessFlow(now).rounds[0]!, reviewHeadSha: reviewedSha }],
      mergeEvidence: {
        repository: "Latand/live-log-viewer-next",
        headRef: "feature/reviewed",
        headSha: reviewedSha,
        prNumber: 605,
        mergedAt: new Date(now - 60_000).toISOString(),
        checkedAt: new Date(now - 60_000).toISOString(),
        source: "github-pr",
      },
    } satisfies Flow;

    expect(await refreshMergedFlowIds([flow], {
      now: () => now,
      saveFlows: () => {},
    })).toEqual(new Set());
    expect(flow.mergeEvidence?.mergedAt).toBeNull();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("merge probes are concurrent and a stalled probe times out fail closed", async () => {
  const now = Date.parse("2026-07-12T12:00:00.000Z");
  const stalled = {
    ...headlessFlow(now),
    id: "flow-stalled-probe",
    rounds: [{ ...headlessFlow(now).rounds[0]!, reviewHeadSha: "e".repeat(40) }],
    mergeEvidence: {
      repository: "Latand/live-log-viewer-next",
      headRef: "feature/stalled",
      headSha: "e".repeat(40),
      prNumber: null,
      mergedAt: null,
      checkedAt: null,
      source: null,
    },
  } satisfies Flow;
  const responsive = {
    ...headlessFlow(now),
    id: "flow-responsive-probe",
    rounds: [{ ...headlessFlow(now).rounds[0]!, reviewHeadSha: "f".repeat(40) }],
    mergeEvidence: {
      repository: "Latand/live-log-viewer-next",
      headRef: "feature/responsive",
      headSha: "f".repeat(40),
      prNumber: null,
      mergedAt: null,
      checkedAt: null,
      source: null,
    },
  } satisfies Flow;
  let active = 0;
  let peak = 0;
  const startedAt = performance.now();

  const merged = await refreshMergedFlowIds([stalled, responsive], {
    now: () => now,
    resolveMergeIdentity: () => null,
    probePullRequest: async (evidence) => {
      active += 1;
      peak = Math.max(peak, active);
      if (evidence.headRef === "feature/stalled") return new Promise(() => {});
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return { number: 501, mergedAt: new Date(now - 60_000).toISOString(), headRefOid: evidence.headSha };
    },
    localBranchMerged: () => false,
    mergeProbeTimeoutMs: 25,
    mergeProbeConcurrency: 2,
    saveFlows: () => {},
  });

  expect(merged).toEqual(new Set([responsive.id]));
  expect(peak).toBe(2);
  expect(performance.now() - startedAt).toBeLessThan(200);
  expect(stalled.mergeEvidence?.mergedAt).toBeNull();
});

test("merge evidence persistence cannot roll back a concurrent flow transition", async () => {
  const now = Date.parse("2026-07-12T12:00:00.000Z");
  const reviewedSha = "1".repeat(40);
  const stale = {
    ...headlessFlow(now),
    id: "flow-store-race",
    rounds: [{ ...headlessFlow(now).rounds[0]!, reviewHeadSha: reviewedSha }],
    mergeEvidence: {
      repository: "Latand/live-log-viewer-next",
      headRef: "feature/store-race",
      headSha: reviewedSha,
      prNumber: null,
      mergedAt: null,
      checkedAt: null,
      source: null,
    },
  } satisfies Flow;
  let stored: Flow[] = structuredClone([stale]);

  await refreshMergedFlowIds([structuredClone(stale)], {
    now: () => now,
    resolveMergeIdentity: () => null,
    probePullRequest: async () => {
      stored[0]!.state = "fixing";
      stored[0]!.closedAt = null;
      return { number: 601, mergedAt: new Date(now - 60_000).toISOString(), headRefOid: reviewedSha };
    },
    localBranchMerged: () => false,
    loadFlows: () => structuredClone(stored),
    saveFlows: (flows) => { stored = structuredClone(flows); },
  });

  expect(stored[0]).toMatchObject({ state: "fixing", closedAt: null });
  expect(stored[0]?.mergeEvidence?.mergedAt).toBeNull();
});

test("an existing checkout with unverified cleanliness loses merge authorization", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-reaper-unverified-checkout-"));
  const now = Date.parse("2026-07-12T12:00:00.000Z");
  const reviewedSha = "2".repeat(40);
  const flow = {
    ...headlessFlow(now),
    id: "flow-unverified-checkout",
    cwd: directory,
    rounds: [{ ...headlessFlow(now).rounds[0]!, reviewHeadSha: reviewedSha }],
    mergeEvidence: {
      repository: "Latand/live-log-viewer-next",
      headRef: "feature/unverified",
      headSha: reviewedSha,
      prNumber: 602,
      mergedAt: new Date(now - 60_000).toISOString(),
      checkedAt: new Date(now - 60_000).toISOString(),
      source: "github-pr",
    },
  } satisfies Flow;
  try {
    expect(await refreshMergedFlowIds([flow], {
      now: () => now,
      checkoutClean: () => null,
      resolveMergeIdentity: () => ({ repository: "Latand/live-log-viewer-next", headRef: "feature/unverified", headSha: reviewedSha }),
      saveFlows: () => {},
    })).toEqual(new Set());
    expect(flow.mergeEvidence?.mergedAt).toBeNull();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("local merge evidence persists the reviewed SHA without GitHub identity", async () => {
  const now = Date.parse("2026-07-12T12:00:00.000Z");
  const reviewedSha = "3".repeat(40);
  const flow = {
    ...headlessFlow(now),
    id: "flow-local-merge",
    rounds: [{ ...headlessFlow(now).rounds[0]!, reviewHeadSha: reviewedSha }],
    mergeEvidence: null,
  } satisfies Flow;

  expect(await refreshMergedFlowIds([flow], {
    now: () => now,
    resolveMergeIdentity: () => null,
    localBranchMerged: () => true,
    saveFlows: () => {},
  })).toEqual(new Set([flow.id]));
  expect(flow.mergeEvidence).toMatchObject({ headSha: reviewedSha, source: "git-ancestor" });
});

test("Viewer flow deliveries are discounted from transcript authorship", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-reaper-flow-authorship-"));
  const sessionId = "019f4906-3f67-7b72-9fbc-9ec3b5ad1350";
  const pathname = path.join(directory, `rollout-${sessionId}.jsonl`);
  const now = Date.parse("2026-07-12T12:00:00.000Z");
  const messages = ["launch prompt", "flow kickoff", "review findings"].map((message) => JSON.stringify({
    type: "event_msg",
    timestamp: new Date(now - 2 * 60 * 60_000).toISOString(),
    payload: { type: "user_message", message },
  })).join("\n") + "\n";
  fs.writeFileSync(pathname, messages);
  process.env.LLV_STATE_DIR = directory;
  delete process.env.LLV_REAPER_ENABLED;
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
  const profile = emptyLaunchProfile({ cwd: "/repo", role: "worker" });
  const receipt = registry.beginSpawn("codex", "/repo", profile);
  registry.completeSpawn(receipt.launchId, {
    key: { engine: "codex", sessionId },
    artifactPath: pathname,
    cwd: "/repo",
    accountId: "default",
    launchProfile: profile,
    status: "idle",
    host: null,
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: null,
  });
  registry.reconcileConversations([{
    engine: "codex",
    path: pathname,
    accountId: "default",
    launchProfile: profile,
    turn: { state: "idle", source: "assistant", terminalAt: new Date(now - 2 * 60 * 60_000).toISOString() },
    observedAt: new Date(now - 2 * 60 * 60_000).toISOString(),
  }]);
  const reviewedSha = "4".repeat(40);
  const flow = {
    ...headlessFlow(now),
    id: "flow-viewer-authorship",
    cwd: "/deleted/flow-worktree",
    implementerPath: pathname,
    closedAt: new Date(now - 31 * 60_000).toISOString(),
    kickoffDelivery: { path: pathname, deliveredAt: new Date(now - 3 * 60 * 60_000).toISOString() },
    rounds: [{
      ...headlessFlow(now).rounds[0]!,
      reviewHeadSha: reviewedSha,
      relayDelivery: { path: pathname, deliveredAt: new Date(now - 31 * 60_000).toISOString() },
    }],
    mergeEvidence: {
      repository: "Latand/live-log-viewer-next",
      headRef: "feature/authorship",
      headSha: reviewedSha,
      prNumber: 603,
      mergedAt: new Date(now - 32 * 60_000).toISOString(),
      checkedAt: new Date(now - 32 * 60_000).toISOString(),
      source: "github-pr",
    },
  } satisfies Flow;
  try {
    const report = await runReaperCycle({
      registry,
      hosts: [runtimeHost(pathname)],
      files: [runtimeFile(pathname, now / 1000 - 2 * 60 * 60)],
      now,
      actuation: { loadFlows: () => [flow], now: () => now },
    });

    expect(report.agents[0]).toMatchObject({ class: "flow-worker", eligible: true, protectedReasons: [] });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("actuation rejects a replacement host that reused the candidate pane", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-reaper-reused-pane-"));
  const sessionId = "019f4906-3f67-7b72-9fbc-9ec3b5ad1351";
  const pathname = path.join(directory, `rollout-${sessionId}.jsonl`);
  const now = Date.parse("2026-07-12T12:00:00.000Z");
  fs.writeFileSync(pathname, JSON.stringify({
    type: "event_msg",
    timestamp: new Date(now - 2 * 60 * 60_000).toISOString(),
    payload: { type: "user_message", message: "launch prompt" },
  }) + "\n");
  process.env.LLV_STATE_DIR = directory;
  process.env.LLV_REAPER_ENABLED = "1";
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
  const profile = emptyLaunchProfile({ cwd: "/repo", role: "worker", title: "probe" });
  const receipt = registry.beginSpawn("codex", "/repo", profile);
  registry.completeSpawn(receipt.launchId, {
    key: { engine: "codex", sessionId },
    artifactPath: pathname,
    cwd: "/repo",
    accountId: "default",
    launchProfile: profile,
    status: "idle",
    host: null,
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: null,
  });
  registry.reconcileConversations([{
    engine: "codex",
    path: pathname,
    accountId: "default",
    launchProfile: profile,
    turn: { state: "idle", source: "assistant", terminalAt: new Date(now - 2 * 60 * 60_000).toISOString() },
    observedAt: new Date(now - 2 * 60 * 60_000).toISOString(),
  }]);
  const original = runtimeHost(pathname);
  const replacement = { ...original, windowName: "replacement-window", agentArgv: ["codex", "exec", "replacement"] };
  const replacementSnapshot: TranscriptHostSnapshot = {
    hosts: [replacement],
    observation: "available",
    canonicalFor: (candidate) => candidate === pathname ? replacement : null,
  };
  let observations = 0;
  let kills = 0;
  try {
    const report = await runReaperCycle({
      registry,
      hosts: [original],
      files: [runtimeFile(pathname, now / 1000 - 2 * 60 * 60)],
      now,
      actuation: {
        readHosts: async () => { observations += 1; return replacementSnapshot; },
        processIdentity: (pid) => pid === 900 ? "900:original" : pid === 1041 ? "1041:original" : null,
        kill: async () => { kills += 1; return true; },
        now: () => now,
      },
    });

    expect(report.agents[0]).toMatchObject({ eligible: true, action: "kill-failed" });
    expect(observations).toBe(1);
    expect(kills).toBe(0);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("post-kill cleanup preserves a same-pane replacement registry host", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-reaper-registry-replacement-"));
  const sessionId = "019f4906-3f67-7b72-9fbc-9ec3b5ad1352";
  const pathname = path.join(directory, `rollout-${sessionId}.jsonl`);
  const now = Date.parse("2026-07-12T12:00:00.000Z");
  fs.writeFileSync(pathname, JSON.stringify({
    type: "event_msg",
    timestamp: new Date(now - 2 * 60 * 60_000).toISOString(),
    payload: { type: "user_message", message: "launch prompt" },
  }) + "\n");
  process.env.LLV_STATE_DIR = directory;
  process.env.LLV_REAPER_ENABLED = "1";
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
  const profile = emptyLaunchProfile({ cwd: "/repo", role: "worker", title: "probe" });
  const host = runtimeHost(pathname);
  const originalEvidence = runtimeEvidence(host);
  const replacementEvidence = {
    ...originalEvidence,
    server: { ...originalEvidence.server, startIdentity: "900:replacement" },
    panePid: { ...originalEvidence.panePid, startIdentity: "1041:replacement" },
    windowName: "replacement-window",
    argv: ["codex", "exec", "replacement"],
  } satisfies TmuxHostEvidence;
  const key = { engine: "codex" as const, sessionId };
  const receipt = registry.beginSpawn("codex", "/repo", profile);
  registry.completeSpawn(receipt.launchId, {
    key,
    artifactPath: pathname,
    cwd: "/repo",
    accountId: "default",
    launchProfile: profile,
    status: "idle",
    host: originalEvidence,
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: null,
  });
  registry.reconcileConversations([{
    engine: "codex",
    path: pathname,
    accountId: "default",
    launchProfile: profile,
    turn: { state: "idle", source: "assistant", terminalAt: new Date(now - 2 * 60 * 60_000).toISOString() },
    observedAt: new Date(now - 2 * 60 * 60_000).toISOString(),
  }]);
  const snapshot: TranscriptHostSnapshot = {
    hosts: [host],
    observation: "available",
    canonicalFor: (candidate) => candidate === pathname ? host : null,
  };
  try {
    const report = await runReaperCycle({
      registry,
      hosts: [host],
      files: [runtimeFile(pathname, now / 1000 - 2 * 60 * 60)],
      now,
      actuation: {
        readHosts: async () => snapshot,
        refreshLifecycle: async () => [runtimeFile(pathname, now / 1000 - 2 * 60 * 60)],
        processIdentity: (pid) => pid === 900 ? "900:original" : pid === 1041 ? "1041:original" : null,
        kill: async () => {
          const entry = registry.snapshot().entries[`codex:${sessionId}`]!;
          registry.upsert({ ...entry, host: replacementEvidence, status: "live" });
          return true;
        },
        now: () => now,
      },
    });

    expect(report.agents[0]).toMatchObject({ eligible: true, action: "reaped" });
    expect(registry.snapshot().entries[`codex:${sessionId}`]?.host).toEqual(replacementEvidence);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("an idle candidate that becomes busy inside the operation lock is retained", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-reaper-idle-busy-"));
  const sessionId = "019f4906-3f67-7b72-9fbc-9ec3b5ad1354";
  const pathname = path.join(directory, `rollout-${sessionId}.jsonl`);
  const now = Date.parse("2026-07-12T12:00:00.000Z");
  fs.writeFileSync(pathname, JSON.stringify({
    type: "event_msg", timestamp: new Date(now - 2 * 60 * 60_000).toISOString(),
    payload: { type: "user_message", message: "launch prompt" },
  }) + "\n");
  process.env.LLV_STATE_DIR = directory;
  process.env.LLV_REAPER_ENABLED = "1";
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
  const profile = emptyLaunchProfile({ cwd: "/repo", role: "worker", title: "probe" });
  const receipt = registry.beginSpawn("codex", "/repo", profile);
  registry.completeSpawn(receipt.launchId, {
    key: { engine: "codex", sessionId }, artifactPath: pathname, cwd: "/repo", accountId: "default",
    launchProfile: profile, status: "idle", host: null, claimEpoch: 0, claimOwner: null, pendingAction: null,
  });
  registry.reconcileConversations([{
    engine: "codex", path: pathname, accountId: "default", launchProfile: profile,
    turn: { state: "idle", source: "empty", terminalAt: null }, observedAt: new Date(now - 2 * 60 * 60_000).toISOString(),
  }]);
  const host = runtimeHost(pathname);
  const snapshot: TranscriptHostSnapshot = {
    hosts: [host], observation: "available", canonicalFor: (candidate) => candidate === pathname ? host : null,
  };
  let lifecycleRefreshes = 0;
  let kills = 0;
  try {
    const report = await runReaperCycle({
      registry,
      hosts: [host],
      files: [runtimeFile(pathname, now / 1000 - 2 * 60 * 60)],
      now,
      actuation: {
        readHosts: async () => snapshot,
        refreshLifecycle: async () => {
          lifecycleRefreshes += 1;
          registry.reconcileConversations([{
            engine: "codex", path: pathname, accountId: "default", launchProfile: profile,
            turn: { state: "busy", source: "tool", terminalAt: null }, observedAt: new Date(now).toISOString(),
          }]);
          return [{ ...runtimeFile(pathname, now / 1000), activity: "live", activityReason: "jsonl_turn_open" }];
        },
        processIdentity: (pid) => pid === 900 ? "900:original" : pid === 1041 ? "1041:original" : null,
        kill: async () => { kills += 1; return true; },
        now: () => now,
      },
    });

    expect(report.agents[0]).toMatchObject({ eligible: true, action: "kill-failed" });
    expect(lifecycleRefreshes).toBe(1);
    expect(kills).toBe(0);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a delivery created during merge revalidation fences the final reap decision", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-reaper-delivery-fence-"));
  const pathname = path.join(directory, "missing-019f4906-3f67-7b72-9fbc-9ec3b5ad1342.jsonl");
  const now = Date.now();
  process.env.LLV_STATE_DIR = directory;
  process.env.LLV_REAPER_ENABLED = "1";
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
  const profile = emptyLaunchProfile({ cwd: "/repo", role: "worker", title: "probe" });
  fs.writeFileSync(pathname, "");
  const receipt = registry.beginSpawn("codex", "/repo", profile);
  const key = { engine: "codex" as const, sessionId: "019f4906-3f67-7b72-9fbc-9ec3b5ad1342" };
  registry.completeSpawn(receipt.launchId, {
    key,
    artifactPath: pathname,
    cwd: "/repo",
    accountId: "default",
    launchProfile: profile,
    status: "idle",
    host: null,
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: null,
  });
  registry.reconcileConversations([{
    engine: "codex",
    path: pathname,
    accountId: "default",
    launchProfile: profile,
    turn: { state: "idle", source: "assistant", terminalAt: new Date(now - 2 * 60 * 60_000).toISOString() },
    observedAt: new Date(now - 2 * 60 * 60_000).toISOString(),
  }]);
  const conversation = registry.conversationForPath(pathname)!;
  const host = runtimeHost(pathname);
  fs.writeFileSync(path.join(directory, "reaper-state.json"), JSON.stringify({
    version: 1,
    firstObservedAt: { "%41:2041:2041:one": new Date(now - 2 * 60 * 60_000).toISOString() },
  }));
  const reviewedSha = "5".repeat(40);
  const flow = {
    ...headlessFlow(now),
    id: "flow-delivery-race",
    cwd: "/deleted/delivery-race-worktree",
    implementerPath: pathname,
    reviewerMode: "pane",
    closedAt: new Date(now - 31 * 60_000).toISOString(),
    rounds: [{ ...headlessFlow(now).rounds[0]!, reviewHeadSha: reviewedSha }],
    mergeEvidence: {
      repository: "Latand/live-log-viewer-next",
      headRef: "feature/delivery-race",
      headSha: reviewedSha,
      prNumber: null,
      mergedAt: null,
      checkedAt: null,
      source: null,
    },
  } satisfies Flow;
  let probes = 0;
  let observations = 0;
  let kills = 0;
  const snapshot: TranscriptHostSnapshot = {
    hosts: [host],
    observation: "available",
    canonicalFor: (candidate) => candidate === pathname ? host : null,
  };

  try {
    const report = await runReaperCycle({
      registry,
      hosts: [host],
      files: [runtimeFile(pathname, now / 1000 - 2 * 60 * 60)],
      now,
      actuation: {
        readHosts: async () => {
          observations += 1;
          return snapshot;
        },
        loadFlows: () => [structuredClone(flow)],
        resolveMergeIdentity: () => null,
        probePullRequest: async () => {
          probes += 1;
          if (probes === 2) {
            const held = registry.holdDelivery(conversation.id, "new user turn");
            const started = registry.beginDeliveryAttempt(held.id, held.generationId!)!;
            registry.recordDeliveryOutcome(started.id, "delivered");
          }
          return { number: 604, mergedAt: new Date(now - 60_000).toISOString(), headRefOid: reviewedSha };
        },
        localBranchMerged: () => false,
        saveFlows: () => {},
        refreshLifecycle: async () => [runtimeFile(pathname, now / 1000 - 2 * 60 * 60)],
        processIdentity: (pid) => pid === 900 ? "900:original" : pid === 1041 ? "1041:original" : null,
        kill: async () => { kills += 1; return true; },
        now: () => now,
      },
    });

    expect(report.agents[0]).toMatchObject({ class: "flow-worker", eligible: true, action: "kill-failed" });
    expect(probes).toBe(2);
    expect(observations).toBe(2);
    expect(kills).toBe(0);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
