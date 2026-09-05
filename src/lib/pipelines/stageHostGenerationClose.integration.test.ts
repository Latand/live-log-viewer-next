import { Database } from "bun:sqlite";
import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";

/*
 * #1501, production-shaped and causal.
 *
 * Three kinds of real process take part, and none of them is this test
 * relabelled:
 *
 *  - a runtime host generation: `src/runtime-host/main.ts` under `bun run`, on
 *    a private socket in a private state directory. Every Viewer generation
 *    below talks to it over that socket, as the Viewer container does.
 *  - Viewer generations: `fixtures/stageHostGeneration.ts` under `bun run`,
 *    one process per generation. The incumbent runs the product's spawn
 *    writers and records itself as the claim owner; a successor runs the
 *    product's `adoptStructuredHostsAtStartup` with only the CLI launch
 *    substituted. Losing a generation is killing that process.
 *  - stage hosts: detached `sh -c 'exec sleep 300'` children the generations
 *    start, recorded in the registry by pid, start identity and boot epoch.
 *
 * This process is the caller with no structured control channel — the MCP
 * host process shape, which answered every close of the incident's lane with
 * "structured runtime host is unavailable". Its closes go over HTTP to a
 * loopback listener serving the real PATCH route with default ports, so the
 * transport, the handler, the close loop, the conversation-action seam, the
 * registry and the signals are all the product's.
 */
const isolated = fs.mkdtempSync(path.join(os.tmpdir(), "llv-generation-close-"));
const isolatedEnvironment = {
  HOME: path.join(isolated, "home"),
  XDG_CONFIG_HOME: path.join(isolated, "config"),
  LLV_STATE_DIR: path.join(isolated, "state"),
  TMPDIR: path.join(isolated, "tmp"),
  LLV_CLAUDE_HOME: path.join(isolated, "claude"),
  LLV_CODEX_HOME: path.join(isolated, "codex"),
  CODEX_HOME: path.join(isolated, "codex"),
  CLAUDE_CONFIG_DIR: path.join(isolated, "claude"),
};
const ambientEnvironment = Object.fromEntries(
  ["LLV_RUNTIME_HOST_SOCKET", "LLV_STRUCTURED_HOSTS", "NODE_ENV", ...Object.keys(isolatedEnvironment)]
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
const { captureProcessIdentity, processIdentityStatus, systemBootEpoch } = await import("@/lib/processIdentity");
const { runtimeHostClient } = await import("@/lib/runtime/client");
const { probeRuntimeSocket } = await import("@/runtime-host/hostRehearsalRun");
const { RUNTIME_HOST_CONTAINER_ENV } = await import("@/runtime-host/hostRelease");
const { buildPipeline, loadPipelines, savePipelines } = await import("./store");
const { defaultPipelinePorts, patchPipeline, stopPipelineStageAgent, tickPipelines } = await import("./engine");
const { PATCH } = await import("@/app/api/pipelines/[id]/route");
type Pipeline = import("./types").Pipeline;

const repoRoot = path.resolve(import.meta.dir, "../../..");
const generationFixture = path.join(import.meta.dir, "fixtures", "stageHostGeneration.ts");
const runtimeSocket = path.join(isolated, "runtime-host.sock");
const generationEnvironment: Record<string, string | undefined> = {
  PATH: process.env.PATH,
  ...isolatedEnvironment,
  LLV_STRUCTURED_HOSTS: "1",
  LLV_RUNTIME_HOST_SOCKET: runtimeSocket,
  LLV_RUNTIME_JOURNAL: path.join(isolated, "runtime-events.sqlite"),
};

/* ---------- the runtime host generation ---------- */

let runtimeHost: ChildProcess | null = null;
const runtimeHostLog: string[] = [];

beforeAll(async () => {
  runtimeHost = spawn(process.execPath, ["run", "src/runtime-host/main.ts"], {
    cwd: repoRoot,
    env: { ...generationEnvironment, [RUNTIME_HOST_CONTAINER_ENV]: "generation-close-proof" } as Record<string, string | undefined> as NodeJS.ProcessEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const collect = (chunk: unknown) => { for (const line of String(chunk).split("\n")) if (line.trim()) runtimeHostLog.push(line); };
  runtimeHost.stdout?.on("data", collect);
  runtimeHost.stderr?.on("data", collect);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await probeRuntimeSocket(runtimeSocket, { id: "ready", method: "snapshot", params: {} }, { abandon: false })) return;
    await Bun.sleep(50);
  }
  throw new Error(`the runtime host did not answer on its socket:\n${runtimeHostLog.join("\n")}`);
}, 40_000);

afterAll(async () => {
  setAgentRegistryForTests(null);
  if (runtimeHost && runtimeHost.exitCode === null) {
    const gone = new Promise<void>((resolve) => runtimeHost!.once("exit", () => resolve()));
    runtimeHost.kill("SIGTERM");
    const forced = setTimeout(() => runtimeHost?.kill("SIGKILL"), 5_000);
    await gone;
    clearTimeout(forced);
  }
  for (const [name, value] of Object.entries(ambientEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  fs.rmSync(isolated, { recursive: true, force: true });
});

/* ---------- controlled processes ---------- */

type Tracked = { pid: number; identity: ProcessIdentity; alive(): boolean; end(): Promise<void> };
const tracked: Tracked[] = [];
const realKill = process.kill;

async function settles(assertion: () => boolean, what: string, attempts = 600): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (assertion()) return;
    await Bun.sleep(5);
  }
  throw new Error(`${what} did not settle`);
}

/** Tracks a process this test is responsible for ending; teardown kills are
    not product signals, so they bypass the spy. */
function track(pid: number, identity: ProcessIdentity = captureProcessIdentity(pid)): Tracked {
  const alive = () => procBackend.pidAlive(pid);
  const end = async () => {
    try { realKill.call(process, pid, "SIGKILL"); } catch { /* gone */ }
    await settles(() => !alive(), `process ${pid} exit`);
  };
  const created = { pid, identity, alive, end };
  tracked.push(created);
  return created;
}

/** A same-argv bystander no registry row names: manual or external provenance. */
function bystander(): Tracked {
  const handle = spawn("/bin/sh", ["-c", "exec sleep 300"], { detached: true, stdio: "ignore" });
  if (handle.pid === undefined) throw new Error("bystander did not start");
  return track(handle.pid);
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
  for (const created of tracked.splice(0)) await created.end();
});

function signalsTo(pid: number) {
  return signals.filter((sent) => sent.pid === pid || sent.pid === -pid);
}

/* ---------- Viewer generations, as separate processes ---------- */

type SpawnReport = {
  generation: ProcessIdentity;
  conversationId: `conversation_${string}`;
  launchId: string;
  sessionId: string;
  transcriptPath: string;
  host: ProcessIdentity;
  descendant: ProcessIdentity | null;
};
type AdoptReport = {
  deferred: string | null;
  generation: ProcessIdentity;
  adopted: Array<{ key: string; host: ProcessIdentity }>;
  considered: string[];
  published: string[];
  entries: Record<string, { status: string; claimOwner: string | null; process: ProcessIdentity | null }>;
};
type Generation<Report> = Tracked & { report: Report };

async function generation<Report extends { generation: ProcessIdentity }>(
  mode: "spawn" | "adopt",
  lane: { registryPath: string; directory: string },
  hostShape: "single" | "tree" = "single",
): Promise<Generation<Report>> {
  const child: ChildProcess = spawn(process.execPath, ["run", generationFixture, mode, lane.registryPath, lane.directory, hostShape], {
    cwd: repoRoot,
    env: generationEnvironment as NodeJS.ProcessEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (child.pid === undefined) throw new Error("generation did not start");
  const errors: string[] = [];
  child.stderr?.on("data", (chunk) => errors.push(String(chunk)));
  const report = await new Promise<Report>((resolve, reject) => {
    let buffered = "";
    child.stdout?.on("data", (chunk) => {
      buffered += String(chunk);
      const line = buffered.split("\n").find((candidate) => candidate.trim().startsWith("{"));
      if (line) resolve(JSON.parse(line) as Report);
    });
    child.once("exit", (code) => reject(new Error(`generation ${mode} exited with ${code} before reporting:\n${errors.join("")}`)));
  });
  const created = track(child.pid, report.generation);
  expect(report.generation.pid).toBe(child.pid);
  return Object.assign(created, { report });
}

/* ---------- lane fixture ---------- */

type Lane = {
  directory: string;
  registryPath: string;
  registry: InstanceType<typeof AgentRegistry>;
  incumbent: Generation<SpawnReport>;
  hostA: Tracked;
  descendant: Tracked | null;
  conversationId: `conversation_${string}`;
  launchId: string;
  key: { engine: "claude"; sessionId: string };
  transcriptPath: string;
  entry(): AgentRegistryEntry | undefined;
  hostedBy(): ProcessIdentity | null;
};

/** One lane: an incumbent Viewer generation spawns a structured stage
    conversation hosted by a controlled process. This test process reads the
    same registry file through the product's registry. */
async function lane(hostShape: "single" | "tree" = "single"): Promise<Lane> {
  const directory = fs.mkdtempSync(path.join(isolated, "lane-"));
  const registryPath = path.join(directory, "agent-registry.json");
  const incumbent = await generation<SpawnReport>("spawn", { registryPath, directory }, hostShape);
  const registry = new AgentRegistry(registryPath, undefined, undefined, { sqliteMode: "off" });
  setAgentRegistryForTests(registry);
  const key = { engine: "claude" as const, sessionId: incumbent.report.sessionId };
  return {
    directory,
    registryPath,
    registry,
    incumbent,
    hostA: track(incumbent.report.host.pid, incumbent.report.host),
    descendant: incumbent.report.descendant ? track(incumbent.report.descendant.pid, incumbent.report.descendant) : null,
    conversationId: incumbent.report.conversationId,
    launchId: incumbent.report.launchId,
    key,
    transcriptPath: incumbent.report.transcriptPath,
    entry: () => registry.readOnlySnapshot().entries[sessionKeyId(key)],
    hostedBy: () => registry.readOnlySnapshot().entries[sessionKeyId(key)]?.structuredHost?.process ?? null,
  };
}

/** The reboot, as far as one lane is concerned: the Viewer generation that
    owns the row and the host it started are both gone. */
async function loseIncumbent(current: Lane): Promise<void> {
  await current.incumbent.end();
  await current.hostA.end();
  if (current.descendant) await current.descendant.end();
}

/** Work the product owes the conversation: a held delivery, which startup
    adoption honours whatever the pipeline record says. */
function holdWork(current: Lane): void {
  current.registry.holdDelivery(
    current.conversationId,
    "answer this when you are back",
    `held-${crypto.randomUUID()}`,
    "text",
    [],
    null,
    { operationId: `op-${crypto.randomUUID()}`, kind: "send", policy: "queue", turnId: null },
  );
}

/** A successor Viewer generation boots against the lane's registry and the
    runtime host, running the product's startup adoption. */
async function successor(current: Lane): Promise<Generation<AdoptReport>> {
  const booted = await generation<AdoptReport>("adopt", { registryPath: current.registryPath, directory: current.directory });
  for (const adopted of booted.report.adopted) track(adopted.host.pid, adopted.host);
  return booted;
}

/* ---------- pipeline fixture ---------- */

const NOW = () => new Date().toISOString();
const effectiveRole = { roleId: "builder" as const, engine: "claude" as const, model: null, effort: null, access: "read-write" as const, promptScaffold: "Builder guidance" };

/** The record the incident left behind by default: stage `build` attempt 1
    settled `failed`, pipeline `needs_decision`. `running` keeps the attempt
    live, the shape of a lane the controller still drives. */
function pipelineFor(
  current: Lane,
  options: { launchId?: string | null; conversationId?: string | null; attemptState?: "failed" | "running" } = {},
): Pipeline {
  const id = crypto.randomUUID().slice(0, 8);
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
  const running = options.attemptState === "running";
  pipeline.state = running ? "running" : "needs_decision";
  pipeline.stateDetail = running ? null : "stage build attempt 1 ended in error";
  pipeline.baseBranch = "main";
  pipeline.baseRef = "0".repeat(40);
  pipeline.lastPassedCommit = "0".repeat(40);
  pipeline.cursor = { stageId: "build", state: "running", input: null, activatedBy: null };
  pipeline.runs[0]!.attempts.push({
    n: 1,
    state: running ? "running" : "failed",
    effectiveRole,
    launchId: options.launchId === undefined ? current.launchId : options.launchId,
    conversationId: options.conversationId === undefined ? current.conversationId : options.conversationId,
    sessionId: current.key.sessionId,
    agentPath: current.transcriptPath,
    paneId: null,
    flowId: null,
    startedAt: NOW(),
    completedAt: running ? null : NOW(),
    input: "build it",
    activatedBy: null,
    output: null,
    verdict: null,
    error: running ? null : "stage build attempt 1 ended in error",
  });
  current.registry.rememberMembership(current.conversationId, {
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

/* ---------- the transport: a loopback listener serving the real route ---------- */

type CloseReport = {
  stopped: unknown[];
  alreadyStopped: unknown[];
  stillRunning: Array<{ error: string }>;
  notes: Array<{ detail: string }>;
};
type CloseAnswer = { status: number; error?: string; close?: CloseReport };

const listener = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    const match = /^\/api\/pipelines\/([^/]+)$/.exec(url.pathname);
    if (!match || request.method !== "PATCH") return new Response("not found", { status: 404 });
    const forwarded = new NextRequest(request.url, {
      method: "PATCH",
      headers: request.headers,
      body: await request.text(),
    });
    return PATCH(forwarded, { params: Promise.resolve({ id: match[1]! }) });
  },
});
afterAll(() => { listener.stop(true); });

/** PATCH /api/pipelines/<id> {action:"close"} over HTTP, from a same-origin
    caller, answered by the real handler with default ports. */
async function closeOverHttp(id: string): Promise<CloseAnswer> {
  const response = await fetch(`http://127.0.0.1:${listener.port}/api/pipelines/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "close" }),
  });
  const body = await response.json() as { error?: string; close?: CloseReport };
  return { status: response.status, ...body };
}

/** The same close through the engine with an injected termination fault, for
    the cases that need one. Everything else is the default port set. */
async function closeWithTermination(
  id: string,
  termination: NonNullable<Parameters<typeof stopPipelineStageAgent>[1]>["termination"],
): Promise<CloseAnswer> {
  const stopStageAgent = (target: Parameters<typeof stopPipelineStageAgent>[0]) => stopPipelineStageAgent(target, { termination });
  const result = await patchPipeline(id, { action: "close" }, { ...defaultPipelinePorts(), stopStageAgent });
  return { status: result.status ?? 200, ...(result.error ? { error: result.error } : {}), ...(result.close ? { close: result.close as CloseReport } : {}) };
}

/* ---------- cases ---------- */

test("the caller shape is the incident's: no structured control channel in this process, a live runtime host for the generations", async () => {
  expect(runtimeHostClient()).toBeNull();
  expect(systemBootEpoch()).not.toBeNull();
  expect(await probeRuntimeSocket(runtimeSocket, { id: "alive", method: "snapshot", params: {} }, { abandon: false })).toBeTrue();
});

test("incident: a stage host re-hosted by a successor generation is ended by a close from a socketless process (#1501)", async () => {
  const current = await lane();
  const pipeline = pipelineFor(current);
  expect(current.entry()).toMatchObject({ status: "live", claimOwner: `structured-host:${JSON.stringify(current.incumbent.identity)}` });
  /* The reboot: the incumbent generation and its host are gone. Work is owed
     to the conversation, so the successor's startup adoption re-hosts it. */
  await loseIncumbent(current);
  holdWork(current);
  const next = await successor(current);
  expect(next.report.adopted.map((item) => item.key)).toEqual([sessionKeyId(current.key)]);
  const hostB = tracked.find((item) => item.pid === next.report.adopted[0]!.host.pid)!;
  expect(current.hostedBy()).toEqual(next.report.adopted[0]!.host);
  expect(current.entry()).toMatchObject({ status: "live", claimOwner: `structured-host:${JSON.stringify(next.identity)}` });
  expect(next.alive()).toBeTrue();
  const other = bystander();
  const before = structuredClone(pipelineRecord(pipeline.id).runs);

  const closed = await closeOverHttp(pipeline.id);

  expect(closed.status).toBe(200);
  const report = closed.close!;
  expect(report.stillRunning).toEqual([]);
  expect(report.stopped).toMatchObject([{ stageId: "build", attempt: 1, conversationId: current.conversationId }]);
  const notes = report.notes.map((note) => note.detail).join("\n");
  expect(notes).toContain(`pid ${hostB.pid}`);
  expect(notes).toContain(`(pid ${next.pid}) is still running`);
  await settles(() => !hostB.alive(), "host B exit");
  expect(current.entry()).toMatchObject({ status: "dead", structuredHost: null, claimOwner: null });
  /* Exactly one TERM reached the host; nothing reached the successor
     generation, the runtime host or the same-argv bystander. */
  expect(signalsTo(hostB.pid).filter((sent) => sent.signal === "SIGTERM")).toHaveLength(1);
  expect(signalsTo(next.pid)).toEqual([]);
  expect(signalsTo(runtimeHost!.pid!)).toEqual([]);
  expect(signalsTo(other.pid)).toEqual([]);
  expect(other.alive()).toBeTrue();
  expect(next.alive()).toBeTrue();
  const after = pipelineRecord(pipeline.id);
  expect(after.state).toBe("closed");
  expect(after.runs).toEqual(before);
  expect(after.runs[0]!.attempts).toHaveLength(1);
});

test("resume/park: a successor generation does not re-host a settled stage attempt on its turn claim alone, and the close then settles on evidence (#1501)", async () => {
  const current = await lane();
  const pipeline = pipelineFor(current);
  await loseIncumbent(current);

  const next = await successor(current);

  /* The row was considered — its transcript reads as an unfinished turn —
     and refused: no host was started for it, and the skipped row is demoted. */
  expect(next.report.considered).toContain(sessionKeyId(current.key));
  expect(next.report.adopted).toEqual([]);
  expect(current.entry()).toMatchObject({ status: "dead" });
  expect(current.hostedBy()).toBeNull();
  const closed = await closeOverHttp(pipeline.id);
  expect(closed.status).toBe(200);
  expect(closed.close!.alreadyStopped).toMatchObject([{ stageId: "build", attempt: 1 }]);
  expect(closed.close!.stopped).toEqual([]);
  expect(signals).toEqual([]);
  expect(pipelineRecord(pipeline.id).state).toBe("closed");
  expect(pipelineRecord(pipeline.id).runs[0]!.attempts).toHaveLength(1);
});

test("control: a stage attempt the pipeline still drives is re-hosted at startup (#1501)", async () => {
  const current = await lane();
  pipelineFor(current, { attemptState: "running" });
  await loseIncumbent(current);

  const next = await successor(current);

  expect(next.report.adopted.map((item) => item.key)).toEqual([sessionKeyId(current.key)]);
  expect(current.hostedBy()).toEqual(next.report.adopted[0]!.host);
});

test("control: a host proven dead with no successor closes through the existing fallback with no signal", async () => {
  const current = await lane();
  const pipeline = pipelineFor(current);
  await loseIncumbent(current);

  const closed = await closeOverHttp(pipeline.id);

  expect(closed.status).toBe(200);
  expect(closed.close!.alreadyStopped).toMatchObject([{ stageId: "build", attempt: 1 }]);
  expect(closed.close!.stopped).toEqual([]);
  expect(signals).toEqual([]);
  expect(pipelineRecord(pipeline.id).state).toBe("closed");
});

test("restart durability: after the close, a further generation adopts nothing and the tick restarts nothing (#1501)", async () => {
  const current = await lane();
  const pipeline = pipelineFor(current);
  await loseIncumbent(current);
  holdWork(current);
  const next = await successor(current);
  const hostB = tracked.find((item) => item.pid === next.report.adopted[0]!.host.pid)!;
  expect((await closeOverHttp(pipeline.id)).status).toBe(200);
  await settles(() => !hostB.alive(), "host B exit");
  await next.end();
  signals.length = 0;

  const later = await successor(current);

  expect(later.report.adopted).toEqual([]);
  expect(current.entry()).toMatchObject({ status: "dead", structuredHost: null });
  await tickPipelines([], defaultPipelinePorts());
  const record = pipelineRecord(pipeline.id);
  expect(record.state).toBe("closed");
  expect(record.runs[0]!.attempts).toHaveLength(1);
  expect(record.runs[0]!.attempts[0]!.state).toBe("failed");
  expect(signals).toEqual([]);
});

test("a recorded start identity that no longer matches the pid is proof of death, never a target (#1501)", async () => {
  /* The kernel handed the pid to another process: the row's start token is
     not the live one. Residency reads that as the recorded host being gone,
     so the close terminalizes on evidence and the stranger is never signalled. */
  const current = await lane();
  const pipeline = pipelineFor(current);
  const stranger = bystander();
  const claimed = current.entry()!;
  current.registry.setStructuredHostClaimed(
    current.key,
    { ...claimed.structuredHost!, process: { ...stranger.identity, startIdentity: `${stranger.pid}:not-this-start` } },
    "live",
    claimed.claimOwner!,
    claimed.claimEpoch,
  );
  await current.hostA.end();

  const closed = await closeOverHttp(pipeline.id);

  expect(closed.status).toBe(200);
  expect(closed.close!.alreadyStopped).toHaveLength(1);
  expect(signals).toEqual([]);
  expect(stranger.alive()).toBeTrue();
});

test("an identity that changes between the residency probe and the signal refuses without a signal (#1501)", async () => {
  const current = await lane();
  const pipeline = pipelineFor(current);
  let probes = 0;

  const closed = await closeWithTermination(pipeline.id, {
    /* The first read (the fence before the tree walk) still matches; every
       later read reports the pid as some other process. */
    processIdentity: (pid) => pid === current.hostA.pid && probes++ > 0 ? `${pid}:recycled` : procBackend.processIdentity(pid),
  });

  expect(closed.status).toBe(409);
  expect(closed.close?.stillRunning[0]?.error).toContain("identity changed before signalling");
  expect(signals).toEqual([]);
  expect(current.hostA.alive()).toBeTrue();
  expect(current.hostedBy()).toEqual(current.hostA.identity);
  expect(pipelineRecord(pipeline.id).state).toBe("needs_decision");
});

test("a legacy row with no start identity is unresolved: no signal, the close is refused with the reason (#1501)", async () => {
  const current = await lane();
  const pipeline = pipelineFor(current);
  const claimed = current.entry()!;
  current.registry.setStructuredHostClaimed(
    current.key,
    { ...claimed.structuredHost!, process: { pid: current.hostA.pid, startIdentity: null, bootEpoch: current.hostA.identity.bootEpoch } },
    "live",
    claimed.claimOwner!,
    claimed.claimEpoch,
  );

  const closed = await closeOverHttp(pipeline.id);

  expect(closed.status).toBe(409);
  const error = closed.close!.stillRunning[0]!.error;
  expect(error).toContain("identity is unknown");
  expect(error).toContain(`pid ${current.hostA.pid}`);
  expect(signals).toEqual([]);
  expect(current.hostA.alive()).toBeTrue();
  expect(pipelineRecord(pipeline.id)).toMatchObject({ state: "needs_decision" });
  expect(pipelineRecord(pipeline.id).runs[0]!.attempts[0]!.state).toBe("failed");
});

test("a row without a boot epoch is ambiguous evidence: no signal, unresolved (#1501)", async () => {
  const current = await lane();
  const pipeline = pipelineFor(current);
  const claimed = current.entry()!;
  current.registry.setStructuredHostClaimed(
    current.key,
    { ...claimed.structuredHost!, process: { pid: current.hostA.pid, startIdentity: current.hostA.identity.startIdentity } },
    "live",
    claimed.claimOwner!,
    claimed.claimEpoch,
  );

  const closed = await closeOverHttp(pipeline.id);

  expect(closed.status).toBe(409);
  expect(closed.close!.stillRunning[0]!.error).toContain("boot epoch is unknown");
  expect(signals).toEqual([]);
  expect(current.hostA.alive()).toBeTrue();
});

test("missing launch evidence is unresolved ownership: no launch id, or no receipt for it, and nothing is signalled (#1501)", async () => {
  const current = await lane();
  const unlaunched = pipelineFor(current, { launchId: null });
  const unreceipted = pipelineFor(current, { launchId: "launch_never_recorded" });

  const first = await closeOverHttp(unlaunched.id);
  const second = await closeOverHttp(unreceipted.id);

  expect(first.status).toBe(409);
  expect(first.close!.stillRunning[0]!.error).toContain("records no launch identity");
  expect(second.status).toBe(409);
  expect(second.close!.stillRunning[0]!.error).toContain("no launch receipt exists");
  expect(signals).toEqual([]);
  expect(current.hostA.alive()).toBeTrue();
  expect(pipelineRecord(unlaunched.id).state).toBe("needs_decision");
  expect(pipelineRecord(unreceipted.id).state).toBe("needs_decision");
});

test("a launch receipt that names another conversation is contradictory ownership: no signal (#1501)", async () => {
  const current = await lane();
  /* A second launch in the same registry, so its receipt is real. */
  const other = beginLegacySpawnFixture(current.registry, { engine: "claude", cwd: isolated, transport: "structured", accountId: null });
  if (other.kind !== "created") throw new Error("second launch was unavailable");
  const pipeline = pipelineFor(current, { launchId: other.receipt.launchId });

  const closed = await closeOverHttp(pipeline.id);

  expect(closed.status).toBe(409);
  expect(closed.close!.stillRunning[0]!.error).toContain("contradictory ownership");
  expect(signals).toEqual([]);
  expect(current.hostA.alive()).toBeTrue();
});

test("an attempt whose conversation id resolves only through its transcript is contradictory for the identity path (#1501)", async () => {
  const current = await lane();

  const result = await stopPipelineStageAgent({
    stageId: "build",
    attempt: 1,
    conversationId: "conversation_not_this_lane",
    agentPath: current.transcriptPath,
    paneId: null,
    launchId: current.launchId,
  });

  expect(result).toMatchObject({ outcome: "failed" });
  expect((result as { error: string }).error).toContain("contradictory ownership");
  expect(signals).toEqual([]);
  expect(current.hostA.alive()).toBeTrue();
});

test("partial stop: a descendant that outlives the kill keeps the attempt unresolved until it is proven gone, whatever the row says (#1501)", async () => {
  const current = await lane("tree");
  const survivor = current.descendant!;
  expect(procBackend.readPpid(survivor.pid)).toBe(current.hostA.pid);
  const pipeline = pipelineFor(current);

  /* The root takes its signal; the descendant refuses it (EPERM). */
  const refused = await closeWithTermination(pipeline.id, {
    signal: (pid, value) => {
      if (pid === survivor.pid) throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
      realKill.call(process, pid, value);
    },
    deadlineMs: 200,
    graceMs: 20,
  });

  expect(refused.status).toBe(409);
  const error = refused.close!.stillRunning[0]!.error;
  expect(error).toContain("EPERM");
  expect(error).toContain(`still running: ${survivor.pid}`);
  await settles(() => !current.hostA.alive(), "root exit");
  expect(survivor.alive()).toBeTrue();
  let record = pipelineRecord(pipeline.id);
  expect(record.state).toBe("needs_decision");
  expect(record.runs[0]!.attempts[0]!.unresolvedTermination).toMatchObject({
    survivors: [{ pid: survivor.pid, startIdentity: survivor.identity.startIdentity }],
  });

  /* The root is dead, so the row and the transcript would terminalize the
     attempt on the dead-host fallback. The recorded survivor forbids it, and
     it is not signalled again. */
  signals.length = 0;
  const again = await closeOverHttp(pipeline.id);
  expect(again.status).toBe(409);
  expect(again.close!.stillRunning[0]!.error).toContain(`pid ${survivor.pid} is still running`);
  expect(again.close!.alreadyStopped).toEqual([]);
  expect(signals).toEqual([]);
  expect(survivor.alive()).toBeTrue();
  record = pipelineRecord(pipeline.id);
  expect(record.state).toBe("needs_decision");
  expect(record.runs[0]!.attempts[0]!.unresolvedTermination).toBeDefined();

  /* Proven gone by identity: the record clears and the close settles. */
  await survivor.end();
  const settled = await closeOverHttp(pipeline.id);
  expect(settled.status).toBe(200);
  expect(settled.close!.alreadyStopped).toHaveLength(1);
  record = pipelineRecord(pipeline.id);
  expect(record.state).toBe("closed");
  expect(record.runs[0]!.attempts[0]!.unresolvedTermination).toBeUndefined();
});

test("a refused signal on the host itself is unresolved with the pid named, and a later close ends it once the fault clears (#1501)", async () => {
  const current = await lane();
  const pipeline = pipelineFor(current);

  const refused = await closeWithTermination(pipeline.id, {
    signal: () => { throw Object.assign(new Error("operation not permitted"), { code: "EPERM" }); },
    deadlineMs: 200,
    graceMs: 20,
  });

  expect(refused.status).toBe(409);
  const error = refused.close?.stillRunning[0]?.error ?? "";
  expect(error).toContain("EPERM");
  expect(error).toContain(`pid ${current.hostA.pid}`);
  expect(current.hostA.alive()).toBeTrue();
  expect(current.hostedBy()).toEqual(current.hostA.identity);
  let record = pipelineRecord(pipeline.id);
  expect(record.state).toBe("needs_decision");
  expect(record.stateDetail).toContain("EPERM");
  expect(record.runs[0]!.attempts[0]!.state).toBe("failed");
  expect(record.runs[0]!.attempts[0]!.unresolvedTermination?.survivors).toEqual([{ ...current.hostA.identity }]);

  /* The fault clears; the same close, over HTTP, now ends the host and the
     recorded survivor is proven gone by the same identity. */
  const closed = await closeOverHttp(pipeline.id);
  expect(closed.status).toBe(200);
  await settles(() => !current.hostA.alive(), "host A exit after the fault cleared");
  record = pipelineRecord(pipeline.id);
  expect(record.state).toBe("closed");
  expect(record.runs[0]!.attempts[0]!.unresolvedTermination).toBeUndefined();
});

test("a seat taken while the termination awaits the runtime is seen before the signal: refused, nothing sent (#1501)", async () => {
  const current = await lane();
  const pipeline = pipelineFor(current);

  const closed = await closeWithTermination(pipeline.id, {
    terminateOwnedHost: async () => {
      current.registry.rememberMembership(current.conversationId, {
        kind: "orchestrator",
        containerId: "seat-taken-during-await",
        role: "orchestrator",
        slot: "seat",
        stageId: null,
        stageOrder: null,
        round: null,
        parentConversationId: null,
      });
      return false;
    },
  });

  expect(closed.status).toBe(409);
  expect(closed.close!.stillRunning[0]!.error).toContain("orchestrator seat");
  expect(signals).toEqual([]);
  expect(current.hostA.alive()).toBeTrue();
  expect(pipelineRecord(pipeline.id).state).toBe("needs_decision");
});

test("a row rebound to another process while the termination awaits the runtime is seen before the signal: refused, nothing sent (#1501)", async () => {
  const current = await lane();
  const pipeline = pipelineFor(current);
  const replacement = bystander();

  const closed = await closeWithTermination(pipeline.id, {
    terminateOwnedHost: async () => {
      /* Another writer re-hosts the conversation during the await: the row
         now names a process this close was never authorized for. */
      const claimed = current.entry()!;
      current.registry.setStructuredHostClaimed(
        current.key,
        { ...claimed.structuredHost!, endpoint: `stdio:${replacement.pid}`, process: replacement.identity },
        "live",
        claimed.claimOwner!,
        claimed.claimEpoch,
      );
      return false;
    },
  });

  expect(closed.status).toBe(409);
  expect(closed.close!.stillRunning[0]!.error).toContain(`now names pid ${replacement.pid}, not pid ${current.hostA.pid}`);
  expect(signals).toEqual([]);
  expect(current.hostA.alive()).toBeTrue();
  expect(replacement.alive()).toBeTrue();
});

test("a conversation holding an orchestrator seat is revalidated at the kill and refused (#1501)", async () => {
  const current = await lane();
  const pipeline = pipelineFor(current);
  current.registry.rememberMembership(current.conversationId, {
    kind: "orchestrator",
    containerId: "seat-fixture",
    role: "orchestrator",
    slot: "seat",
    stageId: null,
    stageOrder: null,
    round: null,
    parentConversationId: null,
  });

  const closed = await closeOverHttp(pipeline.id);

  expect(closed.status).toBe(409);
  expect(closed.close!.stillRunning[0]!.error).toContain("orchestrator seat");
  expect(signals).toEqual([]);
  expect(current.hostA.alive()).toBeTrue();
});

test("two concurrent closes over HTTP signal the host exactly once (#1501)", async () => {
  const current = await lane();
  const pipeline = pipelineFor(current);

  const [first, second] = await Promise.all([closeOverHttp(pipeline.id), closeOverHttp(pipeline.id)]);

  expect(first.status).toBe(200);
  expect(second.status).toBe(200);
  await settles(() => !current.hostA.alive(), "host A exit");
  expect(signalsTo(current.hostA.pid).filter((sent) => sent.signal === "SIGTERM")).toHaveLength(1);
  const reports = [first, second].map((answer) => answer.close!);
  expect(reports.filter((report) => report.stopped.length === 1)).toHaveLength(1);
  expect(reports.filter((report) => report.alreadyStopped.length === 1)).toHaveLength(1);
  expect(pipelineRecord(pipeline.id).state).toBe("closed");
});

test("a row naming a pid in this process's own ancestry is refused without a signal (#1501)", async () => {
  const current = await lane();
  const pipeline = pipelineFor(current);
  const claimed = current.entry()!;
  current.registry.setStructuredHostClaimed(
    current.key,
    { ...claimed.structuredHost!, process: captureProcessIdentity(process.pid) },
    "live",
    claimed.claimOwner!,
    claimed.claimEpoch,
  );

  const closed = await closeOverHttp(pipeline.id);

  expect(closed.status).toBe(409);
  expect(closed.close!.stillRunning[0]!.error).toContain("own process chain");
  expect(signals).toEqual([]);
});

test("with a control channel present the runtime path answers and the identity path is never entered (#1501)", async () => {
  const current = await lane();
  let terminations = 0;

  const result = await stopPipelineStageAgent(
    { stageId: "build", attempt: 1, conversationId: current.conversationId, agentPath: current.transcriptPath, paneId: null, launchId: current.launchId },
    {
      /* A kill the runtime accepted and settled: what the Viewer process sees. */
      action: async () => ({ status: 200, body: { ok: true, structured: true, operationId: "op-1", receipt: { status: "delivered" } } }),
      termination: { signal: () => { terminations += 1; } },
    },
  );

  expect(result).toEqual({ outcome: "stopped" });
  expect(terminations).toBe(0);
  expect(signals).toEqual([]);
  expect(current.hostA.alive()).toBeTrue();
  expect(processIdentityStatus(current.hostA.identity)).toBe("alive");
});


test("authority lost after TERM retains every survivor across HTTP closes and startup (#1501)", async () => {
  const current = await lane("tree");
  const survivor = current.descendant!;
  const pipeline = pipelineFor(current);
  let seatInstalled = false;
  process.kill = ((pid: number, signal?: NodeJS.Signals) => {
    signals.push({ pid, signal });
    if (pid === survivor.pid) throw Object.assign(new Error("refused"), { code: "EPERM" });
    const result = realKill.call(process, pid, signal);
    if (signal === "SIGTERM" && Math.abs(pid) === current.hostA.pid) {
      setTimeout(() => {
        current.registry.rememberMembership(current.conversationId, {
          kind: "orchestrator", containerId: "seat-after-term", role: "orchestrator", slot: "seat",
          stageId: null, stageOrder: null, round: null, parentConversationId: null,
        });
        seatInstalled = true;
      }, 0);
    }
    return result;
  }) as typeof process.kill;
  const closed = await closeOverHttp(pipeline.id);
  expect(seatInstalled).toBeTrue();
  expect(closed.status).toBe(409);
  expect(closed.close!.stillRunning[0]!.error).toContain("orchestrator seat");
  expect(closed.close!.stillRunning[0]!.error).not.toContain("nothing was signalled");
  expect(current.hostA.alive()).toBeFalse();
  expect(survivor.alive()).toBeTrue();
  expect(pipelineRecord(pipeline.id).runs[0]!.attempts[0]!.unresolvedTermination?.survivors).toContainEqual(survivor.identity);
  signals.length = 0;
  expect((await closeOverHttp(pipeline.id)).status).toBe(409);
  expect(signals).toEqual([]);
  await current.incumbent.end();
  holdWork(current);
  const rebooted = await successor(current);
  expect(rebooted.report.adopted).toEqual([]);
  expect(rebooted.report.deferred).toContain("pipeline startup evidence is unresolved");
  expect((await closeOverHttp(pipeline.id)).status).toBe(409);
  expect(signals).toEqual([]);
});

test("successor partial stop merges an earlier generation's late survivor evidence across restart (#1501)", async () => {
  const current = await lane("tree");
  const survivorA = current.descendant!;
  const pipeline = pipelineFor(current);
  const first = await closeWithTermination(pipeline.id, {
    signal: (pid, value) => {
      if (pid === survivorA.pid) throw Object.assign(new Error("refused"), { code: "EPERM" });
      realKill.call(process, pid, value);
    }, deadlineMs: 100, graceMs: 20,
  });
  expect(first.status).toBe(409);
  const partial = pipelineRecord(pipeline.id);
  const evidenceA = partial.runs[0]!.attempts[0]!.unresolvedTermination!;
  /* Model a successor admitted before the first close publishes its survivor
     evidence: persist that earlier snapshot for the actual startup pass, then
     publish A's result before closing B. Both generations are real writers. */
  delete partial.runs[0]!.attempts[0]!.unresolvedTermination;
  savePipelines(loadPipelines().map((record) => record.id === pipeline.id ? partial : record));
  await current.incumbent.end();
  holdWork(current);
  const adopted = await successor(current);
  expect(adopted.report.adopted).toHaveLength(1);
  const hostB = adopted.report.adopted[0]!.host;
  const published = pipelineRecord(pipeline.id);
  published.runs[0]!.attempts[0]!.unresolvedTermination = evidenceA;
  savePipelines(loadPipelines().map((record) => record.id === pipeline.id ? published : record));
  const second = await closeWithTermination(pipeline.id, {
    signal: () => { throw Object.assign(new Error("refused"), { code: "EPERM" }); }, deadlineMs: 100, graceMs: 20,
  });
  expect(second.status).toBe(409);
  expect(pipelineRecord(pipeline.id).runs[0]!.attempts[0]!.unresolvedTermination?.survivors).toEqual(expect.arrayContaining([survivorA.identity, hostB]));
  const closesB = await closeOverHttp(pipeline.id);
  expect(closesB.status).toBe(409);
  expect(processIdentityStatus(hostB)).toBe("dead");
  expect(survivorA.alive()).toBeTrue();
  expect(pipelineRecord(pipeline.id).runs[0]!.attempts[0]!.unresolvedTermination?.survivors).toEqual([survivorA.identity]);
  await adopted.end();
  const rebooted = await successor(current);
  expect(rebooted.report.adopted).toEqual([]);
  expect(rebooted.report.deferred).not.toBeNull();
  signals.length = 0;
  expect((await closeOverHttp(pipeline.id)).status).toBe(409);
  expect(signals).toEqual([]);
  await survivorA.end();
  expect((await closeOverHttp(pipeline.id)).status).toBe(200);
  expect(pipelineRecord(pipeline.id).runs[0]!.attempts[0]!.unresolvedTermination).toBeUndefined();
});

test("unreadable pipeline state defers startup without demotion and a successful reread recovers (#1501)", async () => {
  const current = await lane();
  const pipeline = pipelineFor(current);
  await loseIncumbent(current);
  const before = current.entry()!;
  const database = new Database(path.join(isolatedEnvironment.LLV_STATE_DIR, "state.sqlite"));
  const row = database.query("SELECT value_json FROM state_rows WHERE collection = 'pipelines' AND row_key = ?").get(pipeline.id) as { value_json: string };
  database.query("UPDATE state_rows SET value_json = ? WHERE collection = 'pipelines' AND row_key = ?").run("{unreadable", pipeline.id);
  let blocked: Generation<AdoptReport>;
  try {
    blocked = await successor(current);
    expect(blocked.report.adopted).toEqual([]);
    expect(blocked.report.deferred).not.toBeNull();
    expect(current.entry()!.status).toBe(before.status);
    expect(current.hostedBy()).toEqual(before.structuredHost!.process);
    expect(signals).toEqual([]);
    await blocked.end();
  } finally {
    database.query("UPDATE state_rows SET value_json = ? WHERE collection = 'pipelines' AND row_key = ?").run(row.value_json, pipeline.id);
    database.close();
  }
  holdWork(current);
  const recovered = await successor(current);
  expect(recovered.report.deferred).toBeNull();
  expect(recovered.report.adopted).toHaveLength(1);
  expect((await closeOverHttp(pipeline.id)).status).toBe(200);
});


test("startup defers a running attempt with an unverifiable survivor until positive death permits reread recovery (#1501)", async () => {
  const current = await lane("tree");
  const survivor = current.descendant!;
  const pipeline = pipelineFor(current, { attemptState: "running" });
  expect((await closeWithTermination(pipeline.id, {
    signal: (pid, value) => {
      if (pid === survivor.pid) throw Object.assign(new Error("refused"), { code: "EPERM" });
      realKill.call(process, pid, value);
    }, deadlineMs: 100, graceMs: 20,
  })).status).toBe(409);
  const record = pipelineRecord(pipeline.id);
  expect(record.runs[0]!.attempts[0]!.state).toBe("running");
  record.runs[0]!.attempts[0]!.unresolvedTermination!.survivors[0]!.bootEpoch = null;
  savePipelines(loadPipelines().map((item) => item.id === pipeline.id ? record : item));
  await current.incumbent.end();
  holdWork(current);
  const blocked = await successor(current);
  expect(blocked.report.deferred).not.toBeNull();
  expect(blocked.report.adopted).toEqual([]);
  expect(survivor.alive()).toBeTrue();
  await blocked.end();
  await survivor.end();
  const recovered = await successor(current);
  expect(recovered.report.deferred).toBeNull();
  expect(recovered.report.adopted).toHaveLength(1);
  expect((await closeOverHttp(pipeline.id)).status).toBe(200);
});


test("terminal reap retains a partial tree for later ticks, HTTP close and startup (#1501)", async () => {
  const current = await lane("tree");
  const survivor = current.descendant!;
  const pipeline = pipelineFor(current);
  /* The completed turn makes this a terminal-reap candidate. */
  fs.appendFileSync(current.transcriptPath, `${JSON.stringify({ type: "assistant", timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "text", text: "finished" }], stop_reason: "end_turn" } })}\n`);
  const ports = defaultPipelinePorts();
  ports.stopStageAgent = (target) => stopPipelineStageAgent(target, { termination: {
    signal: (pid, value) => {
      if (pid === survivor.pid) throw Object.assign(new Error("refused"), { code: "EPERM" });
      realKill.call(process, pid, value);
    }, deadlineMs: 100, graceMs: 20,
  } });
  await tickPipelines([], ports);
  expect(current.hostA.alive()).toBeFalse();
  expect(survivor.alive()).toBeTrue();
  expect(pipelineRecord(pipeline.id).runs[0]!.attempts[0]!.unresolvedTermination?.survivors).toEqual([survivor.identity]);
  await tickPipelines([], defaultPipelinePorts());
  expect((await closeOverHttp(pipeline.id)).status).toBe(409);
  await current.incumbent.end();
  holdWork(current);
  const rebooted = await successor(current);
  expect(rebooted.report.adopted).toEqual([]);
  expect(rebooted.report.deferred).not.toBeNull();
  await survivor.end();
  expect((await closeOverHttp(pipeline.id)).status).toBe(200);
});
