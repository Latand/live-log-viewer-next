import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Flow } from "@/lib/flows/types";
import type { FileEntry } from "@/lib/types";

process.env.LLV_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "llv-pipeline-engine-"));
const { createPipelineFromRequest, patchPipeline, pipelineClaudePermissionMode, reviewNote, tickPipelines } = await import("./engine");
const { loadPipelines, savePipelines } = await import("./store");
type PipelinePorts = import("./engine").PipelinePorts;

afterAll(() => fs.rmSync(process.env.LLV_STATE_DIR!, { recursive: true, force: true }));

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
  const messages = new Map<string, { text: string; ts: number }>();
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
      if (args[0] === "rev-parse") return { code: 0, stdout: `${ORIGIN_MAIN_SHA}\n`, stderr: "" };
      if (args[0] === "status") return { code: 0, stdout: "", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
    roleLookup: (roleId) => {
      if (roleId === "builder") return { engine: "codex", model: "gpt-5.6-sol", effort: builderEffort, access: "read-write", promptScaffold: "Builder guidance" };
      if (roleId === "reviewer") return { engine: "codex", model: "gpt-5.6-sol", effort: "xhigh", access: "read-only", promptScaffold: "Reviewer guidance" };
      if (roleId === "architect") return { engine: "claude", model: "fable", effort: "high", access: "read-only", promptScaffold: "Architect guidance" };
      return null;
    },
    spawnReceipt: () => null,
    spawnAgent: async ({ parentPath, clientAttemptId, membership }, onReserved) => {
      spawn += 1;
      calls.push(`spawn:${clientAttemptId}:parent=${parentPath ?? "root"}`);
      calls.push(`membership:${membership.kind}:${membership.containerId}:${membership.slot}:${membership.role}:${membership.stageOrder}`);
      onReserved({ launchId: `launch-${spawn}`, conversationId: `conversation_stage_${spawn}` });
      return { launchId: `launch-${spawn}`, conversationId: `conversation_stage_${spawn}`, sessionId: `session-${spawn}`, transcript: `/codex/stage-${spawn}.jsonl`, paneId: `%${spawn}` };
    },
    paneAgentAlive: async () => paneAlive,
    conversationAgentActive: async () => conversationActive,
    headCwd: () => loadPipelines()[0]?.worktreeDir ?? null,
    lastMessage: (item) => messages.get(item.path) ?? null,
    pathForConversation: (id) => id === "conversation_stage_1" ? "/codex/stage-1.jsonl" : id === "conversation_stage_2" ? "/codex/stage-2.jsonl" : null,
    conversationIdForPath: (pathname) => pathname.includes("stage-1") ? "conversation_stage_1" : pathname.includes("stage-2") ? "conversation_stage_2" : null,
    createFlow: async (req) => {
      calls.push(`flow:${req.implementerPath}:${req.baseRef}:${req.spec}`);
      const flow = { id: `flow-${flows.size + 1}`, implementerPath: req.implementerPath, baseRef: req.baseRef, state: "waiting_ready", rounds: [], createdAt: new Date(clock).toISOString(), closedAt: null } as unknown as Flow;
      flows.set(flow.id, flow);
      return { flow };
    },
    patchFlow: (id, action, note) => {
      calls.push(`flow-patch:${id}:${action}`);
      if (note) calls.push(`flow-note:${note}`);
      return {};
    },
    closeFlow: async (id) => { const flow = flows.get(id); if (flow) flow.state = "closed"; },
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
    flows,
    finish,
    setBuilderEffort: (effort: string) => { builderEffort = effort; },
    setPaneAlive: (alive: boolean) => { paneAlive = alive; },
    setConversationActive: (active: boolean | null) => { conversationActive = active; },
  };
}

async function create(ports: PipelinePorts, stages = RUN_STAGES as never) {
  savePipelines([]);
  const result = await createPipelineFromRequest({ task: "Ship pipelines", spec: "AC1", repoDir: "/repo", stages }, ports);
  if (!result.pipeline) throw new Error(result.error);
  return result.pipeline;
}

test("creation validates linear 2–4 stage chains and optional roles", async () => {
  const { ports } = harness();
  expect((await createPipelineFromRequest({ task: "x", repoDir: "/repo", stages: [] }, ports)).status).toBe(400);
  expect((await createPipelineFromRequest({ task: "x", repoDir: "/repo", stages: [
    { id: "a", kind: "run", role: { roleId: "builder" }, engine: "codex", prompt: "a", next: null },
    { id: "b", kind: "run", role: { roleId: "builder" }, engine: "codex", prompt: "b", next: null },
  ] }, ports)).error).toContain("next must be b");
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

  expect(result.pipeline).toMatchObject({ state: "draft", cursor: { stageId: "plan", state: "pending" } });
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);

  const persisted = loadPipelines()[0]!;
  expect(persisted.state).toBe("draft");
  expect(persisted.runs.every((run) => run.attempts.length === 0)).toBe(true);
  expect(h.calls.some((call) => call.includes("worktree add"))).toBe(false);
  expect(h.calls.some((call) => call.startsWith("spawn:"))).toBe(false);
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

  expect(h.calls).toContain(`membership:pipeline:${pipeline.id}:plan:1:architect:0`);
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
    output: null,
    verdict: null,
    error: null,
  });
  pipeline.cursor = { stageId: "plan", state: "spawning" };
  h.ports.spawnReceipt = () => ({
    state: "starting",
    launchId: "launch-reserved",
    conversationId: "conversation_reserved",
    sessionId: null,
    transcript: null,
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
    output: null,
    verdict: null,
    error: null,
  });
  pipeline.cursor = { stageId: "plan", state: "running" };
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
  h.flows.get("flow-1")!.state = "approved";
  await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);
  expect(loadPipelines()[0]!.state).toBe("completed");
  expect(loadPipelines()[0]!.runs[1]!.attempts[0]!.verdict).toEqual({ status: "pass", confidence: 1 });
});

test("retrying a parked review-loop appends a fresh attempt and flow", async () => {
  const h = harness();
  const stages = [
    { id: "build", kind: "run", role: { roleId: "builder" }, prompt: "build", next: "review" },
    { id: "review", kind: "review-loop", role: { roleId: "reviewer" }, prompt: "review", next: null },
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
    startedAt: null, completedAt: null, output: null, verdict: null, error: null,
  });
  savePipelines([started]);
  expect((await patchPipeline(started.id, { action: "override-stage", stageId: "build", prompt: "x" }, ports)).status).toBe(409);
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
      prompt: `Edited ${stage.id}`,
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

test("an empty draft is created, assembled from zero, and cannot start until it has 2 stages (#136)", async () => {
  const h = harness();
  const { ports } = h;
  savePipelines([]);
  /* The canvas builder POSTs a stageless draft — no 2-stage minimum at creation. */
  const created = await createPipelineFromRequest({ task: "Build on canvas", repoDir: "/repo", stages: [], autoStart: false }, ports);
  expect(created.pipeline?.state).toBe("draft");
  expect(created.pipeline?.stages).toEqual([]);
  expect(created.pipeline?.cursor).toBeNull();
  const id = created.pipeline!.id;

  /* Start is refused while under two stages, on the draft, without side effects. */
  const tooFew = await patchPipeline(id, { action: "start" }, ports);
  expect(tooFew.status).toBe(409);
  expect(loadPipelines()[0]!.state).toBe("draft");

  const one = await patchPipeline(id, { action: "add-stage", stage: { id: "plan", kind: "run", role: { roleId: "builder" }, prompt: "Plan it", next: null } }, ports);
  expect(one.pipeline?.stages.map((stage) => stage.id)).toEqual(["plan"]);
  expect(one.pipeline?.cursor).toEqual({ stageId: "plan", state: "pending" });
  expect((await patchPipeline(id, { action: "start" }, ports)).status).toBe(409);

  await patchPipeline(id, { action: "add-stage", stage: { id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build it", next: null } }, ports);
  const started = await patchPipeline(id, { action: "start" }, ports);
  expect(started.pipeline?.state).toBe("provisioning");
});

test("a draft can be emptied stage by stage on the canvas (#136)", async () => {
  const h = harness();
  const { ports } = h;
  savePipelines([]);
  const created = await createPipelineFromRequest({ task: "Empty me", repoDir: "/repo", stages: RUN_STAGES as never, autoStart: false }, ports);
  const id = created.pipeline!.id;
  await patchPipeline(id, { action: "remove-stage", stageId: "build" }, ports);
  const oneLeft = await patchPipeline(id, { action: "remove-stage", stageId: "plan" }, ports);
  expect(oneLeft.pipeline?.stages).toEqual([]);
  expect(oneLeft.pipeline?.cursor).toBeNull();
  /* Removing from an already-empty draft returns a clean 409. */
  expect((await patchPipeline(id, { action: "remove-stage", stageId: "plan" }, ports)).status).toBe(409);
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
