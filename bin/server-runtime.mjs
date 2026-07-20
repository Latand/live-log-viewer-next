export const WAKATIME_CREDENTIAL_ENV = "WAKATIME_API_KEY";

/** @param {Record<string, string | undefined>} environment */
export function discardWakatimeEnvironmentCredential(environment = process.env) {
  delete environment[WAKATIME_CREDENTIAL_ENV];
}

/**
 * @param {Readonly<Record<string, string | undefined>>} base
 * @returns {Record<string, string | undefined>}
 */
export function withoutWakatimeCredential(base) {
  const env = { NODE_ENV: base.NODE_ENV };
  for (const key of Object.keys(base)) {
    if (key === WAKATIME_CREDENTIAL_ENV) continue;
    env[key] = base[key];
  }
  return env;
}

export function viewerServerBunRuntime(options = {}) {
  const env = options.env ?? process.env;
  const versions = options.versions ?? process.versions;
  const execPath = options.execPath ?? process.execPath;
  const sqliteMode = env.LLV_AGENT_REGISTRY_SQLITE ?? "off";
  const requiresBun = sqliteMode !== "off" || env.LLV_STRUCTURED_HOSTS === "1";
  if (!requiresBun) return null;
  return versions.bun ? execPath : (env.LLV_BUN_EXECUTABLE || "bun");
}
