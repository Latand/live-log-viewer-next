import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import net from "node:net";
import { homedir, networkInterfaces } from "node:os";
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

/**
 * The loopback bind guard.
 *
 * `bin/cli.mjs` reads every non-loopback address twice — once before the Viewer
 * launches, once after it answers — and stops startup when an address that was
 * free before is bound after. Both halves of that reading are
 * platform-dependent, so both are exported and driven directly by
 * `bin/bind-guard.test.ts`: the Windows runner this guard first broke on cannot
 * be run from a Linux checkout.
 *
 * The rule the guard follows is that only a *change* between the two readings
 * is evidence. An address the probe cannot evaluate is recorded and carried,
 * never read as exposure and never fatal — a question the kernel refuses to
 * answer is not an answer.
 */

/** Addresses in fe80::/10 are link-local and unbindable without a zone. */
const LINK_LOCAL_IPV6 = /^fe[89ab][0-9a-f]:/i;

/**
 * The zone that names a link-local address's interface to this platform's
 * resolver.
 *
 * A zone is written `<address>%<zone>`, and the two families of operating
 * system disagree on what a zone is. POSIX resolvers take the interface name
 * (`fe80::1%eth0`). Windows takes the numeric interface index and nothing else
 * (`fe80::1%12`); an adapter name such as `Ethernet 3` is rejected there, which
 * is how this guard came to abort every Windows startup. Node reports that
 * index as `scopeid` on both.
 *
 * Returns null when this platform's zone cannot be expressed for the entry. The
 * caller then drops the address rather than probing an unscoped link-local one,
 * which no resolver can bind either.
 *
 * @param {{ scopeid?: number }} entry
 * @param {string} interfaceName
 * @param {NodeJS.Platform} [platform]
 * @returns {string | null}
 */
export function linkLocalScopeZone(entry, interfaceName, platform = process.platform) {
  if (platform === "win32") {
    return Number.isInteger(entry.scopeid) && entry.scopeid > 0 ? String(entry.scopeid) : null;
  }
  return interfaceName || null;
}

/**
 * Every non-loopback address the guard will ask about, named the way this
 * platform's resolver accepts. Throws only when the interface list itself
 * cannot be read, which leaves the guard blind rather than uncertain about one
 * address.
 *
 * @param {{ interfaces?: Record<string, unknown[] | undefined>, platform?: NodeJS.Platform }} [options]
 * @returns {string[]}
 */
export function nonLoopbackProbeAddresses(options = {}) {
  const platform = options.platform ?? process.platform;
  const interfaces = options.interfaces ?? networkInterfaces();
  const addresses = new Set();
  for (const [interfaceName, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.internal) continue;
      const scoped = entry.family === "IPv6"
        && (entry.scopeid > 0 || LINK_LOCAL_IPV6.test(entry.address));
      if (!scoped) {
        addresses.add(entry.address);
        continue;
      }
      const zone = linkLocalScopeZone(entry, interfaceName, platform);
      if (zone === null) continue;
      addresses.add(`${entry.address}%${zone}`);
    }
  }
  return [...addresses];
}

/**
 * What a failed bind says about the address it failed on.
 *
 * A rejection can be any value, so the code is read defensively rather than
 * assumed to be a Node system error.
 *
 * @param {unknown} error
 * @param {NodeJS.Platform} [platform]
 * @returns {"occupied" | "unevaluated"}
 */
export function classifyBindProbeFailure(error, platform = process.platform) {
  const code = /** @type {{ code?: string } | null | undefined} */ (error)?.code;
  if (code === "EADDRINUSE") return "occupied";
  // Windows answers a bind against an address:port another process already
  // holds under SO_EXCLUSIVEADDRUSE with EACCES rather than EADDRINUSE, so
  // reading it as occupancy is what keeps the guard's evidence intact there. A
  // permission-denied EACCES that has nothing to do with occupancy is stable
  // across both readings, cancels out, and so can never manufacture a widened
  // bind on its own.
  if (code === "EACCES" && platform === "win32") return "occupied";
  return "unevaluated";
}

/**
 * Bind an address once and release it. Resolves when the address was free,
 * rejects with the operating system's error otherwise. This is the per-address
 * half of the probe, and the half whose failures differ by platform, so it is
 * exported for a caller that needs to substitute it.
 *
 * @param {string} address
 * @param {number} port
 * @returns {Promise<void>}
 */
export function attemptAddressBind(address, port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      // A connection landing inside the probe's window must not reach the
      // process as an unhandled `error`. The probe answers about an address; it
      // never serves anything.
      socket.on("error", () => {});
      socket.destroy();
    });
    server.once("error", reject);
    server.listen({ host: address, port, exclusive: true }, () => {
      server.close((error) => error ? reject(error) : resolve());
    });
  });
}

/**
 * One reading of every non-loopback address, sorted into what the guard knows:
 * `occupied` and `free` are answers, `unevaluated` maps an address to why the
 * platform would not answer for it.
 *
 * A per-address failure never rejects. Only an unreadable interface list does.
 *
 * @param {number} port
 * @param {{
 *   addresses?: string[],
 *   interfaces?: Record<string, unknown[] | undefined>,
 *   listen?: (address: string, port: number) => Promise<void>,
 *   platform?: NodeJS.Platform,
 * }} [options]
 * @returns {Promise<{ occupied: Set<string>, free: Set<string>, unevaluated: Map<string, string> }>}
 */
export async function readNonLoopbackBindState(port, options = {}) {
  const platform = options.platform ?? process.platform;
  const addresses = options.addresses
    ?? nonLoopbackProbeAddresses({ platform, interfaces: options.interfaces });
  const listen = options.listen ?? attemptAddressBind;
  const occupied = new Set();
  const free = new Set();
  const unevaluated = new Map();
  for (const address of addresses) {
    try {
      await listen(address, port);
      free.add(address);
    } catch (error) {
      if (classifyBindProbeFailure(error, platform) === "occupied") {
        occupied.add(address);
        continue;
      }
      unevaluated.set(address, error instanceof Error ? error.message : String(error));
    }
  }
  return { occupied, free, unevaluated };
}

/**
 * The guard's verdict: the first address bound after launch that the reading
 * taken before launch gives no reason to excuse, or null when nothing changed.
 *
 * There are exactly two excuses. Somebody already held the address before the
 * Viewer existed, so its occupancy is not the Viewer's. Or nobody could
 * evaluate the address before the Viewer existed, so there is no before-state
 * to compare against and silence is not evidence — which is what makes an
 * unanswerable probe safe to carry.
 *
 * Everything else stays evidence, including an address that only appeared
 * between the two readings: a guard for a listener that must not be reachable
 * fails closed when it cannot excuse what it sees.
 *
 * @param {{ occupied: Set<string>, unevaluated: Map<string, string> }} before
 * @param {{ occupied: Set<string> }} after
 * @returns {string | null}
 */
export function newlyBoundNonLoopbackAddress(before, after) {
  for (const address of after.occupied) {
    if (before.occupied.has(address)) continue;
    if (before.unevaluated.has(address)) continue;
    return address;
  }
  return null;
}
