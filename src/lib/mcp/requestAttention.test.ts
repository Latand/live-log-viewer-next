import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import type { RegistryConversation } from "@/lib/agent/registry";
import { raiseAttentionRequest } from "@/lib/attention/service";
import { readAttentionFile } from "@/lib/attention/store";
import { adoptLiveRootSession } from "@/lib/root/adopt";
import { readRootLineage } from "@/lib/root/store";
import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";

import { viewerMcpBindings } from "./bindings";
import { createMcpToolService, MemoryMcpReceiptStore, MCP_TOOL_NAMES, type McpToolResult } from "./server";

/*
 * The root agent's own door into #688.
 *
 * Before this there was none: the record, the machine and the HTTP surface all
 * existed, and the only way to raise a request was a hand-written POST. The
 * agent could not ask for the operator's attention through the surface it
 * actually has.
 */

let sandbox = "";
let previousStateDir: string | undefined;

beforeEach(() => {
  previousStateDir = process.env.LLV_STATE_DIR;
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-attention-"));
  process.env.LLV_STATE_DIR = sandbox;
});
afterEach(() => {
  if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousStateDir;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const REVIEWER = "/tmp/reviewer.jsonl";

const reviewerFile = {
  path: REVIEWER,
  project: "live-log-viewer-next",
  title: "Reviewer — login fix",
  engine: "claude",
  activity: "live",
} as unknown as FileEntry;

const task = {
  id: "task_1",
  project: "other-project",
  status: "inbox",
  text: "Ship the handoff",
  placement: "unplaced",
  assignments: [],
  createdAt: "2026-07-01T10:00:00.000Z",
  updatedAt: "2026-07-01T10:00:00.000Z",
} as unknown as BoardTask;

interface Adoptions { count: number }

function bindings(adoptions: Adoptions = { count: 0 }, adoptRootSession = () => { adoptions.count += 1; }) {
  return viewerMcpBindings(undefined, undefined, {
    listFiles: async () => [reviewerFile],
    loadTasks: () => [task],
    getPipelines: () => ({ pipelines: [{ id: "pipeline_1", project: "pipeline-project" }] }),
    getFlowsWithPresets: () => ({ flows: [{ id: "flow_1", project: "flow-project" }] }),
    adoptRootSession,
    /* The real one: it resolves the state path per call, so the sandbox set in
       beforeEach applies and the request lands on a real record. */
    raiseAttentionRequest,
  } as never);
}

function service(adoptions: Adoptions = { count: 0 }) {
  return createMcpToolService(bindings(adoptions), new MemoryMcpReceiptStore());
}

/** A root conversation exactly as the registry holds one — the `root` role on
    the newest generation's launch profile, which is the only place the registry
    ever writes it. Typed as the real thing so the shape cannot drift. */
function rootConversation(id: string, transcript: string, updatedAt: string): RegistryConversation {
  return {
    id: id as RegistryConversation["id"],
    engine: "claude",
    generations: [{
      id: `${id}_g0`,
      path: transcript,
      accountId: null,
      launchProfile: emptyLaunchProfile({ cwd: "/repo", role: "root" }),
      historyHash: null,
      host: null,
      createdAt: "2026-07-01T09:00:00.000Z",
      archivedAt: null,
    }],
    continuityPaths: [],
    abandonedContinuityPaths: [],
    providerForkPaths: [],
    projectOwnership: null,
    migration: null,
    migrationOptOut: null,
    supersededBy: null,
    /* No role PRESET: the operator's own session is precisely the one without
       one, which is why the preset id can never identify it. */
    agentRole: null,
    delegationDepth: null,
    turn: { state: "idle", source: "empty", terminalAt: null, observedAt: null },
    createdAt: "2026-07-01T09:00:00.000Z",
    updatedAt,
  };
}

const ask = (overrides: Record<string, unknown> = {}) => ({
  clientRequestId: "raise-1",
  target: { kind: "conversation", path: REVIEWER },
  reason: "The reviewer finished with request-changes.",
  ...overrides,
});

test("the root agent can raise a request through its normal tool surface", async () => {
  const adoptions = { count: 0 };
  const result = await service(adoptions).callTool("request_attention", ask()) as McpToolResult & { attentionId?: string };

  expect(result.ok).toBe(true);
  expect(result.attentionId).toStartWith("attention_");
  const stored = readAttentionFile().requests[0]!;
  /* It only ASKS: nothing moves until the operator agrees on a device. */
  expect(stored.state).toBe("pending");
  expect(stored.origin).toBe("root-agent");
  expect(stored.intent).toBe("show");
  /* The project is derived from the target rather than taken from the caller,
     and the frame records that no board was read. */
  expect(stored.frameAtCreation).toEqual({ project: "live-log-viewer-next", rect: { x: 0, y: 0, w: 0, h: 0 }, boardRevision: null });
  /* The root is named by stable identity, never by a session path — and the
     live session was folded into the chain on the way past. */
  expect(stored.requestedBy.rootId).toBe(readRootLineage()!.rootId);
  expect(adoptions.count).toBe(1);
});

test("a repeated clientRequestId replays the same receipt instead of asking twice", async () => {
  const tools = service();

  const first = await tools.callTool("request_attention", ask()) as McpToolResult & { attentionId?: string };
  const again = await tools.callTool("request_attention", ask()) as McpToolResult & { attentionId?: string };

  expect(again.replayed).toBe(true);
  expect(again.attentionId).toBe(first.attentionId!);
  /* One ask on the record. Without this a retried tool call would supersede its
     own previous request and the operator would watch the card replace itself. */
  expect(readAttentionFile().requests).toHaveLength(1);
});

test("the same key with different arguments is a conflict, not a second ask", async () => {
  const tools = service();
  await tools.callTool("request_attention", ask());

  const conflict = await tools.callTool("request_attention", ask({ reason: "Something else entirely." })) as McpToolResult;

  expect(conflict).toMatchObject({ ok: false, code: "idempotency_conflict" });
  expect(readAttentionFile().requests).toHaveLength(1);
});

test("every target kind the server can attribute resolves its own project", async () => {
  const tools = service();

  for (const [key, target, project] of [
    ["pipeline", { kind: "pipeline", pipelineId: "pipeline_1" }, "pipeline-project"],
    ["stage", { kind: "stage", pipelineId: "pipeline_1", stageId: "review" }, "pipeline-project"],
    ["flow", { kind: "flowRound", flowId: "flow_1", round: 2 }, "flow-project"],
    ["task", { kind: "task", taskId: "task_1" }, "other-project"],
    ["point", { kind: "point", project: "geometric", x: 10, y: 20 }, "geometric"],
  ] as const) {
    const result = await tools.callTool("request_attention", ask({ clientRequestId: `raise-${key}`, target })) as McpToolResult;
    expect(result.ok).toBe(true);
    expect(readAttentionFile().requests.at(-1)!.frameAtCreation.project).toBe(project);
  }

  /* A geometric target IS its own frame, so it is the one kind that can degrade
     to a real destination when nothing named survives. */
  expect(readAttentionFile().requests.at(-1)!.frameAtCreation.rect).toEqual({ x: -290, y: -280, w: 600, h: 600 });
});

test("a target the server cannot attribute is refused rather than filed under a guess", async () => {
  const tools = service();

  const draft = await tools.callTool("request_attention", ask({ clientRequestId: "raise-draft", target: { kind: "draft", draftId: "d1" } })) as McpToolResult;
  const missing = await tools.callTool("request_attention", ask({ clientRequestId: "raise-missing", target: { kind: "conversation", path: "/tmp/nope.jsonl" } })) as McpToolResult;
  const nonsense = await tools.callTool("request_attention", ask({ clientRequestId: "raise-nonsense", target: { kind: "elsewhere" } })) as McpToolResult;

  expect(draft).toMatchObject({ ok: false, error: "a draft target needs an explicit project" });
  expect(missing).toMatchObject({ ok: false, error: "no conversation on the board has that transcript path" });
  expect(nonsense).toMatchObject({ ok: false, error: "target must be a typed focus target" });
  expect(readAttentionFile().requests).toEqual([]);

  /* Naming the project explicitly is the way through for a board draft. */
  const named = await tools.callTool("request_attention", ask({ clientRequestId: "raise-draft-2", target: { kind: "draft", draftId: "d1" }, project: "demo" })) as McpToolResult;
  expect(named.ok).toBe(true);
  expect(readAttentionFile().requests[0]!.frameAtCreation.project).toBe("demo");
});

test("a geometric target may not be opened, and the refusal reaches the caller", async () => {
  const tools = service();

  const refused = await tools.callTool("request_attention", ask({
    target: { kind: "region", project: "demo", rect: { x: 0, y: 0, w: 100, h: 100 } },
    intent: "open",
  })) as McpToolResult;

  /* Refused, never silently downgraded: the operator is told which of show and
     open they are agreeing to, so a rewritten intent would make that a lie. */
  expect(refused).toMatchObject({ ok: false, error: "a geometric target can only be shown, not opened" });
  expect(readAttentionFile().requests).toEqual([]);
});

test("the ask is a mutation, so its receipt outlives the MCP process", async () => {
  const retentions: string[] = [];
  const store = new MemoryMcpReceiptStore();
  const spy = {
    claim: (key: string, digest: string, retention: string) => {
      retentions.push(retention);
      return store.claim(key, digest);
    },
    complete: (key: string, digest: string, result: McpToolResult) => store.complete(key, digest, result),
  };

  await createMcpToolService(bindings(), spy as never).callTool("request_attention", ask());

  /* A bounded receipt would let a retry after a restart ask the operator a
     second time for the same thing. */
  expect(retentions).toEqual(["durable"]);
  expect(MCP_TOOL_NAMES).toContain("request_attention");
});

test("a raise folds the real live root session into the chain, and a rollover keeps the link", async () => {
  /* The adoption runs for real here against registry-shaped conversations — not
     a counter — because the defect this closes was the resolution reading a
     field the registry never writes `root` into: the raise worked, the chain
     stayed empty, and every request named an identity with no sessions behind
     it. Only a production-shaped source can tell the two apart. */
  let live = [rootConversation("conversation_root", "/tmp/root.jsonl", "2026-07-01T10:00:00.000Z")];
  const tools = createMcpToolService(
    bindings(undefined, () => { adoptLiveRootSession({ conversations: live, configuredRootId: null }); }),
    new MemoryMcpReceiptStore(),
  );

  await tools.callTool("request_attention", ask());

  const identity = readRootLineage()!.rootId;
  expect(readRootLineage()!.sessions).toHaveLength(1);
  expect(readRootLineage()!.sessions[0]).toMatchObject({ conversationId: "conversation_root", path: "/tmp/root.jsonl" });

  /* The rollover D5 exists for: the session the operator is talking to is
     replaced, and a request raised before it must still resolve after. */
  live = [...live, rootConversation("conversation_root_2", "/tmp/root-2.jsonl", "2026-07-01T11:00:00.000Z")];
  await tools.callTool("request_attention", ask({ clientRequestId: "raise-2", reason: "The verifier is blocked on you." }));

  const sessions = readRootLineage()!.sessions;
  expect(sessions.map((session) => session.conversationId)).toEqual(["conversation_root", "conversation_root_2"]);
  expect(sessions[1]!.seededFrom).toBe("conversation_root");
  /* Same stable identity across the rollover, and both requests named it. */
  expect(readRootLineage()!.rootId).toBe(identity);
  expect(readAttentionFile().requests.map((entry) => entry.requestedBy.rootId)).toEqual([identity, identity]);
});

test("no rootId can be named by the caller", async () => {
  const tools = service();

  await tools.callTool("request_attention", ask({ rootId: "root_somebody_else" }));

  /* D4's authority rule: the service resolves the root identity itself, so a
     worker holding this tool still cannot speak as a root of its choosing. */
  expect(readAttentionFile().requests[0]!.requestedBy.rootId).toBe(readRootLineage()!.rootId);
  expect(readAttentionFile().requests[0]!.requestedBy.rootId).not.toBe("root_somebody_else");
});
