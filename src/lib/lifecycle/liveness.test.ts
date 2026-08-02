import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AgentRegistryEntry, RegistryFile } from "@/lib/agent/registry";
import type { Pipeline, PipelineStageAttempt } from "@/lib/pipelines/types";
import type { FileScanSnapshot } from "@/lib/scanner/scanCache";
import type { FileEntry } from "@/lib/types";

import { completedGenerationSelection, type CompletedGenerationRead } from "./inventorySelection";
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

function dualHostEntry(
  artifactPath: string,
  status: AgentRegistryEntry["status"] = "live",
): AgentRegistryEntry {
  return {
    ...structuredEntry(artifactPath, 2222),
    status,
    host: {
      kind: "tmux",
      endpoint: "/tmp/tmux.sock",
      server: { pid: 1000, startIdentity: "tmux-server" },
      paneId: "%1",
      panePid: { pid: 1111, startIdentity: "tmux-pane" },
      windowName: "agent",
      agent: { pid: 1112, startIdentity: "tmux-agent" },
      argv: ["agent"],
    },
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

test.each([
  { name: "dead tmux with live structured host", alive: new Set([2222]), status: "live", lifecycle: "running", kind: "structured" },
  { name: "live tmux with dead structured host", alive: new Set([1112]), status: "live", lifecycle: "running", kind: "tmux" },
  { name: "both hosts live", alive: new Set([1112, 2222]), status: "live", lifecycle: "running", kind: "tmux" },
  { name: "both hosts dead", alive: new Set<number>(), status: "live", lifecycle: "stalled", kind: "tmux" },
  { name: "terminal registry status", alive: new Set([1112, 2222]), status: "dead", lifecycle: "stalled", kind: "tmux" },
] as const)("$name reports combined dual-host liveness", async ({ alive, status, lifecycle, kind }) => {
  const dir = sandbox();
  const agentPath = path.join(dir, "dual-host.jsonl");
  fs.writeFileSync(agentPath, "{}\n", "utf8");
  const registry = {
    entries: { "codex:dual-host": dualHostEntry(agentPath, status) },
    conversations: {},
  } as unknown as RegistryFile;

  const snapshot = await agentLivenessSnapshot({}, sources({
    probe: {
      now: () => NOW,
      pidAlive: (pid) => alive.has(pid),
      processIdentity: (pid) => alive.has(pid)
        ? pid === 2222 ? "start-token-of-a-dead-host" : pid === 1112 ? "tmux-agent" : "tmux-pane"
        : null,
    },
    listFiles: async () => [fileEntry({ path: agentPath, activity: "live" })],
    registrySnapshot: () => registry,
    pipelines: () => [],
    transcriptEvidence: async () => ({ turn: "busy" as const, lastRecordTs: NOW - 30_000 }),
  }));

  expect(snapshot.conversations[0]!.lifecycle).toBe(lifecycle);
  expect(snapshot.conversations[0]!.host.kind).toBe(kind);
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

/* ------------------------------------------------------------------------- *
 * #860 — bounded project-scoped selection.
 *
 * The incident: `agent_activity(project, liveOnly, limit: 10)` had not returned
 * after seventy seconds on a corpus this shape, while a targeted read of the
 * same deployment answered in 290 ms. Everything below is production-shaped and
 * isolated: a 10,000-row corpus, 1,000 rows in the requested project, six live
 * conversations and one multi-gigabyte transcript whose body is never opened.
 * ------------------------------------------------------------------------- */

const PROJECT = "viewer";
/** 3 GiB, allocated sparsely: the row exists, its bytes are never read. */
const HUGE_TRANSCRIPT_BYTES = 3 * 1024 ** 3;

function liveTranscriptText(at: number): string {
  return [
    { type: "assistant", timestamp: new Date(at - 5_000).toISOString(), message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }], stop_reason: "tool_use" } },
    { type: "user", timestamp: new Date(at).toISOString(), message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } },
  ].map((row) => JSON.stringify(row)).join("\n") + "\n";
}

interface ProductionCorpus {
  files: FileEntry[];
  livePaths: string[];
  hugePath: string;
}

/** 10,000 historical conversations, 1,000 in `PROJECT`, six live, one huge. */
function productionShapedCorpus(dir: string): ProductionCorpus {
  const files: FileEntry[] = [];
  const livePaths: string[] = [];
  for (let index = 0; index < 10_000; index += 1) {
    const inProject = index % 10 === 0;
    const project = inProject ? PROJECT : `other-${index % 41}`;
    const live = inProject && livePaths.length < 6;
    const transcriptPath = live
      ? path.join(dir, `live-${index}.jsonl`)
      : `${dir}/history/${project}/session-${index}.jsonl`;
    if (live) {
      fs.writeFileSync(transcriptPath, liveTranscriptText(NOW - 10_000), "utf8");
      livePaths.push(transcriptPath);
    }
    files.push(fileEntry({
      path: transcriptPath,
      project,
      engine: index % 3 === 0 ? "claude" : "codex",
      conversationId: `conversation_${index}`,
      mtime: Math.floor((NOW - index * 1_000) / 1000),
      activity: live ? "live" : "idle",
      activityReason: live ? "jsonl_turn_open" : "mtime_old",
      size: 4096,
    }));
  }
  /* The multi-gigabyte transcript: a real sparse file, in the project, idle.
     Metadata-only selection must never open it. */
  const hugePath = path.join(dir, "huge-history.jsonl");
  const handle = fs.openSync(hugePath, "w");
  fs.ftruncateSync(handle, HUGE_TRANSCRIPT_BYTES);
  const tail = Buffer.from(liveTranscriptText(NOW - 3_600_000).repeat(1_400), "utf8");
  fs.writeSync(handle, tail, 0, tail.length, HUGE_TRANSCRIPT_BYTES);
  fs.closeSync(handle);
  files.push(fileEntry({
    path: hugePath,
    project: PROJECT,
    engine: "claude",
    conversationId: "conversation_huge",
    mtime: Math.floor((NOW - 3_600_000) / 1000),
    activity: "idle",
    activityReason: "mtime_old",
    size: HUGE_TRANSCRIPT_BYTES + tail.length,
  }));
  files.sort((left, right) => right.mtime - left.mtime);
  return { files, livePaths, hugePath };
}

interface GenerationStub {
  read: CompletedGenerationRead;
  starts: () => number;
  reads: () => number;
}

/** One published generation, cloned per read exactly as `completedFileScan`
    does, so the measured cost is the production cost. */
function publishedGeneration(files: FileEntry[], options: { coldDelayMs?: number } = {}): GenerationStub {
  const snapshot = { files, projectCatalog: [], complete: true } as FileScanSnapshot;
  let starts = 0;
  let reads = 0;
  let published: Promise<void> | null = null;
  const read: CompletedGenerationRead = async (readOptions) => {
    reads += 1;
    if (!published) {
      starts += 1;
      published = new Promise((resolve) => setTimeout(resolve, options.coldDelayMs ?? 0));
    }
    await published;
    if (readOptions?.signal?.aborted) throw new DOMException("cancelled", "AbortError");
    return {
      snapshot: structuredClone(snapshot),
      generation: 12,
      targetGeneration: 12,
      cacheStatus: "hit",
      requestCount: reads,
      cloneDurationMs: 0,
    };
  };
  return { read, starts: () => starts, reads: () => reads };
}

function corpusSources(
  generation: GenerationStub,
  overrides: Partial<AgentLivenessSources> = {},
): AgentLivenessSources {
  return {
    now: () => NOW,
    probe: { now: () => NOW, pidAlive: () => true, processIdentity: () => "start-token-of-a-dead-host" },
    listFiles: async () => {
      throw new Error("a project-scoped read must never sweep the whole corpus");
    },
    selectInventory: (request, options) => completedGenerationSelection(request, {
      completedFileScan: generation.read,
      signal: options?.signal ?? null,
    }),
    describeTranscript: async () => {
      throw new Error("a project-scoped read describes nothing by path");
    },
    registrySnapshot: () => ({ entries: {}, conversations: {} }) as unknown as RegistryFile,
    pipelines: () => [],
    transcriptEvidence: readLivenessTranscriptEvidence,
    ...overrides,
  };
}

test("a project-scoped live read serves one completed generation, hydrates only the rows it returns, and never sweeps the corpus (#860)", async () => {
  const dir = sandbox();
  const corpus = productionShapedCorpus(dir);
  const generation = publishedGeneration(corpus.files);
  const hydrated: string[] = [];

  const startedAt = performance.now();
  const snapshot = await agentLivenessSnapshot(
    { project: PROJECT, liveOnly: true, limit: 10 },
    corpusSources(generation, {
      transcriptEvidence: async (engine, transcriptPath) => {
        hydrated.push(transcriptPath);
        return readLivenessTranscriptEvidence(engine, transcriptPath);
      },
    }),
  );
  const elapsedMs = performance.now() - startedAt;

  expect(snapshot.count).toBe(6);
  expect(hydrated).toHaveLength(6);
  expect(hydrated.every((entry) => corpus.livePaths.includes(entry))).toBe(true);
  expect(snapshot.selection).toMatchObject({
    scope: "project",
    scanned: 10_001,
    matched: 6,
    selected: 6,
    hydrated: 6,
    freshScan: false,
    generation: 12,
    budget: "complete",
  });
  expect(generation.starts()).toBe(1);
  /* Warm, on the production-shaped corpus, well inside the 500 ms bar. */
  expect(elapsedMs).toBeLessThan(500);
});

test("a limit of ten hydrates at most ten transcript tails out of a thousand project rows (#860)", async () => {
  const dir = sandbox();
  const corpus = productionShapedCorpus(dir);
  const generation = publishedGeneration(corpus.files);
  let hydrations = 0;

  const snapshot = await agentLivenessSnapshot(
    { project: PROJECT, limit: 10 },
    corpusSources(generation, {
      transcriptEvidence: async () => {
        hydrations += 1;
        return { turn: "idle" as const, lastRecordTs: NOW - 60_000 };
      },
    }),
  );

  expect(snapshot.count).toBe(10);
  expect(hydrations).toBe(10);
  expect(snapshot.selection.matched).toBe(1_001);
  expect(snapshot.selection.selected).toBe(10);
});

test("the multi-gigabyte transcript is selected from metadata and never opened for a metadata-only read (#860)", async () => {
  const dir = sandbox();
  const corpus = productionShapedCorpus(dir);
  const generation = publishedGeneration(corpus.files);
  const opened: string[] = [];

  const liveRead = await agentLivenessSnapshot(
    { project: PROJECT, liveOnly: true, limit: 10 },
    corpusSources(generation, {
      transcriptEvidence: async (engine, transcriptPath) => {
        opened.push(transcriptPath);
        return readLivenessTranscriptEvidence(engine, transcriptPath);
      },
    }),
  );

  /* Present in the generation, absent from every read. */
  expect(corpus.files.some((entry) => entry.path === corpus.hugePath)).toBe(true);
  expect(liveRead.conversations.map((record) => record.transcriptPath)).not.toContain(corpus.hugePath);
  expect(opened).not.toContain(corpus.hugePath);

  /* When it IS selected, the evidence read stays a bounded tail: three
     gigabytes of body would never come back in this budget. */
  const startedAt = performance.now();
  const hugeRead = await agentLivenessSnapshot(
    { project: PROJECT, limit: 1, stallAfterMs: 60_000 },
    corpusSources(generation, {
      selectInventory: async (request, options) => {
        const selection = await completedGenerationSelection(
          { ...request, query: "huge-history" },
          { completedFileScan: generation.read, signal: options?.signal ?? null },
        );
        return selection;
      },
    }),
  );
  const elapsedMs = performance.now() - startedAt;

  expect(hugeRead.conversations[0]!.transcriptPath).toBe(corpus.hugePath);
  expect(hugeRead.conversations[0]!.evidenceSource).toBe("transcript");
  expect(elapsedMs).toBeLessThan(1_000);
});

test("twenty concurrent project reads share one completed generation and stay bounded (#860)", async () => {
  const dir = sandbox();
  const corpus = productionShapedCorpus(dir);
  const generation = publishedGeneration(corpus.files, { coldDelayMs: 5 });

  const before = process.memoryUsage().rss;
  const startedAt = performance.now();
  const snapshots = await Promise.all(Array.from({ length: 20 }, () => agentLivenessSnapshot(
    { project: PROJECT, liveOnly: true, limit: 10 },
    corpusSources(generation),
  )));
  const elapsedMs = performance.now() - startedAt;
  const rssDeltaBytes = process.memoryUsage().rss - before;

  expect(generation.starts()).toBe(1);
  expect(generation.reads()).toBe(20);
  expect(snapshots.every((snapshot) => snapshot.selection.generation === 12)).toBe(true);
  expect(snapshots.every((snapshot) => snapshot.count === 6)).toBe(true);
  /* Twenty readers of a 10,000-row generation, each hydrating six tails. */
  expect(elapsedMs).toBeLessThan(2_000);
  expect(rssDeltaBytes).toBeLessThan(768 * 1024 * 1024);
});

test("a cancelled caller stops the read and starts no further transcript evidence (#860)", async () => {
  const dir = sandbox();
  const corpus = productionShapedCorpus(dir);
  const generation = publishedGeneration(corpus.files);
  const controller = new AbortController();
  const started: string[] = [];

  const pending = agentLivenessSnapshot(
    { project: PROJECT, liveOnly: true, limit: 10, signal: controller.signal },
    corpusSources(generation, {
      transcriptEvidence: async (_engine, transcriptPath) => {
        started.push(transcriptPath);
        if (started.length === 1) controller.abort();
        await new Promise((resolve) => setTimeout(resolve, 2));
        return { turn: "busy" as const, lastRecordTs: NOW - 1_000 };
      },
    }),
  );

  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  const settled = started.length;
  await new Promise((resolve) => setTimeout(resolve, 25));
  expect(started.length).toBe(settled);
  expect(settled).toBeLessThan(6);
});

test("a caller cancelled before the generation is read never touches it (#860)", async () => {
  const dir = sandbox();
  const corpus = productionShapedCorpus(dir);
  const generation = publishedGeneration(corpus.files);
  const controller = new AbortController();
  controller.abort();

  await expect(agentLivenessSnapshot(
    { project: PROJECT, liveOnly: true, limit: 10, signal: controller.signal },
    corpusSources(generation),
  )).rejects.toMatchObject({ name: "AbortError" });
  expect(generation.reads()).toBe(0);
});

test("phase timings are reported as bare numbers, carrying no identity (#860)", async () => {
  const dir = sandbox();
  const corpus = productionShapedCorpus(dir);
  const generation = publishedGeneration(corpus.files);

  const snapshot = await agentLivenessSnapshot(
    { project: PROJECT, liveOnly: true, limit: 10 },
    corpusSources(generation),
  );

  expect(Object.keys(snapshot.timings).sort()).toEqual([
    "evidenceReadMs",
    "inventorySelectionMs",
    "journalProjectionMs",
    "serializationMs",
    "totalMs",
  ]);
  for (const value of Object.values(snapshot.timings)) {
    expect(typeof value).toBe("number");
    expect(Number.isFinite(value)).toBe(true);
    expect(value).toBeGreaterThanOrEqual(0);
  }
  /* Nothing in the phase report can name a path, a project or an account. */
  const reported = { ...snapshot.timings, ...snapshot.selection };
  for (const [key, value] of Object.entries(reported)) {
    if (key === "scope" || key === "cacheStatus" || key === "budget") continue;
    expect(typeof value === "number" || typeof value === "boolean").toBe(true);
  }
});

test("the evidence budget degrades extra rows to the scan projection instead of reading unbounded tails (#860)", async () => {
  const dir = sandbox();
  const corpus = productionShapedCorpus(dir);
  const generation = publishedGeneration(corpus.files);
  let hydrations = 0;

  const snapshot = await agentLivenessSnapshot(
    { project: PROJECT, limit: 50, evidenceByteBudget: 4 * 4096 },
    corpusSources(generation, {
      transcriptEvidence: async () => {
        hydrations += 1;
        return { turn: "busy" as const, lastRecordTs: NOW - 1_000 };
      },
    }),
  );

  expect(hydrations).toBe(4);
  expect(snapshot.count).toBe(50);
  expect(snapshot.selection).toMatchObject({ hydrated: 4, projected: 46, budget: "byte_budget" });
  /* The unread rows still answer honestly, from the generation's projection. */
  expect(snapshot.conversations.filter((record) => record.evidenceSource === "projection")).toHaveLength(46);
});

test("a runtime-hosted conversation survives the liveness filter the completed generation still calls idle (#860)", async () => {
  const dir = sandbox();
  const agentPath = path.join(dir, "just-launched.jsonl");
  fs.writeFileSync(agentPath, liveTranscriptText(NOW - 1_000), "utf8");
  const generation = publishedGeneration([
    fileEntry({ path: agentPath, project: PROJECT, engine: "claude", activity: "idle", activityReason: "mtime_old", conversationId: "conversation_new" }),
    fileEntry({ path: path.join(dir, "old.jsonl"), project: PROJECT, activity: "idle", activityReason: "mtime_old", conversationId: "conversation_old" }),
  ]);

  const snapshot = await agentLivenessSnapshot(
    { project: PROJECT, liveOnly: true, limit: 10 },
    corpusSources(generation, {
      registrySnapshot: () => ({
        entries: { "claude:just-launched": structuredEntry(agentPath, 4242) },
        conversations: {},
      }) as unknown as RegistryFile,
    }),
  );

  expect(snapshot.conversations.map((record) => record.transcriptPath)).toEqual([agentPath]);
});

test("a targeted read never consults the completed generation (#860)", async () => {
  const dir = sandbox();
  const agentPath = path.join(dir, "targeted.jsonl");
  fs.writeFileSync(agentPath, liveTranscriptText(NOW - 1_000), "utf8");
  const generation = publishedGeneration([]);

  const snapshot = await agentLivenessSnapshot(
    { transcriptPath: agentPath, limit: 1 },
    corpusSources(generation, {
      describeTranscript: async (transcriptPath) => ({
        path: transcriptPath,
        project: PROJECT,
        title: "targeted agent",
        engine: "claude",
        mtimeMs: NOW - 1_000,
        conversationId: null,
        activity: null,
        activityReason: null,
      }),
    }),
  );

  expect(snapshot.count).toBe(1);
  expect(snapshot.selection.scope).toBe("targeted");
  expect(generation.reads()).toBe(0);
});
