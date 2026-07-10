import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Flow } from "@/lib/flows/types";
import type { FileEntry } from "@/lib/types";

process.env.LLV_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "llv-pipeline-engine-"));
const { createPipelineFromRequest, patchPipeline, tickPipelines } = await import("./engine");
const { loadPipelines, savePipelines } = await import("./store");
type PipelinePorts = import("./engine").PipelinePorts;

afterAll(() => fs.rmSync(process.env.LLV_STATE_DIR!, { recursive: true, force: true }));

const RUN_STAGES = [
  { id: "plan", kind: "run", role: { roleId: "architect" }, engine: "codex", access: "read-only", prompt: "Plan {{task}}", next: "build" },
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
  const ports: PipelinePorts = {
    exec: (command, args) => {
      calls.push(`${command} ${args.join(" ")}`);
      if (args[0] === "rev-parse" && args[1] === "--git-dir") return { code: 0, stdout: ".git\n", stderr: "" };
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return { code: 0, stdout: "main\n", stderr: "" };
      if (args[0] === "rev-parse") return { code: 0, stdout: `sha-${calls.length}\n`, stderr: "" };
      if (args[0] === "status") return { code: 0, stdout: "", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
    roleLookup: null,
    spawnAgent: async ({ parentPath, clientAttemptId }) => {
      spawn += 1;
      calls.push(`spawn:${clientAttemptId}:parent=${parentPath ?? "root"}`);
      return { launchId: `launch-${spawn}`, conversationId: `conversation_stage_${spawn}`, sessionId: `session-${spawn}`, transcript: `/codex/stage-${spawn}.jsonl`, paneId: `%${spawn}` };
    },
    paneAgentAlive: async () => true,
    headCwd: () => loadPipelines()[0]?.worktreeDir ?? null,
    lastMessage: (item) => messages.get(item.path) ?? null,
    pathForConversation: (id) => id === "conversation_stage_1" ? "/codex/stage-1.jsonl" : id === "conversation_stage_2" ? "/codex/stage-2.jsonl" : null,
    conversationIdForPath: (pathname) => pathname.includes("stage-1") ? "conversation_stage_1" : pathname.includes("stage-2") ? "conversation_stage_2" : null,
    createFlow: async (req) => {
      calls.push(`flow:${req.implementerPath}:${req.baseRef}:${req.spec}`);
      const flow = { id: "flow-1", implementerPath: req.implementerPath, baseRef: req.baseRef, state: "waiting_ready", rounds: [], createdAt: new Date(clock).toISOString(), closedAt: null } as unknown as Flow;
      flows.set(flow.id, flow);
      return { flow };
    },
    patchFlow: (id, action) => calls.push(`flow-patch:${id}:${action}`),
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
  return { ports, calls, messages, flows, finish };
}

function create(ports: PipelinePorts, stages = RUN_STAGES as never) {
  savePipelines([]);
  const result = createPipelineFromRequest({ task: "Ship pipelines", spec: "AC1", repoDir: "/repo", stages }, ports);
  if (!result.pipeline) throw new Error(result.error);
  return result.pipeline;
}

test("creation validates linear 2–4 stage chains and optional roles", () => {
  const { ports } = harness();
  expect(createPipelineFromRequest({ task: "x", repoDir: "/repo", stages: [] }, ports).status).toBe(400);
  expect(createPipelineFromRequest({ task: "x", repoDir: "/repo", stages: [
    { id: "a", kind: "run", role: { roleId: "builder" }, engine: "codex", prompt: "a", next: null },
    { id: "b", kind: "run", role: { roleId: "builder" }, engine: "codex", prompt: "b", next: null },
  ] }, ports).error).toContain("next must be b");
  const roleless = createPipelineFromRequest({ task: "x", repoDir: "/repo", stages: [
    { id: "a", kind: "run", prompt: "a", next: "b" },
    { id: "b", kind: "run", prompt: "b", next: null },
  ] }, ports);
  expect(roleless.pipeline?.stages[0]?.role).toBeUndefined();
  expect(createPipelineFromRequest({ task: "x", repoDir: "/repo", stages: [
    { id: "a", kind: "run", role: { roleId: "builder" }, prompt: "a", next: "b" },
    { id: "b", kind: "run", role: { roleId: "builder", engine: "codex" }, prompt: "b", next: null },
  ] as never }, ports).error).toContain("role only accepts roleId");
});

test("linear run stages persist sessions, structured outputs, commits, and lineage", async () => {
  const h = harness();
  create(h.ports);
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

test("role-less run stages persist the Builder global runtime", async () => {
  const h = harness();
  create(h.ports, [
    { id: "research", kind: "run", prompt: "research", next: "summarize" },
    { id: "summarize", kind: "run", prompt: "summarize", next: null },
  ] as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.effectiveRole).toEqual({
    roleId: null,
    engine: "codex",
    model: "gpt-5.6-sol",
    effort: "high",
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
  create(h.ports, stages as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass")], h.ports);
  await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);
  expect(h.calls.filter((call) => call.startsWith("flow:")).length).toBe(1);
  expect(h.calls).toContain("flow-patch:flow-1:advance");
  h.flows.get("flow-1")!.state = "approved";
  await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);
  expect(loadPipelines()[0]!.state).toBe("completed");
  expect(loadPipelines()[0]!.runs[1]!.attempts[0]!.verdict).toEqual({ status: "pass", confidence: 1 });
});

test("failed stages park and retry resets to the last passed commit", async () => {
  const h = harness();
  const pipeline = create(h.ports);
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
  const pipeline = create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "needs_decision", "operator choice")], h.ports);
  const result = await patchPipeline(pipeline.id, { action: "skip-stage" }, h.ports);
  expect(result.pipeline?.cursor?.stageId).toBe("build");
  expect(h.calls.some((call) => call.includes("reset --hard"))).toBe(true);
  expect(h.calls.some((call) => call.includes("clean -fd"))).toBe(true);
});
