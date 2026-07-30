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
  MCP_TOOL_NAMES,
  TOOL_INPUT_SCHEMAS,
  MemoryMcpReceiptStore,
  createMcpToolService,
  createViewerMcpServer,
  type McpToolBindings,
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

test("spawn_agent publishes the registry role ids once and rejects unknown roles at the protocol boundary", async () => {
  const roleIds = listRoles().map((role) => role.id);
  let spawnCalls = 0;

  await withProtocolClient(inertBindings({
    spawn_agent: async () => {
      spawnCalls += 1;
      return {};
    },
  }), async (client) => {
    const listed = await client.listTools();
    const spawnSchema = listed.tools.find((tool) => tool.name === "spawn_agent")?.inputSchema;
    const roleSchema = spawnSchema?.properties?.role as { enum?: string[] } | undefined;

    expect(roleSchema?.enum).toEqual(roleIds);
    expect(new Set(roleSchema?.enum).size).toBe(roleIds.length);

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
    expect(spawnCalls).toBe(0);

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

test("operator_snapshot publishes a strict conditional schema and rejects invalid paths at the protocol boundary", async () => {
  const oversized = "x".repeat(MAX_SNAPSHOT_STRING_LENGTH + 1);
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

    const invalidArguments = [
      { unexpected: true },
      { scope: { kind: "paths" } },
      { scope: { kind: "visible", paths: ["sessions/a.jsonl"] } },
      { scope: { kind: "paths", paths: [""] } },
      { scope: { kind: "paths", paths: [oversized] } },
      { scope: { kind: "paths", paths: ["sessions/a.jsonl", "sessions/a.jsonl"] } },
    ];
    for (const [index, invalid] of invalidArguments.entries()) {
      const rejected = await client.callTool({
        name: "operator_snapshot",
        arguments: {
          clientRequestId: `snapshot-invalid-${index}`,
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
  const views = [
    undefined,
    {},
    { id: "view-a" },
    { deviceId: "device-a" },
    { resolution: "latest-interaction" },
    { id: "view-a", deviceId: "device-a", resolution: "require-explicit" },
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
  ];

  let accepted = 0;
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
            const parsed = schema.safeParse(candidate);
            if (!parsed.success) continue;
            accepted += 1;
            const validatorInput = Object.fromEntries(
              Object.entries(parsed.data).filter(([key]) => key !== "clientRequestId"),
            );
            expect(() => validateSnapshotRequest({
              schemaVersion: 1,
              ...validatorInput,
            })).not.toThrow();
          }
        }
      }
    }
  }
  expect(accepted).toBeGreaterThan(1_000);
});
