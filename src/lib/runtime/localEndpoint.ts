import path from "node:path";

/**
 * Where the runtime host listens, and where its singleton fence lives.
 *
 * On POSIX both are files in the state directory: a Unix socket and, beside it,
 * `<socket>.lock`. Windows has no Unix sockets in the filesystem sense that
 * `mkdir`/`unlink`/`chmod` assume, so the endpoint becomes a **named pipe** in
 * the kernel's pipe namespace (`\\.\pipe\…`) — which `net.createServer().listen`
 * and `net.createConnection` accept unchanged, so the Viewer's client, the
 * CLI's readiness probe and the newline framing all stay as they are.
 *
 * A pipe name is not a path, so the fence cannot be derived from it by
 * appending `.lock`: it gets its own name in the state directory. That split is
 * the only reason `fencePath` exists as a separate value at all — on POSIX it
 * is exactly today's `${socketPath}.lock` and nothing moves.
 *
 * Access control differs and the difference is documented, not papered over: a
 * Unix socket inherits the state directory's `0700` and is `chmod 0600`, while
 * a named pipe created through libuv carries the default DACL. Whether another
 * local account can connect to it cannot be settled by a CI runner with one
 * user, so the Viewer is documented as single-user on Windows.
 */
export interface RuntimeHostEndpoint {
  socketPath: string;
  fencePath: string;
}

const NAMED_PIPE_PREFIX = /^\\\\[.?]\\pipe\\/;

/** True for a Windows named-pipe name rather than a filesystem path. Pure. */
export function isNamedPipePath(pathname: string): boolean {
  return NAMED_PIPE_PREFIX.test(pathname);
}

function endpoint(
  stateDirectory: string,
  fileStem: string,
  pipeName: string,
  platform: NodeJS.Platform,
): RuntimeHostEndpoint {
  /* The `platform` argument governs the separator too, so the Windows shape is
     assertable from the Ubuntu leg and not only from the Windows one. */
  if (platform === "win32") {
    return {
      socketPath: `\\\\.\\pipe\\${pipeName}`,
      fencePath: path.win32.join(stateDirectory, `${fileStem}.lock`),
    };
  }
  const socketPath = path.posix.join(stateDirectory, `${fileStem}.sock`);
  return { socketPath, fencePath: `${socketPath}.lock` };
}

/**
 * The endpoint for one install id — what the public CLI supervises. Pure, and
 * deliberately duplicated (not imported) by `bin/server-runtime.mjs`, which
 * cannot load TypeScript; `bin/server-runtime.test.ts` imports both and asserts
 * they agree.
 */
export function runtimeHostEndpoint(
  stateDirectory: string,
  installId: string,
  platform: NodeJS.Platform = process.platform,
): RuntimeHostEndpoint {
  return endpoint(stateDirectory, `runtime-host-${installId}`, `agent-log-viewer-${installId}`, platform);
}

/** The endpoint a host started with no `LLV_RUNTIME_HOST_SOCKET` binds. */
export function defaultRuntimeHostEndpoint(
  stateDirectory: string,
  platform: NodeJS.Platform = process.platform,
): RuntimeHostEndpoint {
  return endpoint(stateDirectory, "runtime-host", "agent-log-viewer-runtime-host", platform);
}

/**
 * The fence beside a socket the caller already has, for the hosts that are
 * handed `LLV_RUNTIME_HOST_SOCKET` and no fence name. A pipe endpoint has no
 * file to sit beside, so its fence goes to `fallbackDirectory`.
 */
export function runtimeHostFencePath(socketPath: string, fallbackDirectory: string): string {
  if (!isNamedPipePath(socketPath)) return `${socketPath}.lock`;
  const name = socketPath.slice(socketPath.lastIndexOf("\\") + 1);
  return path.win32.join(fallbackDirectory, `${name || "runtime-host"}.lock`);
}
