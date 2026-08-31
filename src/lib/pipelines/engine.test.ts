import { afterAll, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";

import type { Flow } from "@/lib/flows/types";
import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";
import type { AgentRegistry as AgentRegistryType } from "@/lib/agent/registry";
import { accountManager } from "@/lib/accounts/manager";

process.env.LLV_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "llv-pipeline-engine-"));
const engineModule = await import("./engine");
const { adoptAttempt, defaultPipelinePorts, ensureTaskPipelineForAssignment, patchPipeline, pipelineAttemptTargetForSource, pipelineClaudePermissionMode, reconcileEmbeddedReviewFlows, reviewNote, tickPipelines } = engineModule;
const { AgentRegistry, setAgentRegistryForTests } = await import("@/lib/agent/registry");
const { newRound, setRelayDeliveryForTest, tickFlow } = await import("@/lib/flows/engine");
const { isRecoverableLegacyRelayFailurePause } = await import("@/lib/flows/commands");
const rawCreatePipelineFromRequest = engineModule.createPipelineFromRequest;
const createPipelineFromRequest: typeof rawCreatePipelineFromRequest = async (request, ports, options) =>
  await rawCreatePipelineFromRequest({ src: "/codex/creator.jsonl", ...request }, ports, options);
const { registerPipelineTick } = await import("./controllerSignal");
const { loadPipelines, savePipelines } = await import("./store");
const { durableStageTurnEvidence } = await import("./durableEvidence");
const { saveTasks } = await import("@/lib/tasks/store");
type PipelinePorts = import("./engine").PipelinePorts;
type PipelineStageStopResult = import("./engine").PipelineStageStopResult;
type StageTurnEvidence = import("./durableEvidence").StageTurnEvidence;

/* tickPipelines self-schedules a follow-up tick when a pass leaves a pending
   cursor; keep that wake-up away from the real default ports in this suite. */
registerPipelineTick(async () => {});

afterAll(() => fs.rmSync(process.env.LLV_STATE_DIR!, { recursive: true, force: true }));

test("default pipeline projections reuse one registry parse across the historical backlog", () => {
  const registryPath = path.join(process.env.LLV_STATE_DIR!, "projection-cache-agent-registry.json");
  const registry = new AgentRegistry(registryPath);
  setAgentRegistryForTests(registry);
  const reads = spyOn(registry, "readOnlySnapshot");
  const fileReads = spyOn(fs, "readFileSync");
  try {
    const ports = defaultPipelinePorts();
    for (let index = 0; index < 300; index += 1) {
      expect(ports.pipelineAdoptionCandidates(`historical-${index}`)).toEqual([]);
      expect(ports.spawnReceipt(`missing-${index}`)).toBeNull();
      expect(ports.pathForConversation(`conversation_${index}`)).toBeNull();
      expect(ports.getFlow(`flow-${index}`)).toBeNull();
    }
    expect(reads).toHaveBeenCalledTimes(1);
    expect(fileReads.mock.calls.filter(([filename]) =>
      filename === path.join(process.env.LLV_STATE_DIR!, "flows.json"))).toHaveLength(1);
  } finally {
    fileReads.mockRestore();
    reads.mockRestore();
    setAgentRegistryForTests(null);
  }
});

test("a pipeline stage keeps its reserved account through a routing change before settlement", async () => {
  const registry = new AgentRegistry(path.join(process.env.LLV_STATE_DIR!, "pipeline-account-pin-registry.json"));
  const cwd = process.env.LLV_STATE_DIR!;
  setAgentRegistryForTests(registry);
  const resolveSpawn = spyOn(accountManager, "resolveProjectSpawn").mockImplementation(() => ({
    kind: "available",
    account: {
      engine: "codex",
      accountId: "limited",
      kind: "managed",
      home: process.env.LLV_STATE_DIR!,
      transcriptRoot: process.env.LLV_STATE_DIR!,
      env: { NODE_ENV: "test" },
    },
  }));
  const reservations: Array<{ launchId: string; conversationId: string }> = [];
  try {
    const ports = defaultPipelinePorts();
    await expect(ports.spawnAgent({
      role: {
        roleId: "builder",
        engine: "codex",
        model: "gpt-5.6-sol",
        effort: "xhigh",
        access: "read-write",
        promptScaffold: "Builder guidance",
      },
      cwd,
      project: "repo-00000000000000000000000000000001",
      requestedAccountId: null,
      title: "Build scoped change · build",
      ["prompt"]: "Build the scoped change",
      parentPath: null,
      clientAttemptId: "pipeline_account_pin_attempt",
      membership: {
        kind: "pipeline",
        containerId: "pipeline-account-pin",
        role: "builder",
        slot: "build:1",
        stageId: "build",
        stageOrder: 0,
        round: 1,
        parentConversationId: null,
      },
      creatorConversationId: null,
    }, (created) => {
      reservations.push(created);
      registry.commitMigrationIntent({
        engine: "codex",
        targetId: "healthy",
        origin: "manual",
        requestId: "pipeline-routing-change",
        expectedRevision: registry.engineRouting("codex").revision,
      });
      throw new Error("reservation captured");
    })).rejects.toThrow("reservation captured");
    const reservation = reservations[0];
    if (!reservation) throw new Error("pipeline reservation was not captured");
    const receipt = registry.snapshot().receipts[reservation.launchId]!;
    const settled = registry.stageStructuredSpawn(receipt.launchId, {
      key: { engine: "codex", sessionId: crypto.randomUUID() },
      artifactPath: path.join(cwd, "pinned-pipeline-stage.jsonl"),
      cwd,
      accountId: "limited",
      launchProfile: receipt.launchProfile,
      status: "starting",
      host: null,
      structuredHost: null,
      claimEpoch: 0,
      claimOwner: null,
      pendingAction: "spawn",
    });
    if (settled.kind !== "settled") throw new Error("pipeline settlement conflicted");

    expect(settled.receipt).toMatchObject({
      accountId: "limited",
      accountPin: true,
      launchProfile: expect.objectContaining({ title: "Build scoped change · build" }),
    });
    expect(settled.conversation).toMatchObject({ pinnedAccountId: "limited", migration: null });
  } finally {
    resolveSpawn.mockRestore();
    setAgentRegistryForTests(null);
  }
});

test("a concurrent pipeline replay and its recovery projections withhold staged identity (#1123)", async () => {
  const registry = new AgentRegistry(path.join(process.env.LLV_STATE_DIR!, "pipeline-phantom-replay-registry.json"));
  const cwd = process.env.LLV_STATE_DIR!;
  const previousCodexBinary = process.env.LLV_CODEX_BINARY;
  const codexBinary = path.join(cwd, "codex-mcp-fixture");
  fs.writeFileSync(codexBinary, "#!/bin/sh\nprintf '[{\"name\":\"viewer\"}]'\n");
  fs.chmodSync(codexBinary, 0o755);
  process.env.LLV_CODEX_BINARY = codexBinary;
  setAgentRegistryForTests(registry);
  const resolveSpawn = spyOn(accountManager, "resolveSpawn").mockImplementation(() => ({
    engine: "codex",
    accountId: "pipeline-account",
    kind: "managed",
    home: cwd,
    transcriptRoot: cwd,
    env: { NODE_ENV: "test" },
  }));
  const input: Parameters<PipelinePorts["spawnAgent"]>[0] = {
    role: {
      roleId: "builder",
      engine: "codex" as const,
      model: "gpt-5.6-sol",
      effort: "xhigh",
      access: "read-write" as const,
      promptScaffold: "Builder guidance",
    },
    cwd,
    project: "repo-00000000000000000000000000000001",
    requestedAccountId: null,
    title: "Build scoped change",
    "prompt": "Build the scoped change",
    parentPath: null,
    clientAttemptId: "pipeline_phantom_replay_attempt",
    membership: {
      kind: "pipeline" as const,
      containerId: "pipeline-phantom-replay",
      role: "builder",
      slot: "build:1",
      stageId: "build",
      stageOrder: 0,
      round: 1,
      parentConversationId: null,
    },
    creatorConversationId: null,
  };
  const reservations: Array<{ launchId: string; conversationId: string }> = [];

  try {
    const ports = defaultPipelinePorts();
    await expect(ports.spawnAgent(input, (created) => {
      reservations.push(created);
      throw new Error("reservation captured");
    })).rejects.toThrow("reservation captured");
    const reservation = reservations[0];
    if (!reservation) throw new Error("pipeline reservation was not captured");
    const receipt = registry.snapshot().receipts[reservation.launchId]!;
    const stagedPath = path.join(cwd, "provisional-stage.jsonl");
    registry.stageStructuredSpawn(receipt.launchId, {
      key: { engine: "codex", sessionId: "provisional-session" },
      artifactPath: stagedPath,
      cwd,
      accountId: "pipeline-account",
      launchProfile: receipt.launchProfile,
      status: "idle",
      host: null,
      structuredHost: {
        kind: "codex-app-server",
        endpoint: "stdio:provisional-session",
        process: { pid: process.pid, startIdentity: "provisional-session-host" },
        eventCursor: 0,
        protocolVersion: null,
        writerClaimEpoch: 1,
        activeTurnRef: null,
        pendingAttention: [],
        activeFlags: [],
      },
      claimEpoch: 1,
      claimOwner: "structured-host:provisional-session-host",
      pendingAction: "spawn",
    });
    const parent = registry.ensureConversation("codex", path.join(cwd, "parent.jsonl"), "pipeline-account");
    registry.rememberMembership(receipt.conversationId, {
      kind: "pipeline",
      containerId: "pipeline-phantom-replay",
      role: "builder",
      slot: "adopt:build:1",
      stageId: "build",
      stageOrder: 0,
      round: 1,
      parentConversationId: parent.id,
    });

    const replay = await ports.spawnAgent(input, () => {});
    expect(replay).toMatchObject({
      launchId: receipt.launchId,
      conversationId: receipt.conversationId,
      sessionId: null,
      "transcript": null,
    });
    expect(ports.spawnReceipt(receipt.launchId)).toMatchObject({
      sessionId: null,
      "transcript": null,
    });
    expect(ports.pathForConversation(receipt.conversationId)).toBeNull();
    expect(ports.conversationIdForPath(stagedPath)).toBeNull();
    expect(ports.pipelineAdoptionCandidates("pipeline-phantom-replay")).toEqual([]);

    registry.finalizeStructuredSpawn(receipt.launchId);
    const completedPorts = defaultPipelinePorts();
    expect(completedPorts.spawnReceipt(receipt.launchId)).toMatchObject({
      sessionId: "provisional-session",
      "transcript": stagedPath,
    });
    expect(completedPorts.pathForConversation(receipt.conversationId)).toBe(stagedPath);
    expect(completedPorts.conversationIdForPath(stagedPath)).toBe(receipt.conversationId);
    expect(completedPorts.pipelineAdoptionCandidates("pipeline-phantom-replay")).toEqual([
      expect.objectContaining({
        sessionId: "provisional-session",
        agentPath: stagedPath,
      }),
    ]);
  } finally {
    if (previousCodexBinary === undefined) delete process.env.LLV_CODEX_BINARY;
    else process.env.LLV_CODEX_BINARY = previousCodexBinary;
    resolveSpawn.mockRestore();
    setAgentRegistryForTests(null);
  }
});

test("a staged resume cannot hide its already-published transcript (#1123)", () => {
  const registry = new AgentRegistry(path.join(process.env.LLV_STATE_DIR!, "pipeline-staged-resume-registry.json"));
  const cwd = process.env.LLV_STATE_DIR!;
  const sessionId = crypto.randomUUID();
  const transcript = path.join(cwd, `${sessionId}.jsonl`);
  fs.writeFileSync(transcript, `${JSON.stringify({ type: "session_meta", payload: { id: sessionId } })}\n`);
  const conversation = registry.ensureConversation("codex", transcript, "pipeline-account");
  setAgentRegistryForTests(registry);

  try {
    const begun = registry.beginSpawnRequest({
      engine: "codex",
      cwd,
      transport: "structured",
      accountId: "pipeline-account",
      conversationId: conversation.id,
      purpose: "resume-successor",
      launchProfile: { title: "Resume published session" },
    });
    if (begun.kind !== "created") throw new Error("resume receipt was unavailable");
    const staged = registry.stageStructuredSpawn(begun.receipt.launchId, {
      key: { engine: "codex", sessionId },
      artifactPath: transcript,
      cwd,
      accountId: "pipeline-account",
      launchProfile: begun.receipt.launchProfile,
      status: "idle",
      host: null,
      structuredHost: {
        kind: "codex-app-server",
        endpoint: `stdio:${sessionId}`,
        process: { pid: process.pid, startIdentity: "staged-resume-host" },
        eventCursor: 0,
        protocolVersion: null,
        writerClaimEpoch: 1,
        activeTurnRef: null,
        pendingAttention: [],
        activeFlags: [],
      },
      claimEpoch: 1,
      claimOwner: "structured-host:staged-resume-host",
      pendingAction: "spawn",
    });
    if (staged.kind !== "settled") throw new Error("resume staging conflicted");

    const ports = defaultPipelinePorts();
    expect(ports.spawnReceipt(begun.receipt.launchId)).toMatchObject({
      sessionId: null,
      "transcript": null,
    });
    expect(ports.pathForConversation(conversation.id)).toBe(transcript);
    expect(ports.conversationIdForPath(transcript)).toBe(conversation.id);
  } finally {
    setAgentRegistryForTests(null);
  }
});

const RUN_STAGES = [
  { id: "plan", kind: "run", role: { roleId: "architect" }, access: "read-only", prompt: "Plan {{task}}", next: "build" },
  { id: "build", kind: "run", role: { roleId: "builder" }, engine: "codex", access: "read-write", prompt: "Build from {{prev.output}}", next: null },
] as const;
const ORIGIN_MAIN_SHA = "48c739bbcc87b3244aee7fb0e2d1b3f8e312548f";

test("Claude pipeline roles keep autonomous tool access under read-only scope fences", () => {
  expect(pipelineClaudePermissionMode({
    roleId: "architect",
    engine: "claude",
    model: "fable",
    effort: "high",
    access: "read-only",
    promptScaffold: "Read-only architecture contract",
  })).toBe("bypassPermissions");
  expect(pipelineClaudePermissionMode({
    roleId: "builder",
    engine: "claude",
    model: "fable",
    effort: "high",
    access: "read-write",
    promptScaffold: "Builder contract",
  })).toBe("bypassPermissions");
  expect(pipelineClaudePermissionMode({
    roleId: "reviewer",
    engine: "codex",
    model: "gpt-5.6-sol",
    effort: "xhigh",
    access: "read-only",
    promptScaffold: "Reviewer contract",
  })).toBeNull();
});

function entry(pathname: string): FileEntry {
  return {
    path: pathname, root: "codex-sessions", name: path.basename(pathname), project: "viewer", title: "stage", engine: "codex",
    kind: "session", fmt: "codex", parent: null, mtime: 2_000, size: 10, activity: "idle", proc: null, pid: null,
    model: null, pendingQuestion: null, waitingInput: null,
  };
}

function harness() {
  const calls: string[] = [];
  const spawnRoles: Array<Parameters<PipelinePorts["spawnAgent"]>[0]["role"]> = [];
  const spawnTitles: string[] = [];
  const messages = new Map<string, { text: string; ts: number }>();
  const durableTurns = new Map<string, StageTurnEvidence>();
  const flows = new Map<string, Flow>();
  let spawn = 0;
  let clock = 1_000_000;
  let builderEffort = "medium";
  let paneAlive = true;
  let conversationActive: boolean | null = null;
  /* Stage hosts are "not running" unless a test seats one; nothing in this
     suite may reach a real host or the operator's registry. */
  const stageHosts = new Map<string, PipelineStageStopResult>();
  /* Panes the harness considers killable, and the clock the teardown budget
     reads. Both default to the benign case so existing tests are unaffected. */
  const killedPanes: string[] = [];
  let paneStop: Awaited<ReturnType<PipelinePorts["stopStagePane"]>> = { outcome: "stopped" };
  let worktreePresent = true;
  let residentHosts = false;
  let monotonic: () => number = () => Date.now();
  const ports: PipelinePorts = {
    exec: (rawCommand, rawArgs) => {
      calls.push(`${rawCommand} ${rawArgs.join(" ")}`);
      const args = rawCommand === "timeout" ? rawArgs.slice(rawArgs.indexOf("git") + 1) : rawArgs;
      if (args[0] === "rev-parse" && args[1] === "--git-dir") return { code: 0, stdout: ".git\n", stderr: "" };
      if (args[0] === "rev-parse" && args[1] === "--verify") return { code: 0, stdout: `${ORIGIN_MAIN_SHA}\n`, stderr: "" };
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return { code: 0, stdout: "main\n", stderr: "" };
      if (args[0] === "branch" && args[1] === "--show-current") return { code: 0, stdout: `${loadPipelines()[0]?.branch ?? ""}\n`, stderr: "" };
      /* Review ingress requires a publishable remote, so the default repo has
         one. A test that needs the no-origin case overrides this. */
      if (args[0] === "remote" && args[1] === "get-url") return { code: 0, stdout: "git@example.invalid:owner/repo.git\n", stderr: "" };
      if (args[0] === "ls-remote") {
        const branch = loadPipelines()[0]?.branch ?? "pipeline/test";
        return { code: 0, stdout: `${ORIGIN_MAIN_SHA}\trefs/heads/${branch}\n`, stderr: "" };
      }
      if (args[0] === "rev-parse") return { code: 0, stdout: `${ORIGIN_MAIN_SHA}\n`, stderr: "" };
      if (args[0] === "status") return { code: 0, stdout: "", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
    preflightRepo: (repoDir) => ({
      ok: true,
      repoDir,
      gitCommonDir: path.join(repoDir, ".git"),
      worktreeParent: path.dirname(repoDir),
    }),
    roleLookup: (roleId) => {
      if (roleId === "builder") return { engine: "codex", model: "gpt-5.6-sol", effort: builderEffort, access: "read-write", promptScaffold: "Builder guidance" };
      if (roleId === "reviewer") return { engine: "codex", model: "gpt-5.6-sol", effort: "xhigh", access: "read-only", promptScaffold: "Reviewer guidance" };
      if (roleId === "architect") return { engine: "claude", model: "fable", effort: "high", access: "read-only", promptScaffold: "Architect guidance" };
      return null;
    },
    spawnReceipt: () => null,
    claimSpawnRetry: () => "claimed",
    spawnAgent: async ({ role, title, parentPath, clientAttemptId, membership, supersedes }, onReserved) => {
      spawn += 1;
      spawnRoles.push(structuredClone(role));
      spawnTitles.push(title);
      calls.push(`spawn:${clientAttemptId}:parent=${parentPath ?? "root"}:supersedes=${supersedes ?? "none"}`);
      calls.push(`membership:${membership.kind}:${membership.containerId}:${membership.slot}:${membership.role}:${membership.stageOrder}:round=${membership.round}`);
      onReserved({ launchId: `launch-${spawn}`, conversationId: `conversation_stage_${spawn}` });
      return { launchId: `launch-${spawn}`, conversationId: `conversation_stage_${spawn}`, sessionId: `session-${spawn}`, transcript: `/codex/stage-${spawn}.jsonl`, paneId: `%${spawn}` };
    },
    paneAgentAlive: async () => paneAlive,
    stopStageAgent: async (target) => {
      calls.push(`stop-host:${target.stageId}:${target.attempt}:${target.conversationId ?? "none"}`);
      return stageHosts.get(target.conversationId ?? "") ?? { outcome: "not-running" };
    },
    stopStagePane: async (target) => {
      calls.push(`stop-pane:${target.stageId}:${target.attempt}:${target.paneId ?? "none"}`);
      if (paneStop.outcome === "stopped" && target.paneId) {
        killedPanes.push(target.paneId);
        paneAlive = false;
      }
      return paneStop;
    },
    stageHostResident: async (target) => {
      calls.push(`host-resident:${target.stageId}:${target.attempt}`);
      return residentHosts;
    },
    monotonicNow: () => monotonic(),
    worktreePresent: () => worktreePresent,
    conversationAgentActive: async () => conversationActive,
    durableTurnEvidence: async (_engine, transcriptPath) => durableTurns.get(transcriptPath) ?? null,
    headCwd: () => loadPipelines()[0]?.worktreeDir ?? null,
    lastMessage: (item) => messages.get(item.path) ?? null,
    pathForConversation: (id) => id === "conversation_stage_1" ? "/codex/stage-1.jsonl" : id === "conversation_stage_2" ? "/codex/stage-2.jsonl" : null,
    sourcePathAllowed: (pathname) => pathname.startsWith("/codex/") && pathname.endsWith(".jsonl"),
    conversationIdForPath: (pathname) => pathname === "/codex/creator.jsonl"
      ? "conversation_creator"
      : pathname.includes("stage-1") ? "conversation_stage_1" : pathname.includes("stage-2") ? "conversation_stage_2" : null,
    pipelineAdoptionCandidates: () => [],
    createFlow: async (req) => {
      calls.push(`flow:${req.implementerPath}:${req.baseRef}:${req.targetSha}:${req.spec}`);
      const flow = { id: `flow-${flows.size + 1}`, implementerPath: req.implementerPath, baseRef: req.baseRef, headRef: req.headRef, targetSha: req.targetSha, state: "waiting_ready", rounds: [], createdAt: new Date(clock).toISOString(), closedAt: null } as unknown as Flow;
      flows.set(flow.id, flow);
      return { flow };
    },
    patchFlow: (id, action, note) => {
      calls.push(`flow-patch:${id}:${action}`);
      if (note) calls.push(`flow-note:${note}`);
      const flow = flows.get(id);
      if (flow && action === "resume" && flow.state === "paused") {
        const round = flow.rounds.at(-1);
        if (round && isRecoverableLegacyRelayFailurePause(flow)) {
          round.relayStartedAt = null;
          round.relayDeliveryTransport = null;
          round.relayRetryAt = null;
          round.relayRetryRequiresIdempotency = false;
        }
        flow.state = flow.pausedState && flow.pausedState !== "paused" ? flow.pausedState : "waiting_ready";
        flow.pausedState = null;
        flow.stateDetail = null;
      }
      return {};
    },
    closeFlow: async (id) => {
      calls.push(`flow-close:${id}`);
      const flow = flows.get(id);
      if (flow) flow.state = "closed";
      return { flow };
    },
    getFlow: (id) => flows.get(id) ?? null,
    findFlow: () => null,
    projectForCwd: () => "viewer",
    now: () => new Date((clock += 1_000)).toISOString(),
  };
  const finish = (pathname: string, status: "pass" | "fail" | "needs_decision", output = "done") => {
    messages.set(pathname, { text: `${output}\n\n\`\`\`json\n${JSON.stringify({ status })}\n\`\`\``, ts: clock + 100_000 });
    return entry(pathname);
  };
  return {
    ports,
    calls,
    messages,
    durableTurns,
    flows,
    spawnRoles,
    spawnTitles,
    finish,
    setBuilderEffort: (effort: string) => { builderEffort = effort; },
    setPaneAlive: (alive: boolean) => { paneAlive = alive; },
    setStageHost: (conversationId: string, result: PipelineStageStopResult) => { stageHosts.set(conversationId, result); },
    setPaneStop: (result: Awaited<ReturnType<PipelinePorts["stopStagePane"]>>) => { paneStop = result; },
    setWorktreePresent: (present: boolean) => { worktreePresent = present; },
    setHostsResident: (resident: boolean) => { residentHosts = resident; },
    setMonotonicClock: (clock: () => number) => { monotonic = clock; },
    advanceWallClock: (milliseconds: number) => { clock += milliseconds; },
    killedPanes,
    setConversationActive: (active: boolean | null) => { conversationActive = active; },
  };
}

async function create(ports: PipelinePorts, stages = RUN_STAGES as never) {
  savePipelines([]);
  const result = await createPipelineFromRequest({ task: "Ship pipelines", spec: "AC1", repoDir: "/repo", stages, src: "/codex/creator.jsonl" }, ports);
  if (!result.pipeline) throw new Error(result.error);
  return result.pipeline;
}

async function exhaustVerdictRecovery(h: ReturnType<typeof harness>, entries: FileEntry[] = []): Promise<void> {
  h.advanceWallClock(30_000);
  await tickPipelines(entries, h.ports);
  h.advanceWallClock(30_000);
  await tickPipelines(entries, h.ports);
}

test("pause and resume state details name the operator or calling agent (#1121)", async () => {
  const h = harness();
  const pipeline = await create(h.ports);

  const operatorPause = await patchPipeline(pipeline.id, { action: "pause" }, h.ports);
  expect(operatorPause.pipeline).toMatchObject({ state: "paused", stateDetail: "paused by operator" });
  const operatorResume = await patchPipeline(pipeline.id, { action: "resume" }, h.ports);
  expect(operatorResume.pipeline).toMatchObject({ state: "provisioning", stateDetail: "resumed by operator" });

  const agent = { kind: "agent" as const, role: "orchestrator", conversationId: "conversation_orchestrator" };
  const agentPause = await patchPipeline(pipeline.id, { action: "pause" }, h.ports, agent);
  expect(agentPause.pipeline).toMatchObject({
    state: "paused",
    stateDetail: "paused by orchestrator conversation_orchestrator",
  });
  const agentResume = await patchPipeline(pipeline.id, { action: "resume" }, h.ports, agent);
  expect(agentResume.pipeline).toMatchObject({
    state: "provisioning",
    stateDetail: "resumed by orchestrator conversation_orchestrator",
  });
});

async function withRuntimeSnapshot(
  snapshot: Record<string, unknown> | ((requestNumber: number) => Record<string, unknown>),
  run: () => Promise<void>,
): Promise<void> {
  const socketPath = path.join(process.env.LLV_STATE_DIR!, `runtime-${crypto.randomUUID()}.sock`);
  let requestNumber = 0;
  const server = net.createServer((socket) => {
    let frame = "";
    socket.on("data", (chunk) => {
      frame += String(chunk);
      const newline = frame.indexOf("\n");
      if (newline < 0) return;
      const request = JSON.parse(frame.slice(0, newline)) as { id: string };
      const result = typeof snapshot === "function" ? snapshot(requestNumber++) : snapshot;
      socket.end(`${JSON.stringify({ id: request.id, ok: true, result })}\n`);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const priorSocket = process.env.LLV_RUNTIME_HOST_SOCKET;
  process.env.LLV_RUNTIME_HOST_SOCKET = socketPath;
  try {
    await run();
  } finally {
    if (priorSocket === undefined) delete process.env.LLV_RUNTIME_HOST_SOCKET;
    else process.env.LLV_RUNTIME_HOST_SOCKET = priorSocket;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function boardTask(id: string, project = "viewer"): BoardTask {
  return {
    id,
    project,
    status: "inbox",
    text: `Task ${id}`,
    placement: "unplaced",
    assignments: [],
    createdAt: "2026-07-19T00:00:00.000Z",
    updatedAt: "2026-07-19T00:00:00.000Z",
  };
}

test("new pipelines require an allowed creator transcript with an existing conversation", async () => {
  const h = harness();
  savePipelines([]);

  const missing = await rawCreatePipelineFromRequest({
    task: "Missing creator",
    repoDir: "/repo",
    autoStart: false,
    stages: [],
  }, h.ports);
  expect(missing).toMatchObject({
    error: "pipeline creator lineage is required; pass src",
    status: 400,
    violations: [{ field: "src", message: "pipeline creator lineage is required; pass src" }],
  });

  const invalidPath = await createPipelineFromRequest({
    task: "Invalid creator",
    repoDir: "/repo",
    src: "/outside/creator.jsonl",
    autoStart: false,
    stages: [],
  }, h.ports);
  /* #1026: the rejection names the roots that ARE accepted, so a caller holding
     a native Claude path is not left guessing which address the viewer records. */
  expect(invalidPath.status).toBe(400);
  expect(invalidPath.error).toStartWith("src path is not an allowed conversation transcript.");
  expect(invalidPath.error).toContain("shared/claude/projects");
  expect(invalidPath.error).toContain("~/.codex/sessions");
  expect(invalidPath.violations).toEqual([expect.objectContaining({ field: "src" })]);

  const unknownConversation = await createPipelineFromRequest({
    task: "Unknown creator",
    repoDir: "/repo",
    src: "/codex/unknown.jsonl",
    autoStart: false,
    stages: [],
  }, h.ports);
  expect(unknownConversation.status).toBe(400);
  expect(unknownConversation.error).toStartWith("src conversation does not exist.");
  expect(unknownConversation.error).toContain("~/.claude/projects");

  const created = await createPipelineFromRequest({
    task: "Known creator",
    repoDir: "/repo",
    src: "/codex/creator.jsonl",
    autoStart: false,
    stages: [],
  }, h.ports);
  expect(created.pipeline).toMatchObject({
    srcPath: "/codex/creator.jsonl",
    srcConversationId: "conversation_creator",
  });
});

/* #1026 — a Claude-engine caller knows its own native ~/.claude/projects path;
   every viewer record addresses the shared transcript store the home's projects
   dir links into. The two name one file, so the native address resolves — but
   only when that file really is mirrored, since inventing a shared path would
   mint a phantom conversation identity. */
test("a native Claude src path resolves through its shared-store mirror, and says so when there is none", async () => {
  const h = harness();
  savePipelines([]);
  const claudeHome = path.join(process.env.LLV_STATE_DIR!, "native-claude-home");
  const encoded = "-home-agent-repo";
  const mirrored = path.join(path.dirname(process.env.LLV_STATE_DIR!), "shared", "claude", "projects", encoded, "creator.jsonl");
  fs.mkdirSync(path.dirname(mirrored), { recursive: true });
  fs.writeFileSync(mirrored, "{}\n");
  const native = path.join(claudeHome, "projects", encoded, "creator.jsonl");
  const unmirrored = path.join(claudeHome, "projects", encoded, "stranger.jsonl");
  const ports: PipelinePorts = {
    ...h.ports,
    sourcePathAllowed: (pathname) => pathname === mirrored,
    conversationIdForPath: (pathname) => (pathname === mirrored ? "conversation_creator" : null),
  };
  const previousHome = process.env.LLV_CLAUDE_HOME;
  process.env.LLV_CLAUDE_HOME = claudeHome;
  try {
    const normalizedSrc = await rawCreatePipelineFromRequest({
      task: "Native creator path",
      repoDir: "/repo",
      autoStart: false,
      stages: [],
      src: native,
    }, ports);
    expect(normalizedSrc.pipeline).toMatchObject({ srcPath: mirrored, srcConversationId: "conversation_creator" });

    const nothingMirrored = await rawCreatePipelineFromRequest({
      task: "Native creator path without a mirror",
      repoDir: "/repo",
      autoStart: false,
      stages: [],
      src: unmirrored,
    }, ports);
    expect(nothingMirrored.pipeline).toBeUndefined();
    expect(nothingMirrored.status).toBe(400);
    expect(nothingMirrored.error).toContain("shared/claude/projects");
    expect(nothingMirrored.error).toContain("~/.codex/sessions");
  } finally {
    if (previousHome === undefined) delete process.env.LLV_CLAUDE_HOME; else process.env.LLV_CLAUDE_HOME = previousHome;
  }
});

/* #1026 — the reported walk cost seven calls because each answer carried one
   constraint. Every constraint the request violates is now collected in one
   response, each naming its field and the shape that field expects. */
test("an invalid create answers with every violated constraint at once", async () => {
  const h = harness();
  savePipelines([]);
  const rejected = await createPipelineFromRequest({
    task: "Batched validation",
    repoDir: "/repo",
    autoStart: false,
    baseBranch: "main",
    stages: [
      { id: "not a url safe id", kind: "implement", prompt: "build", role: "builder" },
      { id: "review", kind: "review-loop", prompt: "", role: { roleId: "reviewer", engine: "codex" } },
    ],
  } as never, h.ports);

  expect(rejected.pipeline).toBeUndefined();
  expect(rejected.status).toBe(400);
  expect(rejected.violations?.map((violation) => violation.field)).toEqual([
    "stages[0].id",
    "stages[0].kind",
    "stages[0].role",
    "stages[1].prompt",
    "stages[1].role",
    "baseRef",
  ]);
  for (const violation of rejected.violations ?? []) expect(violation.expected).not.toBe("");
  /* One response, and it reads as one: the count, then field, message and
     expected shape for each violated constraint. */
  expect(rejected.error).toStartWith("6 validation errors — ");
  expect(rejected.error).toContain('stages[0].kind: stage kind must be run or review-loop (expected "run" | "review-loop")');
  expect(rejected.error).toContain("place runtime overrides on the stage");
  expect(rejected.error).toContain("baseRef: a draft baseBranch requires an explicit baseRef");
  expect(loadPipelines()).toEqual([]);
});

/* #1026 ask 3 — "review-loop stage requires a preceding run stage" read as an
   ordering rule and sent the caller reordering an array that was already in the
   right order. The defect is the missing pass edge. */
test("an unreachable review-loop names the stage and the next edge that would reach it", async () => {
  const h = harness();
  savePipelines([]);
  const rejected = await createPipelineFromRequest({
    task: "Unwired review loop",
    repoDir: "/repo",
    autoStart: false,
    stages: [
      { id: "build", kind: "run", role: { roleId: "builder" }, prompt: "build", next: null },
      { id: "review", kind: "review-loop", role: { roleId: "reviewer" }, prompt: "review", next: null },
    ],
  }, h.ports);

  expect(rejected.pipeline).toBeUndefined();
  expect(rejected.error).toBe('review-loop stage review is unreachable: no run stage\'s next chain reaches it — set next: "review" on run stage build');
  expect(rejected.violations).toEqual([expect.objectContaining({ field: "stages[].next" })]);
  expect(rejected.error).not.toContain("requires a preceding run stage");
});

test("set-src repairs closed history and requires overwrite for existing lineage", async () => {
  const h = harness();
  const pipeline = await create(h.ports);
  pipeline.srcPath = null;
  pipeline.srcConversationId = null;
  pipeline.state = "closed";
  pipeline.cursor = null;
  pipeline.closedAt = h.ports.now();
  savePipelines([pipeline]);

  const invalid = await patchPipeline(pipeline.id, {
    action: "set-src",
    srcPath: "/outside/creator.jsonl",
  } as never, h.ports);
  expect(invalid.status).toBe(400);
  expect(invalid.error).toStartWith("src path is not an allowed conversation transcript.");

  const repaired = await patchPipeline(pipeline.id, {
    action: "set-src",
    srcPath: "/codex/creator.jsonl",
  } as never, h.ports);
  expect(repaired.pipeline).toMatchObject({
    state: "closed",
    srcPath: "/codex/creator.jsonl",
    srcConversationId: "conversation_creator",
  });
  const repeated = await patchPipeline(pipeline.id, {
    action: "set-src",
    srcPath: "/codex/creator.jsonl",
  }, h.ports);
  expect(repeated.pipeline).toMatchObject({
    srcPath: "/codex/creator.jsonl",
    srcConversationId: "conversation_creator",
  });

  const blocked = await patchPipeline(pipeline.id, {
    action: "set-src",
    srcPath: "/codex/stage-1.jsonl",
  } as never, h.ports);
  expect(blocked).toEqual({ error: "pipeline creator lineage already exists; pass overwrite: true to replace it", status: 409 });

  const overwritten = await patchPipeline(pipeline.id, {
    action: "set-src",
    srcPath: "/codex/stage-1.jsonl",
    overwrite: true,
  } as never, h.ports);
  expect(overwritten.pipeline).toMatchObject({
    state: "closed",
    srcPath: "/codex/stage-1.jsonl",
    srcConversationId: "conversation_stage_1",
  });
});

test("link-task is idempotent for an existing task in the pipeline project", async () => {
  const h = harness();
  const task = boardTask("task-link-1");
  saveTasks([task]);
  const pipeline = await create(h.ports);

  const first = await patchPipeline(pipeline.id, { action: "link-task", taskId: task.id }, h.ports);
  const duplicate = await patchPipeline(pipeline.id, { action: "link-task", taskId: task.id }, h.ports);

  expect(first.pipeline?.taskIds).toEqual([task.id]);
  expect(duplicate.pipeline?.taskIds).toEqual([task.id]);
  expect(loadPipelines()[0]!.taskIds).toEqual([task.id]);
});

test("task links reject project mismatches without persisting a change", async () => {
  const h = harness();
  const foreignTask = boardTask("task-foreign", "other-project");
  saveTasks([foreignTask]);
  const pipeline = await create(h.ports);

  const result = await patchPipeline(pipeline.id, { action: "link-task", taskId: foreignTask.id }, h.ports);

  expect(result).toEqual({ error: `task project does not match pipeline project: ${foreignTask.id}`, status: 400 });
  expect(loadPipelines()[0]!.taskIds).toEqual([]);
});

test("a linked draft cannot move to a different task project", async () => {
  const h = harness();
  const task = boardTask("task-repo-move");
  saveTasks([task]);
  savePipelines([]);
  h.ports.projectForCwd = (cwd) => cwd === "/other" ? "other-project" : "viewer";
  const created = await createPipelineFromRequest({
    task: "Linked draft",
    taskIds: [task.id],
    repoDir: "/repo",
    autoStart: false,
    stages: [{ id: "run", kind: "run", role: { roleId: "builder" }, engine: "codex", prompt: "run", next: null }],
  }, h.ports);

  const moved = await patchPipeline(created.pipeline!.id, { action: "update-draft", repoDir: "/other" }, h.ports);

  expect(moved).toEqual({ error: `task project does not match pipeline project: ${task.id}`, status: 400 });
  expect(loadPipelines()[0]).toMatchObject({ repoDir: "/repo", project: "viewer", taskIds: [task.id] });
});

test("a deleted task stays linked until unlink-task removes its stale id", async () => {
  const h = harness();
  const task = boardTask("task-stale");
  saveTasks([task]);
  const pipeline = await create(h.ports);
  await patchPipeline(pipeline.id, { action: "link-task", taskId: task.id }, h.ports);
  saveTasks([]);

  expect(loadPipelines()[0]!.taskIds).toEqual([task.id]);
  const result = await patchPipeline(pipeline.id, { action: "unlink-task", taskId: task.id }, h.ports);

  expect(result.pipeline?.taskIds).toEqual([]);
  expect(loadPipelines()[0]!.taskIds).toEqual([]);
});

test("pipeline creation validates and persists explicit taskIds atomically", async () => {
  const h = harness();
  const task = boardTask("task-create");
  saveTasks([task]);
  savePipelines([]);

  const created = await createPipelineFromRequest({
    task: "Bound pipeline",
    taskIds: [task.id, task.id],
    repoDir: "/repo",
    stages: RUN_STAGES as never,
  }, h.ports);

  expect(created.pipeline?.taskIds).toEqual([task.id]);
  expect(loadPipelines()[0]!.taskIds).toEqual([task.id]);

  savePipelines([]);
  const missing = await createPipelineFromRequest({
    task: "Missing task",
    taskIds: ["task-missing"],
    repoDir: "/repo",
    stages: RUN_STAGES as never,
  }, h.ports);
  expect(missing).toEqual({ error: "task not found: task-missing", status: 400 });
  expect(loadPipelines()).toEqual([]);
});

test("auto-create rechecks task links inside the pipeline mutation", async () => {
  const h = harness();
  const task = boardTask("task-race");
  saveTasks([task]);
  savePipelines([]);

  const [explicit, automatic] = await Promise.all([
    createPipelineFromRequest({
      task: "Explicit owner",
      taskIds: [task.id],
      repoDir: "/repo",
      autoStart: false,
      stages: [{ id: "run", kind: "run", role: { roleId: "builder" }, engine: "codex", prompt: "run", next: null }],
    }, h.ports),
    ensureTaskPipelineForAssignment(task, {
      repoDir: "/repo",
      engine: "codex",
      model: "gpt-5.6-sol",
      effort: "high",
      launchId: "launch-task-race",
      conversationId: "conversation_creator",
      srcPath: "/codex/creator.jsonl",
    }, h.ports),
  ]);

  expect(explicit.pipeline).toBeDefined();
  expect(automatic.pipeline?.id).toBe(explicit.pipeline?.id);
  expect(loadPipelines()).toHaveLength(1);
  expect(loadPipelines()[0]!.taskIds).toEqual([task.id]);
});

test("task spawn reserves one launch-correlated pipeline and reconciles its creator path", async () => {
  const h = harness();
  const task = boardTask("task-intent");
  saveTasks([task]);
  savePipelines([]);
  const pending = {
    repoDir: "/repo",
    engine: "codex" as const,
    model: "gpt-5.6-sol",
    effort: "high",
    launchId: "launch-task-intent",
    conversationId: "conversation_stage_1",
    srcPath: null,
  };

  const reserved = await ensureTaskPipelineForAssignment(task, pending, h.ports);
  expect(reserved.pipeline).toMatchObject({
    taskIds: [task.id],
    creationIntent: { kind: "task-spawn", taskId: task.id, launchId: pending.launchId },
    srcPath: null,
    srcConversationId: pending.conversationId,
  });

  const materialized = await ensureTaskPipelineForAssignment(task, {
    ...pending,
    srcPath: "/codex/stage-1.jsonl",
  }, h.ports);
  const replayed = await ensureTaskPipelineForAssignment(task, {
    ...pending,
    srcPath: "/codex/stage-1.jsonl",
  }, h.ports);
  expect(materialized.pipeline?.id).toBe(reserved.pipeline?.id);
  expect(replayed.pipeline?.id).toBe(reserved.pipeline?.id);
  expect(loadPipelines()).toEqual([expect.objectContaining({
    id: reserved.pipeline?.id,
    srcPath: "/codex/stage-1.jsonl",
  })]);
});

test("pipeline tick recovers a reserved task creator path from its conversation", async () => {
  const h = harness();
  const task = boardTask("task-intent-recovery");
  saveTasks([task]);
  savePipelines([]);

  const reserved = await ensureTaskPipelineForAssignment(task, {
    repoDir: "/repo",
    engine: "codex",
    model: "gpt-5.6-sol",
    effort: "high",
    launchId: "launch-task-recovery",
    conversationId: "conversation_stage_2",
    srcPath: null,
  }, h.ports);
  expect(reserved.pipeline?.srcPath).toBeNull();

  await tickPipelines([], h.ports);
  expect(loadPipelines()).toEqual([expect.objectContaining({
    id: reserved.pipeline?.id,
    srcPath: "/codex/stage-2.jsonl",
    srcConversationId: "conversation_stage_2",
  })]);
});

test("unlinking a task keeps its launch-correlated creation evidence", async () => {
  const h = harness();
  const task = boardTask("task-intent-unlink");
  saveTasks([task]);
  savePipelines([]);
  const reserved = await ensureTaskPipelineForAssignment(task, {
    repoDir: "/repo",
    engine: "codex",
    model: "gpt-5.6-sol",
    effort: "high",
    launchId: "launch-task-unlink",
    conversationId: "conversation_stage_1",
    srcPath: null,
  }, h.ports);

  const unlinked = await patchPipeline(reserved.pipeline!.id, { action: "unlink-task", taskId: task.id }, h.ports);
  expect(unlinked.pipeline).toMatchObject({
    taskIds: [],
    creationIntent: { kind: "task-spawn", taskId: task.id, launchId: "launch-task-unlink" },
  });
  expect(loadPipelines()).toHaveLength(1);
});

test("a fresh task launch replaces one failed pending creation intent", async () => {
  const h = harness();
  const task = boardTask("task-intent-retry");
  saveTasks([task]);
  savePipelines([]);
  const first = await ensureTaskPipelineForAssignment(task, {
    repoDir: "/repo",
    engine: "codex",
    model: "gpt-5.6-sol",
    effort: "high",
    launchId: "launch-task-failed",
    conversationId: "conversation_stage_1",
    srcPath: null,
  }, h.ports);
  h.ports.spawnReceipt = (launchId) => launchId === "launch-task-failed" ? {
    state: "failed",
    launchId,
    conversationId: "conversation_stage_1",
    sessionId: null,
    "transcript": null,
    paneId: null,
  } : null;

  const recovered = await ensureTaskPipelineForAssignment(task, {
    repoDir: "/repo",
    engine: "codex",
    model: "gpt-5.6-sol",
    effort: "high",
    launchId: "launch-task-retry",
    conversationId: "conversation_stage_2",
    srcPath: "/codex/stage-2.jsonl",
  }, h.ports);

  expect(recovered.pipeline?.id).toBe(first.pipeline?.id);
  expect(loadPipelines()).toEqual([expect.objectContaining({
    creationIntent: { kind: "task-spawn", taskId: task.id, launchId: "launch-task-retry" },
    srcConversationId: "conversation_stage_2",
    srcPath: "/codex/stage-2.jsonl",
  })]);
});

test("adoptAttempt appends to the source stage after the cursor moved on", async () => {
  const h = harness();
  const pipeline = await create(h.ports);
  const sourceRun = pipeline.runs.find((run) => run.stageId === "plan")!;
  sourceRun.attempts.push({
    n: 1,
    state: "passed",
    effectiveRole: structuredClone(pipeline.stages[0]!.effectiveRole),
    launchId: "launch-source",
    conversationId: "conversation_source",
    sessionId: "session-source",
    agentPath: "/codex/source.jsonl",
    paneId: "%1",
    flowId: null,
    startedAt: "t0",
    completedAt: "t1",
    input: "original input",
    activatedBy: null,
    output: "source output",
    verdict: { status: "pass" },
    error: null,
  });
  pipeline.cursor = { stageId: "build", state: "running", input: "source output", activatedBy: { stageId: "plan", attempt: 1, edge: "pass" } };
  const cursorBefore = structuredClone(pipeline.cursor);

  const adopted = adoptAttempt(pipeline, "plan", {
    sourceConversationId: "conversation_source",
    launchId: "launch-child",
    conversationId: "conversation_child",
    sessionId: "session-child",
    agentPath: "/codex/child.jsonl",
    paneId: "%2",
    startedAt: "t2",
  });

  expect(adopted).toMatchObject({ n: 2, state: "running", conversationId: "conversation_child", input: "original input" });
  expect(sourceRun.attempts).toHaveLength(2);
  expect(pipeline.cursor).toEqual(cursorBefore);
  expect(adoptAttempt(pipeline, "plan", {
    sourceConversationId: "conversation_source",
    launchId: "launch-child",
    conversationId: "conversation_child",
    sessionId: "session-child",
    agentPath: "/codex/child.jsonl",
    paneId: "%2",
    startedAt: "t2",
  })).toBe(adopted);
  expect(sourceRun.attempts).toHaveLength(2);
});

test("durable pipeline membership recovers one pending adoption", async () => {
  const h = harness();
  const pipeline = await create(h.ports);
  const sourceRun = pipeline.runs.find((run) => run.stageId === "plan")!;
  sourceRun.attempts.push({
    n: 1,
    state: "passed",
    effectiveRole: structuredClone(pipeline.stages[0]!.effectiveRole),
    launchId: "launch-source",
    conversationId: "conversation_source",
    sessionId: "session-source",
    agentPath: "/codex/source.jsonl",
    paneId: "%1",
    flowId: null,
    startedAt: "1970-01-01T00:10:00.000Z",
    completedAt: "1970-01-01T00:11:00.000Z",
    input: "original input",
    activatedBy: null,
    output: "source output",
    verdict: { status: "pass" },
    error: null,
  });
  pipeline.cursor = { stageId: "build", state: "running", input: "source output", activatedBy: { stageId: "plan", attempt: 1, edge: "pass" } };
  pipeline.state = "paused";
  pipeline.pausedState = "running";
  savePipelines([pipeline]);
  expect(pipelineAttemptTargetForSource("conversation_source")).toEqual({
    pipelineId: pipeline.id,
    stageId: "plan",
    stageOrder: 0,
    role: "architect",
  });
  h.ports.pipelineAdoptionCandidates = () => [{
    stageId: "plan",
    sourceConversationId: "conversation_source",
    launchId: "launch-child",
    conversationId: "conversation_child",
    sessionId: "session-child",
    agentPath: "/codex/child.jsonl",
    paneId: null,
    startedAt: "1970-01-01T00:12:00.000Z",
  }];
  h.durableTurns.set("/codex/child.jsonl", { turn: "busy", message: null });

  await tickPipelines([entry("/codex/child.jsonl")], h.ports);
  await tickPipelines([entry("/codex/child.jsonl")], h.ports);

  const attempts = loadPipelines()[0]!.runs.find((run) => run.stageId === "plan")!.attempts;
  expect(attempts).toHaveLength(2);
  expect(attempts[1]).toMatchObject({ historical: true, conversationId: "conversation_child", state: "running" });
});

test("a terminal historical adoption settles without changing the cursor", async () => {
  const h = harness();
  const pipeline = await create(h.ports);
  const sourceRun = pipeline.runs.find((run) => run.stageId === "plan")!;
  sourceRun.attempts.push({
    n: 1,
    state: "passed",
    effectiveRole: structuredClone(pipeline.stages[0]!.effectiveRole),
    launchId: "launch-source",
    conversationId: "conversation_source",
    sessionId: "session-source",
    agentPath: "/codex/source.jsonl",
    paneId: "%1",
    flowId: null,
    startedAt: "1970-01-01T00:10:00.000Z",
    completedAt: "1970-01-01T00:11:00.000Z",
    input: "original input",
    activatedBy: null,
    output: "source output",
    verdict: { status: "pass" },
    error: null,
  });
  pipeline.cursor = { stageId: "build", state: "running", input: "source output", activatedBy: { stageId: "plan", attempt: 1, edge: "pass" } };
  pipeline.state = "paused";
  pipeline.pausedState = "running";
  const cursorBefore = structuredClone(pipeline.cursor);
  const adopted = adoptAttempt(pipeline, "plan", {
    sourceConversationId: "conversation_source",
    launchId: "launch-child",
    conversationId: "conversation_child",
    sessionId: "session-child",
    agentPath: "/codex/child.jsonl",
    paneId: null,
    startedAt: "1970-01-01T00:12:00.000Z",
  })!;
  savePipelines([pipeline]);
  h.durableTurns.set("/codex/child.jsonl", {
    turn: "terminal",
    message: {
      text: "historical result\n\n```json\n{\"status\":\"pass\",\"findings\":[],\"confidence\":0.9}\n```",
      ts: 2_000_000,
    },
  });

  await tickPipelines([entry("/codex/child.jsonl")], h.ports);
  const settled = loadPipelines()[0]!;
  const historical = settled.runs.find((run) => run.stageId === "plan")!.attempts[1]!;
  expect(historical).toMatchObject({
    historical: true,
    state: "passed",
    completedAt: new Date(2_000_000).toISOString(),
    verdict: { status: "pass" },
    output: null,
  });
  expect(settled.cursor).toEqual(cursorBefore);
  expect(settled.state).toBe("paused");

  const afterFirst = JSON.stringify(settled);
  await tickPipelines([entry("/codex/child.jsonl")], h.ports);
  expect(JSON.stringify(loadPipelines()[0])).toBe(afterFirst);
  expect(adopted.conversationId).toBe("conversation_child");
});

test("a cross-engine historical adoption settles with the child runtime", async () => {
  const h = harness();
  const pipeline = await create(h.ports);
  const sourceRun = pipeline.runs.find((run) => run.stageId === "plan")!;
  sourceRun.attempts.push({
    n: 1,
    state: "passed",
    effectiveRole: {
      roleId: "architect",
      engine: "codex",
      model: "gpt-5.6-sol",
      effort: "high",
      access: "read-only",
      promptScaffold: "Architect guidance",
    },
    launchId: "launch-source-codex",
    conversationId: "conversation_source_codex",
    sessionId: "session-source-codex",
    agentPath: "/codex/source-cross-engine.jsonl",
    paneId: "%3",
    flowId: null,
    startedAt: "1970-01-01T00:10:00.000Z",
    completedAt: "1970-01-01T00:11:00.000Z",
    input: "original input",
    activatedBy: null,
    output: "source output",
    verdict: { status: "pass" },
    error: null,
  });
  pipeline.cursor = { stageId: "build", state: "running", input: "source output", activatedBy: { stageId: "plan", attempt: 1, edge: "pass" } };
  pipeline.state = "paused";
  pipeline.pausedState = "running";
  savePipelines([pipeline]);
  const registryPath = path.join(process.env.LLV_STATE_DIR!, "cross-engine-agent-registry.json");
  const registry = new AgentRegistry(registryPath);
  const begun = registry.beginSpawnRequest({
    engine: "claude",
    cwd: "/repo",
    accountId: "claude-test",
    parentConversationId: "conversation_source_codex",
    launchProfile: { model: "claude-sonnet-4-6", effort: "high", title: "Adopt cross-engine pipeline stage" },
    memberships: [{
      kind: "pipeline",
      containerId: pipeline.id,
      role: "architect",
      slot: "adopt:plan:cross-engine",
      stageId: "plan",
      stageOrder: 0,
      round: null,
      parentConversationId: "conversation_source_codex",
      runtime: { engine: "claude", model: "claude-sonnet-4-6", effort: "high" },
    }],
  });
  if (begun.kind !== "created") throw new Error("cross-engine spawn reservation conflicted");
  const childPath = "/claude/child-cross-engine.jsonl";
  const childSessionId = crypto.randomUUID();
  const settled = registry.settleSpawn(begun.receipt.launchId, {
    key: { engine: "claude", sessionId: childSessionId },
    artifactPath: childPath,
    cwd: "/repo",
    accountId: "claude-test",
    launchProfile: begun.receipt.launchProfile,
    status: "starting",
    host: null,
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: "spawn",
  });
  if (settled.kind !== "settled") throw new Error("cross-engine spawn settlement conflicted");
  const candidates = (() => {
    setAgentRegistryForTests(new AgentRegistry(registryPath));
    try {
      return defaultPipelinePorts().pipelineAdoptionCandidates(pipeline.id);
    } finally {
      setAgentRegistryForTests(null);
    }
  })();
  expect(candidates).toEqual([
    expect.objectContaining({
      sourceConversationId: "conversation_source_codex",
      conversationId: begun.receipt.conversationId,
      agentPath: childPath,
      runtime: { engine: "claude", model: "claude-sonnet-4-6", effort: "high" },
    }),
  ]);
  h.ports.pipelineAdoptionCandidates = () => candidates;
  const observedEngines: string[] = [];
  h.ports.durableTurnEvidence = async (engine, transcriptPath) => {
    observedEngines.push(engine);
    if (engine !== "claude" || transcriptPath !== childPath) return null;
    return {
      turn: "terminal",
      message: {
        text: "cross-engine historical result\n\n```json\n{\"status\":\"pass\",\"findings\":[],\"confidence\":0.9}\n```",
        ts: Date.parse(begun.receipt.createdAt) + 1_000,
      },
    };
  };

  await tickPipelines([entry(childPath)], h.ports);

  expect(observedEngines).toContain("claude");
  const adopted = loadPipelines()[0]!.runs.find((run) => run.stageId === "plan")!.attempts[1]!;
  expect(adopted.effectiveRole).toMatchObject({
    roleId: "architect",
    engine: "claude",
    model: "claude-sonnet-4-6",
    effort: "high",
    access: "read-only",
  });
  expect(loadPipelines()[0]!.runs.find((run) => run.stageId === "plan")!.attempts[1]).toMatchObject({
    historical: true,
    state: "passed",
    verdict: { status: "pass" },
  });
});

test("historical adoption never replaces the operational retry predecessor", async () => {
  const h = harness();
  const created = await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "fail", "retry me")], h.ports);
  const pipeline = loadPipelines()[0]!;
  const adopted = adoptAttempt(pipeline, "plan", {
    sourceConversationId: "conversation_stage_1",
    launchId: "launch-historical",
    conversationId: "conversation_historical",
    sessionId: "session-historical",
    agentPath: "/codex/historical.jsonl",
    paneId: null,
    startedAt: "1970-01-01T00:12:00.000Z",
  });
  expect(adopted?.historical).toBe(true);
  savePipelines([pipeline]);

  await patchPipeline(created.id, { action: "retry-stage" }, h.ports);
  await tickPipelines([], h.ports);

  expect(h.calls).toContain(`spawn:pipeline_${created.id}_plan_3:parent=/codex/creator.jsonl:supersedes=conversation_stage_1`);
});

test("creation validates the 1–8 stage conversation graph and optional roles", async () => {
  const { ports } = harness();
  expect((await createPipelineFromRequest({ task: "x", repoDir: "/repo", stages: [] }, ports)).status).toBe(400);
  /* v3 graph rules: edge targets must exist and pass edges stay acyclic. */
  expect((await createPipelineFromRequest({ task: "x", repoDir: "/repo", stages: [
    { id: "a", kind: "run", role: { roleId: "builder" }, engine: "codex", prompt: "a", next: "missing" },
    { id: "b", kind: "run", role: { roleId: "builder" }, engine: "codex", prompt: "b", next: null },
  ] }, ports)).error).toContain("must reference an existing stage");
  expect((await createPipelineFromRequest({ task: "x", repoDir: "/repo", stages: [
    { id: "a", kind: "run", role: { roleId: "builder" }, engine: "codex", prompt: "a", next: "b" },
    { id: "b", kind: "run", role: { roleId: "builder" }, engine: "codex", prompt: "b", next: "a" },
  ] }, ports)).error).toContain("cycle");
  const roleless = await createPipelineFromRequest({ task: "x", repoDir: "/repo", stages: [
    { id: "a", kind: "run", prompt: "a", next: "b" },
    { id: "b", kind: "run", prompt: "b", next: null },
  ] }, ports);
  expect(roleless.pipeline?.stages[0]?.role).toBeUndefined();
  expect((await createPipelineFromRequest({ task: "x", repoDir: "/repo", stages: [
    { id: "a", kind: "run", role: { roleId: "builder" }, prompt: "a", next: "b" },
    { id: "b", kind: "run", role: { roleId: "builder", engine: "codex" }, prompt: "b", next: null },
  ] as never }, ports)).error).toContain("role only accepts roleId");
});

test("review-loop onFail edges are rejected during creation and graph editing", async () => {
  const h = harness();
  savePipelines([]);
  const invalid = await createPipelineFromRequest({
    task: "Unreachable review fix edge",
    repoDir: "/repo",
    autoStart: false,
    stages: [
      { id: "build", kind: "run", role: { roleId: "builder" }, prompt: "build", next: "review" },
      { id: "review", kind: "review-loop", role: { roleId: "reviewer" }, prompt: "review", next: null, onFail: { to: "build", maxRounds: 3 } },
    ],
  }, h.ports);

  expect(invalid).toMatchObject({
    error: "review-loop stage review does not support onFail",
    status: 400,
    violations: [{ field: "stages[].next", message: "review-loop stage review does not support onFail" }],
  });
  expect(loadPipelines()).toEqual([]);

  const valid = await createPipelineFromRequest({
    task: "Editable review graph",
    repoDir: "/repo",
    autoStart: false,
    stages: [
      { id: "build", kind: "run", role: { roleId: "builder" }, prompt: "build", next: "review" },
      { id: "review", kind: "review-loop", role: { roleId: "reviewer" }, prompt: "review", next: null },
    ],
  }, h.ports);
  if (!valid.pipeline) throw new Error(valid.error);

  const edited = await patchPipeline(valid.pipeline.id, {
    action: "set-edge",
    stageId: "review",
    edge: "fail",
    to: "build",
    maxRounds: 3,
  }, h.ports);
  expect(edited).toMatchObject({
    error: "review-loop stage review does not support onFail",
    status: 400,
  });
  expect(loadPipelines()[0]!.stages.find((stage) => stage.id === "review")!.onFail).toBeNull();
});

test("auto-start creation persists the fetched origin/main identity before provisioning", async () => {
  const h = harness();
  savePipelines([]);
  const result = await createPipelineFromRequest({ task: "Pinned base", repoDir: "/repo", stages: RUN_STAGES as never }, h.ports);

  expect(result.pipeline).toMatchObject({
    state: "provisioning",
    baseBranch: "main",
    baseRef: ORIGIN_MAIN_SHA,
    lastPassedCommit: ORIGIN_MAIN_SHA,
  });
  expect(loadPipelines()[0]).toMatchObject({
    baseBranch: "main",
    baseRef: ORIGIN_MAIN_SHA,
    lastPassedCommit: ORIGIN_MAIN_SHA,
  });
  expect(h.calls).toContain("git fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main");
});

test("auto-start creation rejects an unavailable remote without persisting a pipeline", async () => {
  const h = harness();
  savePipelines([]);
  const baseExec = h.ports.exec;
  h.ports.exec = (command, args, cwd) => args[0] === "fetch"
    ? { code: 128, stdout: "", stderr: "origin unavailable" }
    : baseExec(command, args, cwd);

  const result = await createPipelineFromRequest({ task: "No remote", repoDir: "/repo", stages: RUN_STAGES as never }, h.ports);

  expect(result).toEqual({ error: "fetching origin/main: origin unavailable", status: 409 });
  expect(loadPipelines()).toEqual([]);
  expect(h.calls.some((call) => call.includes("worktree add"))).toBe(false);
});

test("repository admission fails before pipeline persistence or provisioning", async () => {
  const h = harness();
  savePipelines([]);
  h.ports.preflightRepo = () => ({ ok: false, code: "repo_unreadable", path: "/repo" });

  const result = await createPipelineFromRequest({ task: "Private repo", repoDir: "/repo", stages: RUN_STAGES as never }, h.ports);

  expect(result).toEqual({
    error: "repository is not readable: /repo",
    status: 403,
    code: "repo_unreadable",
    field: "repoDir",
    path: "/repo",
  });
  expect(loadPipelines()).toEqual([]);
  expect(h.calls).toEqual([]);
});

test("create, draft repo edits, and Start share canonical repository admission", async () => {
  const h = harness();
  const checked: string[] = [];
  h.ports.preflightRepo = (repoDir) => {
    checked.push(repoDir);
    return { ok: true, repoDir: "/canonical/repo", gitCommonDir: "/canonical/repo/.git", worktreeParent: "/canonical" };
  };
  savePipelines([]);

  const created = await createPipelineFromRequest({ task: "Canonical", repoDir: "/alias", stages: RUN_STAGES as never, autoStart: false }, h.ports);
  expect(created.pipeline?.repoDir).toBe("/canonical/repo");

  h.ports.preflightRepo = (repoDir) => {
    checked.push(repoDir);
    if (repoDir === "/second") return { ok: true, repoDir: "/canonical/second", gitCommonDir: "/canonical/second/.git", worktreeParent: "/canonical" };
    return { ok: false, code: "git_metadata_unwritable", path: "/canonical/second/.git" };
  };
  const updated = await patchPipeline(created.pipeline!.id, { action: "update-draft", repoDir: "/second" }, h.ports);
  expect(updated.pipeline?.repoDir).toBe("/canonical/second");

  const blocked = await patchPipeline(created.pipeline!.id, { action: "start" }, h.ports);
  expect(blocked).toMatchObject({ status: 403, code: "git_metadata_unwritable", field: "repoDir" });
  expect(loadPipelines()[0]).toMatchObject({ state: "draft", repoDir: "/canonical/second" });
  expect(checked).toEqual(["/alias", "/second", "/canonical/second"]);
});

test("a parked provisioning retry reuses the pinned base and provisions again", async () => {
  const h = harness();
  savePipelines([]);
  const baseExec = h.ports.exec;
  let failWorktreeAdd = true;
  h.ports.exec = (command, args, cwd) => {
    if (args[0] === "worktree" && failWorktreeAdd) return { code: 128, stdout: "", stderr: "worktree unavailable" };
    if (args[0] === "rev-parse" && args[1] === "--abbrev-ref" && cwd?.includes("-pipeline-")) {
      return failWorktreeAdd
        ? { code: 128, stdout: "", stderr: "missing worktree" }
        : { code: 0, stdout: `${loadPipelines()[0]!.branch}\n`, stderr: "" };
    }
    return baseExec(command, args, cwd);
  };
  const created = await createPipelineFromRequest({ task: "Recover provision", repoDir: "/repo", stages: RUN_STAGES as never }, h.ports);

  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]).toMatchObject({
    state: "needs_decision",
    baseRef: ORIGIN_MAIN_SHA,
    lastPassedCommit: ORIGIN_MAIN_SHA,
  });

  failWorktreeAdd = false;
  const retried = await patchPipeline(created.pipeline!.id, { action: "retry-stage" }, h.ports);
  expect(retried.pipeline?.state).toBe("provisioning");
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]).toMatchObject({ state: "running", baseRef: ORIGIN_MAIN_SHA, lastPassedCommit: ORIGIN_MAIN_SHA });
});

test("controller recovery stamps an older unresolved provisioning record before creating its worktree", async () => {
  const h = harness();
  savePipelines([]);
  const created = await createPipelineFromRequest({
    task: "Recover legacy provision",
    repoDir: "/repo",
    stages: RUN_STAGES as never,
    autoStart: false,
  }, h.ports);
  const legacy = loadPipelines()[0]!;
  legacy.state = "provisioning";
  savePipelines([legacy]);

  await tickPipelines([], h.ports);

  expect(loadPipelines()[0]).toMatchObject({
    id: created.pipeline!.id,
    state: "running",
    baseBranch: "main",
    baseRef: ORIGIN_MAIN_SHA,
    lastPassedCommit: ORIGIN_MAIN_SHA,
  });
  expect(h.calls).toContain("git fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main");
});

test("autoStart false persists a draft without provisioning or spawning", async () => {
  const h = harness();
  savePipelines([]);
  const result = await createPipelineFromRequest({
    task: "Review this draft",
    repoDir: "/repo",
    stages: RUN_STAGES as never,
    autoStart: false,
  }, h.ports);

  expect(result.pipeline).toMatchObject({ state: "draft", cursor: { stageId: "plan", state: "pending", input: null, activatedBy: null } });
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);

  const persisted = loadPipelines()[0]!;
  expect(persisted.state).toBe("draft");
  expect(persisted.runs.every((run) => run.attempts.length === 0)).toBe(true);
  expect(h.calls.some((call) => call.includes("worktree add"))).toBe(false);
  expect(h.calls.some((call) => call.startsWith("spawn:"))).toBe(false);
});

test("set-position persists a finite world pin without changing pipeline execution state", async () => {
  const h = harness();
  const created = await create(h.ports);

  const moved = await patchPipeline(created.id, { action: "set-position", pos: { x: 1337, y: -240 } }, h.ports);

  expect(moved.pipeline).toMatchObject({ id: created.id, state: created.state, pos: { x: 1337, y: -240 } });
  expect(loadPipelines()[0]).toMatchObject({ pos: { x: 1337, y: -240 } });
  expect((await patchPipeline(created.id, { action: "set-position", pos: { x: Number.NaN, y: 1 } }, h.ports)).status).toBe(400);
});

test("an explicit draft base remains pinned when the draft starts", async () => {
  const h = harness();
  savePipelines([]);
  const explicitRef = "release-candidate";
  const created = await createPipelineFromRequest({
    task: "Pinned draft",
    repoDir: "/repo",
    baseBranch: "release",
    baseRef: explicitRef,
    stages: RUN_STAGES as never,
    autoStart: false,
  }, h.ports);

  expect(created.pipeline).toMatchObject({
    state: "draft",
    baseBranch: "release",
    baseRef: ORIGIN_MAIN_SHA,
    lastPassedCommit: ORIGIN_MAIN_SHA,
  });
  const callsBeforeStart = h.calls.length;
  const started = await patchPipeline(created.pipeline!.id, { action: "start" }, h.ports);
  expect(started.pipeline).toMatchObject({
    state: "provisioning",
    baseBranch: "release",
    baseRef: ORIGIN_MAIN_SHA,
    lastPassedCommit: ORIGIN_MAIN_SHA,
  });
  expect(h.calls.slice(callsBeforeStart)).toEqual([]);
});

test("starting a draft enters the existing provision and stage-spawn path", async () => {
  const h = harness();
  savePipelines([]);
  const created = await createPipelineFromRequest({
    task: "Start after review",
    repoDir: "/repo",
    stages: RUN_STAGES as never,
    autoStart: false,
  }, h.ports);
  const id = created.pipeline!.id;

  const started = await patchPipeline(id, { action: "start" }, h.ports);
  expect(started.pipeline).toMatchObject({
    state: "provisioning",
    baseBranch: "main",
    baseRef: ORIGIN_MAIN_SHA,
    lastPassedCommit: ORIGIN_MAIN_SHA,
  });
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.state).toBe("running");
  await tickPipelines([], h.ports);

  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.state).toBe("running");
  expect(h.calls.some((call) => call.includes("worktree add"))).toBe(true);
  expect(h.calls.some((call) => call.startsWith("spawn:"))).toBe(true);
  expect(h.spawnTitles).toEqual(["Start after review · plan"]);
});

test("long pipeline tasks keep distinct stage identifiers in every spawn title", async () => {
  const h = harness();
  savePipelines([]);
  const created = await createPipelineFromRequest({
    task: "x".repeat(4_000),
    repoDir: "/repo",
    stages: RUN_STAGES as never,
  }, h.ports);
  expect(created.pipeline).toBeDefined();

  await tickPipelines([], h.ports); // provision
  await tickPipelines([], h.ports); // spawn plan
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass", "plan output")], h.ports);
  await tickPipelines([], h.ports); // spawn build

  expect(h.spawnTitles).toHaveLength(2);
  expect(h.spawnTitles[0]).toEndWith(" · plan");
  expect(h.spawnTitles[1]).toEndWith(" · build");
  expect(h.spawnTitles[0]).not.toBe(h.spawnTitles[1]);
  expect(h.spawnTitles.every((title) => title.length <= 120)).toBe(true);
});

test("role params are accepted, persisted on the stage, and type-checked", async () => {
  const { ports } = harness();
  savePipelines([]);
  const ok = await createPipelineFromRequest({ task: "x", spec: "AC", repoDir: "/repo", stages: [
    { id: "build", kind: "run", role: { roleId: "builder", params: { mode: "tdd" } }, engine: "codex", prompt: "a", next: "review" },
    { id: "review", kind: "review-loop", role: { roleId: "reviewer" }, prompt: "b", next: null },
  ] as never }, ports);
  expect(ok.pipeline?.stages[0]?.role).toEqual({ roleId: "builder", params: { mode: "tdd" } });

  savePipelines([]);
  const bad = await createPipelineFromRequest({ task: "x", spec: "AC", repoDir: "/repo", stages: [
    { id: "build", kind: "run", role: { roleId: "builder", params: { mode: { nested: true } } }, engine: "codex", prompt: "a", next: "review" },
    { id: "review", kind: "review-loop", role: { roleId: "reviewer" }, prompt: "b", next: null },
  ] as never }, ports);
  expect(bad.error).toContain("params must be strings or numbers");
});

test("a deployer stage is rejected at create with a 400", async () => {
  const { ports } = harness();
  savePipelines([]);
  const result = await createPipelineFromRequest({ task: "x", spec: "AC", repoDir: "/repo", stages: [
    { id: "build", kind: "run", role: { roleId: "builder" }, engine: "codex", prompt: "a", next: "ship" },
    { id: "ship", kind: "run", role: { roleId: "deployer" }, engine: "codex", prompt: "b", next: null },
  ] as never }, ports);
  expect(result.status).toBe(400);
  expect(result.error).toContain("not allowed in a pipeline");
});

test("invalid role param values fail canonical validation with a 400", async () => {
  const { ports } = harness();
  savePipelines([]);
  const badSelect = await createPipelineFromRequest({ task: "x", spec: "AC", repoDir: "/repo", stages: [
    { id: "build", kind: "run", role: { roleId: "builder", params: { mode: "bananas" } }, engine: "codex", prompt: "a", next: "review" },
    { id: "review", kind: "review-loop", role: { roleId: "reviewer" }, prompt: "b", next: null },
  ] as never }, ports);
  expect(badSelect.status).toBe(400);
  expect(badSelect.error).toContain("invalid role parameter: mode");

  savePipelines([]);
  const unknownKey = await createPipelineFromRequest({ task: "x", spec: "AC", repoDir: "/repo", stages: [
    { id: "build", kind: "run", role: { roleId: "builder", params: { bogus: "x" } }, engine: "codex", prompt: "a", next: "review" },
    { id: "review", kind: "review-loop", role: { roleId: "reviewer" }, prompt: "b", next: null },
  ] as never }, ports);
  expect(unknownKey.status).toBe(400);
  expect(unknownKey.error).toContain("unknown role parameter: bogus");
});

test("linear run stages persist sessions, structured outputs, commits, and lineage", async () => {
  const h = harness();
  await create(h.ports);
  await tickPipelines([], h.ports); // provision
  await tickPipelines([], h.ports); // spawn plan
  let current = loadPipelines()[0]!;
  expect(current.runs[0]!.attempts[0]).toMatchObject({ sessionId: "session-1", conversationId: "conversation_stage_1", state: "running" });
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass", "plan output")], h.ports);
  current = loadPipelines()[0]!;
  expect(current.cursor?.stageId).toBe("build");
  expect(current.runs[0]!.attempts[0]!.output).toBe("plan output");
  await tickPipelines([], h.ports); // spawn build
  expect(h.calls.some((call) => call.includes("parent=/codex/stage-1.jsonl"))).toBe(true);
  await tickPipelines([h.finish("/codex/stage-2.jsonl", "pass", "build output")], h.ports);
  current = loadPipelines()[0]!;
  expect(current.state).toBe("completed");
  expect(current.lastPassedCommit).toBe(ORIGIN_MAIN_SHA);
});

test("pipeline stage membership is supplied before every stage spawn", async () => {
  const h = harness();
  const pipeline = await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);

  expect(h.calls).toContain(`membership:pipeline:${pipeline.id}:plan:1:architect:0:round=1`);
});

test("controller ticks follow a stage conversation to its resumed transcript", async () => {
  const h = harness();
  await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  h.ports.pathForConversation = (id) => id === "conversation_stage_1" ? "/codex/stage-1-resumed.jsonl" : null;
  const resumed = entry("/codex/stage-1-resumed.jsonl");
  resumed.activity = "live";

  await tickPipelines([resumed], h.ports);

  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.agentPath).toBe(resumed.path);
});

test("controller ticks refresh durable paths for completed pipeline attempts", async () => {
  const h = harness();
  await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  const pipeline = loadPipelines()[0]!;
  pipeline.state = "completed";
  pipeline.cursor = null;
  pipeline.runs[0]!.attempts[0]!.agentPath = "/codex/stage-1-archived.jsonl";
  savePipelines([pipeline]);
  h.ports.pathForConversation = (id) => id === "conversation_stage_1" ? "/codex/stage-1-resumed.jsonl" : null;

  await tickPipelines([], h.ports);

  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.agentPath).toBe("/codex/stage-1-resumed.jsonl");
});

test("spawn reservations persist before actuation and concurrent creation waits for the controller mutation", async () => {
  const h = harness();
  await create(h.ports);
  await tickPipelines([], h.ports); // provision
  let releaseSpawn!: () => void;
  let reserved!: () => void;
  const spawnGate = new Promise<void>((resolve) => { releaseSpawn = resolve; });
  const reservation = new Promise<void>((resolve) => { reserved = resolve; });
  h.ports.spawnAgent = async (_input, onReserved) => {
    onReserved({ launchId: "launch-durable", conversationId: "conversation_durable" });
    reserved();
    await spawnGate;
    return { launchId: "launch-durable", conversationId: "conversation_durable", sessionId: "session-durable", transcript: "/codex/durable.jsonl", paneId: "%9" };
  };

  const ticking = tickPipelines([], h.ports);
  await reservation;
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]).toMatchObject({
    state: "spawning",
    launchId: "launch-durable",
    conversationId: "conversation_durable",
  });
  let creationSettled = false;
  const creating = createPipelineFromRequest({
    task: "Second pipeline",
    repoDir: "/repo",
    stages: [
      { id: "build", kind: "run", prompt: "build", next: "verify" },
      { id: "verify", kind: "run", prompt: "verify", next: null },
    ],
  }, h.ports).then((result) => { creationSettled = true; return result; });
  await Promise.resolve();
  expect(creationSettled).toBe(false);

  releaseSpawn();
  await ticking;
  expect((await creating).pipeline).toBeDefined();
  expect(loadPipelines()).toHaveLength(2);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.launchId).toBe("launch-durable");
});

test("a dirty read-only stage parks without staging repository changes", async () => {
  const h = harness();
  const baseExec = h.ports.exec;
  h.ports.exec = (command, args, cwd) => args[0] === "status"
    ? { code: 0, stdout: " M forbidden.ts\n", stderr: "" }
    : baseExec(command, args, cwd);
  await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass")], h.ports);
  expect(loadPipelines()[0]!.state).toBe("needs_decision");
  expect(loadPipelines()[0]!.stateDetail).toContain("read-only stage plan modified");
  expect(h.calls.some((call) => call.includes("git add"))).toBe(false);
});

test("restart after a bare spawn reservation parks instead of waiting forever", async () => {
  const h = harness();
  await create(h.ports);
  await tickPipelines([], h.ports);
  const pipeline = loadPipelines()[0]!;
  pipeline.runs[0]!.attempts.push({
    n: 1,
    state: "spawning",
    effectiveRole: structuredClone(pipeline.stages[0]!.effectiveRole),
    launchId: "launch-reserved",
    conversationId: "conversation_reserved",
    sessionId: null,
    agentPath: null,
    paneId: null,
    flowId: null,
    startedAt: h.ports.now(),
    completedAt: null,
    input: null,
    activatedBy: null,
    output: null,
    verdict: null,
    error: null,
  });
  pipeline.cursor = { stageId: "plan", state: "spawning", input: null, activatedBy: null };
  h.ports.spawnReceipt = () => ({
    state: "starting",
    launchId: "launch-reserved",
    conversationId: "conversation_reserved",
    sessionId: null,
    "transcript": null,
    paneId: null,
  });
  savePipelines([pipeline]);

  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.state).toBe("needs_decision");
  expect(loadPipelines()[0]!.stateDetail).toContain("cannot recover from receipt state starting");
});

test("transient structured spawn handshakes retry twice before parking (#1056)", async () => {
  const h = harness();
  await create(h.ports);
  await tickPipelines([], h.ports);
  let spawnCalls = 0;
  const delays: number[] = [];
  h.ports.spawnAgent = async () => {
    spawnCalls += 1;
    throw new Error("runtime host request timed out");
  };
  Object.assign(h.ports, {
    sleep: async (milliseconds: number) => { delays.push(milliseconds); },
  });

  await tickPipelines([], h.ports);

  const parked = loadPipelines()[0]!;
  expect(spawnCalls).toBe(3);
  expect(delays).toEqual([1_000, 1_000]);
  expect(parked.state).toBe("needs_decision");
  expect(parked.stateDetail).toContain("runtime host request timed out");
  expect(parked.stateDetail).toContain("2 retries");
});

/* The controller wait must never be slept through: the pipelines phase holds
   the pipeline mutation, and a tick that blocks in it for the whole budget is
   what pushed the flow pipeline controller past its 15s deadline (#1191). */
const forbiddenSleep = async (milliseconds: number) => {
  throw new Error(`stage activation slept ${milliseconds}ms inside the pipelines phase`);
};

/* Freezes the harness wall clock so a bounded, wall-clock wait can be driven
   step by step. The default clock advances on every `now()` read, which would
   make the elapsed budget depend on how many times a tick happens to ask. */
function frozenWallClock(h: ReturnType<typeof harness>) {
  let wall = Date.parse(h.ports.now());
  h.ports.now = () => new Date(wall).toISOString();
  return (milliseconds: number) => { wall += milliseconds; };
}

test("stage activation rides out a controller that is unavailable for a few seconds (#1191)", async () => {
  const h = harness();
  await create(h.ports);
  await tickPipelines([], h.ports);
  const advance = frozenWallClock(h);
  const baseSpawn = h.ports.spawnAgent;
  let spawnCalls = 0;
  const scheduled: number[] = [];
  const slept: number[] = [];
  const attemptIds: string[] = [];
  h.ports.spawnAgent = async (input, onReserved) => {
    spawnCalls += 1;
    attemptIds.push(input.clientAttemptId);
    if (spawnCalls <= 3) throw new Error("structured delivery controller is unavailable");
    return baseSpawn(input, onReserved);
  };
  Object.assign(h.ports, {
    scheduleTick: (delayMs: number) => { scheduled.push(delayMs); },
    sleep: async (milliseconds: number) => { slept.push(milliseconds); },
  });

  /* Each tick makes exactly one attempt and hands the wait to a scheduled
     tick; nothing sleeps inside the pipelines phase. */
  for (let round = 0; round < 4; round += 1) {
    await tickPipelines([], h.ports);
    if (round === 3) break;
    const waiting = loadPipelines()[0]!;
    expect(waiting.state).toBe("running");
    expect(waiting.stateDetail).toBeNull();
    expect(waiting.cursor).toMatchObject({ stageId: "plan", state: "pending" });
    expect(waiting.runs[0]!.attempts.at(-1)!.state).toBe("pending");
    advance(scheduled.at(-1)!);
  }

  expect(spawnCalls).toBe(4);
  expect(scheduled).toEqual([1_000, 2_000, 4_000]);
  expect(slept).toEqual([]);
  /* Each retry keeps a launch identity of its own even though the wait now
     spans ticks, so no attempt collides with the receipt of the one before. */
  expect(new Set(attemptIds).size).toBe(4);
  expect(attemptIds.slice(1).map((id) => id.split("_pipeline_")[0])).toEqual([
    "handshake_retry_1",
    "handshake_retry_2",
    "handshake_retry_3",
  ]);
  const running = loadPipelines()[0]!;
  expect(running).toMatchObject({
    state: "running",
    stateDetail: null,
    cursor: { stageId: "plan", state: "running" },
  });
  /* The wait record is spent, so a later stall starts its own budget. */
  expect(running.runs[0]!.attempts.at(-1)!.controllerWait).toBeUndefined();
});

test("a stage waiting on the controller does not spin the pipelines phase (#1191)", async () => {
  const h = harness();
  await create(h.ports);
  await tickPipelines([], h.ports);
  frozenWallClock(h);
  h.ports.spawnAgent = async () => { throw new Error("structured delivery controller is unavailable"); };
  Object.assign(h.ports, { scheduleTick: () => {}, sleep: forbiddenSleep });
  let ticks = 0;
  const unregister = registerPipelineTick(async () => { ticks += 1; });
  try {
    await tickPipelines([], h.ports);
    expect(loadPipelines()[0]!.cursor).toMatchObject({ stageId: "plan", state: "pending" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    /* The pending cursor belongs to a wait that is not due; re-ticking it at
       once would loop the controller through passes that can only defer it. */
    expect(ticks).toBe(0);
  } finally {
    unregister();
  }
});

test("a controller that is between publications is never spawned into (#1191)", async () => {
  const h = harness();
  await create(h.ports);
  await tickPipelines([], h.ports);
  const advance = frozenWallClock(h);
  const baseSpawn = h.ports.spawnAgent;
  let spawnCalls = 0;
  const scheduled: number[] = [];
  h.ports.spawnAgent = async (input, onReserved) => {
    spawnCalls += 1;
    return baseSpawn(input, onReserved);
  };
  Object.assign(h.ports, {
    structuredDeliveryPublication: () => "rebinding" as const,
    scheduleTick: (delayMs: number) => { scheduled.push(delayMs); },
    sleep: forbiddenSleep,
  });

  await tickPipelines([], h.ports);

  /* The spawn only fails at durable host publication, so an attempt issued
     against a rebinding controller burns a real engine launch first. */
  expect(spawnCalls).toBe(0);
  expect(scheduled).toEqual([1_000]);
  expect(loadPipelines()[0]!).toMatchObject({
    state: "running",
    stateDetail: null,
    cursor: { stageId: "plan", state: "pending" },
  });

  /* Before the booked wait falls due nothing is retried. */
  await tickPipelines([], h.ports);
  expect(scheduled).toEqual([1_000]);

  advance(1_000);
  Object.assign(h.ports, { structuredDeliveryPublication: () => "ready" as const });
  await tickPipelines([], h.ports);

  expect(spawnCalls).toBe(1);
  expect(loadPipelines()[0]!).toMatchObject({
    state: "running",
    cursor: { stageId: "plan", state: "running" },
  });
});

test("a controller that never returns parks the stage with the wait it spent (#1191)", async () => {
  const h = harness();
  await create(h.ports);
  await tickPipelines([], h.ports);
  const advance = frozenWallClock(h);
  let spawnCalls = 0;
  const scheduled: number[] = [];
  const slept: number[] = [];
  h.ports.spawnAgent = async () => {
    spawnCalls += 1;
    throw new Error("structured delivery controller is unavailable");
  };
  Object.assign(h.ports, {
    scheduleTick: (delayMs: number) => { scheduled.push(delayMs); },
    sleep: async (milliseconds: number) => { slept.push(milliseconds); },
  });

  for (let round = 0; round < 8 && loadPipelines()[0]!.state === "running"; round += 1) {
    await tickPipelines([], h.ports);
    if (scheduled.length > 0) advance(scheduled.at(-1)!);
  }

  const parked = loadPipelines()[0]!;
  /* The budget is wall-clock, so the schedule stops exactly on it. */
  expect(scheduled).toEqual([1_000, 2_000, 4_000, 8_000, 8_000, 7_000]);
  expect(scheduled.reduce((total, delay) => total + delay, 0)).toBe(30_000);
  expect(spawnCalls).toBe(scheduled.length + 1);
  /* Nothing was slept through inside the pipelines phase. */
  expect(slept).toEqual([]);
  expect(parked.state).toBe("needs_decision");
  expect(parked.stateDetail).toContain("structured delivery controller is unavailable");
  expect(parked.stateDetail).toContain("6 retries over 30s");
});

test("the controller wait counts the time a failing spawn attempt spent (#1191)", async () => {
  const h = harness();
  await create(h.ports);
  await tickPipelines([], h.ports);
  const advance = frozenWallClock(h);
  let spawnCalls = 0;
  const scheduled: number[] = [];
  h.ports.spawnAgent = async () => {
    spawnCalls += 1;
    /* Durable host setup runs for 20s before it reaches host publication. */
    advance(20_000);
    throw new Error("structured delivery controller is unavailable");
  };
  Object.assign(h.ports, {
    scheduleTick: (delayMs: number) => { scheduled.push(delayMs); },
    sleep: forbiddenSleep,
  });

  await tickPipelines([], h.ports);
  advance(scheduled.at(-1)!);
  await tickPipelines([], h.ports);

  /* Two attempts have burned 40s of wall clock between them, so the budget is
     spent even though the booked backoff only came to 1s. */
  const parked = loadPipelines()[0]!;
  expect(spawnCalls).toBe(2);
  expect(scheduled).toEqual([1_000]);
  expect(parked.state).toBe("needs_decision");
  expect(parked.stateDetail).toContain("1 retries over 41s");
});

test("a process without a delivery controller publication defers stage activation (#1191)", async () => {
  const h = harness();
  await create(h.ports);
  await tickPipelines([], h.ports);
  let spawnCalls = 0;
  const baseSpawn = h.ports.spawnAgent;
  h.ports.spawnAgent = async (input, onReserved) => {
    spawnCalls += 1;
    return baseSpawn(input, onReserved);
  };
  Object.assign(h.ports, { structuredDeliveryPublication: () => "unbound" as const });

  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);

  const deferred = loadPipelines()[0]!;
  expect(spawnCalls).toBe(0);
  expect(deferred.state).toBe("running");
  expect(deferred.stateDetail).toBeNull();
  expect(deferred.cursor).toMatchObject({ stageId: "plan", state: "pending" });
  expect(deferred.runs[0]!.attempts).toHaveLength(1);
  expect(deferred.runs[0]!.attempts.at(-1)!.state).toBe("pending");

  /* The process that owns the publication activates the same attempt. */
  Object.assign(h.ports, { structuredDeliveryPublication: () => "ready" as const });
  await tickPipelines([], h.ports);

  expect(spawnCalls).toBe(1);
  expect(loadPipelines()[0]!).toMatchObject({
    state: "running",
    cursor: { stageId: "plan", state: "running" },
  });
});

test("a transient structured spawn handshake can recover on retry (#1056)", async () => {
  const h = harness();
  await create(h.ports);
  await tickPipelines([], h.ports);
  const baseSpawn = h.ports.spawnAgent;
  let spawnCalls = 0;
  const clientAttemptIds: string[] = [];
  Object.assign(h.ports, { sleep: async () => {} });
  h.ports.spawnAgent = async (input, onReserved) => {
    spawnCalls += 1;
    clientAttemptIds.push(input.clientAttemptId);
    if (spawnCalls < 3) throw new Error("runtime host request timed out");
    return baseSpawn(input, onReserved);
  };

  await tickPipelines([], h.ports);

  expect(spawnCalls).toBe(3);
  expect(new Set(clientAttemptIds).size).toBe(3);
  const current = loadPipelines()[0]!;
  expect(current).toMatchObject({
    state: "running",
    stateDetail: null,
    cursor: { stageId: "plan", state: "running" },
  });
  expect(current.runs[0]!.attempts[0]!.state).toBe("running");
});

test("durable conversation identity never adopts a competing cwd session", async () => {
  const h = harness();
  await create(h.ports);
  await tickPipelines([], h.ports);
  const pipeline = loadPipelines()[0]!;
  pipeline.runs[0]!.attempts.push({
    n: 1,
    state: "running",
    effectiveRole: structuredClone(pipeline.stages[0]!.effectiveRole),
    launchId: "launch-known",
    conversationId: "conversation_known",
    sessionId: null,
    agentPath: null,
    paneId: null,
    flowId: null,
    startedAt: h.ports.now(),
    completedAt: null,
    input: null,
    activatedBy: null,
    output: null,
    verdict: null,
    error: null,
  });
  pipeline.cursor = { stageId: "plan", state: "running", input: null, activatedBy: null };
  savePipelines([pipeline]);

  await tickPipelines([h.finish("/codex/competing.jsonl", "pass")], h.ports);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.agentPath).toBeNull();
  expect(loadPipelines()[0]!.cursor?.stageId).toBe("plan");
});

test("a stage with an unwritten transcript parks on its first-message drain failure", async () => {
  const h = harness();
  await create(h.ports);
  await tickPipelines([], h.ports);
  h.ports.spawnAgent = async (_input, onReserved) => {
    onReserved({ launchId: "launch-drain-timeout", conversationId: "conversation_drain_timeout" });
    return {
      launchId: "launch-drain-timeout",
      conversationId: "conversation_drain_timeout",
      sessionId: "session-drain-timeout",
      "transcript": "/codex/unwritten-stage.jsonl",
      paneId: null,
    };
  };
  await tickPipelines([], h.ports);
  h.setConversationActive(false);
  const reason = "first message never drained: runtime host request timed out";
  h.ports.spawnReceipt = () => ({
    state: "failed",
    launchId: "launch-drain-timeout",
    conversationId: "conversation_drain_timeout",
    sessionId: "session-drain-timeout",
    "transcript": "/codex/unwritten-stage.jsonl",
    paneId: null,
    error: reason,
  });

  await tickPipelines([], h.ports);

  const parked = loadPipelines()[0]!;
  expect(parked).toMatchObject({ state: "needs_decision", stateDetail: reason });
  expect(parked.runs[0]!.attempts[0]!.error).toBe(reason);
});

test("a runtime-host outage does not hide a terminal spawn receipt's drain cause (#1314, #1326)", async () => {
  const h = harness();
  await create(h.ports);
  await tickPipelines([], h.ports);
  h.ports.spawnAgent = async (_input, onReserved) => {
    onReserved({ launchId: "launch-drain-outage", conversationId: "conversation_drain_outage" });
    return {
      launchId: "launch-drain-outage",
      conversationId: "conversation_drain_outage",
      sessionId: "session-drain-outage",
      "transcript": "/codex/unwritten-outage-stage.jsonl",
      paneId: null,
    };
  };
  await tickPipelines([], h.ports);
  /* The runtime host is unreachable: liveness answers null, not false. */
  h.setConversationActive(null);
  const reason = "first message never drained: runtime host request timed out";
  h.ports.spawnReceipt = () => ({
    state: "failed",
    launchId: "launch-drain-outage",
    conversationId: "conversation_drain_outage",
    sessionId: "session-drain-outage",
    "transcript": "/codex/unwritten-outage-stage.jsonl",
    paneId: null,
    error: reason,
  });

  await tickPipelines([], h.ports);

  const parked = loadPipelines()[0]!;
  expect(parked).toMatchObject({ state: "needs_decision", stateDetail: reason });
  expect(parked.runs[0]!.attempts[0]!.error).toBe(reason);
});

test("a terminal spawn receipt parks while runtime liveness still reports active (#1326)", async () => {
  const h = harness();
  await create(h.ports);
  await tickPipelines([], h.ports);
  h.ports.spawnAgent = async (_input, onReserved) => {
    onReserved({ launchId: "launch-drain-stale-live", conversationId: "conversation_drain_stale_live" });
    return {
      launchId: "launch-drain-stale-live",
      conversationId: "conversation_drain_stale_live",
      sessionId: "session-drain-stale-live",
      "transcript": "/codex/unwritten-stale-live-stage.jsonl",
      paneId: null,
    };
  };
  await tickPipelines([], h.ports);
  h.setConversationActive(true);
  const reason = "first message never drained: runtime host request timed out";
  h.ports.spawnReceipt = () => ({
    state: "failed",
    launchId: "launch-drain-stale-live",
    conversationId: "conversation_drain_stale_live",
    sessionId: "session-drain-stale-live",
    "transcript": "/codex/unwritten-stale-live-stage.jsonl",
    paneId: null,
    error: reason,
  });

  await tickPipelines([], h.ports);

  const parked = loadPipelines()[0]!;
  expect(parked).toMatchObject({ state: "needs_decision", stateDetail: reason });
  expect(parked.runs[0]!.attempts[0]!.error).toBe(reason);
});

test("an unregistered stage with only its launch record parks and the lane closes (#1325)", async () => {
  const h = harness();
  const pipeline = await runningStructuredStage(h);
  h.setConversationActive(null);
  h.ports.conversationRegistered = () => false;
  h.durableTurns.set("/codex/stage-1.jsonl", {
    turn: "busy",
    message: null,
    launchOnly: true,
  });

  for (let check = 0; check < 3; check += 1) {
    if (check > 0) h.advanceWallClock(30_000);
    await tickPipelines([], h.ports);
  }

  const parked = loadPipelines()[0]!;
  expect(parked).toMatchObject({
    state: "needs_decision",
    stateDetail: "stage verdict recovery exhausted after 3 checks: the stage host died before its session registered",
  });
  expect(parked.runs[0]!.attempts[0]).toMatchObject({
    state: "needs_decision",
    completedAt: expect.any(String),
    verdictRecovery: { state: "exhausted", checks: 3 },
  });

  h.setHostsResident(true);
  h.setStageHost("conversation_stage_1", {
    outcome: "failed",
    error: "structured runtime host is unavailable",
  });
  const closed = await patchPipeline(pipeline.id, { action: "close" }, h.ports);

  expect(closed.error).toBeUndefined();
  expect(closed.close?.stillRunning).toEqual([]);
  expect(closed.close?.alreadyStopped).toMatchObject([{ stageId: "plan", attempt: 1 }]);
  expect(closed.close?.notes).toMatchObject([{
    stageId: "plan",
    attempt: 1,
    detail: expect.stringContaining("the stage host died before its session registered"),
  }]);
  expect(loadPipelines()[0]!.state).toBe("closed");
});

test("an unregistered stage with agent transcript progress keeps running (#1325)", async () => {
  const h = harness();
  await runningStructuredStage(h);
  h.setConversationActive(null);
  h.ports.conversationRegistered = () => false;
  h.durableTurns.set("/codex/stage-1.jsonl", {
    turn: "busy",
    message: { text: "working through the stage", ts: 5_000_000 },
    launchOnly: false,
  });

  for (let check = 0; check < 4; check += 1) {
    if (check > 0) h.advanceWallClock(30_000);
    await tickPipelines([], h.ports);
  }

  const current = loadPipelines()[0]!;
  expect(current.state).toBe("running");
  expect(current.runs[0]!.attempts[0]).toMatchObject({ state: "running", completedAt: null });
  expect(current.runs[0]!.attempts[0]!.verdictRecovery).toBeUndefined();
});

test("an unregistered launch-only stage stays running with affirmative runtime activity (#1325)", async () => {
  const h = harness();
  await runningStructuredStage(h);
  h.setConversationActive(true);
  h.ports.conversationRegistered = () => false;
  h.durableTurns.set("/codex/stage-1.jsonl", {
    turn: "unknown",
    message: null,
    launchOnly: true,
  });

  for (let check = 0; check < 4; check += 1) {
    if (check > 0) h.advanceWallClock(30_000);
    await tickPipelines([], h.ports);
  }

  const current = loadPipelines()[0]!;
  expect(current.state).toBe("running");
  expect(current.runs[0]!.attempts[0]).toMatchObject({ state: "running", completedAt: null });
  expect(current.runs[0]!.attempts[0]!.verdictRecovery).toBeUndefined();
});

test("a worker that dies after transcript discovery enters bounded verdict recovery", async () => {
  const h = harness();
  await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  h.setPaneAlive(false);
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.state).toBe("running");
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.verdictRecovery).toMatchObject({ state: "pending", checks: 1 });
  await exhaustVerdictRecovery(h);
  expect(loadPipelines()[0]!.state).toBe("needs_decision");
  expect(loadPipelines()[0]!.stateDetail).toContain("canonical stage transcript is not yet readable");
});

test("an unindexed rollout stays running while its structured host is alive and idle (#1109)", async () => {
  await withRuntimeSnapshot({
    sessions: [{
      conversationId: "conversation_stage_1",
      host: "hosted",
      turn: "idle",
      attentionIds: [],
    }],
  }, async () => {
    const h = harness();
    await runningStructuredStage(h);
    h.ports.conversationAgentActive = defaultPipelinePorts().conversationAgentActive;

    for (let tick = 0; tick < 4; tick += 1) {
      if (tick > 0) h.advanceWallClock(30_000);
      await tickPipelines([], h.ports);
    }

    const current = loadPipelines()[0]!;
    expect(current.state).toBe("running");
    expect(current.runs[0]!.attempts[0]).toMatchObject({
      state: "running",
      verdict: null,
    });
    expect(current.runs[0]!.attempts[0]!.verdictRecovery).toBeUndefined();
  });
});

test("a dead runtime snapshot cannot poison later hosted idle evidence in the same tick (#1109)", async () => {
  let snapshotReads = 0;
  await withRuntimeSnapshot((requestNumber) => {
    snapshotReads += 1;
    return {
      sessions: [{
        conversationId: "conversation_stage_1",
        host: requestNumber === 0 ? "dead" : "hosted",
        turn: "idle",
        attentionIds: [],
      }],
    };
  }, async () => {
    const h = harness();
    await runningStructuredStage(h);
    const runtimePorts = defaultPipelinePorts();
    let primedDeadProjection = false;
    h.ports.conversationAgentActive = async (conversationId) => {
      if (!primedDeadProjection) {
        primedDeadProjection = true;
        expect(await runtimePorts.conversationAgentActive(conversationId)).toBe(false);
      }
      return runtimePorts.conversationAgentActive(conversationId);
    };

    await tickPipelines([], h.ports);

    const current = loadPipelines()[0]!;
    expect(current.state).toBe("running");
    expect(current.runs[0]!.attempts[0]!.verdictRecovery).toBeUndefined();
    expect(snapshotReads).toBe(2);
  });
});

test("a phase-budget overrun cannot spend an unindexed transcript recovery check (#1109)", async () => {
  for (const overrun of ["before-read", "during-read"] as const) {
    const h = harness();
    await runningStructuredStage(h);
    let monotonicMs = 0;
    let durableReads = 0;
    h.setMonotonicClock(() => monotonicMs);
    h.ports.conversationAgentActive = async () => {
      if (overrun === "before-read") monotonicMs = 15_000;
      return false;
    };
    h.ports.durableTurnEvidence = async () => {
      durableReads += 1;
      if (overrun === "during-read") monotonicMs = 15_000;
      return null;
    };

    await tickPipelines([], h.ports);

    const current = loadPipelines()[0]!;
    expect(current.state).toBe("running");
    expect(current.runs[0]!.attempts[0]!.verdictRecovery).toBeUndefined();
    expect(durableReads).toBe(overrun === "before-read" ? 0 : 1);
  }
});

test("an unindexed rollout parks once its structured host is dead past grace (#1109)", async () => {
  const h = harness();
  await runningStructuredStage(h);
  h.setConversationActive(false);
  const unavailableSince = h.ports.now();
  h.ports.conversationHostUnavailableSince = async () => unavailableSince;
  h.advanceWallClock(5 * 60_000);

  await tickPipelines([], h.ports);

  const current = loadPipelines()[0]!;
  expect(current).toMatchObject({
    state: "needs_decision",
    stateDetail: "historical attempt completed without a valid final JSON verdict",
  });
  expect(current.runs[0]!.attempts[0]).toMatchObject({
    state: "failed",
    verdict: null,
    error: "historical attempt completed without a valid final JSON verdict",
  });
});

test("a stage whose host is proven dead becomes retryable without closing the pipeline (#1282)", async () => {
  const h = harness();
  await runningStructuredStage(h);
  h.setConversationActive(false);
  const unavailableSince = h.ports.now();
  h.ports.conversationHostUnavailableSince = async () => unavailableSince;
  h.advanceWallClock(5 * 60_000);

  await tickPipelines([], h.ports);

  /* Before #1282 the stage stayed `running` while its host sat there doing
     nothing, so retry-stage answered "pipeline does not have a stage awaiting
     retry" and the only way out was closing the pipeline.

     What this case pins is the engine's own behaviour once a host is proven
     dead: the liveness port is stubbed here, so it says nothing about whether
     that port ever reports the incident's host. The whole sequence — a live but
     severed child, the runtime kill, the registry retirement, this tick and
     `retry-stage` — runs through the production seams in
     `src/lib/pipelines/severedStageRetry.test.ts`. */
  const parked = loadPipelines()[0]!;
  expect(parked.state).toBe("needs_decision");
  const failedAttempt = parked.runs[0]!.attempts[0]!;
  h.ports.spawnReceipt = (candidate) => candidate === failedAttempt.launchId ? {
    state: "completed",
    launchId: failedAttempt.launchId!,
    conversationId: failedAttempt.conversationId!,
    sessionId: failedAttempt.sessionId,
    "transcript": failedAttempt.agentPath,
    paneId: failedAttempt.paneId,
  } : null;
  const retried = await patchPipeline(parked.id, { action: "retry-stage" }, h.ports);

  expect(retried.error).toBeUndefined();
  expect(retried.pipeline?.state).not.toBe("closed");
  expect(loadPipelines()[0]!.state).not.toBe("needs_decision");
});

test("a stage stays non-retryable while automatic host retirement is unconfirmed (#1296)", async () => {
  const h = harness();
  await runningStructuredStage(h);
  h.setConversationActive(false);
  const unavailableSince = h.ports.now();
  h.ports.conversationHostUnavailableSince = async () => unavailableSince;
  h.ports.stopStageAgent = async () => ({
    outcome: "unconfirmed",
    operationId: "fixture-kill",
    detail: "fixture termination remains in flight",
  });
  h.advanceWallClock(5 * 60_000);

  await tickPipelines([], h.ports);

  const current = loadPipelines()[0]!;
  expect(current).toMatchObject({
    state: "running",
    stateDetail: "automatic recovery is waiting for the unavailable stage host to terminate",
  });
  expect(current.runs[0]!.attempts[0]).toMatchObject({ state: "running", completedAt: null });
  const retry = await patchPipeline(current.id, { action: "retry-stage" }, h.ports);
  expect(retry).toMatchObject({ error: "pipeline does not have a stage awaiting retry", status: 409 });
});

test("an exhausted false park ingests its live host's late verdict without a duplicate attempt (#1109)", async () => {
  const h = harness();
  await runningStructuredStage(h);
  h.setConversationActive(true);
  const stored = loadPipelines()[0]!;
  const attempt = stored.runs[0]!.attempts[0]!;
  const parkedAt = h.ports.now();
  attempt.state = "needs_decision";
  attempt.completedAt = parkedAt;
  attempt.error = "stage verdict recovery exhausted after 3 checks: canonical stage transcript is not yet readable after structured stage termination";
  attempt.verdictRecovery = {
    state: "exhausted",
    checks: 3,
    maxChecks: 3,
    startedAt: parkedAt,
    lastCheckedAt: parkedAt,
    nextCheckAt: null,
    reason: "canonical stage transcript is not yet readable after structured stage termination",
    messageTs: null,
  };
  stored.state = "needs_decision";
  stored.stateDetail = attempt.error;
  savePipelines([stored]);
  h.durableTurns.set("/codex/stage-1.jsonl", {
    turn: "terminal",
    message: { text: PASS_TEXT, ts: 5_000_000 },
  });

  await tickPipelines([], h.ports);

  const recovered = loadPipelines()[0]!;
  expect(recovered.cursor).toEqual({
    stageId: "build",
    state: "running",
    input: "integration complete",
    activatedBy: { stageId: "plan", attempt: 1, edge: "pass" },
  });
  expect(recovered.runs[0]!.attempts).toHaveLength(1);
  expect(recovered.runs[0]!.attempts[0]).toMatchObject({
    state: "passed",
    verdict: { status: "pass", confidence: 0.9 },
    verdictRecovery: { state: "recovered", checks: 3, messageTs: 5_000_000 },
  });
  expect(recovered.runs[1]!.attempts).toHaveLength(1);
  expect(h.calls.filter((call) => call.startsWith("spawn:"))).toHaveLength(2);
});

test("a dead structured host past grace fails through the stage fail edge (#973)", async () => {
  const h = harness();
  await create(h.ports, [
    { id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build", next: null, onFail: { to: "recover", maxRounds: 1 } },
    { id: "recover", kind: "run", role: { roleId: "builder" }, prompt: "Recover {{prev.output}}", next: null },
  ] as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  const running = loadPipelines()[0]!;
  running.runs[0]!.attempts[0]!.paneId = null;
  savePipelines([running]);
  const unavailableSince = h.ports.now();
  Object.assign(h.ports, {
    conversationHostUnavailableSince: async () => unavailableSince,
  });

  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.state).toBe("running");

  h.advanceWallClock(5 * 60_000);
  await tickPipelines([], h.ports);

  const current = loadPipelines()[0]!;
  expect(current.state).toBe("running");
  expect(current.runs[0]!.attempts[0]).toMatchObject({
    state: "failed",
    verdict: null,
    error: "historical attempt completed without a valid final JSON verdict",
  });
  expect(current.cursor).toEqual({
    stageId: "recover",
    state: "pending",
    input: "historical attempt completed without a valid final JSON verdict",
    activatedBy: { stageId: "build", attempt: 1, edge: "fail" },
  });
});

test("a dead structured host with an invalid terminal verdict still takes the fail edge (#973)", async () => {
  const h = harness();
  await create(h.ports, [
    { id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build", next: null, onFail: { to: "recover", maxRounds: 1 } },
    { id: "recover", kind: "run", role: { roleId: "builder" }, prompt: "Recover {{prev.output}}", next: null },
  ] as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  const running = loadPipelines()[0]!;
  running.runs[0]!.attempts[0]!.paneId = null;
  savePipelines([running]);
  h.durableTurns.set("/codex/stage-1.jsonl", {
    turn: "terminal",
    message: { text: "Finished without a structured verdict", ts: 5_000_000 },
  });
  const unavailableSince = h.ports.now();
  Object.assign(h.ports, {
    conversationHostUnavailableSince: async () => unavailableSince,
  });

  h.advanceWallClock(5 * 60_000);
  await tickPipelines([], h.ports);

  const current = loadPipelines()[0]!;
  expect(current.state).toBe("running");
  expect(current.runs[0]!.attempts[0]).toMatchObject({
    state: "failed",
    verdict: null,
    error: "historical attempt completed without a valid final JSON verdict",
  });
  expect(current.cursor).toEqual({
    stageId: "recover",
    state: "pending",
    input: "historical attempt completed without a valid final JSON verdict",
    activatedBy: { stageId: "build", attempt: 1, edge: "fail" },
  });
});

test("a dead structured host with a contradictory verdict still takes the fail edge (#973)", async () => {
  const h = harness();
  await create(h.ports, [
    { id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build", next: null, onFail: { to: "recover", maxRounds: 1 } },
    { id: "recover", kind: "run", role: { roleId: "builder" }, prompt: "Recover {{prev.output}}", next: null },
  ] as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  const running = loadPipelines()[0]!;
  running.runs[0]!.attempts[0]!.paneId = null;
  savePipelines([running]);
  h.durableTurns.set("/codex/stage-1.jsonl", {
    turn: "terminal",
    message: {
      text: "VERDICT: REQUEST_CHANGES\n\n```json\n{\"status\":\"pass\"}\n```",
      ts: 5_000_000,
    },
  });
  const unavailableSince = h.ports.now();
  Object.assign(h.ports, {
    conversationHostUnavailableSince: async () => unavailableSince,
  });

  h.advanceWallClock(5 * 60_000);
  await tickPipelines([], h.ports);

  const current = loadPipelines()[0]!;
  expect(current.state).toBe("running");
  expect(current.runs[0]!.attempts[0]).toMatchObject({
    state: "failed",
    verdict: null,
    error: "historical attempt completed without a valid final JSON verdict",
  });
  expect(current.cursor).toEqual({
    stageId: "recover",
    state: "pending",
    input: "historical attempt completed without a valid final JSON verdict",
    activatedBy: { stageId: "build", attempt: 1, edge: "fail" },
  });
});

test("a dead structured host past grace still accepts a valid terminal verdict (#973)", async () => {
  const h = harness();
  await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  const running = loadPipelines()[0]!;
  running.runs[0]!.attempts[0]!.paneId = null;
  savePipelines([running]);
  h.durableTurns.set("/codex/stage-1.jsonl", {
    turn: "terminal",
    message: {
      text: "Completed\n\n```json\n{\"status\":\"pass\"}\n```",
      ts: 5_000_000,
    },
  });
  const unavailableSince = h.ports.now();
  Object.assign(h.ports, {
    conversationHostUnavailableSince: async () => unavailableSince,
  });

  h.advanceWallClock(5 * 60_000);
  await tickPipelines([], h.ports);

  const current = loadPipelines()[0]!;
  expect(current.runs[0]!.attempts[0]).toMatchObject({
    state: "passed",
    output: "Completed",
    verdict: { status: "pass" },
    error: null,
  });
  expect(current.cursor).toEqual({
    stageId: "build",
    state: "pending",
    input: "Completed",
    activatedBy: { stageId: "plan", attempt: 1, edge: "pass" },
  });
});

test("an inactive transcript with no verdict exhausts bounded recovery after its worker exits", async () => {
  const h = harness();
  await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  h.setPaneAlive(false);
  const entries = [entry("/codex/stage-1.jsonl")];
  await tickPipelines(entries, h.ports);
  expect(loadPipelines()[0]!.state).toBe("running");
  await exhaustVerdictRecovery(h, entries);
  expect(loadPipelines()[0]!.state).toBe("needs_decision");
  expect(loadPipelines()[0]!.stateDetail).toContain("completed assistant turn has not been ingested");
});

test("an ended structured stage overrides a stale live marker with bounded transcript recovery", async () => {
  const h = harness();
  await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  const pipeline = loadPipelines()[0]!;
  pipeline.runs[0]!.attempts[0]!.paneId = null;
  savePipelines([pipeline]);
  h.setConversationActive(false);

  const entries: FileEntry[] = [{
    ...entry("/codex/stage-1.jsonl"),
    activity: "live",
    activityReason: "jsonl_turn_open",
  }];
  await tickPipelines(entries, h.ports);

  expect(loadPipelines()[0]!.state).toBe("running");
  await exhaustVerdictRecovery(h, entries);
  expect(loadPipelines()[0]!.state).toBe("needs_decision");
  expect(loadPipelines()[0]!.stateDetail).toContain("completed assistant turn has not been ingested");
});

/* #337 durable convergence fixtures: a structured stage attempt (no pane) whose
   completion authority is the transcript artifact itself. */
const STAGE_HEAD = "f8aa42dc90b04d34a1f2a5f3f8c2f6b7c9d0e1a2";
const PASS_TEXT = "integration complete\n\n```json\n{\"status\":\"pass\",\"confidence\":0.9}\n```";

function makeStructuredAttempt() {
  const pipeline = loadPipelines()[0]!;
  pipeline.runs[0]!.attempts[0]!.paneId = null;
  savePipelines([pipeline]);
}

/** The production projection shape (#337): scanner resource-scope inheritance
    keeps the transcript `jsonl_turn_stalled` at its final byte size forever. */
function stalledEntry(pathname: string): FileEntry {
  return { ...entry(pathname), activity: "stalled", activityReason: "jsonl_turn_stalled" };
}

function countDurableReads(h: ReturnType<typeof harness>): () => number {
  let reads = 0;
  const base = h.ports.durableTurnEvidence;
  h.ports.durableTurnEvidence = async (engine, transcriptPath) => {
    reads += 1;
    return base(engine, transcriptPath);
  };
  return () => reads;
}

function pinStageHead(h: ReturnType<typeof harness>) {
  const baseExec = h.ports.exec;
  h.ports.exec = (rawCommand, rawArgs, cwd) => {
    const args = rawCommand === "timeout" ? rawArgs.slice(rawArgs.indexOf("git") + 1) : rawArgs;
    if (args[0] === "rev-parse" && args[1] === "HEAD") return { code: 0, stdout: `${STAGE_HEAD}\n`, stderr: "" };
    /* The remote carries the same stage commit: these tests are about durable
       turn evidence, not publication, so origin is modelled as already current
       and publication short-circuits without a push. */
    if (args[0] === "ls-remote") {
      return { code: 0, stdout: `${STAGE_HEAD}\trefs/heads/${loadPipelines()[0]?.branch ?? "pipeline/test"}\n`, stderr: "" };
    }
    return baseExec(rawCommand, rawArgs, cwd);
  };
}

/** Provision + spawn the first stage, then strip its pane so the attempt is a
    structured host, and pin later HEAD reads to the stage's own commit. */
async function runningStructuredStage(h: ReturnType<typeof harness>) {
  const pipeline = await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  makeStructuredAttempt();
  pinStageHead(h);
  return pipeline;
}

test("fa6aa690 parked production state reconciles its canonical verdict and advances once (#356)", async () => {
  const h = harness();
  await create(h.ports, [
    { id: "diagnose_and_fix", kind: "run", role: { roleId: "builder" }, engine: "codex", access: "read-write", prompt: "Fix the defect", next: "review_phase0" },
    { id: "review_phase0", kind: "review-loop", role: { roleId: "reviewer" }, access: "read-only", prompt: "Review the fix", next: null },
  ] as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  makeStructuredAttempt();
  pinStageHead(h);

  const persisted = loadPipelines()[0]!;
  const attempt = persisted.runs[0]!.attempts[0]!;
  attempt.state = "needs_decision";
  attempt.error = "stage completed without a valid final JSON verdict";
  persisted.state = "needs_decision";
  persisted.stateDetail = attempt.error;
  savePipelines([persisted]);
  expect(persisted.runs[1]!.attempts).toHaveLength(0);

  h.setConversationActive(false);
  h.durableTurns.set("/codex/stage-1.jsonl", {
    turn: "terminal",
    message: {
      text: [
        "All focused gates passed.",
        "",
        "```json",
        JSON.stringify({
          status: "pass",
          findings: [],
          confidence: 0.97,
          headSha: STAGE_HEAD,
          prNumber: 1,
          redProvenTests: ["canonical verdict replay"],
          buildExitsZero: true,
        }),
        "```",
      ].join("\n"),
      ts: 5_000_000,
    },
  });

  await tickPipelines([], h.ports);
  let current = loadPipelines()[0]!;
  expect(current.cursor).toEqual({
    stageId: "review_phase0",
    state: "pending",
    input: "All focused gates passed.",
    activatedBy: { stageId: "diagnose_and_fix", attempt: 1, edge: "pass" },
  });
  expect(current.runs[0]!.attempts).toHaveLength(1);
  expect(current.runs[0]!.attempts[0]).toMatchObject({
    state: "passed",
    verdict: { status: "pass", findings: [], confidence: 0.97 },
  });
  expect(current.runs[1]!.attempts).toHaveLength(0);
  expect(current.lastPassedCommit).toBe(STAGE_HEAD);

  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  current = loadPipelines()[0]!;
  expect(current.runs[0]!.attempts).toHaveLength(1);
  expect(current.runs[1]!.attempts).toHaveLength(1);
  expect(h.calls.filter((call) => call.startsWith("flow:"))).toHaveLength(1);
});

test("a terminal parser miss receives three spaced evaluations before an auditable terminal state", async () => {
  const h = harness();
  await runningStructuredStage(h);
  h.setConversationActive(false);
  h.durableTurns.set("/codex/stage-1.jsonl", {
    turn: "terminal",
    message: { text: "Completion summary without a fenced verdict.", ts: 5_000_000 },
  });

  await tickPipelines([], h.ports);
  let current = loadPipelines()[0]!;
  expect(current.state).toBe("running");
  expect(current.runs[0]!.attempts[0]).toMatchObject({
    state: "running",
    verdictRecovery: {
      state: "pending",
      checks: 1,
      maxChecks: 3,
      reason: "canonical completed assistant turn is missing a fenced JSON verdict",
    },
  });

  await tickPipelines([], h.ports);
  current = loadPipelines()[0]!;
  expect(current.runs[0]!.attempts[0]).toMatchObject({
    state: "running",
    verdictRecovery: { state: "pending", checks: 1 },
  });

  h.advanceWallClock(30_000);
  await tickPipelines([], h.ports);
  current = loadPipelines()[0]!;
  expect(current.runs[0]!.attempts[0]).toMatchObject({
    state: "running",
    verdictRecovery: { state: "pending", checks: 2 },
  });

  h.advanceWallClock(30_000);
  await tickPipelines([], h.ports);
  current = loadPipelines()[0]!;
  expect(current.state).toBe("needs_decision");
  expect(current.stateDetail).toBe(
    "stage verdict recovery exhausted after 3 checks: canonical completed assistant turn is missing a fenced JSON verdict",
  );
  expect(current.runs[0]!.attempts[0]).toMatchObject({
    state: "needs_decision",
    verdictRecovery: { state: "exhausted", checks: 3 },
    error: current.stateDetail,
  });
  expect(h.calls.some((call) => call.includes("reset --hard") || call.includes("clean -fd"))).toBe(false);
});

test("a later completed turn in the same conversation supersedes the parser miss after restart (#515)", async () => {
  const h = harness();
  await runningStructuredStage(h);
  h.setConversationActive(false);
  h.durableTurns.set("/codex/stage-1.jsonl", {
    turn: "terminal",
    message: { text: "The first completed turn was interrupted before its verdict.", ts: 5_000_000 },
  });

  await tickPipelines([], h.ports);
  let current = loadPipelines()[0]!;
  expect(current.state).toBe("running");
  expect(current.runs[0]!.attempts[0]).toMatchObject({
    state: "running",
    verdictRecovery: { state: "pending", checks: 1, messageTs: 5_000_000 },
  });

  /* A fresh controller process would reconstruct exclusively from this store
     record and the conversation's latest durable transcript. */
  savePipelines(loadPipelines());
  h.durableTurns.set("/codex/stage-1.jsonl", {
    turn: "terminal",
    message: { text: PASS_TEXT, ts: 5_100_000 },
  });
  await tickPipelines([], h.ports);

  current = loadPipelines()[0]!;
  expect(current.cursor).toEqual({
    stageId: "build",
    state: "pending",
    input: "integration complete",
    activatedBy: { stageId: "plan", attempt: 1, edge: "pass" },
  });
  expect(current.runs[0]!.attempts).toHaveLength(1);
  expect(current.runs[0]!.attempts[0]).toMatchObject({
    state: "passed",
    verdict: { status: "pass", confidence: 0.9 },
    verdictRecovery: { state: "recovered", checks: 1, messageTs: 5_100_000 },
  });
  expect(current.lastPassedCommit).toBe(STAGE_HEAD);
});

test("newer same-conversation evidence supersedes an exhausted recovery exactly once (#515)", async () => {
  const h = harness();
  await runningStructuredStage(h);
  h.setConversationActive(false);
  h.durableTurns.set("/codex/stage-1.jsonl", {
    turn: "terminal",
    message: { text: "No fenced verdict was produced.", ts: 5_000_000 },
  });
  await tickPipelines([], h.ports);
  await exhaustVerdictRecovery(h);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.verdictRecovery).toMatchObject({
    state: "exhausted",
    checks: 3,
    messageTs: 5_000_000,
  });

  h.durableTurns.set("/codex/stage-1.jsonl", {
    turn: "terminal",
    message: { text: PASS_TEXT, ts: 5_100_000 },
  });
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);

  const current = loadPipelines()[0]!;
  expect(current.runs[0]!.attempts).toHaveLength(1);
  expect(current.runs[0]!.attempts[0]).toMatchObject({
    state: "passed",
    verdict: { status: "pass", confidence: 0.9 },
    verdictRecovery: { state: "recovered", checks: 3, messageTs: 5_100_000 },
  });
  expect(current.runs[1]!.attempts).toHaveLength(1);
  expect(h.calls.filter((call) => call.startsWith("spawn:"))).toHaveLength(2);
  expect(current.lastPassedCommit).toBe(STAGE_HEAD);
});

test("verdict recovery normalizes object findings and still rejects a missing core status (#879)", async () => {
  const accepted = harness();
  await runningStructuredStage(accepted);
  accepted.setConversationActive(false);
  accepted.durableTurns.set("/codex/stage-1.jsonl", {
    turn: "terminal",
    message: {
      text: [
        "The review found one defect.",
        "",
        "```json",
        JSON.stringify({
          status: "fail",
          findings: [{ severity: "medium", file: "src/lib/example.ts", line: 57, summary: "Preserve the accepted revision." }],
          confidence: 0.87,
        }),
        "```",
      ].join("\n"),
      ts: 5_000_000,
    },
  });

  await tickPipelines([], accepted.ports);

  expect(loadPipelines()[0]!.runs[0]!.attempts[0]).toMatchObject({
    state: "failed",
    verdict: {
      status: "fail",
      findings: ["medium — src/lib/example.ts:57 — Preserve the accepted revision."],
      confidence: 0.87,
    },
  });

  const rejected = harness();
  await runningStructuredStage(rejected);
  rejected.setConversationActive(false);
  rejected.durableTurns.set("/codex/stage-1.jsonl", {
    turn: "terminal",
    message: {
      text: `\`\`\`json\n${JSON.stringify({ findings: [{ severity: "medium", summary: "Missing status." }], confidence: 0.87 })}\n\`\`\``,
      ts: 5_000_000,
    },
  });

  await tickPipelines([], rejected.ports);

  expect(loadPipelines()[0]!.runs[0]!.attempts[0]).toMatchObject({
    state: "running",
    verdict: null,
    verdictRecovery: {
      state: "pending",
      reason: "canonical completed assistant turn is missing a valid status, findings, or confidence field",
    },
  });
});

test("terminal ingestion after process exit advances a trailing-marker verdict once after restart (#707)", async () => {
  const h = harness();
  await runningStructuredStage(h);
  h.setConversationActive(false);
  h.durableTurns.set("/codex/stage-1.jsonl", {
    turn: "terminal",
    message: { text: "Process exit became visible before terminal transcript ingestion.", ts: 5_000_000 },
  });

  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]).toMatchObject({
    state: "running",
    verdictRecovery: { state: "pending", checks: 1 },
  });

  savePipelines(loadPipelines());
  h.durableTurns.set("/codex/stage-1.jsonl", {
    turn: "terminal",
    message: {
      text: `${PASS_TEXT}\nREVIEW_READY: published branch`,
      ts: 5_100_000,
    },
  });
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);

  const current = loadPipelines()[0]!;
  expect(current.runs[0]!.attempts).toHaveLength(1);
  expect(current.runs[0]!.attempts[0]).toMatchObject({
    state: "passed",
    verdictRecovery: { state: "recovered", checks: 1 },
  });
  expect(current.runs[1]!.attempts).toHaveLength(1);
  expect(h.calls.filter((call) => call.startsWith("spawn:"))).toHaveLength(2);
  expect(current.lastPassedCommit).toBe(STAGE_HEAD);
});

test("paused verdict recovery accepts canonical evidence after resume without resetting work", async () => {
  const h = harness();
  const pipeline = await runningStructuredStage(h);
  h.setConversationActive(false);
  h.durableTurns.set("/codex/stage-1.jsonl", {
    turn: "terminal",
    message: { text: "No fenced verdict was produced.", ts: 5_000_000 },
  });
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.verdictRecovery).toMatchObject({ state: "pending", checks: 1 });

  expect((await patchPipeline(pipeline.id, { action: "pause" }, h.ports)).pipeline?.state).toBe("paused");
  h.durableTurns.set("/codex/stage-1.jsonl", {
    turn: "terminal",
    message: { text: PASS_TEXT, ts: 5_100_000 },
  });
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.state).toBe("paused");
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.verdict).toBeNull();

  expect((await patchPipeline(pipeline.id, { action: "resume" }, h.ports)).pipeline?.state).toBe("running");
  await tickPipelines([], h.ports);
  const current = loadPipelines()[0]!;
  expect(current.runs[0]!.attempts[0]).toMatchObject({
    state: "passed",
    verdictRecovery: { state: "recovered", checks: 1, messageTs: 5_100_000 },
  });
  expect(current.lastPassedCommit).toBe(STAGE_HEAD);
  expect(h.calls.some((call) => call.includes("reset --hard") || call.includes("clean -fd"))).toBe(false);
});

test("verdict recovery follows conversation generation rollover after transcript compaction", async () => {
  const h = harness();
  await runningStructuredStage(h);
  h.setConversationActive(false);
  h.durableTurns.set("/codex/stage-1.jsonl", {
    turn: "terminal",
    message: { text: "No fenced verdict was produced.", ts: 5_000_000 },
  });
  await tickPipelines([], h.ports);

  const compactedPath = "/codex/stage-1-compacted.jsonl";
  const stageConversation = loadPipelines()[0]!.runs[0]!.attempts[0]!.conversationId;
  h.ports.pathForConversation = (id) => id === stageConversation ? compactedPath : null;
  h.durableTurns.set(compactedPath, {
    turn: "terminal",
    message: { text: PASS_TEXT, ts: 5_100_000 },
  });
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);

  const current = loadPipelines()[0]!;
  expect(current.runs[0]!.attempts).toHaveLength(1);
  expect(current.runs[0]!.attempts[0]).toMatchObject({
    agentPath: compactedPath,
    state: "passed",
    verdictRecovery: { state: "recovered", checks: 1 },
  });
  expect(current.runs[1]!.attempts).toHaveLength(1);
  expect(h.calls.filter((call) => call.startsWith("spawn:"))).toHaveLength(2);
  expect(current.lastPassedCommit).toBe(STAGE_HEAD);
});

test("a durable terminal pass verdict settles a stage despite a stale running runtime ledger (#337, pipeline 0ec6eab0)", async () => {
  const h = harness();
  await runningStructuredStage(h);
  /* The runtime session ledger never observed the end of the turn. */
  h.setConversationActive(true);
  h.durableTurns.set("/codex/stage-1.jsonl", {
    turn: "terminal",
    message: { text: PASS_TEXT, ts: 5_000_000 },
  });

  await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);

  const current = loadPipelines()[0]!;
  expect(current.state).toBe("running");
  expect(current.stateDetail).toBeNull();
  expect(current.cursor).toEqual({ stageId: "build", state: "pending", input: "integration complete", activatedBy: { stageId: "plan", attempt: 1, edge: "pass" } });
  /* The actual clean stage HEAD advances, not the pipeline base. */
  expect(current.lastPassedCommit).toBe(STAGE_HEAD);
  expect(current.runs[0]!.attempts[0]).toMatchObject({
    state: "passed",
    output: "integration complete",
    verdict: { status: "pass", confidence: 0.9 },
  });
  expect(current.runs[0]!.attempts[0]!.completedAt).toBeTruthy();
});

test("scanner projection loss cannot park a durably completed stage (#337, pipelines fdbea289/4dd0e775)", async () => {
  const h = harness();
  await runningStructuredStage(h);
  /* Host already terminal; the transcript vanished from the scan projection
     while still existing at its durable agentPath. */
  h.setConversationActive(false);
  h.durableTurns.set("/codex/stage-1.jsonl", {
    turn: "terminal",
    message: { text: PASS_TEXT, ts: 5_000_000 },
  });

  await tickPipelines([], h.ports);

  const current = loadPipelines()[0]!;
  expect(current.state).toBe("running");
  expect(current.cursor).toEqual({ stageId: "build", state: "pending", input: "integration complete", activatedBy: { stageId: "plan", attempt: 1, edge: "pass" } });
  expect(current.lastPassedCommit).toBe(STAGE_HEAD);
  expect(current.runs[0]!.attempts[0]!.state).toBe("passed");
  /* No reset happened on the way through: the committed work survives. */
  expect(h.calls.some((call) => call.includes("reset --hard"))).toBe(false);
});

test("projection loss over a readable mid-turn artifact keeps waiting instead of parking", async () => {
  const h = harness();
  await runningStructuredStage(h);
  h.setConversationActive(false);
  h.durableTurns.set("/codex/stage-1.jsonl", { turn: "busy", message: null });

  await tickPipelines([], h.ports);

  const current = loadPipelines()[0]!;
  expect(current.state).toBe("running");
  expect(current.runs[0]!.attempts[0]!.state).toBe("running");
});

test("a mid-work message on a recovered idle host never terminalizes the attempt (#337 restart invariant)", async () => {
  const h = harness();
  await runningStructuredStage(h);
  /* Recovered idle broker: the ledger reports not-running while the durable
     transcript still shows an open turn with a mid-work trailing message. */
  h.setConversationActive(false);
  h.messages.set("/codex/stage-1.jsonl", { text: "midway through applying the fix", ts: 5_000_000 });
  h.durableTurns.set("/codex/stage-1.jsonl", {
    turn: "busy",
    message: { text: "midway through applying the fix", ts: 5_000_000 },
  });

  await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);

  const current = loadPipelines()[0]!;
  expect(current.state).toBe("running");
  expect(current.runs[0]!.attempts[0]!.state).toBe("running");
});

test("a durable busy turn blocks scanner-message settlement even for a parseable verdict (#337 seam)", async () => {
  for (const status of ["pass", "fail"] as const) {
    const h = harness();
    await runningStructuredStage(h);
    /* Recovered idle broker over a still-open turn whose trailing scanner
       message happens to be a syntactically valid fenced verdict. */
    h.setConversationActive(false);
    const scanEntry = h.finish("/codex/stage-1.jsonl", status);
    h.durableTurns.set("/codex/stage-1.jsonl", {
      turn: "busy",
      message: h.messages.get("/codex/stage-1.jsonl")!,
    });

    await tickPipelines([scanEntry], h.ports);

    const current = loadPipelines()[0]!;
    expect(current.state).toBe("running");
    expect(current.runs[0]!.attempts[0]!.state).toBe("running");
    expect(current.runs[0]!.attempts[0]!.verdict).toBeNull();
  }
});

test("a pane-less stalled projection with a stuck running runtime ledger settles from durable terminal evidence (#337 production shape)", async () => {
  const h = harness();
  await runningStructuredStage(h);
  /* Production shape: the transcript ended in a fenced verdict plus trailing
     bookkeeping records, the scan projects jsonl_turn_stalled at the final
     size, and the runtime session ledger stays stuck `running` forever. */
  h.setConversationActive(true);
  h.durableTurns.set("/codex/stage-1.jsonl", {
    turn: "terminal",
    message: { text: PASS_TEXT, ts: 5_000_000 },
  });

  await tickPipelines([stalledEntry("/codex/stage-1.jsonl")], h.ports);

  const current = loadPipelines()[0]!;
  expect(current.state).toBe("running");
  expect(current.cursor).toEqual({ stageId: "build", state: "pending", input: "integration complete", activatedBy: { stageId: "plan", attempt: 1, edge: "pass" } });
  expect(current.lastPassedCommit).toBe(STAGE_HEAD);
  expect(current.runs[0]!.attempts[0]).toMatchObject({
    state: "passed",
    output: "integration complete",
    verdict: { status: "pass", confidence: 0.9 },
  });

  /* Settles exactly once: the frozen stalled projection on later wake-ups
     neither re-settles nor appends attempts — history stays append-only. */
  await tickPipelines([stalledEntry("/codex/stage-1.jsonl")], h.ports);
  await tickPipelines([stalledEntry("/codex/stage-1.jsonl")], h.ports);
  expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(1);
  expect(h.calls.filter((call) => call.startsWith("spawn:")).length).toBe(2);
});

test("a restart-primed stalled cache at final size settles without a runtime session (#337)", async () => {
  const h = harness();
  await runningStructuredStage(h);
  /* Restart: the scan cache re-primes busy at the final size and the fresh
     runtime host has no session for the conversation (ledger answers null). */
  h.setConversationActive(null);
  h.durableTurns.set("/codex/stage-1.jsonl", {
    turn: "terminal",
    message: { text: PASS_TEXT, ts: 5_000_000 },
  });

  await tickPipelines([stalledEntry("/codex/stage-1.jsonl")], h.ports);

  const current = loadPipelines()[0]!;
  expect(current.state).toBe("running");
  expect(current.cursor).toEqual({ stageId: "build", state: "pending", input: "integration complete", activatedBy: { stageId: "plan", attempt: 1, edge: "pass" } });
  expect(current.lastPassedCommit).toBe(STAGE_HEAD);
  expect(current.runs[0]!.attempts[0]!.state).toBe("passed");
});

test("a genuinely busy durable turn keeps a stalled pane-less attempt running (#337)", async () => {
  for (const active of [true, null] as const) {
    const h = harness();
    await runningStructuredStage(h);
    h.setConversationActive(active);
    /* The trailing scanner message even parses as a verdict; the durable open
       turn (open tool call or a later user follow-up) still blocks settlement. */
    h.finish("/codex/stage-1.jsonl", "pass");
    h.durableTurns.set("/codex/stage-1.jsonl", {
      turn: "busy",
      message: h.messages.get("/codex/stage-1.jsonl")!,
    });

    await tickPipelines([stalledEntry("/codex/stage-1.jsonl")], h.ports);

    const current = loadPipelines()[0]!;
    expect(current.state).toBe("running");
    expect(current.runs[0]!.attempts[0]!.state).toBe("running");
    expect(current.runs[0]!.attempts[0]!.verdict).toBeNull();
  }
});

test("live and open-turn projections never consult the durable read (#337 cheap path)", async () => {
  const h = harness();
  await runningStructuredStage(h);
  h.setConversationActive(null);
  const reads = countDurableReads(h);
  h.durableTurns.set("/codex/stage-1.jsonl", {
    turn: "terminal",
    message: { text: PASS_TEXT, ts: 5_000_000 },
  });

  await tickPipelines([{ ...entry("/codex/stage-1.jsonl"), activity: "live", activityReason: "jsonl_turn_open" }], h.ports);
  await tickPipelines([{ ...entry("/codex/stage-1.jsonl"), activity: "live", activityReason: "mtime_fresh" }], h.ports);

  expect(reads()).toBe(0);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.state).toBe("running");
});

test("a pane-hosted stalled attempt keeps the cheap return without a durable read", async () => {
  const h = harness();
  await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  const reads = countDurableReads(h);
  h.durableTurns.set("/codex/stage-1.jsonl", {
    turn: "terminal",
    message: { text: PASS_TEXT, ts: 5_000_000 },
  });

  await tickPipelines([stalledEntry("/codex/stage-1.jsonl")], h.ports);

  expect(reads()).toBe(0);
  const current = loadPipelines()[0]!;
  expect(current.state).toBe("running");
  expect(current.runs[0]!.attempts[0]!.state).toBe("running");
  expect(current.runs[0]!.attempts[0]!.verdict).toBeNull();
});

test("a genuinely terminal turn without a valid verdict exhausts recovery and preserves the attempt receipt", async () => {
  const h = harness();
  await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  makeStructuredAttempt();
  h.setConversationActive(false);
  h.durableTurns.set("/codex/stage-1.jsonl", {
    turn: "terminal",
    message: { text: "should I proceed with plan A or plan B?", ts: 5_000_000 },
  });

  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.state).toBe("running");
  await exhaustVerdictRecovery(h);
  const parked = loadPipelines()[0]!;
  expect(parked.state).toBe("needs_decision");
  expect(parked.stateDetail).toContain("recovery exhausted after 3 checks");
  const attempt = parked.runs[0]!.attempts[0]!;
  expect(attempt.state).toBe("needs_decision");
  expect(attempt.verdictRecovery).toMatchObject({ state: "exhausted", checks: 3 });
  expect(attempt.launchId).toBeTruthy();
  expect(attempt.conversationId).toBeTruthy();
  expect(attempt.agentPath).toBe("/codex/stage-1.jsonl");
});

test("a durable fail verdict parks with the verdict receipt preserved", async () => {
  const h = harness();
  await runningStructuredStage(h);
  h.setConversationActive(true);
  h.durableTurns.set("/codex/stage-1.jsonl", {
    turn: "terminal",
    message: { text: "blocked\n\n```json\n{\"status\":\"fail\",\"findings\":[\"tests are red\"]}\n```", ts: 5_000_000 },
  });

  await tickPipelines([], h.ports);

  const current = loadPipelines()[0]!;
  expect(current.state).toBe("needs_decision");
  expect(current.stateDetail).toBe("tests are red");
  expect(current.runs[0]!.attempts[0]).toMatchObject({
    state: "failed",
    verdict: { status: "fail", findings: ["tests are red"] },
  });
});

test("a contradictory durable pass verdict parks with the parser failure reason", async () => {
  const h = harness();
  await runningStructuredStage(h);
  h.setConversationActive(true);
  h.durableTurns.set("/codex/stage-1.jsonl", {
    turn: "terminal",
    message: {
      text: [
        "VERDICT: REQUEST_CHANGES",
        "",
        "- [P1] Preserve the failed review",
        "",
        "```json",
        '{"status":"pass","findings":["Preserve the failed review"]}',
        "```",
      ].join("\n"),
      ts: 5_000_000,
    },
  });

  await tickPipelines([], h.ports);

  const reason = 'contradictory stage verdict: status "pass" cannot include findings';
  const current = loadPipelines()[0]!;
  expect(current.state).toBe("needs_decision");
  expect(current.stateDetail).toBe(reason);
  expect(current.cursor).toEqual({ stageId: "plan", state: "running", input: null, activatedBy: null });
  expect(current.lastPassedCommit).toBe(ORIGIN_MAIN_SHA);
  expect(current.runs[0]!.attempts[0]).toMatchObject({
    state: "needs_decision",
    output: "VERDICT: REQUEST_CHANGES\n\n- [P1] Preserve the failed review",
    verdict: null,
    error: reason,
  });
});

test("durable settlement is idempotent across repeated wake-up ticks", async () => {
  const h = harness();
  await runningStructuredStage(h);
  h.setConversationActive(true);
  h.durableTurns.set("/codex/stage-1.jsonl", {
    turn: "terminal",
    message: { text: PASS_TEXT, ts: 5_000_000 },
  });

  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.cursor).toEqual({ stageId: "build", state: "pending", input: "integration complete", activatedBy: { stageId: "plan", attempt: 1, edge: "pass" } });
  /* The next wake-up materializes the build attempt; further wake-ups with the
     same durable evidence neither re-settle nor duplicate anything. */
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);

  const current = loadPipelines()[0]!;
  expect(current.runs[0]!.attempts).toHaveLength(1);
  expect(current.runs[0]!.attempts[0]!.state).toBe("passed");
  expect(current.runs[1]!.attempts).toHaveLength(1);
  expect(current.lastPassedCommit).toBe(STAGE_HEAD);
  expect(h.calls.filter((call) => call.startsWith("spawn:")).length).toBe(2);
});

test("a pass that advances to a pending stage schedules its own follow-up tick (#337, pipeline a91b4562)", async () => {
  const h = harness();
  await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  let ticks = 0;
  const unregister = registerPipelineTick(async () => { ticks += 1; });
  try {
    await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass")], h.ports);
    expect(loadPipelines()[0]!.cursor).toEqual({ stageId: "build", state: "pending", input: "done", activatedBy: { stageId: "plan", attempt: 1, edge: "pass" } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ticks).toBe(1);

    /* A pass that leaves no pending cursor does not wake the controller. */
    await tickPipelines([], h.ports);
    expect(loadPipelines()[0]!.cursor).toEqual({ stageId: "build", state: "running", input: "done", activatedBy: { stageId: "plan", attempt: 1, edge: "pass" } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ticks).toBe(1);
  } finally {
    unregister();
  }
});

test("role-less run stages persist the Builder registry runtime", async () => {
  const h = harness();
  await create(h.ports, [
    { id: "research", kind: "run", prompt: "research", next: "summarize" },
    { id: "summarize", kind: "run", prompt: "summarize", next: null },
  ] as never);
  h.setBuilderEffort("low");
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.effectiveRole).toEqual({
    roleId: null,
    engine: "codex",
    model: "gpt-5.6-sol",
    effort: "medium",
    access: "read-write",
    promptScaffold: null,
  });
});

test("review-loop stage delegates to one regular flow and maps approval", async () => {
  const h = harness();
  const stages = [
    { id: "build", kind: "run", role: { roleId: "builder" }, engine: "codex", prompt: "build", next: "review" },
    { id: "review", kind: "review-loop", role: { roleId: "reviewer" }, engine: "codex", prompt: "Review {{task}}", next: null },
  ] as const;
  await create(h.ports, stages as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass")], h.ports);
  await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);
  expect(h.calls.filter((call) => call.startsWith("flow:")).length).toBe(1);
  expect(h.calls).toContain("flow-patch:flow-1:advance");
  expect(h.calls.some((call) => call.includes("Reviewer guidance"))).toBe(true);
  h.flows.get("flow-1")!.rounds.push({ n: 1, reviewHeadSha: ORIGIN_MAIN_SHA } as never);
  h.flows.get("flow-1")!.state = "approved";
  await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);
  expect(loadPipelines()[0]!.state).toBe("completed");
  expect(loadPipelines()[0]!.runs[1]!.attempts[0]!.verdict).toEqual({ status: "pass", confidence: 1 });
});

test("pipeline 8fa12bb4 creates review flow from a terminal builder's durable identity with an empty scanner slice", async () => {
  const h = harness();
  h.ports.spawnAgent = async (_input, onReserved) => {
    onReserved({ launchId: "launch-1", conversationId: "conversation_stage_1" });
    return {
      launchId: "launch-1",
      conversationId: "conversation_stage_1",
      sessionId: "session-1",
      "transcript": "/codex/stage-1.jsonl",
      paneId: null,
    };
  };
  const createFlow = h.ports.createFlow;
  h.ports.createFlow = async (req, entries) => {
    const durableConversationId = (req as typeof req & { implementerConversationId?: string }).implementerConversationId;
    if (!entries.some((candidate) => candidate.path === req.implementerPath) && !durableConversationId) {
      return { error: "implementer transcript is unknown" };
    }
    h.calls.push(`flow-implementer:${durableConversationId ?? "scanner"}`);
    return createFlow(req, entries);
  };
  h.setConversationActive(false);
  const pipeline = await create(h.ports, [
    { id: "build", kind: "run", role: { roleId: "builder" }, ["prompt"]: "build", next: "review" },
    { id: "review", kind: "review-loop", role: { roleId: "reviewer" }, ["prompt"]: "review", next: null },
  ] as never);

  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass")], h.ports);
  await tickPipelines([], h.ports);

  const current = loadPipelines().find((candidate) => candidate.id === pipeline.id)!;
  const build = current.runs.find((run) => run.stageId === "build")!.attempts[0]!;
  const review = current.runs.find((run) => run.stageId === "review")!.attempts[0]!;
  expect(build).toMatchObject({
    state: "passed",
    conversationId: "conversation_stage_1",
    agentPath: "/codex/stage-1.jsonl",
    paneId: null,
  });
  expect(current.stateDetail ?? "").not.toContain("implementer transcript is unknown");
  expect(review.flowId).toBe("flow-1");
  expect(h.calls).toContain("flow-implementer:conversation_stage_1");
});

test("retrying a parked review-loop appends a fresh attempt and flow", async () => {
  const h = harness();
  const stages = [
    { id: "build", kind: "run", role: { roleId: "builder" }, ["prompt"]: "build", next: "review" },
    { id: "review", kind: "review-loop", role: { roleId: "reviewer" }, ["prompt"]: "review", next: null },
  ] as const;
  const pipeline = await create(h.ports, stages as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass")], h.ports);
  await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);
  h.flows.get("flow-1")!.state = "done_comment";
  await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);
  expect(loadPipelines()[0]!.state).toBe("needs_decision");

  await patchPipeline(pipeline.id, { action: "retry-stage" }, h.ports);
  await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);
  const reviewRun = loadPipelines()[0]!.runs[1]!;
  expect(reviewRun.attempts).toHaveLength(2);
  expect(reviewRun.attempts[1]!.flowId).toBe("flow-2");
});

test("retrying a parked review-loop fast-forwards to the pushed repair and records the reviewer SHA (#522)", async () => {
  const h = harness();
  const reviewRepo = path.join(process.env.LLV_STATE_DIR!, "retry-review-repo");
  fs.mkdirSync(reviewRepo, { recursive: true });
  expect(spawnSync("git", ["init", "-b", "main"], { cwd: reviewRepo }).status).toBe(0);
  expect(spawnSync("git", ["config", "user.email", "noreply"], { cwd: reviewRepo }).status).toBe(0);
  expect(spawnSync("git", ["config", "user.name", "Flow Test"], { cwd: reviewRepo }).status).toBe(0);
  fs.writeFileSync(path.join(reviewRepo, "repair.txt"), "repair\n");
  expect(spawnSync("git", ["add", "repair.txt"], { cwd: reviewRepo }).status).toBe(0);
  expect(spawnSync("git", ["commit", "-m", "repair"], { cwd: reviewRepo }).status).toBe(0);
  const repairHead = spawnSync("git", ["rev-parse", "HEAD"], { cwd: reviewRepo, encoding: "utf8" }).stdout.trim();
  const createFlow = h.ports.createFlow;
  h.ports.createFlow = async (req, entries) => {
    const created = await createFlow(req, entries);
    if (created.flow) {
      created.flow.cwd = reviewRepo;
      created.flow.roles = req.roles!;
    }
    return created;
  };
  const stages = [
    { id: "build", kind: "run", role: { roleId: "builder" }, ["prompt"]: "build", next: "review" },
    { id: "review", kind: "review-loop", role: { roleId: "reviewer" }, ["prompt"]: "review", next: null },
  ] as const;
  let localHead = ORIGIN_MAIN_SHA;
  let remoteHead = ORIGIN_MAIN_SHA;
  let fastForwarded = false;
  const baseExec = h.ports.exec;
  h.ports.exec = (rawCommand, rawArgs, cwd) => {
    const command = rawCommand === "timeout" ? "git" : rawCommand;
    const args = rawCommand === "timeout" ? rawArgs.slice(rawArgs.indexOf("git") + 1) : rawArgs;
    if (command === "git" && args[0] === "status") return { code: 0, stdout: "", stderr: "" };
    if (command === "git" && args[0] === "branch" && args[1] === "--show-current") return { code: 0, stdout: `${loadPipelines()[0]!.branch}\n`, stderr: "" };
    if (command === "git" && args[0] === "ls-remote") return { code: 0, stdout: `${remoteHead}\trefs/heads/${loadPipelines()[0]!.branch}\n`, stderr: "" };
    if (command === "git" && args[0] === "rev-parse" && args[1] === "HEAD") return { code: 0, stdout: `${localHead}\n`, stderr: "" };
    if (command === "git" && args[0] === "rev-parse" && String(args[1]).startsWith("refs/remotes/origin/")) return { code: 0, stdout: `${remoteHead}\n`, stderr: "" };
    if (command === "git" && args[0] === "merge-base") return { code: localHead === ORIGIN_MAIN_SHA && remoteHead === repairHead ? 0 : 1, stdout: "", stderr: "" };
    if (command === "git" && args[0] === "merge" && args[1] === "--ff-only") {
      h.calls.push(`${command} ${args.join(" ")}`);
      localHead = remoteHead;
      fastForwarded = true;
      return { code: 0, stdout: "", stderr: "" };
    }
    return baseExec(rawCommand, rawArgs, cwd);
  };

  const pipeline = await create(h.ports, stages as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass")], h.ports);
  await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);
  h.flows.get("flow-1")!.state = "done_comment";
  await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);
  expect(loadPipelines()[0]!.state).toBe("needs_decision");

  /* An operator's additive repair has landed on the pipeline branch after the
     reviewer finding. The retry must review this repair head. */
  remoteHead = repairHead;
  await patchPipeline(pipeline.id, { action: "retry-stage" }, h.ports);
  await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);

  const launchedFlow = h.flows.get("flow-2")!;
  const launchedRound = newRound(launchedFlow, "button", null);
  launchedRound.reviewHeadSha = repairHead;
  launchedFlow.rounds.push(launchedRound);
  expect(launchedFlow.targetSha).toBe(repairHead);
  expect(launchedFlow.headRef).toBe(pipeline.branch);
  expect(launchedRound.reviewHeadSha).toBe(repairHead);
  await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);

  const review = loadPipelines()[0]!.runs.find((run) => run.stageId === "review")!.attempts[1]!;
  expect(localHead).toBe(repairHead);
  expect(review.expectedReviewHeadSha).toBe(repairHead);
  expect(review.reviewHeadSha).toBe(repairHead);
  expect(fastForwarded).toBe(true);
  expect(h.calls).toContain(`flow:/codex/stage-1.jsonl:${ORIGIN_MAIN_SHA}:${repairHead}:AC1`);
  expect(h.calls.some((call) => call.includes("reset --hard"))).toBe(false);
  expect(h.calls.indexOf("flow-close:flow-1")).toBeLessThan(h.calls.indexOf(`git merge --ff-only refs/remotes/origin/${pipeline.branch}`));
});

test("issue 533: an in-loop repair advances expectedReviewHeadSha with reviewHeadSha from d03cc211 to 5755f992", async () => {
  const h = harness();
  const stages = [
    { id: "build", kind: "run", role: { roleId: "builder" }, ["prompt"]: "build", next: "review" },
    { id: "review", kind: "review-loop", role: { roleId: "reviewer" }, ["prompt"]: "review", next: null },
  ] as const;
  await create(h.ports, stages as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass")], h.ports);
  const beforeRepair = "d03cc2118d7d02b4e3afdfc2af3bb4bf2b9e7d2a";
  const persisted = loadPipelines()[0]!;
  persisted.lastPassedCommit = beforeRepair;
  savePipelines([persisted]);
  /* The accepted commit IS the worktree head, and origin already carries it:
     review ingress publishes the exact accepted head, so a fixture whose
     worktree disagreed with its own accepted commit would park instead. */
  const baseExec = h.ports.exec;
  h.ports.exec = (rawCommand, rawArgs, cwd) => {
    const command = rawCommand === "timeout" ? "git" : rawCommand;
    const args = rawCommand === "timeout" ? rawArgs.slice(rawArgs.indexOf("git") + 1) : rawArgs;
    if (command === "git" && args[0] === "rev-parse" && args[1] === "HEAD") return { code: 0, stdout: `${beforeRepair}\n`, stderr: "" };
    if (command === "git" && args[0] === "ls-remote") return { code: 0, stdout: `${beforeRepair}\trefs/heads/${loadPipelines()[0]!.branch}\n`, stderr: "" };
    return baseExec(rawCommand, rawArgs, cwd);
  };
  await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);

  const actualReviewHead = "5755f992b195cc8637fd7129d9be4049c10494fa";
  expect(loadPipelines()[0]!.runs.find((run) => run.stageId === "review")!.attempts[0]!.expectedReviewHeadSha).toBe(beforeRepair);
  h.flows.get("flow-1")!.rounds.push({ n: 1, reviewHeadSha: actualReviewHead } as never);
  await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);

  const attempt = loadPipelines()[0]!.runs.find((run) => run.stageId === "review")!.attempts[0]!;
  expect(attempt.expectedReviewHeadSha).toBe(actualReviewHead);
  expect(attempt.reviewHeadSha).toBe(actualReviewHead);
});

test("a divergent pipeline branch leaves a retried review parked with an actionable decision (#522)", async () => {
  const h = harness();
  const stages = [
    { id: "build", kind: "run", role: { roleId: "builder" }, ["prompt"]: "build", next: "review" },
    { id: "review", kind: "review-loop", role: { roleId: "reviewer" }, ["prompt"]: "review", next: null },
  ] as const;
  let diverged = false;
  const localHead = "b".repeat(40);
  const remoteHead = "c".repeat(40);
  const baseExec = h.ports.exec;
  h.ports.exec = (command, args, cwd) => {
    if (command === "git" && args[0] === "status") return { code: 0, stdout: "", stderr: "" };
    if (command === "git" && args[0] === "branch" && args[1] === "--show-current") return { code: 0, stdout: `${loadPipelines()[0]!.branch}\n`, stderr: "" };
    if (command === "git" && args[0] === "rev-parse" && args[1] === "HEAD") return { code: 0, stdout: `${diverged ? localHead : ORIGIN_MAIN_SHA}\n`, stderr: "" };
    if (!diverged) return baseExec(command, args, cwd);
    if (command === "git" && args[0] === "ls-remote") return { code: 0, stdout: `${remoteHead}\trefs/heads/${loadPipelines()[0]!.branch}\n`, stderr: "" };
    if (command === "git" && args[0] === "rev-parse" && String(args[1]).startsWith("refs/remotes/origin/")) return { code: 0, stdout: `${remoteHead}\n`, stderr: "" };
    if (command === "git" && args[0] === "merge-base") return { code: 1, stdout: "", stderr: "" };
    return baseExec(command, args, cwd);
  };

  const pipeline = await create(h.ports, stages as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass")], h.ports);
  await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);
  h.flows.get("flow-1")!.state = "done_comment";
  await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);

  diverged = true;
  const retried = await patchPipeline(pipeline.id, { action: "retry-stage" }, h.ports);

  expect(retried).toMatchObject({ status: 409, error: expect.stringContaining("diverged") });
  expect(loadPipelines()[0]).toMatchObject({ state: "needs_decision", stateDetail: expect.stringContaining("diverged") });
});

test("reopening an embedded review flow resumes its parked pipeline attempt", async () => {
  const h = harness();
  const stages = [
    { id: "build", kind: "run", role: { roleId: "builder" }, engine: "codex", prompt: "build", next: "review" },
    { id: "review", kind: "review-loop", role: { roleId: "reviewer" }, prompt: "review", next: null },
  ] as const;
  await create(h.ports, stages as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass")], h.ports);
  await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);
  h.flows.get("flow-1")!.state = "done_comment";
  await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);
  expect(loadPipelines()[0]!.state).toBe("needs_decision");

  h.flows.get("flow-1")!.state = "waiting_ready";
  h.flows.get("flow-1")!.stateDetail = null;
  await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);

  const resumed = loadPipelines()[0]!;
  const reviewRun = resumed.runs[1]!;
  expect(resumed.state).toBe("running");
  expect(reviewRun.attempts).toHaveLength(1);
  expect(reviewRun.attempts[0]).toMatchObject({ flowId: "flow-1", state: "reviewing", error: null });
});

test("retry-stage adopts a partially created flow and records its reviewer on the pipeline attempt", async () => {
  const h = harness();
  const stages = [
    { id: "build", kind: "run", role: { roleId: "builder" }, prompt: "build", next: "review" },
    { id: "review", kind: "review-loop", role: { roleId: "reviewer" }, prompt: "review", next: null },
  ] as const;
  const pipeline = await create(h.ports, stages as never);
  const partial = {
    id: "flow-partial",
    implementerPath: "/codex/stage-1.jsonl",
    implementerConversationId: "conversation_stage_1",
    baseRef: ORIGIN_MAIN_SHA,
    state: "reviewing",
    rounds: [{
      n: 1,
      sessionId: "reviewer-session",
      reviewerPath: "/codex/reviewer.jsonl",
      reviewerConversationId: "conversation_reviewer",
    }],
    createdAt: new Date(1_005_000).toISOString(),
    closedAt: null,
  } as unknown as Flow;
  let createCalls = 0;
  h.ports.createFlow = async () => {
    createCalls += 1;
    if (createCalls === 1) {
      h.flows.set(partial.id, partial);
      return { error: "flow persistence completed before response transport failed" };
    }
    return { error: "implementer already has an active flow" };
  };
  h.ports.findFlow = (_implementerPath, stableIdentity) =>
    h.flows.has(partial.id) && stableIdentity === "conversation_stage_1" ? partial : null;

  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass")], h.ports);
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.stateDetail).toContain("response transport failed");

  await patchPipeline(pipeline.id, { action: "retry-stage" }, h.ports);
  await tickPipelines([], h.ports);

  const reviewRun = loadPipelines()[0]!.runs.find((run) => run.stageId === "review")!;
  expect(reviewRun.attempts).toHaveLength(2);
  expect(reviewRun.attempts[1]).toMatchObject({
    flowId: "flow-partial",
    sessionId: "reviewer-session",
    agentPath: "/codex/reviewer.jsonl",
    conversationId: "conversation_reviewer",
  });
  expect(createCalls).toBe(1);
});

test("retry-stage recovers after the three identical pipeline 8fa12bb4 review creation failures", async () => {
  const h = harness();
  const stages = [
    { id: "build", kind: "run", role: { roleId: "builder" }, prompt: "build", next: "review" },
    { id: "review", kind: "review-loop", role: { roleId: "reviewer" }, prompt: "review", next: null },
  ] as const;
  const pipeline = await create(h.ports, stages as never);
  const createFlow = h.ports.createFlow;
  let causePresent = true;
  h.ports.createFlow = async (req, entries) => {
    if (causePresent || !req.implementerConversationId) {
      return { error: "implementer transcript is unknown" };
    }
    return createFlow(req, entries);
  };

  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass")], h.ports);
  await tickPipelines([], h.ports);
  for (let retry = 0; retry < 2; retry += 1) {
    await patchPipeline(pipeline.id, { action: "retry-stage" }, h.ports);
    await tickPipelines([], h.ports);
  }

  const failed = loadPipelines()[0]!.runs.find((run) => run.stageId === "review")!.attempts;
  expect(failed).toHaveLength(3);
  expect(failed.map((attempt) => attempt.error)).toEqual([
    "creating the review flow failed: implementer transcript is unknown",
    "creating the review flow failed: implementer transcript is unknown",
    "creating the review flow failed: implementer transcript is unknown",
  ]);

  causePresent = false;
  await patchPipeline(pipeline.id, { action: "retry-stage" }, h.ports);
  await tickPipelines([], h.ports);

  const recovered = loadPipelines()[0]!.runs.find((run) => run.stageId === "review")!.attempts;
  expect(recovered).toHaveLength(4);
  expect(recovered[3]).toMatchObject({ state: "reviewing", flowId: "flow-1", error: null });
});

test("review-loop startup parks when advance fails", async () => {
  const h = harness();
  const stages = [
    { id: "build", kind: "run", prompt: "build", next: "review" },
    { id: "review", kind: "review-loop", role: { roleId: "reviewer" }, prompt: "review", next: null },
  ] as const;
  await create(h.ports, stages as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass")], h.ports);
  h.ports.patchFlow = () => ({ error: "advance rejected", status: 409 });
  await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);
  expect(loadPipelines()[0]!.state).toBe("needs_decision");
  expect(loadPipelines()[0]!.stateDetail).toContain("advance rejected");
});

test("a paused review flow parks its pipeline", async () => {
  const h = harness();
  const stages = [
    { id: "build", kind: "run", prompt: "build", next: "review" },
    { id: "review", kind: "review-loop", role: { roleId: "reviewer" }, prompt: "review", next: null },
  ] as const;
  await create(h.ports, stages as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass")], h.ports);
  await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);
  h.flows.get("flow-1")!.state = "paused";
  h.flows.get("flow-1")!.stateDetail = "kickoff delivery failed";
  await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);
  expect(loadPipelines()[0]!.state).toBe("needs_decision");
  expect(loadPipelines()[0]!.stateDetail).toContain("kickoff delivery failed");
});

test("a review-flow host claim retry keeps the stage running with the safe claim detail (#921)", async () => {
  const h = harness();
  const stages = [
    { id: "build", kind: "run", prompt: "build", next: "review" },
    { id: "review", kind: "review-loop", role: { roleId: "reviewer" }, prompt: "review", next: null },
  ] as const;
  await create(h.ports, stages as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass")], h.ports);
  await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);

  const flow = h.flows.get("flow-1")!;
  const claim = {
    sessionKey: `codex:${["179f421e", "02e1", "73e0", "9b77", "bebde063f529"].join("-")}`,
    accountRef: "managed:fc164f825080",
  } as const;
  flow.hostClaim = claim;
  flow.state = "relaying";
  flow.stateDetail = `relay delivery failed; retrying automatically (2/3): structured host claim ${claim.sessionKey} on account ${claim.accountRef} failed: structured resume host claim is unavailable`;

  await tickPipelines([], h.ports);

  const retrying = loadPipelines()[0]!;
  expect(retrying).toMatchObject({
    state: "running",
    stateDetail: `review flow host claim retry: ${flow.stateDetail}`,
  });
  expect(retrying.runs[1]!.attempts[0]).toMatchObject({
    state: "reviewing",
    error: null,
    reviewFlowSync: {
      relayState: "relaying",
      hostClaim: claim,
    },
  });

  flow.state = "fixing";
  flow.stateDetail = null;
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]).toMatchObject({ state: "running", stateDetail: null });
});

test("an accepted-but-unsettled relay retry is not mislabeled as a host-claim failure (#921, #1065)", async () => {
  const h = harness();
  const stages = [
    { id: "build", kind: "run", prompt: "build", next: "review" },
    { id: "review", kind: "review-loop", role: { roleId: "reviewer" }, prompt: "review", next: null },
  ] as const;
  await create(h.ports, stages as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass")], h.ports);
  await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);

  const flow = h.flows.get("flow-1")!;
  flow.hostClaim = {
    sessionKey: `codex:${["189f421e", "02e1", "73e0", "9b77", "bebde063f529"].join("-")}`,
    accountRef: "managed:fc164f825080",
  };
  flow.state = "relaying";
  flow.stateDetail = "relay delivery failed; retrying automatically (1/3): structured relay was accepted but never settled in the delivery journal";

  await tickPipelines([], h.ports);

  expect(loadPipelines()[0]).toMatchObject({
    state: "running",
    stateDetail: `review flow relay retry: ${flow.stateDetail}`,
  });
  expect(loadPipelines()[0]!.stateDetail).not.toContain("host claim retry");
});

test("a bound review flow paused while relaying resumes without operator action", async () => {
  const h = harness();
  const stages = [
    { id: "build", kind: "run", prompt: "build", next: "review" },
    { id: "review", kind: "review-loop", role: { roleId: "reviewer" }, prompt: "review", next: null },
  ] as const;
  await create(h.ports, stages as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass")], h.ports);
  await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);

  const flow = h.flows.get("flow-1")!;
  const findingsPath = path.join(process.env.LLV_STATE_DIR!, "legacy-relay-failure-findings.md");
  fs.writeFileSync(findingsPath, "VERDICT: REQUEST_CHANGES\n\nRepair the host claim.\n");
  flow.rounds.push({
    n: 3,
    verdict: "REQUEST_CHANGES",
    reviewHeadSha: ORIGIN_MAIN_SHA,
    findingsPath,
    relayStartedAt: "2026-08-05T20:47:08.000Z",
    relayDeliveryTransport: null,
    relayDelivery: null,
    relayedAt: null,
    error: "structured resume host claim is unavailable",
    reviewerPath: "/codex/reviewer.jsonl",
    reviewerConversationId: "conversation_reviewer",
  } as never);
  flow.state = "paused";
  flow.pausedState = "relaying";
  flow.stateDetail = "structured resume host claim is unavailable";

  await tickPipelines([entry("/codex/reviewer.jsonl")], h.ports);
  const parked = loadPipelines()[0]!;
  expect(parked).toMatchObject({
    state: "needs_decision",
    stateDetail: "review flow paused in relaying: structured resume host claim is unavailable",
  });
  expect(parked.runs[1]!.attempts[0]).toMatchObject({
    state: "needs_decision",
    error: "review flow paused in relaying: structured resume host claim is unavailable",
    flowId: "flow-1",
  });

  await tickPipelines([entry("/codex/reviewer.jsonl")], h.ports);

  expect(flow).toMatchObject({ state: "relaying", pausedState: null, stateDetail: null });
  expect(flow.rounds.at(-1)).toMatchObject({ relayStartedAt: null, relayDeliveryTransport: null });
  expect(h.calls).toContain("flow-patch:flow-1:resume");
  expect(loadPipelines()[0]).toMatchObject({ state: "running", stateDetail: null });
  expect(loadPipelines()[0]!.runs[1]!.attempts[0]).toMatchObject({
    state: "reviewing",
    error: null,
    flowId: "flow-1",
    agentPath: "/codex/reviewer.jsonl",
    conversationId: "conversation_reviewer",
  });

  const implementer = entry("/codex/stage-1.jsonl");
  const relayDeliveries: string[] = [];
  const restoreDelivery = setRelayDeliveryForTest(async (_flow, _entries, text) => {
    relayDeliveries.push(text);
    return implementer.path;
  });
  try {
    await tickFlow(flow, [implementer], new Map([[implementer.path, implementer]]), () => {});
  } finally {
    restoreDelivery();
  }
  await tickPipelines([entry("/codex/reviewer.jsonl")], h.ports);

  expect(relayDeliveries).toHaveLength(1);
  expect(flow).toMatchObject({ state: "fixing", pausedState: null, stateDetail: null });
  expect(flow.rounds.at(-1)).toMatchObject({
    relayDelivery: { path: implementer.path, deliveredAt: expect.any(String) },
    relayedAt: expect.any(String),
    error: null,
  });
  expect(loadPipelines()[0]).toMatchObject({ state: "running", stateDetail: null });
});

test("a parked review stage ingests ten verdicts when relay terminalization races ingestion (#921)", async () => {
  const h = harness();
  const stages = [
    { id: "build", kind: "run", prompt: "build", next: "review" },
    { id: "review", kind: "review-loop", role: { roleId: "reviewer" }, prompt: "review", next: null },
  ] as const;
  await create(h.ports, stages as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass")], h.ports);
  await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);

  const claim = {
    sessionKey: `codex:${["279f421e", "02e1", "73e0", "9b77", "bebde063f529"].join("-")}`,
    accountRef: "managed:fc164f825080",
  } as const;
  const privateWorktree = path.join(process.env.LLV_STATE_DIR!, "private-worktree");
  const startupClaimError = "review flow paused during startup: structured resume host claim is unavailable";
  let completedRounds = 0;
  const populateRounds = (flow: Flow, count: number): void => {
    const flowDir = path.join(process.env.LLV_STATE_DIR!, "flows", flow.id);
    fs.mkdirSync(flowDir, { recursive: true });
    flow.cwd = privateWorktree;
    flow.hostClaim = claim;
    flow.rounds = Array.from({ length: count }, (_, index) => {
      const n = index + 1;
      completedRounds += 1;
      const findingsPath = path.join(flowDir, `round-${n}-review.md`);
      const content = completedRounds === 10
        ? [
            "VERDICT: REQUEST_CHANGES",
            "",
            "### Finding 1",
            "- **Severity:** High",
            `- **File:** ${path.join(privateWorktree, "src/lib/claim.ts")}`,
            "- **Line:** 42",
            "- **Title:** Claim failure stays invisible",
            "- **Explanation:** Surface the completed verdict on the stage.",
            "",
            "### Finding 2",
            "- **Severity:** Medium",
            "- **File:** src/lib/flows/state.ts",
            "- **Line:** 17",
            "- **Title:** Round count is stale",
            "- **Explanation:** Keep the latest completed round authoritative.",
            "",
          ].join("\n")
        : `VERDICT: REQUEST_CHANGES\n\nCompleted review ${completedRounds} requested changes.\n`;
      fs.writeFileSync(findingsPath, content);
      const reviewedAt = `2026-08-06T${String(4 + completedRounds).padStart(2, "0")}:19:00.000Z`;
      return {
        n,
        verdict: "REQUEST_CHANGES",
        findingsCount: completedRounds === 10 ? 2 : 1,
        findingsPath,
        reviewHeadSha: ORIGIN_MAIN_SHA,
        reviewedAt,
        terminalAt: reviewedAt,
        relayStartedAt: null,
        relayDeliveryTransport: null,
        relayDelivery: null,
        relayPendingSettlement: null,
        relayRetryAt: null,
        relayedAt: null,
        error: null,
        reviewerPath: `/codex/${flow.id}-reviewer-${n}.jsonl`,
        reviewerConversationId: `conversation_${flow.id}_reviewer_${n}`,
      } as never;
    });
  };

  const parkAtStartupClaim = (flow: Flow): void => {
    flow.cwd = privateWorktree;
    flow.hostClaim = claim;
    flow.state = "relaying";
    flow.pausedState = null;
    flow.stateDetail = null;
    const pipeline = loadPipelines()[0]!;
    const attempt = pipeline.runs[1]!.attempts.at(-1)!;
    pipeline.state = "needs_decision";
    pipeline.stateDetail = startupClaimError;
    attempt.state = "needs_decision";
    attempt.error = startupClaimError;
    savePipelines([pipeline]);
  };

  const recordHiddenRoundsAndRetry = async (flow: Flow, rounds: number): Promise<void> => {
    parkAtStartupClaim(flow);
    expect(loadPipelines()[0]).toMatchObject({
      state: "needs_decision",
      stateDetail: startupClaimError,
    });

    /* The incident's round artifacts appeared only after the parent stage had
       already parked. Keep the flow live while its read projection records the
       hidden rounds; the operator's retry then closes that attempt. */
    populateRounds(flow, rounds);
    const projected = structuredClone(loadPipelines()[0]!);
    expect(reconcileEmbeddedReviewFlows(
      [projected],
      [flow],
      flow.rounds.at(-1)!.reviewedAt!,
    )).toBe(true);
    savePipelines([projected]);
    expect(loadPipelines()[0]).toMatchObject({
      state: "needs_decision",
      stateDetail: startupClaimError,
    });

    await patchPipeline(loadPipelines()[0]!.id, { action: "retry-stage" }, h.ports);
    expect(flow.state).toBe("closed");
    await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);
  };

  await recordHiddenRoundsAndRetry(h.flows.get("flow-1")!, 2);
  await recordHiddenRoundsAndRetry(h.flows.get("flow-2")!, 3);

  const flow = h.flows.get("flow-3")!;
  parkAtStartupClaim(flow);
  populateRounds(flow, 5);
  expect(completedRounds).toBe(10);
  const finalRound = flow.rounds.at(-1)!;
  finalRound.relayRetryCount = 3;
  const claimFailure = `structured host claim ${claim.sessionKey} on account ${claim.accountRef} failed: structured resume host claim is unavailable`;
  const terminalDetail = `relay delivery failed after 3 automatic retries: ${claimFailure}`;
  let releaseRelay!: () => void;
  let markRelayStarted!: () => void;
  const relayStarted = new Promise<void>((resolve) => { markRelayStarted = resolve; });
  const relayReleased = new Promise<void>((resolve) => { releaseRelay = resolve; });
  const restoreDelivery = setRelayDeliveryForTest(async () => {
    markRelayStarted();
    await relayReleased;
    throw new Error(claimFailure);
  });

  let flowChanged: boolean;
  let ingested: Awaited<ReturnType<typeof tickPipelines>>;
  try {
    const flowTick = tickFlow(
      flow,
      [entry("/codex/stage-1.jsonl")],
      new Map([["/codex/stage-1.jsonl", entry("/codex/stage-1.jsonl")]]),
      () => {},
    );
    await relayStarted;
    /* Resolve the in-flight relay immediately before the controller reads the
       parked stage. The relay exhausts its fourth claim attempt while the
       controller is entering ingestion, so the terminal flow generation and
       the parent settlement contend in one real flow/pipeline race. */
    releaseRelay();
    const pipelineTick = tickPipelines([entry(finalRound.reviewerPath!)], h.ports);
    [flowChanged, ingested] = await Promise.all([flowTick, pipelineTick]);
  } finally {
    restoreDelivery();
  }
  expect(flowChanged).toBe(true);
  expect(ingested.changed).toBe(true);
  expect(flow).toMatchObject({ state: "needs_decision", stateDetail: terminalDetail });

  const settled = loadPipelines()[0]!;
  const reviewAttempts = settled.runs[1]!.attempts;
  const attempt = reviewAttempts[2]!;
  expect(settled).toMatchObject({ state: "needs_decision" });
  expect(reviewAttempts).toHaveLength(3);
  expect(reviewAttempts.map((candidate) => candidate.reviewFlowSync?.roundCount)).toEqual([2, 3, 5]);
  expect(attempt).toMatchObject({
    state: "failed",
    completedAt: expect.any(String),
    verdict: {
      status: "fail",
      findings: [
        terminalDetail,
        "High — src/lib/claim.ts:42 — Claim failure stays invisible",
        "Medium — src/lib/flows/state.ts:17 — Round count is stale",
      ],
    },
    reviewFlowSync: {
      roundCount: 5,
      verdict: "REQUEST_CHANGES",
      hostClaim: claim,
    },
  });
  expect(reviewAttempts.filter((candidate) => candidate.verdict !== null)).toHaveLength(1);
  expect(reviewAttempts.filter((candidate) => candidate.completedAt !== null)).toHaveLength(1);
  expect(settled.stateDetail).toBe(terminalDetail);
  expect(attempt.output).toContain("Review flow round 5: REQUEST_CHANGES");
  expect(JSON.stringify(attempt)).not.toContain(privateWorktree);

  const stableSettlement = JSON.stringify(loadPipelines()[0]);
  const repeated = await tickPipelines([entry(flow.rounds.at(-1)!.reviewerPath!)], h.ports);
  expect(repeated.changed).toBe(false);
  expect(JSON.stringify(loadPipelines()[0])).toBe(stableSettlement);
});

test("an operator pause during relay stays paused across pipeline reconciliation", async () => {
  const h = harness();
  const stages = [
    { id: "build", kind: "run", prompt: "build", next: "review" },
    { id: "review", kind: "review-loop", role: { roleId: "reviewer" }, prompt: "review", next: null },
  ] as const;
  await create(h.ports, stages as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass")], h.ports);
  await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);

  const flow = h.flows.get("flow-1")!;
  flow.rounds.push({
    n: 3,
    verdict: "REQUEST_CHANGES",
    reviewHeadSha: ORIGIN_MAIN_SHA,
    relayStartedAt: "2026-08-05T20:47:08.000Z",
    error: "structured resume host claim is unavailable",
    reviewerPath: "/codex/reviewer.jsonl",
    reviewerConversationId: "conversation_reviewer",
  } as never);
  flow.state = "paused";
  flow.pausedState = "relaying";
  flow.stateDetail = "paused by user";

  await tickPipelines([entry("/codex/reviewer.jsonl")], h.ports);
  await tickPipelines([entry("/codex/reviewer.jsonl")], h.ports);

  expect(flow).toMatchObject({ state: "paused", pausedState: "relaying", stateDetail: "paused by user" });
  expect(h.calls).not.toContain("flow-patch:flow-1:resume");
  expect(loadPipelines()[0]).toMatchObject({
    state: "needs_decision",
    stateDetail: "review flow paused in relaying: paused by user",
  });
  expect(loadPipelines()[0]!.runs[1]!.attempts[0]).toMatchObject({
    state: "needs_decision",
    error: "review flow paused in relaying: paused by user",
  });
});

test("a later exact-head approval replaces a stale startup pause and completes after controller restart (#526)", async () => {
  const h = harness();
  const stages = [
    { id: "build", kind: "run", prompt: "build", next: "review" },
    { id: "review", kind: "review-loop", role: { roleId: "reviewer" }, prompt: "review", next: null },
  ] as const;
  await create(h.ports, stages as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass")], h.ports);
  await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);

  const flow = h.flows.get("flow-1")!;
  flow.state = "paused";
  flow.pausedState = "reviewing";
  flow.stateDetail = "paused by user";
  await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);
  const parked = loadPipelines()[0]!;
  expect(parked.state).toBe("needs_decision");
  expect(parked.runs[1]!.attempts[0]).toMatchObject({
    flowId: "flow-1",
    state: "needs_decision",
    error: "review flow paused in reviewing: paused by user",
  });

  flow.rounds.push({
    n: 1,
    reviewHeadSha: ORIGIN_MAIN_SHA,
    launchId: "review-launch",
    sessionId: "review-session",
    reviewerPath: "/codex/reviewer.jsonl",
    reviewerConversationId: "conversation_reviewer",
  } as never);
  flow.state = "approved";
  flow.stateDetail = null;

  /* A fresh controller process sees only durable pipeline + flow state. */
  await tickPipelines([entry("/codex/reviewer.jsonl")], h.ports);
  const completed = loadPipelines()[0]!;
  expect(completed.state).toBe("completed");
  expect(completed.stateDetail).toBeNull();
  expect(completed.runs[1]!.attempts).toHaveLength(1);
  expect(completed.runs[1]!.attempts[0]).toMatchObject({
    flowId: "flow-1",
    state: "passed",
    error: null,
    reviewHeadSha: ORIGIN_MAIN_SHA,
    agentPath: "/codex/reviewer.jsonl",
    conversationId: "conversation_reviewer",
  });

  /* The first post-completion tick settles the terminal host reap (#574);
     from there the record is stable. */
  await tickPipelines([entry("/codex/reviewer.jsonl")], h.ports);
  expect(loadPipelines()[0]!.terminalReap?.settledAt).toBeTruthy();
  const afterCompletion = JSON.stringify(loadPipelines()[0]);
  await tickPipelines([entry("/codex/reviewer.jsonl")], h.ports);
  expect(JSON.stringify(loadPipelines()[0])).toBe(afterCompletion);
});

test("a later approval stays parked when its reviewed head differs from the current pipeline head (#526)", async () => {
  const h = harness();
  await create(h.ports, [
    { id: "build", kind: "run", prompt: "build", next: "review" },
    { id: "review", kind: "review-loop", role: { roleId: "reviewer" }, prompt: "review", next: null },
  ] as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass")], h.ports);
  await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);

  const flow = h.flows.get("flow-1")!;
  flow.state = "paused";
  flow.stateDetail = "transient controller restart";
  await tickPipelines([], h.ports);
  flow.rounds.push({ n: 1, reviewHeadSha: "f".repeat(40) } as never);
  flow.state = "approved";
  flow.stateDetail = null;

  await tickPipelines([], h.ports);
  const parked = loadPipelines()[0]!;
  expect(parked.state).toBe("needs_decision");
  expect(parked.stateDetail).toContain("approved review flow head mismatch");
  expect(parked.runs[1]!.attempts[0]).toMatchObject({
    state: "needs_decision",
    reviewHeadSha: "f".repeat(40),
    error: expect.stringContaining(`current pipeline head is ${ORIGIN_MAIN_SHA}`),
  });
  expect((await tickPipelines([], h.ports)).changed).toBe(false);
  expect(loadPipelines()[0]!.stateDetail).toBe(parked.stateDetail);
});

test("issue 533: approval parks when the reviewed repair is absent from the remote pipeline branch", async () => {
  const h = harness();
  const pipeline = await create(h.ports, [
    { id: "build", kind: "run", prompt: "build", next: "review" },
    { id: "review", kind: "review-loop", role: { roleId: "reviewer" }, prompt: "review", next: null },
  ] as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass")], h.ports);
  await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);
  const repairHead = "5".repeat(40);
  const staleRemoteHead = "d".repeat(40);
  const flow = h.flows.get("flow-1")!;
  flow.rounds.push({ n: 1, reviewHeadSha: repairHead } as never);
  flow.state = "approved";
  const baseExec = h.ports.exec;
  h.ports.exec = (command, args, cwd) => {
    if (command === "git" && args[0] === "rev-parse" && args[1] === "HEAD") {
      return { code: 0, stdout: `${repairHead}\n`, stderr: "" };
    }
    if (command === "git" && args[0] === "ls-remote") {
      return { code: 0, stdout: `${staleRemoteHead}\trefs/heads/${pipeline.branch}\n`, stderr: "" };
    }
    return baseExec(command, args, cwd);
  };

  await tickPipelines([], h.ports);

  const parked = loadPipelines()[0]!;
  expect(parked.state).toBe("needs_decision");
  expect(parked.stateDetail).toContain(`remote pipeline head is ${staleRemoteHead}`);
  expect(parked.runs[1]!.attempts[0]).toMatchObject({
    expectedReviewHeadSha: repairHead,
    reviewHeadSha: repairHead,
    state: "needs_decision",
  });
});

test("an approval parks when the clean head advances during final settlement (#526)", async () => {
  const h = harness();
  await create(h.ports, [
    { id: "build", kind: "run", prompt: "build", next: "review" },
    { id: "review", kind: "review-loop", role: { roleId: "reviewer" }, prompt: "review", next: null },
  ] as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass")], h.ports);
  await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);

  const flow = h.flows.get("flow-1")!;
  flow.rounds.push({ n: 1, reviewHeadSha: ORIGIN_MAIN_SHA } as never);
  flow.state = "approved";
  const newerHead = "e".repeat(40);
  let headReads = 0;
  const baseExec = h.ports.exec;
  h.ports.exec = (command, args, cwd) => {
    if (command === "git" && args[0] === "rev-parse" && args[1] === "HEAD") {
      headReads += 1;
      return { code: 0, stdout: `${headReads === 1 ? ORIGIN_MAIN_SHA : newerHead}\n`, stderr: "" };
    }
    return baseExec(command, args, cwd);
  };

  await tickPipelines([], h.ports);
  const parked = loadPipelines()[0]!;
  expect(headReads).toBe(2);
  expect(parked).toMatchObject({
    state: "needs_decision",
    stateDetail: expect.stringContaining(`settled ${newerHead}`),
    lastPassedCommit: ORIGIN_MAIN_SHA,
  });
  expect(parked.cursor?.stageId).toBe("review");
  expect(parked.runs[1]!.attempts[0]).toMatchObject({
    state: "needs_decision",
    reviewHeadSha: ORIGIN_MAIN_SHA,
  });
});

test("REQUEST_CHANGES recovery keeps the bound reviewer in the review slot and lets the flow relay continue (#526)", async () => {
  const h = harness();
  await create(h.ports, [
    { id: "build", kind: "run", prompt: "build", next: "review" },
    { id: "review", kind: "review-loop", role: { roleId: "reviewer" }, prompt: "review", next: null },
  ] as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass")], h.ports);
  await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);

  const flow = h.flows.get("flow-1")!;
  flow.state = "paused";
  flow.stateDetail = "relay controller unavailable";
  await tickPipelines([], h.ports);
  flow.rounds.push({
    n: 1,
    verdict: "REQUEST_CHANGES",
    reviewHeadSha: ORIGIN_MAIN_SHA,
    launchId: "review-launch",
    sessionId: "review-session",
    reviewerPath: "/codex/reviewer.jsonl",
    reviewerConversationId: "conversation_reviewer",
  } as never);
  flow.state = "relay_pending";
  flow.stateDetail = null;

  await tickPipelines([entry("/codex/reviewer.jsonl")], h.ports);
  const relaying = loadPipelines()[0]!;
  expect(relaying.state).toBe("running");
  expect(relaying.stateDetail).toBeNull();
  expect(relaying.runs[1]!.attempts).toHaveLength(1);
  expect(relaying.runs[1]!.attempts[0]).toMatchObject({
    flowId: "flow-1",
    state: "reviewing",
    error: null,
    agentPath: "/codex/reviewer.jsonl",
    conversationId: "conversation_reviewer",
  });
});

test("issue 532: a four-round embedded flow authoritatively repairs its stale parent once", async () => {
  const h = harness();
  await create(h.ports, [
    { id: "build", kind: "run", prompt: "build", next: "review" },
    { id: "review", kind: "review-loop", role: { roleId: "reviewer" }, prompt: "review", next: null },
  ] as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass")], h.ports);
  await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);

  const flow = h.flows.get("flow-1")!;
  const heads = ["1", "2", "3", "4"].map((digit) => digit.repeat(40));
  flow.rounds = heads.map((reviewHeadSha, index) => ({
    n: index + 1,
    reviewerPath: `/codex/reviewer-${index + 1}.jsonl`,
    reviewerConversationId: `conversation_reviewer_${index + 1}`,
    reviewHeadSha,
    verdict: index < 3 ? "REQUEST_CHANGES" : null,
    reviewedAt: index < 3 ? `2026-07-22T00:0${index}:00.000Z` : null,
    relayedAt: index < 3 ? `2026-07-22T00:0${index}:30.000Z` : null,
  } as never));
  flow.state = "reviewing";

  const parent = loadPipelines()[0]!;
  const reviewAttempt = parent.runs[1]!.attempts[0]!;
  reviewAttempt.agentPath = "/codex/reviewer-2.jsonl";
  reviewAttempt.conversationId = "conversation_reviewer_2";
  reviewAttempt.expectedReviewHeadSha = heads[1]!;
  reviewAttempt.reviewHeadSha = heads[1]!;

  expect(reconcileEmbeddedReviewFlows([parent], [flow], "2026-07-22T00:04:00.000Z")).toBe(true);
  expect(reviewAttempt).toMatchObject({
    agentPath: "/codex/reviewer-4.jsonl",
    conversationId: "conversation_reviewer_4",
    expectedReviewHeadSha: heads[3],
    reviewHeadSha: heads[3],
    reviewFlowSync: {
      roundCount: 4,
      implementerHeadSha: heads[3],
      reviewerHeadSha: heads[3],
      verdict: null,
      relayState: "reviewing",
      terminalState: null,
      synchronizedAt: "2026-07-22T00:04:00.000Z",
    },
  });
  expect(reconcileEmbeddedReviewFlows([parent], [flow], "2026-07-22T00:05:00.000Z")).toBe(false);

  flow.revision = 2;
  flow.rounds[3]!.reviewerPath = "/codex/reviewer-new.jsonl";
  expect(reconcileEmbeddedReviewFlows([parent], [flow], "2026-07-22T00:05:30.000Z")).toBe(true);
  const equalTimestampStaleFlow = structuredClone(flow);
  equalTimestampStaleFlow.revision = 1;
  equalTimestampStaleFlow.rounds[3]!.reviewerPath = "/codex/reviewer-old.jsonl";
  expect(reconcileEmbeddedReviewFlows([parent], [equalTimestampStaleFlow], "2026-07-22T00:05:31.000Z")).toBe(false);
  expect(reviewAttempt.agentPath).toBe("/codex/reviewer-new.jsonl");

  /* Model the partial-write crash: flows.json advances with a delayed final
     marker while pipelines.json still contains generation four. A fresh
     controller has no scan entries or runtime host and must converge once. */
  savePipelines([parent]);
  const finalHead = "5".repeat(40);
  flow.rounds.push({
    n: 5,
    reviewerPath: "/codex/reviewer-5.jsonl",
    reviewerConversationId: "conversation_reviewer_5",
    reviewHeadSha: finalHead,
    verdict: null,
    startedAt: "2026-07-22T00:06:00.000Z",
  } as never);
  flow.revision = 3;
  expect((await tickPipelines([], h.ports)).changed).toBe(true);
  const recovered = loadPipelines()[0]!.runs[1]!.attempts[0]!;
  expect(recovered).toMatchObject({
    agentPath: "/codex/reviewer-5.jsonl",
    expectedReviewHeadSha: finalHead,
    reviewHeadSha: finalHead,
    reviewFlowSync: { roundCount: 5, relayState: "reviewing" },
  });
  expect((await tickPipelines([], h.ports)).changed).toBe(false);

  const staleFlow = structuredClone(flow);
  staleFlow.rounds = staleFlow.rounds.slice(0, 4);
  expect(reconcileEmbeddedReviewFlows([loadPipelines()[0]!], [staleFlow], "2026-07-22T00:07:00.000Z")).toBe(false);
  expect(loadPipelines()[0]!.runs[1]!.attempts[0]).toMatchObject({
    agentPath: "/codex/reviewer-5.jsonl",
    expectedReviewHeadSha: finalHead,
    reviewHeadSha: finalHead,
    reviewFlowSync: { roundCount: 5 },
  });
});

test("issue 532: projection rebinds one flow-first partial write and refuses ambiguous candidates", async () => {
  const h = harness();
  await create(h.ports, [
    { id: "build", kind: "run", prompt: "build", next: "review" },
    { id: "review", kind: "review-loop", role: { roleId: "reviewer" }, prompt: "review", next: null },
  ] as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass")], h.ports);
  await tickPipelines([], h.ports);

  const parent = loadPipelines()[0]!;
  const attempt = parent.runs[1]!.attempts[0]!;
  const flow = h.flows.get("flow-1")!;
  attempt.flowId = null;
  attempt.agentPath = null;
  attempt.conversationId = null;

  /* No scan entries and no runtime host: the files read owns recovery. */
  expect(reconcileEmbeddedReviewFlows([parent], [flow], "2026-07-22T01:00:00.000Z")).toBe(true);
  expect(attempt).toMatchObject({ flowId: flow.id, reviewFlowSync: { roundCount: 0 } });
  expect(reconcileEmbeddedReviewFlows([parent], [flow], "2026-07-22T01:01:00.000Z")).toBe(false);

  attempt.flowId = null;
  attempt.reviewFlowSync = undefined;
  const duplicate = { ...structuredClone(flow), id: "flow-duplicate" };
  expect(reconcileEmbeddedReviewFlows([parent], [flow, duplicate], "2026-07-22T01:02:00.000Z")).toBe(false);
  expect(attempt.flowId).toBeNull();
});

for (const terminalState of ["done_comment", "needs_decision"] as const) {
  test(`a later ${terminalState} outcome replaces stale startup evidence once across restart ticks (#526)`, async () => {
    const h = harness();
    await create(h.ports, [
      { id: "build", kind: "run", prompt: "build", next: "review" },
      { id: "review", kind: "review-loop", role: { roleId: "reviewer" }, prompt: "review", next: null },
    ] as never);
    await tickPipelines([], h.ports);
    await tickPipelines([], h.ports);
    await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass")], h.ports);
    await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);

    const flow = h.flows.get("flow-1")!;
    flow.state = "paused";
    flow.pausedState = "spawning";
    flow.stateDetail = "startup transport unavailable";
    await tickPipelines([], h.ports);
    expect(loadPipelines()[0]!.runs[1]!.attempts[0]!.error)
      .toBe("review flow paused in spawning: startup transport unavailable");

    flow.rounds.push({
      n: 1,
      verdict: terminalState === "done_comment" ? "COMMENT" : null,
      reviewHeadSha: ORIGIN_MAIN_SHA,
      reviewerPath: "/codex/reviewer.jsonl",
      reviewerConversationId: "conversation_reviewer",
    } as never);
    flow.state = terminalState;
    flow.stateDetail = terminalState === "done_comment" ? "reviewer left a comment" : "reviewer relay failed";

    await tickPipelines([entry("/codex/reviewer.jsonl")], h.ports);
    const reconciled = loadPipelines()[0]!;
    const expectedError = `review loop ended in ${terminalState}: ${flow.stateDetail}`;
    expect(reconciled).toMatchObject({ state: "needs_decision", stateDetail: expectedError });
    expect(reconciled.runs[1]!.attempts).toHaveLength(1);
    expect(reconciled.runs[1]!.attempts[0]).toMatchObject({
      flowId: "flow-1",
      state: "needs_decision",
      error: expectedError,
      reviewHeadSha: ORIGIN_MAIN_SHA,
      agentPath: "/codex/reviewer.jsonl",
      conversationId: "conversation_reviewer",
    });

    expect((await tickPipelines([entry("/codex/reviewer.jsonl")], h.ports)).changed).toBe(false);
    expect(loadPipelines()[0]!.runs[1]!.attempts).toHaveLength(1);
    expect(loadPipelines()[0]!.stateDetail).toBe(expectedError);
  });
}

async function persistedCommittingReview() {
  const h = harness();
  await create(h.ports, [
    { id: "build", kind: "run", prompt: "build", next: "review" },
    { id: "review", kind: "review-loop", role: { roleId: "reviewer" }, prompt: "review", next: null },
  ] as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass")], h.ports);
  await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);

  const pipeline = loadPipelines()[0]!;
  const attempt = pipeline.runs[1]!.attempts[0]!;
  attempt.state = "committing";
  attempt.reviewHeadSha = ORIGIN_MAIN_SHA;
  attempt.output = "Review loop approved after 1 round(s).";
  attempt.verdict = { status: "pass", confidence: 1 };
  pipeline.cursor = { ...pipeline.cursor!, state: "committing" };
  savePipelines([pipeline]);
  return h;
}

test("a restarted committing review completes once when its clean head still matches (#526)", async () => {
  const h = await persistedCommittingReview();

  await tickPipelines([], h.ports);
  const completed = loadPipelines()[0]!;
  expect(completed.state).toBe("completed");
  expect(completed.runs[1]!.attempts[0]).toMatchObject({ state: "passed", reviewHeadSha: ORIGIN_MAIN_SHA });

  /* The first post-completion tick settles the terminal host reap (#574);
     from there the record is stable and further ticks change nothing. */
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.terminalReap?.settledAt).toBeTruthy();
  const afterCompletion = JSON.stringify(loadPipelines()[0]);
  expect((await tickPipelines([], h.ports)).changed).toBe(false);
  expect(JSON.stringify(loadPipelines()[0])).toBe(afterCompletion);
});

test("a restarted committing review parks when the branch head drifted after approval (#526)", async () => {
  const h = await persistedCommittingReview();
  const driftedHead = "d".repeat(40);
  const baseExec = h.ports.exec;
  h.ports.exec = (command, args, cwd) => {
    if (command === "git" && args[0] === "rev-parse" && args[1] === "HEAD") {
      return { code: 0, stdout: `${driftedHead}\n`, stderr: "" };
    }
    return baseExec(command, args, cwd);
  };

  await tickPipelines([], h.ports);
  const parked = loadPipelines()[0]!;
  expect(parked).toMatchObject({
    state: "needs_decision",
    stateDetail: expect.stringContaining(`current pipeline head is ${driftedHead}`),
  });
  expect(parked.runs[1]!.attempts[0]).toMatchObject({ state: "needs_decision", reviewHeadSha: ORIGIN_MAIN_SHA });
  expect(h.calls.some((call) => call.startsWith("git commit"))).toBe(false);
});

test("a restarted committing review parks when the clean head advances during final settlement (#526)", async () => {
  const h = await persistedCommittingReview();
  const newerHead = "c".repeat(40);
  let headReads = 0;
  const baseExec = h.ports.exec;
  h.ports.exec = (command, args, cwd) => {
    if (command === "git" && args[0] === "rev-parse" && args[1] === "HEAD") {
      headReads += 1;
      return { code: 0, stdout: `${headReads === 1 ? ORIGIN_MAIN_SHA : newerHead}\n`, stderr: "" };
    }
    return baseExec(command, args, cwd);
  };

  await tickPipelines([], h.ports);
  const parked = loadPipelines()[0]!;
  expect(headReads).toBe(2);
  expect(parked).toMatchObject({
    state: "needs_decision",
    stateDetail: expect.stringContaining(`settled ${newerHead}`),
    lastPassedCommit: ORIGIN_MAIN_SHA,
  });
  expect(parked.cursor?.stageId).toBe("review");
  expect(parked.runs[1]!.attempts[0]).toMatchObject({
    state: "needs_decision",
    reviewHeadSha: ORIGIN_MAIN_SHA,
  });
});

test("a restarted committing review parks without committing post-review changes (#526)", async () => {
  const h = await persistedCommittingReview();
  const baseExec = h.ports.exec;
  h.ports.exec = (command, args, cwd) => {
    if (command === "git" && args[0] === "status") {
      return { code: 0, stdout: " M post-review.txt\n", stderr: "" };
    }
    return baseExec(command, args, cwd);
  };

  await tickPipelines([], h.ports);
  const parked = loadPipelines()[0]!;
  expect(parked).toMatchObject({
    state: "needs_decision",
    stateDetail: expect.stringContaining("uncommitted changes"),
  });
  expect(parked.runs[1]!.attempts[0]).toMatchObject({ state: "needs_decision", reviewHeadSha: ORIGIN_MAIN_SHA });
  expect(h.calls.some((call) => call.startsWith("git add") || call.startsWith("git commit"))).toBe(false);
});

test("retrying a paused review with a live reviewer never mutates its checkout (#522)", async () => {
  const h = harness();
  const stages = [
    { id: "build", kind: "run", ["prompt"]: "build", next: "review" },
    { id: "review", kind: "review-loop", role: { roleId: "reviewer" }, ["prompt"]: "review", next: null },
  ] as const;
  const repairHead = "e".repeat(40);
  let localHead = ORIGIN_MAIN_SHA;
  let repaired = false;
  const baseExec = h.ports.exec;
  h.ports.exec = (command, args, cwd) => {
    if (command === "git" && args[0] === "status") return { code: 0, stdout: "", stderr: "" };
    if (command === "git" && args[0] === "branch" && args[1] === "--show-current") return { code: 0, stdout: `${loadPipelines()[0]!.branch}\n`, stderr: "" };
    if (command === "git" && args[0] === "rev-parse" && args[1] === "HEAD") return { code: 0, stdout: `${localHead}\n`, stderr: "" };
    /* The repair only exists on the remote once it has actually landed there;
       before that origin simply carries what the pipeline published. */
    if (command === "git" && args[0] === "ls-remote") return { code: 0, stdout: `${repaired ? repairHead : localHead}\trefs/heads/${loadPipelines()[0]!.branch}\n`, stderr: "" };
    if (command === "git" && args[0] === "rev-parse" && String(args[1]).startsWith("refs/remotes/origin/")) return { code: 0, stdout: `${repaired ? repairHead : localHead}\n`, stderr: "" };
    if (command === "git" && args[0] === "merge-base") return { code: 0, stdout: "", stderr: "" };
    if (command === "git" && args[0] === "merge" && args[1] === "--ff-only") {
      localHead = repairHead;
      return { code: 0, stdout: "", stderr: "" };
    }
    return baseExec(command, args, cwd);
  };

  const pipeline = await create(h.ports, stages as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass")], h.ports);
  await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);
  const flow = h.flows.get("flow-1")!;
  flow.rounds.push({ n: 1, reviewerPane: { paneId: "%reviewer", windowName: "reviewer" } } as never);
  flow.state = "reviewing";
  await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);
  flow.state = "paused";
  flow.stateDetail = "reviewer paused";
  await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);

  repaired = true;
  const retried = await patchPipeline(pipeline.id, { action: "retry-stage" }, h.ports);

  expect(retried).toMatchObject({ status: 409, error: expect.stringContaining("still be running") });
  expect(localHead).toBe(ORIGIN_MAIN_SHA);
  expect(h.calls).not.toContain(`git merge --ff-only refs/remotes/origin/${pipeline.branch}`);
  expect(h.calls).not.toContain("flow-close:flow-1");
});

test("retry parks without synchronizing when reviewer termination cannot be verified (#522)", async () => {
  const h = harness();
  const stages = [
    { id: "build", kind: "run", ["prompt"]: "build", next: "review" },
    { id: "review", kind: "review-loop", role: { roleId: "reviewer" }, ["prompt"]: "review", next: null },
  ] as const;
  const repairHead = "f".repeat(40);
  let localHead = ORIGIN_MAIN_SHA;
  let repaired = false;
  const baseExec = h.ports.exec;
  h.ports.exec = (command, args, cwd) => {
    if (command === "git" && args[0] === "status") return { code: 0, stdout: "", stderr: "" };
    if (command === "git" && args[0] === "branch" && args[1] === "--show-current") return { code: 0, stdout: `${loadPipelines()[0]!.branch}\n`, stderr: "" };
    if (command === "git" && args[0] === "rev-parse" && args[1] === "HEAD") return { code: 0, stdout: `${localHead}\n`, stderr: "" };
    /* The repair only exists on the remote once it has actually landed there;
       before that origin simply carries what the pipeline published. */
    if (command === "git" && args[0] === "ls-remote") return { code: 0, stdout: `${repaired ? repairHead : localHead}\trefs/heads/${loadPipelines()[0]!.branch}\n`, stderr: "" };
    if (command === "git" && args[0] === "rev-parse" && String(args[1]).startsWith("refs/remotes/origin/")) return { code: 0, stdout: `${repaired ? repairHead : localHead}\n`, stderr: "" };
    if (command === "git" && args[0] === "merge-base") return { code: 0, stdout: "", stderr: "" };
    if (command === "git" && args[0] === "merge" && args[1] === "--ff-only") {
      localHead = repairHead;
      return { code: 0, stdout: "", stderr: "" };
    }
    return baseExec(command, args, cwd);
  };

  const pipeline = await create(h.ports, stages as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass")], h.ports);
  await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);
  h.flows.get("flow-1")!.state = "done_comment";
  await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);
  h.ports.closeFlow = async () => ({ error: "reviewer process group did not terminate", status: 409 });

  repaired = true;
  const retried = await patchPipeline(pipeline.id, { action: "retry-stage" }, h.ports);

  expect(retried).toEqual({ error: "reviewer process group did not terminate", status: 409 });
  expect(localHead).toBe(ORIGIN_MAIN_SHA);
  expect(loadPipelines()[0]).toMatchObject({ state: "needs_decision", stateDetail: "reviewer process group did not terminate" });

  const skipped = await patchPipeline(pipeline.id, { action: "skip-stage" }, h.ports);
  expect(skipped).toEqual({ error: "reviewer process group did not terminate", status: 409 });
  expect(h.calls.some((call) => call.includes("reset --hard"))).toBeFalse();
  expect(loadPipelines()[0]).toMatchObject({ state: "needs_decision", stateDetail: "reviewer process group did not terminate" });

  const closed = await patchPipeline(pipeline.id, { action: "close" }, h.ports);
  /* The close carries its host-teardown report (#670) even when the flow refuses
     to close, so nothing it already stopped is swallowed by the rejection. */
  expect(closed).toMatchObject({ error: "reviewer process group did not terminate", status: 409 });
  /* A reviewer that would not die leaves through the same report a surviving
     stage host does, not only through the prose error (#670). */
  expect(closed.close).toMatchObject({
    stopped: [],
    stillRunning: [{ stageId: "review", attempt: 1, error: "reviewer process group did not terminate" }],
  });
  expect(loadPipelines()[0]).toMatchObject({ state: "needs_decision", closedAt: null, stateDetail: "reviewer process group did not terminate" });
});

test("failed stages park and retry resets to the last passed commit", async () => {
  const h = harness();
  const pipeline = await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "fail", "blocked")], h.ports);
  expect(loadPipelines()[0]!.state).toBe("needs_decision");
  await patchPipeline(pipeline.id, { action: "retry-stage" }, h.ports);
  expect(h.calls.some((call) => call.includes("reset --hard"))).toBe(true);
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(2);
});

test("issue 533: receipt retry validates the current stage and failed launch identity", async () => {
  const h = harness();
  const pipeline = await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "fail", "blocked")], h.ports);
  const parked = loadPipelines()[0]!;
  const attempt = parked.runs[0]!.attempts[0]!;
  expect(attempt.launchId).toBeString();
  const launchId = attempt.launchId!;
  h.ports.spawnReceipt = (candidate) => candidate === launchId ? {
    state: "failed", launchId, conversationId: attempt.conversationId!, sessionId: attempt.sessionId,
    "transcript": attempt.agentPath, paneId: attempt.paneId,
  } : null;

  expect(await patchPipeline(pipeline.id, {
    action: "retry-stage",
    stageId: "build",
    launchId,
  }, h.ports)).toMatchObject({ status: 409, error: expect.stringContaining("stage") });
  expect(await patchPipeline(pipeline.id, {
    action: "retry-stage",
    stageId: "plan",
    launchId: "launch-stale-history",
  }, h.ports)).toMatchObject({ status: 409, error: expect.stringContaining("launch") });
  expect(h.calls.some((call) => call.includes("reset --hard"))).toBe(false);

  expect((await patchPipeline(pipeline.id, {
    action: "retry-stage",
    stageId: "plan",
    launchId,
  }, h.ports)).pipeline?.state).toBe("running");
  expect(await patchPipeline(pipeline.id, {
    action: "retry-stage",
    stageId: "plan",
    launchId,
  }, h.ports)).toMatchObject({ status: 409 });
});

test("issue 533: a matching receipt that settles late cannot spawn a retry", async () => {
  const h = harness();
  const pipeline = await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  const parked = loadPipelines()[0]!;
  const attempt = parked.runs[0]!.attempts[0]!;
  expect(attempt.launchId).toBeString();
  const launchId = attempt.launchId!;
  attempt.state = "needs_decision";
  attempt.sessionId = null;
  attempt.agentPath = null;
  attempt.paneId = null;
  attempt.error = "stage spawn cannot recover from receipt state failed";
  parked.state = "needs_decision";
  parked.stateDetail = attempt.error;
  savePipelines([parked]);
  const spawnCount = h.calls.filter((call) => call.startsWith("spawn:")).length;
  h.ports.spawnReceipt = (candidate) => candidate === launchId ? {
    state: "completed",
    launchId,
    conversationId: attempt.conversationId!,
    sessionId: "late-success",
    "transcript": "/codex/stage-1.jsonl",
    paneId: null,
  } : null;

  expect(await patchPipeline(pipeline.id, {
    action: "retry-stage",
  }, h.ports)).toMatchObject({ status: 409, error: expect.stringContaining("settled") });
  expect(h.calls.some((call) => call.includes("reset --hard"))).toBe(false);

  await tickPipelines([], h.ports);
  expect(h.calls.filter((call) => call.startsWith("spawn:")).length).toBe(spawnCount);
  const afterTick = loadPipelines()[0]!;
  expect(afterTick).toMatchObject({
    state: "running",
    stateDetail: null,
    cursor: { stageId: "plan", state: "running" },
  });
  expect(afterTick.runs[0]!.attempts).toEqual([
    expect.objectContaining({
      state: "running",
      launchId,
      conversationId: attempt.conversationId,
      sessionId: "late-success",
      agentPath: "/codex/stage-1.jsonl",
      error: null,
    }),
  ]);
});

test("issue 533: a cross-process late recovery loses atomically to a claimed retry", async () => {
  const h = harness();
  const pipeline = await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "fail", "blocked")], h.ports);
  const registryPath = path.join(process.env.LLV_STATE_DIR!, `retry-race-${pipeline.id}.json`);
  const retryRegistry = new AgentRegistry(registryPath, undefined, undefined, { sqliteMode: "off" });
  const competingRegistry = new AgentRegistry(registryPath, undefined, undefined, { sqliteMode: "off" });
  const begun = retryRegistry.beginSpawnRequest({
    engine: "codex",
    cwd: pipeline.worktreeDir,
    transport: "structured",
    accountId: "work",
    launchProfile: { title: "Recover claimed pipeline retry" },
  });
  if (begun.kind !== "created") throw new Error("spawn receipt was unavailable");
  const key = { engine: "codex" as const, sessionId: `retry-race-${pipeline.id}` };
  const artifactPath = path.join(pipeline.worktreeDir, "late-original.jsonl");
  retryRegistry.stageStructuredSpawn(begun.receipt.launchId, {
    key, artifactPath, cwd: pipeline.worktreeDir, accountId: "work", status: "dead",
    host: null, structuredHost: null, claimEpoch: 0, claimOwner: null, pendingAction: null,
  });
  retryRegistry.failStructuredSpawn(begun.receipt.launchId, "host loss confirmed");
  const persisted = loadPipelines()[0]!;
  const attempt = persisted.runs[0]!.attempts[0]!;
  attempt.launchId = begun.receipt.launchId;
  attempt.conversationId = begun.receipt.conversationId;
  attempt.sessionId = key.sessionId;
  attempt.agentPath = artifactPath;
  attempt.paneId = null;
  savePipelines([persisted]);
  h.ports.spawnReceipt = (launchId) => {
    const receipt = retryRegistry.readOnlySnapshot().receipts[launchId];
    return receipt ? {
      state: receipt.state, launchId, conversationId: receipt.conversationId,
      sessionId: receipt.key?.sessionId ?? null, "transcript": receipt.artifactPath, paneId: null,
    } : null;
  };
  let lateRecovery: ReturnType<AgentRegistryType["recoverStructuredSpawnFromEvidence"]> | null = null;
  h.ports.claimSpawnRetry = (launchId, claimId) => {
    const claim = retryRegistry.claimFailedSpawnForRetry(launchId, claimId);
    lateRecovery = competingRegistry.recoverStructuredSpawnFromEvidence(launchId, {
      key, artifactPath, cwd: pipeline.worktreeDir, accountId: "work",
      launchProfile: begun.receipt.launchProfile, status: "live", host: null, structuredHost: null,
      claimEpoch: 0, claimOwner: null, pendingAction: null,
    });
    return claim.kind;
  };
  const spawnCount = h.calls.filter((call) => call.startsWith("spawn:")).length;

  expect((await patchPipeline(pipeline.id, {
    action: "retry-stage",
  }, h.ports)).pipeline?.state).toBe("running");
  expect(lateRecovery).toMatchObject({ kind: "conflict" });
  expect(competingRegistry.snapshot().receipts[begun.receipt.launchId]).toMatchObject({
    state: "failed",
    retryClaim: { claimId: expect.any(String) },
  });
  await tickPipelines([], h.ports);
  expect(h.calls.filter((call) => call.startsWith("spawn:")).length).toBe(spawnCount + 1);
});

test("a stage retry supersedes the prior attempt's conversation and numbers its round (#383)", async () => {
  const h = harness();
  const pipeline = await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  expect(h.calls).toContain(`spawn:pipeline_${pipeline.id}_plan_1:parent=/codex/creator.jsonl:supersedes=none`);

  await tickPipelines([h.finish("/codex/stage-1.jsonl", "fail", "blocked")], h.ports);
  await patchPipeline(pipeline.id, { action: "retry-stage" }, h.ports);
  await tickPipelines([], h.ports);

  /* Attempt 2 chains onto attempt 1's conversation; the durable membership
     carries the round so decks number chained recoveries. */
  expect(h.calls).toContain(`spawn:pipeline_${pipeline.id}_plan_2:parent=/codex/creator.jsonl:supersedes=conversation_stage_1`);
  expect(h.calls).toContain(`membership:pipeline:${pipeline.id}:plan:2:architect:0:round=2`);

  /* A second failure and retry chains again from attempt 2, never re-naming
     attempt 1 — chains stay linear across repeated recovery. */
  await tickPipelines([h.finish("/codex/stage-2.jsonl", "fail", "still blocked")], h.ports);
  await patchPipeline(pipeline.id, { action: "retry-stage" }, h.ports);
  await tickPipelines([], h.ports);
  expect(h.calls).toContain(`spawn:pipeline_${pipeline.id}_plan_3:parent=/codex/creator.jsonl:supersedes=conversation_stage_2`);
});

test("issue 533: retry replays the pipeline launch contract from durable stage state", async () => {
  const h = harness();
  const launches: Array<Parameters<PipelinePorts["spawnAgent"]>[0]> = [];
  const spawn = h.ports.spawnAgent;
  h.ports.spawnAgent = async (input, onReserved) => {
    launches.push(structuredClone(input));
    return spawn(input, onReserved);
  };
  const pipeline = await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "fail", "blocked")], h.ports);
  const firstAttempt = loadPipelines()[0]!.runs[0]!.attempts[0]!;
  expect(firstAttempt.launchId).toBeString();
  h.ports.spawnReceipt = (candidate) => candidate === firstAttempt.launchId ? {
    state: "failed", launchId: firstAttempt.launchId!, conversationId: firstAttempt.conversationId!,
    sessionId: firstAttempt.sessionId, "transcript": firstAttempt.agentPath, paneId: firstAttempt.paneId,
  } : null;
  await patchPipeline(pipeline.id, {
    action: "retry-stage", stageId: "plan", launchId: firstAttempt.launchId!,
  }, h.ports);
  await tickPipelines([], h.ports);

  const [first, retry] = launches;
  expect(retry).toMatchObject({
    role: first!.role,
    cwd: first!.cwd,
    "prompt": first!.prompt,
    parentPath: first!.parentPath,
    creatorConversationId: first!.creatorConversationId,
    membership: {
      kind: "pipeline", containerId: pipeline.id, role: first!.membership.role,
      stageId: "plan", stageOrder: 0, parentConversationId: null,
    },
    supersedes: "conversation_stage_1",
  });
  expect(retry!.membership.slot).toBe("plan:2");
  expect(retry!.membership.round).toBe(2);
});

test("a retried attempt whose predecessor never reserved a conversation records nothing (#383)", async () => {
  const h = harness();
  const pipeline = await create(h.ports);
  h.ports.spawnAgent = async (input, onReserved) => {
    h.calls.push(`spawn:${input.clientAttemptId}:supersedes=${input.supersedes ?? "none"}`);
    if (input.clientAttemptId.endsWith("_1")) throw new Error("spawn transport unavailable");
    onReserved({ launchId: "launch-late", conversationId: "conversation_stage_late" });
    return { launchId: "launch-late", conversationId: "conversation_stage_late", sessionId: "session-late", transcript: "/codex/stage-late.jsonl", paneId: "%9" };
  };
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.state).toBe("needs_decision");

  await patchPipeline(pipeline.id, { action: "retry-stage" }, h.ports);
  await tickPipelines([], h.ports);
  expect(h.calls).toContain(`spawn:pipeline_${pipeline.id}_plan_2:supersedes=none`);
});

test("skip-stage cleans failed work before advancing", async () => {
  const h = harness();
  const pipeline = await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "needs_decision", "operator choice")], h.ports);
  const result = await patchPipeline(pipeline.id, { action: "skip-stage" }, h.ports);
  expect(result.pipeline?.cursor?.stageId).toBe("build");
  expect(h.calls.some((call) => call.includes("reset --hard"))).toBe(true);
  expect(h.calls.some((call) => call.includes("clean -fd"))).toBe(true);
});

test("a corrupt SQLite pipeline row skips the tick without escalating", async () => {
  const h = harness();
  await create(h.ports);
  const database = new Database(path.join(process.env.LLV_STATE_DIR!, "state.sqlite"), { strict: true });
  database.exec("BEGIN IMMEDIATE");
  const revision = database.query<{ revision: number }, []>(
    "SELECT revision FROM state_collections WHERE collection = 'pipelines'",
  ).get()!.revision + 1;
  const key = database.query<{ row_key: string }, []>(
    "SELECT row_key FROM state_rows WHERE collection = 'pipelines' LIMIT 1",
  ).get()!.row_key;
  database.query("UPDATE state_rows SET value_json = '{}', row_revision = ? WHERE collection = 'pipelines' AND row_key = ?")
    .run(revision, key);
  database.query("UPDATE state_collections SET revision = ? WHERE collection = 'pipelines'").run(revision);
  database.query("INSERT INTO state_changes(collection, revision, row_key, operation) VALUES ('pipelines', ?, ?, 'upsert')")
    .run(revision, key);
  database.exec("COMMIT");
  database.close();
  expect(await tickPipelines([], h.ports)).toEqual({ pipelines: [], changed: false });
  savePipelines([]);
});

test("retry and skip leave verdict-recovery exhaustion only when reset preserves all work (#879)", async () => {
  const exhaust = async (h: ReturnType<typeof harness>) => {
    const pipeline = await create(h.ports);
    await tickPipelines([], h.ports);
    await tickPipelines([], h.ports);
    h.messages.set("/codex/stage-1.jsonl", { text: "narrative without a JSON verdict", ts: 2_000_000 });
    const entries = [entry("/codex/stage-1.jsonl")];
    await tickPipelines(entries, h.ports);
    await exhaustVerdictRecovery(h, entries);
    expect(loadPipelines()[0]!.state).toBe("needs_decision");
    return pipeline;
  };

  for (const action of ["retry-stage", "skip-stage"] as const) {
    const clean = harness();
    const cleanPipeline = await exhaust(clean);
    clean.setPaneAlive(false);

    const recovered = await patchPipeline(cleanPipeline.id, { action }, clean.ports);

    expect(recovered.error).toBeUndefined();
    expect(clean.calls.some((call) => call.includes("reset --hard"))).toBe(true);
    expect(clean.calls.some((call) => call.includes("clean -fd"))).toBe(true);

    const dirty = harness();
    const dirtyPipeline = await exhaust(dirty);
    const baseExec = dirty.ports.exec;
    dirty.ports.exec = (command, args, cwd) => command === "git" && args[0] === "status"
      ? { code: 0, stdout: " M src/lib/example.ts\n", stderr: "" }
      : baseExec(command, args, cwd);

    const refused = await patchPipeline(dirtyPipeline.id, { action }, dirty.ports);

    expect(refused.status).toBe(409);
    expect(refused.error).toContain("close");
    expect(dirty.calls.some((call) => call.includes("reset --hard") || call.includes("clean -fd"))).toBe(false);

    const publishedAhead = harness();
    const publishedAheadPipeline = await exhaust(publishedAhead);
    const publishedAheadHead = "a".repeat(40);
    const publishedAheadExec = publishedAhead.ports.exec;
    publishedAhead.ports.exec = (command, args, cwd) => {
      if (command === "git" && args[0] === "rev-parse" && args[1] === "HEAD") {
        return { code: 0, stdout: `${publishedAheadHead}\n`, stderr: "" };
      }
      if (command === "git" && args[0] === "ls-remote") {
        return { code: 0, stdout: `${publishedAheadHead}\trefs/heads/${publishedAheadPipeline.branch}\n`, stderr: "" };
      }
      return publishedAheadExec(command, args, cwd);
    };

    const refusedAhead = await patchPipeline(publishedAheadPipeline.id, { action }, publishedAhead.ports);

    expect(refusedAhead.status).toBe(409);
    expect(refusedAhead.error).toContain("close");
    expect(publishedAhead.calls.some((call) => call.includes("reset --hard") || call.includes("clean -fd"))).toBe(false);
  }
});

test("retry and skip recover a completed pane-hosted semantic contradiction", async () => {
  for (const action of ["retry-stage", "skip-stage"] as const) {
    const h = harness();
    const pipeline = await create(h.ports);
    await tickPipelines([], h.ports);
    await tickPipelines([], h.ports);
    h.messages.set("/codex/stage-1.jsonl", {
      text: [
        "VERDICT: REQUEST_CHANGES",
        "",
        "```json",
        '{"status":"pass"}',
        "```",
      ].join("\n"),
      ts: 5_000_000,
    });
    await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);

    const parkedAttempt = loadPipelines()[0]!.runs[0]!.attempts[0]!;
    expect(parkedAttempt).toMatchObject({
      state: "needs_decision",
      paneId: "%1",
      verdict: null,
      error: 'contradictory stage verdict: prose marker "REQUEST_CHANGES" disagrees with JSON status "pass"',
    });
    expect(parkedAttempt.completedAt).toBeTruthy();

    const recovered = await patchPipeline(pipeline.id, { action }, h.ports);
    expect(recovered.error).toBeUndefined();
    expect(recovered.pipeline?.state).toBe("running");
    expect(recovered.pipeline?.cursor).toEqual({
      stageId: action === "retry-stage" ? "plan" : "build",
      state: "pending",
      input: action === "retry-stage" ? null : "Skipped by operator.",
      activatedBy: action === "retry-stage" ? null : { stageId: "plan", attempt: 1, edge: "pass" },
    });
  }
});

test("closing a mid-run or parked pipeline persists a record that loads back", async () => {
  const h = harness();
  /* No host and no live pane behind these stages: the close has nothing to stop
     and records the closed pipeline. A live pane is covered separately (#670). */
  h.setPaneAlive(false);
  const running = await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.cursor).not.toBeNull();
  const closed = await patchPipeline(running.id, { action: "close" }, h.ports);
  expect(closed.pipeline?.state).toBe("closed");
  expect(closed.pipeline?.cursor).toBeNull();
  expect(loadPipelines()[0]!.state).toBe("closed");

  /* The second spawn in this harness lands in stage-2.jsonl. */
  const parked = await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-2.jsonl", "fail", "blocked")], h.ports);
  expect(loadPipelines()[0]!.state).toBe("needs_decision");
  await patchPipeline(parked.id, { action: "close" }, h.ports);
  expect(loadPipelines()[0]!).toMatchObject({ state: "closed", cursor: null });
});

test("closing a running pipeline terminates its stage host and reports the stop (#670)", async () => {
  const h = harness();
  const pipeline = await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  h.setStageHost("conversation_stage_1", { outcome: "stopped" });

  const closed = await patchPipeline(pipeline.id, { action: "close" }, h.ports);

  expect(h.calls).toContain("stop-host:plan:1:conversation_stage_1");
  expect(closed.error).toBeUndefined();
  expect(closed.close).toMatchObject({
    stopped: [{ stageId: "plan", attempt: 1, conversationId: "conversation_stage_1", agentPath: "/codex/stage-1.jsonl" }],
    alreadyStopped: [],
    stillRunning: [],
  });
  expect(loadPipelines()[0]).toMatchObject({
    state: "closed",
    cursor: null,
    stateDetail: "closed; stopped 1 stage host",
  });
});

test("closing probes every host the pipeline launched, settled rounds included (#670)", async () => {
  const h = harness();
  const pipeline = await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  /* A settled round's attempt state says nothing about its host: the passed
     round below is still resident, and a close that trusted the state machine
     would leave it burning quota. */
  const stored = loadPipelines();
  const buildRun = stored[0]!.runs.find((run) => run.stageId === "build")!;
  const template = stored[0]!.runs[0]!.attempts[0]!;
  buildRun.attempts.push(
    { ...structuredClone(template), n: 1, state: "passed", verdict: { status: "pass" }, conversationId: "conversation_stage_settled", agentPath: "/codex/stage-settled.jsonl", completedAt: h.ports.now() },
    { ...structuredClone(template), n: 2, state: "running", conversationId: "conversation_stage_2", agentPath: "/codex/stage-2.jsonl" },
  );
  savePipelines(stored);
  h.setStageHost("conversation_stage_1", { outcome: "stopped" });
  h.setStageHost("conversation_stage_settled", { outcome: "stopped" });
  h.setStageHost("conversation_stage_2", { outcome: "stopped" });

  const closed = await patchPipeline(pipeline.id, { action: "close" }, h.ports);

  expect(h.calls).toContain("stop-host:build:1:conversation_stage_settled");
  expect(closed.close?.stopped.map((item) => `${item.stageId}:${item.attempt}`)).toEqual(["plan:1", "build:1", "build:2"]);
  expect(loadPipelines()[0]!.stateDetail).toBe("closed; stopped 3 stage hosts");
});

test("a parked stage whose host is still resident is stopped, not read as terminal (#670)", async () => {
  const h = harness();
  const pipeline = await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  /* park() writes needs_decision while the agent process is still there — the
     7.5-hour orphans of #670 were exactly this shape. */
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "needs_decision", "operator choice")], h.ports);
  const parked = loadPipelines()[0]!.runs[0]!.attempts[0]!;
  expect(parked.state).toBe("needs_decision");
  h.setStageHost("conversation_stage_1", { outcome: "stopped" });

  const closed = await patchPipeline(pipeline.id, { action: "close" }, h.ports);

  expect(h.calls).toContain("stop-host:plan:1:conversation_stage_1");
  expect(closed.close?.stopped).toMatchObject([{ stageId: "plan", attempt: 1, conversationId: "conversation_stage_1" }]);
  expect(loadPipelines()[0]).toMatchObject({ state: "closed", stateDetail: "closed; stopped 1 stage host" });
});

test("a parked stage with no resident host still reports nothing was running (#670)", async () => {
  const h = harness();
  h.setPaneAlive(false);
  const pipeline = await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "needs_decision", "operator choice")], h.ports);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.state).toBe("needs_decision");

  const closed = await patchPipeline(pipeline.id, { action: "close" }, h.ports);

  expect(closed.close).toMatchObject({
    stopped: [],
    alreadyStopped: [{ stageId: "plan", attempt: 1, conversationId: "conversation_stage_1" }],
    stillRunning: [],
  });
  expect(loadPipelines()[0]).toMatchObject({ state: "closed", stateDetail: null });
});

test("closing a pipeline whose host is already gone reports that nothing was running (#670)", async () => {
  const h = harness();
  h.setPaneAlive(false);
  h.setPaneStop({ outcome: "not-running" });
  const pipeline = await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);

  const closed = await patchPipeline(pipeline.id, { action: "close" }, h.ports);

  expect(closed.close).toMatchObject({
    stopped: [],
    alreadyStopped: [{ stageId: "plan", attempt: 1, conversationId: "conversation_stage_1" }],
    unconfirmed: [],
    stillRunning: [],
  });
  /* "closed, nothing was running" carries no stop claim of any kind. */
  expect(loadPipelines()[0]).toMatchObject({ state: "closed", stateDetail: null });
});

test("an accepted but unconfirmed kill never counts as a clean stop (#670)", async () => {
  const h = harness();
  const pipeline = await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  h.setStageHost("conversation_stage_1", {
    outcome: "unconfirmed",
    operationId: "kill-op-1",
    detail: "kill accepted as queued but termination was not confirmed",
  });

  const closed = await patchPipeline(pipeline.id, { action: "close" }, h.ports);

  /* A queued receipt is the normal first answer, so this still closes — but it
     records no stop and names the operation that may have left a survivor. */
  expect(closed.error).toBeUndefined();
  expect(closed.close).toMatchObject({
    stopped: [],
    stillRunning: [],
    unconfirmed: [{ stageId: "plan", attempt: 1, operationId: "kill-op-1" }],
  });
  expect(loadPipelines()[0]!.stateDetail).toBe(
    "closed; kill accepted as queued but termination was not confirmed for stage plan attempt 1 (conversation_stage_1) (operation kill-op-1)",
  );
  /* The possible survivor stays addressable: the lane is not hidden, and the
     durable record names the operation to chase. */
  const parked = loadPipelines()[0]!;
  expect(parked.hiddenAt).toBeNull();
  expect(parked.unconfirmedHosts).toMatchObject([{ stageId: "plan", attempt: 1, operationId: "kill-op-1" }]);

  /* Closing again once the kill is confirmed settles the lane and hides it. */
  h.setStageHost("conversation_stage_1", { outcome: "stopped" });
  const settled = await patchPipeline(pipeline.id, { action: "close" }, h.ports);
  expect(settled.close?.unconfirmed).toEqual([]);
  expect(loadPipelines()[0]!.unconfirmedHosts).toBeUndefined();
  expect(loadPipelines()[0]!.hiddenAt).toBe(loadPipelines()[0]!.closedAt);
});

test("a teardown that runs out of budget reports the hosts it never probed (#670)", async () => {
  const h = harness();
  const pipeline = await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  const stored = loadPipelines();
  const buildRun = stored[0]!.runs.find((run) => run.stageId === "build")!;
  const template = stored[0]!.runs[0]!.attempts[0]!;
  buildRun.attempts.push({ ...structuredClone(template), n: 1, state: "running", conversationId: "conversation_stage_2", agentPath: "/codex/stage-2.jsonl", paneId: "%2" });
  savePipelines(stored);
  h.setStageHost("conversation_stage_1", { outcome: "stopped" });
  h.setStageHost("conversation_stage_2", { outcome: "stopped" });
  /* The clock jumps past the aggregate ceiling after the first host: the close
     holds the pipelines transaction, so it must stop working, not run long. */
  let reading = 0;
  h.setMonotonicClock(() => (reading += 60_000));

  const closed = await patchPipeline(pipeline.id, { action: "close" }, h.ports);

  expect(closed.error).toBeUndefined();
  expect(closed.close?.stopped).toMatchObject([{ stageId: "plan", attempt: 1 }]);
  /* Truthful, not silent: the unprobed host is named, and the lane stays
     visible so a later close finishes the work. */
  expect(closed.close?.unconfirmed).toMatchObject([
    { stageId: "build", attempt: 1, operationId: null, detail: "close teardown budget expired before this host was probed" },
  ]);
  expect(h.calls).not.toContain("stop-host:build:1:conversation_stage_2");
  const record = loadPipelines()[0]!;
  expect(record.hiddenAt).toBeNull();
  expect(record.unconfirmedHosts).toHaveLength(1);
});

test("an unconfirmed host record retires once its host is demonstrably gone (#670)", async () => {
  const h = harness();
  h.setPaneAlive(false);
  const pipeline = await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  h.setStageHost("conversation_stage_1", {
    outcome: "unconfirmed",
    operationId: "kill-op-1",
    detail: "kill accepted as queued but termination was not confirmed",
  });
  await patchPipeline(pipeline.id, { action: "close" }, h.ports);
  expect(loadPipelines()[0]!.unconfirmedHosts).toHaveLength(1);

  /* Still resident: the lane keeps its record and stays on the board. */
  h.setHostsResident(true);
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]).toMatchObject({ hiddenAt: null });
  expect(loadPipelines()[0]!.unconfirmedHosts).toHaveLength(1);

  /* Gone: the record retires and the closed lane hides like any other. */
  h.setHostsResident(false);
  await tickPipelines([], h.ports);
  const settled = loadPipelines()[0]!;
  expect(settled.unconfirmedHosts).toBeUndefined();
  expect(settled.hiddenAt).toBe(settled.closedAt);
  /* The probe never kills anything — it only reads. */
  expect(h.calls.filter((call) => call.startsWith("stop-host:")).length).toBe(1);
});

test("an adopted stage child is stopped and counted, never silently left running (#670)", async () => {
  const h = harness();
  const pipeline = await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  /* The build agent spawned a helper through the viewer; adoptAttempt seats it
     on the stage run as historical and running, with its own live host. */
  const stored = loadPipelines();
  const run = stored[0]!.runs[0]!;
  run.attempts.push({
    ...structuredClone(run.attempts[0]!),
    n: 2,
    historical: true,
    state: "running",
    conversationId: "conversation_helper",
    agentPath: "/codex/helper.jsonl",
    paneId: "%9",
  });
  savePipelines(stored);
  h.setHostsResident(true);
  h.setStageHost("conversation_stage_1", { outcome: "stopped" });
  h.setStageHost("conversation_helper", { outcome: "stopped" });

  const closed = await patchPipeline(pipeline.id, { action: "close" }, h.ports);

  expect(h.calls).toContain("stop-host:plan:2:conversation_helper");
  expect(closed.close?.stopped).toMatchObject([
    { attempt: 1, conversationId: "conversation_stage_1" },
    { attempt: 2, conversationId: "conversation_helper", adopted: true },
  ]);
  expect(loadPipelines()[0]!.stateDetail).toBe("closed; stopped 1 stage host; stopped 1 adopted agent");
});

test("an adopted child that cannot be stopped keeps the lane visible (#670)", async () => {
  const h = harness();
  const pipeline = await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  const stored = loadPipelines();
  const run = stored[0]!.runs[0]!;
  run.attempts.push({
    ...structuredClone(run.attempts[0]!),
    n: 2,
    historical: true,
    state: "running",
    conversationId: "conversation_helper",
    agentPath: "/codex/helper.jsonl",
    paneId: null,
  });
  savePipelines(stored);
  h.setHostsResident(true);
  h.setStageHost("conversation_stage_1", { outcome: "stopped" });
  h.setStageHost("conversation_helper", { outcome: "failed", error: "structured host ownership is unavailable" });

  const refused = await patchPipeline(pipeline.id, { action: "close" }, h.ports);

  expect(refused.status).toBe(409);
  expect(refused.error).toContain("adopted agent of stage plan attempt 2");
  expect(loadPipelines()[0]!.state).not.toBe("closed");
});

test("an unidentifiable pane can be dismissed by the operator once judged (#670)", async () => {
  const h = harness();
  const pipeline = await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  h.setPaneAlive(true);
  h.setPaneStop({
    outcome: "unknown",
    detail: "pane %1 now runs codex in window other and cannot be identified as this stage's agent",
  });

  const pinned = await patchPipeline(pipeline.id, { action: "close" }, h.ports);
  expect(pinned.close?.unconfirmed).toHaveLength(1);
  expect(loadPipelines()[0]!.hiddenAt).toBeNull();
  /* The detail names what the pane actually shows, so the operator can find it. */
  expect(loadPipelines()[0]!.stateDetail).toContain("now runs codex in window other");

  /* Their judgement is the way out: the lane stops claiming a host it could
     never identify, and leaves the board. */
  const dismissed = await patchPipeline(pipeline.id, { action: "close", acknowledgeHosts: true }, h.ports);

  expect(dismissed.error).toBeUndefined();
  expect(dismissed.close?.acknowledged).toMatchObject([{ stageId: "plan", attempt: 1, paneId: "%1" }]);
  expect(dismissed.close?.unconfirmed).toEqual([]);
  const settled = loadPipelines()[0]!;
  expect(settled.unconfirmedHosts).toBeUndefined();
  expect(settled.hiddenAt).toBe(settled.closedAt);
  expect(settled.stateDetail).toContain("dismissed 1 unconfirmed host");
});

test("an acknowledgement never dismisses a host that is provably still running (#670)", async () => {
  const h = harness();
  const pipeline = await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  h.setHostsResident(true);
  h.setStageHost("conversation_stage_1", { outcome: "failed", error: "structured host ownership is unavailable" });

  const refused = await patchPipeline(pipeline.id, { action: "close", acknowledgeHosts: true }, h.ports);

  expect(refused.status).toBe(409);
  expect(refused.close?.acknowledged).toEqual([]);
  expect(loadPipelines()[0]!.state).not.toBe("closed");
});

test("closing mid-review counts the reviewer it stopped (#670)", async () => {
  const h = harness();
  const stages = [
    { id: "build", kind: "run", ["prompt"]: "build", next: "review" },
    { id: "review", kind: "review-loop", role: { roleId: "reviewer" }, ["prompt"]: "review", next: null },
  ] as const;
  const pipeline = await create(h.ports, stages as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass")], h.ports);
  await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);
  h.setPaneAlive(false);
  h.setPaneStop({ outcome: "not-running" });
  /* A headless reviewer is a child process with no registry entry, so the host
     teardown cannot see it — closeFlow is what stops it. */
  h.ports.closeFlow = async (id) => {
    h.calls.push(`flow-close:${id}`);
    return { flow: h.flows.get(id), stoppedReviewer: { round: 1 } };
  };

  const closed = await patchPipeline(pipeline.id, { action: "close" }, h.ports);

  expect(closed.error).toBeUndefined();
  expect(closed.close?.reviewers).toMatchObject([{ stageId: "review", flowId: "flow-1", round: 1 }]);
  /* The lane must not report "closed, nothing was running" after killing one. */
  expect(loadPipelines()[0]!.stateDetail).toBe("closed; stopped 1 review round");
});

test("a worktree removed after a merge closes tidily, with no error text (#670)", async () => {
  const h = harness();
  h.setPaneAlive(false);
  h.setPaneStop({ outcome: "not-running" });
  const baseExec = h.ports.exec;
  h.ports.exec = (command, args, cwd) => {
    /* What realExec answers for a missing cwd. It must never be reached. */
    if (command === "git" && args[0] === "status") return { code: 1, stdout: "", stderr: "spawnSync git ENOENT" };
    return baseExec(command, args, cwd);
  };
  const pipeline = await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  h.setWorktreePresent(false);

  const closed = await patchPipeline(pipeline.id, { action: "close" }, h.ports);

  expect(closed.close?.worktree).toBeNull();
  expect(loadPipelines()[0]).toMatchObject({ state: "closed", stateDetail: null });
});

test("a settled attempt with an idle CLI in its pane does not block the close (#670)", async () => {
  const h = harness();
  const pipeline = await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  /* A verdict means the turn ended, so what is left in the pane is an idle CLI —
     the exemption orphanAgentPane applies to a retry. The pane stays alive here. */
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass")], h.ports);
  const settled = loadPipelines()[0]!.runs[0]!.attempts[0]!;
  expect(settled.verdict).toMatchObject({ status: "pass" });
  expect(settled.paneId).toBe("%1");

  const closed = await patchPipeline(pipeline.id, { action: "close" }, h.ports);

  expect(closed.error).toBeUndefined();
  expect(closed.close?.stillRunning).toEqual([]);
  expect(closed.close?.alreadyStopped).toMatchObject([{ stageId: "plan", attempt: 1 }]);
  expect(loadPipelines()[0]!.state).toBe("closed");
});

test("a pane the teardown can identify as this stage's is stopped, not refused (#670)", async () => {
  const h = harness();
  const pipeline = await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  /* The registry has no resident host but the pane's recorded identity still
     matches, so the orphan is stopped instead of handed back to the operator. */
  h.setPaneAlive(true);
  h.setPaneStop({ outcome: "stopped" });

  const closed = await patchPipeline(pipeline.id, { action: "close" }, h.ports);

  expect(closed.error).toBeUndefined();
  expect(h.calls).toContain("stop-pane:plan:1:%1");
  expect(h.killedPanes).toEqual(["%1"]);
  expect(closed.close?.stopped).toMatchObject([{ stageId: "plan", attempt: 1, paneId: "%1" }]);
  expect(loadPipelines()[0]).toMatchObject({ state: "closed", stateDetail: "closed; stopped 1 stage host" });
});

test("close terminalizes a running attempt after confirmed host and pane absence (#1047, #988)", async () => {
  for (const absent of ["structured-host", "pane"] as const) {
    const h = harness();
    const pipeline = await create(h.ports);
    await tickPipelines([], h.ports);
    await tickPipelines([], h.ports);
    const stored = loadPipelines()[0]!;
    const attempt = stored.runs[0]!.attempts[0]!;
    expect(attempt).toMatchObject({ state: "running", completedAt: null });
    if (absent === "structured-host") attempt.paneId = null;
    else h.setPaneStop({ outcome: "not-running" });
    savePipelines([stored]);

    const closed = await patchPipeline(pipeline.id, { action: "close" }, h.ports);

    expect(closed.error).toBeUndefined();
    expect(closed.close?.alreadyStopped).toMatchObject([{ stageId: "plan", attempt: 1 }]);
    expect(loadPipelines()[0]!.runs[0]!.attempts[0]).toMatchObject({
      state: "failed",
      completedAt: expect.any(String),
    });
  }
});

test("a pane that cannot be identified is reported, never killed (#670)", async () => {
  const h = harness();
  const pipeline = await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  h.setPaneAlive(true);
  h.setPaneStop({ outcome: "unknown", detail: "pane %1 runs an agent that cannot be identified as this stage's" });

  const closed = await patchPipeline(pipeline.id, { action: "close" }, h.ports);

  /* Unidentifiable is neither a stop nor a silent pass: nothing was signalled,
     and the lane stays visible with the pane named. */
  expect(h.killedPanes).toEqual([]);
  expect(closed.close?.stopped).toEqual([]);
  expect(closed.close?.unconfirmed).toMatchObject([{ stageId: "plan", attempt: 1, paneId: "%1", operationId: null }]);
  expect(loadPipelines()[0]!.hiddenAt).toBeNull();
  expect(loadPipelines()[0]!.stateDetail).toContain("cannot be identified");
});

test("an unreadable worktree is reported instead of closing as if nothing was left (#670)", async () => {
  const h = harness();
  h.setPaneAlive(false);
  h.setPaneStop({ outcome: "not-running" });
  const baseExec = h.ports.exec;
  let failStatus = false;
  h.ports.exec = (command, args, cwd) => {
    if (failStatus && command === "git" && args[0] === "status") {
      return { code: 128, stdout: "", stderr: "fatal: not a git repository" };
    }
    return baseExec(command, args, cwd);
  };
  const pipeline = await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  failStatus = true;

  const closed = await patchPipeline(pipeline.id, { action: "close" }, h.ports);

  expect(closed.error).toBeUndefined();
  expect(closed.close?.worktree).toMatchObject({ uncommitted: [], error: "checking the pipeline worktree: fatal: not a git repository" });
  /* An unreadable worktree must not look like a verified-clean one. */
  expect(loadPipelines()[0]!.stateDetail).toBe(
    `closed; could not read the worktree at ${loadPipelines()[0]!.worktreeDir}: checking the pipeline worktree: fatal: not a git repository`,
  );
});

test("a stage host that cannot be stopped refuses the close instead of hiding it (#670)", async () => {
  const h = harness();
  const pipeline = await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  h.setHostsResident(true);
  h.setStageHost("conversation_stage_1", { outcome: "failed", error: "structured host ownership is unavailable" });

  const refused = await patchPipeline(pipeline.id, { action: "close" }, h.ports);

  expect(refused.status).toBe(409);
  expect(refused.error).toBe(
    "could not stop stage plan attempt 1 (conversation_stage_1): structured host ownership is unavailable",
  );
  expect(refused.close?.stillRunning).toMatchObject([{ stageId: "plan", conversationId: "conversation_stage_1" }]);
  const stored = loadPipelines()[0]!;
  expect(stored.state).not.toBe("closed");
  expect(stored.closedAt).toBeNull();
  expect(stored.stateDetail).toContain("structured host ownership is unavailable");
});

test("terminal transcript prose without a valid fenced verdict cannot dismiss a resident host (#1047, #988)", async () => {
  for (const text of [
    "Review completed with no findings.",
    "Review completed.\n\n```json\n{\"status\":\"pass\",\"findings\":\"none\",\"confidence\":0.9}\n```",
  ]) {
    const h = harness();
    const pipeline = await create(h.ports);
    await tickPipelines([], h.ports);
    await tickPipelines([], h.ports);
    h.setHostsResident(true);
    h.setStageHost("conversation_stage_1", { outcome: "failed", error: "structured runtime host is unavailable" });
    h.durableTurns.set("/codex/stage-1.jsonl", {
      turn: "terminal",
      message: { text, ts: 5_000_000 },
    });

    const refused = await patchPipeline(pipeline.id, { action: "close" }, h.ports);

    expect(refused.status).toBe(409);
    expect(refused.close?.stillRunning).toMatchObject([{ stageId: "plan", attempt: 1 }]);
    expect(loadPipelines()[0]).toMatchObject({ state: "running", closedAt: null });
  }
});

test("close terminalizes host-unavailable attempts from durable evidence and records the failure (#1047, #988)", async () => {
  for (const evidence of ["registry-absent", "terminal-transcript"] as const) {
    const h = harness();
    const pipeline = await create(h.ports);
    await tickPipelines([], h.ports);
    await tickPipelines([], h.ports);
    const stored = loadPipelines()[0]!;
    const attempt = stored.runs[0]!.attempts[0]!;
    attempt.state = "needs_decision";
    attempt.error = "operator decision was resolved after the work merged";
    stored.state = "needs_decision";
    stored.stateDetail = attempt.error;
    savePipelines([stored]);
    const stopError = evidence === "registry-absent"
      ? "structured host termination is unavailable"
      : "structured host termination target is unavailable";
    h.setStageHost("conversation_stage_1", { outcome: "failed", error: stopError });

    if (evidence === "terminal-transcript") {
      h.setHostsResident(true);
      h.durableTurns.set("/codex/stage-1.jsonl", {
        turn: "terminal",
        message: {
          text: "Completed review.\n\n```json\n{\"status\":\"needs_decision\",\"findings\":[],\"confidence\":0.9}\n```",
          ts: 5_000_000,
        },
      });
    }

    const closed = await patchPipeline(pipeline.id, { action: "close" }, h.ports);

    expect(closed.error).toBeUndefined();
    expect(closed.close?.alreadyStopped).toMatchObject([{ stageId: "plan", attempt: 1 }]);
    expect(closed.close?.notes).toMatchObject([{ stageId: "plan", attempt: 1, detail: expect.stringContaining(stopError) }]);
    const terminal = loadPipelines()[0]!;
    expect(terminal.state).toBe("closed");
    expect(terminal.runs[0]!.attempts[0]!.completedAt).toBeTruthy();
    expect(terminal.stateDetail).toContain(stopError);
  }
});

/* #1141 — the sibling case of transcript terminalization. A provider limit cuts
   the stage turn off mid-flight, so the transcript's last record is the CLI's
   own notice and there is no verdict to read; the close then had no terminal
   reading at all and refused, parking the lane on the board forever. The
   fixtures below are written here, never lifted from a live transcript. */
const PROVIDER_LIMIT_NOTICE = "You've hit your session limit. Try again once the window resets.";

function stageTranscript(name: string, records: Record<string, unknown>[]): string {
  const file = path.join(process.env.LLV_STATE_DIR!, `${name}.jsonl`);
  fs.writeFileSync(file, records.map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");
  return file;
}

function limitInterruptedTranscript(name: string): string {
  return stageTranscript(name, [
    { type: "user", timestamp: "2026-08-27T09:00:00.000Z", message: { role: "user", content: "run the stage" } },
    {
      type: "assistant",
      timestamp: "2026-08-27T09:20:00.000Z",
      message: { role: "assistant", stop_reason: null, content: [{ type: "text", text: "opening the failing test" }] },
    },
    {
      type: "assistant",
      timestamp: "2026-08-27T09:41:00.000Z",
      isApiErrorMessage: true,
      error: "rate_limit",
      message: {
        role: "assistant",
        model: "<synthetic>",
        stop_reason: "stop_sequence",
        content: [{ type: "text", text: PROVIDER_LIMIT_NOTICE }],
      },
    },
  ]);
}

function verdictTranscript(name: string, status: "pass" | "needs_decision" = "pass"): string {
  return stageTranscript(name, [
    { type: "user", timestamp: "2026-08-27T09:00:00.000Z", message: { role: "user", content: "run the stage" } },
    {
      type: "assistant",
      timestamp: "2026-08-27T09:30:00.000Z",
      message: {
        role: "assistant",
        stop_reason: "end_turn",
        content: [{
          type: "text",
          text: `done\n\n\`\`\`json\n${JSON.stringify({ status, findings: [], confidence: 0.9 })}\n\`\`\``,
        }],
      },
    },
  ]);
}

function silentTranscript(name: string): string {
  return stageTranscript(name, [
    { type: "user", timestamp: "2026-08-27T09:00:00.000Z", message: { role: "user", content: "run the stage" } },
    {
      type: "assistant",
      timestamp: "2026-08-27T09:20:00.000Z",
      message: { role: "assistant", stop_reason: null, content: [{ type: "text", text: "opening the failing test" }] },
    },
  ]);
}

/** Read the stage's durable evidence out of a fixture transcript through the
    same reader production uses, so the close is exercised against real records
    rather than a hand-shaped evidence object. */
function readFixtures(h: ReturnType<typeof harness>, fixtures: Record<string, string>): void {
  h.ports.durableTurnEvidence = async (engine, transcriptPath) => {
    const fixture = fixtures[transcriptPath];
    return fixture ? await durableStageTurnEvidence(engine, fixture) : null;
  };
}

test("close retires an attempt whose turn a provider limit cut off, naming the notice (#1141)", async () => {
  const h = harness();
  const pipeline = await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  h.setHostsResident(true);
  h.setStageHost("conversation_stage_1", { outcome: "failed", error: "structured runtime host is unavailable" });
  readFixtures(h, { "/codex/stage-1.jsonl": limitInterruptedTranscript("close-limit-interrupted") });

  const closed = await patchPipeline(pipeline.id, { action: "close" }, h.ports);

  expect(closed.error).toBeUndefined();
  expect(closed.close?.stillRunning).toEqual([]);
  expect(closed.close?.alreadyStopped).toMatchObject([{ stageId: "plan", attempt: 1 }]);
  const stored = loadPipelines()[0]!;
  expect(stored.state).toBe("closed");
  /* Retired as failed, with the provider's own words as the reason — on the
     attempt and on the lane, so nothing reads as a stage that produced one. */
  const attempt = stored.runs[0]!.attempts[0]!;
  expect(attempt.state).toBe("failed");
  expect(attempt.completedAt).toBeTruthy();
  expect(attempt.error).toContain("terminal provider message");
  expect(attempt.error).toContain(PROVIDER_LIMIT_NOTICE);
  expect(stored.stateDetail).toContain(PROVIDER_LIMIT_NOTICE);
});

test("a transcript that ends on a valid fenced verdict still closes on the verdict path (#1141)", async () => {
  const h = harness();
  const pipeline = await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  h.setHostsResident(true);
  h.setStageHost("conversation_stage_1", { outcome: "failed", error: "structured runtime host is unavailable" });
  readFixtures(h, { "/codex/stage-1.jsonl": verdictTranscript("close-verdict") });

  const closed = await patchPipeline(pipeline.id, { action: "close" }, h.ports);

  expect(closed.error).toBeUndefined();
  const detail = closed.close?.notes[0]?.detail ?? "";
  expect(detail).toContain("valid fenced verdict");
  /* A lane closed on a real verdict stays distinguishable from one closed on a
     provider notice — the two reasons never collapse into one. */
  expect(detail).not.toContain("terminal provider message");
  expect(loadPipelines()[0]!.state).toBe("closed");
});

test("a transcript silent under a live host is not terminalized by the provider-message rule (#1141)", async () => {
  const h = harness();
  const pipeline = await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  h.setHostsResident(true);
  h.setStageHost("conversation_stage_1", { outcome: "failed", error: "structured runtime host is unavailable" });
  readFixtures(h, { "/codex/stage-1.jsonl": silentTranscript("close-silent") });

  const refused = await patchPipeline(pipeline.id, { action: "close" }, h.ports);

  /* Silence is not evidence that the turn ended: the stall path keeps it. */
  expect(refused.status).toBe(409);
  expect(refused.close?.stillRunning).toMatchObject([{ stageId: "plan", attempt: 1 }]);
  const stored = loadPipelines()[0]!;
  expect(stored.state).toBe("running");
  expect(stored.runs[0]!.attempts[0]!.state).toBe("running");
});

test("a pipeline blocked only by a limit-interrupted attempt closes end to end (#1141)", async () => {
  const h = harness();
  const pipeline = await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  /* The board shape from the issue: earlier attempts of the same stage ended on
     verdicts and terminalize from their transcripts; the parked one was cut off
     by the limit and is the whole reason the close was refused. */
  const stored = loadPipelines()[0]!;
  const run = stored.runs[0]!;
  const parked = run.attempts[0]!;
  const settled = structuredClone(parked);
  settled.n = 1;
  settled.state = "failed";
  settled.conversationId = "conversation_stage_2";
  settled.agentPath = "/codex/stage-2.jsonl";
  settled.paneId = "%2";
  parked.n = 2;
  parked.state = "needs_decision";
  parked.error = "stage verdict recovery exhausted after 3 checks";
  run.attempts = [settled, parked];
  stored.state = "needs_decision";
  stored.stateDetail = parked.error;
  savePipelines([stored]);
  h.setHostsResident(true);
  for (const conversationId of ["conversation_stage_1", "conversation_stage_2"]) {
    h.setStageHost(conversationId, { outcome: "failed", error: "structured runtime host is unavailable" });
  }
  readFixtures(h, {
    "/codex/stage-1.jsonl": limitInterruptedTranscript("close-blocker-limit"),
    "/codex/stage-2.jsonl": verdictTranscript("close-blocker-verdict", "needs_decision"),
  });

  const closed = await patchPipeline(pipeline.id, { action: "close" }, h.ports);

  expect(closed.error).toBeUndefined();
  expect(closed.close?.stillRunning).toEqual([]);
  expect(closed.close?.alreadyStopped).toHaveLength(2);
  const terminal = loadPipelines()[0]!;
  expect(terminal.state).toBe("closed");
  expect(terminal.closedAt).toBeTruthy();
  /* Nothing unconfirmed is left, so the lane leaves the board. */
  expect(terminal.hiddenAt).toBe(terminal.closedAt);
  expect(terminal.runs[0]!.attempts.map((item) => item.completedAt).every(Boolean)).toBeTrue();
  /* The parking attempt keeps the reason it parked with; the close reason it
     was retired on rides the lane's own detail. */
  expect(terminal.runs[0]!.attempts[1]!.error).toBe("stage verdict recovery exhausted after 3 checks");
  expect(terminal.stateDetail).toContain(PROVIDER_LIMIT_NOTICE);
});

test("closing preserves uncommitted stage work and names what it left behind (#670)", async () => {
  const h = harness();
  const baseExec = h.ports.exec;
  h.ports.exec = (command, args, cwd) => {
    if (command === "git" && args[0] === "status") {
      return { code: 0, stdout: " M src/lib/app.ts\n?? notes.md\n", stderr: "" };
    }
    return baseExec(command, args, cwd);
  };
  const pipeline = await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  h.setStageHost("conversation_stage_1", { outcome: "stopped" });

  const closed = await patchPipeline(pipeline.id, { action: "close" }, h.ports);

  expect(closed.close?.worktree).toEqual({
    dir: loadPipelines()[0]!.worktreeDir,
    uncommitted: ["src/lib/app.ts", "notes.md"],
    truncated: false,
  });
  /* The whole point of the report: the work stays on disk. */
  expect(h.calls.some((call) => call.includes("reset --hard"))).toBeFalse();
  expect(h.calls.some((call) => call.startsWith("git clean"))).toBeFalse();
  expect(h.calls.some((call) => call.startsWith("git checkout"))).toBeFalse();
  expect(loadPipelines()[0]!.stateDetail).toBe("closed; stopped 1 stage host; kept 2 uncommitted paths in the worktree");
});

test("a lost advance on a fresh review flow is re-issued instead of waiting forever", async () => {
  const h = harness();
  const stages = [
    { id: "build", kind: "run", prompt: "build", next: "review" },
    { id: "review", kind: "review-loop", role: { roleId: "reviewer" }, prompt: "review", next: null },
  ] as const;
  await create(h.ports, stages as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass")], h.ports);
  await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);
  /* The harness flow stays waiting_ready with zero rounds — exactly the
     crash-between-persist-and-advance shape. The next tick re-issues. */
  await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);
  expect(h.calls.filter((call) => call === "flow-patch:flow-1:advance").length).toBe(2);
});

test("creation caps task, spec, and stage prompt sizes", async () => {
  const { ports } = harness();
  expect((await createPipelineFromRequest({ task: "x".repeat(4_001), repoDir: "/repo", stages: [] }, ports)).error).toContain("task exceeds");
  expect((await createPipelineFromRequest({ task: "x", spec: "y".repeat(16_001), repoDir: "/repo", stages: [] }, ports)).error).toContain("spec exceeds");
  expect((await createPipelineFromRequest({ task: "x", repoDir: "/repo", stages: [
    { id: "a", kind: "run", prompt: "p".repeat(8_001), next: "b" },
    { id: "b", kind: "run", prompt: "b", next: null },
  ] }, ports)).error).toContain("prompt exceeds");
});

const reviewPipeline = { task: "ship the widget", cursor: null, stages: [], runs: [] } as unknown as Parameters<typeof reviewNote>[0];
const reviewStage = (prompt: string) => ({ id: "review", kind: "review-loop", prompt, next: null } as unknown as Parameters<typeof reviewNote>[1]);
const noteOf = (result: ReturnType<typeof reviewNote>) => ("note" in result ? result.note : "");

test("reviewNote fits the flow-note cap while preserving the directive and safety fences", () => {
  /* A long role scaffold + fences would blow past the flow note's 2,000-char cap.
     The directive and the fences must survive; only the scaffold body is trimmed. */
  const fences = "\n\nSafety fences:\n- never delete production data\n- keep read-only when reviewing";
  const role = {
    engine: "codex" as const, model: "gpt-5.6-sol", effort: "high",
    roleId: "reviewer" as const, access: "read-only" as const,
    promptScaffold: `${"scaffold body ".repeat(400)}${fences}`,
  };
  const result = reviewNote(reviewPipeline, reviewStage("Review the diff for {{task}} carefully."), role);
  const note = noteOf(result);
  expect("note" in result).toBe(true);
  expect(note.length).toBeLessThanOrEqual(2_000);
  /* The operator's directive (with {{task}} substituted) is kept whole. */
  expect(note).toContain("Review the diff for ship the widget carefully.");
  /* Both safety fences survive the trim. */
  expect(note).toContain("never delete production data");
  expect(note).toContain("keep read-only when reviewing");
  /* The scaffold body was trimmed (it did not all fit). */
  expect(note).toContain("scaffold body");
});

test("reviewNote parks a too-long directive for raw and role-backed review stages", () => {
  const longDirective = `${"X".repeat(3_000)} {{task}}`;
  /* Raw review stage (no role scaffold): a 3,000-char directive can't be
     delivered whole, so it parks with an actionable error and never a 1,967-char slice. */
  const raw = reviewNote(reviewPipeline, reviewStage(longDirective), {
    engine: "codex", model: "gpt-5.6-sol", effort: "high", roleId: null, access: "read-only", promptScaffold: null,
  } as unknown as Parameters<typeof reviewNote>[2]);
  expect("error" in raw).toBe(true);
  if ("error" in raw) expect(raw.error).toContain("too long");

  /* Role-backed review stage: same over-cap directive still parks (the scaffold
     body trims, but the directive itself cannot be dropped). */
  const backed = reviewNote(reviewPipeline, reviewStage(longDirective), {
    engine: "codex", model: "gpt-5.6-sol", effort: "high", roleId: "reviewer", access: "read-only",
    promptScaffold: "guidance\n\nSafety fences:\n- stay read-only",
  } as unknown as Parameters<typeof reviewNote>[2]);
  expect("error" in backed).toBe(true);

  /* A directive that fits is delivered whole. */
  const ok = reviewNote(reviewPipeline, reviewStage("Check {{task}} against the ACs."), {
    engine: "codex", model: "gpt-5.6-sol", effort: "high", roleId: null, access: "read-only", promptScaffold: null,
  } as unknown as Parameters<typeof reviewNote>[2]);
  expect(noteOf(ok)).toBe("Check ship the widget against the ACs.");
});

test("override-stage re-configures an unstarted stage and rejects a started one (issue #118)", async () => {
  const { ports } = harness();
  const created = await create(ports);
  /* The trailing "build" stage has not run yet, so its config is still editable. */
  const res = await patchPipeline(
    created.id,
    { action: "override-stage", stageId: "build", engine: "claude", model: "opus", effort: "high", prompt: "New build prompt" },
    ports,
  );
  expect(res.error).toBeUndefined();
  const build = loadPipelines()[0]!.stages.find((stage) => stage.id === "build")!;
  expect(build.effectiveRole).toMatchObject({ engine: "claude", model: "opus", effort: "high" });
  expect(build.prompt).toBe("New build prompt");

  /* A blank model resolves to the engine default (null), not the literal "". */
  const cleared = await patchPipeline(created.id, { action: "override-stage", stageId: "build", model: "  " }, ports);
  expect(cleared.error).toBeUndefined();
  expect(loadPipelines()[0]!.stages.find((stage) => stage.id === "build")!.effectiveRole.model).toBeNull();

  /* Once the stage has an attempt it is frozen: the override 409s. */
  const started = loadPipelines()[0]!;
  const buildStage = started.stages.find((stage) => stage.id === "build")!;
  started.runs.find((run) => run.stageId === "build")!.attempts.push({
    n: 1, state: "running", effectiveRole: structuredClone(buildStage.effectiveRole), launchId: null,
    conversationId: null, sessionId: null, agentPath: null, paneId: null, flowId: null,
    startedAt: null, completedAt: null, input: null, activatedBy: null, output: null, verdict: null, error: null,
  });
  savePipelines([started]);
  expect((await patchPipeline(started.id, { action: "override-stage", stageId: "build", prompt: "x" }, ports)).status).toBe(409);
});

test("a stage spawn uses the model and effort saved by override-stage", async () => {
  const h = harness();
  const created = await create(h.ports);
  const updated = await patchPipeline(created.id, {
    action: "override-stage",
    stageId: "build",
    model: "gpt-5.6-terra",
    effort: "xhigh",
  }, h.ports);
  expect(updated.error).toBeUndefined();

  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass", "planned")], h.ports);
  await tickPipelines([], h.ports);

  expect(h.spawnRoles.at(-1)).toMatchObject({
    roleId: "builder",
    engine: "codex",
    model: "gpt-5.6-terra",
    effort: "xhigh",
  });
  expect(loadPipelines()[0]!.runs.find((run) => run.stageId === "build")?.attempts[0]?.effectiveRole).toMatchObject({
    model: "gpt-5.6-terra",
    effort: "xhigh",
  });
});

test("override-stage edits every stage while a pipeline is a draft", async () => {
  const { ports } = harness();
  savePipelines([]);
  const created = await createPipelineFromRequest({
    task: "Tune the plan",
    repoDir: "/repo",
    stages: RUN_STAGES as never,
    autoStart: false,
  }, ports);

  for (const stage of created.pipeline!.stages) {
    const updated = await patchPipeline(created.pipeline!.id, {
      action: "override-stage",
      stageId: stage.id,
      "prompt": `Edited ${stage.id}`,
    }, ports);
    expect(updated.error).toBeUndefined();
  }

  expect(loadPipelines()[0]!.stages.map((stage) => stage.prompt)).toEqual(["Edited plan", "Edited build"]);
});

test("draft metadata can be revised before the pipeline starts", async () => {
  const { ports } = harness();
  savePipelines([]);
  const created = await createPipelineFromRequest({
    task: "Initial task",
    spec: "Initial AC",
    repoDir: "/repo",
    baseBranch: "main",
    baseRef: ORIGIN_MAIN_SHA,
    stages: RUN_STAGES as never,
    autoStart: false,
  }, ports);

  const updated = await patchPipeline(created.pipeline!.id, {
    action: "update-draft",
    task: "Revised task",
    spec: "Revised AC",
    repoDir: "/other-repo",
  }, ports);

  expect(updated.pipeline).toMatchObject({
    task: "Revised task",
    spec: "Revised AC",
    repoDir: "/other-repo",
    project: "viewer",
    baseBranch: "",
    baseRef: "",
    lastPassedCommit: "",
  });
  expect(updated.pipeline?.worktreeDir).toContain("other-repo-pipeline-");
  expect(updated.pipeline?.branch).toContain("revised-task");
});

test("draft stages can be added, reordered, and removed while keeping a linear plan", async () => {
  const h = harness();
  const { ports } = h;
  savePipelines([]);
  const created = await createPipelineFromRequest({
    task: "Edit the plan",
    repoDir: "/repo",
    stages: RUN_STAGES as never,
    autoStart: false,
  }, ports);
  const id = created.pipeline!.id;
  h.setBuilderEffort("high");

  const added = await patchPipeline(id, {
    action: "add-stage",
    index: 1,
    stage: { id: "verify", kind: "run", role: { roleId: "builder" }, prompt: "Verify the plan", next: null },
  }, ports);
  expect(added.pipeline?.stages.map((stage) => [stage.id, stage.next])).toEqual([
    ["plan", "verify"], ["verify", "build"], ["build", null],
  ]);
  expect(added.pipeline?.stages.map((stage) => stage.effectiveRole.effort)).toEqual(["high", "high", "medium"]);

  const reordered = await patchPipeline(id, {
    action: "reorder-stage",
    stageIds: ["plan", "build", "verify"],
  }, ports);
  expect(reordered.pipeline?.stages.map((stage) => stage.id)).toEqual(["plan", "build", "verify"]);

  const removed = await patchPipeline(id, { action: "remove-stage", stageId: "verify" }, ports);
  expect(removed.pipeline?.stages.map((stage) => [stage.id, stage.next])).toEqual([
    ["plan", "build"], ["build", null],
  ]);
  expect(removed.pipeline?.runs.map((run) => run.stageId)).toEqual(["plan", "build"]);
});

test("an empty draft is created, assembled from zero, and starts with one stage (#136, #353)", async () => {
  const h = harness();
  const { ports } = h;
  savePipelines([]);
  /* The legacy stageless draft POST still loads; the current client seeds a
     default implement stage (#353), but the API keeps accepting zero. */
  const created = await createPipelineFromRequest({ task: "Build on canvas", repoDir: "/repo", stages: [], autoStart: false }, ports);
  expect(created.pipeline?.state).toBe("draft");
  expect(created.pipeline?.stages).toEqual([]);
  expect(created.pipeline?.cursor).toBeNull();
  const id = created.pipeline!.id;

  /* Start is refused while the draft is empty, without side effects. */
  const tooFew = await patchPipeline(id, { action: "start" }, ports);
  expect(tooFew.status).toBe(409);
  expect(loadPipelines()[0]!.state).toBe("draft");

  /* One implement conversation is the minimum graph (#353): Start succeeds. */
  const one = await patchPipeline(id, { action: "add-stage", stage: { id: "plan", kind: "run", role: { roleId: "builder" }, prompt: "Plan it", next: null } }, ports);
  expect(one.pipeline?.stages.map((stage) => stage.id)).toEqual(["plan"]);
  expect(one.pipeline?.cursor).toEqual({ stageId: "plan", state: "pending", input: null, activatedBy: null });
  const started = await patchPipeline(id, { action: "start" }, ports);
  expect(started.pipeline?.state).toBe("provisioning");
});

test("a draft keeps at least one stage on the canvas (#136, #353)", async () => {
  const h = harness();
  const { ports } = h;
  savePipelines([]);
  const created = await createPipelineFromRequest({ task: "Empty me", repoDir: "/repo", stages: RUN_STAGES as never, autoStart: false }, ports);
  const id = created.pipeline!.id;
  await patchPipeline(id, { action: "remove-stage", stageId: "build" }, ports);
  /* The final stage is not removable (#353: every pipeline keeps at least one
     default action) — reconfigure it instead. */
  const lastRemove = await patchPipeline(id, { action: "remove-stage", stageId: "plan" }, ports);
  expect(lastRemove.status).toBe(409);
  expect(loadPipelines()[0]!.stages.map((stage) => stage.id)).toEqual(["plan"]);
});

test("draft edits that would orphan a review-loop are rejected (#136)", async () => {
  const h = harness();
  const { ports } = h;
  savePipelines([]);
  const created = await createPipelineFromRequest({
    task: "Guard the chain",
    repoDir: "/repo",
    stages: [
      { id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build", next: "review" },
      { id: "review", kind: "review-loop", role: { roleId: "reviewer" }, prompt: "Review", next: null },
    ] as never,
    autoStart: false,
  }, ports);
  const id = created.pipeline!.id;
  /* Moving the review loop ahead of its only run stage — the API must refuse. */
  const reordered = await patchPipeline(id, { action: "reorder-stage", stageIds: ["review", "build"] }, ports);
  expect(reordered.pipeline).toBeUndefined();
  expect(reordered.status).toBe(400);
  /* Removing the sole preceding run leaves a review loop with nothing to review. */
  const removed = await patchPipeline(id, { action: "remove-stage", stageId: "build" }, ports);
  expect(removed.pipeline).toBeUndefined();
  expect(removed.status).toBe(400);
  /* The draft survived both rejections unchanged. */
  expect(loadPipelines()[0]!.stages.map((stage) => stage.id)).toEqual(["build", "review"]);
});

test("discarding a draft terminates its persisted record (#1274)", async () => {
  const { ports } = harness();
  savePipelines([]);
  const created = await createPipelineFromRequest({
    task: "Disposable draft",
    repoDir: "/repo",
    stages: RUN_STAGES as never,
    autoStart: false,
  }, ports);

  const discarded = await patchPipeline(created.pipeline!.id, { action: "delete" }, ports);
  expect(discarded.pipeline?.id).toBe(created.pipeline!.id);
  expect(loadPipelines()).toHaveLength(1);
  const record = loadPipelines()[0]!;
  /* A hide alone left `state: "draft"` with `closedAt: null`, which every
     liveness reader answered "open" to — the hourly seat wake in #1274. */
  expect(record.state).toBe("closed");
  expect(record.closedAt).toBeTruthy();
  expect(record.hiddenAt).toBe(record.closedAt);
  expect(record.cursor).toBeNull();
  expect(record.runs.flatMap((run) => run.attempts)).toHaveLength(0);
});

test("closing a draft settles it the same way discarding does (#1274)", async () => {
  const { ports } = harness();
  savePipelines([]);
  const created = await createPipelineFromRequest({
    task: "Draft closed rather than discarded",
    repoDir: "/repo",
    stages: RUN_STAGES as never,
    autoStart: false,
  }, ports);

  const closed = await patchPipeline(created.pipeline!.id, { action: "close" }, ports);
  expect(closed.pipeline?.id).toBe(created.pipeline!.id);
  const record = loadPipelines()[0]!;
  expect(record.state).toBe("closed");
  expect(record.closedAt).toBeTruthy();
  expect(record.hiddenAt).toBe(record.closedAt);
});

test("a draft that is real work still starts after the discard change (#1274)", async () => {
  const { ports } = harness();
  savePipelines([]);
  const created = await createPipelineFromRequest({
    task: "Draft nobody discarded",
    repoDir: "/repo",
    stages: RUN_STAGES as never,
    autoStart: false,
  }, ports);

  const started = await patchPipeline(created.pipeline!.id, { action: "start" }, ports);
  expect(started.status).toBeUndefined();
  const record = loadPipelines()[0]!;
  expect(record.state).not.toBe("draft");
  expect(record.closedAt).toBeNull();
  expect(record.hiddenAt ?? null).toBeNull();
});

test("draft-only mutations cannot rewrite or delete an active pipeline", async () => {
  const { ports } = harness();
  const active = await create(ports);
  const before = structuredClone(loadPipelines()[0]!);
  const attempts = [
    { action: "start" },
    { action: "update-draft", task: "rewritten" },
    { action: "add-stage", stage: { id: "extra", kind: "run", prompt: "extra", next: null } },
    { action: "remove-stage", stageId: "plan" },
    { action: "reorder-stage", stageId: "plan", toIndex: 1 },
    { action: "delete" },
  ] as const;

  for (const request of attempts) {
    expect((await patchPipeline(active.id, request, ports)).status).toBe(409);
  }
  expect(loadPipelines()[0]).toEqual(before);
});

test("override-stage validates the target and requires a change", async () => {
  const { ports } = harness();
  const created = await create(ports);
  expect((await patchPipeline(created.id, { action: "override-stage", stageId: "ghost", prompt: "x" }, ports)).status).toBe(404);
  expect((await patchPipeline(created.id, { action: "override-stage", stageId: "build" }, ports)).status).toBe(400);
  expect((await patchPipeline(created.id, { action: "override-stage", stageId: "build", engine: "gemini" as never }, ports)).status).toBe(400);
  expect((await patchPipeline(created.id, { action: "override-stage", stageId: "build", prompt: "  " }, ports)).status).toBe(400);
});

test("override-stage swaps the stage role through the registry and resets unpinned runtime (issue #118 review F3)", async () => {
  const { ports } = harness();
  const created = await create(ports);
  /* build was builder/codex; switch it to architect with no runtime pins → the
     new role's registry defaults (claude/fable/high + scaffold) apply. */
  const res = await patchPipeline(created.id, { action: "override-stage", stageId: "build", role: { roleId: "architect" } }, ports);
  expect(res.error).toBeUndefined();
  const build = loadPipelines()[0]!.stages.find((stage) => stage.id === "build")!;
  expect(build.role).toEqual({ roleId: "architect" });
  expect(build.effectiveRole).toMatchObject({ roleId: "architect", engine: "claude", model: "fable", effort: "high", promptScaffold: "Architect guidance" });
  /* Input fields stay consistent with the effectiveRole so the record persists. */
  expect(build.engine).toBe("claude");
  expect(build.model).toBe("fable");

  /* An explicit runtime pin still wins over the role default. */
  const pinned = await patchPipeline(created.id, { action: "override-stage", stageId: "build", role: { roleId: "reviewer" }, effort: "low" }, ports);
  expect(pinned.error).toBeUndefined();
  expect(loadPipelines()[0]!.stages.find((stage) => stage.id === "build")!.effectiveRole).toMatchObject({ roleId: "reviewer", effort: "low" });

  /* Clearing the role falls back to the Builder default. */
  const cleared = await patchPipeline(created.id, { action: "override-stage", stageId: "build", role: null }, ports);
  expect(cleared.error).toBeUndefined();
  const roleless = loadPipelines()[0]!.stages.find((stage) => stage.id === "build")!;
  expect(roleless.role).toBeUndefined();
  expect(roleless.effectiveRole).toMatchObject({ roleId: null, engine: "codex" });
});

test("override-stage rejects an unknown/disallowed role and an incompatible role+model (issue #118 review F3)", async () => {
  const { ports } = harness();
  const created = await create(ports);
  expect((await patchPipeline(created.id, { action: "override-stage", stageId: "build", role: { roleId: "wizard" as never } }, ports)).status).toBe(400);
  expect((await patchPipeline(created.id, { action: "override-stage", stageId: "build", role: { roleId: "deployer" } }, ports)).error).toContain("not allowed in a pipeline");
  /* architect resolves to claude; a codex-only model must fail canonical bounds. */
  const bad = await patchPipeline(created.id, { action: "override-stage", stageId: "build", role: { roleId: "architect" }, model: "gpt-5.6-sol" }, ports);
  expect(bad.status).toBe(400);
  const unknown = await patchPipeline(created.id, { action: "override-stage", stageId: "build", engine: "codex", model: "gpt-5.6-codex" }, ports);
  expect(unknown).toMatchObject({
    status: 400,
    error: "invalid codex model id \"gpt-5.6-codex\"; valid codex model ids: gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna",
  });
});

test("override-stage rejects non-string model/effort instead of silently ignoring them (issue #118 review F3)", async () => {
  const { ports } = harness();
  const created = await create(ports);
  /* resolvePipelineRole would treat these as absent and 200 with the old config;
     the type guards must 400 instead, and never mutate the stage. */
  expect((await patchPipeline(created.id, { action: "override-stage", stageId: "build", model: 123 as never }, ports)).status).toBe(400);
  expect((await patchPipeline(created.id, { action: "override-stage", stageId: "build", effort: false as never }, ports)).status).toBe(400);
  expect((await patchPipeline(created.id, { action: "override-stage", stageId: "build", engine: 7 as never }, ports)).status).toBe(400);
  const build = loadPipelines()[0]!.stages.find((stage) => stage.id === "build")!;
  expect(build.prompt).toBe("Build from {{prev.output}}");
});

test("override-stage enforces the same prompt-size ceiling as creation (issue #118 review F5)", async () => {
  const { ports } = harness();
  const { MAX_STAGE_PROMPT_LENGTH } = await import("./limits");
  const created = await create(ports);
  /* Over the ceiling is rejected with a 400, not persisted as an oversized record. */
  const over = await patchPipeline(created.id, { action: "override-stage", stageId: "build", prompt: "x".repeat(MAX_STAGE_PROMPT_LENGTH + 1) }, ports);
  expect(over.status).toBe(400);
  expect(over.error).toContain(String(MAX_STAGE_PROMPT_LENGTH));
  expect(loadPipelines()[0]!.stages.find((stage) => stage.id === "build")!.prompt).toBe("Build from {{prev.output}}");
  /* Exactly at the ceiling is accepted. */
  const atLimit = await patchPipeline(created.id, { action: "override-stage", stageId: "build", prompt: "y".repeat(MAX_STAGE_PROMPT_LENGTH) }, ports);
  expect(atLimit.error).toBeUndefined();
});

/* ── #353: persisted exactly-once relay, fail-edge cycles, set-edge editing ── */

const CYCLE_STAGES = [
  { id: "build", kind: "run", role: { roleId: "builder" }, engine: "codex", access: "read-write", prompt: "Build {{task}} from {{prev.output}}", next: "verify" },
  { id: "verify", kind: "run", role: { roleId: "builder" }, engine: "codex", access: "read-write", prompt: "Verify {{prev.output}}", next: null, onFail: { to: "build", maxRounds: 1 } },
] as const;

test("a rejected structured fail verdict parks before fail-edge traversal (#429)", async () => {
  const h = harness();
  await create(h.ports, CYCLE_STAGES as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass", "built")], h.ports);
  await tickPipelines([], h.ports);
  h.messages.set("/codex/stage-2.jsonl", {
    text: "VERDICT: APPROVE\n\n```json\n{\"status\":\"fail\",\"findings\":[\"broken test\"]}\n```",
    ts: Date.now() + 100_000_000,
  });

  await tickPipelines([entry("/codex/stage-2.jsonl")], h.ports);

  const reason = 'contradictory stage verdict: prose marker "APPROVE" disagrees with JSON status "fail"';
  const current = loadPipelines()[0]!;
  expect(current.state).toBe("needs_decision");
  expect(current.stateDetail).toBe(reason);
  expect(current.cursor).toEqual({
    stageId: "verify",
    state: "running",
    input: "built",
    activatedBy: { stageId: "build", attempt: 1, edge: "pass" },
  });
  expect(current.runs[0]!.attempts).toHaveLength(1);
  expect(current.runs[1]!.attempts[0]).toMatchObject({
    state: "needs_decision",
    output: "VERDICT: APPROVE",
    verdict: null,
    error: reason,
  });
});

test("a completed stage's output is persisted once and relayed exactly once (#353)", async () => {
  const h = harness();
  const prompts: string[] = [];
  const baseSpawn = h.ports.spawnAgent;
  h.ports.spawnAgent = async (input, onReserved) => {
    prompts.push(input.prompt);
    return baseSpawn(input, onReserved);
  };
  await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass", "plan output")], h.ports);

  /* The relay record lands in the same mutation as the verdict. */
  let current = loadPipelines()[0]!;
  expect(current.cursor).toEqual({ stageId: "build", state: "pending", input: "plan output", activatedBy: { stageId: "plan", attempt: 1, edge: "pass" } });

  /* Sibling-record evolution after the advance must not change the delivered
     The persisted prompt input remains authoritative across cursor movement. */
  current.runs[0]!.attempts[0]!.output = "mutated later";
  savePipelines([current]);
  await tickPipelines([], h.ports);

  current = loadPipelines()[0]!;
  expect(current.runs[1]!.attempts[0]).toMatchObject({
    input: "plan output",
    activatedBy: { stageId: "plan", attempt: 1, edge: "pass" },
    state: "running",
  });
  expect(prompts.at(-1)).toContain("Build from plan output");
  /* Exactly once: re-ticking the same state neither respawns nor rewrites. */
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.runs[1]!.attempts).toHaveLength(1);
  expect(h.calls.filter((call) => call.startsWith("spawn:")).length).toBe(2);
});

test("an accepted fail verdict traverses the fail edge, loops once, then parks on budget exhaustion (#353)", async () => {
  const h = harness();
  const prompts: string[] = [];
  const baseSpawn = h.ports.spawnAgent;
  h.ports.spawnAgent = async (input, onReserved) => {
    prompts.push(input.prompt);
    return baseSpawn(input, onReserved);
  };
  await create(h.ports, CYCLE_STAGES as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass", "built v1")], h.ports);
  await tickPipelines([], h.ports);

  /* verify fails with findings → the fail edge routes back to build with the
     failure narrative as {{prev.output}}; no park, no worktree reset. */
  h.messages.set("/codex/stage-2.jsonl", { text: "cannot pass\n\n```json\n{\"status\":\"fail\",\"findings\":[\"broken test\"]}\n```", ts: Date.now() + 100_000_000 });
  await tickPipelines([entry("/codex/stage-2.jsonl")], h.ports);

  let current = loadPipelines()[0]!;
  expect(current.state).toBe("running");
  expect(current.runs[1]!.attempts[0]).toMatchObject({ state: "failed", verdict: { status: "fail" } });
  expect(current.cursor).toEqual({
    stageId: "build",
    state: "pending",
    input: "cannot pass\n\nFail verdict findings:\n- broken test",
    activatedBy: { stageId: "verify", attempt: 1, edge: "fail" },
  });
  expect(h.calls.some((call) => call.includes("reset --hard"))).toBe(false);

  /* The loop round re-runs build with the failure input, passes, re-enters
     verify as a fresh attempt. */
  await tickPipelines([], h.ports);
  expect(prompts.at(-1)).toContain("Fail verdict findings:\n- broken test");
  current = loadPipelines()[0]!;
  expect(current.runs[0]!.attempts).toHaveLength(2);
  expect(current.runs[0]!.attempts[1]!.activatedBy).toEqual({ stageId: "verify", attempt: 1, edge: "fail" });
  h.messages.set("/codex/stage-3.jsonl", { text: "fixed\n\n```json\n{\"status\":\"pass\"}\n```", ts: Date.now() + 100_000_000 });
  await tickPipelines([entry("/codex/stage-3.jsonl")], h.ports);
  await tickPipelines([], h.ports);
  current = loadPipelines()[0]!;
  expect(current.runs[1]!.attempts).toHaveLength(2);

  /* Second verify failure exhausts maxRounds: 1 → parks for the operator. */
  h.messages.set("/codex/stage-4.jsonl", { text: "still broken\n\n```json\n{\"status\":\"fail\",\"findings\":[\"regression\"]}\n```", ts: Date.now() + 100_000_000 });
  await tickPipelines([entry("/codex/stage-4.jsonl")], h.ports);
  current = loadPipelines()[0]!;
  expect(current.state).toBe("needs_decision");
  expect(current.stateDetail).toContain("fail-edge budget exhausted after 1 round(s)");
  expect(current.runs[1]!.attempts[1]!.state).toBe("failed");
});

test("needs_decision always parks — a fail edge never auto-loops it (#353)", async () => {
  const h = harness();
  await create(h.ports, CYCLE_STAGES as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass", "built")], h.ports);
  await tickPipelines([], h.ports);
  h.messages.set("/codex/stage-2.jsonl", { text: "unsure\n\n```json\n{\"status\":\"needs_decision\"}\n```", ts: Date.now() + 100_000_000 });
  await tickPipelines([entry("/codex/stage-2.jsonl")], h.ports);

  const current = loadPipelines()[0]!;
  expect(current.state).toBe("needs_decision");
  expect(current.cursor?.stageId).toBe("verify");
  expect(current.runs[0]!.attempts).toHaveLength(1);
});

test("set-edge rewires future edges and freezes traversed evidence (#353)", async () => {
  const h = harness();
  const { ports } = h;
  savePipelines([]);
  const created = await createPipelineFromRequest({
    task: "Graph edit",
    repoDir: "/repo",
    stages: [
      { id: "plan", kind: "run", role: { roleId: "builder" }, prompt: "Plan", next: "build" },
      { id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build", next: "verify" },
      { id: "verify", kind: "run", role: { roleId: "builder" }, prompt: "Verify", next: null },
    ] as never,
    autoStart: false,
  }, ports);
  const id = created.pipeline!.id;

  /* Validation matrix. */
  expect((await patchPipeline(id, { action: "set-edge", stageId: "missing", edge: "pass", to: null }, ports)).status).toBe(404);
  expect((await patchPipeline(id, { action: "set-edge", stageId: "plan", edge: "up" as never, to: null }, ports)).status).toBe(400);
  expect((await patchPipeline(id, { action: "set-edge", stageId: "plan", edge: "pass" }, ports)).status).toBe(400);
  expect((await patchPipeline(id, { action: "set-edge", stageId: "plan", edge: "pass", to: "missing" }, ports)).status).toBe(400);
  expect((await patchPipeline(id, { action: "set-edge", stageId: "verify", edge: "pass", to: "plan" }, ports)).error).toContain("cycle");
  expect((await patchPipeline(id, { action: "set-edge", stageId: "plan", edge: "pass", to: "plan" }, ports)).error).toContain("itself");
  expect((await patchPipeline(id, { action: "set-edge", stageId: "verify", edge: "fail", to: "build", maxRounds: 10 }, ports)).status).toBe(400);
  expect((await patchPipeline(id, { action: "set-edge", stageId: "verify", edge: "fail", to: null, maxRounds: 3 }, ports)).status).toBe(400);
  expect((await patchPipeline(id, { action: "set-edge", stageId: "plan", edge: "pass", to: "build", maxRounds: 2 }, ports)).status).toBe(400);

  /* A direct pass link (skipping build) and a fail-edge cycle are accepted. */
  const direct = await patchPipeline(id, { action: "set-edge", stageId: "plan", edge: "pass", to: "verify" }, ports);
  expect(direct.pipeline?.stages[0]?.next).toBe("verify");
  const cycle = await patchPipeline(id, { action: "set-edge", stageId: "verify", edge: "fail", to: "build", maxRounds: 2 }, ports);
  expect(cycle.pipeline?.stages[2]?.onFail).toEqual({ to: "build", maxRounds: 2 });
  /* Defaulted budget mirrors the review flow's round limit. */
  const defaulted = await patchPipeline(id, { action: "set-edge", stageId: "build", edge: "fail", to: "plan" }, ports);
  expect(defaulted.pipeline?.stages[1]?.onFail).toEqual({ to: "plan", maxRounds: 5 });
  /* Clearing works. */
  const cleared = await patchPipeline(id, { action: "set-edge", stageId: "build", edge: "fail", to: null }, ports);
  expect(cleared.pipeline?.stages[1]?.onFail).toBeNull();

  /* Restore the chain, start, run plan to completion: its pass edge freezes. */
  await patchPipeline(id, { action: "set-edge", stageId: "plan", edge: "pass", to: "build" }, ports);
  await patchPipeline(id, { action: "start" }, ports);
  await tickPipelines([], ports);
  await tickPipelines([], ports);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass", "planned")], ports);
  const frozen = await patchPipeline(id, { action: "set-edge", stageId: "plan", edge: "pass", to: "verify" }, ports);
  expect(frozen.status).toBe(409);
  expect(frozen.error).toContain("frozen evidence");
  /* An untraversed fail edge on a started-but-not-run stage stays editable. */
  const stillEditable = await patchPipeline(id, { action: "set-edge", stageId: "verify", edge: "fail", to: "build", maxRounds: 1 }, ports);
  expect(stillEditable.pipeline?.stages[2]?.onFail).toEqual({ to: "build", maxRounds: 1 });
});

test("a fail edge freezes the instant it routes, before the target attempt materializes, and the freeze survives restart (#353)", async () => {
  const h = harness();
  const { ports } = h;
  await create(ports, CYCLE_STAGES as never);
  await tickPipelines([], ports); // provision
  await tickPipelines([], ports); // spawn build
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass", "built v1")], ports); // build passes → verify
  await tickPipelines([], ports); // spawn verify
  /* verify fails → the cursor routes back to build along the fail edge. The
     follow-up tick that would materialize build's second attempt is a no-op in
     this suite, so we sit in the in-flight window on purpose. */
  h.messages.set("/codex/stage-2.jsonl", { text: "cannot pass\n\n```json\n{\"status\":\"fail\",\"findings\":[\"broken\"]}\n```", ts: Date.now() + 100_000_000 });
  await tickPipelines([entry("/codex/stage-2.jsonl")], ports);

  const inflight = loadPipelines()[0]!;
  expect(inflight.cursor).toMatchObject({ stageId: "build", activatedBy: { stageId: "verify", attempt: 1, edge: "fail" } });
  /* The traversal lives on the durable cursor while build still holds one
     attempt, so the freeze reads the cursor activation to catch this window. */
  expect(inflight.runs[0]!.attempts).toHaveLength(1);

  const frozen = await patchPipeline(inflight.id, { action: "set-edge", stageId: "verify", edge: "fail", to: null }, ports);
  expect(frozen.status).toBe(409);
  expect(frozen.error).toContain("frozen evidence");

  /* patchPipeline re-reads the persisted registry from disk, so this second edit
     proves the freeze survives a process restart. */
  const afterRestart = await patchPipeline(inflight.id, { action: "set-edge", stageId: "verify", edge: "fail", to: "build", maxRounds: 4 }, ports);
  expect(afterRestart.status).toBe(409);
  expect(loadPipelines()[0]!.stages.find((stage) => stage.id === "verify")?.onFail).toEqual({ to: "build", maxRounds: 1 });
});

test("a review-loop binds its implementer through the activation graph across a merge (#353)", async () => {
  const h = harness();
  const { ports } = h;
  savePipelines([]);
  /* Execution runs seed → buildB → review, while the array order places review
     (index 1) ahead of its real implementer buildB (index 2). The activation
     lineage binds the review to buildB, the run that activated it, and the merge
     makes buildB sit later in the array than the review it feeds. */
  const created = await createPipelineFromRequest({
    task: "Merge lineage",
    spec: "AC",
    repoDir: "/repo",
    stages: [
      { id: "seed", kind: "run", role: { roleId: "builder" }, prompt: "Seed {{task}}", next: "buildB" },
      { id: "review", kind: "review-loop", role: { roleId: "reviewer" }, prompt: "Review {{task}}", next: null },
      { id: "buildB", kind: "run", role: { roleId: "builder" }, prompt: "Build {{prev.output}}", next: "review" },
    ] as never,
  }, ports);
  expect(created.pipeline).toBeDefined();
  await tickPipelines([], ports); // provision
  await tickPipelines([], ports); // spawn seed
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass", "seeded")], ports); // seed → buildB
  await tickPipelines([], ports); // spawn buildB
  await tickPipelines([h.finish("/codex/stage-2.jsonl", "pass", "built")], ports); // buildB → review
  await tickPipelines([], ports); // review creates its flow

  const current = loadPipelines()[0]!;
  expect(current.cursor?.stageId).toBe("review");
  expect(current.runs.find((run) => run.stageId === "review")!.attempts[0]!.activatedBy).toEqual({ stageId: "buildB", attempt: 1, edge: "pass" });
  /* The review flow opens against buildB's transcript, the run that activated
     the review. */
  expect(h.calls.some((call) => call.startsWith("flow:/codex/stage-2.jsonl"))).toBe(true);
  expect(h.calls.some((call) => call.startsWith("flow:/codex/stage-1.jsonl"))).toBe(false);
});

test("structural draft edits preserve intentional pass and fail edges (#353)", async () => {
  const h = harness();
  const { ports } = h;
  savePipelines([]);
  const created = await createPipelineFromRequest({
    task: "Graph preservation",
    repoDir: "/repo",
    stages: [
      { id: "plan", kind: "run", role: { roleId: "builder" }, prompt: "Plan", next: "build" },
      { id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build", next: "verify" },
      { id: "verify", kind: "run", role: { roleId: "builder" }, prompt: "Verify", next: null },
    ] as never,
    autoStart: false,
  }, ports);
  const id = created.pipeline!.id;

  /* A custom jump (plan → verify, skipping build) and a fail loop (verify → plan). */
  await patchPipeline(id, { action: "set-edge", stageId: "plan", edge: "pass", to: "verify" }, ports);
  await patchPipeline(id, { action: "set-edge", stageId: "verify", edge: "fail", to: "plan", maxRounds: 3 }, ports);

  const edgesOf = (stages: { id: string; next: string | null; onFail?: unknown }[]) =>
    new Map(stages.map((stage) => [stage.id, { next: stage.next, onFail: stage.onFail ?? null }]));
  const jumpAndLoopSurvive = (stages: { id: string; next: string | null; onFail?: unknown }[]) => {
    const edges = edgesOf(stages);
    expect(edges.get("plan")!.next).toBe("verify");
    expect(edges.get("verify")!.onFail).toEqual({ to: "plan", maxRounds: 3 });
  };

  /* add-stage: the jump and loop survive; the new stage is spliced at its seam. */
  const added = await patchPipeline(id, {
    action: "add-stage",
    stage: { id: "audit", kind: "run", role: { roleId: "builder" }, prompt: "Audit", next: null },
  }, ports);
  jumpAndLoopSurvive(added.pipeline!.stages);
  expect(added.pipeline!.stages.some((stage) => stage.id === "audit")).toBe(true);

  /* reorder-stage: edges follow ids, so a reorder leaves them in place. */
  const reordered = await patchPipeline(id, { action: "reorder-stage", stageId: "build", toIndex: 3 }, ports);
  expect(reordered.pipeline!.stages.map((stage) => stage.id)).toEqual(["plan", "verify", "audit", "build"]);
  jumpAndLoopSurvive(reordered.pipeline!.stages);

  /* override-stage: editing a stage's prompt leaves its edges intact. */
  const overridden = await patchPipeline(id, { action: "override-stage", stageId: "build", prompt: "Rebuild" }, ports);
  jumpAndLoopSurvive(overridden.pipeline!.stages);

  /* remove-stage: removing an unrelated stage leaves the jump and loop intact. */
  const removed = await patchPipeline(id, { action: "remove-stage", stageId: "audit" }, ports);
  expect(removed.pipeline!.stages.some((stage) => stage.id === "audit")).toBe(false);
  jumpAndLoopSurvive(removed.pipeline!.stages);
});

test("consecutive reviews cross a migration boundary and resume positional implementer selection (#353)", async () => {
  const h = harness();
  const { ports } = h;
  savePipelines([]);
  const created = await createPipelineFromRequest({
    task: "Mixed consecutive reviews",
    spec: "AC",
    repoDir: "/repo",
    stages: [
      { id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build {{task}}", next: "review1" },
      { id: "review1", kind: "review-loop", role: { roleId: "reviewer" }, prompt: "Review {{task}}", next: "review2" },
      { id: "review2", kind: "review-loop", role: { roleId: "reviewer" }, prompt: "Review again {{task}}", next: null },
    ] as never,
  }, ports);
  expect(created.pipeline).toBeDefined();
  await tickPipelines([], ports); // provision
  await tickPipelines([], ports); // spawn build
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass", "built")], ports); // build → review1
  await tickPipelines([entry("/codex/stage-1.jsonl")], ports); // review1 opens flow-1
  h.flows.get("flow-1")!.rounds.push({ n: 1, reviewHeadSha: ORIGIN_MAIN_SHA } as never);
  h.flows.get("flow-1")!.state = "approved";
  await tickPipelines([entry("/codex/stage-1.jsonl")], ports); // review1 approves → review2

  /* Migrate review1's attempt: an ancestor with activatedBy null is the boundary
     the review2 lineage stops at, so implementer selection resumes positionally
     and binds to build (the passed run before the reviews). */
  const staged = loadPipelines()[0]!;
  expect(staged.cursor?.stageId).toBe("review2");
  staged.runs.find((run) => run.stageId === "review1")!.attempts[0]!.activatedBy = null;
  savePipelines([staged]);

  await tickPipelines([], ports); // review2 opens its flow
  const current = loadPipelines()[0]!;
  expect(current.state).toBe("running");
  expect(h.flows.size).toBe(2);
  expect(h.calls.filter((call) => call.startsWith("flow:/codex/stage-1.jsonl")).length).toBe(2);
});

test("a fail loop crosses a migration boundary and resumes positional parent selection (#353)", async () => {
  const h = harness();
  const { ports } = h;
  savePipelines([]);
  const created = await createPipelineFromRequest({
    task: "Mixed fail loop",
    spec: "AC",
    repoDir: "/repo",
    stages: [
      { id: "seed", kind: "run", role: { roleId: "builder" }, prompt: "Seed {{task}}", next: "build" },
      { id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build {{prev.output}}", next: "verify" },
      { id: "verify", kind: "run", role: { roleId: "builder" }, prompt: "Verify {{prev.output}}", next: null, onFail: { to: "build", maxRounds: 2 } },
    ] as never,
  }, ports);
  expect(created.pipeline).toBeDefined();
  await tickPipelines([], ports); // provision
  await tickPipelines([], ports); // spawn seed
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass", "seeded")], ports); // seed → build
  await tickPipelines([], ports); // spawn build
  await tickPipelines([h.finish("/codex/stage-2.jsonl", "pass", "built")], ports); // build → verify
  await tickPipelines([], ports); // spawn verify
  h.messages.set("/codex/stage-3.jsonl", { text: "cannot pass\n\n```json\n{\"status\":\"fail\",\"findings\":[\"broken\"]}\n```", ts: Date.now() + 100_000_000 });
  await tickPipelines([entry("/codex/stage-3.jsonl")], ports); // verify fails → routes to build

  /* Migrate verify's attempt: the fail-loop lineage stops at that boundary, so
     the build retry's parent selection resumes positionally and inherits seed
     (the passed run before build). */
  const staged = loadPipelines()[0]!;
  expect(staged.cursor).toMatchObject({ stageId: "build", activatedBy: { stageId: "verify", attempt: 1, edge: "fail" } });
  staged.runs.find((run) => run.stageId === "verify")!.attempts[0]!.activatedBy = null;
  savePipelines([staged]);

  await tickPipelines([], ports); // build retry spawns
  const lastSpawn = h.calls.filter((call) => call.startsWith("spawn:")).at(-1) ?? "";
  expect(lastSpawn).toContain("_build_2");
  expect(lastSpawn).toContain("parent=/codex/stage-1.jsonl");
});

test("closing an initial pending stage records the resting stage as a durable pending attempt (#353)", async () => {
  const h = harness();
  const pipeline = await create(h.ports); // RUN_STAGES: plan → build
  await tickPipelines([], h.ports); // provision → running, cursor plan pending, no attempts
  const before = loadPipelines()[0]!;
  expect(before.cursor).toMatchObject({ stageId: "plan", state: "pending" });
  expect(before.runs.every((run) => run.attempts.length === 0)).toBe(true);

  await patchPipeline(pipeline.id, { action: "close" }, h.ports);

  const reloaded = loadPipelines()[0]!;
  expect(reloaded.state).toBe("closed");
  expect(reloaded.cursor).toBeNull();
  const planRun = reloaded.runs.find((run) => run.stageId === "plan")!;
  expect(planRun.attempts).toHaveLength(1);
  expect(planRun.attempts[0]).toMatchObject({ state: "pending", startedAt: null, completedAt: null, input: null, activatedBy: null });
  expect(reloaded.runs.find((run) => run.stageId === "build")!.attempts).toHaveLength(0);
});

test("closing a post-advance pending stage records the resting stage with its relay record (#353)", async () => {
  const h = harness();
  const pipeline = await create(h.ports); // RUN_STAGES: plan → build
  await tickPipelines([], h.ports); // provision
  await tickPipelines([], h.ports); // spawn plan
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass", "planned")], h.ports); // plan passes → advance to build
  const before = loadPipelines()[0]!;
  expect(before.cursor).toMatchObject({ stageId: "build", state: "pending", input: "planned", activatedBy: { stageId: "plan", attempt: 1, edge: "pass" } });
  expect(before.runs.find((run) => run.stageId === "build")!.attempts).toHaveLength(0);

  await patchPipeline(pipeline.id, { action: "close" }, h.ports);

  const reloaded = loadPipelines()[0]!;
  expect(reloaded.state).toBe("closed");
  expect(reloaded.cursor).toBeNull();
  const buildRun = reloaded.runs.find((run) => run.stageId === "build")!;
  expect(buildRun.attempts).toHaveLength(1);
  /* The resting attempt inherits the durable relay record and carries no run
     timestamps (it never started). */
  expect(buildRun.attempts[0]).toMatchObject({ state: "pending", startedAt: null, completedAt: null, input: "planned", activatedBy: { stageId: "plan", attempt: 1, edge: "pass" } });
  expect(reloaded.runs.find((run) => run.stageId === "plan")!.attempts[0]!.state).toBe("passed");
});

test("closing a fail-edge target with an older terminal attempt records a fresh pending round (#353)", async () => {
  const h = harness();
  const pipeline = await create(h.ports, [
    { id: "plan", kind: "run", role: { roleId: "builder" }, engine: "codex", prompt: "Plan {{task}}", next: "build" },
    { id: "build", kind: "run", role: { roleId: "builder" }, engine: "codex", prompt: "Build {{prev.output}}", next: "verify" },
    { id: "verify", kind: "run", role: { roleId: "builder" }, engine: "codex", prompt: "Verify {{prev.output}}", next: null, onFail: { to: "build", maxRounds: 2 } },
  ] as never);
  await tickPipelines([], h.ports); // provision
  await tickPipelines([], h.ports); // spawn plan
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass", "planned")], h.ports); // plan → build
  await tickPipelines([], h.ports); // spawn build
  await tickPipelines([h.finish("/codex/stage-2.jsonl", "pass", "built v1")], h.ports); // build → verify
  await tickPipelines([], h.ports); // spawn verify
  h.messages.set("/codex/stage-3.jsonl", { text: "cannot pass\n\n```json\n{\"status\":\"fail\",\"findings\":[\"regression\"]}\n```", ts: Date.now() + 100_000_000 });
  await tickPipelines([entry("/codex/stage-3.jsonl")], h.ports); // verify fails → routes to build

  const before = loadPipelines()[0]!;
  expect(before.cursor).toMatchObject({ stageId: "build", state: "pending", activatedBy: { stageId: "verify", attempt: 1, edge: "fail" } });
  expect(before.runs.find((run) => run.stageId === "build")!.attempts).toHaveLength(1); // build attempt 2 not yet materialized

  await patchPipeline(pipeline.id, { action: "close" }, h.ports);

  const reloaded = loadPipelines()[0]!;
  expect(reloaded.state).toBe("closed");
  expect(reloaded.cursor).toBeNull();
  const buildRun = reloaded.runs.find((run) => run.stageId === "build")!;
  expect(buildRun.attempts).toHaveLength(2);
  expect(buildRun.attempts[0]!.state).toBe("passed");
  /* The fresh round stays pending, carries the fail-edge provenance and input,
     and has no run timestamps (it never started). */
  expect(buildRun.attempts[1]).toMatchObject({ n: 2, state: "pending", startedAt: null, completedAt: null, activatedBy: { stageId: "verify", attempt: 1, edge: "fail" } });
  expect(buildRun.attempts[1]!.input).toContain("regression");
  expect(reloaded.runs.find((run) => run.stageId === "verify")!.attempts[0]!.state).toBe("failed");
});

/* --- #729: the orchestrator publishes the head the review layer fences on --- */

function publishHarness(h: ReturnType<typeof harness>, options: { origin?: boolean; pushFails?: boolean; remoteReadFails?: boolean } = {}) {
  const passedSha = "7".repeat(40);
  const order: string[] = [];
  /* Oldest first. `merge-base --is-ancestor` is answered from this, so the
     fake cannot accidentally agree that a divergence is a fast-forward. */
  const history = [ORIGIN_MAIN_SHA, passedSha];
  let localHead = ORIGIN_MAIN_SHA;
  let remoteBranch: string | null = null;
  let dirty = true;
  let pushFails = false;
  let remoteReadFails = options.remoteReadFails ?? false;
  let remoteReadAttempts = 0;
  const baseExec = h.ports.exec;
  h.ports.exec = (rawCommand, rawArgs, cwd) => {
    const command = rawCommand === "timeout" ? "git" : rawCommand;
    const args = rawCommand === "timeout" ? rawArgs.slice(rawArgs.indexOf("git") + 1) : rawArgs;
    if (command !== "git") return baseExec(command, args, cwd);
    const branch = loadPipelines()[0]?.branch ?? "pipeline/test";
    if (args[0] === "status") return { code: 0, stdout: dirty ? " M src/lib/thing.ts\n" : "", stderr: "" };
    if (args[0] === "add") return { code: 0, stdout: "", stderr: "" };
    if (args[0] === "commit") {
      dirty = false;
      localHead = passedSha;
      order.push("commit");
      return { code: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "branch" && args[1] === "--show-current") return { code: 0, stdout: `${branch}\n`, stderr: "" };
    if (args[0] === "remote" && args[1] === "get-url") {
      return options.origin === false
        ? { code: 128, stdout: "", stderr: "error: No such remote 'origin'" }
        : { code: 0, stdout: "git@example.invalid:owner/repo.git\n", stderr: "" };
    }
    if (args[0] === "ls-remote") {
      remoteReadAttempts += 1;
      if (remoteReadFails) {
        return { code: 128, stdout: "", stderr: "fatal: remote authentication unavailable" };
      }
      return { code: 0, stdout: remoteBranch ? `${remoteBranch}\trefs/heads/${branch}\n` : "", stderr: "" };
    }
    if (args[0] === "push") {
      if (options.pushFails || pushFails) {
        order.push("push-rejected");
        return { code: 1, stdout: "", stderr: "! [remote rejected] (shallow update not allowed)" };
      }
      remoteBranch = localHead;
      order.push(`push:${localHead}`);
      return { code: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "reset" || args[0] === "clean") {
      dirty = false;
      return { code: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "cat-file") return { code: history.includes(String(args[2]).replace("^{commit}", "")) ? 0 : 1, stdout: "", stderr: "" };
    if (args[0] === "merge-base" && args[1] === "--is-ancestor") {
      const ancestor = history.indexOf(String(args[2]));
      const descendant = history.indexOf(String(args[3]));
      return { code: ancestor >= 0 && descendant >= 0 && ancestor <= descendant ? 0 : 1, stdout: "", stderr: "" };
    }
    if (args[0] === "fetch") return { code: 0, stdout: "", stderr: "" };
    if (args[0] === "merge" && args[1] === "--ff-only") {
      localHead = remoteBranch ?? localHead;
      return { code: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "rev-parse" && args[1] === "HEAD") return { code: 0, stdout: `${localHead}\n`, stderr: "" };
    if (args[0] === "rev-parse" && String(args[1]).startsWith("refs/remotes/origin/")) {
      return remoteBranch
        ? { code: 0, stdout: `${remoteBranch}\n`, stderr: "" }
        : { code: 128, stdout: "", stderr: "fatal: bad revision" };
    }
    return baseExec(command, args, cwd);
  };
  const baseCreateFlow = h.ports.createFlow;
  h.ports.createFlow = async (req, entries) => {
    order.push("createFlow");
    return await baseCreateFlow(req, entries);
  };
  return {
    passedSha,
    order,
    remote: () => remoteBranch,
    setRemote: (sha: string | null) => { remoteBranch = sha; },
    setDirty: (value: boolean) => { dirty = value; },
    setPushFails: (value: boolean) => { pushFails = value; },
    setRemoteReadFails: (value: boolean) => { remoteReadFails = value; },
    remoteReadAttempts: () => remoteReadAttempts,
    setLocalHead: (sha: string) => { localHead = sha; if (!history.includes(sha)) history.push(sha); },
    /* Records a revision nobody's local checkout contains — a repair pushed
       from another clone, which must never be fast-forwarded away. */
    setDivergentRemote: (sha: string) => { remoteBranch = sha; },
  };
}

const PUBLISH_STAGES = [
  { id: "build", kind: "run", role: { roleId: "builder" }, ["prompt"]: "build", next: "review" },
  { id: "review", kind: "review-loop", role: { roleId: "reviewer" }, ["prompt"]: "review", next: null },
] as const;

test("a passed run stage publishes its committed head before the review stage creates its flow (#729)", async () => {
  const h = harness();
  const box = publishHarness(h);
  await create(h.ports, PUBLISH_STAGES as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass")], h.ports);

  /* The builder's commit reaches origin before anything can gate on it: this is
     the exact ordering pipeline 2ae14391 lacked when its review stage parked on
     `review remote head is unavailable before launch`. */
  expect(box.remote()).toBe(box.passedSha);
  expect(loadPipelines()[0]).toMatchObject({ lastPassedCommit: box.passedSha, publishedCommit: box.passedSha });

  await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);

  expect(box.order).toEqual(["commit", `push:${box.passedSha}`, "createFlow"]);
  expect(h.flows.get("flow-1")).toMatchObject({ headRef: loadPipelines()[0]!.branch, targetSha: box.passedSha });
  expect(loadPipelines()[0]!.state).toBe("running");
});

test("an unreachable remote leaves the stage passed and records it as unpublished (#999)", async () => {
  const h = harness();
  const box = publishHarness(h, { remoteReadFails: true });
  await create(h.ports, PUBLISH_STAGES as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass")], h.ports);

  const current = loadPipelines()[0]!;
  const attempt = current.runs.find((run) => run.stageId === "build")!.attempts[0]!;
  expect(current).toMatchObject({
    state: "running",
    lastPassedCommit: box.passedSha,
    publishedCommit: null,
    stateDetail: expect.stringContaining("passed but unpublished"),
  });
  expect(attempt).toMatchObject({
    state: "passed",
    verdict: { status: "pass" },
    error: expect.stringContaining("passed but unpublished"),
  });
  expect(box.remoteReadAttempts()).toBe(1);
  expect(box.order).toEqual(["commit"]);
  expect(h.flows.size).toBe(0);

  /* Review ingress still cannot fence a flow while GitHub is unreachable. It
     keeps the lane retryable in place instead of turning infrastructure into
     a second operator decision. */
  await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);
  const waiting = loadPipelines()[0]!;
  expect(waiting.state).toBe("running");
  expect(waiting.cursor?.stageId).toBe("review");
  expect(waiting.stateDetail).toContain("passed but unpublished");
  expect(waiting.runs.find((run) => run.stageId === "build")!.attempts[0]).toMatchObject({
    state: "passed",
    verdict: { status: "pass" },
  });
  expect(box.remoteReadAttempts()).toBe(2);
  expect(h.flows.size).toBe(0);
});

test("a final passing stage stays open until its accepted head is published (#999)", async () => {
  const h = harness();
  const box = publishHarness(h, { remoteReadFails: true });
  await create(h.ports, [
    { id: "build", kind: "run", role: { roleId: "builder" }, ["prompt"]: "build", next: null },
  ] as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass")], h.ports);

  const waiting = loadPipelines()[0]!;
  expect(waiting).toMatchObject({
    state: "running",
    closedAt: null,
    lastPassedCommit: box.passedSha,
    publishedCommit: null,
    stateDetail: expect.stringContaining("passed but unpublished"),
  });
  expect(waiting.runs[0]!.attempts[0]).toMatchObject({
    state: "passed",
    verdict: { status: "pass" },
    error: expect.stringContaining("passed but unpublished"),
  });
  expect(box.remoteReadAttempts()).toBe(1);

  box.setRemoteReadFails(false);
  await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);

  const completed = loadPipelines()[0]!;
  expect(completed).toMatchObject({
    state: "completed",
    cursor: null,
    lastPassedCommit: box.passedSha,
    publishedCommit: box.passedSha,
    stateDetail: null,
  });
  expect(completed.closedAt).not.toBeNull();
  expect(completed.runs[0]!.attempts[0]).toMatchObject({
    state: "passed",
    verdict: { status: "pass" },
    error: null,
  });
  expect(box.order).toEqual(["commit", `push:${box.passedSha}`]);
  expect(box.remoteReadAttempts()).toBe(3);
});

test("a publication that cannot land parks the pass without losing the commit", async () => {
  const h = harness();
  const box = publishHarness(h, { pushFails: true });
  await create(h.ports, PUBLISH_STAGES as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass")], h.ports);

  const parked = loadPipelines()[0]!;
  expect(parked.state).toBe("needs_decision");
  expect(parked.stateDetail).toContain("publishing the passed stage: publishing the pipeline branch:");
  /* The stage's work is committed and recorded — the park is recoverable, and a
     retry resets to this commit rather than discarding the builder's output. */
  expect(parked.lastPassedCommit).toBe(box.passedSha);
  expect(parked.publishedCommit ?? null).toBeNull();
  expect(box.order).toEqual(["commit", "push-rejected"]);
  expect(h.flows.size).toBe(0);
});

test("a pipeline whose repo has no origin parks at review ingress instead of fencing on a remote it cannot have", async () => {
  const h = harness();
  const box = publishHarness(h, { origin: false });
  await create(h.ports, PUBLISH_STAGES as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  /* The pass itself still advances — an unpublishable repo is not a reason to
     lose the builder's commit. */
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass")], h.ports);
  expect(loadPipelines()[0]).toMatchObject({ state: "running", lastPassedCommit: box.passedSha, publishedCommit: null });

  await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);

  const parked = loadPipelines()[0]!;
  expect(parked.state).toBe("needs_decision");
  expect(parked.stateDetail).toBe(
    `review stage requires a published pipeline branch, but this repository has no origin remote to publish ${box.passedSha} to`,
  );
  /* Parked BEFORE the flow exists: no reviewer is ever fenced on a remote head
     that cannot be created. */
  expect(box.order).toEqual(["commit"]);
  expect(h.flows.size).toBe(0);
  expect(parked.lastPassedCommit).toBe(box.passedSha);
});

test("retrying a parked review stage republishes a local repair before the reviewer relaunches", async () => {
  const h = harness();
  const box = publishHarness(h);
  const pipeline = await create(h.ports, PUBLISH_STAGES as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass")], h.ports);
  await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);
  h.flows.get("flow-1")!.state = "done_comment";
  await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);
  expect(loadPipelines()[0]!.state).toBe("needs_decision");

  /* The operator commits a repair in the shared worktree. Without republication
     the retried reviewer fences on a remote that never learned about it. */
  const repairHead = "9".repeat(40);
  box.setLocalHead(repairHead);
  await patchPipeline(pipeline.id, { action: "retry-stage" }, h.ports);

  expect(box.remote()).toBe(repairHead);
  expect(loadPipelines()[0]).toMatchObject({ state: "running", lastPassedCommit: repairHead, publishedCommit: repairHead });
  expect(box.order).toEqual(["commit", `push:${box.passedSha}`, "createFlow", `push:${repairHead}`]);
});

/* --- exact-head publication is a precondition of EVERY review ingress ------ */

/* A review stage needs a passed run session to review, so both the skip path
   and the fail-edge path reach ingress only behind an earlier passed stage. */
const SKIP_STAGES = [
  { id: "plan", kind: "run", role: { roleId: "builder" }, ["prompt"]: "plan", next: "build" },
  { id: "build", kind: "run", role: { roleId: "builder" }, ["prompt"]: "build", next: "review" },
  { id: "review", kind: "review-loop", role: { roleId: "reviewer" }, ["prompt"]: "review", next: null },
] as const;

const FAIL_EDGE_STAGES = [
  { id: "plan", kind: "run", role: { roleId: "builder" }, ["prompt"]: "plan", next: "build" },
  { id: "build", kind: "run", role: { roleId: "builder" }, ["prompt"]: "build", next: "review", onFail: { to: "review", maxRounds: 2 } },
  { id: "review", kind: "review-loop", role: { roleId: "reviewer" }, ["prompt"]: "review", next: null },
] as const;

test("a skipped stage publishes the accepted head before its review flow is created", async () => {
  const h = harness();
  const box = publishHarness(h);
  const pipeline = await create(h.ports, SKIP_STAGES as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass")], h.ports);
  await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);
  await tickPipelines([h.finish("/codex/stage-2.jsonl", "needs_decision", "operator call")], h.ports);
  expect(loadPipelines()[0]!.state).toBe("needs_decision");

  /* Nothing on the skip route publishes: the branch is unpublished when the
     cursor reaches review. */
  box.setRemote(null);
  await patchPipeline(pipeline.id, { action: "skip-stage" }, h.ports);
  const beforeIngress = box.order.length;
  await tickPipelines([entry("/codex/stage-1.jsonl"), entry("/codex/stage-2.jsonl")], h.ports);

  const accepted = loadPipelines()[0]!.lastPassedCommit;
  expect(box.remote()).toBe(accepted);
  expect(box.order.slice(beforeIngress)).toEqual([`push:${accepted}`, "createFlow"]);
  expect(loadPipelines()[0]).toMatchObject({ state: "running", publishedCommit: accepted });
});

test("a fail edge into a review stage publishes the accepted head before its review flow is created", async () => {
  const h = harness();
  const box = publishHarness(h);
  await create(h.ports, FAIL_EDGE_STAGES as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass")], h.ports);
  await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);
  /* A failed stage commits nothing; the worktree is clean at the accepted head. */
  box.setDirty(false);
  box.setRemote(null);
  await tickPipelines([h.finish("/codex/stage-2.jsonl", "fail", "needs a reviewer")], h.ports);

  const beforeIngress = box.order.length;
  await tickPipelines([entry("/codex/stage-1.jsonl"), entry("/codex/stage-2.jsonl")], h.ports);

  const accepted = loadPipelines()[0]!.lastPassedCommit;
  expect(box.remote()).toBe(accepted);
  expect(box.order.slice(beforeIngress)).toEqual([`push:${accepted}`, "createFlow"]);
  expect(loadPipelines()[0]!.state).toBe("running");
});

test("review ingress re-probes the remote instead of trusting a stale publishedCommit", async () => {
  const h = harness();
  const box = publishHarness(h);
  await create(h.ports, PUBLISH_STAGES as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass")], h.ports);
  expect(loadPipelines()[0]!.publishedCommit).toBe(box.passedSha);

  /* The durable record says published, but origin does not have it — a migrated
     record, or a branch deleted on the remote. Ingress must not believe it. */
  box.setRemote(null);
  await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);

  expect(box.remote()).toBe(box.passedSha);
  expect(box.order).toEqual(["commit", `push:${box.passedSha}`, `push:${box.passedSha}`, "createFlow"]);
  expect(loadPipelines()[0]!.state).toBe("running");
});

test("a worktree head that is not the accepted review head parks without publishing anything", async () => {
  const h = harness();
  const box = publishHarness(h);
  await create(h.ports, FAIL_EDGE_STAGES as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass")], h.ports);
  await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);
  const accepted = loadPipelines()[0]!.lastPassedCommit;

  /* The failed stage committed on its own. That revision was never accepted by
     the pipeline, so it must never reach origin. */
  const unaccepted = "c".repeat(40);
  box.setDirty(false);
  box.setRemote(null);
  await tickPipelines([h.finish("/codex/stage-2.jsonl", "fail", "self-committed")], h.ports);
  box.setLocalHead(unaccepted);
  const beforeIngress = box.order.length;

  await tickPipelines([entry("/codex/stage-1.jsonl"), entry("/codex/stage-2.jsonl")], h.ports);

  const parked = loadPipelines()[0]!;
  expect(parked.state).toBe("needs_decision");
  expect(parked.stateDetail).toBe(
    `review stage head mismatch: the accepted review head is ${accepted}, but the pipeline worktree is at ${unaccepted}; nothing was published`,
  );
  expect(box.remote()).toBeNull();
  expect(box.order.slice(beforeIngress)).toEqual([]);
  expect(h.flows.size).toBe(0);
});

test("a remote that diverged from the accepted head parks review ingress and keeps both revisions", async () => {
  const h = harness();
  const box = publishHarness(h);
  await create(h.ports, PUBLISH_STAGES as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass")], h.ports);

  /* Someone else's repair landed on the branch; the accepted head does not
     contain it, so publication must refuse rather than fast-forward over it. */
  const foreignRepair = "d".repeat(40);
  box.setDivergentRemote(foreignRepair);
  await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);

  const parked = loadPipelines()[0]!;
  expect(parked.state).toBe("needs_decision");
  expect(parked.stateDetail).toContain(`review stage could not publish the accepted head ${box.passedSha}`);
  expect(parked.stateDetail).toContain("diverged");
  expect(box.remote()).toBe(foreignRepair);
  expect(h.flows.size).toBe(0);
});

test("a push that fails at review ingress parks before the review flow exists", async () => {
  const h = harness();
  const box = publishHarness(h);
  await create(h.ports, PUBLISH_STAGES as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass")], h.ports);

  box.setRemote(null);
  box.setPushFails(true);
  await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);

  const parked = loadPipelines()[0]!;
  expect(parked.state).toBe("needs_decision");
  expect(parked.stateDetail).toContain(`review stage could not publish the accepted head ${box.passedSha}`);
  expect(parked.stateDetail).toContain("publishing the pipeline branch:");
  expect(h.flows.size).toBe(0);
  expect(parked.lastPassedCommit).toBe(box.passedSha);
});
