import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";

/*
 * #1501, production-shaped: a parked pipeline whose stage host was started by
 * a Viewer generation that no longer exists, closed from a process that has no
 * structured control channel (the MCP host process shape: no
 * LLV_RUNTIME_HOST_SOCKET). Every process signalled here is a child this test
 * started; every registry row lives in a throwaway state directory; the close
 * goes through the real PATCH route handler with default pipeline ports, the
 * real conversation-action seam, the real registry and real signals.
 */
const isolated = fs.mkdtempSync(path.join(os.tmpdir(), "llv-generation-close-"));
const isolatedEnvironment = {
  HOME: path.join(isolated, "home"),
  XDG_CONFIG_HOME: path.join(isolated, "config"),
  LLV_STATE_DIR: path.join(isolated, "state"),
  TMPDIR: path.join(isolated, "tmp"),
};
const ambientEnvironment = Object.fromEntries(
  ["LLV_RUNTIME_HOST_SOCKET", "LLV_STRUCTURED_HOSTS", ...Object.keys(isolatedEnvironment)]
    .map((name) => [name, process.env[name]]),
);
for (const [name, directory] of Object.entries(isolatedEnvironment)) {
  fs.mkdirSync(directory, { recursive: true });
  process.env[name] = directory;
}
process.env.LLV_STRUCTURED_HOSTS = "1";
/* The incident's caller shape: no channel to any runtime host generation. */
delete process.env.LLV_RUNTIME_HOST_SOCKET;

const { NextRequest } = await import("next/server");
const { AgentRegistry, setAgentRegistryForTests } = await import("@/lib/agent/registry");
type ProcessIdentity = import("@/lib/agent/registry").ProcessIdentity;
type AgentRegistryEntry = import("@/lib/agent/registry").AgentRegistryEntry;
const { beginLegacySpawnFixture } = await import("@/lib/agent/registryTestFixtures");
const { sessionKeyId } = await import("@/lib/agent/sessionKey");
const { procBackend } = await import("@/lib/proc");
const { captureProcessIdentity, systemBootEpoch } = await import("@/lib/processIdentity");
const { runtimeHostClient } = await import("@/lib/runtime/client");
const { buildPipeline, loadPipelines, savePipelines } = await import("./store");
const { defaultPipelinePorts, patchPipeline, stopPipelineStageAgent } = await import("./engine");
const { PATCH } = await import("@/app/api/pipelines/[id]/route");
type Pipeline = import("./types").Pipeline;

afterAll(() => {
  setAgentRegistryForTests(null);
  for (const [name, value] of Object.entries(ambientEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  fs.rmSync(isolated, { recursive: true, force: true });
});

/* ---------- controlled processes ---------- */

type Child = { pid: number; identity: ProcessIdentity; alive(): boolean; end(): Promise<void> };
const children: Child[] = [];
const realKill = process.kill;

/** A detached child leading its own process group, the way a structured host
    is spawned. Its argv is the same for every role a case gives it (host,
    Viewer generation, bystander), so nothing here can be told apart by argv. */
function child(): Child {
  const handle = spawn("/bin/sh", ["-c", "exec sleep 300"], { detached: true, stdio: "ignore" });
  const pid = handle.pid;
  if (pid === undefined) throw new Error("fixture child did not start");
  const identity = captureProcessIdentity(pid);
  if (!identity.startIdentity || !identity.bootEpoch) throw new Error("fixture child has no kernel identity to fence on");
  const alive = () => procBackend.pidAlive(pid);
  const end = async () => {
    /* Fixture teardown is not a product signal, so it bypasses the spy. */
    try { realKill.call(process, pid, "SIGKILL"); } catch { /* gone */ }
    await settles(() => !alive(), `child ${pid} exit`);
  };
  const created = { pid, identity, alive, end };
  children.push(created);
  return created;
}

async function settles(assertion: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (assertion()) return;
    await Bun.sleep(5);
  }
  throw new Error(`${what} did not settle`);
}

/** Every signal this process sends while a case runs. `process.kill` is the
    only primitive the identity-bound termination signals through. */
const signals: Array<{ pid: number; signal: string | number | undefined }> = [];
beforeEach(() => {
  signals.length = 0;
  process.kill = ((pid: number, signal?: string | number) => {
    signals.push({ pid, signal });
    return realKill.call(process, pid, signal as NodeJS.Signals);
  }) as typeof process.kill;
});
afterEach(async () => {
  process.kill = realKill;
  setAgentRegistryForTests(null);
  for (const created of children.splice(0)) await created.end();
});

/** Signals sent to a pid or to its process group. */
function signalsTo(pid: number) {
  return signals.filter((sent) => sent.pid === pid || sent.pid === -pid);
}

/* ---------- registry fixture, written through the product's own writers ---------- */

const NOW = () => new Date().toISOString();

type Lane = {
  registry: InstanceType<typeof AgentRegistry>;
  registryPath: string;
  conversationId: `conversation_${string}`;
  launchId: string;
  key: { engine: "claude"; sessionId: string };
  transcriptPath: string;
  entry(): AgentRegistryEntry | undefined;
};

/** Seats one structured conversation hosted by `host` and claimed by the
    Viewer generation `owner` — exactly what a Viewer spawn writes. */
function seatLane(host: ProcessIdentity, owner: ProcessIdentity, options: { registryPath?: string } = {}): Lane {
  const directory = fs.mkdtempSync(path.join(isolated, "lane-"));
  const registryPath = options.registryPath ?? path.join(directory, "agent-registry.json");
  const registry = new AgentRegistry(registryPath, undefined, undefined, { sqliteMode: "off" });
  const sessionId = crypto.randomUUID();
  const transcript = path.join(directory, `${sessionId}.jsonl`);
  fs.writeFileSync(transcript, `${JSON.stringify({ type: "user", timestamp: NOW(), message: { role: "user", content: "start" } })}\n`);
  const begun = beginLegacySpawnFixture(registry, { engine: "claude", cwd: directory, transport: "structured", accountId: null });
  if (begun.kind !== "created") throw new Error("spawn receipt was unavailable");
  const settled = registry.settleSpawn(begun.receipt.launchId, {
    key: { engine: "claude", sessionId },
    artifactPath: transcript,
    cwd: directory,
    accountId: null,
    status: "live",
    host: null,
    structuredHost: {
      kind: "claude-broker",
      endpoint: `stdio:${host.pid}`,
      process: host,
      eventCursor: 0,
      protocolVersion: "test",
      writerClaimEpoch: 1,
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 1,
    claimOwner: `structured-host:${JSON.stringify(owner)}`,
    pendingAction: null,
  });
  if (settled.kind !== "settled") throw new Error("structured conversation was unavailable");
  setAgentRegistryForTests(registry);
  const key = { engine: "claude" as const, sessionId };
  return {
    registry,
    registryPath,
    conversationId: settled.conversation.id,
    launchId: begun.receipt.launchId,
    key,
    transcriptPath: transcript,
    entry: () => registry.readOnlySnapshot().entries[sessionKeyId(key)],
  };
}

/** The post-reboot re-host: a successor Viewer generation takes the claim the
    dead incumbent left and records the host it started. Same writers as
    startup adoption (`claimStructuredHost`, then `setStructuredHostClaimed`). */
function rehost(lane: Lane, successor: ProcessIdentity, host: ProcessIdentity): void {
  const claimed = lane.registry.claimStructuredHost(lane.key, successor);
  if (!claimed?.claimOwner || !claimed.structuredHost) throw new Error("the successor generation could not claim the row");
  const written = lane.registry.setStructuredHostClaimed(
    lane.key,
    { ...claimed.structuredHost, endpoint: `stdio:${host.pid}`, process: host },
    "live",
    claimed.claimOwner,
    claimed.claimEpoch,
  );
  if (!written) throw new Error("the successor generation could not record its host");
}

/* ---------- pipeline fixture ---------- */

/** A parked lane: stage `build` attempt 1 settled `failed`, pipeline
    `needs_decision` — the record the reboot left behind. */
function parkedPipeline(lane: Lane, options: { launchId?: string | null; conversationId?: string | null } = {}): Pipeline {
  const id = crypto.randomUUID().slice(0, 8);
  const effectiveRole = { roleId: "builder" as const, engine: "claude" as const, model: null, effort: null, access: "read-write" as const, promptScaffold: "Builder guidance" };
  const pipeline = buildPipeline({
    id,
    task: "#1501 reproduction lane",
    project: "viewer-fixture",
    repoDir: path.join(isolated, "repo"),
    stages: [{ id: "build", kind: "run", prompt: "build it", next: null, role: { roleId: "builder" }, effectiveRole }],
    srcPath: null,
    srcConversationId: null,
    now: NOW(),
  });
  pipeline.state = "needs_decision";
  pipeline.stateDetail = "stage build attempt 1 ended in error";
  pipeline.baseBranch = "main";
  pipeline.baseRef = "0".repeat(40);
  pipeline.lastPassedCommit = "0".repeat(40);
  pipeline.cursor = { stageId: "build", state: "running", input: null, activatedBy: null };
  pipeline.runs[0]!.attempts.push({
    n: 1,
    state: "failed",
    effectiveRole,
    launchId: options.launchId === undefined ? lane.launchId : options.launchId,
    conversationId: options.conversationId === undefined ? lane.conversationId : options.conversationId,
    sessionId: lane.key.sessionId,
    agentPath: lane.transcriptPath,
    paneId: null,
    flowId: null,
    startedAt: NOW(),
    completedAt: NOW(),
    input: "build it",
    activatedBy: null,
    output: null,
    verdict: null,
    error: "stage build attempt 1 ended in error",
  });
  lane.registry.rememberMembership(lane.conversationId, {
    kind: "pipeline",
    containerId: id,
    role: "builder",
    slot: "build:1",
    stageId: "build",
    stageOrder: 0,
    round: 1,
    parentConversationId: null,
  });
  savePipelines([...loadPipelines().filter((existing) => existing.id !== id), pipeline]);
  return pipeline;
}

function pipelineRecord(id: string): Pipeline {
  const record = loadPipelines().find((candidate) => candidate.id === id);
  if (!record) throw new Error(`pipeline ${id} is not in the store`);
  return record;
}

/** The production seam: PATCH /api/pipelines/<id> {action:"close"} from a
    same-origin caller, answered by the real handler with default ports. */
async function closeThroughRoute(id: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const request = new NextRequest(`http://127.0.0.1/api/pipelines/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", host: "127.0.0.1:8899" },
    body: JSON.stringify({ action: "close" }),
  });
  const response = await PATCH(request, { params: Promise.resolve({ id }) });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

type CloseBody = { error?: string; close?: { stopped: unknown[]; alreadyStopped: unknown[]; stillRunning: Array<{ error: string }>; notes: Array<{ detail: string }> } };

/* ---------- cases ---------- */

test("the caller shape is the incident's: no structured control channel in this process", () => {
  expect(runtimeHostClient()).toBeNull();
  expect(systemBootEpoch()).not.toBeNull();
});

test("incident: a host re-started by a successor generation is ended by a close from a socketless process (#1501)", async () => {
  const incumbent = child();
  const hostA = child();
  const lane = seatLane(hostA.identity, incumbent.identity);
  const pipeline = parkedPipeline(lane);
  /* The reboot: the incumbent Viewer generation and its host are gone... */
  await incumbent.end();
  await hostA.end();
  /* ...and the successor generation re-hosts the row with a new process. */
  const successor = child();
  const hostB = child();
  rehost(lane, successor.identity, hostB.identity);
  expect(lane.entry()).toMatchObject({ status: "live", claimEpoch: 2, structuredHost: { process: { pid: hostB.pid } } });
  const bystander = child();
  const before = structuredClone(pipelineRecord(pipeline.id).runs);

  const closed = await closeThroughRoute(pipeline.id);

  expect(closed.status).toBe(200);
  const report = (closed.body as CloseBody).close!;
  expect(report.stillRunning).toEqual([]);
  expect(report.stopped).toMatchObject([{ stageId: "build", attempt: 1, conversationId: lane.conversationId }]);
  expect(report.notes.map((note) => note.detail).join("\n")).toContain(`pid ${hostB.pid}`);
  await settles(() => !hostB.alive(), "host B exit");
  expect(lane.entry()).toMatchObject({ status: "dead", structuredHost: null, claimOwner: null });
  /* Exactly one TERM reached the host; nothing reached the successor
     generation or the same-argv bystander. */
  expect(signalsTo(hostB.pid).filter((sent) => sent.signal === "SIGTERM")).toHaveLength(1);
  expect(signalsTo(successor.pid)).toEqual([]);
  expect(signalsTo(bystander.pid)).toEqual([]);
  expect(bystander.alive()).toBeTrue();
  expect(successor.alive()).toBeTrue();
  const after = pipelineRecord(pipeline.id);
  expect(after.state).toBe("closed");
  /* Attempt history and lineage are preserved; nothing restarted. */
  expect(after.runs).toEqual(before);
  expect(after.runs[0]!.attempts).toHaveLength(1);
});

test("control: a host proven dead closes through the existing fallback with no signal", async () => {
  const incumbent = child();
  const hostA = child();
  const lane = seatLane(hostA.identity, incumbent.identity);
  const pipeline = parkedPipeline(lane);
  await incumbent.end();
  await hostA.end();

  const closed = await closeThroughRoute(pipeline.id);

  expect(closed.status).toBe(200);
  const report = (closed.body as CloseBody).close!;
  expect(report.alreadyStopped).toMatchObject([{ stageId: "build", attempt: 1 }]);
  expect(report.stopped).toEqual([]);
  expect(signals).toEqual([]);
  expect(pipelineRecord(pipeline.id).state).toBe("closed");
});

test("a recorded start identity that no longer matches the pid is proof of death, never a target (#1501)", async () => {
  /* The kernel handed the pid to another process: the row's start token is
     not the live one. Residency reads that as the recorded host being gone,
     so the close terminalizes on evidence and the stranger is never signalled. */
  const stranger = child();
  const incumbent = child();
  const lane = seatLane({ ...stranger.identity, startIdentity: `${stranger.pid}:not-this-start` }, incumbent.identity);
  const pipeline = parkedPipeline(lane);

  const closed = await closeThroughRoute(pipeline.id);

  expect(closed.status).toBe(200);
  expect((closed.body as CloseBody).close!.alreadyStopped).toHaveLength(1);
  expect(signals).toEqual([]);
  expect(stranger.alive()).toBeTrue();
});

test("an identity that changes between the residency probe and the signal refuses without a signal (#1501)", async () => {
  const hostB = child();
  const successor = child();
  const lane = seatLane(hostB.identity, successor.identity);
  const pipeline = parkedPipeline(lane);
  let probes = 0;
  const stopStageAgent = (target: Parameters<typeof stopPipelineStageAgent>[0]) => stopPipelineStageAgent(target, {
    termination: {
      /* The first read (the fence before the tree walk) still matches; every
         later read reports the pid as some other process. */
      processIdentity: (pid) => pid === hostB.pid && probes++ > 0 ? `${pid}:recycled` : procBackend.processIdentity(pid),
    },
  });

  const closed = await patchPipeline(pipeline.id, { action: "close" }, { ...defaultPipelinePorts(), stopStageAgent });

  expect(closed.status).toBe(409);
  expect(closed.close?.stillRunning[0]?.error).toContain("identity changed before signalling");
  expect(signals).toEqual([]);
  expect(hostB.alive()).toBeTrue();
  expect(lane.entry()).toMatchObject({ status: "live", structuredHost: { process: { pid: hostB.pid } } });
  expect(pipelineRecord(pipeline.id).state).toBe("needs_decision");
});

test("a legacy row with no start identity is unresolved: no signal, the close is refused with the reason (#1501)", async () => {
  const hostB = child();
  const successor = child();
  const lane = seatLane({ pid: hostB.pid, startIdentity: null, bootEpoch: hostB.identity.bootEpoch }, successor.identity);
  const pipeline = parkedPipeline(lane);

  const closed = await closeThroughRoute(pipeline.id);

  expect(closed.status).toBe(409);
  const report = (closed.body as CloseBody).close!;
  expect(report.stillRunning[0]!.error).toContain("identity is unknown");
  expect(report.stillRunning[0]!.error).toContain(`pid ${hostB.pid}`);
  expect(signals).toEqual([]);
  expect(hostB.alive()).toBeTrue();
  expect(pipelineRecord(pipeline.id)).toMatchObject({ state: "needs_decision" });
  expect(pipelineRecord(pipeline.id).runs[0]!.attempts[0]!.state).toBe("failed");
});

test("a row without a boot epoch is ambiguous evidence: no signal, unresolved (#1501)", async () => {
  const hostB = child();
  const successor = child();
  const lane = seatLane({ pid: hostB.pid, startIdentity: hostB.identity.startIdentity }, successor.identity);
  const pipeline = parkedPipeline(lane);

  const closed = await closeThroughRoute(pipeline.id);

  expect(closed.status).toBe(409);
  expect((closed.body as CloseBody).close!.stillRunning[0]!.error).toContain("boot epoch is unknown");
  expect(signals).toEqual([]);
  expect(hostB.alive()).toBeTrue();
});

test("a launch receipt that names another conversation is contradictory ownership: no signal (#1501)", async () => {
  const hostB = child();
  const successor = child();
  const lane = seatLane(hostB.identity, successor.identity);
  /* A second conversation in the same registry, so its launch is real. */
  const other = beginLegacySpawnFixture(lane.registry, { engine: "claude", cwd: isolated, transport: "structured", accountId: null });
  if (other.kind !== "created") throw new Error("second launch was unavailable");
  const pipeline = parkedPipeline(lane, { launchId: other.receipt.launchId });

  const closed = await closeThroughRoute(pipeline.id);

  expect(closed.status).toBe(409);
  expect((closed.body as CloseBody).close!.stillRunning[0]!.error).toContain("contradictory ownership");
  expect(signals).toEqual([]);
  expect(hostB.alive()).toBeTrue();
});

test("an attempt whose conversation id resolves only through its transcript is unresolved for the identity path (#1501)", async () => {
  const hostB = child();
  const successor = child();
  const lane = seatLane(hostB.identity, successor.identity);

  const result = await stopPipelineStageAgent({
    stageId: "build",
    attempt: 1,
    conversationId: "conversation_not_this_lane",
    agentPath: lane.transcriptPath,
    paneId: null,
    launchId: lane.launchId,
  });

  expect(result).toMatchObject({ outcome: "failed" });
  expect((result as { error: string }).error).toContain("contradictory ownership");
  expect(signals).toEqual([]);
  expect(hostB.alive()).toBeTrue();
});

test("a refused signal is a failed close that names the pid and keeps every retry authority (#1501)", async () => {
  const hostB = child();
  const successor = child();
  const lane = seatLane(hostB.identity, successor.identity);
  const pipeline = parkedPipeline(lane);
  const stopStageAgent = (target: Parameters<typeof stopPipelineStageAgent>[0]) => stopPipelineStageAgent(target, {
    termination: {
      signal: () => { throw Object.assign(new Error("operation not permitted"), { code: "EPERM" }); },
    },
  });

  const refused = await patchPipeline(pipeline.id, { action: "close" }, { ...defaultPipelinePorts(), stopStageAgent });

  expect(refused.status).toBe(409);
  const error = refused.close?.stillRunning[0]?.error ?? "";
  expect(error).toContain("EPERM");
  expect(error).toContain(`pid ${hostB.pid}`);
  expect(hostB.alive()).toBeTrue();
  expect(lane.entry()).toMatchObject({ status: "live", structuredHost: { process: { pid: hostB.pid } } });
  const record = pipelineRecord(pipeline.id);
  expect(record.state).toBe("needs_decision");
  expect(record.stateDetail).toContain("EPERM");
  expect(record.runs[0]!.attempts[0]!.state).toBe("failed");

  /* The fault clears; the same close, through the route, now ends the host. */
  const closed = await closeThroughRoute(pipeline.id);
  expect(closed.status).toBe(200);
  await settles(() => !hostB.alive(), "host B exit after the fault cleared");
  expect(pipelineRecord(pipeline.id).state).toBe("closed");
});

test("the retirement is durable across a registry reopen and the closed lane is never re-adopted or restarted (#1501)", async () => {
  const hostB = child();
  const successor = child();
  const lane = seatLane(hostB.identity, successor.identity);
  const pipeline = parkedPipeline(lane);

  const closed = await closeThroughRoute(pipeline.id);
  expect(closed.status).toBe(200);
  await settles(() => !hostB.alive(), "host B exit");

  /* A fresh process reading the same file sees the retired row: no
     structuredHost, so startup adoption has nothing to launch for it. */
  const reopened = new AgentRegistry(lane.registryPath, undefined, undefined, { sqliteMode: "off" });
  expect(reopened.readOnlySnapshot().entries[sessionKeyId(lane.key)]).toMatchObject({ status: "dead", structuredHost: null, claimOwner: null });
  const record = pipelineRecord(pipeline.id);
  expect(record.state).toBe("closed");
  expect(record.runs[0]!.attempts).toHaveLength(1);
  expect(record.runs[0]!.attempts[0]!.state).toBe("failed");
});

test("two concurrent closes signal the host exactly once (#1501)", async () => {
  const hostB = child();
  const successor = child();
  const lane = seatLane(hostB.identity, successor.identity);
  const pipeline = parkedPipeline(lane);

  const [first, second] = await Promise.all([closeThroughRoute(pipeline.id), closeThroughRoute(pipeline.id)]);

  expect(first.status).toBe(200);
  expect(second.status).toBe(200);
  await settles(() => !hostB.alive(), "host B exit");
  expect(signalsTo(hostB.pid).filter((sent) => sent.signal === "SIGTERM")).toHaveLength(1);
  const reports = [first, second].map((answer) => (answer.body as CloseBody).close!);
  expect(reports.filter((report) => report.stopped.length === 1)).toHaveLength(1);
  expect(reports.filter((report) => report.alreadyStopped.length === 1)).toHaveLength(1);
  expect(pipelineRecord(pipeline.id).state).toBe("closed");
});

test("a row naming a pid in this process's own ancestry is refused without a signal (#1501)", async () => {
  const successor = child();
  const lane = seatLane(captureProcessIdentity(process.pid), successor.identity);
  const pipeline = parkedPipeline(lane);

  const closed = await closeThroughRoute(pipeline.id);

  expect(closed.status).toBe(409);
  expect((closed.body as CloseBody).close!.stillRunning[0]!.error).toContain("own process chain");
  expect(signals).toEqual([]);
});

test("a conversation holding an orchestrator seat is revalidated at the kill and refused (#1501)", async () => {
  const hostB = child();
  const successor = child();
  const lane = seatLane(hostB.identity, successor.identity);
  const pipeline = parkedPipeline(lane);
  lane.registry.rememberMembership(lane.conversationId, {
    kind: "orchestrator",
    containerId: "seat-fixture",
    role: "orchestrator",
    slot: "seat",
    stageId: null,
    stageOrder: null,
    round: null,
    parentConversationId: null,
  });

  const closed = await closeThroughRoute(pipeline.id);

  expect(closed.status).toBe(409);
  expect((closed.body as CloseBody).close!.stillRunning[0]!.error).toContain("orchestrator seat");
  expect(signals).toEqual([]);
  expect(hostB.alive()).toBeTrue();
});

test("with a control channel present the runtime path answers and the identity path is never entered (#1501)", async () => {
  const hostB = child();
  const successor = child();
  const lane = seatLane(hostB.identity, successor.identity);
  let terminations = 0;

  const result = await stopPipelineStageAgent(
    { stageId: "build", attempt: 1, conversationId: lane.conversationId, agentPath: lane.transcriptPath, paneId: null, launchId: lane.launchId },
    {
      /* A kill the runtime accepted and settled: what the Viewer process sees. */
      action: async () => ({ status: 200, body: { ok: true, structured: true, operationId: "op-1", receipt: { status: "delivered" } } }),
      termination: { signal: () => { terminations += 1; } },
    },
  );

  expect(result).toEqual({ outcome: "stopped" });
  expect(terminations).toBe(0);
  expect(signals).toEqual([]);
  expect(hostB.alive()).toBeTrue();
});
