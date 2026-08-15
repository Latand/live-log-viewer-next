import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AgentRegistry, setAgentRegistryForTests } from "@/lib/agent/registry";
import { VIEWER_SPAWN_CAPABILITY_ENV, VIEWER_SPAWN_CAPABILITY_HEADER } from "@/lib/agent/spawnPolicy";
import { DeadlineExceededError } from "@/lib/deadline";
import { CORPUS_BODY_MARKERS, pipelineCorpus } from "@/lib/pipelines/fixtures/corpus";
import type { Pipeline } from "@/lib/pipelines/types";
import { listRoles } from "@/lib/roles/registry";
import type { RoleDefinition } from "@/lib/roles/types";
import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";

import { queryLifecycleEvents } from "@/lib/lifecycle/journal";
import { refreshLifecycleJournal } from "@/lib/lifecycle/projector";

import { defaultMcpSpawnRoleParams, viewerMcpBindings } from "./bindings";
import { createMcpToolService, MemoryMcpReceiptStore, type McpToolResult } from "./server";

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
    mcpServers: ["viewer", "agent-browser"],
  });
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
    boardFor: () => ({ schemaVersion: 1, revision: 7, updatedAt: "2026-07-23T00:00:00.000Z", prefs: { manual: [], hidden: [], expanded: [], favorites: [], viewMode: null, taskPanelOpen: false } }),
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
  const actions: Array<{ id: string; action: string }> = [];
  const bindings = viewerMcpBindings(undefined, undefined, {
    getFlowsWithPresets: () => ({ flows, presets: [] }),
    patchFlow: (id: string, request: { action: string }) => {
      actions.push({ id, action: request.action });
      return { flow: { ...flows[0], id, state: "paused" } };
    },
    cancelRound: async () => ({ flow: flows[0] }),
    closeFlow: async () => ({ flow: flows[0] }),
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
  expect(actions).toEqual([{ id: "flow_open", action: "pause" }]);
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
  const bindings = viewerMcpBindings(undefined, undefined, {
    patchPipeline: async (_id: string, request: { action?: string }) => (request.action === "close"
      ? { error: "could not stop stage build attempt 2 (conversation_build): structured runtime host is unavailable", status: 409, close }
      : { pipeline: { id: "pipeline_1", state: "paused" } }),
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
