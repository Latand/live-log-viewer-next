import { afterAll, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { Flow, FlowDecisionRequest } from "./types";
import type { FileEntry } from "@/lib/types";
import type { Pipeline } from "@/lib/pipelines/types";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "flow-decisions-"));
process.env.LLV_STATE_DIR = path.join(root, "state");
const { submitFlowDecision, decisionStageMatches } = await import("./decisions");
const { loadFlows, saveFlows } = await import("./store");
const { tickFlow, persistTickFlows, flowTickBase } = await import("./engine");
const cwd = path.join(root, "repo");
fs.mkdirSync(cwd);
const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
git("init", "-b", "main");
git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "--allow-empty", "-m", "initial");
const head = git("rev-parse", "HEAD");
const transcript = path.join(root, "turn.jsonl");
const owner = "conversation_fixture";
let flow: Flow;
let request: FlowDecisionRequest;
function record(type: string, extra: Record<string, unknown> = {}) {
  fs.appendFileSync(transcript, JSON.stringify({ type: "event_msg", timestamp: new Date().toISOString(), payload: { type, turn_id: "turn-a", ...extra } }) + "\n");
}
async function tick() {
  flow = loadFlows().find((item) => item.id === flow.id)!;
  const base = flowTickBase([flow]);
  await tickFlow(flow, [], new Map<string, FileEntry>(), () => {});
  persistTickFlows([flow], base);
  return loadFlows().find((item) => item.id === flow.id)!;
}
beforeEach(() => {
  fs.writeFileSync(transcript, "");
  record("task_started");
  flow = {
    id: "decision-fixture", template: "implement-review-loop", project: "fixture", cwd,
    implementerPath: transcript, implementerConversationId: owner,
    roles: { implementer: { engine: "codex", model: null, effort: null }, reviewer: { engine: "codex", model: null, effort: null } },
    baseRef: head, targetSha: head, baseMode: "head", mode: "auto", reviewerMode: "headless",
    roundLimit: 5, state: "fixing", stateDetail: null, rounds: [], createdAt: "2026-01-01T00:00:00Z", closedAt: null,
  };
  saveFlows([flow]);
  flow = loadFlows()[0]!;
  request = { clientRequestId: "original-key", flowId: flow.id, decision: "submit-review", reason: "repair ready", expectedRevision: flow.revision!, expectedHead: head, round: 0, turnId: "turn-a" };
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

test("decision waits for native completion; replay after consumption preserves one round and original receipt", async () => {
  const accepted = await submitFlowDecision(request, owner);
  expect(accepted.decision.disposition).toBe("accepted");
  expect((await tick()).rounds).toHaveLength(0);
  record("task_complete", { last_agent_message: "ready" });
  const settled = await tick();
  expect(settled.state).toBe("spawning");
  expect(settled.rounds).toHaveLength(1);
  expect(settled.rounds[0]?.reviewHeadSha).toBe(head);
  const replay = await submitFlowDecision(request, owner);
  expect(replay.replayed).toBe(true);
  expect(replay.decision.disposition).toBe("applied");
  expect(loadFlows()[0]?.rounds).toHaveLength(1);
});

test("racing duplicate submissions share the atomic receipt", async () => {
  const results = await Promise.all([submitFlowDecision(request, owner), submitFlowDecision(request, owner)]);
  expect(results[0]?.decision).toEqual(results[1]?.decision);
  expect(loadFlows()[0]?.agentDecisions).toHaveLength(1);
});

test("foreign owner, changed payload, stale revision/head/round/turn and paused flow are refused", async () => {
  await expect(submitFlowDecision(request, "conversation_foreign")).rejects.toThrow("owner");
  for (const change of [{ expectedRevision: 999 }, { expectedHead: "a".repeat(40) }, { round: 1 }, { turnId: "old-turn" }]) {
    await expect(submitFlowDecision({ ...request, ...change }, owner)).rejects.toThrow();
  }
  await submitFlowDecision(request, owner);
  await expect(submitFlowDecision({ ...request, reason: "changed" }, owner)).rejects.toThrow("idempotency conflict");
  await expect(submitFlowDecision(request, null)).rejects.toThrow("owner");
});

test("another terminal turn cannot consume an accepted decision", async () => {
  await submitFlowDecision(request, owner);
  record("task_started", { turn_id: "turn-b" });
  record("task_complete", { turn_id: "turn-b", last_agent_message: "finished later" });
  const result = await tick();
  expect(result.state).toBe("needs_decision");
  expect(result.rounds).toHaveLength(0);
});

test("unknown completion and aborted completion never complete a decision", async () => {
  await submitFlowDecision({ ...request, decision: "completed" }, owner);
  fs.writeFileSync(transcript, "");
  expect((await tick()).agentDecisions?.[0]?.disposition).toBe("accepted");
  record("task_started");
  record("turn_aborted");
  expect((await tick()).state).toBe("needs_decision");
});

test("a terminal record without a turn identity cannot inherit an older identity", async () => {
  await submitFlowDecision({ ...request, decision: "completed" }, owner);
  record("task_complete", { turn_id: null, last_agent_message: "unbound completion" });
  expect((await tick()).state).toBe("needs_decision");
  expect(loadFlows()[0]?.agentDecisions?.[0]?.disposition).toBe("needs_decision");
});

test("rotation fences a late decision without launching a reviewer", async () => {
  await submitFlowDecision(request, owner);
  const current = loadFlows()[0]!;
  current.implementerPath = path.join(root, "rotated.jsonl");
  saveFlows([current]);
  expect((await tick()).state).toBe("needs_decision");
  expect(loadFlows()[0]?.rounds).toHaveLength(0);
});

test("round limit changed after acceptance refuses settlement", async () => {
  const { newRound } = await import("./engine");
  flow.rounds = [newRound(flow, "button", null)];
  saveFlows([flow]);
  request = { ...request, round: 1, expectedRevision: loadFlows()[0]!.revision! };
  await submitFlowDecision(request, owner);
  const current = loadFlows()[0]!;
  current.roundLimit = 1;
  saveFlows([current]);
  record("task_complete", { last_agent_message: "ready" });
  expect((await tick()).state).toBe("needs_decision");
  expect(loadFlows()[0]?.rounds).toHaveLength(1);
});

test("process restart recovers the original decision from SQLite", async () => {
  await submitFlowDecision(request, owner);
  const child = Bun.spawn([process.execPath, "-e", `
    const { submitFlowDecision } = await import("./src/lib/flows/decisions.ts");
    const result = await submitFlowDecision(JSON.parse(process.env.FLOW_TEST_REQUEST), process.env.FLOW_TEST_OWNER);
    process.stdout.write(JSON.stringify(result));
  `], { cwd: process.cwd(), env: { ...process.env, FLOW_TEST_REQUEST: JSON.stringify(request), FLOW_TEST_OWNER: owner }, stdout: "pipe", stderr: "pipe" });
  const output = await new Response(child.stdout).text();
  const error = await new Response(child.stderr).text();
  expect({ code: await child.exited, error }).toEqual({ code: 0, error: "" });
  expect(JSON.parse(output)).toMatchObject({ replayed: true, decision: { disposition: "accepted" } });
  expect(loadFlows()[0]?.agentDecisions).toHaveLength(1);
});

test("a second round keeps its submitted HEAD while waiting to launch", async () => {
  const { newRound } = await import("./engine");
  flow.rounds = [newRound(flow, "button", null)];
  saveFlows([flow]);
  request = { ...request, round: 1, expectedRevision: loadFlows()[0]!.revision! };
  await submitFlowDecision(request, owner);
  record("task_complete", { last_agent_message: "ready" });
  expect((await tick()).state).toBe("spawning");
  // Dirtiness is sufficient to prove the pre-launch fence without starting any host.
  const changed = path.join(cwd, "later.txt");
  fs.writeFileSync(changed, "later work");
  try {
    const entry = { path: transcript } as FileEntry;
    flow = loadFlows()[0]!;
    await tickFlow(flow, [entry], new Map([[transcript, entry]]), () => {});
    expect(flow.state).toBe("needs_decision");
    expect(flow.rounds[1]?.reviewHeadSha).toBe(head);
    expect(flow.rounds[1]?.spawnStartedAt).toBeNull();
  } finally { fs.unlinkSync(changed); }
});

for (const [decision, expected] of [["stop", "closed"], ["completed", "done_comment"], ["continue-fixing", "needs_decision"]] as const) {
  test(`explicit ${decision} settles with its reason and no approval`, async () => {
    await submitFlowDecision({ ...request, decision }, owner);
    record("task_complete", { last_agent_message: "decision submitted" });
    const result = await tick();
    expect(result.state).toBe(expected);
    expect(result.stateDetail).toContain(request.reason);
    expect(result.agentDecisions?.[0]?.disposition).toBe("applied");
  });
}

test("atomic receipt survives a stale controller save", async () => {
  const base = flowTickBase([flow]);
  await submitFlowDecision(request, owner);
  flow.stateDetail = "stale projection";
  persistTickFlows([flow], base);
  expect(loadFlows()[0]?.agentDecisions).toHaveLength(1);
});

test("a budget change racing completion discards the stale transition and retries acceptance", async () => {
  const { newRound } = await import("./engine");
  flow.rounds = [newRound(flow, "button", null)];
  saveFlows([flow]);
  request = { ...request, round: 1, expectedRevision: loadFlows()[0]!.revision! };
  await submitFlowDecision(request, owner);
  const stale = loadFlows()[0]!;
  const base = flowTickBase([stale]);
  const current = loadFlows()[0]!;
  current.roundLimit = 1;
  saveFlows([current]);
  record("task_complete", { last_agent_message: "ready" });
  await tickFlow(stale, [], new Map(), () => {});
  expect(stale.state).toBe("spawning");
  persistTickFlows([stale], base);
  expect(loadFlows()[0]?.agentDecisions?.[0]?.disposition).toBe("accepted");
  expect(loadFlows()[0]?.rounds).toHaveLength(1);
  expect((await tick()).state).toBe("needs_decision");
});

test("pipeline context requires exact current stage attempt and refuses omission/rotation", () => {
  const stage = { pipelineId: "pipeline-fixture", stageId: "review", attempt: 1 };
  const pipeline = { id: stage.pipelineId, state: "running", cursor: { stageId: stage.stageId }, runs: [{ stageId: stage.stageId, attempts: [{ n: 1, flowId: flow.id }] }] } as Pipeline;
  expect(decisionStageMatches(flow, stage, [pipeline])).toBe(true);
  expect(decisionStageMatches(flow, undefined, [pipeline])).toBe(false);
  expect(decisionStageMatches(flow, { ...stage, attempt: 2 }, [pipeline])).toBe(false);
  pipeline.state = "paused";
  expect(decisionStageMatches(flow, stage, [pipeline])).toBe(false);
});

test("MCP rechecks caller authority on replay and after service restart", async () => {
  const { viewerMcpBindings } = await import("@/lib/mcp/bindings");
  const { createMcpToolService, MemoryMcpReceiptStore } = await import("@/lib/mcp/server");
  let caller = owner;
  const bindings = viewerMcpBindings(undefined, undefined, {
    callerAttribution: () => ({ kind: "agent", role: "builder", conversationId: caller }),
  } as never);
  const service = () => createMcpToolService(bindings, new MemoryMcpReceiptStore());
  const first = service();
  const args = { ...request, action: "agent-decision" };
  expect((await first.callTool("flow_action", args)).ok).toBe(true);
  caller = "conversation_foreign";
  expect((await first.callTool("flow_action", args)).ok).toBe(false);
  caller = owner;
  expect(await service().callTool("flow_action", args)).toMatchObject({ ok: true, replayed: true, decision: { disposition: "accepted" } });
  expect((await service().callTool("flow_action", { ...args, expectedHead: "b".repeat(40) })).ok).toBe(false);
  expect(loadFlows()[0]?.agentDecisions).toHaveLength(1);
});

test("HTTP/general action path cannot bypass MCP owner admission", async () => {
  const { patchFlow } = await import("./commands");
  expect(patchFlow(flow.id, { action: "agent-decision" })).toMatchObject({ status: 403 });
  expect(loadFlows()[0]?.agentDecisions).toBeUndefined();
});

test("completed legacy turn without decision has an explicit recoverable state", async () => {
  record("task_complete", { last_agent_message: "work finished" });
  const entry = { path: transcript } as FileEntry;
  await tickFlow(flow, [entry], new Map([[transcript, entry]]), () => {});
  expect(flow.state).toBe("needs_decision");
  expect(flow.decisionRequired).toBe(true);
  expect(flow.rounds).toHaveLength(0);
});

test("silent native completion requires a decision", async () => {
  record("task_complete");
  const entry = { path: transcript } as FileEntry;
  await tickFlow(flow, [entry], new Map([[transcript, entry]]), () => {});
  expect(flow.state).toBe("needs_decision");
  expect(flow.decisionRequired).toBe(true);
});

test("explicit stop preserves unfinished files", async () => {
  const unfinished = path.join(cwd, "unfinished.txt");
  fs.writeFileSync(unfinished, "keep this work");
  try {
    await submitFlowDecision({ ...request, decision: "stop" }, owner);
    record("task_complete", { last_agent_message: "stopped with unfinished work" });
    expect((await tick()).state).toBe("closed");
    expect(fs.readFileSync(unfinished, "utf8")).toBe("keep this work");
  } finally { fs.unlinkSync(unfinished); }
});

test("paused flow refuses new decisions and preserves pending decisions until resumed", async () => {
  flow.state = "paused";
  saveFlows([flow]);
  request.expectedRevision = loadFlows()[0]!.revision!;
  await expect(submitFlowDecision(request, owner)).rejects.toThrow("current state");
  flow = loadFlows()[0]!;
  flow.state = "fixing";
  saveFlows([flow]);
  request.expectedRevision = loadFlows()[0]!.revision!;
  await submitFlowDecision(request, owner);
  flow = loadFlows()[0]!;
  flow.state = "paused";
  saveFlows([flow]);
  record("task_complete", { last_agent_message: "ready" });
  expect((await tick()).state).toBe("paused");
  expect(loadFlows()[0]?.agentDecisions?.[0]?.disposition).toBe("accepted");
});
