import { CODEX_VIEWER_SPAWN_FEATURES } from "@/lib/agent/spawnPolicy";

type JsonObject = Record<string, unknown>;

function record(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

/** Builds a fail-closed thread override from Codex's effective configuration. */
export function headlessCodexThreadConfig(configRead: unknown, allowSubagents = false): JsonObject {
  const config = record(record(configRead)?.config);
  const servers = record(config?.mcp_servers);
  if (!config || !servers) throw new Error("config/read returned no MCP server table");
  return {
    mcp_servers: Object.fromEntries(Object.keys(servers).map((name) => [name, { enabled: false }])),
    features: { ...CODEX_VIEWER_SPAWN_FEATURES, multi_agent: allowSubagents },
    include_apps_instructions: false,
  };
}
