import { CODEX_VIEWER_SPAWN_FEATURES } from "@/lib/agent/spawnPolicy";
import { normalizeSpawnMcpServers } from "@/lib/agent/mcpAllowlist";
import { grantedPlugins } from "@/lib/agent/pluginAllowlist";

type JsonObject = Record<string, unknown>;
const MCP_APPROVAL_MODES = new Set(["auto", "prompt", "writes", "approve"]);

function record(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

/** Per-plugin thread table for a granted session: every plugin Codex knows
 *  about, with only the granted names enabled. Codex 0.145 accepts this table
 *  on `thread/start` but resolves plugins from the global config instead, so it
 *  is the declarative record of the grant — the realized surface is verified
 *  against the same allowlist once the thread exists (`codexAppServerHost`). */
function pluginTable(config: JsonObject, granted: readonly string[]): JsonObject {
  const installed = record(config.plugins) ?? {};
  const keys = new Set(Object.keys(installed));
  /* Plugin ids are `<name>@<marketplace>`; the grant names the plugin only. */
  for (const name of granted) {
    if (![...keys].some((key) => key.split("@")[0] === name)) keys.add(name);
  }
  return Object.fromEntries([...keys].map((key) => [key, { enabled: granted.includes(key.split("@")[0]) }]));
}

/** Builds a fail-closed thread override from Codex's effective configuration. */
export function headlessCodexThreadConfig(
  configRead: unknown,
  allowSubagents = false,
  mcpServers: readonly string[] | undefined = undefined,
  plugins: readonly string[] | undefined = undefined,
): JsonObject {
  const config = record(record(configRead)?.config);
  const servers = record(config?.mcp_servers);
  if (!config || !servers) throw new Error("config/read returned no MCP server table");
  const normalized = normalizeSpawnMcpServers(mcpServers);
  const enabled = new Set(normalized.ok ? normalized.value : ["viewer"]);
  /* The plugin subsystem is off for every session that holds no grant, which
     is the default. A grant turns it on for THIS thread only — never for the
     app-server, never in the operator's configuration. */
  const granted = grantedPlugins(plugins);
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
    /* The per-thread features table replaces the app-server's global one, so
       the realtime flag the host passes via `--enable realtime_conversation`
       must be restated here or thread/realtime/start fails locally (#621). */
    features: {
      ...CODEX_VIEWER_SPAWN_FEATURES,
      plugins: granted.length > 0,
      multi_agent: allowSubagents,
      realtime_conversation: true,
    },
    ...(granted.length > 0 ? { plugins: pluginTable(config, granted) } : {}),
    include_apps_instructions: false,
  };
}
