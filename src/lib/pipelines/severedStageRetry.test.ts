import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "bun:test";

/* Isolated state only: this suite seats registry rows, drives a runtime kill
   and ticks pipelines against them. The only pid it can ever signal is a child
   it started itself, and it must never read the operator's live state
   directory. Structured hosting is pinned off so nothing reaches a runtime
   host: the delivery controller here is bound to a journal of its own. */
const isolated = fs.mkdtempSync(path.join(os.tmpdir(), "llv-severed-stage-retry-"));
const isolatedEnvironment = {
  HOME: path.join(isolated, "home"),
  XDG_CONFIG_HOME: path.join(isolated, "config"),
  LLV_STATE_DIR: path.join(isolated, "state"),
  TMPDIR: path.join(isolated, "tmp"),
  LLV_STRUCTURED_HOSTS: "0",
};
const ambientEnvironment = Object.fromEntries(
  Object.keys(isolatedEnvironment).map((name) => [name, process.env[name]]),
);
for (const [name, value] of Object.entries(isolatedEnvironment)) {
  if (name !== "LLV_STRUCTURED_HOSTS") fs.mkdirSync(value, { recursive: true });
  process.env[name] = value;
}

const { AgentRegistry, setAgentRegistryForTests } = await import("@/lib/agent/registry");
const { beginLegacySpawnFixture } = await import("@/lib/agent/registryTestFixtures");
const { procBackend } = await import("@/lib/proc");
const { RuntimeJournal } = await import("@/runtime-host/journal");
const { bindStructuredDeliveryQueue } = await import("@/lib/runtime/structuredDeliveryController");
const { createPipelineFromRequest, defaultPipelinePorts, patchPipeline, tickPipelines } = await import("./engine");
const { loadPipelines, savePipelines } = await import("./store");
const { registerPipelineTick } = await import("./controllerSignal");
type PipelinePorts = import("./engine").PipelinePorts;
type RuntimeHostClient = import("@/lib/runtime/client").RuntimeHostClient;

/* A tick this suite did not ask for must never reach the real ports. */
registerPipelineTick(async () => {});

afterAll(() => {
  setAgentRegistryForTests(null);
  for (const [name, value] of Object.entries(ambientEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  fs.rmSync(isolated, { recursive: true, force: true });
});

const TOOL_CALL_AT = "2026-08-29T03:24:00.000Z";
const TOOL_RESULT_AT = "2026-08-29T03:24:05.000Z";
const STAGE_HEAD = "1111111111111111111111111111111111111111";
/* The incident's own interval: the host had been up 34 minutes when the kill
   was attempted. Both clocks move together, because a wall clock 34 minutes
   ahead is a machine that has been up 34 minutes longer. */
const LATER_MS = 34 * 60_000;

function runtimeJournalClient(journal: InstanceType<typeof RuntimeJournal>): RuntimeHostClient {
  return {
    snapshot: async () => journal.snapshot(),
    append: async (event) => journal.append(event),
    command: async (command) => journal.executeOperation(command),
    operationStatus: async (operationId) => journal.operationResult(operationId),
    retryOperation: async (operationId, nextIdempotencyKey, options) =>
      journal.retryOperation(operationId, nextIdempotencyKey, options),
    effectBatch: async (kinds, afterEventSeq) => journal.effectBatch(100, kinds, afterEventSeq),
    transitionOperation: async (operationId, status, details) =>
      journal.transitionOperation(operationId, status, details),
  } as RuntimeHostClient;
}

async function settles(assertion: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (assertion()) return;
    await Bun.sleep(5);
  }
  throw new Error(`${what} did not settle`);
}

const OPEN_TURN_TRANSCRIPT = [
  JSON.stringify({ type: "assistant", timestamp: TOOL_CALL_AT, message: { content: [{ type: "tool_use", id: "t1", name: "Bash" }] } }),
  JSON.stringify({ type: "user", timestamp: TOOL_RESULT_AT, message: { content: [{ type: "tool_result", tool_use_id: "t1" }] } }),
  "",
].join("\n");

/** A tail no reader can parse: the record is cut off mid-object. */
const UNREADABLE_TRANSCRIPT = '{"type":"assistant","timestamp":"2026-08-29T03:24:0';

/**
 * A stage whose structured host is the incident's specimen: a live process that
 * has written nothing since its own launch, over a transcript whose last event
 * is an unanswered tool call from before that launch.
 *
 * `hostProcess` replaces that live child with a pid the row still names and the
 * machine no longer runs, and `body` replaces the transcript — together, the
 * shape a redeploy leaves behind when the artifact is also unreadable.
 */
function severedStage(
  options: { body?: string; recordedTurn?: "busy" | "terminal"; hostProcess?: { pid: number; startIdentity: string } } = {},
) {
  const directory = fs.mkdtempSync(path.join(isolated, "stage-"));
  const worktreeDir = path.join(directory, "worktree");
  fs.mkdirSync(worktreeDir, { recursive: true });
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"), undefined, undefined, { sqliteMode: "off" });
  const child = options.hostProcess ? null : Bun.spawn(["sleep", "300"], { stdout: "ignore", stderr: "ignore" });
  const hostProcess = options.hostProcess ?? {
    pid: child!.pid,
    startIdentity: procBackend.processIdentity(child!.pid)!,
  };
  if (!hostProcess.startIdentity) throw new Error("the fixture host has no start identity to fence on");
  const sessionId = crypto.randomUUID();
  const transcript = path.join(directory, `${sessionId}.jsonl`);
  fs.writeFileSync(transcript, options.body ?? OPEN_TURN_TRANSCRIPT);
  const anHourAgo = new Date(Date.now() - 60 * 60_000);
  fs.utimesSync(transcript, anHourAgo, anHourAgo);
  const begun = beginLegacySpawnFixture(registry, { engine: "claude", cwd: worktreeDir, transport: "structured", accountId: null });
  if (begun.kind !== "created") throw new Error("spawn receipt was unavailable");
  const settled = registry.settleSpawn(begun.receipt.launchId, {
    key: { engine: "claude", sessionId },
    artifactPath: transcript,
    cwd: worktreeDir,
    accountId: null,
    status: "live",
    host: null,
    structuredHost: {
      kind: "claude-broker",
      endpoint: `stdio:${hostProcess.pid}`,
      process: hostProcess,
      eventCursor: 0,
      protocolVersion: "test",
      writerClaimEpoch: 1,
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 1,
    claimOwner: "structured-host:severed-stage-fixture",
    pendingAction: null,
  });
  if (settled.kind !== "settled") throw new Error("structured conversation was unavailable");
  if (options.recordedTurn) {
    /* The turn word the durable record carries, inherited from whoever wrote it
       last. No retry is ever decided on it (#1281), and a case that means to
       prove that has to put the word there. */
    registry.reconcileConversations([{
      engine: "claude",
      path: transcript,
      accountId: null,
      launchProfile: settled.conversation.generations.at(-1)!.launchProfile,
      turn: {
        state: options.recordedTurn,
        source: "lifecycle",
        terminalAt: options.recordedTurn === "terminal" ? TOOL_RESULT_AT : null,
      },
      observedAt: "2026-08-29T03:30:00.000Z",
    }]);
  }
  setAgentRegistryForTests(registry);
  return {
    registry,
    worktreeDir,
    transcript,
    launchId: begun.receipt.launchId,
    key: { engine: "claude" as const, sessionId },
    conversationId: settled.conversation.id,
    child: { pid: hostProcess.pid, kill: () => { try { child?.kill("SIGKILL"); } catch { /* gone */ } } },
  };
}

/**
 * The pipeline ports, real everywhere the incident runs through them: host
 * liveness, durable turn evidence and the spawn receipt all read the registry
 * this test seated. Only the outside world is stubbed — git, and starting an
 * agent, which no test may do — plus the wall clock, so the dead-host grace can
 * be spent without waiting it out.
 */
function stagePorts(stage: ReturnType<typeof severedStage>, spawns: string[]): PipelinePorts {
  let wallClockOffsetMs = 0;
  const ports: PipelinePorts = {
    ...defaultPipelinePorts(),
    now: () => new Date(Date.now() + wallClockOffsetMs).toISOString(),
    exec: (rawCommand, rawArgs) => {
      const args = rawCommand === "timeout" ? rawArgs.slice(rawArgs.indexOf("git") + 1) : rawArgs;
      if (args[0] === "rev-parse" && args[1] === "--git-dir") return { code: 0, stdout: ".git\n", stderr: "" };
      if (args[0] === "rev-parse") return { code: 0, stdout: `${STAGE_HEAD}\n`, stderr: "" };
      if (args[0] === "branch") return { code: 0, stdout: "pipeline/severed-stage\n", stderr: "" };
      if (args[0] === "remote") return { code: 1, stdout: "", stderr: "no origin\n" };
      if (args[0] === "ls-remote") return { code: 0, stdout: `${STAGE_HEAD}\trefs/heads/pipeline/severed-stage\n`, stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
    preflightRepo: (repoDir) => ({
      ok: true,
      repoDir,
      gitCommonDir: path.join(repoDir, ".git"),
      worktreeParent: path.dirname(repoDir),
    }),
    roleLookup: (roleId) => roleId === "builder"
      ? { engine: "claude", model: "opus", effort: "xhigh", access: "read-write", promptScaffold: "Builder guidance" }
      : null,
    /* The first launch is the stage host this suite seated; a later one is the
       replacement a retry asks for. No agent is ever started. */
    spawnAgent: async ({ clientAttemptId }, onReserved) => {
      spawns.push(clientAttemptId);
      if (spawns.length === 1) {
        onReserved({ launchId: stage.launchId, conversationId: stage.conversationId });
        return {
          launchId: stage.launchId,
          conversationId: stage.conversationId,
          sessionId: stage.key.sessionId,
          ["transcript"]: stage.transcript,
          paneId: null,
        };
      }
      const replacement = `replacement-${spawns.length - 1}`;
      onReserved({ launchId: replacement, conversationId: `conversation_${replacement}` });
      return {
        launchId: replacement,
        conversationId: `conversation_${replacement}`,
        sessionId: `session-${replacement}`,
        ["transcript"]: path.join(path.dirname(stage.transcript), `${replacement}.jsonl`),
        paneId: null,
      };
    },
    stopStageAgent: async () => ({ outcome: "not-running" }),
    stopStagePane: async () => ({ outcome: "not-running" }),
    stageHostResident: async () => false,
    paneAgentAlive: async () => false,
    worktreePresent: () => true,
    headCwd: () => stage.worktreeDir,
    sourcePathAllowed: (pathname) => pathname.endsWith(".jsonl"),
    projectForCwd: () => "fixture",
  };
  return Object.assign(ports, {
    advanceWallClock: (milliseconds: number) => { wallClockOffsetMs += milliseconds; },
  });
}

test("a live severed stage host is killed, retired, and its stage retried once, through the seams the incident ran through (#1282)", async () => {
  const stage = severedStage();
  const journal = new RuntimeJournal(path.join(path.dirname(stage.transcript), "runtime.sqlite"), { structuredHosts: true });
  const client = runtimeJournalClient(journal);
  const spawns: string[] = [];
  const ports = stagePorts(stage, spawns) as PipelinePorts & { advanceWallClock(ms: number): void };

  try {
    /* 0. A pipeline whose one stage is running on that host, provisioned and
       spawned through the engine's own path. */
    savePipelines([]);
    const created = await createPipelineFromRequest({
      task: "Ship the severed stage",
      spec: "AC1",
      repoDir: stage.worktreeDir,
      src: stage.transcript,
      stages: [{
        id: "build",
        kind: "run",
        role: { roleId: "builder" },
        access: "read-write",
        ["prompt"]: "Build the scoped change",
        next: null,
      }],
    } as never, ports);
    if (!created.pipeline) throw new Error(created.error ?? "pipeline creation was unavailable");
    await tickPipelines([], ports);
    await tickPipelines([], ports);
    expect(loadPipelines()[0]!.runs[0]!.attempts[0]).toMatchObject({
      state: "running",
      conversationId: stage.conversationId,
      launchId: stage.launchId,
      paneId: null,
    });

    /* 1. The operator's kill, admitted as a runtime operation and executed by
       the delivery controller — the path that refused forever while the
       recorded process was alive and this Viewer was its claim owner. */
    journal.executeOperation({
      kind: "kill",
      operationId: "kill-severed-stage",
      idempotencyKey: "kill-severed-stage",
      conversationId: stage.conversationId,
      sessionKey: stage.key,
    });
    await bindStructuredDeliveryQueue([], {
      registry: stage.registry,
      client,
      /* Real process, real transcript, real registry; only the clock is moved,
         so the host reaches the age the incident's host had. */
      liveness: {
        now: () => Date.now() + LATER_MS,
        uptimeSeconds: () => os.uptime() + LATER_MS / 1_000,
        processCpuMs: () => 4_700,
      },
    });

    await settles(
      () => journal.operationResult("kill-severed-stage")?.receipt.status === "delivered",
      "the kill operation",
    );
    /* 2. The process is gone and the row retired, so the registry stops
       claiming a host for this conversation. */
    await settles(() => !procBackend.pidAlive(stage.child.pid), "the reaped host process");
    expect(stage.registry.readOnlySnapshot().entries[`claude:${stage.key.sessionId}`]).toMatchObject({
      status: "dead",
      structuredHost: null,
    });

    /* 3. The pipeline tick, reading host liveness through its own port. */
    ports.advanceWallClock(6 * 60_000);
    await tickPipelines([], ports);

    const parked = loadPipelines()[0]!;
    expect(parked.state).toBe("needs_decision");
    expect(parked.runs[0]!.attempts[0]).toMatchObject({ state: "failed" });

    /* 4. `retry-stage`, which the stage's stuck `running` state used to refuse
       — the lane could only be freed by closing the pipeline. */
    const retried = await patchPipeline(parked.id, { action: "retry-stage" }, ports);
    expect(retried.error).toBeUndefined();
    expect(retried.pipeline?.state).not.toBe("closed");

    await tickPipelines([], ports);

    /* 5. Exactly one replacement attempt for the severed one. */
    expect(spawns).toHaveLength(2);
    const resumed = loadPipelines()[0]!;
    expect(resumed.state).not.toBe("closed");
    expect(resumed.runs[0]!.attempts).toHaveLength(2);
    expect(resumed.runs[0]!.attempts[1]).toMatchObject({ n: 2, launchId: "replacement-1" });
  } finally {
    stage.child.kill();
    await bindStructuredDeliveryQueue([], { registry: stage.registry, client: null });
    journal.close();
  }
});

test.each(["busy", "terminal"] as const)(
  "a stage whose host is gone and whose transcript cannot be read is never retried on a stale %s turn word",
  async (recordedTurn) => {
    /* The same seams as the sequence above, with one fact removed: the
       transcript cannot be parsed. What remains is a row that still reads
       `live`, a pid the machine no longer runs, and a word claiming a turn is
       in flight or finished. Under the reading this replaced, the missing pid
       alone answered `severed`, the tick spent the dead-host grace and failed
       the attempt, and `retry-stage` re-ran a step that may have completed
       before the process ever went away. Nothing separates that from a turn cut
       off mid-work, so nothing happens: the attempt keeps running and no
       replacement is spawned (#1281). */
    const stage = severedStage({
      body: UNREADABLE_TRANSCRIPT,
      recordedTurn,
      hostProcess: { pid: 2_000_000_005, startIdentity: "pre-restart-host" },
    });
    const spawns: string[] = [];
    const ports = stagePorts(stage, spawns) as PipelinePorts & { advanceWallClock(ms: number): void };

    savePipelines([]);
    const created = await createPipelineFromRequest({
      task: "Ship the unreadable stage",
      spec: "AC1",
      repoDir: stage.worktreeDir,
      src: stage.transcript,
      stages: [{
        id: "build",
        kind: "run",
        role: { roleId: "builder" },
        access: "read-write",
        ["prompt"]: "Build the scoped change",
        next: null,
      }],
    } as never, ports);
    if (!created.pipeline) throw new Error(created.error ?? "pipeline creation was unavailable");
    await tickPipelines([], ports);
    await tickPipelines([], ports);
    expect(loadPipelines()[0]!.runs[0]!.attempts[0]).toMatchObject({ state: "running" });

    /* Well past the grace a genuinely dead host is failed after. */
    ports.advanceWallClock(6 * 60_000);
    await tickPipelines([], ports);

    const held = loadPipelines()[0]!;
    expect(held.runs[0]!.attempts[0]).toMatchObject({ state: "running" });
    expect(held.runs[0]!.attempts).toHaveLength(1);
    expect(held.state).not.toBe("needs_decision");
    expect(spawns).toHaveLength(1);
  },
);
