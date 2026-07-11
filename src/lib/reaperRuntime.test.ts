import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { AgentRegistry } from "@/lib/agent/registry";
import type { TranscriptHost, TranscriptHostSnapshot } from "@/lib/agent/transcriptHost";
import type { FileEntry } from "@/lib/types";

import { readReaperReport, runReaperCycle } from "./reaperRuntime";

const originalStateDir = process.env.LLV_STATE_DIR;
const originalEnabled = process.env.LLV_REAPER_ENABLED;

afterEach(() => {
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

    expect(report.agents[0]).toMatchObject({
      class: "probe",
      eligible: false,
      protectedReasons: ["user-authored-message"],
    });
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

test("a delivery completed before reaper actuation fences the stale idle turn", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-reaper-delivery-fence-"));
  const pathname = path.join(directory, "missing-019f4906-3f67-7b72-9fbc-9ec3b5ad1342.jsonl");
  const now = Date.now();
  process.env.LLV_STATE_DIR = directory;
  process.env.LLV_REAPER_ENABLED = "1";
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
  const profile = emptyLaunchProfile({ cwd: "/repo", role: "worker" });
  registry.reconcileConversations([{
    engine: "codex",
    path: pathname,
    accountId: "default",
    launchProfile: profile,
    turn: { state: "idle", source: "assistant", terminalAt: new Date(now - 2 * 60 * 60_000).toISOString() },
    observedAt: new Date(now - 2 * 60 * 60_000).toISOString(),
  }]);
  const conversation = registry.conversationForPath(pathname)!;
  const key = { engine: "codex" as const, sessionId: "019f4906-3f67-7b72-9fbc-9ec3b5ad1342" };
  registry.upsert({
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
  const host = runtimeHost(pathname);
  fs.writeFileSync(path.join(directory, "reaper-state.json"), JSON.stringify({
    version: 1,
    firstObservedAt: { "%41:2041:2041:one": new Date(now - 2 * 60 * 60_000).toISOString() },
  }));
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
      files: [],
      now,
      actuation: {
        readHosts: async () => {
          observations += 1;
          if (observations === 1) {
            const held = registry.holdDelivery(conversation.id, "new user turn");
            const started = registry.beginDeliveryAttempt(held.id, held.generationId!)!;
            registry.recordDeliveryOutcome(started.id, "delivered");
          }
          return snapshot;
        },
        kill: async () => { kills += 1; return true; },
        now: () => now,
      },
    });

    expect(report.agents[0]).toMatchObject({ class: "dead-transcript", eligible: true, action: "kill-failed" });
    expect(observations).toBe(2);
    expect(kills).toBe(0);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
