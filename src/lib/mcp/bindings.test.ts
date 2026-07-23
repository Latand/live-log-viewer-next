import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AgentRegistry, setAgentRegistryForTests } from "@/lib/agent/registry";
import type { Pipeline } from "@/lib/pipelines/types";
import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";

import { viewerMcpBindings } from "./bindings";

const sandboxes: string[] = [];
const originalStateDir = process.env.LLV_STATE_DIR;

afterEach(() => {
  setAgentRegistryForTests(null);
  if (originalStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = originalStateDir;
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
  expect(fs.readFileSync(path.join(sandbox, "operator-spawn-capability"), "utf8").trim()).toMatch(/^[A-Za-z0-9_-]{43}$/);
});

test("runtime-bound MCP tools use the live Viewer control surface", async () => {
  const requests: Array<{ pathname: string; body: Record<string, unknown> }> = [];
  const bindings = viewerMcpBindings(undefined, {
    post: async (pathname, body) => {
      requests.push({ pathname, body });
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
  });

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
    confirm: "deploy",
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
  const credentialLabel = ["api", "key"].join("_");
  const titleFixture = ["super", "secret"].join("-");
  const bindings = viewerMcpBindings(undefined, undefined, {
    listFiles: async () => [{
      path: "/sessions/worker.jsonl",
      project: "viewer",
      title: `Audit ${credentialLabel}=${titleFixture}`,
      engine: "codex",
      activity: "live",
      proc: "codex",
      conversationId: "conversation_worker",
    }],
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

  expect(await bindings.list_pipelines({
    clientRequestId: "list-pipelines",
    project: "viewer",
    state: "running",
  })).toEqual({
    count: 1,
    pipelines: [{ id: "pipeline_live", project: "viewer", state: "running" }],
  });
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

test("deployment_status and resources use the runtime and resource read modules directly", async () => {
  const calls: string[] = [];
  const runtimeClient = {
    readViewerDeployment: async (id: string) => {
      calls.push(`deployment:${id}`);
      return { deploymentId: id, state: "completed", revision: "a".repeat(40) };
    },
    operationStatus: async (id: string) => {
      calls.push(`operation:${id}`);
      return { operationId: id, receipt: { status: "delivered" } };
    },
    snapshot: async () => ({ deployments: [{ deploymentId: "deployment_recent", state: "running" }] }),
  };
  const bindings = viewerMcpBindings(undefined, undefined, {
    runtimeEventsEnabled: () => true,
    runtimeHostClient: () => runtimeClient,
    readResources: async (fresh: boolean) => {
      calls.push(`resources:${fresh}`);
      return { system: { ramTotal: 10, ramAvailable: 5, swapTotal: 2, swapUsed: 1, capturedAt: "2026-07-23T00:00:00.000Z" }, sessions: [] };
    },
  } as never);

  expect(await bindings.deployment_status({ clientRequestId: "deployment-status", deploymentId: "deployment_608" })).toMatchObject({
    deploymentId: "deployment_608",
    deployment: { state: "completed" },
  });
  expect(await bindings.deployment_status({ clientRequestId: "operation-status", operationId: "operation_608" })).toMatchObject({
    operationId: "operation_608",
    operation: { receipt: { status: "delivered" } },
  });
  expect(await bindings.deployment_status({ clientRequestId: "deployment-list" })).toEqual({
    count: 1,
    deployments: [{ deploymentId: "deployment_recent", state: "running" }],
  });
  expect(await bindings.resources({ clientRequestId: "resources-read", fresh: true })).toMatchObject({ system: { ramAvailable: 5 }, sessions: [] });
  expect(calls).toEqual(["deployment:deployment_608", "operation:operation_608", "resources:true"]);
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
