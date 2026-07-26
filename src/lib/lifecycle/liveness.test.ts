import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AgentRegistryEntry, RegistryFile } from "@/lib/agent/registry";
import type { StageTurnEvidence } from "@/lib/pipelines/durableEvidence";
import type { Pipeline, PipelineStageAttempt } from "@/lib/pipelines/types";
import type { FileEntry } from "@/lib/types";

import { agentLivenessSnapshot, evaluateLiveness, type AgentLivenessSources } from "./liveness";

const sandboxes: string[] = [];

afterEach(() => {
  for (const sandbox of sandboxes.splice(0)) fs.rmSync(sandbox, { recursive: true, force: true });
});

function sandbox(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-liveness-"));
  sandboxes.push(dir);
  return dir;
}

const NOW = Date.parse("2026-07-26T08:40:00.000Z");
/** The frozen transcript tail from the incident: mid-turn, six hours stale. */
const FROZEN_AT = Date.parse("2026-07-26T02:27:33.000Z");

function fileEntry(overrides: Partial<FileEntry> & { path: string }): FileEntry {
  return {
    root: "claude" as FileEntry["root"],
    name: path.basename(overrides.path),
    project: "viewer",
    title: "stage agent",
    engine: "codex",
    kind: "session",
    fmt: "jsonl" as FileEntry["fmt"],
    parent: null,
    mtime: Math.floor(FROZEN_AT / 1000),
    size: 4096,
    activity: "stalled",
    activityReason: "jsonl_turn_stalled",
    proc: null,
    pid: null,
    conversationId: "conversation_zombie",
    ...overrides,
  } as FileEntry;
}

function structuredEntry(artifactPath: string, pid: number): AgentRegistryEntry {
  return {
    key: { engine: "codex", accountId: null, sessionId: "session-zombie" } as AgentRegistryEntry["key"],
    artifactPath,
    cwd: "/repo",
    accountId: null,
    /* The registry still calls it live — nothing terminalized it. */
    status: "live",
    host: null,
    structuredHost: {
      kind: "codex-app-server",
      endpoint: "unix:/tmp/host.sock",
      process: { pid, startIdentity: "start-token-of-a-dead-host" },
      eventCursor: 0,
      protocolVersion: null,
      writerClaimEpoch: 1,
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 1,
    claimOwner: null,
    pendingAction: null,
    updatedAt: new Date(FROZEN_AT).toISOString(),
  };
}

function zombiePipeline(conversationId: string, agentPath: string): Pipeline {
  const attempt = {
    n: 1,
    /* The pipeline record from the incident: still `running`, six hours on. */
    state: "running",
    effectiveRole: { engine: "codex", model: null, effort: null, roleId: "builder", access: "read-write", promptScaffold: null },
    launchId: "launch_zombie",
    conversationId,
    sessionId: "session-zombie",
    agentPath,
    /* Pane-less: a structured attempt, the shape the reconciler waits on forever. */
    paneId: null,
    flowId: null,
    startedAt: "2026-07-26T02:10:00.000Z",
    completedAt: null,
    input: null,
    activatedBy: null,
    output: null,
    verdict: null,
    error: null,
  } as unknown as PipelineStageAttempt;
  return {
    id: "pipeline_ae6c1f87",
    task: "implement the thing",
    taskIds: [],
    project: "viewer",
    repoDir: "/repo",
    worktreeDir: "/repo/worktree",
    branch: "pipeline/zombie",
    baseBranch: "main",
    baseRef: "main",
    lastPassedCommit: "",
    stages: [{ id: "build", kind: "run", prompt: "build", next: null } as unknown as Pipeline["stages"][number]],
    runs: [{ stageId: "build", attempts: [attempt] }],
    cursor: { stageId: "build", state: "running", input: null, activatedBy: null },
    state: "running",
    pausedState: null,
    stateDetail: null,
    srcPath: null,
    srcConversationId: null,
    createdAt: "2026-07-26T02:00:00.000Z",
    closedAt: null,
  } as unknown as Pipeline;
}

function sources(overrides: Partial<AgentLivenessSources> & Pick<AgentLivenessSources, "listFiles" | "registrySnapshot" | "pipelines" | "durableTurnEvidence">): AgentLivenessSources {
  return {
    now: () => NOW,
    probe: {
      now: () => NOW,
      /* Nothing answers: the structured host process is gone. */
      pidAlive: () => false,
      processIdentity: () => null,
    },
    ...overrides,
  };
}

test("a pane-less structured attempt with a dead host and a mid-turn transcript reports as stalled, not the pipeline's running", async () => {
  const dir = sandbox();
  const agentPath = path.join(dir, "session-zombie.jsonl");
  fs.writeFileSync(agentPath, "{}\n", "utf8");
  const entry = fileEntry({ path: agentPath });
  const registry = {
    entries: { "codex:session-zombie": structuredEntry(agentPath, 424242) },
    conversations: {},
  } as unknown as RegistryFile;
  const pipeline = zombiePipeline("conversation_zombie", agentPath);

  const snapshot = await agentLivenessSnapshot({}, sources({
    listFiles: async () => [entry],
    registrySnapshot: () => registry,
    pipelines: () => [pipeline],
    /* Durable transcript evidence: the turn never closed. */
    durableTurnEvidence: async (): Promise<StageTurnEvidence> => ({
      turn: "busy",
      message: { text: "working on it", ts: FROZEN_AT },
    }),
  }));

  expect(snapshot.stalledCount).toBe(1);
  const record = snapshot.conversations[0]!;
  expect(record.lifecycle).toBe("stalled");
  expect(record.reason).toBe("host_gone_turn_open");
  expect(record.host).toEqual({ state: "gone", kind: "structured", pid: 424242 });
  expect(record.turnState).toBe("busy");
  expect(record.lastRecordAt).toBe("2026-07-26T02:27:33.000Z");
  /* Six hours and change of silence, reported as such. */
  expect(record.stalledForMs).toBe(NOW - FROZEN_AT);
  expect(record.stalledForMs! / 3_600_000).toBeGreaterThan(6);
  /* The pipeline's own claim is carried for contrast and never used as the answer. */
  expect(record.pipeline).toMatchObject({
    pipelineId: "pipeline_ae6c1f87",
    stageId: "build",
    attempt: 1,
    reportedState: "running",
    reportedPipelineState: "running",
    paneId: null,
  });
});

test("a live host with a fresh turn is running, and a live host with a settled turn is waiting", async () => {
  const dir = sandbox();
  const agentPath = path.join(dir, "session-live.jsonl");
  fs.writeFileSync(agentPath, "{}\n", "utf8");
  const registry = {
    entries: { "codex:session-live": structuredEntry(agentPath, 4242) },
    conversations: {},
  } as unknown as RegistryFile;
  const aliveProbe = { now: () => NOW, pidAlive: () => true, processIdentity: () => "start-token-of-a-dead-host" };

  const running = await agentLivenessSnapshot({}, sources({
    probe: aliveProbe,
    listFiles: async () => [fileEntry({ path: agentPath, mtime: Math.floor((NOW - 30_000) / 1000), activity: "live" })],
    registrySnapshot: () => registry,
    pipelines: () => [],
    durableTurnEvidence: async () => ({ turn: "busy", message: { text: "still going", ts: NOW - 30_000 } }),
  }));
  expect(running.conversations[0]!.lifecycle).toBe("running");
  expect(running.stalledCount).toBe(0);

  const waiting = await agentLivenessSnapshot({}, sources({
    probe: aliveProbe,
    listFiles: async () => [fileEntry({ path: agentPath, mtime: Math.floor((NOW - 30_000) / 1000), activity: "idle" })],
    registrySnapshot: () => registry,
    pipelines: () => [],
    durableTurnEvidence: async () => ({ turn: "terminal", message: { text: "done", ts: NOW - 30_000 } }),
  }));
  expect(waiting.conversations[0]!.lifecycle).toBe("waiting");
  expect(waiting.conversations[0]!.reason).toBe("host_alive_turn_idle");
  expect(waiting.conversations[0]!.stalledForMs).toBeNull();
});

test("a live host whose transcript goes silent past the threshold is stalled", () => {
  expect(evaluateLiveness({ host: { state: "alive" }, turnState: "busy", silentForMs: 9 * 60_000, stallAfterMs: 10 * 60_000 }))
    .toEqual({ lifecycle: "running", reason: "host_alive_turn_active" });
  expect(evaluateLiveness({ host: { state: "alive" }, turnState: "busy", silentForMs: 11 * 60_000, stallAfterMs: 10 * 60_000 }))
    .toEqual({ lifecycle: "stalled", reason: "host_alive_transcript_silent" });
  /* A host that exited after its turn settled finished; it is gone, not stalled. */
  expect(evaluateLiveness({ host: { state: "gone" }, turnState: "idle", silentForMs: 60_000, stallAfterMs: 10 * 60_000 }))
    .toEqual({ lifecycle: "gone", reason: "host_gone_turn_settled" });
  /* No host evidence yet inside the launch grace is a start, not a stall. */
  expect(evaluateLiveness({ host: { state: "unknown" }, turnState: "unknown", silentForMs: 1_000, stallAfterMs: 10 * 60_000 }))
    .toEqual({ lifecycle: "starting", reason: "launch_unproven" });
});
