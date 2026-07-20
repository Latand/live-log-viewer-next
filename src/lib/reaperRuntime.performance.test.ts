import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { AgentRegistry } from "@/lib/agent/registry";
import type { TranscriptHost } from "@/lib/agent/transcriptHost";
import type { FileEntry } from "@/lib/types";

import { runReaperCycle } from "./reaperRuntime";

const originalStateDir = process.env.LLV_STATE_DIR;
const originalEnabled = process.env.LLV_REAPER_ENABLED;

afterEach(() => {
  if (originalStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = originalStateDir;
  if (originalEnabled === undefined) delete process.env.LLV_REAPER_ENABLED;
  else process.env.LLV_REAPER_ENABLED = originalEnabled;
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

test("a sticky owner-authored verdict prevents later full transcript rescans (issue #493)", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-reaper-sticky-authorship-"));
  const pathname = path.join(directory, "rollout-019f4906-3f67-0b72-0fbc-9ec3b5ad13ac.jsonl");
  const now = Date.parse("2026-07-20T18:00:00.000Z");
  process.env.LLV_STATE_DIR = directory;
  delete process.env.LLV_REAPER_ENABLED;
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
  const profile = emptyLaunchProfile({ cwd: "/repo", role: "worker", title: "sticky authorship" });
  registry.reconcileConversations([{
    engine: "codex",
    path: pathname,
    accountId: "default",
    launchProfile: profile,
    turn: { state: "idle", source: "assistant", terminalAt: new Date(now - 60_000).toISOString() },
    observedAt: new Date(now - 60_000).toISOString(),
  }]);

  try {
    fs.writeFileSync(pathname, JSON.stringify({
      type: "event_msg",
      timestamp: new Date(now - 60_000).toISOString(),
      payload: { type: "user_message", message: "keep this conversation visible" },
    }) + "\n");
    await runReaperCycle({
      registry,
      hosts: [runtimeHost(pathname)],
      files: [runtimeFile(pathname, fs.statSync(pathname).mtimeMs / 1000)],
      now,
    });

    fs.writeFileSync(pathname, JSON.stringify({
      type: "event_msg",
      timestamp: new Date(now).toISOString(),
      payload: { type: "agent_message", message: "x".repeat(128 * 1024) },
    }) + "\n");
    await runReaperCycle({
      registry,
      hosts: [runtimeHost(pathname)],
      files: [runtimeFile(pathname, fs.statSync(pathname).mtimeMs / 1000)],
      now: now + 1_000,
    });

    const state = JSON.parse(fs.readFileSync(path.join(directory, "reaper-state.json"), "utf8")) as {
      scannedAt?: Record<string, number>;
      userAuthoredPaths?: Record<string, true>;
    };
    expect(state.userAuthoredPaths?.[pathname]).toBe(true);
    expect(state.scannedAt?.[pathname]).toBeUndefined();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
