import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Flow } from "@/lib/flows/types";
import type { FileEntry } from "@/lib/types";

process.env.LLV_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "llv-pipeline-engine-"));
const { createPipelineFromRequest, patchPipeline, reviewNote, tickPipelines } = await import("./engine");
const { loadPipelines, savePipelines } = await import("./store");
type PipelinePorts = import("./engine").PipelinePorts;

afterAll(() => fs.rmSync(process.env.LLV_STATE_DIR!, { recursive: true, force: true }));

const RUN_STAGES = [
  { id: "plan", kind: "run", role: { roleId: "architect" }, access: "read-only", prompt: "Plan {{task}}", next: "build" },
  { id: "build", kind: "run", role: { roleId: "builder" }, engine: "codex", access: "read-write", prompt: "Build from {{prev.output}}", next: null },
] as const;

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
  const ports: PipelinePorts = {
    exec: (command, args) => {
      calls.push(`${command} ${args.join(" ")}`);
      if (args[0] === "rev-parse" && args[1] === "--git-dir") return { code: 0, stdout: ".git\n", stderr: "" };
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return { code: 0, stdout: "main\n", stderr: "" };
      if (args[0] === "rev-parse") return { code: 0, stdout: `sha-${calls.length}\n`, stderr: "" };
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
    spawnAgent: async ({ parentPath, clientAttemptId }, onReserved) => {
      spawn += 1;
      calls.push(`spawn:${clientAttemptId}:parent=${parentPath ?? "root"}`);
      onReserved({ launchId: `launch-${spawn}`, conversationId: `conversation_stage_${spawn}` });
      return { launchId: `launch-${spawn}`, conversationId: `conversation_stage_${spawn}`, sessionId: `session-${spawn}`, transcript: `/codex/stage-${spawn}.jsonl`, paneId: `%${spawn}` };
    },
    paneAgentAlive: async () => paneAlive,
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
  expect(current.lastPassedCommit).toStartWith("sha-");
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
