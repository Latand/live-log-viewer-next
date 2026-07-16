export function viewerServerBunRuntime(options = {}) {
  const env = options.env ?? process.env;
  const versions = options.versions ?? process.versions;
  const execPath = options.execPath ?? process.execPath;
  const sqliteMode = env.LLV_AGENT_REGISTRY_SQLITE ?? "off";
  const requiresBun = sqliteMode !== "off" || env.LLV_STRUCTURED_HOSTS === "1";
  if (!requiresBun) return null;
  return versions.bun ? execPath : (env.LLV_BUN_EXECUTABLE || "bun");
}
