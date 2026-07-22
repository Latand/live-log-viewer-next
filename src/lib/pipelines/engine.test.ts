import { afterAll, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Flow } from "@/lib/flows/types";
import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";

process.env.LLV_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "llv-pipeline-engine-"));
const engineModule = await import("./engine");
const { adoptAttempt, defaultPipelinePorts, ensureTaskPipelineForAssignment, patchPipeline, pipelineAttemptTargetForSource, pipelineClaudePermissionMode, reviewNote, tickPipelines } = engineModule;
const { AgentRegistry, setAgentRegistryForTests } = await import("@/lib/agent/registry");
const { captureReviewHead, newRound } = await import("@/lib/flows/engine");
const rawCreatePipelineFromRequest = engineModule.createPipelineFromRequest;
const createPipelineFromRequest: typeof rawCreatePipelineFromRequest = async (request, ports, options) =>
  await rawCreatePipelineFromRequest({ src: "/codex/creator.jsonl", ...request }, ports, options);
const { registerPipelineTick } = await import("./controllerSignal");
const { loadPipelines, savePipelines } = await import("./store");
const { saveTasks } = await import("@/lib/tasks/store");
type PipelinePorts = import("./engine").PipelinePorts;
type StageTurnEvidence = import("./durableEvidence").StageTurnEvidence;

/* tickPipelines self-schedules a follow-up tick when a pass leaves a pending
   cursor; keep that wake-up away from the real default ports in this suite. */
registerPipelineTick(async () => {});

afterAll(() => fs.rmSync(process.env.LLV_STATE_DIR!, { recursive: true, force: true }));

test("default pipeline projections reuse one registry parse across the historical backlog", () => {
  const registryPath = path.join(process.env.LLV_STATE_DIR!, "projection-cache-agent-registry.json");
  const registry = new AgentRegistry(registryPath);
  setAgentRegistryForTests(registry);
  const reads = spyOn(fs, "readFileSync");
  try {
    const ports = defaultPipelinePorts();
    for (let index = 0; index < 300; index += 1) {
      expect(ports.pipelineAdoptionCandidates(`historical-${index}`)).toEqual([]);
      expect(ports.spawnReceipt(`missing-${index}`)).toBeNull();
    }
    expect(reads.mock.calls.filter(([filename]) => filename === registryPath)).toHaveLength(1);
  } finally {
    reads.mockRestore();
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
  const messages = new Map<string, { text: string; ts: number }>();
  const durableTurns = new Map<string, StageTurnEvidence>();
  const flows = new Map<string, Flow>();
  let spawn = 0;
  let clock = 1_000_000;
  let builderEffort = "medium";
  let paneAlive = true;
  let conversationActive: boolean | null = null;
  const ports: PipelinePorts = {
    exec: (command, args) => {
      calls.push(`${command} ${args.join(" ")}`);
      if (args[0] === "rev-parse" && args[1] === "--git-dir") return { code: 0, stdout: ".git\n", stderr: "" };
      if (args[0] === "rev-parse" && args[1] === "--verify") return { code: 0, stdout: `${ORIGIN_MAIN_SHA}\n`, stderr: "" };
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return { code: 0, stdout: "main\n", stderr: "" };
      if (args[0] === "branch" && args[1] === "--show-current") return { code: 0, stdout: `${loadPipelines()[0]?.branch ?? ""}\n`, stderr: "" };
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
    spawnAgent: async ({ role, parentPath, clientAttemptId, membership, supersedes }, onReserved) => {
      spawn += 1;
      spawnRoles.push(structuredClone(role));
      calls.push(`spawn:${clientAttemptId}:parent=${parentPath ?? "root"}:supersedes=${supersedes ?? "none"}`);
      calls.push(`membership:${membership.kind}:${membership.containerId}:${membership.slot}:${membership.role}:${membership.stageOrder}:round=${membership.round}`);
      onReserved({ launchId: `launch-${spawn}`, conversationId: `conversation_stage_${spawn}` });
      return { launchId: `launch-${spawn}`, conversationId: `conversation_stage_${spawn}`, sessionId: `session-${spawn}`, transcript: `/codex/stage-${spawn}.jsonl`, paneId: `%${spawn}` };
    },
    paneAgentAlive: async () => paneAlive,
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
      const flow = { id: `flow-${flows.size + 1}`, implementerPath: req.implementerPath, baseRef: req.baseRef, targetSha: req.targetSha, state: "waiting_ready", rounds: [], createdAt: new Date(clock).toISOString(), closedAt: null } as unknown as Flow;
      flows.set(flow.id, flow);
      return { flow };
    },
    patchFlow: (id, action, note) => {
      calls.push(`flow-patch:${id}:${action}`);
      if (note) calls.push(`flow-note:${note}`);
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
    finish,
    setBuilderEffort: (effort: string) => { builderEffort = effort; },
    setPaneAlive: (alive: boolean) => { paneAlive = alive; },
    setConversationActive: (active: boolean | null) => { conversationActive = active; },
  };
}

async function create(ports: PipelinePorts, stages = RUN_STAGES as never) {
  savePipelines([]);
  const result = await createPipelineFromRequest({ task: "Ship pipelines", spec: "AC1", repoDir: "/repo", stages, src: "/codex/creator.jsonl" }, ports);
  if (!result.pipeline) throw new Error(result.error);
  return result.pipeline;
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
  expect(missing).toEqual({
    error: "pipeline creator lineage is required; pass src",
    status: 400,
  });

  const invalidPath = await createPipelineFromRequest({
    task: "Invalid creator",
    repoDir: "/repo",
    src: "/outside/creator.jsonl",
    autoStart: false,
    stages: [],
  }, h.ports);
  expect(invalidPath).toEqual({ error: "src path is not an allowed conversation transcript", status: 400 });

  const unknownConversation = await createPipelineFromRequest({
    task: "Unknown creator",
    repoDir: "/repo",
    src: "/codex/unknown.jsonl",
    autoStart: false,
    stages: [],
  }, h.ports);
  expect(unknownConversation).toEqual({ error: "src conversation does not exist", status: 400 });

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
  expect(invalid).toEqual({ error: "src path is not an allowed conversation transcript", status: 400 });

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
    launchProfile: { model: "claude-sonnet-4-6", effort: "high" },
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

test("a worker that dies after transcript discovery parks without a verdict", async () => {
  const h = harness();
  await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  h.setPaneAlive(false);
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.state).toBe("needs_decision");
  expect(loadPipelines()[0]!.stateDetail).toContain("transcript disappeared");
});

test("an inactive transcript with no verdict parks after its worker exits", async () => {
  const h = harness();
  await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  h.setPaneAlive(false);
  await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);
  expect(loadPipelines()[0]!.state).toBe("needs_decision");
  expect(loadPipelines()[0]!.stateDetail).toContain("without producing a verdict");
});

test("an ended structured stage overrides a stale live transcript marker", async () => {
  const h = harness();
  await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  const pipeline = loadPipelines()[0]!;
  pipeline.runs[0]!.attempts[0]!.paneId = null;
  savePipelines([pipeline]);
  h.setConversationActive(false);

  await tickPipelines([{
    ...entry("/codex/stage-1.jsonl"),
    activity: "live",
    activityReason: "jsonl_turn_open",
  }], h.ports);

  expect(loadPipelines()[0]!.state).toBe("needs_decision");
  expect(loadPipelines()[0]!.stateDetail).toContain("structured stage ended without producing a verdict");
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
  h.ports.exec = (command, args, cwd) => args[0] === "rev-parse" && args[1] === "HEAD"
    ? { code: 0, stdout: `${STAGE_HEAD}\n`, stderr: "" }
    : baseExec(command, args, cwd);
}

/** Provision + spawn the first stage, then strip its pane so the attempt is a
    structured host, and pin later HEAD reads to the stage's own commit. */
async function runningStructuredStage(h: ReturnType<typeof harness>) {
  await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  makeStructuredAttempt();
  pinStageHead(h);
}

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

test("a genuinely terminal turn without a valid verdict stays parked and retry preserves the attempt receipt", async () => {
  const h = harness();
  const pipeline = await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  makeStructuredAttempt();
  h.setConversationActive(false);
  h.durableTurns.set("/codex/stage-1.jsonl", {
    turn: "terminal",
    message: { text: "should I proceed with plan A or plan B?", ts: 5_000_000 },
  });

  await tickPipelines([], h.ports);
  const parked = loadPipelines()[0]!;
  expect(parked.state).toBe("needs_decision");
  expect(parked.stateDetail).toContain("without a valid final JSON verdict");

  const retried = await patchPipeline(pipeline.id, { action: "retry-stage" }, h.ports);
  expect(retried.pipeline?.state).toBe("running");
  await tickPipelines([], h.ports);
  const attempts = loadPipelines()[0]!.runs[0]!.attempts;
  expect(attempts).toHaveLength(2);
  expect(attempts[0]!.state).toBe("needs_decision");
  expect(attempts[0]!.error).toContain("without a valid final JSON verdict");
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
  expect(spawnSync("git", ["config", "user.email", "flow@example.com"], { cwd: reviewRepo }).status).toBe(0);
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
  h.ports.exec = (command, args, cwd) => {
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
    return baseExec(command, args, cwd);
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
  captureReviewHead(launchedFlow, launchedRound);
  launchedFlow.rounds.push(launchedRound);
  expect(launchedFlow.targetSha).toBe(repairHead);
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
  flow.stateDetail = "paused by user";
  await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);
  const parked = loadPipelines()[0]!;
  expect(parked.state).toBe("needs_decision");
  expect(parked.runs[1]!.attempts[0]).toMatchObject({
    flowId: "flow-1",
    state: "needs_decision",
    error: "review flow paused during startup: paused by user",
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

  const afterCompletion = JSON.stringify(completed);
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
    flow.stateDetail = "startup transport unavailable";
    await tickPipelines([], h.ports);
    expect(loadPipelines()[0]!.runs[1]!.attempts[0]!.error)
      .toBe("review flow paused during startup: startup transport unavailable");

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

  const afterCompletion = JSON.stringify(completed);
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
  const baseExec = h.ports.exec;
  h.ports.exec = (command, args, cwd) => {
    if (command === "git" && args[0] === "status") return { code: 0, stdout: "", stderr: "" };
    if (command === "git" && args[0] === "branch" && args[1] === "--show-current") return { code: 0, stdout: `${loadPipelines()[0]!.branch}\n`, stderr: "" };
    if (command === "git" && args[0] === "rev-parse" && args[1] === "HEAD") return { code: 0, stdout: `${localHead}\n`, stderr: "" };
    if (command === "git" && args[0] === "ls-remote") return { code: 0, stdout: `${repairHead}\trefs/heads/${loadPipelines()[0]!.branch}\n`, stderr: "" };
    if (command === "git" && args[0] === "rev-parse" && String(args[1]).startsWith("refs/remotes/origin/")) return { code: 0, stdout: `${repairHead}\n`, stderr: "" };
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
  const baseExec = h.ports.exec;
  h.ports.exec = (command, args, cwd) => {
    if (command === "git" && args[0] === "status") return { code: 0, stdout: "", stderr: "" };
    if (command === "git" && args[0] === "branch" && args[1] === "--show-current") return { code: 0, stdout: `${loadPipelines()[0]!.branch}\n`, stderr: "" };
    if (command === "git" && args[0] === "rev-parse" && args[1] === "HEAD") return { code: 0, stdout: `${localHead}\n`, stderr: "" };
    if (command === "git" && args[0] === "ls-remote") return { code: 0, stdout: `${repairHead}\trefs/heads/${loadPipelines()[0]!.branch}\n`, stderr: "" };
    if (command === "git" && args[0] === "rev-parse" && String(args[1]).startsWith("refs/remotes/origin/")) return { code: 0, stdout: `${repairHead}\n`, stderr: "" };
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

  const retried = await patchPipeline(pipeline.id, { action: "retry-stage" }, h.ports);

  expect(retried).toEqual({ error: "reviewer process group did not terminate", status: 409 });
  expect(localHead).toBe(ORIGIN_MAIN_SHA);
  expect(loadPipelines()[0]).toMatchObject({ state: "needs_decision", stateDetail: "reviewer process group did not terminate" });

  const skipped = await patchPipeline(pipeline.id, { action: "skip-stage" }, h.ports);
  expect(skipped).toEqual({ error: "reviewer process group did not terminate", status: 409 });
  expect(h.calls.some((call) => call.includes("reset --hard"))).toBeFalse();
  expect(loadPipelines()[0]).toMatchObject({ state: "needs_decision", stateDetail: "reviewer process group did not terminate" });

  const closed = await patchPipeline(pipeline.id, { action: "close" }, h.ports);
  expect(closed).toEqual({ error: "reviewer process group did not terminate", status: 409 });
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

test("a corrupt pipelines registry skips the tick without escalating", async () => {
  const h = harness();
  await create(h.ports);
  const file = path.join(process.env.LLV_STATE_DIR!, "pipelines.json");
  fs.writeFileSync(file, "{", "utf8");
  expect(await tickPipelines([], h.ports)).toEqual({ pipelines: [], changed: false });
  expect(fs.readFileSync(file, "utf8")).toBe("{");
  savePipelines([]);
});

test("retry and skip refuse while a verdict-less parked stage still hosts a live agent", async () => {
  const h = harness();
  const pipeline = await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  h.messages.set("/codex/stage-1.jsonl", { text: "narrative without a JSON verdict", ts: 2_000_000 });
  await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);
  expect(loadPipelines()[0]!.state).toBe("needs_decision");

  const blockedRetry = await patchPipeline(pipeline.id, { action: "retry-stage" }, h.ports);
  expect(blockedRetry.status).toBe(409);
  expect(blockedRetry.error).toContain("still be running");
  const blockedSkip = await patchPipeline(pipeline.id, { action: "skip-stage" }, h.ports);
  expect(blockedSkip.status).toBe(409);

  h.setPaneAlive(false);
  const retried = await patchPipeline(pipeline.id, { action: "retry-stage" }, h.ports);
  expect(retried.pipeline?.state).toBe("running");
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

test("discarding a draft hides its persisted record", async () => {
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
  expect(loadPipelines()[0]).toMatchObject({ id: created.pipeline!.id, state: "draft" });
  expect(loadPipelines()[0]!.hiddenAt).toBeTruthy();
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
