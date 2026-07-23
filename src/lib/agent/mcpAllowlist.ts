export const DEFAULT_SPAWN_MCP_SERVERS: readonly string[] = Object.freeze(["viewer"]);

export type SpawnMcpServersResult =
  | { ok: true; value: string[] }
  | { ok: false; error: string };

const MCP_SERVER_NAME = /^[^\s\u0000-\u001f\u007f]{1,128}$/u;

export function normalizeSpawnMcpServers(value: unknown): SpawnMcpServersResult {
  if (value === undefined) return { ok: true, value: [...DEFAULT_SPAWN_MCP_SERVERS] };
  if (Array.isArray(value) && value.every((name) => typeof name === "string" && MCP_SERVER_NAME.test(name))) {
    return { ok: true, value: ["viewer", ...new Set(value.filter((name) => name !== "viewer"))] };
  }
  return { ok: false, error: "mcpServers must be an array of non-empty server names" };
}
