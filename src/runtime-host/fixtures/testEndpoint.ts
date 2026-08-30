import path from "node:path";

/**
 * A listening endpoint for a test, in the form the running platform can bind.
 *
 * POSIX gets a Unix socket inside the caller's sandbox directory. Windows has
 * no such thing, so it gets a named pipe — which lives in a flat, machine-wide
 * kernel namespace rather than under a directory, and therefore has to carry
 * the sandbox's own unique name to stay unique. `mkdtemp` already made that
 * name unique, so the basename is enough.
 *
 * This exists so the runtime-host socket and fence tests exercise the *real*
 * endpoint on both legs of `platform-tests.yml` instead of being skipped on the
 * one platform whose endpoint is different.
 */
export function testEndpoint(sandbox: string, name: string): string {
  if (process.platform !== "win32") return path.join(sandbox, `${name}.sock`);
  return `\\\\.\\pipe\\llv-test-${path.basename(sandbox)}-${name}`;
}
