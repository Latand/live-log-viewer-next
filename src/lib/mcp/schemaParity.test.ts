import { expect, test } from "bun:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { FOCUS_TARGET_SHAPES } from "@/lib/attention/targets";
import { listRoles, resolveRole } from "@/lib/roles/registry";
import { ROLE_IDS } from "@/lib/roles/types";
import {
  MAX_SCOPE_PATHS,
  MAX_SNAPSHOT_CHARS_PER_CONVERSATION,
  MAX_SNAPSHOT_LAST_MESSAGES,
  MAX_SNAPSHOT_STRING_LENGTH,
} from "@/lib/view/types";
import { validateSnapshotRequest } from "@/lib/view/validation";

import {
  MCP_BOUNDED_NUMERIC_ARGS,
  MCP_TOOL_NAMES,
  TOOL_INPUT_SCHEMAS,
  MemoryMcpReceiptStore,
  createMcpToolService,
  createViewerMcpServer,
  type McpToolBindings,
  type McpToolName,
} from "./server";

function inertBindings(overrides: Partial<McpToolBindings> = {}): McpToolBindings {
  return {
    ...Object.fromEntries(MCP_TOOL_NAMES.map((toolName) => [toolName, async () => ({})])),
    ...overrides,
  } as McpToolBindings;
}

async function withProtocolClient<T>(
  bindings: McpToolBindings,
  run: (client: Client) => Promise<T>,
): Promise<T> {
  const server = createViewerMcpServer(createMcpToolService(bindings, new MemoryMcpReceiptStore()));
  const client = new Client({ name: "schema-parity-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return await run(client);
  } finally {
    await client.close();
    await server.close();
  }
}

function requiredRoleParams(role: ReturnType<typeof listRoles>[number]): Record<string, string | number> {
  return Object.fromEntries(role.parameters.map((parameter) => {
    if (parameter.default !== undefined) return [parameter.key, parameter.default];
    if (parameter.kind === "integer") return [parameter.key, parameter.min ?? 1];
    if (parameter.kind === "select") return [parameter.key, parameter.options?.[0] ?? "value"];
    return [parameter.key, "value"];
  }));
}

function setAtPath(target: Record<string, unknown>, path: readonly string[], value: unknown): void {
  let parent = target;
  for (const part of path.slice(0, -1)) {
    const existing = parent[part];
    if (existing && typeof existing === "object" && !Array.isArray(existing)) {
      parent = existing as Record<string, unknown>;
    } else {
      const child: Record<string, unknown> = {};
      parent[part] = child;
      parent = child;
    }
  }
  parent[path.at(-1)!] = value;
}

function boundedArgs(
  toolName: McpToolName,
  spec: NonNullable<(typeof MCP_BOUNDED_NUMERIC_ARGS)[McpToolName]>[number],
  clientRequestId: string,
): Record<string, unknown> {
  const args: Record<string, unknown> = { clientRequestId };
  if (toolName === "spawn_agent") {
    Object.assign(args, {
      title: "Review MCP schema parity",
      cwd: ".",
      ["prompt"]: "Review PR #1.",
      role: spec.role,
      roleParams: {},
    });
  }
  if (toolName === "search_transcripts") args.query = "fixture";
  return args;
}

function valueAtPath(target: Record<string, unknown>, path: readonly string[]): unknown {
  let value: unknown = target;
  for (const part of path) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

test("agent_activity preserves additive provider throttle fields through the MCP protocol", async () => {
  const retryAt = "2026-08-23T09:12:00.000Z";
  await withProtocolClient(inertBindings({
    agent_activity: async () => ({
      count: 1,
      stalledCount: 0,
      conversations: [{
        conversationId: "conversation_provider_throttled",
        lifecycle: "waiting",
        reason: "provider_throttled",
        retryAt,
        host: { state: "alive", kind: "structured" },
      }],
    }),
  }), async (client) => {
    const result = await client.callTool({
      name: "agent_activity",
      arguments: { clientRequestId: "activity-provider-throttle-parity", liveOnly: true },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: true,
      toolName: "agent_activity",
      count: 1,
      stalledCount: 0,
      conversations: [{
        conversationId: "conversation_provider_throttled",
        lifecycle: "waiting",
        reason: "provider_throttled",
        retryAt,
        host: { state: "alive", kind: "structured" },
      }],
    });
  });
});

test("every harmless bounded MCP numeric clamps, coerces, and defaults before its binding", async () => {
  const calls = new Map<McpToolName, Record<string, unknown>[]>();
  const bindings = inertBindings(Object.fromEntries(
    Object.keys(MCP_BOUNDED_NUMERIC_ARGS).map((toolName) => [toolName, async (args: Record<string, unknown>) => {
      const typedTool = toolName as McpToolName;
      const bucket = calls.get(typedTool) ?? [];
      bucket.push(args);
      calls.set(typedTool, bucket);
      return { applied: args };
    }]),
  ) as Partial<McpToolBindings>);

  await withProtocolClient(bindings, async (client) => {
    for (const [toolName, specs] of Object.entries(MCP_BOUNDED_NUMERIC_ARGS) as Array<[
      McpToolName,
      NonNullable<(typeof MCP_BOUNDED_NUMERIC_ARGS)[McpToolName]>,
    ]>) {
      for (const [index, spec] of specs.entries()) {
        const highIsSafe = spec.max < Number.MAX_SAFE_INTEGER;
        const outside = highIsSafe ? spec.max + 1 : spec.min - 1;
        const boundary = highIsSafe ? spec.max : spec.min;
        const clampArgs = boundedArgs(toolName, spec, `${toolName}-${index}-clamp`);
        setAtPath(clampArgs, spec.path, outside);
        const clamped = await client.callTool({ name: toolName, arguments: clampArgs });
        expect(clamped.isError).not.toBe(true);
        expect(clamped.structuredContent).toMatchObject({
          ok: true,
          clamped: { [spec.path.join(".")]: boundary },
        });
        expect(valueAtPath((clamped.structuredContent as { applied: Record<string, unknown> }).applied, spec.path)).toBe(boundary);

        const coercionValue = Math.max(spec.min, Math.min(spec.max, spec.fallback));
        const coercionArgs = boundedArgs(toolName, spec, `${toolName}-${index}-coerce`);
        setAtPath(coercionArgs, spec.path, String(coercionValue));
        const coerced = await client.callTool({ name: toolName, arguments: coercionArgs });
        expect(coerced.isError).not.toBe(true);
        expect(coerced.structuredContent).toMatchObject({
          ok: true,
          clamped: { [spec.path.join(".")]: coercionValue },
        });
        expect(valueAtPath((coerced.structuredContent as { applied: Record<string, unknown> }).applied, spec.path)).toBe(coercionValue);

        const fallbackArgs = boundedArgs(toolName, spec, `${toolName}-${index}-fallback`);
        setAtPath(fallbackArgs, spec.path, { ambiguous: true });
        const defaulted = await client.callTool({ name: toolName, arguments: fallbackArgs });
        expect(defaulted.isError).not.toBe(true);
        expect(defaulted.structuredContent).toMatchObject({
          ok: true,
          clamped: { [spec.path.join(".")]: spec.fallback },
        });
        expect(valueAtPath((defaulted.structuredContent as { applied: Record<string, unknown> }).applied, spec.path)).toBe(spec.fallback);
      }
    }
  });

  expect([...calls.keys()].sort()).toEqual((Object.keys(MCP_BOUNDED_NUMERIC_ARGS) as McpToolName[]).sort());
});

test("extreme bounded integers clamp toward the nearest bound", async () => {
  const bindings = inertBindings({
    get_conversation: async (args) => ({ applied: args }),
    list_conversations: async (args) => ({ applied: args }),
    spawn_agent: async (args) => ({ applied: args }),
    lifecycle_events: async (args) => ({ applied: args }),
  });
  const cases: Array<{
    toolName: "get_conversation" | "list_conversations" | "spawn_agent" | "lifecycle_events";
    path: readonly string[];
    input: number | string;
    expected: number;
  }> = [
    { toolName: "list_conversations", path: ["limit"], input: 1e100, expected: 100 },
    { toolName: "list_conversations", path: ["limit"], input: -1e100, expected: 1 },
    { toolName: "get_conversation", path: ["maxRecords"], input: "8.0", expected: 8 },
    { toolName: "get_conversation", path: ["maxRecords"], input: "8e0", expected: 8 },
    { toolName: "get_conversation", path: ["maxRecords"], input: "1e999", expected: 500 },
    { toolName: "get_conversation", path: ["maxRecords"], input: "-1e999", expected: 1 },
    { toolName: "get_conversation", path: ["maxRecords"], input: "8.5", expected: 100 },
    { toolName: "spawn_agent", path: ["roleParams", "parallelN"], input: "999999999999999999999999999999", expected: 8 },
    { toolName: "lifecycle_events", path: ["afterSeq"], input: "999999999999999999999999999999", expected: Number.MAX_SAFE_INTEGER },
  ];

  await withProtocolClient(bindings, async (client) => {
    for (const [index, candidate] of cases.entries()) {
      const spec = MCP_BOUNDED_NUMERIC_ARGS[candidate.toolName]!
        .find((entry) => entry.path.join(".") === candidate.path.join("."))!;
      const args = boundedArgs(candidate.toolName, spec, `extreme-${index}`);
      setAtPath(args, candidate.path, candidate.input);
      const result = await client.callTool({ name: candidate.toolName, arguments: args });

      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        ok: true,
        clamped: { [candidate.path.join(".")]: candidate.expected },
      });
      expect(valueAtPath(
        (result.structuredContent as { applied: Record<string, unknown> }).applied,
        candidate.path,
      )).toBe(candidate.expected);
    }
  });
});

test("operator mutations and identity-bearing numerics retain exact protocol validation", async () => {
  const calls: string[] = [];
  const bindings = inertBindings({
    flow_action: async () => { calls.push("flow_action"); return {}; },
    operator_snapshot: async () => { calls.push("operator_snapshot"); return {}; },
    conversation_migration: async () => { calls.push("conversation_migration"); return {}; },
    bridge_directive: async () => { calls.push("bridge_directive"); return {}; },
  });
  const invalidCalls = [
    { name: "flow_action", arguments: { clientRequestId: "strict-flow-rounds", flowId: "flow_a", action: "set-round-limit", rounds: 51 } },
    { name: "operator_snapshot", arguments: { clientRequestId: "strict-snapshot-pid", caller: { pid: "42" } } },
    { name: "conversation_migration", arguments: { clientRequestId: "strict-migration-revision", conversationId: "conversation_a", action: "retry", expectedRevision: -1 } },
    { name: "bridge_directive", arguments: { clientRequestId: "strict-directive-utterance", rootTurnId: "turn-a", utterance: -1, instruction: "continue" } },
    { name: "bridge_directive", arguments: { clientRequestId: "strict-directive-ref", rootTurnId: "turn-b", utterance: 0, instruction: "continue", ref: 0 } },
  ] as const;

  await withProtocolClient(bindings, async (client) => {
    for (const request of invalidCalls) {
      const result = await client.callTool(request);
      expect(result.isError).toBe(true);
    }
  });
  expect(calls).toEqual([]);
});

test("spawn_agent listTools publishes every registry role exactly once", async () => {
  const roleIds = listRoles().map((role) => role.id);

  await withProtocolClient(inertBindings(), async (client) => {
    const listed = await client.listTools();
    const spawnSchema = listed.tools.find((tool) => tool.name === "spawn_agent")?.inputSchema;
    const roleSchema = spawnSchema?.properties?.role as { enum?: string[] } | undefined;

    expect(roleSchema?.enum).toEqual(roleIds);
    expect(new Set(roleSchema?.enum).size).toBe(roleIds.length);
  });
});

test("get_conversation listTools publishes every bounded tail target", async () => {
  await withProtocolClient(inertBindings(), async (client) => {
    const listed = await client.listTools();
    const tool = listed.tools.find((candidate) => candidate.name === "get_conversation");
    const tailSchema = tool?.inputSchema.properties?.tailLines as { description?: string } | undefined;

    for (const target of ["conversationId", "selectedContext", "transcriptPath"]) {
      expect(tool?.description).toContain(target);
      expect(tailSchema?.description).toContain(target);
    }
    expect(tool?.description).toContain("validated pinned reader");
    expect(tailSchema?.description).toContain("validated pinned reader");
  });
});

test("conversation_messages publishes identity, filters, clamps, and paging on the first probe", async () => {
  await withProtocolClient(inertBindings(), async (client) => {
    const listed = await client.listTools();
    const tool = listed.tools.find((candidate) => candidate.name === "conversation_messages");
    const properties = tool?.inputSchema.properties ?? {};

    for (const target of ["conversationId", "selectedContext", "transcriptPath"]) {
      expect(tool?.description).toContain(target);
      expect(properties).toHaveProperty(target);
    }
    for (const kind of ["message", "reasoning", "tool_call", "tool_result", "trace"]) {
      expect(tool?.description).toContain(kind);
    }
    for (const role of ["user", "assistant", "system", "tool"]) {
      expect(tool?.description).toContain(role);
    }
    expect(tool?.description).toContain("limit clamps to 1..200 (default 20)");
    expect(tool?.description).toContain("maxChars clamps to 1..16000 (default 4000)");
    expect(tool?.description).toContain("next-older page");
    expect(tool?.description).toContain("hasMore");
    expect(tool?.description).toContain("fresh clientRequestId");
    expect((properties.cursor as { description?: string }).description).toContain("next-older page");
    expect((properties.cursor as { description?: string }).description).toContain("fresh clientRequestId");
  });
});

test("conversation_action publishes full-generation archive outcomes and the 100-target bound", async () => {
  let calls = 0;
  await withProtocolClient(inertBindings({
    conversation_action: async () => {
      calls += 1;
      return {
        action: "archive",
        outcomes: [{ outcome: "archived", paths: ["/fixtures/project/earlier.jsonl", "/fixtures/project/current.jsonl"] }],
      };
    },
  }), async (client) => {
    const listed = await client.listTools();
    const tool = listed.tools.find((candidate) => candidate.name === "conversation_action");
    const action = tool?.inputSchema.properties?.action as { enum?: string[] } | undefined;
    const targets = tool?.inputSchema.properties?.targets as {
      maxItems?: number;
      items?: { properties?: Record<string, { description?: string }> };
    } | undefined;

    expect(action?.enum).toEqual(expect.arrayContaining(["archive", "unarchive"]));
    expect(tool?.description).toContain("every registered generation path");
    expect(tool?.description).toContain("preserving an exact transcriptPath");
    expect(tool?.description).toContain("outcome lists the paths actually written by this call");
    expect(tool?.description).toContain("full expanded set was already hidden");
    expect(tool?.description).toContain("readable transcript");
    expect(targets?.maxItems).toBe(100);
    expect(Object.keys(targets?.items?.properties ?? {})).toEqual(expect.arrayContaining([
      "conversationId",
      "transcriptPath",
    ]));
    expect(targets?.items?.properties?.conversationId?.description).toContain("every registered generation path");
    expect(targets?.items?.properties?.transcriptPath?.description).toContain("preserve it");

    const archived = await client.callTool({
      name: "conversation_action",
      arguments: {
        clientRequestId: "archive-schema-paths",
        action: "archive",
        conversationId: "conversation_fixture",
      },
    });
    expect(archived.structuredContent).toMatchObject({
      outcomes: [{ outcome: "archived", paths: ["/fixtures/project/earlier.jsonl", "/fixtures/project/current.jsonl"] }],
    });

    const result = await client.callTool({
      name: "conversation_action",
      arguments: {
        clientRequestId: "archive-schema-overflow",
        action: "archive",
        targets: Array.from({ length: 101 }, (_, index) => ({ transcriptPath: `/fixtures/project/session-${index}.jsonl` })),
      },
    });
    expect(result.isError).toBe(true);
  });
  expect(calls).toBe(1);
});

test("search_transcripts publishes its body-query, project, cursor, and bounded page schema", async () => {
  await withProtocolClient(inertBindings(), async (client) => {
    const listed = await client.listTools();
    const tool = listed.tools.find((candidate) => candidate.name === "search_transcripts");

    expect(tool?.description).toContain("message bodies");
    /* #1428 — the description names the use case and the read that follows a
       hit, so a seat discovers the pairing from the tool list alone. */
    expect(tool?.description).toContain("has this been solved before?");
    expect(tool?.description).toContain("conversation_messages");
    expect(tool?.description).toContain("byteOffset");
    expect(tool?.inputSchema.required).toEqual(expect.arrayContaining(["clientRequestId", "query"]));
    expect(Object.keys(tool?.inputSchema.properties ?? {})).toEqual(expect.arrayContaining([
      "clientRequestId",
      "query",
      "project",
      "cursor",
      "limit",
    ]));
    expect(tool?.inputSchema.properties?.limit).toMatchObject({
      description: expect.stringContaining("Integer 1..100"),
    });
  });
});

test("spawn_agent rejects unknown roles at the protocol boundary while valid roles and roleParams remain admitted", async () => {
  const roleIds = listRoles().map((role) => role.id);
  let spawnCalls = 0;

  await withProtocolClient(inertBindings({
    spawn_agent: async () => {
      spawnCalls += 1;
      return {};
    },
  }), async (client) => {
    for (const role of roleIds) {
      await client.callTool({
        name: "spawn_agent",
        arguments: {
          clientRequestId: `spawn-valid-${role}`,
          title: `Run ${role} schema check`,
          cwd: ".",
          "prompt": "Run the assigned check.",
          role,
          roleParams: { roleSpecificField: true },
        },
      });
    }
    expect(spawnCalls).toBe(roleIds.length);

    const unknownRole = await client.callTool({
      name: "spawn_agent",
      arguments: {
        clientRequestId: "spawn-unknown-role",
        title: "Reject unknown spawn role",
        cwd: ".",
        "prompt": "Run the assigned check.",
        role: "unknown-role",
      },
    });
    expect(unknownRole.isError).toBe(true);
    expect(spawnCalls).toBe(roleIds.length);
  });
});

test("every registry role resolves and unknown-role errors enumerate the same alternatives", () => {
  const roles = listRoles();
  for (const role of roles) {
    expect(resolveRole(role.id, requiredRoleParams(role))).toMatchObject({ ok: true });
  }

  const unknown = resolveRole("unknown-role");
  expect(unknown).toEqual({
    ok: false,
    error: `unknown role: unknown-role (allowed: ${roles.map((role) => role.id).join(", ")})`,
  });
});

test("operator_snapshot publishes a strict top-level schema", async () => {
  let snapshotCalls = 0;

  await withProtocolClient(inertBindings({
    operator_snapshot: async () => {
      snapshotCalls += 1;
      return {};
    },
  }), async (client) => {
    const listed = await client.listTools();
    const snapshotSchema = listed.tools.find((tool) => tool.name === "operator_snapshot")?.inputSchema;
    expect(snapshotSchema?.additionalProperties).toBe(false);

    const rejected = await client.callTool({
      name: "operator_snapshot",
      arguments: {
        clientRequestId: "snapshot-invalid-top-level",
        unexpected: true,
      },
    });
    expect(rejected.isError).toBe(true);
    expect(snapshotCalls).toBe(0);
  });
});

test("operator_snapshot scope discriminates paths from non-path kinds at the protocol boundary", async () => {
  let snapshotCalls = 0;

  await withProtocolClient(inertBindings({
    operator_snapshot: async () => {
      snapshotCalls += 1;
      return {};
    },
  }), async (client) => {
    const invalidArguments = [
      { scope: { kind: "paths" } },
      { scope: { kind: "visible", paths: ["sessions/a.jsonl"] } },
    ];
    for (const [index, invalid] of invalidArguments.entries()) {
      const rejected = await client.callTool({
        name: "operator_snapshot",
        arguments: {
          clientRequestId: `snapshot-invalid-scope-${index}`,
          ...invalid,
        },
      });
      expect(rejected.isError).toBe(true);
    }
    expect(snapshotCalls).toBe(0);
  });
});

test("operator_snapshot bounds snapshot strings and rejects duplicate paths at the protocol boundary", async () => {
  const oversized = "x".repeat(MAX_SNAPSHOT_STRING_LENGTH + 1);
  let snapshotCalls = 0;

  await withProtocolClient(inertBindings({
    operator_snapshot: async () => {
      snapshotCalls += 1;
      return {};
    },
  }), async (client) => {
    const invalidArguments = [
      { scope: { kind: "paths", paths: [""] } },
      { scope: { kind: "paths", paths: [oversized] } },
      { scope: { kind: "paths", paths: ["sessions/a.jsonl", "sessions/a.jsonl"] } },
      { view: { id: "" } },
      { view: { deviceId: oversized } },
      { caller: { transcriptPath: "" } },
    ];
    for (const [index, invalid] of invalidArguments.entries()) {
      const rejected = await client.callTool({
        name: "operator_snapshot",
        arguments: {
          clientRequestId: `snapshot-invalid-string-${index}`,
          ...invalid,
        },
      });
      expect(rejected.isError).toBe(true);
    }
    expect(snapshotCalls).toBe(0);
  });
});

test("every generated operator_snapshot schema combination is admitted by request validation", () => {
  const schema = TOOL_INPUT_SCHEMAS.operator_snapshot;
  const oversized = "x".repeat(MAX_SNAPSHOT_STRING_LENGTH + 1);
  const views = [
    undefined,
    {},
    { id: "view-a" },
    { deviceId: "device-a" },
    { resolution: "latest-interaction" },
    { id: "view-a", deviceId: "device-a", resolution: "require-explicit" },
    { id: "v".repeat(MAX_SNAPSHOT_STRING_LENGTH) },
  ];
  const scopes = [
    undefined,
    { kind: "focused" },
    { kind: "selected" },
    { kind: "visible" },
    { kind: "focused-selected" },
    { kind: "paths", paths: [] },
    { kind: "paths", paths: Array.from({ length: MAX_SCOPE_PATHS }, (_, index) => `sessions/${index}.jsonl`) },
  ];
  const textOptions = [
    undefined,
    {},
    { include: false },
    { lastMessages: 1 },
    { lastMessages: MAX_SNAPSHOT_LAST_MESSAGES },
    { maxCharsPerConversation: 1 },
    { maxCharsPerConversation: MAX_SNAPSHOT_CHARS_PER_CONVERSATION },
  ];
  const callers = [
    undefined,
    {},
    { pid: 1 },
    { transcriptPath: "sessions/caller.jsonl" },
    { pid: Number.MAX_SAFE_INTEGER, transcriptPath: "sessions/caller.jsonl" },
    { transcriptPath: "t".repeat(MAX_SNAPSHOT_STRING_LENGTH) },
  ];

  let accepted = 0;
  const compareAcceptedShape = (candidate: Record<string, unknown>) => {
    const parsed = schema.safeParse(candidate);
    if (!parsed.success) return;
    accepted += 1;
    const validatorInput = Object.fromEntries(
      Object.entries(parsed.data).filter(([key]) => key !== "clientRequestId"),
    );
    expect(() => validateSnapshotRequest({
      schemaVersion: 1,
      ...validatorInput,
    })).not.toThrow();
  };
  for (const schemaVersion of [undefined, 1]) {
    for (const view of views) {
      for (const scope of scopes) {
        for (const text of textOptions) {
          for (const caller of callers) {
            const candidate = {
              clientRequestId: `snapshot-parity-${accepted}`,
              ...(schemaVersion === undefined ? {} : { schemaVersion }),
              ...(view === undefined ? {} : { view }),
              ...(scope === undefined ? {} : { scope }),
              ...(text === undefined ? {} : { text }),
              ...(caller === undefined ? {} : { caller }),
            };
            compareAcceptedShape(candidate);
          }
        }
      }
    }
  }
  for (const [index, divergent] of [
    { unexpected: true },
    { scope: { kind: "paths" } },
    { scope: { kind: "visible", paths: ["sessions/a.jsonl"] } },
    { scope: { kind: "paths", paths: [""] } },
    { scope: { kind: "paths", paths: [oversized] } },
    { scope: { kind: "paths", paths: ["sessions/a.jsonl", "sessions/a.jsonl"] } },
    { view: { id: "" } },
    { view: { deviceId: oversized } },
    { caller: { transcriptPath: "" } },
  ].entries()) {
    compareAcceptedShape({
      clientRequestId: `snapshot-divergence-${index}`,
      ...divergent,
    });
  }
  expect(accepted).toBeGreaterThan(1_000);
});

/* #1026 — `stages: array of objects` with no field documentation cost a fresh
   caller seven sequential rejections to learn the stage contract. The published
   tool definition now carries that contract: every field the engine accepts,
   and the rules a JSONSchema cannot express in the description. */
test("create_pipeline publishes the stage contract in its tool definition", async () => {
  await withProtocolClient(inertBindings(), async (client) => {
    const listed = await client.listTools();
    const tool = listed.tools.find((candidate) => candidate.name === "create_pipeline");
    const stages = tool?.inputSchema.properties?.stages as {
      items?: { properties?: Record<string, { description?: string; enum?: string[]; properties?: Record<string, { enum?: string[] }> }> };
    } | undefined;
    const stage = stages?.items?.properties;

    expect(Object.keys(stage ?? {}).sort()).toEqual([
      "access", "account", "effort", "engine", "id", "kind", "model", "next", "onFail", "outputs", "prompt", "role", "sandbox",
    ]);
    expect(stage?.kind?.enum).toEqual(["run", "review-loop"]);
    expect(stage?.engine?.enum).toEqual(["claude", "codex"]);
    expect(stage?.role?.properties?.roleId?.enum).toEqual([...ROLE_IDS]);
    /* The two rules the reported walk actually turned on. */
    expect(stage?.next?.description).toContain("DEFAULTS TO null");
    expect(stage?.role?.description).toContain("Runtime overrides do not go here");
    for (const [field, expected] of [
      ["id", "unique within the pipeline"],
      ["prompt", "role scaffold"],
      ["onFail", "may not define one"],
      ["model", "inherit the role default"],
      ["access", "always read-only"],
      ["sandbox", "Defaults to full host access"],
      ["outputs", "controller records only these paths"],
      /* #1279: the account a stage may name, and the refusal the project's
         binding answers with when it names one the project does not allow. */
      ["account", "project allows that account"],
    ] as const) {
      expect(stage?.[field]?.description).toContain(expected);
    }

    /* Reachability, the draft baseRef rule and the review-loop runtime default
       are graph-level facts no per-field schema can carry. */
    expect(tool?.description).toContain("pass-reachable from a run stage");
    expect(tool?.description).toContain("`next` defaults to null");
    expect(tool?.description).toContain("must also pass `baseRef`");
    expect(tool?.description).toContain("always read-only");
    expect(tool?.description).toContain("Codex");
    expect(tool?.description).toContain("access is the repository-mutation policy enforced at settlement");
    expect(stage?.access?.description).toContain("does not select the sandbox");
    expect(stage?.sandbox?.description).toContain("independent from access");
    expect(tool?.description).toContain("every violated constraint");
    expect(tool?.description).toContain("normalized to the shared Claude transcript store");
  });
});

/* The published schema must never be stricter than the engine: a stage shape
   the engine accepts has to survive the protocol boundary unchanged. */
test("create_pipeline admits the stage shapes the engine accepts", () => {
  const schema = TOOL_INPUT_SCHEMAS.create_pipeline;
  const accepted = [
    { id: "build", kind: "run", "prompt": "Implement." },
    { id: "build", kind: "run", "prompt": "Implement.", next: null, onFail: null, role: { roleId: "builder" } },
    {
      id: "audit", kind: "run", "prompt": "Audit.", next: null,
      role: { roleId: "architect", params: { mode: "architecture-audit" } },
      access: "read-only",
      sandbox: "restricted", outputs: ["reports/audit.md"],
    },
    { id: "build", kind: "run", "prompt": "Implement.", next: "review-1", onFail: { to: "build", maxRounds: 3 }, engine: "claude", model: "opus", effort: "high" },
    /* The engine trims before it checks, so padding it accepts must not be
       refused at the protocol boundary. */
    { id: " build ", kind: "run", "prompt": " Implement. " },
  ];
  for (const stage of accepted) {
    const parsed = schema.safeParse({ clientRequestId: "stage-shape", task: "t", repoDir: "/repo", stages: [stage] });
    expect(parsed.success).toBe(true);
    expect((parsed.data as { stages: unknown[] } | undefined)?.stages[0]).toEqual(stage);
  }
  /* Runtime overrides inside role are refused by the engine and by the schema. */
  expect(schema.safeParse({
    clientRequestId: "stage-shape-role-override", task: "t", repoDir: "/repo",
    stages: [{ id: "build", kind: "run", "prompt": "Implement.", role: { roleId: "builder", engine: "codex" } }],
  }).success).toBe(false);
});

/* #1016 — `target` was a free-form record with a prose list of kind names, so
   the discriminator and every per-kind field lived only in the TypeScript type:
   five plausible guesses in a row were rejected by one undifferentiated
   sentence. The tool definition now publishes the union itself. */
test("request_attention publishes the per-kind target schema in its tool definition", async () => {
  await withProtocolClient(inertBindings(), async (client) => {
    const listed = await client.listTools();
    const tool = listed.tools.find((candidate) => candidate.name === "request_attention");
    const target = tool?.inputSchema.properties?.target as {
      oneOf?: { properties?: Record<string, { const?: string; description?: string }>; required?: string[] }[];
    } | undefined;
    const branches = new Map((target?.oneOf ?? []).map(
      (branch) => [branch.properties?.kind?.const, branch] as const,
    ));

    /* One branch per kind, in the table's own order — a real oneOf, not a hint. */
    expect([...branches.keys()]).toEqual(FOCUS_TARGET_SHAPES.map((shape) => shape.kind));
    for (const [kind, required] of [
      ["conversation", ["kind"]],
      ["pipeline", ["kind", "pipelineId"]],
      ["stage", ["kind", "pipelineId", "stageId"]],
      ["flowRound", ["kind", "flowId", "round"]],
      ["task", ["kind", "taskId"]],
      ["draft", ["kind", "draftId"]],
      ["region", ["kind", "project", "rect"]],
      ["point", ["kind", "project", "x", "y"]],
    ] as const) {
      expect([kind, branches.get(kind)?.required?.slice().sort()]).toEqual([kind, [...required].sort()]);
    }
    /* The conversation branch carries BOTH accepted input forms: the durable id
       the rest of this surface speaks, and the transcript path the record
       stores. Neither is required alone, which is why the binding — not the
       protocol boundary — answers a conversation target naming neither. */
    const conversation = branches.get("conversation")?.properties;
    expect(conversation?.conversationId?.description).toContain("survives resume and migration");
    expect(conversation?.path?.description).toContain("supply at least one");

    /* One pasteable example per kind, on the definition a caller reads first. */
    for (const shape of FOCUS_TARGET_SHAPES) expect(tool?.description).toContain(shape.example);
    expect(tool?.description).toContain("A rejected target names the kind it read and the fields that kind expects");
  });
});

/* The published union must never be stricter than the record's own validator,
   or a target the server would have accepted dies at the protocol boundary
   without ever reaching the error that explains targets. */
test("request_attention admits every target shape the attention record accepts", () => {
  const schema = TOOL_INPUT_SCHEMAS.request_attention;
  const accepted = [
    ...FOCUS_TARGET_SHAPES.map((shape) => JSON.parse(shape.example) as Record<string, unknown>),
    { kind: "conversation", path: "/tmp/session.jsonl" },
    /* Both forms together, and the extra keys `isFocusTarget` has always
       tolerated: every call that works today keeps working. */
    { kind: "conversation", path: "/tmp/session.jsonl", conversationId: "conversation_9f2c", note: "kept" },
    { kind: "flowRound", flowId: "flow_9f2c", round: 0 },
    { kind: "region", project: "demo", rect: { x: -10, y: -10, w: 0, h: 0 } },
    { kind: "point", project: "demo", x: -1.5, y: 2.5, zoom: 0.25 },
  ];
  for (const target of accepted) {
    const parsed = schema.safeParse({ clientRequestId: "target-shape", target, reason: "Look at this." });
    expect([target.kind, parsed.success]).toEqual([target.kind, true]);
    expect((parsed.data as { target: unknown } | undefined)?.target).toEqual(target);
  }
  /* An unknown kind never resolves to a branch, so the discriminator is the one
     thing the boundary does refuse — naming the kinds it knows. */
  const refused = schema.safeParse({ clientRequestId: "target-shape", target: { kind: "elsewhere" }, reason: "Look." });
  expect(refused.success).toBe(false);
  expect(JSON.stringify(refused.error?.issues)).toContain("conversation");
});

/* ── ORIGINAL-KEY RECOVERY (#1490) ─────────────────────────────────────── */

import { RECOVERY_CONTRACT_DESCRIPTION, type McpRecoverableTool } from "./server";

test("spawn_agent and send_message publish recoveryOnly and the recovery contract, and the flag never enters the digest", async () => {
  await withProtocolClient(inertBindings(), async (client) => {
    const listed = await client.listTools();
    for (const toolName of ["spawn_agent", "send_message"] as const) {
      const tool = listed.tools.find((candidate) => candidate.name === toolName)!;
      const schema = tool.inputSchema as { properties: Record<string, { type?: string; description?: string }>; required?: string[] };
      /* Captured before toMatchObject, which swaps the matched field for its matcher. */
      const recoveryOnlyDescription = String(schema.properties.recoveryOnly?.description);
      expect(schema.properties.recoveryOnly).toMatchObject({ type: "boolean", description: expect.stringContaining("never claim an absent key") });
      expect(recoveryOnlyDescription).toContain("nothing is disclosed");
      if (toolName === "spawn_agent") {
        expect(String(schema.properties.project.description)).toContain("resolved server-side from cwd");
      }
      expect(schema.required ?? []).not.toContain("recoveryOnly");
      expect(tool.description).toContain(RECOVERY_CONTRACT_DESCRIPTION);
      for (const rule of [
        "sent exactly once",
        "`recoveryOnly: true` never claims an absent key",
        "`idempotency_conflict`",
        "refused without disclosure",
        "`accepted`",
        "`in-flight`",
        "`settled`",
        "`not-executed`",
        "`unknown`",
        "`retryable` never means a new key may be used",
        "`message_receipt(operationId)` remains available",
      ]) expect(tool.description).toContain(rule);
    }
    expect(listed.tools.find((candidate) => candidate.name === "message_receipt")).toBeDefined();
  });

  /* Over the protocol: the same logical call with and without the flag is one
     call, answered once by dispatch and afterwards by recovery only. */
  const bindingCalls: unknown[] = [];
  const bindings = inertBindings({
    send_message: async (args) => { bindingCalls.push(args); return { operationId: "op_parity" }; },
  });
  const tool: McpRecoverableTool = {
    bind: () => ({ caller: { kind: "worker", conversationId: "conversation_parity", project: null }, target: { project: null, identity: "conversation_target" }, downstreamKey: "parity-1" }),
    recover: async () => ({ outcome: "settled", evidence: "delivery-record", reason: null, ids: { operationId: "op_parity" }, facts: { state: "delivered" } }),
  };
  const server = createViewerMcpServer(createMcpToolService(bindings, new MemoryMcpReceiptStore(), undefined, { recovery: { send_message: tool } }));
  const client = new Client({ name: "schema-parity-recovery", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const args = { clientRequestId: "parity-1", conversationId: "conversation_target", text: "hold" };
    const first = await client.callTool({ name: "send_message", arguments: { ...args, recoveryOnly: false } });
    expect(first.structuredContent).toMatchObject({ ok: true, operationId: "op_parity", replayed: false });
    const explicit = await client.callTool({ name: "send_message", arguments: { ...args, recoveryOnly: true } });
    expect(explicit.structuredContent).toMatchObject({ ok: true, recovered: true, outcome: "settled", operationId: "op_parity", replayed: true });
    const ordinary = await client.callTool({ name: "send_message", arguments: args });
    expect(ordinary.structuredContent).toMatchObject({ ok: true, operationId: "op_parity", replayed: true });
    expect(bindingCalls).toHaveLength(1);
    const rejected = await client.callTool({ name: "send_message", arguments: { ...args, recoveryOnly: "yes" } });
    expect(rejected.isError).toBe(true);
  } finally {
    await client.close();
    await server.close();
  }
});


test("task coordinates publish finite axes and retain pinned-update position semantics", async () => {
  await withProtocolClient(inertBindings(), async client => {
    const listed = await client.listTools();
    for (const name of ["create_task", "update_task"] as const) {
      const tool = listed.tools.find(t => t.name === name)!;
      const pos = tool.inputSchema.properties!.pos as { required: string[]; properties: Record<string, { type: string }> };
      expect(pos.required.slice().sort()).toEqual(["x", "y"]);
      expect(pos.properties.x.type).toBe("number");
      expect(pos.properties.y.type).toBe("number");
      expect(tool.inputSchema.required).not.toContain("pos");
      expect(tool.inputSchema.required?.slice().sort()).toEqual(name === "create_task" ? ["clientRequestId", "project", "text"] : ["clientRequestId", "taskId"]);
      for (const invalid of [null, {}, { x: 1 }, { y: 2 }, { x: "1", y: 2 }, { x: Infinity, y: 0 }, { x: NaN, y: 0 }]) {
        const args = { clientRequestId: "invalid-coordinate", project: "fixture-project", text: "task", taskId: "task-fixture", pos: invalid };
        const parsed = TOOL_INPUT_SCHEMAS[name].safeParse(args);
        expect(parsed.success).toBe(false);
        expect(parsed.error?.issues.some(issue => issue.path[0] === "pos")).toBe(true);
        const result = await client.callTool({ name, arguments: args });
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain("pos");
        expect(result.structuredContent).toMatchObject({ ok: false, code: "TASK_INVALID_FIELD", retryable: false });
      }
    }
    expect(TOOL_INPUT_SCHEMAS.update_task.safeParse({ clientRequestId: "retain-position", taskId: "task-fixture", placement: "pinned", expectedProject: "fixture-project", expectedRevision: "opaque" }).success).toBe(true);
  });
});
