import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, posix, resolve, win32 } from "node:path";

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
 * @param {{ env?: Readonly<Record<string, string | undefined>>, home?: string, platform?: NodeJS.Platform }} [options]
 */
export function cliRuntimeHostConfig(packageRoot, options = {}) {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const platform = options.platform ?? process.platform;
  const stateDirectory = env.LLV_STATE_DIR?.trim()
    || join(env.XDG_CONFIG_HOME?.trim() || join(home, ".config"), "agent-log-viewer", "state");
  const installId = createHash("sha256").update(resolve(packageRoot)).digest("hex").slice(0, 16);
  const bundled = join(packageRoot, "dist", "runtime-host.mjs");
  const source = join(packageRoot, "src", "runtime-host", "main.ts");
  return {
    ...cliRuntimeHostEndpoint(stateDirectory, installId, platform),
    journalPath: join(stateDirectory, `runtime-events-${installId}.sqlite`),
    entrypoint: existsSync(bundled) ? bundled : source,
  };
}

/**
 * Where the supervised host listens and where its singleton fence lives.
 *
 * Windows has no filesystem Unix socket, so the endpoint is a named pipe in the
 * kernel's pipe namespace; `net.createServer().listen` and
 * `net.createConnection` take that name unchanged, which is why nothing else in
 * the CLI's readiness probe or the Viewer's client changes. The fence stays a
 * real file either way, and a pipe name has nothing to sit beside, so the fence
 * gets its own name in the state directory rather than `${socketPath}.lock`.
 *
 * This is a deliberate duplicate of `runtimeHostEndpoint` in
 * `src/lib/runtime/localEndpoint.ts` — this file is loaded by Node as plain
 * `.mjs` and cannot import TypeScript. `server-runtime.test.ts` imports both
 * and fails when they disagree.
 *
 * @param {string} stateDirectory
 * @param {string} installId
 * @param {NodeJS.Platform} platform
 */
export function cliRuntimeHostEndpoint(stateDirectory, installId, platform = process.platform) {
  if (platform === "win32") {
    return {
      socketPath: `\\\\.\\pipe\\agent-log-viewer-${installId}`,
      fencePath: win32.join(stateDirectory, `runtime-host-${installId}.lock`),
    };
  }
  const socketPath = posix.join(stateDirectory, `runtime-host-${installId}.sock`);
  return { socketPath, fencePath: `${socketPath}.lock` };
}

/**
 * The command that hands a URL to the desktop's default browser.
 *
 * Windows has no `xdg-open`. `rundll32 url.dll,FileProtocolHandler <url>` is
 * the shell-free route: `cmd /c start` would put the URL through `cmd`'s own
 * parsing, where the `&` between the viewer's query parameters ends the
 * command. Any other platform keeps the existing "do nothing" degrade, which is
 * what made the CLI runnable on Windows before this ever worked.
 *
 * @param {string} url
 * @param {NodeJS.Platform} platform
 * @returns {{ command: string, args: string[] } | null}
 */
export function browserOpenCommand(url, platform = process.platform) {
  if (platform === "linux") return { command: "xdg-open", args: [url] };
  if (platform === "darwin") return { command: "open", args: [url] };
  if (platform === "win32") return { command: "rundll32.exe", args: ["url.dll,FileProtocolHandler", url] };
  return null;
}

/**
 * Environment shared by the supervised runtime host and the Viewer server.
 * The CLI is the structured-host activation boundary, including for callers
 * whose shell still carries one of the former rollback values. Its journal
 * follows the same installation boundary as its socket, so a CLI host cannot
 * claim an ambient deployment's host epoch through the shared state directory.
 *
 * @param {Readonly<Record<string, string | undefined>>} base
 * @param {{ socketPath: string, fencePath: string, journalPath: string }} config
 */
export function cliRuntimeHostEnvironment(base, config) {
  return {
    ...withoutWakatimeCredential(base),
    LLV_RUNTIME_HOST_SOCKET: config.socketPath,
    LLV_RUNTIME_HOST_FENCE: config.fencePath,
    LLV_RUNTIME_JOURNAL: config.journalPath,
    LLV_STRUCTURED_HOSTS: "1",
    LLV_RUNTIME_EVENTS: "1",
    LLV_SPAWN_TRANSPORT: "structured",
    NEXT_PUBLIC_RUNTIME_UI: "1",
  };
}
