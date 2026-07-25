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

/**
 * @param {Record<string, unknown> & { env?: Readonly<Record<string, string | undefined>> }} options
 */
export function viewerChildProcessOptions(options = {}) {
  return {
    ...options,
    env: withoutWakatimeCredential(options.env ?? process.env),
  };
}

/**
 * Mirror of `structuredHostsEnabled` (and its rollback normalisation) from
 * `src/lib/runtime/flags.ts`. `bin/` is plain JS outside the TS build and
 * cannot import that module, so the predicate is duplicated — never diverged:
 * `bin/server-runtime.test.ts` pins the two to one truth table. Structured
 * hosting is on unless explicitly rolled back, and it genuinely requires Bun
 * (the journal runs on `bun:sqlite`; macOS process ownership needs the kernel
 * start token), so the launcher must select Bun on the same answer.
 *
 * @param {Readonly<Record<string, string | undefined>>} [env]
 */
export function structuredHostsEnabled(env = process.env) {
  const raw = env.LLV_STRUCTURED_HOSTS;
  if (raw === undefined) return true;
  const normalized = raw.trim().replace(/^(["'])([\s\S]*)\1$/, "$2").trim().toLowerCase();
  return !(normalized === "0" || normalized === "false" || normalized === "off" || normalized === "no");
}

export function viewerServerBunRuntime(options = {}) {
  const env = options.env ?? process.env;
  const versions = options.versions ?? process.versions;
  const execPath = options.execPath ?? process.execPath;
  const sqliteMode = env.LLV_AGENT_REGISTRY_SQLITE ?? "off";
  const requiresBun = sqliteMode !== "off" || structuredHostsEnabled(env);
  if (!requiresBun) return null;
  return versions.bun ? execPath : (env.LLV_BUN_EXECUTABLE || "bun");
}
