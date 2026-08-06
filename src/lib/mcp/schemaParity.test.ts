import { expect, test } from "bun:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { listRoles, resolveRole } from "@/lib/roles/registry";
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
      cwd: ".",
      ["prompt"]: "Review PR #1.",
      role: spec.role,
      roleParams: {},
    });
  }
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
    list_conversations: async (args) => ({ applied: args }),
    spawn_agent: async (args) => ({ applied: args }),
    lifecycle_events: async (args) => ({ applied: args }),
  });
  const cases: Array<{
    toolName: "list_conversations" | "spawn_agent" | "lifecycle_events";
    path: readonly string[];
    input: number | string;
    expected: number;
  }> = [
    { toolName: "list_conversations", path: ["limit"], input: 1e100, expected: 100 },
    { toolName: "list_conversations", path: ["limit"], input: -1e100, expected: 1 },
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
