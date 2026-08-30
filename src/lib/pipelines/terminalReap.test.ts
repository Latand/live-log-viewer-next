import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/* This suite exercises the terminal-settlement host reap (#574), which
   terminates agent processes. Every pipeline is constructed directly inside
   this sandboxed state directory and every port is stubbed — it never reads
   the shared runtime state directory and can never dispatch a real kill. */
process.env.LLV_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "llv-terminal-reap-"));
process.env.LLV_STRUCTURED_HOSTS = "0";

const { tickPipelines } = await import("./engine");
const { registerPipelineTick } = await import("./controllerSignal");
const { loadPipelines, pipelineIdentity, savePipelines } = await import("./store");
type Pipeline = import("./types").Pipeline;
type PipelineStageAttempt = import("./types").PipelineStageAttempt;
type PipelinePorts = import("./engine").PipelinePorts;
type PipelineStageStopResult = import("./engine").PipelineStageStopResult;

/* tickPipelines self-schedules a follow-up tick when a pass leaves a pending
   cursor; keep that wake-up away from the real default ports in this suite. */
registerPipelineTick(async () => {});

afterAll(() => fs.rmSync(process.env.LLV_STATE_DIR!, { recursive: true, force: true }));

const ROLE = { roleId: null, engine: "codex", model: "gpt-5.6-sol", effort: null, access: "read-write", promptScaffold: null } as const;

function attempt(n: number, conversation: string, settled: boolean): PipelineStageAttempt {
  return {
    n,
    state: settled ? "passed" : "running",
    effectiveRole: { ...ROLE },
    launchId: `launch-${conversation}`,
    conversationId: conversation,
    sessionId: null,
    agentPath: `/codex/${conversation}.jsonl`,
    paneId: null,
    flowId: null,
    startedAt: "2026-07-31T00:00:00.000Z",
    completedAt: settled ? "2026-07-31T00:10:00.000Z" : null,
    input: null,
    activatedBy: null,
    output: settled ? "done" : null,
    verdict: settled ? { status: "pass" } : null,
    error: null,
  };
}

function pipelineRecord(input: {
  id: string;
  state: Pipeline["state"];
  attempts: PipelineStageAttempt[];
}): Pipeline {
  const task = "Terminal reap";
  const repoDir = "/repo";
  return {
    id: input.id,
    task,
    taskIds: [],
    project: "viewer",
    repoDir,
    ...pipelineIdentity(input.id, task, repoDir),
    baseBranch: "main",
    baseRef: "48c739bbcc87b3244aee7fb0e2d1b3f8e312548f",
    lastPassedCommit: "48c739bbcc87b3244aee7fb0e2d1b3f8e312548f",
    publishedCommit: null,
    stages: [{ id: "implement", kind: "run", prompt: "{{task}}", next: null, onFail: null, effectiveRole: { ...ROLE } }],
    runs: [{ stageId: "implement", attempts: input.attempts }],
    cursor: null,
    state: input.state,
    pausedState: null,
    stateDetail: null,
    srcPath: "/codex/creator.jsonl",
    srcConversationId: "conversation_creator",
    createdAt: "2026-07-31T00:00:00.000Z",
    closedAt: input.state === "completed" || input.state === "closed" ? "2026-07-31T00:20:00.000Z" : null,
    hiddenAt: null,
  };
}

function harness() {
  const stops: string[] = [];
  const resident = new Map<string, boolean>();
  const stopResults = new Map<string, PipelineStageStopResult>();
  const active = new Map<string, boolean>();
  let clock = 1_000_000;
  let monotonic = 0;
  let stopCostMs = 0;
  const ports: PipelinePorts = {
    exec: () => ({ code: 0, stdout: "", stderr: "" }),
    preflightRepo: (repoDir) => ({ ok: true, repoDir, gitCommonDir: path.join(repoDir, ".git"), worktreeParent: path.dirname(repoDir) }),
    roleLookup: () => null,
    spawnAgent: async () => { throw new Error("the terminal reap must never spawn an agent"); },
    spawnReceipt: () => null,
    claimSpawnRetry: () => "claimed",
    paneAgentAlive: async () => false,
    stopStageAgent: async (target) => {
      stops.push(`${target.stageId}:${target.attempt}:${target.conversationId ?? "none"}`);
      monotonic += stopCostMs;
      const result = stopResults.get(target.conversationId ?? "") ?? { outcome: "stopped" as const };
      if (result.outcome === "stopped") resident.set(target.conversationId ?? "", false);
      return result;
    },
    stopStagePane: async () => ({ outcome: "not-running" as const }),
    stageHostResident: async (target) => resident.get(target.conversationId ?? "") ?? false,
    monotonicNow: () => monotonic,
    worktreePresent: () => false,
    conversationAgentActive: async (conversationId) => active.get(conversationId) ?? null,
    durableTurnEvidence: async () => null,
    headCwd: () => null,
    lastMessage: () => null,
    pathForConversation: () => null,
    sourcePathAllowed: () => true,
    conversationIdForPath: () => null,
    pipelineAdoptionCandidates: () => [],
    createFlow: async () => ({ error: "no flows in this suite" }),
    patchFlow: () => ({}),
    closeFlow: async () => {},
    getFlow: () => null,
    findFlow: () => null,
    projectForCwd: () => "viewer",
    now: () => new Date((clock += 1_000)).toISOString(),
  };
  return {
    ports,
    stops,
    resident,
    stopResults,
    active,
    setStopCost: (ms: number) => { stopCostMs = ms; },
  };
}

test("completion reaps its finished resident builder hosts exactly once", async () => {
  const h = harness();
  savePipelines([pipelineRecord({
    id: "reap-clean",
    state: "completed",
    attempts: [attempt(1, "conversation_builder_1", true), attempt(2, "conversation_builder_2", true)],
  })]);
  h.resident.set("conversation_builder_1", true);
  h.resident.set("conversation_builder_2", true);

  await tickPipelines([], h.ports);

  expect(h.stops).toEqual(["implement:1:conversation_builder_1", "implement:2:conversation_builder_2"]);
  const settled = loadPipelines()[0]!;
  expect(settled.terminalReap).toMatchObject({ rounds: 1, stopped: 2 });
  expect(settled.terminalReap!.settledAt).not.toBeNull();
  expect(settled.unconfirmedHosts).toBeUndefined();

  /* A settled reap is durable: the next tick re-reads it from the store and
     sends nothing, resident or not. */
  h.resident.set("conversation_builder_1", true);
  await tickPipelines([], h.ports);
  expect(h.stops).toHaveLength(2);
});

test("the creator, a mid-turn attempt, and a runtime-active session are preserved", async () => {
  const h = harness();
  savePipelines([pipelineRecord({
    id: "reap-preserve",
    state: "completed",
    attempts: [
      attempt(1, "conversation_creator", true),
      attempt(2, "conversation_midturn", false),
      attempt(3, "conversation_helper", true),
    ],
  })]);
  h.resident.set("conversation_creator", true);
  h.resident.set("conversation_midturn", true);
  h.resident.set("conversation_helper", true);
  h.active.set("conversation_helper", true);

  await tickPipelines([], h.ports);

  expect(h.stops).toEqual([]);
  expect(h.resident.get("conversation_creator")).toBe(true);
  expect(h.resident.get("conversation_midturn")).toBe(true);
  expect(h.resident.get("conversation_helper")).toBe(true);
  const settled = loadPipelines()[0]!;
  expect(settled.terminalReap).toMatchObject({ rounds: 0, stopped: 0 });
  expect(settled.terminalReap!.settledAt).not.toBeNull();
});

test("a parked terminal attempt is swept while closed teardown stays the close action's job", async () => {
  const h = harness();
  savePipelines([
    pipelineRecord({ id: "reap-closed", state: "closed", attempts: [attempt(1, "conversation_closed", true)] }),
    pipelineRecord({ id: "reap-parked", state: "needs_decision", attempts: [attempt(1, "conversation_parked", true)] }),
  ]);
  h.resident.set("conversation_closed", true);
  h.resident.set("conversation_parked", true);

  await tickPipelines([], h.ports);

  expect(h.stops).toEqual(["implement:1:conversation_parked"]);
  expect(h.resident.get("conversation_closed")).toBe(true);
  expect(loadPipelines().find((pipeline) => pipeline.id === "reap-closed")?.terminalReap).toBeUndefined();
  expect(loadPipelines().find((pipeline) => pipeline.id === "reap-parked")?.terminalReap)
    .toMatchObject({ rounds: 1, stopped: 1, settledAttempts: ["implement:1"] });
});

test("finished attempts are swept as the pipeline advances and later rounds reopen the reap", async () => {
  const h = harness();
  const record = pipelineRecord({
    id: "reap-progressive",
    state: "running",
    attempts: [attempt(1, "conversation_finished", true), attempt(2, "conversation_running", false)],
  });
  record.cursor = { stageId: "implement", state: "running", input: null, activatedBy: null };
  savePipelines([record]);
  h.resident.set("conversation_finished", true);
  h.resident.set("conversation_running", true);
  h.active.set("conversation_running", true);

  await tickPipelines([], h.ports);

  expect(h.stops).toEqual(["implement:1:conversation_finished"]);
  expect(loadPipelines()[0]!.terminalReap).toMatchObject({
    rounds: 1,
    stopped: 1,
    settledAttempts: ["implement:1"],
  });

  const parked = loadPipelines()[0]!;
  const second = parked.runs[0]!.attempts[1]!;
  second.state = "needs_decision";
  second.completedAt = "2026-07-31T00:30:00.000Z";
  second.verdict = { status: "needs_decision" };
  parked.state = "needs_decision";
  h.active.set("conversation_running", false);
  savePipelines([parked]);

  await tickPipelines([], h.ports);

  expect(h.stops).toEqual([
    "implement:1:conversation_finished",
    "implement:2:conversation_running",
  ]);
  expect(loadPipelines()[0]!.terminalReap).toMatchObject({
    rounds: 1,
    stopped: 2,
    settledAttempts: ["implement:1", "implement:2"],
  });
});

test("a host that will not die is bounded and surfaces as an unconfirmed host", async () => {
  const h = harness();
  savePipelines([pipelineRecord({
    id: "reap-stuck",
    state: "completed",
    attempts: [attempt(1, "conversation_stuck", true)],
  })]);
  h.resident.set("conversation_stuck", true);
  h.stopResults.set("conversation_stuck", {
    outcome: "unconfirmed",
    operationId: "op_stuck",
    detail: "kill accepted as queued but termination was not confirmed",
  });

  for (let round = 0; round < 5; round += 1) await tickPipelines([], h.ports);

  expect(h.stops).toHaveLength(5);
  const settled = loadPipelines()[0]!;
  expect(settled.terminalReap).toMatchObject({ rounds: 5, stopped: 0 });
  expect(settled.terminalReap!.settledAt).not.toBeNull();
  expect(settled.unconfirmedHosts).toMatchObject([{ stageId: "implement", attempt: 1, operationId: "op_stuck" }]);

  /* Settled: no further kills are dispatched, ever. */
  await tickPipelines([], h.ports);
  expect(h.stops).toHaveLength(5);

  /* Once the survivor is demonstrably gone, the existing unconfirmed-host
     reconcile retires it without sending another kill. */
  h.resident.set("conversation_stuck", false);
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.unconfirmedHosts).toBeUndefined();
  expect(h.stops).toHaveLength(5);
});

test("a reap whose every round expires still surfaces the hosts it never probed", async () => {
  const h = harness();
  savePipelines([pipelineRecord({
    id: "reap-exhaust",
    state: "completed",
    attempts: [attempt(1, "conversation_refusing", true), attempt(2, "conversation_unprobed", true)],
  })]);
  h.resident.set("conversation_refusing", true);
  h.resident.set("conversation_unprobed", true);
  h.stopResults.set("conversation_refusing", { outcome: "failed", error: "kill was refused" });
  h.setStopCost(6_000);

  for (let round = 0; round < 5; round += 1) await tickPipelines([], h.ports);

  /* Every round burned its budget on the refusing host, so the second host was
     never reached — settlement names both instead of dropping the unprobed one. */
  expect(h.stops).toEqual(Array.from({ length: 5 }, () => "implement:1:conversation_refusing"));
  const settled = loadPipelines()[0]!;
  expect(settled.terminalReap).toMatchObject({ rounds: 5, stopped: 0 });
  expect(settled.terminalReap!.settledAt).not.toBeNull();
  expect(settled.unconfirmedHosts).toMatchObject([
    { stageId: "implement", attempt: 1, detail: "kill was refused" },
    { stageId: "implement", attempt: 2, detail: "terminal reap budget expired before this host was probed" },
  ]);
});

test("the sweep budget defers remaining hosts to the next tick instead of stalling it", async () => {
  const h = harness();
  savePipelines([pipelineRecord({
    id: "reap-budget",
    state: "completed",
    attempts: [attempt(1, "conversation_slow", true), attempt(2, "conversation_next", true)],
  })]);
  h.resident.set("conversation_slow", true);
  h.resident.set("conversation_next", true);
  h.setStopCost(6_000);

  await tickPipelines([], h.ports);

  expect(h.stops).toEqual(["implement:1:conversation_slow"]);
  const partial = loadPipelines()[0]!;
  expect(partial.terminalReap).toMatchObject({ rounds: 1, stopped: 1, settledAt: null });

  h.setStopCost(0);
  await tickPipelines([], h.ports);

  expect(h.stops).toEqual(["implement:1:conversation_slow", "implement:2:conversation_next"]);
  const settled = loadPipelines()[0]!;
  expect(settled.terminalReap).toMatchObject({ rounds: 2, stopped: 2 });
  expect(settled.terminalReap!.settledAt).not.toBeNull();
});
