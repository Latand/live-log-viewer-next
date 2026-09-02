import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AgentRegistry, setAgentRegistryForTests } from "@/lib/agent/registry";
import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { SEND_LOST_REASON } from "@/lib/runtime/sendSettlement";
import { VIEWER_SPAWN_CAPABILITY_ENV, VIEWER_SPAWN_CAPABILITY_HEADER } from "@/lib/agent/spawnPolicy";
import { applyBoardCommand } from "@/lib/board/command";
import { boardFor, mutateBoard, patchBoard } from "@/lib/board/store";
import { DeadlineExceededError } from "@/lib/deadline";
import { CORPUS_BODY_MARKERS, pipelineCorpus } from "@/lib/pipelines/fixtures/corpus";
import type { Pipeline } from "@/lib/pipelines/types";
import { listRoles } from "@/lib/roles/registry";
import type { RoleDefinition } from "@/lib/roles/types";
import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";

import type { CompletedGenerationRead } from "@/lib/lifecycle/inventorySelection";
import { queryLifecycleEvents } from "@/lib/lifecycle/journal";
import { productionLivenessSources } from "@/lib/lifecycle/liveness";
import { refreshLifecycleJournal } from "@/lib/lifecycle/projector";

import { defaultMcpSpawnRoleParams, viewerMcpBindings } from "./bindings";
import { SEAT_TICK_PROMPT_LIMIT } from "@/lib/monitor/seatTickSettings";
import {
  createMcpToolService,
  MemoryMcpReceiptStore,
  type McpReceiptStore,
  type McpToolResult,
} from "./server";

const sandboxes: string[] = [];
const originalStateDir = process.env.LLV_STATE_DIR;
const originalSpawnCapability = process.env[VIEWER_SPAWN_CAPABILITY_ENV];

afterEach(() => {
  setAgentRegistryForTests(null);
  if (originalStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = originalStateDir;
  if (originalSpawnCapability === undefined) delete process.env[VIEWER_SPAWN_CAPABILITY_ENV];
  else process.env[VIEWER_SPAWN_CAPABILITY_ENV] = originalSpawnCapability;
  for (const sandbox of sandboxes.splice(0)) fs.rmSync(sandbox, { recursive: true, force: true });
});

function bulkArchiveFixture(
  conversationCount: number,
  generationsPerConversation: number,
  beforeApply?: (input: unknown, call: number, boardFile: string, project: string) => void,
) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-archive-bulk-"));
  sandboxes.push(sandbox);
  const boardFile = path.join(sandbox, "board.json");
  const project = "fixture-bulk-archive-project";
  const conversationIds = Array.from(
    { length: conversationCount },
    (_, index) => `conversation_bulk_${index}`,
  );
  const pathsByTarget = conversationIds.map((_, conversationIndex) => Array.from(
    { length: generationsPerConversation },
    (_, generationIndex) => `/fixtures/bulk-archive/conversation-${conversationIndex}/generation-${generationIndex}.jsonl`,
  ));
  const launchProfile = {
    cwd: "/fixtures/bulk-archive",
    project,
    model: null,
    effort: null,
  };
  const emptyRegistrySnapshot = new AgentRegistry(path.join(sandbox, "agent-registry.json")).readOnlySnapshot();
  const registrySnapshot: typeof emptyRegistrySnapshot = {
    ...emptyRegistrySnapshot,
    conversations: Object.fromEntries(conversationIds.map((conversationId, index) => [conversationId, {
      id: conversationId,
      generations: pathsByTarget[index]!.map((pathname) => ({ path: pathname, launchProfile })),
      continuityPaths: [],
      abandonedContinuityPaths: [],
      migration: null,
      projectOwnership: {
        project,
        source: "operator",
        setAt: "2026-08-24T08:00:00.000Z",
        operationId: `ownership_${conversationId}`,
      },
    } as never])),
  };
  let commandCalls = 0;
  const bindings = viewerMcpBindings(undefined, undefined, {
    registrySnapshot: () => registrySnapshot,
    completedFileScan: async () => {
      throw new Error("registered bulk archiving must not scan transcripts");
    },
    boardFor: (key: string) => boardFor(key, boardFile),
    applyBoardCommand: (input: unknown, snapshot: typeof registrySnapshot) => {
      commandCalls += 1;
      beforeApply?.(input, commandCalls, boardFile, project);
      return applyBoardCommand(input, {
        registrySnapshot: () => snapshot,
        patchBoard: (key, revision, patch) => patchBoard(key, revision, patch, boardFile),
        mutateBoard: (key, revision, mutations) => mutateBoard(key, revision, mutations, boardFile),
      });
    },
  } as never);
  return {
    bindings,
    boardFile,
    project,
    targets: conversationIds.map((conversationId) => ({ conversationId })),
    pathsByTarget,
    allPaths: pathsByTarget.flat(),
  };
}

test("spawn_agent reaches spawn validation through the operator admission lane", async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-binding-spawn-"));
  sandboxes.push(sandbox);
  process.env.LLV_STATE_DIR = sandbox;
  const requests: Array<{ pathname: string; body: Record<string, unknown>; headers?: Record<string, string> }> = [];
  const spawnAgent = viewerMcpBindings(undefined, {
    post: async (pathname, body, headers) => {
      requests.push({ pathname, body, headers });
      throw new Error(`directory does not exist: ${String(body.cwd)}`);
    },
  }).spawn_agent;
  const missingCwd = path.join(sandbox, "missing-cwd");

  for (const request of [
    { clientRequestId: "mcp-roleless-spawn", engine: "codex", cwd: missingCwd, prompt: "probe" },
    { clientRequestId: "mcp-builder-spawn", role: "builder", cwd: missingCwd, prompt: "probe" },
  ]) {
    await expect(spawnAgent(request)).rejects.toThrow(`directory does not exist: ${missingCwd}`);
  }
  expect(requests.map((request) => request.pathname)).toEqual(["/api/spawn", "/api/spawn"]);
  expect(requests.every((request) => Boolean(request.headers?.["x-llv-spawn-capability"]))).toBe(true);
  expect(requests.every((request) => /^mcp\.[a-f0-9]{64}$/.test(request.headers?.["x-llv-internal-service"] ?? ""))).toBe(true);
  expect(fs.readFileSync(path.join(sandbox, "operator-spawn-capability"), "utf8").trim()).toMatch(/^[A-Za-z0-9_-]{43}$/);
});

test("spawn_agent rejects an explicit model outside the engine catalog before control-plane admission", async () => {
  const requests: Record<string, unknown>[] = [];
  const spawnAgent = viewerMcpBindings(undefined, {
    post: async (_pathname, body) => {
      requests.push(body);
      return {};
    },
  }).spawn_agent;

  const refusal = await spawnAgent({
    clientRequestId: "mcp-invalid-model",
    engine: "codex",
    model: "gpt-5.6-codex",
    cwd: "/repo",
    ["prompt"]: "probe",
  }).then(
    () => null,
    (error: unknown) => error as Error & { details?: { violations?: Array<{ field: string; message: string; expected: string }> } },
  );

  const message = "invalid codex model id \"gpt-5.6-codex\"; valid codex model ids: gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna";
  expect(refusal?.name).toBe("McpToolRefusal");
  expect(refusal?.message).toBe(message);
  expect(refusal?.details?.violations).toEqual([{
    field: "model",
    message,
    expected: "one of: gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna",
  }]);
  expect(requests).toEqual([]);
});

test("MCP message delivery always presents authenticated service provenance with or without an agent capability", async () => {
  const requests: Array<{ headers?: Record<string, string> }> = [];
  const send = viewerMcpBindings(undefined, {
    post: async (_pathname, _body, headers) => {
      requests.push({ headers });
      return { outcome: "delivered" };
    },
  }).send_message;
  const previous = process.env[VIEWER_SPAWN_CAPABILITY_ENV];
  try {
    process.env[VIEWER_SPAWN_CAPABILITY_ENV] = "e".repeat(43);
    await send({ clientRequestId: "mcp-send-valid", conversationId: "conversation_http_control", text: "one" });
    delete process.env[VIEWER_SPAWN_CAPABILITY_ENV];
    await send({ clientRequestId: "mcp-send-missing", conversationId: "conversation_http_control", text: "two" });

    expect(requests[0]!.headers?.[VIEWER_SPAWN_CAPABILITY_HEADER]).toBe("e".repeat(43));
    expect(requests[1]!.headers?.[VIEWER_SPAWN_CAPABILITY_HEADER]).toBeUndefined();
    expect(requests.every((request) => /^mcp\.[a-f0-9]{64}$/.test(request.headers?.["x-llv-internal-service"] ?? ""))).toBe(true);
  } finally {
    if (previous === undefined) delete process.env[VIEWER_SPAWN_CAPABILITY_ENV];
    else process.env[VIEWER_SPAWN_CAPABILITY_ENV] = previous;
  }
});

test("conversation deliverability is read from the durable host record through the resume publication window", async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-deliverability-"));
  sandboxes.push(sandbox);
  const transcriptPath = "/fixtures/conversations/deliverability.jsonl";
  const registry = new AgentRegistry(path.join(sandbox, "agent-registry.json"));
  registry.reconcileConversations([{
    engine: "codex",
    path: transcriptPath,
    accountId: "fixture-account",
    launchProfile: emptyLaunchProfile({ cwd: "/fixtures/project", project: "fixture-project" }),
    turn: { state: "terminal", source: "assistant", terminalAt: "2026-08-29T09:00:00.000Z" },
    observedAt: "2026-08-30T09:00:00.000Z",
  }]);
  const conversation = registry.conversationForPath(transcriptPath)!;
  const generation = conversation.generations.at(-1)!;
  const key = { engine: "codex" as const, sessionId: generation.id };
  const baseEntry = {
    key,
    artifactPath: transcriptPath,
    cwd: generation.launchProfile.cwd,
    accountId: generation.accountId,
    launchProfile: generation.launchProfile,
    host: null,
    claimEpoch: 3,
    claimOwner: null,
  };
  const bindings = viewerMcpBindings(undefined, undefined, {
    registrySnapshot: () => registry.readOnlySnapshot(),
  } as never) as unknown as {
    conversation_deliverability(args: Record<string, unknown>): Promise<Record<string, unknown>>;
  };
  let queryNumber = 0;
  const query = () => bindings.conversation_deliverability({
    clientRequestId: `deliverability-${queryNumber += 1}`,
    conversationId: conversation.id,
  });

  registry.upsert({
    ...baseEntry,
    status: "idle",
    structuredHost: {
      kind: "codex-app-server",
      endpoint: "stdio:released",
      process: null,
      eventCursor: 9,
      protocolVersion: "v2",
      writerClaimEpoch: 3,
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
    },
    claimOwner: "structured-host:stale-owner",
    pendingAction: null,
  });
  await expect(query()).resolves.toMatchObject({
    conversationId: conversation.id,
    deliverable: false,
    condition: "reclaimed",
    resumeRequired: true,
    processRecorded: false,
  });

  registry.upsert({
    ...baseEntry,
    status: "starting",
    structuredHost: {
      kind: "codex-app-server",
      endpoint: "stdio:publishing",
      process: null,
      eventCursor: 0,
      protocolVersion: "v2",
      writerClaimEpoch: 4,
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 4,
    pendingAction: "resume",
  });
  await expect(query()).resolves.toMatchObject({
    conversationId: conversation.id,
    deliverable: false,
    condition: "synchronizing",
    resumeRequired: false,
    processRecorded: false,
  });

  registry.upsert({
    ...baseEntry,
    status: "idle",
    structuredHost: {
      kind: "codex-app-server",
      endpoint: "stdio:published",
      process: { pid: 4100, startIdentity: "fixture-process" },
      eventCursor: 1,
      protocolVersion: "v2",
      writerClaimEpoch: 5,
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 5,
    claimOwner: "structured-host:fixture",
    pendingAction: null,
  });
  await expect(query()).resolves.toMatchObject({
    conversationId: conversation.id,
    deliverable: true,
    condition: "deliverable",
    resumeRequired: false,
    processRecorded: true,
  });
});

test("spawn_agent derives required role params from the prompt and preserves supplied params", async () => {
  const bodies: Record<string, unknown>[] = [];
  const spawn = viewerMcpBindings(undefined, {
    post: async (_pathname, body) => {
      bodies.push(body);
      return {
        conversationId: `conversation_${bodies.length}`,
        path: `/repo/session-${bodies.length}.jsonl`,
        launchId: `launch_${bodies.length}`,
        state: "queued",
      };
    },
  }).spawn_agent;
  const sha = "a".repeat(40);

  await spawn({
    clientRequestId: "derive-review-pr",
    cwd: "/repo",
    ["prompt"]: "Review PR #915 for correctness.",
    role: "reviewer",
    roleParams: { lens: "correctness" },
  });
  await spawn({
    clientRequestId: "derive-review-branch",
    cwd: "/repo",
    ["prompt"]: "Review branch feature/mcp-clamping before merge.",
    role: "reviewer",
  });
  await spawn({
    clientRequestId: "derive-review-branch-punctuation",
    cwd: "/repo",
    ["prompt"]: "Review branch feature/topic.",
    role: "reviewer",
  });
  await spawn({
    clientRequestId: "derive-review-quoted-branch-punctuation",
    cwd: "/repo",
    ["prompt"]: "Review branch `feature/quoted`.",
    role: "reviewer",
  });
  await spawn({
    clientRequestId: "derive-review-quoted-range",
    cwd: "/repo",
    ["prompt"]: "Review `origin/main...HEAD`.",
    role: "reviewer",
  });
  await spawn({
    clientRequestId: "derive-review-bare-ref",
    cwd: "/repo",
    ["prompt"]: "Review origin/main before merge.",
    role: "reviewer",
  });
  await spawn({
    clientRequestId: "derive-prod-questions",
    cwd: "/repo",
    ["prompt"]: "Measure stalled delivery latency.\nUse a bounded UTC window.",
    role: "prod-auditor",
  });
  await spawn({
    clientRequestId: "derive-verifier-claims",
    cwd: "/repo",
    ["prompt"]: "The bounded read returns within its budget.\nUse a synthetic transcript.",
    role: "verifier",
  });
  await spawn({
    clientRequestId: "derive-deployer-sha",
    cwd: "/repo",
    ["prompt"]: `Prepare deployment for ${sha}.`,
    role: "deployer",
  });

  expect(bodies.map((body) => body.roleParams)).toEqual([
    { diffSource: "PR #915", lens: "correctness" },
    { diffSource: "feature/mcp-clamping" },
    { diffSource: "feature/topic" },
    { diffSource: "feature/quoted" },
    { diffSource: "origin/main...HEAD" },
    { diffSource: "origin/main" },
    { questions: "Measure stalled delivery latency." },
    { claims: "The bounded read returns within its budget." },
    { sha },
  ]);
});

test("spawn_agent coerces and clamps bounded role params before the control request", async () => {
  const bodies: Record<string, unknown>[] = [];
  const service = createMcpToolService(viewerMcpBindings(undefined, {
    post: async (_pathname, body) => {
      bodies.push(body);
      return {
        conversationId: `conversation_${bodies.length}`,
        path: `/repo/session-${bodies.length}.jsonl`,
        launchId: `launch_${bodies.length}`,
        state: "queued",
      };
    },
  }), new MemoryMcpReceiptStore());

  const reviewer = await service.callTool("spawn_agent", {
    clientRequestId: "bounded-reviewer-parallel",
    cwd: "/repo",
    ["prompt"]: "Review PR #915.",
    role: "reviewer",
    roleParams: { parallelN: "4" },
  });
  const orchestrator = await service.callTool("spawn_agent", {
    clientRequestId: "bounded-orchestrator-workers",
    cwd: "/repo",
    ["prompt"]: "Coordinate the assigned work.",
    role: "orchestrator",
    roleParams: { maxWorkers: 99 },
  });

  expect(reviewer).toMatchObject({ ok: true, clamped: { "roleParams.parallelN": 4 } });
  expect(orchestrator).toMatchObject({ ok: true, clamped: { "roleParams.maxWorkers": 20 } });
  expect(bodies.map((body) => body.roleParams)).toEqual([
    { diffSource: "PR #915", parallelN: 4 },
    { maxWorkers: 20 },
  ]);
});

test("spawn_agent reports every underivable required role param with its shape in one error", async () => {
  let posts = 0;
  const spawn = viewerMcpBindings(undefined, {
    post: async () => {
      posts += 1;
      return {};
    },
  }).spawn_agent;
  const cases = [
    { role: "reviewer", prompt: "Review the current work.", param: "diffSource" },
    { role: "verifier", prompt: "", param: "claims" },
    { role: "prod-auditor", prompt: "", param: "questions" },
    { role: "deployer", prompt: "Prepare the current release.", param: "sha" },
  ] as const;

  for (const candidate of cases) {
    await expect(spawn({
      clientRequestId: `missing-${candidate.role}`,
      cwd: "/repo",
      ["prompt"]: candidate.prompt,
      role: candidate.role,
    })).rejects.toThrow(
      `missing required roleParams for ${candidate.role}: ${candidate.param}: non-empty string up to 2000 characters`,
    );
  }

  const reviewer = listRoles().find((candidate) => candidate.id === "reviewer")!;
  const roleWithTwoRequiredParams: RoleDefinition = {
    ...reviewer,
    parameters: [
      { key: "diffSource", label: "Diff source", description: "Diff to inspect.", kind: "text", required: true },
      { key: "claims", label: "Claims", description: "Claims to verify.", kind: "text", required: true },
    ],
  };
  expect(() => defaultMcpSpawnRoleParams({
    clientRequestId: "missing-multiple-reviewer-params",
    cwd: "/repo",
    ["prompt"]: "",
    role: "reviewer",
  }, [roleWithTwoRequiredParams])).toThrow(
    "missing required roleParams for reviewer: diffSource: non-empty string up to 2000 characters; claims: non-empty string up to 2000 characters",
  );
  expect(posts).toBe(0);
});

test("runtime-bound MCP tools use the live Viewer control surface", async () => {
  const requests: Array<{ pathname: string; body: Record<string, unknown>; headers?: Record<string, string> }> = [];
  process.env[VIEWER_SPAWN_CAPABILITY_ENV] = "c".repeat(43);
  /* #795: the deploy tool authorizes off the SERVER-ATTRIBUTED caller identity, so
     the control-surface check attributes this session as the designated seat of its
     own project. `deployAuthority.test.ts` covers the refusals directly. */
  const designatedSeat = {
    callerAttribution: () => ({ kind: "manager" as const, conversationId: "conversation_seat", role: null }),
    callerProject: () => "proj-a",
    authorizedSeats: () => [{ conversationId: "conversation_seat", path: null, project: "proj-a" }],
    /* #845: the send resolves the conversation it names from ONE injected registry
       projection rather than reaching for the registry itself. */
    registrySnapshot: () => ({
      conversations: {
        conversation_http_control: {
          id: "conversation_http_control",
          generations: [{ path: "/repo/session.jsonl" }],
          continuityPaths: [],
        },
      },
      conversationAliases: {},
    }),
  } as never;
  const bindings = viewerMcpBindings(undefined, {
    post: async (pathname, body, headers) => {
      requests.push({ pathname, body, headers });
      if (pathname === "/api/spawn") return {
        conversationId: "conversation_http_control",
        path: "/repo/session.jsonl",
        launchId: "launch_http_control",
        state: "path-pending",
        initialMessage: "queued",
      };
      if (pathname === "/api/tmux") return {
        operationId: "operation_http_control",
        outcome: "queued",
      };
      return {
        deploymentId: "deployment_http_control",
        revision: "a".repeat(40),
        state: "accepted",
        replayed: false,
      };
    },
  }, designatedSeat);

  await bindings.spawn_agent({
    clientRequestId: "spawn-http-control",
    cwd: "/repo",
    ["prompt"]: "implement",
    title: "Implement durable identity",
    mcpServers: ["viewer", "agent-browser"],
  });
  expect(requests[0]?.body.title).toBe("Implement durable identity");
  const exactMessage = " \tcontinue\nПривіт 🌍\n ";
  await bindings.send_message({
    clientRequestId: "send-http-control",
    conversationId: "conversation_http_control",
    text: exactMessage,
  });
  await expect(bindings.send_message({
    clientRequestId: "send-empty-http-control",
    conversationId: "conversation_http_control",
    text: " \t\n ",
  })).rejects.toThrow("text is required");
  await bindings.deploy_exact_sha({
    clientRequestId: "deploy-http-control",
    revision: "a".repeat(40),
  });

  expect(requests.map((request) => request.pathname)).toEqual([
    "/api/spawn",
    "/api/tmux",
    "/api/runtime/deployments",
  ]);
  expect(requests[0]?.body.clientAttemptId).toBe("spawn-http-control");
  expect(requests[0]?.body.mcpServers).toEqual(["viewer", "agent-browser"]);
  expect(requests[1]?.body.clientMessageId).toBe("send-http-control");
  expect(requests[1]?.body.text).toBe(exactMessage);
  expect(requests[1]?.headers?.[VIEWER_SPAWN_CAPABILITY_HEADER]).toBe("c".repeat(43));
  expect(requests[2]?.body.idempotencyKey).toBe("deploy-http-control");
});

test("get_conversation presents current direct Codex tools and redacts recovered output content", async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-binding-conversation-"));
  sandboxes.push(sandbox);
  setAgentRegistryForTests(new AgentRegistry(
    path.join(sandbox, "agent-registry.json"),
    undefined,
    undefined,
    { sqliteMode: "off" },
  ));
  const transcriptPath = path.join(
    import.meta.dir,
    "..",
    "session",
    "fixtures",
    "codex-response-items-issue-626.jsonl",
  );
  const file = {
    path: transcriptPath,
    root: "codex-sessions",
    name: path.basename(transcriptPath),
    project: "live-log-viewer-next",
    title: "Issue 626 production-shaped replay",
    engine: "codex",
    kind: "session",
    fmt: "codex",
    parent: null,
    mtime: 1,
    size: fs.statSync(transcriptPath).size,
    activity: "live",
    proc: "running",
    pid: null,
    model: "gpt-5.6-sol",
    pendingQuestion: null,
    waitingInput: null,
    conversationId: "conversation_issue_626",
  } satisfies FileEntry;
  const bindings = viewerMcpBindings(undefined, undefined, {
    /* The completed generation does not carry this transcript, so the pinned scan is
       the fallback it exists for (#845). */
    completedFileScan: async () => ({ snapshot: { files: [], projectCatalog: [], complete: true } }),
    listFiles: async () => [file],
  } as never);

  const result = await bindings.get_conversation({
    clientRequestId: "get-conversation-issue-626",
    transcriptPath,
    maxRecords: 100,
  });

  expect(result).toMatchObject({
    conversationId: "conversation_issue_626",
    transcriptPath,
    messages: [
      { role: "assistant", phase: "commentary", text: "First commentary survives the tool transition." },
      { role: "assistant", phase: "commentary", text: "Second commentary follows the tool output." },
    ],
    tools: [
      { kind: "tool_call", name: "exec" },
      { kind: "tool_result", text: "Script completed\nTOOL_OUTPUT_626\nauthorization: [redacted]" },
      { kind: "tool_call", name: "update_plan" },
      { kind: "tool_result", text: "Plan updated" },
      { kind: "tool_call", name: "nested_probe" },
      { kind: "tool_result", text: "Nested output preserved" },
    ],
  });
  expect(JSON.stringify(result)).not.toContain("issue626_fixture_token");
});

test("conversation_messages resolves id, path, and selectedContext through one pinned normalized reader", async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-conversation-messages-"));
  sandboxes.push(sandbox);
  const transcriptPath = path.join(sandbox, "session.jsonl");
  fs.writeFileSync(transcriptPath, [
    { type: "response_item", timestamp: "2026-08-30T10:00:00.000Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "question" }] } },
    { type: "event_msg", timestamp: "2026-08-30T10:01:00.000Z", payload: { type: "agent_message", message: "answer" } },
  ].map((row) => JSON.stringify(row)).join("\n") + "\n");
  const selectedContext = {
    selectedConversation: () => ({
      resolve: (conversationId: string) => conversationId === "conversation_fixture"
        ? { conversationId, engine: "codex" as const, path: transcriptPath, project: "fixture" }
        : null,
      readTail: () => { throw new Error("conversation_messages must not use the raw tail reader"); },
    }),
    pathAllowed: (candidate: string) => candidate === transcriptPath,
  };
  const pinnedTranscript = (candidate: string) => {
    if (candidate !== transcriptPath) return undefined;
    const descriptor = fs.openSync(candidate, "r");
    return {
      descriptor,
      stat: fs.fstatSync(descriptor),
      rootName: "codex-sessions",
      root: sandbox,
      sameIdentity: () => true,
    };
  };
  const bindings = viewerMcpBindings(undefined, undefined, {
    selectedContext,
    pinnedTranscript,
  } as never);

  const byId = await bindings.conversation_messages({
    clientRequestId: "messages-by-id",
    conversationId: "conversation_fixture",
    roles: ["user", "assistant"],
  });
  expect(byId).toMatchObject({
    conversationId: "conversation_fixture",
    transcriptPath,
    engine: "codex",
    lastRecordAt: "2026-08-30T10:01:00.000Z",
    records: [{ role: "assistant", text: "answer" }, { role: "user", text: "question" }],
    hasMore: false,
    cursor: null,
  });

  const byPath = await bindings.conversation_messages({
    clientRequestId: "messages-by-path",
    transcriptPath,
  });
  expect(byPath).toMatchObject({ conversationId: null, transcriptPath, engine: "codex" });

  const bySelection = await bindings.conversation_messages({
    clientRequestId: "messages-by-selection",
    selectedContext: {
      version: 1,
      state: "selected",
      conversationId: "conversation_fixture",
      capturedAt: "2026-08-30T10:02:00.000Z",
    },
  });
  expect(bySelection).toMatchObject({
    conversationId: "conversation_fixture",
    selectedContext: { state: "selected", conversationId: "conversation_fixture", project: "fixture" },
  });
});

test("conversation_messages refuses unsupported roots and stale cursors with typed codes", async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-conversation-message-refusals-"));
  sandboxes.push(sandbox);
  const transcriptPath = path.join(sandbox, "session.jsonl");
  fs.writeFileSync(transcriptPath, [
    { type: "user", timestamp: "2026-08-30T10:00:00.000Z", message: { content: "older" } },
    { type: "assistant", timestamp: "2026-08-30T10:01:00.000Z", message: { content: [{ type: "text", text: "newer" }] } },
  ].map((row) => JSON.stringify(row)).join("\n") + "\n");
  let rootName = "claude-projects";
  const bindings = viewerMcpBindings(undefined, undefined, {
    pinnedTranscript: (candidate: string) => {
      if (candidate !== transcriptPath) return undefined;
      const descriptor = fs.openSync(candidate, "r");
      return { descriptor, stat: fs.fstatSync(descriptor), rootName, root: sandbox, sameIdentity: () => true };
    },
  } as never);

  const first = await bindings.conversation_messages({
    clientRequestId: "messages-first",
    transcriptPath,
    limit: 1,
  });
  expect(typeof first.cursor).toBe("string");
  const invalidSince = await bindings.conversation_messages({
    clientRequestId: "messages-invalid-since",
    transcriptPath,
    since: "yesterday",
  }).then(() => null, (error: unknown) => error as Error & { details?: { code?: string } });
  expect(invalidSince?.details?.code).toBe("conversation_messages_since_invalid");
  fs.writeFileSync(transcriptPath, "");
  const stale = await bindings.conversation_messages({
    clientRequestId: "messages-stale",
    transcriptPath,
    limit: 1,
    cursor: first.cursor,
  }).then(() => null, (error: unknown) => error as Error & { details?: { code?: string } });
  expect(stale?.details?.code).toBe("conversation_messages_cursor_stale");

  rootName = "openclaw-sessions";
  const unsupported = await bindings.conversation_messages({
    clientRequestId: "messages-openclaw",
    transcriptPath,
  }).then(() => null, (error: unknown) => error as Error & { details?: { code?: string } });
  expect(unsupported?.details?.code).toBe("conversation_messages_engine_unsupported");

  const outside = await bindings.conversation_messages({
    clientRequestId: "messages-outside",
    transcriptPath: path.join(sandbox, "outside.jsonl"),
  }).then(() => null, (error: unknown) => error as Error & { details?: { code?: string } });
  expect(outside?.details?.code).toBe("conversation_messages_transcript_unavailable");
});

test("link_task_to_pipeline binds the latest operational attempt after historical adoption", async () => {
  const operationalPath = "/pipeline/operational.jsonl";
  const operationalConversationId = "conversation_operational";
  const historicalPath = "/pipeline/historical-child.jsonl";
  const pipeline = {
    id: "pipeline-mcp-operational",
    srcPath: null,
    srcConversationId: null,
    runs: [{ stageId: "build", attempts: [
      {
        n: 1,
        state: "running",
        historical: false,
        agentPath: operationalPath,
        conversationId: operationalConversationId,
      },
      {
        n: 2,
        state: "passed",
        historical: true,
        agentPath: historicalPath,
        conversationId: "conversation_historical_child",
      },
    ] }],
  } as unknown as Pipeline;
  let tasks: BoardTask[] = [{
    id: "task-mcp-operational",
    project: "live-log-viewer-next",
    status: "inbox",
    text: "Link the operational pipeline member",
    placement: "unplaced",
    assignments: [],
    createdAt: "2026-07-20T10:30:00.000Z",
    updatedAt: "2026-07-20T10:30:00.000Z",
  }];
  const bindings = viewerMcpBindings({
    getPipelines: () => ({ pipelines: [pipeline] }),
    mutateTasks: (mutator) => {
      const mutation = mutator(tasks);
      if (mutation.tasks) tasks = mutation.tasks;
      return mutation.result;
    },
    isoNow: () => "2026-07-20T10:31:00.000Z",
  });

  const result = await bindings.link_task_to_pipeline({
    taskId: tasks[0]!.id,
    pipelineId: pipeline.id,
    clientRequestId: "mcp-link-operational-attempt",
  });

  expect(result).toMatchObject({
    conversationId: operationalConversationId,
    transcriptPath: operationalPath,
  });
  expect(tasks[0]!.assignments).toEqual([expect.objectContaining({
    conversationId: operationalConversationId,
    path: operationalPath,
    state: "handoff",
  })]);
});

test("link_task_to_pipeline follows the cursor retry after a fail-edge loop-back", async () => {
  const retryPath = "/pipeline/build-retry.jsonl";
  const retryConversationId = "conversation_build_retry";
  const stalePath = "/pipeline/stale-verify.jsonl";
  const pipeline = {
    id: "pipeline-mcp-loop-back",
    srcPath: null,
    srcConversationId: null,
    stages: [
      { id: "build", kind: "run" },
      { id: "verify", kind: "run" },
    ],
    runs: [
      { stageId: "build", attempts: [
        {
          n: 1,
          state: "passed",
          historical: false,
          agentPath: "/pipeline/build-first.jsonl",
          conversationId: "conversation_build_first",
          startedAt: "2026-07-20T11:10:00.000Z",
          completedAt: "2026-07-20T11:11:00.000Z",
        },
        {
          n: 2,
          state: "running",
          historical: false,
          agentPath: retryPath,
          conversationId: retryConversationId,
          startedAt: "2026-07-20T11:13:00.000Z",
          completedAt: null,
          activatedBy: { stageId: "verify", attempt: 1, edge: "fail" },
        },
      ] },
      { stageId: "verify", attempts: [{
        n: 1,
        state: "failed",
        historical: false,
        agentPath: stalePath,
        conversationId: "conversation_stale_verify",
        startedAt: "2026-07-20T11:11:00.000Z",
        completedAt: "2026-07-20T11:12:00.000Z",
      }] },
    ],
    cursor: {
      stageId: "build",
      state: "running",
      input: "Fix the failed verification",
      activatedBy: { stageId: "verify", attempt: 1, edge: "fail" },
    },
    state: "running",
  } as unknown as Pipeline;
  let tasks: BoardTask[] = [{
    id: "task-mcp-loop-back",
    project: "live-log-viewer-next",
    status: "inbox",
    text: "Link the active loop-back retry",
    placement: "unplaced",
    assignments: [],
    createdAt: "2026-07-20T11:14:00.000Z",
    updatedAt: "2026-07-20T11:14:00.000Z",
  }];
  const bindings = viewerMcpBindings({
    getPipelines: () => ({ pipelines: [pipeline] }),
    mutateTasks: (mutator) => {
      const mutation = mutator(tasks);
      if (mutation.tasks) tasks = mutation.tasks;
      return mutation.result;
    },
    isoNow: () => "2026-07-20T11:15:00.000Z",
  });

  const result = await bindings.link_task_to_pipeline({
    taskId: tasks[0]!.id,
    pipelineId: pipeline.id,
    clientRequestId: "mcp-link-loop-back-attempt",
  });

  expect(result).toMatchObject({
    conversationId: retryConversationId,
    transcriptPath: retryPath,
  });
  expect(tasks[0]!.assignments).toEqual([expect.objectContaining({
    conversationId: retryConversationId,
    path: retryPath,
    state: "handoff",
  })]);
  expect(tasks[0]!.assignments[0]!.path).not.toBe(stalePath);
});

test("board_snapshot returns an inert bounded board projection with durable lineage and redaction", async () => {
  let writes = 0;
  let rawScans = 0;
  const credentialLabel = ["api", "key"].join("_");
  const titleFixture = ["super", "secret"].join("-");
  const bindings = viewerMcpBindings(undefined, undefined, {
    listFiles: async () => {
      rawScans += 1;
      throw new Error("board_snapshot must not start a raw transcript scan");
    },
    completedFileScan: async () => ({
      snapshot: {
        files: [{
          path: "/sessions/worker.jsonl",
          project: "viewer",
          title: `Audit ${credentialLabel}=${titleFixture}`,
          engine: "codex",
          activity: "live",
          proc: "codex",
          conversationId: "conversation_worker",
        }],
        projectCatalog: [],
        complete: true,
      },
      generation: 7,
      targetGeneration: 8,
      cacheStatus: "stale",
      requestCount: 1,
      cloneDurationMs: 0,
    }),
    registrySnapshot: () => ({
      conversations: {
        conversation_worker: {
          id: "conversation_worker",
          delegationDepth: 1,
          generations: [{ path: "/sessions/worker.jsonl" }],
        },
      },
      conversationAliases: {},
      lineageEdges: {
        conversation_worker: {
          parentConversationId: "conversation_parent",
          kind: "spawn",
          source: "viewer-spawn",
          role: "builder",
        },
      },
      memberships: {
        conversation_worker: [{ kind: "pipeline", containerId: "pipeline_608", role: "builder" }],
      },
    }),
    boardFor: () => ({ schemaVersion: 1, revision: 7, updatedAt: "2026-07-23T00:00:00.000Z", prefs: { manual: [], hidden: ["/sessions/hidden-a.jsonl", "/sessions/hidden-b.jsonl"], expanded: [], favorites: [], viewMode: null, taskPanelOpen: false } }),
    noteWrite: () => { writes += 1; },
  } as never);

  const result = await bindings.board_snapshot({
    clientRequestId: "board-snapshot-redacted",
    project: "viewer",
    liveOnly: true,
    limit: 1,
  });

  expect(result).toMatchObject({
    count: 1,
    hiddenCount: 2,
    board: { revision: 7 },
    conversations: [{
      conversationId: "conversation_worker",
      title: "Audit api_key=[redacted]",
      lineage: {
        parentConversationId: "conversation_parent",
        role: "builder",
        depth: 1,
        memberships: [{ kind: "pipeline", containerId: "pipeline_608", role: "builder" }],
      },
    }],
  });
  expect(JSON.stringify(result)).not.toContain("super-secret");
  expect(writes).toBe(0);
  expect(rawScans).toBe(0);
});

test("flow tools read durable flows and return a stable action receipt", async () => {
  const flows = [
    { id: "flow_open", project: "viewer", state: "waiting_ready", closedAt: null },
    { id: "flow_closed", project: "viewer", state: "closed", closedAt: "2026-07-23T01:00:00.000Z" },
    { id: "flow_other", project: "other", state: "waiting_ready", closedAt: null },
  ];
  const actions: Array<{ id: string; action: string; actor: unknown }> = [];
  const bindings = viewerMcpBindings(undefined, undefined, {
    getFlowsWithPresets: () => ({ flows, presets: [] }),
    patchFlow: (id: string, request: { action: string }, actor: unknown) => {
      actions.push({ id, action: request.action, actor });
      return { flow: { ...flows[0], id, state: "paused" } };
    },
    cancelRound: async () => ({ flow: flows[0] }),
    closeFlow: async () => ({ flow: flows[0] }),
    callerAttribution: () => ({ kind: "agent", conversationId: "conversation_reviewer", role: "reviewer" }),
  } as never);

  expect(await bindings.list_flows({ clientRequestId: "list-flows", project: "viewer" })).toMatchObject({
    count: 1,
    flows: [{ id: "flow_open" }],
  });
  expect(await bindings.get_flow({ clientRequestId: "get-flow", flowId: "flow_open" })).toEqual({
    flowId: "flow_open",
    flow: flows[0],
  });
  const actionResult = await bindings.flow_action({ clientRequestId: "pause-flow", flowId: "flow_open", action: "pause" });
  const actionOperationId = actionResult.operationId as string;
  expect(actionResult).toMatchObject({
    flowId: "flow_open",
    receipt: { status: "delivered" },
    flow: { state: "paused" },
  });
  expect(actionOperationId).toMatch(/^mcp_flow_action_[0-9a-f]{24}$/);
  expect((actionResult.receipt as { operationId: string }).operationId).toBe(actionOperationId);
  expect(actions).toEqual([{
    id: "flow_open",
    action: "pause",
    actor: { kind: "agent", role: "reviewer", conversationId: "conversation_reviewer" },
  }]);
});

test("list_pipelines applies project, state, and closed filters to the durable registry", async () => {
  const bindings = viewerMcpBindings(undefined, undefined, {
    getPipelines: () => ({ pipelines: [
      { id: "pipeline_live", project: "viewer", state: "running" },
      { id: "pipeline_paused", project: "viewer", state: "paused" },
      { id: "pipeline_closed", project: "viewer", state: "closed" },
      { id: "pipeline_other", project: "other", state: "running" },
    ] }),
  } as never);

  const listed = await bindings.list_pipelines({
    clientRequestId: "list-pipelines",
    project: "viewer",
    state: "running",
  }) as { count: number; pipelines: { id: string; project: string; state: string }[] };
  expect(listed.count).toBe(1);
  expect(listed.pipelines.map((row) => ({ id: row.id, project: row.project, state: row.state })))
    .toEqual([{ id: "pipeline_live", project: "viewer", state: "running" }]);
});

/* #863: the list is a board-card projection, not the registry records. Detail —
   the spec body, stage prompts, and every attempt's relay input and transcript
   tail — belongs to get_pipeline, which still returns the whole record. */
test("list_pipelines returns bounded rows and leaves prompts, specs and transcripts to get_pipeline", async () => {
  const pipeline = {
    ...pipelineCorpus(1)[0],
    id: "pipeline_detail",
    project: "viewer",
    state: "running",
    stateDetail: "waiting on review",
  };
  const bindings = viewerMcpBindings(undefined, undefined, {
    getPipelines: () => ({ pipelines: [pipeline] }),
  } as never);

  const listed = await bindings.list_pipelines({ clientRequestId: "list-bounded", project: "viewer" });
  const serialized = JSON.stringify(listed.pipelines);
  for (const marker of Object.values(CORPUS_BODY_MARKERS)) expect(serialized).not.toContain(marker);
  expect(listed.pipelines).toMatchObject([{
    id: "pipeline_detail",
    project: "viewer",
    state: "running",
    stateDetail: "waiting on review",
    hasSpec: true,
    attemptCount: 12,
  }]);
  expect(Buffer.byteLength(serialized)).toBeLessThan(4 * 1024);
});

test("list_pipelines abandons the read when the caller's deadline has already passed", async () => {
  const bindings = viewerMcpBindings(undefined, undefined, {
    getPipelines: () => ({ pipelines: pipelineCorpus(1) }),
  } as never);

  await expect(bindings.list_pipelines(
    { clientRequestId: "list-expired" },
    { deadlineAt: Date.now() - 1 },
  )).rejects.toThrow(DeadlineExceededError);
});

test("task read tools expose the pipeline-linked durable read model", async () => {
  const tasks = [
    { id: "task_viewer", project: "viewer", status: "assigned", placement: "pinned", text: "Ship #608" },
    { id: "task_other", project: "other", status: "inbox", placement: "unplaced", text: "Other" },
  ];
  const bindings = viewerMcpBindings(undefined, undefined, {
    loadTasks: () => tasks,
    getPipelines: () => ({ pipelines: [{ id: "pipeline_608", taskIds: ["task_viewer"] }] }),
  } as never);

  expect(await bindings.list_tasks({ clientRequestId: "list-tasks", project: "viewer" })).toEqual({
    count: 1,
    tasks: [{ ...tasks[0], pipelineIds: ["pipeline_608"] }],
  });
  expect(await bindings.get_task({ clientRequestId: "get-task", taskId: "task_viewer" })).toEqual({
    taskId: "task_viewer",
    task: { ...tasks[0], pipelineIds: ["pipeline_608"] },
  });
});

test("operator_snapshot validates the v1 request and re-redacts the authoritative snapshot", async () => {
  const requests: unknown[] = [];
  const header = "Author" + "ization";
  const scheme = "Bear" + "er";
  const bearerFixture = ["super", "secret", "token"].join("-");
  const fieldFixture = ["bare", "secret"].join("-");
  const bindings = viewerMcpBindings(undefined, undefined, {
    collectSnapshot: async (request: unknown) => {
      requests.push(request);
      return { ok: true, schemaVersion: 1, [["access", "Token"].join("")]: fieldFixture, conversations: [{ text: { messages: [{ text: `${header}: ${scheme} ${bearerFixture}` }] } }] };
    },
  } as never);

  const result = await bindings.operator_snapshot({
    clientRequestId: "operator-snapshot",
    scope: { kind: "focused" },
    text: { include: true },
  });

  expect(requests).toEqual([{ schemaVersion: 1, scope: { kind: "focused", paths: undefined }, text: { include: true, lastMessages: undefined, maxCharsPerConversation: undefined }, view: undefined, caller: undefined }]);
  expect(JSON.stringify(result)).not.toContain("super-secret-token");
  expect(JSON.stringify(result)).not.toContain("bare-secret");
  expect(JSON.stringify(result)).toContain("[redacted]");
});

test("deployment_status uses Viewer HTTP while resources keeps its resource read module", async () => {
  const calls: string[] = [];
  const control = {
    get: async (pathname: string) => {
      calls.push(pathname);
      if (pathname.endsWith("deployment_608")) {
        return { deploymentId: "deployment_608", phase: "completed", revision: "a".repeat(40) };
      }
      if (pathname.endsWith("operation_608")) {
        return { operationId: "operation_608", receipt: { status: "delivered" } };
      }
      return { count: 1, deployments: [{ deploymentId: "deployment_recent", phase: "running", revision: "b".repeat(40) }] };
    },
    post: async () => {
      throw new Error("unexpected control write");
    },
  };
  const bindings = viewerMcpBindings(undefined, control, {
    readResources: async (fresh: boolean) => {
      calls.push(`resources:${fresh}`);
      return { system: { ramTotal: 10, ramAvailable: 5, swapTotal: 2, swapUsed: 1, capturedAt: "2026-07-23T00:00:00.000Z" }, sessions: [] };
    },
  } as never);

  expect(await bindings.deployment_status({ clientRequestId: "deployment-status", deploymentId: "deployment_608" })).toMatchObject({
    deploymentId: "deployment_608",
    deployment: { phase: "completed" },
  });
  expect(await bindings.deployment_status({ clientRequestId: "operation-status", operationId: "operation_608" })).toMatchObject({
    operationId: "operation_608",
    operation: { receipt: { status: "delivered" } },
  });
  expect(await bindings.deployment_status({ clientRequestId: "deployment-list" })).toEqual({
    count: 1,
    deployments: [{ deploymentId: "deployment_recent", phase: "running", revision: "b".repeat(40) }],
  });
  expect(await bindings.resources({ clientRequestId: "resources-read", fresh: true })).toMatchObject({ system: { ramAvailable: 5 }, sessions: [] });
  expect(calls).toEqual([
    "/api/runtime/deployments/deployment_608",
    "/api/runtime/operations/operation_608",
    "/api/runtime/deployments?limit=25",
    "resources:true",
  ]);
});

test("conversation_action delegates to the ownership-fenced conversation command with a stable receipt", async () => {
  const requests: unknown[] = [];
  const bindings = viewerMcpBindings(undefined, undefined, {
    applyConversationAction: async (request: { operationId: string }) => {
      requests.push(request);
      return {
        status: 202,
        body: {
          ok: true,
          structured: true,
          target: "conversation_608",
          operationId: request.operationId,
          receipt: { operationId: request.operationId, status: "queued" },
        },
      };
    },
  } as never);

  const result = await bindings.conversation_action({
    clientRequestId: "interrupt-608",
    conversationId: "conversation_608",
    action: "interrupt",
  });

  expect(requests).toEqual([{
    operationId: expect.stringMatching(/^mcp_conversation_action_[0-9a-f]{24}$/),
    conversationId: "conversation_608",
    transcriptPath: "",
    action: "interrupt",
    key: "",
    label: undefined,
    question: undefined,
  }]);
  const operationId = (requests[0] as { operationId: string }).operationId;
  expect(result).toMatchObject({
    conversationId: "conversation_608",
    operationId,
    receipt: { operationId, status: "queued" },
  });
});

test("conversation_action archives every generation from either target form and unarchives symmetrically", async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-archive-generations-"));
  sandboxes.push(sandbox);
  const boardFile = path.join(sandbox, "board.json");
  const project = "fixture-generation-project";
  const earlierPath = "/fixtures/codex/raw-sessions/2026/08/rollout-earlier.jsonl";
  const currentPath = "/fixtures/codex/accounts/account-a/sessions/2026/08/rollout-current.jsonl";
  const pendingPath = "/fixtures/codex/accounts/account-a/sessions/2026/08/rollout-pending.jsonl";
  const pendingSpawnPath = "spawn:launch_pending_generation";
  const emptyRegistrySnapshot = new AgentRegistry(path.join(sandbox, "agent-registry.json")).readOnlySnapshot();
  const registrySnapshot: typeof emptyRegistrySnapshot = {
    ...emptyRegistrySnapshot,
    conversations: {
      conversation_resumed: {
        id: "conversation_resumed",
        generations: [earlierPath, currentPath].map((pathname) => ({
          path: pathname,
          launchProfile: {
            cwd: "/fixtures/generation-project",
            project,
            model: null,
            effort: null,
          },
        })),
        continuityPaths: [],
        abandonedContinuityPaths: [],
        migration: null,
        projectOwnership: {
          project,
          source: "operator",
          setAt: "2026-08-24T08:00:00.000Z",
          operationId: "ownership_conversation_resumed",
        },
      } as never,
      conversation_pending: {
        id: "conversation_pending",
        generations: [{
          path: pendingPath,
          launchProfile: {
            cwd: "/fixtures/generation-project",
            project,
            model: null,
            effort: null,
          },
        }],
        continuityPaths: [],
        abandonedContinuityPaths: [],
        migration: null,
        projectOwnership: {
          project,
          source: "operator",
          setAt: "2026-08-24T08:01:00.000Z",
          operationId: "ownership_conversation_pending",
        },
      } as never,
    },
    receipts: {
      launch_pending_generation: {
        launchId: "launch_pending_generation",
        conversationId: "conversation_pending",
        createdAt: "2026-08-24T08:02:00.000Z",
        artifactLifecycle: "pending",
        transport: "structured",
        purpose: "launch",
        explicitProject: project,
        cwd: "/fixtures/generation-project",
        launchProfile: {
          cwd: "/fixtures/generation-project",
          project,
          model: null,
          effort: null,
        },
      } as never,
    },
  };
  const bindings = viewerMcpBindings(undefined, undefined, {
    registrySnapshot: () => registrySnapshot,
    completedFileScan: async () => {
      throw new Error("registered generation archiving must not scan transcripts");
    },
    boardFor: (key: string) => boardFor(key, boardFile),
    applyBoardCommand: (input: unknown, snapshot: typeof registrySnapshot) => applyBoardCommand(input, {
      registrySnapshot: () => snapshot,
      patchBoard: (key, revision, patch) => patchBoard(key, revision, patch, boardFile),
      mutateBoard: (key, revision, mutations) => mutateBoard(key, revision, mutations, boardFile),
    }),
  } as never);

  const byId = await bindings.conversation_action({
    clientRequestId: "archive-resumed-by-id",
    action: "archive",
    conversationId: "conversation_resumed",
  });
  expect(byId).toMatchObject({
    projectsTouched: [project],
    outcomes: [{
      conversationId: "conversation_resumed",
      transcriptPath: currentPath,
      paths: [earlierPath, currentPath],
      project,
      outcome: "archived",
    }],
  });
  expect(boardFor(project, boardFile)).toMatchObject({
    revision: 1,
    prefs: { hidden: [earlierPath, currentPath] },
  });

  const repeated = await bindings.conversation_action({
    clientRequestId: "archive-resumed-by-id-again",
    action: "archive",
    conversationId: "conversation_resumed",
  });
  expect(repeated).toMatchObject({
    projectsTouched: [],
    outcomes: [{ transcriptPath: currentPath, paths: [], outcome: "already-archived" }],
  });
  expect(boardFor(project, boardFile).revision).toBe(1);

  const restoredById = await bindings.conversation_action({
    clientRequestId: "unarchive-resumed-by-id",
    action: "unarchive",
    conversationId: "conversation_resumed",
  });
  expect(restoredById).toMatchObject({
    projectsTouched: [project],
    outcomes: [{ transcriptPath: currentPath, paths: [earlierPath, currentPath], outcome: "unarchived" }],
  });
  expect(boardFor(project, boardFile)).toMatchObject({ revision: 2, prefs: { hidden: [] } });
  fs.rmSync(boardFile);

  expect(mutateBoard(project, 0, [{
    kind: "remap-paths",
    pairs: [{ from: earlierPath, to: currentPath }],
  }], boardFile)).toMatchObject({ ok: true, applied: true });

  const byExactEarlierPath = await bindings.conversation_action({
    clientRequestId: "archive-resumed-by-earlier-path",
    action: "archive",
    transcriptPath: earlierPath,
  });
  expect(byExactEarlierPath).toMatchObject({
    outcomes: [{
      conversationId: "conversation_resumed",
      transcriptPath: earlierPath,
      paths: [earlierPath, currentPath],
      outcome: "archived",
    }],
  });
  expect(boardFor(project, boardFile)).toMatchObject({
    revision: 2,
    pathAliases: { [earlierPath]: currentPath },
    prefs: { hidden: [earlierPath, currentPath] },
  });

  expect(mutateBoard(project, 2, [{ kind: "set-presentation", taskPanelOpen: true }], boardFile)).toMatchObject({
    ok: true,
    applied: true,
    board: {
      pathAliases: { [earlierPath]: currentPath },
      prefs: { hidden: [earlierPath, currentPath], taskPanelOpen: true },
    },
  });

  const repeatedByExactEarlierPath = await bindings.conversation_action({
    clientRequestId: "archive-resumed-by-earlier-path-again",
    action: "archive",
    transcriptPath: earlierPath,
  });
  expect(repeatedByExactEarlierPath).toMatchObject({
    projectsTouched: [],
    outcomes: [{ transcriptPath: earlierPath, paths: [], outcome: "already-archived" }],
  });
  expect(boardFor(project, boardFile).revision).toBe(3);

  const restoredByExactEarlierPath = await bindings.conversation_action({
    clientRequestId: "unarchive-resumed-by-earlier-path",
    action: "unarchive",
    transcriptPath: earlierPath,
  });
  expect(restoredByExactEarlierPath).toMatchObject({
    outcomes: [{ transcriptPath: earlierPath, paths: [earlierPath, currentPath], outcome: "unarchived" }],
  });
  expect(boardFor(project, boardFile)).toMatchObject({
    revision: 4,
    prefs: { hidden: [], taskPanelOpen: true },
  });
  fs.rmSync(boardFile);

  expect(patchBoard(project, 0, { hidden: [currentPath] }, boardFile)).toMatchObject({ ok: true, applied: true });
  const repairedPartialArchive = await bindings.conversation_action({
    clientRequestId: "archive-resumed-partial-hidden",
    action: "archive",
    conversationId: "conversation_resumed",
  });
  expect(repairedPartialArchive).toMatchObject({
    projectsTouched: [project],
    outcomes: [{ transcriptPath: currentPath, paths: [earlierPath], outcome: "archived" }],
  });
  expect(boardFor(project, boardFile)).toMatchObject({
    revision: 2,
    prefs: { hidden: [currentPath, earlierPath] },
  });

  const pendingPlaceholder = await bindings.conversation_action({
    clientRequestId: "archive-pending-placeholder-by-id",
    action: "archive",
    conversationId: "conversation_pending",
  });
  expect(pendingPlaceholder).toMatchObject({
    outcomes: [{
      transcriptPath: pendingPath,
      paths: [pendingPath, pendingSpawnPath],
      outcome: "archived",
    }],
  });
  expect(boardFor(project, boardFile)).toMatchObject({
    revision: 3,
    prefs: { hidden: [currentPath, earlierPath, pendingPath, pendingSpawnPath] },
  });

  const restoredPendingPlaceholder = await bindings.conversation_action({
    clientRequestId: "unarchive-pending-placeholder-by-id",
    action: "unarchive",
    conversationId: "conversation_pending",
  });
  expect(restoredPendingPlaceholder).toMatchObject({
    outcomes: [{ paths: [pendingPath, pendingSpawnPath], outcome: "unarchived" }],
  });
  expect(boardFor(project, boardFile)).toMatchObject({
    revision: 4,
    prefs: { hidden: [currentPath, earlierPath] },
  });
});

test("conversation_action archives ghosts and reconciles interrupted receipts without another board revision", async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-archive-"));
  sandboxes.push(sandbox);
  const boardFile = path.join(sandbox, "board.json");
  const project = "fixture-owned-project";
  const predecessorPath = "/fixtures/fixture-project/predecessor.jsonl";
  const currentPath = "/fixtures/fixture-project/current.jsonl";
  const deletedGhostPath = "/fixtures/fixture-project/deleted-ghost.jsonl";
  const spawnPath = "spawn:launch_fixture_placeholder";
  const unknownPath = "/fixtures/fixture-project/unknown.jsonl";
  const interruptedReceiptStore = (expectedKey: string): { store: McpReceiptStore; completed: McpToolResult[] } => {
    const completed: McpToolResult[] = [];
    return {
      completed,
      store: {
        claim: (key) => {
          expect(key).toBe(expectedKey);
          return completed[0]
            ? { kind: "replay", result: completed[0] }
            : { kind: "pending", unfinishedAgeMs: 4_000 };
        },
        complete: (key, _digest, result) => {
          expect(key).toBe(expectedKey);
          completed.push(result);
        },
      },
    };
  };
  const launchProfile = {
    cwd: "/fixtures/fixture-project",
    project,
    model: null,
    effort: null,
  };
  const conversation = (id: string, paths: string[]) => ({
    id,
    generations: paths.map((pathname) => ({ path: pathname, launchProfile })),
    continuityPaths: [],
    abandonedContinuityPaths: [],
    migration: null,
    projectOwnership: {
      project,
      source: "operator",
      setAt: "2026-08-24T08:00:00.000Z",
      operationId: `ownership_${id}`,
    },
  });
  const emptyRegistrySnapshot = new AgentRegistry(path.join(sandbox, "agent-registry.json")).readOnlySnapshot();
  const registrySnapshot: typeof emptyRegistrySnapshot = {
    ...emptyRegistrySnapshot,
    conversations: {
      conversation_current: conversation("conversation_current", [predecessorPath, currentPath]) as never,
      conversation_deleted_ghost: conversation("conversation_deleted_ghost", [deletedGhostPath]) as never,
    },
    receipts: {
      launch_fixture_placeholder: {
        launchId: "launch_fixture_placeholder",
        conversationId: "conversation_spawn_placeholder",
        createdAt: "2026-08-24T08:05:00.000Z",
        explicitProject: project,
        cwd: "/fixtures/fixture-project",
        launchProfile,
      } as never,
    },
  };
  let runtimeCalls = 0;
  let scanCalls = 0;
  const bindings = viewerMcpBindings(undefined, undefined, {
    registrySnapshot: () => registrySnapshot,
    completedFileScan: async () => {
      scanCalls += 1;
      expect(boardFor(project, boardFile).prefs.hidden).toEqual(scanCalls <= 2
        ? [predecessorPath, currentPath, deletedGhostPath, spawnPath]
        : []);
      throw new Error("ghost archiving must not require a transcript scan");
    },
    boardFor: (key: string) => boardFor(key, boardFile),
    applyBoardCommand: (input: unknown, snapshot: typeof registrySnapshot) => applyBoardCommand(input, {
      registrySnapshot: () => snapshot,
      patchBoard: (key, revision, patch) => patchBoard(key, revision, patch, boardFile),
      mutateBoard: (key, revision, mutations) => mutateBoard(key, revision, mutations, boardFile),
    }),
    applyConversationAction: async () => {
      runtimeCalls += 1;
      throw new Error("archive must not enter runtime conversation control");
    },
  } as never);

  const archiveArgs = {
    clientRequestId: "archive-ghosts-first",
    action: "archive",
    targets: [
      { conversationId: "conversation_current" },
      { transcriptPath: deletedGhostPath },
      { transcriptPath: spawnPath },
      { transcriptPath: predecessorPath },
      { transcriptPath: unknownPath },
    ],
  };
  const first = await bindings.conversation_action(archiveArgs);

  expect(first).toMatchObject({
    action: "archive",
    project,
    projectsTouched: [project],
    outcomes: [
      { conversationId: "conversation_current", transcriptPath: currentPath, paths: [predecessorPath, currentPath], project, outcome: "archived" },
      { conversationId: "conversation_deleted_ghost", transcriptPath: deletedGhostPath, paths: [deletedGhostPath], project, outcome: "archived" },
      { conversationId: "conversation_spawn_placeholder", transcriptPath: spawnPath, paths: [spawnPath], project, outcome: "archived" },
      { conversationId: "conversation_current", transcriptPath: predecessorPath, paths: [], project, outcome: "already-archived" },
      { conversationId: null, transcriptPath: unknownPath, paths: [], project: null, outcome: "resolution-failed" },
    ],
  });
  expect(boardFor(project, boardFile)).toMatchObject({
    revision: 1,
    pathAliases: {},
    prefs: { hidden: [predecessorPath, currentPath, deletedGhostPath, spawnPath] },
  });

  const interruptedArchive = interruptedReceiptStore("conversation_action:archive-ghosts-first");
  const archiveRecovery = createMcpToolService(bindings, interruptedArchive.store);
  const recoveredArchive = await archiveRecovery.callTool("conversation_action", archiveArgs);
  expect(recoveredArchive).toMatchObject({
    ok: true,
    projectsTouched: [],
    outcomes: [
      { transcriptPath: currentPath, paths: [], outcome: "already-archived" },
      { transcriptPath: deletedGhostPath, paths: [], outcome: "already-archived" },
      { transcriptPath: spawnPath, paths: [], outcome: "already-archived" },
      { transcriptPath: predecessorPath, paths: [], outcome: "already-archived" },
      { transcriptPath: unknownPath, paths: [], outcome: "resolution-failed" },
    ],
  });
  expect(boardFor(project, boardFile)).toMatchObject({
    revision: 1,
    prefs: { hidden: [predecessorPath, currentPath, deletedGhostPath, spawnPath] },
  });
  expect(interruptedArchive.completed).toEqual([recoveredArchive]);
  expect(await archiveRecovery.callTool("conversation_action", archiveArgs)).toEqual({
    ...recoveredArchive,
    replayed: true,
  });
  expect(boardFor(project, boardFile).revision).toBe(1);

  const replayByContent = await bindings.conversation_action({
    clientRequestId: "archive-ghosts-again",
    action: "archive",
    targets: [
      { transcriptPath: predecessorPath },
      { transcriptPath: deletedGhostPath },
      { transcriptPath: spawnPath },
    ],
  });
  expect(replayByContent).toMatchObject({
    outcomes: [
      { paths: [], outcome: "already-archived" },
      { paths: [], outcome: "already-archived" },
      { paths: [], outcome: "already-archived" },
    ],
  });
  expect(boardFor(project, boardFile).revision).toBe(1);

  const unarchiveArgs = {
    clientRequestId: "unarchive-ghosts",
    action: "unarchive",
    targets: [
      { conversationId: "conversation_current" },
      { transcriptPath: deletedGhostPath },
      { transcriptPath: spawnPath },
      { transcriptPath: unknownPath },
    ],
  };
  const restored = await bindings.conversation_action(unarchiveArgs);
  expect(restored).toMatchObject({
    outcomes: [
      { conversationId: "conversation_current", transcriptPath: currentPath, paths: [predecessorPath, currentPath], outcome: "unarchived" },
      { paths: [deletedGhostPath], outcome: "unarchived" },
      { paths: [spawnPath], outcome: "unarchived" },
      { paths: [], project: null, outcome: "resolution-failed" },
    ],
  });
  expect(boardFor(project, boardFile)).toMatchObject({ revision: 2, prefs: { hidden: [] } });

  const interruptedUnarchive = interruptedReceiptStore("conversation_action:unarchive-ghosts");
  const unarchiveRecovery = createMcpToolService(bindings, interruptedUnarchive.store);
  const recoveredUnarchive = await unarchiveRecovery.callTool("conversation_action", unarchiveArgs);
  expect(recoveredUnarchive).toMatchObject({
    ok: true,
    projectsTouched: [],
    outcomes: [
      { transcriptPath: currentPath, paths: [], outcome: "not-found" },
      { transcriptPath: deletedGhostPath, paths: [], outcome: "not-found" },
      { transcriptPath: spawnPath, paths: [], outcome: "not-found" },
      { transcriptPath: unknownPath, paths: [], outcome: "resolution-failed" },
    ],
  });
  expect(boardFor(project, boardFile)).toMatchObject({ revision: 2, prefs: { hidden: [] } });
  expect(interruptedUnarchive.completed).toEqual([recoveredUnarchive]);
  expect(runtimeCalls).toBe(0);
  expect(scanCalls).toBe(4);
});

test("conversation_action attributes archive outcomes only to paths written by its board command", async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-archive-race-"));
  sandboxes.push(sandbox);
  const boardFile = path.join(sandbox, "board.json");
  const project = "fixture-concurrent-project";
  const transcriptPath = "/fixtures/concurrent-project/session.jsonl";
  const emptyRegistrySnapshot = new AgentRegistry(path.join(sandbox, "agent-registry.json")).readOnlySnapshot();
  const registrySnapshot: typeof emptyRegistrySnapshot = {
    ...emptyRegistrySnapshot,
    conversations: {
      conversation_concurrent: {
        id: "conversation_concurrent",
        generations: [{
          path: transcriptPath,
          launchProfile: { cwd: "/fixtures/concurrent-project", project, model: null, effort: null },
        }],
        continuityPaths: [],
        abandonedContinuityPaths: [],
        migration: null,
        projectOwnership: {
          project,
          source: "operator",
          setAt: "2026-08-24T08:00:00.000Z",
          operationId: "ownership_conversation_concurrent",
        },
      } as never,
    },
  };
  let commandCalls = 0;
  const bindings = viewerMcpBindings(undefined, undefined, {
    registrySnapshot: () => registrySnapshot,
    boardFor: (key: string) => boardFor(key, boardFile),
    applyBoardCommand: (input: unknown, snapshot: typeof registrySnapshot) => {
      commandCalls += 1;
      if (commandCalls === 1) {
        expect(patchBoard(project, 0, { hidden: [transcriptPath] }, boardFile)).toMatchObject({ ok: true, applied: true });
      } else {
        expect(mutateBoard(project, 1, [{ kind: "restore", path: transcriptPath, placement: "auto" }], boardFile))
          .toMatchObject({ ok: true, applied: true });
      }
      return applyBoardCommand(input, {
        registrySnapshot: () => snapshot,
        patchBoard: (key, revision, patch) => patchBoard(key, revision, patch, boardFile),
        mutateBoard: (key, revision, mutations) => mutateBoard(key, revision, mutations, boardFile),
      });
    },
  } as never);

  const archived = await bindings.conversation_action({
    clientRequestId: "archive-concurrent-content",
    action: "archive",
    conversationId: "conversation_concurrent",
  });
  expect(archived).toMatchObject({
    projectsTouched: [],
    outcomes: [{ transcriptPath, paths: [], project, outcome: "already-archived" }],
  });
  expect(boardFor(project, boardFile)).toMatchObject({ revision: 1, prefs: { hidden: [transcriptPath] } });

  const unarchived = await bindings.conversation_action({
    clientRequestId: "unarchive-concurrent-content",
    action: "unarchive",
    conversationId: "conversation_concurrent",
  });
  expect(unarchived).toMatchObject({
    projectsTouched: [],
    outcomes: [{ transcriptPath, paths: [], project, outcome: "not-found" }],
  });
  expect(boardFor(project, boardFile)).toMatchObject({ revision: 2, prefs: { hidden: [] } });
  expect(commandCalls).toBe(2);
});

test("conversation_action chunks archive expansions at the board path-list limit", async () => {
  const fixture = bulkArchiveFixture(86, 6);

  const archived = await fixture.bindings.conversation_action({
    clientRequestId: "archive-bulk-path-limit",
    action: "archive",
    targets: fixture.targets,
  });

  expect(archived).toMatchObject({
    projectsTouched: [fixture.project],
    outcomes: fixture.pathsByTarget.map((paths, index) => ({
      conversationId: fixture.targets[index]!.conversationId,
      transcriptPath: paths.at(-1),
      paths,
      project: fixture.project,
      outcome: "archived",
    })),
  });
  expect(boardFor(fixture.project, fixture.boardFile)).toMatchObject({
    revision: 2,
    prefs: { hidden: fixture.allPaths },
  });

  const repeated = await fixture.bindings.conversation_action({
    clientRequestId: "archive-bulk-path-limit-again",
    action: "archive",
    targets: fixture.targets,
  });
  expect(repeated).toMatchObject({
    projectsTouched: [],
    outcomes: fixture.targets.map(() => ({ paths: [], outcome: "already-archived" })),
  });
  expect(boardFor(fixture.project, fixture.boardFile).revision).toBe(2);
});

test("conversation_action chunks symmetric unarchive at the board mutation limit", async () => {
  const fixture = bulkArchiveFixture(65, 2);
  await fixture.bindings.conversation_action({
    clientRequestId: "archive-bulk-mutation-limit",
    action: "archive",
    targets: fixture.targets,
  });

  const unarchived = await fixture.bindings.conversation_action({
    clientRequestId: "unarchive-bulk-mutation-limit",
    action: "unarchive",
    targets: fixture.targets,
  });

  expect(unarchived).toMatchObject({
    projectsTouched: [fixture.project],
    outcomes: fixture.pathsByTarget.map((paths, index) => ({
      conversationId: fixture.targets[index]!.conversationId,
      transcriptPath: paths.at(-1),
      paths,
      project: fixture.project,
      outcome: "unarchived",
    })),
  });
  expect(boardFor(fixture.project, fixture.boardFile)).toMatchObject({
    revision: 3,
    prefs: { hidden: [] },
  });

  const repeated = await fixture.bindings.conversation_action({
    clientRequestId: "unarchive-bulk-mutation-limit-again",
    action: "unarchive",
    targets: fixture.targets,
  });
  expect(repeated).toMatchObject({
    projectsTouched: [],
    outcomes: fixture.targets.map(() => ({ paths: [], outcome: "not-found" })),
  });
  expect(boardFor(fixture.project, fixture.boardFile).revision).toBe(3);
});

test("conversation_action aggregates only successful chunks across a revision conflict", async () => {
  const fixture = bulkArchiveFixture(86, 6, (input, call, boardFile, project) => {
    if (call !== 2) return;
    const patch = (input as { patch: { hidden: string[] } }).patch;
    expect(patch.hidden).toEqual(fixture.allPaths.slice(512));
    expect(patchBoard(project, 1, { hidden: patch.hidden }, boardFile)).toMatchObject({
      ok: true,
      applied: true,
    });
  });

  const archived = await fixture.bindings.conversation_action({
    clientRequestId: "archive-bulk-conflict",
    action: "archive",
    targets: fixture.targets,
  });

  expect(archived).toMatchObject({
    projectsTouched: [fixture.project],
    outcomes: [
      ...fixture.pathsByTarget.slice(0, -1).map((paths) => ({ paths, outcome: "archived" })),
      { paths: fixture.pathsByTarget.at(-1)!.slice(0, 2), outcome: "archived" },
    ],
  });
  expect(boardFor(fixture.project, fixture.boardFile)).toMatchObject({
    revision: 2,
    prefs: { hidden: fixture.allPaths },
  });
});

test("conversation_action refuses archive batches above 100 before reading board or runtime state", async () => {
  let reads = 0;
  const bindings = viewerMcpBindings(undefined, undefined, {
    registrySnapshot: () => { reads += 1; return {} as never; },
    boardFor: () => { reads += 1; return {} as never; },
    applyConversationAction: async () => { reads += 1; return {} as never; },
  } as never);
  const targets = Array.from({ length: 101 }, (_, index) => ({ transcriptPath: `/fixtures/project/session-${index}.jsonl` }));

  await expect(bindings.conversation_action({
    clientRequestId: "archive-too-many",
    action: "archive",
    targets,
  })).rejects.toThrow("targets supports at most 100 conversations per call");
  expect(reads).toBe(0);
});

test("conversation_migration delegates to the revision-fenced migration command with a stable receipt", async () => {
  const requests: unknown[] = [];
  const bindings = viewerMcpBindings(undefined, undefined, {
    applyConversationMigration: async (request: { conversationId: string; expectedRevision?: number }) => {
      requests.push(request);
      return {
        status: 200,
        body: { conversation: { id: request.conversationId, migration: { phase: "rolled-back", revision: request.expectedRevision } } },
      };
    },
  } as never);

  const result = await bindings.conversation_migration({
    clientRequestId: "rollback-608",
    conversationId: "conversation_608",
    action: "rollback",
    expectedRevision: 4,
  });
  const migrationOperationId = result.operationId as string;

  expect(requests).toEqual([{
    conversationId: "conversation_608",
    action: "rollback",
    expectedRevision: 4,
    path: "",
  }]);
  expect(result).toMatchObject({
    conversationId: "conversation_608",
    receipt: { status: "delivered" },
    conversation: { migration: { phase: "rolled-back", revision: 4 } },
  });
  expect(migrationOperationId).toMatch(/^mcp_conversation_migration_[0-9a-f]{24}$/);
  expect((result.receipt as { operationId: string }).operationId).toBe(migrationOperationId);
});

test("a refused pipeline close exposes its host report through MCP, not only prose (#670)", async () => {
  const close = {
    stopped: [{ stageId: "plan", attempt: 1, conversationId: "conversation_plan", agentPath: null, paneId: null }],
    alreadyStopped: [],
    unconfirmed: [],
    acknowledged: [],
    reviewers: [],
    stillRunning: [{ stageId: "build", attempt: 2, conversationId: "conversation_build", agentPath: null, paneId: "%7", error: "structured runtime host is unavailable" }],
    worktree: { dir: "/repo-pipeline-1", uncommitted: ["notes.md"], truncated: false },
  };
  let pauseActor: unknown;
  const bindings = viewerMcpBindings(undefined, undefined, {
    patchPipeline: async (_id: string, request: { action?: string }, _ports: unknown, actor: unknown) => {
      if (request.action === "pause") pauseActor = actor;
      return request.action === "close"
        ? { error: "could not stop stage build attempt 2 (conversation_build): structured runtime host is unavailable", status: 409, close }
        : { pipeline: { id: "pipeline_1", state: "paused" } };
    },
    callerAttribution: () => ({ kind: "manager", conversationId: "conversation_orchestrator", role: "orchestrator" }),
  } as never);
  const results = new Map<string, McpToolResult>();
  const service = createMcpToolService(bindings, {
    claim: async (key: string) => (results.has(key) ? { kind: "replay" as const, result: results.get(key)! } : { kind: "fresh" as const }),
    complete: async (key: string, _digest: string, result: McpToolResult) => { results.set(key, result); },
  } as never);

  const refused = await service.callTool("pipeline_action", {
    clientRequestId: "close-refused",
    pipelineId: "pipeline_1",
    action: "close",
  });

  expect(refused.ok).toBeFalse();
  /* An agent driving the board gets the structured evidence an HTTP caller
     gets — which host survived and where to find it — not just the prose. */
  expect(refused).toMatchObject({
    code: "tool_failed",
    error: "could not stop stage build attempt 2 (conversation_build): structured runtime host is unavailable",
    details: { close: { stillRunning: [{ stageId: "build", attempt: 2, conversationId: "conversation_build", paneId: "%7" }] } },
  });

  const paused = await service.callTool("pipeline_action", {
    clientRequestId: "pause-ok",
    pipelineId: "pipeline_1",
    action: "pause",
  });
  expect(paused).toMatchObject({ ok: true, pipelineId: "pipeline_1" });
  expect((paused as { details?: unknown }).details).toBeUndefined();
  expect(pauseActor).toEqual({ kind: "agent", role: "orchestrator", conversationId: "conversation_orchestrator" });
});

test("agent_activity reports the liveness snapshot and journals the stalls it finds (#645)", async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-activity-"));
  sandboxes.push(sandbox);
  process.env.LLV_STATE_DIR = sandbox;
  const journaled: unknown[] = [];
  const bindings = viewerMcpBindings(undefined, undefined, {
    livenessSources: () => ({
      now: () => Date.parse("2026-07-26T08:40:00.000Z"),
      probe: { now: () => Date.parse("2026-07-26T08:40:00.000Z"), pidAlive: () => false, processIdentity: () => null },
      listFiles: async () => [{
        path: "/transcripts/session.jsonl",
        project: "viewer",
        title: "stage agent",
        engine: "codex",
        activity: "stalled",
        activityReason: "jsonl_turn_stalled",
        mtime: Date.parse("2026-07-26T02:27:33.000Z") / 1000,
        conversationId: "conversation_zombie",
      }],
      registrySnapshot: () => ({ entries: {}, conversations: {} }),
      pipelines: () => [],
      describeTranscript: async () => null,
      transcriptEvidence: async () => ({ turn: "busy", lastRecordTs: Date.parse("2026-07-26T02:27:33.000Z") }),
    }),
    refreshLifecycleJournal: (input: unknown) => {
      journaled.push(input);
      return { appended: 1, skipped: 0, throttled: false };
    },
  } as never);

  const result = await bindings.agent_activity({ clientRequestId: "activity-645", liveOnly: true });

  expect(result).toMatchObject({ count: 1, stalledCount: 1, journaled: 1 });
  expect((result.conversations as Array<Record<string, unknown>>)[0]).toMatchObject({
    conversationId: "conversation_zombie",
    lifecycle: "stalled",
    turnState: "busy",
    lastRecordAt: "2026-07-26T02:27:33.000Z",
  });
  expect(journaled).toHaveLength(1);
});

test("agent_activity exposes a provider throttle retryAt without journaling a stall", async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-provider-throttle-"));
  sandboxes.push(sandbox);
  process.env.LLV_STATE_DIR = sandbox;
  const now = Date.parse("2026-08-23T09:00:00.000Z");
  const retryAt = "2026-08-23T09:12:00.000Z";
  const transcriptPath = "/transcripts/provider-throttled.jsonl";
  const accountId = "account-a";
  const journaled: unknown[] = [];
  const bindings = viewerMcpBindings(undefined, undefined, {
    livenessSources: () => ({
      now: () => now,
      probe: { now: () => now, pidAlive: () => true, processIdentity: () => "host-start" },
      listFiles: async () => [{
        path: transcriptPath,
        project: "viewer",
        title: "stage agent",
        engine: "codex",
        activity: "stalled",
        activityReason: "jsonl_turn_stalled",
        mtime: Date.parse("2026-08-23T08:20:00.000Z") / 1000,
        conversationId: "conversation_provider_throttled",
      }],
      registrySnapshot: () => ({
        entries: {
          "codex:provider-throttled": {
            key: { engine: "codex", accountId, sessionId: "provider-throttled" },
            artifactPath: transcriptPath,
            cwd: "/repo",
            accountId,
            status: "live",
            host: null,
            structuredHost: {
              kind: "codex-app-server",
              endpoint: "unix:/tmp/host.sock",
              process: { pid: 42, startIdentity: "host-start" },
              eventCursor: 0,
              protocolVersion: null,
              writerClaimEpoch: 1,
              activeTurnRef: null,
              pendingAttention: [],
              activeFlags: [],
            },
            claimEpoch: 1,
            claimOwner: null,
            pendingAction: null,
            updatedAt: "2026-08-23T08:00:00.000Z",
          },
        },
        conversations: {},
      }),
      pipelines: () => [],
      describeTranscript: async () => null,
      transcriptEvidence: async () => ({ turn: "busy", lastRecordTs: Date.parse("2026-08-23T08:20:00.000Z") }),
      limitsProvenance: (engine: "claude" | "codex", requestedAccountId: string) => {
        expect([engine, requestedAccountId]).toEqual(["codex", accountId]);
        return { source: "cache", reason: "oauth-rate-limited", staleSince: null, retryAt };
      },
    }),
    refreshLifecycleJournal: (input: unknown) => {
      journaled.push(input);
      return { appended: 0, skipped: 0, throttled: false };
    },
  } as never);

  const result = await bindings.agent_activity({ clientRequestId: "activity-provider-throttle", liveOnly: true });

  expect(result).toMatchObject({ count: 1, stalledCount: 0, journaled: 0 });
  expect((result.conversations as Array<Record<string, unknown>>)[0]).toMatchObject({
    lifecycle: "waiting",
    reason: "provider_throttled",
    retryAt,
  });
  expect(journaled).toHaveLength(1);
});

/**
 * #860 — the two bounds the project-scoped liveness read was missing at this
 * binding: the catalog it reads and the caller's lifetime.
 */
function activityRow(overrides: Partial<FileEntry> & { path: string }): FileEntry {
  return {
    root: "claude-projects" as FileEntry["root"],
    name: path.basename(overrides.path),
    project: "viewer",
    title: "stage agent",
    engine: "codex",
    kind: "session",
    fmt: "claude" as FileEntry["fmt"],
    parent: null,
    mtime: Date.parse("2026-08-22T08:55:00.000Z") / 1000,
    size: 4096,
    activity: "idle",
    activityReason: "mtime_old",
    proc: null,
    pid: null,
    ...overrides,
  } as FileEntry;
}

test("project-scoped agent_activity selects from the binding's cached catalog and forces no fresh sweep (#860)", async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-activity-catalog-"));
  sandboxes.push(sandbox);
  process.env.LLV_STATE_DIR = sandbox;
  const now = Date.parse("2026-08-22T09:00:00.000Z");
  const catalogReads: Array<{ signal?: AbortSignal | null }> = [];
  let freshSweeps = 0;
  let handedCatalog: CompletedGenerationRead | null = null;
  const files = [
    activityRow({ path: "/corpus/viewer/live.jsonl", activity: "stalled", activityReason: "jsonl_turn_stalled", conversationId: "conversation_selected" }),
    activityRow({ path: "/corpus/viewer/idle.jsonl" }),
    activityRow({ path: "/corpus/other/live.jsonl", project: "other", activity: "stalled", activityReason: "jsonl_turn_stalled" }),
  ];
  /* The completed generation the board path reads. A fresh whole-corpus sweep
     would have to come through one of the two counters below. */
  const cachedCatalogRead: CompletedGenerationRead = async (options) => {
    catalogReads.push(options ?? {});
    return {
      snapshot: { files, projectCatalog: [], complete: true },
      generation: 11,
      targetGeneration: 11,
      cacheStatus: "hit" as const,
      requestCount: 1,
      cloneDurationMs: 0,
    };
  };
  const bindings = viewerMcpBindings(undefined, undefined, {
    completedFileScan: cachedCatalogRead,
    listFiles: async () => { freshSweeps += 1; return files; },
    /* Production's own selection wiring over whatever catalog read the binding
       hands in, with only the environment-touching seams stubbed. The fallback
       keeps a regression here off the real scanner instead of sweeping the
       machine the test runs on. */
    livenessSources: (catalog?: { completedFileScan?: CompletedGenerationRead }) => ({
      ...productionLivenessSources({ completedFileScan: (handedCatalog = catalog?.completedFileScan ?? null) ?? cachedCatalogRead }),
      now: () => now,
      probe: { now: () => now, pidAlive: () => false, processIdentity: () => null },
      registrySnapshot: () => ({ entries: {}, conversations: {} }),
      pipelines: () => [],
      describeTranscript: async () => null,
      transcriptEvidence: async () => ({ turn: "busy", lastRecordTs: Date.parse("2026-08-22T08:40:00.000Z") }),
      listFiles: async () => { freshSweeps += 1; return files; },
    }),
    refreshLifecycleJournal: () => ({ appended: 0, skipped: 0, throttled: false }),
  } as never);

  const result = await bindings.agent_activity({
    clientRequestId: "activity-860-catalog",
    project: "viewer",
    liveOnly: true,
    limit: 10,
  });

  expect(result).toMatchObject({ count: 1 });
  expect(result.selection).toMatchObject({
    scope: "project",
    freshScan: false,
    generation: 11,
    cacheStatus: "hit",
    scanned: 3,
    matched: 1,
    selected: 1,
  });
  expect((result.conversations as Array<Record<string, unknown>>)[0]).toMatchObject({
    conversationId: "conversation_selected",
    project: "viewer",
  });
  expect(freshSweeps).toBe(0);
  expect(catalogReads).toHaveLength(1);
  /* The catalog the read consumed is the binding's own, so `agent_activity` and
     `board_snapshot` share one generation. */
  expect(handedCatalog as CompletedGenerationRead | null).toBe(cachedCatalogRead);
});

test("agent_activity stops the liveness read at the call deadline instead of hanging the caller (#860)", async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-activity-deadline-"));
  sandboxes.push(sandbox);
  process.env.LLV_STATE_DIR = sandbox;
  let observed: AbortSignal | null = null;
  let journalWrites = 0;
  let entered: () => void = () => {};
  const reached = new Promise<void>((resolve) => { entered = resolve; });
  const bindings = viewerMcpBindings(undefined, undefined, {
    livenessSources: () => ({
      now: () => Date.now(),
      probe: { now: () => Date.now(), pidAlive: () => false, processIdentity: () => null },
      registrySnapshot: () => ({ entries: {}, conversations: {} }),
      pipelines: () => [],
      describeTranscript: async () => null,
      transcriptEvidence: async () => null,
      /* A cold generation that never publishes — the 70-second shape the issue
         reported. Only the caller's signal can end this call. */
      selectInventory: (_request: unknown, options?: { signal?: AbortSignal | null }) => new Promise<never>((_resolve, reject) => {
        observed = options?.signal ?? null;
        options?.signal?.addEventListener(
          "abort",
          () => { reject(new DOMException("catalog selection cancelled", "AbortError")); },
          { once: true },
        );
        entered();
      }),
    }),
    refreshLifecycleJournal: () => { journalWrites += 1; return { appended: 0, skipped: 0, throttled: false }; },
  } as never);

  const pending = bindings.agent_activity(
    { clientRequestId: "activity-860-deadline", project: "viewer", liveOnly: true, limit: 10 },
    { deadlineAt: Date.now() + 25 },
  );
  await reached;

  /* Self-bounded: a regression that ignores the deadline fails this assertion
     instead of hanging the suite on a call that never returns. */
  const guard = new Promise<never>((_resolve, reject) => {
    setTimeout(() => { reject(new Error("agent_activity did not stop at the call deadline")); }, 2_000);
  });
  await expect(Promise.race([pending, guard])).rejects.toThrow("catalog selection cancelled");
  expect(observed).not.toBeNull();
  expect((observed as unknown as AbortSignal).aborted).toBe(true);
  expect((observed as unknown as AbortSignal).reason).toBeInstanceOf(DeadlineExceededError);
  /* Nothing was journaled: the call that no caller is waiting for records no
     lifecycle evidence either. */
  expect(journalWrites).toBe(0);
}, 10_000);

test("lifecycle_events projects the runtime deployment ledger into the journal (#686)", async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-deploy-events-"));
  sandboxes.push(sandbox);
  process.env.LLV_STATE_DIR = sandbox;
  /* Real projector, real journal — only the Viewer HTTP read is stubbed,
     because a deploy event has no other durable source. */
  const deployments = [
    {
      deploymentId: "deployment_ready",
      phase: "admitted",
      revision: "b".repeat(40),
      updatedAt: "2026-07-26T10:00:00.000Z",
      error: null,
    },
    {
      deploymentId: "deployment_done",
      phase: "succeeded",
      revision: "c".repeat(40),
      updatedAt: "2026-07-26T10:05:00.000Z",
      error: null,
    },
    {
      deploymentId: "deployment_bad",
      phase: "failed",
      revision: "d".repeat(40),
      updatedAt: "2026-07-26T10:09:00.000Z",
      error: "the health gate never went green",
    },
  ];
  const bindings = viewerMcpBindings(undefined, {
    get: async () => ({ count: deployments.length, deployments }),
    post: async () => {
      throw new Error("unexpected control write");
    },
  }, {
    registrySnapshot: () => ({ heldDeliveries: {} }),
    getPipelines: () => ({ pipelines: [] }),
    refreshLifecycleJournal,
    queryLifecycleEvents,
  } as never);

  const result = await bindings.lifecycle_events({ clientRequestId: "deploy-events-686", type: "deploy_succeeded" });

  expect(result).toMatchObject({ mode: "query", journaled: 3 });
  expect((result.events as Array<Record<string, unknown>>).map((event) => event.type)).toEqual(["deploy_succeeded"]);
  const journal = JSON.parse(fs.readFileSync(path.join(sandbox, "lifecycle-journal.json"), "utf8")) as {
    events: Array<{ type: string; state: string; summary: string }>;
  };
  expect(journal.events.map((event) => event.type)).toEqual(["deploy_ready", "deploy_succeeded", "deploy_failed"]);
  expect(journal.events.map((event) => event.state)).toEqual(["waiting", "completed", "failed"]);
  expect(journal.events[2]!.summary).toBe("the health gate never went green");
});

test("lifecycle_events queries the journal by lineage and polls the bounded digest (#686)", async () => {
  const queries: unknown[] = [];
  const digests: unknown[] = [];
  const bindings = viewerMcpBindings(undefined, {
    get: async () => ({ count: 0, deployments: [] }),
    post: async () => {
      throw new Error("unexpected control write");
    },
  }, {
    registrySnapshot: () => ({ heldDeliveries: {} }),
    getPipelines: () => ({ pipelines: [] }),
    refreshLifecycleJournal: () => ({ appended: 2, skipped: 5, throttled: false }),
    queryLifecycleEvents: (query: unknown) => {
      queries.push(query);
      return { count: 1, events: [{ seq: 7, type: "review_verdict", summary: "pass" }], cursor: 7, remaining: 0 };
    },
    pollLifecycleDigest: (request: unknown) => {
      digests.push(request);
      return { subscriberId: "conversation_operator", relay: { reason: "terminal", items: [], through: 7, omitted: 0 }, cursor: 7, pending: 0, heldUntil: null };
    },
  } as never);

  const queried = await bindings.lifecycle_events({
    clientRequestId: "journal-686",
    pipelineId: "pipeline_a",
    afterSeq: 3,
  });
  expect(queried).toMatchObject({ mode: "query", count: 1, cursor: 7, journaled: 2 });
  expect(queries).toEqual([{
    project: undefined,
    pipelineId: "pipeline_a",
    conversationId: undefined,
    stageId: undefined,
    type: undefined,
    afterSeq: 3,
    limit: undefined,
  }]);

  const polled = await bindings.lifecycle_events({
    clientRequestId: "digest-686",
    mode: "digest",
    subscriberId: "conversation_operator",
  });
  expect(polled).toMatchObject({ mode: "digest", cursor: 7, relay: { reason: "terminal" } });
  expect(digests).toEqual([{
    subscriberId: "conversation_operator",
    project: undefined,
    pipelineId: undefined,
    conversationId: undefined,
    maxItems: undefined,
    acknowledge: true,
  }]);

  await expect(bindings.lifecycle_events({ clientRequestId: "digest-no-subscriber", mode: "digest" }))
    .rejects.toThrow("subscriberId is required for mode=digest");
  await expect(bindings.lifecycle_events({ clientRequestId: "bad-type", type: "not_a_type" }))
    .rejects.toThrow("unknown lifecycle event type: not_a_type");
});

/* #1026 — an agent driving the board must not get less than an HTTP caller: a
   rejected create carries every violated constraint, with its field and the
   shape that field expects, as structured refusal details. */
test("create_pipeline refuses with every violated constraint attached", async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-binding-pipeline-"));
  sandboxes.push(sandbox);
  process.env.LLV_STATE_DIR = sandbox;
  const bindings = viewerMcpBindings();

  const refusal = await bindings.create_pipeline({
    clientRequestId: "create-pipeline-invalid",
    task: "Batched contract",
    repoDir: path.join(sandbox, "repo"),
    src: path.join(sandbox, "creator.jsonl"),
    stages: [{ id: "build", kind: "implement", prompt: "build" }],
  }, { signal: undefined, deadlineAt: Date.now() + 30_000 } as never).then(
    () => null,
    (error: unknown) => error as Error & { details?: { violations?: Array<{ field: string; expected: string }> } },
  );

  expect(refusal?.name).toBe("McpToolRefusal");
  expect(refusal?.details?.violations?.map((violation) => violation.field)).toEqual(["src", "stages[0].kind"]);
  for (const violation of refusal?.details?.violations ?? []) expect(violation.expected.length).toBeGreaterThan(0);
  expect(refusal?.message).toContain("stages[0].kind: stage kind must be run or review-loop");
});

test("create_pipeline batches every invalid stage model with each engine catalog", async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-binding-pipeline-models-"));
  sandboxes.push(sandbox);
  process.env.LLV_STATE_DIR = sandbox;
  const bindings = viewerMcpBindings();

  const refusal = await bindings.create_pipeline({
    clientRequestId: "create-pipeline-invalid-models",
    task: "Validate model catalog",
    repoDir: path.join(sandbox, "repo"),
    src: path.join(sandbox, "creator.jsonl"),
    stages: [
      { id: "build", kind: "run", engine: "codex", model: "gpt-5.6-codex", prompt: "build", next: "review" },
      { id: "review", kind: "review-loop", engine: "claude", model: "claude-fable-5", prompt: "review", next: null },
    ],
  }, { signal: undefined, deadlineAt: Date.now() + 30_000 } as never).then(
    () => null,
    (error: unknown) => error as Error & { details?: { violations?: Array<{ field: string; message: string }> } },
  );

  expect(refusal?.name).toBe("McpToolRefusal");
  expect(refusal?.details?.violations?.map((violation) => violation.field)).toEqual([
    "src",
    "stages[0].model",
    "stages[1].model",
  ]);
  expect(refusal?.message).toContain("valid codex model ids: gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna");
  expect(refusal?.message).toContain("valid claude model ids: opus, fable, sonnet, haiku");
});

/* ------------------------------------------------------------------------- *
 * seat_tick_settings (#1275): the seat's control over the loop the Viewer arms
 * for it. Every case here is about what the tool ALLOWS — the one refusal is
 * the missing reason, because a quiet tick with no reason cannot be told from
 * a broken one.
 * ------------------------------------------------------------------------- */

const TICK_SEAT = ["conversation", "0f4c21b7729fbc9e"].join("_");

function tickSettingsBindings(options: {
  callerProject?: string | null;
  kind?: "manager" | "agent" | "gateway" | "unidentified";
  store?: Map<string, unknown>;
} = {}) {
  const store = options.store ?? new Map<string, unknown>();
  const bindings = viewerMcpBindings(undefined, undefined, {
    callerAttribution: () => ({ kind: options.kind ?? "manager", conversationId: TICK_SEAT, role: "orchestrator" }),
    authorizedSeats: () => (options.callerProject === null
      ? []
      : [{ conversationId: TICK_SEAT, path: null, project: options.callerProject ?? "viewer" }]),
    callerProject: () => options.callerProject ?? "viewer",
    readTickSettings: (project: string) => (store.get(project) as never) ?? {
      project, enabled: true, wakeIntervalMinutes: null, reason: null, monitorPrompt: null, until: null, updatedAt: null, setBy: null,
    },
    writeTickSettings: (project: string, settings: unknown) => { store.set(project, settings); },
  } as never);
  return { bindings, store };
}

test("seat_tick_settings reads its own project's defaults without changing anything", async () => {
  const { bindings, store } = tickSettingsBindings();
  const read = await bindings.seat_tick_settings({ clientRequestId: "tick-read" });
  expect(read).toMatchObject({
    project: "viewer",
    changed: false,
    scope: "own-project",
    effective: { enabled: true, wakeIntervalMinutes: 60, isDefault: true },
  });
  expect(store.size).toBe(0);
});

test("seat_tick_settings turns its own project's tick off indefinitely, with the reason on the record", async () => {
  const { bindings, store } = tickSettingsBindings();
  const applied = await bindings.seat_tick_settings({
    clientRequestId: "tick-off",
    enabled: false,
    reason: "the only open lane is a draft nothing can discharge",
  });
  expect(applied).toMatchObject({
    changed: true,
    scope: "own-project",
    effective: { enabled: false, isDefault: false, until: null, reason: "the only open lane is a draft nothing can discharge" },
  });
  expect(store.get("viewer")).toMatchObject({
    enabled: false,
    until: null,
    setBy: { kind: "manager", conversationId: TICK_SEAT, project: "viewer" },
  });

  /* And it is read back the same way by the next call, which is what the tick
     itself does at its next check. */
  const read = await bindings.seat_tick_settings({ clientRequestId: "tick-read-back" });
  expect(read).toMatchObject({ changed: false, effective: { enabled: false } });
});

test("seat_tick_settings sets a cadence and restores the default", async () => {
  const { bindings, store } = tickSettingsBindings();
  await bindings.seat_tick_settings({
    clientRequestId: "tick-slower",
    wakeIntervalMinutes: 240,
    reason: "batching this board into four-hour rounds",
  });
  expect(store.get("viewer")).toMatchObject({ enabled: true, wakeIntervalMinutes: 240 });
  const restored = await bindings.seat_tick_settings({ clientRequestId: "tick-default", wakeIntervalMinutes: null });
  expect(restored).toMatchObject({ effective: { wakeIntervalMinutes: 60, isDefault: true } });
});

test("seat_tick_settings accepts an expiry in minutes and records the instant it lapses", async () => {
  const { bindings, store } = tickSettingsBindings();
  const before = Date.now();
  await bindings.seat_tick_settings({
    clientRequestId: "tick-until",
    enabled: false,
    untilMinutes: 90,
    reason: "quiet while the release runs",
  });
  const until = Date.parse((store.get("viewer") as { until: string }).until);
  expect(until).toBeGreaterThanOrEqual(before + 89 * 60_000);
  expect(until).toBeLessThanOrEqual(Date.now() + 91 * 60_000);
});

test("seat_tick_settings lets one seat set another project's tick, and says whose decision it was", async () => {
  const { bindings, store } = tickSettingsBindings({ callerProject: "viewer" });
  const applied = await bindings.seat_tick_settings({
    clientRequestId: "tick-other-project",
    project: "another-project",
    enabled: false,
    reason: "its seat asked me to quiet it while the migration runs",
  });
  /* Allowed rather than refused; what answers for it is attribution. */
  expect(applied).toMatchObject({ project: "another-project", changed: true, scope: "other-project", callerProject: "viewer" });
  expect(store.get("another-project")).toMatchObject({
    enabled: false,
    setBy: { conversationId: TICK_SEAT, project: "viewer" },
  });
  expect(store.has("viewer")).toBe(false);
});

test("seat_tick_settings refuses only the change that would leave no reason behind", async () => {
  const { bindings, store } = tickSettingsBindings();
  await expect(bindings.seat_tick_settings({ clientRequestId: "tick-no-reason", enabled: false }))
    .rejects.toThrow("a reason is required");
  expect(store.size).toBe(0);
  await expect(bindings.seat_tick_settings({ clientRequestId: "tick-empty" })).resolves.toMatchObject({ changed: false });
});

test("seat_tick_settings sets, replaces and clears the monitor prompt, and the record read back is what says so (#1280)", async () => {
  const { bindings, store } = tickSettingsBindings();
  const set = await bindings.seat_tick_settings({
    clientRequestId: "tick-prompt-set",
    monitorPrompt: "before the items, check whether last night's digest actually sent",
  });
  expect(set).toMatchObject({
    changed: true,
    /* The stored note in full and its length ride the reply (#1450), so a seat
       can check what persisted against what it sent. */
    monitorPrompt: "before the items, check whether last night's digest actually sent",
    monitorPromptLength: "before the items, check whether last night's digest actually sent".length,
    effective: { monitorPrompt: "before the items, check whether last night's digest actually sent" },
  });

  /* Read back through a second call, which is what the tick itself does at its
     next check — the echo of the write proves nothing about the record. */
  const readBack = await bindings.seat_tick_settings({ clientRequestId: "tick-prompt-read" });
  expect(readBack).toMatchObject({
    changed: false,
    effective: { monitorPrompt: "before the items, check whether last night's digest actually sent" },
  });

  await bindings.seat_tick_settings({ clientRequestId: "tick-prompt-replace", monitorPrompt: "the digest is fixed; watch the review rounds instead" });
  expect(await bindings.seat_tick_settings({ clientRequestId: "tick-prompt-read-2" }))
    .toMatchObject({ changed: false, effective: { monitorPrompt: "the digest is fixed; watch the review rounds instead" } });

  await bindings.seat_tick_settings({ clientRequestId: "tick-prompt-clear", monitorPrompt: null });
  expect(store.get("viewer")).toMatchObject({ monitorPrompt: null });
  expect(await bindings.seat_tick_settings({ clientRequestId: "tick-prompt-read-len" }))
    .toMatchObject({ monitorPrompt: null, monitorPromptLength: 0 });

  /* Over the limit the write is refused out loud, with nothing stored (#1450). */
  const longNote = "n".repeat(SEAT_TICK_PROMPT_LIMIT + 1);
  await expect(bindings.seat_tick_settings({ clientRequestId: "tick-prompt-long", monitorPrompt: longNote }))
    .rejects.toThrow(`monitorPrompt is ${SEAT_TICK_PROMPT_LIMIT + 1} characters; the limit is ${SEAT_TICK_PROMPT_LIMIT}`);
  expect(store.get("viewer")).toMatchObject({ monitorPrompt: null });
  expect(await bindings.seat_tick_settings({ clientRequestId: "tick-prompt-read-3" }))
    .toMatchObject({ changed: false, effective: { monitorPrompt: null } });
});

test("a monitor prompt needs no reason and leaves the tick on its default (#1280)", async () => {
  const { bindings, store } = tickSettingsBindings();
  /* The reason answers for a tick that has gone quiet. A prompt quiets
     nothing — it changes what a wake says, never whether or when one is sent —
     so there is nothing here for a reason to explain. */
  const applied = await bindings.seat_tick_settings({
    clientRequestId: "tick-prompt-no-reason",
    monitorPrompt: "start from the oldest blocked card",
  });
  expect(applied).toMatchObject({
    changed: true,
    effective: { enabled: true, wakeIntervalMinutes: 60, isDefault: true, reason: null, monitorPrompt: "start from the oldest blocked card" },
  });
  expect(store.get("viewer")).toMatchObject({ enabled: true, wakeIntervalMinutes: null, reason: null, until: null });
});

test("seat_tick_settings is callable by a session that holds no seat at all", async () => {
  const { bindings, store } = tickSettingsBindings({ kind: "agent", callerProject: "viewer" });
  const applied = await bindings.seat_tick_settings({
    clientRequestId: "tick-worker",
    enabled: false,
    reason: "my lane is the only thing open here and it is blocked on the operator",
  });
  expect(applied).toMatchObject({ changed: true });
  expect(store.get("viewer")).toMatchObject({ setBy: { kind: "agent", conversationId: TICK_SEAT } });
});

test("send_message reports acceptance as unsettled, and message_receipt answers what became of it", async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-send-receipt-"));
  sandboxes.push(sandbox);
  const registry = new AgentRegistry(
    path.join(sandbox, "agent-registry.json"),
    undefined,
    undefined,
    { sqliteMode: "off" },
  );
  setAgentRegistryForTests(registry);
  const transcriptPath = path.join(sandbox, "recipient.jsonl");
  registry.reconcileConversations([{
    engine: "codex",
    path: transcriptPath,
    accountId: "receipt-fixture-account",
    launchProfile: emptyLaunchProfile({ cwd: sandbox }),
    turn: { state: "idle", source: "assistant", terminalAt: null },
    observedAt: "2026-08-30T10:00:00.000Z",
  }]);
  const conversation = Object.values(registry.snapshot().conversations)[0]!;
  const generationId = conversation.generations.at(-1)!.id;
  const operationId = "op_receipt_fixture";

  const bindings = viewerMcpBindings(undefined, {
    post: async () => ({ outcome: "queued", operationId, receipt: { operationId, status: "queued" } }),
  });
  const accepted = await bindings.send_message({
    clientRequestId: "receipt-fixture-send",
    conversationId: conversation.id,
    text: "hold the cutover",
  });
  /* #1131: the answer says acceptance, and says that acceptance is not the end
     of the story. A caller that read `queued` as terminal is what cost forty
     idle minutes. */
  expect(accepted).toMatchObject({ operationId, outcome: "queued", settled: false });

  const reservation = registry.holdDelivery(
    conversation.id,
    "hold the cutover",
    "receipt-fixture-send",
    "text",
    [],
    null,
    { operationId, kind: "send", policy: "queue" },
  );
  registry.beginDeliveryAttempt(reservation.id, generationId);
  expect(await bindings.message_receipt({ clientRequestId: "receipt-read-1", operationId }))
    .toMatchObject({ operationId, state: "in-flight", resend: null, evidence: "delivery-record" });

  registry.recordDeliveryOutcome(reservation.id, "failed", SEND_LOST_REASON);
  expect(await bindings.message_receipt({ clientRequestId: "receipt-read-2", operationId })).toMatchObject({
    operationId,
    conversationId: conversation.id,
    state: "failed",
    reason: SEND_LOST_REASON,
    duplicateRisk: false,
    resend: "safe",
  });
});

test("message_receipt refuses an operation id nothing ever admitted", async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-send-receipt-unknown-"));
  sandboxes.push(sandbox);
  setAgentRegistryForTests(new AgentRegistry(
    path.join(sandbox, "agent-registry.json"),
    undefined,
    undefined,
    { sqliteMode: "off" },
  ));
  const refusal = await viewerMcpBindings()
    .message_receipt({ clientRequestId: "receipt-unknown", operationId: "op_never_admitted" })
    .then(() => null, (error: unknown) => error as Error & { details?: { code?: string } });
  expect(refusal?.name).toBe("McpToolRefusal");
  expect(refusal?.details?.code).toBe("OPERATION_UNKNOWN");
});

test("an ambiguous send's operation id and resend guidance survive the control refusal", async () => {
  /* #1131: the Viewer answers an ambiguous send with the id it accepted the
     send under and what is safe to do next. The control client used to keep the
     prose and drop the rest, so the caller of a send that may already be in the
     recipient's pane was left with a sentence, no id to ask `message_receipt`
     about, and no warning against sending it again. */
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-binding-ambiguous-"));
  sandboxes.push(sandbox);
  process.env.LLV_STATE_DIR = sandbox;
  const operationId = ["operation", "ambiguous", "legacy", "send"].join("_");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    ok: false,
    outcome: "failed",
    error: "delivery was started and never settled",
    actuation: "started",
    operationId,
    resend: "verify-first",
  }), { status: 409, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

  try {
    const sendMessage = viewerMcpBindings().send_message;
    const refusal = await sendMessage({
      clientRequestId: "mcp-ambiguous-send",
      conversationId: "conversation_ambiguous",
      text: "hold the cutover until I say go",
    }).then(() => null, (error: unknown) => error);

    expect(refusal).toBeInstanceOf(Error);
    expect((refusal as Error).message).toContain("delivery was started and never settled");
    expect((refusal as { details?: Record<string, unknown> }).details).toEqual({
      operationId,
      resend: "verify-first",
      actuation: "started",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
