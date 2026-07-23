import { CODEX_VIEWER_SPAWN_FEATURES } from "@/lib/agent/spawnPolicy";
import { normalizeSpawnMcpServers } from "@/lib/agent/mcpAllowlist";

type JsonObject = Record<string, unknown>;
const MCP_APPROVAL_MODES = new Set(["auto", "prompt", "writes", "approve"]);

function record(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

/** Builds a fail-closed thread override from Codex's effective configuration. */
export function headlessCodexThreadConfig(
  configRead: unknown,
  allowSubagents = false,
  mcpServers: readonly string[] | undefined = undefined,
): JsonObject {
  const config = record(record(configRead)?.config);
  const servers = record(config?.mcp_servers);
  if (!config || !servers) throw new Error("config/read returned no MCP server table");
  const normalized = normalizeSpawnMcpServers(mcpServers);
  const enabled = new Set(normalized.ok ? normalized.value : ["viewer"]);
  return {
    mcp_servers: Object.fromEntries(Object.entries(servers).map(([name, server]) => {
      const configuredApproval = record(server)?.default_tools_approval_mode;
      const approval = name === "viewer"
        ? "approve"
        : typeof configuredApproval === "string" && MCP_APPROVAL_MODES.has(configuredApproval)
          ? configuredApproval
          : null;
      return [name, {
        enabled: enabled.has(name),
        ...(approval ? { default_tools_approval_mode: approval } : {}),
      }];
    })),
    features: { ...CODEX_VIEWER_SPAWN_FEATURES, multi_agent: allowSubagents },
    include_apps_instructions: false,
  };
}
