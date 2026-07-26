import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AgentRegistryEntry, RegistryFile } from "@/lib/agent/registry";
import type { Pipeline, PipelineStageAttempt } from "@/lib/pipelines/types";
import type { FileEntry } from "@/lib/types";

import { agentLivenessSnapshot, evaluateLiveness, type AgentLivenessSources } from "./liveness";
import { readLivenessTranscriptEvidence, type LivenessTranscript, type LivenessTranscriptEvidence } from "./transcript";

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

function sources(
  overrides: Partial<AgentLivenessSources>
    & Pick<AgentLivenessSources, "listFiles" | "registrySnapshot" | "pipelines" | "transcriptEvidence">,
): AgentLivenessSources {
  return {
    now: () => NOW,
    probe: {
      now: () => NOW,
      /* Nothing answers: the structured host process is gone. */
      pidAlive: () => false,
      processIdentity: () => null,
    },
    describeTranscript: async () => {
      throw new Error("a request with no named conversation must not describe one");
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
    transcriptEvidence: async (): Promise<LivenessTranscriptEvidence> => ({
      turn: "busy",
      lastRecordTs: FROZEN_AT,
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
    transcriptEvidence: async () => ({ turn: "busy" as const, lastRecordTs: NOW - 30_000 }),
  }));
  expect(running.conversations[0]!.lifecycle).toBe("running");
  expect(running.stalledCount).toBe(0);

  const waiting = await agentLivenessSnapshot({}, sources({
    probe: aliveProbe,
    listFiles: async () => [fileEntry({ path: agentPath, mtime: Math.floor((NOW - 30_000) / 1000), activity: "idle" })],
    registrySnapshot: () => registry,
    pipelines: () => [],
    transcriptEvidence: async () => ({ turn: "idle" as const, lastRecordTs: NOW - 30_000 }),
  }));
  expect(waiting.conversations[0]!.lifecycle).toBe("waiting");
  expect(waiting.conversations[0]!.reason).toBe("host_alive_turn_idle");
  expect(waiting.conversations[0]!.stalledForMs).toBeNull();
});

/** A Claude transcript replayed from the shape this got wrong: one prose
    message hours ago, then an unbroken tool stretch that is still going. */
function toolStretchTranscript(target: string): void {
  const rows = [
    {
      type: "assistant",
      timestamp: new Date(FROZEN_AT).toISOString(),
      message: { content: [{ type: "text", text: "starting the migration sweep" }], stop_reason: null },
    },
    {
      type: "assistant",
      timestamp: new Date(NOW - 120_000).toISOString(),
      message: { content: [{ type: "tool_use", id: "tool_a", name: "Bash", input: { command: "bun test" } }], stop_reason: "tool_use" },
    },
    {
      type: "user",
      timestamp: new Date(NOW - 90_000).toISOString(),
      message: { content: [{ type: "tool_result", tool_use_id: "tool_a", content: "ok" }] },
    },
    {
      type: "assistant",
      timestamp: new Date(NOW - 45_000).toISOString(),
      message: { content: [{ type: "tool_use", id: "tool_b", name: "Read", input: { file: "a.ts" } }], stop_reason: "tool_use" },
    },
    {
      type: "user",
      timestamp: new Date(NOW - 20_000).toISOString(),
      message: { content: [{ type: "tool_result", tool_use_id: "tool_b", content: "ok" }] },
    },
  ];
  fs.writeFileSync(target, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
}

test("a live agent deep in a tool stretch is running: freshness is the newest RECORD, not the last prose message", async () => {
  const dir = sandbox();
  const agentPath = path.join(dir, "session-tools.jsonl");
  toolStretchTranscript(agentPath);

  /* Read for real: this is the production evidence path, not a stub. */
  const evidence = await readLivenessTranscriptEvidence("claude", agentPath);
  expect(evidence).not.toBeNull();
  expect(evidence!.turn).toBe("busy");
  /* Twenty seconds old — the last tool result — and NOT the six-hour-old prose. */
  expect(evidence!.lastRecordTs).toBe(NOW - 20_000);
  expect(evidence!.lastRecordTs).not.toBe(FROZEN_AT);

  const registry = {
    entries: { "claude:session-tools": structuredEntry(agentPath, 4242) },
    conversations: {},
  } as unknown as RegistryFile;
  const snapshot = await agentLivenessSnapshot({}, sources({
    probe: { now: () => NOW, pidAlive: () => true, processIdentity: () => "start-token-of-a-dead-host" },
    listFiles: async () => [fileEntry({ path: agentPath, engine: "claude", mtime: (NOW - 20_000) / 1000 })],
    registrySnapshot: () => registry,
    pipelines: () => [],
    transcriptEvidence: readLivenessTranscriptEvidence,
  }));

  const record = snapshot.conversations[0]!;
  expect(record.lastRecordAt).toBe(new Date(NOW - 20_000).toISOString());
  expect(record.silentForMs).toBe(20_000);
  expect(record.lifecycle).toBe("running");
  expect(snapshot.stalledCount).toBe(0);
});

test("a single-conversation query does no inventory sweep and reads the tail once (#645)", async () => {
  const agentPath = "/transcripts/named-session.jsonl";
  const described: string[] = [];
  const tailReads: string[] = [];
  const registry = {
    entries: {},
    conversations: {
      conversation_named: {
        id: "conversation_named",
        generations: [{ path: "/transcripts/old-generation.jsonl" }, { path: agentPath }],
        continuityPaths: [],
      },
    },
  } as unknown as RegistryFile;

  const snapshot = await agentLivenessSnapshot({ conversationId: "conversation_named" }, sources({
    /* Root discovery, the process-table sweep and the tmux pane map all live
       behind this one call. Reaching it at all is the finding. */
    listFiles: async () => {
      throw new Error("a single-conversation query must not run the inventory sweep");
    },
    describeTranscript: async (transcriptPath): Promise<LivenessTranscript> => {
      described.push(transcriptPath);
      return {
        path: transcriptPath,
        project: "viewer",
        title: "named agent",
        engine: "claude",
        mtimeMs: NOW - 60_000,
        conversationId: null,
        activity: null,
        activityReason: null,
      };
    },
    transcriptEvidence: async (_engine, transcriptPath) => {
      tailReads.push(transcriptPath);
      return { turn: "busy" as const, lastRecordTs: NOW - 60_000 };
    },
    registrySnapshot: () => registry,
    pipelines: () => [],
  }));

  /* Only the conversation's CURRENT generation, described once, tail read once. */
  expect(described).toEqual([agentPath]);
  expect(tailReads).toEqual([agentPath]);
  expect(snapshot.count).toBe(1);
  const record = snapshot.conversations[0]!;
  expect(record.transcriptPath).toBe(agentPath);
  /* The registry snapshot the query already read supplies the owner. */
  expect(record.conversationId).toBe("conversation_named");
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

test("an unregistered transcript is aged: past the grace it has stopped starting up", () => {
  const stallAfterMs = 10 * 60_000;
  /* Four minutes in, with nothing registered yet: still a launch. */
  expect(evaluateLiveness({ host: { state: "unknown" }, turnState: "busy", silentForMs: 4 * 60_000, stallAfterMs }))
    .toEqual({ lifecycle: "starting", reason: "launch_unproven" });
  /* Six hours in, mid-turn, still nothing registered: an orphan, not a launch.
     Reporting `starting` here tells an orchestrator to keep waiting for an
     agent that was never proven to exist. */
  expect(evaluateLiveness({ host: { state: "unknown" }, turnState: "busy", silentForMs: 6 * 3_600_000, stallAfterMs }))
    .toEqual({ lifecycle: "stalled", reason: "launch_unproven_expired" });
  /* The same age with a settled turn is simply over. */
  expect(evaluateLiveness({ host: { state: "unknown" }, turnState: "idle", silentForMs: 6 * 3_600_000, stallAfterMs }))
    .toEqual({ lifecycle: "gone", reason: "launch_unproven_expired" });
  /* Nothing to age it by keeps the benefit of the doubt. */
  expect(evaluateLiveness({ host: { state: "unknown" }, turnState: "unknown", silentForMs: null, stallAfterMs }))
    .toEqual({ lifecycle: "starting", reason: "launch_unproven" });
});

test("a targeted query with an unknown conversation id returns an empty snapshot, never the full inventory", async () => {
  const registry = {
    entries: {},
    conversations: {},
  } as unknown as RegistryFile;

  const snapshot = await agentLivenessSnapshot({ conversationId: "nonexistent_conversation_id" }, sources({
    listFiles: async () => {
      throw new Error("a targeted query with an unknown id must not run the inventory sweep");
    },
    describeTranscript: async () => null,
    registrySnapshot: () => registry,
    pipelines: () => [],
    transcriptEvidence: async () => null,
  }));

  expect(snapshot.count).toBe(0);
  expect(snapshot.conversations).toEqual([]);
});
