import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

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
 * cannot import that module, so `bin/server-runtime.test.ts` pins both readers
 * to one truth table. Structured hosting and the authoritative hot-state
 * collections use Bun SQLite. The hot-state requirement applies in every
 * feature-flag configuration, so the packaged launcher always selects Bun.
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
  return versions.bun ? execPath : (env.LLV_BUN_EXECUTABLE || "bun");
}

/**
 * Resolve the runtime host the public CLI will supervise. Ordinary package
 * installs share the Viewer state directory while retaining distinct socket
 * and journal ownership. Ambient deployment runtime configuration never
 * crosses this CLI ownership boundary.
 *
 * @param {string} packageRoot
 * @param {{ env?: Readonly<Record<string, string | undefined>>, home?: string }} [options]
 */
export function cliRuntimeHostConfig(packageRoot, options = {}) {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const stateDirectory = env.LLV_STATE_DIR?.trim()
    || join(env.XDG_CONFIG_HOME?.trim() || join(home, ".config"), "agent-log-viewer", "state");
  const installId = createHash("sha256").update(resolve(packageRoot)).digest("hex").slice(0, 16);
  const bundled = join(packageRoot, "dist", "runtime-host.mjs");
  const source = join(packageRoot, "src", "runtime-host", "main.ts");
  return {
    socketPath: join(stateDirectory, `runtime-host-${installId}.sock`),
    journalPath: join(stateDirectory, `runtime-events-${installId}.sqlite`),
    entrypoint: existsSync(bundled) ? bundled : source,
  };
}

/**
 * Environment shared by the supervised runtime host and the Viewer server.
 * The CLI is the structured-host activation boundary, including for callers
 * whose shell still carries one of the former rollback values. Its journal
 * follows the same installation boundary as its socket, so a CLI host cannot
 * claim an ambient deployment's host epoch through the shared state directory.
 *
 * @param {Readonly<Record<string, string | undefined>>} base
 * @param {{ socketPath: string, journalPath: string }} config
 */
export function cliRuntimeHostEnvironment(base, config) {
  return {
    ...withoutWakatimeCredential(base),
    LLV_RUNTIME_HOST_SOCKET: config.socketPath,
    LLV_RUNTIME_JOURNAL: config.journalPath,
    LLV_STRUCTURED_HOSTS: "1",
    LLV_RUNTIME_EVENTS: "1",
    LLV_SPAWN_TRANSPORT: "structured",
    NEXT_PUBLIC_RUNTIME_UI: "1",
  };
}
